import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { executableOf, maskedCommand } from '../utils/command-text';
import { mapEventToItem } from '../utils/event-to-item';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import { persistItemAndEmit } from '../utils/persist-item';
import type { ScannedProcess } from '../utils/run-process-scan';
import type { LeftProcessesCause } from '../chat.types';
import {
  finishedStoppedNote,
  idleStoppedNote,
} from '../utils/session-replacement-notes';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunProcessReaper } from './run-process-reaper.service';

/**
 * Stop what a run's agents left running outside their CLIs once the run has
 * gone unused for the kept-session window, and say so: one `warning` row in
 * the transcript for the user, and a line on the run's next prompt for the
 * agent, which otherwise would not know its dev server is gone.
 *
 * Two ways in, one rule for every run: the registry's idle close, once the CLI
 * has exited ({@link AgentSessionRegistry.onIdleClosed}), and the sweep, for a
 * run nothing will idle-close — after a daemon restart, or an eviction. A
 * finished card's run is reaped and told the same way, sooner
 * (`TaskSettleService.endFinishedWork`).
 */
@Injectable()
export class RunIdleReapService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RunIdleReapService.name);
  /** Reaps waiting out the kill grace after a CLI's exit, by run. */
  private readonly graced = new Map<NodeJS.Timeout, string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
    private readonly sessions: AgentSessionRegistry,
    private readonly reaper: RunProcessReaper,
  ) {}

  onModuleInit(): void {
    this.sessions.onIdleClosed((runId) => {
      void this.afterExitGrace(runId).then(() => this.reap(runId));
    });
  }

  /**
   * Resolves once the kill grace after a CLI of the run exited has passed: its
   * exit signals its own group, MCP servers included, so what outlives the
   * grace is what the agents left, not the CLI. Never resolves after shutdown.
   */
  afterExitGrace(runId: string): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.graced.delete(timer);
        resolve();
      }, GROUP_KILL_GRACE_MS);
      this.graced.set(timer, runId);
    });
  }

  onApplicationShutdown(): void {
    this.graced.forEach((_runId, timer) => clearTimeout(timer));
    this.graced.clear();
  }

  /**
   * Whether a CLI of the run exited for going unused within the kill grace:
   * its own MCP servers may still be stopping, and are not the agents'.
   */
  awaitingGrace(runId: string): boolean {
    return [...this.graced.values()].includes(runId);
  }

  /**
   * The processes stopped for the run, once it has been told why (`cause`).
   * Never rejects. Two asking at once share one reap, which hands its
   * processes to one of them ({@link RunProcessReaper.reapIdle}), so the run
   * is told once.
   */
  async reap(
    runId: string,
    cause: LeftProcessesCause = 'idle',
  ): Promise<ScannedProcess[]> {
    const stopped = await this.reaper.reapIdle(runId);
    if (stopped.length > 0) {
      await this.tell(runId, stopped, cause).catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not note the processes stopped (${cause}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    return stopped;
  }

  private async tell(
    runId: string,
    stopped: ScannedProcess[],
    cause: LeftProcessesCause,
  ): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    // A deleted run has no transcript left, and an archived one is reaped by
    // its archive and refuses the next message the note is for.
    if (run === null || run.archivedAt !== null) {
      return;
    }
    const commands = commandsOf(stopped);
    const executables = executablesOf(stopped);
    const note =
      cause === 'finished-card'
        ? finishedStoppedNote(commands, executables, stopped.length)
        : idleStoppedNote(
            this.sessions.idleMinutes,
            commands,
            executables,
            stopped.length,
          );
    const row = mapEventToItem({
      type: 'notice',
      message: note.transcript,
      severity: 'warning',
      // Without one the renderer captions a warning `not applied`.
      caption: 'processes stopped',
    })!;
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
        memberId: null,
        seq: await this.seqs.reserve(runId),
        kind: row.kind,
        role: row.role,
        payload: row.payload,
      },
    );
    this.sessions.oweRunNote(runId, note.prompt);
  }
}

/**
 * The stopped processes no other stopped process started — a dev server, not
 * each of its workers.
 */
function startersOf(stopped: readonly ScannedProcess[]): ScannedProcess[] {
  const pids = new Set(stopped.map((process) => process.pid));
  return stopped.filter((process) => !pids.has(process.ppid));
}

/** Their command lines, masked, for the transcript the user reads. */
function commandsOf(stopped: readonly ScannedProcess[]): string[] {
  return startersOf(stopped).map((process) => maskedCommand(process.args));
}

/**
 * Their executables alone, for the prompt: an argv read from the process
 * table can carry a credential no agent typed, and the prompt leaves the
 * machine — in a team, possibly to another agent's provider.
 */
function executablesOf(stopped: readonly ScannedProcess[]): string[] {
  return [
    ...new Set(
      startersOf(stopped).map((process) => executableOf(process.args)),
    ),
  ];
}
