import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { MemoryService } from '../../memory/services/memory.service';
import type { UsageEventDao } from '../../stats/dao/usage-event.dao';
import type { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import { LessonProposalService } from './lesson-proposal.service';
import type { LessonRowWriter } from './lesson-row.writer';

const TARGET_PROJECT = { kind: 'memory', scope: 'project', type: 'feedback' };
const BODY_RULE =
  'Rerun a failing check only after changing what it exercises.';
const BODY_WHY = 'The same check was retried three times unchanged.';

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

function build(
  row: LessonProposal | null,
  memoryOutcome: unknown = {
    kind: 'created',
    entry: { handle: 'm7', title: 'Saved' },
  },
) {
  const em = {
    fork: () => em,
    flush: vi.fn(() => Promise.resolve()),
  } as unknown as EntityManager & { flush: ReturnType<typeof vi.fn> };
  const proposals = {
    getById: vi.fn(() => Promise.resolve(row)),
  };
  const runDao = {
    getById: vi.fn(() => Promise.resolve(null)),
  };
  const usage = {
    rowsByRuns: vi.fn(() => Promise.resolve([])),
  };
  const memory = {
    create: vi.fn(() => Promise.resolve(memoryOutcome)),
  };
  const rows = {
    write: vi.fn(() => Promise.resolve()),
  };
  const items = {
    getByRun: vi.fn((): Promise<{ kind: string; payload: string }[]> =>
      Promise.resolve([]),
    ),
  };
  const service = new LessonProposalService(
    em,
    proposals as unknown as LessonProposalDao,
    runDao as unknown as RunDao,
    usage as unknown as UsageEventDao,
    memory as unknown as MemoryService,
    rows as unknown as LessonRowWriter,
    items as unknown as ItemDao,
  );
  return { service, em, proposals, runDao, usage, memory, rows, items };
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
        title: row.title,
        rule: BODY_RULE,
        target: TARGET_PROJECT,
        memoryHandle: 'm7',
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
        title: row.title,
        rule: BODY_RULE,
        target: TARGET_PROJECT,
        memoryHandle: null,
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
