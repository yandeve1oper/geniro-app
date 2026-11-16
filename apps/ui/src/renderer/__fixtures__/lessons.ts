import type {
  LessonKnowledgeDocument,
  LessonPlaces,
  LessonsReflectionView,
  LessonView,
} from '../components/lessons-card';

export const LESSON_CORRECTION: LessonView = {
  id: 'p-correction',
  title:
    'WHEN running tests in this repo → use pnpm --filter <pkg> test:unit; never call vitest directly',
  rule: 'Run tests through pnpm --filter <pkg> test:unit; a plain vitest run skips the Electron runtime.',
  why: 'Plain vitest skips the Electron runtime and crashes on better-sqlite3.',
  signalKind: 'user_correction',
  evidence: {
    seq: 31,
    quote:
      'не запускай vitest напрямую — только через pnpm --filter <pkg> test:unit',
  },
  target: { kind: 'memory', scope: 'project', type: 'feedback' },
  dedup: { verdict: 'new', handle: null },
};

export const LESSON_REFINES: LessonView = {
  id: 'p-refines',
  title:
    'WHEN a change touches a daemon route → run pnpm generate:api and commit the client before pushing',
  rule: 'After changing a daemon route, run pnpm generate:api and commit the regenerated client.',
  why: 'CI failed on a stale generated client; it passed once regenerated.',
  signalKind: 'error_then_success',
  evidence: { seq: 44, quote: 'CI красный из-за устаревшего клиента' },
  target: { kind: 'memory', scope: 'project', type: 'feedback' },
  dedup: { verdict: 'refines', handle: 'm12' },
};

export const LESSON_BROKEN_AGAIN: LessonView = {
  id: 'p-broken',
  title:
    'WHEN a reviewer finds a missing test → add it before the fix, not after',
  rule: 'When a review finding names a missing test, write that test before changing the code.',
  why: 'The fix landed without its test twice in one thread.',
  signalKind: 'review_finding',
  evidence: { seq: 58, quote: 'тест на это где?' },
  target: { kind: 'memory', scope: 'global', type: 'feedback' },
  dedup: { verdict: 'broken_again', handle: 'm7' },
};

export const LESSON_PROJECT_RULE: LessonView = {
  id: 'p-project-rule',
  title:
    'WHEN a task card moves to In review → post the PR link on the card first',
  rule: 'Every rule that must hold in every run of this project belongs in its instructions.',
  why: 'The same card reached review without its PR link twice.',
  signalKind: 'stage_reopened',
  evidence: { seq: 63, quote: 'ссылку на PR опять забыли' },
  target: { kind: 'project_instructions' },
  dedup: { verdict: 'new', handle: null },
};

export const LESSON_MEMBER_RULE: LessonView = {
  id: 'p-member-rule',
  title:
    'WHEN a review finds a missing test → name the test, not only the file',
  rule: 'A review report names the missing test case, so the fix can start from it.',
  why: 'The reviewer wrote findings the builder had to re-read twice.',
  signalKind: 'review_finding',
  evidence: { seq: 71, quote: 'какой именно тест не хватает?' },
  target: { kind: 'member_instructions', memberId: 'member-reviewer' },
  dedup: { verdict: 'new', handle: null },
};

export const LESSON_KNOWLEDGE_PROCEDURE: LessonView = {
  id: 'p-knowledge',
  title: 'WHEN cutting a release → follow the release procedure step by step',
  rule: 'A long release procedure is filed as a project document, not as a rule of thumb.',
  why: 'The release steps were reconstructed from memory in two threads.',
  signalKind: 'error_then_success',
  evidence: { seq: 80, quote: 'опять забыли шаг с тегом' },
  target: { kind: 'knowledge', handle: null },
  dedup: { verdict: 'new', handle: null },
};

export const LESSON_NO_PROJECT_PLACES: LessonPlaces = {
  project: false,
  team: false,
  projectId: null,
  members: [],
};

export const PROJECT_PLACES: LessonPlaces = {
  project: true,
  team: true,
  projectId: 'proj-1',
  members: [{ id: 'member-reviewer', name: 'Reviewer' }],
};

export const PROJECT_DOCUMENTS: readonly LessonKnowledgeDocument[] = [
  { handle: 'k-release', title: 'Release procedure' },
  { handle: 'k-review', title: 'Review checklist' },
];

export const REFLECTION_FOOTER: LessonsReflectionView = {
  label: 'Reflection',
  agent: 'Claude',
  model: 'claude-haiku-5-5',
  effort: 'high',
  figures: { working: false, durationMs: 38_000, costUsd: 0.02 },
};

export const CHECK_FOOTER: LessonsReflectionView = {
  label: 'Check',
  agent: 'Claude',
  model: 'claude-opus-5-5',
  effort: 'high',
  figures: { working: false, durationMs: 21_000, costUsd: 0.27 },
};
