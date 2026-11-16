import { z } from 'zod';

import {
  ChatTotalsWireSchema,
  type GoalStatus,
  MEMBER_VERDICTS,
  type MemberVerdict,
  type RecommendationEvidence,
  type StageChangeAction,
  type ThreadOutcomeKind,
} from '../agents/chat.types';
import {
  commitShaSchema,
  type RunOutcomeAcceptance,
} from '../agents/chat.types';
import type { AgentKind } from '../runs/runs.types';

/** What a turn's spend was for, beside the user's own work: a lessons reflection. */
export type UsagePurpose = 'lessons';

/**
 * One ledger row as its writers hand it over — the shape both the live recorder
 * and the boot backfill produce, so the two cannot disagree about what a usage
 * event is made of.
 */
export interface UsageEventInput {
  runId: string;
  memberId: string | null;
  seq: number;
  occurredAt: Date;
  agentKind: AgentKind | null;
  model: string | null;
  cwd: string | null;
  teamName: string | null;
  /** Absent reads as null: the user's own work. */
  purpose?: UsagePurpose | null;
  costUsd: number | null;
  estimatedCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  thinkingTokens: number | null;
  durationMs: number | null;
  apiMs: number | null;
  ttftMs: number | null;
  timeToRequestMs: number | null;
  numTurns: number | null;
}

/**
 * What one `usage_activity` row records. See its entity for what each kind means and
 * how it is keyed.
 */
export type UsageActivityKind =
  | 'thread'
  | 'pull_request'
  | 'lines'
  | 'run_outcome'
  | 'thread_outcome'
  | 'stage'
  | 'call';

/** One finished tool call as `tool_call_events` keeps it. */
export interface ToolCallLedgerRow {
  runId: string;
  seq: number;
  occurredAt: Date;
  teamSlug: string | null;
  memberId: string | null;
  agentKind: AgentKind | null;
  tool: string;
  mcpServer: string | null;
  ok: boolean;
  durationMs: number | null;
}

/** One stage change as the ledger keeps it (`usage_activity` kind `stage`). */
export interface StageLedgerRow {
  runId: string;
  seq: number;
  occurredAt: Date;
  teamSlug: string | null;
  /** The agent member that moved it; null for the user or the daemon. */
  memberId: string | null;
  /** A hand-off's new lead. */
  lead: string | null;
  stageId: string;
  action: StageChangeAction;
  /** When the stage a `complete` closed became current. */
  enteredAt: Date | null;
  durationMs: number | null;
}

/** One ended agent-to-agent call as the ledger keeps it (`usage_activity` kind `call`). */
export interface CallLedgerRow {
  runId: string;
  seq: number;
  callId: string;
  occurredAt: Date;
  teamSlug: string | null;
  caller: string;
  callee: string;
  durationMs: number | null;
  costUsd: number | null;
  turns: number | null;
  ok: boolean;
}

/** One goal as the stats read it from `run_goals`. */
export interface GoalLedgerRow {
  runId: string;
  status: GoalStatus;
  /** The member that recorded it; null for the user or a chat. */
  memberId?: string | null;
}

/** A run's recorded thread outcome as the ledger keeps it. */
export interface ThreadOutcomeLedgerRow {
  runId: string;
  seq: number;
  occurredAt: Date;
  teamSlug: string | null;
  memberId: string | null;
  kind: ThreadOutcomeKind;
}

/**
 * One pull request's newest recorded outcome, as the ledger keeps it (a `run_outcome`
 * row): copied from the run's newest `run_outcome` item for that pull request, so it
 * survives the run's teardown. `sourceSeq` is that item's seq, which orders two copies
 * of one pull request's outcome.
 */
export interface RunOutcomeLedgerRow {
  runId: string;
  sourceSeq: number;
  occurredAt: Date;
  teamSlug: string | null;
  prOwner: string;
  prRepo: string;
  prNumber: number;
  prUrl: string;
  draft: boolean;
  reviewRounds: number;
  acceptance: RunOutcomeAcceptance;
  /** Questions put to the user on the run before this outcome. */
  questionsAsked: number;
  /** Over every outcome the run recorded for the pull request; null where its rows could not be read. */
  changesRequestedRounds: number | null;
  msToAccepted: number | null;
}

/**
 * One `thread` or `pull_request` row, keyed. The live recorder and the boot sweep build these
 * the same way (`utils/activity-facts.ts`), so the two cannot disagree about a fact's key.
 */
export interface ActivityFact {
  kind: 'thread' | 'pull_request';
  dedupKey: string;
  runId: string;
  occurredAt: Date;
  prOwner?: string;
  prRepo?: string;
  prNumber?: number;
  prUrl?: string;
}

/** A pull request a thread opened, as the transcript's own `gh pr create` result named it. */
export interface PullRequestActivityInput {
  runId: string;
  owner: string;
  repo: string;
  number: number;
  url: string;
  occurredAt: Date;
}

/**
 * One cumulative snapshot of a folder's change totals against its baseline commit, taken
 * for the thread whose turn just ended. Only a MEASURED figure is a snapshot: a caller that
 * could not count the changes writes nothing, rather than a zero.
 */
export interface LineSnapshotRow {
  runId: string;
  /** The folder + branch + baseline the totals were measured against (see `lineKeyOf`); null on a row written before baselines existed. */
  lineKey: string | null;
  occurredAt: Date;
  linesAdded: number;
  linesRemoved: number;
  partial: boolean;
}

/** What the team ledger writes on a run's thread row when the run is created. */
export interface ThreadVersionStamp {
  slug: string;
  /** Null when the run kept no team copy it can read. */
  version: string | null;
  inferred: boolean | null;
}

/** One team run's thread row, as the versions table reads it. */
export interface ThreadLedgerRow {
  runId: string;
  occurredAt: Date;
  slug: string | null;
  version: string | null;
  inferred: boolean | null;
  /** Whether the metric ledgers watched the run from its creation. */
  metrics?: boolean;
}

/** Which kind of chat filed a team's recommendations card. */
export type TeamRecommendationChat = 'analysis' | 'builder';

