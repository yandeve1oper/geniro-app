import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { KnowledgeService } from '../../knowledge/services/knowledge.service';
import type { MemoryService } from '../../memory/services/memory.service';
import { PROJECT_INSTRUCTIONS_MAX } from '../../projects/projects.types';
import type { ProjectsService } from '../../projects/services/projects.service';
import type { UsageEventDao } from '../../stats/dao/usage-event.dao';
import type { TeamChangeService } from '../../teams/services/team-change.service';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import {
  LessonProposalService,
  moveUpOf,
  placesOf,
  ruleLine,
  withLessonLine,
} from './lesson-proposal.service';
import type { LessonRowWriter } from './lesson-row.writer';

const TARGET_PROJECT = { kind: 'memory', scope: 'project', type: 'feedback' };
const PROJECT = { id: 'p1', instructionBlocks: [], instructionsRevision: 4 };
const BODY_RULE =
  'Rerun a failing check only after changing what it exercises.';
const BODY_WHY = 'The same check was retried three times unchanged.';

const FILED_ENTRY = {
  id: 'mem-7',
  handle: 'm7',
  rev: 3,
  status: 'active',
  type: 'feedback',
  projectId: 'p1',
  teamSlug: null,
};

function proposal(overrides: Partial<LessonProposal> = {}): LessonProposal {
  return Object.assign(new LessonProposal(), {
    id: 'lp-1',
    sourceRunId: 'src',
    sourceTitle: 'Migrate the cache',
    reflectionRunId: 'refl',
    segmentId: 'seg-1',
    projectId: 'p1',
    teamSlug: 'team-a',
    title: "WHEN a check fails → DON'T retry it unchanged",
    rule: BODY_RULE,
    why: BODY_WHY,
    signalKind: 'error_then_success',
    evidenceSeq: 7,
    evidenceQuote: 'use pnpm not npm',
    target: JSON.stringify(TARGET_PROJECT),
    dedup: JSON.stringify({ verdict: 'new', handle: null }),
    status: 'proposed',
    rejectReason: null,
    resultRef: null,
    decidedAt: null,
    ...overrides,
  });
}

function applied(handle: string) {
  return { kind: 'applied', document: { handle }, created: true };
}

function build(
  row: LessonProposal | null,
  memoryOutcome: unknown = {
    kind: 'created',
    entry: { handle: 'm7', title: 'Saved' },
  },
  entry: Record<string, unknown> | null = FILED_ENTRY,
) {
  const em = {
    fork: () => em,
    flush: vi.fn(() => Promise.resolve()),
  } as unknown as EntityManager & { flush: ReturnType<typeof vi.fn> };
  const proposals = {
    getById: vi.fn(() => Promise.resolve(row)),
    list: vi.fn(() => Promise.resolve([] as LessonProposal[])),
  };
  const runDao = {
    getById: vi.fn(() => Promise.resolve(null)),
    existingIds: vi.fn(() => Promise.resolve(new Set(['src']))),
  };
  const usage = {
    rowsByRuns: vi.fn(() => Promise.resolve([])),
  };
  const memory = {
    create: vi.fn(() => Promise.resolve(memoryOutcome)),
    list: vi.fn(() =>
      Promise.resolve({ memories: entry === null ? [] : [entry], next: null }),
    ),
    setStatus: vi.fn(() => Promise.resolve({ kind: 'changed' })),
    edit: vi.fn(() =>
      Promise.resolve({ kind: 'updated', entry: { handle: 'm7' } }),
    ),
  };
  const rows = {
    write: vi.fn(() => Promise.resolve()),
  };
  const items = {
    getByRun: vi.fn((): Promise<{ kind: string; payload: string }[]> =>
      Promise.resolve([]),
    ),
  };
  const projects = {
    get: vi.fn(() => Promise.resolve(PROJECT)),
    update: vi.fn(() => Promise.resolve()),
  };
  const teamChange = {
    appendMemberLine: vi.fn(() => Promise.resolve({ saved: true })),
  };
  const knowledge = {
    create: vi.fn(() => Promise.resolve(applied('k-new'))),
    list: vi.fn(() => Promise.resolve({ documents: [] as { id: string }[] })),
    get: vi.fn(() => Promise.resolve(null)),
    edit: vi.fn(() => Promise.resolve(applied('k-1'))),
  };
  const service = new LessonProposalService(
    em,
    proposals as unknown as LessonProposalDao,
    runDao as unknown as RunDao,
    usage as unknown as UsageEventDao,
    memory as unknown as MemoryService,
    rows as unknown as LessonRowWriter,
    items as unknown as ItemDao,
    projects as unknown as ProjectsService,
    teamChange as unknown as TeamChangeService,
    knowledge as unknown as KnowledgeService,
  );
  return {
    service,
    em,
    proposals,
    runDao,
    usage,
    memory,
    rows,
    items,
    projects,
    teamChange,
    knowledge,
  };
}

