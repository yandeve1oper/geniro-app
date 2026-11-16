import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { LessonSegment } from '../entity/lesson-segment.entity';

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