/** One `team_recommendations` row (see the entity). */
export interface TeamRecommendationRow {
  slug: string;
  chatRunId: string;
  chatKind: TeamRecommendationChat;
  cardSeq: number;
  filedAt: Date;
  libraryVersion: string | null;
  itemId: string;
  target: string;
  territory: string;
  kind: string;
  location: string;
  title: string;
  change: string;
  rootCause: string;
  minutesSaved: number;
  costSavedUsd: number | null;
  expectedOutcome: string | null;
  confidence: number;
  risk: string;
  selectedAt: Date | null;
  outcome: string | null;
  outcomeNote: string | null;
  outcomeAt: Date | null;
  outcomeSeq: number | null;
}

/** A card's item as the ledger first files it: nothing selected or marked yet. */
export type FiledRecommendation = Omit<
  TeamRecommendationRow,
  'selectedAt' | 'outcome' | 'outcomeNote' | 'outcomeAt' | 'outcomeSeq'
>;

/** One team's chat as the recommendation ledger files it. */
export interface TeamRecommendationSource {
  chatRunId: string;
  slug: string;
  chatKind: TeamRecommendationChat;
}

/**
 * Which kind of chat assessed a team's members: one that files the team's
 * recommendations, or a thread analysis of one of its runs.
 */
export type MemberAssessmentChat = TeamRecommendationChat | 'thread';

/** A chat whose cards' member assessments the ledger files, and the CLI and model it judged with. */
export interface MemberAssessmentSource {
  chatRunId: string;
  slug: string;
  chatKind: MemberAssessmentChat;
  judge: MemberAssessmentJudge;
}

export interface MemberAssessmentJudge {
  agent: string | null;
  model: string | null;
}

export const MEMBER_ASSESSMENT_USER_VERDICTS = ['agree', 'disagree'] as const;
export type MemberAssessmentUserVerdict =
  (typeof MEMBER_ASSESSMENT_USER_VERDICTS)[number];

export interface MemberAssessmentRow {
  slug: string;
  chatRunId: string;
  chatKind: MemberAssessmentChat;
  cardSeq: number;
  filedAt: Date;
  libraryVersion: string | null;
  runs: number;
  /** The runs the analysis read, whose versions the marks describe. */
  runIds: string[];
  memberId: string;
  usefulness: number | null;
  quality: number | null;
  verdict: MemberVerdict;
  summary: string;
  evidence: RecommendationEvidence[];
  items: { id: string; title: string }[];
  judge: MemberAssessmentJudge;
  userVerdict: {
    verdict: MemberAssessmentUserVerdict;
    note: string | null;
    at: Date;
  } | null;
}

/** A team version as the history names it: its hash, its number once recorded, and whether it is the library's now. */
export interface HistoryVersionRef {
  version: string;
  number: number | null;
  current: boolean;
}

/** What one version's runs did, folded from the ledgers over every run of it, deleted ones included. */
export interface HistoryVersionFigures {
  runs: number;
  pricedRuns: number;
  costUsd: number | null;
  avgCostUsd: number | null;
  turns: number;
  avgTurns: number | null;
  /** The CLIs' own reported working time; a turn its CLI did not time adds nothing. */
  cliWorkedMs: number | null;
  avgCliWorkedMs: number | null;
  pullRequests: {
    total: number;
    accepted: number;
    changesRequested: number;
    notYet: number;
    notNeeded: number;
    avgReviewRounds: number | null;
    /** Times a pull request went to `changes_requested`, on average over those whose history was counted. */
    avgChangesRequestedRounds: number | null;
    /** From a pull request's first outcome to its acceptance, on average over the accepted ones. */
    avgMsToAccepted: number | null;
    /**
     * Questions put to the user per run, up to its last recorded outcome — over the runs
     * whose outcomes were counted, never a copy made before questions were (stored as 0).
     */
    avgQuestionsPerRun: number | null;
  };
}

/** One logged write to the team, as the history shows it. */
export interface HistoryChange {
  at: string;
  source: string;
  /** The project whose overlay of the team was changed; null for the shared team. Its `from`/`to` are then overlay file hashes, never team versions. */
  projectId: string | null;
  from: HistoryVersionRef | null;
  to: HistoryVersionRef;
  summary: string | null;
  reason: string | null;
  userNote: string | null;
  recommendationIds: string[];
  chatRunId: string | null;
  byThisChat: boolean;
  backup: string | null;
}

/** What became of a recommendation, from the ledger. */
export const HISTORY_RECOMMENDATION_STATUSES = [
  'applied',
  'skipped',
  'failed',
  'selected',
  'open',
  'not-selected',
  'unanswered',
] as const;
export type HistoryRecommendationStatus =
  (typeof HISTORY_RECOMMENDATION_STATUSES)[number];

/** One team's history, as an analysis reads it (`read_analyzed_thread` view=history). */
export interface TeamHistory {
  team: string;
  currentVersion: HistoryVersionRef | null;
  summary: {
    versions: number;
    changesLogged: number;
    recommendations: Record<HistoryRecommendationStatus, number>;
    analysedRunsByVersion: {
      version: HistoryVersionRef | null;
      runIds: string[];
    }[];
  };
  versions: {
    version: HistoryVersionRef | null;
    inferred: boolean;
    firstRunAt: string | null;
    lastRunAt: string | null;
    analysedRunIds: string[];
    figures: HistoryVersionFigures;
    madeBy: Pick<
      HistoryChange,
      'at' | 'source' | 'summary' | 'recommendationIds'
    >[];
    changes: VersionChangesWire | null;
  }[];
  changeLog: HistoryChange[];
  recommendations: {
    chatRunId: string;
    chat: TeamRecommendationChat;
    byThisChat: boolean;
    chatStillExists: boolean;
    cardSeq: number;
    filedAt: string;
    libraryVersion: HistoryVersionRef | null;
    items: {
      id: string;
      target: string;
      territory: string;
      kind: string;
      location: string;
      title: string;
      change: string;
      rootCause: string;
      expectedMinutesSavedPerRun: number;
      expectedCostSavedPerRunUsd: number | null;
      expectedOutcome: string | null;
      confidence: number;
      risk: string;
      status: HistoryRecommendationStatus;
      note: string | null;
      selectedAt: string | null;
      decidedAt: string | null;
      changedIn: { at: string; to: HistoryVersionRef }[];
    }[];
  }[];
  /** Every member's figures over every run, its work from the metric ledgers and every earlier assessment of it, newest first. */
  members: TeamStatsMemberWire[];
}