describe('LessonProposalService.save', () => {
  it('writes the memory entry in the chosen scope, naming its thread and proposal', async () => {
    const row = proposal();
    const { service, memory, rows, em } = build(row);

    await service.save('lp-1', {});

    expect(memory.create).toHaveBeenCalledWith(
      {
        title: row.title,
        body: `${BODY_RULE}\n\nWhy: ${BODY_WHY}\n\nLesson from "Migrate the cache", message #7: “use pnpm not npm”`,
        type: 'feedback',
        projectId: 'p1',
        teamSlug: null,
      },
      { sourceRunId: 'src', proposalId: 'lp-1' },
    );
    expect(row).toMatchObject({
      status: 'saved',
      resultRef: 'm7',
      decidedAt: expect.any(Date),
    });
    expect(em.flush).toHaveBeenCalled();
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: {
        proposalId: 'lp-1',
        status: 'saved',
        by: 'user',
        title: row.title,
        rule: BODY_RULE,
        target: TARGET_PROJECT,
        memoryHandle: 'm7',
        resultRef: 'm7',
        reason: null,
      },
    });
  });

  it.each([
    ['project', { projectId: 'p1', teamSlug: null }],
    ['team', { projectId: null, teamSlug: 'team-a' }],
    ['global', { projectId: null, teamSlug: null }],
  ] as const)(
    'files a %s lesson under that place only',
    async (scope, placed) => {
      const { service, memory } = build(
        proposal({
          target: JSON.stringify({ kind: 'memory', scope, type: 'project' }),
        }),
      );

      await service.save('lp-1', {});

      expect(memory.create).toHaveBeenCalledWith(
        expect.objectContaining(placed),
        expect.anything(),
      );
    },
  );

  it('saves the title and rule as the user edited them', async () => {
    const row = proposal();
    const { service, memory, rows } = build(row);

    const wire = await service.save('lp-1', {
      title: 'Check before retrying',
      rule: 'Change the check input before rerunning it.',
    });

    expect(memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Check before retrying',
        body: `Change the check input before rerunning it.\n\nWhy: ${BODY_WHY}\n\nLesson from "Migrate the cache", message #7: “use pnpm not npm”`,
      }),
      expect.anything(),
    );
    expect(wire).toMatchObject({
      title: 'Check before retrying',
      rule: 'Change the check input before rerunning it.',
      status: 'saved',
      memoryHandle: 'm7',
    });
    expect(rows.write).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        payload: expect.objectContaining({
          title: 'Check before retrying',
          rule: 'Change the check input before rerunning it.',
        }),
      }),
    );
  });

  it('files under the target chosen on save in place of the proposed one', async () => {
    const row = proposal();
    const { service, memory, rows } = build(row);

    await service.save('lp-1', {
      target: { kind: 'memory', scope: 'global', type: 'user' },
    });

    expect(memory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user',
        projectId: null,
        teamSlug: null,
      }),
      expect.anything(),
    );
    expect(JSON.parse(row.target)).toEqual({
      kind: 'memory',
      scope: 'global',
      type: 'user',
    });
    expect(rows.write).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        payload: expect.objectContaining({
          target: { kind: 'memory', scope: 'global', type: 'user' },
        }),
      }),
    );
  });

  it.each([
    ['refines', 'm12'],
    ['broken_again', 'm12'],
  ] as const)(
    'names the entry a %s lesson refines as not a duplicate, so the write goes through',
    async (verdict, handle) => {
      const row = proposal({
        dedup: JSON.stringify({ verdict, handle }),
      });
      const { service, memory } = build(row);

      await service.save('lp-1', {});

      expect(memory.create).toHaveBeenCalledWith(
        expect.objectContaining({ notDuplicateOf: ['m12'] }),
        expect.anything(),
      );
    },
  );

  it('names no entry as not a duplicate for a new lesson', async () => {
    const { service, memory } = build(proposal());

    await service.save('lp-1', {});

    const [input] = memory.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(input).not.toHaveProperty('notDuplicateOf');
  });

  it('refuses a lesson that is already decided, writing nothing', async () => {
    const row = proposal({ status: 'rejected' });
    const { service, memory, rows, em } = build(row);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_DECIDED',
    });
    expect(memory.create).not.toHaveBeenCalled();
    expect(em.flush).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });

  it.each([
    ['project', 'LESSON_NO_PROJECT', { projectId: null, teamSlug: 'team-a' }],
    ['team', 'LESSON_NO_TEAM', { projectId: 'p1', teamSlug: null }],
  ] as const)(
    'refuses a %s lesson its thread has no place for, and leaves the proposal open',
    async (scope, errorCode, places) => {
      const row = proposal({
        ...places,
        target: JSON.stringify({ kind: 'memory', scope, type: 'project' }),
      });
      const { service, memory, rows, em } = build(row);

      await expect(service.save('lp-1', {})).rejects.toMatchObject({
        errorCode,
      });
      expect(memory.create).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
      expect(rows.write).not.toHaveBeenCalled();
      expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    },
  );

  it('refuses a near-duplicate entry, and leaves the proposal open', async () => {
    const row = proposal();
    const { service, rows } = build(row, {
      kind: 'near_duplicate',
      candidates: [{ handle: 'm3', title: 'Check before retrying' }],
      pending: [],
      updatable: true,
    });

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'MEMORY_NEAR_DUPLICATE',
    });
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.reject', () => {
  it('stores the reason and writes a rejected outcome beside the card', async () => {
    const row = proposal();
    const { service, memory, rows } = build(row);

    const wire = await service.reject('lp-1', { reason: 'Too narrow.' });

    expect(wire).toMatchObject({
      status: 'rejected',
      rejectReason: 'Too narrow.',
      decidedAt: expect.any(String),
    });
    expect(memory.create).not.toHaveBeenCalled();
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: {
        proposalId: 'lp-1',
        status: 'rejected',
        by: 'user',
        title: row.title,
        rule: BODY_RULE,
        target: TARGET_PROJECT,
        memoryHandle: null,
        resultRef: null,
        reason: 'Too narrow.',
      },
    });
  });

  it('stores no reason when none is given', async () => {
    const row = proposal();
    const { service, rows } = build(row);

    await service.reject('lp-1', {});

    expect(row.rejectReason).toBeNull();
    expect(rows.write).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        payload: expect.objectContaining({ reason: null }),
      }),
    );
  });
});

