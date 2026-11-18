import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { simulateSleep } from '../../../__tests__/simulate-sleep';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { KeptProcessRoot } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  type ScannedProcess,
} from '../utils/run-process-scan';
import { nodeSessionKey } from '../utils/session-keys';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { RunIdleReapService } from './run-idle-reap.service';
import { RunProcessAttribution } from './run-process-attribution.service';
import type { RunProcessReaper } from './run-process-reaper.service';
import {
  RUN_PROCESS_SWEEP_EVERY_MS,
  RUN_PROCESS_SWEEP_FIRST_MS,
  RunProcessSweep,
} from './run-process-sweep.service';

const OWNER = 'aaaaaaaaaaaaaaaa';
const IDLE_MINUTES = 5;
const SELF = 900;
const UID = 501;

const tagged = (pid: number, runId: string, ppid = 1): ScannedProcess => ({
  pid,
  ppid,
  pgid: pid,
  uid: UID,
  tty: null,
  startedAt: 1_000,
  args: `node ${runId}.js`,
  env: `${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${OWNER}`,
});

/**
 * Over a REAL in-memory schema: which runs read as gone is the database's
 * answer to the sweep's query, and a double that returned what it was told
 * could not catch that query asking the wrong thing.
 */
describe('RunProcessSweep (in-memory sqlite)', () => {
  let orm: MikroORM;
  let runDao: RunDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState, CallContext],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    runDao = new RunDao(orm.em.fork());
  });

  function sweep(
    rows: ScannedProcess[] | null,
    options: {
      roots?: () => KeptProcessRoot[];
      runDao?: RunDao;
      scan?: () => Promise<ScannedProcess[] | null>;
      /** Whether Electron has pushed the user's window yet. */
      userWindow?: boolean;
      /** Runs whose CLI exited for going unused within the kill grace. */
      inGrace?: string[];
    } = {},
  ) {
    const sessions = {
      processRoots: () => options.roots?.() ?? [],
      idleMinutes: IDLE_MINUTES,
      hasUserIdleWindow: options.userWindow ?? true,
    } as unknown as AgentSessionRegistry;
    const idle: string[] = [];
    const idleReap = {
      reap: (runId: string) => {
        idle.push(runId);
        return Promise.resolve([]);
      },
      awaitingGrace: (runId: string) =>
        options.inGrace?.includes(runId) ?? false,
    } as unknown as RunIdleReapService;
    const reaped: string[] = [];
    const conditional: boolean[] = [];
    const reaper = {
      reapInBackground: (runId: string, onlyIfStillGone = false) => {
        reaped.push(runId);
        conditional.push(onlyIfStillGone);
      },
      settled: () => Promise.resolve(),
    } as unknown as RunProcessReaper;
    const logger = { log: vi.fn(), warn: vi.fn() };
    const scan = vi.fn(options.scan ?? (() => Promise.resolve(rows)));
    const attribution = new RunProcessAttribution(OWNER, {
      scan,
      selfPid: SELF,
      uid: UID,
    });
    return {
      reaped,
      idle,
      conditional,
      logger,
      scan,
      subject: new RunProcessSweep(
        orm.em,
        options.runDao ?? runDao,
        new ItemDao(orm.em.fork()),
        sessions,
        reaper,
        attribution,
        idleReap,
        { logger },
      ),
    };
  }

  it('stops what deleted and archived threads left running, and nothing of a live one', async () => {
    const live = await runDao.create({ status: 'completed' });
    const archived = await runDao.create({ status: 'completed' });
    await runDao.updateById(archived.id, { archivedAt: new Date() });
    const { subject, reaped, idle, conditional } = sweep([
      tagged(10, live.id),
      tagged(20, 'run-deleted'),
      tagged(30, archived.id),
    ]);
    await lastRowAt(archived.id, IDLE_MINUTES * 10);
    const gone = await subject.sweep();
    expect(gone.sort()).toEqual(['run-deleted', archived.id].sort());
    expect(reaped.sort()).toEqual(['run-deleted', archived.id].sort());
    // Its verdict is a reading old: the reaper asks again before a signal.
    expect(conditional).toEqual([true, true]);
    // The archived run's old row does not make it an idle one as well.
    expect(idle).toEqual([]);
  });

  /** A transcript row for `runId`, written `minutesAgo` minutes ago. */
  async function lastRowAt(runId: string, minutesAgo: number): Promise<void> {
    const items = new ItemDao(orm.em.fork());
    await items.create({ runId, seq: 1, kind: 'message', payload: '{}' });
    await orm.em
      .fork()
      .nativeUpdate(
        Item,
        { runId },
        { createdAt: new Date(Date.now() - minutesAgo * 60_000) },
      );
  }

  it('stops what a live thread left running once its newest row is older than the idle window', async () => {
    const unused = await runDao.create({ status: 'completed' });
    const recent = await runDao.create({ status: 'completed' });
    const silent = await runDao.create({ status: 'completed' });
    await lastRowAt(unused.id, IDLE_MINUTES + 1);
    await lastRowAt(recent.id, IDLE_MINUTES - 1);
    const { subject, reaped, idle } = sweep([
      tagged(10, unused.id),
      tagged(20, recent.id),
      tagged(30, silent.id),
    ]);

    const swept = await subject.sweep();

    expect(swept).toEqual([unused.id]);
    expect(idle).toEqual([unused.id]);
    // Not the deleted-or-archived reap: a live run is not gone.
    expect(reaped).toEqual([]);
  });

  it('leaves an unused live thread alone while its CLI’s kill grace runs', async () => {
    // Its MCP servers may still be stopping; the idle close reaps after.
    const run = await runDao.create({ status: 'completed' });
    await lastRowAt(run.id, IDLE_MINUTES * 10);
    const { subject, idle } = sweep([tagged(10, run.id)], {
      inGrace: [run.id],
    });
    expect(await subject.sweep()).toEqual([]);
    expect(idle).toEqual([]);
  });

  it('leaves unused live threads alone until the user’s window has been pushed', async () => {
    // The default may be shorter than the window the user chose.
    const run = await runDao.create({ status: 'completed' });
    await lastRowAt(run.id, IDLE_MINUTES * 10);
    const { subject, idle } = sweep([tagged(10, run.id)], {
      userWindow: false,
    });
    expect(await subject.sweep()).toEqual([]);
    expect(idle).toEqual([]);
  });

  it('counts a live thread’s unused time from the last wake, as the idle close does', async () => {
    vi.useFakeTimers();
    try {
      const run = await runDao.create({ status: 'completed' });
      await lastRowAt(run.id, IDLE_MINUTES * 10);
      const { subject } = sweep([tagged(10, run.id)]);
      subject.onApplicationBootstrap();

      await simulateSleep(8 * 60 * 60_000);
      expect(await subject.sweep()).toEqual([]);

      await vi.advanceTimersByTimeAsync((IDLE_MINUTES + 1) * 60_000);
      expect(await subject.sweep()).toEqual([run.id]);
      subject.onApplicationShutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never sweeps an unused live thread the registry holds a process for', async () => {
    const run = await runDao.create({ status: 'completed' });
    await lastRowAt(run.id, IDLE_MINUTES * 10);
    const { subject, idle } = sweep([tagged(10, run.id)], {
      roots: () => [
        {
          key: nodeSessionKey(run.id, 'dev'),
          agent: 'claude',
          cwd: '/p',
          pid: 99,
        },
      ],
    });
    expect(await subject.sweep()).toEqual([]);
    expect(idle).toEqual([]);
  });

  it('never sweeps a run the registry holds a process for by the time of its scan', async () => {
    // Not a row yet, or not a row at all — but its agent is running now. Held
    // only from the scan on: a check made before it would sweep the agent.
    let scanned = false;
    const root: KeptProcessRoot = {
      key: nodeSessionKey('run-new', 'dev'),
      agent: 'claude',
      cwd: '/p',
      pid: 10,
    };
    const { subject, reaped } = sweep([], {
      scan: () => {
        scanned = true;
        return Promise.resolve([tagged(10, 'run-new')]);
      },
      roots: () => (scanned ? [root] : []),
    });
    expect(await subject.sweep()).toEqual([]);
    expect(reaped).toEqual([]);
  });

  it('sweeps nothing when the process table cannot be read', async () => {
    const { subject, reaped, logger } = sweep(null);
    expect(await subject.sweep()).toEqual([]);
    expect(reaped).toEqual([]);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('sweeps nothing when the database cannot be read', async () => {
    const failing = {
      getAll: () => Promise.reject(new Error('SQLITE_BUSY')),
    } as unknown as RunDao;
    const { subject, reaped } = sweep([tagged(10, 'run-x')], {
      runDao: failing,
    });
    await expect(subject.sweep()).rejects.toThrow('SQLITE_BUSY');
    expect(reaped).toEqual([]);
  });

  it('joins a sweep still running instead of starting a second', async () => {
    const { subject, reaped } = sweep([tagged(20, 'run-gone')]);
    await Promise.all([subject.sweep(), subject.sweep()]);
    expect(reaped).toEqual(['run-gone']);
  });

  describe('its schedule', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sweeps once shortly after boot, then on every interval, and stops at shutdown', async () => {
      const { subject, scan } = sweep([]);
      subject.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_FIRST_MS - 1);
      expect(scan).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(scan).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_EVERY_MS);
      expect(scan).toHaveBeenCalledTimes(2);
      subject.onApplicationShutdown();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_EVERY_MS * 3);
      expect(scan).toHaveBeenCalledTimes(2);
    });

    it('reports a failed background sweep as a warning instead of rejecting', async () => {
      const { subject, logger } = sweep(null, {
        scan: () => Promise.reject(new Error('boom')),
      });
      subject.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(RUN_PROCESS_SWEEP_FIRST_MS);
      expect(logger.warn).toHaveBeenCalledWith(
        'could not sweep leftover processes: boom',
      );
      subject.onApplicationShutdown();
    });
  });
});
