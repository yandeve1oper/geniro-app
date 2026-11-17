import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROCESS_IDENTITY_TOLERANCE_MS,
  readProcessStartTimes,
} from '../../../utils/process-identity';
import { ChildJournal, readChildJournal } from '../utils/child-journal';
import type { RecordedGroup } from '../utils/process-descendants';
import {
  StrandedChildReaper,
  type StrandedChildReaperOptions,
} from './stranded-child-reaper.service';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'geniro-reaper-'));
  path = join(dir, 'children.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const silent = { log: vi.fn(), warn: vi.fn() };

function reaper(options: StrandedChildReaperOptions = {}): {
  reaper: StrandedChildReaper;
  killed: [number, NodeJS.Signals][];
  handed: [string, readonly RecordedGroup[]][];
} {
  const killed: [number, NodeJS.Signals][] = [];
  const handed: [string, readonly RecordedGroup[]][] = [];
  return {
    killed,
    handed,
    reaper: new StrandedChildReaper(
      path,
      (runId, groups) => {
        handed.push([runId, groups]);
        return Promise.resolve([]);
      },
      {
        logger: silent,
        killGroup: (pid, signal) => killed.push([pid, signal]),
        ...options,
      },
    ),
  };
}

/** Write a journal as a previous launch would have, with a chosen owner. */
function writeJournal(
  children: { pid: number; startedAt: number; command: string }[],
  ownerPid = process.pid,
  ownerStartedAt = 1,
  commandGroups?: unknown[],
): void {
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      ownerPid,
      ownerStartedAt,
      children,
      ...(commandGroups === undefined ? {} : { commandGroups }),
    }),
  );
}

const LEFT_GROUP = { pgid: 900, members: [{ pid: 901, startedAt: 7_000 }] };

