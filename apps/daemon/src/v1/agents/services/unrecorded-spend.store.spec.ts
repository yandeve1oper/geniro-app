import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { RunDao } from '../dao/run.dao';
import { AgentEventBus } from './agent-events.bus';
import { UnrecordedSpendStore } from './unrecorded-spend.store';

/**
 * Real-driver spec: the store's whole job is a column, so it is asserted on
 * the column — the same in-memory better-sqlite3 harness `run.dao.spec` uses.
 */
describe('UnrecordedSpendStore (in-memory sqlite)', () => {
  let orm: MikroORM;
  let bus: AgentEventBus;
  let store: UnrecordedSpendStore;

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
    await new RunDao(orm.em.fork()).create({ id: 'r1' });
    bus = new AgentEventBus();
    store = new UnrecordedSpendStore(orm.em, new RunDao(orm.em), bus);
    store.onModuleInit();
  });

  const column = async (runId = 'r1'): Promise<string | null> =>
    new RunDao(orm.em.fork()).unrecordedSpendOf(runId);

  it('writes each change to the run row, in the order it was made', async () => {
    store.set('r1', 'engineer::call-1', 12.5);
    store.set('r1', 'engineer::call-1', 38.5);
    store.set('r1', 'agent', 0.4);
    await store.flushed('r1');
    expect(JSON.parse((await column())!)).toEqual({
      agent: 0.4,
      'engineer::call-1': 38.5,
    });

    // A reading then its retirement: the retirement must land LAST, or a
    // turn that ended would leave its figure on the row beside the
    // `turn_complete` that recorded the same money.
    store.set('r1', 'agent', 0.9);
    store.set('r1', 'agent', null);
    await store.flushed('r1');
    expect(JSON.parse((await column())!)).toEqual({
      'engineer::call-1': 38.5,
    });
  });

  it('leaves the column NULL once nothing is owed', async () => {
    store.set('r1', 'agent', 0.4);
    store.clearRun('r1');
    await store.flushed('r1');

    expect(await column()).toBeNull();
  });

  it('merges with what an EARLIER process left, rather than overwriting it', async () => {
    await new RunDao(orm.em.fork()).setUnrecordedSpend(
      'r1',
      JSON.stringify({ 'engineer::call-1': 20 }),
    );

    store.set('r1', 'manager', 1.5);
    await store.flushed('r1');

    expect(JSON.parse((await column())!)).toEqual({
      'engineer::call-1': 20,
      manager: 1.5,
    });
  });

  it('reads every run with spend outstanding, for the boot rehydration', async () => {
    const dao = new RunDao(orm.em.fork());
    await dao.create({ id: 'r2' });
    await dao.create({ id: 'r3' });
    await dao.setUnrecordedSpend('r2', JSON.stringify({ agent: 3 }));
    await dao.setUnrecordedSpend('r3', 'not json');

    const loaded = await store.loadAll();

    expect([...loaded]).toEqual([
      ['r2', { spend: new Map([['agent', 3]]), estimates: new Map() }],
    ]);
  });

  it('writes the part geniro priced beside the dollars, and clears it with them', async () => {
    store.set('r1', 'agent', 0.4, 0.4);
    await store.flushed('r1');
    expect(JSON.parse((await column()) ?? '{}')).toEqual({
      agent: { costUsd: 0.4, estimatedCostUsd: 0.4 },
    });

    store.set('r1', 'agent', 0.5);
    await store.flushed('r1');
    expect(JSON.parse((await column()) ?? '{}')).toEqual({ agent: 0.5 });
  });

  it('keeps going after a run is deleted, writing nothing for it', async () => {
    store.set('r1', 'agent', 0.4);
    await store.flushed('r1');
    await orm.em.fork().nativeDelete(Run, { id: 'r1' });
    bus.publishRunDeleted('r1');

    store.set('r1', 'agent', 0.8);
    await store.flushed('r1');

    expect(await column()).toBeNull();
  });
});
