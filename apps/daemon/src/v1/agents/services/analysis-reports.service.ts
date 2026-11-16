import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Optional } from '@nestjs/common';

import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { ItemKind } from '../../runs/runs.types';
import {
  type AnalysedThreadKind,
  type AnalysisFiled,
  type AnalysisSink,
  type AnalysisTurn,
  type ItemWire,
  KNOWLEDGE_ITEM_KINDS,
  KNOWLEDGE_MOVE_SOURCES,
  MAX_RECOMMENDATIONS_PER_TARGET,
  MEMBER_VERDICT_TARGETS,
  RECOMMENDATION_ID_PREFIX,
  RECOMMENDATION_TARGETS,
  type RecommendationItem,
  type RecommendationMarks,
  type RecommendationsPayload,
  type RecommendationsReport,
  RecommendationsReportSchema,
  type RecommendationsTeamStats,
  type RecommendationsTiming,
  type TeamPopulationReader,
  type TeamVersionIndexReader,
  type ThreadTimeline,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import {
  analysedProjectIdsOf,
  analysedSourceOf,
  overlayProjectIdsOf,
} from '../utils/analysed-runs';
import { laneOf } from '../utils/analysis-lane';
import {
  everySelectedMarked,
  knowledgeWriteOf,
  readCard,
} from '../utils/recommendations-card';
import { patchedCard } from '../utils/recommendations-patch';
import { existingDirectory } from '../utils/resolve-directory';
import { teamCardStats } from '../utils/team-runs-fold';
import { analysedThreadKindOf } from '../utils/thread-analysis-guide';
import { ThreadReaderService } from './thread-reader.service';
import { ThreadTimelineService } from './thread-timeline.service';

/** Writes one row into the analysis chat's own transcript and answers the row written. */
export type AnalysisRowWriter = (
  kind: ItemKind,
  payload: object,
) => Promise<ItemWire>;

const LESSONS_REFLECTION_REFUSAL =
  'LESSONS_REFLECTION — a lessons reflection files lessons with propose_lessons, never recommendations';

function refused(reason: string): AnalysisFiled {
  return { status: 'refused', reason };
}

const KEPT_FOR_PATCH =
  'The card is kept for this turn: send only `patch` with what fixes these, never the whole card again';

/** Every problem of a card, at once: each re-send regenerates the card's whole text. */
function refusedFor(problems: readonly string[]): AnalysisFiled {
  const listed =
    problems.length === 1
      ? problems[0]!
      : `${problems.length} problems: ${problems.map((problem, index) => `(${index + 1}) ${problem}`).join('; ')}`;
  return refused(`${listed}. ${KEPT_FOR_PATCH}`);
}

/** Whether a path is the root of a repository, where a board card's run could work. */
function isRepositoryRoot(path: string): boolean {
  const folder = existingDirectory(path);
  return folder !== null && existsSync(join(folder, '.git'));
}

/**
 * The checks between an analysis agent and its card: a recommendation must
 * cite rows that exist in the run it names (the source, or one of a team
 * analysis's runs) at or below that run's snapshot, a plain chat
 * gets no team items, ids are unique and say their target — and the
 * timing strip on the card is measured here, never taken from the agent.
 */
@Injectable()
export class AnalysisReportsService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly timelines: ThreadTimelineService,
    private readonly memory: MemoryService,
    private readonly threads: ThreadReaderService,
    private readonly projectScope: ProjectScopeService,
    @Optional() private readonly knowledge?: KnowledgeService,
  ) {}

  /**
   * The sink of one turn. It keeps the newest refused card, in memory and only
   * here: the turn that sent it is the one holding its text in its context, a
   * restart ends that turn anyway, and an on-disk copy would be one more place
   * for whatever the card quotes.
   */
  sinkFor(turn: AnalysisTurn, write: AnalysisRowWriter): AnalysisSink {
    let kept: Record<string, unknown> | null = null;
    return {
      turn,
      report: async (call, versionIndex, population) => {
        if (turn.purpose === 'lessons') {
          return refused(LESSONS_REFLECTION_REFUSAL);
        }
        let card: Record<string, unknown>;
        if ('patch' in call) {
          if (kept === null) {
            return refused(
              'NO_KEPT_CARD — no refused card is kept: one lasts only for the turn that sent it, until a card is recorded. Send the whole card',
            );
          }
          const patched = patchedCard(kept, call.patch);
          if (!patched.ok) {
            return refusedFor(patched.problems);
          }
          card = patched.card;
        } else {
          card = call.whole;
        }
        kept = card;
        const filed = await this.report(
          turn,
          card,
          write,
          versionIndex,
          population,
        );
        if (filed.status === 'recorded' && kept === card) {
          kept = null;
        }
        return filed;
      },
      mark: (marks) =>
        turn.purpose === 'lessons'
          ? Promise.resolve(refused(LESSONS_REFLECTION_REFUSAL))
          : this.mark(turn, marks, write),
    };
  }

  private async report(
    turn: AnalysisTurn,
    card: Record<string, unknown>,
    write: AnalysisRowWriter,
    versionIndex: TeamVersionIndexReader | null,
    population: TeamPopulationReader | null,
  ): Promise<AnalysisFiled> {
    const parsed = RecommendationsReportSchema.strict().safeParse(card);
    if (!parsed.success) {
      return refusedFor(
        parsed.error.issues.map((issue) =>
          issue.path.length === 0
            ? issue.message
            : `${issue.path.join('.')}: ${issue.message}`,
        ),
      );
    }
    const report = parsed.data;
    const em = this.em.fork();
    let sourceKind: AnalysedThreadKind = 'team';
    if (!turn.team) {
      const source = await this.runDao.getById(turn.sourceRunId, em);
      if (source === null) {
        return refused('SOURCE_GONE — the analysed thread has been deleted');
      }
      sourceKind = analysedThreadKindOf(source);
    }
    const readers = { runDao: this.runDao, projectScope: this.projectScope };
    const problems = checkItems(
      report,
      sourceKind,
      this.memory.enabled,
      report.items.some(
        (item) => item.target === 'project' || item.target === 'overlay',
      )
        ? await analysedProjectIdsOf(turn, readers, em)
        : new Set(),
      report.items.some((item) => item.target === 'overlay')
        ? await overlayProjectIdsOf(turn, readers, em)
        : new Set(),
      this.knowledge?.agentsMayWrite ?? false,
      isRepositoryRoot,
    );
    problems.push(...(await this.documentProblems(report)));
    // Each cited row is checked against the run it names, at that run's own
    // snapshot — a team analysis cites several.
    const cited = new Map<string, { snapshotSeq: number; seqs: Set<number> }>();
    const unknownRuns = new Set<string>();
    for (const evidence of [
      ...report.items.flatMap((item) => item.evidence),
      ...(report.members ?? []).flatMap((member) => member.evidence),
    ]) {
      const source = analysedSourceOf(turn, evidence.runId);
      if ('error' in source) {
        unknownRuns.add(evidence.runId ?? '');
        continue;
      }
      const entry = cited.get(source.sourceRunId) ?? {
        snapshotSeq: source.snapshotSeq,
        seqs: new Set<number>(),
      };
      entry.seqs.add(evidence.seq);
      cited.set(source.sourceRunId, entry);
    }
    for (const runId of unknownRuns) {
      problems.push(
        turn.team
          ? `evidence runId ${runId} has not been read in this turn: a run is cited against the snapshot its read pinned, so read it first with runId`
          : `evidence runId ${runId} is not the thread this analysis reads: leave runId out`,
      );
    }
    for (const [runId, { snapshotSeq, seqs }] of cited) {
      const wanted = [...seqs];
      const existing = await this.itemDao.existingSeqs(
        runId,
        wanted,
        snapshotSeq,
        em,
      );
      const missing = wanted.filter((seq) => !existing.has(seq));
      if (missing.length > 0) {
        problems.push(
          `evidence seq ${missing.join(', ')} ${missing.length === 1 ? 'does' : 'do'} not exist in the analysed ${turn.team ? `run ${runId}` : 'thread'} (snapshot ends at ${snapshotSeq}) — re-read and cite real rows`,
        );
      }
    }
    const teamStats = await this.teamStats(turn, versionIndex, population);
    problems.push(...checkHotspots(report, teamStats));
    // One run's timing would pass for the team's.
    const reading = turn.team
      ? null
      : await this.timelines.read(
          turn.sourceRunId,
          turn.snapshotSeq,
          turn.sourceWorking,
        );
    problems.push(
      ...checkMembers(
        report,
        sourceKind,
        teamStats !== null
          ? new Set(teamStats.agents.map((agent) => agent.node))
          : new Set(
              (reading?.fold.lanes ?? []).map((lane) => laneOf(lane.memberId)),
            ),
      ),
    );
    if (problems.length > 0) {
      return refusedFor(problems);
    }
    const payload: RecommendationsPayload = {
      ...report,
      sourceRunId: turn.sourceRunId,
      sourceKind,
      timing: reading === null ? null : timingOf(reading.timeline),
      teamStats,
    };
    const row = await write('recommendations', payload);
    return {
      status: 'recorded',
      seq: row.seq,
      count: report.items.length,
      ...(report.members === undefined
        ? {}
        : { members: report.members.length }),
    };
  }

  /** What the store's own write would refuse of a knowledge item, ahead of any Apply. */
  private async documentProblems(
    report: RecommendationsReport,
  ): Promise<string[]> {
    const problems: string[] = [];
    const byId = new Map(report.items.map((item) => [item.id, item]));
    const writable = this.knowledge?.agentsMayWrite ?? false;
    for (const item of report.items) {
      if (knowledgeItemProblems(item, byId, writable).length > 0) {
        continue;
      }
      const write = knowledgeWriteOf(item);
      const refusal =
        write === null || this.knowledge === undefined
          ? null
          : await this.knowledge.checkRecommended(write);
      if (refusal !== null) {
        problems.push(`${item.id}: ${refusal.code} — ${refusal.reason}`);
      }
    }
    return problems;
  }

  private async mark(
    turn: AnalysisTurn,
    marks: RecommendationMarks,
    write: AnalysisRowWriter,
  ): Promise<AnalysisFiled> {
    let card: RecommendationsPayload;
    try {
      card = await readCard(
        this.itemDao,
        turn.analysisRunId,
        marks.cardSeq,
        this.em.fork(),
      );
    } catch {
      return refused(
        `there is no recommendations card at seq ${marks.cardSeq} in this chat`,
      );
    }
    const ids = new Set(card.items.map((item) => item.id));
    const unknown = marks.outcomes
      .map((outcome) => outcome.id)
      .filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      return refused(`the card has no ${unknown.join(', ')}`);
    }
    const row = await write('recommendation_outcome', marks);
    return {
      status: 'recorded',
      seq: row.seq,
      count: marks.outcomes.length,
      allMarked: await everySelectedMarked(
        this.itemDao,
        turn.analysisRunId,
        marks.cardSeq,
        this.em.fork(),
      ).catch(() => false),
    };
  }

  private async teamStats(
    turn: AnalysisTurn,
    versionIndex: TeamVersionIndexReader | null,
    population: TeamPopulationReader | null,
  ): Promise<RecommendationsTeamStats | null> {
    if (!turn.team) {
      return null;
    }
    const folds = await this.threads.foldRuns(turn.team.runs);
    const index =
      versionIndex === null
        ? null
        : await versionIndex(turn.team.slug).catch(() => null);
    return teamCardStats(
      folds.flatMap(({ run, folded }) =>
        run === null || folded === null
          ? []
          : [{ title: run.title, createdAt: run.createdAt, folded }],
      ),
      index,
      population === null
        ? null
        : await population(turn.team.slug).catch(() => null),
    );
  }
}

