import type { EntityManager } from '@mikro-orm/sqlite';
import { BadRequestException, NotFoundException } from '@packages/common';
import { describe, expect, it, vi } from 'vitest';

import { StopDetachedProcessesSchema } from '../chat.types';
import type { RunDao } from '../dao/run.dao';
import { historyQuerySchema, listChatsQuerySchema } from '../dto/chat.dto';
import type { AgentSessionRegistry } from '../services/agent-session.registry';
import type { MonitorRegistry } from '../services/monitor.registry';
import { RunProcessAttribution } from '../services/run-process-attribution.service';
import { RunProcessReaper } from '../services/run-process-reaper.service';
import { RunProcessesService } from '../services/run-processes.service';
import type { ProcessUsageRow } from '../utils/process-usage';
import {
  RUN_PROCESS_CAP,
  type ScannedProcess,
} from '../utils/run-process-scan';
import { ChatController } from './chat.controller';

const OWNER = 'aaaaaaaaaaaaaaaa';
const RUN = 'run-1';

function scanned(pid: number, ppid = 1, runId = RUN): ScannedProcess {
  return {
    pid,
    ppid,
    pgid: pid,
    uid: 501,
    tty: null,
    startedAt: pid * 10,
    args: 'node stand.js',
    env: `GENIRO_RUN_ID=${runId} GENIRO_RUN_OWNER=${OWNER}`,
  };
}

function setup(
  options: {
    rows?: ScannedProcess[] | null;
    usage?: ProcessUsageRow[] | null;
    roots?: number[];
    exists?: boolean;
    startTimes?: (pids: number[]) => Promise<Map<number, number> | null>;
    scan?: () => Promise<ScannedProcess[] | null>;
  } = {},
) {
  const rows =
    options.rows === undefined
      ? [
          scanned(500),
          scanned(501, 500),
          scanned(600),
          scanned(700, 1, 'another-run'),
        ]
      : options.rows;
  const usage =
    options.usage === undefined
      ? (rows ?? []).map((row) => ({
          ...row,
          pgid: row.pid,
          comm: null,
          cpuPercent: 0,
          rssBytes: 0,
          elapsedSeconds: 10,
        }))
      : options.usage;
  const attribution = new RunProcessAttribution(OWNER, {
    scan: options.scan ?? (async () => rows),
    selfPid: 900,
    uid: 501,
  });
  const signal = vi.fn();
  const monitors = {
    stop: vi.fn((_runId: string, id: string) =>
      id === 'm1'
        ? { status: 'stopped' as const }
        : {
            status: 'refused' as const,
            reason: `no running monitor ${id} of yours`,
          },
    ),
  } as unknown as MonitorRegistry;
  const reaper = new RunProcessReaper(attribution, {
    held: () => (options.roots?.length ?? 0) > 0,
    processRoots: () => [...(options.roots ?? [])],
    listUsage: async () => usage,
    startTimes:
      options.startTimes ??
      (async (pids) => new Map(pids.map((pid) => [pid, pid * 10]))),
    signal,
    wait: async () => undefined,
    selfPid: 900,
    logger: { log: vi.fn(), warn: vi.fn() },
  });
  const em = { fork: () => em } as unknown as EntityManager;
  const service = new RunProcessesService(
    em,
    {
      getById: async () => (options.exists === false ? null : { id: RUN }),
    } as unknown as RunDao,
    {} as AgentSessionRegistry,
    attribution,
    reaper,
    monitors,
  );
  const controller = Object.create(ChatController.prototype) as ChatController;
  Object.assign(controller, { processes: service });
  return { controller, signal, monitors };
}

