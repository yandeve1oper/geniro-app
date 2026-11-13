import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { BrowserBridgeService } from '../../browser/services/browser-bridge.service';
import { BrowserHostApprovals } from '../../browser/services/browser-host-approvals.service';
import { CallContextDao } from '../dao/call-context.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { ActionCommandRegistry } from './action-command.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ArtifactStoreService } from './artifact-store.service';
import { AttachmentStoreService } from './attachment-store.service';
import { ChatUploadStoreService } from './chat-upload-store.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { MonitorRegistry } from './monitor.registry';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import { RunProcessReaper } from './run-process-reaper.service';
import { SessionTranscriptsService } from './session-transcripts.service';
import { ThreadInboxService } from './thread-inbox.service';

/**
 * How long a purge waits for a cancelled turn to finish writing before it
 * destroys the run's rows anyway. Bounded on purpose: a wedged child must not
 * hang a delete the user asked for, and `cancel()` already escalates
 * SIGTERM→SIGKILL well inside this window.
 */
export const DELETE_SETTLE_TIMEOUT_MS = 5_000;

/** How long a delete waits for the command actions it ended to write their last row. */
const COMMAND_SETTLE_MS = 15_000;

/**
 * The teardown behind EVERY run delete — a single-agent chat
 * (`ChatService.delete`) and a team run (`TeamExecutorService.deleteRun`)
 * alike. Extracted rather than mirrored: the two kinds of run own the same
 * stores, so a second copy is how one of them silently keeps leaking a store
 * the other learned to clear.
 *
 * A delete is a ONE-WAY DOOR — there is no trash and none is planned, so
 * nothing here is recoverable.
 *
 * Order matters. The live turn is stopped FIRST: a running turn writes items as
 * it goes, so deleting its rows underneath it would let the turn re-create some
 * of them after the delete "finished".
 *
 * Every store the run touched is then cleared, because none of them cascade:
 * `Item.runId` is a plain string column with no FK, `node_state` is keyed by
 * `(runId, nodeId)`, `call_context` by `(runId, callId)`, attachments are files
 * on disk, and live CLI sessions,
 * partial streams, seq allocations and call tokens all live in in-memory
 * registries. A delete that dropped only the `runs` row would leave every one
 * of those behind, invisible and unreachable.
 *
 * What it deliberately does NOT do is decide WHICH runs may be deleted, or wait
 * for the caller's own notion of "finished": the run-kind guard and the settle
 * promise both come from the caller, because a chat waits on its turn finalizer
 * while a team waits on its executor's in-flight work.
 */
@Injectable()
export class RunTeardownService {
  private readonly logger = new Logger(RunTeardownService.name);

  constructor(
    private readonly itemDao: ItemDao,
    private readonly nodeStateDao: NodeStateDao,
    private readonly callContextDao: CallContextDao,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly callTokens: CallTokenRegistry,
    private readonly partials: PartialStreamService,
    private readonly attachments: AttachmentStoreService,
    private readonly artifacts: ArtifactStoreService,
    private readonly seqs: ItemSeqAllocator,
    private readonly transcripts: SessionTranscriptsService,
    private readonly uploads: ChatUploadStoreService,
    private readonly reaper: RunProcessReaper,
    private readonly wallTurns: WallTurnDao,
    private readonly commands: ActionCommandRegistry,
    private readonly threadInbox: ThreadInboxService,
    /** Optional for the positional specs. */
    @Optional() private readonly monitors?: MonitorRegistry,
    /** The run's in-app browser requests and approved hosts. Optional for the positional specs. */
    @Optional() private readonly browserBridge?: BrowserBridgeService,
    @Optional() private readonly browserApprovals?: BrowserHostApprovals,
  ) {}

  /**
   * Runs {@link endProcesses} ended that have not come back
   * ({@link resumeProcesses}). Set before the archive or delete completes,
   * which closes the race with a finished card's close in flight: their reap
   * is queued already, and a second request would be a second full reap. In
   * memory only: a deleted run's id is kept for the daemon's life, since a
   * card's end may still be in flight after the purge.
   */
  private readonly ended = new Set<string>();

