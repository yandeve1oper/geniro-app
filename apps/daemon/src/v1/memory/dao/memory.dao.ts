import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';
import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from 'kysely';

import {
  CREATE_MEMORY_TEXT_TABLE,
  DROP_MEMORY_TEXT_TABLE,
  DROP_RETIRED_MEMORY_TEXT_TRIGGERS,
  MEMORY_TEXT_TRIGGERS,
} from '../../../db/memory-text-index.ddl';
import type { RunPlace } from '../../projects/projects.types';
import { Memory } from '../entity/memory.entity';
import {
  MEMORY_COLD_DAYS,
  memoryHandle,
  type MemoryReach,
  type MemoryReviewSort,
  type MemoryReviewTab,
  type MemoryReviewWarnings,
  type MemoryStatus,
  type MemoryTextDatabase,
  type MemoryType,
} from '../memory.types';
import {
  forgottenColumns,
  restoredColumns,
} from '../utils/memory-forget-stamp';
import { DAY_MS, usageDay } from '../utils/memory-usage-day';

/** Which rows a cleanup read takes, counted over every row before any page. */
export interface MemoryReviewFilter {
  tab: MemoryReviewTab;
  sort: MemoryReviewSort;
  places: MemoryMatchScope['places'];
  type?: MemoryType;
  /** Least used only: rows younger than this many days are left out. */
  minAgeDays: number;
  /** Least used only: the age filter turned around, for what it keeps out. */
  youngerOnly?: boolean;
  warnings: MemoryReviewWarnings;
  referenceGone: boolean;
  now: Date;
}

/** What the automatic sweep takes: rows quiet since `before`, in a live scope. */
export interface MemoryAutoForgetFilter {
  before: Date;
  liveScopes: MemoryLiveScopes;
}

/** The places a new run was filed in lately; entries filed elsewhere are dormant. */
export interface MemoryLiveScopes {
  global: boolean;
  projectIds: readonly string[];
  teamSlugs: readonly string[];
}

/** One cleanup row's id and its usage, summed over the ledger. */
export interface MemoryReviewHit {
  id: string;
  readsLast90Days: number;
  reads: number;
  searchHits: number;
  indexShows: number;
  lastReadDay: string | null;
  warned: boolean;
}

/** A live row the sweep has not read for a rule or paths yet. */
export interface MemoryUnmarkedRow {
  id: string;
  rev: number;
  title: string;
  body: string;
}

/** An active entry's text and scope, as the pair search reads it. */
export interface MemoryActiveText {
  id: string;
  handle: number;
  title: string;
  body: string;
  projectId: string | null;
  teamSlug: string | null;
}

/** A project entry whose referenced paths are due a check. */
export interface MemoryReferenceRow {
  id: string;
  rev: number;
  projectId: string;
  referencedPaths: string;
}

/** Which entries a read or a full-text match may return. */
export interface MemoryMatchScope {
  statuses: readonly MemoryStatus[];
  /**
   * `visibleTo`: global entries plus this place's project's and team's.
   * `exactly`: entries filed under exactly this place (both null = global).
   * `any`: every scope — the user's own view.
   */
  places: { visibleTo: RunPlace } | { exactly: RunPlace } | { any: true };
}

/** One page of the user's list, newest edit first. */
export interface MemoryPageFilter extends MemoryMatchScope {
  type?: MemoryType;
  reach?: MemoryReach;
  handle?: number;
  /** A ready-made FTS5 query. */
  match?: string;
  before?: { updatedAt: Date; id: string };
  limit: number;
}

@Injectable()
export class MemoryDao extends BaseDao<Memory> {
  constructor(em: EntityManager) {
    super(em, Memory);
  }

  /** One past the highest handle ever given, forgotten entries included. */
  async nextHandle(em: EntityManager): Promise<number> {
    const highest = await em.findOne(
      Memory,
      { handle: { $gt: 0 } },
      { orderBy: { handle: 'desc' }, fields: ['handle'], filters: false },
    );
    return (highest?.handle ?? 0) + 1;
  }

  /** Every entry's id by its handle (`m12`), forgotten and deleted ones included. */
  async idsByHandle(em: EntityManager): Promise<Map<string, string>> {
    const rows = await em.find(
      Memory,
      {},
      { fields: ['id', 'handle'], filters: false, disableIdentityMap: true },
    );
    return new Map(rows.map((row) => [memoryHandle(row.handle), row.id]));
  }

  async getByIds(
    ids: readonly string[],
    em: EntityManager = this.em,
  ): Promise<Memory[]> {
    return this.getAll({ id: { $in: [...ids] } }, undefined, em);
  }

