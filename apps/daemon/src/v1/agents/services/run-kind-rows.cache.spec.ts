import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { OUTSIDE_ANY_CALL } from '../utils/call-membership';
import { CALL_RECORDS } from '../utils/call-seed';
import { AgentEventBus } from './agent-events.bus';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { RunKindRowsCache } from './run-kind-rows.cache';

describe('RunKindRowsCache (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let seqs: ItemSeqAllocator;
  let bus: AgentEventBus;
  let calls: ItemCallIndexService;
  let cache: RunKindRowsCache;

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
    items = new ItemDao(em);
    seqs = new ItemSeqAllocator(em, items);
    bus = new AgentEventBus();
    calls = new ItemCallIndexService(
      items,
      new RunDao(em),
      em,
      join(mkdtempSync(join(tmpdir(), 'kind-rows-')), 'marker'),
    );
    cache = new RunKindRowsCache(items, seqs, bus, calls, em);
    cache.onModuleInit();
  });

  async function write(seq: number, kind: ItemKind): Promise<void> {
    await items.create({
      runId: 'run-a',
      seq,
      kind,
      payload: JSON.stringify({ seq }),
    });
  }

  async function seqsOf(kinds: ItemKind[]): Promise<number[]> {
    return (await cache.rowsOf('run-a', kinds)).map((row) => row.seq);
  }

  it('reads only the rows past what it already holds', async () => {
    await write(0, 'turn_complete');
    await write(1, 'message');
    expect(await seqsOf(['turn_complete'])).toEqual([0]);

    const read = vi.spyOn(items, 'rowsOfKindsBetween');
    await write(2, 'turn_complete');

    expect(await seqsOf(['turn_complete'])).toEqual([0, 2]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]!.slice(1, 4)).toEqual([['turn_complete'], 1, 2]);
  });

  it('holds back past a seq reserved but not written yet, then reads it once written', async () => {
    await write(0, 'turn_complete');
    const reserved = await seqs.reserve('run-a');
    await write(reserved + 1, 'turn_complete');

    expect(await seqsOf(['turn_complete'])).toEqual([0]);

    await write(reserved, 'turn_complete');
    seqs.settle('run-a', reserved);

    expect(await seqsOf(['turn_complete'])).toEqual([
      0,
      reserved,
      reserved + 1,
    ]);
  });

  it('serves a team run’s row written before its call stamp only once the run is stamped', async () => {
    await new RunDao(orm.em.fork()).create({
      id: 'run-a',
      status: 'running',
      teamId: 'flow',
    });
    await write(0, 'turn_complete');

    const [row] = await cache.rowsOf('run-a', ['turn_complete']);

    expect(row!.inCall).toBe(OUTSIDE_ANY_CALL);
  });

  it('reads a run again from the start once its rows were stamped again', async () => {
    await write(0, 'turn_complete');
    await seqsOf(['turn_complete']);
    vi.spyOn(calls, 'stampEpochOf').mockImplementation((runId) =>
      runId === 'run-a' ? 1 : 0,
    );
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    expect(await seqsOf(['turn_complete'])).toEqual([0]);
    expect(read.mock.calls[0]![2]).toBe(-1);
  });

  it('keeps a run’s rows when another run’s rows were stamped again', async () => {
    await write(0, 'turn_complete');
    await seqsOf(['turn_complete']);
    vi.spyOn(calls, 'stampEpochOf').mockImplementation((runId) =>
      runId === 'run-a' ? 0 : 1,
    );
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    expect(await seqsOf(['turn_complete'])).toEqual([0]);
    expect(read).not.toHaveBeenCalled();
  });

  it('never stamps a chat, whose rows are all in its own flow', async () => {
    await new RunDao(orm.em.fork()).create({
      id: 'run-a',
      status: 'running',
      teamId: null,
    });
    await write(0, 'turn_complete');
    const stamp = vi.spyOn(calls, 'ensureIndexed');

    expect(await seqsOf(['turn_complete'])).toEqual([0]);
    expect(stamp).not.toHaveBeenCalled();
  });

  it('shares one read between callers that arrive together', async () => {
    await write(0, 'turn_complete');
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    const [first, second] = await Promise.all([
      seqsOf(['turn_complete']),
      seqsOf(['turn_complete']),
    ]);

    expect(first).toEqual([0]);
    expect(second).toEqual([0]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again for a caller that saw a row written after the read it joined began', async () => {
    await write(0, 'turn_complete');
    const maxSeq = items.maxSeq.bind(items);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(items, 'maxSeq').mockImplementationOnce(async (...args) => {
      const seen = await maxSeq(...args);
      reached();
      await gate;
      return seen;
    });

    const early = cache.rowsOf('run-a', ['turn_complete']);
    await atGate;
    await write(1, 'turn_complete');
    const late = cache.rowsOf('run-a', ['turn_complete'], 1);
    release();

    expect((await early).map((row) => row.seq)).toEqual([0]);
    expect((await late).map((row) => row.seq)).toEqual([0, 1]);
  });

  it('drops the least recently read set once the payload budget is spent', async () => {
    const small = new RunKindRowsCache(
      items,
      seqs,
      bus,
      calls,
      orm.em.fork() as EntityManager,
      10,
    );
    await write(0, 'turn_complete');
    await write(1, 'subagent_info');
    await small.rowsOf('run-a', ['turn_complete']);
    await small.rowsOf('run-a', ['subagent_info']);
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    await small.rowsOf('run-a', ['subagent_info']);
    await small.rowsOf('run-a', ['turn_complete']);

    expect(read.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      [['turn_complete'], -1],
    ]);
  });

  it('answers call records: the call rows and only the system rows carrying delivery notices, in seq order', async () => {
    const record = async (
      seq: number,
      kind: ItemKind,
      payload: unknown,
    ): Promise<void> => {
      await items.create({
        runId: 'run-a',
        seq,
        kind,
        payload: JSON.stringify(payload),
      });
    };
    await record(0, 'call_started', { callId: 'call-1' });
    await record(1, 'system', { text: 'unrelated note' });
    await record(2, 'system', { messageDeliveryNotices: [] });
    await record(3, 'call_answer', { callId: 'call-1' });
    await record(4, 'call_result', { callId: 'call-1' });
    await record(5, 'message', { text: 'not a record' });

    expect(
      (await cache.rowsOfView('run-a', CALL_RECORDS)).map((row) => row.seq),
    ).toEqual([0, 2, 3, 4]);
  });

  it('answers a fresh read with a row written after the read it would have joined began', async () => {
    await write(0, 'turn_complete');
    const maxSeq = items.maxSeq.bind(items);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const atGate = new Promise<void>((resolve) => {
      reached = resolve;
    });
    vi.spyOn(items, 'maxSeq').mockImplementationOnce(async (...args) => {
      const seen = await maxSeq(...args);
      reached();
      await gate;
      return seen;
    });
    const view = { name: 'turns', kinds: ['turn_complete'] as ItemKind[] };

    const early = cache.rowsOfView('run-a', view);
    await atGate;
    await write(1, 'turn_complete');
    const fresh = cache.rowsOfView('run-a', view, 'fresh');
    release();

    expect((await early).map((row) => row.seq)).toEqual([0]);
    expect((await fresh).map((row) => row.seq)).toEqual([0, 1]);
  });

  it('keeps nothing from a read the run was deleted during', async () => {
    await write(0, 'turn_complete');
    const maxSeq = items.maxSeq.bind(items);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(items, 'maxSeq').mockImplementationOnce(async (...args) => {
      const seen = await maxSeq(...args);
      await gate;
      return seen;
    });

    const reading = seqsOf(['turn_complete']);
    await new Promise((resolve) => setImmediate(resolve));
    bus.publishRunDeleted('run-a');
    release();
    await reading;
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    await seqsOf(['turn_complete']);

    expect(read.mock.calls[0]![2]).toBe(-1);
  });

  it('reads a run first seen cold in seq windows, every row kept', async () => {
    await write(0, 'turn_complete');
    await write(4_500, 'turn_complete');
    const read = vi.spyOn(items, 'rowsOfKindsBetween');

    expect(await seqsOf(['turn_complete'])).toEqual([0, 4_500]);
    expect(read.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      [-1, 1_999],
      [1_999, 3_999],
      [3_999, 4_500],
    ]);
  });

  it('forgets a deleted run, so a run id reused by a test or an import starts over', async () => {
    await write(0, 'turn_complete');
    expect(await seqsOf(['turn_complete'])).toEqual([0]);

    await orm.em.fork().nativeDelete(Item, { runId: 'run-a' });
    bus.publishRunDeleted('run-a');
    await write(0, 'turn_complete');

    const read = vi.spyOn(items, 'rowsOfKindsBetween');
    expect(await seqsOf(['turn_complete'])).toEqual([0]);
    expect(read.mock.calls[0]![2]).toBe(-1);
  });
});