describe('LessonProposalService.reflectionFacts', () => {
  const REFLECTION = {
    id: 'refl',
    analysisPurpose: 'lessons',
    agentKind: 'claude',
    model: 'opus',
    effort: 'high',
    status: 'completed',
    createdAt: new Date('2026-11-12T10:00:00.000Z'),
  };

  it('sums the spend and time of the reflection over its usage rows', async () => {
    const { service, runDao, usage } = build(null);
    runDao.getById.mockResolvedValueOnce(REFLECTION as never);
    usage.rowsByRuns.mockResolvedValueOnce([
      { durationMs: 1200, costUsd: 0.5, inputTokens: 900, outputTokens: 100 },
      { durationMs: 300, costUsd: 0.25, inputTokens: null, outputTokens: null },
    ] as never);

    expect(await service.reflectionFacts('refl')).toEqual({
      reflectionRunId: 'refl',
      agentKind: 'claude',
      model: 'opus',
      effort: 'high',
      working: false,
      startedAt: '2026-11-12T10:00:00.000Z',
      durationMs: 1500,
      costUsd: 0.75,
      tokens: 1000,
    });
  });

  it('names the model the reflection was billed for, not the one it was configured with', async () => {
    const { service, runDao, items } = build(null);
    runDao.getById.mockResolvedValueOnce({
      ...REFLECTION,
      model: 'haiku',
    } as never);
    items.getByRun.mockResolvedValueOnce([
      { kind: 'message', payload: JSON.stringify({ text: 'hi' }) },
      {
        kind: 'turn_complete',
        payload: JSON.stringify({
          usage: {
            contextModel: 'claude-haiku-5-5',
            modelCosts: [{ model: 'claude-haiku-5-5', costUsd: 0.01 }],
          },
        }),
      },
    ]);

    expect((await service.reflectionFacts('refl')).model).toBe(
      'claude-haiku-5-5',
    );
  });

  it('answers a null cost when the CLI reported none, never zero', async () => {
    const { service, runDao, usage } = build(null);
    runDao.getById.mockResolvedValueOnce({
      ...REFLECTION,
      status: 'running',
    } as never);
    usage.rowsByRuns.mockResolvedValueOnce([
      { durationMs: 10, costUsd: null, inputTokens: null, outputTokens: null },
    ] as never);

    const facts = await service.reflectionFacts('refl');

    expect(facts).toMatchObject({ working: true, costUsd: null, tokens: null });
  });

  it('answers a not-found for a run that is no lessons reflection', async () => {
    const { service, runDao } = build(null);
    runDao.getById.mockResolvedValueOnce({
      ...REFLECTION,
      analysisPurpose: 'analysis',
    } as never);

    await expect(service.reflectionFacts('refl')).rejects.toMatchObject({
      errorCode: 'LESSONS_REFLECTION_NOT_FOUND',
    });
  });
});

