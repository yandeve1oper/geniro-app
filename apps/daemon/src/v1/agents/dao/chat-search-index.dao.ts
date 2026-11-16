import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import {
  CHAT_TEXT_KINDS,
  CHAT_TEXT_TRIGGERS,
  CREATE_CHAT_TEXT_TABLE,
  DROP_CHAT_TEXT_TABLE,
  DROP_RETIRED_CHAT_TEXT_TRIGGERS,
} from '../../../db/chat-text-index.ddl';
import { Item } from '../../runs/entity/item.entity';
import type {
  ChatContextRow,
  ChatContextRun,
  ChatTextDatabase,
  ChatTextMatch,
  GlobalChatSearchQuery,
} from '../chat.types';

@Injectable()
export class ChatSearchIndexDao extends BaseDao<Item> {
  constructor(em: EntityManager) {
    super(em, Item);
  }

  /** The best `limit` rows matching a ready-made FTS5 query, best first. */
  match(
    options: GlobalChatSearchQuery,
    matchQuery: string,
    limit: number,
  ): Promise<ChatTextMatch[]> {
    let query = this.database()
      .selectFrom('chat_text')
      .innerJoin('items as i', 'i.id', 'chat_text.item_id')
      .innerJoin('runs as r', 'r.id', 'i.run_id')
      .select([
        'i.id',
        'i.run_id',
        'i.member_id',
        'i.seq',
        'i.kind',
        'i.role',
        'i.created_at',
        'r.title',
        'r.cwd',
        'r.archived_at',
        'chat_text.rank',
        'chat_text.text',
      ])
      .where('chat_text', 'match', matchQuery)
      .where('i.deleted_at', 'is', null)
      .where('r.deleted_at', 'is', null)
      // A team builder's own chat, and a thread's or a team's
      // analysis, are listed nowhere a hit could open them: each lives in its
      // own surface.
      .where('r.edits_team_slug', 'is', null)
      .where('r.analysis_source_run_id', 'is', null)
      .where('r.analysis_team_slug', 'is', null)
      .where('r.pending_delete_at', 'is', null);
    if (!options.includeArchived) {
      query = query.where('r.archived_at', 'is', null);
    }
    if (options.runId) {
      query = query.where('i.run_id', '=', options.runId);
    }
    if (options.cwd) {
      query = query.where('r.cwd', '=', options.cwd);
    }
    return query
      .orderBy('chat_text.rank')
      .orderBy('i.created_at', 'desc')
      .limit(limit)
      .execute();
  }

  /** The run a context read is about, or undefined when it is gone. */
  run(runId: string): Promise<ChatContextRun | undefined> {
    return (
      this.database()
        .selectFrom('runs')
        .select(['id', 'title', 'cwd', 'archived_at'])
        .where('id', '=', runId)
        .where('deleted_at', 'is', null)
        // The same reach as `match`: nothing a search cannot return.
        .where('edits_team_slug', 'is', null)
        .where('analysis_source_run_id', 'is', null)
        .where('analysis_team_slug', 'is', null)
        .where('pending_delete_at', 'is', null)
        .executeTakeFirst()
    );
  }

  /** One message or reasoning row of a run — the kinds a search returns. */
  row(runId: string, itemId: string): Promise<ChatContextRow | undefined> {
    return this.contextRows()
      .where('run_id', '=', runId)
      .where('id', '=', itemId)
      .where('kind', 'in', [...CHAT_TEXT_KINDS])
      .executeTakeFirst();
  }

  /**
   * Up to `count` messages and reasoning rows on one side of `target`, nearest
   * first. `(run_id, seq)` is not unique, so a tie on seq is broken by id —
   * the same order on both sides, so no row is read twice or skipped.
   */
  neighbours(
    target: Pick<ChatContextRow, 'run_id' | 'seq' | 'id'>,
    side: 'before' | 'after',
    count: number,
  ): Promise<ChatContextRow[]> {
    if (count === 0) {
      return Promise.resolve([]);
    }
    const before = side === 'before';
    return this.contextRows()
      .where('run_id', '=', target.run_id)
      .where('kind', 'in', [...CHAT_TEXT_KINDS])
      .where((eb) =>
        eb.or([
          eb('seq', before ? '<' : '>', target.seq),
          eb.and([
            eb('seq', '=', target.seq),
            eb('id', before ? '<' : '>', target.id),
          ]),
        ]),
      )
      .orderBy('seq', before ? 'desc' : 'asc')
      .orderBy('id', before ? 'desc' : 'asc')
      .limit(count)
      .execute();
  }

  /** Which of the index's triggers exist. */
  async presentTriggers(): Promise<Set<string>> {
    const rows = await this.database()
      .selectFrom('sqlite_master')
      .select('name')
      .where('type', '=', 'trigger')
      .where(
        'name',
        'in',
        CHAT_TEXT_TRIGGERS.map((trigger) => trigger.name),
      )
      .execute();
    return new Set(rows.map((row) => row.name));
  }

  /** Create the FTS table when it does not exist yet. */
  async createTable(): Promise<void> {
    await this.em.getConnection().execute(CREATE_CHAT_TEXT_TABLE, [], 'run');
  }

  /**
   * Recreate the index from `items` and install its triggers, in ONE
   * transaction: a row written between the fill and the triggers would
   * otherwise be missed, and a crash part-way leaves the triggers absent,
   * which is what makes the next boot rebuild it. The table is dropped and
   * created again rather than emptied, so a changed definition takes effect.
   */
  async rebuild(): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ddl = (sql: string) =>
        connection.execute(sql, [], 'run', em.getTransactionContext());
      for (const statement of DROP_RETIRED_CHAT_TEXT_TRIGGERS) {
        await ddl(statement);
      }
      await ddl(DROP_CHAT_TEXT_TABLE);
      await ddl(CREATE_CHAT_TEXT_TABLE);
      const database = this.database(em);
      await database
        .insertInto('chat_text')
        .columns(['rowid', 'item_id', 'text'])
        .expression((eb) =>
          eb
            .selectFrom('items')
            .select(['rowid', 'id'])
            .select((inner) =>
              inner
                .fn<string>('json_extract', [
                  inner.ref('payload'),
                  inner.val('$.text'),
                ])
                .as('text'),
            )
            .where('kind', 'in', [...CHAT_TEXT_KINDS])
            .where((inner) =>
              inner(
                inner
                  .case()
                  .when(inner.fn('json_valid', [inner.ref('payload')]), '=', 1)
                  .then(
                    inner.fn('json_type', [
                      inner.ref('payload'),
                      inner.val('$.text'),
                    ]),
                  )
                  .end(),
                '=',
                'text',
              ),
            ),
        )
        .execute();
      for (const trigger of CHAT_TEXT_TRIGGERS) {
        await ddl(trigger.sql);
      }
    });
  }

  private contextRows() {
    return this.database()
      .selectFrom('items')
      .select([
        'id',
        'run_id',
        'member_id',
        'seq',
        'kind',
        'role',
        'payload',
        'created_at',
      ])
      .where('deleted_at', 'is', null);
  }

  private database(em = this.em) {
    return em.getKysely<ChatTextDatabase>({ convertValues: false });
  }
}
