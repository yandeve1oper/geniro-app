import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunDao } from '../../agents/dao/run.dao';
import type { ChatService } from '../../agents/services/chat.service';
import { ExtractLessonsOnDeleteRegistry } from '../../agents/services/extract-lessons-on-delete.registry';
import type { Run } from '../../runs/entity/run.entity';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import type { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LESSON_PENDING_DELETE_MAX_MS } from '../lessons.types';
import { LessonPendingDeleteService } from './lesson-pending-delete.service';
import type { LessonReflectionService } from './lesson-reflection.service';
import { LessonsEventBus } from './lessons-events.bus';

function runOf(overrides: Partial<Run> = {}): Run {
  return {
    id: 'src',
    title: 'Migrate the cache',
    status: 'completed',
    agentKind: 'claude',
    configDir: null,
    teamId: null,
    projectId: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    editsTeamSlug: null,
    editsProjectId: null,
    reflectedThroughSeq: null,
    pendingDeleteAt: null,
    archivedAt: null,
    ...overrides,
  } as unknown as Run;
}

function build(
  options: {
    runs?: Run[];
    pending?: Run[];
    /** The reflection already working on the thread, as `runningReflectionId` finds it. */
    running?: string | null;
    startFails?: Error;
    archiveFails?: Error;
    deleteFails?: Error;
    pendingFails?: Error;
    stretch?: string;
  } = {},
) {
  const runs = new Map((options.runs ?? [runOf()]).map((run) => [run.id, run]));
  const em = { fork: () => em } as unknown as EntityManager;
  const runDao = {
    getById: vi.fn((runId: string) => Promise.resolve(runs.get(runId) ?? null)),
    updateById: vi.fn(() => Promise.resolve()),
    listPendingDeletes: vi.fn(() =>
      options.pendingFails === undefined
        ? Promise.resolve(options.pending ?? [])
        : Promise.reject(options.pendingFails),
    ),
  };
  const chats = {
    archive: vi.fn(() =>
      options.archiveFails === undefined
        ? Promise.resolve({})
        : Promise.reject(options.archiveFails),
    ),
    delete: vi.fn((_runId: string) =>
      options.deleteFails === undefined
        ? Promise.resolve({ deleted: true })
        : Promise.reject(options.deleteFails),
    ),
  };
  const teamRuns = {
    deleteRun: vi.fn((_runId: string) =>
      options.deleteFails === undefined
        ? Promise.resolve({ deleted: true })
        : Promise.reject(options.deleteFails),
    ),
  };
  const reflections = {
    start: vi.fn(() =>
      options.startFails === undefined
        ? Promise.resolve({
            reflectionRunId: 'refl-1',
            segmentId: 'seg-1',
            fromSeq: -1,
            toSeq: 2,
          })
        : Promise.reject(options.startFails),
    ),
    runningReflectionId: vi.fn((_runId: string) =>
      Promise.resolve(options.running ?? null),
    ),
  };
  const segment: { id: string; runId: string; status: string } = {
    id: 'seg-1',
    runId: 'src',
    status: options.stretch ?? 'reflecting',
  };
  const segments = {
    ofReflection: vi.fn(() => Promise.resolve(segment)),
  };
  const events = new LessonsEventBus();
  const registry = new ExtractLessonsOnDeleteRegistry();
  const service = new LessonPendingDeleteService(
    em,
    runDao as unknown as RunDao,
    chats as unknown as ChatService,
    teamRuns as unknown as TeamExecutorService,
    reflections as unknown as LessonReflectionService,
    registry,
    segments as unknown as LessonSegmentDao,
    events,
  );
  return {
    service,
    em,
    runs,
    runDao,
    chats,
    teamRuns,
    reflections,
    segment,
    events,
    registry,
  };
}

