import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';
import type { Subscription } from 'rxjs';

import { environment } from '../../../environments';
import { HOST_LESSONS_TOOL } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { existingDirectory } from '../../agents/utils/resolve-directory';
import { runSnapshotOf } from '../../agents/utils/run-snapshots';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_REJECTED_BRIEF_MAX,
  LESSON_ROW_KINDS,
  LESSON_SEGMENT_LEASE_MS,
  LESSON_SEGMENT_MAX_ATTEMPTS,
  LESSONS_REFLECTION_APPROVAL,
  type LessonSegmentCloser,
  type ReflectLessons,
  type ThreadLessonsState,
} from '../lessons.types';
import { placesOfRun } from '../utils/lesson-places';
import {
  lessonsReflectionBrief,
  lessonsReflectionGuide,
} from '../utils/lessons-reflection-guide';
import { readLessonSignals } from '../utils/read-lesson-signals';
import { isReflectable } from '../utils/reflectable';
import { runFailureOf } from '../utils/run-failure';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

export interface LessonsReflectStarted {
  reflectionRunId: string;
  segmentId: string;
  fromSeq: number;
  toSeq: number;
}

/**
 * Starts a lessons reflection: a hidden chat on the thread-analysis machinery
 * (`Run.analysisPurpose = 'lessons'`) that reads the items of a thread past
 * its `reflectedThroughSeq` and files lessons with `propose_lessons`. Never
 * touches the thread's own "Analyze thread" analysis.
 *
 * A reflection takes the thread's queued stretch when it has one, so the
 * runner, "Reflect now" and a delete's extraction all end the same stretch.
 * A reflection that ends without filing is a failed attempt: its stretch goes
 * back to the queue, and after `LESSON_SEGMENT_MAX_ATTEMPTS` is left `failed`
 * with the reason, for the Settings readout.
 */
const ENDED_WITHOUT_FILING = 'the reflection ended without filing lessons';

/** The one follow-up a reflection that ended without its call is sent. */
export const LESSONS_FILE_NUDGE = `You ended without calling ${HOST_LESSONS_TOOL}, so nothing was recorded. Call it now, once — with an empty list if no lesson passed all five gates — then reply in one sentence.`;