function timingOf(timeline: ThreadTimeline): RecommendationsTiming {
  return {
    wallMs: timeline.wallMs,
    activeMs: timeline.activeMs,
    waitingMs: timeline.waitingOnUserMs,
    criticalPathMs: timeline.criticalPathMs,
    sinks: timeline.sinks.map((sink) => ({
      label: sink.memberId ?? 'agent',
      ms: sink.ms,
    })),
  };
}

/**
 * Why a report's member assessments cannot go on a card: a team thread assesses
 * its members and a plain chat none, each member once and only one that took a
 * turn in the analysed runs, and a verdict other than keep is carried out by
 * team, overlay or project items on the same card and rests on at least one
 * mark, while keep carries none.
 */
export function checkMembers(
  report: RecommendationsReport,
  sourceKind: AnalysedThreadKind,
  /** The members that took a turn in the analysed runs, as the reads name them. */
  members: ReadonlySet<string>,
): string[] {
  const assessed = report.members ?? [];
  if (sourceKind === 'chat') {
    return assessed.length === 0
      ? []
      : [
          'the analysed thread is a plain chat, so it has no members to assess — leave members out',
        ];
  }
  if (assessed.length === 0 && members.size > 0) {
    return [
      'assess the members: one entry in members for each member of the team that took a turn in the analysed runs',
    ];
  }
  const problems: string[] = [];
  const items = new Map(report.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  for (const assessment of assessed) {
    const { member, verdict } = assessment;
    if (seen.has(member)) {
      problems.push(
        `member ${member} is assessed twice — one entry per member`,
      );
    }
    seen.add(member);
    if (!members.has(member)) {
      problems.push(
        `member ${member} took no turn in the analysed runs — assess only members the reads name (${[...members].join(', ')})`,
      );
    }
    const unknown = assessment.items.filter((id) => !items.has(id));
    if (unknown.length > 0) {
      problems.push(
        `member ${member} names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the card`,
      );
    }
    const elsewhere = assessment.items.filter((id) => {
      const target = items.get(id)?.target;
      return target !== undefined && !MEMBER_VERDICT_TARGETS.includes(target);
    });
    if (elsewhere.length > 0) {
      problems.push(
        `member ${member} names ${elsewhere.join(', ')} — only team, overlay and project items (W-…, O-…, P-…) carry out a member's verdict`,
      );
    }
    if (verdict === 'keep' && assessment.items.length > 0) {
      problems.push(
        `member ${member} is kept, so it names no items — a member with a change to make is tune, reconfigure, replace or remove`,
      );
    }
    if (verdict !== 'keep' && assessment.items.length === 0) {
      problems.push(
        `member ${member}'s verdict ${verdict} names no item — file the team, overlay or project item that carries it out and name it, or keep the member`,
      );
    }
    if (
      verdict !== 'keep' &&
      assessment.usefulness === null &&
      assessment.quality === null
    ) {
      problems.push(
        `member ${member}'s verdict ${verdict} rests on no mark — judge its usefulness or quality, or keep it while the runs give too little to judge`,
      );
    }
  }
  return problems;
}

export function checkHotspots(
  report: RecommendationsReport,
  teamStats: RecommendationsTeamStats | null,
): string[] {
  const problems: string[] = [];
  const ids = new Set(report.items.map((item) => item.id));
  const nodes =
    teamStats === null
      ? null
      : new Set(teamStats.agents.map((agent) => agent.node));
  for (const hotspot of report.hotspots) {
    const unknown = hotspot.items.filter((id) => !ids.has(id));
    if (unknown.length > 0) {
      problems.push(
        `hotspot "${hotspot.title}" names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not on the card`,
      );
    }
    if (
      nodes !== null &&
      hotspot.node !== undefined &&
      !nodes.has(hotspot.node)
    ) {
      problems.push(
        `hotspot "${hotspot.title}" names member ${hotspot.node}, which took no turn in the analysed runs — name a member view=runs lists, or leave node out`,
      );
    }
  }
  return problems;
}

/** Why a knowledge item, or an item naming a document, cannot go on a card. */
function knowledgeItemProblems(
  item: RecommendationItem,
  byId: ReadonlyMap<string, RecommendationItem>,
  writable: boolean,
): string[] {
  if (item.target !== 'knowledge') {
    return item.document === undefined && item.movesWith === undefined
      ? []
      : [
          `${item.id}: only a knowledge item (K-…) names a document or what it moves with`,
        ];
  }
  if (!writable) {
    return [
      `${item.id}: knowledge is off or read-only for agents, so knowledge recommendations cannot apply`,
    ];
  }
  const problems: string[] = [];
  const { document, kind, movesWith } = item;
  if (document === undefined) {
    problems.push(`${item.id}: a knowledge item names its \`document\``);
  }
  if (!KNOWLEDGE_ITEM_KINDS.some((entry) => entry === kind)) {
    problems.push(
      `${item.id}: a knowledge item's kind is add, update or retire`,
    );
  }
  if (document !== undefined && kind === 'add') {
    if (document.handle !== undefined || document.rev !== undefined) {
      problems.push(
        `${item.id}: a new document has no handle or rev yet — kind update or retire changes one`,
      );
    }
    if (document.title === undefined || document.whenToRead === undefined) {
      problems.push(`${item.id}: a new document takes a title and whenToRead`);
    }
  } else if (
    document !== undefined &&
    (document.handle === undefined || document.rev === undefined)
  ) {
    problems.push(
      `${item.id}: kind ${kind} names the document's handle and the rev you read`,
    );
  }
  if (movesWith === undefined) {
    return problems;
  }
  const source = byId.get(movesWith);
  if (source === undefined) {
    problems.push(
      `${item.id}: movesWith names ${movesWith}, which is not on this card`,
    );
    return problems;
  }
  if (!KNOWLEDGE_MOVE_SOURCES.includes(source.target)) {
    problems.push(
      `${item.id}: text moves with a team, repo, user, project or overlay item, not ${movesWith}`,
    );
  }
  const also = [...byId.values()].find(
    (other) => other.id !== item.id && other.movesWith === movesWith,
  );
  if (also !== undefined) {
    problems.push(
      `${movesWith} moves with both ${item.id} and ${also.id} — one document per item`,
    );
  }
  return problems;
}

/** Why a report's items cannot go on a card as they are. */
export function checkItems(
  report: RecommendationsReport,
  sourceKind: AnalysedThreadKind,
  memoryEnabled: boolean,
  /** The projects the analysed runs belong to — a project item must name one. */
  projectIds: ReadonlySet<string>,
  /** Of those, the ones defaulting to the analysed team — an overlay item must name one. */
  overlayProjectIds: ReadonlySet<string> = projectIds,
  knowledgeWritable = false,
  /** Whether a folder an external item names is a repository to file a card for. */
  repositoryAt: (path: string) => boolean = () => true,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const byId = new Map(report.items.map((item) => [item.id, item]));
  for (const item of report.items) {
    if (seen.has(item.id)) {
      problems.push(`duplicate id ${item.id}`);
    }
    seen.add(item.id);
    const prefix = RECOMMENDATION_ID_PREFIX[item.target];
    if (!item.id.startsWith(prefix)) {
      problems.push(
        `${item.id} is a ${item.target} item — its id starts with ${prefix}`,
      );
    }
    if (item.target === 'memory' && !memoryEnabled) {
      problems.push(
        `${item.id}: the shared memory is off, so memory recommendations cannot apply`,
      );
    }
    problems.push(...knowledgeItemProblems(item, byId, knowledgeWritable));
    if (item.target === 'team' && sourceKind === 'chat') {
      problems.push(
        `${item.id}: the analysed thread is a plain chat, so only repo, user, memory, project and external recommendations apply`,
      );
    }
    if (item.target === 'overlay') {
      if (sourceKind === 'chat') {
        problems.push(
          `${item.id}: the analysed thread is a plain chat, so it has no team overlay to change`,
        );
      } else if (projectIds.size === 0) {
        problems.push(
          `${item.id}: the analysed runs belong to no project, so overlay recommendations cannot apply`,
        );
      } else if (!projectIds.has(item.location)) {
        problems.push(
          `${item.id}: location must be the projectId whose overlay it changes, the project of an analysed run (${[...projectIds].join(', ')}) — view=project names it`,
        );
      } else if (!overlayProjectIds.has(item.location)) {
        problems.push(
          `${item.id}: project ${item.location} defaults to another team, so its runs would not use an overlay of this one — file a team or project item instead`,
        );
      }
    }
    if (item.target === 'project') {
      if (projectIds.size === 0) {
        problems.push(
          `${item.id}: the analysed runs belong to no project, so project-instructions recommendations cannot apply`,
        );
      } else if (!projectIds.has(item.location)) {
        problems.push(
          `${item.id}: location must be the projectId of an analysed run's project (${[...projectIds].join(', ')}) — view=project names it`,
        );
      }
    }
    if (
      item.target === 'external' &&
      (!isAbsolute(item.location) || !repositoryAt(item.location))
    ) {
      problems.push(
        `${item.id}: location must be the absolute root folder of that repository on this Mac, holding its .git, and ${item.location} is not one — a repository not on this Mac cannot get a card: say so in your reply instead`,
      );
    }
  }
  for (const target of RECOMMENDATION_TARGETS) {
    const count = report.items.filter((item) => item.target === target).length;
    if (count > MAX_RECOMMENDATIONS_PER_TARGET) {
      problems.push(
        `${count} ${target} items — keep the strongest ${MAX_RECOMMENDATIONS_PER_TARGET} at most`,
      );
    }
  }
  return problems;
}
