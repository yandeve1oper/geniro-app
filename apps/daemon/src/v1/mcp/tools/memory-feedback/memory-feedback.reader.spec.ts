import { describe, expect, it } from 'vitest';

import {
  memoryFeedbackResultText,
  readMemoryFeedbackArgs,
} from './memory-feedback.reader';

describe('readMemoryFeedbackArgs', () => {
  it('needs a handle, a verdict and a reason', () => {
    expect(
      readMemoryFeedbackArgs({
        id: 'm3',
        verdict: 'helped',
        reason: 'the rule saved a migration',
      }),
    ).toEqual({
      ok: true,
      query: {
        id: 'm3',
        verdict: 'helped',
        reason: 'the rule saved a migration',
      },
    });
    expect(readMemoryFeedbackArgs({ id: 'm3', verdict: 'helped' }).ok).toBe(
      false,
    );
    expect(readMemoryFeedbackArgs({ verdict: 'helped', reason: 'x' }).ok).toBe(
      false,
    );
  });

  it('accepts only the three verdicts an agent may give', () => {
    for (const verdict of ['helped', 'not_useful', 'misleading']) {
      expect(
        readMemoryFeedbackArgs({ id: 'm3', verdict, reason: 'x' }).ok,
      ).toBe(true);
    }
    expect(
      readMemoryFeedbackArgs({ id: 'm3', verdict: 'broken', reason: 'x' }).ok,
    ).toBe(false);
  });
});

describe('memoryFeedbackResultText', () => {
  it('says what was marked, in the words of the verdict', () => {
    expect(
      memoryFeedbackResultText({
        kind: 'marked',
        handle: 'm12',
        verdict: 'helped',
        forgotten: false,
      }),
    ).toEqual({ text: 'Marked m12 helped.', isError: false });
    expect(
      memoryFeedbackResultText({
        kind: 'marked',
        handle: 'm12',
        verdict: 'not_useful',
        forgotten: false,
      }),
    ).toEqual({ text: 'Marked m12 not useful.', isError: false });
    expect(
      memoryFeedbackResultText({
        kind: 'marked',
        handle: 'm12',
        verdict: 'misleading',
        forgotten: false,
      }),
    ).toEqual({ text: 'Marked m12 misleading.', isError: false });
  });

  it('tells the agent the entry is gone once enough threads found it not useful', () => {
    expect(
      memoryFeedbackResultText({
        kind: 'marked',
        handle: 'm12',
        verdict: 'not_useful',
        forgotten: true,
      }),
    ).toEqual({
      text: 'Marked m12 not useful. Enough threads found it not useful, so no agent sees it any more; the user can bring it back.',
      isError: false,
    });
  });

  it('reports a refusal as its code and reason, as an error', () => {
    expect(
      memoryFeedbackResultText({
        kind: 'refused',
        code: 'NOT_SEEN',
        reason: 'm12 was not in front of this thread',
      }),
    ).toEqual({
      text: 'NOT_SEEN: m12 was not in front of this thread',
      isError: true,
    });
  });
});