describe('LessonProposalService.undo', () => {
  it('forgets the entry the lesson wrote as the user and marks the proposal undone', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory, rows, em } = build(row);

    const wire = await service.undo('lp-1');

    expect(memory.list).toHaveBeenCalledWith({ handle: 'm7', limit: 1 });
    expect(memory.setStatus).toHaveBeenCalledWith(
      { kind: 'user' },
      'mem-7',
      'forgotten',
    );
    expect(wire).toMatchObject({
      status: 'undone',
      memoryHandle: 'm7',
      decidedAt: expect.any(String),
    });
    expect(row.status).toBe('undone');
    expect(em.flush).toHaveBeenCalled();
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: {
        proposalId: 'lp-1',
        status: 'undone',
        by: 'user',
        title: row.title,
        rule: BODY_RULE,
        target: TARGET_PROJECT,
        memoryHandle: 'm7',
        resultRef: 'm7',
        reason: null,
      },
    });
  });

  it('does not forget an entry that is already forgotten, and still marks the proposal undone', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory } = build(row, undefined, {
      ...FILED_ENTRY,
      status: 'forgotten',
    });

    await service.undo('lp-1');

    expect(memory.setStatus).not.toHaveBeenCalled();
    expect(row.status).toBe('undone');
  });
});

describe('LessonProposalService.edit', () => {
  it('rewrites the entry at the rev it was read at, as the user', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory, rows } = build(row);

    const wire = await service.edit('lp-1', {
      title: 'Check before retrying',
      rule: 'Change the input first.',
    });

    expect(memory.edit).toHaveBeenCalledWith('mem-7', {
      rev: 3,
      title: 'Check before retrying',
      body: `Change the input first.\n\nWhy: ${BODY_WHY}\n\nLesson from "Migrate the cache", message #7: “use pnpm not npm”`,
      type: 'feedback',
      projectId: 'p1',
      teamSlug: null,
    });
    expect(wire).toMatchObject({
      title: 'Check before retrying',
      rule: 'Change the input first.',
      status: 'saved',
    });
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'saved',
        by: 'user',
        title: 'Check before retrying',
        rule: 'Change the input first.',
        memoryHandle: 'm7',
      }),
    });
  });

  it('refuses when the entry is forgotten, writing nothing', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory, rows } = build(row, undefined, {
      ...FILED_ENTRY,
      status: 'forgotten',
    });

    await expect(
      service.edit('lp-1', { title: 't', rule: 'r' }),
    ).rejects.toMatchObject({ errorCode: 'LESSON_ENTRY_GONE' });
    expect(memory.edit).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.approve', () => {
  it('sets the entry active as the user and writes a user-approved saved outcome', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory, rows } = build(row, undefined, {
      ...FILED_ENTRY,
      status: 'pending',
    });

    const wire = await service.approve('lp-1');

    expect(memory.setStatus).toHaveBeenCalledWith(
      { kind: 'user' },
      'mem-7',
      'active',
    );
    expect(wire.status).toBe('saved');
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'saved',
        by: 'user',
        memoryHandle: 'm7',
      }),
    });
  });

  it('refuses when the entry is gone, writing nothing', async () => {
    const row = proposal({ status: 'saved', resultRef: 'm7' });
    const { service, memory, rows } = build(row, undefined, null);

    await expect(service.approve('lp-1')).rejects.toMatchObject({
      errorCode: 'LESSON_ENTRY_GONE',
    });
    expect(memory.setStatus).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe.each(['undo', 'edit', 'approve'] as const)(
  'LessonProposalService.%s on a lesson that is not saved',
  (action) => {
    it.each(['proposed', 'rejected', 'undone'] as const)(
      'refuses a %s lesson with LESSON_NOT_FILED, touching nothing',
      async (status) => {
        const row = proposal({ status, resultRef: null });
        const { service, memory, rows, em } = build(row);
        const call =
          action === 'edit'
            ? service.edit('lp-1', { title: 't', rule: 'r' })
            : service[action]('lp-1');

        await expect(call).rejects.toMatchObject({
          errorCode: 'LESSON_NOT_FILED',
        });
        expect(memory.setStatus).not.toHaveBeenCalled();
        expect(memory.edit).not.toHaveBeenCalled();
        expect(rows.write).not.toHaveBeenCalled();
        expect(em.flush).not.toHaveBeenCalled();
        expect(row.status).toBe(status);
      },
    );
  },
);

const PROJECT_TARGET = { kind: 'project_instructions' } as const;
const MEMBER_TARGET = { kind: 'member_instructions', memberId: 'builder' };
const KNOWLEDGE_NEW = { kind: 'knowledge', handle: null } as const;

describe('LessonProposalService.save into project instructions', () => {
  it('appends one line to a new Lessons block at the revision it read, logged as a lesson of its thread', async () => {
    const row = proposal({ target: JSON.stringify(PROJECT_TARGET) });
    const { service, projects, rows } = build(row);
    projects.get.mockResolvedValueOnce({
      id: 'p1',
      instructionBlocks: [{ id: 'notes', title: 'Notes', text: 'Use pnpm.' }],
      instructionsRevision: 4,
    } as never);

    const wire = await service.save('lp-1', {});

    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      {
        instructionBlocks: [
          { id: 'notes', title: 'Notes', text: 'Use pnpm.' },
          { id: 'lessons', title: 'Lessons', text: `- ${BODY_RULE}` },
        ],
        expectedInstructionsRevision: 4,
      },
      {
        source: 'lesson',
        recommendationIds: [],
        chatRunId: 'src',
        cardSeq: null,
      },
    );
    expect(wire).toMatchObject({
      status: 'saved',
      target: PROJECT_TARGET,
      resultRef: 'p1',
      memoryHandle: null,
    });
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: {
        proposalId: 'lp-1',
        status: 'saved',
        by: 'user',
        title: row.title,
        rule: BODY_RULE,
        target: PROJECT_TARGET,
        memoryHandle: null,
        resultRef: 'p1',
        reason: null,
      },
    });
  });

  it('appends to the lines the Lessons block already holds', async () => {
    const { service, projects } = build(
      proposal({ target: JSON.stringify(PROJECT_TARGET) }),
    );
    projects.get.mockResolvedValueOnce({
      id: 'p1',
      instructionBlocks: [
        { id: 'lessons', title: 'Lessons', text: '- Old rule.' },
      ],
      instructionsRevision: 7,
    } as never);

    await service.save('lp-1', {});

    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      {
        instructionBlocks: [
          {
            id: 'lessons',
            title: 'Lessons',
            text: `- Old rule.\n- ${BODY_RULE}`,
          },
        ],
        expectedInstructionsRevision: 7,
      },
      expect.objectContaining({ source: 'lesson' }),
    );
  });

  it('refuses instructions that would run past the limit, with 409 LESSON_INSTRUCTIONS_TOO_LONG, writing no update', async () => {
    const row = proposal({ target: JSON.stringify(PROJECT_TARGET) });
    const { service, projects, rows } = build(row);
    projects.get.mockResolvedValueOnce({
      id: 'p1',
      instructionBlocks: [
        {
          id: 'notes',
          title: 'Notes',
          text: 'a'.repeat(PROJECT_INSTRUCTIONS_MAX),
        },
      ],
      instructionsRevision: 4,
    } as never);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_INSTRUCTIONS_TOO_LONG',
    });
    expect(projects.update).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
  });
});

