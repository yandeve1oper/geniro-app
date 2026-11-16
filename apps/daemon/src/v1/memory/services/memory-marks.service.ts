import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { MemoryMarkDao } from '../dao/memory-mark.dao';
import { MemoryUsageDao } from '../dao/memory-usage.dao';
import {
  MEMORY_MARKS_WINDOW_DAYS,
  type MemoryMarkInput,
  type MemoryTrackRecord,
} from '../memory.types';
import {
  type MemoryMarkTally,
  tallyMarks,
  tallyOf,
} from '../utils/memory-marks-fold';
import { indexHandlesOf } from '../utils/memory-text';
import { DAY_MS } from '../utils/memory-usage-day';
import { runMemoryUsage } from '../utils/memory-usage-history';

/**
 * Agents' marks on shared-memory entries: whether a run may mark an entry,
 * what each entry's marks add up to, and its track record. The writes and
 * the forgetting they lead to are `MemoryService`'s, which serializes them.
 */
@Injectable()
export class MemoryMarksService {
  constructor(
    private readonly marks: MemoryMarkDao,
    private readonly usage: MemoryUsageDao,
    private readonly runs: RunDao,
    private readonly items: ItemDao,
  ) {}

  /**
   * How a run had the entry in front of it: returned by one of its own
   * `memory_read` calls (`read`, already counted as a use), only listed in
   * the memory index it was created with (`index`), or not at all. A search
   * hit alone is not enough — the run saw only its title.
   */
  async seenIn(
    runId: string,
    entry: { id: string; handle: string },
    em: EntityManager,
  ): Promise<'read' | 'index' | null> {
    const run = await this.runs.getById(runId, em);
    if (run === null) {
      return null;
    }
    if ((await this.readIn(runId, [entry], em)).has(entry.id)) {
      return 'read';
    }
    return listedIn(run.memoryIndex).has(entry.handle) ? 'index' : null;
  }

  /** Which of these entries the run had in front of it, by {@link seenIn}'s rule. */
  async seenBy(
    runId: string,
    entries: readonly { id: string; handle: string }[],
    em: EntityManager,
  ): Promise<Set<string>> {
    const run = await this.runs.getById(runId, em);
    if (run === null || entries.length === 0) {
      return new Set();
    }
    const listed = listedIn(run.memoryIndex);
    const seen = new Set(
      entries.filter((entry) => listed.has(entry.handle)).map((e) => e.id),
    );
    if (seen.size === entries.length) {
      return seen;
    }
    for (const id of await this.readIn(runId, entries, em)) {
      seen.add(id);
    }
    return seen;
  }

  /** The entries the run's own `memory_read` calls returned. */
  private async readIn(
    runId: string,
    entries: readonly { id: string; handle: string }[],
    em: EntityManager,
  ): Promise<Set<string>> {
    const used = await runMemoryUsage(
      this.items,
      runId,
      new Map(entries.map((entry) => [entry.handle, entry.id])),
      new Date(Date.now() + 1),
      em,
    );
    return new Set(
      used.filter((count) => count.reads > 0).map((count) => count.memoryId),
    );
  }

  deleteFor(memoryId: string, em: EntityManager): Promise<void> {
    return this.marks.deleteFor(memoryId, em);
  }

  record(input: MemoryMarkInput, at: Date, em: EntityManager): Promise<void> {
    return this.marks.record(input, at, em);
  }

  /**
   * What the counted marks of these entries — or of every active entry, with
   * null — add up to at `now`.
   */
  async tallies(
    memoryIds: readonly string[] | null,
    now: Date,
    em: EntityManager,
  ): Promise<Map<string, MemoryMarkTally>> {
    const since = new Date(now.getTime() - MEMORY_MARKS_WINDOW_DAYS * DAY_MS);
    return tallyMarks(await this.marks.counted(memoryIds, since, em));
  }

  /** The titles of these threads; a deleted thread is missing from the map. */
  async threadTitles(
    threadIds: readonly string[],
    em: EntityManager,
  ): Promise<Map<string, string | null>> {
    const titles = new Map<string, string | null>();
    for (const id of new Set(threadIds)) {
      const run = await this.runs.getById(id, em);
      if (run !== null) {
        titles.set(id, run.title);
      }
    }
    return titles;
  }

  /** One track record per entry, in the order asked. */
  async trackRecords(
    memoryIds: readonly string[],
    now: Date,
    em: EntityManager,
  ): Promise<MemoryTrackRecord[]> {
    if (memoryIds.length === 0) {
      return [];
    }
    const days = await this.usage.daysOf(memoryIds, em);
    const tallies = await this.tallies(memoryIds, now, em);
    const totals = new Map<string, { indexShows: number; reads: number }>();
    for (const day of days) {
      const total = totals.get(day.memoryId) ?? { indexShows: 0, reads: 0 };
      total.indexShows += day.indexShows;
      total.reads += day.reads;
      totals.set(day.memoryId, total);
    }
    return memoryIds.map((memoryId) => {
      const tally = tallyOf(tallies, memoryId);
      const total = totals.get(memoryId);
      return {
        memoryId,
        indexShows: total?.indexShows ?? 0,
        reads: total?.reads ?? 0,
        helped: tally.helped,
        notUseful: tally.notUseful,
      };
    });
  }
}

function listedIn(memoryIndex: string | null): Set<string> {
  return new Set(memoryIndex === null ? [] : indexHandlesOf(memoryIndex));
}
