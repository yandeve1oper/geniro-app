import { setTimeout as sleep } from 'node:timers/promises';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import {
  isSameProcess,
  parseStartTimes,
} from '../../../utils/process-identity';
import { currentChildJournal } from '../utils/child-journal';
import { executableOf } from '../utils/command-text';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import { descendantsOf } from '../utils/process-descendants';
import {
  isGroupAnchored,
  type RecordedGroup,
} from '../utils/process-descendants';
import {
  listProcessUsage,
  processTreeOf,
  type ProcessUsageRow,
} from '../utils/process-usage';
import {
  capSelection,
  daemonChain,
  fencedPids,
  type PlainProcess,
  type ScannedProcess,
  scanPlainTable,
  type StopCandidate,
} from '../utils/run-process-scan';
import { runPs } from '../utils/run-ps';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { RunProcessAttribution } from './run-process-attribution.service';

/**
 * Seams — `createRunProcessReaper` passes `held` and `processRoots`, the module
 * adds `stillGone`; specs pass the rest.
 */
export interface RunProcessReaperOptions {
  /**
   * Whether the registry holds a live agent process under the run right now,
   * or the user is running one of its command actions. Such a run was used
   * after its reap was queued, and its processes are working, not leftovers.
   */
  held?: (runId: string) => boolean;
  processRoots?: () => readonly number[];
  listUsage?: () => Promise<ProcessUsageRow[] | null>;
  /** The table {@link RunProcessReaper.stopLeftGroups} reads. */
  listGroups?: () => Promise<PlainProcess[] | null>;
  /** The user the daemon runs as; null when the platform cannot say, and then nothing is stopped. */
  uid?: number | null;
  /**
   * Which of these runs are still deleted or archived. Asked after the scan
   * for a reap the SWEEP queued, whose verdict may be minutes old — never for
   * an archive or delete, which the user has just made.
   */
  stillGone?: (runIds: string[]) => Promise<ReadonlySet<string>>;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  /** Start times (epoch ms) of whichever of `pids` are alive. */
  startTimes?: (pids: number[]) => Promise<Map<number, number> | null>;
  wait?: (ms: number) => Promise<void>;
  logger?: { log(msg: string): void; warn(msg: string): void };
  selfPid?: number;
}

/** One process about to be signalled, and the run it is stopped for. */
interface Target {
  row: ScannedProcess;
  runId: string;
}

/** A run waiting for the next reap, and who is waiting to hear what it stopped. */
interface QueuedReap {
  onlyIfStillGone: boolean;
  waiters: ((stopped: ScannedProcess[]) => void)[];
}

/**
 * Whether a pid may never be signalled, whatever selected it: launchd, the
 * whole-session `-1`, and the daemon itself.
 */
export function isUnsignallable(pid: number, selfPid: number): boolean {
  return pid <= 1 || pid === selfPid;
}

/**
 * Stop every process a run's agents left behind, once the run is archived or
 * deleted — or, through the sweep, once it turns out to be gone — and once it
 * has sat unused for the kept-session window ({@link reapIdle}).
 *
 * Closing the run's sessions ends the agent CLIs, but not what they started
 * DETACHED to outlive a turn — `nohup pnpm dev`, a watcher, a headless browser.
 * Those are reparented to launchd and nothing the daemon holds still points at
 * them. What still does is their environment: every run-scoped CLI is spawned
 * with the run's tag, and its descendants inherit it (`attributeRunProcesses`).
 *
 * Signals go to explicit pids only — never a process group, never a pattern —
 * and each pid is confirmed to be the process that was listed (its kernel
 * start time) before either signal reaches it. Anything that cannot be
 * confirmed is left alone: a surviving dev server costs memory, a wrong kill
 * costs the user their session.
 */
