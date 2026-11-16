import { describe, expect, it } from 'vitest';

import type { MemoryEntry } from '../../../memory/memory.types';
import { MEMORY_RESULT_PREFACE } from '../../../memory/memory.types';
import { memorySaveResultText, readMemorySaveArgs } from './memory-save.reader';

const ENTRY: MemoryEntry = {
  id: 'id-4',
  handle: 'm4',
  title: 'Use pnpm',
  body: 'Never npm here.',
  type: 'project',
  projectId: 'p1',
  teamSlug: null,
  status: 'active',
  rev: 2,
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

const FENCE = 'memory-entry-f00d';

describe('readMemorySaveArgs', () => {
  it('reads the tool’s `id` as the handle of the entry to update', () => {
    expect(
      readMemorySaveArgs({ id: 'm4', rev: 2, title: 't', body: 'b' }),
    ).toEqual({
      ok: true,
      query: { handle: 'm4', rev: 2, title: 't', body: 'b' },
    });
  });

  it('reads scope team', () => {
    expect(
      readMemorySaveArgs({ title: 't', body: 'b', scope: 'team' }),
    ).toEqual({ ok: true, query: { title: 't', body: 'b', scope: 'team' } });
  });

  it('reads a new entry, treating a null optional as absent', () => {
    expect(
      readMemorySaveArgs({
        title: 't',
        body: 'b',
        type: null,
        scope: 'global',
      }),
    ).toEqual({ ok: true, query: { title: 't', body: 'b', scope: 'global' } });
  });

  it('refuses an update without the rev it was read at, and unknown arguments', () => {
    expect(readMemorySaveArgs({ id: 'm4', title: 't', body: 'b' })).toEqual({
      ok: false,
      error: 'rev is required with id — read the entry first with memory_read',
    });
    expect(
      readMemorySaveArgs({ title: 't', body: 'b', projectId: 'x' }).ok,
    ).toBe(false);
    expect(
      readMemorySaveArgs({ id: 'four', rev: 1, title: 't', body: 'b' }).ok,
    ).toBe(false);
  });
});

describe('memorySaveResultText', () => {
  it('names a saved entry and says when it waits for review', () => {
    expect(
      memorySaveResultText({ kind: 'created', entry: ENTRY }, FENCE),
    ).toEqual({
      text: 'Saved m4 (rev 2, this project, project) — Use pnpm.',
      isError: false,
    });
    expect(
      memorySaveResultText(
        { kind: 'updated', entry: { ...ENTRY, status: 'pending' } },
        FENCE,
      ).text,
    ).toBe(
      "Updated m4 (rev 2, this project, project) — Use pnpm. It waits for the user's review before any agent sees it.",
    );
  });

  it('words a team entry’s scope as this team', () => {
    expect(
      memorySaveResultText(
        {
          kind: 'created',
          entry: { ...ENTRY, projectId: null, teamSlug: 'a' },
        },
        FENCE,
      ).text,
    ).toBe('Saved m4 (rev 2, this team, project) — Use pnpm.');
  });

  it('names the near-duplicates and how to get past them', () => {
    const { text, isError } = memorySaveResultText(
      {
        kind: 'near_duplicate',
        candidates: [{ ...ENTRY, excerpt: 'Never npm here.' }],
        pending: [],
        updatable: true,
      },
      FENCE,
    );
    expect(isError).toBe(true);
    expect(text).toContain('notDuplicateOf');
    expect(text).toContain(
      '- m4 (rev 2, this project, project) — Use pnpm: Never npm here.',
    );
  });

  it('offers only vouching, never an update, to a writer under review', () => {
    const { text } = memorySaveResultText(
      {
        kind: 'near_duplicate',
        candidates: [{ ...ENTRY, excerpt: 'Never npm here.' }],
        pending: [],
        updatable: false,
      },
      FENCE,
    );
    expect(text).not.toContain('memory_save with its id and rev');
    expect(text).toContain('notDuplicateOf');
  });

  it('names a pending match without quoting it, and offers vouching past it', () => {
    const { text, isError } = memorySaveResultText(
      {
        kind: 'near_duplicate',
        candidates: [],
        pending: ['m7'],
        updatable: true,
      },
      FENCE,
    );
    expect(isError).toBe(true);
    expect(text).not.toContain(MEMORY_RESULT_PREFACE);
    expect(text).toContain('(not shown): m7');
    expect(text).toContain('notDuplicateOf: ["m7"]');
  });

  it('returns the current text of a stale entry with the rev to quote', () => {
    const { text, isError } = memorySaveResultText(
      { kind: 'stale', current: ENTRY },
      FENCE,
    );
    expect(isError).toBe(true);
    expect(text).toContain('save again with rev 2');
    expect(text).toContain(`<${FENCE}>\nNever npm here.\n</${FENCE}>`);
  });

  it('words a refusal with its code', () => {
    expect(
      memorySaveResultText(
        { kind: 'refused', code: 'CONTAINS_SECRET', reason: 'no secrets' },
        FENCE,
      ),
    ).toEqual({ text: 'CONTAINS_SECRET: no secrets', isError: true });
  });
});
