import type { LessonOverride } from '../../projects/projects.types';
import type { LessonReflectionMode } from '../lessons.types';

/**
 * Whether reflections run on a thread: the app's Off always wins; otherwise
 * the team's own setting, else the project's, else the app's.
 */
export function offersLessons(
  appMode: LessonReflectionMode,
  project: LessonOverride | null,
  team: LessonOverride | null,
): boolean {
  if (appMode === 'off') {
    return false;
  }
  const own = team ?? project;
  return own === null ? true : own === 'on';
}

/** The `lessons` field of a run's team copy, or null when it has none or is no team run. */
export function teamLessonsOverrideOf(
  teamSnapshot: string | null,
): LessonOverride | null {
  if (teamSnapshot === null) {
    return null;
  }
  try {
    const team: unknown = JSON.parse(teamSnapshot);
    const value =
      typeof team === 'object' && team !== null
        ? (team as Record<string, unknown>).lessons
        : undefined;
    return value === 'on' || value === 'off' ? value : null;
  } catch {
    return null;
  }
}