describe('POST /v1/chats/:runId/processes/stop', () => {
  it("stops a monitor by its id as the user's stop, and reports only the ones it stopped", async () => {
    const { controller, signal, monitors } = setup();
    expect(
      await controller.stopDetachedProcesses(RUN, { monitorIds: ['m1', 'm9'] }),
    ).toEqual({ stoppedPids: [], stoppedMonitorIds: ['m1'] });
    expect(monitors.stop).toHaveBeenCalledWith(RUN, 'm1', 'user');
    expect(signal).not.toHaveBeenCalled();
  });

  it('checks the registry after the scans finish', async () => {
    const roots: number[] = [];
    const rows = [scanned(500)];
    const { controller, signal } = setup({
      roots,
      rows,
      scan: async () => {
        await Promise.resolve();
        roots.push(500);
        return rows;
      },
    });
    await expect(
      controller.stopDetachedProcesses(RUN, { pids: [500] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(signal).not.toHaveBeenCalled();
  });

  it.each([undefined, 123])(
    'refuses a selected pid missing or reparented in the usage scan (ppid=%s)',
    async (ppid) => {
      const usage =
        ppid === undefined
          ? []
          : [
              {
                ...scanned(500, ppid),
                pgid: 500,
                comm: null,
                cpuPercent: 0,
                rssBytes: 0,
                elapsedSeconds: 10,
              },
            ];
      const { controller, signal } = setup({ usage });
      await expect(
        controller.stopDetachedProcesses(RUN, { pids: [500] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    'reports an unreadable identity probe before signal %i',
    async (failedProbe) => {
      let probe = 0;
      const { controller, signal } = setup({
        startTimes: async (pids) =>
          ++probe === failedProbe
            ? null
            : new Map(pids.map((pid) => [pid, pid * 10])),
      });
      await expect(
        controller.stopDetachedProcesses(RUN, { pids: [500] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signal.mock.calls).toEqual(
        failedProbe === 1 ? [] : [[500, 'SIGTERM']],
      );
    },
  );

  it('reports a refused signal instead of succeeding silently', async () => {
    const { controller, signal } = setup();
    signal.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    });
    await expect(
      controller.stopDetachedProcesses(RUN, { pids: [500] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(signal).toHaveBeenCalledExactlyOnceWith(500, 'SIGTERM');
  });
  it.each([
    [500, 501],
    [500, 501, 600],
  ])(
    'stops exactly the selected group or all detached pids: %j',
    async (...pids) => {
      const { controller, signal } = setup();
      expect(await controller.stopDetachedProcesses(RUN, { pids })).toEqual({
        stoppedPids: pids,
        stoppedMonitorIds: [],
      });
      expect(signal.mock.calls).toEqual([
        ...pids.map((pid) => [pid, 'SIGTERM']),
        ...pids.map((pid) => [pid, 'SIGKILL']),
      ]);
    },
  );

  it.each([700, 999])(
    'refuses a foreign or unknown pid %i without stopping the valid selection',
    async (pid) => {
      const { controller, signal } = setup();
      await expect(
        controller.stopDetachedProcesses(RUN, { pids: [500, pid] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it('allows a detached stand beside a live CLI but refuses its children and orphaned group members', async () => {
    const rows = [scanned(100), scanned(101, 100), scanned(102), scanned(500)];
    const usage = rows.map((row) => ({
      ...row,
      pgid: row.pid === 500 ? 500 : 100,
      comm: null,
      cpuPercent: 0,
      rssBytes: 0,
      elapsedSeconds: 10,
    }));
    const { controller, signal } = setup({ rows, usage, roots: [100] });
    expect(
      await controller.stopDetachedProcesses(RUN, { pids: [500] }),
    ).toEqual({ stoppedPids: [500], stoppedMonitorIds: [] });
    expect(signal.mock.calls).toEqual([
      [500, 'SIGTERM'],
      [500, 'SIGKILL'],
    ]);
    signal.mockClear();
    for (const pid of [100, 101, 102]) {
      await expect(
        controller.stopDetachedProcesses(RUN, { pids: [pid] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(signal).not.toHaveBeenCalled();
  });

  it('reconfirms identity before TERM and again before KILL', async () => {
    let probe = 0;
    const { controller, signal } = setup({
      startTimes: async () =>
        ++probe === 1
          ? new Map([
              [500, 5000],
              [501, 99999],
            ])
          : new Map([[500, 99999]]),
    });
    expect(
      await controller.stopDetachedProcesses(RUN, { pids: [500, 501] }),
    ).toEqual({ stoppedPids: [500], stoppedMonitorIds: [] });
    expect(signal.mock.calls).toEqual([[500, 'SIGTERM']]);
  });

  it('refuses an over-cap run even when selecting only one process', async () => {
    const { controller, signal } = setup({
      rows: Array.from({ length: RUN_PROCESS_CAP + 1 }, (_, i) =>
        scanned(1000 + i),
      ),
    });
    await expect(
      controller.stopDetachedProcesses(RUN, { pids: [1000] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(signal).not.toHaveBeenCalled();
  });

  it.each([{ rows: null }, { usage: null }, { roots: [123] }])(
    'refuses an unreadable or changed process table: %j',
    async (options) => {
      const { controller, signal } = setup(options);
      await expect(
        controller.stopDetachedProcesses(RUN, { pids: [500] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(signal).not.toHaveBeenCalled();
    },
  );

  it('refuses a missing run', async () => {
    const { controller, signal } = setup({ exists: false });
    await expect(
      controller.stopDetachedProcesses('missing', { pids: [500] }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(signal).not.toHaveBeenCalled();
  });

  it.each([
    [],
    [1],
    [-500],
    [1.5],
    Array.from({ length: RUN_PROCESS_CAP + 1 }, (_, i) => i + 2),
  ])('rejects unsafe request pids %j', (...pids) => {
    expect(StopDetachedProcessesSchema.safeParse({ pids }).success).toBe(false);
  });
});

describe('GET /v1/chats', () => {
  it('hands the service the page the query names', async () => {
    const listChats = vi.fn(async () => []);
    const controller = Object.create(
      ChatController.prototype,
    ) as ChatController;
    Object.assign(controller, { chatService: { listChats } });

    await controller.listChats(
      listChatsQuerySchema.parse({
        scope: 'archived',
        limit: '50',
        beforeCreatedAt: '2026-10-01T10:00:00.000Z',
        beforeId: 'run-9',
      }),
    );

    expect(listChats).toHaveBeenCalledWith('archived', {
      limit: 50,
      before: { createdAt: new Date('2026-10-01T10:00:00.000Z'), id: 'run-9' },
    });
  });
});

describe('GET /v1/chats/:runId/items', () => {
  it('hands the history service the one delegate the query names, and no other conversation', async () => {
    const read = vi.fn(async () => ({ items: [], anchors: [] }));
    const controller = Object.create(
      ChatController.prototype,
    ) as ChatController;
    Object.assign(controller, { history: { read } });

    await controller.getHistory(
      'run-1',
      historyQuerySchema.parse({ delegate: 'toolu_a', limit: '200' }),
    );

    expect(read).toHaveBeenCalledWith(
      'run-1',
      -1,
      { limit: 200, beforeSeq: undefined, take: undefined, probe: false },
      { delegate: 'toolu_a' },
    );
  });
});

describe('POST /v1/chats/:runId/actions/:seq/press|dismiss', () => {
  function actionController() {
    const actionPresses = {
      pressChat: vi.fn(async () => ({ outcome: {} })),
      dismissChat: vi.fn(async () => ({ outcome: {} })),
    };
    const controller = Object.create(
      ChatController.prototype,
    ) as ChatController;
    Object.assign(controller, { actionPresses });
    return { controller, actionPresses };
  }

  it('records a press through the gateway as remote, and one without the stamp as desktop', async () => {
    const { controller, actionPresses } = actionController();

    await controller.pressAction(
      RUN,
      4,
      { clientMessageId: 'c1' },
      {
        'x-geniro-via': 'remote',
      },
    );
    await controller.pressAction(RUN, 4, { clientMessageId: 'c2' }, {});

    expect(actionPresses.pressChat.mock.calls).toEqual([
      [RUN, 4, 'c1', 'remote'],
      [RUN, 4, 'c2', 'desktop'],
    ]);
  });

  it('records a dismissal through the gateway as remote', async () => {
    const { controller, actionPresses } = actionController();

    await controller.dismissAction(RUN, 4, { 'x-geniro-via': 'remote' });

    expect(actionPresses.dismissChat).toHaveBeenCalledWith(RUN, 4, 'remote');
  });
});
