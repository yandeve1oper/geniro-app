import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { AnalysisTurn } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { hasHiddenText } from '../../agents/utils/hidden-text';
import { quoteIn } from '../../agents/utils/memory-check-prompt';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { placeKeyOf } from '../../knowledge/utils/knowledge-text';
import {
  memoryHandle,
  type MemorySaveOutcome,
  parseMemoryHandle,
} from '../../memory/memory.types';
import { MemoryService } from '../../memory/services/memory.service';
import { similarTitles } from '../../memory/utils/memory-text';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { AgentKind } from '../../runs/runs.types';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import type { LessonSegment } from '../entity/lesson-segment.entity';
import {
  LESSON_RULE_MAX_CHARS,
  LESSON_TITLE_MAX_CHARS,
  LESSON_WHY_MAX_CHARS,
  type LessonDedup,
  type LessonOutcomePayload,
  type LessonPlaces,
  type LessonProposalCard,
  LESSONS_PER_REFLECTION_MAX,
  type LessonSignalKind,
  type LessonsPayload,
  type LessonTarget,
} from '../lessons.types';
import { placesOfRun } from '../utils/lesson-places';
import { memoryBodyOf, placesOf } from './lesson-proposal.service';
import { LessonRowWriter } from './lesson-row.writer';
import { LessonsConfigService } from './lessons-config.service';
import { LessonsEventBus } from './lessons-events.bus';

/** One lesson as `propose_lessons` hands it over, already shape-checked. */
export interface ProposedLesson {
  title: string;
  rule: string;
  why: string;
  signalKind: LessonSignalKind;
  evidence: { seq: number; quote: string };
  target: LessonTarget;
  dedup: LessonDedup;
}

export type LessonRefusalCode =
  | 'NOT_A_REFLECTION'
  | 'ALREADY_FILED'
  | 'SOURCE_GONE'
  | 'TOO_MANY'
  | 'TOO_LONG'
  | 'EVIDENCE_OUT_OF_SEGMENT'
  | 'QUOTE_NOT_FOUND'
  | 'CONTAINS_SECRET'
  | 'UNKNOWN_HANDLE'
  | 'NEAR_DUPLICATE'
  | 'NO_PLACE_FOR_TARGET'
  | 'UNKNOWN_MEMBER'
  | 'UNKNOWN_DOCUMENT'
  | 'HIDDEN_TEXT';

export type LessonFiled =
  | { status: 'recorded'; count: number }
  | {
      status: 'refused';
      problems: { code: LessonRefusalCode; reason: string }[];
    };

/** The model behind a check, as a lessons card's footer names it. */
export interface LessonCheckFacts {
  runId: string;
  agentKind: AgentKind;
  model: string | null;
}

/** Hands proposals to the second-model check; registered by `LessonCheckService`. */
export type LessonCheckStarter = (
  segment: LessonSegment,
  proposals: readonly LessonProposal[],
) => Promise<void>;

/**
 * Where `propose_lessons` lands: checks every lesson against the stretch the
 * reflection was started on, records the proposals and moves the thread's
 * watermark. Nothing is recorded unless every lesson passes, so the model
 * corrects and sends the whole set again.
 *
 * Then each lesson is filed into shared memory at once, as a `lesson` write
 * (searchable, outside the memory index until approved) — or, with "Check
 * found lessons with" set, held until the second model's verdicts. The
 * lessons card and an outcome row per lesson go into the thread last. An
 * automatic reflection that found nothing writes no card.
 */
@Injectable()
export class LessonFilingService {
  private checkStarter: LessonCheckStarter | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly memory: MemoryService,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly proposals: LessonProposalDao,
    private readonly rows: LessonRowWriter,
    private readonly config: LessonsConfigService,
    private readonly events: LessonsEventBus,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** Register the check; the returned function unregisters it. */
  useCheck(starter: LessonCheckStarter): () => void {
    this.checkStarter = starter;
    return () => {
      if (this.checkStarter === starter) {
        this.checkStarter = null;
      }
    };
  }

