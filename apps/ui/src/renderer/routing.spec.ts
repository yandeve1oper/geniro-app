import { describe, expect, it } from 'vitest';

import { formatRoute, parseRoute, type Route } from './routing';

/** One example per arm, plus an id needing percent-encoding on both sides. */
const EXAMPLES: readonly { label: string; hash: string; route: Route }[] = [
  {
    label: 'an open chat',
    hash: '#/chats/run-123',
    route: { view: 'chats', runId: 'run-123' },
  },
  {
    label: 'the chat list with nothing open',
    hash: '#/chats',
    route: { view: 'chats', runId: null },
  },
  {
    label: 'an open team',
    hash: '#/teams/dev-team',
    route: { view: 'teams', slug: 'dev-team' },
  },
  {
    label: 'the team library with nothing open',
    hash: '#/teams',
    route: { view: 'teams', slug: null },
  },
  {
    label: 'an open project page',
    hash: '#/projects/proj-9',
    route: { view: 'projects', projectId: 'proj-9' },
  },
  {
    label: 'the projects page with nothing chosen',
    hash: '#/projects',
    route: { view: 'projects', projectId: null },
  },
  {
    label: 'an open task project',
    hash: '#/tasks/proj-9',
    route: { view: 'tasks', projectId: 'proj-9' },
  },
  {
    label: 'the task board with nothing open',
    hash: '#/tasks',
    route: { view: 'tasks', projectId: null },
  },
  {
    label: 'settings',
    hash: '#/settings',
    route: { view: 'settings' },
  },
  {
    label: 'the knowledge list',
    hash: '#/knowledge',
    route: { view: 'knowledge', documentId: null },
  },
  {
    label: 'one knowledge document',
    hash: '#/knowledge/doc-1',
    route: { view: 'knowledge', documentId: 'doc-1' },
  },
  {
    label: 'stats',
    hash: '#/stats',
    route: { view: 'stats' },
  },
  {
    label: 'the command center',
    hash: '#/command-center',
    route: { view: 'command-center' },
  },
  {
    label: 'a run id with characters that need encoding',
    hash: '#/chats/a%2Fb%20c%3F%23d',
    route: { view: 'chats', runId: 'a/b c?#d' },
  },
];

describe('parseRoute', () => {
  for (const { label, hash, route } of EXAMPLES) {
    it(`parses ${label}`, () => {
      expect(parseRoute(hash)).toEqual(route);
    });
  }

  it('opens the teams view from a link saved before the rename', () => {
    expect(parseRoute('#/workflows/dev-team')).toEqual({
      view: 'teams',
      slug: 'dev-team',
    });
    expect(parseRoute('#/workflows')).toEqual({ view: 'teams', slug: null });
  });

  it('answers null for an empty hash', () => {
    expect(parseRoute('')).toBeNull();
    expect(parseRoute('#')).toBeNull();
  });

  it('answers null for an unrecognised view', () => {
    expect(parseRoute('#/nowhere')).toBeNull();
    expect(parseRoute('#/nowhere/123')).toBeNull();
  });

  it('answers null for a settings/stats hash carrying a stray id', () => {
    expect(parseRoute('#/settings/general')).toBeNull();
    expect(parseRoute('#/stats/today')).toBeNull();
  });

  it('answers null for malformed percent-encoding in the id segment', () => {
    // A lone `%` is not a valid escape — `decodeURIComponent` throws on it,
    // and a hash this build cannot decode names no route at all.
    expect(parseRoute('#/chats/%')).toBeNull();
    expect(parseRoute('#/teams/100%')).toBeNull();
  });
});

describe('formatRoute', () => {
  for (const { label, hash, route } of EXAMPLES) {
    it(`formats ${label}`, () => {
      expect(formatRoute(route)).toBe(hash);
    });
  }
});

describe('round-trip', () => {
  for (const { label, route } of EXAMPLES) {
    it(`parseRoute(formatRoute(route)) recovers ${label}`, () => {
      expect(parseRoute(formatRoute(route))).toEqual(route);
    });
  }
});
