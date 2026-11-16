import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { AnalysisTurn } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { quoteIn } from '../../agents/utils/memory-check-prompt';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { memoryHandle, parseMemoryHandle } from '../../memory/memory.types';
import { MemoryService } from '../../memory/services/memory.service';
import { similarTitles } from '../../memory/utils/memory-text';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { AgentKind } from '../../runs/runs.types';
import { LessonSegmentDao } from '../dao/lesson-segment.dao';
import { LessonProposal } from '../entity/lesson-proposal.entity';
import {
  LESSON_RULE_MAX_CHARS,
  LESSON_TITLE_MAX_CHARS,
  LESSON_WHY_MAX_CHARS,
  type LessonDedup,
  type LessonProposalCard,
  LESSONS_PER_REFLECTION_MAX,
  type LessonSignalKind,
  type LessonsPayload,
  type LessonTarget,
} from '../lessons.types';
import { LessonRowWriter } from './lesson-row.writer';

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
  | 'NEAR_DUPLICATE';

export type LessonFiled =
  | { status: 'recorded'; count: number }
  | {
      status: 'refused';
      problems: { code: LessonRefusalCode; reason: string }[];
    };

/**
 * Where `propose_lessons` lands: checks every lesson against the stretch the
 * reflection was started on, then records the proposals, puts the lessons
 * card into the thread they are about and moves that thread's watermark.
 * Nothing is recorded unless every lesson passes, so the model corrects and
 * sends the whole set again.
 */
@Injectable()
export class LessonFilingService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly memory: MemoryService,
    private readonly projectScope: ProjectScopeService,
    private readonly segments: LessonSegmentDao,
    private readonly rows: LessonRowWriter,
  ) {}

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
    if (segment.status === 'reflected') {
      return refusedWith(
        'ALREADY_FILED',
        'this reflection has already filed its lessons',
      );
    }
    const [source, reflection] = await Promise.all([
      this.runDao.getById(turn.sourceRunId, em),
      this.runDao.getById(turn.analysisRunId, em),
    ]);
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
        status: 'proposed' as const,
      }),
    );
    await em.transactional(async (tx) => {
      for (const row of rows) {
        tx.persist(row);
      }
      await this.segments.updateById(segment.id, { status: 'reflected' }, tx);
      if ((source.reflectedThroughSeq ?? -1) < segment.toSeq) {
        await this.runDao.updateById(
          source.id,
          { reflectedThroughSeq: segment.toSeq },
          tx,
        );
      }
    });
    const payload: LessonsPayload = {
      reflectionRunId: turn.analysisRunId,
      segmentId: segment.id,
      fromSeq: segment.fromSeq,
      toSeq: segment.toSeq,
      agentKind: reflection?.agentKind ?? AgentKind.Claude,
      model: reflection?.model ?? null,
      proposals: rows.map(cardOf),
      places: {
        project: place.projectId !== null,
        team: place.teamSlug !== null,
      },
    };
    await this.rows.write(source.id, { kind: 'lessons', payload });
    return { status: 'recorded', count: rows.length };
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
