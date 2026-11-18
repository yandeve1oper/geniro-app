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

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { keptSessionAdapter } from '../__tests__/kept-session';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { GROUP_KILL_GRACE_MS } from '../utils/kill-tree';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  type ScannedProcess,
} from '../utils/run-process-scan';
import { nodeSessionKey } from '../utils/session-keys';
import { ActionCommandRegistry } from './action-command.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunIdleReapService } from './run-idle-reap.service';
import { RunProcessAttribution } from './run-process-attribution.service';
import { createRunProcessReaper } from './run-process-reaper.service';

const OWNER = 'aaaaaaaaaaaaaaaa';
const SELF = 900;
const UID = 501;
const SECRET = 'sk-idle-reap-spec-secret-0123456789';

function tagged(
  pid: number,
  runId: string,
  args: string,
  ppid = 1,
): ScannedProcess {
  return {
    pid,
    ppid,
    pgid: pid,
    uid: UID,
    tty: null,
    startedAt: pid * 10,
    args,
    env: ppid === 1 ? `${RUN_ID_ENV}=${runId} ${RUN_OWNER_ENV}=${OWNER}` : '',
  };
}

/**
 * Over the REAL registry, reaper and transcript writer: the idle close is what
 * starts the reap, and the row is read back from the database it was written
 * to. Only the process table and the signals are doubles.
 */
