import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import { tempDir } from '../__tests__/temp-dir';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { CALL_MEMBERSHIP_VERSION } from '../utils/call-membership';
import {
  ItemCallIndexService,
  stampPauseAfter,
} from './item-call-index.service';

describe('ItemCallIndexService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ItemDao;
  let runs: RunDao;
  let marker: string;
  let index: ItemCallIndexService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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
    const em = orm.em.fork() as EntityManager;
    dao = new ItemDao(em);
    runs = new RunDao(em);
    marker = join(tempDir('call-index-'), 'marker');
    index = new ItemCallIndexService(dao, runs, em, marker);
  });

  /** A row written the way a build before the column wrote it: unstamped. */
  async function legacy(
    seq: number,
    kind: ItemKind,
    memberId: string | null,
    payload: Record<string, unknown>,
    runId = 'run-1',
  ): Promise<void> {
    await dao.create({
      runId,
      seq,
      kind,
      memberId,
      payload: JSON.stringify(payload),
    });
  }

  /**
   * {@link legacy} for rows `1..count` of a run, in one flush. A run past one
   * stamping batch is 600 rows, and a flush per row made such a case alone take
   * ~1s on an idle machine and run out of its 5s on a loaded one.
   */
  async function legacyRun(
    count: number,
    row: (seq: number) => {
      kind: ItemKind;
      memberId: string;
      payload: Record<string, unknown>;
    },
    runId = 'run-1',
  ): Promise<void> {
    await dao.createMany(
      Array.from({ length: count }, (_, index) => {
        const seq = index + 1;
        const { kind, memberId, payload } = row(seq);
        return {
          runId,
          seq,
          kind,
          memberId,
          payload: JSON.stringify(payload),
        };
      }),
    );
  }

  async function inCallBySeq(runId = 'run-1'): Promise<(string | null)[]> {
    const rows = await dao.getByRun(runId, -1, orm.em.fork() as EntityManager);
    return rows.map((row) => row.inCall);
  }

  it("stamps an older run's rows by the call whose card each is drawn in", async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    await legacy(2, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });
    await legacy(3, 'tool_call', 'engineer', { id: 't1', callId: 'call-1' });
    await legacy(4, 'approval_request', 'engineer', { callId: 'call-1' });
    await legacy(5, 'call_result', 'manager', { callId: 'call-1' });

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq()).toEqual(['', '', 'call-1', '', 'call-1']);
  });

  it('leaves every other run alone', async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    await legacy(1, 'message', 'manager', { text: 'other' }, 'run-2');

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq('run-2')).toEqual([null]);
  });

  it('reads the call starts a stamped row holds when stamping the unstamped ones after it', async () => {
    // A run written across the upgrade: its call started under the new build,
    // and a row the old one wrote meanwhile still needs the start to be placed.
    await dao.create({
      runId: 'run-1',
      seq: 1,
      kind: 'call_started',
      memberId: 'manager',
      payload: JSON.stringify({ callId: 'call-1', calleeNodeId: 'engineer' }),
      inCall: '',
    });
    await legacy(2, 'message', 'engineer', { text: 'on it', callId: 'call-1' });

    await index.ensureIndexed('run-1');

    expect(await inCallBySeq()).toEqual(['', 'call-1']);
  });

  it('stamps a row as it is written from the starts the run already holds', async () => {
    await legacy(1, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });

    expect(
      await index.inCallOf('run-1', {
        kind: 'message',
        memberId: 'engineer',
        payload: { text: 'done', callId: 'call-1' },
      }),
    ).toBe('call-1');
  });

  it('learns a start it is asked to stamp, for the rows written after it', async () => {
    await index.inCallOf('run-1', {
      kind: 'call_started',
      memberId: 'manager',
      payload: { callId: 'call-2', calleeNodeId: 'qa' },
    });

    expect(
      await index.inCallOf('run-1', {
        kind: 'tool_call',
        memberId: 'qa',
        payload: { id: 't1', callId: 'call-2' },
      }),
    ).toBe('call-2');
  });

  it('stamps a row outside any call as the run’s own flow without reading the run', async () => {
    const reads = vi.spyOn(dao, 'rowsOfKinds');

    expect(
      await index.inCallOf('run-1', {
        kind: 'message',
        memberId: 'manager',
        payload: { text: 'plan' },
      }),
    ).toBe('');
    expect(reads).not.toHaveBeenCalled();
  });

  it('stamps a run past one batch of rows', async () => {
    await legacy(0, 'call_started', 'manager', {
      callId: 'call-1',
      calleeNodeId: 'engineer',
    });
    await legacyRun(600, (seq) => ({
      kind: 'tool_call',
      memberId: 'engineer',
      payload: { id: `t${seq}`, callId: 'call-1' },
    }));

    await index.ensureIndexed('run-1');

    const stamped = await inCallBySeq();
    expect(stamped).toHaveLength(601);
    expect(stamped.filter((value) => value === 'call-1')).toHaveLength(600);
  });

  it('stamps a run once when two reads ask at the same time', async () => {
    await legacy(1, 'message', 'manager', { text: 'plan' });
    const reads = vi.spyOn(dao, 'unstampedRows');

    await Promise.all([
      index.ensureIndexed('run-1'),
      index.ensureIndexed('run-1'),
    ]);

    // One stamping pass: its batch, then the empty read that ends it.
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('reads a run once to know whether it can hold calls', async () => {
    await runs.create({ id: 'run-1', teamId: 'dev-team' });
    await runs.create({ id: 'chat-1' });
    const reads = vi.spyOn(runs, 'getById');

    expect(await index.holdsCalls('run-1')).toBe(true);
    expect(await index.holdsCalls('run-1')).toBe(true);
    expect(await index.holdsCalls('chat-1')).toBe(false);

    expect(reads).toHaveBeenCalledTimes(2);
  });

  describe('the boot sweep', () => {
    it('stamps every team run and records the rule it stamped under', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await runs.create({ id: 'run-2', teamId: 'dev-team' });
      await legacy(1, 'message', 'manager', { text: 'a' }, 'run-1');
      await legacy(1, 'message', 'manager', { text: 'b' }, 'run-2');

      await index.indexAllQuietly();

      expect(await inCallBySeq('run-1')).toEqual(['']);
      expect(await inCallBySeq('run-2')).toEqual(['']);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(CALL_MEMBERSHIP_VERSION),
      );
    });

    it('stays retired once it has finished under the current rule', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION}\n`);
      await legacy(1, 'message', 'manager', { text: 'a' });

      await index.indexAllQuietly();

      // Left for the run's first read, which stamps it on demand.
      expect(await inCallBySeq()).toEqual([null]);
    });

    it("stamps every row again when the stamps are another rule's", async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.create({
        runId: 'run-1',
        seq: 1,
        kind: 'message',
        memberId: 'manager',
        payload: JSON.stringify({ text: 'a' }),
        inCall: 'call-stale',
      });

      await index.indexAllQuietly();

      expect(await inCallBySeq()).toEqual(['']);
    });

    it('resolves when the runs cannot be listed, and is not retired', async () => {
      vi.spyOn(runs, 'listTeamRuns').mockRejectedValue(new Error('locked'));

      await expect(index.indexAllQuietly()).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    });

    async function stale(seq: number, runId: string): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        memberId: 'manager',
        payload: JSON.stringify({ text: `m${seq}` }),
        inCall: 'call-stale',
      });
    }

    it('stamps again a run past one batch whose rows all carry another rule’s stamp', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.createMany(
        Array.from({ length: 600 }, (_, at) => ({
          runId: 'run-1',
          seq: at + 1,
          kind: 'message' as const,
          memberId: 'manager',
          payload: JSON.stringify({ text: `m${at + 1}` }),
          inCall: 'call-stale',
        })),
      );

      await index.indexAllQuietly();

      expect(new Set(await inCallBySeq())).toEqual(new Set(['']));
    });

    it('places a run from its indexes, reading no payload, when its promoted columns are filled', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await legacy(1, 'call_started', 'manager', {
        callId: 'call-1',
        calleeNodeId: 'engineer',
      });
      await legacy(2, 'message', 'engineer', {
        text: 'on it',
        callId: 'call-1',
      });
      await legacy(3, 'subagent_info', 'manager', {
        id: 'd1',
        callId: 'call-1',
      });
      await legacy(4, 'tool_call', 'engineer', {
        id: 't1',
        parentToolUseId: 'd1',
      });
      await orm.em
        .fork()
        .nativeUpdate(Item, { runId: 'run-1' }, { inCall: 'call-stale' });
      const fromIndexes = vi.spyOn(dao, 'inCallRowsOfKind');
      const fromPayloads = vi.spyOn(dao, 'inCallBatch');

      await index.indexAllQuietly();

      expect(await inCallBySeq()).toEqual(['', 'call-1', '', '']);
      expect(fromIndexes).toHaveBeenCalled();
      expect(fromPayloads).not.toHaveBeenCalled();
    });

    it('lets a timer queued while a run is being stamped again run before the next batch is written', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.createMany(
        Array.from({ length: 600 }, (_, at) => ({
          runId: 'run-1',
          seq: at + 1,
          kind: 'message' as const,
          memberId: 'manager',
          payload: JSON.stringify({ text: `m${at + 1}` }),
          inCall: 'call-stale',
        })),
      );
      const write = dao.rememberInCallAt.bind(dao);
      let writesBeforeTimer: number | null = null;
      const writes = vi
        .spyOn(dao, 'rememberInCallAt')
        .mockImplementation(async (runId, kind, inCall, rows, em) => {
          if (writes.mock.calls.length === 1) {
            setTimeout(() => {
              writesBeforeTimer = writes.mock.calls.length;
            }, 0);
          }
          return write(runId, kind, inCall, rows, em);
        });

      await index.indexAllQuietly();

      expect(writes.mock.calls.length).toBeGreaterThan(2);
      expect(writesBeforeTimer).toBe(1);
      expect(new Set(await inCallBySeq())).toEqual(new Set(['']));
    });

    it('pauses after a batch at least as long as the batch held the event loop, within bounds', () => {
      expect(stampPauseAfter(0)).toBe(10);
      expect(stampPauseAfter(120.2)).toBe(121);
      expect(stampPauseAfter(5_000)).toBe(1_000);
    });

    it('places a run from its payloads when its promoted columns were never filled', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await orm.em
        .fork()
        .nativeUpdate(Run, { id: 'run-1' }, { payloadRefsVersion: null });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await legacy(1, 'call_started', 'manager', {
        callId: 'call-1',
        calleeNodeId: 'engineer',
      });
      await legacy(2, 'message', 'engineer', {
        text: 'on it',
        callId: 'call-1',
      });
      await orm.em
        .fork()
        .nativeUpdate(
          Item,
          { runId: 'run-1' },
          { inCall: 'call-stale', callId: null, payloadId: null },
        );
      const fromIndexes = vi.spyOn(dao, 'inCallRowsOfKind');
      const fromPayloads = vi.spyOn(dao, 'inCallBatch');

      await index.indexAllQuietly();

      expect(await inCallBySeq()).toEqual(['', 'call-1']);
      expect(fromPayloads).toHaveBeenCalled();
      expect(fromIndexes).not.toHaveBeenCalled();
    });

    it('lets a read finish while its run is still being stamped again, then marks the run to be read again', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await runs.create({ id: 'run-2', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await stale(1, 'run-1');
      await stale(1, 'run-2');
      await legacy(2, 'message', 'manager', { text: 'unstamped' }, 'run-1');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = dao.inCallRowsOfKind.bind(dao);
      vi.spyOn(dao, 'inCallRowsOfKind').mockImplementation(
        async (runId, kind, em) => {
          await held;
          return read(runId, kind, em);
        },
      );

      const sweep = index.indexAllQuietly();
      await index.ensureIndexed('run-1');

      expect(await inCallBySeq('run-1')).toEqual(['call-stale', '']);
      expect(index.stampEpochOf('run-1')).toBe(0);
      expect(readFileSync(marker, 'utf8')).toBe(
        `${CALL_MEMBERSHIP_VERSION - 1}\n`,
      );

      release();
      await sweep;

      expect(await inCallBySeq('run-1')).toEqual(['', '']);
      expect(await inCallBySeq('run-2')).toEqual(['']);
      expect(index.stampEpochOf('run-1')).toBe(1);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(CALL_MEMBERSHIP_VERSION),
      );
    });

    it('leaves a run’s epoch alone when stamping it again changed nothing', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.create({
        runId: 'run-1',
        seq: 1,
        kind: 'message',
        memberId: 'manager',
        payload: JSON.stringify({ text: 'a' }),
        inCall: '',
      });

      await index.indexAllQuietly();

      expect(index.stampEpochOf('run-1')).toBe(0);
    });

    it('stamps a run again once when a read and the sweep reach it together', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await stale(1, 'run-1');
      const reads = vi.spyOn(dao, 'inCallRowsOfKind');

      await Promise.all([
        index.ensureIndexed('run-1'),
        index.indexAllQuietly(),
      ]);

      expect(await inCallBySeq()).toEqual(['']);
      // One pass: one read of the run's one kind.
      expect(reads).toHaveBeenCalledTimes(1);
    });

    it('goes on past a run that fails, leaves the marker unwritten, and the next launch stamps every run again', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await runs.create({ id: 'run-2', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await stale(1, 'run-1');
      await stale(1, 'run-2');
      const read = dao.inCallRowsOfKind.bind(dao);
      const failing = vi
        .spyOn(dao, 'inCallRowsOfKind')
        .mockImplementation(async (runId, kind, em) => {
          if (runId === 'run-2') {
            throw new Error('locked');
          }
          return read(runId, kind, em);
        });

      await index.indexAllQuietly();

      expect(await inCallBySeq('run-1')).toEqual(['']);
      expect(readFileSync(marker, 'utf8')).toBe(
        `${CALL_MEMBERSHIP_VERSION - 1}\n`,
      );
      failing.mockRestore();

      const nextLaunch = new ItemCallIndexService(
        dao,
        runs,
        orm.em.fork() as EntityManager,
        marker,
      );
      const reads = vi.spyOn(dao, 'inCallRowsOfKind');
      await nextLaunch.indexAllQuietly();

      expect(new Set(reads.mock.calls.map(([runId]) => runId))).toEqual(
        new Set(['run-1', 'run-2']),
      );
      expect(await inCallBySeq('run-2')).toEqual(['']);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(CALL_MEMBERSHIP_VERSION),
      );
    });

    it('moves the run’s epoch when a re-stamp fails after it changed rows, and waits before a read starts one again', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await dao.createMany(
        (['message', 'tool_call'] as const).map((kind, at) => ({
          runId: 'run-1',
          seq: at + 1,
          kind,
          memberId: 'manager',
          payload: JSON.stringify({ text: `m${at + 1}` }),
          inCall: 'call-stale',
        })),
      );
      const read = dao.inCallRowsOfKind.bind(dao);
      const reads = vi
        .spyOn(dao, 'inCallRowsOfKind')
        .mockImplementation(async (runId, kind, em) => {
          if (reads.mock.calls.length > 1) {
            throw new Error('locked');
          }
          return read(runId, kind, em);
        });

      await index.indexAllQuietly();
      await index.ensureIndexed('run-1');

      expect(index.stampEpochOf('run-1')).toBe(1);
      expect(reads).toHaveBeenCalledTimes(2);
    });

    it('keeps the stamp of a row written while its run is being stamped again', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await stale(1, 'run-1');
      await stale(4, 'run-1');
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached: () => void = () => undefined;
      const reading = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const read = dao.inCallRowsOfKind.bind(dao);
      vi.spyOn(dao, 'inCallRowsOfKind').mockImplementation(
        async (runId, kind, em) => {
          reached();
          await held;
          return read(runId, kind, em);
        },
      );
      async function written(
        seq: number,
        kind: ItemKind,
        memberId: string,
        payload: Record<string, unknown>,
      ): Promise<void> {
        const inCall = await index.inCallOf('run-1', {
          kind,
          memberId,
          payload,
        });
        await dao.create({
          runId: 'run-1',
          seq,
          kind,
          memberId,
          payload: JSON.stringify(payload),
          inCall,
        });
      }

      const sweep = index.indexAllQuietly();
      await reading;
      await written(2, 'call_started', 'manager', {
        callId: 'call-9',
        calleeNodeId: 'engineer',
      });
      await written(3, 'message', 'engineer', {
        text: 'on it',
        callId: 'call-9',
      });
      release();
      await sweep;

      expect(await inCallBySeq()).toEqual(['', '', 'call-9', '']);
    });

    it('places every row the same from the promoted columns as from its payload', async () => {
      const rows: [ItemKind, string, Record<string, unknown>][] = [
        [
          'call_started',
          'manager',
          { callId: 'call-1', calleeNodeId: 'engineer' },
        ],
        ['message', 'engineer', { text: 'on it', callId: 'call-1' }],
        ['message', 'manager', { text: 'aside', callId: 'call-1' }],
        ['tool_call', 'engineer', { id: 't1', callId: 'call-1' }],
        ['call_question', 'manager', { callId: 'call-1' }],
        ['approval_request', 'engineer', { callId: 'call-1' }],
        ['subagent_info', 'engineer', { id: 'd1', callId: 'call-1' }],
        ['subagent_info', 'engineer', { id: 'd1' }],
        [
          'call_started',
          'engineer',
          {
            callId: 'call-2',
            calleeNodeId: 'qa',
            callerConversationId: 'call-1',
          },
        ],
        ['message', 'qa', { text: 'nested', callId: 'call-2' }],
        ['call_result', 'manager', { callId: 'call-1' }],
        ['message', 'manager', { text: 'unknown call', callId: 'call-x' }],
      ];
      const placed: (string | null)[][] = [];
      for (const fromColumns of [true, false]) {
        await orm.schema.clear();
        const em = orm.em.fork() as EntityManager;
        dao = new ItemDao(em);
        runs = new RunDao(em);
        index = new ItemCallIndexService(dao, runs, em, marker);
        await runs.create({ id: 'run-1', teamId: 'dev-team' });
        if (!fromColumns) {
          await orm.em
            .fork()
            .nativeUpdate(Run, { id: 'run-1' }, { payloadRefsVersion: null });
        }
        writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
        for (const [at, [kind, memberId, payload]] of rows.entries()) {
          await legacy(at + 1, kind, memberId, payload);
        }
        await orm.em
          .fork()
          .nativeUpdate(Item, { runId: 'run-1' }, { inCall: 'call-stale' });

        await index.indexAllQuietly();

        placed.push(await inCallBySeq());
      }

      expect(placed[0]).toEqual(placed[1]);
      expect(placed[0]).not.toContain('call-stale');
    });

    it('keeps a chat’s stamps under a changed rule, since its rows are all in its own flow', async () => {
      await runs.create({ id: 'chat-1' });
      writeFileSync(marker, `${CALL_MEMBERSHIP_VERSION - 1}\n`);
      await legacy(1, 'message', null, { text: 'hi' }, 'chat-1');
      await index.ensureIndexed('chat-1');
      const fromIndexes = vi.spyOn(dao, 'inCallRowsOfKind');
      const fromPayloads = vi.spyOn(dao, 'inCallBatch');

      await index.ensureIndexed('chat-1');
      await legacy(2, 'message', null, { text: 'again' }, 'chat-1');
      await new ItemCallIndexService(
        dao,
        runs,
        orm.em.fork() as EntityManager,
        marker,
      ).ensureIndexed('chat-1');

      expect(fromIndexes).not.toHaveBeenCalled();
      expect(fromPayloads).not.toHaveBeenCalled();
      expect(await inCallBySeq('chat-1')).toEqual(['', '']);
    });
  });
});