@Injectable()
export class LessonReflectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonReflectionService.name);
  private subscriptions: Subscription[] = [];
  /** Sources between a start's checks and its chat, so a second press cannot start a twin. */
  private readonly starting = new Set<string>();
  /** Reflections already asked once to file what they found. */
  private readonly nudged = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly bus: AgentEventBus,
    private readonly memory: MemoryService,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
  ) {}

  onModuleInit(): void {
    this.subscriptions = [
      this.bus.allDeleted().subscribe((runId) => {
        this.segments
          .deleteOfRuns([runId], this.em.fork())
          .catch((err: unknown) => {
            this.logger.warn(
              `lesson segments of deleted ${runId} not dropped: ${messageOf(err)}`,
            );
          });
      }),
      this.bus.allStatuses().subscribe((event) => {
        if (event.status !== null && isTerminalRunStatus(event.status)) {
          void this.settled(event.runId).catch((err: unknown) => {
            this.logger.warn(
              `lessons reflection ${event.runId} not settled: ${messageOf(err)}`,
            );
          });
        }
      }),
    ];
  }

  onModuleDestroy(): void {
    for (const subscription of this.subscriptions) {
      subscription.unsubscribe();
    }
  }

  /** The reflection still working on this thread, if any — a delete waits for it rather than starting a second. */
  async runningReflectionId(sourceRunId: string): Promise<string | null> {
    return (
      (await this.runningReflectionOf(sourceRunId, this.em.fork()))?.id ?? null
    );
  }

  /** Whether "Reflect now" has anything to do on this thread now. */
  async state(sourceRunId: string): Promise<ThreadLessonsState> {
    const em = this.em.fork();
    const source = await this.sourceOf(sourceRunId, em);
    const running = await this.runningReflectionOf(source.id, em);
    const newest = await this.itemDao.maxSeqExcept(
      source.id,
      LESSON_ROW_KINDS,
      em,
    );
    return {
      reflectable:
        isReflectable(source) &&
        source.pendingDeleteAt === null &&
        running === null &&
        !this.starting.has(source.id) &&
        newest > (source.reflectedThroughSeq ?? -1),
      reflectionRunId: running?.id ?? null,
      reflectedThroughSeq: source.reflectedThroughSeq,
    };
  }

  async start(
    sourceRunId: string,
    input: ReflectLessons,
    closedBy: LessonSegmentCloser = 'manual',
  ): Promise<LessonsReflectStarted> {
    if (this.starting.has(sourceRunId)) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is already starting',
      );
    }
    this.starting.add(sourceRunId);
    try {
      return await this.startNow(sourceRunId, input, closedBy);
    } finally {
      this.starting.delete(sourceRunId);
    }
  }

  private async startNow(
    sourceRunId: string,
    input: ReflectLessons,
    closedBy: LessonSegmentCloser,
  ): Promise<LessonsReflectStarted> {
    const em = this.em.fork();
    const source = await this.sourceOf(sourceRunId, em);
    if (!isReflectable(source)) {
      throw new ConflictException(
        'LESSONS_NOT_REFLECTABLE',
        'an analysis, team builder or project chat is never reflected on — reflect on the thread it works on instead',
      );
    }
    if (source.pendingDeleteAt !== null && closedBy !== 'delete') {
      throw new ConflictException(
        'LESSONS_NOT_REFLECTABLE',
        'this thread is being deleted',
      );
    }
    if ((await this.runningReflectionOf(source.id, em)) !== null) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is still working',
      );
    }
    const waiting = await this.segments.queuedOf(source.id, em);
    const fromSeq = source.reflectedThroughSeq ?? -1;
    const newest = await this.itemDao.maxSeqExcept(
      source.id,
      LESSON_ROW_KINDS,
      em,
    );
    if (newest <= fromSeq) {
      throw new ConflictException(
        'LESSONS_NOTHING_NEW',
        'nothing has happened in this thread since its last reflection',
      );
    }
    const { snapshotSeq, working } = await runSnapshotOf(
      { em: this.em, runDao: this.runDao, itemDao: this.itemDao },
      source.id,
    );
    if (snapshotSeq <= fromSeq) {
      throw new ConflictException(
        'LESSONS_NOTHING_NEW',
        'nothing has happened in this thread since its last reflection',
      );
    }
    const signals = await readLessonSignals(
      this.itemDao,
      source.id,
      fromSeq,
      snapshotSeq,
      em,
    );
    const project = await this.projectScope.projectOfRun(source);
    const place = {
      projectId: project?.id ?? null,
      teamSlug: source.teamId,
    };
    const rejected = await this.proposals.rejectedIn(
      place,
      LESSON_REJECTED_BRIEF_MAX,
      em,
    );
    const stretch = {
      fromSeq,
      toSeq: snapshotSeq,
      signals: JSON.stringify(signals),
      status: 'reflecting' as const,
      leaseUntil: new Date(Date.now() + LESSON_SEGMENT_LEASE_MS),
      failReason: null,
    };
    let segment: LessonSegment;
    if (waiting === null) {
      segment = await this.segments.create(
        {
          runId: source.id,
          closedBy,
          closedAt: new Date(),
          attempts: 1,
          ...stretch,
        },
        em,
      );
    } else {
      const attempts = waiting.attempts + 1;
      await this.segments.updateById(
        waiting.id,
        { ...stretch, attempts, reflectionRunId: null, checkRunId: null },
        em,
      );
      segment = Object.assign(waiting, stretch, { attempts });
    }
    const choice = this.config.reflectionChoice(source, input);
    let runId: string;
    try {
      const run = await this.chats.createChat({
        agentKind: choice.agentKind,
        cwd: this.folderFor(source, project?.folder ?? null),
        projectId: place.projectId,
        approval: LESSONS_REFLECTION_APPROVAL,
        model: choice.model ?? undefined,
        effort: choice.effort ?? undefined,
        configDir: choice.configDir ?? undefined,
        contextWindow: choice.contextWindow ?? undefined,
        ...(Object.keys(choice.modelParameters).length === 0
          ? {}
          : { modelParameters: choice.modelParameters }),
        title: `Lessons: ${source.title ?? 'untitled thread'}`,
        taskInstructions: lessonsReflectionGuide(this.memory.enabled),
        analysisSource: {
          runId: source.id,
          seq: snapshotSeq,
          working,
          purpose: 'lessons',
        },
      });
      runId = run.id;
    } catch (error) {
      await this.failAttempt(segment, messageOf(error), em);
      throw error;
    }
    await this.segments.updateById(segment.id, { reflectionRunId: runId }, em);
    try {
      await this.chats.sendMessage(
        runId,
        lessonsReflectionBrief({
          title: source.title,
          fromSeq,
          toSeq: snapshotSeq,
          signals,
          rejected: rejected.map((proposal) => ({
            title: proposal.title,
            reason: proposal.rejectReason ?? proposal.checkReason,
          })),
          places: placesOfRun(place, source),
        }),
      );
    } catch (error) {
      await this.chats.delete(runId).catch(() => undefined);
      await this.failAttempt(segment, messageOf(error), em);
      throw error;
    }
    this.events.publishChanged(source.id);
    return {
      reflectionRunId: runId,
      segmentId: segment.id,
      fromSeq,
      toSeq: snapshotSeq,
    };
  }

  /**
   * Take back a stretch whose reflection outlived its lease: the reflection
   * is cancelled and the attempt counted as failed.
   */
  async abandon(segment: LessonSegment): Promise<void> {
    const em = this.em.fork();
    if (segment.reflectionRunId !== null) {
      await this.chats.cancel(segment.reflectionRunId).catch(() => undefined);
    }
    await this.failAttempt(
      segment,
      'the reflection ran past its 30-minute limit',
      em,
    );
  }

  /**
   * A reflection ended without filing. One that finished cleanly — no error,
   * not stopped — only forgot the call, so the same chat is asked once to
   * make it: a turn on its warm cache, where a new attempt would pay for the
   * whole read again. Anything else, or a second miss, is a failed attempt.
   */
  private async settled(runId: string): Promise<void> {
    const em = this.em.fork();
    const segment = await this.segments.ofReflection(runId, em);
    if (segment === null || segment.status !== 'reflecting') {
      this.nudged.delete(runId);
      return;
    }
    const run = await this.runDao.getById(runId, em);
    const reason = await runFailureOf(
      this.itemDao,
      run,
      ENDED_WITHOUT_FILING,
      em,
    );
    if (
      run?.status === 'completed' &&
      reason === ENDED_WITHOUT_FILING &&
      !this.nudged.has(runId)
    ) {
      this.nudged.add(runId);
      try {
        await this.chats.sendMessage(runId, LESSONS_FILE_NUDGE);
        return;
      } catch (error) {
        this.logger.warn(
          `lessons reflection ${runId} not asked to file: ${messageOf(error)}`,
        );
      }
    }
    this.nudged.delete(runId);
    await this.failAttempt(segment, reason, em);
  }

  /** Back to the queue for another attempt, or `failed` with the reason once the attempts are spent. */
  private async failAttempt(
    segment: LessonSegment,
    reason: string,
    em: EntityManager,
  ): Promise<void> {
    const spent = segment.attempts >= LESSON_SEGMENT_MAX_ATTEMPTS;
    await this.segments
      .updateById(
        segment.id,
        {
          status: spent ? 'failed' : 'queued',
          failReason: reason,
          leaseUntil: null,
        },
        em,
      )
      .catch(() => undefined);
    this.events.publishChanged(segment.runId);
  }

  private async sourceOf(runId: string, em: EntityManager): Promise<Run> {
    const source = await this.runDao.getById(runId, em);
    if (source === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `no run: ${runId}`);
    }
    return source;
  }

  private async runningReflectionOf(
    sourceRunId: string,
    em: EntityManager,
  ): Promise<Run | null> {
    const reflections = await this.runDao.listLessonReflectionsOf(
      sourceRunId,
      em,
    );
    return reflections.find((run) => !isTerminalRunStatus(run.status)) ?? null;
  }

  private folderFor(source: Run, projectFolder: string | null): string {
    return (
      (source.cwd === null ? null : existingDirectory(source.cwd)) ??
      (projectFolder === null ? null : existingDirectory(projectFolder)) ??
      environment.userDataDir
    );
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