describe('RunIdleReapService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let runDao: RunDao;
  let itemDao: ItemDao;

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
    registerSecret(SECRET, 'spec');
  });

  afterAll(async () => {
    clearSecrets();
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    runDao = new RunDao(orm.em.fork());
    itemDao = new ItemDao(orm.em.fork());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(
    rows: ScannedProcess[],
    scan: () => Promise<ScannedProcess[]> = () => Promise.resolve(rows),
    calls: ItemCallIndexService = new ItemCallIndexService(
      itemDao,
      runDao,
      orm.em,
    ),
  ) {
    const sessions = new AgentSessionRegistry(4);
    const commands = new ActionCommandRegistry();
    const monitoring = new Set<string>();
    const monitors = { isRunning: (runId: string) => monitoring.has(runId) };
    const signals: [number, NodeJS.Signals][] = [];
    const reaper = createRunProcessReaper(
      new RunProcessAttribution(OWNER, {
        scan,
        selfPid: SELF,
        uid: UID,
      }),
      sessions,
      [commands, monitors],
      {
        signal: (pid, sig) => signals.push([pid, sig]),
        startTimes: (pids) =>
          Promise.resolve(new Map(pids.map((pid) => [pid, pid * 10]))),
        wait: () => Promise.resolve(),
        logger: { log: vi.fn(), warn: vi.fn() },
        selfPid: SELF,
      },
    );
    const service = new RunIdleReapService(
      orm.em,
      runDao,
      itemDao,
      new AgentEventBus(),
      calls,
      new ItemSeqAllocator(orm.em, itemDao),
      sessions,
      reaper,
    );
    service.onModuleInit();
    const { adapter, kept } = keptSessionAdapter();
    return {
      sessions,
      commands,
      monitoring,
      service,
      reaper,
      signals,
      kept,
      adapter,
    };
  }

  async function notes(runId: string): Promise<string[]> {
    const items = await itemDao.getAll(
      { runId, kind: 'system' },
      undefined,
      orm.em.fork(),
    );
    return items.map((item) => {
      const payload = JSON.parse(item.payload) as {
        message: string;
        caption?: string;
      };
      // Captioned for what it is; a warning without one reads `not applied`.
      expect(payload.caption).toBe('processes stopped');
      return payload.message;
    });
  }

  /**
   * Sit unused for `ms`, then through the kill grace after the CLI's exit, by
   * which the idle reap is queued; resolves once it has run.
   */
  async function idleFor(
    ms: number,
    reaper: { settled(): Promise<void> },
  ): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS);
    vi.useRealTimers();
    await reaper.settled();
  }

  /** The notes once `count` have been written — the write follows the reap. */
  async function notesOnce(runId: string, count: number): Promise<string[]> {
    await vi.waitFor(
      async () => expect(await notes(runId)).toHaveLength(count),
      { timeout: 5_000 },
    );
    return notes(runId);
  }

  it.each([
    ['a chat', (runId: string) => runId],
    ['a team member', (runId: string) => nodeSessionKey(runId, 'dev')],
  ])(
    'stops what %s left outside its CLI once it went unused, and tells the user and the agent once',
    async (_what, keyOf) => {
      vi.useFakeTimers();
      const run = await runDao.create({ status: 'completed' });
      const { sessions, reaper, signals, kept, adapter } = setup([
        tagged(
          10,
          run.id,
          `pnpm dev --token=${SECRET} GITHUB_TOKEN=ghp_unregistered0123456789`,
        ),
        tagged(11, run.id, 'node next-server.js', 10),
        tagged(20, 'other-run', 'node other.js'),
      ]);
      sessions.setIdleMinutes(5);
      sessions.startTurn(
        keyOf(run.id),
        adapter,
        { prompt: 'p', cwd: '/p' },
        () => undefined,
      );
      kept[0]?.endTurn();

      await idleFor(5 * 60_000, reaper);

      expect(kept[0]?.alive).toBe(false);
      expect(
        signals.filter(([, sig]) => sig === 'SIGTERM').map(([pid]) => pid),
      ).toEqual([10, 11]);
      const [note] = await notesOnce(run.id, 1);
      expect(note).toContain('2 processes');
      expect(note).toContain('5 min');
      expect(note).toContain('pnpm dev --token=');
      // Named by the process that started the rest, as redacted as the panel.
      expect(note).not.toContain('next-server');
      expect(note).not.toContain(SECRET);
      // A value set inline is no registered secret, and the line can reach
      // another agent's provider.
      expect(note).toContain('GITHUB_TOKEN=…');
      expect(note).not.toContain('ghp_unregistered');

      sessions.startTurn(
        keyOf(run.id),
        adapter,
        { prompt: 'again', cwd: '/p' },
        () => undefined,
      );
      const prompt = kept[1]?.inputs[0]?.prompt ?? '';
      // The executable alone: argv read from the process table leaves the
      // machine in a prompt, and can carry what no agent typed.
      expect(prompt).toContain('started by: pnpm.');
      expect(prompt).not.toContain('--token');
      expect(prompt).not.toContain('GITHUB_TOKEN');
      expect(prompt).not.toContain('next-server');
    },
  );

  it('reaps only once the CLI’s own group kill has had its grace', async () => {
    // Its MCP servers are still stopping at the exit; they are not leftovers.
    vi.useFakeTimers();
    const run = await runDao.create({ status: 'completed' });
    const { sessions, reaper, kept, adapter, signals } = setup([
      tagged(10, run.id, 'pnpm dev'),
    ]);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );
    kept[0]?.endTurn();

    await vi.advanceTimersByTimeAsync(sessions.idleMinutes * 60_000);
    await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS - 1);
    expect(kept[0]?.alive).toBe(false);
    expect(signals).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await reaper.settled();
    expect(signals).toContainEqual([10, 'SIGTERM']);
  });

  it('reaps nothing once the daemon shuts down inside the grace', async () => {
    vi.useFakeTimers();
    const run = await runDao.create({ status: 'completed' });
    const { sessions, service, reaper, kept, adapter, signals } = setup([
      tagged(10, run.id, 'pnpm dev'),
    ]);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );
    kept[0]?.endTurn();
    await vi.advanceTimersByTimeAsync(sessions.idleMinutes * 60_000);
    expect(service.awaitingGrace(run.id)).toBe(true);

    service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(GROUP_KILL_GRACE_MS);
    vi.useRealTimers();
    await reaper.settled();

    expect(service.awaitingGrace(run.id)).toBe(false);
    expect(signals).toEqual([]);
  });

  it('leaves a run alone while a command action the user ran is still running', async () => {
    // The command is tagged with the run, so without the hold it would read
    // as something the agents left; an archive ends the command first.
    vi.useFakeTimers();
    const run = await runDao.create({ status: 'completed' });
    const { sessions, commands, reaper, kept, adapter, signals } = setup([
      tagged(10, run.id, 'pnpm test'),
    ]);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );
    kept[0]?.endTurn();
    const slot = commands.start(run.id);

    await idleFor(sessions.idleMinutes * 60_000, reaper);

    expect(kept[0]?.alive).toBe(false);
    expect(signals).toEqual([]);
    expect(await notes(run.id)).toEqual([]);

    commands.abortRun(run.id);
    expect(slot.signal.aborted).toBe(true);
    await reaper.reap([run.id]);
    expect(signals).toContainEqual([10, 'SIGTERM']);
  });

  it('leaves a run alone while one of its monitors is running', async () => {
    vi.useFakeTimers();
    const run = await runDao.create({ status: 'completed' });
    const { sessions, monitoring, reaper, kept, adapter, signals } = setup([
      tagged(10, run.id, 'gh run watch 1'),
    ]);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );
    kept[0]?.endTurn();
    monitoring.add(run.id);

    await idleFor(sessions.idleMinutes * 60_000, reaper);

    expect(signals).toEqual([]);
    expect(await notes(run.id)).toEqual([]);
  });

  it('writes nothing when nothing was left running', async () => {
    vi.useFakeTimers();
    const run = await runDao.create({ status: 'completed' });
    const { sessions, reaper, kept, adapter, signals } = setup([]);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );
    kept[0]?.endTurn();

    await idleFor(sessions.idleMinutes * 60_000, reaper);

    expect(kept[0]?.alive).toBe(false);
    expect(signals).toEqual([]);
    expect(await notes(run.id)).toEqual([]);
  });

  it.each([
    ['an archived run', true],
    ['a deleted run', false],
  ])(
    'stops what %s left but writes no note into it',
    async (_what, archived) => {
      const run = await runDao.create({ status: 'completed' });
      if (archived) {
        await runDao.updateById(run.id, { archivedAt: new Date() });
      }
      const runId = archived ? run.id : 'run-deleted';
      const { service, signals } = setup([tagged(10, runId, 'pnpm dev')]);

      const stopped = await service.reap(runId);

      expect(stopped.map((process) => process.pid)).toEqual([10]);
      expect(signals).toContainEqual([10, 'SIGTERM']);
      expect(await notes(runId)).toEqual([]);
    },
  );

  it('writes one note when two idle reaps of a run share a reap', async () => {
    // The idle close and the sweep can both ask while another run's reap is
    // still in its grace period, and then share the next one.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scans = 0;
    const run = await runDao.create({ status: 'completed' });
    const rows = [tagged(10, run.id, 'pnpm dev')];
    const { service, reaper: shared } = setup(rows, async () => {
      scans += 1;
      if (scans === 1) {
        await gate;
      }
      return rows;
    });
    shared.reapInBackground('run-other');

    const first = service.reap(run.id);
    const second = service.reap(run.id);
    release();
    await Promise.all([first, second]);

    expect(await notes(run.id)).toHaveLength(1);
  });

  it('still answers what it stopped when the note cannot be written, owing the agent nothing', async () => {
    const run = await runDao.create({ status: 'completed' });
    const failing = {
      inCallOf: () => Promise.reject(new Error('disk full')),
    } as unknown as ItemCallIndexService;
    const { service, sessions, kept, adapter } = setup(
      [tagged(10, run.id, 'pnpm dev')],
      undefined,
      failing,
    );

    const stopped = await service.reap(run.id);
    sessions.startTurn(
      run.id,
      adapter,
      { prompt: 'p', cwd: '/p' },
      () => undefined,
    );

    expect(stopped.map((process) => process.pid)).toEqual([10]);
    expect(await notes(run.id)).toEqual([]);
    expect(kept[0]?.inputs[0]?.prompt).toBe('p');
  });
});