/** Lets the settle chain's awaited reads and deletes finish, without moving the clock. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** The thread's stretch ends in `status`: the lessons change event follows the write, as the filing does. */
async function stretchEnds(
  h: ReturnType<typeof build>,
  status = 'reflected',
): Promise<void> {
  h.segment.status = status;
  h.events.publishChanged('src');
  await settle();
}

describe('LessonPendingDeleteService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('extractThenDelete', () => {
    it('archives the thread, marks it pending delete and starts its reflection as a delete', async () => {
      const h = build();

      await expect(h.service.extractThenDelete('src')).resolves.toEqual({
        deleted: true,
      });

      expect(h.chats.archive).toHaveBeenCalledWith('src');
      expect(h.runDao.updateById).toHaveBeenCalledWith(
        'src',
        { pendingDeleteAt: expect.any(Date) },
        h.em,
      );
      expect(h.reflections.start).toHaveBeenCalledWith('src', {}, 'delete');
      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('marks the thread pending delete before it archives it', async () => {
      const h = build();

      await h.service.extractThenDelete('src');

      expect(h.runDao.updateById.mock.invocationCallOrder[0]).toBeLessThan(
        h.chats.archive.mock.invocationCallOrder[0]!,
      );
    });

    it('does not archive a thread that is already archived', async () => {
      const h = build({ runs: [runOf({ archivedAt: new Date() })] });

      await h.service.extractThenDelete('src');

      expect(h.chats.archive).not.toHaveBeenCalled();
      expect(h.reflections.start).toHaveBeenCalledTimes(1);
    });

    it('answers null, and starts nothing, for a thread that has nothing to reflect on', async () => {
      const h = build({ runs: [runOf({ editsProjectId: 'p1' })] });

      await expect(h.service.extractThenDelete('src')).resolves.toBeNull();

      expect(h.chats.archive).not.toHaveBeenCalled();
      expect(h.runDao.updateById).not.toHaveBeenCalled();
      expect(h.reflections.start).not.toHaveBeenCalled();
    });

    it('adopts the reflection already working on the thread: none starts, and the delete waits for its stretch to end', async () => {
      const h = build({ running: 'refl-running' });
      h.service.onModuleInit();

      await expect(h.service.extractThenDelete('src')).resolves.toEqual({
        deleted: true,
      });
      expect(h.reflections.runningReflectionId).toHaveBeenCalledWith('src');
      expect(h.reflections.start).not.toHaveBeenCalled();

      h.events.publishChanged('src');
      await settle();
      expect(h.chats.delete).not.toHaveBeenCalled();

      await stretchEnds(h);
      expect(h.chats.delete).toHaveBeenCalledWith('src');
    });

    it('answers null when its reflection cannot start, and clears the pending mark so the route deletes as usual', async () => {
      const h = build({ startFails: new Error('no reflection') });

      await expect(h.service.extractThenDelete('src')).resolves.toBeNull();

      expect(h.runDao.updateById).toHaveBeenLastCalledWith(
        'src',
        { pendingDeleteAt: null },
        h.em,
      );
      expect(h.chats.delete).not.toHaveBeenCalled();
      expect(h.teamRuns.deleteRun).not.toHaveBeenCalled();
    });

    it('answers null and clears the pending mark when the archive fails, starting no reflection', async () => {
      const h = build({ archiveFails: new Error('archive busy') });

      await expect(h.service.extractThenDelete('src')).resolves.toBeNull();

      expect(h.runDao.updateById).toHaveBeenLastCalledWith(
        'src',
        { pendingDeleteAt: null },
        h.em,
      );
      expect(h.reflections.start).not.toHaveBeenCalled();
      expect(h.chats.delete).not.toHaveBeenCalled();
    });
  });

  describe('the delete once the reflection settles', () => {
    it.each(['reflected', 'empty', 'failed', 'skipped'])(
      'deletes a chat once its stretch ends %s',
      async (status) => {
        const h = build();
        h.service.onModuleInit();
        await h.service.extractThenDelete('src');

        await stretchEnds(h, status);

        expect(h.chats.delete).toHaveBeenCalledTimes(1);
      },
    );

    it('deletes a chat when its stretch ends', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await stretchEnds(h);
      await settle();

      expect(h.chats.delete).toHaveBeenCalledTimes(1);
      expect(h.chats.delete).toHaveBeenCalledWith('src');
      expect(h.teamRuns.deleteRun).not.toHaveBeenCalled();
    });

    it('deletes a team run through teamRuns.deleteRun', async () => {
      const h = build({ runs: [runOf({ teamId: 'team-1' })] });
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await stretchEnds(h, 'failed');
      await settle();

      expect(h.teamRuns.deleteRun).toHaveBeenCalledWith('src');
      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('does not delete while its stretch is still being reflected, even when the reflection run has finished', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.events.publishChanged('src');
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('deletes at LESSON_PENDING_DELETE_MAX_MS when the reflection never settles, once', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS - 1);
      await settle();
      expect(h.chats.delete).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);

      await stretchEnds(h);
      await settle();
      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);
    });

    it('a settle before the cap deletes once, and the cap then does nothing', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await stretchEnds(h);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();
      expect(h.chats.delete).toHaveBeenCalledTimes(1);
    });

    it('deletes nothing when the thread is gone by the time its reflection settles', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');
      h.runs.delete('src');

      await stretchEnds(h);
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('logs and leaves the run in place when its delete fails once the reflection settles', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const h = build({
        runs: [runOf({ teamId: 'team-1' })],
        deleteFails: new Error('busy'),
      });
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      await stretchEnds(h);
      await settle();

      expect(h.teamRuns.deleteRun).toHaveBeenCalledWith('src');
      expect(warn).toHaveBeenCalledWith(
        'run src deleted with lessons first was not deleted: busy',
      );
    });
  });

  describe('start-up and module lifetime', () => {
    it('deletes every run left pending delete when the daemon starts, chats and team runs alike', async () => {
      const h = build({
        pending: [
          runOf({ id: 'chat-a', teamId: null, pendingDeleteAt: new Date() }),
          runOf({
            id: 'team-b',
            teamId: 'team-1',
            pendingDeleteAt: new Date(),
          }),
        ],
      });

      h.service.onApplicationBootstrap();
      await settle();

      expect(h.runDao.listPendingDeletes).toHaveBeenCalledTimes(1);
      expect(h.chats.delete).toHaveBeenCalledWith('chat-a');
      expect(h.teamRuns.deleteRun).toHaveBeenCalledWith('team-b');
    });

    it('does not throw at start when the pending deletes cannot be read, and logs it', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const h = build({ pendingFails: new Error('db locked') });

      expect(() => h.service.onApplicationBootstrap()).not.toThrow();
      await settle();

      expect(warn).toHaveBeenCalledWith(
        'pending deletes not read at start: db locked',
      );
      expect(h.chats.delete).not.toHaveBeenCalled();
    });

    it('takes the extract-first handler into the registry on init and gives it back on destroy', async () => {
      const h = build();
      const use = vi.spyOn(h.registry, 'use');

      h.service.onModuleInit();
      expect(use).toHaveBeenCalledTimes(1);
      await expect(h.registry.extract('src')).resolves.toEqual({
        deleted: true,
      });

      h.service.onModuleDestroy();
      await expect(h.registry.extract('src')).resolves.toBeNull();
    });

    it('stops deleting on settle once destroyed, and drops its cap', async () => {
      const h = build();
      h.service.onModuleInit();
      await h.service.extractThenDelete('src');

      h.service.onModuleDestroy();
      await stretchEnds(h);
      await settle();
      await vi.advanceTimersByTimeAsync(LESSON_PENDING_DELETE_MAX_MS);
      await settle();

      expect(h.chats.delete).not.toHaveBeenCalled();
    });
  });
});