  async file(
    turn: AnalysisTurn,
    lessons: readonly ProposedLesson[],
  ): Promise<LessonFiled> {
    if (turn.purpose !== 'lessons') {
      return refusedWith(
        'NOT_A_REFLECTION',
        'only a lessons reflection files lessons',
      );
    }
    const em = this.em.fork();
    const segment = await this.segments.ofReflection(turn.analysisRunId, em);
    if (segment === null) {
      return refusedWith(
        'NOT_A_REFLECTION',
        'this reflection was started on no stretch of the thread',
      );
    }
    if (segment.status !== 'reflecting') {
      return refusedWith(
        'ALREADY_FILED',
        'this reflection has already filed its lessons',
      );
    }
    const source = await this.runDao.getById(turn.sourceRunId, em);
    if (source === null) {
      return refusedWith('SOURCE_GONE', 'the thread has been deleted');
    }
    if (lessons.length > LESSONS_PER_REFLECTION_MAX) {
      return refusedWith(
        'TOO_MANY',
        `at most ${LESSONS_PER_REFLECTION_MAX} lessons — keep the ones with the hardest signals`,
      );
    }
    const project = await this.projectScope.projectOfRun(source);
    const place = { projectId: project?.id ?? null, teamSlug: source.teamId };
    const places = placesOfRun(place, source);
    const visible = await this.memory.listVisible(place);
    const problems: { code: LessonRefusalCode; reason: string }[] = [];
    for (const [index, lesson] of lessons.entries()) {
      const at = `lessons[${index}]`;
      for (const problem of this.textProblems(lesson)) {
        problems.push({
          code: problem.code,
          reason: `${at}: ${problem.reason}`,
        });
      }
      const misplaced = await this.targetProblem(lesson.target, places);
      if (misplaced !== null) {
        problems.push({
          code: misplaced.code,
          reason: `${at}: ${misplaced.reason}`,
        });
      }
      const { seq, quote } = lesson.evidence;
      if (seq <= segment.fromSeq || seq > segment.toSeq) {
        problems.push({
          code: 'EVIDENCE_OUT_OF_SEGMENT',
          reason: `${at}: seq ${seq} is outside this reflection's stretch — after ${segment.fromSeq} up to ${segment.toSeq}`,
        });
      } else if (!quoteIn(quote, await this.itemText(source.id, seq, em))) {
        problems.push({
          code: 'QUOTE_NOT_FOUND',
          reason: `${at}: the quote is not in row ${seq} — copy 8–200 characters of it exactly (view=item seq=${seq})`,
        });
      }
      const handle = lesson.dedup.handle;
      const named = handle === null ? null : parseMemoryHandle(handle);
      if (
        lesson.dedup.verdict !== 'new' &&
        (named === null ||
          !visible.some((entry) => entry.handle === memoryHandle(named)))
      ) {
        problems.push({
          code: 'UNKNOWN_HANDLE',
          reason: `${at}: ${lesson.dedup.verdict} names ${handle ?? 'no entry'}, which is not an active memory entry this thread's agents can see`,
        });
      }
      const same = visible.find((entry) =>
        similarTitles(entry.title, lesson.title),
      );
      if (same !== undefined && lesson.dedup.verdict === 'new') {
        problems.push({
          code: 'NEAR_DUPLICATE',
          reason: `${at}: ${same.handle} already says this — drop the lesson, or mark it refines ${same.handle} if yours says it better`,
        });
      }
    }
    if (problems.length > 0) {
      return { status: 'refused', problems };
    }
    const checking =
      lessons.length > 0 &&
      this.checkStarter !== null &&
      this.config.checkChoice() !== null;
    const rows = lessons.map((lesson) =>
      Object.assign(new LessonProposal(), {
        sourceRunId: source.id,
        sourceTitle: source.title,
        reflectionRunId: turn.analysisRunId,
        segmentId: segment.id,
        projectId: place.projectId,
        teamSlug: place.teamSlug,
        title: lesson.title.trim(),
        rule: lesson.rule.trim(),
        why: lesson.why.trim(),
        signalKind: lesson.signalKind,
        evidenceSeq: lesson.evidence.seq,
        evidenceQuote: lesson.evidence.quote,
        target: JSON.stringify(lesson.target),
        dedup: JSON.stringify(lesson.dedup),
        places: JSON.stringify(places),
        status: checking ? ('checking' as const) : ('proposed' as const),
      }),
    );
    const status =
      rows.length === 0 ? 'empty' : checking ? 'checking' : 'reflected';
    await em.transactional(async (tx) => {
      for (const row of rows) {
        tx.persist(row);
      }
      await this.segments.updateById(
        segment.id,
        { status, leaseUntil: checking ? segment.leaseUntil : null },
        tx,
      );
      if ((source.reflectedThroughSeq ?? -1) < segment.toSeq) {
        await this.runDao.updateById(
          source.id,
          { reflectedThroughSeq: segment.toSeq },
          tx,
        );
      }
    });
    if (rows.length === 0) {
      if (segment.closedBy === 'manual') {
        await this.writeCard(segment, turn.analysisRunId, rows, null);
      } else {
        this.events.publishChanged(source.id);
      }
      return { status: 'recorded', count: 0 };
    }
    if (checking) {
      this.events.publishChanged(source.id);
      await this.checkStarter!(
        Object.assign(segment, { status: 'checking' as const }),
        rows,
      );
      return { status: 'recorded', count: rows.length };
    }
    await this.deliver(segment, rows, null);
    return { status: 'recorded', count: rows.length };
  }

