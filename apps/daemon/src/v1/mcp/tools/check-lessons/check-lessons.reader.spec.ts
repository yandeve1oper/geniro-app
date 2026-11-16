import { describe, expect, it } from 'vitest';

import {
  checkLessonsResultText,
  readCheckLessons,
} from './check-lessons.reader';

const KEEP = { proposalId: 'p1', verdict: 'keep', reason: 'Passes all gates.' };
const REWRITE = {
  proposalId: 'p2',
  verdict: 'rewrite',
  reason: 'Too vague as written.',
  rewrite: { title: 'WHEN X → DO Y', rule: 'Do Y when X happens.' },
};

describe('readCheckLessons', () => {
  it('reads keep, rewrite and drop verdicts', () => {
    const drop = { proposalId: 'p3', verdict: 'drop', reason: 'One-off.' };

    expect(readCheckLessons({ verdicts: [KEEP, REWRITE, drop] })).toEqual({
      ok: true,
      query: { verdicts: [KEEP, REWRITE, drop] },
    });
  });

  it('refuses an unknown field at the top level and inside a verdict', () => {
    expect(readCheckLessons({ verdicts: [], run_id: 'run-a' }).ok).toBe(false);
    expect(readCheckLessons({ verdicts: [{ ...KEEP, score: 5 }] }).ok).toBe(
      false,
    );
    expect(
      readCheckLessons({
        verdicts: [
          {
            ...REWRITE,
            rewrite: { ...REWRITE.rewrite, why: 'extra' },
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it('refuses a verdict that is not keep, rewrite or drop', () => {
    expect(
      readCheckLessons({ verdicts: [{ ...KEEP, verdict: 'approve' }] }).ok,
    ).toBe(false);
  });

  it('refuses a verdict with no proposal id or no reason', () => {
    expect(
      readCheckLessons({ verdicts: [{ verdict: 'keep', reason: 'ok' }] }).ok,
    ).toBe(false);
    expect(
      readCheckLessons({ verdicts: [{ proposalId: 'p1', verdict: 'keep' }] })
        .ok,
    ).toBe(false);
    expect(
      readCheckLessons({ verdicts: [{ ...KEEP, proposalId: '' }] }).ok,
    ).toBe(false);
  });

  it('refuses a rewrite with an empty title or rule, and a call without verdicts', () => {
    expect(
      readCheckLessons({
        verdicts: [{ ...REWRITE, rewrite: { title: '', rule: 'r' } }],
      }).ok,
    ).toBe(false);
    expect(
      readCheckLessons({
        verdicts: [{ ...REWRITE, rewrite: { title: 't', rule: '' } }],
      }).ok,
    ).toBe(false);
    expect(readCheckLessons({}).ok).toBe(false);
  });
});

describe('checkLessonsResultText', () => {
  it('lists every refusal code and says nothing was recorded', () => {
    const result = checkLessonsResultText({
      status: 'refused',
      problems: [
        { code: 'UNKNOWN_LESSON', reason: 'verdicts[0]: x is not listed' },
        { code: 'MISSING_VERDICT', reason: 'no verdict for p2' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Nothing was recorded\./);
    expect(result.text).toContain(
      '- UNKNOWN_LESSON: verdicts[0]: x is not listed',
    );
    expect(result.text).toContain('- MISSING_VERDICT: no verdict for p2');
  });

  it('counts the kept and dropped lessons without an error', () => {
    const result = checkLessonsResultText({
      status: 'recorded',
      kept: 2,
      dropped: 1,
    });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('Recorded: 2 kept, 1 dropped.');
  });

  it('tells the check to say its verdicts in the reply when they cannot be recorded', () => {
    const result = checkLessonsResultText({
      status: 'unavailable',
      reason: 'the turn ended',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('the turn ended');
    expect(result.text).toContain('Say them in your reply instead.');
  });
});