/** A set of ledger rows' spend. Every money and token figure is null when no row reported it. */
export interface SpendFigures {
  /** The runs with a ledger row in this set. */
  runs: number;
  /** Of those, the runs that reported or polled a cost. */
  pricedRuns: number;
  turns: number;
  costUsd: number | null;
  /** `costUsd` over `pricedRuns`. */
  avgCostPerRunUsd: number | null;
  /** Of `costUsd`, the part geniro priced from tokens rather than read off the CLI. */
  estimatedCostUsd: number | null;
  inputUsd: number | null;
  cacheReadUsd: number | null;
  cacheWriteUsd: number | null;
  outputUsd: number | null;
  /** Polled money and turns of a model with no list price; the five parts sum to `costUsd` before each is rounded to the cent. */
  notSplitUsd: number | null;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  /** Turns with a heavy cache write that wrote more than they read. */
  cacheMissTurns: number;
  /** Turns that wrote at least `CACHE_HEAVY_WRITE_TOKENS` to the cache. */
  heavyWriteTurns: number;
}

/** A named part of a team's spend over the whole population and its recent window. */
export interface SpendBreakdown {
  all: SpendFigures;
  /** Null when this part has no row in the window. */
  last30Days: SpendFigures | null;
}

/** A run of a team outside what its analysis samples (`read_analyzed_thread` view=runs section=otherRuns). */
export interface TeamOtherRun {
  runId: string;
  title: string | null;
  createdAt: string;
  statusNow: string;
  archived: boolean;
  /** Over every row its ledgers hold; null when none reported one. */
  costUsd: number | null;
}

/** One team's spend, as an analysis reads it (`read_analyzed_thread` view=spend). */
export interface TeamSpend {
  team: string;
  asOf: string;
  method: string;
  population: {
    covers: string;
    runs: number;
    runsWithUsage: number;
    firstAt: string | null;
    lastAt: string | null;
  };
  windows: ({
    window: 'all' | 'last30Days' | 'analysedRuns';
    covers: string;
    from: string | null;
    to: string;
  } & SpendFigures)[];
  byProject: ({
    project: string | null;
    folder: string | null;
  } & SpendBreakdown)[];
  byMember: ({ member: string | null } & SpendBreakdown)[];
  byModel: ({ agent: string | null; model: string | null } & SpendBreakdown)[];
  largestCacheWrites: {
    runId: string;
    seq: number;
    member: string | null;
    model: string | null;
    at: string;
    cacheWriteTokens: number;
    cacheReadTokens: number | null;
    costUsd: number | null;
    /** Whether this analysis can read the run's rows (view=item runId=…). */
    analysed: boolean;
  }[];
  next: string;
}

/** One `team_versions` row. */
export interface TeamVersionGraph {
  version: string;
  graph: string;
  firstSeenAt: Date;
}

/** One lines snapshot, as the fold reads it. A null count is a measurement that was never made. */
export interface LineSnapshotRead {
  runId: string;
  lineKey: string | null;
  occurredAt: Date;
  linesAdded: number | null;
  linesRemoved: number | null;
  partial: boolean | null;
}

/** What one snapshot added past the highest total its key had reached before it. */
export interface LinesIncrement {
  /** The line key the growth is counted under (see `snapshotLineKey`). */
  key: string;
  occurredAt: Date;
  addedDelta: number;
  removedDelta: number;
  partial: boolean;
}

/** The highest lines total a key reached before a period: the figure that period's growth is counted past. */
export interface LinesPeak {
  linesAdded: number;
  linesRemoved: number;
}

/**
 * The `seq` of a run's POLLED-spend row — the one ledger row per run that holds
 * what a polled-spend CLI's account poll says the run has cost, rather than a finished turn.
 *
 * A turn row's seq is its transcript row's, which starts at 0, so a negative one
 * can never collide with a real turn, and the `(runId, seq)` unique index then
 * enforces ONE polled row per run with no column of its own. That row is
 * rewritten in place as the poll moves the figure
 * (`UsageEventDao.recordPolledSpend`) — never appended — which is what keeps a
 * running total from being counted once per poll.
 */
export const POLLED_SPEND_SEQ = -1;
// A run's polled bill is several rows — one per day and model — numbered
// downward from this one (`polledSpendRows`), so every seq at or below it is
// polled spend and every one above it is a turn.

/**
 * A ledger row that has just been written — a finished turn, or a run's polled
 * spend moving — announced on the WS channel so an open Stats page can refresh
 * itself instead of showing whatever was true when it was opened.
 *
 * Deliberately NOT the figures themselves. The page's numbers are sums the
 * daemon computes over a range (see `StatsService` on why the client holds no
 * ledger), so a client adding a pushed row to its own totals would be keeping a
 * second, divergent set of books — and the first one it dropped while
 * disconnected would be invisible and permanent. It carries only enough to
 * decide whether the reading on screen is now stale, and the refetch is what
 * answers with figures.
 *
 * Outside the generated HTTP contract (it rides `/ws`, which has no OpenAPI
 * document), so its renderer-side TWIN in `daemon-client.ts` must be changed
 * with it.
 */
export interface UsageRecordedEvent {
  runId: string;
  memberId: string | null;
  /**
   * When the spend happened — ISO-8601, the same instant the row carries: the
   * turn's own, or for polled spend the run's last activity.
   */
  occurredAt: string;
  /**
   * True for a turn the ledger now holds: the one event a thread's changes are measured after.
   * False for a poll's spend and for a lines snapshot, which move a figure without a turn
   * finishing. Measuring after a snapshot's own announcement would re-read the folder for the
   * total it just wrote, and a folder that keeps changing would then keep writing a row per
   * debounce window.
   */
  turn: boolean;
}

