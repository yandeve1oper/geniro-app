import type { ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';

import { DesktopOnlyGuard } from '../../../auth/desktop-only.guard';
import {
  REMOTE_VIA_HEADER,
  REMOTE_VIA_VALUE,
} from '../../../auth/remote-marker';
import { MemoryCheckController } from '../../agents/controllers/memory-check.controller';
import { MemoryImportController } from '../../agents/controllers/memory-import.controller';
import { AgentKind } from '../../runs/runs.types';
import {
  MemoryCreateSchema,
  type MemoryEntry,
  type MemoryFinding,
  type MemoryForgetBatchList,
  type MemoryForgetBatchResult,
  type MemoryList,
  MemoryListQuerySchema,
  MemoryListSchema,
  type MemoryMergeRequest,
  type MemoryMergeResult,
  MemoryPatchSchema,
  type MemoryReviewIds,
  type MemoryReviewPage,
  type MemoryReviewSummary,
} from '../memory.types';
import type { MemoryService } from '../services/memory.service';
import type { MemoryFindingsService } from '../services/memory-findings.service';
import type { MemoryReviewService } from '../services/memory-review.service';
import { MemoriesController } from './memories.controller';
import { MemoryConfigController } from './memory-config.controller';
import { MemoryPurgeController } from './memory-purge.controller';

const ENTRY: MemoryEntry = {
  id: 'e1',
  handle: 'm1',
  title: 'Use pnpm',
  body: 'Never npm.',
  type: 'project',
  projectId: null,
  teamSlug: null,
  status: 'active',
  rev: 2,
  source: {
    actor: 'user',
    agentKind: null,
    model: null,
    runId: null,
    importedFrom: null,
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  lastUsedAt: null,
  approvedAt: null,
  indexed: true,
  promotedAt: null,
  forgetReason: null,
  purgeAt: null,
};

const PAGE: MemoryReviewPage = { rows: [], total: 0, younger: 0, next: null };

const IDS: MemoryReviewIds = { ids: ['e1'], warnedSkipped: 2 };

const SUMMARY: MemoryReviewSummary = {
  active: 3,
  pending: 1,
  read: 1,
  neverRead: 2,
  proposed: 2,
  proposedWithWarning: 1,
  younger: 0,
  kept: 1,
  forgotten: 1,
  minAgeDays: 14,
  countedSince: '2026-11-01',
  counting: false,
  lastBatch: null,
  lastPass: [],
  autoForget: null,
};

const BATCHES: MemoryForgetBatchList = {
  batches: [
    {
      batchId: 'b1',
      count: 2,
      forgottenAt: '2026-11-11T00:00:00.000Z',
      automatic: false,
      kind: 'manual',
      title: null,
      reason: null,
      purgeAt: null,
    },
  ],
};

const BATCH_RESULT: MemoryForgetBatchResult = {
  batchId: 'b1',
  forgotten: 1,
  skipped: [],
};

const OTHER: MemoryEntry = { ...ENTRY, id: 'e2', handle: 'm2' };

const FINDING: MemoryFinding = {
  id: 'f1',
  kind: 'contradicts',
  a: ENTRY,
  b: OTHER,
  quoteA: 'Use pnpm',
  quoteB: 'Use npm',
  reason: 'opposed',
  agentKind: AgentKind.Claude,
  model: null,
  checkedAt: '2026-11-11T00:00:00.000Z',
};

const MERGE: MemoryMergeRequest = {
  sourceIds: ['e1', 'e2'],
  title: 'Use pnpm',
  body: 'Never npm.',
  type: 'project',
  projectId: null,
  teamSlug: null,
};

function controllerOver(
  service: Partial<MemoryService>,
  review: Partial<MemoryReviewService> = {},
  findings: Partial<MemoryFindingsService> = {},
) {
  return new MemoriesController(
    service as MemoryService,
    review as MemoryReviewService,
    findings as MemoryFindingsService,
  );
}

async function errorOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode?: number; errorCode?: string };
  }
  throw new Error('expected the call to throw');
}

