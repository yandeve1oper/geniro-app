import type { EntityManager } from '@mikro-orm/sqlite';

import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import {
  type ConfigDirPinWire,
  type ItemWire,
  type RunAwaiting,
  type RunGroupColor,
  RunGroupColorSchema,
  type RunPreview,
  type RunWire,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { AgentEventBus } from '../services/agent-events.bus';
import type { ItemCallIndexService } from '../services/item-call-index.service';
import type { ItemSeqAllocator } from '../services/item-seq.allocator';
import { inCallWire } from './item-wire';
import { threadPreviewOf } from './message-preview';
import { readModelParameters } from './model-parameters';
import { readDisplayedPullRequests } from './pull-request-capture';
import { readRunGoals, readThreadOutcome, threadOutcomeOf } from './run-goals';
import { readRunOutcomes } from './run-outcomes';
import { readRunResetWakes } from './run-reset-wakes';
import { searchIndexText } from './searchable-text';
import { readRunStageProgress } from './stage-progress';
import { readRunTaskList } from './task-list-fold';
import { servedWorkedMs } from './wall-worked';

/**
 * The one persist-then-emit implementation both execution paths (single-agent
 * chat and the team executor) share: write the row — allocating its place in
 * the run's monotonic `seq` order — THEN publish on the bus, so SQLite stays
 * the source of truth and a reconnecting client can replay everything it
 * missed. Also clears the forked EntityManager's identity map afterwards, so
 * a long streaming run doesn't grow it unboundedly.
 */
export async function persistItemAndEmit(
  deps: {
    itemDao: ItemDao;
    bus: AgentEventBus;
    calls: Pick<ItemCallIndexService, 'inCallOf'>;
    /** Told when the row's reserved seq is no longer in flight. */
    seqs: Pick<ItemSeqAllocator, 'settle'>;
  },
  em: EntityManager,
  row: {
    runId: string;
    memberId: string | null;
    seq: number;
    kind: ItemKind;
    role: string | null;
    payload: unknown;
  },
): Promise<ItemWire> {
  let item: Item;
  let inCall: string;
  // Settled however the insert ends: a row on disk is no longer in flight, and
  // one that failed never will be (`ItemSeqAllocator.writtenThrough`).
  try {
    inCall = await deps.calls.inCallOf(row.runId, row);
    item = await deps.itemDao.create(
      {
        runId: row.runId,
        memberId: row.memberId,
        seq: row.seq,
        kind: row.kind,
        role: row.role,
        payload: JSON.stringify(row.payload),
        // Computed at the insert rather than at query time: the search is a
        // daemon route precisely because the client holds only the newest page,
        // and scanning JSON payloads across a long transcript is what the column
        // exists to avoid.
        searchText: searchIndexText(row.payload),
        inCall,
      },
      // A fork of its own: the insert flushes this row alone, never another
      // writer's pending change on the caller's manager.
      em.fork(),
    );
  } finally {
    deps.seqs.settle(row.runId, row.seq);
  }
  const wire: ItemWire = {
    id: item.id,
    runId: row.runId,
    memberId: row.memberId,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    payload: row.payload,
    createdAt: item.createdAt.toISOString(),
    inCall: inCallWire(inCall),
  };
  deps.bus.publish({ runId: row.runId, item: wire });
  // Items reach ONE run room and a client joins one at a time, so a thread
  // working in the background delivers none of them to the window watching the
  // sidebar. Its preview line rides the client-wide status channel instead —
  // announced HERE so every execution path (chat, team, any added later)
  // pushes it, after the row is durable. `status: null` asserts no status;
  // `activity` is left absent, since a null one would blank the phrase of a
  // turn still working.
  const preview = threadPreviewOf(wire);
  if (preview !== null) {
    deps.bus.publishRunStatus({ runId: row.runId, status: null, preview });
  }
  em.clear();
  return wire;
}

/**
 * A stored row colour this build's palette no longer names reads as untinted.
 * The column is a free string while `RunWire` validates it against the enum,
 * so passing it through would fail the response of every listing over one
 * stale row.
 */
function readRunColor(stored: unknown): RunGroupColor | null {
  const parsed = RunGroupColorSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

/** The one Run → wire projection (chat and team runs share the shape). */
export function runToWire(
  run: Run,
  /** The run's newest transcript rows, as `ItemDao.runPreviews` reads them. */
  preview: RunPreview | null = null,
  /**
   * What the run is parked on right now, from the approval registry.
   *
   * Passed in rather than looked up here: this is a pure projection of a row,
   * and the registry is in-memory DI state. Defaulted to null so the paths
   * that genuinely cannot be parked — a run being created, a team run just
   * started — say so without asking.
   */
  awaiting: RunAwaiting | null = null,
  /**
   * How many units of background work this run's turn is being held for, from
   * the live turn state.
   *
   * Passed in for the same reason {@link awaiting} is — a pure projection of a
   * row cannot read in-memory state — and on the ROW for the same reason too: a
   * hold lasts as long as the delegates do, which is minutes, and the announce
   * that starts it is a one-off event. Without it a window opened (or a chat
   * revisited) mid-hold reads the run as a working agent and puts the user's
   * message back in the queue.
   */
  holdingFor = 0,
  /**
   * The config directory this run's FOLDER pins, from `ConfigDirPinService`.
   *
   * Passed in for the reason the two above are: this is a pure projection of a
   * row, and the answer comes from an adapter behind a cache. Defaulted to null
   * so the callers that cannot usefully ask — a team member's own run row,
   * whose agents are per member — say nothing rather than guessing.
   */
  configDirPin: ConfigDirPinWire | null = null,
  /**
   * How many DETACHED commands this run still has out, from the live turn
   * state — see `BackgroundWorkCounts`.
   *
   * Passed in and on the ROW for the reasons {@link holdingFor} is, plus one of
   * its own: the renderer used to derive this from the OPEN thread's
   * transcript, so a row could only answer it about the chat the user happened
   * to be looking at, and the badge changed when they looked away.
   *
   * It asserts nothing about the turn — a shell does not hold one open. Last in
   * the parameter list so the callers that cannot know (a run being created, a
   * team member's row) keep saying nothing by saying nothing.
   */
  shellsOpen = 0,
  /**
   * How many background SUB-AGENTS this run still has out, from the live turn
   * state — see `BackgroundWorkCounts`.
   *
   * The delegate twin of {@link shellsOpen}, on every one of its reasons and
   * with the same limitation answered the same way: derived from the OPEN
   * thread's transcript it was knowable for one chat and no other, so a
   * fan-out badged itself `working` while selected and `completed` the moment
   * the user looked at another thread.
   *
   * It asserts nothing about the turn either, and that is the whole difference
   * from {@link holdingFor}: a delegate whose CLI never reports an ending does
   * not hold a turn open — nothing would ever release it — so the turn settles
   * and this says what is still out underneath.
   */
  subagentsOut = 0,
  /**
   * How many of this run's agents are sitting inside a wait on their own
   * agent-to-agent calls, from `CallBroker`.
   *
   * Passed in and on the ROW for {@link holdingFor}'s reasons exactly: the
   * composer ACTS on it, a wait outlasts the one announce that began it by
   * however long the callees take, and a window opened meanwhile has no other
   * way to learn it. Last in the list and defaulted to 0 so every chat caller —
   * which has no call runtime and therefore nothing that could be waiting —
   * goes on saying nothing by saying nothing.
   */
  awaitingCalls = 0,
  /** Trigger-fed team agents inside a turn — see `RunWire.rootsWorking`. */
  rootsWorking = 0,
  /**
   * This chat's wall-measured worked time (`WallTurnDao.chatSums`), added to
   * the CLI-reported `Run.workedMs` so the row says what the agent worked
   * whatever its CLI timed. Last and defaulted to null for the team
   * callers, whose worked time lives per member.
   */
  wallWorkedMs: number | null = null,
  /** How many monitors the run has running, from `MonitorRegistry`. */
  monitorsOpen = 0,
  /**
   * The name of the run's project while it exists, read for a whole listing at
   * once (`ProjectScopeService.liveNamesOf`); null draws no project.
   */
  projectName: string | null = null,
): RunWire {
  return {
    id: run.id,
    status: run.status,
    awaiting,
    holdingFor,
    awaitingCalls,
    rootsWorking,
    shellsOpen,
    subagentsOut,
    monitorsOpen,
    title: run.title,
    agentKind: run.agentKind,
    teamId: run.teamId,
    cwd: run.cwd,
    startSha: run.startSha,
    startDirty: run.startDirty,
    model: run.model,
    approval: run.approval,
    effort: run.effort,
    contextWindow: run.contextWindow,
    autoCompactPercent: run.autoCompactPercent,
    modelParameters: readModelParameters(run.modelParameters),
    contextTokens: run.contextTokens,
    contextEstimated: run.contextEstimated === true,
    contextWindowTokens: run.contextWindowTokens,
    workedMs: servedWorkedMs(run.workedMs, wallWorkedMs),
    toolCalls: run.toolCalls,
    promptCacheExpiresAt: run.promptCacheExpiresAt?.toISOString() ?? null,
    promptCacheTtlMs: run.promptCacheTtlMs,
    promptCacheTtlReason: run.promptCacheTtlReason,
    configDir: run.configDir,
    configDirPin,
    groupId: run.groupId,
    taskId: run.taskId,
    taskIdentifier: run.taskIdentifier,
    project:
      run.projectId !== null && projectName !== null
        ? { id: run.projectId, name: projectName }
        : null,
    analysisSourceRunId: run.analysisSourceRunId,
    analysisSourceSeq: run.analysisSourceSeq,
    analysisTeamSlug: run.analysisTeamSlug,
    pinnedPosition: run.pinnedPosition,
    color: readRunColor(run.color),
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    archivedAt: run.archivedAt?.toISOString() ?? null,
    attentionAt: run.attentionAt?.toISOString() ?? null,
    seenAt: run.seenAt?.toISOString() ?? null,
    notes: run.notes,
    lastMessage: preview?.lastMessage ?? null,
    lastActivityAt: preview?.lastActivityAt?.toISOString() ?? null,
    // Read off the row rather than passed in like the four live readings above:
    // these ARE columns (opened + touched, written by the capture pass, and
    // each one's newest recorded outcome), so a caller that cannot know about
    // approvals or holds still projects them.
    pullRequests: readDisplayedPullRequests(
      run.pullRequests,
      run.touchedPullRequests,
      readRunOutcomes(run.runOutcomes),
    ),
    // A column too, written by the call broker's reset wakes.
    resetWakes: readRunResetWakes(run.resetWakes),
    // Likewise a column, written by `TaskListCaptureService` — and on the row
    // for the same reason the context reading is: the client can only fold the
    // transcript window it loaded, and the whole list is stated only in the
    // earliest announcements.
    taskList: readRunTaskList(run.taskList),
    stages: readRunStageProgress(run.stageProgress),
    currentLead: run.currentLead,
    goals: readRunGoals(run.goals),
    outcome: threadOutcomeOf(
      readThreadOutcome(run.threadOutcome),
      readRunGoals(run.goals),
    ),
  };
}
