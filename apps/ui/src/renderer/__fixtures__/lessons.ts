import type { LessonView } from '../components/lessons-card';

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

export const REFLECTION_FOOTER = {
  agent: 'Claude',
  model: 'claude-haiku-5-5',
  working: false,
  durationMs: 38_000,
  costUsd: 0.02,
  tokens: 4200,
};
