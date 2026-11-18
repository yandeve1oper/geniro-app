import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException, NotFoundException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { GoalDao } from '../../agents/dao/goal.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { Goal } from '../../runs/entity/goal.entity';
import { Run } from '../../runs/entity/run.entity';
import { LineBaselineDao } from '../dao/line-baseline.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { LineBaseline } from '../entity/line-baseline.entity';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import {
  POLLED_SPEND_SEQ,
  type UsageEventInput,
  type UsageRecordedEvent,
} from '../stats.types';
import { StatsService } from './stats.service';
import { UsageEventBus } from './usage-events.bus';

/**
 * The threads' activity on the Stats page, end to end: the real ledger and activity
 * tables and the real fold, on an in-memory database. The day a fact is filed under is
 * a property of the SQL range and the local-day arithmetic working together, so the
 * assertions read the figures the page would show.
 *
 * Every date is built in local time, which is how the fold files a fact: a test that
 * named a UTC instant would pass or fail depending on the machine's timezone.
 */

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

describe('StatsService — what the threads did (in-memory sqlite)', () => {
  let orm: MikroORM;
  let usageDao: UsageEventDao;
  let activityDao: UsageActivityDao;
  let service: StatsService;
  let bus: UsageEventBus;

  const day = (date: number, hour = 12): Date => new Date(2026, 7, date, hour);

  function turn(
    overrides: Pick<UsageEventInput, 'runId' | 'seq' | 'occurredAt'> &
      Partial<UsageEventInput>,
  ): UsageEventInput {
    return {
      memberId: null,
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      teamName: null,
      costUsd: 0.25,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: 4_000,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
      ...overrides,
    };
  }

  function statsWith(runDao: RunDao): StatsService {
    const em = orm.em.fork();
    return new StatsService(
      em,
      new UsageEventDao(em),
      new AgentAdapterRegistry([]),
      new ProjectRootsService(em),
      runDao,
      new UsageActivityDao(em),
      bus,
      new LineBaselineDao(em),
      new MetricLedgerDao(em),
      new GoalDao(em),
    );
  }

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [
          UsageActivity,
          UsageEvent,
          Run,
          LineBaseline,
          ToolCallEvent,
          Goal,
        ],
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
    const em = orm.em.fork();
    usageDao = new UsageEventDao(em);
    activityDao = new UsageActivityDao(em);
    bus = new UsageEventBus();
    service = statsWith(new RunDao(em));
    // The ledger's first turn is the page's lower bound, so every period below starts on or after it.
    await usageDao.recordOnce(
      turn({ runId: 'run-a', seq: 0, occurredAt: day(1, 9) }),
    );
  });

  const range = (from: number, to: number) => ({
    from: day(from, 0).toISOString(),
    to: day(to, 0).toISOString(),
  });

  describe('usage()', () => {
    it('counts the threads and pull requests created in the period, day by day', async () => {
      await activityDao.insertThreadOnce('run-a', day(10, 9));
      await activityDao.insertThreadOnce('run-b', day(10, 15));
      await activityDao.insertThreadOnce('run-c', day(11, 9));
      await activityDao.insertPullRequestOnce({
        runId: 'run-a',
        owner: 'geniro-io',
        repo: 'geniro-app',
        number: 218,
        url: 'https://github.com/geniro-io/geniro-app/pull/218',
        occurredAt: day(10, 10),
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({
        threadsCreated: 3,
        pullRequests: 1,
      });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({
        threadsCreated: 2,
        pullRequests: 1,
      });
      expect(byDate.get('2026-08-11')).toMatchObject({
        threadsCreated: 1,
        pullRequests: 0,
      });
    });

    it('sums the lines a thread added between its snapshots, filed on the day each was taken', async () => {
      // The snapshot before the period is the baseline, so the first in-period growth is
      // 15, not the whole 25.
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: day(9),
        linesAdded: 10,
        linesRemoved: 2,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: day(10, 9),
        linesAdded: 25,
        linesRemoved: 2,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: day(11, 9),
        linesAdded: 25,
        linesRemoved: 7,
        partial: false,
      });

      const stats = await service.usage(range(10, 13).from, range(10, 13).to);

      expect(stats.activity).toMatchObject({ linesAdded: 15, linesRemoved: 5 });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({
        linesAdded: 15,
        linesRemoved: 0,
      });
      // Measured with no growth: a real zero, not an unmeasured day.
      expect(byDate.get('2026-08-11')).toMatchObject({
        linesAdded: 0,
        linesRemoved: 5,
      });
      // Nothing measured on the quiet day: null, not zero.
      expect(byDate.get('2026-08-12')).toMatchObject({
        linesAdded: null,
        linesRemoved: null,
      });
    });

    it("measures a thread's first snapshot in the period whole when it has no baseline", async () => {
      await activityDao.insertLineSnapshot({
        runId: 'run-b',
        lineKey: null,
        occurredAt: day(10, 9),
        linesAdded: 40,
        linesRemoved: 3,
        partial: false,
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({ linesAdded: 40, linesRemoved: 3 });
    });

    it('adds nothing for a fall back, and flags a day and the period partial when a measurement was a lower bound', async () => {
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        lineKey: null,
        occurredAt: day(10, 9),
        linesAdded: 30,
        linesRemoved: 0,
        partial: true,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        lineKey: null,
        occurredAt: day(11, 9),
        linesAdded: 20,
        linesRemoved: 0,
        partial: false,
      });
      await activityDao.insertLineSnapshot({
        runId: 'run-c',
        lineKey: null,
        occurredAt: day(11, 15),
        linesAdded: 36,
        linesRemoved: 0,
        partial: false,
      });

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      // 30, then nothing for the fall back to 20, then 6 past the highest total, 30.
      expect(stats.activity).toMatchObject({
        linesAdded: 36,
        linesPartial: true,
      });
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));
      expect(byDate.get('2026-08-10')).toMatchObject({ linesPartial: true });
      expect(byDate.get('2026-08-11')).toMatchObject({
        linesAdded: 6,
        linesPartial: false,
      });
    });

    it('counts a thread created before the ledger’s first recorded turn, in the default range', async () => {
      // A thread is recorded when it is created, which can be before its first turn. With
      // no lower bound given, the range starts at the ledger's earliest row of either kind.
      await activityDao.insertThreadOnce('run-early', day(0, 15));

      const stats = await service.usage(undefined, day(12, 0).toISOString());

      expect(stats.activity).toMatchObject({ threadsCreated: 1 });
    });

    it('keeps the default floor on the earliest thread, whatever a lines snapshot is dated', async () => {
      // A snapshot is dated by the client, so only thread and pull-request rows may answer the
      // floor: a lines row dated before the thread must not stretch the default range.
      await activityDao.insertThreadOnce('run-a', day(0, 12));
      await activityDao.insertLineSnapshot({
        runId: 'run-a',
        lineKey: null,
        occurredAt: day(0, 2),
        linesAdded: 4,
        linesRemoved: 0,
        partial: false,
      });

      const stats = await service.usage(undefined, day(12, 0).toISOString());

      expect(stats.from).toBe(day(0, 12).toISOString());
    });

    it('averages each day’s working time over the threads that reported it that day', async () => {
      // Day ten: one thread at 100s of working time is 100s. Day eleven: two threads at
      // 30s each is 30s, not the period's average.
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 1,
          occurredAt: day(10, 9),
          durationMs: 60_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 2,
          occurredAt: day(10, 11),
          durationMs: 40_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-b',
          seq: 0,
          occurredAt: day(11, 9),
          durationMs: 30_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-c',
          seq: 0,
          occurredAt: day(11, 11),
          durationMs: 30_000,
        }),
      );

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);
      const byDate = new Map(stats.days.map((row) => [row.date, row.activity]));

      expect(byDate.get('2026-08-10')).toMatchObject({
        threadsWithWorkedTime: 1,
        avgWorkedMs: 100_000,
      });
      expect(byDate.get('2026-08-11')).toMatchObject({
        threadsWithWorkedTime: 2,
        avgWorkedMs: 30_000,
      });
    });

    it('counts the threads that were active, and averages working time over the ones that reported it', async () => {
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 1,
          occurredAt: day(10, 9),
          durationMs: 60_000,
        }),
      );
      await usageDao.recordOnce(
        turn({
          runId: 'run-a',
          seq: 2,
          occurredAt: day(10, 11),
          durationMs: 40_000,
        }),
      );
      // A cursor-like thread: its turns report no working time, so it is active but unmeasured.
      await usageDao.recordOnce(
        turn({
          runId: 'run-b',
          seq: 0,
          occurredAt: day(10, 13),
          durationMs: null,
        }),
      );
      // A polled-spend bill is not a turn, so it must not make its thread active.
      await usageDao.recordOnce(
        turn({
          runId: 'run-c',
          seq: POLLED_SPEND_SEQ,
          occurredAt: day(10, 15),
          costUsd: 2,
          durationMs: null,
        }),
      );

      const stats = await service.usage(range(10, 12).from, range(10, 12).to);

      expect(stats.activity).toMatchObject({
        activeThreads: 2,
        threadsWithWorkedTime: 1,
        avgWorkedMs: 100_000,
      });
    });
  });

  describe('recordLinesSnapshot()', () => {
    it('refuses a run that no longer exists, and writes nothing', async () => {
      const gone = statsWith({
        getOne: async () => null,
      } as unknown as RunDao);

      await expect(
        gone.recordLinesSnapshot({
          runId: 'gone',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(
        await activityDao.inRange(
          'lines',
          day(1, 0),
          day(30, 0),
          ACTIVITY_FIELDS,
        ),
      ).toHaveLength(0);
    });

    it('refuses a measurement dated before its thread existed, and writes nothing', async () => {
      const early = statsWith({
        getOne: async () => ({ id: 'run-a', createdAt: day(5, 0) }) as Run,
      } as unknown as RunDao);

      await expect(
        early.recordLinesSnapshot({
          runId: 'run-a',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
          occurredAt: day(4, 23).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await activityDao.inRange(
          'lines',
          day(1, 0),
          day(30, 0),
          ACTIVITY_FIELDS,
        ),
      ).toHaveLength(0);
    });

    it('refuses a measurement dated past the clock allowance, and writes nothing', async () => {
      const live = statsWith({
        getOne: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);
      const now = Date.now();

      await expect(
        live.recordLinesSnapshot({
          runId: 'run-a',
          linesAdded: 3,
          linesRemoved: 0,
          partial: false,
          occurredAt: new Date(now + 60 * 60_000).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await activityDao.inRange(
          'lines',
          new Date(now - 86_400_000),
          new Date(now + 2 * 86_400_000),
          ACTIVITY_FIELDS,
        ),
      ).toHaveLength(0);
    });

    it('takes the time as now when the caller names none, which is what the desktop app sends', async () => {
      const live = statsWith({
        getOne: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);
      const before = Date.now();

      await live.recordLinesSnapshot({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: false,
      });

      const after = Date.now();
      const rows = await activityDao.inRange(
        'lines',
        new Date(before - 1_000),
        new Date(after + 1_000),
        ACTIVITY_FIELDS,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(rows[0]?.occurredAt.getTime()).toBeLessThanOrEqual(after);
    });

    it('writes the measurement at the time it was taken, and announces it to the open page', async () => {
      const announced: UsageRecordedEvent[] = [];
      bus.all().subscribe((event) => announced.push(event));
      const live = statsWith({
        getOne: async () => ({ id: 'run-a', createdAt: day(1, 0) }) as Run,
      } as unknown as RunDao);

      await live.recordLinesSnapshot({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: true,
        occurredAt: day(10, 9).toISOString(),
      });

      const rows = await activityDao.inRange(
        'lines',
        day(10, 0),
        day(11, 0),
        ACTIVITY_FIELDS,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: 'run-a',
        linesAdded: 12,
        linesRemoved: 4,
        partial: true,
      });
      expect(announced).toEqual([
        {
          runId: 'run-a',
          memberId: null,
          occurredAt: day(10, 9).toISOString(),
          turn: false,
        },
      ]);
    });
  });

  describe('lineBaseline() and folder series', () => {
    const SHA_A = 'a'.repeat(40);
    const SHA_B = 'b'.repeat(40);
    const SHA_C = 'c'.repeat(40);

    /**
     * Threads by id, each with the folder and start commit a baseline is read off — written as
     * real rows and read through the real DAO, so the columns the service selects are the ones
     * it gets.
     */
    async function threads(
      rows: Record<string, { cwd: string | null; startSha: string | null }>,
    ): Promise<StatsService> {
      const em = orm.em.fork();
      for (const [id, row] of Object.entries(rows)) {
        em.persist(
          Object.assign(new Run(), {
            id,
            status: 'completed',
            createdAt: day(1, 0),
            ...row,
          }),
        );
      }
      await em.flush();
      return statsWith(new RunDao(orm.em.fork()));
    }

    it('sets a folder’s baseline from the first thread measured there, and hands it to every later thread on that branch', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/repo', startSha: SHA_B },
      });

      expect(
        await stats.lineBaseline({
          runId: 'run-a',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_A });
      // The second thread started at another commit, and still measures against the first one's.
      expect(
        await stats.lineBaseline({
          runId: 'run-b',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_A });
    });

    it('keeps a separate baseline per branch of one folder', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/repo', startSha: SHA_B },
      });

      await stats.lineBaseline({
        runId: 'run-a',
        root: '/repo',
        branch: 'main',
      });

      expect(
        await stats.lineBaseline({
          runId: 'run-b',
          root: '/repo',
          branch: 'feature',
        }),
      ).toEqual({ baseSha: SHA_B });
    });

    it('replaces a baseline reported stale with the measuring thread’s start, once', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/repo', startSha: SHA_B },
        'run-c': { cwd: '/repo', startSha: SHA_C },
      });
      await stats.lineBaseline({
        runId: 'run-a',
        root: '/repo',
        branch: 'main',
      });

      expect(
        await stats.lineBaseline({
          runId: 'run-b',
          root: '/repo',
          branch: 'main',
          staleBaseSha: SHA_A,
        }),
      ).toEqual({ baseSha: SHA_B });
      // A second thread reporting the same stale commit reads the replacement rather than
      // replacing it again with its own start.
      expect(
        await stats.lineBaseline({
          runId: 'run-c',
          root: '/repo',
          branch: 'main',
          staleBaseSha: SHA_A,
        }),
      ).toEqual({ baseSha: SHA_B });
    });

    it('answers no baseline when the stale commit is the thread’s own start, or the thread has no folder or start', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-nofolder': { cwd: null, startSha: SHA_B },
        'run-nostart': { cwd: '/other', startSha: null },
      });

      expect(
        await stats.lineBaseline({
          runId: 'run-a',
          root: '/repo',
          branch: 'main',
          staleBaseSha: SHA_A,
        }),
      ).toEqual({ baseSha: null });
      expect(
        await stats.lineBaseline({
          runId: 'run-nofolder',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: null });
      expect(
        await stats.lineBaseline({
          runId: 'run-nostart',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: null });
    });

    it('refuses a thread that does not exist', async () => {
      await expect(
        (await threads({})).lineBaseline({
          runId: 'run-gone',
          root: '/repo',
          branch: 'main',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('counts work two threads share in one folder once, where per-thread series counted it twice', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/repo', startSha: SHA_A },
      });
      // Both threads measured the same folder against its baseline: 50 lines, then 70.
      await stats.recordLinesSnapshot({
        runId: 'run-a',
        baseSha: SHA_A,
        branch: 'main',
        root: '/repo',
        linesAdded: 50,
        linesRemoved: 5,
        partial: false,
        occurredAt: day(10, 9).toISOString(),
      });
      await stats.recordLinesSnapshot({
        runId: 'run-b',
        baseSha: SHA_A,
        branch: 'main',
        root: '/repo',
        linesAdded: 70,
        linesRemoved: 5,
        partial: false,
        occurredAt: day(10, 11).toISOString(),
      });

      const usage = await stats.usage(range(10, 11).from, range(10, 11).to);

      expect(usage.activity).toMatchObject({
        linesAdded: 70,
        linesRemoved: 5,
      });
    });

    it('keeps a snapshot that names no baseline in its own thread’s series', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/repo', startSha: SHA_A },
      });
      for (const runId of ['run-a', 'run-b']) {
        await stats.recordLinesSnapshot({
          runId,
          linesAdded: 30,
          linesRemoved: 0,
          partial: false,
          occurredAt: day(10, 9).toISOString(),
        });
      }

      const rows = await activityDao.inRange(
        'lines',
        day(10, 0),
        day(11, 0),
        ACTIVITY_FIELDS,
      );
      expect(rows.map((row) => row.lineKey)).toEqual([null, null]);
      const usage = await stats.usage(range(10, 11).from, range(10, 11).to);
      expect(usage.activity).toMatchObject({ linesAdded: 60 });
    });
    it('files a thread in a subfolder under its repository, so the two threads share one series', async () => {
      // Both measure the whole repository; keyed by their own folders, one edit grew two
      // series and was counted twice.
      const stats = await threads({
        'run-root': { cwd: '/repo', startSha: SHA_A },
        'run-sub': { cwd: '/repo/apps/ui', startSha: SHA_B },
      });

      await stats.lineBaseline({
        runId: 'run-root',
        root: '/repo',
        branch: 'main',
      });

      expect(
        await stats.lineBaseline({
          runId: 'run-sub',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_A });
    });

    it('does not file a thread under a root that does not contain its folder, or under the filesystem root', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-b': { cwd: '/elsewhere', startSha: SHA_B },
        'run-c': { cwd: '/third', startSha: SHA_C },
      });
      await stats.lineBaseline({
        runId: 'run-a',
        root: '/repo',
        branch: 'main',
      });

      // Claiming the other thread's repository does not join its series.
      expect(
        await stats.lineBaseline({
          runId: 'run-b',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_B });
      // `/` contains every folder, and would put every thread in one series.
      await stats.lineBaseline({ runId: 'run-a', root: '/', branch: 'dev' });
      expect(
        await stats.lineBaseline({ runId: 'run-c', root: '/', branch: 'dev' }),
      ).toEqual({ baseSha: SHA_C });
    });

    it('counts work a subfolder thread and a root thread share once, filed under their repository', async () => {
      const stats = await threads({
        'run-root': { cwd: '/repo', startSha: SHA_A },
        'run-sub': { cwd: '/repo/apps/ui', startSha: SHA_A },
      });
      // Both measured the whole repository against its baseline: 50 lines, then 70.
      await stats.recordLinesSnapshot({
        runId: 'run-root',
        baseSha: SHA_A,
        branch: 'main',
        root: '/repo',
        linesAdded: 50,
        linesRemoved: 0,
        partial: false,
        occurredAt: day(10, 9).toISOString(),
      });
      await stats.recordLinesSnapshot({
        runId: 'run-sub',
        baseSha: SHA_A,
        branch: 'main',
        root: '/repo',
        linesAdded: 70,
        linesRemoved: 0,
        partial: false,
        occurredAt: day(10, 11).toISOString(),
      });

      const usage = await stats.usage(range(10, 11).from, range(10, 11).to);

      expect(usage.activity).toMatchObject({ linesAdded: 70 });
    });

    it('honours only a plain absolute root, and matches it to the folder without case', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
        'run-x': { cwd: '/repo/x', startSha: SHA_C },
        'run-slash': { cwd: '/repo/x', startSha: SHA_B },
        'run-case': { cwd: '/Repo/z', startSha: SHA_B },
      });
      await stats.lineBaseline({
        runId: 'run-a',
        root: '/repo',
        branch: 'main',
      });
      // A baseline kept under the folder `/repo/x` itself.
      await stats.lineBaseline({
        runId: 'run-x',
        root: '/repo/x',
        branch: 'main',
      });

      // A trailing separator would file one repository under a second key; it is not a
      // plain root, so the thread is filed under its own folder — whose baseline it reads —
      // rather than starting one of its own under `/repo/`.
      expect(
        await stats.lineBaseline({
          runId: 'run-slash',
          root: '/repo/',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_C });
      // A folder whose case differs from the root git printed is still inside it.
      expect(
        await stats.lineBaseline({
          runId: 'run-case',
          root: '/repo',
          branch: 'main',
        }),
      ).toEqual({ baseSha: SHA_A });
    });

    it('refuses a snapshot that names a baseline but not the repository it was measured in', async () => {
      const stats = await threads({
        'run-a': { cwd: '/repo', startSha: SHA_A },
      });

      await expect(
        stats.recordLinesSnapshot({
          runId: 'run-a',
          baseSha: SHA_A,
          branch: 'main',
          linesAdded: 1,
          linesRemoved: 0,
          partial: false,
          occurredAt: day(10, 9).toISOString(),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