describe('LessonProposalService decisions', () => {
  it('refuses a second press while the first still writes, so the rule is appended once', async () => {
    const row = proposal({ target: JSON.stringify(PROJECT_TARGET) });
    const { service, projects } = build(row);
    let release: () => void = () => undefined;
    projects.update.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.save('lp-1', {});
    await vi.waitFor(() => expect(projects.update).toHaveBeenCalled());
    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_DECIDING',
    });
    release();
    await first;

    expect(projects.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a rule with invisible characters before writing anything', async () => {
    const row = proposal({ target: JSON.stringify(PROJECT_TARGET) });
    const { service, projects, rows } = build(row);

    await expect(
      service.save('lp-1', { rule: 'Run pnpm​ test first' }),
    ).rejects.toMatchObject({ errorCode: 'LESSON_HIDDEN_TEXT' });
    expect(projects.update).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.save into member instructions', () => {
  it("appends the rule as one line to the member's instructions in the library team, logged as a lesson of its thread", async () => {
    const row = proposal({
      teamSlug: 'team-a',
      target: JSON.stringify(MEMBER_TARGET),
    });
    const { service, teamChange, rows } = build(row);

    await service.save('lp-1', {});

    expect(teamChange.appendMemberLine).toHaveBeenCalledWith({
      slug: 'team-a',
      memberId: 'builder',
      line: `- ${BODY_RULE}`,
      proposalId: 'lp-1',
      sourceRunId: 'src',
      summary: `Lesson for builder: ${row.title}`,
    });
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'saved',
        target: MEMBER_TARGET,
        memoryHandle: null,
        resultRef: 'team-a',
      }),
    });
  });

  it('refuses a member the library team no longer has, with 409 LESSON_MEMBER_GONE, and leaves the proposal open', async () => {
    const row = proposal({
      teamSlug: 'team-a',
      target: JSON.stringify(MEMBER_TARGET),
    });
    const { service, teamChange, rows } = build(row);
    teamChange.appendMemberLine.mockResolvedValueOnce({
      saved: false,
      error: 'MEMBER_GONE',
      message: "the team 'team-a' no longer has the member 'builder'",
    } as never);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_MEMBER_GONE',
    });
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.save into knowledge', () => {
  it("files a new document in the project's place when the lesson names none", async () => {
    const row = proposal({ target: JSON.stringify(KNOWLEDGE_NEW) });
    const { service, knowledge, rows } = build(row);

    await service.save('lp-1', {});

    expect(knowledge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        place: 'project:p1',
        title: row.title,
        body: expect.stringContaining(BODY_RULE),
      }),
    );
    expect(rows.write).toHaveBeenCalledWith('src', {
      kind: 'lesson_outcome',
      payload: expect.objectContaining({
        status: 'saved',
        target: KNOWLEDGE_NEW,
        memoryHandle: null,
        resultRef: 'k-new',
      }),
    });
  });

  it('appends the lesson as a section to the document it names, at the revision it reads', async () => {
    const row = proposal({
      target: JSON.stringify({ kind: 'knowledge', handle: 'k-1' }),
    });
    const { service, knowledge } = build(row);
    knowledge.list.mockResolvedValueOnce({
      documents: [{ id: 'kd-1' }],
    } as never);
    knowledge.get.mockResolvedValueOnce({
      id: 'kd-1',
      handle: 'k-1',
      rev: 7,
      title: 'Cache procedure',
      whenToRead: 'When migrating the cache',
      body: 'Step one.',
    } as never);

    const wire = await service.save('lp-1', {});

    expect(knowledge.list).toHaveBeenCalledWith({
      place: 'project:p1',
      handle: 'k-1',
      status: 'active',
      limit: 1,
    });
    expect(knowledge.edit).toHaveBeenCalledWith('kd-1', {
      rev: 7,
      title: 'Cache procedure',
      whenToRead: 'When migrating the cache',
      body: `Step one.\n\n## ${row.title}\n\n${BODY_RULE}\n\nWhy: ${BODY_WHY}\n\nLesson from "Migrate the cache", message #7: “use pnpm not npm”\n`,
    });
    expect(wire).toMatchObject({ status: 'saved', resultRef: 'k-1' });
  });

  it('refuses a document that is gone, with 409 LESSON_DOCUMENT_GONE, writing nothing', async () => {
    const row = proposal({
      target: JSON.stringify({ kind: 'knowledge', handle: 'k-gone' }),
    });
    const { service, knowledge, rows } = build(row);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_DOCUMENT_GONE',
    });
    expect(knowledge.edit).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    expect(rows.write).not.toHaveBeenCalled();
  });

  it("passes on the knowledge store's refusal under a lesson code, leaving the lesson open", async () => {
    const row = proposal({ target: JSON.stringify(KNOWLEDGE_NEW) });
    const { service, knowledge, rows } = build(row);
    knowledge.create.mockResolvedValueOnce({
      kind: 'refused',
      code: 'INVALID_DOCUMENT',
      reason: 'the body is too long',
    } as never);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_INVALID_DOCUMENT',
    });
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    expect(rows.write).not.toHaveBeenCalled();
  });

  it('refuses a document that changed while the lesson was saved, with 409 LESSON_DOCUMENT_CHANGED', async () => {
    const row = proposal({
      target: JSON.stringify({ kind: 'knowledge', handle: 'k-1' }),
    });
    const { service, knowledge, rows } = build(row);
    const document = {
      id: 'kd-1',
      handle: 'k-1',
      rev: 7,
      title: 'Cache procedure',
      whenToRead: 'When migrating the cache',
      body: 'Step one.',
    };
    knowledge.list.mockResolvedValueOnce({
      documents: [{ id: 'kd-1' }],
    } as never);
    knowledge.get.mockResolvedValueOnce(document as never);
    knowledge.edit.mockResolvedValueOnce({
      kind: 'stale',
      current: document,
    } as never);

    await expect(service.save('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_DOCUMENT_CHANGED',
    });
    expect(row).toMatchObject({ status: 'proposed', resultRef: null });
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.updateRule', () => {
  it('rewrites the entry a refines lesson names, at the rev it reads, as the user, and records the save under that entry', async () => {
    const row = proposal({
      dedup: JSON.stringify({ verdict: 'refines', handle: 'm7' }),
    });
    const { service, memory, rows } = build(row);

    const wire = await service.updateRule('lp-1', {
      rule: 'Change the input first.',
    });

    expect(memory.edit).toHaveBeenCalledWith('mem-7', {
      rev: 3,
      title: row.title,
      body: `Change the input first.\n\nWhy: ${BODY_WHY}\n\nLesson from "Migrate the cache", message #7: “use pnpm not npm”`,
      type: 'feedback',
      projectId: 'p1',
      teamSlug: null,
    });
    expect(wire).toMatchObject({
      status: 'saved',
      memoryHandle: 'm7',
      resultRef: 'm7',
    });
    expect(rows.write).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'saved',
          memoryHandle: 'm7',
          resultRef: 'm7',
        }),
      }),
    );
  });

  it('refuses Update rule when the refined entry was forgotten, with 409 LESSON_ENTRY_GONE, leaving the lesson open', async () => {
    const row = proposal({
      dedup: JSON.stringify({ verdict: 'refines', handle: 'm7' }),
    });
    const { service, memory, rows } = build(row, undefined, {
      ...FILED_ENTRY,
      status: 'forgotten',
    });

    await expect(service.updateRule('lp-1', {})).rejects.toMatchObject({
      errorCode: 'LESSON_ENTRY_GONE',
    });
    expect(memory.edit).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
    expect(row.status).toBe('proposed');
  });

  it('keeps Undo off the entry an Update rule changed: that entry was not written by the lesson', async () => {
    const row = proposal({
      dedup: JSON.stringify({ verdict: 'refines', handle: 'm7' }),
    });
    const { service, memory } = build(row);
    await service.updateRule('lp-1', {});

    await expect(service.undo('lp-1')).rejects.toMatchObject({
      errorCode: 'LESSON_NOT_FILED',
    });
    expect(memory.setStatus).not.toHaveBeenCalled();
  });

  it('refuses Update rule on a new lesson with 409 LESSON_NOT_A_REFINEMENT, touching nothing', async () => {
    const { service, memory, rows } = build(proposal());

    await expect(
      service.updateRule('lp-1', { rule: 'Change the input first.' }),
    ).rejects.toMatchObject({ errorCode: 'LESSON_NOT_A_REFINEMENT' });
    expect(memory.edit).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.moveUp', () => {
  const BROKEN_AGAIN = JSON.stringify({
    verdict: 'broken_again',
    handle: 'm7',
  });

  it("moves a rule broken again into the project's Lessons block, and the lesson becomes a project-instructions lesson", async () => {
    const row = proposal({ dedup: BROKEN_AGAIN });
    const { service, projects, memory } = build(row);

    const wire = await service.moveUp('lp-1');

    expect(projects.update).toHaveBeenCalledWith(
      'p1',
      {
        instructionBlocks: [
          { id: 'lessons', title: 'Lessons', text: `- ${BODY_RULE}` },
        ],
        expectedInstructionsRevision: 4,
      },
      expect.objectContaining({ source: 'lesson' }),
    );
    expect(memory.setStatus).not.toHaveBeenCalled();
    expect(wire).toMatchObject({
      status: 'saved',
      target: PROJECT_TARGET,
      resultRef: 'p1',
    });
  });

  it('approves the entry a rule broken again names into the memory index, as the user, when the thread has no project', async () => {
    const row = proposal({ projectId: null, dedup: BROKEN_AGAIN });
    const { service, memory, projects, rows } = build(row, undefined, {
      ...FILED_ENTRY,
      status: 'pending',
    });

    await service.moveUp('lp-1');

    expect(memory.setStatus).toHaveBeenCalledWith(
      { kind: 'user' },
      'mem-7',
      'active',
    );
    expect(projects.update).not.toHaveBeenCalled();
    expect(rows.write).toHaveBeenCalledWith(
      'src',
      expect.objectContaining({
        payload: expect.objectContaining({
          status: 'saved',
          memoryHandle: 'm7',
        }),
      }),
    );
  });

  it('refuses to move up a lesson whose rule was not broken again, with 409 LESSON_NOT_BROKEN_AGAIN, touching nothing', async () => {
    const { service, memory, projects, rows } = build(proposal());

    await expect(service.moveUp('lp-1')).rejects.toMatchObject({
      errorCode: 'LESSON_NOT_BROKEN_AGAIN',
    });
    expect(projects.update).not.toHaveBeenCalled();
    expect(memory.setStatus).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
  });
});

