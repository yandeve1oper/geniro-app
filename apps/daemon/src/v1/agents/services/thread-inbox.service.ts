import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import type { ThreadMessage } from '../../runs/entity/thread-message.entity';
import type {
  HostWakeOwner,
  ThreadContact,
  ThreadMessageReason,
  ThreadMessageReply,
  ThreadMessageRowEntry,
  WaitingMessageWire,
} from '../chat.types';
import { RunDao } from '../dao/run.dao';
import { ThreadMessageDao } from '../dao/thread-message.dao';
import { KeyedChain } from '../utils/keyed-chain';
import {
  THREAD_INBOX_MAX_WAITING,
  THREAD_MESSAGE_MAX_CHARS,
  THREAD_MESSAGE_REPEAT_WINDOW_MS,
  THREAD_MESSAGES_PER_MINUTE,
  THREAD_MESSAGES_TURN_MAX_CHARS,
  threadMessageExcerpt,
  threadMessageNotDeliveredNote,
  threadMessageNotDeliveredSentence,
  UNTITLED_THREAD,
} from '../utils/thread-message-text';
import { isMessageableThread } from '../utils/thread-runs';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { hostWakeSessionKey } from './host-wake.bus';
import { RunNoticeWriter } from './run-notice.writer';

const HOUR_MS = 60 * 60_000;
const MINUTE_MS = 60_000;
const TAKEN_HOLD_MS = 2 * MINUTE_MS;

export interface ThreadMessageDraft {
  from: HostWakeOwner;
  fromMember: string | null;
  toRunId: string;
  text: string;
  wake: boolean;
  /** Until when the first reply from the receiver may wake the sender past its budgets. */
  replyCreditUntil?: Date | null;
}

/**
 * The mailbox between threads: what may be sent, what waits, and what a turn
 * takes. Every row is written before anything is told about it, so a message
 * survives a restart. Routing it — joined, woken or left waiting — is
 * `ThreadDeliveryService`'s; this service sits in `v1/agents` because the chat
 * service drains and cancels here.
 *
 * Accepting is serialized per thread, so the limits hold under racing senders.
 */
@Injectable()
export class ThreadInboxService {
  private readonly logger = new Logger(ThreadInboxService.name);
  private readonly accepting = new KeyedChain();
  /**
   * When a turn's prompt took a message that is still waiting: it flips only
   * once the turn is known to have started, and until then Remove could no
   * longer keep it from the agent. Timed, so a turn that never started frees it.
   */
  private readonly takenAt = new Map<string, number>();

  constructor(
    private readonly em: EntityManager,
    private readonly messages: ThreadMessageDao,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
    private readonly sessions: AgentSessionRegistry,
    private readonly notices: RunNoticeWriter,
  ) {}

  /** Refuses with a code the sender reads, or writes the row. */
  accept(draft: ThreadMessageDraft): Promise<ThreadMessage> {
    return this.accepting.run(draft.toRunId, () => this.acceptNow(draft));
  }

  private async acceptNow(draft: ThreadMessageDraft): Promise<ThreadMessage> {
    const em = this.em.fork();
    const fromRunId = draft.from.runId;
    if (draft.toRunId === fromRunId) {
      throw new BadRequestException(
        'SAME_THREAD',
        'this is your own thread — a message goes to another one',
      );
    }
    const target = await this.runDao.getById(draft.toRunId, em);
    if (target === null || !isMessageableThread(target)) {
      throw new NotFoundException(
        'THREAD_NOT_FOUND',
        `no thread ${draft.toRunId} — list_threads names the ones you can reach`,
      );
    }
    if (target.archivedAt !== null) {
      throw new BadRequestException(
        'THREAD_ARCHIVED',
        'that thread is archived',
      );
    }
    if (draft.text.trim().length === 0) {
      throw new BadRequestException('MESSAGE_EMPTY', 'the message is empty');
    }
    if (draft.text.length > THREAD_MESSAGE_MAX_CHARS) {
      throw new BadRequestException(
        'MESSAGE_TOO_LONG',
        `the message is ${draft.text.length} characters; the limit is ${THREAD_MESSAGE_MAX_CHARS}. Say it shorter.`,
      );
    }
    const text = redactSecrets(draft.text);
    const now = Date.now();
    const recent = await this.messages.sentSince(
      fromRunId,
      draft.toRunId,
      new Date(now - THREAD_MESSAGE_REPEAT_WINDOW_MS),
      em,
    );
    if (recent.some((message) => message.text === text)) {
      throw new BadRequestException(
        'REPEATED_MESSAGE',
        'you sent that thread the same text a few minutes ago',
      );
    }
    const lastMinute = recent.filter(
      (message) => message.createdAt.getTime() >= now - MINUTE_MS,
    );
    if (lastMinute.length >= THREAD_MESSAGES_PER_MINUTE) {
      throw new BadRequestException(
        'TOO_MANY_MESSAGES',
        `at most ${THREAD_MESSAGES_PER_MINUTE} messages a minute to one thread — put the rest into one message`,
      );
    }
    if (
      (await this.messages.countWaiting(draft.toRunId, em)) >=
      THREAD_INBOX_MAX_WAITING
    ) {
      throw new BadRequestException(
        'INBOX_FULL',
        `that thread already has ${THREAD_INBOX_MAX_WAITING} messages waiting`,
      );
    }
    const sender = await this.runDao.getById(fromRunId, em);
    const row = await this.messages.create(
      {
        fromRunId,
        fromTitle: redactSecrets(sender?.title ?? UNTITLED_THREAD),
        fromMember: draft.fromMember,
        fromSessionKey: hostWakeSessionKey(draft.from),
        toRunId: draft.toRunId,
        text,
        wake: draft.wake,
        replyCreditUntil: draft.replyCreditUntil ?? null,
      },
      em,
    );
    this.bus.publishThreadMessagesChanged(draft.toRunId);
    this.bus.publishThreadMessageSent({
      messageId: row.id,
      fromRunId,
      toRunId: draft.toRunId,
      at: row.createdAt,
      expectsReply: row.replyCreditUntil !== null,
    });
    return row;
  }

