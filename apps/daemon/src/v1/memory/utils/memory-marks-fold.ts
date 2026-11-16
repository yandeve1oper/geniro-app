import {
  MEMORY_MARKS_FORGET_THRESHOLD,
  MEMORY_PROMOTE_HELPED_THREADS,
  type MemoryCountedMark,
} from '../memory.types';

/** What the threads that marked one entry say, one vote each. */
export interface MemoryMarkTally {
  helped: number;
  notUseful: number;
  /** The threads counted as not useful, oldest mark first, with the reason each gave. */
  notUsefulThreads: { threadId: string; reason: string }[];
}

/** Threads a forget reason names before it says how many more. */
const MARKS_REASON_THREADS_MAX = 5;

const EMPTY: MemoryMarkTally = {
  helped: 0,
  notUseful: 0,
  notUsefulThreads: [],
};

/**
 * One vote per thread and entry, its newest mark winning whichever source
 * made it (an agent's feedback or a reflection's effect); `misleading`
 * counts as not useful, and a newest `broken` leaves the thread without a
 * vote. Marks must come oldest first.
 */
export function tallyMarks(
  marks: readonly MemoryCountedMark[],
): Map<string, MemoryMarkTally> {
  const latest = new Map<string, Map<string, MemoryCountedMark>>();
  for (const mark of marks) {
    const threads = latest.get(mark.memoryId) ?? new Map();
    threads.delete(mark.threadId);
    threads.set(mark.threadId, mark);
    latest.set(mark.memoryId, threads);
  }
  const tallies = new Map<string, MemoryMarkTally>();
  for (const [memoryId, threads] of latest) {
    const votes = [...threads.values()].filter(
      (mark) => mark.verdict !== 'broken',
    );
    const against = votes.filter((mark) => mark.verdict !== 'helped');
    tallies.set(memoryId, {
      helped: votes.length - against.length,
      notUseful: against.length,
      notUsefulThreads: against.map((mark) => ({
        threadId: mark.threadId,
        reason: mark.reason,
      })),
    });
  }
  return tallies;
}

export function tallyOf(
  tallies: ReadonlyMap<string, MemoryMarkTally>,
  memoryId: string,
): MemoryMarkTally {
  return tallies.get(memoryId) ?? EMPTY;
}

/** Each helped thread cancels one not-useful thread. */
export function forgetsByMarks(tally: MemoryMarkTally): boolean {
  return tally.notUseful - tally.helped >= MEMORY_MARKS_FORGET_THRESHOLD;
}

export function promotesLesson(tally: MemoryMarkTally): boolean {
  return tally.helped >= MEMORY_PROMOTE_HELPED_THREADS && tally.notUseful === 0;
}

/**
 * The forget reason the user reads in Recent cleanups and the Forgotten list:
 * how many threads, then the title and reason of the first few.
 */
export function marksForgetReason(
  tally: MemoryMarkTally,
  titleOf: (threadId: string) => string | null,
): string {
  const count = tally.notUsefulThreads.length;
  const named = tally.notUsefulThreads
    .slice(0, MARKS_REASON_THREADS_MAX)
    .map(({ threadId, reason }) => {
      const title = titleOf(threadId);
      return `${title === null ? 'a deleted thread' : `“${title}”`} — ${reason}`;
    })
    .join('; ');
  const more = count - MARKS_REASON_THREADS_MAX;
  return `${count} thread${count === 1 ? '' : 's'} marked it not useful: ${named}${more > 0 ? `; and ${more} more` : ''}`;
}
