import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { persistItemAndEmit } from '../../agents/utils/persist-item';
import type { LessonOutcomePayload, LessonsPayload } from '../lessons.types';

/**
 * Writes the lessons rows into the thread they are about — a passive row,
 * not a turn, so an archived thread takes one too. A thread deleted since
 * takes none: its proposals stay in `lesson_proposals`.
 */
@Injectable()
export class LessonRowWriter {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly calls: ItemCallIndexService,
    private readonly seqs: ItemSeqAllocator,
  ) {}

  async write(runId: string, row: LessonRow): Promise<void> {
    const em = this.em.fork();
    if ((await this.runDao.getById(runId, em)) === null) {
      return;
    }
    await persistItemAndEmit(
      {
        itemDao: this.itemDao,
        bus: this.bus,
        calls: this.calls,
        seqs: this.seqs,
      },
      em,
      {
        runId,
        memberId: null,
        seq: await this.seqs.reserve(runId),
        kind: row.kind,
        role: null,
        payload: row.payload,
      },
    );
  }
}

export type LessonRow =
  | { kind: 'lessons'; payload: LessonsPayload }
  | { kind: 'lesson_outcome'; payload: LessonOutcomePayload };