/**
 * What the threads did over a period, beside what they cost. None of it is money, so it
 * is not a second spend ledger.
 *
 * Nullable only where "not measured" and zero are different claims. The line counts are
 * null until some thread was measured in the period, and the average is null when no
 * thread reported a working time. `threadsWithWorkedTime` is the average's denominator,
 * so a reader can see how many threads it stands for.
 */
export const ActivityTotalsWireSchema = z
  .object({
    threadsCreated: z
      .number()
      .int()
      .nonnegative()
      .describe('threads (chats and team runs) created in the period'),
    pullRequests: z
      .number()
      .int()
      .nonnegative()
      .describe('pull requests a thread opened in the period'),
    linesAdded: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'lines the threads added in the period; null when no thread was measured then',
      ),
    linesRemoved: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'lines the threads removed in the period; null when no thread was measured then',
      ),
    linesPartial: z
      .boolean()
      .describe(
        'true when a line figure is a lower bound: a listing was truncated, or some files were not counted',
      ),
    activeThreads: z
      .number()
      .int()
      .nonnegative()
      .describe('threads that finished a turn in the period'),
    threadsWithWorkedTime: z
      .number()
      .int()
      .nonnegative()
      .describe('threads whose turns reported their working time'),
    avgWorkedMs: z
      .number()
      .nonnegative()
      .nullable()
      .describe(
        'the average working time per thread that reported one, in milliseconds; null when none did',
      ),
  })
  .meta({ id: 'ActivityTotals' });
export type ActivityTotalsWire = z.infer<typeof ActivityTotalsWireSchema>;

/**
 * The most lines one measurement may count, per direction. No real diff reaches it, and the
 * sums of counts this size stay exact integers across any period a client can ask for.
 */
export const MAX_LINE_COUNT = 1_000_000_000;

/** A branch name as git reports it; null on a detached HEAD. */
const BranchSchema = z.string().min(1).max(1024).nullable();

/**
 * The repository a thread's folder belongs to, as git names its top level. The key a
 * folder's lines are filed under, because the totals are measured over the whole repository:
 * a thread in a subfolder and one at the root measure the same changes. Only honoured when it
 * contains the thread's own folder (`StatsService.measuredFolder`).
 */
const RootSchema = z.string().min(1).max(4096);

/**
 * A folder's cumulative change totals, as the desktop app measured them against the
 * folder's baseline commit after one of its threads finished a turn. A measurement that
 * could not be made is not sent at all, so no figure here ever stands in for silence.
 */
export const LineSnapshotWireSchema = z.object({
  runId: z
    .string()
    .min(1)
    .describe('the thread whose finished turn the measurement follows'),
  baseSha: commitShaSchema
    .optional()
    .describe(
      'the folder baseline the totals were measured against (`POST /v1/stats/line-baselines`); absent, the totals are the thread’s own and are counted per thread',
    ),
  branch: BranchSchema.optional().describe(
    'the branch the folder had checked out; null on a detached HEAD. Required with `baseSha`',
  ),
  root: RootSchema.optional().describe(
    'the repository the folder belongs to, as its baseline was resolved for. Required with `baseSha`',
  ),
  linesAdded: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LINE_COUNT)
    .describe('lines added against the baseline, cumulative'),
  linesRemoved: z
    .number()
    .int()
    .nonnegative()
    .max(MAX_LINE_COUNT)
    .describe('lines removed against the baseline, cumulative'),
  partial: z
    .boolean()
    .describe(
      'true when the count is a lower bound: a listing was truncated, or some files were not counted',
    ),
  occurredAt: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'when the measurement was taken; the time the daemon received it when omitted',
    ),
});
export type LineSnapshotInput = z.infer<typeof LineSnapshotWireSchema>;

/** The acknowledgement a recorded measurement earns. */
export const LineSnapshotAckSchema = z.object({ recorded: z.literal(true) });

/**
 * Which commit a thread's folder is measured against. Every thread in one folder and branch
 * measures against the same commit, so the folder's lines are one series and work two threads
 * share is counted once.
 */
export const LineBaselineRequestSchema = z.object({
  runId: z.string().min(1).describe('the thread about to be measured'),
  branch: BranchSchema.describe(
    'the branch the folder has checked out; null on a detached HEAD',
  ),
  root: RootSchema.describe(
    'the repository the thread’s folder belongs to, as git names its top level',
  ),
  staleBaseSha: commitShaSchema
    .optional()
    .describe(
      'a baseline the folder can no longer be measured from (its commit is gone, or the checkout no longer descends from it); replaced by this thread’s start commit',
    ),
});
export type LineBaselineRequest = z.infer<typeof LineBaselineRequestSchema>;

export const LineBaselineSchema = z.object({
  baseSha: commitShaSchema
    .nullable()
    .describe(
      'the commit to measure the folder against; null when there is none (no folder, or no commit the folder could start from)',
    ),
});
export type LineBaselineWire = z.infer<typeof LineBaselineSchema>;

/**
 * One day's spend.
 *
 * The totals REUSE `ChatTotalsWireSchema` rather than restating its eight
 * fields: a day's spend and a thread's spend are the same aggregate over a
 * different population, and a near-identical second shape is how a field added
 * to one silently stops appearing in the other. The generated client therefore
 * types both against one `ChatTotals`.
 *
 * `date` is a calendar day in the MACHINE's own timezone, not UTC. The daemon
 * and the window looking at it are the same computer by construction, so local
 * is what "today" means to the person reading the page — bucketing by UTC would
 * file a late-evening turn under tomorrow for most of the world.
 */
export const UsageBucketWireSchema = z
  .object({
    date: z.string().describe('calendar day, YYYY-MM-DD, in local time'),
    totals: ChatTotalsWireSchema,
    activity: ActivityTotalsWireSchema.describe(
      'what the threads did that day — see ActivityTotals',
    ),
  })
  .meta({ id: 'UsageBucket' });
export type UsageBucketWire = z.infer<typeof UsageBucketWireSchema>;

