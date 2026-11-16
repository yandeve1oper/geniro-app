import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LessonSegment } from '../entity/lesson-segment.entity';
import type { LessonSegmentStatus } from '../lessons.types';

/** A stretch a reflection or its check is working on now. */
export const RUNNING_SEGMENT_STATUSES: readonly LessonSegmentStatus[] = [
  'reflecting',
  'checking',
];

@Injectable()
export class LessonSegmentDao extends BaseDao<LessonSegment> {
  constructor(em: EntityManager) {
    super(em, LessonSegment);
  }

  /** The segment a reflection was started on. */
  ofReflection(
    reflectionRunId: string,
    txEm?: EntityManager,
  ): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { reflectionRunId },
      { disableIdentityMap: true },
    );
  }

  /** The segment a second-model check was started on. */
  ofCheck(
    checkRunId: string,
    txEm?: EntityManager,
  ): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { checkRunId },
      { disableIdentityMap: true },
    );
  }

  /** A thread's stretch waiting in the queue; a thread has at most one, and a later close extends it. */
  queuedOf(runId: string, txEm?: EntityManager): Promise<LessonSegment | null> {
    return this.getRepo(txEm).findOne(
      { runId, status: 'queued' },
      { orderBy: { closedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Every queued stretch, oldest closed first — the order the runner takes them in. */
  listQueued(txEm?: EntityManager): Promise<LessonSegment[]> {
    return this.getRepo(txEm).find(
      { status: 'queued' },
      { orderBy: { closedAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** Segments by status, newest closed first; every run's, or one run's. */
  listByStatus(
    statuses: readonly LessonSegmentStatus[],
    runId: string | null,
    txEm?: EntityManager,
  ): Promise<LessonSegment[]> {
    return this.getRepo(txEm).find(
      {
        status: { $in: [...statuses] },
        ...(runId === null ? {} : { runId }),
      },
      { orderBy: { closedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Stretches in one of these statuses last changed since a moment, newest first. */
  listChangedSince(
    statuses: readonly LessonSegmentStatus[],
    since: Date,
    txEm?: EntityManager,
  ): Promise<LessonSegment[]> {
    return this.getRepo(txEm).find(
      { status: { $in: [...statuses] }, updatedAt: { $gte: since } },
      { orderBy: { updatedAt: 'desc' }, disableIdentityMap: true },
    );
  }

  /** Drop every segment of the runs a teardown deletes. */
  async deleteOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<void> {
    if (runIds.length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeDelete({ runId: { $in: [...runIds] } });
  }
}