@Injectable()
export class RunProcessReaper {
  private readonly logger: NonNullable<RunProcessReaperOptions['logger']>;
  private readonly held: (runId: string) => boolean;
  private readonly stillGone: (
    runIds: string[],
  ) => Promise<ReadonlySet<string>>;
  private readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  private readonly startTimes: (
    pids: number[],
  ) => Promise<Map<number, number> | null>;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly selfPid: number;
  private readonly processRoots: () => readonly number[];
  private readonly listUsage: () => Promise<ProcessUsageRow[] | null>;
  private readonly listGroups: () => Promise<PlainProcess[] | null>;
  private readonly uid: number | null;
  /** Runs waiting for the next reap; one reap runs at a time, over one scan. */
  private readonly queued = new Map<string, QueuedReap>();
  private draining: Promise<void> | null = null;

  constructor(
    private readonly attribution: RunProcessAttribution,
    options: RunProcessReaperOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(RunProcessReaper.name);
    this.held = options.held ?? (() => false);
    this.stillGone =
      options.stillGone ?? ((runIds) => Promise.resolve(new Set(runIds)));
    this.signal = options.signal ?? ((pid, sig) => process.kill(pid, sig));
    this.startTimes = options.startTimes ?? readStartTimes;
    this.wait = options.wait ?? ((ms) => sleep(ms));
    this.selfPid = options.selfPid ?? process.pid;
    this.processRoots = options.processRoots ?? (() => []);
    this.listUsage = options.listUsage ?? listProcessUsage;
    this.listGroups = options.listGroups ?? scanPlainTable;
    this.uid =
      options.uid !== undefined ? options.uid : (process.getuid?.() ?? null);
  }

  /**
   * Reap in the background. A teardown route must not wait out the grace
   * period, and a failure here must not fail the archive or delete it follows.
   *
   * Queued rather than started: a retention sweep deletes runs one after
   * another, and a full `ps -E` per run, all at once, is megabytes each. What
   * queued while a reap ran is reaped together, over one scan.
   */
  reapInBackground(runId: string, onlyIfStillGone = false): void {
    this.enqueue(runId, onlyIfStillGone, null);
  }

  /**
   * Stop what a run that went unused for the kept-session window left running,
   * resolving with the processes stopped for it — empty when nothing was, or
   * the reap was refused or failed. Never rejects. Two asking for one run in
   * the same reap: the first is handed what it stopped, the rest nothing, so
   * the run is told once.
   *
   * Unconditional, unlike the sweep's reap of a gone run: a run is used again
   * only through a kept CLI process or a command action the user ran, and
   * {@link held}, asked after the scan, sees both.
   */
  reapIdle(runId: string): Promise<ScannedProcess[]> {
    return new Promise((resolve) => {
      if (!this.enqueue(runId, false, resolve)) {
        resolve([]);
      }
    });
  }

  private enqueue(
    runId: string,
    onlyIfStillGone: boolean,
    waiter: QueuedReap['waiters'][number] | null,
  ): boolean {
    if (runId.trim() === '') {
      return false;
    }
    const prior = this.queued.get(runId);
    this.queued.set(runId, {
      // An unconditional request wins: an archive is not undone by a sweep's
      // stale verdict queued beside it.
      onlyIfStillGone: onlyIfStillGone && (prior?.onlyIfStillGone ?? true),
      waiters: [
        ...(prior?.waiters ?? []),
        ...(waiter === null ? [] : [waiter]),
      ],
    });
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return true;
  }

  /** Resolves once every queued reap has finished. For the sweep and specs. */
  async settled(): Promise<void> {
    while (this.draining !== null) {
      await this.draining;
    }
  }