  /**
   * Entries in a scope, by handle when `handles` is given — the one place the
   * scope rule is written, for reads as for search.
   */
  async getInScope(
    scope: MemoryMatchScope,
    handles?: readonly number[],
    em: EntityManager = this.em,
  ): Promise<Memory[]> {
    let query = this.scoped(scope, em).select('m.id');
    if (handles !== undefined) {
      if (handles.length === 0) {
        return [];
      }
      query = query.where('m.handle', 'in', [...handles]);
    }
    const ids = (await query.execute()).map((row) => row.id);
    // The status again on load: a forget landing between the two reads must
    // not hand back an entry that just left the scope.
    return ids.length === 0
      ? []
      : this.getAll(
          { id: { $in: ids }, status: { $in: [...scope.statuses] } },
          undefined,
          em,
        );
  }

  /** The ids of the best `limit` entries matching a ready-made FTS5 query. */
  async matchIds(
    matchQuery: string,
    scope: MemoryMatchScope,
    limit: number,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    const rows = await this.scoped(scope, em)
      .innerJoin('memories_fts', 'memories_fts.memory_id', 'm.id')
      .select('m.id')
      .where('memories_fts', 'match', matchQuery)
      .orderBy('memories_fts.rank')
      .limit(limit)
      .execute();
    return rows.map((row) => row.id);
  }

  async page(
    filter: MemoryPageFilter,
    em: EntityManager = this.em,
  ): Promise<Memory[]> {
    const { type, reach, handle, match, before } = filter;
    let query = this.scoped(filter, em).select('m.id');
    if (type !== undefined) {
      query = query.where('m.type', '=', type);
    }
    if (reach !== undefined) {
      query = query.where((eb) =>
        reach === 'index' ? reachExpression(eb) : eb.not(reachExpression(eb)),
      );
    }
    if (handle !== undefined) {
      query = query.where('m.handle', '=', handle);
    }
    if (match !== undefined) {
      query = query.where((eb) =>
        eb(
          'm.id',
          'in',
          eb
            .selectFrom('memories_fts')
            .select('memories_fts.memory_id')
            .where('memories_fts', 'match', match),
        ),
      );
    }
    if (before !== undefined) {
      const at = before.updatedAt.getTime();
      query = query.where((eb) =>
        eb.or([
          eb('m.updated_at', '<', at),
          eb.and([eb('m.updated_at', '=', at), eb('m.id', '<', before.id)]),
        ]),
      );
    }
    const rows = await query
      .orderBy('m.updated_at', 'desc')
      .orderBy('m.id', 'desc')
      .limit(filter.limit)
      .execute();
    const ids = rows.map((row) => row.id);
    const byId = new Map(
      (await this.getByIds(ids, em)).map((row) => [row.id, row]),
    );
    return ids
      .map((id) => byId.get(id))
      .filter((row): row is Memory => row !== undefined);
  }

