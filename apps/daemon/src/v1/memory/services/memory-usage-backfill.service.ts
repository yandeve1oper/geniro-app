import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { PAYLOAD_REFS_VERSION } from '../../agents/utils/payload-refs';
import type { Run } from '../../runs/entity/run.entity';
import { MemoryDao } from '../dao/memory.dao';
import { MemoryUsageDao } from '../dao/memory-usage.dao';
import type { MemoryUsageCount } from '../memory.types';
import { indexHandlesOf } from '../utils/memory-text';
import { usageDay } from '../utils/memory-usage-day';
import { runMemoryUsage } from '../utils/memory-usage-history';
import {
  MEMORY_USAGE_BACKFILL_VERSION,
  MemoryUsageService,
} from './memory-usage.service';

/**
 * A breath between runs: the pass runs while the daemon serves, and
 * better-sqlite3 is synchronous, so the event loop turns only between runs.
 */
const RUN_PAUSE_MS = 10;

type BackfillRun = Pick<
  Run,
  'id' | 'createdAt' | 'memoryIndex' | 'payloadRefsVersion'
>;

/**
 * Counts the memory use agents made before the usage ledger existed, from the
 * only place it is still recorded: each run's stored memory calls and its
 * memory index. Only what happened before the cutoff (`MemoryUsageService`) is
 * counted, so nothing live counting has counted is counted again.
 *
 * Each run's counts and its `memory_usage_backfill` row commit together, and
 * a run with that row is never read again, so a pass killed at any point and
 * run again counts every use once. The pass retires through the marker once
 * every run is counted; a run it had to pass over (its payload columns not
 * stamped yet, or a failure) keeps it running on the next launch.
 */
@Injectable()
export class MemoryUsageBackfillService {
  private readonly logger = new Logger(MemoryUsageBackfillService.name);

  constructor(
    private readonly usage: MemoryUsageService,
    private readonly usageDao: MemoryUsageDao,
    private readonly memories: MemoryDao,
    private readonly runs: RunDao,
    private readonly items: ItemDao,
    private readonly em: EntityManager,
  ) {}

  /** The boot entry point, off the ready path. Never throws. */
  async runQuietly(): Promise<void> {
    try {
      const marker = this.usage.backfillMarker;
      if (
        marker === null ||
        marker.doneVersion === MEMORY_USAGE_BACKFILL_VERSION
      ) {
        return;
      }
      const startedAt = Date.now();
      const cutoff = new Date(marker.cutoff);
      const em = this.em.fork();
      const counted = await this.usageDao.backfilledRunIds(em);
      const pending = (await this.runs.listCreatedBefore(cutoff, em)).filter(
        (run) => !counted.has(run.id),
      );
      const idsByHandle = await this.memories.idsByHandle(em);
      let passedOver = 0;
      for (const run of pending) {
        if (run.payloadRefsVersion !== PAYLOAD_REFS_VERSION) {
          passedOver += 1;
          continue;
        }
        try {
          await this.countRun(run, cutoff, idsByHandle);
        } catch (err) {
          passedOver += 1;
          this.logger.warn(
            `memory usage of run ${run.id} not counted: ${errorText(err)}`,
          );
        }
        await pause();
      }
      if (passedOver === 0) {
        await this.usage.markBackfilled();
        this.logger.log(
          `memory usage backfill counted ${pending.length} run(s) in ${
            Date.now() - startedAt
          }ms`,
        );
      } else {
        this.logger.log(
          `memory usage backfill passed over ${passedOver} run(s); it runs again next launch`,
        );
      }
    } catch (err) {
      this.logger.warn(`memory usage backfill failed: ${errorText(err)}`);
    }
  }

  private async countRun(
    run: BackfillRun,
    cutoff: Date,
    idsByHandle: ReadonlyMap<string, string>,
  ): Promise<void> {
    const em = this.em.fork();
    const counts: MemoryUsageCount[] = [
      ...(await runMemoryUsage(this.items, run.id, idsByHandle, cutoff, em)),
      ...indexShowsOf(run, idsByHandle),
    ];
    await em.transactional(async (tx) => {
      await this.usageDao.add(counts, tx);
      await this.usageDao.markBackfilled(run.id, tx);
    });
  }
}

/** One show of each entry the run's stored memory index lists, on the day it was created. */
function indexShowsOf(
  run: BackfillRun,
  idsByHandle: ReadonlyMap<string, string>,
): MemoryUsageCount[] {
  if (run.memoryIndex === null) {
    return [];
  }
  const day = usageDay(run.createdAt);
  return [...new Set(indexHandlesOf(run.memoryIndex))].flatMap((handle) => {
    const memoryId = idsByHandle.get(handle);
    return memoryId === undefined
      ? []
      : [{ memoryId, day, reads: 0, searchHits: 0, indexShows: 1 }];
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, RUN_PAUSE_MS);
  });
}
