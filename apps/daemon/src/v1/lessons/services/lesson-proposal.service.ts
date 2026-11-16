import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { ConflictException, NotFoundException } from '@packages/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { parseJsonColumn } from '../../agents/utils/json-util';
import { MemoryService } from '../../memory/services/memory.service';
import { savedEntryOrThrow } from '../../memory/utils/memory-outcome';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { UsageEventDao } from '../../stats/dao/usage-event.dao';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import type {
  LessonDedup,
  LessonProposalListQuery,
  LessonProposalWire,
  LessonReflectionFacts,
  LessonTarget,
  RejectLesson,
  SaveLesson,
} from '../lessons.types';
import { billedModelOf } from '../utils/billed-model';
import { LessonRowWriter } from './lesson-row.writer';

/**
 * The user's decision on a proposed lesson. Save is the approval itself, so
 * the daemon writes the memory entry as the user — active at once, whatever
 * the review mode — and names the thread and proposal it came from.
 */
@Injectable()
export class LessonProposalService {
  constructor(
    private readonly em: EntityManager,
    private readonly proposals: LessonProposalDao,
    private readonly runDao: RunDao,
    private readonly usage: UsageEventDao,
    private readonly memory: MemoryService,
    private readonly rows: LessonRowWriter,
    private readonly items: ItemDao,
  ) {}

  async list(query: LessonProposalListQuery): Promise<LessonProposalWire[]> {
    const rows = await this.proposals.list(query, this.em.fork());
    return rows.map(toWire);
  }

  async save(id: string, input: SaveLesson): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.undecided(id, em);
    const target = input.target ?? targetOf(row);
    const title = input.title ?? row.title;
    const rule = input.rule ?? row.rule;
    const dedup = JSON.parse(row.dedup) as LessonDedup;
    const entry = savedEntryOrThrow(
      await this.memory.create(
        {
          title,
          body: memoryBodyOf(row, rule),
          type: target.type,
          projectId:
            target.scope === 'project' ? this.placeOf(row, 'project') : null,
          teamSlug: target.scope === 'team' ? this.placeOf(row, 'team') : null,
          ...(dedup.verdict !== 'new' && dedup.handle !== null
            ? { notDuplicateOf: [dedup.handle] }
            : {}),
        },
        { sourceRunId: row.sourceRunId, proposalId: row.id },
      ),
    );
    Object.assign(row, {
      title,
      rule,
      target: JSON.stringify(target),
      status: 'saved' as const,
      resultRef: entry.handle,
      decidedAt: new Date(),
    });
    await em.flush();
    await this.rows.write(row.sourceRunId, {
      kind: 'lesson_outcome',
      payload: {
        proposalId: row.id,
        status: 'saved',
        title,
        rule,
        target,
        memoryHandle: entry.handle,
        reason: null,
      },
    });
    return toWire(row);
  }

  async reject(id: string, input: RejectLesson): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.undecided(id, em);
    const reason =
      input.reason === undefined || input.reason === '' ? null : input.reason;
    Object.assign(row, {
      status: 'rejected' as const,
      rejectReason: reason,
      decidedAt: new Date(),
    });
    await em.flush();
    await this.rows.write(row.sourceRunId, {
      kind: 'lesson_outcome',
      payload: {
        proposalId: row.id,
        status: 'rejected',
        title: row.title,
        rule: row.rule,
        target: targetOf(row),
        memoryHandle: null,
        reason,
      },
    });
    return toWire(row);
  }

  /** What a lessons card's footer states about the reflection behind it, from the ledger. */
  async reflectionFacts(
    reflectionRunId: string,
  ): Promise<LessonReflectionFacts> {
    const em = this.em.fork();
    const run = await this.runDao.getById(reflectionRunId, em);
    if (
      run === null ||
      run.analysisPurpose !== 'lessons' ||
      run.agentKind === null
    ) {
      throw new NotFoundException(
        'LESSONS_REFLECTION_NOT_FOUND',
        `no lessons reflection ${reflectionRunId}`,
      );
    }
    const events = await this.usage.rowsByRuns([run.id], em);
    const turns = (await this.items.getByRun(run.id, -1, em)).filter(
      (item) => item.kind === 'turn_complete',
    );
    return {
      reflectionRunId: run.id,
      agentKind: run.agentKind,
      model:
        billedModelOf(turns.map((item) => parseJsonColumn(item.payload))) ??
        run.model,
      working: !isTerminalRunStatus(run.status),
      startedAt: run.createdAt.toISOString(),
      durationMs: sumMeasured(events.map((event) => event.durationMs)),
      costUsd: sumMeasured(events.map((event) => event.costUsd)),
      tokens: sumMeasured(
        events.flatMap((event) =>
          event.inputTokens === null && event.outputTokens === null
            ? [null]
            : [(event.inputTokens ?? 0) + (event.outputTokens ?? 0)],
        ),
      ),
    };
  }

  private async undecided(
    id: string,
    em: EntityManager,
  ): Promise<LessonProposal> {
    const row = await this.proposals.getById(id, em);
    if (row === null) {
      throw new NotFoundException('LESSON_NOT_FOUND', `no lesson ${id}`);
    }
    if (row.status !== 'proposed') {
      throw new ConflictException(
        'LESSON_DECIDED',
        `this lesson was already ${row.status}`,
      );
    }
    return row;
  }

  private placeOf(row: LessonProposal, scope: 'project' | 'team'): string {
    const place = scope === 'project' ? row.projectId : row.teamSlug;
    if (place === null) {
      throw new ConflictException(
        scope === 'project' ? 'LESSON_NO_PROJECT' : 'LESSON_NO_TEAM',
        scope === 'project'
          ? 'the thread belongs to no project — save the lesson to global memory'
          : 'the thread is not a team run — save the lesson to project or global memory',
      );
    }
    return place;
  }
}

/** The memory entry's body: the rule in full, then why, then where it came from. */
export function memoryBodyOf(
  row: Pick<
    LessonProposal,
    'why' | 'sourceTitle' | 'evidenceSeq' | 'evidenceQuote'
  >,
  rule: string,
): string {
  const from = row.sourceTitle === null ? 'a thread' : `"${row.sourceTitle}"`;
  return `${rule}\n\nWhy: ${row.why}\n\nLesson from ${from}, message #${row.evidenceSeq}: “${row.evidenceQuote}”`;
}

function targetOf(row: LessonProposal): LessonTarget {
  return JSON.parse(row.target) as LessonTarget;
}

function toWire(row: LessonProposal): LessonProposalWire {
  return {
    id: row.id,
    sourceRunId: row.sourceRunId,
    sourceTitle: row.sourceTitle,
    reflectionRunId: row.reflectionRunId,
    projectId: row.projectId,
    teamSlug: row.teamSlug,
    title: row.title,
    rule: row.rule,
    why: row.why,
    signalKind: row.signalKind,
    evidence: { seq: row.evidenceSeq, quote: row.evidenceQuote },
    target: targetOf(row),
    dedup: JSON.parse(row.dedup) as LessonDedup,
    status: row.status,
    rejectReason: row.rejectReason,
    memoryHandle: row.resultRef,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

/** A sum over figures where null is "not measured": null when none was. */
function sumMeasured(values: readonly (number | null)[]): number | null {
  const measured = values.filter((value): value is number => value !== null);
  return measured.length === 0
    ? null
    : measured.reduce((total, value) => total + value, 0);
}
