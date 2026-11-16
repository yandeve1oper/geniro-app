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
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { isAnalysisRun } from '../../agents/utils/analysed-runs';
import { existingDirectory } from '../../agents/utils/resolve-directory';
import { runSnapshotOf } from '../../agents/utils/run-snapshots';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import {
  AgentKind,
  AgentKindSchema,
  isTerminalRunStatus,
  type ItemKind,
} from '../../runs/runs.types';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import {
  LESSON_REJECTED_BRIEF_MAX,
  LESSONS_REFLECTION_APPROVAL,
  type LessonSignal,
  type ReflectLessons,
  type ThreadLessonsState,
} from '../lessons.types';
import {
  foldLessonSignals,
  LESSON_SIGNAL_ITEM_KINDS,
} from '../utils/lesson-signals.fold';
import {
  lessonsReflectionBrief,
  lessonsReflectionGuide,
} from '../utils/lessons-reflection-guide';
import { LessonsConfigService } from './lessons-config.service';

const SIGNAL_PAGE_SIZE = 500;

/** The rows a reflection writes into the thread it read: never new activity to reflect on. */
const LESSON_ROW_KINDS: readonly ItemKind[] = ['lessons', 'lesson_outcome'];

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
 */
@Injectable()
export class LessonReflectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonReflectionService.name);
  private deletedSubscription: Subscription | null = null;
  /** Sources between a start's checks and its chat, so a second press cannot start a twin. */
  private readonly starting = new Set<string>();

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
  ) {}

  onModuleInit(): void {
    this.deletedSubscription = this.bus.allDeleted().subscribe((runId) => {
      this.segments
        .deleteOfRuns([runId], this.em.fork())
        .catch((err: unknown) => {
          this.logger.warn(
            `lesson segments of deleted ${runId} not dropped: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  onModuleDestroy(): void {
    this.deletedSubscription?.unsubscribe();
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
  ): Promise<LessonsReflectStarted> {
    if (this.starting.has(sourceRunId)) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is already starting',
      );
    }
    this.starting.add(sourceRunId);
    try {
      return await this.startNow(sourceRunId, input);
    } finally {
      this.starting.delete(sourceRunId);
    }
  }

  private async startNow(
    sourceRunId: string,
    input: ReflectLessons,
  ): Promise<LessonsReflectStarted> {
    const em = this.em.fork();
    const source = await this.sourceOf(sourceRunId, em);
    if (!isReflectable(source)) {
      throw new ConflictException(
        'LESSONS_NOT_REFLECTABLE',
        'an analysis, team builder or project chat is never reflected on — reflect on the thread it works on instead',
      );
    }
    if ((await this.runningReflectionOf(source.id, em)) !== null) {
      throw new ConflictException(
        'LESSONS_REFLECTING',
        'a reflection on this thread is still working',
      );
    }
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
    const signals = await this.signalsOf(source.id, fromSeq, snapshotSeq, em);
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
    const segment = await this.segments.create(
      {
        runId: source.id,
        fromSeq,
        toSeq: snapshotSeq,
        closedBy: 'manual',
        closedAt: new Date(),
        signals: JSON.stringify(signals),
        status: 'reflecting',
        attempts: 1,
      },
      em,
    );
    const settings = this.config.config;
    const settingsAgent = AgentKindSchema.safeParse(settings.agentKind);
    const agentKind =
      input.agentKind ??
      (settingsAgent.success ? settingsAgent.data : null) ??
      source.agentKind ??
      AgentKind.Claude;
    const fromSettings =
      settings.agentKind === null || settings.agentKind === agentKind;
    const run = await this.chats.createChat({
      agentKind,
      cwd: this.folderFor(source, project?.folder ?? null),
      projectId: place.projectId,
      approval: LESSONS_REFLECTION_APPROVAL,
      model: input.model ?? (fromSettings ? settings.model : null) ?? undefined,
      effort:
        input.effort ?? (fromSettings ? settings.effort : null) ?? undefined,
      configDir:
        input.configDir ??
        (source.agentKind === agentKind
          ? (source.configDir ?? undefined)
          : undefined),
      title: `Lessons: ${source.title ?? 'untitled thread'}`,
      taskInstructions: lessonsReflectionGuide(this.memory.enabled),
      analysisSource: {
        runId: source.id,
        seq: snapshotSeq,
        working,
        purpose: 'lessons',
      },
    });
    await this.segments.updateById(segment.id, { reflectionRunId: run.id }, em);
    try {
      await this.chats.sendMessage(
        run.id,
        lessonsReflectionBrief({
          title: source.title,
          fromSeq,
          toSeq: snapshotSeq,
          signals,
          rejected: rejected.map((proposal) => ({
            title: proposal.title,
            reason: proposal.rejectReason,
          })),
        }),
      );
    } catch (error) {
      await this.chats.delete(run.id).catch(() => undefined);
      await this.segments
        .updateById(segment.id, { status: 'failed' }, em)
        .catch(() => undefined);
      throw error;
    }
    return {
      reflectionRunId: run.id,
      segmentId: segment.id,
      fromSeq,
      toSeq: snapshotSeq,
    };
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

  private async signalsOf(
    runId: string,
    afterSeq: number,
    maxSeq: number,
    em: EntityManager,
  ): Promise<LessonSignal[]> {
    const items = [];
    let cursor = afterSeq;
    for (;;) {
      const page = await this.itemDao.analysisPage(
        runId,
        {
          afterSeq: cursor,
          maxSeq,
          limit: SIGNAL_PAGE_SIZE,
          kinds: LESSON_SIGNAL_ITEM_KINDS,
        },
        em,
      );
      items.push(...page);
      if (page.length < SIGNAL_PAGE_SIZE) {
        break;
      }
      cursor = page[page.length - 1]!.seq;
    }
    return foldLessonSignals(items, { afterFinishedTurn: afterSeq >= 0 });
  }

  private folderFor(source: Run, projectFolder: string | null): string {
    return (
      (source.cwd === null ? null : existingDirectory(source.cwd)) ??
      (projectFolder === null ? null : existingDirectory(projectFolder)) ??
      environment.userDataDir
    );
  }
}

function isReflectable(
  run: Pick<
    Run,
    | 'analysisSourceRunId'
    | 'analysisTeamSlug'
    | 'editsTeamSlug'
    | 'editsProjectId'
  >,
): boolean {
  return (
    !isAnalysisRun(run) &&
    run.editsTeamSlug === null &&
    run.editsProjectId === null
  );
}
