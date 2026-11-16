import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate, setTimeout } from 'node:timers/promises';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import {
  MemoryDao,
  type MemoryReviewFilter,
  type MemoryReviewHit,
} from '../dao/memory.dao';
import type { Memory } from '../entity/memory.entity';
import {
  MEMORY_AUTO_BATCH_PREFIX,
  MEMORY_BATCHES_LIMIT,
  MEMORY_EXPIRED_LESSON_BATCH_PREFIX,
  MEMORY_FORGET_BATCH_MAX,
  MEMORY_MARKS_BATCH_PREFIX,
  MEMORY_REVIEW_IDS_MAX,
  MEMORY_REVIEW_LIMIT_DEFAULT,
  MEMORY_REVIEW_MIN_AGE_DAYS,
  MEMORY_RULE_PURGE_AFTER_DAYS,
  type MemoryForgetBatch,
  type MemoryForgetBatchKind,
  type MemoryForgetBatchList,
  type MemoryReviewIds,
  type MemoryReviewPage,
  type MemoryReviewQuery,
  type MemoryReviewRow,
  type MemoryReviewSummary,
  type MemoryReviewWarningKind,
} from '../memory.types';
import { autoForgetFilterOf } from '../utils/memory-auto-forget';
import {
  confinedPath,
  pathsOf,
  referencedPathsOf,
  statesRule,
  storedPaths,
} from '../utils/memory-references';
import { DAY_MS, usageDay } from '../utils/memory-usage-day';
import { entryOf, MemoryService } from './memory.service';
import {
  MEMORY_USAGE_BACKFILL_VERSION,
  MemoryUsageService,
} from './memory-usage.service';

/** A reference check older than this is run again when the list is opened. */
export const REFERENCE_CHECK_TTL_MS = 60 * 60 * 1000;

/** How long the first page waits on a reference check before drawing without it. */
const REFERENCE_CHECK_WAIT_MS = 2000;

/** Rows the sweep reads per breath; better-sqlite3 holds the loop meanwhile. */
const SWEEP_BATCH = 200;
const SWEEP_PAUSE_MS = 10;
const REFERENCE_WINDOW = 50;

/**
 * The cleanup list's reads (`GET /v1/memories/review*`): which entries are
 * cold, kept or forgotten, with their usage summed over every row, and the
 * marks behind its warnings — whether an entry states a limit, and whether
 * the repo paths it names still exist. Writes stay in `MemoryService`.
 */
