import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  type ChildJournalFile,
  configureChildJournal,
  resetChildJournal,
} from '../utils/child-journal';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import type { ProcessUsageRow } from '../utils/process-usage';
import {
  type PlainProcess,
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  type ScannedProcess,
} from '../utils/run-process-scan';
import type { StoppedCommands } from '../utils/spawn-cli';
import { ActionCommandRegistry } from './action-command.registry';
import type { AgentSessionRegistry } from './agent-session.registry';
import { RunProcessAttribution } from './run-process-attribution.service';
import {
  createRunProcessReaper,
  isUnsignallable,
  RunProcessReaper,
  type RunProcessReaperOptions,
} from './run-process-reaper.service';

const RUN = 'run-1111';
const OWNER = 'aaaaaaaaaaaaaaaa';
const SELF = 900;
const UID = 501;

function row(
  pid: number,
  ppid: number,
  args: string,
  overrides: Partial<ScannedProcess> = {},
): ScannedProcess {
  return {
    pid,
    ppid,
    pgid: pid,
    uid: UID,
    tty: null,
    startedAt: pid * 10,
    args,
    env: '',
    ...overrides,
  };
}

const tag = (runId = RUN): string =>
  `${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${OWNER}`;

/** Start times as the kernel would report them for the listed rows. */
const sameAsListed = (pids: number[]): Promise<Map<number, number>> =>
  Promise.resolve(new Map(pids.map((pid) => [pid, pid * 10])));

