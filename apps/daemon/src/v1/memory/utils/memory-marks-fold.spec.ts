import { describe, expect, it } from 'vitest';

import type { MemoryCountedMark, MemoryFeedbackVerdict } from '../memory.types';
import {
  forgetsByMarks,
  marksForgetReason,
  type MemoryMarkTally,
  promotesLesson,
  tallyMarks,
  tallyOf,
} from './memory-marks-fold';

function mark(
  memoryId: string,
  threadId: string,
  verdict: MemoryFeedbackVerdict,
  at: number,
  reason = `reason ${threadId}`,
): MemoryCountedMark {
  return { memoryId, threadId, verdict, reason, at };
}

function tally(helped: number, notUseful: number): MemoryMarkTally {
  return {
    helped,
    notUseful,
    notUsefulThreads: Array.from({ length: notUseful }, (_, i) => ({
      threadId: `t${i}`,
      reason: `r${i}`,
    })),
  };
}

describe('tallyMarks', () => {
  it('counts one vote per thread, the newest mark of a thread winning across the agent and the reflection', () => {
    const tallies = tallyMarks([
      mark('m1', 't1', 'not_useful', 1),
      mark('m1', 't1', 'helped', 2),
      mark('m1', 't2', 'helped', 3),
      mark('m1', 't2', 'not_useful', 4),
      mark('m1', 't3', 'helped', 5),
    ]);

    expect(tallyOf(tallies, 'm1')).toMatchObject({
      helped: 2,
      notUseful: 1,
      notUsefulThreads: [{ threadId: 't2', reason: 'reason t2' }],
    });
  });

  it('counts misleading as not useful, with the reason the thread gave', () => {
    const tallies = tallyMarks([
      mark('m1', 't1', 'misleading', 1, 'the flag was renamed'),
    ]);

    expect(tallyOf(tallies, 'm1')).toEqual({
      helped: 0,
      notUseful: 1,
      notUsefulThreads: [{ threadId: 't1', reason: 'the flag was renamed' }],
    });
  });

  it('keeps each entry’s votes apart, and answers an unmarked entry with nothing', () => {
    const tallies = tallyMarks([
      mark('m1', 't1', 'helped', 1),
      mark('m2', 't1', 'not_useful', 2),
    ]);

    expect(tallyOf(tallies, 'm1')).toMatchObject({ helped: 1, notUseful: 0 });
    expect(tallyOf(tallies, 'm2')).toMatchObject({ helped: 0, notUseful: 1 });
    expect(tallyOf(tallies, 'm9')).toEqual({
      helped: 0,
      notUseful: 0,
      notUsefulThreads: [],
    });
  });
});

describe('forgetsByMarks', () => {
  it('forgets at a net of three not-useful threads, not two', () => {
    expect(forgetsByMarks(tally(0, 2))).toBe(false);
    expect(forgetsByMarks(tally(0, 3))).toBe(true);
  });

  it('lets each helped thread cancel one not-useful thread', () => {
    expect(forgetsByMarks(tally(1, 3))).toBe(false);
    expect(forgetsByMarks(tally(2, 4))).toBe(false);
    expect(forgetsByMarks(tally(1, 4))).toBe(true);
  });
});

describe('promotesLesson', () => {
  it('promotes a lesson helped by two threads and not marked not useful by any', () => {
    expect(promotesLesson(tally(2, 0))).toBe(true);
    expect(promotesLesson(tally(1, 0))).toBe(false);
    expect(promotesLesson(tally(2, 1))).toBe(false);
  });
});

describe('marksForgetReason', () => {
  it('names the count, then each not-useful thread by its title and reason', () => {
    const condemned: MemoryMarkTally = {
      helped: 0,
      notUseful: 2,
      notUsefulThreads: [
        { threadId: 't1', reason: 'wrong flag' },
        { threadId: 't2', reason: 'stale path' },
      ],
    };

    expect(
      marksForgetReason(condemned, (threadId) => `Thread ${threadId}`),
    ).toBe(
      '2 threads marked it not useful: “Thread t1” — wrong flag; “Thread t2” — stale path',
    );
  });

  it('uses the singular for one thread', () => {
    const condemned = tally(0, 1);

    expect(marksForgetReason(condemned, () => 'Fix the build')).toBe(
      '1 thread marked it not useful: “Fix the build” — r0',
    );
  });

  it('calls a thread whose title is gone a deleted thread', () => {
    const condemned: MemoryMarkTally = {
      helped: 0,
      notUseful: 1,
      notUsefulThreads: [{ threadId: 'gone', reason: 'wrong flag' }],
    };

    expect(marksForgetReason(condemned, () => null)).toBe(
      '1 thread marked it not useful: a deleted thread — wrong flag',
    );
  });
});
