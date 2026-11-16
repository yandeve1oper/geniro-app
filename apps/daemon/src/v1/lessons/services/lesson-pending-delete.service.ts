import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { RunDao } from '../../agents/dao/run.dao';
import { ChatService } from '../../agents/services/chat.service';
import { ExtractLessonsOnDeleteRegistry } from '../../agents/services/extract-lessons-on-delete.registry';
import { TeamExecutorService } from '../../teams/services/team-executor.service';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import {
  LESSON_PENDING_DELETE_MAX_MS,
  type LessonSegmentStatus,
} from '../lessons.types';
import { isReflectable } from '../utils/reflectable';
import { LessonReflectionService } from './lesson-reflection.service';
import { LessonsEventBus } from './lessons-events.bus';

/** A stretch past these is done with: its lessons are filed, or there are none to file. */
const ENDED_SEGMENT_STATUSES: readonly LessonSegmentStatus[] = [
  'reflected',
  'empty',
  'failed',
  'skipped',
];

/**
 * "Extract lessons first" on a delete: the run is archived and hidden from
 * every listing at once (`Run.pendingDeleteAt`), its reflection starts ahead
 * of the queue, and the ordinary delete runs once its stretch has ended —
 * lessons filed after the check when one is set, none found, or failed —
 * after `LESSON_PENDING_DELETE_MAX_MS`, or at the next daemon start. What a
 * delete destroys is unchanged; it only waits.
 */
@Injectable()
export class LessonPendingDeleteService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LessonPendingDeleteService.name);
  /** By reflection run: the thread to delete once its stretch ends, and the cap's timer. */
  private readonly waiting = new Map<
    string,
    { sourceRunId: string; timer: ReturnType<typeof setTimeout> }
  >();
  private subscription: Subscription | null = null;
  private release: (() => void) | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly chats: ChatService,
    private readonly teamRuns: TeamExecutorService,
    private readonly reflections: LessonReflectionService,
    private readonly registry: ExtractLessonsOnDeleteRegistry,
    private readonly segments: LessonSegmentDao,
    private readonly events: LessonsEventBus,
  ) {}

  onModuleInit(): void {
    this.release = this.registry.use((runId) => this.extractThenDelete(runId));
    this.subscription = this.events.allChanges().subscribe((event) => {
      for (const [reflectionRunId, entry] of this.waiting) {
        if (entry.sourceRunId === event.runId) {
          void this.finishIfEnded(reflectionRunId);
        }
      }
    });
  }

  onApplicationBootstrap(): void {
    void this.deletePending().catch((err: unknown) => {
      this.logger.warn(`pending deletes not read at start: ${messageOf(err)}`);
    });
  }

  private async deletePending(): Promise<void> {
    const pending = await this.runDao.listPendingDeletes(this.em.fork());
    for (const run of pending) {
      await this.deleteNow(run.id, run.teamId);
    }
  }

  onModuleDestroy(): void {
    this.release?.();
    this.subscription?.unsubscribe();
    for (const entry of this.waiting.values()) {
      clearTimeout(entry.timer);
    }
    this.waiting.clear();
  }

  /** Null when there is nothing to reflect on: the route then deletes as usual. */
  async extractThenDelete(runId: string): Promise<{ deleted: boolean } | null> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || !isReflectable(run) || run.pendingDeleteAt !== null) {
      return null;
    }
    await this.runDao.updateById(runId, { pendingDeleteAt: new Date() }, em);
    let reflectionRunId: string;
    try {
      if (run.archivedAt === null) {
        await this.chats.archive(runId);
      }
      reflectionRunId =
        (await this.reflections.runningReflectionId(runId)) ??
        (await this.reflections.start(runId, {}, 'delete')).reflectionRunId;
    } catch (err) {
      this.logger.warn(
        `run ${runId}: lessons not extracted before its delete: ${messageOf(err)}`,
      );
      await this.runDao
        .updateById(runId, { pendingDeleteAt: null }, em)
        .catch(() => undefined);
      return null;
    }
    const timer = setTimeout(() => {
      void this.finish(reflectionRunId);
    }, LESSON_PENDING_DELETE_MAX_MS);
    timer.unref();
    this.waiting.set(reflectionRunId, { sourceRunId: runId, timer });
    return { deleted: true };
  }

  private async finishIfEnded(reflectionRunId: string): Promise<void> {
    const segment = await this.segments.ofReflection(
      reflectionRunId,
      this.em.fork(),
    );
    if (segment === null || ENDED_SEGMENT_STATUSES.includes(segment.status)) {
      await this.finish(reflectionRunId);
    }
  }

  private async finish(reflectionRunId: string): Promise<void> {
    const entry = this.waiting.get(reflectionRunId);
    if (entry === undefined) {
      return;
    }
    this.waiting.delete(reflectionRunId);
    clearTimeout(entry.timer);
    const run = await this.runDao.getById(entry.sourceRunId, this.em.fork());
    if (run !== null) {
      await this.deleteNow(run.id, run.teamId);
    }
  }

  private async deleteNow(runId: string, teamId: string | null): Promise<void> {
    try {
      if (teamId === null) {
        await this.chats.delete(runId);
      } else {
        await this.teamRuns.deleteRun(runId);
      }
    } catch (err) {
      this.logger.warn(
        `run ${runId} deleted with lessons first was not deleted: ${messageOf(err)}`,
      );
    }
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