function reaper(
  rows: ScannedProcess[] | null,
  options: RunProcessReaperOptions & {
    scan?: () => Promise<ScannedProcess[] | null>;
    uid?: number | null;
  } = {},
): {
  reaper: RunProcessReaper;
  signals: [number, NodeJS.Signals][];
  waits: number[];
  logger: { log: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  scan: ReturnType<typeof vi.fn>;
} {
  const signals: [number, NodeJS.Signals][] = [];
  const waits: number[] = [];
  const logger = { log: vi.fn(), warn: vi.fn() };
  const scan = vi.fn(options.scan ?? (() => Promise.resolve(rows)));
  const attribution = new RunProcessAttribution(OWNER, {
    scan,
    selfPid: SELF,
    uid: options.uid === undefined ? UID : options.uid,
  });
  return {
    signals,
    waits,
    logger,
    scan,
    reaper: new RunProcessReaper(attribution, {
      signal: (pid, sig) => signals.push([pid, sig]),
      startTimes: sameAsListed,
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      logger,
      selfPid: SELF,
      ...options,
    }),
  };
}

describe('RunProcessReaper', () => {
  it('leaves background reap targets alone when identities cannot be read', async () => {
    const { reaper: subject, signals } = reaper(
      [row(10, 1, 'node stand.js', { env: tag() })],
      { startTimes: async () => null },
    );
    expect(await subject.reap([RUN])).toEqual([]);
    expect(signals).toEqual([]);
  });
  it('sends SIGTERM to the run tree, waits the grace, then SIGKILLs only confirmed survivors', async () => {
    let probes = 0;
    const {
      reaper: subject,
      signals,
      waits,
    } = reaper(
      [
        row(10, 1, 'node turbo run dev', { env: tag() }),
        row(11, 10, 'next-server (v16.3.8)', { env: null }),
        row(12, 10, 'node tsc --watch'),
      ],
      {
        startTimes: (pids) => {
          probes += 1;
          if (probes === 1) {
            return sameAsListed(pids);
          }
          // After the grace: 10 exited, 11 still runs, 12's pid now belongs
          // to a process that started later — a recycled pid.
          return Promise.resolve(
            new Map([
              [11, 110],
              [12, 99_999],
            ]),
          );
        },
      },
    );

    const stopped = await subject.reap([RUN]);

    expect(stopped.sort()).toEqual([10, 11, 12]);
    expect(waits).toEqual([GROUP_KILL_GRACE_MS]);
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [12, 'SIGTERM'],
      [11, 'SIGKILL'],
    ]);
  });

  it('logs every pid it signals by its executable, never its command line', async () => {
    const { reaper: subject, logger } = reaper([
      row(10, 1, '/usr/bin/psql postgres://u:hunter2@db/x', { env: tag() }),
    ]);
    await subject.reap([RUN]);
    expect(logger.log).toHaveBeenCalledWith(
      `SIGTERM pid 10 (psql) of run ${RUN}`,
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('hunter2');
  });

  it.each(['', '  '])(
    'reads nothing and signals nothing for the run id %j',
    async (runId) => {
      const {
        reaper: subject,
        signals,
        scan,
      } = reaper([row(10, 1, 'node a.js', { env: tag('') })]);
      expect(await subject.reap([runId])).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
      expect(signals).toEqual([]);
    },
  );

  it('reads nothing and signals nothing when it cannot tell which user it is', async () => {
    const {
      reaper: subject,
      signals,
      scan,
    } = reaper([row(10, 1, 'node a.js', { env: tag() })], { uid: null });
    expect(await subject.reap([RUN])).toEqual([]);
    expect(scan).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
  });

  it('leaves a run alone that has a live agent again by the time of its scan', async () => {
    // Archived, then unarchived and messaged while its reap waited in line:
    // what the table holds now is a working agent's.
    // Held only from the moment of the scan: asked any earlier, the check
    // would see nothing held and signal the new agent.
    let scanned = false;
    const rows = [
      row(10, 1, 'claude -p', { env: tag() }),
      row(20, 1, 'node b.js', { env: tag('run-2222') }),
    ];
    const {
      reaper: subject,
      signals,
      logger,
    } = reaper(rows, {
      scan: () => {
        scanned = true;
        return Promise.resolve(rows);
      },
      held: (runId) => scanned && runId === RUN,
    });
    expect(await subject.reap([RUN, 'run-2222'])).toEqual([20]);
    expect(signals.map(([pid]) => pid)).not.toContain(10);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`run ${RUN} has a live agent again`),
    );
  });

  it('signals nothing, and does not wait, for another run', async () => {
    const {
      reaper: subject,
      signals,
      waits,
    } = reaper([row(10, 1, 'node a.js', { env: tag('run-2222') })]);
    expect(await subject.reap([RUN])).toEqual([]);
    expect(signals).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('signals nothing when the process table cannot be read', async () => {
    const { reaper: subject, signals, logger } = reaper(null);
    expect(await subject.reap([RUN])).toEqual([]);
    expect(signals).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('signals nothing for a run over the cap, and still stops the others', async () => {
    const rows = [
      row(10, 1, 'node root.js', { env: tag() }),
      ...Array.from({ length: 300 }, (_, i) => row(1000 + i, 10, 'node w.js')),
      row(20, 1, 'node other.js', { env: tag('run-2222') }),
    ];
    const { reaper: subject, signals, logger } = reaper(rows);
    expect(await subject.reap([RUN, 'run-2222'])).toEqual([20]);
    expect(signals).toEqual([
      [20, 'SIGTERM'],
      [20, 'SIGKILL'],
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('matched 301 processes'),
    );
  });

  it('signals nothing of the run the daemon itself was started from', async () => {
    const { reaper: subject, signals } = reaper([
      row(SELF, 1, 'node daemon/main.js', { env: tag() }),
      row(10, 1, 'node server.js', { env: tag() }),
    ]);
    expect(await subject.reap([RUN])).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('never signals a process whose identity it cannot confirm', async () => {
    const { reaper: subject, signals } = reaper(
      [
        row(10, 1, 'node a.js', { env: tag(), startedAt: null }),
        row(11, 1, 'node b.js', { env: tag() }),
      ],
      // 11's pid was recycled between the listing and the signal: what holds
      // it now started a minute after the process that was listed.
      // 10 is alive, but the listing could not say when it started.
      {
        startTimes: () =>
          Promise.resolve(
            new Map([
              [10, 100],
              [11, 110 + 60_000],
            ]),
          ),
      },
    );
    expect(await subject.reap([RUN])).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('steps over a process that exits between the probe and the signal', async () => {
    const { reaper: subject, logger } = reaper(
      [
        row(10, 1, 'node a.js', { env: tag() }),
        row(11, 1, 'node b.js', { env: tag() }),
      ],
      {
        signal: (pid) => {
          if (pid === 10) {
            throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
          }
        },
      },
    );
    expect(await subject.reap([RUN])).toEqual([11]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('says so when a signal is refused, rather than skipping it in silence', async () => {
    const { reaper: subject, logger } = reaper(
      [row(10, 1, 'node a.js', { env: tag() })],
      {
        signal: () => {
          throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
        },
      },
    );
    expect(await subject.reap([RUN])).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not send SIGTERM to pid 10 (node)'),
    );
  });

  it('reaps what queued while a reap ran together, over one scan', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scans: number[] = [];
    const { reaper: subject, signals } = reaper(null, {
      scan: async () => {
        scans.push(scans.length);
        if (scans.length === 1) {
          await gate;
        }
        return [
          row(10, 1, 'node a.js', { env: tag('run-a') }),
          row(20, 1, 'node b.js', { env: tag('run-b') }),
          row(30, 1, 'node c.js', { env: tag('run-c') }),
        ];
      },
    });
    subject.reapInBackground('run-a');
    subject.reapInBackground('run-b');
    subject.reapInBackground('run-c');
    release();
    await subject.settled();
    // The first reap took run-a alone; b and c queued behind it, together.
    expect(scans).toHaveLength(2);
    expect(signals.filter(([, sig]) => sig === 'SIGTERM')).toEqual([
      [10, 'SIGTERM'],
      [20, 'SIGTERM'],
      [30, 'SIGTERM'],
    ]);
  });

  it('re-asks whether a run the sweep queued is still gone, never one an archive queued', async () => {
    const asked: string[][] = [];
    const { reaper: subject, signals } = reaper(
      [
        row(10, 1, 'node a.js', { env: tag('run-a') }),
        row(20, 1, 'node b.js', { env: tag('run-b') }),
        row(30, 1, 'node c.js', { env: tag('run-c') }),
      ],
      {
        // run-b was unarchived since the sweep's verdict.
        stillGone: (runIds) => {
          asked.push(runIds);
          return Promise.resolve(
            new Set(runIds.filter((id) => id !== 'run-b')),
          );
        },
      },
    );
    subject.reapInBackground('run-a', true);
    subject.reapInBackground('run-b', true);
    // Archived by the user while the sweep's request waited: that one wins.
    subject.reapInBackground('run-c', true);
    subject.reapInBackground('run-c');
    await subject.settled();
    expect(asked.flat().sort()).toEqual(['run-a', 'run-b']);
    expect(
      signals.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid),
    ).toEqual([10, 30]);
  });

  it('hands an idle reap the processes it stopped for that run alone', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scans: number[] = [];
    const { reaper: subject, signals } = reaper(null, {
      scan: async () => {
        scans.push(scans.length);
        if (scans.length === 1) {
          await gate;
        }
        return [
          row(10, 1, 'node dev-server.js', { env: tag('run-a') }),
          row(11, 10, 'node worker.js'),
          row(20, 1, 'node b.js', { env: tag('run-b') }),
        ];
      },
    });
    // Held behind a reap of another run, so run-a and run-b share one reap.
    subject.reapInBackground('run-z');
    const idle = subject.reapIdle('run-a');
    subject.reapInBackground('run-b');
    release();
    const stopped = await idle;
    await subject.settled();
    expect(stopped.map((process) => process.pid).sort()).toEqual([10, 11]);
    expect(stopped.map((process) => process.args)).toContain(
      'node dev-server.js',
    );
    expect(scans).toHaveLength(2);
    expect(
      signals.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid),
    ).toEqual([10, 11, 20]);
  });

  it('hands what it stopped to the first of two idle reaps of one run sharing a reap', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scans = 0;
    const { reaper: subject, signals } = reaper(null, {
      scan: async () => {
        scans += 1;
        if (scans === 1) {
          await gate;
        }
        return [row(10, 1, 'node dev-server.js', { env: tag('run-a') })];
      },
    });
    subject.reapInBackground('run-z');
    const first = subject.reapIdle('run-a');
    const second = subject.reapIdle('run-a');
    release();

    const answers = await Promise.all([first, second]);

    expect(answers.map((rows) => rows.map((process) => process.pid))).toEqual([
      [10],
      [],
    ]);
    expect(signals.filter(([, sig]) => sig === 'SIGTERM')).toEqual([
      [10, 'SIGTERM'],
    ]);
  });

  it.each(['', '  '])(
    'resolves an idle reap of the run id %j empty, reading nothing',
    async (runId) => {
      const { reaper: subject, scan } = reaper([
        row(10, 1, 'node a.js', { env: tag('') }),
      ]);
      expect(await subject.reapIdle(runId)).toEqual([]);
      expect(scan).not.toHaveBeenCalled();
    },
  );

  it('resolves an idle reap empty, signalling nothing, for a run that holds an agent again', async () => {
    const { reaper: subject, signals } = reaper(
      [row(10, 1, 'node dev-server.js', { env: tag('run-a') })],
      { held: (runId) => runId === 'run-a' },
    );
    expect(await subject.reapIdle('run-a')).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('resolves an idle reap empty instead of rejecting when the reap fails', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const subject = new RunProcessReaper(
      new RunProcessAttribution(OWNER, {
        scan: () => Promise.reject(new Error('boom')),
        selfPid: SELF,
        uid: UID,
      }),
      { logger, selfPid: SELF },
    );
    expect(await subject.reapIdle(RUN)).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      `could not stop the processes of run(s) ${RUN}: boom`,
    );
  });

  it('reports a failed background reap as a warning instead of rejecting', async () => {
    const logger = { log: vi.fn(), warn: vi.fn() };
    const subject = new RunProcessReaper(
      new RunProcessAttribution(OWNER, {
        scan: () => Promise.reject(new Error('boom')),
        selfPid: SELF,
        uid: UID,
      }),
      { logger, selfPid: SELF },
    );
    subject.reapInBackground(RUN);
    await subject.settled();
    expect(logger.warn).toHaveBeenCalledWith(
      `could not stop the processes of run(s) ${RUN}: boom`,
    );
  });
});

describe('createRunProcessReaper', () => {
  it('stops nothing of a finished card’s run while a command action pressed during its close runs, and its leftovers once it ends', async () => {
    // Pressed while the card's CLIs were still exiting: the run is in use when
    // the finished card's reap scans, and that command's processes carry the
    // same run tag as what the agents left.
    const commands = new ActionCommandRegistry();
    const signals: [number, NodeJS.Signals][] = [];
    const sessions = {
      processRoots: () => [],
      onLeftCommands: () => undefined,
    } as unknown as AgentSessionRegistry;
    const subject = createRunProcessReaper(
      new RunProcessAttribution(OWNER, {
        scan: () =>
          Promise.resolve([row(10, 1, 'node dev-server.js', { env: tag() })]),
        selfPid: SELF,
        uid: UID,
      }),
      sessions,
      [commands],
      {
        signal: (pid, sig) => signals.push([pid, sig]),
        startTimes: sameAsListed,
        wait: () => Promise.resolve(),
        logger: { log: vi.fn(), warn: vi.fn() },
        selfPid: SELF,
        uid: UID,
      },
    );
    const pressed = commands.start(RUN);

    expect(await subject.reapIdle(RUN)).toEqual([]);
    expect(signals).toEqual([]);

    pressed.release();
    const stopped = await subject.reapIdle(RUN);
    expect(stopped.map((process) => process.pid)).toEqual([10]);
    expect(signals).toContainEqual([10, 'SIGTERM']);
  });
});

describe('RunProcessReaper.stopRecorded', () => {
  /**
   * A live CLI (10) leading its own group with an MCP server in it (11), and
   * a command it backgrounded in a group of its own (12) running a server (13).
   */
  const table = (
    overrides: Record<number, Partial<ScannedProcess>> = {},
  ): ScannedProcess[] => [
    row(10, 1, 'claude', { env: tag(), ...overrides[10] }),
    row(11, 10, 'node mcp-server.js', overrides[11]),
    row(12, 10, 'bash -c python3 -m http.server', overrides[12]),
    row(13, 12, 'python3 -m http.server', overrides[13]),
  ];
  const groups: Record<number, number> = { 10: 10, 11: 10, 12: 12, 13: 12 };
  const usageOf = (rows: ScannedProcess[]): ProcessUsageRow[] =>
    rows.map((scanned) => ({
      pid: scanned.pid,
      ppid: scanned.ppid,
      args: scanned.args,
      pgid: groups[scanned.pid] ?? scanned.pid,
      cpuPercent: 0,
      rssBytes: 0,
      elapsedSeconds: null,
      comm: null,
    }));
  const stopper = (
    rows: ScannedProcess[],
    options: RunProcessReaperOptions = {},
  ): ReturnType<typeof reaper> =>
    reaper(rows, {
      processRoots: () => [10],
      listUsage: () => Promise.resolve(usageOf(rows)),
      ...options,
    });
  const recorded = (pid: number) => ({ pid, startedAt: pid * 10 });

  it('stopRecorded stops a background child under the CLI but never a CLI root pid', async () => {
    const { reaper: subject, signals } = stopper(table());

    expect(
      (await subject.stopCandidates(RUN)).map((process) => process.pid),
    ).toEqual([12, 13]);
    expect(await subject.stopRecorded(RUN, [recorded(13)])).toEqual({
      stopped: [13],
      gone: [],
    });
    expect(signals).toEqual([
      [13, 'SIGTERM'],
      [13, 'SIGKILL'],
    ]);

    for (const pid of [10, 11]) {
      await expect(
        subject.stopRecorded(RUN, [recorded(pid)]),
      ).rejects.toMatchObject({ errorCode: 'PROCESS_CHANGED' });
    }
    expect(signals).toHaveLength(2);
  });

  it('refuses the whole press when a recorded process is no longer this thread’s', async () => {
    // 13 was reparented out from under the tagged CLI and carries no tag of
    // its own, so nothing attributes it to the run any more.
    const { reaper: subject, signals } = stopper(
      table({ 13: { ppid: 1, env: null } }),
    );
    await expect(
      subject.stopRecorded(RUN, [recorded(12), recorded(13)]),
    ).rejects.toMatchObject({ errorCode: 'PROCESS_CHANGED' });
    expect(signals).toEqual([]);
  });

  it('reports already stopped when every target is gone', async () => {
    const {
      reaper: subject,
      signals,
      waits,
    } = stopper(table(), {
      // 12 exited; 13's pid now belongs to a process that started later.
      startTimes: () => Promise.resolve(new Map([[13, 130 + 60_000]])),
    });
    expect(
      await subject.stopRecorded(RUN, [recorded(12), recorded(13)]),
    ).toEqual({ stopped: [], gone: [12, 13] });
    expect(signals).toEqual([]);
    expect(waits).toEqual([]);
  });

  it('also stops what a recorded target started after it was published', async () => {
    // 12 was recorded alone; the server under it (13) came up later.
    const { reaper: subject, signals } = stopper(table());
    expect(await subject.stopRecorded(RUN, [recorded(12)])).toEqual({
      stopped: [12, 13],
      gone: [],
    });
    expect(signals.filter(([, sig]) => sig === 'SIGTERM')).toEqual([
      [12, 'SIGTERM'],
      [13, 'SIGTERM'],
    ]);
  });

  it('never offers a CLI that leads no group of its own', async () => {
    // Spawned into its spawner's group: only its own pid can exclude it.
    const rows = table();
    const { reaper: subject } = stopper(rows, {
      listUsage: () =>
        Promise.resolve(
          usageOf(rows).map((usage) =>
            usage.pid === 10 ? { ...usage, pgid: 5 } : usage,
          ),
        ),
    });
    expect(
      (await subject.stopCandidates(RUN)).map((process) => process.pid),
    ).not.toContain(10);
  });

  it.each([
    [
      'a start time cannot be read',
      { startTimes: () => Promise.resolve(null) },
      'PROCESS_IDENTITY_UNREADABLE',
    ],
    [
      'a CLI root is missing from the usage table',
      { processRoots: () => [10, 99] },
      'PROCESS_TABLE_CHANGED',
    ],
  ] as const)(
    'refuses to stop anything when %s',
    async (_case, options, errorCode) => {
      const { reaper: subject, signals } = stopper(table(), options);
      await expect(
        subject.stopRecorded(RUN, [recorded(13)]),
      ).rejects.toMatchObject({ errorCode });
      expect(signals).toEqual([]);
    },
  );

  it('says SIGTERM went out when the identity read before SIGKILL fails', async () => {
    let reads = 0;
    const { reaper: subject, signals } = stopper(table(), {
      startTimes: (pids) => {
        reads += 1;
        // The press's own check and the one before SIGTERM read; the one
        // before SIGKILL cannot.
        return reads <= 2
          ? Promise.resolve(new Map(pids.map((pid) => [pid, pid * 10])))
          : Promise.resolve(null);
      },
    });
    await expect(
      subject.stopRecorded(RUN, [recorded(13)]),
    ).rejects.toMatchObject({
      errorCode: 'PROCESS_IDENTITY_UNREADABLE',
      message:
        'sent SIGTERM to 1 process(es), then could not confirm process identities; refresh and try again',
    });
    expect(signals).toEqual([[13, 'SIGTERM']]);
  });

  it('refuses to stop anything for a run over the cap', async () => {
    const rows = [
      ...table(),
      ...Array.from({ length: 300 }, (_, i) =>
        row(2000 + i, 12, 'node worker.js'),
      ),
    ];
    const { reaper: subject, signals } = stopper(rows);
    await expect(
      subject.stopRecorded(RUN, [recorded(13)]),
    ).rejects.toMatchObject({ errorCode: 'RUN_PROCESS_CAP' });
    expect(signals).toEqual([]);
  });

  it('refuses to stop anything when the usage table cannot be read', async () => {
    const { reaper: subject, signals } = stopper(table(), {
      listUsage: () => Promise.resolve(null),
    });
    await expect(
      subject.stopRecorded(RUN, [recorded(13)]),
    ).rejects.toMatchObject({ errorCode: 'PROCESS_TABLE_UNREADABLE' });
    expect(signals).toEqual([]);
  });
});

describe('isUnsignallable', () => {
  it('refuses launchd, the whole-session pid and the daemon itself', () => {
    expect(isUnsignallable(1, SELF)).toBe(true);
    expect(isUnsignallable(0, SELF)).toBe(true);
    expect(isUnsignallable(-1, SELF)).toBe(true);
    expect(isUnsignallable(SELF, SELF)).toBe(true);
    expect(isUnsignallable(10, SELF)).toBe(false);
  });
});

describe('RunProcessReaper.stopLeftGroups', () => {
  /** A table row whose kernel start time is what `sameAsListed` reports. */
  const groupRow = (
    pid: number,
    ppid: number,
    pgid: number,
    args: string,
    overrides: Partial<PlainProcess> = {},
  ): PlainProcess => ({
    pid,
    ppid,
    pgid,
    uid: UID,
    tty: null,
    startedAt: pid * 10,
    args,
    ...overrides,
  });

  /** What the session recorded: the wrapper shell and its `sleep`. */
  const RECORDED = [
    {
      pgid: 200,
      members: [
        { pid: 200, startedAt: 2000 },
        { pid: 201, startedAt: 2010 },
      ],
    },
  ];

  const leftBy = (
    table: PlainProcess[] | null,
    options: RunProcessReaperOptions = {},
  ) =>
    reaper([], {
      listGroups: () => Promise.resolve(table),
      uid: UID,
      ...options,
    });

  it('stops every current member of a group a recorded member still anchors, and nothing else', async () => {
    const {
      reaper: subject,
      signals,
      waits,
    } = leftBy([
      // The dead CLI's orphaned MCP server, still in the CLI's own group.
      groupRow(101, 1, 100, 'node mcp.js'),
      groupRow(200, 1, 200, '/bin/sh -c sleep 600; :'),
      groupRow(201, 200, 200, 'sleep 600'),
      // Forked into the group after the last recording.
      groupRow(205, 201, 200, 'sleep-helper'),
      groupRow(400, 1, 400, 'node /Users/me/other-project/server.js'),
    ]);

    expect(await subject.stopLeftGroups(RUN, RECORDED)).toEqual([
      200, 201, 205,
    ]);
    expect(signals).toEqual([
      [200, 'SIGTERM'],
      [201, 'SIGTERM'],
      [205, 'SIGTERM'],
      [200, 'SIGKILL'],
      [201, 'SIGKILL'],
      [205, 'SIGKILL'],
    ]);
    // The CLI's own shutdown gets the grace first, then TERM → grace → KILL.
    expect(waits).toEqual([GROUP_KILL_GRACE_MS, GROUP_KILL_GRACE_MS]);
  });

  it('reads the table only after the grace a CLI stopping its own commands is given', async () => {
    const order: string[] = [];
    const { reaper: subject } = reaper([], {
      uid: UID,
      wait: (ms) => {
        order.push(`wait ${ms}`);
        return Promise.resolve();
      },
      listGroups: () => {
        order.push('read');
        return Promise.resolve([]);
      },
    });

    await subject.stopLeftGroups(RUN, RECORDED);

    expect(order).toEqual([`wait ${GROUP_KILL_GRACE_MS}`, 'read']);
  });

  it('acts on no group whose recorded members are gone or are now other processes', async () => {
    const { reaper: subject, signals } = leftBy([
      // Same pid, later start: a recycled pid, not the recorded wrapper.
      groupRow(200, 1, 200, 'node unrelated.js', { startedAt: 999_999 }),
      // In the group, but never recorded: proves nothing about the group.
      groupRow(202, 200, 200, 'node unrelated-child.js'),
    ]);

    expect(await subject.stopLeftGroups(RUN, RECORDED)).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('acts on no group whose recorded member has moved to another group', async () => {
    const { reaper: subject, signals } = leftBy([
      // The recorded wrapper, alive and itself, but now leading group 300.
      groupRow(200, 1, 300, '/bin/sh -c sleep 600; :'),
      // Whatever now reads as group 200 was never shown to be the agent's.
      groupRow(250, 1, 200, 'node unrelated.js'),
    ]);

    expect(await subject.stopLeftGroups(RUN, RECORDED)).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('never acts on the daemon’s own group or launchd’s, whatever was recorded', async () => {
    const { reaper: subject, signals } = leftBy([
      groupRow(SELF, 1, 200, 'Geniro Helper'),
      groupRow(200, 1, 200, '/bin/sh -c sleep 600; :'),
      groupRow(201, 200, 200, 'sleep 600'),
      groupRow(50, 1, 1, 'loginwindow'),
    ]);

    expect(
      await subject.stopLeftGroups(RUN, [
        ...RECORDED,
        { pgid: 1, members: [{ pid: 50, startedAt: 500 }] },
      ]),
    ).toEqual([]);
    expect(signals).toEqual([]);
  });

  it('spares a CLI the registry holds, another user’s process and a system executable', async () => {
    const { reaper: subject, signals } = leftBy(
      [
        groupRow(200, 1, 200, '/bin/sh -c sleep 600; :'),
        groupRow(201, 200, 200, 'sleep 600'),
        // Under the run's NEW CLI (pid 300), whatever group it reads as.
        groupRow(300, SELF, 300, 'claude'),
        groupRow(301, 300, 200, 'node mcp.js'),
        groupRow(203, 200, 200, 'sudo-helper', { uid: 0 }),
        groupRow(204, 200, 200, '/System/Library/CoreServices/helper'),
      ],
      { processRoots: () => [300] },
    );

    await subject.stopLeftGroups(RUN, RECORDED);

    expect(new Set(signals.map(([pid]) => pid))).toEqual(new Set([200, 201]));
  });

  it('stops a member on a terminal, since codex runs its commands on one', async () => {
    const { reaper: subject, signals } = leftBy([
      groupRow(200, 1, 200, '/bin/zsh -lc sleep 600', { tty: 'ttys009' }),
      groupRow(201, 200, 200, 'sleep 600', { tty: 'ttys009' }),
    ]);

    expect(await subject.stopLeftGroups(RUN, RECORDED)).toEqual([200, 201]);
    expect(signals.filter(([, sig]) => sig === 'SIGTERM')).toEqual([
      [200, 'SIGTERM'],
      [201, 'SIGTERM'],
    ]);
  });

  it('stops nothing, and reports it could not act, when the selection is over the cap or the table cannot be read', async () => {
    const crowd = Array.from({ length: 300 }, (_, i) =>
      groupRow(1000 + i, 200, 200, 'worker'),
    );
    const over = leftBy([groupRow(200, 1, 200, 'sh'), ...crowd]);
    expect(await over.reaper.stopLeftGroups(RUN, RECORDED)).toBeNull();
    expect(over.signals).toEqual([]);
    expect(over.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('more than a run can own — killed none'),
    );

    const unread = leftBy(null);
    expect(await unread.reaper.stopLeftGroups(RUN, RECORDED)).toBeNull();
    expect(unread.signals).toEqual([]);
    expect(unread.logger.warn).toHaveBeenCalledWith(
      `could not read the process table — left what run ${RUN}'s agent left running alone`,
    );
  });

  it('stops nothing, and says why, when it cannot tell which user the daemon runs as', async () => {
    const {
      reaper: subject,
      signals,
      logger,
    } = leftBy(
      [
        groupRow(200, 1, 200, '/bin/sh -c sleep 600; :'),
        groupRow(201, 200, 200, 'sleep 600'),
      ],
      { uid: null },
    );

    expect(await subject.stopLeftGroups(RUN, RECORDED)).toBeNull();
    expect(signals).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      `could not tell which user the daemon runs as — left what run ${RUN}'s agent left running alone`,
    );
  });

  it('never throws, and stops nothing, when reading the table fails', async () => {
    const {
      reaper: subject,
      signals,
      logger,
    } = reaper([], {
      uid: UID,
      listGroups: () => Promise.reject(new Error('ps exploded')),
    });

    await expect(subject.stopLeftGroups(RUN, RECORDED)).resolves.toBeNull();
    expect(signals).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      `could not stop what run ${RUN}'s agent left running: ps exploded`,
    );
  });

  it('reads nothing when no group was recorded', async () => {
    const listGroups = vi.fn(() => Promise.resolve([] as PlainProcess[]));
    const { reaper: subject, waits } = reaper([], { uid: UID, listGroups });

    expect(await subject.stopLeftGroups(RUN, [])).toEqual([]);
    expect(listGroups).not.toHaveBeenCalled();
    expect(waits).toEqual([]);
  });
});

describe('createRunProcessReaper — the journaled record of what a dead CLI left', () => {
  const GROUPS = [{ pgid: 200, members: [{ pid: 200, startedAt: 2000 }] }];
  let dir: string;

  afterEach(() => {
    resetChildJournal();
    rmSync(dir, { recursive: true, force: true });
  });

  function wired(options: RunProcessReaperOptions) {
    dir = mkdtempSync(join(tmpdir(), 'geniro-reaper-journal-'));
    const path = join(dir, 'children.json');
    configureChildJournal(path).recordCommandGroups(42, RUN, GROUPS);
    let tell: ((runId: string, left: StoppedCommands) => void) | null = null;
    const sessions = {
      onLeftCommands: (listener: NonNullable<typeof tell>) => {
        tell = listener;
      },
      processRoots: () => [],
    } as unknown as AgentSessionRegistry;
    createRunProcessReaper(new RunProcessAttribution(OWNER), sessions, [], {
      selfPid: SELF,
      logger: { log: vi.fn(), warn: vi.fn() },
      ...options,
    });
    const journaled = () =>
      (JSON.parse(readFileSync(path, 'utf8')) as ChildJournalFile)
        .commandGroups ?? [];
    return {
      journaled,
      die: (pid?: number) =>
        tell?.(RUN, { running: 1, commands: [], groups: GROUPS, pid }),
    };
  }

  it('keeps the record while the stop runs, and drops it once the stop has run', async () => {
    let graceOver: () => void = () => {};
    const { journaled, die } = wired({
      uid: UID,
      wait: () =>
        new Promise<void>((resolve) => {
          graceOver = resolve;
        }),
      listGroups: () => Promise.resolve([]),
    });

    die(42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(journaled().map((entry) => entry.cliPid)).toEqual([42]);

    graceOver();
    await vi.waitFor(() => expect(journaled()).toEqual([]));
  });

  it('keeps the record when the stop could not act, for the next boot', async () => {
    const warn = vi.fn();
    const { journaled, die } = wired({
      uid: UID,
      wait: () => Promise.resolve(),
      listGroups: () => Promise.resolve(null),
      logger: { log: vi.fn(), warn },
    });

    die(42);
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(journaled().map((entry) => entry.cliPid)).toEqual([42]);
  });
});