describe('StrandedChildReaper', () => {
  it('hands each CLI’s journaled command groups to the stop, with its run, after the group kills', () => {
    writeJournal(
      [{ pid: 1, startedAt: 1_000, command: 'claude' }],
      process.pid,
      1,
      [
        { cliPid: 1, runId: 'run-a', groups: [LEFT_GROUP] },
        {
          cliPid: 2,
          runId: null,
          groups: [{ pgid: 950, members: [{ pid: 951, startedAt: 8_000 }] }],
        },
      ],
    );
    const order: string[] = [];
    const r = new StrandedChildReaper(
      path,
      (runId) => {
        order.push(`stop ${runId}`);
        return Promise.resolve([]);
      },
      {
        logger: silent,
        startTimes: () => new Map([[1, 1_000]]),
        killGroup: (pid) => order.push(`kill ${pid}`),
      },
    );

    r.reap();

    expect(order).toEqual(['kill 1', 'stop run-a', 'stop untagged']);
    expect(readChildJournal(path)).toBeNull();
  });

  it('hands on the command groups of a journal with no live CLI left in it', () => {
    writeJournal([], process.pid, 1, [
      { cliPid: 1, runId: 'run-a', groups: [LEFT_GROUP] },
    ]);
    const { reaper: r, handed } = reaper({ startTimes: () => new Map() });

    expect(r.reap()).toEqual([]);

    expect(handed).toEqual([['run-a', [LEFT_GROUP]]]);
    expect(readChildJournal(path)).toBeNull();
  });

  it('kills a confirmed stray group and clears the journal', () => {
    writeJournal([
      { pid: 500, startedAt: 1_000, command: '/bin/cursor-agent' },
    ]);
    const { reaper: r, killed } = reaper({
      startTimes: () => new Map([[500, 1_000]]),
    });

    expect(r.reap().map((c) => c.pid)).toEqual([500]);

    expect(killed).toEqual([[500, 'SIGKILL']]);
    expect(readChildJournal(path)).toBeNull();
  });

  it('leaves a RECYCLED pid alone — the check that stops it killing the user’s own CLI', () => {
    // Same pid, a start time far from what we recorded: by now this pid
    // belongs to something else. Reverting the identity check makes this kill.
    writeJournal([{ pid: 500, startedAt: 1_000, command: '/bin/claude' }]);
    const { reaper: r, killed } = reaper({
      startTimes: () =>
        new Map([[500, 1_000 + PROCESS_IDENTITY_TOLERANCE_MS + 1]]),
    });

    expect(r.reap()).toEqual([]);

    expect(killed).toEqual([]);
  });

  it('leaves a pid that is no longer alive alone', () => {
    writeJournal([{ pid: 501, startedAt: 1_000, command: '/bin/claude' }]);
    const { reaper: r, killed } = reaper({ startTimes: () => new Map() });

    expect(r.reap()).toEqual([]);
    expect(killed).toEqual([]);
    // Still cleared: those entries can never become actionable again.
    expect(readChildJournal(path)).toBeNull();
  });

  it('reaps only the confirmed entries of a mixed journal', () => {
    writeJournal([
      { pid: 1, startedAt: 100, command: 'a' },
      { pid: 2, startedAt: 200, command: 'b' },
      { pid: 3, startedAt: 300, command: 'c' },
    ]);
    const { reaper: r, killed } = reaper({
      // 1 confirmed, 2 recycled, 3 gone.
      startTimes: () =>
        new Map([
          [1, 100],
          [2, 999_999],
        ]),
    });

    expect(r.reap().map((c) => c.pid)).toEqual([1]);
    expect(killed).toEqual([[1, 'SIGKILL']]);
  });

  it('REFUSES to touch a journal whose owning daemon is still running', () => {
    // Those are another live daemon's in-flight turns, not strays.
    writeJournal(
      [{ pid: 600, startedAt: 1_000, command: 'a' }],
      424_242,
      5_000,
      [{ cliPid: 600, runId: 'run-a', groups: [LEFT_GROUP] }],
    );
    const {
      reaper: r,
      killed,
      handed,
    } = reaper({
      startTimes: () =>
        new Map([
          [424_242, 5_000],
          [600, 1_000],
        ]),
    });

    expect(r.reap()).toEqual([]);

    expect(killed).toEqual([]);
    expect(handed).toEqual([]);
    // And the journal SURVIVES — it is the live daemon's, not ours to erase.
    expect(readChildJournal(path)?.children).toHaveLength(1);
  });

  it('reaps a previous daemon’s strays when its pid now belongs to SOMEONE ELSE', () => {
    // A bare signal to the pid is no owner check. A recycled pid — here one
    // that is genuinely alive (this runner's parent) but started at a
    // different time than the daemon that wrote the journal — would read as
    // that daemon still running. Its strays would be left alone, and the new
    // launch's first spawn would rewrite the journal without them.
    writeJournal(
      [{ pid: 600, startedAt: 1_000, command: '/bin/cursor-agent' }],
      process.ppid,
      5_000,
    );
    const { reaper: r, killed } = reaper({
      startTimes: () =>
        new Map([
          [process.ppid, 5_000 + PROCESS_IDENTITY_TOLERANCE_MS + 1],
          [600, 1_000],
        ]),
    });

    expect(r.reap().map((c) => c.pid)).toEqual([600]);

    expect(killed).toEqual([[600, 'SIGKILL']]);
    expect(readChildJournal(path)).toBeNull();
  });

  it('does nothing when no previous launch left a journal', () => {
    const { reaper: r, killed } = reaper({
      startTimes: () => {
        throw new Error('must not probe when there is nothing to probe');
      },
    });

    expect(r.reap()).toEqual([]);
    expect(killed).toEqual([]);
  });

  it('clears an empty journal left by a clean shutdown', () => {
    writeJournal([]);
    const { reaper: r } = reaper();

    expect(r.reap()).toEqual([]);

    expect(readChildJournal(path)).toBeNull();
  });

  it('reaps what a real ChildJournal wrote — the two halves agree on the format', () => {
    // Guards the pair, not each side: a shape change in the writer that the
    // reader stopped understanding would leave every stray un-reaped, and
    // both files' own specs would still pass.
    new ChildJournal(path, undefined, () => 7_000).record(700, '/bin/claude');
    const { reaper: r, killed } = reaper({
      startTimes: () => new Map([[700, 7_000]]),
    });

    expect(r.reap().map((c) => c.command)).toEqual(['/bin/claude']);
    expect(killed).toEqual([[700, 'SIGKILL']]);
  });

  it('confirms a real ChildJournal’s owner against the kernel — the writer’s start time is one the reader can match', () => {
    // The other half of the pair: the start time the writer stamps must be one
    // the owner check can CONFIRM, or every journal would read as a dead
    // owner's and a second live daemon's groups would be reaped. Rewritten
    // under another owner pid so the self-check does not short-circuit it.
    new ChildJournal(path).record(700, '/bin/claude');
    const written = readChildJournal(path);
    if (written === null) {
      throw new Error('the journal was not written');
    }
    writeFileSync(path, JSON.stringify({ ...written, ownerPid: 424_242 }));
    const own = readProcessStartTimes([process.pid]).get(process.pid);
    if (own === undefined) {
      throw new Error('ps could not read this process’s own start time');
    }
    const { reaper: r, killed } = reaper({
      startTimes: () =>
        new Map([
          [424_242, own],
          [700, written.children[0]!.startedAt],
        ]),
    });

    expect(r.reap()).toEqual([]);
    expect(killed).toEqual([]);
  });
});
