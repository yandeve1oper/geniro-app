import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { TeamStoreService } from '../../teams/services/team-store.service';
import {
  LessonSegmentDao,
  RUNNING_SEGMENT_STATUSES,
} from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_ROW_KINDS,
  LESSON_SEGMENT_STATUSES,
  type LessonEstimateQuery,
  type LessonSegmentCloser,
  type LessonSegmentListQuery,
  type LessonSegmentStatus,
  type LessonSegmentWire,
  type LessonSignal,
  type ThreadLessonEstimate,
} from '../lessons.types';
import { offersLessons, teamLessonsOverrideOf } from '../utils/lessons-mode';
import { readLessonSignals } from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { LessonEstimateService } from './lesson-estimate.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

const DEFAULT_LIST_STATUSES: readonly LessonSegmentStatus[] =
  RUNNING_SEGMENT_STATUSES.concat('queued');

/**
 * Closes the stretch of a thread a reflection reads and queues it for
 * `LessonAutoRunner`. Archiving a thread closes its stretch at once; a delete
 * with "Extract lessons first" ticked and "Reflect now" start their own
 * reflection. Only the items past the thread's `reflectedThroughSeq` belong
 * to a stretch, a stretch with no learning signal is never queued, and a
 * thread has at most one stretch queued: a later close extends it.
 */
