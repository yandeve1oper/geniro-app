import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { hasHiddenText } from '../../agents/utils/hidden-text';
import { parseJsonColumn } from '../../agents/utils/json-util';
import {
  KNOWLEDGE_TITLE_MAX_CHARS,
  KNOWLEDGE_WHEN_MAX_CHARS,
  type KnowledgeSaveOutcome,
} from '../../knowledge/knowledge.types';
import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { placeKeyOf } from '../../knowledge/utils/knowledge-text';
import { MemoryService } from '../../memory/services/memory.service';
import { savedEntryOrThrow } from '../../memory/utils/memory-outcome';
import type { ProjectInstructionBlock } from '../../projects/projects.types';
import { ProjectsService } from '../../projects/services/projects.service';
import { projectBlocksRefusal } from '../../projects/utils/project-instruction-blocks';
import { isTerminalRunStatus } from '../../runs/runs.types';
import { UsageEventDao } from '../../stats/dao/usage-event.dao';
import { TeamChangeService } from '../../teams/services/team-change.service';
import { LessonProposalDao } from '../dao/lesson-proposal.dao';
import type { LessonProposal } from '../entity/lesson-proposal.entity';
import {
  type EditLesson,
  LESSON_PROPOSAL_STATUSES,
  type LessonDedup,
  type LessonMoveUpPlace,
  type LessonOutcomePayload,
  type LessonPlaces,
  LessonPlacesSchema,
  type LessonProposalListQuery,
  type LessonProposalStatus,
  type LessonProposalWire,
  type LessonReflectionFacts,
  type LessonTarget,
  type RejectLesson,
  type SaveLesson,
  type UpdateLessonRule,
} from '../lessons.types';
import { billedModelOf } from '../utils/billed-model';
import { LessonRowWriter } from './lesson-row.writer';

/** The project instruction block saved lessons are appended to. */
export const LESSONS_BLOCK_ID = 'lessons';
const LESSONS_BLOCK_TITLE = 'Lessons';

/** Where a save landed, for the proposal row and its outcome. */
interface Landed {
  memoryHandle: string | null;
  resultRef: string;
}

/**
 * The user's decision on a lesson. Save is the approval itself, so the daemon
 * writes as the user — a memory entry active at once whatever the review
 * mode, one line appended to the project's or a member's instructions, or a
 * knowledge document — and names the thread and proposal it came from. A
 * lesson a reflection filed on its own is undone (its entry forgotten,
 * restorable), edited (the entry becomes the user's own) or approved (into
 * the index).
 */
@Injectable()
export class LessonProposalService {
  private readonly deciding = new Set<string>();

  constructor(
    private readonly em: EntityManager,
    private readonly proposals: LessonProposalDao,
    private readonly runDao: RunDao,
    private readonly usage: UsageEventDao,
    private readonly memory: MemoryService,
    private readonly rows: LessonRowWriter,
    private readonly items: ItemDao,
    private readonly projects: ProjectsService,
    private readonly teamChange: TeamChangeService,
    private readonly knowledge: KnowledgeService,
  ) {}

  async list(query: LessonProposalListQuery): Promise<LessonProposalWire[]> {
    const em = this.em.fork();
    const rows = await this.proposals.list(
      {
        statuses: statusesOf(query.status),
        sourceRunId: query.sourceRunId,
      },
      em,
    );
    const existing = await this.runDao.existingIds(
      rows.map((row) => row.sourceRunId),
      em,
    );
    const moveUps = await this.moveUpsOf(rows);
    const pending = await this.pendingEntriesOf(rows);
    return rows.map((row) =>
      toWire(
        row,
        existing.has(row.sourceRunId),
        moveUps.get(row.id) ?? null,
        pending.has(row.id),
      ),
    );
  }

  save(id: string, input: SaveLesson): Promise<LessonProposalWire> {
    return this.claimed(id, async () => {
      const em = this.em.fork();
      const row = await this.undecided(id, em);
      const target = input.target ?? targetOf(row);
      const title = input.title ?? row.title;
      const rule = input.rule ?? row.rule;
      const landed = await this.writeTo(row, target, title, rule);
      return this.decided(row, em, { title, rule, target, landed });
    });
  }

  /** "Update rule" on a `refines` lesson: the entry it refines takes its text, as the user's edit. */
  updateRule(id: string, input: UpdateLessonRule): Promise<LessonProposalWire> {
    return this.claimed(id, () => this.updateRuleNow(id, input));
  }