/**
 * One slice of the period — an agent, a model, a project folder, or a thread.
 *
 * `key` is nullable because every dimension genuinely can be absent: a turn
 * recorded after its run was deleted knows no folder, and a turn whose CLI
 * reported no model names none. Null is left for the client to label, so the
 * daemon never invents a display string like "(unknown)" that a translated or
 * restyled UI would then have to parse back out.
 *
 * A THREAD's key is its run id, which names nothing a reader recognises, so
 * that dimension alone also carries the thread's own `title` and whether the
 * thread has since been `deleted` — both read off the run at answer time, the
 * ledger keeping no title of its own.
 */
export const UsageGroupWireSchema = z
  .object({
    key: z.string().nullable(),
    totals: ChatTotalsWireSchema,
    title: z
      .string()
      .nullable()
      .optional()
      .describe("a thread's title; null when it has none"),
    deleted: z
      .boolean()
      .optional()
      .describe('a thread that no longer exists — its spend outlives it'),
  })
  .meta({ id: 'UsageGroup' });
export type UsageGroupWire = z.infer<typeof UsageGroupWireSchema>;

/** How a set of runs' goals ended. */
export const GoalFiguresSchema = z
  .object({
    recorded: z.number().describe('every goal recorded, dropped ones included'),
    achieved: z.number(),
    notAchieved: z.number(),
    dropped: z.number(),
    open: z.number(),
    achievedShare: z
      .number()
      .nullable()
      .describe(
        'achieved over every goal not dropped, an open one counting as not achieved; null with no such goal',
      ),
    runsWithGoals: z.number(),
    measuredRuns: z
      .number()
      .describe(
        'runs the ledgers watched from their start — what coverage is out of',
      ),
    coverage: z
      .number()
      .nullable()
      .describe(
        'runs with goals over measured runs; null with no measured run',
      ),
  })
  .meta({ id: 'GoalFigures' });
export type GoalFiguresWire = z.infer<typeof GoalFiguresSchema>;

/** How a set of runs ended: each run's recorded outcome, else the one its goals derive. */
export const ThreadOutcomeCountsSchema = z
  .object({
    success: z.number(),
    partial: z.number(),
    failed: z.number(),
    abandoned: z.number(),
    recorded: z.number().describe('runs whose outcome an agent recorded'),
    derived: z.number().describe('runs whose outcome is read from their goals'),
  })
  .meta({ id: 'ThreadOutcomeCounts' });
export type ThreadOutcomeCountsWire = z.infer<typeof ThreadOutcomeCountsSchema>;

/** One tool's finished calls. */
export const ToolUseSchema = z
  .object({
    tool: z.string(),
    mcpServer: z
      .string()
      .nullable()
      .describe("the MCP server it came from; null for a CLI's own tool"),
    calls: z.number(),
    errors: z.number(),
    avgMs: z
      .number()
      .nullable()
      .describe('mean time from call to result; null when none was timed'),
  })
  .meta({ id: 'ToolUse' });
export type ToolUseWire = z.infer<typeof ToolUseSchema>;

/** One MCP server's finished calls, over every tool of it. */
export const McpServerUseSchema = z
  .object({
    server: z.string(),
    calls: z.number(),
    errors: z.number(),
    tools: z.number().describe('distinct tools of it that were called'),
  })
  .meta({ id: 'McpServerUse' });
export type McpServerUseWire = z.infer<typeof McpServerUseSchema>;

/** One stage's moves over a team's runs. */
export const StageFiguresSchema = z
  .object({
    stageId: z.string(),
    completed: z.number(),
    skipped: z.number(),
    reopened: z.number(),
    avgMs: z
      .number()
      .nullable()
      .describe(
        'mean time a completed stage was current; null when none completed',
      ),
  })
  .meta({ id: 'StageFigures' });
export type StageFiguresWire = z.infer<typeof StageFiguresSchema>;

/** Every call one member made to another, over a team's runs. */
export const MemberCallSchema = z
  .object({
    caller: z.string(),
    callee: z.string(),
    calls: z.number(),
    failed: z.number().describe('calls that ended without an answer'),
    turns: z.number().describe("the callee's turns inside them"),
    costUsd: z
      .number()
      .nullable()
      .describe("what the callee's turns cost; null when none reported a cost"),
    avgMs: z.number().nullable().describe('mean time from call to answer'),
  })
  .meta({ id: 'MemberCall' });
export type MemberCallWire = z.infer<typeof MemberCallSchema>;

/** The thread metrics of a set of runs, folded over the write-time ledgers. */
export const ThreadMetricsSchema = z
  .object({
    goals: GoalFiguresSchema,
    outcomes: ThreadOutcomeCountsSchema,
    handOffs: z
      .number()
      .nullable()
      .describe('stage hand-offs of the lead; null when no run was measured'),
    tools: z.array(ToolUseSchema).describe('most called first'),
    mcpServers: z.array(McpServerUseSchema).describe('most called first'),
    stages: z.array(StageFiguresSchema),
    calls: z
      .array(MemberCallSchema)
      .describe('one row per caller and callee, most calls first'),
  })
  .meta({ id: 'ThreadMetrics' });
export type ThreadMetricsWire = z.infer<typeof ThreadMetricsSchema>;

/**
 * Everything the Stats page shows for one period.
 *
 * Answered by ONE route, like the chat metrics readout and for the same reason:
 * a page that fetched its headline total and its per-day series separately could
 * show a total that disagrees with the sum of the bars under it, which reads as
 * the app losing track of the user's money.
 *
 * `from`/`to` echo the RESOLVED range rather than the request's, since either
 * bound may be omitted — the page has to be able to say which period it is
 * actually showing.
 */