describe('LessonProposalService.list', () => {
  it("answers the proposals of the statuses named, and says whether each one's thread still exists", async () => {
    const kept = proposal({ id: 'lp-kept', sourceRunId: 'src' });
    const orphan = proposal({
      id: 'lp-orphan',
      sourceRunId: 'gone',
      status: 'check_failed',
    });
    const { service, proposals, runDao } = build(null);
    proposals.list.mockResolvedValueOnce([kept, orphan]);

    const wires = await service.list({ status: 'proposed,check_failed' });

    expect(proposals.list).toHaveBeenCalledWith(
      { statuses: ['proposed', 'check_failed'], sourceRunId: undefined },
      expect.anything(),
    );
    expect(runDao.existingIds).toHaveBeenCalledWith(
      ['src', 'gone'],
      expect.anything(),
    );
    expect(wires.map((wire) => [wire.id, wire.sourceExists])).toEqual([
      ['lp-kept', true],
      ['lp-orphan', false],
    ]);
  });

  it('drops a status name it does not know, and filters by no status when none is named', async () => {
    const { service, proposals } = build(null);

    await service.list({ status: 'proposed,bogus' });
    expect(proposals.list).toHaveBeenLastCalledWith(
      { statuses: ['proposed'], sourceRunId: undefined },
      expect.anything(),
    );

    await service.list({});
    expect(proposals.list).toHaveBeenLastCalledWith(
      { statuses: undefined, sourceRunId: undefined },
      expect.anything(),
    );
  });
});

