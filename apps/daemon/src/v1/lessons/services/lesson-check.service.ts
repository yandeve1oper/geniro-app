import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';

import { environment } from '../../../environments';
import type { AnalysisTurn } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { ChatService } from '../../agents/services/chat.service';
import { existingDirectory } from '../../agents/utils/resolve-directory';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { AgentKind, isTerminalRunStatus } from '../../runs/runs.types';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  type CheckLessonsCall,
  LESSON_CHECK_REASON_MAX_CHARS,
  LESSON_RULE_MAX_CHARS,
  LESSON_SEGMENT_LEASE_MS,
  LESSON_SEGMENT_MAX_ATTEMPTS,
  LESSON_TITLE_MAX_CHARS,
  LESSONS_REFLECTION_APPROVAL,
  type LessonTarget,
} from '../lessons.types';
import {
  lessonsCheckBrief,
  lessonsCheckGuide,
} from '../utils/lessons-check-guide';
import { runFailureOf } from '../utils/run-failure';
import { LessonFilingService } from './lesson-filing.service';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

export type LessonCheckRefusalCode =
  | 'NOT_A_CHECK'
  | 'ALREADY_CHECKED'
  | 'UNKNOWN_LESSON'
  | 'MISSING_VERDICT'
  | 'DUPLICATE_VERDICT'
  | 'REWRITE_MISMATCH'
  | 'TOO_LONG'
  | 'CONTAINS_SECRET';

export type LessonChecked =
  | { status: 'recorded'; kept: number; dropped: number }
  | {
      status: 'refused';
      problems: { code: LessonCheckRefusalCode; reason: string }[];
    };

/**
 * "Check found lessons with": a second hidden chat (`analysisPurpose =
 * 'lessons_check'`) on the CLI, profile and model the settings name judges
 * each lesson a reflection found against the five gates, through
 * `check_lessons`, before anything reaches memory. `keep` and `rewrite` are
 * filed, `drop` stays on the card with its reason. A check that cannot answer
 * after `LESSON_SEGMENT_MAX_ATTEMPTS` leaves its lessons for the user's Save
 * or Reject.
 */