@Injectable()
export class LessonSegmentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonSegmentService.name);
  private readonly queues = new Map<string, Promise<unknown>>();
  private subscription: Subscription | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly bus: AgentEventBus,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly estimates: LessonEstimateService,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
    @Optional() private readonly teams?: TeamStoreService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.bus.allChanged().subscribe((runs) => {
      for (const run of runs) {
        if (run.archivedAt !== null) {
          void this.close(run.id, 'archive').catch((err: unknown) => {
            this.logger.warn(
              `lessons close of ${run.id} failed: ${messageOf(err)}`,
            );
          });
        }
      }
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /**
   * Queue the thread's stretch past its last reflection when it holds a
   * learning signal. Null when nothing was queued: nothing new, no signal,
   * Lessons off for this thread, or a reflection already on it.
   */
  close(
    runId: string,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonSegment | null> {
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.closeNow(runId, closedBy));
    const settled = next.catch(() => undefined);
    this.queues.set(runId, settled);
    void settled.then(() => {
      if (this.queues.get(runId) === settled) {
        this.queues.delete(runId);
      }
    });
    return next;
  }

  /** Whether reflections run on this thread, by the app's, its project's and its team's settings. */
  async lessonsOnFor(run: Run): Promise<boolean> {
    if (this.config.config.mode === 'off') {
      return false;
    }
    const project = await this.projectScope.projectOfRun(run);
    return offersLessons(
      this.config.config.mode,
      project?.lessons ?? null,
      await this.teamOverrideOf(run),
    );
  }

  /** "Skip" on the archive notice: the queued stretch never runs, and the watermark moves past it. */
  async skip(segmentId: string): Promise<LessonSegmentWire> {
    const em = this.em.fork();
    const segment = await this.segments.getById(segmentId, em);
    if (segment === null) {
      throw new NotFoundException(
        'LESSON_SEGMENT_NOT_FOUND',
        `no stretch ${segmentId}`,
      );
    }
    if (segment.status !== 'queued') {
      throw new ConflictException(
        'LESSON_SEGMENT_DECIDED',
        `this stretch is already ${segment.status}`,
      );
    }
    const run = await this.runDao.getById(segment.runId, em);
    await em.transactional(async (tx) => {
      await this.segments.updateById(
        segment.id,
        { status: 'skipped', skipReason: 'user_skipped', leaseUntil: null },
        tx,
      );
      if (run !== null && (run.reflectedThroughSeq ?? -1) < segment.toSeq) {
        await this.runDao.updateById(
          run.id,
          { reflectedThroughSeq: segment.toSeq },
          tx,
        );
      }
    });
    this.events.publishChanged(segment.runId);
    const skipped = Object.assign(segment, {
      status: 'skipped' as const,
      skipReason: 'user_skipped' as const,
    });
    return this.wireOf(skipped, run, em);
  }

  async list(query: LessonSegmentListQuery): Promise<LessonSegmentWire[]> {
    const em = this.em.fork();
    const statuses =
      query.status === undefined
        ? DEFAULT_LIST_STATUSES
        : query.status
            .split(',')
            .map((part) => part.trim())
            .filter((part): part is LessonSegmentStatus =>
              (LESSON_SEGMENT_STATUSES as readonly string[]).includes(part),
            );
    const segments = await this.segments.listByStatus(
      statuses,
      query.runId ?? null,
      em,
    );
    const wires: LessonSegmentWire[] = [];
    for (const segment of segments) {
      wires.push(
        await this.wireOf(
          segment,
          await this.runDao.getById(segment.runId, em),
          em,
        ),
      );
    }
    return wires;
  }

  /** What reflecting on the thread's stretch past its last reflection would cost, for the delete dialog. */
  async threadEstimate(
    query: LessonEstimateQuery,
  ): Promise<ThreadLessonEstimate> {
    const em = this.em.fork();
    const run = await this.runDao.getById(query.runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${query.runId}`);
    }
    const fromSeq = run.reflectedThroughSeq ?? -1;
    const toSeq = await this.itemDao.maxSeqExcept(run.id, LESSON_ROW_KINDS, em);
    const reflectable =
      toSeq > fromSeq &&
      isReflectable(run) &&
      run.pendingDeleteAt === null &&
      !(await this.reflecting(run.id, em));
    const signals = reflectable
      ? await readLessonSignals(this.itemDao, run.id, fromSeq, toSeq, em)
      : [];
    const range = { fromSeq, toSeq: Math.max(fromSeq, toSeq) };
    const checker = this.config.checkChoice();
    return {
      estimate: await this.estimates.estimate(
        run,
        range,
        this.config.reflectionChoice(run),
        em,
      ),
      check:
        checker === null
          ? null
          : await this.estimates.estimate(run, range, checker, em),
      signals: signals.length,
      fromSeq,
      toSeq,
    };
  }

  private async closeNow(
    runId: string,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonSegment | null> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || !isReflectable(run) || run.pendingDeleteAt !== null) {
      return null;
    }
    const fromSeq = run.reflectedThroughSeq ?? -1;
    const toSeq = await this.itemDao.maxSeqExcept(run.id, LESSON_ROW_KINDS, em);
    if (toSeq <= fromSeq) {
      return null;
    }
    const queued = await this.segments.queuedOf(run.id, em);
    if (
      queued !== null &&
      queued.fromSeq === fromSeq &&
      queued.toSeq >= toSeq
    ) {
      return null;
    }
    if (
      !(await this.lessonsOnFor(run)) ||
      (await this.reflecting(run.id, em))
    ) {
      return null;
    }
    const signals = await readLessonSignals(
      this.itemDao,
      run.id,
      fromSeq,
      toSeq,
      em,
    );
    if (signals.length === 0) {
      return null;
    }
    const estimate = await this.estimates.estimate(
      run,
      { fromSeq, toSeq },
      this.config.reflectionChoice(run),
      em,
    );
    const fields = {
      fromSeq,
      toSeq,
      closedBy,
      closedAt: new Date(),
      signals: JSON.stringify(signals),
      status: 'queued' as const,
      reflectionRunId: null,
      checkRunId: null,
      failReason: null,
      estimateTokens: estimate.tokens,
      estimateUsd: estimate.usd,
    };
    let segment: LessonSegment;
    if (queued === null) {
      segment = await this.segments.create(
        { runId: run.id, attempts: 0, ...fields },
        em,
      );
    } else {
      await this.segments.updateById(queued.id, fields, em);
      segment = Object.assign(queued, fields);
    }
    this.events.publishChanged(run.id);
    return segment;
  }

  private async wireOf(
    segment: LessonSegment,
    run: Run | null,
    em: EntityManager,
  ): Promise<LessonSegmentWire> {
    const source = run ?? {
      id: segment.runId,
      agentKind: null,
      configDir: null,
      model: null,
      effort: null,
      contextWindow: null,
      modelParameters: null,
    };
    const range = { fromSeq: segment.fromSeq, toSeq: segment.toSeq };
    const checker = this.config.checkChoice();
    return {
      id: segment.id,
      runId: segment.runId,
      sourceTitle: run?.title ?? null,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      closedBy: segment.closedBy,
      closedAt: segment.closedAt.toISOString(),
      signals: (JSON.parse(segment.signals) as LessonSignal[]).map(
        ({ kind, seq }) => ({ kind, seq }),
      ),
      status: segment.status,
      reflectionRunId: segment.reflectionRunId,
      checkRunId: segment.checkRunId,
      failReason: segment.failReason,
      estimate: await this.estimates.estimate(
        source,
        range,
        this.config.reflectionChoice(source),
        em,
      ),
      checkEstimate:
        checker === null
          ? null
          : await this.estimates.estimate(source, range, checker, em),
    };
  }

  private async reflecting(runId: string, em: EntityManager): Promise<boolean> {
    const reflections = await this.runDao.listLessonReflectionsOf(runId, em);
    return reflections.some((run) => !isTerminalRunStatus(run.status));
  }

  private async teamOverrideOf(run: Run): Promise<'on' | 'off' | null> {
    if (run.teamId === null) {
      return null;
    }
    if (this.teams !== undefined) {
      try {
        return (await this.teams.get(run.teamId)).team.lessons ?? null;
      } catch {
        return teamLessonsOverrideOf(run.teamSnapshot);
      }
    }
    return teamLessonsOverrideOf(run.teamSnapshot);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