export const UsageStatsWireSchema = z.object({
  from: z.string().describe('ISO-8601, inclusive'),
  to: z.string().describe('ISO-8601, exclusive'),
  totals: ChatTotalsWireSchema,
  activity: ActivityTotalsWireSchema.describe(
    'what the threads did over the period — the same figures the days sum to',
  ),
  days: z
    .array(UsageBucketWireSchema)
    .describe('every day in the range, including days with no activity'),
  byAgent: z.array(UsageGroupWireSchema),
  byModel: z.array(UsageGroupWireSchema),
  byProject: z
    .array(UsageGroupWireSchema)
    .describe(
      'per project folder; a git worktree is filed under its repository',
    ),
  byThread: z
    .array(UsageGroupWireSchema)
    .describe('per thread (run), keyed by run id — chats and team runs'),
  byTeam: z
    .array(UsageGroupWireSchema)
    .describe(
      'per team, keyed by slug; a thread with no team is in no row, so a chat is never pooled into one',
    ),
  byPurpose: z
    .array(UsageGroupWireSchema)
    .describe(
      "spend the app made for itself, keyed by purpose: `lessons` is the hidden lessons reflections; the user's own work is in no row",
    ),
  metrics: ThreadMetricsSchema.describe(
    'the threads started in the period: goals, outcomes, and every tool and MCP server called in it',
  ),
});
// No `.meta({ id })`: this is a RESPONSE DTO ROOT, and nestjs-zod would then
// register the component under the id while the route still points at the DTO
// class name — the dangling `$ref` `setupSwagger` fails the boot on. The nested
// shapes above carry ids precisely because they are not roots.
export type UsageStatsWire = z.infer<typeof UsageStatsWireSchema>;

/**
 * What a set of runs cost. Folded over the runs' own ledger rows, a deleted run's
 * included; null means not measured, never zero.
 */
export const VersionFiguresSchema = z
  .object({
    runs: z.number(),
    costUsd: z.number().nullable().describe('null when no run reported a cost'),
    avgCostUsd: z
      .number()
      .nullable()
      .describe('costUsd over the runs that reported one'),
    estimatedCostUsd: z
      .number()
      .nullable()
      .describe('the part of costUsd geniro priced, not billed by a CLI'),
  })
  .meta({ id: 'VersionFigures' });
export type VersionFiguresWire = z.infer<typeof VersionFiguresSchema>;

/** A version's team against the version recorded before it, as `git diff` prints it. */
export const VersionChangesSchema = z
  .object({
    added: z.number().describe('lines the diff adds'),
    removed: z.number().describe('lines the diff removes'),
    diff: z
      .string()
      .describe("unified diff of the two graphs' YAML; empty when they match"),
  })
  .meta({ id: 'VersionChanges' });
export type VersionChangesWire = z.infer<typeof VersionChangesSchema>;

export const TeamVersionRowSchema = z
  .object({
    version: z
      .string()
      .nullable()
      .describe('null for the runs that kept no team copy'),
    ordinal: z
      .number()
      .nullable()
      .describe('1 for the first version recorded, in order of first use'),
    inferred: z
      .boolean()
      .describe(
        'every run of it predates team copies, so the team was frozen after the run started',
      ),
    recorded: z
      .boolean()
      .describe(
        'false only for the library team before its first run or restore records it',
      ),
    preTeam: z
      .boolean()
      .describe(
        'recorded while teams were node graphs; its diff is taken over the graph converted to a team',
      ),
    firstRunAt: z
      .string()
      .nullable()
      .describe('null for a version not run yet'),
    lastRunAt: z.string().nullable().describe('null for a version not run yet'),
    changes: VersionChangesSchema.nullable().describe(
      'null for the first recorded version, an inferred one and the runs with no team copy',
    ),
    figures: VersionFiguresSchema,
  })
  .meta({ id: 'TeamVersionRow' });
export type TeamVersionRowWire = z.infer<typeof TeamVersionRowSchema>;

/** One team's runs grouped by the team version they ran. */
export const TeamVersionsWireSchema = z.object({
  slug: z.string(),
  currentVersion: z
    .string()
    .nullable()
    .describe("the library team's version; null when the file cannot be read"),
  versions: z.array(TeamVersionRowSchema).describe('newest first'),
  unversioned: TeamVersionRowSchema.nullable().describe(
    'the runs that kept no team copy, or null when there are none',
  ),
  totals: VersionFiguresSchema.describe(
    'folded over every run of the team, not summed from the rows',
  ),
});
// No `.meta({ id })`: a response DTO root (see UsageStatsWireSchema).
export type TeamVersionsWire = z.infer<typeof TeamVersionsWireSchema>;

/** A team's pull request outcomes: each pull request's newest, one per run and pull request. */
export const TeamStatsOutcomesSchema = z
  .object({
    total: z.number(),
    accepted: z.number(),
    changesRequested: z.number(),
    notYet: z.number(),
    notNeeded: z.number(),
  })
  .meta({ id: 'TeamStatsOutcomes' });
export type TeamStatsOutcomesWire = z.infer<typeof TeamStatsOutcomesSchema>;

/** One local calendar day of a team's activity. */
export const TeamStatsDaySchema = z
  .object({
    day: z.string().describe('YYYY-MM-DD, the machine’s local day'),
    runs: z.number().describe('runs that started that day'),
    costUsd: z
      .number()
      .nullable()
      .describe('null when no turn that day reported a cost'),
    turns: z.number(),
    workedMs: z
      .number()
      .nullable()
      .describe('null when no turn that day was timed'),
    outcomes: z.number().describe('pull request outcomes recorded that day'),
  })
  .meta({ id: 'TeamStatsDay' });
export type TeamStatsDayWire = z.infer<typeof TeamStatsDaySchema>;

