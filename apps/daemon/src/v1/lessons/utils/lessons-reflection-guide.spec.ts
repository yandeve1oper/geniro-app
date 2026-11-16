import { describe, expect, it } from 'vitest';

import type { LessonPlaces } from '../lessons.types';
import {
  lessonsReflectionBrief,
  lessonsReflectionGuide,
} from './lessons-reflection-guide';

const TEAM_RUN: LessonPlaces = {
  project: true,
  team: true,
  projectId: 'p1',
  members: [
    { id: 'builder', name: 'Builder' },
    { id: 'reviewer', name: 'Reviewer' },
  ],
};

const NO_PLACE: LessonPlaces = {
  project: false,
  team: false,
  projectId: null,
  members: [],
};

function briefOf(places: LessonPlaces): string {
  return lessonsReflectionBrief({
    title: 'Migrate the cache',
    fromSeq: 4,
    toSeq: 9,
    signals: [],
    rejected: [],
    places,
  });
}

describe('lessonsReflectionBrief', () => {
  it('lists the members of a team run, each with the id a member_instructions target names', () => {
    const brief = briefOf(TEAM_RUN);

    expect(brief).toContain(
      'This is a team run. Its members, for a member_instructions target:',
    );
    expect(brief).toContain('- builder · "Builder"');
    expect(brief).toContain('- reviewer · "Reviewer"');
    expect(brief).toContain(
      'Targets this thread accepts: memory with scope global or project or team, project_instructions, knowledge, member_instructions. Any other target or memory scope is refused.',
    );
  });

  it('opens only global memory to a thread with no project and no team, the one target the daemon accepts there', () => {
    const brief = briefOf(NO_PLACE);

    expect(brief).toContain(
      'Targets this thread accepts: memory with scope global. Any other target or memory scope is refused.',
    );
    expect(brief).not.toContain('scope team');
    expect(brief).not.toContain('This is a team run');
    expect(brief).not.toContain('member_instructions');
  });

  it('opens project memory, project instructions and knowledge to a project thread that is no team run', () => {
    const brief = briefOf({
      project: true,
      team: false,
      projectId: 'p1',
      members: [],
    });

    expect(brief).toContain(
      'Targets this thread accepts: memory with scope global or project, project_instructions, knowledge. Any other target or memory scope is refused.',
    );
  });

  it("tells a team run whose members cannot be read to use memory scope team for a role's lesson", () => {
    const brief = briefOf({
      project: false,
      team: true,
      projectId: null,
      members: [],
    });

    expect(brief).toContain(
      "its members could not be read: use memory scope team for a role's lesson.",
    );
    expect(brief).toContain(
      'Targets this thread accepts: memory with scope global or team. Any other target or memory scope is refused.',
    );
    expect(brief).not.toContain('member_instructions target');
  });
});

describe('lessonsReflectionGuide', () => {
  it('names the member and knowledge targets with the runs they are open to', () => {
    const guide = lessonsReflectionGuide(true);

    expect(guide).toContain(
      '`member_instructions` with the member id your brief lists (a team run only)',
    );
    expect(guide).toContain(
      '`project_instructions` (a thread with a project only)',
    );
    expect(guide).toContain(
      'the user decides whether to update the entry or move the rule somewhere every run reads',
    );
  });
});
