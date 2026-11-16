import type { EntityManager } from '@mikro-orm/sqlite';

import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Run } from '../../runs/entity/run.entity';
import type {
  AnalysedRun,
  AnalysisReadScope,
  AnalysisSource,
  AnalysisTurn,
} from '../chat.types';
import type { RunDao } from '../dao/run.dao';

/** `Run.analysisRuns` as the column stores it. */
export function writeAnalysedRuns(runs: readonly AnalysedRun[]): string {
  return JSON.stringify(
    runs.map(({ runId, snapshotSeq, working }) => ({
      runId,
      snapshotSeq,
      working,
    })),
  );
}

/**
 * `Run.analysisRuns` read back, newest first. An entry that does not read is
 * dropped rather than failing the analysis; an unreadable column reads as no
 * runs.
 */
export function readAnalysedRuns(value: string | null): AnalysedRun[] {
  if (value === null) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry: unknown): AnalysedRun[] => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { runId, snapshotSeq, working } = entry as Record<string, unknown>;
    return typeof runId === 'string' &&
      typeof snapshotSeq === 'number' &&
      Number.isInteger(snapshotSeq) &&
      snapshotSeq >= 0
      ? [{ runId, snapshotSeq, working: working === true }]
      : [];
  });
}

/**
 * What an analysis chat's turn reads, or null for a chat that is not an
 * analysis: a thread analysis reads its one source, a team analysis the
 * runs it was started on, the newest of them standing for a read that names
 * none.
 */
export function analysisTurnOf(
  analysisRunId: string,
  run: Pick<
    Run,
    | 'analysisSourceRunId'
    | 'analysisSourceSeq'
    | 'analysisSourceWorking'
    | 'analysisTeamSlug'
    | 'analysisRuns'
    | 'analysisPurpose'
  >,
): AnalysisTurn | null {
  if (run.analysisSourceRunId !== null && run.analysisSourceSeq !== null) {
    return {
      analysisRunId,
      sourceRunId: run.analysisSourceRunId,
      snapshotSeq: run.analysisSourceSeq,
      sourceWorking: run.analysisSourceWorking ?? false,
      ...(run.analysisPurpose === 'lessons' ? { purpose: 'lessons' } : {}),
    };
  }
  if (run.analysisTeamSlug === null) {
    return null;
  }
  return teamAnalysisTurn(
    analysisRunId,
    run.analysisTeamSlug,
    readAnalysedRuns(run.analysisRuns),
  );
}

/**
 * A turn reading a team's runs, newest first — a team analysis's, or
 * a builder chat's over the runs snapshotted when its turn began. Null with no
 * run to read.
 */
export function teamAnalysisTurn(
  analysisRunId: string,
  slug: string,
  runs: readonly AnalysedRun[],
): AnalysisTurn | null {
  const newest = runs[0];
  if (newest === undefined) {
    return null;
  }
  return {
    analysisRunId,
    sourceRunId: newest.runId,
    snapshotSeq: newest.snapshotSeq,
    sourceWorking: newest.working,
    team: {
      slug,
      runs: runs.map(({ runId, snapshotSeq, working }) => ({
        runId,
        snapshotSeq,
        working,
      })),
    },
  };
}

/** Every run an analysis reads: a team analysis's runs, else its one source. */
export function analysedRunIdsOf(turn: AnalysisReadScope): string[] {
  return turn.team
    ? turn.team.runs.map((run) => run.runId)
    : [turn.sourceRunId];
}

/** The live projects the runs an analysis reads belong to, by id. */
export async function analysedProjectIdsOf(
  turn: AnalysisReadScope,
  readers: {
    runDao: Pick<RunDao, 'getById'>;
    projectScope: Pick<ProjectScopeService, 'projectOfRun'>;
  },
  em: EntityManager,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const runId of analysedRunIdsOf(turn)) {
    const run = await readers.runDao.getById(runId, em);
    const project = run ? await readers.projectScope.projectOfRun(run) : null;
    if (project) {
      ids.add(project.id);
    }
  }
  return ids;
}

/**
 * The analysed runs' projects whose default team is the team the run ran —
 * the only projects whose overlay of that team a run would use.
 */
export async function overlayProjectIdsOf(
  turn: AnalysisReadScope,
  readers: {
    runDao: Pick<RunDao, 'getById'>;
    projectScope: Pick<ProjectScopeService, 'projectOfRun'>;
  },
  em: EntityManager,
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const runId of analysedRunIdsOf(turn)) {
    const run = await readers.runDao.getById(runId, em);
    const project = run ? await readers.projectScope.projectOfRun(run) : null;
    if (project && run?.teamId && project.teamSlug === run.teamId) {
      ids.add(project.id);
    }
  }
  return ids;
}

/**
 * The run a read is about: the one `runId` names among those the analysis
 * reads — its sample and the runs this turn has opened
 * (`ThreadReaderService.readSourceOf`) — or, named none, its source (a team
 * analysis's newest run). Never another: the model names it, and each of these
 * carries the snapshot a read or a citation of it is held to.
 */
export function analysedSourceOf(
  turn: AnalysisReadScope,
  runId: string | undefined,
): AnalysisSource | { error: string; message: string } {
  if (runId === undefined || runId === turn.sourceRunId) {
    return turn;
  }
  const run =
    turn.team?.runs.find((entry) => entry.runId === runId) ??
    turn.team?.opened?.get(runId);
  if (run === undefined) {
    return {
      error: 'NOT_ANALYSED',
      message: turn.team
        ? `${runId} is not open: read it with runId first — view=runs lists the sample, section="otherRuns" the rest.`
        : 'This analysis reads one thread: leave runId out.',
    };
  }
  return {
    sourceRunId: run.runId,
    snapshotSeq: run.snapshotSeq,
    sourceWorking: run.working,
  };
}

/**
 * Whether a run is itself an analysis — of a thread, or of a team across
 * its runs. Every check of it reads both columns.
 */
export function isAnalysisRun(
  run: Pick<Run, 'analysisSourceRunId' | 'analysisTeamSlug'>,
): boolean {
  return run.analysisSourceRunId !== null || run.analysisTeamSlug !== null;
}

/**
 * Whether a run works read-only: a lessons reflection is hidden, so its turns
 * get no shell or write tools, and a permission request the rules do not
 * approve is refused at once, since a card raised there would never be seen.
 */
export function runsReadOnly(run: Pick<Run, 'analysisPurpose'>): boolean {
  return run.analysisPurpose === 'lessons';
}
