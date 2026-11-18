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
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { DelegateFigures } from '../adapters/adapter.types';
import { RunDao } from '../dao/run.dao';
import { readDelegateSpend, writeDelegateSpend } from '../utils/delegate-spend';
import { AgentEventBus } from './agent-events.bus';
import { DelegateSpendStore } from './delegate-spend.store';

/**
 * Real-driver spec: the store's whole job is a column, so it is asserted on
 * the column — the same in-memory better-sqlite3 harness `run.dao.spec` uses.
 */
describe('DelegateSpendStore (in-memory sqlite)', () => {
  let orm: MikroORM;
  let bus: AgentEventBus;
  let dao: RunDao;
  let store: DelegateSpendStore;

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
    dao = new RunDao(orm.em.fork());
    await dao.create({ id: 'r1' });
    bus = new AgentEventBus();
    store = new DelegateSpendStore(orm.em, new RunDao(orm.em), bus);
    store.onModuleInit();
  });

  afterEach(async () => {
    store.flushRun('r1');
    await store.flushed('r1');
    vi.useRealTimers();
  });

  const column = async (runId = 'r1'): Promise<Map<string, DelegateFigures>> =>
    readDelegateSpend(await new RunDao(orm.em.fork()).delegateSpendOf(runId));

  const figures = (
    overrides: Partial<DelegateFigures> = {},
  ): DelegateFigures => ({
    requests: 4,
    inputTokens: 2_000,
    outputTokens: 800,
    cacheReadTokens: 30_000,
    cacheCreationTokens: 1_000,
    contextTokens: 31_000,
    model: 'claude-haiku-5-5',
    costUsd: 0.02,
    estimatedCostUsd: 0.019,
    ...overrides,
  });

  it('writes a final reading to the run row at once, and reads it back whole', async () => {
    store.set('r1', 'call-1', figures({ requests: 2 }), true);
    await store.flushed('r1');

    expect(await column()).toEqual(
      new Map([['call-1', figures({ requests: 2 })]]),
    );
  });

  it('keeps the latest figures for a delegate, not the first', async () => {
    store.set('r1', 'call-1', figures({ requests: 1 }), true);
    store.set('r1', 'call-1', figures({ requests: 9 }), true);
    await store.flushed('r1');

    expect((await column()).get('call-1')?.requests).toBe(9);
  });

  it('skips the write when the figures are already on the row', async () => {
    const write = vi.spyOn(dao, 'setDelegateSpend');
    const shared = new DelegateSpendStore(orm.em, dao, bus);
    shared.onModuleInit();

    shared.set('r1', 'call-1', figures(), true);
    await shared.flushed('r1');
    shared.set('r1', 'call-1', figures(), true);
    await shared.flushed('r1');

    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it('coalesces the changes of one window into a single write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const write = vi.spyOn(dao, 'setDelegateSpend');
    const shared = new DelegateSpendStore(orm.em, dao, bus);
    shared.onModuleInit();

    shared.set('r1', 'call-1', figures({ requests: 1 }), false);
    shared.set('r1', 'call-2', figures({ requests: 2 }), false);
    await shared.flushed('r1');
    expect(write).not.toHaveBeenCalled();
    expect(await column()).toEqual(new Map());

    vi.advanceTimersByTime(2_000);
    await shared.flushed('r1');

    expect(write).toHaveBeenCalledTimes(1);
    expect((await column()).size).toBe(2);
    write.mockRestore();
  });

  it('writes a final reading at once even inside a coalescing window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    store.set('r1', 'call-1', figures({ requests: 1 }), false);
    store.set('r1', 'call-1', figures({ requests: 7 }), true);
    await store.flushed('r1');

    expect((await column()).get('call-1')?.requests).toBe(7);
  });

  it('lands whatever is pending when the turn boundary flushes the run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const write = vi.spyOn(dao, 'setDelegateSpend');
    const shared = new DelegateSpendStore(orm.em, dao, bus);
    shared.onModuleInit();
    shared.set('r1', 'call-1', figures(), false);

    shared.flushRun('r1');
    await shared.flushed('r1');
    expect(write).toHaveBeenCalledTimes(1);
    expect((await column()).size).toBe(1);

    vi.advanceTimersByTime(2_000);
    await shared.flushed('r1');
    expect(write).toHaveBeenCalledTimes(1);
    write.mockRestore();
  });

  it('merges with the figures an EARLIER process wrote, rather than overwriting them', async () => {
    await dao.setDelegateSpend(
      'r1',
      writeDelegateSpend(new Map([['call-0', figures({ requests: 3 })]])),
    );

    store.set('r1', 'call-1', figures({ requests: 5 }), true);
    await store.flushed('r1');

    expect(await column()).toEqual(
      new Map([
        ['call-0', figures({ requests: 3 })],
        ['call-1', figures({ requests: 5 })],
      ]),
    );
  });

  it('keeps the figures written before a restart after a second store starts on the run', async () => {
    store.set('r1', 'call-1', figures({ requests: 2 }), true);
    await store.flushed('r1');

    const restarted = new DelegateSpendStore(orm.em, new RunDao(orm.em), bus);
    restarted.onModuleInit();
    restarted.set('r1', 'call-2', figures({ requests: 6 }), true);
    await restarted.flushed('r1');

    expect([...(await column()).keys()].sort()).toEqual(['call-1', 'call-2']);
  });

  it('keeps going after a run is deleted, writing nothing for it', async () => {
    store.set('r1', 'call-1', figures(), true);
    await store.flushed('r1');
    await orm.em.fork().nativeDelete(Run, { id: 'r1' });
    bus.publishRunDeleted('r1');

    store.set('r1', 'call-1', figures({ requests: 9 }), true);
    await store.flushed('r1');

    expect(await column()).toEqual(new Map());
  });
});
