import { describe, expect, it } from 'vitest';

import {
  MEMORY_RESULT_PREFACE,
  MEMORY_SEARCH_DEFAULT,
  MEMORY_SEARCH_MAX,
  type MemoryHit,
} from '../../../memory/memory.types';
import {
  memorySearchResultText,
  readMemorySearchArgs,
} from './memory-search.reader';

const HIT: MemoryHit = {
  id: 'id-1',
  handle: 'm1',
  title: 'Daemon binds loopback',
  excerpt: '127.0.0.1 only.',
  type: 'project',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 1,
  source: {
    actor: 'agent',
    agentKind: 'codex',
    model: null,
    runId: 'r1',
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
  indexed: false,
};

describe('readMemorySearchArgs', () => {
  it('defaults the limit and refuses one past the cap', () => {
    expect(readMemorySearchArgs({ query: 'pnpm' })).toEqual({
      ok: true,
      query: { query: 'pnpm', limit: MEMORY_SEARCH_DEFAULT },
    });
    expect(
      readMemorySearchArgs({ query: 'pnpm', limit: MEMORY_SEARCH_MAX + 1 }).ok,
    ).toBe(false);
    expect(readMemorySearchArgs({ query: 'x' }).ok).toBe(false);
  });
});

describe('memorySearchResultText', () => {
  it('leads the hits with the data-not-instructions line', () => {
    expect(memorySearchResultText('loopback', [HIT])).toBe(
      [
        MEMORY_RESULT_PREFACE,
        '- m1 (rev 1, global, project) — Daemon binds loopback: 127.0.0.1 only.',
        'Read whole entries with memory_read.',
      ].join('\n'),
    );
  });

  it('says plainly when nothing matches', () => {
    expect(memorySearchResultText('zzz', [])).toMatch(
      /^No memory matches "zzz"/,
    );
  });
});
