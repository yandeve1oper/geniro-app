import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { MemoryMark } from '../entity/memory-mark.entity';
import type {
  MemoryCountedMark,
  MemoryMarkInput,
  MemoryTextDatabase,
} from '../memory.types';

@Injectable()
export class MemoryMarkDao extends BaseDao<MemoryMark> {
  constructor(em: EntityManager) {
    super(em, MemoryMark);
  }

  /** Record a mark, replacing what the same thread said from the same source before. */
  async record(
    input: MemoryMarkInput,
    at: Date,
    em: EntityManager,
  ): Promise<void> {
    const now = at.getTime();
    const values = {
      run_id: input.runId,
      member_id: input.memberId,
      verdict: input.verdict,
      reason: input.reason,
      evidence_seq: input.evidenceSeq,
      agent_kind: input.agentKind,
      model: input.model,
      updated_at: now,
      deleted_at: null,
    };
    await this.database(em)
      .insertInto('memory_marks')
      .values({
        id: randomUUID(),
        memory_id: input.memoryId,
        thread_id: input.threadId,
        source: input.source,
        created_at: now,
        ...values,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['memory_id', 'thread_id', 'source'])
          .doUpdateSet(values),
      )
      .execute();
  }

  /**
   * Every countable mark since `since` and since its entry's last restore,
   * for these entries, or for every active entry when `memoryIds` is null.
   */
  async counted(
    memoryIds: readonly string[] | null,
    since: Date,
    em: EntityManager,
  ): Promise<MemoryCountedMark[]> {
    if (memoryIds !== null && memoryIds.length === 0) {
      return [];
    }
    let query = this.database(em)
      .selectFrom('memory_marks as k')
      .innerJoin('memories as m', 'm.id', 'k.memory_id')
      .select([
        'k.memory_id',
        'k.thread_id',
        'k.verdict',
        'k.reason',
        'k.updated_at',
      ])
      .where('k.deleted_at', 'is', null)
      .where('m.deleted_at', 'is', null)
      .where('k.updated_at', '>=', since.getTime())
      .where((eb) =>
        eb.or([
          eb('m.restored_at', 'is', null),
          eb('k.updated_at', '>', eb.ref('m.restored_at')),
        ]),
      );
    query =
      memoryIds === null
        ? query.where('m.status', '=', 'active')
        : query.where('k.memory_id', 'in', [...memoryIds]);
    const rows = await query.orderBy('k.updated_at').execute();
    return rows.map((row) => ({
      memoryId: row.memory_id,
      threadId: row.thread_id,
      verdict: row.verdict,
      reason: row.reason,
      at: Number(row.updated_at),
    }));
  }

  /** Delete an entry's marks with its text: their reasons quote it. */
  async deleteFor(memoryId: string, em: EntityManager): Promise<void> {
    await this.database(em)
      .deleteFrom('memory_marks')
      .where('memory_id', '=', memoryId)
      .execute();
  }

  private database(em: EntityManager) {
    return em.getKysely<MemoryTextDatabase>({ convertValues: false });
  }
}
