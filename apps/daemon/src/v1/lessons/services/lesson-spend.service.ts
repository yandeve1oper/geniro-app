import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { UsageEventDao } from '../../stats/dao/usage-event.dao';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonsSpend } from '../lessons.types';

/** How many failed stretches the readout names. */
export const LESSON_FAILED_LISTED_MAX = 5;

/**
 * What lessons cost, from the usage ledger's `purpose` rows over every row of
 * the period (`lessons` is the reflection, `lessons_check` the check), and
 * what they did today — for Settings → Memory → Lessons. A run whose CLI
 * reported no cost is counted as unpriced, never as $0.
 */
@Injectable()
export class LessonSpendService {
  constructor(
    private readonly em: EntityManager,
    private readonly usage: UsageEventDao,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly runDao: RunDao,
  ) {}

  async spend(now = new Date()): Promise<LessonsSpend> {
    const em = this.em.fork();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const month = new Date(now.getFullYear(), now.getMonth(), 1);
    const rows = await this.usage.ofPurposesSince(
      ['lessons', 'lessons_check'],
      month,
      em,
    );
    const todayByStep = { reflect: 0, check: 0 };
    const monthByStep = { reflect: 0, check: 0 };
    const priced = new Map<string, boolean>();
    for (const row of rows) {
      const step = row.purpose === 'lessons_check' ? 'check' : 'reflect';
      const cost = row.costUsd ?? 0;
      monthByStep[step] += cost;
      if (row.occurredAt >= today) {
        todayByStep[step] += cost;
      }
      priced.set(
        row.runId,
        (priced.get(row.runId) ?? false) || row.costUsd !== null,
      );
    }
    const ended = await this.segments.listChangedSince(
      ['reflected', 'empty'],
      today,
      em,
    );
    const failed = (
      await this.segments.listByStatus(['failed'], null, em)
    ).slice(0, LESSON_FAILED_LISTED_MAX);
    return {
      todayUsd: todayByStep.reflect + todayByStep.check,
      monthUsd: monthByStep.reflect + monthByStep.check,
      todayByStep,
      monthByStep,
      reflectedToday: new Set(ended.map((segment) => segment.runId)).size,
      savedToday: await this.proposals.savedSince(today, em),
      unpricedRuns: [...priced.values()].filter((value) => !value).length,
      failed: await Promise.all(
        failed.map(async (segment) => ({
          segmentId: segment.id,
          runId: segment.runId,
          sourceTitle:
            (await this.runDao.getById(segment.runId, em))?.title ?? null,
          reason: segment.failReason,
        })),
      ),
    };
  }
}
