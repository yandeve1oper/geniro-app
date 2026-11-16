import { describe, expect, it } from 'vitest';

import {
  proposeLessonsResultText,
  readProposeLessons,
} from './propose-lessons.reader';

const LESSON = {
  title: "WHEN a check fails → DON'T retry it unchanged",
  rule: 'Rerun a failing check only after changing what it exercises.',
  why: 'The same failing check was retried three times with no change.',
  signalKind: 'error_then_success',
  evidence: { seq: 6, quote: 'use pnpm not npm' },
  target: { kind: 'memory', scope: 'project', type: 'feedback' },
  dedup: { verdict: 'new', handle: null },
};

describe('readProposeLessons', () => {
  it('reads a lessons call of valid lessons', () => {
    expect(readProposeLessons({ lessons: [LESSON] })).toEqual({
      ok: true,
      query: { lessons: [LESSON] },
    });
  });

  it('refuses an unknown field at the top level and inside a lesson', () => {
    expect(readProposeLessons({ lessons: [], run_id: 'run-a' }).ok).toBe(false);
    expect(
      readProposeLessons({
        lessons: [{ ...LESSON, evidence: { ...LESSON.evidence, row: 6 } }],
      }).ok,
    ).toBe(false);
  });
});

describe('proposeLessonsResultText', () => {
  it('lists every refusal code, and says nothing was recorded', () => {
    const result = proposeLessonsResultText({
      status: 'refused',
      problems: [
        { code: 'TOO_LONG', reason: 'title is over 120 characters' },
        { code: 'QUOTE_NOT_FOUND', reason: 'the quote is not in row 6' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Nothing was recorded\./);
    expect(result.text).toContain('- TOO_LONG: title is over 120 characters');
    expect(result.text).toContain(
      '- QUOTE_NOT_FOUND: the quote is not in row 6',
    );
  });

  it('answers a reflection that found nothing without an error', () => {
    expect(proposeLessonsResultText({ status: 'recorded', count: 0 })).toEqual({
      text: 'Recorded: no lessons from this stretch. Say in one or two sentences why none passed.',
      isError: false,
    });
  });

  it('counts the lessons recorded, singular and plural', () => {
    expect(
      proposeLessonsResultText({ status: 'recorded', count: 1 }).text,
    ).toMatch(/^1 lesson recorded /);
    expect(
      proposeLessonsResultText({ status: 'recorded', count: 2 }).text,
    ).toMatch(/^2 lessons recorded /);
  });

  it('tells the reflection to reply in its own words when the thread is unreachable', () => {
    expect(
      proposeLessonsResultText({
        status: 'unavailable',
        reason: 'no reflection is waiting for a call',
      }),
    ).toEqual({
      text: 'The lessons could not be recorded (no reflection is waiting for a call). Say them in your reply instead.',
      isError: true,
    });
  });
});
