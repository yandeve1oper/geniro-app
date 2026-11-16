import { describe, expect, it } from 'vitest';

import {
  memberQuestionIds,
  readMemberQuestions,
  serializeMemberQuestions,
} from './team-member-questions';

const CARD = {
  kind: 'question' as const,
  requestId: 'card-1',
  title: 'Storage',
  questions: [
    { question: 'Which database?', options: [{ label: 'Postgres' }] },
  ],
};

describe('team member questions column', () => {
  it('reads back what it wrote, one entry per member', () => {
    const value = serializeMemberQuestions([
      { memberId: 'worker', card: CARD },
      {
        memberId: 'other',
        card: { ...CARD, requestId: 'card-2', title: null },
      },
    ]);
    expect(readMemberQuestions(value)).toEqual([
      { memberId: 'worker', card: CARD },
      {
        memberId: 'other',
        card: { ...CARD, requestId: 'card-2', title: null },
      },
    ]);
  });

  it('writes nothing for no cards', () => {
    expect(serializeMemberQuestions([])).toBeNull();
  });

  it('drops an entry that no longer reads but still names its id, so it can be closed', () => {
    const value = JSON.stringify([
      {
        memberId: 'worker',
        kind: 'question',
        requestId: 'card-1',
        questions: [],
      },
      {
        kind: 'question',
        requestId: 'card-2',
        title: null,
        questions: CARD.questions,
      },
      'garbage',
    ]);
    expect(readMemberQuestions(value)).toEqual([]);
    expect(memberQuestionIds(value)).toEqual(['card-1', 'card-2']);
  });

  it('reads an unparseable column as empty', () => {
    expect(readMemberQuestions('{not json')).toEqual([]);
    expect(memberQuestionIds('{not json')).toEqual([]);
  });
});