  /**
   * End every process the run holds, for a run being archived or deleted.
   *
   * EVERY CLI of it — a team run keeps one per member and per conversation
   * under `<runId>::…`, and they outlive each of its passes — and then what its
   * agents started to outlive a turn: a detached dev server, a watcher, a
   * browser, which closing the CLI does not reach. The second half runs in the
   * background, so the caller's route never waits out its grace period. The
   * command actions the user ran in it, its agents' monitors and the browser
   * requests still waiting on the Mac's window are ended here too, and the hosts
   * the user allowed in its browser are forgotten.
   */
  endProcesses(runId: string): void {
    this.ended.add(runId);
    this.commands.abortRun(runId);
    this.monitors?.abortRun(runId);
    this.browserBridge?.rejectRun(runId, 'The chat was archived or deleted.');
    this.browserApprovals?.forget(runId);
    this.sessions.closeRun(runId);
    this.reaper.reapInBackground(runId);
  }

  /** Whether an archive or delete has ended this run ({@link ended}). */
  hasEnded(runId: string): boolean {
    return this.ended.has(runId);
  }

  /**
   * The second half of {@link endProcesses} alone — what the run's agents left
   * running detached — for a caller that closed the CLIs itself and waited for
   * them (a finished card's graceful close). Nothing for a run an archive or
   * delete ended meanwhile: that reap is the run's one.
   */
  reapDetached(runId: string): void {
    if (this.ended.has(runId)) {
      return;
    }
    this.reaper.reapInBackground(runId);
  }