@Injectable()
export class MemoryReviewService {
  private readonly logger = new Logger(MemoryReviewService.name);
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly memories: MemoryDao,
    private readonly projects: ProjectDao,
    private readonly usage: MemoryUsageService,
    private readonly runs: RunDao,
    private readonly memory: MemoryService,
  ) {}

  /** One page of a tab; the first page refreshes reference checks gone stale. */
  async page(
    query: MemoryReviewQuery,
    now = new Date(),
  ): Promise<MemoryReviewPage> {
    if (query.cursor === undefined) {
      await Promise.race([
        this.refreshReferences(now).catch((err: unknown) =>
          this.logger.warn(
            `memory reference check failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
        setTimeout(REFERENCE_CHECK_WAIT_MS, undefined, { ref: false }),
      ]);
    }
    const filter = filterOf(query, now);
    const offset = Number(query.cursor ?? 0);
    const limit = query.limit ?? MEMORY_REVIEW_LIMIT_DEFAULT;
    const em = this.em.fork();
    const { hits, total } = await this.memories.reviewPage(
      filter,
      offset,
      limit,
      em,
    );
    const byId = new Map(
      (
        await this.memories.getByIds(
          hits.map((hit) => hit.id),
          em,
        )
      ).map((row) => [row.id, row]),
    );
    const marksPurge = this.memory.removesNotUseful;
    const rows = hits.flatMap((hit) => {
      const row = byId.get(hit.id);
      return row ? [reviewRow(row, hit, marksPurge)] : [];
    });
    const end = offset + hits.length;
    return {
      rows,
      total,
      younger:
        filter.tab === 'cold'
          ? await this.memories.reviewCount(
              { ...filter, youngerOnly: true },
              em,
            )
          : null,
      next: end < total && hits.length > 0 ? String(end) : null,
    };
  }

  /** What "Tick shown" ticks: the matching ids, rows with a warning left out. */
  ids(query: MemoryReviewQuery, now = new Date()): Promise<MemoryReviewIds> {
    return this.memories.reviewIds(
      filterOf(query, now),
      MEMORY_REVIEW_IDS_MAX,
      this.em.fork(),
    );
  }

  /**
   * The Clean up panel's figures, each counted over every row, and with
   * `autoForgetDays` what the automatic sweep with that window would take now.
   */
  async summary(
    now = new Date(),
    autoForgetDays?: number,
  ): Promise<MemoryReviewSummary> {
    const em = this.em.fork();
    const totals = await this.memories.reviewTotals(em);
    const cold = filterOf({}, now);
    const marker = this.usage.backfillMarker;
    const firstDay = await this.memories.firstUsageDay(em);
    const [newest] = await this.batchesOf(1, em);
    const lastPass =
      newest === undefined
        ? []
        : await this.batchesOf(
            MEMORY_FORGET_BATCH_MAX,
            em,
            Date.parse(newest.forgottenAt),
          );
    return {
      active: totals.active,
      pending: totals.pending,
      read: totals.read,
      neverRead: totals.active - totals.read,
      proposed: await this.memories.reviewCount(cold, em),
      proposedWithWarning: await this.memories.reviewCount(
        { ...cold, warnings: 'only' },
        em,
      ),
      younger: await this.memories.reviewCount(
        { ...cold, youngerOnly: true },
        em,
      ),
      kept: totals.kept,
      forgotten: totals.forgotten,
      minAgeDays: MEMORY_REVIEW_MIN_AGE_DAYS,
      countedSince:
        firstDay ??
        (marker === null ? null : usageDay(new Date(marker.cutoff))),
      counting:
        marker !== null && marker.doneVersion !== MEMORY_USAGE_BACKFILL_VERSION,
      lastBatch: lastPass[0] ?? null,
      lastPass,
      autoForget:
        autoForgetDays === undefined
          ? null
          : {
              days: autoForgetDays,
              ...(await this.memories.autoForgetCounts(
                await autoForgetFilterOf(autoForgetDays, now, this.runs, em),
                em,
              )),
            },
    };
  }

  /** The newest cleanups still holding forgotten entries, for their Undo. */
  async batches(): Promise<MemoryForgetBatchList> {
    return {
      batches: await this.batchesOf(MEMORY_BATCHES_LIMIT, this.em.fork()),
    };
  }

  /**
   * Check the paths project entries name against their project's folder, for
   * every entry last checked over an hour ago. Only a path the disk says does
   * not exist is gone: a folder macOS denies passes `stat` and fails on open,
   * and a missing project root (a detached disk, a moved repository) leaves
   * the entry unjudged.
   */
  refreshReferences(now = new Date()): Promise<void> {
    this.refreshing ??= this.refreshNow(now).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Read every entry the marks predate for a stated limit and the paths it
   * names. Off the ready path, in breaths; never throws.
   */
  async sweepQuietly(): Promise<void> {
    try {
      const em = this.em.fork();
      const seen = new Set<string>();
      for (;;) {
        const rows = await this.memories.unmarked(SWEEP_BATCH, em);
        const fresh = rows.filter((row) => !seen.has(row.id));
        if (fresh.length === 0) {
          return;
        }
        for (const row of fresh) {
          seen.add(row.id);
          await this.memories.mark(
            row,
            {
              statesRule: statesRule(row.title, row.body),
              referencedPaths: storedPaths(
                referencedPathsOf(row.title, row.body),
              ),
            },
            em,
          );
        }
        await setTimeout(SWEEP_PAUSE_MS);
      }
    } catch (err) {
      this.logger.warn(
        `memory marks sweep stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async refreshNow(now: Date): Promise<void> {
    const em = this.em.fork();
    const due = await this.memories.referencesDue(
      new Date(now.getTime() - REFERENCE_CHECK_TTL_MS),
      em,
    );
    if (due.length === 0) {
      return;
    }
    const folders = new Map(
      (await this.projects.getAll({}, undefined, em)).map((project) => [
        project.id,
        project.folder,
      ]),
    );
    const roots = new Map<string, Promise<boolean>>();
    for (const [n, row] of due.entries()) {
      if (n > 0 && n % REFERENCE_WINDOW === 0) {
        await setImmediate();
      }
      const folder = folders.get(row.projectId);
      const gone: string[] = [];
      if (folder !== undefined) {
        let present = roots.get(folder);
        if (present === undefined) {
          present = isDirectory(folder);
          roots.set(folder, present);
        }
        if (await present) {
          for (const path of pathsOf(row.referencedPaths)) {
            if (await isGone(folder, path)) {
              gone.push(path);
            }
          }
        }
      }
      await this.memories.setReferencesGone(row, storedPaths(gone), now, em);
    }
  }

  private async batchesOf(
    limit: number,
    em: EntityManager,
    forgottenAt?: number,
  ): Promise<MemoryForgetBatch[]> {
    const marksPurge = this.memory.removesNotUseful;
    return (await this.memories.batches(limit, em, forgottenAt)).map(
      (batch) => {
        const kind = batchKindOf(batch.batchId);
        const purged =
          kind === 'expired_lesson' || (kind === 'marks' && marksPurge);
        return {
          batchId: batch.batchId,
          count: batch.count,
          forgottenAt: new Date(batch.forgottenAt).toISOString(),
          automatic: kind === 'automatic',
          kind,
          title: batch.title,
          reason: batch.reason,
          purgeAt: purged
            ? new Date(
                batch.forgottenAt + MEMORY_RULE_PURGE_AFTER_DAYS * DAY_MS,
              ).toISOString()
            : null,
        };
      },
    );
  }
}

function batchKindOf(batchId: string): MemoryForgetBatchKind {
  if (batchId.startsWith(MEMORY_AUTO_BATCH_PREFIX)) {
    return 'automatic';
  }
  if (batchId.startsWith(MEMORY_MARKS_BATCH_PREFIX)) {
    return 'marks';
  }
  if (batchId.startsWith(MEMORY_EXPIRED_LESSON_BATCH_PREFIX)) {
    return 'expired_lesson';
  }
  return 'manual';
}

function filterOf(
  query: Partial<MemoryReviewQuery>,
  now: Date,
): MemoryReviewFilter {
  return {
    tab: query.tab ?? 'cold',
    sort: query.sort ?? 'leastUsed',
    places:
      query.scope === 'global'
        ? { exactly: { projectId: null, teamSlug: null } }
        : query.scope === 'project' && query.projectId !== undefined
          ? { exactly: { projectId: query.projectId, teamSlug: null } }
          : query.scope === 'team' && query.teamSlug !== undefined
            ? { exactly: { projectId: null, teamSlug: query.teamSlug } }
            : { any: true },
    type: query.type,
    minAgeDays: query.minAgeDays ?? MEMORY_REVIEW_MIN_AGE_DAYS,
    warnings: query.warnings ?? 'any',
    referenceGone: query.referenceGone === 'true',
    now,
  };
}

function reviewRow(
  row: Memory,
  hit: MemoryReviewHit,
  marksPurge: boolean,
): MemoryReviewRow {
  return {
    entry: entryOf(row, marksPurge),
    usage: {
      readsLast90Days: hit.readsLast90Days,
      reads: hit.reads,
      searchHits: hit.searchHits,
      indexShows: hit.indexShows,
      lastReadAt: hit.lastReadDay,
    },
    warning: warningOf(row),
    referencesGone: pathsOf(row.referencesGone),
    keptAt: row.keptAt?.toISOString() ?? null,
    forgottenAt:
      (
        row.forgottenAt ?? (row.status === 'forgotten' ? row.updatedAt : null)
      )?.toISOString() ?? null,
    forgetBatchId: row.forgetBatchId,
  };
}

/** TWIN: `warnedExpression` in `../dao/memory.dao.ts`, which filters by the same rule. */
function warningOf(row: Memory): MemoryReviewWarningKind | null {
  if (row.type === 'feedback') {
    return 'feedback';
  }
  if (row.type === 'user') {
    return 'user';
  }
  if (row.sourceActor === 'user') {
    return 'writtenByYou';
  }
  if (row.statesRule === null) {
    return 'notChecked';
  }
  return row.statesRule ? 'statesLimit' : null;
}

async function isDirectory(folder: string): Promise<boolean> {
  try {
    return (await stat(folder)).isDirectory();
  } catch {
    return false;
  }
}

async function isGone(folder: string, path: string): Promise<boolean> {
  const inside = confinedPath(path);
  if (inside === null) {
    return false;
  }
  try {
    await stat(join(folder, inside));
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}
