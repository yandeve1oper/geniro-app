import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { BaseException } from '@packages/common';

import {
  type NoteThreadAnswer,
  type NoteThreadInput,
  SINGLE_AGENT_NODE,
  type TellThreadsAnswer,
  type TellThreadsInput,
} from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { CommandCenterOpsBroker } from '../../agents/services/command-center-ops.broker';
import { UNTITLED_THREAD } from '../../agents/utils/thread-message-text';
import { isMessageableThread } from '../../agents/utils/thread-runs';
import { ThreadDeliveryService } from '../../teams/services/thread-delivery.service';
import { REPLY_CREDIT_MS } from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { type NameableThread, resolveTarget } from '../utils/resolve-target';
import { CommandCenterChatService } from './command-center-chat.service';
import { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterStartsService } from './command-center-starts.service';

type Unresolved = TellThreadsAnswer['unresolved'][number];

function candidatesOf(threads: readonly NameableThread[]) {
  return threads.map((thread) => ({
    handle: thread.handle,
    title: thread.title,
  }));
}

/**
 * What the manager's tools do, installed on `CommandCenterOpsBroker` for the
 * MCP host to reach. Every target is resolved against the manager's roster
 * first, and `tell_threads` sends nothing at all while any target is
 * unresolved — a message half-delivered to the wrong set is worse than none.
 */
@Injectable()
export class CommandCenterOpsService implements OnModuleInit, OnModuleDestroy {
  private uninstall: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly broker: CommandCenterOpsBroker,
    private readonly delivery: ThreadDeliveryService,
    private readonly roster: CommandCenterRosterDao,
    private readonly managers: CommandCenterChatService,
    private readonly starts: CommandCenterStartsService,
    private readonly events: CommandCenterEventBus,
  ) {}

  onModuleInit(): void {
    this.uninstall = this.broker.install({
      tell: (managerRunId, input) => this.tell(managerRunId, input),
      note: (managerRunId, input) => this.note(managerRunId, input),
      start: (managerRunId, input) => this.starts.start(managerRunId, input),
    });
  }

  onModuleDestroy(): void {
    this.uninstall?.();
  }

  async tell(
    managerRunId: string,
    input: TellThreadsInput,
  ): Promise<TellThreadsAnswer> {
    await this.assertManager(managerRunId);
    const roster = await this.nameable(managerRunId);
    const resolved: { to: string; thread: NameableThread }[] = [];
    const unresolved: Unresolved[] = [];
    for (const to of input.to) {
      const found = await this.resolve(to, roster);
      if ('thread' in found) {
        resolved.push({ to, thread: found.thread });
      } else {
        unresolved.push({ to, ...found });
      }
    }
    if (unresolved.length > 0) {
      return { sent: [], unresolved };
    }
    const replyCreditUntil = input.expect_reply
      ? new Date(Date.now() + REPLY_CREDIT_MS)
      : null;
    const sent: TellThreadsAnswer['sent'] = [];
    const seen = new Set<string>();
    for (const { to, thread } of resolved) {
      if (seen.has(thread.runId)) {
        continue;
      }
      seen.add(thread.runId);
      try {
        const answer = await this.delivery.send({
          from: {
            target: 'chat',
            runId: managerRunId,
            memberId: SINGLE_AGENT_NODE,
            conversationId: null,
            caller: SINGLE_AGENT_NODE,
          },
          toRunId: thread.runId,
          text: input.message,
          wake: true,
          replyCreditUntil,
        });
        sent.push({
          to,
          runId: thread.runId,
          title: answer.title,
          outcome: answer.outcome,
          code: answer.reason ?? null,
        });
      } catch (error) {
        sent.push({
          to,
          runId: thread.runId,
          title: thread.title,
          outcome: 'refused',
          code:
            error instanceof BaseException
              ? error.errorCode
              : 'DELIVERY_FAILED',
        });
      }
    }
    return { sent, unresolved: [] };
  }

  async note(
    managerRunId: string,
    input: NoteThreadInput,
  ): Promise<NoteThreadAnswer> {
    await this.assertManager(managerRunId);
    const found = await this.resolve(
      input.thread,
      await this.nameable(managerRunId),
    );
    if (!('thread' in found)) {
      return { status: 'unresolved', ...found };
    }
    const note = input.note?.trim() ? input.note.trim() : null;
    await this.roster.setNote(managerRunId, found.thread.runId, note);
    this.events.publishChanged([found.thread.runId], 'roster');
    return {
      status: 'noted',
      handle: found.thread.handle,
      title: found.thread.title,
    };
  }

  private async assertManager(managerRunId: string): Promise<void> {
    const run = await this.runDao.getById(managerRunId, this.em.fork());
    if (run === null || run.commandCenter !== true) {
      throw new Error('only the command center manager may call this tool');
    }
  }

  private async nameable(managerRunId: string): Promise<NameableThread[]> {
    return (await this.managers.rosterThreads(managerRunId)).map(
      ({ entry, run }) => ({
        handle: entry.handle,
        runId: entry.threadRunId,
        title: run?.title ?? UNTITLED_THREAD,
      }),
    );
  }

  /** A name on the roster, or why not — `NOT_MANAGED` for a thread that exists off it. */
  private async resolve(
    name: string,
    roster: readonly NameableThread[],
  ): Promise<{ thread: NameableThread } | Omit<Unresolved, 'to'>> {
    const resolution = resolveTarget(name, roster);
    if (resolution.kind === 'resolved') {
      return { thread: resolution.thread };
    }
    if (resolution.kind === 'ambiguous') {
      return {
        code: 'AMBIGUOUS_TARGET',
        candidates: candidatesOf(resolution.candidates),
      };
    }
    const existing = await this.runDao.getById(name.trim(), this.em.fork());
    return {
      code:
        existing !== null && isMessageableThread(existing)
          ? 'NOT_MANAGED'
          : 'THREAD_NOT_FOUND',
      candidates: candidatesOf(resolution.candidates),
    };
  }
}
