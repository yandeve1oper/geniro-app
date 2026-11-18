import {
  defineConfig,
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
import { UsageActivity } from '../entity/usage-activity.entity';
import type { RunOutcomeLedgerRow } from '../stats.types';
import { threadFact } from '../utils/activity-facts';
import { UsageActivityDao } from './usage-activity.dao';

/** Every column the ledger specs read back. */
const ACTIVITY_FIELDS = [
  'kind',
  'runId',
  'lineKey',
  'occurredAt',
  'dedupKey',
  'linesAdded',
  'linesRemoved',
  'partial',
] as const;

/**
 * Real-driver DAO spec, on the same harness as `usage-event.dao.spec.ts`: MikroORM
 * boots on an in-memory better-sqlite3 database with the real entity and runs the
 * actual SQL. The unique index that refuses a second thread or pull request row is
 * exercised here rather than mirrored, and so is the half-open range the Stats page
 * reads.
 */
describe('UsageActivityDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageActivityDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [UsageActivity],
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
    dao = new UsageActivityDao(orm.em.fork());
  });

  const at = (iso: string): Date => new Date(iso);

  const pullRequest = (
    overrides: Partial<
      Parameters<UsageActivityDao['insertPullRequestOnce']>[0]
    > = {},
  ) => ({
    runId: 'run-a',
    owner: 'geniro-io',
    repo: 'geniro-app',
    number: 218,
    url: 'https://github.com/geniro-io/geniro-app/pull/218',
    occurredAt: at('2026-08-10T12:05:00.000Z'),
    ...overrides,
  });

  describe('the unique index on dedupKey', () => {
    it('refuses a second row for a key already recorded, even one written around the DAO', async () => {
      // The DAO's own lookup answers first, so the index is the only guard a racing
      // writer meets, and a row written directly has to meet it.
      await dao.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z'));

      await expect(
        orm.em
          .fork()
          .getRepository(UsageActivity)
          .insert({
            id: 'written-around-the-dao',
            kind: 'thread',
            runId: 'run-b',
            occurredAt: at('2026-08-11T09:00:00.000Z'),
            dedupKey: 'thread:run-a',
            createdAt: at('2026-08-11T09:00:00.000Z'),
            updatedAt: at('2026-08-11T09:00:00.000Z'),
          }),
      ).rejects.toThrow(/UNIQUE/i);
    });
  });

  describe('insertThreadOnce', () => {
    it('writes a thread once and refuses the same run again, keeping the first time', async () => {
      expect(
        await dao.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z')),
      ).toBe(true);
      expect(
        await dao.insertThreadOnce('run-a', at('2026-08-11T09:00:00.000Z')),
      ).toBe(false);

      const rows = await dao.getAll({ kind: 'thread' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'thread', runId: 'run-a' });
      expect(rows[0]?.occurredAt).toEqual(at('2026-08-10T12:00:00.000Z'));
    });

    it('answers a race the lookup missed as already recorded, rather than throwing', async () => {
      const em = orm.em.fork();
      const racing = new UsageActivityDao(em);
      await racing.insertThreadOnce('run-a', at('2026-08-10T12:00:00.000Z'));
      // The lookup misses the row, as it would if another writer committed after it looked.
      const findOne = vi
        .spyOn(em.getRepository(UsageActivity), 'findOne')
        .mockResolvedValueOnce(null);

      await expect(
        racing.insertThreadOnce('run-a', at('2026-08-11T09:00:00.000Z')),
      ).resolves.toBe(false);
      expect(findOne).toHaveBeenCalledTimes(1);
      findOne.mockRestore();
    });
  });

  describe('insertPullRequestOnce', () => {
    it('writes a pull request once per thread and identity', async () => {
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(true);
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(false);

      const rows = await dao.getAll({ kind: 'pull_request' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        prOwner: 'geniro-io',
        prRepo: 'geniro-app',
        prNumber: 218,
        prUrl: 'https://github.com/geniro-io/geniro-app/pull/218',
      });
    });

    it('keeps a second pull request of the same thread, and the same number in another thread', async () => {
      expect(await dao.insertPullRequestOnce(pullRequest())).toBe(true);
      expect(
        await dao.insertPullRequestOnce(
          pullRequest({
            number: 219,
            url: 'https://github.com/geniro-io/geniro-app/pull/219',
          }),
        ),
      ).toBe(true);
      expect(
        await dao.insertPullRequestOnce(pullRequest({ runId: 'run-b' })),
      ).toBe(true);
      expect(await dao.getAll({ kind: 'pull_request' })).toHaveLength(3);
    });
  });

  describe('insertMissing', () => {
    it('writes only the facts the ledger does not hold, and counts them by kind', async () => {
      await dao.insertThreadOnce('run-a', at('2026-08-10T09:00:00Z'));

      const written = await dao.insertMissing([
        threadFact('run-a', at('2026-08-10T09:00:00Z')),
        threadFact('run-b', at('2026-08-10T10:00:00Z')),
      ]);

      expect(written).toEqual({ thread: 1, pull_request: 0 });
    });

    it('counts a fact another writer recorded between the read and the write as already recorded', async () => {
      // The read finds nothing, then a concurrent writer takes the key: the unique index
      // refuses the second insert, and the sweep carries on rather than failing.
      const repo = (
        dao as unknown as { getRepo(): { find: (...args: never[]) => unknown } }
      ).getRepo();
      const read = vi.spyOn(repo, 'find').mockResolvedValueOnce([] as never);
      await dao.insertThreadOnce('run-a', at('2026-08-10T09:00:00Z'));

      const written = await dao.insertMissing([
        threadFact('run-a', at('2026-08-10T09:00:00Z')),
        threadFact('run-b', at('2026-08-10T10:00:00Z')),
      ]);

      expect(written).toEqual({ thread: 1, pull_request: 0 });
      // The read the sweep made is the one that missed the row, so the insert was refused.
      expect(read).toHaveBeenCalledTimes(1);
    });
  });

  describe('insertLineSnapshot', () => {
    it('keeps every snapshot of a thread and round-trips its figures, including the partial flag', async () => {
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-10T12:00:00.000Z'),
        linesAdded: 10,
        linesRemoved: 2,
        partial: false,
      });
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-10T13:00:00.000Z'),
        linesAdded: 25,
        linesRemoved: 4,
        partial: true,
      });

      const rows = await dao.inRange(
        'lines',
        at('2026-08-10T00:00:00.000Z'),
        at('2026-08-11T00:00:00.000Z'),
        ACTIVITY_FIELDS,
      );
      expect(
        rows.map((row) => [row.linesAdded, row.linesRemoved, row.partial]),
      ).toEqual([
        [10, 2, false],
        [25, 4, true],
      ]);
    });
  });

  describe('inRange', () => {
    it('answers a half-open range of one kind, oldest first', async () => {
      await dao.insertThreadOnce('run-late', at('2026-08-12T00:00:00.000Z'));
      await dao.insertThreadOnce('run-later', at('2026-08-10T18:00:00.000Z'));
      await dao.insertThreadOnce('run-start', at('2026-08-10T00:00:00.000Z'));
      await dao.insertThreadOnce('run-end', at('2026-08-11T00:00:00.000Z'));
      await dao.insertPullRequestOnce(
        pullRequest({ occurredAt: at('2026-08-10T06:00:00.000Z') }),
      );

      const rows = await dao.inRange(
        'thread',
        at('2026-08-10T00:00:00.000Z'),
        at('2026-08-11T00:00:00.000Z'),
        ACTIVITY_FIELDS,
      );
      // `from` is inclusive, `to` is exclusive, and the pull request is another kind.
      expect(rows.map((row) => row.runId)).toEqual(['run-start', 'run-later']);
    });
  });

  describe('earliestOccurredAt', () => {
    it('answers the earliest row of the kinds asked for, and null when there is none', async () => {
      expect(
        await dao.earliestOccurredAt(['thread', 'pull_request']),
      ).toBeNull();

      await dao.insertThreadOnce('run-a', at('2026-08-05T12:00:00.000Z'));
      await dao.insertPullRequestOnce(
        pullRequest({ occurredAt: at('2026-08-06T12:00:00.000Z') }),
      );

      expect(await dao.earliestOccurredAt(['thread', 'pull_request'])).toEqual(
        at('2026-08-05T12:00:00.000Z'),
      );
    });

    it('answers only the kinds it is asked for, so a lines snapshot cannot answer the floor', async () => {
      await dao.insertThreadOnce('run-a', at('2026-08-05T12:00:00.000Z'));
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-02T09:00:00.000Z'),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });

      expect(await dao.earliestOccurredAt(['thread', 'pull_request'])).toEqual(
        at('2026-08-05T12:00:00.000Z'),
      );
    });
  });

  describe('peakLinesBefore', () => {
    it("returns each thread's highest total before the period starts, per count", async () => {
      const period = at('2026-08-11T00:00:00.000Z');
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-10T12:00:00.000Z'),
        linesAdded: 10,
        linesRemoved: 1,
        partial: false,
      });
      // A dip after the peak is not the baseline: growth is counted past the peak.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-10T18:00:00.000Z'),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });
      // A snapshot exactly at the period's start belongs to the period, not its baseline.
      await dao.insertLineSnapshot({
        runId: 'run-d',
        lineKey: null,
        occurredAt: period,
        linesAdded: 7,
        linesRemoved: 0,
        partial: false,
      });
      await dao.insertLineSnapshot({
        runId: 'run-b',
        lineKey: null,
        occurredAt: at('2026-08-11T09:00:00.000Z'),
        linesAdded: 5,
        linesRemoved: 0,
        partial: false,
      });
      // An earlier, smaller snapshot of the same thread is below its peak.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-09T12:00:00.000Z'),
        linesAdded: 3,
        linesRemoved: 0,
        partial: false,
      });

      // The highest REMOVED count sits on a different snapshot from the highest added one, so a peak
      // taken from a single row for both counts cannot pass.
      await dao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: at('2026-08-10T20:00:00.000Z'),
        linesAdded: 6,
        linesRemoved: 3,
        partial: false,
      });
      const peaks = await dao.peakLinesBefore(
        [
          { runId: 'run-a', lineKey: null },
          { runId: 'run-b', lineKey: null },
          { runId: 'run-c', lineKey: null },
          { runId: 'run-d', lineKey: null },
        ],
        period,
      );
      expect(peaks.get('run:run-a')).toEqual({
        linesAdded: 10,
        linesRemoved: 3,
      });
      expect(peaks.has('run:run-b')).toBe(false);
      expect(peaks.has('run:run-c')).toBe(false);
      expect(peaks.has('run:run-d')).toBe(false);
    });

    it('leaves a snapshot with either count unmeasured out whole, rather than counting its other half', async () => {
      // The insert path never writes a null count, so a row like this is written around the DAO —
      // the same way the unique index is probed above. Its 99 must not become run-x's baseline.
      await orm.em
        .fork()
        .getRepository(UsageActivity)
        .insert({
          id: 'unmeasured-half',
          kind: 'lines',
          runId: 'run-x',
          occurredAt: at('2026-08-10T12:00:00.000Z'),
          dedupKey: 'lines:unmeasured-half',
          linesAdded: 99,
          linesRemoved: null,
          partial: false,
          createdAt: at('2026-08-10T12:00:00.000Z'),
          updatedAt: at('2026-08-10T12:00:00.000Z'),
        });
      // The mirror case: the added count is unmeasured, and the removed count must not stand alone either.
      await orm.em
        .fork()
        .getRepository(UsageActivity)
        .insert({
          id: 'unmeasured-added',
          kind: 'lines',
          runId: 'run-x',
          occurredAt: at('2026-08-10T11:00:00.000Z'),
          dedupKey: 'lines:unmeasured-added',
          linesAdded: null,
          linesRemoved: 77,
          partial: false,
          createdAt: at('2026-08-10T11:00:00.000Z'),
          updatedAt: at('2026-08-10T11:00:00.000Z'),
        });
      await dao.insertLineSnapshot({
        runId: 'run-x',
        lineKey: null,
        occurredAt: at('2026-08-10T13:00:00.000Z'),
        linesAdded: 6,
        linesRemoved: 2,
        partial: false,
      });

      const peaks = await dao.peakLinesBefore(
        [{ runId: 'run-x', lineKey: null }],
        at('2026-08-11T00:00:00.000Z'),
      );
      expect(peaks.get('run:run-x')).toEqual({
        linesAdded: 6,
        linesRemoved: 2,
      });
    });

    it('takes a series’ peak across every thread that measured it, and keeps a row with no key its thread’s own', async () => {
      const period = at('2026-08-11T00:00:00.000Z');
      for (const [runId, lineKey, linesAdded] of [
        ['run-a', 'folder', 40],
        ['run-b', 'folder', 55],
        ['run-c', null, 12],
        ['run-c', 'other', 99],
      ] as const) {
        await dao.insertLineSnapshot({
          runId,
          lineKey,
          occurredAt: at('2026-08-10T12:00:00.000Z'),
          linesAdded,
          linesRemoved: 1,
          partial: false,
        });
      }

      const peaks = await dao.peakLinesBefore(
        [
          { runId: 'run-a', lineKey: 'folder' },
          { runId: 'run-c', lineKey: null },
        ],
        period,
      );

      expect([...peaks.entries()].sort()).toEqual([
        ['folder', { linesAdded: 55, linesRemoved: 1 }],
        ['run:run-c', { linesAdded: 12, linesRemoved: 1 }],
      ]);
    });

    it('reads every thread in one statement, not one per thread', async () => {
      const em = orm.em.fork();
      const reader = new UsageActivityDao(em);
      // Every statement is compiled by the native database, whichever builder wrote it, so a
      // statement per thread would show here as one call per thread however the rows were fetched.
      const prepare = vi.spyOn(
        await em.getConnection().getNativeClient(),
        'prepare',
      );

      await reader.peakLinesBefore(
        [
          { runId: 'run-a', lineKey: null },
          { runId: 'run-b', lineKey: null },
          { runId: 'run-c', lineKey: null },
          { runId: 'run-d', lineKey: null },
        ],
        at('2026-08-11T00:00:00.000Z'),
      );

      expect(prepare).toHaveBeenCalledTimes(1);
      prepare.mockRestore();
    });
  });
  describe('upsertRunOutcome / runOutcomes', () => {
    const outcome = (
      overrides: Partial<RunOutcomeLedgerRow> = {},
    ): RunOutcomeLedgerRow => ({
      runId: 'run-1',
      sourceSeq: 10,
      occurredAt: at('2026-10-20T10:00:00.000Z'),
      teamSlug: 'dev-team',
      prOwner: 'acme',
      prRepo: 'platform',
      prNumber: 87,
      prUrl: 'https://github.com/acme/platform/pull/87',
      draft: true,
      reviewRounds: 0,
      acceptance: 'not_yet',
      questionsAsked: 1,
      changesRequestedRounds: 0,
      msToAccepted: null,
      ...overrides,
    });

    it('writes one row per run and pull request, and reads it back whole', async () => {
      await dao.upsertRunOutcome(outcome());

      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toEqual([outcome()]);
      expect(await orm.em.fork().count(UsageActivity, {})).toBe(1);
    });

    it('moves the row forward to a newer outcome, keeping one row', async () => {
      await dao.upsertRunOutcome(outcome());
      await dao.upsertRunOutcome(
        outcome({
          sourceSeq: 20,
          occurredAt: at('2026-10-20T11:00:00.000Z'),
          draft: false,
          reviewRounds: 2,
          acceptance: 'accepted',
          questionsAsked: 3,
        }),
      );

      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toEqual([
        outcome({
          sourceSeq: 20,
          occurredAt: at('2026-10-20T11:00:00.000Z'),
          draft: false,
          reviewRounds: 2,
          acceptance: 'accepted',
          questionsAsked: 3,
        }),
      ]);
      expect(await orm.em.fork().count(UsageActivity, {})).toBe(1);
    });

    it('keeps one row for one pull request written in two cases', async () => {
      await dao.upsertRunOutcome(outcome());
      await dao.upsertRunOutcome(
        outcome({ sourceSeq: 20, prOwner: 'ACME', prRepo: 'Platform' }),
      );

      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toMatchObject([
        { sourceSeq: 20 },
      ]);
    });

    it('rewrites a row at the same outcome only to fill history figures it lacks', async () => {
      await dao.upsertRunOutcome(
        outcome({ changesRequestedRounds: null, questionsAsked: 0 }),
      );
      expect(
        (await dao.runOutcomeCopies()).get('outcome:run-1:acme/platform#87'),
      ).toEqual({ sourceSeq: 10, counted: false });

      await dao.upsertRunOutcome(
        outcome({
          changesRequestedRounds: 2,
          msToAccepted: 5_000,
          questionsAsked: 4,
        }),
      );
      await dao.upsertRunOutcome(outcome({ changesRequestedRounds: 9 }));

      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toMatchObject([
        { changesRequestedRounds: 2, msToAccepted: 5_000, questionsAsked: 4 },
      ]);
    });

    it('never moves the row back to an older outcome that arrives late', async () => {
      await dao.upsertRunOutcome(
        outcome({ sourceSeq: 20, acceptance: 'accepted' }),
      );
      await dao.upsertRunOutcome(outcome({ sourceSeq: 10 }));

      expect(await dao.runOutcomes({ runIds: ['run-1'] })).toMatchObject([
        { sourceSeq: 20, acceptance: 'accepted' },
      ]);
    });

    it("keeps another pull request's and another run's outcome apart, and filters by team", async () => {
      await dao.upsertRunOutcome(outcome());
      await dao.upsertRunOutcome(outcome({ prNumber: 88, sourceSeq: 11 }));
      await dao.upsertRunOutcome(
        outcome({ runId: 'run-2', teamSlug: 'dev-team-b' }),
      );

      expect(
        (await dao.runOutcomes({ teamSlug: 'dev-team' })).map(
          (row) => `${row.runId}#${row.prNumber}`,
        ),
      ).toEqual(['run-1#87', 'run-1#88']);
      expect(
        (await dao.runOutcomes({ runIds: ['run-2'] })).map(
          (row) => row.teamSlug,
        ),
      ).toEqual(['dev-team-b']);
      expect(await dao.runOutcomes({ runIds: [] })).toEqual([]);
      expect(await dao.runOutcomeCopies()).toEqual(
        new Map([
          ['outcome:run-1:acme/platform#87', { sourceSeq: 10, counted: true }],
          ['outcome:run-1:acme/platform#88', { sourceSeq: 11, counted: true }],
          ['outcome:run-2:acme/platform#87', { sourceSeq: 10, counted: true }],
        ]),
      );
    });

    it('is not counted as a thread or a pull request by the Stats reads', async () => {
      await dao.upsertRunOutcome(outcome());

      expect(
        await dao.inRange(
          'pull_request',
          at('2026-10-01T00:00:00.000Z'),
          at('2026-11-01T00:00:00.000Z'),
          ['kind'],
        ),
      ).toEqual([]);
      expect(
        await dao.earliestOccurredAt(['thread', 'pull_request']),
      ).toBeNull();
    });
  });

  describe('the team ledger stamps', () => {
    const created = at('2026-10-01T10:00:00.000Z');
    const version = {
      slug: 'dev-team',
      version: 'abcdef0123456789',
      inferred: false,
    };

    it('writes the thread row when the recorder has not yet, then stamps it', async () => {
      await dao.stampThreadVersion('run-1', created, version);

      const rows = await dao.threadRowsBySlug('dev-team');
      expect(rows).toEqual([
        {
          runId: 'run-1',
          occurredAt: created,
          slug: 'dev-team',
          version: 'abcdef0123456789',
          inferred: false,
          metrics: false,
        },
      ]);
      expect(await orm.em.fork().count(UsageActivity, {})).toBe(1);
    });

    it('stamps the row the recorder already wrote, keeping it single', async () => {
      await dao.insertThreadOnce('run-1', created);
      await dao.stampThreadVersion('run-1', created, version);

      expect(await orm.em.fork().count(UsageActivity, {})).toBe(1);
      expect((await dao.threadRowsBySlug('dev-team'))[0]?.version).toBe(
        'abcdef0123456789',
      );
    });

    it('reads every asked run that has a row, and none that has not', async () => {
      await dao.stampThreadVersion('run-1', created, version);

      const rows = await dao.threadRowsByRuns(['run-1', 'run-gone']);
      expect([...rows.keys()]).toEqual(['run-1']);
    });

    it('lists only thread rows of the asked team', async () => {
      await dao.stampThreadVersion('run-1', created, version);
      await dao.stampThreadVersion('run-2', created, {
        ...version,
        slug: 'other',
      });
      await dao.insertThreadOnce('chat-1', created);
      // A run_outcome row of the same run carries the same team slug.
      await dao.upsertRunOutcome({
        runId: 'run-1',
        sourceSeq: 10,
        occurredAt: created,
        teamSlug: 'dev-team',
        prOwner: 'acme',
        prRepo: 'platform',
        prNumber: 87,
        prUrl: 'https://github.com/acme/platform/pull/87',
        draft: false,
        reviewRounds: 1,
        acceptance: 'accepted',
        questionsAsked: 0,
        changesRequestedRounds: 0,
        msToAccepted: 0,
      });

      expect(
        (await dao.threadRowsBySlug('dev-team')).map((row) => row.runId),
      ).toEqual(['run-1']);
      expect(
        (await dao.threadRowsByRuns(['run-1'])).get('run-1'),
      ).toMatchObject({ version: 'abcdef0123456789' });
    });
  });
});