  /**
   * File every proposal still to file into memory, then put the lessons card
   * and the outcome rows into the thread and end the stretch `reflected`.
   * Proposals the check dropped are on the card with their reason.
   */
  async deliver(
    segment: LessonSegment,
    rows: readonly LessonProposal[],
    check: LessonCheckFacts | null,
  ): Promise<void> {
    const em = this.em.fork();
    const reflection =
      rows[0] === undefined
        ? null
        : await this.runDao.getById(rows[0].reflectionRunId, em);
    const outcomes: LessonOutcomePayload[] = [];
    for (const row of rows) {
      if (row.status === 'dropped_by_check') {
        outcomes.push(
          outcomeOf(row, 'dropped_by_check', null, row.checkReason),
        );
        continue;
      }
      const outcome = await this.fileOne(row, reflection);
      if (outcome !== null) {
        outcomes.push(outcome);
      }
    }
    for (const row of rows) {
      await this.proposals.updateById(
        row.id,
        {
          status: row.status,
          resultRef: row.resultRef,
          title: row.title,
          rule: row.rule,
          decidedAt: row.decidedAt,
        },
        em,
      );
    }
    await this.segments.updateById(
      segment.id,
      { status: 'reflected', leaseUntil: null },
      em,
    );
    await this.writeCard(segment, rows[0]?.reflectionRunId ?? '', rows, check);
    for (const outcome of outcomes) {
      await this.rows.write(segment.runId, {
        kind: 'lesson_outcome',
        payload: outcome,
      });
    }
  }

  /**
   * The check could not judge the lessons: they wait on the card for the
   * user's Save or Reject, as in a reflection without a check.
   */
  async deliverUnchecked(
    segment: LessonSegment,
    rows: readonly LessonProposal[],
    check: LessonCheckFacts | null,
    reason: string,
  ): Promise<void> {
    const em = this.em.fork();
    for (const row of rows) {
      row.status = 'check_failed';
      await this.proposals.updateById(row.id, { status: 'check_failed' }, em);
    }
    await this.segments.updateById(
      segment.id,
      { status: 'reflected', leaseUntil: null, failReason: reason },
      em,
    );
    await this.writeCard(segment, rows[0]?.reflectionRunId ?? '', rows, check);
  }

