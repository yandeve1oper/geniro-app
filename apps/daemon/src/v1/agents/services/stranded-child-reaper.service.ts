import { Injectable, Logger } from '@nestjs/common';

import {
  isSameProcess,
  readProcessStartTimes,
  type StartTimeProbe,
} from '../../../utils/process-identity';
import {
  clearChildJournal,
  type JournaledChild,
  type JournaledCommandGroups,
  readChildJournal,
} from '../utils/child-journal';
import { killProcessGroup } from '../utils/kill-tree';
import type { RecordedGroup } from '../utils/process-descendants';

/**
 * Stops the groups a dead CLI's commands ran in, under the live rules
 * (`RunProcessReaper.stopLeftGroups`). Never throws.
 */
export type LeftGroupStop = (
  runId: string,
  groups: readonly RecordedGroup[],
) => Promise<unknown>;

/** Test seams — the production factory passes nothing. */
export interface StrandedChildReaperOptions {
  startTimes?: StartTimeProbe;
  killGroup?: (pid: number, signal: NodeJS.Signals) => void;
  logger?: { log(msg: string): void; warn(msg: string): void };
}

/**
 * Kill the process groups a previous daemon launch left running, and hand
 * the groups its CLIs' commands ran in to {@link LeftGroupStop}.
 *
 * The counterpart to the child journal, and the ONLY mechanism that survives a
 * SIGKILL: `ProcessRegistry.onApplicationShutdown` reaps on the graceful path,
 * and there is no graceful path when the UI supervisor escalates past its
 * shutdown grace or the machine kills the daemon outright. What is left behind
 * is a detached, reparented process group that never exits on its own —
 * measured here as `cursor-agent acp` groups 14 hours old at 217 MB each.
 *
 * Runs at boot, before the server listens, so a stray from the previous launch
 * cannot still be holding a session file while the new launch resumes it.
 *
 * It never kills on a pid alone. A pid recorded hours ago may belong to
 * anything by now — including the user's own interactive `claude` — so each
 * entry is confirmed against the kernel's start time for that pid before it is
 * signalled ({@link isSameProcess}). An entry that cannot be confirmed is left
 * alone, which is the right way to be wrong: a surviving stray costs memory, a
 * mistaken SIGKILL costs the user's work.
 */
@Injectable()
export class StrandedChildReaper {
  private readonly logger: NonNullable<StrandedChildReaperOptions['logger']>;
  private readonly startTimes: StartTimeProbe;
  private readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;

  constructor(
    private readonly journalPath: string,
    private readonly stopLeftGroups: LeftGroupStop,
    options: StrandedChildReaperOptions = {},
  ) {
    this.logger = options.logger ?? new Logger(StrandedChildReaper.name);
    this.startTimes = options.startTimes ?? readProcessStartTimes;
    this.killGroup =
      options.killGroup ??
      ((pid, signal) =>
        killProcessGroup(pid, signal, () => process.kill(pid, signal)));
  }

  /**
   * Reap, and clear the journal. Returns the groups actually signalled, so the
   * boot log can say what it did rather than that it ran.
   */
  reap(): JournaledChild[] {
    const journal = readChildJournal(this.journalPath, this.logger);
    if (!journal) {
      return [];
    }
    // A journal whose author is still running describes ANOTHER daemon's live
    // children, not strays. The instance lock should make this unreachable;
    // if it ever becomes reachable, the wrong move is to kill them.
    //
    // "Still running" is the PROCESS, confirmed by its start time, never a
    // pid that answers a signal: a recycled pid read as a live owner, the
    // strays were left running, and this launch's first spawn rewrote the
    // journal without them — so they were never reaped at all.
    if (
      journal.ownerPid !== process.pid &&
      isSameProcess(
        journal.ownerPid,
        journal.ownerStartedAt,
        this.startTimes([journal.ownerPid]),
      )
    ) {
      this.logger.warn(
        `child journal at ${this.journalPath} belongs to daemon pid ${journal.ownerPid}, which is still running — leaving its ${journal.children.length} child group(s) alone`,
      );
      return [];
    }
    const left = journal.commandGroups ?? [];
    if (journal.children.length === 0) {
      this.stopLeftCommands(left);
      clearChildJournal(this.journalPath);
      return [];
    }

    const startTimes = this.startTimes(journal.children.map((c) => c.pid));
    const stranded = journal.children.filter((child) =>
      isSameProcess(child.pid, child.startedAt, startTimes),
    );
    for (const child of stranded) {
      // SIGKILL, not SIGTERM: these groups are already proven not to exit on
      // their own — an abandoned `cursor-agent acp` sits blocked on a stdin
      // that no longer has a writer, and a SIGTERM grace period here would
      // only delay the boot for a process that is not listening for it.
      this.killGroup(child.pid, 'SIGKILL');
      this.logger.log(
        `reaped stranded process group ${child.pid} (${child.command}) left by a previous daemon launch`,
      );
    }
    const skipped = journal.children.length - stranded.length;
    if (skipped > 0) {
      // Almost always "it already exited" — but it also covers "that pid is
      // now someone else's", which is why they are counted, not asserted about.
      this.logger.log(
        `${skipped} journaled child group(s) were gone or could not be confirmed — left alone`,
      );
    }
    this.stopLeftCommands(left);
    clearChildJournal(this.journalPath);
    return stranded;
  }

  /**
   * Hand on the groups a previous launch's CLIs recorded their commands
   * running in. Those run in sessions of their own, so the group kills above
   * never reach them. Not awaited: the stop waits out a kill grace and reads
   * the process table, and the boot must not wait on either.
   */
  private stopLeftCommands(left: readonly JournaledCommandGroups[]): void {
    for (const entry of left) {
      const runId = entry.runId ?? 'untagged';
      this.logger.log(
        `stopping what ${entry.groups.length} command group(s) of run ${runId}'s agent (pid ${entry.cliPid}) left running at a previous daemon launch`,
      );
      void this.stopLeftGroups(runId, entry.groups);
    }
  }
}