  private async drain(): Promise<void> {
    while (this.queued.size > 0) {
      const batch = [...this.queued];
      this.queued.clear();
      const runIds = batch.map(([id]) => id);
      const conditional = new Set(
        batch.filter(([, queued]) => queued.onlyIfStillGone).map(([id]) => id),
      );
      let stopped: Target[] = [];
      try {
        stopped = await this.reapTargets(runIds, conditional);
      } catch (err: unknown) {
        this.logger.warn(
          `could not stop the processes of run(s) ${runIds.join(', ')}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      for (const [runId, { waiters }] of batch) {
        const rows = stopped
          .filter((target) => target.runId === runId)
          .map((target) => target.row);
        waiters.forEach((waiter, index) => waiter(index === 0 ? rows : []));
      }
    }
  }

  /** SIGTERM, a grace period, then SIGKILL for survivors. Returns the pids signalled. */
  async reap(
    runIds: readonly string[],
    onlyIfStillGone: ReadonlySet<string> = new Set(),
  ): Promise<number[]> {
    return pidsOf(await this.reapTargets(runIds, onlyIfStillGone));
  }

  private async reapTargets(
    runIds: readonly string[],
    onlyIfStillGone: ReadonlySet<string>,
  ): Promise<Target[]> {
    const wanted = runIds.filter((runId) => runId.trim() !== '');
    if (wanted.length === 0) {
      return [];
    }
    const reading = await this.attribution.attribute('fresh');
    if (reading === null) {
      this.logger.warn(
        `could not read the process table — left the processes of run(s) ${wanted.join(', ')} alone`,
      );
      return [];
    }
    const gone =
      onlyIfStillGone.size === 0
        ? new Set<string>()
        : await this.stillGone([...onlyIfStillGone]);
    const targets: Target[] = [];
    for (const runId of wanted) {
      if (onlyIfStillGone.has(runId) && !gone.has(runId)) {
        this.logger.log(
          `run ${runId} is back in use — left its processes alone`,
        );
        continue;
      }
      // Asked AFTER the scan: whatever the registry holds by now was spawned
      // before the table was read, so it is in it — and is not ours to end.
      if (this.held(runId)) {
        this.logger.log(
          `run ${runId} has a live agent again — left its processes alone`,
        );
        continue;
      }
      const { targets: selected, overCap } = capSelection(
        reading.get(runId) ?? [],
      );
      if (overCap !== null) {
        this.logger.warn(
          `run ${runId} matched ${overCap.count} processes, more than a run can own — killed none. First of them: ${overCap.sample
            .map((row) => `${row.pid} (${nameOf(row)})`)
            .join(', ')}`,
        );
        continue;
      }
      targets.push(...selected.map((row) => ({ row, runId })));
    }
    return this.stopTargets(targets, wanted);
  }

  async stopDetached(
    runId: string,
    pids: readonly number[],
  ): Promise<number[]> {
    const { targets, usage, roots } = await this.freshReading(runId);
    const held = new Set(
      roots.flatMap((pid) => processTreeOf(usage, pid).map((row) => row.pid)),
    );
    const detached = new Map(
      targets.filter((row) => !held.has(row.pid)).map((row) => [row.pid, row]),
    );
    const selected = [...new Set(pids)];
    if (selected.some((pid) => !detached.has(pid))) {
      throw new BadRequestException(
        'PROCESS_NOT_DETACHED',
        'a selected process is no longer detached from this thread; refresh and try again',
      );
    }
    if (
      selected.some((pid) => {
        const usageRow = usage.find((row) => row.pid === pid);
        return (
          usageRow === undefined || usageRow.ppid !== detached.get(pid)?.ppid
        );
      })
    ) {
      throw new BadRequestException(
        'PROCESS_TABLE_CHANGED',
        'a selected process changed while reading; refresh and try again',
      );
    }
    return pidsOf(
      await this.stopTargets(
        selected.map((pid) => ({
          row: detached.get(pid) as ScannedProcess,
          runId,
        })),
        [runId],
        true,
      ),
    );
  }

  /**
   * Stop what a run's agent CLI left running when it ended without stopping it
   * itself — a crash, an OOM kill, a Force Quit, or a close whose escalation
   * cut its shutdown short. A CLI starts each background command in a session
   * of its own and stops them only from its own shutdown, so once it is gone
   * nothing points at them but the groups its session recorded while it lived.
   *
   * A group is acted on only while a recorded member is still alive in it, so
   * its id cannot have been reused, and never the daemon's own group. Its
   * current members are then stopped as explicit pids, minus what no run may
   * own and every tree the registry holds — but not for being on a terminal:
   * the groups were the agent's by structure when recorded, and codex runs its
   * commands on a pseudo-terminal of its own.
   *
   * Resolves to the pids it stopped, or null when it could not act at all
   * (no uid, an unreadable table, a selection over the cap), so a caller
   * keeping a record of the groups knows to keep it. Never throws.
   */
  async stopLeftGroups(
    runId: string,
    groups: readonly RecordedGroup[],
  ): Promise<number[] | null> {
    if (groups.length === 0) {
      return [];
    }
    try {
      // A CLI ending on its own terms may still be stopping its commands as
      // it goes: what outlives the grace a kill gives is what it left.
      await this.wait(GROUP_KILL_GRACE_MS);
      if (this.uid === null) {
        this.logger.warn(
          `could not tell which user the daemon runs as — left what run ${runId}'s agent left running alone`,
        );
        return null;
      }
      const rows = await this.listGroups();
      if (rows === null) {
        this.logger.warn(
          `could not read the process table — left what run ${runId}'s agent left running alone`,
        );
        return null;
      }
      const chain = daemonChain(rows, this.selfPid);
      const daemonGroup = rows.find((row) => row.pid === this.selfPid)?.pgid;
      const anchored = new Set(
        groups
          .filter(
            (group) =>
              group.pgid > 1 &&
              group.pgid !== daemonGroup &&
              isGroupAnchored(group, rows),
          )
          .map((group) => group.pgid),
      );
      const spared = new Set([
        ...chain,
        ...fencedPids(rows, this.uid, chain, false),
      ]);
      for (const root of this.processRoots()) {
        for (const row of processTreeOf(rows, root)) {
          spared.add(row.pid);
        }
      }
      const { targets, overCap } = capSelection(
        rows
          .filter(
            (row) =>
              anchored.has(row.pgid) && row.pid > 1 && !spared.has(row.pid),
          )
          .map((row) => ({ ...row, env: null })),
      );
      if (overCap !== null) {
        this.logger.warn(
          `run ${runId}'s agent left ${overCap.count} processes, more than a run can own — killed none. First of them: ${overCap.sample
            .map((row) => `${row.pid} (${nameOf(row)})`)
            .join(', ')}`,
        );
        return null;
      }
      return pidsOf(
        await this.stopTargets(
          targets.map((row) => ({ row, runId })),
          [runId],
        ),
      );
    } catch (err: unknown) {
      this.logger.warn(
        `could not stop what run ${runId}'s agent left running: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /**
   * The processes of `runId` an agent's stop action may name, from a fresh
   * reading: the run's own, less every live CLI and every member of a CLI's
   * own process group — its MCP servers and helpers. A command the agent
   * backgrounded runs in a group of its own, so it stays stoppable while the
   * agent that started it is alive, which {@link stopDetached}'s whole-tree
   * exclusion would not allow.
   */
  async stopCandidates(runId: string): Promise<StopCandidate[]> {
    const reading = await this.freshReading(runId);
    const { targets, usage } = reading;
    const roots = new Set(reading.roots);
    // A root that leads no group shares its spawner's, the daemon's; its pid
    // then names no group, so `roots.has(pgid)` only matches a CLI's own.
    const groupOf = new Map(usage.map((row) => [row.pid, row.pgid]));
    return targets.filter((row): row is StopCandidate => {
      const pgid = groupOf.get(row.pid);
      return (
        pgid !== undefined &&
        !roots.has(row.pid) &&
        !roots.has(pgid) &&
        !isUnsignallable(row.pid, this.selfPid) &&
        row.startedAt !== null
      );
    });
  }

  /**
   * Stop the processes a stop action recorded at publish, and whatever they
   * have started since that is still a candidate — a dev server's workers
   * hold its port. A target that has exited — its pid gone, or held by a
   * process that started later — is `gone` and never signalled. A target
   * still alive as the process recorded but no longer among
   * {@link stopCandidates} refuses the whole press: it left the run, or
   * became an agent's own, since it was published.
   */
  async stopRecorded(
    runId: string,
    targets: readonly { pid: number; startedAt: number }[],
  ): Promise<{ stopped: number[]; gone: number[] }> {
    const candidates = new Map(
      (await this.stopCandidates(runId)).map((row) => [row.pid, row]),
    );
    const alive = await this.startTimes(targets.map((target) => target.pid));
    if (alive === null) {
      throw new BadRequestException(
        'PROCESS_IDENTITY_UNREADABLE',
        'could not confirm process identities; try again',
      );
    }
    const live: Target[] = [];
    for (const target of targets) {
      if (!isSameProcess(target.pid, target.startedAt, alive)) {
        continue;
      }
      const row = candidates.get(target.pid);
      if (
        row === undefined ||
        !isSameProcess(
          target.pid,
          target.startedAt,
          new Map([[row.pid, row.startedAt]]),
        )
      ) {
        throw new BadRequestException(
          'PROCESS_CHANGED',
          `pid ${target.pid} is no longer a process this thread may stop; stopped none`,
        );
      }
      live.push({ row, runId });
    }
    const chosen = new Set(live.map(({ row }) => row.pid));
    for (const { row } of [...live]) {
      for (const child of descendantsOf([...candidates.values()], row.pid)) {
        const candidate = candidates.get(child.pid);
        if (candidate !== undefined && !chosen.has(child.pid)) {
          chosen.add(child.pid);
          live.push({ row: candidate, runId });
        }
      }
    }
    const stopped = pidsOf(await this.stopTargets(live, [runId], true));
    return {
      stopped,
      gone: targets
        .map((target) => target.pid)
        .filter((pid) => !stopped.includes(pid)),
    };
  }

  /**
   * The run's processes, the usage table and the live CLI roots, all read
   * fresh — refused rather than guessed at when either table is unreadable,
   * the run is over the cap, or a root is missing from the usage table.
   */
  private async freshReading(runId: string): Promise<{
    targets: ScannedProcess[];
    usage: ProcessUsageRow[];
    roots: readonly number[];
  }> {
    const [reading, usage] = await Promise.all([
      this.attribution.attribute('fresh'),
      this.listUsage(),
    ]);
    if (reading === null || usage === null) {
      throw new BadRequestException(
        'PROCESS_TABLE_UNREADABLE',
        'could not safely read the process table; try again',
      );
    }
    const { targets, overCap } = capSelection(reading.get(runId) ?? []);
    if (overCap !== null) {
      throw new BadRequestException(
        'RUN_PROCESS_CAP',
        'too many processes belong to this thread; stopped none',
      );
    }
    // The registry is read after both tables: a newly held CLI must never be
    // mistaken for a stand, including orphaned members of its process group.
    const roots = this.processRoots();
    if (roots.some((pid) => !usage.some((row) => row.pid === pid))) {
      throw new BadRequestException(
        'PROCESS_TABLE_CHANGED',
        'an agent process changed while reading; try again',
      );
    }
    return { targets, usage, roots };
  }

  /** Returns the targets that took the SIGTERM. */
  private async stopTargets(
    targets: readonly Target[],
    wanted: readonly string[],
    reportFailure = false,
  ): Promise<Target[]> {
    const terminated = await this.signalConfirmed(
      targets,
      'SIGTERM',
      reportFailure,
    );
    if (terminated.length === 0) {
      return [];
    }
    await this.wait(GROUP_KILL_GRACE_MS);
    let killed: Target[];
    try {
      killed = await this.signalConfirmed(terminated, 'SIGKILL', reportFailure);
    } catch (err) {
      // The refusal must not read as "nothing happened": these already have
      // their SIGTERM.
      if (err instanceof BadRequestException) {
        throw new BadRequestException(
          err.errorCode,
          `sent SIGTERM to ${terminated.length} process(es), then ${err.message}`,
        );
      }
      throw err;
    }
    this.logger.log(
      `stopped ${terminated.length} process(es) of run(s) ${wanted.join(', ')}; ${killed.length} needed SIGKILL`,
    );
    return terminated;
  }

  /**
   * Signal each target still confirmed to be the process that was listed.
   * Those gone, or whose pid now belongs to something else, are skipped.
   */
  private async signalConfirmed(
    targets: readonly Target[],
    sig: NodeJS.Signals,
    reportFailure = false,
  ): Promise<Target[]> {
    if (targets.length === 0) {
      return [];
    }
    const alive = await this.startTimes(targets.map(({ row }) => row.pid));
    if (alive === null) {
      if (reportFailure) {
        throw new BadRequestException(
          'PROCESS_IDENTITY_UNREADABLE',
          'could not confirm process identities; refresh and try again',
        );
      }
      return [];
    }
    const signalled: Target[] = [];
    for (const target of targets) {
      const { row, runId } = target;
      if (
        isUnsignallable(row.pid, this.selfPid) ||
        row.startedAt === null ||
        !isSameProcess(row.pid, row.startedAt, alive)
      ) {
        continue;
      }
      try {
        this.signal(row.pid, sig);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.logger.warn(
            `could not send ${sig} to pid ${row.pid} (${nameOf(row)}) of run ${runId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          if (reportFailure) {
            throw new BadRequestException(
              'PROCESS_SIGNAL_FAILED',
              `could not stop pid ${row.pid} (${nameOf(row)}); refresh and try again`,
            );
          }
        }
        continue;
      }
      signalled.push(target);
      // The executable only: an argv can carry a credential, and this line
      // reaches the debug log a user attaches to a bug report.
      this.logger.log(`${sig} pid ${row.pid} (${nameOf(row)}) of run ${runId}`);
    }
    return signalled;
  }
}

