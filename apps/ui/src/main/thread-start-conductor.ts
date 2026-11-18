import type { DaemonHandle } from '../shared/contracts';
import {
  daemonRead,
  DaemonRefusal,
  mayGiveBack,
  messageOf,
  prepareRunWorktree,
  reportFailure,
  type RunStartDeps,
  startRunOn,
} from './task-run-start';

/**
 * How often the approved starts are read.
 *
 * Shorter than the autopilot's: a start the user approved is one a person is
 * waiting on, and nothing else is going to wake this drain.
 */
const TICK_INTERVAL_MS = 5_000;

const APPROVED_STARTS_PATH = '/v1/command-center/starts?state=approved';

/** One start the command center's manager filed and the user approved. */
interface ApprovedStart {
  taskId: string;
  projectId: string;
  title: string;
  status: string;
  /**
   * Where to cut the worktree from, resolved by the daemon against the
   * project's folder, as the autopilot's queue handout is. Read as given.
   */
  folder: string;
}

export interface ThreadStartDeps extends RunStartDeps {
  /** The daemon to talk to, or null while none is running. */
  handle: () => DaemonHandle | null;
  /**
   * Whether any approved start is waiting, after each read. The daemon stays
   * open only while one is, the way an armed autopilot project holds it.
   */
  holdDaemon: (waiting: boolean) => void;
  log: (message: string) => void;
  /** Injectable so a spec drives the tick without a real clock. */
  intervalMs?: number;
}

/**
 * The drain that starts the threads the command center's manager filed.
 *
 * It is the autopilot's twin for a start the user approved by hand, and it
 * lives in main for the same reasons the autopilot does: a window is not
 * needed for the start to happen, and the worktree is git's to make. It starts
 * with the user's default approval and names itself `manager` as the starter:
 * the start is the user's, so it is never the autopilot's forced `auto`.
 *
 * Like the autopilot it decides nothing about capacity or whether a start is
 * allowed — the daemon answers both at the route that makes the run.
 */
export class ThreadStartConductor {
  private timer: ReturnType<typeof setInterval> | null = null;
  /** One tick at a time: a slow tick must not overlap the next. */
  private ticking = false;
  /** Whether the last read failed, so an outage is logged once, not per tick. */
  private unreachable = false;
  /** Starts already logged as naming no folder, so the log does not repeat. */
  private readonly foldless = new Set<string>();

  constructor(private readonly deps: ThreadStartDeps) {}

  start(): void {
    this.stop();
    this.timer = setInterval(
      () => void this.tick(),
      this.deps.intervalMs ?? TICK_INTERVAL_MS,
    );
    // Never the reason this process stays alive.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One sweep. Exposed so a spec drives it directly.
   *
   * A daemon that is not ready or not reachable skips the tick silently; every
   * other failure is logged and stepped over, as the autopilot does.
   */
  async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    const handle = this.deps.handle();
    if (handle === null) {
      return;
    }
    this.ticking = true;
    try {
      const starts = await this.readApproved(handle);
      if (starts === null) {
        return;
      }
      this.deps.holdDaemon(starts.length > 0);
      for (const start of starts) {
        await this.startOne(handle, start);
      }
    } catch (error) {
      this.deps.log(`thread starts could not be drained: ${messageOf(error)}`);
    } finally {
      this.ticking = false;
    }
  }

  private async readApproved(
    handle: DaemonHandle,
  ): Promise<ApprovedStart[] | null> {
    try {
      const body = await daemonRead<{ starts: ApprovedStart[] }>(
        handle,
        APPROVED_STARTS_PATH,
        this.deps.fetchTimeoutMs,
      );
      this.unreachable = false;
      return body.starts;
    } catch (error) {
      if (!this.unreachable) {
        this.unreachable = true;
        this.deps.log(`thread starts could not be read: ${messageOf(error)}`);
      }
      return null;
    }
  }

  private async startOne(
    handle: DaemonHandle,
    start: ApprovedStart,
  ): Promise<void> {
    if (typeof start.folder !== 'string' || start.folder.trim() === '') {
      if (!this.foldless.has(start.taskId)) {
        this.foldless.add(start.taskId);
        this.deps.log(
          `thread start for "${start.title}" names no folder to cut its worktree from`,
        );
      }
      return;
    }

    const prepared = await prepareRunWorktree(this.deps, start);
    if (!prepared.ok) {
      this.deps.log(
        `thread start could not prepare a worktree for "${start.title}": ${prepared.gitLine}`,
      );
      await this.reportFailed(handle, start, prepared.gitLine);
      return;
    }
    const worktree = prepared.worktree;

    try {
      await startRunOn(this.deps, handle, start, worktree, {
        startedBy: 'manager',
      });
      this.deps.log(
        `thread start began "${start.title}" on ${worktree.branch}`,
      );
    } catch (error) {
      this.deps.log(
        `thread start did not begin "${start.title}": ${messageOf(error)}`,
      );
      if (isRefusedForGood(error)) {
        await this.reportFailed(handle, start, messageOf(error));
      }
      if (worktree.reused) {
        return;
      }
      if (!(await mayGiveBack(this.deps, handle, start.taskId, error))) {
        this.deps.log(
          `thread start left the worktree for "${start.title}" in place: another start of the card is using it`,
        );
        return;
      }
      await this.deps
        .discardWorktree(start.taskId)
        .catch((cleanupError: unknown) => {
          this.deps.log(
            `thread start could not release the worktree for "${start.title}": ${messageOf(cleanupError)}`,
          );
        });
    }
  }

  /**
   * Report a start that cannot happen, so the daemon clears the request and
   * wakes the manager. A report that fails is logged, never thrown.
   */
  private async reportFailed(
    handle: DaemonHandle,
    start: ApprovedStart,
    line: string,
  ): Promise<void> {
    try {
      await reportFailure(
        this.deps,
        handle,
        `/v1/command-center/starts/${encodeURIComponent(start.taskId)}/failed`,
        line,
      );
    } catch (error) {
      this.deps.log(
        `thread start could not report the failure for "${start.title}": ${messageOf(error)}`,
      );
    }
  }
}

/**
 * A refusal that will not change by waiting: a 4xx other than the 409 that
 * means another start already holds the card. A 409 is left for the next
 * tick; a 5xx or a dropped connection is the daemon's trouble, not the start's.
 */
function isRefusedForGood(error: unknown): boolean {
  return (
    error instanceof DaemonRefusal &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 409
  );
}