  /** What one turn takes, oldest first; past the budget stays waiting. */
  async takeForTurn(
    runId: string,
    txEm?: EntityManager,
  ): Promise<ThreadMessageRowEntry[]> {
    const waiting = await this.messages.listWaiting(runId, txEm);
    const now = Date.now();
    const taken: ThreadMessageRowEntry[] = [];
    let chars = 0;
    for (const message of waiting) {
      chars += message.text.length;
      if (chars > THREAD_MESSAGES_TURN_MAX_CHARS) {
        break;
      }
      this.takenAt.set(message.id, now);
      taken.push({
        ...rowEntryOf(message),
        inReplyTo: await this.replyBefore(message, txEm),
      });
    }
    return taken;
  }

  private async replyBefore(
    message: ThreadMessage,
    txEm?: EntityManager,
  ): Promise<ThreadMessageReply | null> {
    const reply = await this.messages.lastSentBefore(
      message.toRunId,
      message.fromRunId,
      message.createdAt,
      txEm,
    );
    return reply === null
      ? null
      : {
          text: threadMessageExcerpt(reply.text),
          at: reply.createdAt.toISOString(),
        };
  }

  async markDelivered(
    runId: string,
    ids: readonly string[],
    deliveryId: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.messages.markDelivered(ids, deliveryId, new Date());
    for (const id of ids) {
      this.takenAt.delete(id);
    }
    this.bus.publishThreadMessagesChanged(runId);
  }

  /**
   * Back to waiting, what a turn was handed and dropped. Answers the delivery
   * ids it took back and their senders; an id it does not know is someone
   * else's delivery.
   */
  async returnDropped(
    deliveryIds: readonly string[],
  ): Promise<{ deliveryIds: string[]; titles: string[] }> {
    const rows =
      deliveryIds.length === 0
        ? []
        : await this.messages.listByDeliveryIds(deliveryIds);
    if (rows.length === 0) {
      return { deliveryIds: [], titles: [] };
    }
    await this.messages.returnToWaiting(rows.map((row) => row.id));
    for (const runId of new Set(rows.map((row) => row.toRunId))) {
      this.bus.publishThreadMessagesChanged(runId);
    }
    return {
      deliveryIds: rows.flatMap((row) =>
        row.deliveryId === null ? [] : [row.deliveryId],
      ),
      titles: [...new Set(rows.map((row) => row.fromTitle))],
    };
  }

  listOwed(runId: string): Promise<ThreadMessage[]> {
    return this.messages.listOwed(runId);
  }

  owedRunIds(): Promise<string[]> {
    return this.messages.owedRunIds();
  }

  wakesInLastHour(runId: string): Promise<number> {
    return this.messages.sumWakesSince(runId, new Date(Date.now() - HOUR_MS));
  }

  /** Spend the reply credit `managerRunId` holds on `threadRunId`; true when one was live. */
  async spendReplyCredit(
    managerRunId: string,
    threadRunId: string,
  ): Promise<boolean> {
    const spent = await this.messages.spendReplyCredit(
      managerRunId,
      threadRunId,
      new Date(),
    );
    if (spent) {
      this.bus.publishReplyCreditSpent({
        fromRunId: managerRunId,
        toRunId: threadRunId,
      });
    }
    return spent;
  }

  /** Every message to or from `runId` since `since`, oldest first — ends and credit only. */
  contactsOf(runId: string, since: Date): Promise<ThreadContact[]> {
    return this.messages.contactsOf(runId, since);
  }

