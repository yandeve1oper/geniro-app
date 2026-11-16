import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { RunStatus } from '../../runs/runs.types';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_SEGMENT_LEASE_MS,
  LESSON_SEGMENT_MAX_ATTEMPTS,
  type LessonSegmentCloser,
  type LessonSegmentStatus,
} from '../lessons.types';
import {
  LESSON_ARCHIVE_GRACE_MS,
  LessonAutoRunner,
} from './lesson-auto-runner.service';
import type { LessonCheckService } from './lesson-check.service';
import type { LessonReflectionService } from './lesson-reflection.service';
import type { LessonSegmentService } from './lesson-segment.service';
import { LessonsEventBus } from './lessons-events.bus';

const NOW = new Date('2026-06-01T12:00:00.000Z');

type SegmentSeed = {
  id: string;
  runId?: string;
  status?: LessonSegmentStatus;
  closedBy?: LessonSegmentCloser;
  closedAt?: Date;
  leaseUntil?: Date | null;
  reflectionRunId?: string | null;
  checkRunId?: string | null;
  attempts?: number;
};

function segmentOf(seed: SegmentSeed): LessonSegment {
  return {
    id: seed.id,
    runId: seed.runId ?? `run-${seed.id}`,
    status: seed.status ?? 'queued',
    closedBy: seed.closedBy ?? 'manual',
    closedAt: seed.closedAt ?? new Date(NOW.getTime() - 60_000),
    leaseUntil: seed.leaseUntil ?? null,
    reflectionRunId: seed.reflectionRunId ?? null,
    checkRunId: seed.checkRunId ?? null,
    attempts: seed.attempts ?? 0,
    skipReason: null,
    failReason: null,
  } as LessonSegment;
}

function setUp(options: {
  segments: SegmentSeed[];
  runs?: Record<string, RunStatus>;
  lessonsOn?: boolean;
  startError?: (runId: string) => Error | null;
}) {
  const rows = new Map(
    options.segments.map((seed) => [seed.id, segmentOf(seed)]),
  );
  const runs = options.runs ?? {};
  const em = { fork: () => em };
  const started: { runId: string; closer: LessonSegmentCloser }[] = [];
  const reflectionAbandoned: string[] = [];
  const checkAbandoned: string[] = [];
  const published: (string | null)[] = [];

  const segments = {
    listByStatus: async (statuses: readonly LessonSegmentStatus[]) =>
      [...rows.values()]
        .filter((row) => statuses.includes(row.status))
        .map((row) => ({ ...row })),
    listQueued: async () =>
      [...rows.values()]
        .filter((row) => row.status === 'queued')
        .sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime())
        .map((row) => ({ ...row })),
    getById: async (id: string) => {
      const row = rows.get(id);
      return row === undefined ? null : { ...row };
    },
    updateById: async (id: string, patch: Partial<LessonSegment>) => {
      Object.assign(rows.get(id)!, patch);
    },
  } as unknown as LessonSegmentDao;
  const runDao = {
    getById: async (id: string) => {
      const status = runs[id] ?? (id.startsWith('run-') ? 'running' : null);
      return status === null ? null : { id, status };
    },
  } as unknown as RunDao;
  const closer = {
    lessonsOnFor: async () => options.lessonsOn ?? true,
  } as unknown as LessonSegmentService;
  const reflections = {
    start: async (runId: string, _input: unknown, by: LessonSegmentCloser) => {
      const error = options.startError?.(runId) ?? null;
      if (error !== null) {
        throw error;
      }
      started.push({ runId, closer: by });
    },
    abandon: async (segment: LessonSegment) => {
      reflectionAbandoned.push(segment.id);
      rows.get(segment.id)!.status = 'failed';
    },
  } as unknown as LessonReflectionService;
  const checks = {
    abandon: async (segment: LessonSegment) => {
      checkAbandoned.push(segment.id);
      rows.get(segment.id)!.status = 'failed';
    },
  } as unknown as LessonCheckService;
  const events = new LessonsEventBus();
  events.allChanges().subscribe(({ runId }) => published.push(runId));

  const runner = new LessonAutoRunner(
    em as never,
    runDao,
    segments,
    closer,
    reflections,
    checks,
    events,
  );
  return {
    runner,
    rows,
    started,
    reflectionAbandoned,
    checkAbandoned,
    published,
    async look() {
      runner.kick();
      await runner.idle();
    },
  };
}

