import {
  defineConfig,
  EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
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
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { PAYLOAD_REFS_VERSION } from '../utils/payload-refs';
import { PayloadRefsSweepService } from './payload-refs-sweep.service';

describe('PayloadRefsSweepService (in-memory sqlite)', () => {
  let orm: MikroORM;

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
  });

  /**
   * Rows as a build before the columns wrote them: a native insert runs no
   * entity hook, so their columns stay NULL like an upgraded table's.
   */
  async function legacyRows(runId: string, count: number): Promise<void> {
    const at = new Date(Date.UTC(2026, 9, 27));
    await orm.em.fork().insertMany(
      Item,
      Array.from({ length: count }, (_, seq) => ({
        id: `${runId}-${seq}`,
        runId,
        seq,
        kind: 'tool_call' as const,
        role: 'assistant',
        payload: JSON.stringify({
          id: `toolu_${seq}`,
          name: 'Read',
          parentToolUseId: seq % 2 === 0 ? 'toolu_parent' : null,
          callId: 'call-1',
        }),
        createdAt: at,
        updatedAt: at,
      })),
    );
  }

  /** A run as an upgraded table holds it: created stamped, then set to `payloadRefsVersion`. */
  async function run(id: string, payloadRefsVersion: number | null) {
    await new RunDao(orm.em.fork()).create({
      id,
      status: 'completed',
      teamId: null,
    });
    await orm.em.fork().nativeUpdate(Run, { id }, { payloadRefsVersion });
  }

  function sweep(): Promise<void> {
    const em = orm.em.fork() as EntityManager;
    return new PayloadRefsSweepService(
      new ItemDao(em),
      new RunDao(em),
      em,
    ).sweepAllQuietly();
  }

  it('stamps every older row of an unstamped run, across batches, and marks the run', async () => {
    await run('run-old', null);
    await legacyRows('run-old', 450);

    await sweep();

    const rows = await orm.em
      .fork()
      .find(Item, { runId: 'run-old' }, { orderBy: { seq: 'asc' } });
    expect(rows.filter((r) => r.payloadId === null)).toEqual([]);
    expect(
      [rows[0]!, rows[449]!].map((r) => [
        r.payloadId,
        r.toolNameLower,
        r.parentToolUseId,
        r.callId,
      ]),
    ).toEqual([
      ['toolu_0', 'read', 'toolu_parent', 'call-1'],
      ['toolu_449', 'read', null, 'call-1'],
    ]);
    expect(await new ItemDao(orm.em.fork()).payloadRefsStamped('run-old')).toBe(
      true,
    );
  });

  it('adds the run column with no default, so every run that predates it reads as unstamped', async () => {
    const ddl = await orm.schema.getCreateSchemaSQL();
    const column = /`payload_refs_version`[^,)]*/.exec(ddl)?.[0];

    expect(column).toBeDefined();
    expect(column).not.toMatch(/default/i);
  });

  it('leaves a run already stamped under the current rule alone', async () => {
    await run('run-new', PAYLOAD_REFS_VERSION);
    await legacyRows('run-new', 3);

    await sweep();

    const rows = await orm.em.fork().find(Item, { runId: 'run-new' });
    expect(rows.map((r) => r.payloadId)).toEqual([null, null, null]);
  });

  it('restamps a run stamped under another rule version', async () => {
    await run('run-stale', PAYLOAD_REFS_VERSION - 1);
    await legacyRows('run-stale', 2);
    expect(
      await new ItemDao(orm.em.fork()).payloadRefsStamped('run-stale'),
    ).toBe(false);

    await sweep();

    const rows = await orm.em
      .fork()
      .find(Item, { runId: 'run-stale' }, { orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.payloadId)).toEqual(['toolu_0', 'toolu_1']);
    expect(
      await new ItemDao(orm.em.fork()).payloadRefsStamped('run-stale'),
    ).toBe(true);
  });

  it('stamps every other run when one run’s rows cannot be read, and says which', async () => {
    await run('run-broken', null);
    await run('run-fine', null);
    await legacyRows('run-fine', 2);
    const em = orm.em.fork() as EntityManager;
    const items = new ItemDao(em);
    const read = items.payloadRefsBatch.bind(items);
    vi.spyOn(items, 'payloadRefsBatch').mockImplementation((runId, ...rest) =>
      runId === 'run-broken'
        ? Promise.reject(new Error('database is locked'))
        : read(runId, ...rest),
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await new PayloadRefsSweepService(
      items,
      new RunDao(em),
      em,
    ).sweepAllQuietly();

    expect(warn).toHaveBeenCalledWith(
      'could not stamp payload columns of run run-broken: database is locked',
    );
    expect(
      await new ItemDao(orm.em.fork()).payloadRefsStamped('run-fine'),
    ).toBe(true);
    expect(
      await new ItemDao(orm.em.fork()).payloadRefsStamped('run-broken'),
    ).toBe(false);
    warn.mockRestore();
  });

  it('stamps both rows of a seq two rows share, even when a batch ends between them', async () => {
    await run('run-dup', null);
    const at = new Date(Date.UTC(2026, 9, 27));
    await orm.em.fork().insertMany(
      Item,
      ['dup-a', 'dup-b'].map((id) => ({
        id,
        runId: 'run-dup',
        seq: 0,
        kind: 'tool_call' as const,
        role: 'assistant',
        payload: JSON.stringify({ id: `toolu_${id}`, name: 'Read' }),
        createdAt: at,
        updatedAt: at,
      })),
    );
    const em = orm.em.fork() as EntityManager;
    const items = new ItemDao(em);
    const read = items.payloadRefsBatch.bind(items);
    vi.spyOn(items, 'payloadRefsBatch').mockImplementation(
      (runId, after, _limit, txEm) => read(runId, after, 1, txEm),
    );

    await new PayloadRefsSweepService(
      items,
      new RunDao(em),
      em,
    ).sweepAllQuietly();

    const rows = await orm.em
      .fork()
      .find(Item, { runId: 'run-dup' }, { orderBy: { id: 'asc' } });
    expect(rows.map((r) => r.payloadId)).toEqual([
      'toolu_dup-a',
      'toolu_dup-b',
    ]);
  });

  it('rewrites no row whose columns already hold what its payload says', async () => {
    await run('run-current', null);
    await new ItemDao(orm.em.fork()).create({
      runId: 'run-current',
      seq: 0,
      kind: 'tool_call',
      payload: JSON.stringify({ id: 'toolu_1', name: 'Read' }),
    });
    const em = orm.em.fork() as EntityManager;
    const items = new ItemDao(em);
    const write = vi.spyOn(items, 'rememberPayloadRefs');

    await new PayloadRefsSweepService(
      items,
      new RunDao(em),
      em,
    ).sweepAllQuietly();

    expect(write).not.toHaveBeenCalled();
    expect(
      await new ItemDao(orm.em.fork()).payloadRefsStamped('run-current'),
    ).toBe(true);
  });

  it('says so and stops when the runs to stamp cannot be listed', async () => {
    const em = orm.em.fork() as EntityManager;
    const runs = new RunDao(em);
    vi.spyOn(runs, 'listUnstampedPayloadRefs').mockRejectedValue(
      new Error('database is locked'),
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await new PayloadRefsSweepService(
      new ItemDao(em),
      runs,
      em,
    ).sweepAllQuietly();

    expect(warn).toHaveBeenCalledWith(
      'payload-column sweep could not list runs: database is locked',
    );
    warn.mockRestore();
  });
});