  /** The threads `fromRunId` still waits on a reply from, by live reply credit. */
  awaitingRepliesFrom(fromRunId: string): Promise<Set<string>> {
    return this.messages.awaitingRepliesFrom(fromRunId, new Date());
  }

  joinsInLastHour(runId: string): Promise<number> {
    return this.messages.countJoinedSince(
      runId,
      new Date(Date.now() - HOUR_MS),
    );
  }

  async markWoken(
    runId: string,
    message: Pick<ThreadMessage, 'id' | 'wakes'>,
  ): Promise<void> {
    await this.messages.markWoken(message.id, message.wakes + 1, new Date());
    this.bus.publishThreadMessagesChanged(runId);
  }

  async setReason(
    runId: string,
    ids: readonly string[],
    reason: ThreadMessageReason | null,
  ): Promise<void> {
    await this.messages.setReason(ids, reason);
    this.bus.publishThreadMessagesChanged(runId);
  }

  async listWaiting(runId: string): Promise<WaitingMessageWire[]> {
    const rows = await this.messages.listWaiting(runId);
    return rows.map((row) => ({
      ...rowEntryOf(row),
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /**
   * The user asked for a waiting message now: from here on it may open a turn,
   * whatever its sender asked. Answers the row as it now stands.
   */
  async requestWake(runId: string, messageId: string): Promise<ThreadMessage> {
    const em = this.em.fork();
    const row = await this.messages.getById(messageId, em);
    if (row === null || row.toRunId !== runId || row.status !== 'waiting') {
      throw new NotFoundException(
        'THREAD_MESSAGE_NOT_FOUND',
        `no message ${messageId} waits in ${runId}`,
      );
    }
    if (!row.wake) {
      await this.messages.markWake(row.id, em);
      row.wake = true;
    }
    return row;
  }

  /** The user took a waiting message out: its agent never reads it. */
  async remove(runId: string, messageId: string): Promise<void> {
    const em = this.em.fork();
    const row = await this.messages.getById(messageId, em);
    if (row === null || row.toRunId !== runId || row.status !== 'waiting') {
      throw new NotFoundException(
        'THREAD_MESSAGE_NOT_FOUND',
        `no message ${messageId} waits in ${runId}`,
      );
    }
    const takenAt = this.takenAt.get(row.id);
    if (takenAt !== undefined && Date.now() - takenAt < TAKEN_HOLD_MS) {
      throw new ConflictException(
        'THREAD_MESSAGE_TAKEN',
        'a turn starting now has already read this message',
      );
    }
    this.takenAt.delete(row.id);
    await this.messages.cancel([row.id], em);
    this.bus.publishThreadMessagesChanged(runId);
    const target = await this.runDao.getById(runId, em);
    await this.tellSenders(
      runId,
      [row],
      redactSecrets(target?.title ?? UNTITLED_THREAD),
      'removed',
    );
  }

  /** The thread is shelved or going: nothing it holds will be read. */
  async cancelFor(runId: string, why: 'archived' | 'deleted'): Promise<void> {
    const em = this.em.fork();
    const waiting = await this.messages.listWaiting(runId, em);
    if (waiting.length > 0) {
      await this.messages.cancel(
        waiting.map((row) => row.id),
        em,
      );
      const target = await this.runDao.getById(runId, em);
      await this.tellSenders(
        runId,
        waiting,
        redactSecrets(target?.title ?? UNTITLED_THREAD),
        why,
      );
    }
    if (why === 'deleted') {
      await this.messages.hardDeleteAddressedTo(runId, em);
    }
    if (waiting.length > 0) {
      this.bus.publishThreadMessagesChanged(runId);
    }
  }

  private async tellSenders(
    toRunId: string,
    rows: readonly ThreadMessage[],
    toTitle: string,
    why: 'archived' | 'deleted' | 'removed',
  ): Promise<void> {
    const sentence = threadMessageNotDeliveredSentence(toTitle, why);
    const note = threadMessageNotDeliveredNote(toRunId, why);
    for (const runId of new Set(rows.map((row) => row.fromRunId))) {
      await this.notices.warn(runId, sentence, 'Not delivered');
    }
    for (const key of new Set(rows.map((row) => row.fromSessionKey))) {
      if (!this.sessions.oweKeyNote(key, note)) {
        this.logger.warn(
          `conversation ${key} not told of an undelivered message: the daemon is shutting down`,
        );
      }
    }
  }
}

function rowEntryOf(row: ThreadMessage): ThreadMessageRowEntry {
  return {
    id: row.id,
    fromRunId: row.fromRunId,
    fromTitle: row.fromTitle,
    fromMember: row.fromMember,
    text: row.text,
  };
}
