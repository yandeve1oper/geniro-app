import { readFileSync, rmSync } from 'node:fs';

import { atomicWriteSync } from '../../../utils/atomic-file';
import type { RecordedGroup } from './process-descendants';

/**
 * The on-disk record of every process GROUP this daemon launch has spawned.
 *
 * `ProcessRegistry` already reaps children on the graceful path, and that is
 * the only path it can serve: it lives in memory. A SIGKILL — the UI
 * supervisor's escalation past its shutdown grace, a crash, a `kill -9` — skips
 * Nest's shutdown hooks entirely, and because every agent child is spawned
 * `detached` (a group leader, so cancel can reach its tool/MCP grandchildren)
 * the group is NOT in the daemon's own process group and does not die with it.
 * It is reparented to launchd and runs until the machine reboots.
 *
 * Measured on this machine before the journal existed: two `cursor-agent acp`
 * groups, ppid 1, 14 hours old, 217 MB resident each, blocked forever on a
 * stdin nobody would ever write to again. Nothing in the daemon knew they
 * existed — which is the actual gap. Killing them needs no cleverness, only a
 * record that outlives the process that made it.
 *
 * So: write the group down when it is spawned, erase it when it exits, and
 * sweep whatever the file still holds at the next boot
 * ({@link StrandedChildReaper}). The file is authoritative only about groups
 * this daemon started; identity is re-verified against the kernel before
 * anything is signalled (see `utils/process-identity`).
 *
 * A CLI's detached commands run in sessions of their own, out of reach of its
 * group kill, so the groups its session records for them are written here too
 * ({@link JournaledCommandGroups}): kept past the CLI's exit until the live
 * daemon has stopped what it left, and handed to the same stop at the next boot
 * when the daemon died first.
 */

/** Journal file name under the userData dir. */
export const CHILD_JOURNAL_FILE_NAME = 'children.json';

/** One spawned process group, as recorded at spawn time. */
export interface JournaledChild {
  /**
   * The child's pid, which doubles as its process-GROUP id — every spawn this
   * journal covers is `detached`, so the leader's pid names the whole group.
   */
  pid: number;
  /** `Date.now()` at the spawn, the identity check the reaper re-verifies. */
  startedAt: number;
  /** The binary, for the reap log — a stray should be nameable, not just a pid. */
  command: string;
}

/** The command groups one CLI session last recorded, under that CLI's pid. */
export interface JournaledCommandGroups {
  cliPid: number;
  /** The run the CLI was spawned for (its run tag), null for an untagged spawn. */
  runId: string | null;
  groups: RecordedGroup[];
}

/** The journal file's shape. */
export interface ChildJournalFile {
  version: 2;
  /**
   * The daemon that wrote this file.
   *
   * The reaper refuses to act on a journal whose owner is still alive: those
   * groups belong to a RUNNING daemon, and reaping them would kill another
   * instance's in-flight turns. The instance lock makes that combination
   * unreachable, and this makes it harmless if it ever becomes reachable
   * again.
   */
  ownerPid: number;
  /**
   * That daemon's process start time (epoch ms), so "still alive" is asked of
   * the PROCESS and not of a number.
   *
   * With the pid alone, a previous daemon whose pid had since been recycled
   * — by anything at all — read as a live owner, the reaper left its strays
   * running, and this launch's first spawn then rewrote the file with its own
   * children only: the previous launch's groups were never recorded anywhere
   * again. The same identity check the children get (`utils/process-identity`)
   * now decides for the owner too.
   */
  ownerStartedAt: number;
  children: JournaledChild[];
  /** Absent in a file an older daemon wrote. */
  commandGroups?: JournaledCommandGroups[];
}

const JOURNAL_VERSION = 2;

/**
 * This process's own start time, from `process.uptime()` — exact to a few
 * milliseconds and free, so no `ps` is spawned for it on the spawn path; well
 * inside the identity tolerance the reaper compares it with.
 */
function ownStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

/** Where a journal failure is reported. Never throws into a spawn path. */
export interface ChildJournalLogger {
  warn(message: string): void;
}

/**
 * A path-bound journal.
 *
 * Every method swallows its own I/O failure after reporting it: a full disk
 * must degrade this to "strays are not tracked this launch", never to a turn
 * that fails to start. The read side is the one place that must NOT swallow
 * quietly — an unreadable journal is indistinguishable from an empty one, and
 * both must reap nothing, so the log line is the only signal there is.
 */
export class ChildJournal {
  private readonly children = new Map<number, JournaledChild>();

  private readonly commandGroups = new Map<number, JournaledCommandGroups>();