  /**
   * "Move up" on a rule that was broken again: into the project's
   * instructions when the thread has a project, else the entry it names is
   * approved into the memory index.
   */
  moveUp(id: string): Promise<LessonProposalWire> {
    return this.claimed(id, () => this.moveUpNow(id));
  }

  private async updateRuleNow(
    id: string,
    input: UpdateLessonRule,
  ): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.undecided(id, em);
    const dedup = dedupOf(row);
    if (
      dedup.verdict !== 'refines' ||
      dedup.handle === null ||
      targetOf(row).kind !== 'memory'
    ) {
      throw new ConflictException(
        'LESSON_NOT_A_REFINEMENT',
        'only a lesson that refines a memory entry updates it',
      );
    }
    const title = input.title ?? row.title;
    const rule = input.rule ?? row.rule;
    refuseHiddenText(title, rule);
    const entry = await this.liveEntry(dedup.handle);
    savedEntryOrThrow(
      await this.memory.edit(entry.id, {
        rev: entry.rev,
        title,
        body: memoryBodyOf(row, rule),
        type: entry.type,
        projectId: entry.projectId,
        teamSlug: entry.teamSlug,
      }),
    );
    return this.decided(row, em, {
      title,
      rule,
      target: targetOf(row),
      landed: { memoryHandle: entry.handle, resultRef: entry.handle },
    });
  }

  private async moveUpNow(id: string): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.undecided(id, em);
    const place = moveUpOf(row);
    const handle = dedupOf(row).handle;
    if (place === null || handle === null) {
      throw new ConflictException(
        'LESSON_NOT_BROKEN_AGAIN',
        'only a lesson whose rule was broken again moves up',
      );
    }
    const entry = await this.liveEntry(handle);
    if (entry.indexed) {
      throw new ConflictException(
        'LESSON_ALREADY_INDEXED',
        `${handle} is already in every chat's memory index — save the lesson to the project's instructions from its menu instead`,
      );
    }
    savedEntryOrThrow(
      await this.memory.setStatus({ kind: 'user' }, entry.id, 'active'),
    );
    return this.decided(row, em, {
      title: row.title,
      rule: row.rule,
      target: targetOf(row),
      landed: { memoryHandle: entry.handle, resultRef: entry.handle },
    });
  }

  /** "Undo" on a lesson filed on its own: its entry is forgotten, restorable from Settings → Memory. */
  async undo(id: string): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.filed(id, em);
    const entry = await this.entryOf(row);
    if (entry !== null && entry.status !== 'forgotten') {
      await this.memory.setStatus({ kind: 'user' }, entry.id, 'forgotten');
    }
    Object.assign(row, {
      status: 'undone' as const,
      rejectReason: 'undone on the lessons card',
      decidedAt: new Date(),
    });
    await em.flush();
    await this.writeOutcome(row, 'undone', row.resultRef, null);
    return this.wireOf(row, em);
  }

  /** "Edit" on a lesson filed on its own: the entry takes the new text and becomes the user's own. */
  async edit(id: string, input: EditLesson): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.filed(id, em);
    const entry = await this.entryOf(row);
    if (entry === null || entry.status === 'forgotten') {
      throw new ConflictException(
        'LESSON_ENTRY_GONE',
        'the memory entry this lesson wrote is gone or forgotten',
      );
    }
    savedEntryOrThrow(
      await this.memory.edit(entry.id, {
        rev: entry.rev,
        title: input.title,
        body: memoryBodyOf(row, input.rule),
        type: entry.type,
        projectId: entry.projectId,
        teamSlug: entry.teamSlug,
      }),
    );
    Object.assign(row, { title: input.title, rule: input.rule });
    await em.flush();
    await this.writeOutcome(row, 'saved', row.resultRef, null, 'user');
    return this.wireOf(row, em);
  }

  /** "Approve" on a lesson filed on its own: the entry joins the memory index, and leaves review when it waited on it. */
  async approve(id: string): Promise<LessonProposalWire> {
    const em = this.em.fork();
    const row = await this.filed(id, em);
    const entry = await this.entryOf(row);
    if (entry === null || entry.status === 'forgotten') {
      throw new ConflictException(
        'LESSON_ENTRY_GONE',
        'the memory entry this lesson wrote is gone or forgotten',
      );
    }
    await this.memory.setStatus({ kind: 'user' }, entry.id, 'active');
    await this.writeOutcome(row, 'saved', row.resultRef, null, 'user');
    return this.wireOf(row, em);
  }

  reject(id: string, input: RejectLesson): Promise<LessonProposalWire> {
    return this.claimed(id, () => this.rejectNow(id, input));
  }

  private async rejectNow(
    id: string,
    input: RejectLesson,
  ): Promise<LessonProposalWire> {
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
    await this.writeOutcome(row, 'rejected', null, reason);
    return this.wireOf(row, em);
  }

  /** What a lessons card's footer states about the reflection behind it, from the ledger. */
  async reflectionFacts(
    reflectionRunId: string,
  ): Promise<LessonReflectionFacts> {
    const em = this.em.fork();
    const run = await this.runDao.getById(reflectionRunId, em);
    if (
      run === null ||
      (run.analysisPurpose !== 'lessons' &&
        run.analysisPurpose !== 'lessons_check') ||
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
      effort: run.effort,
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
    if (row.status !== 'proposed' && row.status !== 'check_failed') {
      throw new ConflictException(
        'LESSON_DECIDED',
        `this lesson was already ${row.status}`,
      );
    }
    return row;
  }

  private async filed(id: string, em: EntityManager): Promise<LessonProposal> {
    const row = await this.proposals.getById(id, em);
    if (row === null) {
      throw new NotFoundException('LESSON_NOT_FOUND', `no lesson ${id}`);
    }
    if (!savedToMemory(row)) {
      throw new ConflictException(
        'LESSON_NOT_FILED',
        `this lesson is ${row.status}, not saved to memory`,
      );
    }
    if (!ownsEntry(row)) {
      throw new ConflictException(
        'LESSON_NOT_FILED',
        `this lesson changed the existing entry ${row.resultRef} — change it in Settings → Memory`,
      );
    }
    return row;
  }

  private async entryOf(row: LessonProposal) {
    return row.resultRef === null ? null : this.entryByHandle(row.resultRef);
  }

  private async entryByHandle(handle: string) {
    const { memories } = await this.memory.list({ handle, limit: 1 });
    return memories[0] ?? null;
  }

  /** The entry a lesson names, or `LESSON_ENTRY_GONE` when it is gone or forgotten. */
  private async liveEntry(handle: string) {
    const entry = await this.entryByHandle(handle);
    if (entry === null || entry.status === 'forgotten') {
      throw new ConflictException(
        'LESSON_ENTRY_GONE',
        `the memory entry ${handle} is gone or forgotten — save the lesson as a new entry instead`,
      );
    }
    return entry;
  }

  private async decided(
    row: LessonProposal,
    em: EntityManager,
    saved: {
      title: string;
      rule: string;
      target: LessonTarget;
      landed: Landed;
    },
  ): Promise<LessonProposalWire> {
    Object.assign(row, {
      title: saved.title,
      rule: saved.rule,
      target: JSON.stringify(saved.target),
      status: 'saved' as const,
      resultRef: saved.landed.resultRef,
      decidedAt: new Date(),
    });
    await em.flush();
    await this.writeOutcome(
      row,
      'saved',
      saved.landed.memoryHandle,
      null,
      'user',
      saved.landed.resultRef,
    );
    return this.wireOf(row, em);
  }

  private async wireOf(
    row: LessonProposal,
    em: EntityManager,
  ): Promise<LessonProposalWire> {
    const existing = await this.runDao.existingIds([row.sourceRunId], em);
    const moveUps = await this.moveUpsOf([row]);
    const pending = await this.pendingEntriesOf([row]);
    return toWire(
      row,
      existing.has(row.sourceRunId),
      moveUps.get(row.id) ?? null,
      pending.has(row.id),
    );
  }

  /** The lessons whose own memory entry still waits for the user's review. */
  private async pendingEntriesOf(
    rows: readonly LessonProposal[],
  ): Promise<Set<string>> {
    const pending = new Set<string>();
    for (const row of rows) {
      if (!ownsEntry(row)) {
        continue;
      }
      const entry = await this.entryOf(row);
      if (entry?.status === 'pending') {
        pending.add(row.id);
      }
    }
    return pending;
  }

  private async moveUpsOf(
    rows: readonly LessonProposal[],
  ): Promise<Map<string, LessonMoveUpPlace>> {
    const places = new Map<string, LessonMoveUpPlace>();
    for (const row of rows) {
      const place = moveUpOf(row);
      const handle = dedupOf(row).handle;
      if (place === null || handle === null) {
        continue;
      }
      const entry = await this.entryByHandle(handle);
      if (entry !== null && !entry.indexed) {
        places.set(row.id, place);
      }
    }
    return places;
  }

  /**
   * One decision per lesson at a time: a second press — from the card and the
   * Waiting list, or a phone — while the first still writes would append the
   * rule twice, since each write reads the file it appends to afresh.
   */
  private async claimed<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.deciding.has(id)) {
      throw new ConflictException(
        'LESSON_DECIDING',
        'this lesson is being saved already',
      );
    }
    this.deciding.add(id);
    try {
      return await work();
    } finally {
      this.deciding.delete(id);
    }
  }

  private writeTo(
    row: LessonProposal,
    target: LessonTarget,
    title: string,
    rule: string,
  ): Promise<Landed> {
    refuseHiddenText(title, rule);
    switch (target.kind) {
      case 'memory':
        return this.toMemory(row, target, title, rule);
      case 'project_instructions':
        return this.toProject(row, rule);
      case 'member_instructions':
        return this.toMember(row, target.memberId, title, rule);
      case 'knowledge':
        return this.toKnowledge(row, target.handle, title, rule);
    }
  }

  private async toMemory(
    row: LessonProposal,
    target: Extract<LessonTarget, { kind: 'memory' }>,
    title: string,
    rule: string,
  ): Promise<Landed> {
    const dedup = dedupOf(row);
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
    return { memoryHandle: entry.handle, resultRef: entry.handle };
  }

  /** One line appended to the project's "Lessons" block, at the revision read here. */
  private async toProject(row: LessonProposal, rule: string): Promise<Landed> {
    const projectId = this.placeOf(row, 'project');
    const project = await this.projects.get(projectId);
    const blocks = withLessonLine(project.instructionBlocks, ruleLine(rule));
    const refusal = projectBlocksRefusal(blocks);
    if (refusal !== null) {
      throw new ConflictException(
        refusal.tooLong
          ? 'LESSON_INSTRUCTIONS_TOO_LONG'
          : 'LESSON_INSTRUCTIONS_INVALID',
        `${refusal.message} — save the lesson to memory instead`,
      );
    }
    await this.projects.update(
      projectId,
      {
        instructionBlocks: blocks,
        expectedInstructionsRevision: project.instructionsRevision,
      },
      {
        source: 'lesson',
        recommendationIds: [],
        chatRunId: row.sourceRunId,
        cardSeq: null,
      },
    );
    return { memoryHandle: null, resultRef: projectId };
  }

  private async toMember(
    row: LessonProposal,
    memberId: string,
    title: string,
    rule: string,
  ): Promise<Landed> {
    const slug = this.placeOf(row, 'team');
    const answer = await this.teamChange.appendMemberLine({
      slug,
      memberId,
      line: ruleLine(rule),
      proposalId: row.id,
      sourceRunId: row.sourceRunId,
      summary: `Lesson for ${memberId}: ${title}`,
    });
    if (answer.saved !== true) {
      throw new ConflictException(
        typeof answer.error === 'string'
          ? `LESSON_${answer.error}`
          : 'LESSON_TEAM_NOT_SAVED',
        typeof answer.message === 'string'
          ? answer.message
          : 'the team was not changed',
      );
    }
    return { memoryHandle: null, resultRef: slug };
  }

  /** A new project document, or the lesson appended as a section to the one it names. */
  private async toKnowledge(
    row: LessonProposal,
    handle: string | null,
    title: string,
    rule: string,
  ): Promise<Landed> {
    const place = placeKeyOf({
      projectId: this.placeOf(row, 'project'),
      teamSlug: null,
    });
    const body = memoryBodyOf(row, rule);
    if (handle === null) {
      return landedIn(
        await this.knowledge.create({
          place,
          title: clipped(title, KNOWLEDGE_TITLE_MAX_CHARS),
          whenToRead: clipped(title, KNOWLEDGE_WHEN_MAX_CHARS),
          body,
        }),
      );
    }
    const [head] = (
      await this.knowledge.list({ place, handle, status: 'active', limit: 1 })
    ).documents;
    const document =
      head === undefined ? null : await this.knowledge.get(head.id);
    if (document === null) {
      throw new ConflictException(
        'LESSON_DOCUMENT_GONE',
        `the project has no active document ${handle} — file the lesson as a new document`,
      );
    }
    return landedIn(
      await this.knowledge.edit(document.id, {
        rev: document.rev,
        title: document.title,
        whenToRead: document.whenToRead,
        body: `${document.body.trimEnd()}\n\n## ${title}\n\n${body}\n`,
      }),
    );
  }

  private writeOutcome(
    row: LessonProposal,
    status: LessonOutcomePayload['status'],
    memoryHandle: string | null,
    reason: string | null,
    by: LessonOutcomePayload['by'] = 'user',
    resultRef: string | null = memoryHandle,
  ): Promise<void> {
    return this.rows.write(row.sourceRunId, {
      kind: 'lesson_outcome',
      payload: {
        proposalId: row.id,
        status,
        by,
        title: row.title,
        rule: row.rule,
        target: targetOf(row),
        memoryHandle,
        resultRef,
        reason,
      },
    });
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

/** A rule as one instructions line: a bullet, its line breaks folded. */
export function ruleLine(rule: string): string {
  return `- ${rule.trim().replace(/\s*\n\s*/g, ' ')}`;
}

/** The project's blocks with `line` appended to its "Lessons" block, which is added when missing. */
export function withLessonLine(
  blocks: readonly ProjectInstructionBlock[],
  line: string,
): ProjectInstructionBlock[] {
  const at = blocks.findIndex((block) => block.id === LESSONS_BLOCK_ID);
  if (at === -1) {
    return [
      ...blocks,
      { id: LESSONS_BLOCK_ID, title: LESSONS_BLOCK_TITLE, text: line },
    ];
  }
  return blocks.map((block, index) => {
    if (index !== at) {
      return block;
    }
    const before = block.text.trimEnd();
    return { ...block, text: before === '' ? line : `${before}\n${line}` };
  });
}

/**
 * Where "Move up" puts a rule that was broken again, or null when the lesson
 * is not one — the one place a rule broken in several threads would also be
 * offered it.
 */
export function moveUpOf(
  row: Pick<LessonProposal, 'dedup' | 'target'>,
): LessonMoveUpPlace | null {
  const dedup = JSON.parse(row.dedup) as LessonDedup;
  const target = JSON.parse(row.target) as LessonTarget;
  if (
    dedup.verdict !== 'broken_again' ||
    dedup.handle === null ||
    target.kind !== 'memory'
  ) {
    return null;
  }
  return 'memory_index';
}

/** What the thread had a place for; a row filed before places were kept reads them off its own columns. */
export function placesOf(
  row: Pick<LessonProposal, 'places' | 'projectId' | 'teamSlug'>,
): LessonPlaces {
  const stored =
    row.places === null
      ? null
      : LessonPlacesSchema.safeParse(parseJsonColumn(row.places));
  return stored?.success === true
    ? stored.data
    : {
        project: row.projectId !== null,
        team: row.teamSlug !== null,
        projectId: row.projectId,
        members: [],
      };
}

function landedIn(outcome: KnowledgeSaveOutcome): Landed {
  switch (outcome.kind) {
    case 'applied':
    case 'proposed':
      return { memoryHandle: null, resultRef: outcome.document.handle };
    case 'stale':
      throw new ConflictException(
        'LESSON_DOCUMENT_CHANGED',
        'the document changed while saving — save the lesson again',
      );
    case 'refused':
      throw new ConflictException(`LESSON_${outcome.code}`, outcome.reason);
  }
}

/** A rule and title as one later run reads them: no invisible or format characters the user could not see when saving. */
function refuseHiddenText(title: string, rule: string): void {
  if (hasHiddenText(title, false) || hasHiddenText(rule, false)) {
    throw new BadRequestException(
      'LESSON_HIDDEN_TEXT',
      'the lesson holds invisible characters — edit its text before saving',
    );
  }
}

function clipped(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function statusesOf(
  raw: string | undefined,
): readonly LessonProposalStatus[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const known = new Set<string>(LESSON_PROPOSAL_STATUSES);
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part): part is LessonProposalStatus => known.has(part));
}

function targetOf(row: LessonProposal): LessonTarget {
  return JSON.parse(row.target) as LessonTarget;
}

function dedupOf(row: LessonProposal): LessonDedup {
  return JSON.parse(row.dedup) as LessonDedup;
}

function savedToMemory(row: LessonProposal): boolean {
  return (
    row.status === 'saved' &&
    row.resultRef !== null &&
    targetOf(row).kind === 'memory'
  );
}

function ownsEntry(row: LessonProposal): boolean {
  return savedToMemory(row) && row.resultRef !== dedupOf(row).handle;
}

function toWire(
  row: LessonProposal,
  sourceExists: boolean,
  moveUp: LessonMoveUpPlace | null,
  memoryPending: boolean,
): LessonProposalWire {
  const target = targetOf(row);
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
    target,
    dedup: dedupOf(row),
    status: row.status,
    rejectReason: row.rejectReason,
    checkVerdict: row.checkVerdict,
    checkReason: row.checkReason,
    memoryHandle: target.kind === 'memory' ? row.resultRef : null,
    resultRef: row.resultRef,
    places: placesOf(row),
    moveUp,
    undoable: ownsEntry(row),
    memoryPending,
    sourceExists,
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