@Injectable()
export class LessonCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LessonCheckService.name);
  private readonly attempts = new Map<string, number>();
  private subscription: Subscription | null = null;
  private release: (() => void) | null = null;

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
    private readonly filing: LessonFilingService,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
  ) {}

  onModuleInit(): void {
    this.release = this.filing.useCheck((segment, rows) =>
      this.start(segment, rows),
    );
    this.subscription = this.bus.allStatuses().subscribe((event) => {
      if (event.status !== null && isTerminalRunStatus(event.status)) {
        void this.settled(event.runId).catch((err: unknown) => {
          this.logger.warn(
            `lessons check ${event.runId} not settled: ${messageOf(err)}`,
          );
        });
      }
    });
  }

  onModuleDestroy(): void {
    this.release?.();
    this.subscription?.unsubscribe();
  }

  /** Start the check of a reflection's lessons; a check that cannot start is a failed attempt. */
  async start(
    segment: LessonSegment,
    rows: readonly LessonProposal[],
  ): Promise<void> {
    const choice = this.config.checkChoice();
    const em = this.em.fork();
    const source = await this.runDao.getById(segment.runId, em);
    if (choice === null || source === null || rows.length === 0) {
      await this.filing.deliver(segment, rows, null);
      return;
    }
    const attempt = (this.attempts.get(segment.id) ?? 0) + 1;
    this.attempts.set(segment.id, attempt);
    const project = await this.projectScope.projectOfRun(source);
    let runId: string;
    try {
      const run = await this.chats.createChat({
        agentKind: choice.agentKind,
        cwd:
          (source.cwd === null ? null : existingDirectory(source.cwd)) ??
          (project?.folder === undefined || project.folder === null
            ? null
            : existingDirectory(project.folder)) ??
          environment.userDataDir,
        projectId: project?.id ?? null,
        approval: LESSONS_REFLECTION_APPROVAL,
        model: choice.model ?? undefined,
        effort: choice.effort ?? undefined,
        configDir: choice.configDir ?? undefined,
        contextWindow: choice.contextWindow ?? undefined,
        ...(Object.keys(choice.modelParameters).length === 0
          ? {}
          : { modelParameters: choice.modelParameters }),
        title: `Lessons check: ${source.title ?? 'untitled thread'}`,
        taskInstructions: lessonsCheckGuide(this.memory.enabled),
        analysisSource: {
          runId: source.id,
          seq: segment.toSeq,
          working: false,
          purpose: 'lessons_check',
        },
      });
      runId = run.id;
    } catch (error) {
      await this.failAttempt(segment, rows, null, messageOf(error));
      return;
    }
    await this.segments.updateById(
      segment.id,
      {
        status: 'checking',
        checkRunId: runId,
        leaseUntil: new Date(Date.now() + LESSON_SEGMENT_LEASE_MS),
      },
      em,
    );
    for (const row of rows) {
      await this.proposals.updateById(row.id, { checkRunId: runId }, em);
    }
    try {
      await this.chats.sendMessage(
        runId,
        lessonsCheckBrief({
          title: source.title,
          fromSeq: segment.fromSeq,
          toSeq: segment.toSeq,
          lessons: rows.map((row) => ({
            id: row.id,
            title: row.title,
            rule: row.rule,
            why: row.why,
            signalKind: row.signalKind,
            evidenceSeq: row.evidenceSeq,
            evidenceQuote: row.evidenceQuote,
            target: JSON.parse(row.target) as LessonTarget,
            dedup: row.dedup,
          })),
        }),
      );
    } catch (error) {
      await this.chats.delete(runId).catch(() => undefined);
      await this.failAttempt(
        Object.assign(segment, { checkRunId: runId }),
        rows,
        null,
        messageOf(error),
      );
      return;
    }
    this.events.publishChanged(segment.runId);
  }

  /** Where `check_lessons` lands: a verdict for every lesson, or nothing recorded. */
  async file(
    turn: AnalysisTurn,
    call: CheckLessonsCall,
  ): Promise<LessonChecked> {
    if (turn.purpose !== 'lessons_check') {
      return refusedWith('NOT_A_CHECK', 'only a lessons check files verdicts');
    }
    const em = this.em.fork();
    const segment = await this.segments.ofCheck(turn.analysisRunId, em);
    if (segment === null || segment.reflectionRunId === null) {
      return refusedWith(
        'NOT_A_CHECK',
        'this check was started on no reflection',
      );
    }
    if (segment.status !== 'checking') {
      return refusedWith(
        'ALREADY_CHECKED',
        'this check has already filed its verdicts',
      );
    }
    const rows = (
      await this.proposals.ofReflection(segment.reflectionRunId, em)
    ).filter((row) => row.status === 'checking');
    const problems = verdictProblems(rows, call);
    if (problems.length > 0) {
      return { status: 'refused', problems };
    }
    let dropped = 0;
    for (const verdict of call.verdicts) {
      const row = rows.find(
        (candidate) => candidate.id === verdict.proposalId,
      )!;
      row.checkVerdict = verdict.verdict;
      row.checkReason = verdict.reason.trim();
      if (verdict.verdict === 'drop') {
        row.status = 'dropped_by_check';
        row.decidedAt = new Date();
        dropped += 1;
      } else if (
        verdict.verdict === 'rewrite' &&
        verdict.rewrite !== undefined
      ) {
        row.title = verdict.rewrite.title.trim();
        row.rule = verdict.rewrite.rule.trim();
      }
    }
    await em.flush();
    this.attempts.delete(segment.id);
    const check = await this.checkFacts(turn.analysisRunId, em);
    await this.filing.deliver(segment, rows, check);
    return { status: 'recorded', kept: rows.length - dropped, dropped };
  }

  /** Take back a check that outlived its lease: cancelled, and counted as a failed attempt. */
  async abandon(segment: LessonSegment): Promise<void> {
    if (segment.checkRunId !== null) {
      await this.chats.cancel(segment.checkRunId).catch(() => undefined);
    }
    const rows = await this.heldRows(segment);
    await this.failAttempt(
      segment,
      rows,
      segment.checkRunId,
      'the check ran past its 30-minute limit',
    );
  }

  /** A check ended without its verdicts: a failed attempt. */
  private async settled(runId: string): Promise<void> {
    const em = this.em.fork();
    const segment = await this.segments.ofCheck(runId, em);
    if (segment === null || segment.status !== 'checking') {
      return;
    }
    const rows = await this.heldRows(segment);
    await this.failAttempt(
      segment,
      rows,
      runId,
      await runFailureOf(
        this.itemDao,
        await this.runDao.getById(runId, em),
        'the check ended without its verdicts',
        em,
      ),
    );
  }

  private async failAttempt(
    segment: LessonSegment,
    rows: readonly LessonProposal[],
    checkRunId: string | null,
    reason: string,
  ): Promise<void> {
    const attempts =
      this.attempts.get(segment.id) ?? LESSON_SEGMENT_MAX_ATTEMPTS;
    if (attempts < LESSON_SEGMENT_MAX_ATTEMPTS && rows.length > 0) {
      await this.start(segment, rows);
      return;
    }
    this.attempts.delete(segment.id);
    const em = this.em.fork();
    await this.filing.deliverUnchecked(
      segment,
      rows,
      checkRunId === null ? null : await this.checkFacts(checkRunId, em),
      `check: ${reason}`,
    );
  }

  private async heldRows(segment: LessonSegment): Promise<LessonProposal[]> {
    if (segment.reflectionRunId === null) {
      return [];
    }
    return (
      await this.proposals.ofReflection(segment.reflectionRunId, this.em.fork())
    ).filter((row) => row.status === 'checking');
  }

  private async checkFacts(
    checkRunId: string,
    em: EntityManager,
  ): Promise<{ runId: string; agentKind: AgentKind; model: string | null }> {
    const run = await this.runDao.getById(checkRunId, em);
    return {
      runId: checkRunId,
      agentKind: run?.agentKind ?? AgentKind.Claude,
      model: run?.model ?? null,
    };
  }
}