  private readonly ownerStartedAt = ownStartedAt();

  constructor(
    private readonly path: string,
    private readonly logger?: ChildJournalLogger,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a live process group. Returns what was recorded, for the caller's log. */
  record(pid: number, command: string): JournaledChild {
    const entry: JournaledChild = { pid, startedAt: this.now(), command };
    this.children.set(pid, entry);
    this.flush();
    return entry;
  }

  /** Drop a group that has exited. */
  forget(pid: number): void {
    if (this.children.delete(pid)) {
      this.flush();
    }
  }

  /**
   * Replace what `cliPid`'s session records of its commands' groups; none
   * drops the entry. Writes the file only when the record changed, since a
   * session re-reads its groups every few seconds while a command runs.
   */
  recordCommandGroups(
    cliPid: number,
    runId: string | null,
    groups: readonly RecordedGroup[],
  ): void {
    const previous = this.commandGroups.get(cliPid);
    if (groups.length === 0) {
      this.forgetCommandGroups(cliPid);
      return;
    }
    const entry: JournaledCommandGroups = {
      cliPid,
      runId,
      groups: groups.map((group) => ({
        pgid: group.pgid,
        members: group.members.map(({ pid, startedAt }) => ({
          pid,
          startedAt,
        })),
      })),
    };
    if (
      previous !== undefined &&
      JSON.stringify(previous) === JSON.stringify(entry)
    ) {
      return;
    }
    this.commandGroups.set(cliPid, entry);
    this.flush();
  }

  /** Drop `cliPid`'s command groups, once what they left has been dealt with. */
  forgetCommandGroups(cliPid: number): void {
    if (this.commandGroups.delete(cliPid)) {
      this.flush();
    }
  }

  /** Groups this instance believes are live — the in-memory half. */
  live(): JournaledChild[] {
    return [...this.children.values()];
  }

  private flush(): void {
    const file: ChildJournalFile = {
      version: JOURNAL_VERSION,
      ownerPid: process.pid,
      ownerStartedAt: this.ownerStartedAt,
      children: [...this.children.values()],
      commandGroups: [...this.commandGroups.values()],
    };
    try {
      atomicWriteSync(this.path, JSON.stringify(file));
    } catch (err) {
      this.logger?.warn(
        `could not write the child journal at ${this.path}: ${errorText(err)} — strays from this launch will not be reaped`,
      );
    }
  }
}

/**
 * Read a journal left by a previous launch.
 *
 * Returns null for "there is nothing to act on", which deliberately covers a
 * missing file, an unreadable one, and one whose contents do not parse as this
 * version's shape. A caller must not be able to tell those apart, because the
 * only safe response to all three is the same: reap nothing.
 */
export function readChildJournal(
  path: string,
  logger?: ChildJournalLogger,
): ChildJournalFile | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null; // No journal — a first launch, or a clean previous shutdown.
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isChildJournalFile(parsed)) {
      logger?.warn(
        `child journal at ${path} is not in a shape this daemon understands — ignoring it`,
      );
      return null;
    }
    return { ...parsed, commandGroups: commandGroupsOf(parsed, path, logger) };
  } catch (err) {
    logger?.warn(
      `could not parse the child journal at ${path}: ${errorText(err)} — ignoring it`,
    );
    return null;
  }
}

/** Remove the journal file, after its entries have been dealt with. */
export function clearChildJournal(path: string): void {
  rmSync(path, { force: true });
}

function isChildJournalFile(value: unknown): value is ChildJournalFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { version, ownerPid, ownerStartedAt, children } = value as Record<
    string,
    unknown
  >;
  return (
    version === JOURNAL_VERSION &&
    typeof ownerPid === 'number' &&
    typeof ownerStartedAt === 'number' &&
    Array.isArray(children) &&
    children.every(isJournaledChild)
  );
}

/**
 * The well-formed command-group entries of a journal. A malformed entry is
 * dropped on its own: it must not cost the CLI groups beside it their reap.
 */
function commandGroupsOf(
  file: ChildJournalFile,
  path: string,
  logger?: ChildJournalLogger,
): JournaledCommandGroups[] {
  const entries = (file as { commandGroups?: unknown }).commandGroups;
  if (entries === undefined) {
    return [];
  }
  if (!Array.isArray(entries)) {
    logger?.warn(
      `child journal at ${path} holds command groups in a shape this daemon does not understand — ignoring them`,
    );
    return [];
  }
  const valid = entries.filter(isJournaledCommandGroups);
  if (valid.length < entries.length) {
    logger?.warn(
      `child journal at ${path} holds ${entries.length - valid.length} malformed command-group entries — ignoring them`,
    );
  }
  return valid;
}

