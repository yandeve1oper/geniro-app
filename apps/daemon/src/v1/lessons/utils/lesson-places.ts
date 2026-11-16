import type { Run } from '../../runs/entity/run.entity';
import {
  baseTeamSnapshotOf,
  parseTeamSnapshot,
} from '../../teams/utils/team-snapshot';
import type { LessonPlaces } from '../lessons.types';

/** What a thread has a place for: its project, and its team run's members. */
export function placesOfRun(
  place: { projectId: string | null; teamSlug: string | null },
  source: Pick<Run, 'teamSnapshot' | 'teamBaseSnapshot'> | null,
): LessonPlaces {
  const reading =
    source === null || place.teamSlug === null
      ? null
      : parseTeamSnapshot(baseTeamSnapshotOf(source));
  return {
    project: place.projectId !== null,
    team: place.teamSlug !== null,
    projectId: place.projectId,
    members:
      reading?.state === 'readable'
        ? reading.team.members.map(({ id, name }) => ({ id, name }))
        : [],
  };
}
