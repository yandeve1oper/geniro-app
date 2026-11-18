import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ, type UsageEventInput } from '../stats.types';
import { UsageEventDao } from './usage-event.dao';

/**
 * Real-driver DAO spec, mirroring `item.dao.spec.ts`: the aggregation service's
 * own spec runs an in-memory fake that only MIRRORS these queries, so this suite
 * boots MikroORM on an in-memory better-sqlite3 database with the real entity
 * and executes the actual SQL — the half-open range, the projections, and the
 * unique index that is the ledger's last line of defence against counting a
 * turn's spend twice.
 */
describe('UsageEventDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [UsageEvent],
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
    dao = new UsageEventDao(orm.em.fork());
  });

  function input(overrides: Partial<UsageEventInput> = {}): UsageEventInput {
    return {
      runId: 'run-a',
      memberId: null,
      seq: 0,
      occurredAt: new Date('2026-08-10T12:00:00.000Z'),
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      teamName: null,
      costUsd: 0.25,
      estimatedCostUsd: null,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
      thinkingTokens: 5,
      durationMs: 4_000,
      apiMs: 3_000,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      ...overrides,
    };
  }

  describe('recordOnce', () => {
    it('writes the turn and round-trips every figure', async () => {
      expect(await dao.recordOnce(input())).toBe(true);

      const rows = await dao.getAll({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: 'run-a',
        memberId: null,
        seq: 0,
        agentKind: 'claude',
        model: 'claude-opus-5',
        cwd: '/work/project',
        teamName: null,
        costUsd: 0.25,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 50,
        cacheCreationTokens: 10,
        thinkingTokens: 5,
        durationMs: 4_000,
        apiMs: 3_000,
      });
      expect(rows[0]!.occurredAt.toISOString()).toBe(
        '2026-08-10T12:00:00.000Z',
      );
    });

    it('round-trips the part of the cost geniro priced itself', async () => {
      await dao.recordOnce(input({ costUsd: 0.25, estimatedCostUsd: 0.25 }));

      const [row] = await dao.getAll({});
      expect(row!.estimatedCostUsd).toBe(0.25);
    });

    it('keeps a null figure null — never coerced to zero', async () => {
      // The cursor-agent shape: tokens reported, everything else not measured.
      await dao.recordOnce(
        input({
          agentKind: 'cursor-agent',
          costUsd: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          durationMs: null,
          apiMs: null,
        }),
      );

      const [row] = await dao.getAll({});
      expect(row!.costUsd).toBeNull();
      expect(row!.cacheReadTokens).toBeNull();
      expect(row!.thinkingTokens).toBeNull();
      expect(row!.durationMs).toBeNull();
      expect(row!.apiMs).toBeNull();
    });

    it('refuses a turn it already holds, and reports that it wrote nothing', async () => {
      expect(await dao.recordOnce(input({ seq: 3 }))).toBe(true);
      // A re-record of the SAME turn carrying a different cost — the shape a
      // backfill re-run produces. It must neither add a row nor overwrite one.
      expect(await dao.recordOnce(input({ seq: 3, costUsd: 99 }))).toBe(false);

      const rows = await dao.getAll({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.costUsd).toBe(0.25);
    });

    it('scopes the idempotency key to the run — same seq in another run is a different turn', async () => {
      await dao.recordOnce(input({ runId: 'run-a', seq: 0 }));

      expect(await dao.recordOnce(input({ runId: 'run-b', seq: 0 }))).toBe(
        true,
      );
      expect(await dao.getAll({})).toHaveLength(2);
    });
  });

  it('has a database-level unique index behind the recordOnce check', async () => {
    // Driven through `create`, deliberately BYPASSING recordOnce's own read —
    // otherwise this would re-test the guard rather than the backstop under it,
    // and dropping @Unique from the entity would leave the suite green.
    await dao.create(input({ seq: 7 }));

    await expect(dao.create(input({ seq: 7 }))).rejects.toThrow();
  });

  describe('inRange', () => {
    it('is half-open — the lower bound is included, the upper excluded', async () => {
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-08-10T23:59:59.999Z') }),
      );
      await dao.recordOnce(
        input({ seq: 2, occurredAt: new Date('2026-08-11T00:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-11T00:00:00.000Z'),
      );

      // Without the half-open bound, consecutive periods would each claim the
      // midnight turn and every per-day total would count it twice.
      expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    });

    it('orders by when the turn happened, not by when the row was written', async () => {
      // The backfill's shape: rows inserted newest-first, carrying old
      // timestamps. `createdAt` ordering would return these reversed.
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-08-10T18:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T06:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        new Date('2026-08-10T00:00:00.000Z'),
        new Date('2026-08-11T00:00:00.000Z'),
      );

      expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    });

    it('answers an empty list for a period with no turns', async () => {
      await dao.recordOnce(input());

      expect(
        await dao.inRange(
          new Date('2026-01-01T00:00:00.000Z'),
          new Date('2026-01-02T00:00:00.000Z'),
        ),
      ).toEqual([]);
    });
  });

  describe('recordedKeys', () => {
    it('returns one composite key per recorded turn', async () => {
      await dao.recordOnce(input({ runId: 'run-a', seq: 0 }));
      await dao.recordOnce(input({ runId: 'run-a', seq: 4 }));
      await dao.recordOnce(input({ runId: 'run-b', seq: 0 }));

      expect(await dao.recordedKeys()).toEqual(
        new Set(['run-a:0', 'run-a:4', 'run-b:0']),
      );
    });

    it('is empty on a fresh ledger', async () => {
      expect((await dao.recordedKeys()).size).toBe(0);
    });
  });

  describe('earliestOccurredAt', () => {
    it('answers the oldest turn the ledger holds', async () => {
      await dao.recordOnce(
        input({ seq: 0, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      );
      await dao.recordOnce(
        input({ seq: 1, occurredAt: new Date('2026-07-01T00:00:00.000Z') }),
      );

      expect((await dao.earliestOccurredAt())?.toISOString()).toBe(
        '2026-07-01T00:00:00.000Z',
      );
    });

    it('answers null when the ledger is empty', async () => {
      expect(await dao.earliestOccurredAt()).toBeNull();
    });
  });

  describe('recordPolledSpend', () => {
    /** One of a run's polled rows, as `polledSpendRows` hands them over. */
    const polled = (
      overrides: Partial<UsageEventInput> = {},
    ): UsageEventInput =>
      input({
        seq: POLLED_SPEND_SEQ,
        agentKind: 'cursor-agent',
        costUsd: 2.5,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        durationMs: null,
        apiMs: null,
        ...overrides,
      });

    it('REWRITES the run’s one polled row as the poll moves it, never appends', async () => {
      // The poll restates a RUNNING total. Appended like a turn, a run polled
      // three times would carry its bill three times over.
      expect(
        await dao.recordPolledSpend('run-a', [polled({ costUsd: 2.5 })]),
      ).toBe(true);
      expect(
        await dao.recordPolledSpend('run-a', [polled({ costUsd: 4 })]),
      ).toBe(true);

      const rows = await dao.getAll({ runId: 'run-a' });
      expect(rows.map((row) => [row.seq, row.costUsd])).toEqual([
        [POLLED_SPEND_SEQ, 4],
      ]);
    });

    it('answers false and writes nothing when the total has not moved', async () => {
      // What decides whether an open Stats page is told to re-read.
      await dao.recordPolledSpend('run-a', [polled()]);

      expect(await dao.recordPolledSpend('run-a', [polled()])).toBe(false);
    });

    it('re-dates the row when only the run’s last activity moved', async () => {
      await dao.recordPolledSpend('run-a', [polled()]);
      const later = new Date('2026-08-12T08:00:00.000Z');

      expect(
        await dao.recordPolledSpend('run-a', [polled({ occurredAt: later })]),
      ).toBe(true);
      expect((await dao.getAll({}))[0]!.occurredAt.toISOString()).toBe(
        later.toISOString(),
      );
    });

    it('files under the polled key whatever seq it was handed, beside the run’s turns', async () => {
      // A polled row filed under a turn's seq would be read as that turn — and
      // would collide with the real one on the unique index.
      await dao.recordOnce(input({ seq: 0 }));

      await dao.recordPolledSpend('run-a', [polled({ seq: 0 })]);

      const rows = await dao.getAll({ runId: 'run-a' });
      expect(rows.map((row) => row.seq).sort((a, b) => a - b)).toEqual([
        POLLED_SPEND_SEQ,
        0,
      ]);
    });

    it('REPLACES the run’s whole set of day-and-model rows, deleting a bucket that is gone', async () => {
      // A bill split per day and model is a SET of rows; an update that only
      // upserted would leave yesterday's guess standing beside today's figure.
      await dao.recordPolledSpend('run-a', [
        polled({ seq: POLLED_SPEND_SEQ, model: 'grok-4.7', costUsd: 3 }),
        polled({ seq: POLLED_SPEND_SEQ - 1, model: 'kimi-k3', costUsd: 1 }),
      ]);

      expect(
        await dao.recordPolledSpend('run-a', [
          polled({ seq: POLLED_SPEND_SEQ, model: 'grok-4.7', costUsd: 5 }),
        ]),
      ).toBe(true);

      const rows = await dao.getAll({ runId: 'run-a' });
      expect(rows.map((row) => [row.seq, row.model, row.costUsd])).toEqual([
        [POLLED_SPEND_SEQ, 'grok-4.7', 5],
      ]);
    });

    it('reads every row at or below the polled key as the run’s polled spend', async () => {
      await dao.recordPolledSpend('run-a', [
        polled({ seq: POLLED_SPEND_SEQ }),
        polled({ seq: POLLED_SPEND_SEQ - 1, model: 'kimi-k3' }),
      ]);
      await dao.recordOnce(input({ seq: 2 }));

      const held = await dao.polledSpendRows(['run-a']);
      expect(
        (held.get('run-a') ?? []).map((row) => row.seq).sort((a, b) => b - a),
      ).toEqual([POLLED_SPEND_SEQ, POLLED_SPEND_SEQ - 1]);
    });
  });

  describe('latestOccurredAt', () => {
    it('is the newest TURN — a polled row dated later does not move it', async () => {
      // The turn sweep's high-water mark answers which transcript rows the
      // ledger can already hold. A polled row is dated by its run's activity,
      // not by any transcript row, so letting it set the mark could only move
      // the sweep past a turn it never recorded.
      await dao.recordOnce(
        input({ seq: 3, occurredAt: new Date('2026-08-10T00:00:00.000Z') }),
      );
      await dao.recordPolledSpend('run-a', [
        input({
          seq: POLLED_SPEND_SEQ,
          occurredAt: new Date('2026-08-20T00:00:00.000Z'),
        }),
      ]);

      expect((await dao.latestOccurredAt())?.toISOString()).toBe(
        '2026-08-10T00:00:00.000Z',
      );
    });
  });

  describe('the model a turn REPORTED', () => {
    it('answers the newest reported model of one CLI’s turns on a run', async () => {
      await dao.recordOnce(
        input({
          seq: 1,
          agentKind: 'cursor-agent',
          model: 'grok-4.7',
          occurredAt: new Date('2026-08-10T10:00:00.000Z'),
        }),
      );
      await dao.recordOnce(
        input({
          seq: 2,
          agentKind: 'cursor-agent',
          model: 'kimi-k3',
          occurredAt: new Date('2026-08-10T11:00:00.000Z'),
        }),
      );
      await dao.recordOnce(
        input({
          seq: 3,
          agentKind: 'claude',
          model: 'claude-opus-5-5',
          occurredAt: new Date('2026-08-10T12:00:00.000Z'),
        }),
      );

      expect(await dao.latestReportedModel('run-a', 'cursor-agent')).toBe(
        'kimi-k3',
      );
      expect(await dao.latestReportedModel('run-a', null)).toBeNull();
    });
  });
});
