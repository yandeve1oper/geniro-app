import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { BadRequestException, ConflictException } from '@packages/common';

import {
  type DeliveredWaitingMessageWire,
  type HostRowWire,
  type HostWake,
  type HostWakeOwner,
  type RunAwaiting,
  SINGLE_AGENT_NODE,
  type ThreadListAnswer,
  type ThreadListQuery,
  type ThreadListRow,
  type ThreadMessageAnswer,
  type ThreadMessageOutcome,
  type ThreadMessageReason,
  type ThreadMessageRowEntry,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ChatService } from '../../agents/services/chat.service';
import { HostWakeBus } from '../../agents/services/host-wake.bus';
import { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { KeyedChain } from '../../agents/utils/keyed-chain';
import { persistItemAndEmit } from '../../agents/utils/persist-item';
import { activityWindowOf } from '../../agents/utils/run-activity';
import {
  decodeThreadListCursor,
  encodeThreadListCursor,
} from '../../agents/utils/thread-list-cursor';
import {
  THREAD_JOINS_PER_HOUR,
  THREAD_WAKE_PROMPT,
  THREAD_WAKES_PER_HOUR,
  threadMessageReturnedRow,
  threadMessageSentRow,
  threadMessagesPrompt,
  threadMessagesRow,
  threadWakeRow,
  UNTITLED_THREAD,
} from '../../agents/utils/thread-message-text';
import { isMessageableThread } from '../../agents/utils/thread-runs';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { Run } from '../../runs/entity/run.entity';
import { isColdAndLarge } from '../utils/prompt-cache-standing';
import {
  TeamExecutorService,
  type ThreadMessageJoinAnswer,
} from './team-executor.service';

interface RouteTerms {
  mayJoin: boolean;
  /** A boot sending again what a wake was already spent on. */
  resending: boolean;
  /** The user's own press, which no cost or rate limit holds back. */
  pressed?: boolean;
}

interface Routed {
  outcome: ThreadMessageOutcome;
  reason: ThreadMessageReason | null;
}

/** What is owed about a message on its way: the row and the ids it carries. */
type Routable = ThreadMessageRowEntry & {
  wake: boolean;
  wokeAt: Date | null;
  wakes: number;
};

function titleOf(run: Run): string {
  return redactSecrets(run.title ?? UNTITLED_THREAD);
}

/**
 * Routes a message from another thread to where it can be read: JOINED into
 * the running turn, WOKEN as a turn of its own, or left WAITING with the
 * reason in its row. A wake opens the turn and that turn's drain carries the
 * text, so a message reaches an agent by one path whichever way it opened.
 *
 * Lives in `v1/teams` because it needs both `ChatService` and
 * `TeamExecutorService`. Routing is serialized per thread.
 */
@Injectable()
export class ThreadDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(ThreadDeliveryService.name);
  private readonly routing = new KeyedChain();
  /** Team runs whose lead was woken and has not ended that turn yet. */
  private readonly wakingLeads = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly projectDao: ProjectDao,
    private readonly inbox: ThreadInboxService,
    private readonly chats: ChatService,
    private readonly approvals: ApprovalRegistry,
    private readonly executor: TeamExecutorService,
    private readonly processes: ProcessRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly wakes: HostWakeBus,
    private readonly bus: AgentEventBus,
    private readonly itemDao: ItemDao,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
  ) {}

  onModuleInit(): void {
    // A status event, not a settled turn: a thread working off-turn settles
    // none, and only its status says it is done.
    this.bus.allStatuses().subscribe((event) => {
      if (
        event.status !== null &&
        event.status !== 'running' &&
        event.status !== 'pending'
      ) {
        void this.release(event.runId);
      }
    });
    // A team's lead ends a turn while the run goes on working.
    this.executor.onConversationTurnEnded((runId, caller) => {
      void this.releaseLead(runId, caller);
    });
  }

  /**
   * Whether this run may reach other threads, as the kind of thread it is. Read
   * from the row, since `tools/call` skips the listing's gate.
   */
  async senderTarget(runId: string): Promise<'chat' | 'team' | null> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (run === null || !isMessageableThread(run)) {
      return null;
    }
    return run.teamId === null ? 'chat' : 'team';
  }

  /**
   * One page of the other threads an agent can reach, its own project's first,
   * then the last active.
   */
  async listThreads(
    callerRunId: string,
    query: ThreadListQuery,
  ): Promise<ThreadListAnswer> {
    const em = this.em.fork();
    const projects = await this.projectDao.listAll(em);
    const names = new Map(
      projects.map((project) => [project.id, project.name]),
    );
    const projectId =
      query.project === undefined
        ? null
        : projectNamed(projects, query.project);
    if (projectId === undefined) {
      throw new BadRequestException(
        'PROJECT_NOT_FOUND',
        `No project has the id or name "${query.project}".`,
      );
    }
    const after =
      query.page === undefined ? null : decodeThreadListCursor(query.page);
    if (after === null && query.page !== undefined) {
      throw new BadRequestException(
        'INVALID_PAGE',
        'The page is not one list_threads handed out.',
      );
    }
    const caller = await this.runDao.getById(callerRunId, em);
    const page = await this.runDao.listThreads(
      {
        excludeRunId: callerRunId,
        callerProjectId: caller?.projectId ?? null,
        query: query.query ?? null,
        includeArchived: query.includeArchived === true,
        projectId,
        window: activityWindowOf(query),
        after,
        limit: query.limit,
      },
      em,
    );
    return {
      threads: page.runs.map(({ run, lastActivityAt, lastUserMessageAt }) => ({
        thread: run.id,
        title: titleOf(run),
        kind: run.teamId === null ? ('chat' as const) : ('team' as const),
        status: this.statusOf(run),
        agent: run.agentKind ?? null,
        project:
          run.projectId === null ? null : (names.get(run.projectId) ?? null),
        folder: run.cwd,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        lastActivityAt: lastActivityAt?.toISOString() ?? null,
        lastUserMessageAt: lastUserMessageAt?.toISOString() ?? null,
        archived: run.archivedAt !== null,
      })),
      nextPage: page.next === null ? null : encodeThreadListCursor(page.next),
    };
  }

  /** The card a thread is parked on, leaving out one that stands across turns. */
  private parkedOn(run: Run): RunAwaiting | null {
    return this.approvals.awaitingFor(run.id, (card) => card.standing === true);
  }

  /**
   * A question waits for the user: any member's in a team; in a chat, one its
   * open turn is parked on or a card that outlived its turn.
   */
  private awaitsAnswer(run: Run): boolean {
    return (
      this.parkedOn(run) === 'question' ||
      (run.teamId === null && this.chats.awaitsCardAnswer(run.id))
    );
  }

  private statusOf(run: Run): ThreadListRow['status'] {
    if (this.awaitsAnswer(run) || this.parkedOn(run) !== null) {
      return 'needs_user';
    }
    if (run.status === 'cancelled') {
      return 'stopped';
    }
    if (run.status === 'failed') {
      return 'failed';
    }
    return run.status === 'running' ? 'working' : 'idle';
  }

  /** Accept a message and route it. A refusal throws with the code the sender reads. */
  async send(draft: {
    from: HostWakeOwner;
    toRunId: string;
    text: string;
    wake: boolean;
  }): Promise<ThreadMessageAnswer> {
    const fromMember =
      draft.from.target === 'team'
        ? await this.executor.memberNameOf(
            draft.from.runId,
            draft.from.memberId,
          )
        : null;
    const accepted = await this.inbox.accept({ ...draft, fromMember });
    const routed = await this.routing.run(draft.toRunId, () =>
      this.route(draft.toRunId, [accepted], {
        mayJoin: true,
        resending: false,
      }),
    );
    const target = await this.runDao.getById(draft.toRunId, this.em.fork());
    const title = target === null ? UNTITLED_THREAD : titleOf(target);
    const answer: ThreadMessageAnswer = {
      outcome: routed.outcome,
      ...(routed.reason === null ? {} : { reason: routed.reason }),
      title,
    };
    await this.writeRow(
      draft.from.runId,
      draft.from.target === 'chat' ? null : draft.from.memberId,
      threadMessageSentRow(
        {
          toRunId: draft.toRunId,
          title,
          outcome: routed.outcome,
          reason: routed.reason,
        },
        draft.from.conversationId,
      ),
    );
    return answer;
  }

  /**
   * The user's Deliver now: the message joins a running turn or opens one,
   * past the limits that hold back an agent's wake, or says why it still waits.
   */
  async deliverNow(
    runId: string,
    messageId: string,
  ): Promise<DeliveredWaitingMessageWire> {
    return this.routing.run(runId, async () => {
      const message = await this.inbox.requestWake(runId, messageId);
      return this.route(runId, [message], {
        mayJoin: true,
        resending: false,
        pressed: true,
      });
    });
  }

  /** Wake whoever a daemon restart left owed. */
  async republishOwed(): Promise<void> {
    for (const runId of await this.inbox.owedRunIds()) {
      await this.release(runId, true);
    }
  }

  private async releaseLead(runId: string, caller: string): Promise<void> {
    try {
      const owed = await this.inbox.listOwed(runId);
      if (!this.wakingLeads.has(runId) && owed.length === 0) {
        return;
      }
      if ((await this.executor.threadLeadCaller(runId)) !== caller) {
        return;
      }
      // The woken turn ended with its message unread, and a team's status does
      // not say a stretch failed: nothing starts it again on its own.
      const failed =
        this.wakingLeads.delete(runId) &&
        owed.some((message) => message.wokeAt !== null);
      if (failed) {
        await this.inbox.setReason(
          runId,
          owed.map((message) => message.id),
          'failed',
        );
        return;
      }
      await this.release(runId);
    } catch (err) {
      this.logger.error(
        `run ${runId} could not release a thread message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** What a thread is owed goes out now, or says why it still waits. */
  private async release(runId: string, resending = false): Promise<void> {
    try {
      await this.routing.run(runId, async () => {
        const owed = await this.inbox.listOwed(runId);
        if (owed.length > 0) {
          await this.route(runId, owed, { mayJoin: false, resending });
        }
      });
    } catch (err) {
      this.logger.error(
        `run ${runId} could not release a thread message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async route(
    runId: string,
    messages: readonly Routable[],
    { mayJoin, resending, pressed = false }: RouteTerms,
  ): Promise<Routed> {
    const run = await this.runDao.getById(runId, this.em.fork());
    const [first] = messages;
    if (run === null || run.archivedAt !== null || first === undefined) {
      return { outcome: 'waiting', reason: null };
    }
    if (mayJoin) {
      const overBudget =
        (await this.inbox.joinsInLastHour(runId)) >= THREAD_JOINS_PER_HOUR;
      const joined =
        run.teamId === null
          ? await this.joinChat(run, messages, overBudget && !pressed)
          : await this.joinTeam(run, messages, overBudget && !pressed);
      if (joined === 'joined') {
        return { outcome: 'joined', reason: null };
      }
      if (joined === 'busy') {
        return this.leave(runId, messages, 'running_turn');
      }
      if (joined === 'over_budget') {
        return this.leave(runId, messages, 'wake_limit');
      }
    }
    const reason = await this.whyNotWake(run, messages, resending, pressed);
    if (reason !== null) {
      return this.leave(runId, messages, reason);
    }
    const woke =
      run.teamId === null
        ? await this.wakeChat(run, first, messages, resending)
        : await this.wakeTeam(run, first, messages, resending);
    if (woke === 'woken') {
      return { outcome: 'woken', reason: null };
    }
    // A refusal on a live run is a Stop on its way: its status stamps the rows.
    return this.leave(
      runId,
      messages,
      woke === 'busy' || run.status === 'running'
        ? 'running_turn'
        : 'not_started',
    );
  }

  private async leave(
    runId: string,
    messages: readonly Routable[],
    reason: ThreadMessageReason,
  ): Promise<Routed> {
    await this.inbox.setReason(
      runId,
      messages.map((message) => message.id),
      reason,
    );
    return { outcome: 'waiting', reason };
  }

  private async joinChat(
    run: Run,
    messages: readonly Routable[],
    overBudget: boolean,
  ): Promise<ThreadMessageJoinAnswer> {
    if (!this.processes.has(run.id)) {
      return 'idle';
    }
    if (this.awaitsAnswer(run)) {
      return 'question';
    }
    const adapter =
      run.agentKind === null
        ? undefined
        : this.adapters.all().get(run.agentKind);
    const followUp = adapter?.getConfig().followUp;
    if (
      followUp === undefined ||
      followUp.unavailableReason !== null ||
      followUp.interrupts
    ) {
      return 'busy';
    }
    if (overBudget) {
      return 'over_budget';
    }
    const deliveryId = randomUUID();
    // Delivered BEFORE the send: a drop reported at once must find its row.
    await this.inbox.markDelivered(
      run.id,
      messages.map((message) => message.id),
      deliveryId,
    );
    try {
      await this.chats.sendMessage(run.id, threadMessagesPrompt(messages), [], {
        joinOnly: true,
        hostRow: threadMessagesRow(messages),
        deliveryId,
      });
      return 'joined';
    } catch (err) {
      await this.inbox.returnDropped([deliveryId]);
      if (err instanceof ConflictException) {
        return err.errorCode === 'RUN_NOT_RUNNING' ? 'idle' : 'busy';
      }
      throw err;
    }
  }

  private async joinTeam(
    run: Run,
    messages: readonly Routable[],
    overBudget: boolean,
  ): Promise<ThreadMessageJoinAnswer> {
    const deliveryId = randomUUID();
    if (!overBudget) {
      await this.inbox.markDelivered(
        run.id,
        messages.map((message) => message.id),
        deliveryId,
      );
    }
    const answer = await this.executor.joinThreadMessage(run.id, {
      prompt: threadMessagesPrompt(messages),
      row: threadMessagesRow(messages),
      deliveryId,
      overBudget,
      onDropped: () => {
        void this.returnJoined(run.id, deliveryId);
      },
    });
    if (answer !== 'joined') {
      await this.inbox.returnDropped([deliveryId]);
    }
    return answer;
  }

  /** The lead's turn gave a joined message back and has ended: it never throws. */
  private async returnJoined(runId: string, deliveryId: string): Promise<void> {
    try {
      const returned = await this.inbox.returnDropped([deliveryId]);
      if (returned.titles.length > 0) {
        await this.writeRow(
          runId,
          null,
          threadMessageReturnedRow(returned.titles),
        );
        await this.release(runId);
      }
    } catch (err) {
      this.logger.error(
        `run ${runId} could not take back a thread message: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Why no turn opens for these messages, or null when one may. */
  private async whyNotWake(
    run: Run,
    messages: readonly Routable[],
    resending: boolean,
    pressed: boolean,
  ): Promise<ThreadMessageReason | null> {
    if (run.status === 'cancelled') {
      return 'stopped';
    }
    if (run.status === 'failed') {
      return 'failed';
    }
    if (run.status === 'pending') {
      return 'not_started';
    }
    // Before a question: a message that asked not to wake anyone goes out with
    // the next turn, and answering the question opens none on its own.
    if (messages.every((message) => !message.wake)) {
      return 'sender_opted_out';
    }
    if (this.awaitsAnswer(run)) {
      return 'question';
    }
    // After a restart the wake already spent on them goes out again, uncounted.
    // Anywhere else a turn came and left them, so another turn is another wake.
    if (
      pressed ||
      (resending && messages.some((message) => message.wokeAt !== null))
    ) {
      return null;
    }
    if (await this.isCold(run)) {
      return 'cold_and_large';
    }
    return (await this.inbox.wakesInLastHour(run.id)) >= THREAD_WAKES_PER_HOUR
      ? 'wake_limit'
      : null;
  }

  private async isCold(run: Run): Promise<boolean> {
    if (run.teamId !== null) {
      const facts = await this.executor.leadCacheFacts(run.id);
      return facts !== null && isColdAndLarge(facts, Date.now());
    }
    const expiresAt = run.promptCacheExpiresAt?.getTime() ?? null;
    const ttl = run.promptCacheTtlMs;
    return isColdAndLarge(
      {
        endedAt: expiresAt === null || ttl === null ? null : expiresAt - ttl,
        promptCacheTtlMs: ttl,
        contextTokens: run.contextTokens,
        contextWindowTokens: run.contextWindowTokens,
      },
      Date.now(),
    );
  }

  private async spendWake(
    runId: string,
    first: Routable,
    messages: readonly Routable[],
    resending: boolean,
  ): Promise<void> {
    if (!resending || !messages.some((message) => message.wokeAt !== null)) {
      await this.inbox.markWoken(runId, first);
    }
    await this.inbox.setReason(
      runId,
      messages.map((message) => message.id),
      null,
    );
  }

  private async wakeChat(
    run: Run,
    first: Routable,
    messages: readonly Routable[],
    resending: boolean,
  ): Promise<'woken'> {
    await this.spendWake(run.id, first, messages, resending);
    const wake: HostWake = {
      key: `thread-message:${run.id}`,
      owner: {
        target: 'chat',
        runId: run.id,
        memberId: SINGLE_AGENT_NODE,
        conversationId: null,
        caller: SINGLE_AGENT_NODE,
      },
      prompt: THREAD_WAKE_PROMPT,
      row: threadWakeRow(first.fromRunId, first.fromTitle),
      note: null,
      onDelivered: () => undefined,
      stale: () => this.wakeIsStale(run.id),
    };
    this.wakes.publish(wake);
    return 'woken';
  }

  /** Nothing left to read, or the thread must not start on its own. */
  private async wakeIsStale(runId: string): Promise<boolean> {
    const run = await this.runDao.getById(runId, this.em.fork());
    if (
      run === null ||
      run.archivedAt !== null ||
      run.status === 'cancelled' ||
      run.status === 'failed'
    ) {
      return true;
    }
    return (await this.inbox.listOwed(runId)).length === 0;
  }

  private async wakeTeam(
    run: Run,
    first: Routable,
    messages: readonly Routable[],
    resending: boolean,
  ): Promise<'woken' | 'busy' | 'refused'> {
    // The woken turn's drain has not run yet, and it takes these too.
    if (this.wakingLeads.has(run.id)) {
      return 'woken';
    }
    // A dropped wake leaves the rows waiting: the next pass's drain takes
    // them, and a stop comes back here as a status.
    const woke = await this.executor.wakeLeadForThreadMessage(
      run.id,
      THREAD_WAKE_PROMPT,
      threadWakeRow(first.fromRunId, first.fromTitle),
      () => {
        this.wakingLeads.delete(run.id);
      },
    );
    if (woke === 'woken') {
      this.wakingLeads.add(run.id);
      await this.spendWake(run.id, first, messages, resending);
    }
    return woke;
  }

  /** One host row in a thread. Never throws; a deleted run gets no row. */
  private async writeRow(
    runId: string,
    memberId: string | null,
    row: HostRowWire,
  ): Promise<void> {
    try {
      const em = this.em.fork();
      if ((await this.runDao.getById(runId, em)) === null) {
        return;
      }
      await persistItemAndEmit(
        {
          itemDao: this.itemDao,
          bus: this.bus,
          calls: this.calls,
          seqs: this.seqs,
        },
        em,
        {
          runId,
          memberId,
          seq: await this.seqs.reserve(runId),
          kind: 'system',
          role: null,
          payload: row,
        },
      );
    } catch (err) {
      this.logger.error(
        `run ${runId} could not write a thread message row: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function projectNamed(
  projects: readonly { id: string; name: string }[],
  wanted: string,
): string | undefined {
  const folded = wanted.trim().toLowerCase();
  return (
    projects.find((project) => project.id === wanted) ??
    projects.find((project) => project.name.trim().toLowerCase() === folded)
  )?.id;
}
