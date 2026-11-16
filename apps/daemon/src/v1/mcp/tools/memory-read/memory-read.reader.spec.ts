import { describe, expect, it } from 'vitest';

import {
  MEMORY_READ_MAX,
  MEMORY_RESULT_PREFACE,
  type MemoryEntry,
} from '../../../memory/memory.types';
import { memoryReadResultText, readMemoryReadArgs } from './memory-read.reader';

const ENTRY: MemoryEntry = {
  id: 'id-2',
  handle: 'm2',
  title: 'Port',
  body: 'The daemon prefers 47615.',
  type: 'reference',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 3,
  source: {
    actor: 'agent',
    agentKind: 'claude',
    model: 'opus',
    runId: 'r1',
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
  indexed: false,
  promotedAt: null,
  forgetReason: null,
  purgeAt: null,
};

describe('readMemoryReadArgs', () => {
  it('reads up to the cap of handles and refuses anything else', () => {
    expect(readMemoryReadArgs({ ids: ['m2', '7'] })).toEqual({
      ok: true,
      query: { ids: ['m2', '7'] },
    });
    expect(
      readMemoryReadArgs({
        ids: Array.from({ length: MEMORY_READ_MAX + 1 }, (_, i) => `m${i + 1}`),
      }).ok,
    ).toBe(false);
    expect(readMemoryReadArgs({ ids: ['note'] }).ok).toBe(false);
  });
});

describe('memoryReadResultText', () => {
  it('quotes each entry whole, its body fenced, with its revision and author, then names what it could not read', () => {
    expect(memoryReadResultText([ENTRY], ['m9'], 'memory-entry-f00d')).toBe(
      [
        MEMORY_RESULT_PREFACE,
        'm2 (rev 3, global, reference) — Port\nby claude (opus), updated 2026-10-02T00:00:00.000Z\n<memory-entry-f00d>\nThe daemon prefers 47615.\n</memory-entry-f00d>',
        "Not found: m9 — forgotten, waiting for the user's review, or another project's or team's.",
      ].join('\n\n'),
    );
  });
});