/** One team member's share of a team's turns. */
/** What one member did for the team, from the write-time ledgers over every run they watched. */
export const MemberWorkSchema = z
  .object({
    measuredRuns: z
      .number()
      .describe(
        'runs the metric ledgers watched from their start that the member took part in — what every figure here is counted over',
      ),
    callsAnswered: z.number().describe('calls other members made to it'),
    callsFailed: z
      .number()
      .describe('of those, the calls that ended in an error'),
    avgAnswerMs: z
      .number()
      .nullable()
      .describe(
        'how long a call to it stayed open on average; null when none was timed',
      ),
    callsMade: z.number().describe('calls it made to other members'),
    toolCalls: z.number(),
    toolErrors: z.number().describe('tool calls that ended in an error'),
    goals: z
      .object({
        recorded: z
          .number()
          .describe('goals it recorded, dropped ones included'),
        achieved: z.number(),
        notAchieved: z.number(),
        open: z.number(),
        dropped: z.number(),
        achievedShare: z
          .number()
          .nullable()
          .describe(
            'achieved over every goal it recorded and did not drop, an open one counting as not achieved; null with none',
          ),
      })
      .describe('the goals it recorded'),
    cleanRuns: z
      .number()
      .describe(
        'of the measured runs, those where none of its work failed or was redone: no call to it failed, no stage it owns was reopened, no goal it recorded ended not achieved',
      ),
    stagesCompleted: z
      .number()
      .describe(
        'completions of stages it was responsible for in its run’s team version, whoever moved them',
      ),
    completionsReopened: z
      .number()
      .describe(
        'of those, the completions a later move reopened in the same run — rework',
      ),
  })
  .meta({ id: 'MemberWork' });
export type MemberWorkWire = z.infer<typeof MemberWorkSchema>;

/** The user's own verdict on one analysis's marks of one member. */
export const MemberAssessmentUserVerdictSchema = z
  .object({
    verdict: z.enum(MEMBER_ASSESSMENT_USER_VERDICTS),
    note: z.string().nullable(),
    at: z.string().describe('ISO-8601'),
  })
  .meta({ id: 'MemberAssessmentUserVerdict' });

export const MAX_ASSESSMENT_NOTE_LENGTH = 2000;

/** Set or clear the user's verdict on one member's marks on one card. */
export const MemberAssessmentVerdictRequestSchema = z.object({
  chatRunId: z.string().min(1).describe('the chat that filed the card'),
  cardSeq: z.number().int().min(0),
  memberId: z.string().min(1),
  verdict: z
    .enum(MEMBER_ASSESSMENT_USER_VERDICTS)
    .nullable()
    .describe('null clears the verdict'),
  note: z
    .string()
    .max(MAX_ASSESSMENT_NOTE_LENGTH)
    .nullable()
    .optional()
    .describe('why — what the next analysis reads beside it'),
});

/** The user's verdicts on one card's member assessments. */
export const CardAssessmentVerdictsSchema = z.object({
  verdicts: z.array(
    z.object({
      memberId: z.string(),
      userVerdict: MemberAssessmentUserVerdictSchema.nullable(),
    }),
  ),
});
// No `.meta({ id })`: a response DTO root (see UsageStatsWireSchema).
export type CardAssessmentVerdictsWire = z.infer<
  typeof CardAssessmentVerdictsSchema
>;

/** One analysis's judgement of one member, from the assessment ledger. */
export const MemberAssessmentEntrySchema = z
  .object({
    chatRunId: z.string().describe('the chat that filed it — it may be gone'),
    chatKind: z.enum(['analysis', 'builder', 'thread']),
    cardSeq: z.number(),
    filedAt: z.string().describe('ISO-8601'),
    runs: z.number().describe('how many runs the analysis read'),
    versions: z
      .array(
        z.object({
          number: z.number().nullable(),
          current: z.boolean(),
        }),
      )
      .describe(
        'the team versions the analysed runs ran, oldest first — what the marks describe',
      ),
    usefulness: z
      .number()
      .int()
      .min(1)
      .max(5)
      .nullable()
      .describe('null when the runs gave too little to judge'),
    quality: z
      .number()
      .int()
      .min(1)
      .max(5)
      .nullable()
      .describe('null when the runs gave too little to judge'),
    verdict: z.enum(MEMBER_VERDICTS),
    summary: z.string(),
    evidence: z.array(
      z.object({
        runId: z.string().nullable(),
        seq: z.number(),
        quote: z.string(),
      }),
    ),
    items: z
      .array(
        z.object({
          id: z.string(),
          title: z.string(),
          status: z
            .enum(HISTORY_RECOMMENDATION_STATUSES)
            .nullable()
            .describe(
              'what became of it; null for a thread analysis, whose items stay with its source thread',
            ),
        }),
      )
      .describe('the card items that carry the verdict out'),
    judge: z
      .object({
        agent: z.string().nullable(),
        model: z.string().nullable().describe('null for the CLI’s default'),
        sameVendor: z
          .boolean()
          .nullable()
          .describe(
            'the judge runs the same vendor’s models as the member it marked, in the newest version its runs ran; null when either is not known',
          ),
      })
      .describe('the CLI and model of the chat that marked it'),
    userVerdict: MemberAssessmentUserVerdictSchema.nullable().describe(
      'the user’s own verdict on these marks; null until given',
    ),
  })
  .meta({ id: 'MemberAssessmentEntry' });

/** Lowest, median and highest of a figure over the runs a member took part in. */
export const FigureSpreadSchema = z
  .object({ min: z.number(), median: z.number(), max: z.number() })
  .meta({ id: 'FigureSpread' });

/** A member's figures over the runs of one team version. */
export const MemberVersionFiguresSchema = z
  .object({
    runs: z.number().describe('runs of the version it took part in'),
    costPerRunUsd: z.number().nullable(),
    workedPerRunMs: z.number().nullable(),
    callFailureShare: z
      .number()
      .nullable()
      .describe('failed calls to it over calls to it, measured runs only'),
    reworkShare: z
      .number()
      .nullable()
      .describe(
        'reopened completions of its stages over their completions, measured runs only',
      ),
    cleanShare: z
      .number()
      .nullable()
      .describe('clean runs over measured runs it took part in'),
  })
  .meta({ id: 'MemberVersionFigures' });

/** The whole team's figures over the runs of one version. */
export const TeamVersionRunFiguresSchema = z
  .object({
    runs: z.number(),
    costPerRunUsd: z.number().nullable(),
    workedPerRunMs: z.number().nullable(),
  })
  .meta({ id: 'TeamVersionRunFigures' });

export const MEMBER_CHANGE_KINDS = [
  'added',
  'removed',
  'role',
  'instructions',
  'character',
  'agent',
  'model',
  'effort',
  'approval',
  'pool',
  'tools',
  'stages',
  'blocks',
] as const;
export type MemberChangeKind = (typeof MEMBER_CHANGE_KINDS)[number];