describe('MemoriesController', () => {
  it('is open to paired devices, while the config push and the import stay desktop only', () => {
    const guardsOf = (target: object) =>
      (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

    expect(guardsOf(MemoriesController)).not.toContain(DesktopOnlyGuard);
    expect(guardsOf(MemoryConfigController)).toContain(DesktopOnlyGuard);
    expect(guardsOf(MemoryImportController)).toContain(DesktopOnlyGuard);
  });

  it('keeps a purge desktop only, in a controller of its own', () => {
    const guardsOf = (target: object) =>
      (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

    expect(guardsOf(MemoryPurgeController)).toContain(DesktopOnlyGuard);
    expect(
      Reflect.getMetadata(PATH_METADATA, MemoryPurgeController.prototype.purge),
    ).toBe(':memoryId/purge');
    expect(
      Object.getOwnPropertyNames(MemoriesController.prototype),
    ).not.toContain('purge');
  });

  it('purges a forgotten entry and turns a refusal into its HTTP error', async () => {
    const purge = vi.fn(async (id: string) =>
      id === 'gone'
        ? ('missing' as const)
        : id === 'live'
          ? ('not-forgotten' as const)
          : { id, handle: 'm7' },
    );
    const controller = new MemoryPurgeController({
      purge,
    } as unknown as MemoryService);

    expect(await controller.purge('e7')).toEqual({ id: 'e7', handle: 'm7' });
    expect(await errorOf(controller.purge('gone'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_NOT_FOUND',
    });
    expect(await errorOf(controller.purge('live'))).toMatchObject({
      statusCode: 400,
      errorCode: 'MEMORY_NOT_FORGOTTEN',
    });
  });

  it('passes the asked auto-forget window to the summary', async () => {
    const summary = vi.fn(async () => SUMMARY);
    const controller = controllerOver({}, { summary });

    await controller.reviewSummary({ autoForgetDays: 30 });
    await controller.reviewSummary({});

    expect(summary).toHaveBeenNthCalledWith(1, expect.any(Date), 30);
    expect(summary).toHaveBeenNthCalledWith(2, expect.any(Date), undefined);
  });

  it('answers a saved entry, and turns a refusal into its HTTP error', async () => {
    const saved = controllerOver({
      change: async () => ({ kind: 'updated', entry: ENTRY }),
    });
    const stale = controllerOver({
      change: async () => ({ kind: 'stale', current: ENTRY }),
    });
    const duplicate = controllerOver({
      create: async () => ({
        kind: 'near_duplicate',
        candidates: [{ ...ENTRY, excerpt: 'Never npm.' }],
        pending: ['m7'],
        updatable: true,
      }),
    });
    const missing = controllerOver({
      change: async () => ({
        kind: 'refused',
        code: 'NOT_FOUND',
        reason: 'no memory e9',
      }),
    });

    await expect(saved.update('e1', { status: 'active' })).resolves.toBe(ENTRY);
    expect(
      await errorOf(stale.update('e1', { status: 'active' })),
    ).toMatchObject({ errorCode: 'MEMORY_STALE' });
    const conflict = await errorOf(
      duplicate.create({
        title: 'Use pnpm',
        body: 'x',
        type: 'project',
        projectId: null,
      }),
    );
    expect(conflict).toMatchObject({
      errorCode: 'MEMORY_NEAR_DUPLICATE',
      data: { description: 'similar entries exist: m1, m7' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(
      (await errorOf(missing.update('e9', { status: 'forgotten' }))).statusCode,
    ).toBe(404);
  });

  it('answers the list with a track per listed entry, beside the entries', async () => {
    const track = {
      memoryId: 'e1',
      indexShows: 3,
      reads: 2,
      helped: 1,
      notUseful: 0,
    };
    const listed: MemoryList = {
      memories: [ENTRY],
      tracks: [track],
      next: null,
    };
    const controller = controllerOver({ list: async () => listed });

    expect(await controller.list({})).toBe(listed);
    expect(MemoryListSchema.safeParse(listed).success).toBe(true);
    expect(
      MemoryListSchema.safeParse({ memories: [ENTRY], next: null }).success,
    ).toBe(false);
  });

  it('answers 404 for an entry that does not exist', async () => {
    const controller = controllerOver({ get: async () => null });

    expect((await errorOf(controller.read('nope'))).statusCode).toBe(404);
  });

  it('takes a PATCH of either a status alone or a whole edit at a rev', () => {
    const edit = {
      rev: 1,
      title: 't',
      body: 'b',
      type: 'project',
      projectId: null,
      teamSlug: null,
    };

    expect(MemoryPatchSchema.safeParse({ status: 'forgotten' }).success).toBe(
      true,
    );
    expect(MemoryPatchSchema.safeParse(edit).success).toBe(true);
    const { teamSlug: _omitted, ...withoutTeam } = edit;
    expect(MemoryPatchSchema.safeParse(withoutTeam).success).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, teamSlug: 'bad slug\n' }).success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, status: 'active' }).success,
    ).toBe(false);
    expect(MemoryPatchSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(MemoryPatchSchema.safeParse({ status: 'pending' }).success).toBe(
      false,
    );
  });

  it('takes a cursor whole or not at all, and a project id only with scope: project', () => {
    const ok = (query: object) =>
      MemoryListQuerySchema.safeParse(query).success;

    expect(ok({})).toBe(true);
    expect(ok({ scope: 'project', projectId: 'p1' })).toBe(true);
    expect(ok({ scope: 'project' })).toBe(false);
    expect(ok({ projectId: 'p1' })).toBe(false);
    expect(
      ok({ beforeUpdatedAt: '2026-10-01T00:00:00.000Z', beforeId: 'e1' }),
    ).toBe(true);
    expect(ok({ beforeId: 'e1' })).toBe(false);
  });

  it('takes a team slug only with scope: team', () => {
    const ok = (query: object) =>
      MemoryListQuerySchema.safeParse(query).success;

    expect(ok({ scope: 'team', teamSlug: 'a' })).toBe(true);
    expect(ok({ scope: 'team' })).toBe(false);
    expect(ok({ teamSlug: 'a' })).toBe(false);
    expect(ok({ scope: 'project', projectId: 'p1', teamSlug: 'a' })).toBe(
      false,
    );
  });

  it('files an entry under a project or a team, never both', () => {
    const entry = {
      title: 't',
      body: 'b',
      type: 'project',
      projectId: null,
    };
    const edit = { ...entry, rev: 1 };

    expect(
      MemoryCreateSchema.safeParse({ ...entry, teamSlug: 'a' }).success,
    ).toBe(true);
    expect(MemoryCreateSchema.safeParse(entry).success).toBe(true);
    expect(
      MemoryCreateSchema.safeParse({ ...entry, projectId: 'p1', teamSlug: 'a' })
        .success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, teamSlug: 'a' }).success,
    ).toBe(true);
    expect(
      MemoryPatchSchema.safeParse({ ...edit, projectId: 'p1', teamSlug: 'a' })
        .success,
    ).toBe(false);
    expect(
      MemoryPatchSchema.safeParse({ status: 'active', teamSlug: 'a' }).success,
    ).toBe(false);
  });

  it('answers the cleanup reads from the review service, with the query as given', async () => {
    const page = vi.fn(async () => PAGE);
    const ids = vi.fn(async () => IDS);
    const controller = controllerOver(
      {},
      {
        summary: async () => SUMMARY,
        page,
        ids,
        batches: async () => BATCHES,
      },
    );
    const query = { tab: 'kept' as const, limit: 5 };

    expect(await controller.reviewSummary({})).toBe(SUMMARY);
    expect(await controller.reviewPage(query)).toBe(PAGE);
    expect(await controller.reviewIds(query)).toBe(IDS);
    expect(await controller.batches()).toBe(BATCHES);
    expect(page).toHaveBeenCalledWith(query);
    expect(ids).toHaveBeenCalledWith(query);
  });

  it('forgets a batch and restores one through the service', async () => {
    const forgetBatch = vi.fn(async () => BATCH_RESULT);
    const restoreBatch = vi.fn(async () => ({ restored: 1 }));
    const controller = controllerOver({ forgetBatch, restoreBatch });

    expect(await controller.forgetBatch({ ids: ['e1', 'e2'] })).toBe(
      BATCH_RESULT,
    );
    expect(await controller.restoreBatch('b1')).toEqual({ restored: 1 });
    expect(forgetBatch).toHaveBeenCalledWith(['e1', 'e2']);
    expect(restoreBatch).toHaveBeenCalledWith('b1');
  });

  it('keeps and unkeeps an entry through the service, answering what it stored', async () => {
    const setKept = vi.fn(async (id: string, kept: boolean) => ({
      id,
      keptAt: kept ? '2026-11-11T00:00:00.000Z' : null,
    }));
    const controller = controllerOver({ setKept });

    expect(await controller.keep('e1')).toEqual({
      id: 'e1',
      keptAt: '2026-11-11T00:00:00.000Z',
    });
    expect(await controller.unkeep('e1')).toEqual({ id: 'e1', keptAt: null });
    expect(setKept.mock.calls).toEqual([
      ['e1', true],
      ['e1', false],
    ]);
  });

  it('answers 404 MEMORY_NOT_FOUND when keeping or unkeeping an entry that does not exist', async () => {
    const controller = controllerOver({ setKept: async () => null });

    expect(await errorOf(controller.keep('nope'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_NOT_FOUND',
    });
    expect(await errorOf(controller.unkeep('nope'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_NOT_FOUND',
    });
  });

  it('leaves every cleanup route open to paired devices, as the rest of the controller is', () => {
    const cleanupRoutes = [
      'reviewSummary',
      'reviewPage',
      'reviewIds',
      'forgetBatch',
      'batches',
      'restoreBatch',
      'keep',
      'unkeep',
    ] as const;

    for (const route of cleanupRoutes) {
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          MemoriesController.prototype[route],
        ),
      ).toBeUndefined();
    }
    expect(
      (Reflect.getMetadata(GUARDS_METADATA, MemoriesController) as unknown[]) ??
        [],
    ).not.toContain(DesktopOnlyGuard);
  });

  it('declares the literal cleanup routes before :memoryId', () => {
    const handlers = MemoriesController.prototype as unknown as Record<
      string,
      object
    >;
    const declared = Object.getOwnPropertyNames(MemoriesController.prototype)
      .filter((name) => name !== 'constructor')
      .flatMap((name) => {
        const path = Reflect.getMetadata(PATH_METADATA, handlers[name]!) as
          string | undefined;
        return path === undefined ? [] : [path];
      });
    const firstParam = declared.findIndex((path) =>
      path.startsWith(':memoryId'),
    );

    expect(firstParam).toBeGreaterThan(0);
    for (const literal of [
      'review/summary',
      'review',
      'review/ids',
      'batches',
      'forget-batch',
      'batches/:batchId/restore',
      'review/findings',
      'review/findings/:findingId/dismiss',
      'merge',
    ]) {
      const at = declared.indexOf(literal);
      expect(at, literal).toBeGreaterThanOrEqual(0);
      expect(at, literal).toBeLessThan(firstParam);
    }
  });

  it('leaves the findings, dismiss and merge routes open to paired devices', () => {
    for (const route of ['listFindings', 'dismissFinding', 'merge'] as const) {
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          MemoriesController.prototype[route],
        ),
      ).toBeUndefined();
    }
  });

  it('refuses the duplicate check from a paired device, and runs it on the Mac', () => {
    expect(
      (Reflect.getMetadata(
        GUARDS_METADATA,
        MemoryCheckController,
      ) as unknown[]) ?? [],
    ).toContain(DesktopOnlyGuard);

    const guard = new DesktopOnlyGuard();
    const requestWith = (headers: Record<string, string>) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ headers }) }),
      }) as unknown as ExecutionContext;
    const thrownBy = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error as { errorCode?: string };
      }
      throw new Error('expected the guard to refuse');
    };

    expect(
      thrownBy(() =>
        guard.canActivate(
          requestWith({ [REMOTE_VIA_HEADER]: REMOTE_VIA_VALUE }),
        ),
      ),
    ).toMatchObject({ errorCode: 'DESKTOP_ONLY' });
    expect(guard.canActivate(requestWith({}))).toBe(true);
  });

  it('answers a merge with its result, or 409 MEMORY_NEAR_DUPLICATE naming the matches', async () => {
    const result: MemoryMergeResult = {
      entry: ENTRY,
      batchId: 'b2',
      forgotten: ['m1', 'm2'],
    };
    const merged = controllerOver({
      merge: async () => ({ kind: 'merged', result }),
    });
    const duplicate = controllerOver({
      merge: async () => ({
        kind: 'near_duplicate',
        candidates: [{ ...ENTRY, excerpt: 'Never npm.' }],
        pending: ['m7'],
        updatable: true,
      }),
    });

    expect(await merged.merge(MERGE)).toBe(result);
    expect(await errorOf(duplicate.merge(MERGE))).toMatchObject({
      statusCode: 409,
      errorCode: 'MEMORY_NEAR_DUPLICATE',
      data: { description: 'similar entries exist: m1, m7' },
    });
  });

  it('lists the open findings, and answers a dismissal with those still open or 404 for an unknown one', async () => {
    const open = vi.fn(async () => [FINDING]);
    const unknown = controllerOver(
      {},
      {},
      { dismiss: async () => false, open },
    );
    const known = controllerOver({}, {}, { dismiss: async () => true, open });

    expect(await known.listFindings()).toEqual({ findings: [FINDING] });
    expect(await known.dismissFinding('f1')).toEqual({ findings: [FINDING] });
    expect(await errorOf(unknown.dismissFinding('nope'))).toMatchObject({
      statusCode: 404,
      errorCode: 'MEMORY_FINDING_NOT_FOUND',
    });
  });
});