describe('LessonProposalService.undo on a lesson saved outside memory', () => {
  it('refuses to undo a lesson saved to project instructions, with 409 LESSON_NOT_FILED, touching nothing', async () => {
    const row = proposal({
      status: 'saved',
      resultRef: 'p1',
      target: JSON.stringify(PROJECT_TARGET),
    });
    const { service, memory, rows } = build(row);

    await expect(service.undo('lp-1')).rejects.toMatchObject({
      errorCode: 'LESSON_NOT_FILED',
    });
    expect(memory.setStatus).not.toHaveBeenCalled();
    expect(rows.write).not.toHaveBeenCalled();
    expect(row.status).toBe('saved');
  });
});

describe('lesson proposal helpers', () => {
  it('turns a rule into one instructions line, its line breaks folded', () => {
    expect(ruleLine('  Use pnpm\n   not npm. ')).toBe('- Use pnpm not npm.');
  });

  it('appends the line to the Lessons block, and starts the block when it is missing or empty', () => {
    const notes = { id: 'notes', title: 'Notes', text: 'Use pnpm.' };

    expect(withLessonLine([notes], '- A')).toEqual([
      notes,
      { id: 'lessons', title: 'Lessons', text: '- A' },
    ]);
    expect(
      withLessonLine(
        [notes, { id: 'lessons', title: 'Lessons', text: '- A\n' }],
        '- B',
      ),
    ).toEqual([notes, { id: 'lessons', title: 'Lessons', text: '- A\n- B' }]);
    expect(
      withLessonLine([{ id: 'lessons', title: 'Lessons', text: '' }], '- B'),
    ).toEqual([{ id: 'lessons', title: 'Lessons', text: '- B' }]);
  });

  it('moves up only a memory lesson broken again: into the project when it has one, else the index', () => {
    const broken = {
      dedup: JSON.stringify({ verdict: 'broken_again', handle: 'm7' }),
      target: JSON.stringify(TARGET_PROJECT),
      projectId: 'p1',
    };

    expect(moveUpOf(broken)).toBe('project_instructions');
    expect(moveUpOf({ ...broken, projectId: null })).toBe('memory_index');
    expect(
      moveUpOf({
        ...broken,
        dedup: JSON.stringify({ verdict: 'refines', handle: 'm7' }),
      }),
    ).toBeNull();
    expect(
      moveUpOf({
        ...broken,
        dedup: JSON.stringify({ verdict: 'broken_again', handle: null }),
      }),
    ).toBeNull();
    expect(
      moveUpOf({
        ...broken,
        target: JSON.stringify(PROJECT_TARGET),
      }),
    ).toBeNull();
  });

  it('reads the places a row stored, and reads an older row off its own project and team columns', () => {
    const places = { project: true, team: false, projectId: 'p1', members: [] };

    expect(
      placesOf({
        places: JSON.stringify(places),
        projectId: 'p1',
        teamSlug: null,
      }),
    ).toEqual(places);
    expect(
      placesOf({ places: null, projectId: 'p1', teamSlug: 'team-a' }),
    ).toEqual({
      project: true,
      team: true,
      projectId: 'p1',
      members: [],
    });
  });
});

describe('LessonProposalService.reflectionFacts for the check', () => {
  it('serves a lessons_check run with its agent, model and effort', async () => {
    const { service, runDao } = build(null);
    runDao.getById.mockResolvedValueOnce({
      id: 'chk',
      analysisPurpose: 'lessons_check',
      agentKind: 'codex',
      model: 'gpt-5',
      effort: 'low',
      status: 'running',
      createdAt: new Date('2026-11-12T10:00:00.000Z'),
    } as never);

    expect(await service.reflectionFacts('chk')).toMatchObject({
      reflectionRunId: 'chk',
      agentKind: 'codex',
      model: 'gpt-5',
      effort: 'low',
      working: true,
    });
  });
});