  /**
   * Forget every active and pending entry in one statement, keeping each
   * restorable, and say how many it took.
   */
  async forgetAll(at: Date, em: EntityManager = this.em): Promise<number> {
    const result = await this.database(em)
      .updateTable('memories')
      .set((eb) => ({
        status_before_forget: eb.ref('status'),
        status: 'forgotten',
        rev: eb('rev', '+', 1),
        updated_at: at.getTime(),
        ...forgottenColumns(at, null),
      }))
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'pending'])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Forget a team's active and pending entries, each kept restorable. */
  async forgetTeam(
    teamSlug: string,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<number> {
    const result = await this.database(em)
      .updateTable('memories')
      .set((eb) => ({
        status_before_forget: eb.ref('status'),
        status: 'forgotten',
        rev: eb('rev', '+', 1),
        updated_at: at.getTime(),
        ...forgottenColumns(at, null),
      }))
      .where('deleted_at', 'is', null)
      .where('team_slug', '=', teamSlug)
      .where('status', 'in', ['active', 'pending'])
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** File every entry of a team, whatever its status, as global. */
  async refileTeamAsGlobal(
    teamSlug: string,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<number> {
    const result = await this.database(em)
      .updateTable('memories')
      .set((eb) => ({
        team_slug: null,
        rev: eb('rev', '+', 1),
        updated_at: at.getTime(),
      }))
      .where('deleted_at', 'is', null)
      .where('team_slug', '=', teamSlug)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** One page of the cleanup list, sorted and counted over every row. */
  async reviewPage(
    filter: MemoryReviewFilter,
    offset: number,
    limit: number,
    em: EntityManager = this.em,
  ): Promise<{ hits: MemoryReviewHit[]; total: number }> {
    const base = this.review(filter, em);
    const counted = await base
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    const rows = await this.sorted(base, filter)
      .select((eb) => [
        'm.id',
        lastReadDayExpression(eb).as('last_read'),
        eb.fn.coalesce('u.recent_reads', eb.lit(0)).as('recent_reads'),
        eb.fn.coalesce('u.reads', eb.lit(0)).as('reads'),
        eb.fn.coalesce('u.search_hits', eb.lit(0)).as('search_hits'),
        eb.fn.coalesce('u.index_shows', eb.lit(0)).as('index_shows'),
        warnedExpression(eb).as('warned'),
      ])
      .limit(limit)
      .offset(offset)
      .execute();
    return {
      total: Number(counted?.n ?? 0),
      hits: rows.map((row) => ({
        id: row.id,
        readsLast90Days: Number(row.recent_reads),
        reads: Number(row.reads),
        searchHits: Number(row.search_hits),
        indexShows: Number(row.index_shows),
        lastReadDay: row.last_read ?? null,
        warned: Boolean(row.warned),
      })),
    };
  }

  /** How many rows a cleanup filter takes, over every row. */
  async reviewCount(
    filter: MemoryReviewFilter,
    em: EntityManager = this.em,
  ): Promise<number> {
    const row = await this.review(filter, em)
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  /**
   * The ids a cleanup filter takes, in its order, leaving out every row that
   * carries a warning — what "Tick shown" ticks.
   */
  async reviewIds(
    filter: MemoryReviewFilter,
    max: number,
    em: EntityManager = this.em,
  ): Promise<{ ids: string[]; warnedSkipped: number }> {
    const base = this.review(filter, em);
    const warned = await base
      .where((eb) => warnedExpression(eb))
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst();
    const rows = await this.sorted(base, filter)
      .where((eb) => eb.not(warnedExpression(eb)))
      .select('m.id')
      .limit(max)
      .execute();
    return {
      ids: rows.map((row) => row.id),
      warnedSkipped: Number(warned?.n ?? 0),
    };
  }

  /** Live rows per status, and how many active ones an agent ever read. */
  async reviewTotals(em: EntityManager = this.em): Promise<{
    active: number;
    pending: number;
    forgotten: number;
    kept: number;
    read: number;
  }> {
    const db = this.database(em);
    const byStatus = await db
      .selectFrom('memories')
      .select((eb) => ['status', eb.fn.countAll<number>().as('n')])
      .where('deleted_at', 'is', null)
      .groupBy('status')
      .execute();
    const count = (status: MemoryStatus) =>
      Number(byStatus.find((row) => row.status === status)?.n ?? 0);
    const kept = await db
      .selectFrom('memories')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'pending'])
      .where('kept_at', 'is not', null)
      .executeTakeFirst();
    const read = await db
      .selectFrom('memories as m')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('m.deleted_at', 'is', null)
      .where('m.status', '=', 'active')
      .where((eb) =>
        eb.or([
          eb('m.last_used_at', 'is not', null),
          eb(
            'm.id',
            'in',
            eb
              .selectFrom('memory_usage_days')
              .select('memory_usage_days.memory_id')
              .where('memory_usage_days.deleted_at', 'is', null)
              .where('memory_usage_days.reads', '>', 0),
          ),
        ]),
      )
      .executeTakeFirst();
    return {
      active: count('active'),
      pending: count('pending'),
      forgotten: count('forgotten'),
      kept: Number(kept?.n ?? 0),
      read: Number(read?.n ?? 0),
    };
  }

  /** The first UTC day the usage ledger holds, or null when it holds none. */
  async firstUsageDay(em: EntityManager = this.em): Promise<string | null> {
    const row = await this.database(em)
      .selectFrom('memory_usage_days')
      .select((eb) => eb.fn.min('day').as('day'))
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.day ?? null;
  }

  /**
   * Forget these active and pending rows as one batch, outside the entity so
   * the list's order does not move, and name the rows it took.
   */
  async forgetBatch(
    ids: readonly string[],
    batchId: string,
    at: Date,
    em: EntityManager = this.em,
    mergedIntoId: string | null = null,
    reason: string | null = null,
  ): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.database(em)
      .updateTable('memories')
      .set((eb) => ({
        status_before_forget: eb.ref('status'),
        status: 'forgotten',
        forget_reason: reason,
        rev: eb('rev', '+', 1),
        merged_into_id: mergedIntoId,
        ...forgottenColumns(at, batchId),
      }))
      .where('id', 'in', [...ids])
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'pending'])
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Return every row a batch forgot to the status it had, unless it left the
   * batch since: restored by hand, or forgotten again on its own.
   */
  async restoreBatch(
    batchId: string,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<number> {
    const result = await this.database(em)
      .updateTable('memories')
      .set((eb) => ({
        status: eb.fn.coalesce(
          'status_before_forget',
          eb.val<MemoryStatus>('active'),
        ),
        status_before_forget: null,
        forget_reason: null,
        rev: eb('rev', '+', 1),
        ...restoredColumns(at),
      }))
      .where('deleted_at', 'is', null)
      .where('status', '=', 'forgotten')
      .where('forget_batch_id', '=', batchId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** The entries a merge wrote for the rows a batch still holds forgotten. */
  async mergedInto(
    batchId: string,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    const rows = await this.database(em)
      .selectFrom('memories')
      .select('merged_into_id')
      .distinct()
      .where('deleted_at', 'is', null)
      .where('status', '=', 'forgotten')
      .where('forget_batch_id', '=', batchId)
      .where('merged_into_id', 'is not', null)
      .execute();
    return rows.flatMap((row) =>
      row.merged_into_id === null ? [] : [row.merged_into_id],
    );
  }

  /** Live active entries past a handle, oldest handle first: one window of a full read. */
  async activeTexts(
    afterHandle: number,
    limit: number,
    em: EntityManager = this.em,
  ): Promise<MemoryActiveText[]> {
    const rows = await this.database(em)
      .selectFrom('memories')
      .select(['id', 'handle', 'title', 'body', 'project_id', 'team_slug'])
      .where('deleted_at', 'is', null)
      .where('status', '=', 'active')
      .where('handle', '>', afterHandle)
      .orderBy('handle')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      handle: row.handle,
      title: row.title,
      body: row.body,
      projectId: row.project_id,
      teamSlug: row.team_slug,
    }));
  }

  /**
   * The newest cleanups whose entries are still forgotten; with `forgottenAt`,
   * only the entries forgotten at that instant.
   */
  async batches(
    limit: number,
    em: EntityManager = this.em,
    forgottenAt?: number,
  ): Promise<
    {
      batchId: string;
      count: number;
      forgottenAt: number;
      title: string | null;
      reason: string | null;
    }[]
  > {
    const rows = await this.database(em)
      .selectFrom('memories')
      .select((eb) => [
        'forget_batch_id',
        eb.fn.countAll<number>().as('n'),
        eb.fn.max('forgotten_at').as('at'),
        eb.fn.max('title').as('title'),
        eb.fn.min('forget_reason').as('reason_low'),
        eb.fn.max('forget_reason').as('reason_high'),
        eb.fn.count('forget_reason').as('reasons'),
      ])
      .where('deleted_at', 'is', null)
      .where('status', '=', 'forgotten')
      .where('forget_batch_id', 'is not', null)
      .$if(forgottenAt !== undefined, (query) =>
        query.where('forgotten_at', '=', forgottenAt ?? null),
      )
      .groupBy('forget_batch_id')
      .orderBy('at', 'desc')
      .orderBy('forget_batch_id')
      .limit(limit)
      .execute();
    return rows.flatMap((row) => {
      if (row.forget_batch_id === null) {
        return [];
      }
      const count = Number(row.n);
      const shared =
        Number(row.reasons) === count && row.reason_low === row.reason_high;
      return [
        {
          batchId: row.forget_batch_id,
          count,
          forgottenAt: Number(row.at ?? 0),
          title: count === 1 ? (row.title ?? null) : null,
          reason: shared ? (row.reason_low ?? null) : null,
        },
      ];
    });
  }

  /**
   * Forgotten rows a rule's batch took before `before`, still forgotten:
   * what the daily sweep deletes for good once their hold is over.
   */
  async ruleForgottenBefore(
    prefixes: readonly string[],
    before: Date,
    max: number,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    if (prefixes.length === 0) {
      return [];
    }
    const rows = await this.database(em)
      .selectFrom('memories')
      .select('id')
      .where('deleted_at', 'is', null)
      .where('status', '=', 'forgotten')
      .where('forgotten_at', '<', before.getTime())
      .where((eb) =>
        eb.or(
          prefixes.map((prefix) => eb('forget_batch_id', 'like', `${prefix}%`)),
        ),
      )
      .orderBy('handle')
      .limit(max)
      .execute();
    return rows.map((row) => row.id);
  }

  /**
   * Active auto lessons, neither approved nor promoted, filed or last
   * restored before `cutoff` and marked `helped` by no thread since then
   * and since `cutoff`: the ones nobody confirmed in time.
   */
  async expiredLessonIds(
    cutoff: Date,
    max: number,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    const at = cutoff.getTime();
    const rows = await this.database(em)
      .selectFrom('memories as m')
      .select('m.id')
      .where('m.deleted_at', 'is', null)
      .where('m.status', '=', 'active')
      .where('m.source_actor', '=', 'lesson')
      .where('m.approved_at', 'is', null)
      .where('m.promoted_at', 'is', null)
      .where('m.created_at', '<', at)
      .where((eb) =>
        eb.or([eb('m.restored_at', 'is', null), eb('m.restored_at', '<', at)]),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom('memory_marks as k')
              .select('k.id')
              .whereRef('k.memory_id', '=', 'm.id')
              .where('k.deleted_at', 'is', null)
              .where('k.verdict', '=', 'helped')
              .where('k.updated_at', '>=', at)
              .where((eb) =>
                eb.or([
                  eb('m.restored_at', 'is', null),
                  eb('k.updated_at', '>', eb.ref('m.restored_at')),
                ]),
              ),
          ),
        ),
      )
      .orderBy('m.handle')
      .limit(max)
      .execute();
    return rows.map((row) => row.id);
  }

  /** Admit these active auto lessons to the memory index, outside the entity so the edit time stays. */
  async promote(
    ids: readonly string[],
    at: Date,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.database(em)
      .updateTable('memories')
      .set({ promoted_at: at.getTime() })
      .where('id', 'in', [...ids])
      .where('deleted_at', 'is', null)
      .where('status', '=', 'active')
      .where('source_actor', '=', 'lesson')
      .where('promoted_at', 'is', null)
      .returning('id')
      .execute();
    return rows.map((row) => row.id);
  }

  /** Keep a live row out of the cleanup list, or stop; false when there is none. */
  async setKept(
    id: string,
    at: Date | null,
    em: EntityManager = this.em,
  ): Promise<boolean> {
    const result = await this.database(em)
      .updateTable('memories')
      .set({ kept_at: at === null ? null : at.getTime() })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'pending'])
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Empty a forgotten row for good and mark it deleted, outside the entity so
   * its edit time stays; false when there is no forgotten row to empty. The
   * row keeps its handle, its provenance and its usage figures.
   */
  async purge(
    id: string,
    textHash: string | null,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<boolean> {
    const result = await this.database(em)
      .updateTable('memories')
      .set({
        title: '',
        body: '',
        forget_reason: null,
        forget_batch_id: null,
        purged_text_hash: textHash,
        deleted_at: at.getTime(),
      })
      .where('id', '=', id)
      .where('deleted_at', 'is', null)
      .where('status', '=', 'forgotten')
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** The text hashes of purged imported rows, read past the soft-delete filter. */
  async purgedImportedHashes(em: EntityManager = this.em): Promise<string[]> {
    const rows = await this.database(em)
      .selectFrom('memories')
      .select('purged_text_hash')
      .where('deleted_at', 'is not', null)
      .where('source_actor', '=', 'import')
      .where('purged_text_hash', 'is not', null)
      .execute();
    return rows.flatMap((row) =>
      row.purged_text_hash === null ? [] : [row.purged_text_hash],
    );
  }

  /**
   * The ids the automatic sweep would forget, oldest handle first: every row
   * its filter takes except those carrying a warning.
   */
  async autoForgetIds(
    filter: MemoryAutoForgetFilter,
    max: number,
    em: EntityManager = this.em,
  ): Promise<string[]> {
    const query = this.autoForget(filter, em);
    if (query === null) {
      return [];
    }
    const rows = await query
      .where((eb) => eb.not(warnedExpression(eb)))
      .select('m.id')
      .orderBy('m.handle')
      .limit(max)
      .execute();
    return rows.map((row) => row.id);
  }

  /** How many rows the sweep would forget now, and how many it leaves for their warning. */
  async autoForgetCounts(
    filter: MemoryAutoForgetFilter,
    em: EntityManager = this.em,
  ): Promise<{ forget: number; warned: number }> {
    const query = this.autoForget(filter, em);
    if (query === null) {
      return { forget: 0, warned: 0 };
    }
    const row = await query
      .select((eb) => [
        eb.fn.countAll<number>().as('n'),
        eb.fn
          .sum<number>(
            eb.case().when(warnedExpression(eb)).then(1).else(0).end(),
          )
          .as('warned'),
      ])
      .executeTakeFirst();
    const total = Number(row?.n ?? 0);
    const warned = Number(row?.warned ?? 0);
    return { forget: total - warned, warned };
  }

  /** Live rows the sweep has not read for a rule or paths yet, oldest handle first. */
  async unmarked(
    limit: number,
    em: EntityManager = this.em,
  ): Promise<MemoryUnmarkedRow[]> {
    return this.database(em)
      .selectFrom('memories')
      .select(['id', 'rev', 'title', 'body'])
      .where('deleted_at', 'is', null)
      .where('states_rule', 'is', null)
      .orderBy('handle')
      .limit(limit)
      .execute();
  }

  /** Store what the sweep read, unless the row was written since it was read. */
  async mark(
    row: Pick<MemoryUnmarkedRow, 'id' | 'rev'>,
    marks: { statesRule: boolean; referencedPaths: string | null },
    em: EntityManager = this.em,
  ): Promise<void> {
    await this.database(em)
      .updateTable('memories')
      .set({
        states_rule: marks.statesRule ? 1 : 0,
        referenced_paths: marks.referencedPaths,
      })
      .where('id', '=', row.id)
      .where('rev', '=', row.rev)
      .execute();
  }

  /** Live project entries naming paths whose last check is older than `before`. */
  async referencesDue(
    before: Date,
    em: EntityManager = this.em,
  ): Promise<MemoryReferenceRow[]> {
    const rows = await this.database(em)
      .selectFrom('memories')
      .select(['id', 'rev', 'project_id', 'referenced_paths'])
      .where('deleted_at', 'is', null)
      .where('status', 'in', ['active', 'pending'])
      .where('project_id', 'is not', null)
      .where('referenced_paths', 'is not', null)
      .where((eb) =>
        eb.or([
          eb('references_checked_at', 'is', null),
          eb('references_checked_at', '<', before.getTime()),
        ]),
      )
      .execute();
    return rows.flatMap((row) =>
      row.project_id === null || row.referenced_paths === null
        ? []
        : [
            {
              id: row.id,
              rev: row.rev,
              projectId: row.project_id,
              referencedPaths: row.referenced_paths,
            },
          ],
    );
  }

  /**
   * Store a reference check's result without moving the entry's edit time,
   * unless the entry was written since the check read its paths.
   */
  async setReferencesGone(
    row: Pick<MemoryReferenceRow, 'id' | 'rev'>,
    gone: string | null,
    at: Date,
    em: EntityManager = this.em,
  ): Promise<void> {
    await this.database(em)
      .updateTable('memories')
      .set({ references_gone: gone, references_checked_at: at.getTime() })
      .where('id', '=', row.id)
      .where('rev', '=', row.rev)
      .execute();
  }

  /**
   * The cleanup rows of a tab with its filters, joined to their summed usage.
   * A merged entry is credited with the usage of every source still forgotten
   * into it, and each source keeps its own.
   */
  private review(filter: MemoryReviewFilter, em: EntityManager) {
    const { tab, places, type, warnings, referenceGone, now } = filter;
    const recentDay = usageDay(
      new Date(now.getTime() - MEMORY_COLD_DAYS * DAY_MS),
    );
    const db = this.database(em);
    const credited = db
      .selectFrom('memory_usage_days as d')
      .where('d.deleted_at', 'is', null)
      .select([
        'd.memory_id as owner',
        'd.day',
        'd.reads',
        'd.search_hits',
        'd.index_shows',
      ])
      .unionAll(
        db
          .selectFrom('memory_usage_days as d')
          .innerJoin('memories as src', 'src.id', 'd.memory_id')
          .where('d.deleted_at', 'is', null)
          .where('src.deleted_at', 'is', null)
          .where('src.status', '=', 'forgotten')
          .where('src.merged_into_id', 'is not', null)
          .select([
            'src.merged_into_id as owner',
            'd.day',
            'd.reads',
            'd.search_hits',
            'd.index_shows',
          ])
          .$narrowType<{ owner: string }>(),
      )
      .as('c');
    const usage = db
      .selectFrom(credited)
      .select((eb) => [
        'c.owner',
        eb.fn.sum<number>('c.reads').as('reads'),
        eb.fn.sum<number>('c.search_hits').as('search_hits'),
        eb.fn.sum<number>('c.index_shows').as('index_shows'),
        eb.fn
          .sum<number>(
            eb
              .case()
              .when('c.day', '>=', recentDay)
              .then(eb.ref('c.reads'))
              .else(0)
              .end(),
          )
          .as('recent_reads'),
        eb.fn
          .max(eb.case().when('c.reads', '>', 0).then(eb.ref('c.day')).end())
          .as('last_read_day'),
      ])
      .groupBy('c.owner')
      .as('u');
    let query = this.scoped(
      {
        statuses: tab === 'forgotten' ? ['forgotten'] : ['active', 'pending'],
        places,
      },
      em,
    ).leftJoin(usage, (join) => join.onRef('u.owner', '=', 'm.id'));
    if (tab === 'kept') {
      query = query.where('m.kept_at', 'is not', null);
    }
    if (tab === 'cold') {
      const coldBefore = now.getTime() - MEMORY_COLD_DAYS * DAY_MS;
      const ageBefore = now.getTime() - filter.minAgeDays * DAY_MS;
      query = query
        .where('m.kept_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb('u.recent_reads', 'is', null),
            eb('u.recent_reads', '=', 0),
          ]),
        )
        .where((eb) =>
          eb.or([
            eb('m.last_used_at', 'is', null),
            eb('m.last_used_at', '<', coldBefore),
          ]),
        )
        .where('m.created_at', filter.youngerOnly ? '>' : '<=', ageBefore);
    }
    if (type !== undefined) {
      query = query.where('m.type', '=', type);
    }
    if (warnings === 'only') {
      query = query.where((eb) => warnedExpression(eb));
    }
    if (warnings === 'hide') {
      query = query.where((eb) => eb.not(warnedExpression(eb)));
    }
    if (referenceGone) {
      query = query.where('m.references_gone', 'is not', null);
    }
    return query;
  }

  /**
   * Active rows nobody kept, created, edited, approved, restored and read
   * before the window, filed in a scope that is not dormant; null when every
   * scope is.
   */
  private autoForget(filter: MemoryAutoForgetFilter, em: EntityManager) {
    const { before, liveScopes } = filter;
    const at = before.getTime();
    const db = this.database(em);
    const lastRead = db
      .selectFrom('memory_usage_days')
      .where('memory_usage_days.deleted_at', 'is', null)
      .where('memory_usage_days.reads', '>', 0)
      .select((eb) => [
        'memory_usage_days.memory_id',
        eb.fn.max('memory_usage_days.day').as('last_read_day'),
      ])
      .groupBy('memory_usage_days.memory_id')
      .as('r');
    const anyScope =
      liveScopes.global ||
      liveScopes.projectIds.length > 0 ||
      liveScopes.teamSlugs.length > 0;
    if (!anyScope) {
      return null;
    }
    return this.scoped({ statuses: ['active'], places: { any: true } }, em)
      .leftJoin(lastRead, (join) => join.onRef('r.memory_id', '=', 'm.id'))
      .where('m.kept_at', 'is', null)
      .where('m.created_at', '<', at)
      .where('m.updated_at', '<', at)
      .where((eb) =>
        eb.and(
          (['m.approved_at', 'm.restored_at', 'm.last_used_at'] as const).map(
            (column) => eb.or([eb(column, 'is', null), eb(column, '<', at)]),
          ),
        ),
      )
      .where((eb) =>
        eb.or([
          eb('r.last_read_day', 'is', null),
          eb('r.last_read_day', '<', usageDay(before)),
        ]),
      )
      .where((eb) =>
        eb.or([
          ...(liveScopes.global
            ? [
                eb.and([
                  eb('m.project_id', 'is', null),
                  eb('m.team_slug', 'is', null),
                ]),
              ]
            : []),
          ...(liveScopes.projectIds.length > 0
            ? [
                eb.and([
                  eb('m.project_id', 'in', [...liveScopes.projectIds]),
                  eb('m.team_slug', 'is', null),
                ]),
              ]
            : []),
          ...(liveScopes.teamSlugs.length > 0
            ? [eb('m.team_slug', 'in', [...liveScopes.teamSlugs])]
            : []),
        ]),
      );
  }

  private sorted(
    query: ReturnType<MemoryDao['review']>,
    filter: MemoryReviewFilter,
  ) {
    if (filter.tab === 'forgotten') {
      return query
        .orderBy(
          (eb) => eb.fn.coalesce('m.forgotten_at', 'm.updated_at'),
          'desc',
        )
        .orderBy('m.id', 'desc');
    }
    switch (filter.sort) {
      case 'oldestSaved':
        return query.orderBy('m.created_at').orderBy('m.id');
      case 'largest':
        return query
          .orderBy((eb) => eb.fn('length', ['m.body']), 'desc')
          .orderBy('m.id');
      case 'longestSinceRead':
        return query
          .orderBy((eb) => lastReadDayExpression(eb))
          .orderBy('m.created_at')
          .orderBy('m.id');
      case 'leastUsed':
        return query
          .orderBy((eb) => eb.fn.coalesce('u.recent_reads', eb.lit(0)))
          .orderBy((eb) => eb.fn.coalesce('u.reads', eb.lit(0)))
          .orderBy((eb) => lastReadDayExpression(eb))
          .orderBy('m.created_at')
          .orderBy('m.id');
    }
  }

  /** Live rows of the given statuses in the given scope. */
  private scoped(scope: MemoryMatchScope, em: EntityManager) {
    const query = this.database(em)
      .selectFrom('memories as m')
      .where('m.deleted_at', 'is', null)
      .where('m.status', 'in', [...scope.statuses]);
    const { places } = scope;
    if ('any' in places) {
      return query;
    }
    if ('visibleTo' in places) {
      const { projectId, teamSlug } = places.visibleTo;
      return query.where((eb) =>
        eb.or([
          eb.and([
            eb('m.project_id', 'is', null),
            eb('m.team_slug', 'is', null),
          ]),
          ...(projectId === null
            ? []
            : [
                eb.and([
                  eb('m.project_id', '=', projectId),
                  eb('m.team_slug', 'is', null),
                ]),
              ]),
          ...(teamSlug === null ? [] : [eb('m.team_slug', '=', teamSlug)]),
        ]),
      );
    }
    const { projectId, teamSlug } = places.exactly;
    return query
      .where('m.project_id', projectId === null ? 'is' : '=', projectId)
      .where('m.team_slug', teamSlug === null ? 'is' : '=', teamSlug);
  }

  /**
   * Stamp entries as read just now, outside the entity: a flush would also
   * move `updatedAt`, which means the entry's text changed.
   */
  async touch(ids: readonly string[], at: Date): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.database()
      .updateTable('memories')
      .set({ last_used_at: at.getTime() })
      .where('id', 'in', [...ids])
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
        MEMORY_TEXT_TRIGGERS.map((trigger) => trigger.name),
      )
      .execute();
    return new Set(rows.map((row) => row.name));
  }

  /** Create the FTS table when it does not exist yet. */
  async createTable(): Promise<void> {
    await this.em.getConnection().execute(CREATE_MEMORY_TEXT_TABLE, [], 'run');
  }

  /**
   * Recreate the index from `memories` and install its triggers in one
   * transaction, as `ChatSearchIndexDao.rebuild` does and for its reasons.
   */
  async rebuild(): Promise<void> {
    await this.em.fork().transactional(async (em) => {
      const connection = em.getConnection();
      const ddl = (sql: string) =>
        connection.execute(sql, [], 'run', em.getTransactionContext());
      for (const statement of DROP_RETIRED_MEMORY_TEXT_TRIGGERS) {
        await ddl(statement);
      }
      await ddl(DROP_MEMORY_TEXT_TABLE);
      await ddl(CREATE_MEMORY_TEXT_TABLE);
      await this.database(em)
        .insertInto('memories_fts')
        .columns(['rowid', 'memory_id', 'title', 'body'])
        .expression((eb) =>
          eb.selectFrom('memories').select(['rowid', 'id', 'title', 'body']),
        )
        .execute();
      for (const trigger of MEMORY_TEXT_TRIGGERS) {
        await ddl(trigger.sql);
      }
    });
  }

  private database(em = this.em) {
    return em.getKysely<MemoryTextDatabase>({ convertValues: false });
  }
}

