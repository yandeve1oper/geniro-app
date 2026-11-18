import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { CallContext } from '../../runs/entity/call-context.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import {
  CALL_CONTEXT_SNAPSHOT_LIMIT,
  CallContextDao,
} from './call-context.dao';

/**
 * Real-driver DAO spec (see item.dao.spec for the harness rationale). What it
 * pins is the reason this table exists at all: a reading is keyed by CALL, so
 * two calls a member holds at once keep separate figures instead of overwriting
 * one row.
 *
 * `NodeState` is registered beside it because the DAO asks about the calling
 * member before it creates anything — see `rememberContext`.
 */
describe('CallContextDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: CallContextDao;

  /** The `node_state` row a real run seeds before any member executes. */
  async function seedNode(runId: string, memberId: string): Promise<void> {
    const em = orm.em.fork();
    em.create(
      NodeState,
      { runId, memberId, status: 'pending' },
      { partial: true },
    );
    await em.flush();
  }

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [CallContext, NodeState],
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
    dao = new CallContextDao(orm.em.fork());
    await seedNode('run-1', 'node-a');
    await seedNode('run-2', 'node-a');
  });

  it("creates the row on a call's first reading, there being no seed for one", async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runId: 'run-1',
      callId: 'call-1',
      memberId: 'node-a',
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
  });

  it('marks a stand-in count until a stated one or a compaction clears it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
      contextEstimated: true,
    });
    expect((await dao.listByRun('run-1'))[0]?.contextEstimated).toBe(true);

    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 5000,
      contextWindowTokens: null,
    });
    expect((await dao.listByRun('run-1'))[0]?.contextEstimated).toBeNull();

    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 6000,
      contextWindowTokens: null,
      contextEstimated: true,
    });
    await dao.forgetContext('run-1', 'call-1');
    expect((await dao.listByRun('run-1'))[0]).toMatchObject({
      contextTokens: null,
      contextEstimated: null,
    });
  });

  it('keeps one row per CALL when a single member holds several at once', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
    await dao.rememberContext('run-1', 'call-2', 'node-a', {
      contextTokens: 91000,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(2);
    expect(
      Object.fromEntries(rows.map((row) => [row.callId, row.contextTokens])),
    ).toEqual({ 'call-1': 4200, 'call-2': 91000 });
  });

  it('updates the existing row rather than adding a second for the same call', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 9100,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contextTokens).toBe(9100);
  });

  it('never clears a stored window with a reading that omits it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
    // A `context_progress` carries a count and no window — the shape that would
    // erase the denominator if the absent half were written as null.
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 5300,
      contextWindowTokens: null,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: 5300,
      contextWindowTokens: 200000,
    });
  });

  it('never clears a stored count with a reading that omits it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: null,
    });
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: null,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
  });

  it('stores no row at all for a reading whose every figure is non-positive', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 0,
      contextWindowTokens: 0,
    });

    expect(await dao.listByRun('run-1')).toHaveLength(0);
  });

  it('rejects a zero figure while storing the positive one beside it', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 0,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows[0]).toMatchObject({
      contextTokens: null,
      contextWindowTokens: 200000,
    });
  });

  it('keeps every session a call ran in, and creates the row ahead of any reading', async () => {
    await seedNode('run-1', 'callee');

    await dao.rememberSession('run-1', 'call-1', 'callee', 'sess-a');
    await dao.rememberSession('run-1', 'call-1', 'callee', 'sess-b');
    await dao.rememberSession('run-1', 'call-1', 'callee', 'sess-a');
    await dao.rememberContext('run-1', 'call-1', 'callee', {
      contextTokens: 10,
    });

    expect(await dao.sessionsByCall('run-1')).toEqual(
      new Map([['call-1', ['sess-a', 'sess-b']]]),
    );
    expect(await dao.listByRun('run-1')).toMatchObject([{ contextTokens: 10 }]);
  });

  it('leaves a call that named no session out of the sessions', async () => {
    await seedNode('run-1', 'callee');
    await dao.rememberContext('run-1', 'call-1', 'callee', {
      contextTokens: 10,
    });

    expect(await dao.sessionsByCall('run-1')).toEqual(new Map());
  });

  it('creates no session row for a member whose state row is already gone', async () => {
    await dao.rememberSession('run-1', 'call-1', 'ghost', 'sess-a');

    expect(await dao.sessionsByCall('run-1')).toEqual(new Map());
  });

  it('scopes the listing to one run', async () => {
    await dao.rememberContext('run-1', 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
    await dao.rememberContext('run-2', 'call-1', 'node-a', {
      contextTokens: 7300,
      contextWindowTokens: 200000,
    });

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.contextTokens).toBe(4200);
  });

  it('creates nothing for a member whose state row is already gone', async () => {
    // The straggler case: a run teardown destroys node states BEFORE call
    // contexts, so a reading arriving in that window would otherwise insert a
    // row that `getNodeStates` can never return — it maps over node states and
    // looks calls up beside them, so a call with no member is unreachable.
    await dao.rememberContext('run-1', 'call-1', 'node-torn-down', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });

    expect(await dao.listByRun('run-1')).toHaveLength(0);
  });

  it('still records a call on a member that DOES have a state row', async () => {
    // The other side of the guard, so a refusal that swallowed everything could
    // not pass the test above.
    await seedNode('run-1', 'node-b');
    await dao.rememberContext('run-1', 'call-1', 'node-b', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });

    expect(await dao.listByRun('run-1')).toHaveLength(1);
  });

  it('caps the snapshot at the newest calls, and returns them oldest-first', async () => {
    // Timestamps are written by hand rather than let the clock assign them:
    // hundreds of inserts land inside the same millisecond, and ordering on a
    // tie is undefined — which would make the assertion below flaky rather than
    // wrong. Distinct values make "which rows survive the cap" answerable.
    const em = orm.em.fork();
    const overflow = 20;
    for (let i = 0; i < CALL_CONTEXT_SNAPSHOT_LIMIT + overflow; i += 1) {
      em.create(
        CallContext,
        {
          runId: 'run-1',
          callId: `call-${String(i).padStart(4, '0')}`,
          memberId: 'node-a',
          contextTokens: 1000 + i,
          createdAt: new Date(1_000_000 + i * 1_000),
        },
        { partial: true },
      );
    }
    await em.flush();

    const rows = await dao.listByRun('run-1');
    expect(rows).toHaveLength(CALL_CONTEXT_SNAPSHOT_LIMIT);
    // The OLDEST are what fell off; the newest call is still the last element.
    expect(rows[0]!.callId).toBe(`call-${String(overflow).padStart(4, '0')}`);
    expect(rows.at(-1)!.callId).toBe(
      `call-${String(CALL_CONTEXT_SNAPSHOT_LIMIT + overflow - 1).padStart(4, '0')}`,
    );
  });
});
