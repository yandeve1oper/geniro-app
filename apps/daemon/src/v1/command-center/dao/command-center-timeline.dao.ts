import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type { ChatTextDatabase } from '../../agents/chat.types';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import { UsageActivity } from '../../stats/entity/usage-activity.entity';
import { Task } from '../../tasks/entity/task.entity';

/**
 * The reads the command center's timeline merges. Each returns the newest
 * `limit` rows strictly older than `before`, straight off its table, so a
 * page is never cut from a window the renderer happened to load.
 */
@Injectable()
export class CommandCenterTimelineDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  async userMessages(managerRunId: string, before: Date, limit: number) {
    return this.itemsBefore([managerRunId], before, limit)
      .where('kind', '=', 'message')
      .where('role', '=', 'user')
      .execute();
  }

  async approvals(
    threadRunIds: readonly string[],
    before: Date,
    limit: number,
  ) {
    return this.scoped(threadRunIds, () =>
      this.itemsBefore(threadRunIds, before, limit)
        .where('kind', '=', 'approval_request')
        .execute(),
    );
  }

  async stages(threadRunIds: readonly string[], before: Date, limit: number) {
    return this.scoped(threadRunIds, () =>
      this.itemsBefore(threadRunIds, before, limit)
        .where('kind', '=', 'stage_change')
        .where((eb) =>
          eb(
            eb.fn<string | null>('json_extract', [
              eb.ref('payload'),
              eb.val('$.action'),
            ]),
            '!=',
            'nudge',
          ),
        )
        .execute(),
    );
  }

  async outcomes(threadRunIds: readonly string[], before: Date, limit: number) {
    return this.scoped(threadRunIds, () =>
      this.itemsBefore(threadRunIds, before, limit)
        .where('kind', '=', 'thread_outcome')
        .execute(),
    );
  }

  async errorItems(runIds: readonly string[]) {
    return this.scoped(runIds, () =>
      this.em
        .fork()
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select(['run_id', 'payload', 'created_at'])
        .where('run_id', 'in', [...runIds])
        .where('kind', '=', 'error')
        .where('deleted_at', 'is', null)
        .orderBy('created_at', 'desc')
        .execute(),
    );
  }

  async managerMessages(
    managerRunId: string,
    threadRunIds: readonly string[],
    before: Date,
    limit: number,
  ) {
    return this.scoped(threadRunIds, () =>
      this.em.fork().find(
        ThreadMessage,
        {
          fromRunId: managerRunId,
          toRunId: { $in: [...threadRunIds] },
          createdAt: { $lt: before },
        },
        {
          fields: [
            'id',
            'toRunId',
            'fromTitle',
            'text',
            'createdAt',
            'replyCreditUntil',
            'replyCreditSpentAt',
          ],
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          limit,
          disableIdentityMap: true,
        },
      ),
    );
  }

  async threadMessages(
    managerRunId: string,
    threadRunIds: readonly string[],
    before: Date,
    limit: number,
  ) {
    return this.scoped(threadRunIds, () =>
      this.em.fork().find(
        ThreadMessage,
        {
          toRunId: managerRunId,
          fromRunId: { $in: [...threadRunIds] },
          createdAt: { $lt: before },
        },
        {
          fields: ['id', 'fromRunId', 'fromTitle', 'text', 'createdAt'],
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          limit,
          disableIdentityMap: true,
        },
      ),
    );
  }

  async threadStarts(
    threadRunIds: readonly string[],
    before: Date,
    limit: number,
  ) {
    return this.scoped(threadRunIds, () =>
      this.em.fork().find(
        Run,
        { id: { $in: [...threadRunIds] }, createdAt: { $lt: before } },
        {
          fields: ['id', 'title', 'createdAt'],
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          limit,
          disableIdentityMap: true,
        },
      ),
    );
  }

  async failedRuns(threadRunIds: readonly string[]) {
    return this.scoped(threadRunIds, () =>
      this.em
        .fork()
        .find(
          Run,
          { id: { $in: [...threadRunIds] }, status: 'failed' },
          { fields: ['id', 'title', 'updatedAt'], disableIdentityMap: true },
        ),
    );
  }

  async titlesOf(runIds: readonly string[]) {
    return this.scoped(runIds, () =>
      this.em
        .fork()
        .find(
          Run,
          { id: { $in: [...runIds] } },
          { fields: ['id', 'title'], disableIdentityMap: true },
        ),
    );
  }

  async startRequests(managerRunId: string, before: Date, limit: number) {
    return this.em.fork().find(
      Task,
      {
        startRequestedByRunId: managerRunId,
        startRequestedAt: { $lt: before },
      },
      {
        fields: ['id', 'title', 'startRequestedAt', 'startApprovedAt'],
        orderBy: [{ startRequestedAt: 'desc' }, { id: 'asc' }],
        limit,
        disableIdentityMap: true,
      },
    );
  }

  async pullRequests(
    threadRunIds: readonly string[],
    before: Date,
    limit: number,
  ) {
    return this.scoped(threadRunIds, () =>
      this.em.fork().find(
        UsageActivity,
        {
          kind: 'pull_request',
          runId: { $in: [...threadRunIds] },
          occurredAt: { $lt: before },
        },
        {
          fields: [
            'id',
            'runId',
            'occurredAt',
            'prOwner',
            'prRepo',
            'prNumber',
          ],
          orderBy: [{ occurredAt: 'desc' }, { id: 'asc' }],
          limit,
          disableIdentityMap: true,
        },
      ),
    );
  }

  private itemsBefore(runIds: readonly string[], before: Date, limit: number) {
    return this.em
      .fork()
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select(['id', 'run_id', 'kind', 'payload', 'created_at'])
      .where('run_id', 'in', [...runIds])
      .where('deleted_at', 'is', null)
      .where('created_at', '<', before.getTime())
      .orderBy('created_at', 'desc')
      .orderBy('id', 'asc')
      .limit(limit);
  }

  private async scoped<T>(
    runIds: readonly string[],
    read: () => Promise<T[]>,
  ): Promise<T[]> {
    return runIds.length === 0 ? [] : read();
  }
}