export const MEMBER_CHANGE_EFFECTS = [
  'better',
  'worse',
  'mixed',
  'no-change',
  'too-few-runs',
] as const;
export type MemberChangeEffect = (typeof MEMBER_CHANGE_EFFECTS)[number];

export const MEMBER_CHANGE_UNITS = ['usd', 'ms', 'share'] as const;
export type MemberChangeUnit = (typeof MEMBER_CHANGE_UNITS)[number];

/**
 * One change between two team versions that touched a member, with what its
 * runs measured on either side — counted by the daemon, never judged by an
 * analysis.
 */
export const MemberChangeSchema = z
  .object({
    from: z.object({ number: z.number().nullable(), current: z.boolean() }),
    to: z.object({ number: z.number().nullable(), current: z.boolean() }),
    at: z
      .string()
      .describe('ISO-8601: the first run of the new version after the old'),
    kinds: z.array(z.enum(MEMBER_CHANGE_KINDS)).describe('what changed'),
    source: z
      .string()
      .nullable()
      .describe(
        'who made the change, from the change log (analysis, builder, chat, restore); null for an edit by hand',
      ),
    summary: z.string().nullable(),
    recommendationIds: z.array(z.string()),
    before: MemberVersionFiguresSchema.nullable().describe(
      'the member over the old version’s runs; null for a member it added',
    ),
    after: MemberVersionFiguresSchema.nullable().describe(
      'the member over the new version’s runs; null for a member it removed',
    ),
    team: z.object({
      before: TeamVersionRunFiguresSchema,
      after: TeamVersionRunFiguresSchema,
    }),
    effect: z
      .enum(MEMBER_CHANGE_EFFECTS)
      .describe(
        'better or worse when every figure that moved by a tenth or more moved that way, mixed when they disagree; too-few-runs under two runs on either side',
      ),
    moved: z
      .array(
        z.object({
          figure: z.string(),
          unit: z
            .enum(MEMBER_CHANGE_UNITS)
            .describe(
              'dollars or milliseconds per run, moved by a tenth of where they stood; a share (0–1), moved by 0.1',
            ),
          from: z.number(),
          to: z.number(),
          direction: z.enum(['better', 'worse']),
        }),
      )
      .describe('the figures that moved by a tenth or more, and which way'),
  })
  .meta({ id: 'MemberChange' });
export type MemberChangeWire = z.infer<typeof MemberChangeSchema>;
export type MemberAssessmentEntryWire = z.infer<
  typeof MemberAssessmentEntrySchema
>;

export const TeamStatsMemberSchema = z
  .object({
    memberId: z.string(),
    agentKind: z
      .string()
      .nullable()
      .describe('the CLI of the member’s newest turn that names one'),
    costUsd: z
      .number()
      .nullable()
      .describe('null when no turn reported a cost'),
    turns: z.number(),
    workedMs: z
      .number()
      .nullable()
      .describe(
        'the CLIs’ own time plus geniro’s clock for turns no CLI timed; null when no turn was timed',
      ),
    measuredWorkedMs: z
      .number()
      .describe('the part of workedMs geniro measured by the clock'),
    runs: z.number().describe('runs it took part in'),
    perRun: z
      .object({
        costUsd: FigureSpreadSchema.nullable(),
        workedMs: FigureSpreadSchema.nullable(),
      })
      .describe(
        'how its cost and working time spread over the runs it took part in; null when none was priced or timed',
      ),
    work: MemberWorkSchema.nullable().describe(
      'null when no run it took part in was watched by the metric ledgers',
    ),
    changes: z
      .array(MemberChangeSchema)
      .describe('every change between versions that touched it, newest first'),
    assessments: z
      .array(MemberAssessmentEntrySchema)
      .describe('every analysis that judged it, newest first'),
  })
  .meta({ id: 'TeamStatsMember' });
export type TeamStatsMemberWire = z.infer<typeof TeamStatsMemberSchema>;

/** What one team's runs did, folded over every run the ledger holds for it — a deleted run's too. */
export const TeamStatsWireSchema = z.object({
  slug: z.string(),
  runs: z.number().describe('every thread row of the team'),
  costUsd: z.number().nullable().describe('null when no run reported a cost'),
  estimatedCostUsd: z
    .number()
    .nullable()
    .describe('the part of costUsd geniro priced, not billed by a CLI'),
  turns: z.number(),
  workedMs: z
    .number()
    .nullable()
    .describe(
      'the CLIs’ own worked time plus geniro’s clock for turns no CLI timed; null when no turn was timed',
    ),
  measuredWorkedMs: z
    .number()
    .describe(
      'the part of workedMs geniro measured by the clock (`wall_turns`), which a deleted run takes with it',
    ),
  outcomes: TeamStatsOutcomesSchema,
  days: z
    .array(TeamStatsDaySchema)
    .describe('oldest first, only the days with activity'),
  byMember: z
    .array(TeamStatsMemberSchema)
    .describe(
      'most expensive first; turns recorded with no member are in the totals only',
    ),
  assessmentVerdicts: z
    .object({
      assessments: z.number().describe('every member assessment filed'),
      agreed: z.number(),
      disagreed: z.number(),
    })
    .describe('how often the user agreed with the analyses’ marks'),
  metrics: ThreadMetricsSchema,
});
// No `.meta({ id })`: a response DTO root (see UsageStatsWireSchema).
export type TeamStatsWire = z.infer<typeof TeamStatsWireSchema>;

/** A version written back to the library as the team. */
export const TeamVersionRestoredSchema = z.object({
  slug: z.string(),
  version: z.string().describe('the team version the library file now holds'),
  hash: z.string().describe('the file hash the next save must quote'),
  backup: z
    .string()
    .describe('where the replaced file was copied, relative to the library'),
});
// No `.meta({ id })`: a response DTO root (see UsageStatsWireSchema).
export type TeamVersionRestoredWire = z.infer<typeof TeamVersionRestoredSchema>;
