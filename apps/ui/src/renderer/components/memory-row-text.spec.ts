import { describe, expect, it } from 'vitest';

import { forgottenNoteOf, trackLineOf } from './memory-row-text';

describe('forgottenNoteOf', () => {
  it('is the reason alone when no purge day is set', () => {
    expect(
      forgottenNoteOf({
        forgetReason: 'superseded by the monorepo move',
        purgeAt: null,
      }),
    ).toBe('superseded by the monorepo move');
  });

  it('appends the purge day to the reason', () => {
    expect(
      forgottenNoteOf({
        forgetReason: '3 threads marked it not useful',
        purgeAt: '2026-12-15T12:00:00.000Z',
      }),
    ).toBe('3 threads marked it not useful · deleted for good on Dec 15');
  });

  it('names the purge day alone when the entry was forgotten with no reason', () => {
    expect(
      forgottenNoteOf({
        forgetReason: null,
        purgeAt: '2026-12-15T12:00:00.000Z',
      }),
    ).toBe('Deleted for good on Dec 15');
  });

  it('is null when there is neither a reason nor a purge day', () => {
    expect(forgottenNoteOf({ forgetReason: null, purgeAt: null })).toBeNull();
  });
});

describe('trackLineOf', () => {
  it('reads the four figures in order', () => {
    expect(
      trackLineOf({
        memoryId: 'm',
        indexShows: 3,
        reads: 2,
        helped: 1,
        notUseful: 0,
      }),
    ).toBe('Shown in 3 runs · read 2 · helped 1 · not useful 0');
  });

  it('names a single run in the singular', () => {
    expect(
      trackLineOf({
        memoryId: 'm',
        indexShows: 1,
        reads: 0,
        helped: 0,
        notUseful: 0,
      }),
    ).toBe('Shown in 1 run · read 0 · helped 0 · not useful 0');
  });

  it('is null while none of the four figures is above zero', () => {
    expect(
      trackLineOf({
        memoryId: 'm',
        indexShows: 0,
        reads: 0,
        helped: 0,
        notUseful: 0,
      }),
    ).toBeNull();
  });

  it('still reads a figure of zero beside one that is above it', () => {
    expect(
      trackLineOf({
        memoryId: 'm',
        indexShows: 0,
        reads: 0,
        helped: 0,
        notUseful: 2,
      }),
    ).toBe('Shown in 0 runs · read 0 · helped 0 · not useful 2');
  });
});