type MemoryRow = MemoryTextDatabase['memories'];

/**
 * Whether a row carries the "looks like a rule" warning: a correction or an
 * entry about the user, one the user wrote, one whose text states a limit,
 * or one the sweep has not read yet.
 */
function warnedExpression<DB extends { m: MemoryRow }>(
  eb: ExpressionBuilder<DB, 'm'>,
): ExpressionWrapper<{ m: MemoryRow }, 'm', SqlBool> {
  const ref = eb as unknown as ExpressionBuilder<{ m: MemoryRow }, 'm'>;
  return ref.or([
    ref('m.type', 'in', ['feedback', 'user']),
    ref('m.source_actor', '=', 'user'),
    ref('m.states_rule', 'is', null),
    ref('m.states_rule', '=', 1),
  ]);
}

/**
 * An active entry a run's memory index may list: the user's own, an import's
 * or one the user approved.
 *
 * TWIN: `indexable` in `apps/daemon/src/v1/memory/services/memory.service.ts`.
 */
function reachExpression<DB extends { m: MemoryRow }>(
  eb: ExpressionBuilder<DB, 'm'>,
): ExpressionWrapper<{ m: MemoryRow }, 'm', SqlBool> {
  const ref = eb as unknown as ExpressionBuilder<{ m: MemoryRow }, 'm'>;
  return ref.and([
    ref('m.status', '=', 'active'),
    ref.or([
      ref('m.source_actor', 'in', ['user', 'import']),
      ref('m.approved_at', 'is not', null),
      ref('m.promoted_at', 'is not', null),
    ]),
  ]);
}

type ReviewRefs = { m: MemoryRow; u: { last_read_day: string | null } };

/**
 * The UTC day an entry was last read: the later of the ledger's last read
 * day and the last read stamp's day, null when it was never read.
 */
function lastReadDayExpression<DB extends ReviewRefs>(
  eb: ExpressionBuilder<DB, 'm' | 'u'>,
): ExpressionWrapper<ReviewRefs, 'm' | 'u', string | null> {
  const ref = eb as unknown as ExpressionBuilder<ReviewRefs, 'm' | 'u'>;
  const stamped = ref.fn<string | null>('strftime', [
    ref.val('%Y-%m-%d'),
    ref('m.last_used_at', '/', 1000),
    ref.val('unixepoch'),
  ]);
  return ref.fn<string | null>('max', [
    ref.fn.coalesce('u.last_read_day', stamped),
    ref.fn.coalesce(stamped, 'u.last_read_day'),
  ]);
}