describe('LessonAutoRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts nothing while another stretch is reflecting under a live lease', async () => {
    const { look, started } = setUp({
      segments: [
        {
          id: 'running',
          status: 'reflecting',
          leaseUntil: new Date(NOW.getTime() + LESSON_SEGMENT_LEASE_MS),
        },
        { id: 'waiting' },
      ],
    });

    await look();

    expect(started).toEqual([]);
  });

  it('starts the oldest queued stretch first and only one per look', async () => {
    const { look, started } = setUp({
      segments: [
        { id: 'newer', closedAt: new Date(NOW.getTime() - 1_000) },
        { id: 'oldest', closedAt: new Date(NOW.getTime() - 90_000) },
        { id: 'middle', closedAt: new Date(NOW.getTime() - 30_000) },
      ],
    });

    await look();

    expect(started).toEqual([{ runId: 'run-oldest', closer: 'manual' }]);
  });

  it('holds an archive stretch younger than the grace and starts it once the grace has passed', async () => {
    const { look, started, runner } = setUp({
      segments: [
        {
          id: 'a',
          closedBy: 'archive',
          closedAt: new Date(NOW.getTime() - 1_000),
        },
      ],
    });

    await look();
    expect(started).toEqual([]);

    await vi.advanceTimersByTimeAsync(LESSON_ARCHIVE_GRACE_MS);
    await runner.idle();

    expect(started).toEqual([{ runId: 'run-a', closer: 'archive' }]);
    runner.onModuleDestroy();
  });

  it('starts an archive stretch that is exactly as old as the grace', async () => {
    const { look, started } = setUp({
      segments: [
        {
          id: 'a',
          closedBy: 'archive',
          closedAt: new Date(NOW.getTime() - LESSON_ARCHIVE_GRACE_MS),
        },
      ],
    });

    await look();

    expect(started).toEqual([{ runId: 'run-a', closer: 'archive' }]);
  });

  it('does not make a manual stretch wait for the grace', async () => {
    const { look, started } = setUp({
      segments: [{ id: 'm', closedBy: 'manual', closedAt: new Date(NOW) }],
    });

    await look();

    expect(started).toEqual([{ runId: 'run-m', closer: 'manual' }]);
  });

  it('skips a queued archive stretch whose thread has lessons off, and starts the next one', async () => {
    const { look, started, rows, published } = setUp({
      lessonsOn: false,
      segments: [
        {
          id: 'a',
          closedBy: 'archive',
          closedAt: new Date(NOW.getTime() - 120_000),
        },
        { id: 'm', closedBy: 'manual' },
      ],
    });

    await look();

    expect(rows.get('a')).toMatchObject({
      status: 'skipped',
      skipReason: 'off',
    });
    expect(published).toContain('run-a');
    expect(started).toEqual([{ runId: 'run-m', closer: 'manual' }]);
  });

  it('does not skip a manual stretch when lessons are off', async () => {
    const { look, started, rows } = setUp({
      lessonsOn: false,
      segments: [{ id: 'm', closedBy: 'manual' }],
    });

    await look();

    expect(rows.get('m')?.status).toBe('queued');
    expect(started).toEqual([{ runId: 'run-m', closer: 'manual' }]);
  });

  it('takes back a reflecting stretch whose lease ran out, then starts the queue', async () => {
    const { look, reflectionAbandoned, checkAbandoned, started } = setUp({
      segments: [
        {
          id: 'stale',
          status: 'reflecting',
          leaseUntil: new Date(NOW.getTime() - 1),
        },
        { id: 'waiting' },
      ],
    });

    await look();

    expect(reflectionAbandoned).toEqual(['stale']);
    expect(checkAbandoned).toEqual([]);
    expect(started).toEqual([{ runId: 'run-waiting', closer: 'manual' }]);
  });

  it('takes back a checking stretch whose lease ran out through the check', async () => {
    const { look, reflectionAbandoned, checkAbandoned } = setUp({
      segments: [
        {
          id: 'stale',
          status: 'checking',
          leaseUntil: new Date(NOW.getTime() - 1),
        },
      ],
    });

    await look();

    expect(checkAbandoned).toEqual(['stale']);
    expect(reflectionAbandoned).toEqual([]);
  });

  it('leaves a stretch alone while its lease has not yet run out', async () => {
    const { look, reflectionAbandoned } = setUp({
      segments: [
        {
          id: 'live',
          status: 'reflecting',
          leaseUntil: new Date(NOW.getTime() + 1),
        },
      ],
    });

    await look();

    expect(reflectionAbandoned).toEqual([]);
  });

  describe('at boot', () => {
    async function boot(options: Parameters<typeof setUp>[0]) {
      const fixture = setUp(options);
      fixture.runner.onApplicationBootstrap();
      await vi.advanceTimersByTimeAsync(0);
      await fixture.runner.idle();
      fixture.runner.onModuleDestroy();
      return fixture;
    }

    it('takes back a reflecting stretch whose run has ended', async () => {
      const { reflectionAbandoned } = await boot({
        segments: [
          {
            id: 'r',
            status: 'reflecting',
            reflectionRunId: 'refl-1',
            leaseUntil: new Date(NOW.getTime() + LESSON_SEGMENT_LEASE_MS),
          },
        ],
        runs: { 'refl-1': 'completed' },
      });

      expect(reflectionAbandoned).toEqual(['r']);
    });

    it('takes back a reflecting stretch whose run is gone', async () => {
      const { reflectionAbandoned } = await boot({
        segments: [
          {
            id: 'r',
            status: 'reflecting',
            reflectionRunId: 'refl-1',
            leaseUntil: new Date(NOW.getTime() + LESSON_SEGMENT_LEASE_MS),
          },
        ],
      });

      expect(reflectionAbandoned).toEqual(['r']);
    });

    it('takes back a checking stretch by its check run, not its reflection run', async () => {
      const { checkAbandoned, reflectionAbandoned } = await boot({
        segments: [
          {
            id: 'c',
            status: 'checking',
            reflectionRunId: 'refl-1',
            checkRunId: 'check-1',
            leaseUntil: new Date(NOW.getTime() + LESSON_SEGMENT_LEASE_MS),
          },
        ],
        runs: { 'refl-1': 'running', 'check-1': 'failed' },
      });

      expect(checkAbandoned).toEqual(['c']);
      expect(reflectionAbandoned).toEqual([]);
    });

    it('leaves a reflecting stretch whose run is still live', async () => {
      const { reflectionAbandoned, rows } = await boot({
        segments: [
          {
            id: 'r',
            status: 'reflecting',
            reflectionRunId: 'refl-1',
            leaseUntil: new Date(NOW.getTime() + LESSON_SEGMENT_LEASE_MS),
          },
        ],
        runs: { 'refl-1': 'running' },
      });

      expect(reflectionAbandoned).toEqual([]);
      expect(rows.get('r')?.status).toBe('reflecting');
    });
  });

  describe('a start that is refused', () => {
    it('marks the stretch empty when nothing has happened since its last reflection', async () => {
      const { look, rows, published } = setUp({
        segments: [{ id: 'q' }],
        startError: () =>
          new Error(
            'nothing has happened in this thread since its last reflection',
          ),
      });

      await look();

      expect(rows.get('q')?.status).toBe('empty');
      expect(rows.get('q')?.attempts).toBe(0);
      expect(published).toContain('run-q');
    });

    it('counts one attempt for any other error and keeps the stretch queued', async () => {
      const { look, rows } = setUp({
        segments: [{ id: 'q' }],
        startError: () => new Error('the CLI is not installed'),
      });

      await look();

      expect(rows.get('q')).toMatchObject({
        status: 'queued',
        attempts: 1,
        failReason: 'the CLI is not installed',
      });
    });

    it('fails the stretch on the last allowed attempt', async () => {
      const { look, rows } = setUp({
        segments: [{ id: 'q', attempts: LESSON_SEGMENT_MAX_ATTEMPTS - 1 }],
        startError: () => new Error('the CLI is not installed'),
      });

      await look();

      expect(rows.get('q')).toMatchObject({
        status: 'failed',
        attempts: LESSON_SEGMENT_MAX_ATTEMPTS,
      });
    });

    it('fails the stretch only after the third failed look', async () => {
      const { look, rows } = setUp({
        segments: [{ id: 'q' }],
        startError: () => new Error('boom'),
      });

      await look();
      await look();
      expect(rows.get('q')?.status).toBe('queued');
      await look();

      expect(rows.get('q')).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('goes on to the next queued stretch after a refused one', async () => {
      const { look, started, rows } = setUp({
        segments: [
          { id: 'bad', closedAt: new Date(NOW.getTime() - 90_000) },
          { id: 'good', closedAt: new Date(NOW.getTime() - 30_000) },
        ],
        startError: (runId) => (runId === 'run-bad' ? new Error('boom') : null),
      });

      await look();

      expect(rows.get('bad')?.attempts).toBe(1);
      expect(started).toEqual([{ runId: 'run-good', closer: 'manual' }]);
    });
  });
});
