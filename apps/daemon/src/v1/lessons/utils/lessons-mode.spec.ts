import { describe, expect, it } from 'vitest';

import type { LessonOverride } from '../../projects/projects.types';
import { offersLessons, teamLessonsOverrideOf } from './lessons-mode';

describe('offersLessons', () => {
  it.each<[LessonOverride | null, LessonOverride | null, boolean]>([
    [null, null, true],
    ['on', null, true],
    ['off', null, false],
    [null, 'on', true],
    [null, 'off', false],
    ['off', 'on', true],
    ['on', 'off', false],
    ['on', 'on', true],
    ['off', 'off', false],
  ])(
    'with the app on: project %s and team %s → %s (the team wins)',
    (project, team, expected) => {
      expect(offersLessons('auto', project, team)).toBe(expected);
    },
  );

  it.each<[LessonOverride | null, LessonOverride | null]>([
    [null, null],
    ['on', null],
    [null, 'on'],
    ['on', 'on'],
    ['off', 'on'],
  ])(
    'with the app off, nothing is offered whatever project %s and team %s say',
    (project, team) => {
      expect(offersLessons('off', project, team)).toBe(false);
    },
  );
});

describe('teamLessonsOverrideOf', () => {
  it.each([
    ['no team snapshot', null, null],
    ['a snapshot that is not JSON', '{not json', null],
    ['a snapshot that is JSON null', 'null', null],
    ['a snapshot that is a list', '[{"lessons":"on"}]', null],
    ['a snapshot with no lessons field', '{"name":"t"}', null],
    ['a snapshot with an unknown value', '{"lessons":"maybe"}', null],
    ['a snapshot that says on', '{"lessons":"on"}', 'on'],
    ['a snapshot that says off', '{"name":"t","lessons":"off"}', 'off'],
  ] as const)('reads %s as %s', (_, snapshot, expected) => {
    expect(teamLessonsOverrideOf(snapshot)).toBe(expected);
  });
});