function verdictProblems(
  rows: readonly LessonProposal[],
  call: CheckLessonsCall,
): { code: LessonCheckRefusalCode; reason: string }[] {
  const problems: { code: LessonCheckRefusalCode; reason: string }[] = [];
  const seen = new Set<string>();
  for (const [index, verdict] of call.verdicts.entries()) {
    const at = `verdicts[${index}]`;
    if (!rows.some((row) => row.id === verdict.proposalId)) {
      problems.push({
        code: 'UNKNOWN_LESSON',
        reason: `${at}: ${verdict.proposalId} is not a lesson your brief lists`,
      });
      continue;
    }
    if (seen.has(verdict.proposalId)) {
      problems.push({
        code: 'DUPLICATE_VERDICT',
        reason: `${at}: ${verdict.proposalId} already has a verdict`,
      });
    }
    seen.add(verdict.proposalId);
    if ((verdict.verdict === 'rewrite') !== (verdict.rewrite !== undefined)) {
      problems.push({
        code: 'REWRITE_MISMATCH',
        reason: `${at}: send a rewrite with verdict rewrite, and only then`,
      });
    }
    const texts: [string, string, number][] = [
      ['reason', verdict.reason, LESSON_CHECK_REASON_MAX_CHARS],
      ...(verdict.rewrite === undefined
        ? []
        : ([
            ['rewrite.title', verdict.rewrite.title, LESSON_TITLE_MAX_CHARS],
            ['rewrite.rule', verdict.rewrite.rule, LESSON_RULE_MAX_CHARS],
          ] as [string, string, number][])),
    ];
    for (const [field, text, max] of texts) {
      if ([...text.trim()].length > max) {
        problems.push({
          code: 'TOO_LONG',
          reason: `${at}: ${field} is over ${max} characters`,
        });
      }
      if (redactSecrets(text) !== text) {
        problems.push({
          code: 'CONTAINS_SECRET',
          reason: `${at}: ${field} contains a secret geniro knows about`,
        });
      }
    }
  }
  for (const row of rows) {
    if (!seen.has(row.id)) {
      problems.push({
        code: 'MISSING_VERDICT',
        reason: `no verdict for ${row.id} — send one for every lesson`,
      });
    }
  }
  return problems;
}

function refusedWith(
  code: LessonCheckRefusalCode,
  reason: string,
): LessonChecked {
  return { status: 'refused', problems: [{ code, reason }] };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