  private async fileOne(
    row: LessonProposal,
    reflection: {
      id: string;
      agentKind: AgentKind | null;
      model: string | null;
    } | null,
  ): Promise<LessonOutcomePayload | null> {
    const target = JSON.parse(row.target) as LessonTarget;
    const dedup = JSON.parse(row.dedup) as LessonDedup;
    if (target.kind !== 'memory' || dedup.verdict !== 'new') {
      row.status = 'proposed';
      return null;
    }
    const place =
      target.scope === 'global'
        ? { projectId: null, teamSlug: null }
        : target.scope === 'project'
          ? row.projectId === null
            ? null
            : { projectId: row.projectId, teamSlug: null }
          : row.teamSlug === null
            ? null
            : { projectId: null, teamSlug: row.teamSlug };
    if (place === null) {
      row.status = 'proposed';
      return null;
    }
    const saved: MemorySaveOutcome = await this.memory.fileLesson(
      {
        kind: 'lesson',
        runId: row.reflectionRunId,
        agentKind: reflection?.agentKind ?? null,
        model: reflection?.model ?? null,
      },
      {
        title: row.title,
        body: memoryBodyOf(row, row.rule),
        type: target.type,
      },
      place,
      { sourceRunId: row.sourceRunId, proposalId: row.id },
    );
    if (saved.kind === 'created' || saved.kind === 'updated') {
      row.status = 'saved';
      row.resultRef = saved.entry.handle;
      row.decidedAt = new Date();
      return outcomeOf(
        row,
        saved.entry.status === 'pending' ? 'pending' : 'saved',
        saved.entry.handle,
        null,
      );
    }
    if (saved.kind === 'near_duplicate') {
      const handle = saved.candidates[0]?.handle ?? saved.pending[0] ?? null;
      row.status = 'skipped_duplicate';
      row.resultRef = handle;
      row.decidedAt = new Date();
      return outcomeOf(
        row,
        'skipped_duplicate',
        handle,
        handle === null ? null : `${handle} already says this`,
      );
    }
    row.status = 'proposed';
    return null;
  }

  private async writeCard(
    segment: LessonSegment,
    reflectionRunId: string,
    rows: readonly LessonProposal[],
    check: LessonCheckFacts | null,
  ): Promise<void> {
    const em = this.em.fork();
    const reflection = await this.runDao.getById(reflectionRunId, em);
    const source = await this.runDao.getById(segment.runId, em);
    const project =
      source === null ? null : await this.projectScope.projectOfRun(source);
    const payload: LessonsPayload = {
      reflectionRunId,
      segmentId: segment.id,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      agentKind: reflection?.agentKind ?? AgentKind.Claude,
      model: reflection?.model ?? null,
      proposals: rows.map(cardOf),
      places:
        rows[0] === undefined
          ? placesOfRun(
              {
                projectId: project?.id ?? null,
                teamSlug: source?.teamId ?? null,
              },
              source,
            )
          : placesOf(rows[0]),
      check,
    };
    await this.rows.write(segment.runId, { kind: 'lessons', payload });
  }