function isJournaledCommandGroups(
  value: unknown,
): value is JournaledCommandGroups {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { cliPid, runId, groups } = value as Record<string, unknown>;
  return (
    isPositiveInteger(cliPid) &&
    (runId === null || typeof runId === 'string') &&
    Array.isArray(groups) &&
    groups.every(isRecordedGroup)
  );
}

function isRecordedGroup(value: unknown): value is RecordedGroup {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { pgid, members } = value as Record<string, unknown>;
  return (
    isPositiveInteger(pgid) &&
    Array.isArray(members) &&
    members.every((member: unknown) => {
      if (typeof member !== 'object' || member === null) {
        return false;
      }
      const { pid, startedAt } = member as Record<string, unknown>;
      return isPositiveInteger(pid) && typeof startedAt === 'number';
    })
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isJournaledChild(value: unknown): value is JournaledChild {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { pid, startedAt, command } = value as Record<string, unknown>;
  return (
    typeof pid === 'number' &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof startedAt === 'number' &&
    typeof command === 'string'
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The journal every production spawn writes to.
 *
 * Process-global because the thing it describes is process-global — the set of
 * groups THIS daemon has running — and because the two spawn sites that must
 * record ({@link trackDetachedChild}'s callers) sit at the bottom of the
 * adapter layer, below any DI. Threading a collaborator down to them would
 * have meant an optional parameter at four call sites, and an optional
 * collaborator is one a caller can quietly omit; this module's own history
 * (`AgentAdapterOptions.logger`, which shipped undefined into the one build
 * that mattered) is the argument against that.
 *
 * Disabled until {@link configureChildJournal} runs, so a unit test that
 * spawns a real child never writes into a developer's userData dir.
 */
let activeJournal: ChildJournal | null = null;

/**
 * Point the journal at a file and start recording. Called once, at boot,
 * BEFORE anything can spawn.
 */
export function configureChildJournal(
  path: string,
  logger?: ChildJournalLogger,
): ChildJournal {
  activeJournal = new ChildJournal(path, logger);
  return activeJournal;
}

/** Test seam: forget the configured journal. */
export function resetChildJournal(): void {
  activeJournal = null;
}

/** The configured journal, or null when nothing is being recorded. */
export function currentChildJournal(): ChildJournal | null {
  return activeJournal;
}

/**
 * The slice of a spawned child this journal touches: a pid and one exit
 * listener.
 *
 * Stated structurally rather than as `Pick<ChildProcess, 'pid' | 'once'>`,
 * which drags in that interface's overloaded `once` — only a real
 * `ChildProcess` satisfies it, so a spec could not substitute a plain
 * `EventEmitter` and would have to cast. Same reasoning as `CrashGuardTarget`
 * in `utils/crash-guards.ts`.
 */
export interface JournalableChild {
  readonly pid?: number;
  once(event: 'exit', listener: () => void): unknown;
}

/**
 * Record a freshly spawned DETACHED child, and erase it when it exits.
 *
 * Called from inside each spawn helper rather than from a registration site
 * further up: the pid exists here and nowhere earlier, and a record written
 * later leaves a window in which a group is running and unrecorded.
 *
 * Only detached (group-leading) spawns pass through here. A plain `execFile`
 * utility child is deliberately NOT journaled: it is a single pid with node's
 * own `timeout` on it, it is a `--version` probe that exits in well under a
 * second, and journaling it would write the file twice per probe to protect
 * against an orphan that costs nothing. The ones that pass through here are
 * the ones that cost hundreds of megabytes and never exit on their own.
 *
 * A no-op when the journal is unconfigured, so spawn behaviour is unchanged in
 * tests and in any embedding that never called {@link configureChildJournal}.
 */
export function trackDetachedChild(
  child: JournalableChild,
  command: string,
): void {
  const journal = activeJournal;
  const pid = child.pid;
  if (!journal || typeof pid !== 'number') {
    return;
  }
  journal.record(pid, command);
  // `exit` (not `close`): the leader is gone by then, and the leader is the
  // only thing whose identity the reaper can verify. A grandchild that
  // outlives it is beyond what a pid-keyed journal can describe: one left in
  // the leader's group is reached by the group kill at cancel and shutdown, and
  // a detached command — in a session of its own — by the stop of the groups
  // its session recorded (`RunProcessReaper.stopLeftGroups`).
  child.once('exit', () => journal.forget(pid));
}