  /**
   * {@link resumeProcesses} for an archive or delete that failed, only when the
   * run is still live: read from its own row on a fresh fork, not from how far
   * the failed call got. A read that fails keeps it ended.
   */
  async resumeIfLive(runId: string, em: EntityManager): Promise<void> {
    let live: boolean;
    try {
      const run = await this.runDao.getById(runId, em.fork());
      live = run !== null && run.archivedAt == null;
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not read whether it is still live after a failed archive or delete; it stays ended: ${String(err)}`,
      );
      return;
    }
    if (live) {
      this.resumeProcesses(runId);
    }
  }

  /** A run back from the archive: its command actions and monitors run again. */
  resumeProcesses(runId: string): void {
    this.ended.delete(runId);
    this.commands.allowRun(runId);
    this.monitors?.allowRun(runId);
  }

  /**
   * Stop the run's live work, then destroy everything it owns.
   *
   * `settled` is the caller's in-flight work, or undefined when nothing is in
   * flight. It must resolve only after that work's LAST write — awaiting a
   * turn's child-exit is not enough, since the finalizer that drains the
   * persist queue runs afterwards.
   */
  async purge(
    em: EntityManager,
    runId: string,
    settled: Promise<void> | undefined,
  ): Promise<{ deleted: boolean }> {
    this.registry.cancel(runId);
    // Cancel only SIGNALS; the caller's work keeps writing until it settles.
    // Wait for it before destroying anything, or it persists a terminal item
    // (and swept-approval rows) for a run whose `runs` row is already gone —
    // `Item.runId` has no FK, so those inserts SUCCEED, and the result is
    // transcript text that no route can ever reach or delete again. That is the
    // opposite of what this method promises.
    await this.awaitSettled(runId, settled);

    // The run's own CLI process, if it kept one between turns. The cancel
    // above stops the WORK but deliberately leaves the process running — that
    // is the whole point of a run-scoped session — so a delete that skipped
    // this would strand a CLI, and every MCP server it started, belonging to a
    // run that no longer exists and that nothing can ever reach again.
    this.endProcesses(runId);
    try {
      // A command action ended above still writes its closing row; one landing
      // after the rows below are gone would belong to no run.
      await this.commands.settled(runId, COMMAND_SETTLE_MS);
      await this.monitors?.settled(runId, COMMAND_SETTLE_MS);

      // The in-memory planes. Cleared next — pure bookkeeping, and a failure
      // here must not leave the durable rows half-deleted.
      this.callTokens.revokeRun(runId);
      this.partials.forgetRun(runId);
      // Dropped only AFTER the caller's work has settled (above), so nothing can
      // still be reserving against a tail we are discarding.
      this.seqs.forget(runId);

      // The transcript is the one table here measured in tens of thousands of
      // rows per run, each carrying a payload, so `ItemDao` purges it natively
      // rather than hydrating every row first (its override of this method). The
      // three below hold small rows with no payload and keep the base
      // unit-of-work path, which also evicts the run row the caller has just
      // read into this same EntityManager.
      // An ARCHIVED run's own CLI conversations go with it — the transcripts the
      // CLI keeps in its own store, which outlive every row below. Only an
      // archived one: that is the run the user deletes permanently, from the
      // archive or by its retention sweep, while the other callers of this purge
      // (a task start that failed, a team builder's chat) are tidying up
      // after the app rather than deleting a conversation the user named. Read
      // HERE, before the `node_state` rows naming the sessions are destroyed;
      // deleted at the end, once every process is closed and the run is gone.
      const run = await this.runDao.getById(runId, em);
      const transcripts =
        run?.archivedAt != null
          ? {
              createdAt: run.createdAt,
              targets: await this.transcripts.collect(run, em),
            }
          : null;

      // The files a phone uploaded into this run's messages. An upload is
      // reachable only through the text naming its path, so it is read out of
      // the user's own messages BEFORE they are destroyed and removed with the
      // rest below (`ChatUploadStoreService.removeReferenced`). A narrow read of
      // those few rows' payloads — never the transcript, which the purge below
      // deliberately does not hydrate. The raw payload is scanned rather than
      // parsed: the path survives JSON encoding intact.
      const uploadTexts = await this.itemDao.userMessagePayloads(runId, em);

      // Before the rows go: it names the thread to each sender of what waited.
      await this.threadInbox.cancelFor(runId, 'deleted');

      const items = await this.itemDao.hardDeleteIncludingSoftDeleted(
        { runId },
        em,
      );
      const nodeStates = await this.nodeStateDao.hardDeleteIncludingSoftDeleted(
        { runId },
        em,
      );
      const callContexts =
        await this.callContextDao.hardDeleteIncludingSoftDeleted({ runId }, em);
      // The run's wall-measured turns go with it: they are run-scoped, a part of
      // its agents' worked time, unlike the usage ledgers that outlive a delete.
      await this.wallTurns.hardDeleteIncludingSoftDeleted({ runId }, em);
      await this.runDao.hardDeleteIncludingSoftDeleted({ id: runId }, em);
      this.attachments.removeRun(runId);
      this.artifacts.removeRun(runId);
      await this.uploads.removeReferenced(uploadTexts);

      if (transcripts !== null) {
        await this.transcripts.remove(
          runId,
          transcripts.createdAt,
          transcripts.targets,
          em,
        );
      }

      // Announced last, once the run genuinely no longer exists: modules above
      // this one hold per-run state and drop it on this signal.
      this.bus.publishRunDeleted(runId);

      this.logger.log(
        `deleted run ${runId}: ${items} item(s), ${nodeStates} node state(s), ${callContexts} call context(s), attachments and artifacts dropped`,
      );
      return { deleted: true };
    } catch (err) {
      await this.resumeIfLive(runId, em);
      throw err;
    }
  }

  /**
   * Wait for the run's in-flight work to finish, bounded by
   * {@link DELETE_SETTLE_TIMEOUT_MS}. Resolves immediately when nothing is in
   * flight. A timeout is REPORTED rather than silently accepted: past it the
   * purge destroys the rows anyway, so a straggling writer can still orphan a
   * row, and the log line is the only trace of why.
   */
  private async awaitSettled(
    runId: string,
    settled: Promise<void> | undefined,
  ): Promise<void> {
    if (!settled) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      // Rejection is treated as settled: a failed finalizer has stopped
      // writing, which is all this wait is about.
      settled.then(
        () => false,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), DELETE_SETTLE_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) {
        clearTimeout(timer);
      }
    });
    if (timedOut) {
      this.logger.warn(
        `run ${runId} did not settle within ${DELETE_SETTLE_TIMEOUT_MS}ms — deleting anyway; a late write may orphan a row`,
      );
    }
  }
}