  /** Why the thread has no place for a lesson's target, or null when it has. */
  private async targetProblem(
    target: LessonTarget,
    places: LessonPlaces,
  ): Promise<{ code: LessonRefusalCode; reason: string } | null> {
    if (target.kind === 'memory') {
      return null;
    }
    if (target.kind === 'member_instructions') {
      if (!places.team) {
        return {
          code: 'NO_PLACE_FOR_TARGET',
          reason:
            'this thread is not a team run — a lesson for how a role works goes to memory instead',
        };
      }
      return places.members.some(({ id }) => id === target.memberId)
        ? null
        : {
            code: 'UNKNOWN_MEMBER',
            reason: `${target.memberId} is not a member of this team run — its members are ${places.members.map(({ id }) => id).join(', ') || 'unreadable'}`,
          };
    }
    if (places.projectId === null) {
      return {
        code: 'NO_PLACE_FOR_TARGET',
        reason: `this thread belongs to no project — ${target.kind === 'knowledge' ? 'a procedure' : 'a rule'} without a project goes to global memory instead`,
      };
    }
    if (target.kind === 'knowledge' && target.handle !== null) {
      const { documents } = await this.knowledge.list({
        place: placeKeyOf({ projectId: places.projectId, teamSlug: null }),
        handle: target.handle,
        status: 'active',
        limit: 1,
      });
      if (documents.length === 0) {
        return {
          code: 'UNKNOWN_DOCUMENT',
          reason: `the project has no active document ${target.handle} — name one knowledge_search found, or null for a new document`,
        };
      }
    }
    return null;
  }

  private textProblems(
    lesson: ProposedLesson,
  ): { code: LessonRefusalCode; reason: string }[] {
    const problems: { code: LessonRefusalCode; reason: string }[] = [];
    const limits: [string, string, number][] = [
      ['title', lesson.title, LESSON_TITLE_MAX_CHARS],
      ['rule', lesson.rule, LESSON_RULE_MAX_CHARS],
      ['why', lesson.why, LESSON_WHY_MAX_CHARS],
    ];
    for (const [field, text, max] of limits) {
      if ([...text.trim()].length > max) {
        problems.push({
          code: 'TOO_LONG',
          reason: `${field} is over ${max} characters`,
        });
      }
    }
    const texts = [
      lesson.title,
      lesson.rule,
      lesson.why,
      lesson.evidence.quote,
    ];
    if (
      [lesson.title, lesson.rule, lesson.why].some((text) =>
        hasHiddenText(text, false),
      )
    ) {
      problems.push({
        code: 'HIDDEN_TEXT',
        reason:
          'it holds invisible or format characters — write the lesson in plain visible text',
      });
    }
    if (texts.some((text) => redactSecrets(text) !== text)) {
      problems.push({
        code: 'CONTAINS_SECRET',
        reason:
          'it contains a secret geniro knows about — write the lesson and quote without it',
      });
    }
    return problems;
  }

  private async itemText(
    runId: string,
    seq: number,
    em: EntityManager,
  ): Promise<string> {
    const [item] = await this.itemDao.analysisPage(
      runId,
      { afterSeq: seq - 1, maxSeq: seq, limit: 1 },
      em,
    );
    return item === undefined ? '' : textOfPayload(item.payload);
  }
}

function refusedWith(code: LessonRefusalCode, reason: string): LessonFiled {
  return { status: 'refused', problems: [{ code, reason }] };
}

function outcomeOf(
  row: LessonProposal,
  status: LessonOutcomePayload['status'],
  memoryHandle: string | null,
  reason: string | null,
): LessonOutcomePayload {
  return {
    proposalId: row.id,
    status,
    by: 'auto',
    title: row.title,
    rule: row.rule,
    target: JSON.parse(row.target) as LessonTarget,
    memoryHandle,
    resultRef: memoryHandle,
    reason,
  };
}

function cardOf(row: LessonProposal): LessonProposalCard {
  return {
    id: row.id,
    title: row.title,
    rule: row.rule,
    why: row.why,
    signalKind: row.signalKind,
    evidence: { seq: row.evidenceSeq, quote: row.evidenceQuote },
    target: JSON.parse(row.target) as LessonTarget,
    dedup: JSON.parse(row.dedup) as LessonDedup,
  };
}

/** Every string a stored payload holds, one per line — what a quote is looked for in. */
export function textOfPayload(payload: string): string {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return payload;
  }
  const strings: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      strings.push(node);
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (typeof node === 'object' && node !== null) {
      Object.values(node).forEach(walk);
    }
  };
  walk(value);
  return strings.join('\n');
}