function pidsOf(targets: readonly Target[]): number[] {
  return targets.map((target) => target.row.pid);
}

function nameOf(row: ScannedProcess): string {
  return executableOf(row.args);
}

/**
 * Start times from one asynchronous listing of the whole table. The per-pid
 * probe in `process-identity` is synchronous and falls back to one `ps` per pid
 * when none of them is alive — the normal case after a SIGTERM — which would
 * stall the daemon for every run it serves.
 */
async function readStartTimes(
  pids: number[],
): Promise<Map<number, number> | null> {
  const out = await runPs(['-axww', '-o', 'pid=,lstart=']);
  if (out === null) {
    return null;
  }
  const wanted = new Set(pids);
  return new Map([...parseStartTimes(out)].filter(([pid]) => wanted.has(pid)));
}

/**
 * The reaper as the agents module provides it: it asks the registry which
 * processes are a live agent's, and is handed what a run's CLI left running
 * whenever a process ends ({@link AgentSessionRegistry.onLeftCommands}). A
 * run with work running that the user started through it — a command action
 * (`ActionCommandRegistry`), a monitor (`MonitorRegistry`) — is held too;
 * archive and delete end that work first, so they still reap the run.
 */
export function createRunProcessReaper(
  attribution: RunProcessAttribution,
  sessions: AgentSessionRegistry,
  heldWork: readonly { isRunning(runId: string): boolean }[],
  options: RunProcessReaperOptions = {},
): RunProcessReaper {
  const reaper = new RunProcessReaper(attribution, {
    held: (runId) =>
      sessions.processRoots(runId).length > 0 ||
      heldWork.some((work) => work.isRunning(runId)),
    processRoots: () => sessions.processRoots().map((root) => root.pid),
    ...options,
  });
  sessions.onLeftCommands((runId, left) => {
    void reaper.stopLeftGroups(runId, left.groups).then((stopped) => {
      if (stopped !== null && left.pid !== undefined) {
        currentChildJournal()?.forgetCommandGroups(left.pid);
      }
    });
  });
  return reaper;
}
