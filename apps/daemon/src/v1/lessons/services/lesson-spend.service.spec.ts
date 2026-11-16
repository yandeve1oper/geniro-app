import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { UsageEventDao } from '../../stats/dao/usage-event.dao';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonSpendService } from './lesson-spend.service';

const NOW = new Date(2026, 10, 15, 14, 0, 0);
const TODAY = new Date(2026, 10, 15, 9, 0, 0);
const EARLIER_THIS_MONTH = new Date(2026, 10, 3, 9, 0, 0);

interface Row {
  runId: string;
  purpose: 'lessons' | 'lessons_check';
  costUsd: number | null;
  occurredAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    runId: 'r1',
    purpose: 'lessons',
    costUsd: 0.1,
    occurredAt: TODAY,
    ...overrides,
  };
}

function build(
  options: {
    usage?: Row[];
    ended?: { runId: string }[];
    failed?: { id: string; runId: string; failReason: string | null }[];
    saved?: number;
    titles?: Record<string, string>;
  } = {},
) {
  const em = { fork: () => em } as unknown as EntityManager;
  const usage = {
    ofPurposesSince: vi.fn(() => Promise.resolve(options.usage ?? [])),
  };
  const segments = {
    listChangedSince: vi.fn(() => Promise.resolve(options.ended ?? [])),
    listByStatus: vi.fn(() => Promise.resolve(options.failed ?? [])),
  };
  const proposals = {
    savedSince: vi.fn(() => Promise.resolve(options.saved ?? 0)),
  };
  const runDao = {
    getById: vi.fn((id: string) =>
      Promise.resolve(
        options.titles?.[id] === undefined
          ? null
          : { id, title: options.titles[id] },
      ),
    ),
  };
  const service = new LessonSpendService(
    em,
    usage as unknown as UsageEventDao,
    segments as unknown as LessonSegmentDao,
    proposals as unknown as LessonProposalDao,
    runDao as unknown as RunDao,
  );
  return { service, usage, segments, proposals };
}

describe('LessonSpendService.spend', () => {
  it('reads reflection and check usage rows from the start of the month', async () => {
    const { service, usage } = build();

    await service.spend(NOW);

    expect(usage.ofPurposesSince).toHaveBeenCalledWith(
      ['lessons', 'lessons_check'],
      new Date(2026, 10, 1),
      expect.anything(),
    );
  });

  it('splits reflect and check spend, today from the month', async () => {
    const { service } = build({
      usage: [
        row({ purpose: 'lessons', costUsd: 0.5 }),
        row({ purpose: 'lessons_check', costUsd: 0.25 }),
        row({ purpose: 'lessons', costUsd: 1, occurredAt: EARLIER_THIS_MONTH }),
        row({
          purpose: 'lessons_check',
          costUsd: 2,
          occurredAt: EARLIER_THIS_MONTH,
        }),
      ],
    });

    const spend = await service.spend(NOW);

    expect(spend.todayByStep).toEqual({ reflect: 0.5, check: 0.25 });
    expect(spend.monthByStep).toEqual({ reflect: 1.5, check: 2.25 });
    expect(spend.todayUsd).toBe(0.75);
    expect(spend.monthUsd).toBe(3.75);
  });

  it('counts a run whose rows all have no cost as unpriced, not as zero spend', async () => {
    const { service } = build({
      usage: [
        row({ runId: 'unpriced', costUsd: null }),
        row({ runId: 'unpriced', costUsd: null, purpose: 'lessons_check' }),
        row({ runId: 'priced', costUsd: 0.2 }),
      ],
    });

    const spend = await service.spend(NOW);

    expect(spend.unpricedRuns).toBe(1);
    expect(spend.todayUsd).toBeCloseTo(0.2);
  });

  it('does not call a run unpriced when any of its rows carries a cost', async () => {
    const { service } = build({
      usage: [
        row({ runId: 'mixed', costUsd: null }),
        row({ runId: 'mixed', costUsd: 0.3 }),
      ],
    });

    expect((await service.spend(NOW)).unpricedRuns).toBe(0);
  });

  it('counts the distinct threads reflected today and the lessons saved today', async () => {
    const { service, segments, proposals } = build({
      ended: [{ runId: 'a' }, { runId: 'a' }, { runId: 'b' }],
      saved: 4,
    });

    const spend = await service.spend(NOW);

    expect(spend.reflectedToday).toBe(2);
    expect(spend.savedToday).toBe(4);
    expect(segments.listChangedSince).toHaveBeenCalledWith(
      ['reflected', 'empty'],
      new Date(2026, 10, 15),
      expect.anything(),
    );
    expect(proposals.savedSince).toHaveBeenCalledWith(
      new Date(2026, 10, 15),
      expect.anything(),
    );
  });

  it('lists failed segments with their thread title and reason', async () => {
    const { service, segments } = build({
      failed: [
        { id: 's1', runId: 'a', failReason: 'the CLI timed out' },
        { id: 's2', runId: 'gone', failReason: null },
      ],
      titles: { a: 'Migrate the cache' },
    });

    const spend = await service.spend(NOW);

    expect(segments.listByStatus).toHaveBeenCalledWith(
      ['failed'],
      null,
      expect.anything(),
    );
    expect(spend.failed).toEqual([
      {
        segmentId: 's1',
        runId: 'a',
        sourceTitle: 'Migrate the cache',
        reason: 'the CLI timed out',
      },
      { segmentId: 's2', runId: 'gone', sourceTitle: null, reason: null },
    ]);
  });

  it('names at most five failed segments', async () => {
    const { service } = build({
      failed: Array.from({ length: 7 }, (_, n) => ({
        id: `s${n}`,
        runId: `r${n}`,
        failReason: 'x',
      })),
    });

    expect((await service.spend(NOW)).failed).toHaveLength(5);
  });
});
