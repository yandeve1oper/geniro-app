import { describe, expect, it } from 'vitest';

import { LessonProposalListQuerySchema } from './lessons.types';

describe('LessonProposalListQuerySchema', () => {
  it('reads a status list the query parser split at its commas as the comma list', () => {
    expect(
      LessonProposalListQuerySchema.parse({
        status: ['proposed', 'check_failed'],
      }),
    ).toEqual({ status: 'proposed,check_failed' });
  });

  it('keeps an encoded comma list and an absent status as they are', () => {
    expect(
      LessonProposalListQuerySchema.parse({ status: 'proposed,check_failed' }),
    ).toEqual({ status: 'proposed,check_failed' });
    expect(LessonProposalListQuerySchema.parse({})).toEqual({});
  });
});
