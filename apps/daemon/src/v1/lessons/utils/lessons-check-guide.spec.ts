import { describe, expect, it } from 'vitest';

import type { LessonTarget } from '../lessons.types';
import {
  type LessonForCheck,
  lessonsCheckBrief,
  lessonsCheckGuide,
  targetText,
} from './lessons-check-guide';

const LESSON: LessonForCheck = {
  id: 'lp-1',
  title: 'Check the cache key first',
  rule: 'Read the cache key before rerunning a failed build.',
  why: 'A run id in the key made every run miss the cache.',
  signalKind: 'user_correction',
  evidenceSeq: 6,
  evidenceQuote: 'cache key must not include the run id',
  target: { kind: 'memory', scope: 'project', type: 'feedback' },
  dedup: '{"verdict":"new","handle":null}',
};

describe('targetText', () => {
  it.each([
    [
      'a memory entry',
      { kind: 'memory', scope: 'team', type: 'feedback' },
      'memory, scope team',
    ],
    [
      'project instructions',
      { kind: 'project_instructions' },
      "the project's instructions (waits for the user's Save)",
    ],
    [
      'a member',
      { kind: 'member_instructions', memberId: 'builder' },
      "the instructions of team member builder (waits for the user's Save)",
    ],
    [
      'a new knowledge document',
      { kind: 'knowledge', handle: null },
      "a new knowledge document (waits for the user's Save)",
    ],
    [
      'an existing knowledge document',
      { kind: 'knowledge', handle: 'k-1' },
      "knowledge document k-1 (waits for the user's Save)",
    ],
  ] as const)('names %s as its place', (_, target, text) => {
    expect(targetText(target as LessonTarget)).toBe(text);
  });
});

describe('lessonsCheckBrief', () => {
  it('says where a lesson for the project instructions goes, and that it waits for the user', () => {
    const brief = lessonsCheckBrief({
      title: 'Migrate the cache',
      fromSeq: 4,
      toSeq: 9,
      lessons: [{ ...LESSON, target: { kind: 'project_instructions' } }],
    });

    expect(brief).toContain(
      `  goes to: the project's instructions (waits for the user's Save) · ${LESSON.dedup}`,
    );
    expect(brief).not.toContain('memory scope');
  });

  it('says which memory scope a memory lesson goes to', () => {
    const brief = lessonsCheckBrief({
      title: null,
      fromSeq: -1,
      toSeq: 9,
      lessons: [LESSON],
    });

    expect(brief).toContain(
      `  goes to: memory, scope project · ${LESSON.dedup}`,
    );
  });
});

describe('lessonsCheckGuide', () => {
  it('says only a new memory lesson is saved at once, and the others wait for the user', () => {
    const guide = lessonsCheckGuide(true);

    expect(guide).toContain(
      'Each new memory lesson you keep is saved to the shared memory',
    );
    expect(guide).toContain(
      'The others still wait for the user, who sees your verdict.',
    );
  });
});
