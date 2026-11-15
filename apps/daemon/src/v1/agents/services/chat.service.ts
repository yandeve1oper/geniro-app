import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { EntityManager } from '@mikro-orm/sqlite';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@packages/common';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { RUNTIME_TOKEN, type RuntimeInfo } from '../../../auth/runtime';
import {
  type InterruptCause,
  interruptCauseClause,
} from '../../../utils/stop-cause';
import type { BrowserOp } from '../../browser/browser.types';
import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { placedFacts } from '../../projects/utils/placed-facts';
import { Run } from '../../runs/entity/run.entity';
import {
  type AgentKind,
  isTerminalRunStatus,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
import type {
  AgentEvent,
  AgentMcpServer,
  AgentSession,
  AgentUsage,
  ApprovalOption,
  SessionCloseCause,
  TurnAutoCompact,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import {
  type AnalysedTeam,
  type AnalysisTurn,
  type AttachmentDataWire,
  type BrowserHostCardInput,
  BUILDER_CHAT_ANALYSED_RUNS,
  CHAT_DEFAULT_APPROVAL,
  type ChatApprovalMode,
  type ChatListScope,
  type DeferredCard,
  type DeferredCardResponder,
  type FollowUpBackgroundWork,
  type HistoryWindow,
  HOST_BROWSER_HOST_CARD,
  HOST_PATCH_TOOL,
  HOST_PLAN_TOOL,
  HOST_PROJECT_INSTRUCTIONS_TOOL,
  HOST_PROPOSE_TEAM_TOOL,
  HOST_QUESTION_TOOL,
  type HostArtifact,
  type HostArtifactOutcome,
  type HostArtifactRow,
  type HostChart,
  type HostChartOutcome,
  type HostComparison,
  type HostComparisonOutcome,
  type HostFindingsOutcome,
  type HostFindingsReport,
  type HostGallery,
  type HostGalleryOutcome,
  type HostMetrics,
  type HostMetricsOutcome,
  type HostNotifyOutcome,
  type HostPatch,
  type HostPatchOutcome,
  type HostPlan,
  type HostPlanOutcome,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
  type HostQuestion,
  type HostQuestionOutcome,
  type HostRowWire,
  type ItemWire,
  type ProjectChatSource,
  type RecommendationApply,
  type RunAwaiting,
  type RunGroupColor,
  type RunListPage,
  type RunPreview,
  type RunSeenWire,
  type RunWire,
  type SendMessageImage,
  SINGLE_AGENT_NODE,
  type StandingHostQuestion,
  type TeamProposalOutcome,
  type UnanswerableWire,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import {
  type AgentOptionsSnapshot,
  readAgentOptions,
  writeAgentOptions,
} from '../utils/agent-options';
import {
  analysisTurnOf,
  isAnalysisRun,
  teamAnalysisTurn,
  writeAnalysedRuns,
} from '../utils/analysed-runs';
import {
  applyHostPatch,
  captureHostPatchFingerprint,
} from '../utils/apply-patch';
import {
  deliverApprovalAnswer,
  isUserQuestion,
} from '../utils/approval-answer';
import { archivedCutoff } from '../utils/archived-cutoff';
import {
  AUTO_COMPACT_COMMAND,
  autoCompactDue,
  autoCompactNotice,
} from '../utils/auto-compact';
import { BackgroundWorkCounts } from '../utils/background-work-counts';
import { withCarriedContext } from '../utils/carried-context';
import { CompactionRows } from '../utils/compaction-rows';
import {
  endsOffTurnStretch,
  mapEventToItem,
  offTurnActivity,
  restatesRunAsWorking,
  terminalStatus,
} from '../utils/event-to-item';
import { firstTurnWindow } from '../utils/first-turn-window';
import { subagentsWouldBeCancelled } from '../utils/follow-up-background-work';
import { isHostActionCall } from '../utils/host-action';
import {
  isHostAnalysisReadCall,
  isHostRecommendationsCall,
} from '../utils/host-analysis';
import { isHostArtifactCall } from '../utils/host-artifact';
import { isHostBoardCall } from '../utils/host-board';
import { isHostBrowserCall } from '../utils/host-browser';
import { isHostChartCall } from '../utils/host-chart';
import { isHostComparisonCall } from '../utils/host-comparison';
import { isHostFindingsCall } from '../utils/host-findings';
import { hostGalleryDownloads, isHostGalleryCall } from '../utils/host-gallery';
import { isHostKnowledgeCall } from '../utils/host-knowledge';
import { isHostMemoryCall } from '../utils/host-memory';
import { isHostMetricsCall } from '../utils/host-metrics';
import { isHostNotifyCall } from '../utils/host-notify';
import {
  hostPatchResultText,
  hostPatchVerdict,
  isHostPatchCall,
} from '../utils/host-patch';
import { hostPlanResultText, isHostPlanCall } from '../utils/host-plan';
import {
  hostProjectInstructionsResultText,
  isHostProjectInstructionsCall,
  projectInstructionsCardInput,
  projectInstructionsCardKey,
  projectInstructionsVerdict,
} from '../utils/host-project-instructions';
import {
  deferredAnswerMessage,
  hostCardQuestions,
  hostMcpServerName,
  isHostQuestionCall,
} from '../utils/host-question';
import {
  isHostBuilderTeamCall,
  isHostLibraryReadCall,
  isHostTeamProposalCall,
  standingProposalCardId,
} from '../utils/host-teams';
import { threadCardFields } from '../utils/host-thread-message';
import { itemToWire } from '../utils/item-wire';
import { asArray, asRecord, asString } from '../utils/json-util';
import {
  readModelParameters,
  writeModelParameters,
} from '../utils/model-parameters';
import { offersMonitorTools } from '../utils/monitor-offer';
import {
  delegateCloseEvent,
  openDelegateIds,
  ownerFields,
  processEndedCloseEvent,
  strandedDelegates,
} from '../utils/open-delegates';
import {
  shellCloseEvent,
  type ShellRow,
  strandedShells,
} from '../utils/open-shells';
import {
  type PendingCardSnapshot,
  type PendingPatchSnapshot,
  type PendingQuestionSnapshot,
  QUESTION_ALREADY_STANDING,
  readPendingQuestion,
  serializePendingQuestion,
} from '../utils/pending-question';
import { persistItemAndEmit, runToWire } from '../utils/persist-item';
import { isProjectChat } from '../utils/project-chat';
import { resolveValidConfigDir } from '../utils/resolve-config-dir';
import { resolveValidCwd } from '../utils/resolve-cwd';
import { assertChatRun } from '../utils/run-kind';
import { teamRunSnapshots } from '../utils/run-snapshots';
import { type RunStatusAnnounce, writeRunStatus } from '../utils/run-status';
import { isSlashCommand } from '../utils/session-replacement-notes';
import { createSessionIdSaver } from '../utils/session-saver';
import { StandingQuestions } from '../utils/standing-questions';
import { teamProjectCardId } from '../utils/team-project-card';
import {
  threadMessageReturnedRow,
  threadMessagesPrompt,
  threadMessagesRow,
} from '../utils/thread-message-text';
import {
  ANSWERABILITY_KINDS,
  unanswerablePayload,
  unansweredRequests,
} from '../utils/unanswerable';
import { cliTurnDurationMs } from '../utils/wall-worked';
import { ActionBroker } from './action.broker';
import { ActionPublishService } from './action-publish.service';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentMcpService } from './agent-mcp.service';
import { AgentSessionRegistry } from './agent-session.registry';
import { AnalysisBroker } from './analysis.broker';
import { AnalysisReportsService } from './analysis-reports.service';
import { ApprovalRegistry, type PendingApproval } from './approval-registry';
import { ArtifactBroker } from './artifact.broker';
import { ArtifactStoreService } from './artifact-store.service';
import { AttachmentStoreService } from './attachment-store.service';
import {
  BROWSER_SESSION_OPTION,
  BROWSER_SESSION_VERDICT_OPTION,
  BrowserBroker,
  type BrowserSink,
} from './browser.broker';
import { ChartBroker } from './chart.broker';
import { CliSessionsService } from './cli-sessions.service';
import {
  chatWakeOwner,
  CommandEndWakeService,
  memberWakeOwner,
} from './command-end-wake.service';
import { ComparisonBroker } from './comparison.broker';
import { ConfigDirPinService } from './config-dir-pin.service';
import { EffortsService } from './efforts.service';
import { FindingsReportBroker } from './findings-report.broker';
import { GalleryBroker } from './gallery.broker';
import { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { McpHarvestStore } from './mcp-harvest.store';
import { MessageSendService } from './message-send.service';
import { MetricsBroker } from './metrics.broker';
import { MonitorBroker, type MonitorSink } from './monitor.broker';
import { MonitorRegistry } from './monitor.registry';
import { NotifyBroker } from './notify.broker';
import { PartialStreamService } from './partial-stream.service';
import { PatchBroker } from './patch.broker';
import { PlanBroker } from './plan.broker';
import { ProcessRegistry } from './process-registry';
import { ProjectChatBroker } from './project-chat.broker';
import { ProjectInstructionsBroker } from './project-instructions.broker';
import { ProjectInstructionsChangeService } from './project-instructions-change.service';
import { PullRequestCaptureService } from './pull-request-capture.service';
import { RunContextRegistry } from './run-context.registry';
import { RunGroupsService } from './run-groups.service';
import { RunHoldRegistry } from './run-hold.registry';
import { RunOutcomeBroker } from './run-outcome.broker';
import { RunTeardownService } from './run-teardown.service';
import { RunWriteQueue } from './run-write.queue';
import { SkillHarvestStore } from './skill-harvest.store';
import { TeamBuilderBroker } from './team-builder.broker';
import { TeamProposalBroker } from './team-proposal.broker';
import { ThreadInboxService } from './thread-inbox.service';
import { UserQuestionBroker } from './user-question.broker';
import { WallWorkService } from './wall-work.service';

const COMPACTING_ACTIVITY = 'compacting the conversation';

/** A deferred card another module raised — one that stands across turns. */
/** The sentence under the badge while a turn is held for `count` units. */
function heldActivity(count: number, unit?: 'command'): string | null {
  if (count === 0) {
    return null;
  }
  const noun = unit === 'command' ? 'background command' : 'sub-agent';
  return `waiting on ${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isStandingCard(entry: PendingApproval): boolean {
  return entry.standing === true;
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * How long one row from a DELEGATE keeps a settled run reading `running` — see
 * {@link ChatService.leaseOnDelegateRow}.
 *
 * A lease and not a latch, because a delegate has no terminal event of its own
 * to take the badge down with: its launching `Task` call returned long ago, and
 * a delegate that simply stops has nothing left to say. So the claim expires
 * unless the delegate renews it by producing another row.
 *
 * The window is a bet in BOTH directions and the length is where the two costs
 * balance. Too short and a delegate parked in one slow tool call (a test suite,
 * a long grep) drops the badge back to `completed` while it is demonstrably
 * mid-work — the defect this exists to remove. Too long and a delegate that has
 * genuinely finished leaves `still working` on screen for the rest of the
 * window, which is the same complaint arriving from the other side ("the
 * agent seems to have finished working, but its status didn't change"). Five
 * minutes bridges every delegate tool call observed here while bounding the
 * wrong-direction claim to something a user can outwait; it is deliberately
 * far short of the 30-minute silence deadline `spawn-cli` gives a turn,
 * because that deadline decides whether to ABANDON work and this one only
 * decides a word.
 *
 * The happy path never reaches it: a delegate that reports back makes the CLI
 * open a continuation turn of its own, and that turn's own `result` settles the
 * run through {@link ChatService.restatusAfterOffTurnEvent}.
 */
const DELEGATE_ROW_LEASE_MS = 5 * 60 * 1000;

/** What `ChatService.toRunWire` reads for one run beyond its row. */
interface RunWireRead {
  preview: RunPreview | null;
  /** The chat's wall-measured worked time (`WallTurnDao.chatSums`). */
  wallMs: number | null;
  /** The name of the run's project while it exists. */
  projectName: string | null;
}

/** What identifies a deferred plan, so an identical re-ask adopts the card. */
function deferredPlanKey(plan: HostPlan): string {
  return `plan:${JSON.stringify({ title: plan.title, steps: plan.steps })}`;
}

/** What identifies a deferred patch, so an identical re-ask adopts the card. */
function deferredPatchKey(patch: HostPatch): string {
  return `patch:${JSON.stringify({
    filePath: patch.filePath,
    oldString: patch.oldString ?? null,
    newString: patch.newString,
    summary: patch.summary ?? null,
  })}`;
}

/** The registry input, spelled the way the card row is. */
function deferredCardInput(snapshot: PendingCardSnapshot): unknown {
  switch (snapshot.kind) {
    case 'question':
      return {
        ...(snapshot.title === null ? {} : { title: snapshot.title }),
        questions: snapshot.questions,
      };
    case 'plan':
      return { title: snapshot.title, steps: snapshot.steps };
    case 'patch':
      return patchWireInput(snapshot.patch);
    case 'project':
      return projectInstructionsCardInput(snapshot.change);
  }
}

/** A patch's arguments in `Edit`'s field names, which is what the diff reads. */
function patchWireInput(patch: HostPatch): {
  file_path: string;
  old_string?: string;
  new_string: string;
  summary?: string;
} {
  return {
    file_path: patch.filePath,
    ...(patch.oldString === undefined ? {} : { old_string: patch.oldString }),
    new_string: patch.newString,
    ...(patch.summary === undefined ? {} : { summary: patch.summary }),
  };
}

/** The host tool that raised a deferred card. */
function deferredCardTool(snapshot: PendingCardSnapshot): string {
  switch (snapshot.kind) {
    case 'question':
      return HOST_QUESTION_TOOL;
    case 'plan':
      return HOST_PLAN_TOOL;
    case 'patch':
      return HOST_PATCH_TOOL;
    case 'project':
      return HOST_PROJECT_INSTRUCTIONS_TOOL;
  }
}

/**
 * Whether `key` is the card already standing. A question's key is every word
 * it shows; a plan's, a patch's and a project card's are prefixed so they
 * cannot collide with it.
 */
function adoptsStanding(standing: PendingCardSnapshot, key: string): boolean {
  switch (standing.kind) {
    case 'question':
      return (
        StandingQuestions.keyFor(standing.title, standing.questions) === key
      );
    case 'plan':
      return (
        deferredPlanKey({ title: standing.title, steps: standing.steps }) ===
        key
      );
    case 'patch':
      return deferredPatchKey(standing.patch) === key;
    case 'project':
      return projectInstructionsCardKey(standing.change) === key;
  }
}

/**
 * Whether a between-turn event starts new late work: a tool call of the main
 * thread, whose stretch the adapter ends with a `late_work_ended` of its own.
 * A delegate's call takes a lease instead.
 */
function startsLateWork(event: AgentEvent): boolean {
  return event.type === 'tool_call' && event.parentToolUseId === undefined;
}

/** What a chat's monitor tools know: whose a monitor is, and where it runs. */
function monitorSinkOf(runId: string, cwd: string): MonitorSink {
  return {
    ownerOf: (caller) => ({
      owner: {
        runId,
        memberId: SINGLE_AGENT_NODE,
        caller,
        conversationId: null,
        callId: null,
        target: 'chat',
      },
      cwd,
    }),
  };
}

/**
 * Orchestrates a single-agent chat: validates the run's cwd, drives the chosen
 * adapter, and applies **persist-then-emit** — every item is written (allocating
 * its monotonic seq) BEFORE it is published on the bus, so the durable
 * transcript is the source of truth and a reconnecting client can replay it. The
 * CLI session id is captured into `node_state` for `--resume`.
 */
@Injectable()
export class ChatService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(ChatService.name);

  /**
   * Set once the daemon has begun shutting down — and, which is the point,
   * BEFORE anything reaps a turn.
   *
   * Nest runs every `beforeApplicationShutdown` hook ahead of every
   * `onApplicationShutdown`, and the reaping happens in the second:
   * `ProcessRegistry` cancels each in-flight turn and `AgentSessionRegistry`
   * closes each kept process. Both reach the turn through the flag a Stop
   * sets, so it settles `turn_cancelled` exactly as though the user had
   * pressed Stop — and the database closes last, so that `cancelled` landed.
   * The task board then read quitting the app as the user stopping the card:
   * back to To do, and listed by the autopilot as "you stopped its last run",
   * so it was never picked up again.
   *
   * So a cancel landing after this is set, on a turn the user did not stop
   * (see {@link stopsRequested}), is an INTERRUPTION: nothing is written and
   * the run is left `running`, for the next boot's
   * {@link reconcileOrphanedRuns} to close as one — the same `interrupted`
   * row a SIGKILL has always left.
   */
  private shuttingDown = false;

  /**
   * Runs whose in-flight turn the USER asked to stop, until that turn's
   * terminal event is handled.
   *
   * The one fact that tells a Stop from the shutdown reap once
   * {@link shuttingDown} is set: both settle the turn `turn_cancelled`, and
   * neither the event nor its timing says who asked. Stopping an agent and
   * then quitting is an ordinary sequence, and the turn can take a few seconds
   * to settle after the press — that Stop is still the user's, and the
   * autopilot leaving the card alone is what it is for.
   */
  private readonly stopsRequested = new Set<string>();

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Subscribe to the one signal that says no further event is coming from a
   * run's process — see {@link settleAfterSessionClosed}.
   *
   * In a lifecycle hook rather than the constructor so nothing is registered
   * against a half-built service, and so a spec that builds one by hand gets
   * the wiring by calling this rather than by reaching into a constructor
   * side effect.
   */
  onModuleInit(): void {
    this.sessions.onClosed((runId, interrupted, exited, cause) => {
      void this.settleAfterSessionClosed(runId, interrupted, exited, cause);
    });
  }

  /**
   * Each in-flight turn's FINALIZER, keyed by run — not its handle.
   *
   * A turn's writes do not stop when its child exits: `handle.done` resolves,
   * and the finalizer chained onto it then drains the persist queue, sweeps
   * pending approvals and records the terminal item. Awaiting `handle.done`
   * would NOT wait for any of that — the finalizer is a continuation on the
   * same promise, so it merely runs first and suspends at its own first await,
   * letting the awaiting caller resume underneath it. `delete` therefore waits
   * on this, or the rows it destroys get rewritten a moment later.
   */
  private readonly finalizing = new Map<string, Promise<void>>();

  /**
   * Runs whose current turn is a geniro command (`/compact`), each mapped to a
   * token owned by that turn. A follow-up is refused rather than delivered into
   * one — see {@link sendMessage}. Cleared only by the turn that set it: the
   * registry frees the run before a finalizer finishes, so the next compaction
   * can claim the run while the previous one is still tidying up.
   */
  private readonly compactingRuns = new Map<string, symbol>();

  /**
   * The context each chat held when it was first measured after its last
   * compaction ('pending' until then). The auto-compact rule compacts again
   * only once the conversation has regrown past it — see `autoCompactDue`.
   *
   * Taken from the first READING that lands, in {@link rememberContext}, and
   * whether or not a threshold is set. It used to be taken at the next settle
   * the auto-compact check ran on, which measured what a whole turn had GROWN
   * to rather than what the compaction left, and never ran while the chat had
   * no threshold: REPORTED as auto-compact at 80% doing nothing on a thread at
   * 82%, where a manual `/compact` hours earlier had left the baseline pending
   * until the threshold was switched on, at 805k — so nothing fired below 905k.
   * In memory: after a restart the worst case is one extra compaction, which
   * re-establishes the baseline.
   */
  private readonly compactionBaselines = new Map<string, number | 'pending'>();

  /**
   * Runs whose delete is in progress.
   *
   * `finalizing` only covers a turn that reached `adapter.start()`. Between
   * `tryClaim` and `register` a turn is CLAIMED but has no finalizer yet, and
   * that window contains real awaits (the approval-mode probe, the
   * live-stream `--version` check). A delete landing there would wait for
   * nothing, destroy the rows, and let the turn register and finalize
   * afterwards — writing exactly the orphans the wait exists to prevent. So a
   * turn crossing that window checks here instead and gives up.
   */
  private readonly deleting = new Set<string>();

  /**
   * Runs whose ARCHIVE is in flight — the twin of {@link deleting}, and it
   * exists for the same window rather than for tidiness.
   *
   * Between `tryClaim` and `register` a turn is live and has no handle to
   * cancel, and that stretch contains real awaits. `archive()` promises the
   * user it stopped the turn first; without this, a turn crossing that window
   * registers behind the archive and runs on — with full tool access, on a run
   * the desk no longer shows.
   */
  private readonly archiving = new Set<string>();

  /**
   * Owned-card verdicts pressed while a turn ran, per run, sent when it ends
   * ({@link deliverOwnedCardVerdict}). In memory only: the verdict row and
   * the write are already durable, and a restart in between leaves the agent
   * unaware of a verdict the transcript still shows.
   */
  private readonly heldVerdicts = new Map<string, string[]>();
  /** Told each time a chat's turn has ended — how held host turns are released. */
  private readonly turnSettledListeners = new Set<(runId: string) => void>();
  /** Told when the user stops a chat — how held host turns are dropped. */
  private readonly stopListeners = new Set<(runId: string) => void>();

  /**
   * The deferred question each run is putting on screen RIGHT NOW, with the
   * key it asks under and the outcome the agent will be told — the per-run
   * claim {@link askUserDeferred} takes before its first await. The durable
   * half (`Run.pendingQuestion`) cannot be the claim: it is written only after
   * the card, several awaits later.
   */
  private readonly deferredAsks = new Map<
    string,
    {
      key: string;
      outcome: Promise<
        | HostQuestionOutcome
        | HostPlanOutcome
        | HostPatchOutcome
        | HostProjectInstructionsOutcome
      >;
    }
  >();

  /**
   * How a mid-turn approval change reaches the turn in flight, keyed by run.
   *
   * Set when a turn registers, dropped when it settles. Returns whether the
   * change was DELIVERED — an entry existing only means a turn is running, not
   * that it can be re-moded (a claude turn spawned under
   * `--dangerously-skip-permissions` has no permission dialogue to be told
   * through, and answers false).
   *
   * A function rather than the handle itself because two things must move
   * together: the CLI's own mode, and the `approvalMode` the turn's closure
   * reads at its auto-approve seam. Handing callers the handle would let them
   * move one without the other.
   */
  private readonly liveApproval = new Map<
    string,
    (mode: ChatApprovalMode) => boolean
  >();
  /**
   * The approval posture each run's KEPT PROCESS should be judged by right
   * now, including while no turn is running.
   *
   * Separate from the per-turn `approvalMode` because the two have genuinely
   * different lifetimes: a turn's copy dies with the turn, while the CLI
   * process lives on and can raise a permission request at any point in
   * between. Reading a turn-scoped copy there answered with whatever the LAST
   * turn was started under — so a user who ended a turn and then moved the chip
   * to `ask` still had the next between-turn tool call approved in their name,
   * with no card. `liveApproval` cannot cover that window by construction: it
   * is registered per turn and only consulted while one is in flight.
   *
   * Written on every turn start and by `updateSettings` whichever path it
   * takes; dropped when the run's session is torn down.
   */
  private readonly runPosture = new Map<string, ChatApprovalMode | undefined>();

  /**
   * Runs whose `running` badge was put there by an OFF-TURN row rather than by
   * a turn of ours — see {@link restatusAfterOffTurnEvent}.
   *
   * A set and not a boolean on the run row: this is a fact about who last wrote
   * the status in THIS process, which the row cannot carry (a restart has no
   * off-turn continuation to finish, and would read a stale flag as one).
   * Cleared when the continuation settles and whenever a real turn takes the
   * run over.
   */
  private readonly offTurnRuns = new Map<string, RunStatus>();
  /**
   * Each run's between-turn handlers still in flight. They run concurrently,
   * and `late_work_ended` carries no row, so it would otherwise settle the run
   * before the late result just ahead of it has written its row and restated
   * the badge; it waits for these instead.
   */
  private readonly offTurnInFlight = new Map<string, Set<Promise<void>>>();
  /**
   * How many between-turn calls that start late work each run has received,
   * counted on arrival. A `late_work_ended` waiting on {@link offTurnInFlight}
   * is dropped once one arrives after it: that call ends with an end of its
   * own, and settling then would put it under `completed`.
   */
  private readonly offTurnLateCalls = new Map<string, number>();
  /** Keep overlapping status writes in order, including Stop behind an off-turn write. */
  private readonly statusWrites = new Map<string, Promise<void>>();
  /**
   * A compaction the CLI finished BETWEEN turns, per run, until its row is
   * written — the off-turn twin of the in-turn `compactions`. Dropped again
   * the moment nothing is held, so a run leaves no entry behind.
   */
  private readonly offTurnCompactions = new Map<string, CompactionRows>();

  /**
   * Runs whose off-turn `running` is a LEASE on a delegate that is still
   * producing rows — see {@link leaseOnDelegateRow}.
   *
   * A subset of {@link offTurnRuns} rather than a parallel plane: the badge
   * belongs to the same off-turn continuation either way, so the CLI's own
   * continuation turn settles it exactly as it settles a main-thread one. What
   * this map adds is the only thing that one cannot carry — the expiry.
   *
   * The status to hand back lives on {@link offTurnRuns} for BOTH kinds, and
   * deliberately not here: an off-turn latch needs restoring on exactly the
   * same terms a lease does (see {@link settleAfterSessionClosed}), and a
   * second copy of that fact is how the two came to be restored differently.
   */
  private readonly delegateLeases = new Map<
    string,
    { timer: NodeJS.Timeout }
  >();

  /**
   * Runs whose lease is being TAKEN right now — claimed synchronously, before
   * the read that decides whether to take it.
   *
   * The map alone cannot express this. Off-turn events are dispatched
   * fire-and-forget, so two delegate rows parsed from one stdout chunk run
   * {@link leaseOnDelegateRow} concurrently: both find the map empty, both
   * `await` the run, and the second `set` overwrites the first entry —
   * orphaning a timer nothing can refresh or clear, which then hands the badge
   * back mid-work five minutes later however many rows kept arriving. Claiming
   * the key before the first `await` is what makes the second caller see the
   * lease that is on its way, the same single-flight discipline
   * `EffortsService`/`SkillsService` use for their reads.
   *
   * {@link clearDelegateLease} drops a claim as well as a lease, so a real turn
   * taking the badge over cancels one that has not landed yet — otherwise the
   * in-flight caller would install a lease over the top of it.
   *
   * A TOKEN per acquisition rather than a bare run id, because presence alone
   * cannot answer "is this still MY claim". A takeover between one caller's
   * read and its install drops that claim, and a later row may have claimed the
   * key again in the meantime — so the resuming caller has to compare identity,
   * or it reads the newcomer's claim as its own, installs over the turn that
   * just took the badge, and leaves `offTurnRuns` latched on a run a real turn
   * owns.
   */
  private readonly leaseClaims = new Map<string, symbol>();

  /**
   * Runs whose off-turn `running` flip is in flight — the same claim, for
   * {@link restatusAfterOffTurnSignal}.
   *
   * Separate from {@link leaseClaims} because the two decide different things:
   * a delegate's row takes a lease with an expiry, a main-thread delta takes
   * the latch that a terminal event ends. Sharing one set would let a delta in
   * flight swallow a delegate row's lease, leaving the latch on with nothing to
   * take it down.
   */
  private readonly offTurnSignalClaims = new Map<string, symbol>();

  /**
   * Runs whose off-turn ROW restate is in flight — the same token claim, for
   * {@link restatusAfterOffTurnEvent}. A later row takes the claim over, so of
   * two rows read close together only the last writes `running`; a terminal
   * event drops it, so a row read before the run settled writes nothing.
   */
  private readonly offTurnEventClaims = new Map<string, symbol>();

  /**
   * Per run, the delegates the CLI has told us are FINISHED — by launching
   * tool-call id, the same key their block is drawn under.
   *
   * The one fact that separates a delegate's trailing rows from a delegate that
   * is still working, and neither the row itself nor its timing can supply it:
   * both are `parentToolUseId` rows arriving after the turn settled. A delegate
   * the CLI brackets (`task_started` → `task_updated`) reports its own end, and
   * `spawn-cli` relays that as the `backgroundOpen: false` announcement that
   * closes the block; one it never brackets reports nothing, which is exactly
   * the case whose steps go on arriving under a `completed` badge. So a row
   * from a delegate named here restates nothing, and a row from one that is not
   * takes a lease — see {@link leaseOnDelegateRow}.
   */
  private readonly closedDelegates = new Map<string, Set<string>>();

  /**
   * Runs whose turn is HELD for background work, and by how many units.
   *
   * In memory and per run, exactly like the approval registry the `awaiting`
   * reading comes from, and on the run's WIRE row for exactly the same reason:
   * the hold begins with one broadcast and then lasts as long as the delegates
   * do. A window opened — or a chat revisited — after that broadcast has
   * nothing else to read it off, and would put the user's next message into a
   * queue that will not drain for minutes.
   */
  private readonly heldRuns = new Map<string, number>();
  /** Main-thread tool calls of the stretch the CLI is running by itself. */
  private readonly offTurnToolCalls = new Map<string, number>();

  /**
   * Runs holding DETACHED commands that have not reported back, by work id.
   *
   * The twin of {@link heldRuns} for the other thing that can outlive a turn,
   * and deliberately NOT folded into it: a shell does not HOLD the turn open —
   * that is the defect shells were carved out of `openWork` to fix (a thread
   * reading `working · waiting on 1 background task` over an agent that had
   * finished and was waiting for its user). This asserts nothing about the
   * turn; it is a DISPLAY fact, and the badge is the only thing that reads it.
   *
   * On the wire for the reason `heldRuns` is, and the reason it had to exist at
   * all: the renderer used to derive this from the OPEN thread's transcript,
   * which is knowable for one run and for no other — so a settled chat with a
   * `sleep` still out read `⌛ working` while it was selected and `✓ completed`
   * the instant it was not. REPORTED as "when i select thread - it bacame
   * working status, but when unselect - successs. So it's blinking". A fact
   * every row can read is the only thing that fixes that, and the daemon is
   * the only place that HAS it for every run at once.
   *
   * A SET of work ids rather than a counter: a CLI is free to report one unit's
   * end on both of its terminal channels (claude does — measured 7ms apart),
   * and a counter would go negative or latch on the double.
   */
  private readonly backgroundWork = new BackgroundWorkCounts((runId, patch) =>
    this.bus.publishRunStatus({ runId, status: null, ...patch }),
  );

  /**
   * Each chat's host tools that hold nothing of the turn, kept past it.
   *
   * The CLI outlives a turn and opens a continuation BY ITSELF when a background
   * command reports, with no turn of ours in flight. A tool that died with the
   * turn refused exactly there, where an agent reports what the command found
   * or starts the next wait. These write a row or a broadcast and park nothing,
   * as a team member's do between passes; a card that parks on the user still
   * dies with its turn, which is what sweeps it. The next turn's registration
   * replaces them, and a deleted run drops them.
   */
  private readonly keptHostTools = new Map<string, (() => void)[]>();

  private teamBrief:
    | ((slug: string, cwd: string, projectId: string | null) => Promise<string>)
    | null = null;

  private projectChatSource: ProjectChatSource | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly messageSends: MessageSendService,
    private readonly nodeStateDao: NodeStateDao,
    /**
     * Which pull requests each listed run opened — read off its own transcript
     * and kept on the row (`PullRequestCaptureService`).
     *
     * On the LIST rather than on a route of its own, because the sidebar, the
     * panel and the composer shelf all draw from the run rows they already
     * hold: a separate route would be a second fetch per thread for a value the
     * list is about to send anyway.
     */
    private readonly pullRequests: PullRequestCaptureService,
    private readonly bus: AgentEventBus,
    /**
     * The newest context reading per run — what every status broadcast is
     * stamped from, so a client that is not in this run's room still learns it.
     */
    private readonly contexts: RunContextRegistry,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly skillHarvest: SkillHarvestStore,
    private readonly mcpHarvest: McpHarvestStore,
    private readonly attachments: AttachmentStoreService,
    private readonly partials: PartialStreamService,
    private readonly teardown: RunTeardownService,
    private readonly efforts: EffortsService,
    private readonly seqs: ItemSeqAllocator,
    private readonly groups: RunGroupsService,
    private readonly cliSessions: CliSessionsService,
    private readonly configDirPins: ConfigDirPinService,
    private readonly userQuestions: UserQuestionBroker,
    private readonly findingsReports: FindingsReportBroker,
    private readonly charts: ChartBroker,
    private readonly patches: PatchBroker,
    private readonly plans: PlanBroker,
    private readonly metrics: MetricsBroker,
    private readonly comparisons: ComparisonBroker,
    private readonly galleries: GalleryBroker,
    private readonly artifacts: ArtifactBroker,
    private readonly actionSinks: ActionBroker,
    private readonly actionPublisher: ActionPublishService,
    private readonly teamProposals: TeamProposalBroker,
    private readonly artifactStore: ArtifactStoreService,
    private readonly notices: NotifyBroker,
    private readonly callTokens: CallTokenRegistry,
    private readonly calls: ItemCallIndexService,
    private readonly wallWork: WallWorkService,
    private readonly wallTurns: WallTurnDao,
    private readonly analyses: AnalysisBroker,
    private readonly analysisReports: AnalysisReportsService,
    private readonly teamBuilders: TeamBuilderBroker,
    private readonly runWrites: RunWriteQueue,
    private readonly memory: MemoryService,
    private readonly knowledge: KnowledgeService,
    private readonly projectScope: ProjectScopeService,
    private readonly holds: RunHoldRegistry,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    @Optional() private readonly agentMcp?: AgentMcpService,
    /** The `monitor` tool's commands, stopped with the thread. Optional for the positional specs. */
    @Optional() private readonly monitors?: MonitorRegistry,
    @Optional() private readonly monitorSinks?: MonitorBroker,
    /** `record_outcome`'s sink, installed per turn. Optional for the positional specs. */
    @Optional() private readonly runOutcomes?: RunOutcomeBroker,
    /** `save_project_instructions`' card and its Apply. Optional for the positional specs. */
    @Optional()
    private readonly projectInstructionCards?: ProjectInstructionsBroker,
    @Optional()
    private readonly projectInstructionWrites?: ProjectInstructionsChangeService,
    /** A project chat's standing to change its project, installed per turn. Optional for the positional specs. */
    @Optional() private readonly projectChats?: ProjectChatBroker,
    /** Messages from other threads, drained at a turn's start. Optional for the positional specs. */
    @Optional() private readonly threadInbox?: ThreadInboxService,
    /** The in-app browser's tools, installed per turn. Optional for the positional specs. */
    @Optional() private readonly browser?: BrowserBroker,
    /** Wakes for commands that end between turns. Optional for the positional specs. */
    @Optional() private readonly commandEndWakes?: CommandEndWakeService,
  ) {}

  /**
   * One attachment's bytes for the renderer, base64 in JSON — an `<img src>`
   * cannot carry the bearer token every daemon route demands, so the transcript
   * fetches through the generated client and builds a data URL.
   */
  readAttachment(runId: string, attachmentId: string): AttachmentDataWire {
    const { mediaType, bytes } = this.attachments.read(runId, attachmentId);
    return { id: attachmentId, mediaType, data: bytes.toString('base64') };
  }

  /**
   * Reconcile chat runs left `running` by a crash / SIGKILL / daemon restart
   * mid-turn. The in-process finalizer and the graceful-SIGTERM shutdown hook are
   * the only paths that flip a turn to a terminal status, and the UI's SIGKILL
   * escalation bypasses both — so a killed daemon leaves the run permanently
   * `running` with a dangling non-terminal transcript. On boot, any `running`
   * chat run with no live registry handle is closed: a synthetic terminal `error`
   * item so the transcript doesn't dangle, and the run is marked `failed`.
   *
   * Called from `main.ts` AFTER the schema sync and before listen, so no turn can
   * start on a run this is about to close.
   *
   * `cause` is why the previous daemon stopped, as the UI recorded it; the row
   * carries it so the task board can tell a stop it may continue from a crash it
   * must not (`TaskSettleService`).
   */
  async reconcileOrphanedRuns(cause: InterruptCause): Promise<void> {
    try {
      const em = this.em.fork();
      const stale = await this.runDao.listRunningChats(em);
      let reconciled = 0;
      for (const run of stale) {
        if (this.registry.has(run.id)) {
          continue; // an in-flight turn legitimately owns this run
        }
        await this.persist(
          em,
          run.id,
          await this.seqs.reserve(run.id),
          'error',
          null,
          {
            message: `run interrupted — ${interruptCauseClause(cause)} while this turn was running`,
            // Written at BOOT, which can be hours after the work stopped — so a
            // clock reading this row as the turn's end must not (the renderer's
            // wall-clock fallback ends such a turn at its last real row).
            interrupted: true,
            interruptCause: cause,
          },
        );
        // The kill took the in-memory registry with it, so no settle path ever
        // swept these — without this the cards come back looking answerable.
        // Not a card that outlives its turn by design — the standing question,
        // plan or patch, and the standing team proposal: each is put back
        // at boot from its column, and closing it here would leave a card
        // drawn expired that the registry still holds open.
        const standing = new Set(
          [
            readPendingQuestion(run.pendingQuestion ?? null)?.requestId,
            standingProposalCardId(run.pendingTeamProposal ?? null),
          ].filter((id): id is string => typeof id === 'string'),
        );
        for (const request of unansweredRequests(
          await this.itemDao.rowsOfKinds(
            run.id,
            ANSWERABILITY_KINDS,
            undefined,
            em,
          ),
        ).filter((request) => !standing.has(request.payload.id))) {
          await this.persist(
            em,
            run.id,
            await this.seqs.reserve(run.id),
            'unanswerable',
            null,
            request.payload,
          );
        }
        await this.setRunStatus(em, run.id, 'failed');
        reconciled += 1;
      }
      if (reconciled > 0) {
        this.logger.warn(
          `reconciled ${reconciled} orphaned running chat run(s) to failed on boot`,
        );
      }
    } catch (err) {
      // Best-effort cleanup — never block daemon boot (e.g. a fresh DB whose
      // schema sync hasn't created the tables yet has nothing to reconcile).
      this.logger.error(
        `boot reconcile of orphaned running runs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Write a run's status AND announce it.
   *
   * One helper rather than a `runDao.updateById` at each of the seven places a
   * status is written: the announcement is what keeps a background run's badge
   * honest, and a write that forgot to announce would go stale invisibly —
   * exactly the failure this replaces. Announce-after-write, so no client can
   * observe a status the database does not yet have.
   */
  private async setRunStatus(
    em: EntityManager,
    runId: string,
    status: RunStatus,
    announce: RunStatusAnnounce = {},
  ): Promise<void> {
    // A settle ends the open turn, and with it its holds; an off-turn stretch
    // writing `running` is dated by its own start (`off_turn_started`).
    if (isTerminalRunStatus(status)) {
      this.holds.forget(runId);
    }
    const previous = this.statusWrites.get(runId) ?? Promise.resolve();
    // A failed earlier write must not prevent a later Stop from settling the run.
    const write = previous
      .catch(() => undefined)
      .then(() =>
        writeRunStatus(
          { runDao: this.runDao, bus: this.bus, wallTurns: this.wallTurns },
          em,
          runId,
          status,
          // Read when the write runs, not when it was queued: a turn claimed
          // in between decides whether a standing card counts.
          this.hasStandingCard(runId)
            ? { awaiting: this.awaitingOf(runId), ...announce }
            : announce,
        ),
      );
    this.statusWrites.set(runId, write);
    try {
      await write;
    } finally {
      if (this.statusWrites.get(runId) === write) {
        this.statusWrites.delete(runId);
      }
    }
  }

  private announceActivity(runId: string, activity: string | null): void {
    this.bus.publishRunStatus({ runId, status: null, activity });
  }

  /**
   * Announce that the turn is now (or is no longer) merely HELD for background
   * work the agent started.
   *
   * The count rides as a FACT beside the phrase, not only inside it. The
   * composer has to act on this — while a run is held the agent is idle and a
   * message must go straight out rather than into the queue — and reading that
   * decision off the wording of an English sentence is how a UI comes to break
   * when someone improves the copy.
   */
  private announceRunHold(
    runId: string,
    open: number,
    activity: string | null,
  ): void {
    if (open > 0) {
      this.heldRuns.set(runId, open);
    } else {
      this.heldRuns.delete(runId);
    }
    this.holds.hold(runId, open);
    this.bus.publishRunStatus({
      runId,
      status: null,
      activity,
      holdingFor: open,
    });
  }

  /**
   * Announce that a run has become parked on the user — or stopped being.
   *
   * Separate from {@link announceActivity} because the two say different
   * things and only one of them belongs on a tool call. The activity phrase is
   * the sentence under the badge; this is the badge, and the badge must not
   * read "running" while nothing can move without the user.
   *
   * Always read back OUT of the registry rather than passed in as the kind that
   * just changed: a turn can hold several cards at once, so "this one closed"
   * is not "nothing is open". Answering from the map is what keeps a second
   * open question from being cleared by the first one's verdict.
   *
   * It carries no activity PHRASE, deliberately — the kind is the whole fact,
   * and the sentence under the badge is worded by the renderer from it. The
   * daemon used to send "waiting for your answer" here as an activity string,
   * which read fine live and then vanished on a reload: the activity plane is
   * events-only, so a reconnecting window had the badge (which rides the run
   * row) with nothing under it. One authority for the fact, one place that
   * words it, and both surfaces agree whenever they are drawn.
   *
   * Clearing the activity is also correct rather than incidental: whatever the
   * run was last said to be DOING, it is not doing it while it waits.
   *
   * What is NOT correct is leaving it cleared once the wait ENDS, which is what
   * {@link resumedActivity} is for. The approved tool then runs with nothing
   * naming it — the phrase is only ever written by a `tool_call`, and the call
   * the user just approved had already announced itself BEFORE the card went
   * up. Measured on a real `ask` turn: a 30s command approved by hand ran under
   * "Working… 11s" from the moment Approve was pressed. That is the reported
   * "the line does not match the work" again, on the commonest path there is.
   * Used only when nothing is still awaiting — a second open card means the run
   * is still parked and the phrase must stay down.
   */
  private announceAwaiting(
    runId: string,
    resumedActivity: string | null = null,
  ): void {
    const awaiting = this.awaitingOf(runId);
    this.bus.publishRunStatus({
      runId,
      status: null,
      activity: awaiting === null ? resumedActivity : null,
      awaiting,
    });
  }

  /**
   * What the run is parked on, for the badge. A standing card another module
   * owns (a team proposal) is not counted while a turn runs: the card
   * stands across turns by design, and the agent working on the user's typed
   * reply is working, not waiting. It counts again once the turn is over.
   */
  private awaitingOf(runId: string): RunAwaiting | null {
    const turning = this.registry.has(runId);
    return this.approvals.awaitingFor(
      runId,
      (entry) => turning && isStandingCard(entry),
    );
  }

  /** Whether the run has a {@link awaitingOf} card whose count moves with its turns. */
  private hasStandingCard(runId: string): boolean {
    return this.approvals.listByRun(runId).some(isStandingCard);
  }

  /**
   * Say again that a deferred card is still waiting, after a status write.
   *
   * `writeRunStatus` publishes `awaiting: null` on every status change. That
   * is true for a parked call the settle just swept, and false for a deferred
   * card `sweepNode` left standing — without this the badge dies with the
   * turn the card was built to outlive, and the banner never fires for it.
   */
  private restoreDeferredAwaiting(runId: string): void {
    // `awaitingOf`, not the bare registry: a turn claimed in between leaves a
    // standing card uncounted, and announcing that would blank its phrase.
    if (this.awaitingOf(runId) !== null) {
      this.announceAwaiting(runId);
    }
  }

  // ── Deferred cards ──────────────────────────────────────────────────────
  //
  // A card the agent is NOT blocked on, for a CLI whose MCP client refuses to
  // hold a `tools/call` open for a person (`AdapterConfig.hostQuestionDeferredReason`).
  // The tool answers `posted` at once and the agent is told to stop; the card
  // stands until the user answers it, and the answer reaches the agent as the
  // run's NEXT message. A question, a plan, a patch and a project card share the column and
  // the one-card rule. So a card may be left open for an hour, which is the
  // whole point — what it costs is that these methods have to hold everything
  // the parked promise used to hold for free.

  /**
   * Put one deferred card in the registry, with a responder that starts a turn
   * rather than resolving a parked call.
   *
   * It closes over NOTHING of the turn that raised it — no `em`, no seq
   * allocator, no enqueue chain — because by the time it runs that turn has
   * ended and, routinely, so has the whole daemon process. That is also what
   * lets the boot rehydration call it with a row read off disk.
   */
  private trackDeferredCard(
    runId: string,
    snapshot: PendingCardSnapshot,
  ): void {
    const question = snapshot.kind === 'question';
    this.approvals.track({
      runId,
      memberId: SINGLE_AGENT_NODE,
      requestId: snapshot.requestId,
      toolName: deferredCardTool(snapshot),
      input: deferredCardInput(snapshot),
      question,
      deferred: true,
      respond: (allow, answer) => {
        // Fire-and-forget, and `true` regardless: the verdict channel is a
        // synchronous WS ack, while delivering this answer is a database write
        // and a new turn. What the ack means here is "accepted", which is the
        // honest reading — the alternative is making the user wait on a CLI
        // spawn to learn their click registered.
        void this.deliverDeferredAnswer(runId, snapshot, allow, answer);
        return true;
      },
    });
  }

  /**
   * What the verdict row records and what the agent is told.
   *
   * A question sends the user's words, as it always has. A plan sends the
   * verdict sentence, note included. A patch and a project card run their
   * write first and send what that write did.
   */
  private async deferredDelivery(
    runId: string,
    snapshot: PendingCardSnapshot,
    allow: boolean,
    answer: string | undefined,
    em: EntityManager,
  ): Promise<{ message: string; answer?: string; outcome?: string }> {
    switch (snapshot.kind) {
      case 'question':
        return {
          message: deferredAnswerMessage(allow, answer),
          ...(allow && answer !== undefined ? { answer } : {}),
        };
      case 'plan': {
        const note =
          answer !== undefined && answer.trim().length > 0
            ? answer.trim()
            : undefined;
        const outcome: HostPlanOutcome = {
          status: allow ? 'approved' : 'declined',
          ...(note === undefined ? {} : { note }),
        };
        return {
          message: hostPlanResultText(outcome),
          ...(note === undefined ? {} : { answer: note }),
        };
      }
      case 'patch': {
        const outcome = await this.deferredPatchOutcome(
          runId,
          allow,
          snapshot,
          em,
        );
        return {
          message: hostPatchResultText(outcome),
          ...hostPatchVerdict(outcome),
        };
      }
      case 'project': {
        const outcome: HostProjectInstructionsOutcome = allow
          ? await this.writeProjectInstructions(runId, snapshot.change)
          : { status: 'declined' };
        return {
          message: hostProjectInstructionsResultText(
            outcome,
            snapshot.change.cardSeq === null,
          ),
          ...projectInstructionsVerdict(outcome),
        };
      }
    }
  }

  /** A project-instructions card's Apply, written as the analysis or project chat that raised it. */
  private writeProjectInstructions(
    runId: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    return (
      this.projectInstructionWrites?.write(runId, change) ??
      Promise.resolve({
        status: 'stale',
        reason: 'this daemon cannot write project instructions',
      })
    );
  }

  /**
   * Apply a deferred patch from the run's cwd, or say why it was not applied.
   *
   * The cwd is read off the run at answer time. The turn that proposed the
   * patch is gone, and so, routinely, is the process — the snapshot is the
   * only copy of the body left.
   *
   * The folder is validated the way the blocking path's turn does it
   * (`resolveValidCwd`). A card can stand for hours with no turn running, so
   * the folder may be gone by Apply, and `applyHostPatch` would recreate it
   * for a whole-file write.
   *
   * Every failure is `stale`, never `unavailable`: the user saw the card and
   * pressed Apply, and `unavailable` tells the agent the patch never reached
   * them.
   */
  private async deferredPatchOutcome(
    runId: string,
    allow: boolean,
    snapshot: PendingPatchSnapshot,
    em: EntityManager,
  ): Promise<HostPatchOutcome> {
    if (!allow) {
      return { status: 'declined' };
    }
    let cwd: string | null;
    try {
      const run = await this.runDao.getById(runId, em);
      cwd = run?.cwd ?? null;
    } catch (err) {
      this.logger.error(
        `run ${runId} could not read its folder for a deferred patch: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'stale', reason: 'the file could not be written' };
    }
    if (cwd === null || cwd.length === 0) {
      return { status: 'stale', reason: 'the chat has no working folder' };
    }
    let root: string;
    try {
      root = resolveValidCwd(cwd);
    } catch (err) {
      this.logger.warn(
        `run ${runId} left a deferred patch unwritten: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'stale', reason: 'the chat’s folder no longer exists' };
    }
    return applyHostPatch(root, snapshot.patch, snapshot.fingerprint);
  }

  /**
   * The user answered a deferred card: record the verdict, forget the standing
   * card, and hand the answer to the agent as the run's next message.
   *
   * ORDER is load-bearing. The column is cleared and the verdict written BEFORE
   * the message goes out, because `sendMessage` retires whatever card is still
   * standing on the run (`retireDeferredQuestions`) — with the clear after it,
   * the answer's own turn would write this card off as superseded and the
   * transcript would carry both a verdict and an `unanswerable` for one id.
   */
  private async deliverDeferredAnswer(
    runId: string,
    snapshot: PendingCardSnapshot,
    allow: boolean,
    answer?: string,
  ): Promise<void> {
    const em = this.em.fork();
    // A patch's Apply writes the file BEFORE the column is cleared. The write
    // is `applyHostPatch` — the blocking path's own function, from the run's
    // cwd as it stands now, not a closure over the turn that proposed it —
    // so a restart answers the same way a live turn does.
    const delivery = await this.deferredDelivery(
      runId,
      snapshot,
      allow,
      answer,
      em,
    );
    try {
      await this.clearOwnPendingCard(runId, snapshot.requestId, em);
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'approval_verdict',
        null,
        {
          id: snapshot.requestId,
          allow,
          ...(delivery.answer === undefined ? {} : { answer: delivery.answer }),
          ...(delivery.outcome === undefined
            ? {}
            : { outcome: delivery.outcome }),
        },
      );
      this.announceAwaiting(runId);
    } catch (err) {
      // The verdict row is the record of what the user chose, so a failure here
      // is worth a log — but it must not stop the answer reaching the agent,
      // which is the thing they actually pressed for.
      this.logger.error(
        `run ${runId} deferred verdict write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      await this.sendMessage(runId, delivery.message);
    } catch (err) {
      // An archived run, a run being deleted, a CLI that refused the send: the
      // card is answered either way and the transcript says so, so this is the
      // agent not hearing it rather than the answer being lost.
      this.logger.error(
        `run ${runId} could not deliver a deferred answer: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Clear the run's deferred-card column if it still points at `requestId`.
   *
   * The delivery reaches this only after awaiting the run row and, for a
   * patch, the file write. In that window the user may have typed on and a
   * new turn put up a DIFFERENT card, which must keep its pointer. Read on a
   * fresh fork (the delivery's own may have the row cached from before), and
   * cleared only if the text is still what was read.
   */
  private async clearOwnPendingCard(
    runId: string,
    requestId: string,
    em: EntityManager,
  ): Promise<void> {
    const run = await this.runDao.getById(runId, this.em.fork());
    const column = run?.pendingQuestion ?? null;
    if (
      column === null ||
      readPendingQuestion(column)?.requestId !== requestId
    ) {
      return;
    }
    await this.runDao.clearPendingQuestionIf(runId, column, em);
  }

  /**
   * Retire the deferred card a run is standing on, because a NEW turn has
   * superseded it — the user typed something else instead of answering. Never
   * a standing card another module owns (a team proposal): only its owner
   * retires that one.
   *
   * Written as `unanswerable` on `ApprovalRegistry.sweepDeferred`'s own
   * obligation: the card is on screen with live buttons, and dropping the entry
   * silently only makes the next press fail quietly.
   *
   * The column is cleared even when the registry holds nothing, which is the
   * case after a restart this process has not rehydrated (or one where the
   * rehydration refused a malformed row): the durable half must not outlive the
   * card it points at.
   */
  private async retireDeferredQuestions(runId: string): Promise<void> {
    const swept = this.approvals.sweepDeferred(
      runId,
      (entry) => !isStandingCard(entry),
    );
    const em = this.em.fork();
    try {
      await this.runDao.setPendingQuestion(runId, null, em);
      for (const approval of swept) {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          'unanswerable',
          null,
          unanswerablePayload(approval),
        );
      }
      if (swept.length > 0) {
        this.announceAwaiting(runId);
      }
    } catch (err) {
      this.logger.error(
        `run ${runId} could not retire a standing question: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Put every standing deferred card back in the registry at boot.
   *
   * Called from `main.ts` beside the other launch passes. Without it the
   * feature does not survive its own commonest case: a deferred card leaves the
   * daemon with no turn in flight, so `IdleShutdownLifecycle` exits the process
   * ten minutes after the last window closes — and a user who comes back to
   * answer an hour later would find a card whose buttons do nothing.
   *
   * A row it cannot read is CLEARED rather than left: the column is a pointer
   * into the transcript, and one nothing can be tracked from is a run reporting
   * that it is waiting on a question nobody can answer.
   */
  async rehydrateDeferredQuestions(): Promise<void> {
    try {
      const em = this.em.fork();
      const runs = await this.runDao.listRunsWithPendingQuestion(em);
      let restored = 0;
      for (const run of runs) {
        const snapshot = readPendingQuestion(run.pendingQuestion);
        if (snapshot === null) {
          await this.runDao.setPendingQuestion(run.id, null, em);
          continue;
        }
        this.trackDeferredCard(run.id, snapshot);
        restored += 1;
      }
      if (restored > 0) {
        this.logger.log(`restored ${restored} standing card(s)`);
      }
    } catch (err) {
      this.logger.error(
        `standing question rehydration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── Deferred cards another module owns ──────────────────────────────────
  //
  // The same outliving card, raised for a module this one may not import (the
  // team proposal, whose write lives in `v1/teams`). The owner supplies
  // the responder and keeps the durable half; this service writes the rows and
  // delivers the verdict, because only it can start the run's next turn.

  /**
   * Put a deferred card on screen and in the registry, under the id its owner
   * minted. Throws when the row cannot be written, and then tracks nothing.
   */
  async raiseOwnedCard(
    runId: string,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
  ): Promise<void> {
    const em = this.em.fork();
    // An archived chat never takes the verdict's message, and its card would
    // stand with nobody able to act on it — refused, so the owner says so.
    if (
      this.archiving.has(runId) ||
      ((await this.runDao.getById(runId, em))?.archivedAt ?? null) !== null
    ) {
      throw new ConflictException('RUN_ARCHIVED', 'this chat is archived');
    }
    await this.persist(
      em,
      runId,
      await this.seqs.reserve(runId),
      'approval_request',
      null,
      { id: requestId, toolName: card.toolName, input: card.input },
    );
    this.trackOwnedCard(runId, requestId, card, respond);
    // Not into a running turn: the card does not count while one runs, and
    // the announce would only blank the turn's own activity phrase.
    if (!this.registry.has(runId)) {
      this.announceAwaiting(runId);
    }
  }

  /**
   * Track a deferred card whose row already stands — the owner's boot
   * rehydration. Its responder runs at most once, the registry dropping the
   * entry before it calls it.
   */
  trackOwnedCard(
    runId: string,
    requestId: string,
    card: DeferredCard,
    respond: DeferredCardResponder,
  ): void {
    this.approvals.track({
      runId,
      memberId: SINGLE_AGENT_NODE,
      requestId,
      toolName: card.toolName,
      input: card.input,
      question: false,
      deferred: true,
      standing: true,
      respond: (allow, answer, optionId) => {
        // `true` at once, for the reason `trackDeferredCard` gives. Arity
        // preserved, as `ApprovalRegistry.resolve` is: only a verdict naming
        // an option carries a third argument.
        if (optionId === undefined) {
          respond(allow, answer);
        } else {
          respond(allow, answer, optionId);
        }
        return true;
      },
    });
  }

  /**
   * Record the user's verdict on an owned card, then hand `message` to the
   * agent as the run's next message. The note the user typed stays on the row
   * whichever button they pressed.
   *
   * A press while a turn runs is HELD until that turn ends rather than sent
   * into it: the card stands across turns, so this is the ordinary case, and
   * a message delivered mid-turn interrupts an ACP agent's work (or is refused
   * `RUN_BUSY`, losing the verdict after its file was written). It is held too
   * while a deferred question, plan or patch stands: the turn the verdict
   * starts would write that card off before the user answered it.
   *
   * `outcome` is what the owner did with an approval, kept on the row so the
   * card can say it before the agent hears it.
   */
  async deliverOwnedCardVerdict(
    runId: string,
    requestId: string,
    allow: boolean,
    message: string,
    answer?: string,
    outcome?: TeamProposalOutcome,
  ): Promise<void> {
    await this.recordOwnedCardVerdict(runId, requestId, allow, {
      ...(answer === undefined ? {} : { answer }),
      ...(outcome === undefined ? {} : { outcome }),
    });
    if (this.mustHoldVerdict(runId)) {
      this.holdVerdict(runId, message);
      return;
    }
    await this.sendOwnedVerdict(runId, message);
  }

  /**
   * Write the `approval_verdict` row of an owned card. A failure is logged and
   * swallowed: the row is the record of what the user chose, but it must not
   * stop the answer reaching the agent, which is what they pressed for.
   */
  private async recordOwnedCardVerdict(
    runId: string,
    requestId: string,
    allow: boolean,
    fields: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.persist(
        this.em.fork(),
        runId,
        await this.seqs.reserve(runId),
        'approval_verdict',
        null,
        { id: requestId, allow, ...fields },
      );
      if (!this.registry.has(runId)) {
        this.announceAwaiting(runId);
      }
    } catch (err) {
      this.logger.error(
        `run ${runId} owned-card verdict write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The chat's browser tools: the name its card shows, whether the run lets
   * every host through unasked (the approval mode read live, since it can move
   * mid-turn and between turns), and the new-host card.
   */
  private browserSinkOf(
    broker: BrowserBroker,
    runId: string,
    agentName: string,
  ): BrowserSink {
    return {
      memberName: agentName,
      approvesEveryHost: () => this.runPosture.get(runId) === 'auto',
      askHost: async (ask) => {
        const standing = this.approvals
          .listByRun(runId)
          .some(
            (entry) =>
              entry.toolName === HOST_BROWSER_HOST_CARD &&
              (entry.input as BrowserHostCardInput).host === ask.host,
          );
        if (standing) {
          return { status: 'standing' };
        }
        const requestId = this.approvals.mintCardId('browser-host');
        const input: BrowserHostCardInput = {
          host: ask.host,
          url: ask.url,
          memberName: agentName,
        };
        try {
          await this.raiseOwnedCard(
            runId,
            requestId,
            { toolName: HOST_BROWSER_HOST_CARD, input },
            (allow, _answer, optionId) => {
              void this.settleBrowserHostCard(broker, runId, requestId, {
                allow,
                optionId,
                host: ask.host,
                memberName: agentName,
                op: ask.op,
              });
            },
          );
        } catch (err) {
          if (
            err instanceof ConflictException &&
            err.errorCode === 'RUN_ARCHIVED'
          ) {
            return {
              status: 'unavailable',
              reason: 'this chat is archived, so the user cannot be asked',
            };
          }
          throw err;
        }
        return { status: 'asked' };
      },
    };
  }

  /**
   * The user answered a new-host card: the verdict row first, then the broker
   * approves, opens the page and wakes the agent. Nothing is sent as a user
   * message — the wake is geniro's own, on its own hold (`HostWakeChatDelivery`).
   */
  private async settleBrowserHostCard(
    broker: BrowserBroker,
    runId: string,
    requestId: string,
    answered: {
      allow: boolean;
      optionId: string | undefined;
      host: string;
      memberName: string;
      op: BrowserOp;
    },
  ): Promise<void> {
    const forSession =
      answered.allow && answered.optionId === BROWSER_SESSION_OPTION;
    await this.recordOwnedCardVerdict(runId, requestId, answered.allow, {
      ...(forSession
        ? {
            option: BROWSER_SESSION_VERDICT_OPTION,
          }
        : {}),
    });
    await broker.settleHostCard(
      {
        requestId,
        owner: {
          runId,
          memberId: SINGLE_AGENT_NODE,
          conversationId: null,
          caller: SINGLE_AGENT_NODE,
          target: 'chat',
        },
        memberName: answered.memberName,
        host: answered.host,
        op: answered.op,
      },
      { allow: answered.allow, optionId: answered.optionId },
    );
  }

  /** Be told each time a chat's turn has ended; returns the unsubscribe. */
  onTurnSettled(listener: (runId: string) => void): () => void {
    this.turnSettledListeners.add(listener);
    return () => {
      this.turnSettledListeners.delete(listener);
    };
  }

  /** Be told when the user stops a chat; returns the unsubscribe. */
  onStopped(listener: (runId: string) => void): () => void {
    this.stopListeners.add(listener);
    return () => {
      this.stopListeners.delete(listener);
    };
  }

  private notifyTurnSettled(runId: string): void {
    this.commandEndWakes?.turnEnded(chatWakeOwner(runId));
    this.notify(this.turnSettledListeners, runId, 'turn-settled');
  }

  private notify(
    listeners: ReadonlySet<(runId: string) => void>,
    runId: string,
    what: string,
  ): void {
    for (const listener of listeners) {
      try {
        listener(runId);
      } catch (err) {
        this.logger.error(
          `run ${runId} ${what} listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Whether a turn geniro starts on its own (a monitor's output) must wait —
   * on the same terms as an owned card's verdict: a turn runs, or a question,
   * plan or patch card waits for the user's answer, whose turn comes first.
   * `closing` when the chat is being archived or deleted.
   */
  hostTurnHold(runId: string): 'wait' | 'closing' | null {
    if (this.deleting.has(runId) || this.archiving.has(runId)) {
      return 'closing';
    }
    return this.mustHoldVerdict(runId) ? 'wait' : null;
  }

  /** Whether the chat still has a detached command or a background sub-agent out. */
  holdsBackgroundWork(runId: string): boolean {
    return (
      this.backgroundWork.shellsOpen(runId) > 0 ||
      this.backgroundWork.subagentsOut(runId) > 0
    );
  }

  /** Whether a verdict has to wait: a turn runs, or a question card stands. */
  private mustHoldVerdict(runId: string): boolean {
    return this.registry.has(runId) || this.awaitsCardAnswer(runId);
  }

  /** Whether a card stands that a new turn would retire unanswered. */
  awaitsCardAnswer(runId: string): boolean {
    return this.approvals
      .listByRun(runId)
      .some((entry) => entry.deferred === true && !isStandingCard(entry));
  }

  /** Whether a chat is archived, or being archived now. */
  async isArchived(runId: string): Promise<boolean> {
    return (
      this.archiving.has(runId) ||
      ((await this.runDao.getById(runId, this.em.fork()))?.archivedAt ??
        null) !== null
    );
  }

  private holdVerdict(runId: string, message: string): void {
    this.heldVerdicts.set(runId, [
      ...(this.heldVerdicts.get(runId) ?? []),
      message,
    ]);
  }

  /**
   * Send the verdicts held behind a turn, now that it has ended — decided now,
   * not when they were held: a chat being deleted or archived drops them (it
   * would refuse the message, after writing a row for it), and a question card
   * still standing keeps them waiting for the turn its answer starts.
   */
  private releaseHeldVerdicts(runId: string): void {
    const held = this.heldVerdicts.get(runId);
    if (held === undefined) {
      return;
    }
    if (this.deleting.has(runId) || this.archiving.has(runId)) {
      this.heldVerdicts.delete(runId);
      return;
    }
    if (this.mustHoldVerdict(runId)) {
      return;
    }
    this.heldVerdicts.delete(runId);
    void this.sendOwnedVerdict(runId, held.join('\n\n'));
  }

  private async sendOwnedVerdict(
    runId: string,
    message: string,
  ): Promise<void> {
    if (this.deleting.has(runId) || this.archiving.has(runId)) {
      return;
    }
    try {
      await this.sendMessage(runId, message, [], { ownTurn: true });
    } catch (err) {
      // Busy after all (a turn claimed in between, a compaction): held for that
      // turn's end instead. An archived or deleted run refuses for good — the
      // card is answered either way and the transcript says so, so this is the
      // agent not hearing it rather than the answer being lost.
      if (err instanceof ConflictException && err.errorCode === 'RUN_BUSY') {
        this.holdVerdict(runId, message);
        return;
      }
      this.logger.error(
        `run ${runId} could not deliver an owned-card verdict: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Retire one owned card as `unanswerable` — its owner superseded it. A card
   * the registry no longer holds is still closed (a boot whose rehydration
   * never reached it leaves it on screen) unless the transcript already closes
   * it: one card, one closing row, or an answered card would draw as expired.
   */
  async retireOwnedCard(
    runId: string,
    requestId: string,
    toolName: string,
  ): Promise<void> {
    const em = this.em.fork();
    if (
      this.approvals.abandon(runId, requestId) === null &&
      (
        await this.itemDao.rowsByPayloadId(
          runId,
          ['approval_verdict', 'unanswerable'],
          [requestId],
          undefined,
          em,
        )
      ).length > 0
    ) {
      return;
    }
    await this.persist(
      em,
      runId,
      await this.seqs.reserve(runId),
      'unanswerable',
      null,
      { id: requestId, toolName } satisfies UnanswerableWire,
    );
    if (!this.registry.has(runId)) {
      this.announceAwaiting(runId);
    }
  }

  /**
   * Close the run's standing owned card and forget its column — an archived
   * chat refuses messages, so a verdict pressed there could never reach the
   * agent. Read from the column rather than the registry, which a boot may not
   * have rehydrated.
   */
  private async retireStandingCard(runId: string): Promise<void> {
    try {
      // Read again, after the stop: a proposal raised while the turn was being
      // cancelled is the one standing now.
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      const cardId = standingProposalCardId(run?.pendingTeamProposal ?? null);
      if (cardId !== null) {
        await this.retireOwnedCard(runId, cardId, HOST_PROPOSE_TEAM_TOOL);
        await this.runDao.setPendingTeamProposal(runId, null, em);
      }
      const projectCardId = teamProjectCardId(
        run?.pendingTeamProjectCard ?? null,
      );
      if (projectCardId !== null) {
        await this.retireOwnedCard(
          runId,
          projectCardId,
          HOST_PROJECT_INSTRUCTIONS_TOOL,
        );
        await this.runDao.setPendingTeamProjectCard(runId, null, em);
      }
      for (const entry of this.approvals.listByRun(runId)) {
        if (entry.toolName === HOST_BROWSER_HOST_CARD) {
          await this.retireOwnedCard(
            runId,
            entry.requestId,
            HOST_BROWSER_HOST_CARD,
          );
        }
      }
    } catch (err) {
      this.logger.error(
        `run ${runId} could not close its standing card on archive: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Raise a deferred card and answer the agent at once.
   *
   * ONE per run, and a second DIFFERENT question is refused rather than stacked.
   * The durable half is a single column, so two standing cards would leave one
   * of them unable to survive a restart — and the agent has in any case just
   * been told to stop, so a second ask in the same turn is it not doing that.
   * An IDENTICAL re-ask is answered `posted` again without raising anything,
   * which is the deferred twin of `StandingQuestions`' adopt.
   */
  private askUserDeferred(
    em: EntityManager,
    runId: string,
    key: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    return this.withDeferredClaim(runId, key, () =>
      this.raiseDeferredQuestion(em, runId, key, questions, title),
    );
  }

  private proposePlanDeferred(
    em: EntityManager,
    runId: string,
    plan: HostPlan,
  ): Promise<HostPlanOutcome> {
    const key = deferredPlanKey(plan);
    return this.withDeferredClaim(runId, key, () =>
      this.raiseDeferredPlan(em, runId, key, plan),
    );
  }

  private proposeProjectInstructionsDeferred(
    em: EntityManager,
    runId: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    const key = projectInstructionsCardKey(change);
    return this.withDeferredClaim(runId, key, () =>
      this.raiseDeferredProjectInstructions(em, runId, key, change),
    );
  }

  private proposePatchDeferred(
    em: EntityManager,
    runId: string,
    patch: HostPatch,
    cwd: string,
  ): Promise<HostPatchOutcome> {
    const key = deferredPatchKey(patch);
    return this.withDeferredClaim(runId, key, () =>
      this.raiseDeferredPatch(em, runId, key, patch, cwd),
    );
  }

  /**
   * Claim the run's one deferred slot SYNCHRONOUSLY, before the first await.
   *
   * The standing check reads the run row, so two different asks racing in one
   * tick both found nothing standing, both drew a card, and only the second
   * survived in `Run.pendingQuestion`. An identical ask in flight shares the
   * first one's outcome.
   */
  private withDeferredClaim<
    T extends
      | HostQuestionOutcome
      | HostPlanOutcome
      | HostPatchOutcome
      | HostProjectInstructionsOutcome,
  >(runId: string, key: string, raise: () => Promise<T>): Promise<T> {
    const inFlight = this.deferredAsks.get(runId);
    if (inFlight !== undefined) {
      return (
        inFlight.key === key
          ? inFlight.outcome
          : Promise.resolve({
              status: 'unavailable' as const,
              reason: QUESTION_ALREADY_STANDING,
            })
      ) as Promise<T>;
    }
    const outcome = raise();
    this.deferredAsks.set(runId, { key, outcome });
    return outcome.finally(() => {
      if (this.deferredAsks.get(runId)?.outcome === outcome) {
        this.deferredAsks.delete(runId);
      }
    });
  }

  /** The card already in the column, or null when the run is parked on none. */
  private async standingCard(
    em: EntityManager,
    runId: string,
    key: string,
  ): Promise<
    { status: 'posted' } | { status: 'unavailable'; reason: string } | null
  > {
    const run = await this.runDao.getById(runId, em);
    const standing = readPendingQuestion(run?.pendingQuestion ?? null);
    if (standing === null) {
      return null;
    }
    return adoptsStanding(standing, key)
      ? { status: 'posted' }
      : { status: 'unavailable', reason: QUESTION_ALREADY_STANDING };
  }

  /** {@link askUserDeferred}'s body, once the run's claim is held. */
  private async raiseDeferredQuestion(
    em: EntityManager,
    runId: string,
    key: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    const standing = await this.standingCard(em, runId, key);
    if (standing !== null) {
      return standing;
    }
    const requestId = randomUUID();
    const snapshot: PendingQuestionSnapshot = {
      kind: 'question',
      requestId,
      title,
      questions,
    };
    return this.commitDeferredCard(
      em,
      runId,
      snapshot,
      {
        id: requestId,
        toolName: HOST_QUESTION_TOOL,
        input: deferredCardInput(snapshot),
        questions: hostCardQuestions(questions),
      },
      'the question card could not be written',
    );
  }

  /** {@link proposePlanDeferred}'s body, once the run's claim is held. */
  private raiseDeferredPlan(
    em: EntityManager,
    runId: string,
    key: string,
    plan: HostPlan,
  ): Promise<HostPlanOutcome> {
    return this.raiseDeferredCard(em, runId, key, async (requestId) => ({
      kind: 'plan',
      requestId,
      title: plan.title,
      steps: plan.steps,
    }));
  }

  /** {@link proposePatchDeferred}'s body, once the run's claim is held. */
  private raiseDeferredPatch(
    em: EntityManager,
    runId: string,
    key: string,
    patch: HostPatch,
    cwd: string,
  ): Promise<HostPatchOutcome> {
    return this.raiseDeferredCard(em, runId, key, async (requestId) => ({
      kind: 'patch',
      requestId,
      patch,
      fingerprint: await captureHostPatchFingerprint(cwd, patch),
    }));
  }

  /** {@link proposeProjectInstructionsDeferred}'s body, once the run's claim is held. */
  private raiseDeferredProjectInstructions(
    em: EntityManager,
    runId: string,
    key: string,
    change: HostProjectInstructions,
  ): Promise<HostProjectInstructionsOutcome> {
    return this.raiseDeferredCard(em, runId, key, async (requestId) => ({
      kind: 'project',
      requestId,
      change,
    }));
  }

  /**
   * A plan, patch or project card put up deferred, unless the run already
   * stands on one: the same card adopted, a different one refused.
   */
  private async raiseDeferredCard(
    em: EntityManager,
    runId: string,
    key: string,
    snapshotOf: (requestId: string) => Promise<PendingCardSnapshot>,
  ): Promise<{ status: 'posted' } | { status: 'unavailable'; reason: string }> {
    const standing = await this.standingCard(em, runId, key);
    if (standing !== null) {
      return standing;
    }
    const snapshot = await snapshotOf(randomUUID());
    return this.commitDeferredCard(
      em,
      runId,
      snapshot,
      {
        id: snapshot.requestId,
        toolName: deferredCardTool(snapshot),
        input: deferredCardInput(snapshot),
      },
      'the card could not be written',
    );
  }

  /**
   * Persist the card, then the column that points at it, then track it.
   *
   * The column is written AFTER the row: a pointer written first would survive
   * a failed persist as a run parked on a card that was never drawn.
   */
  private async commitDeferredCard(
    em: EntityManager,
    runId: string,
    snapshot: PendingCardSnapshot,
    row: Record<string, unknown>,
    failureReason: string,
  ): Promise<{ status: 'posted' } | { status: 'unavailable'; reason: string }> {
    try {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'approval_request',
        null,
        row,
      );
      await this.runDao.setPendingQuestion(
        runId,
        serializePendingQuestion(snapshot),
        em,
      );
    } catch (err) {
      // Logged and replaced, on the findings sink's rule: a persist failure
      // names an absolute database path, and this reason goes to a model whose
      // provider is off this machine.
      this.logger.error(
        `run ${runId} could not put a deferred card on screen: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { status: 'unavailable', reason: failureReason };
    }
    this.trackDeferredCard(runId, snapshot);
    this.announceAwaiting(runId);
    return { status: 'posted' };
  }

  async createChat(input: {
    agentKind: AgentKind;
    cwd: string;
    /**
     * What `cwd` had checked out at this moment, read by the client — the fixed
     * point the diff view measures against. Absent for a folder that is not a
     * repository or has no commits yet, which is a real answer and stored as
     * null; see {@link Run.startSha}.
     */
    startSha?: string;
    startDirty?: boolean;
    model?: string;
    title?: string;
    approval?: ChatApprovalMode;
    effort?: string;
    contextWindow?: string;
    autoCompactPercent?: number;
    modelParameters?: Record<string, string>;
    configDir?: string;
    /**
     * The app's global custom instructions as they stand right now. Snapshotted
     * onto the row below, so a later edit reaches the next chat and not this
     * one — see {@link Run.customInstructions} for why that is deliberate.
     */
    customInstructions?: string;
    /** The app's reply language as it stands now, snapshotted the same way. */
    replyLanguage?: string;
    /**
     * What the board card this chat works asks of it — its label instructions
     * and the report ask, already composed. Absent for every ordinary chat;
     * see {@link Run.taskInstructions} for why it is not joined into the
     * field above.
     */
    taskInstructions?: string;
    /**
     * The library team this chat edits, and what the agent is told about
     * its file — both absent for every chat outside the team builder's
     * panel. Composed by `TeamChatService`, which is the one place that
     * knows where the library keeps its files.
     */
    editsTeamSlug?: string;
    /** The project whose overlay of that team the chat edits beside it; with no team, the project this chat is the own chat of. */
    editsProjectId?: string | null;
    teamInstructions?: string;
    /**
     * The user's per-CLI switches, snapshotted like the instructions above;
     * an option absent from it reads as that option's declared default.
     */
    agentOptions?: AgentOptionsSnapshot;
    /**
     * A conversation this CLI already holds, taken over instead of started —
     * the new thread resumes it, and opens on the transcript it already had.
     */
    resumeSessionId?: string;
    /**
     * The board task this chat is the work for, or absent for every ordinary
     * chat. Set at creation because the settle path finds a task through it:
     * a run that learned its task later would have a window in which its own
     * terminal status could arrive with nothing to move.
     */
    taskId?: string;
    /**
     * That card's own identifier (`GEN-12`), passed in rather than looked up:
     * this module may not read the tasks module, and the caller holds both
     * halves of it already. See `Run.taskIdentifier`.
     */
    taskIdentifier?: string;
    /**
     * Which group to file this chat under, when the caller knows better than
     * the folder rule below.
     *
     * A board's run works in a WORKTREE, so the folder it runs in is one
     * nothing has ever been filed under — the auto rule would answer null for
     * every task run, while the project it belongs to names a group outright.
     * Explicit `null` files it loose; absent falls through to the rule.
     */
    groupId?: string | null;
    /**
     * The project this chat was started under by choice — a run
     * configuration's or the composer's pick: an id binds it, null means none,
     * absent leaves it to the card and the folder (`ProjectScopeService`).
     */
    projectId?: string | null;
    /**
     * The run this chat analyses and the seq its reads stop at — set only by
     * `ThreadAnalysisService.start`. See `Run.analysisSourceRunId`.
     */
    analysisSource?: { runId: string; seq: number; working: boolean };
    /**
     * The library team this chat analyses and the runs it reads — set
     * only by `ThreadAnalysisService.startTeam`. See
     * `Run.analysisTeamSlug`.
     */
    analysisTeam?: AnalysedTeam;
  }): Promise<RunWire> {
    const cwd = resolveValidCwd(input.cwd);
    this.assertApprovalSupported(input.agentKind, input.approval);
    this.assertEffortSupported(
      input.agentKind,
      input.effort ?? null,
      input.model ?? null,
      input.configDir ?? null,
    );
    // Canonicalized HERE, at the one moment the value is chosen, so the row
    // holds the path that was actually checked — the same contract `cwd` above
    // has. Each turn re-resolves it anyway (a directory can be deleted between
    // creation and a turn), which is what keeps a vanished profile from
    // reaching the child, where claude would CREATE it and report a login
    // failure about a directory nobody meant to name.
    const configDir = this.resolveConfigDir(input.agentKind, input.configDir);
    const scopeFacts = {
      taskId: input.taskId ?? null,
      cwd,
      projectId: input.projectId,
    };
    const placement = await this.projectScope.placeNewRun(scopeFacts);
    // Which sidebar group claims a chat opened in this folder. Resolved HERE
    // rather than by the caller so the rule holds for every chat the daemon
    // creates, and against the CANONICAL cwd above rather than the one the
    // request spelled — a group's folder is canonical too, so a symlinked path
    // matches the rule the user actually set.
    //
    // Checked against `undefined` rather than nullish: an explicit null is a
    // caller filing this chat loose, which the rule must not then overturn.
    const groupId =
      input.groupId !== undefined
        ? input.groupId
        : await this.groups.groupForNewRun({
            cwd,
            chosenProjectGroupId: placement.chosenProjectGroupId,
          });
    // BEFORE the run row exists. A CLI that has to bring the conversation
    // across can refuse (it was deleted, it is under another profile), and a
    // refusal must leave no half-made thread behind — the user gets the CLI's
    // own sentence instead of a chat whose first message dies on a session
    // nobody can find.
    if (input.resumeSessionId !== undefined) {
      await this.cliSessions.prepare(
        input.agentKind,
        input.resumeSessionId,
        cwd,
        configDir,
      );
    }
    const placed = placedFacts(scopeFacts, placement);
    const { indexIds, ...memory } = await this.memory.runSnapshot(placed);
    const knowledge = await this.knowledge.runSnapshot(placed);
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        teamId: null,
        status: 'pending',
        agentKind: input.agentKind,
        cwd,
        // The client's reading of the folder, taken a moment ago. Stored as
        // given: the daemon runs no git, so there is nothing here it could
        // check the pair against, and re-reading it later would answer about a
        // different moment than the one the chat began at.
        startSha: input.startSha ?? null,
        startDirty: input.startDirty ?? null,
        model: input.model ?? null,
        effort: input.effort ?? null,
        contextWindow: input.contextWindow ?? null,
        autoCompactPercent: input.autoCompactPercent ?? null,
        modelParameters: writeModelParameters(input.modelParameters),
        configDir,
        // Blank normalizes to null so "typed nothing" and "cleared the box"
        // are one state in the row, and the turn input below cannot hand an
        // adapter an empty string to compose around.
        customInstructions: input.customInstructions?.trim() || null,
        replyLanguage: input.replyLanguage?.trim() || null,
        projectId: placement.projectId,
        projectSource: placement.source,
        projectInstructions: placement.instructions,
        ...memory,
        ...knowledge,
        taskInstructions: input.taskInstructions?.trim() || null,
        editsTeamSlug: input.editsTeamSlug ?? null,
        editsProjectId: input.editsProjectId ?? null,
        teamInstructions: input.teamInstructions?.trim() || null,
        agentOptions: writeAgentOptions(input.agentOptions),
        groupId,
        taskId: input.taskId ?? null,
        taskIdentifier: input.taskIdentifier ?? null,
        analysisSourceRunId: input.analysisSource?.runId ?? null,
        analysisSourceSeq: input.analysisSource?.seq ?? null,
        analysisSourceWorking: input.analysisSource?.working ?? null,
        analysisTeamSlug: input.analysisTeam?.slug ?? null,
        analysisRuns:
          input.analysisTeam === undefined
            ? null
            : writeAnalysedRuns(input.analysisTeam.runs),
        title: input.title ?? null,
        // New chats always carry an explicit mode; only pre-selector rows
        // stay null.
        approval: this.initialApproval(input.agentKind, input.approval),
      },
      em,
    );
    // Announced as soon as the row is durable, ahead of `adoptSession`: a throw
    // there leaves this row behind, and it must still be announced.
    this.bus.publishRunCreated({
      runId: run.id,
      createdAt: run.createdAt.toISOString(),
    });
    await this.memory.countIndexShows(indexIds);
    if (input.resumeSessionId !== undefined) {
      await this.adoptSession(em, run.id, input, cwd, configDir);
      // The conversation's last turn ended in the user's terminal, so `pending`
      // would promise a first turn that does not exist. Announced, since a
      // window can adopt this run off an earlier broadcast before the POST
      // answers; as `restored` because the user picked it a moment ago, which
      // is no news; `noTerminalItem` because no terminal row stands behind it.
      await this.setRunStatus(em, run.id, 'completed', {
        restored: true,
        noTerminalItem: true,
      });
      run.status = 'completed';
    }
    return this.toRunWire(run, (await this.wireReads([run], em)).of(run.id));
  }

  /**
   * Bind a fresh run to a conversation the CLI already holds, and fill the
   * thread with what was said in it.
   *
   * The session id goes on `node_state` — the same row a live turn writes and
   * reads — so nothing about resuming has to know that this thread began as an
   * import: the next turn finds a session id where it always looks and passes
   * it as `resumeSessionId`.
   *
   * The notice is written FIRST, at the transcript's head, and its wording is
   * the service's. Everything after it is the imported conversation, written
   * through the same `mapEventToItem` a live turn's events pass through — so an
   * imported message and a message this app watched arrive are the same row,
   * which is the whole point of doing it this way rather than with a second
   * row builder.
   *
   * Awaited rather than backgrounded: the POST is what the picker is waiting
   * on, and a thread that opens empty and fills in a few seconds later is
   * indistinguishable from one that failed. It also keeps the ordering safe —
   * the user cannot send a message into a transcript that is still being
   * written.
   */
  private async adoptSession(
    em: EntityManager,
    runId: string,
    input: { agentKind: AgentKind; resumeSessionId?: string },
    cwd: string,
    configDir: string | null,
  ): Promise<void> {
    const sessionId = input.resumeSessionId;
    if (sessionId === undefined) {
      return;
    }
    await this.nodeStateDao.saveSessionId(
      runId,
      SINGLE_AGENT_NODE,
      sessionId,
      em,
    );
    const { events, notice } = await this.cliSessions.importHistory(
      input.agentKind,
      sessionId,
      cwd,
      configDir,
    );
    if (notice !== null) {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        // `severity: 'info'`, which is what keeps this out of the failure
        // chrome every other daemon-written notice earns. The rows this path
        // writes are the import REPORTING ITSELF — history left out, a record
        // that could not be read — not something going wrong, and dressing a
        // successful import in red is the exact complaint `isInfoNotice` was
        // added for.
        { message: notice, severity: 'info' },
      );
    }
    for (const event of events) {
      const item = mapEventToItem(event);
      if (item === null) {
        continue;
      }
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        item.kind,
        item.role,
        item.payload,
      );
    }
  }

  /**
   * PATCH /v1/chats/:runId/settings — change what the NEXT turn runs as: the
   * approval mode, the model, the reasoning effort, or any combination. 400
   * for a non-auto mode on a cursor chat or an effort level the run's CLI does
   * not accept.
   *
   * `model` and `effort` are accepted WHILE A TURN IS RUNNING, deliberately.
   * This route has only ever described the next turn: a running turn's argv was
   * fixed when it spawned and no adapter can mutate it in flight, so a 409
   * refused a write whose meaning was unchanged either way — it only made the
   * user wait to express a choice that was going to apply later regardless.
   *
   * `approval` is the EXCEPTION, and 409s exactly as it used to. It is the
   * app's only permission control: `auto` is what makes the daemon
   * auto-approve every tool request. Accepting the write unconditionally meant
   * a user could flip `auto → ask`, get a 200 and a chip reading `ask`, then
   * send — and the turn that claimed the run in the window before the write
   * committed would run fully auto-approved under a UI that said otherwise.
   * For the two cosmetic fields an ACK that the NEXT turn honours is the whole
   * promise; for this one, ACK has to mean applied.
   *
   * `model: null` / `effort: null` are real values — they clear the run back
   * to the CLI's own default (no `--model` / `--effort` flag), which an
   * omitted key cannot express.
   *
   * `configDir` is the second exception and refuses on the SAME terms as
   * `approval`, for a different reason: it is not a value the next turn merely
   * reads. Switching profiles carries the CLI's own conversation into the new
   * one and retires the run's live process, and both of those are wrong to do
   * underneath a turn that is writing into the old profile as they happen.
   *
   * `taskInstructions` is NOT on the HTTP route — `UpdateChatSettingsDto` does
   * not carry it. Its one caller is `TaskRunsService.resume`, which refreshes a
   * card's label block and report ask before continuing the card's thread; it
   * goes through here so every write to a chat's run row keeps one owner. Like
   * `model`, it only describes the NEXT turn, so it needs no busy refusal.
   */
  async updateSettings(
    runId: string,
    patch: {
      approval?: ChatApprovalMode;
      model?: string | null;
      effort?: string | null;
      contextWindow?: string | null;
      autoCompactPercent?: number | null;
      modelParameters?: Record<string, string> | null;
      configDir?: string | null;
      taskInstructions?: string | null;
    },
  ): Promise<RunWire> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    if (patch.approval !== undefined) {
      this.assertApprovalSupported(run.agentKind, patch.approval);
    }
    const profileMove =
      patch.configDir === undefined
        ? null
        : await this.moveToConfigDir(runId, run, patch.configDir, em);
    if (patch.effort !== undefined) {
      // The model this patch LEAVES the run on — its own if it is changing one,
      // otherwise the run's. Checking against the old model would refuse a level
      // that only the incoming one offers.
      this.assertEffortSupported(
        run.agentKind,
        patch.effort,
        patch.model !== undefined ? patch.model : run.model,
        // The profile this patch LEAVES the run on, for the reason the model
        // beside it takes its own: a switch in the same patch has already been
        // applied above, so `moved` is the newer answer where there is one.
        profileMove?.configDir ?? run.configDir,
      );
    }
    const changes = {
      ...(patch.approval !== undefined ? { approval: patch.approval } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      // A window size belongs to the MODEL that offered it, so a patch that
      // changes the model and says nothing about the window CLEARS it rather
      // than carrying it across: `1m` on a model with no such axis is
      // `-32602 Unknown model config option`, and `300k` on one whose sizes are
      // `272k|1m` is refused the same way. The user picks again from the new
      // model's own list, which is what the chip re-fetches anyway.
      ...(patch.contextWindow !== undefined
        ? { contextWindow: patch.contextWindow }
        : patch.model !== undefined
          ? { contextWindow: null }
          : {}),
      // …and the window MEASURED under the old choice goes with it. It is only
      // ever overwritten by a positive reading, and a model that has not yet
      // finished a turn on this machine reports none — so the new model's first
      // turn was drawn against the old model's window (`Context 175% full` after
      // moving a 350k conversation from a 1M model to a 200k one).
      ...((patch.model !== undefined && patch.model !== run.model) ||
      (patch.contextWindow !== undefined &&
        patch.contextWindow !== run.contextWindow)
        ? { contextWindowTokens: null }
        : {}),
      ...(patch.autoCompactPercent !== undefined
        ? { autoCompactPercent: patch.autoCompactPercent }
        : {}),
      // Cleared by a model change on exactly the window's own reasoning, and
      // more sharply: these axes belong to the model that enumerated them, and
      // one of them (`optimize_for`) exists on a single model of thirty-four —
      // so carrying a pick across a model switch sends a config option the new
      // model does not have, which is `-32602 Unknown model config option`.
      ...(patch.modelParameters !== undefined
        ? { modelParameters: writeModelParameters(patch.modelParameters) }
        : patch.model !== undefined
          ? { modelParameters: null }
          : {}),
      // A prompt cache is per ACCOUNT, so the expiry and lifetime the old
      // profile's turns reported go with it: the new account starts cold, and
      // its first turn reports its own.
      ...(profileMove === null
        ? {}
        : {
            configDir: profileMove.configDir,
            promptCacheExpiresAt: null,
            promptCacheTtlMs: null,
          }),
      // Blank normalizes to null, as at creation.
      ...(patch.taskInstructions !== undefined
        ? { taskInstructions: patch.taskInstructions?.trim() || null }
        : {}),
    };
    // Captured before the write: `updateById` mutates this same
    // identity-mapped entity, so `run.approval` is already the NEW value by the
    // time it returns — the revert below needs the old one.
    const previousApproval = run.approval;
    // A turn in flight no longer refuses the change — it is HANDED it. The CLI
    // accepts a `set_permission_mode` on a turn already running and re-reads it
    // within milliseconds (probe-verified on claude 2.1.222), which is what the
    // CLI itself does when the user switches mode mid-turn, so refusing here
    // was a limitation of this service rather than of the agent.
    //
    // Only the case that is still genuinely unhonourable refuses: a turn with
    // no permission dialogue to be told through. `applyLive` reports that as
    // false, and it is a fact about how the turn SPAWNED — under
    // `--dangerously-skip-permissions` there is no prompt tool, so no message
    // can reintroduce a gate the process was started without, and ACKing one
    // would state a safety posture the user does not have.
    let deliveredLive = false;
    if (patch.approval !== undefined && this.registry.has(runId)) {
      const applyLive = this.liveApproval.get(runId);
      deliveredLive = applyLive?.(patch.approval) === true;
      if (!deliveredLive) {
        throw new ConflictException(
          'RUN_BUSY',
          'this turn is running without a permission gate, so its approval mode cannot be changed until it settles',
        );
      }
    }
    if (patch.approval !== undefined) {
      // Also when NO turn is in flight, which is the whole point: the run's
      // process is still alive and can ask permission before the next turn
      // opens, and this is the only record of what to answer it with.
      this.runPosture.set(runId, patch.approval);
    }
    await this.runDao.updateById(runId, changes, em);
    // A turn may have claimed the run DURING the write — after the check above
    // but before the flush — and `sendMessage` snapshots the row in its own
    // fork, so that turn may already be spawning under the OLD mode. ACKing
    // here would tell the user a permission mode the in-flight turn will not
    // honour, so the approval half is reverted and refused. The model/effort
    // half of the same PATCH is left applied: it only ever described the next
    // turn, so nothing about it is untrue.
    //
    // Skipped once the change was delivered LIVE: the turn that made
    // `registry.has` true is the very one that just took the new mode, so
    // reverting here would undo a change already in effect and refuse a
    // request that succeeded.
    if (
      patch.approval !== undefined &&
      !deliveredLive &&
      this.registry.has(runId)
    ) {
      await this.runDao.updateById(runId, { approval: previousApproval }, em);
      throw new ConflictException(
        'RUN_BUSY',
        'a turn started while the approval change was in flight — retry once it settles',
      );
    }
    Object.assign(run, changes);
    if (profileMove !== null) {
      // AFTER the column is written, so a crash between the two leaves the run
      // on its old profile with no row claiming otherwise — and the row is
      // what the next turn reads. The transcript is where the user finds out
      // what a switch cost them, since nothing else on screen can say whether
      // the agent still remembers the conversation.
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        { message: profileMove.notice, severity: 'info' },
      );
    }
    const previews = await this.wireReads([run], em);
    return this.toRunWire(run, previews.of(runId));
  }

  /**
   * Point this thread's next turns at another account, taking the CLI's own
   * conversation with them.
   *
   * REPORTED as "I wanna have ability to dynamically change config directory
   * for current claude threads to have an ability continue thread with other
   * account" — and the second half is the hard half. geniro's transcript is
   * geniro's own and never moves; what a profile holds is the CLI's session
   * store, and `--resume <id>` under a profile that does not hold the file
   * answers "No conversation found" (probed on 2.1.237 across two real
   * accounts). So a switch that only rewrote the column would silently hand
   * the user an agent with amnesia, under a transcript still showing the
   * conversation it had forgotten.
   *
   * Three things happen, in an order that is load-bearing:
   *
   * 1. REFUSE while a turn is running. That turn is appending to the old
   *    profile's session file, so a copy taken now carries a conversation
   *    missing its last minutes, and retiring the process under it would kill
   *    work the user asked for. `model` and `effort` are accepted mid-turn
   *    because they only describe the NEXT one; this does more than describe.
   * 2. CARRY the conversation (`AgentAdapter.carrySessionToConfigDir`). A CLI
   *    that cannot declares that limitation. When it supports carrying but
   *    the copy fails, keep the previous profile and conversation for a retry.
   * 3. RETIRE the run's live process. It was spawned with the old profile in
   *    its env and can never be told otherwise, so leaving it would serve the
   *    next turn from the account the user just switched away from.
   */
  private async moveToConfigDir(
    runId: string,
    run: Run,
    requested: string | null,
    em: EntityManager,
  ): Promise<{ configDir: string | null; notice: string } | null> {
    const agentKind = run.agentKind;
    if (agentKind === null) {
      throw new BadRequestException(
        'CONFIG_DIR_UNSUPPORTED',
        'this run has no agent of its own to point at a profile',
      );
    }
    const adapter = this.adapterFor(agentKind);
    const unsupported = adapter.getConfig().configDir.unavailableReason;
    if (unsupported !== null) {
      throw new BadRequestException('CONFIG_DIR_UNSUPPORTED', unsupported);
    }
    const next = requested === null ? null : resolveValidConfigDir(requested);
    if (next === run.configDir) {
      // Not an error — a picker can re-choose what is already chosen — but
      // nothing should be copied, nothing retired and nothing announced.
      return null;
    }
    // BUSY is wider than "a turn is claimed", and the difference is a
    // SUB-AGENT. `ProcessRegistry` tracks TURNS, and a delegate routinely
    // outlives the one that launched it: an un-bracketed delegate goes on
    // producing rows after its turn's `result` line, which is exactly what
    // {@link leaseOnDelegateRow} exists to keep the badge honest about. In that
    // window the registry is empty while the run row reads `running` and a
    // delegate is alive INSIDE the process this switch would close — so a
    // registry-only guard would kill the sub-agent's work outright, and copy a
    // session file mid-append while it was at it. The run's own reading is the
    // authority, with the registry covering the window before a claimed turn
    // has written one and `heldRuns` covering a turn deferred for a BRACKETED
    // delegate.
    if (
      this.registry.has(runId) ||
      run.status === 'running' ||
      (this.heldRuns.get(runId) ?? 0) > 0
    ) {
      throw new ConflictException(
        'RUN_BUSY',
        'this thread is still working — switching account moves its conversation and restarts its agent, so wait until the turn and its sub-agents have finished',
      );
    }
    const node = await this.nodeStateDao.getByRunNode(
      runId,
      SINGLE_AGENT_NODE,
      em,
    );
    const sessionId = node?.agentSessionId ?? null;
    const carried =
      sessionId === null
        ? // Nothing has been said yet, so there is nothing to carry and no
          // caveat to print — this is the clean case, not a degraded one.
          { carried: true as const }
        : await adapter.carrySessionToConfigDir({
            sessionId,
            from: run.configDir,
            to: next,
          });
    if (
      !carried.carried &&
      adapter.getConfig().configDir.sessionCarryUnavailableReason === null
    ) {
      throw new ConflictException(
        'SESSION_CARRY_FAILED',
        `could not switch account without its conversation: ${carried.reason}`,
      );
    }
    this.sessions.close(runId, 'its account was switched');
    // Every reading this run is holding was taken from the OLD account, and a
    // profile is a whole different subscription: the kept metrics reading
    // carries that account's PLAN LIMITS, so serving it here reports one
    // account's plan under another's name — the same "different account plan"
    // this switch's own notice exists to prevent, reached from the other side.
    // Measured on the two profiles in front of me: `max` against `team`.
    await this.runDao.rememberMetricsReading(runId, null, em);
    if (!carried.carried) {
      // Only when the conversation did NOT come along. The count measures a
      // CONVERSATION, so it survives a move that brought one and is meaningless
      // after one that did not — exactly the rule `forgetContext` already
      // states for a compaction, which is the same event seen from inside.
      this.contexts.forgetTokens(runId);
      await this.runDao.forgetContext(runId, em);
    }
    const profile = next === null ? 'the default profile' : basename(next);
    const moved = carried.carried
      ? `Now running as ${profile} — its conversation came too.`
      : `Now running as ${profile} — fresh conversation from here (${carried.reason}).`;
    // NO override clause. This used to append "Overridden — this folder pins
    // <profile> in <file>", and the override it announced does not exist:
    // measured on claude 2.1.247 from a folder whose `.claude/settings.local
    // .json` carries `env.CLAUDE_CONFIG_DIR`, the variable geniro sets decided
    // the profile every time, and setting none loaded the CLI's default rather
    // than the folder's. So the sentence told a user their switch had not taken
    // effect when it had — the worst shape a notice can have, since it is
    // unfalsifiable from inside the app. Short on purpose besides: this is a
    // centred one-line transcript note.
    return { configDir: next, notice: moved };
  }

  /**
   * Refuse an approval mode the run's CLI does not honour.
   *
   * Asked of the adapter (`config.approval.modes`) rather than branched on the agent
   * kind, for the same reason as {@link assertEffortSupported}: which modes
   * exist is that CLI's fact. Refusing here — where the choice is made — is
   * deliberate and differs from a team member's visible degrade: a chat's
   * mode is picked interactively, so the honest answer is "no" rather than a
   * control that silently means something else.
   */
  private assertApprovalSupported(
    agentKind: AgentKind | null,
    approval: ChatApprovalMode | undefined,
  ): void {
    if (approval === undefined || agentKind === null) {
      return;
    }
    const adapter = this.adapterFor(agentKind);
    if (!adapter.getConfig().approval.modes.includes(approval)) {
      throw new BadRequestException(
        'APPROVAL_MODE_UNSUPPORTED',
        `${agentKind} does not support the approval mode '${approval}'`,
      );
    }
  }

  /**
   * A stored approval mode, kept only when the CLI offers it — what a caller
   * that did not just pick the mode (a board card, the builder's default)
   * sends, so a mode a CLI stopped offering falls back to the new-chat default
   * instead of refusing the run. A mode picked in a request is still refused
   * ({@link assertApprovalSupported}).
   */
  offeredApproval(
    kind: AgentKind,
    approval: ChatApprovalMode | null | undefined,
  ): ChatApprovalMode | undefined {
    if (approval === null || approval === undefined) {
      return undefined;
    }
    return this.adapterFor(kind).getConfig().approval.modes.includes(approval)
      ? approval
      : undefined;
  }

  /**
   * The mode a NEW chat starts in: what the user picked, else the app's
   * preferred default — narrowed to what that CLI actually honours.
   *
   * `auto` is the floor rather than a per-CLI default anyone has to declare:
   * running unattended is the one thing no CLI here can refuse, so a CLI
   * without a permission channel lands there by construction instead of by an
   * `if` naming it.
   */
  private initialApproval(
    kind: AgentKind,
    picked: ChatApprovalMode | undefined,
  ): ChatApprovalMode {
    if (picked !== undefined) {
      return picked;
    }
    const modes = this.adapterFor(kind).getConfig().approval.modes;
    return modes.includes(CHAT_DEFAULT_APPROVAL)
      ? CHAT_DEFAULT_APPROVAL
      : 'auto';
  }

  /** The adapter driving one agent kind — the single kind→adapter dispatch. */
  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * Refuse an effort level the run's CLI does not accept.
   *
   * Asked of the adapter rather than branched on the agent kind: the levels
   * are that CLI's vocabulary, and a CLI with none lists nothing — so the same
   * check both rejects `xhigh` on cursor (no effort control at all) and
   * `ultrathink` on claude (a value it warns about and ignores). Without it
   * the flag would reach the child and the turn would silently run at a
   * different effort than the one acknowledged.
   */
  private assertEffortSupported(
    agentKind: AgentKind | null,
    effort: string | null,
    /**
     * The model this run will actually use, when one is named. It is what makes
     * the refusal exact for a CLI whose levels belong to the model rather than
     * to the binary — see {@link EffortsService.accepts}, which consults only a
     * listing already held so this stays off the request's critical path.
     */
    model: string | null = null,
    /**
     * And the ACCOUNT, for the same reason: the levels a model offers belong to
     * the subscription, so the listing this consults is now held per profile.
     * Passing the run's own is what keeps the check exact instead of silently
     * reading another account's answer.
     */
    configDir: string | null = null,
  ): void {
    if (effort === null || agentKind === null) {
      return;
    }
    if (!this.efforts.accepts(agentKind, effort, model, configDir)) {
      throw new BadRequestException(
        'EFFORT_UNSUPPORTED',
        `${agentKind} does not accept the reasoning effort '${effort}'`,
      );
    }
  }

  /**
   * The canonical form of a chat's chosen config directory, or null when none
   * was chosen.
   *
   * REFUSES a CLI that has no such mechanism, rather than stripping the
   * field the way the team executor does for a team member. The two differ
   * because the choice does: a team can be imported from YAML naming a
   * config directory on a CLI the team editor never offered the field for, so
   * dropping it with a visible notice is the only way to run the team at all;
   * a chat's directory is picked interactively one control away from the agent
   * picker, so the honest answer is "no" — the same reasoning as
   * {@link assertApprovalSupported}.
   *
   * The adapter owns the verdict (`AdapterConfig.configDir.unavailableReason`),
   * so no agent is named here.
   */
  private resolveConfigDir(
    agentKind: AgentKind,
    configDir: string | undefined,
  ): string | null {
    if (configDir === undefined) {
      return null;
    }
    const reason =
      this.adapterFor(agentKind).getConfig().configDir.unavailableReason;
    if (reason !== null) {
      throw new BadRequestException('CONFIG_DIR_UNSUPPORTED', reason);
    }
    return resolveValidConfigDir(configDir);
  }

  /**
   * Forget the custom instructions every existing run snapshotted.
   *
   * The escape hatch the snapshot design otherwise lacks: a user who pasted
   * something they regret into the global box can clear it, but every chat
   * opened beforehand still carries the old text and would send it again on
   * its next turn. Nothing else purges that short of deleting the chat.
   *
   * Deliberately NOT wired to clearing the settings box — it discards a real
   * guarantee (a chat keeps what it started with), so it is an explicit action
   * with its own control, not a side effect of an edit the user might be
   * halfway through.
   *
   * A task run's `taskInstructions` are untouched: they are the card's, not
   * the user's standing text.
   */
  async forgetCustomInstructions(): Promise<{ cleared: number }> {
    const em = this.em.fork();
    const cleared = await this.runDao.forgetCustomInstructions(em);
    return { cleared };
  }

  /**
   * Permanently delete every chat shelved longer ago than `olderThanDays`.
   *
   * The archive is where a thread goes to stop cluttering the desk, and nothing
   * ever took anything out of it — so it grows for the life of the install, and
   * the one-way delete beside it is per-row. This is that delete, applied on a
   * clock the user sets.
   *
   * **It is the SAME one-way door**, not a gentler one: the full teardown per
   * run, so a swept run loses its rows, its attachments, its call tokens and
   * its kept session exactly as a pressed delete does, and `usage_events` survives for
   * the reason it survives there — a lifetime spend total must not shrink
   * because a conversation was tidied away. There is no trash and none is
   * planned, which is why the POLICY lives with the user (the retention window
   * is a setting they choose, and its absence means never) and only the
   * MECHANISM lives here.
   *
   * The window is measured from `archivedAt` — when the thread was shelved —
   * and never from `updatedAt` or `createdAt`. Those answer "when was this
   * conversation last touched", which is a different question: a chat from
   * February archived yesterday has been on the shelf for one day, and sweeping
   * it because the conversation is old would delete a thread the user filed
   * away this week.
   *
   * Runs are deleted ONE AT A TIME and a failure does not stop the sweep: each
   * teardown waits on that run's own in-flight work, and one run that cannot be
   * torn down (a turn that will not settle) must not strand every older chat
   * behind it. The count is what was actually destroyed, so a caller can tell a
   * partial sweep from a complete one.
   */
  async sweepArchived(olderThanDays: number): Promise<{ deleted: number }> {
    return this.sweepArchivedBefore(archivedCutoff(olderThanDays, new Date()));
  }

  /** The sweep from a cutoff already fixed; {@link sweepArchived} measures one from now. */
  async sweepArchivedBefore(cutoff: Date): Promise<{ deleted: number }> {
    const em = this.em.fork();
    const runs = await this.runDao.archivedRunsBefore(cutoff, em);
    let deleted = 0;
    for (const { id, teamId } of runs) {
      try {
        // Asked again, per run, right before its purge: the list above was read
        // once and each teardown before this one can take seconds, so a thread
        // the user UNARCHIVED meanwhile — or archived afresh, restarting its
        // window — was still destroyed off the stale list, its live turn
        // cancelled first. The shelf as it stands now is what the window is
        // about.
        const current = await this.runDao.getById(id, this.em.fork());
        if (
          current === null ||
          current.archivedAt === null ||
          current.archivedAt.getTime() > cutoff.getTime()
        ) {
          continue;
        }
        const result = await this.purgeArchived(id, teamId);
        if (result.deleted) {
          deleted += 1;
        }
      } catch (error) {
        // Logged and stepped over rather than thrown: this runs unattended, so
        // a throw here is a sweep that silently stops at its first bad row and
        // never reaches the rest — and the row it stopped on is the one nobody
        // is watching.
        this.logger.warn(
          `could not sweep archived run ${id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (deleted > 0) {
      this.logger.log(
        `deleted ${deleted} archived run(s) shelved at or before ${cutoff.toISOString()}`,
      );
    }
    return { deleted };
  }

  /**
   * Destroy one shelved run, whichever engine owned it.
   *
   * A chat goes through {@link delete}, which is that kind's whole delete.
   *
   * A team run goes STRAIGHT to the shared teardown, and cannot go through
   * `TeamExecutorService.deleteRun` for the module reason its cancel cannot
   * either — `TeamsModule` imports `AgentsModule`. What that service adds over
   * the teardown is two things, and both are answered here rather than skipped.
   * Its call-broker cleanup now happens on the `runDeleted` broadcast the purge
   * itself publishes, which is what that stream exists for (`CallBroker`
   * subscribes). And its `deleting` claim guards a WALK crossing its own
   * claim→register window — a race that needs a run about to start, while every
   * run this method sees has been shelved for days and had its work cancelled
   * when it was. The settle promise is the registry's, which both engines
   * share.
   *
   * This is the sweep's path alone. `DELETE /v1/chats/:runId` stays kind-guarded:
   * there the executor's route is right there to be used, and a run deleted
   * through the wrong one would skip the claim for no reason.
   */
  private async purgeArchived(
    runId: string,
    teamId: string | null,
  ): Promise<{ deleted: boolean }> {
    if (teamId === null) {
      return this.delete(runId);
    }
    return this.teardown.purge(
      this.em.fork(),
      runId,
      this.registry.settled(runId),
    );
  }

  /**
   * The chat opened to edit one library team, or null if there is none.
   *
   * Newest wins where several exist: nothing creates a second one, but a
   * builder opened in two windows at once could race {@link createChat}, and
   * answering the older row would strand the conversation the user is looking
   * at.
   */
  async findTeamChat(slug: string): Promise<RunWire | null> {
    const em = this.em.fork();
    const [run] = await this.runDao.listEditingTeam(slug, em);
    if (!run) {
      return null;
    }
    const previews = await this.wireReads([run], em);
    return this.toRunWire(run, previews.of(run.id));
  }

  /**
   * A library team's analysis, or null if it has none — newest wins, as
   * in {@link findAnalysis}, `prefer` included.
   */
  async findTeamAnalysis(
    slug: string,
    prefer?: string,
  ): Promise<RunWire | null> {
    const em = this.em.fork();
    const analyses = await this.runDao.listTeamAnalyses(slug, em);
    const run =
      analyses.find((analysis) => analysis.id === prefer) ?? analyses[0];
    if (!run) {
      return null;
    }
    const previews = await this.wireReads([run], em);
    return this.toRunWire(run, previews.of(run.id));
  }

  /**
   * A thread's analysis, or null if it has none — newest wins, for the reason
   * {@link findTeamChat} gives: two starts racing (two windows) leave two.
   * `prefer` is the caller's own, answered while it still exists, so the
   * start that loses the race opens what it started.
   */
  async findAnalysis(
    sourceRunId: string,
    prefer?: string,
  ): Promise<RunWire | null> {
    const em = this.em.fork();
    const analyses = await this.runDao.listAnalysesOf(sourceRunId, em);
    const run =
      analyses.find((analysis) => analysis.id === prefer) ?? analyses[0];
    if (!run) {
      return null;
    }
    const previews = await this.wireReads([run], em);
    return this.toRunWire(run, previews.of(run.id));
  }

  /**
   * Bring an open team chat's brief (`Run.teamInstructions`) up to
   * date with the one `TeamChatService` composes now.
   *
   * The brief is snapshotted at creation, so without this every builder chat
   * opened before an app update — or before its team was renamed — would
   * go on describing a format and a name that are no longer true, with no way
   * out short of discarding the conversation. Written only when the text
   * CHANGED: the brief is part of `AgentAdapter.sessionKey`, so a write
   * respawns the kept CLI process on the next turn (resuming the same
   * conversation), which an unchanged brief must not cost. Without touching
   * `updatedAt` — neither opening the panel nor a turn's re-brief is activity
   * in the thread.
   */
  /** Bind a builder chat to the project whose overlay it edits, or to the shared team alone. */
  async bindTeamChatProject(
    runId: string,
    projectId: string | null,
  ): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    if (run.editsProjectId === projectId) {
      return;
    }
    await this.runDao.updateWithoutActivity(
      runId,
      { editsProjectId: projectId },
      em,
    );
  }

  async refreshTeamInstructions(
    runId: string,
    instructions: string,
  ): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    // Normalized as at creation, so an unchanged brief compares equal.
    const next = instructions.trim() || null;
    if (run.teamInstructions === next) {
      return;
    }
    await this.runDao.updateWithoutActivity(
      runId,
      { teamInstructions: next },
      em,
    );
  }

  /**
   * Install where a team builder chat's brief is composed — installed rather
   * than injected because `TeamsModule`, which owns the library, depends on
   * this module.
   */
  useTeamBrief(
    source: (
      slug: string,
      cwd: string,
      projectId: string | null,
    ) => Promise<string>,
  ): void {
    this.teamBrief = source;
  }

  /**
   * Install what a project's own chat is briefed from — installed rather than
   * injected because `TeamsModule`, which knows overlays, depends on this
   * module.
   */
  useProjectChat(source: ProjectChatSource): void {
    this.projectChatSource = source;
  }

  /** A project's own chat, or null if it has none — newest wins, as in {@link findTeamChat}. */
  async findProjectChat(projectId: string): Promise<RunWire | null> {
    const em = this.em.fork();
    const [run] = await this.runDao.listEditingProject(projectId, em);
    if (!run) {
      return null;
    }
    const previews = await this.wireReads([run], em);
    return this.toRunWire(run, previews.of(run.id));
  }

  /** The projects that have an own chat — what the orphan sweep checks. */
  projectChatProjectIds(): Promise<string[]> {
    return this.runDao.projectChatProjectIds(this.em.fork());
  }

  /**
   * **Destructive and irreversible**: delete a project's own chats, answering
   * with the count — {@link deleteTeamChats}' terms.
   */
  async deleteProjectChats(projectId: string): Promise<{ deleted: number }> {
    const runs = await this.runDao.listEditingProject(
      projectId,
      this.em.fork(),
    );
    let deleted = 0;
    for (const run of runs) {
      try {
        if ((await this.delete(run.id)).deleted) {
          deleted += 1;
        }
      } catch (error) {
        this.logger.warn(
          `could not delete project chat ${run.id} for '${projectId}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { deleted };
  }

  /** Re-brief a project's chat from the project as it stands before each turn. */
  private async rebriefProjectChat(
    runId: string,
    projectId: string,
    cwd: string,
  ): Promise<void> {
    if (this.projectChatSource === null) {
      return;
    }
    try {
      await this.refreshTeamInstructions(
        runId,
        await this.projectChatSource.brief(projectId, cwd),
      );
    } catch (err) {
      this.logger.warn(
        `project chat ${runId} keeps its brief: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-brief a builder chat from its team as it stands before each turn, so a
   * chat created before a change to the brief's text (a renamed tool, a moved
   * library file) is not left pointing its agent at what no longer exists.
   */
  private async rebriefTeamChat(
    runId: string,
    slug: string,
    cwd: string,
    projectId: string | null,
  ): Promise<void> {
    if (this.teamBrief === null) {
      return;
    }
    try {
      await this.refreshTeamInstructions(
        runId,
        await this.teamBrief(slug, cwd, projectId),
      );
    } catch (err) {
      this.logger.warn(
        `team chat ${runId} keeps its brief: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * **Destructive and irreversible**: delete every chat opened to edit one
   * library team, answering with the count.
   *
   * Each goes through {@link delete}, so a live turn is cancelled and the
   * run's rows, attachments and call tokens go with it — these are chats, so
   * the team-run route is never the right one for them.
   *
   * A failure is logged and stepped over rather than thrown, on the archive
   * sweep's reasoning: both callers are doing something else as well (a
   * team delete, or the panel starting a fresh conversation), and one
   * unreadable row must not fail the thing the user actually pressed.
   */
  async deleteTeamChats(slug: string): Promise<{ deleted: number }> {
    const runs = await this.runDao.listEditingTeam(slug, this.em.fork());
    let deleted = 0;
    for (const run of runs) {
      try {
        const result = await this.delete(run.id);
        if (result.deleted) {
          deleted += 1;
        }
      } catch (error) {
        this.logger.warn(
          `could not delete team chat ${run.id} for '${slug}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return { deleted };
  }

  async listChats(
    scope: ChatListScope = 'active',
    page: RunListPage = {},
  ): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listChats(scope, em, page);
    // Incremental and error-swallowing by construction, so this is a `max(seq)`
    // read per run in the steady state and can never fail the listing.
    await this.pullRequests.sync(runs, em);
    const previews = await this.wireReads(runs, em);
    return runs.map((run) => this.toRunWire(run, previews.of(run.id)));
  }

  /**
   * Run-level rename shared by BOTH run kinds — the sidebar lists chat and
   * team runs together, so this route deliberately skips the chat-kind
   * guard the message/cancel routes apply: `title` is a run-row property,
   * not an execution command that must reach the right engine.
   */
  async rename(runId: string, title: string): Promise<RunWire> {
    return this.patchRunRow(runId, { title });
  }

  /**
   * Replace a thread's notes — the user's own text, never sent to the agent.
   * Kind-blind for {@link rename}'s reason, and written without bumping
   * `updatedAt` so jotting a note does not move the thread up the sidebar.
   * Blank (whitespace only) clears them, so a row can never carry a notes
   * marker over an empty preview.
   */
  async setNotes(runId: string, notes: string): Promise<RunWire> {
    return this.patchRunRow(runId, {
      notes: notes.trim() === '' ? null : notes,
    });
  }

  /**
   * A device OPENED this run — the clearing half of the unread mark.
   *
   * Stamps `Run.seenAt` with the daemon's own clock (so it compares against
   * `attentionAt` on one clock, whatever the phone's says) and announces it on
   * `run_status`, which is what takes the mark off every OTHER device too.
   * Kind-blind like {@link setNotes}: the sidebar marks team runs as well.
   * Written without bumping `updatedAt` — reading a thread is not activity in
   * it, and must not move it up the sidebar.
   */
  async markSeen(runId: string): Promise<RunSeenWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const seenAt = new Date().toISOString();
    await this.runDao.updateWithoutActivity(
      runId,
      { seenAt: new Date(seenAt) },
      em,
    );
    this.bus.publishRunStatus({ runId, status: null, seenAt });
    return {
      runId,
      attentionAt: run.attentionAt?.toISOString() ?? null,
      seenAt,
    };
  }

  /**
   * Write user-owned fields of the run ROW and tell every window — the shared
   * body of {@link rename} and {@link setNotes}. Without bumping `updatedAt`,
   * so editing a label never re-sorts the sidebar.
   */
  private async patchRunRow(
    runId: string,
    patch: Partial<Pick<Run, 'title' | 'notes'>>,
  ): Promise<RunWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    await this.runDao.updateWithoutActivity(runId, patch, em);
    Object.assign(run, patch);
    const previews = await this.wireReads([run], em);
    return this.announceRefiled(this.toRunWire(run, previews.of(runId)));
  }

  /**
   * Tint a run's sidebar row, or (null) clear the tint.
   *
   * Kind-blind for `rename`'s reason, and written without touching
   * `updatedAt` for the reason a pin is: recolouring a thread is not activity
   * in it, so it must not move the row up the sidebar.
   */
  async setColor(runId: string, color: RunGroupColor | null): Promise<RunWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    await this.runDao.updateWithoutActivity(runId, { color }, em);
    run.color = color;
    const previews = await this.wireReads([run], em);
    return this.announceRefiled(this.toRunWire(run, previews.of(runId)));
  }

  /**
   * File a run into a sidebar group, or (null) out of every group.
   *
   * Kind-blind for the same reason `rename` is: the sidebar lists chat and
   * team runs together and a group holds either, so this is a run-row
   * property rather than an execution command that has to reach the right
   * engine.
   *
   * The group is checked BEFORE the write. A dangling id would degrade
   * quietly — the sidebar files an unmatched run into the loose list, which
   * looks exactly like "nothing happened" — so the honest answer to a group
   * that does not exist is a 404, not a run that silently stayed put.
   */
  async setGroup(runId: string, groupId: string | null): Promise<RunWire> {
    if (groupId !== null) {
      await this.groups.assertExists(groupId);
    }
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    // A pinned run RE-FILED carries its pin into the new band, and cannot
    // carry its number: `pinnedPosition` is contiguous within a scope, so the
    // old number collides with whatever already holds that slot next door.
    // The two halves straddle the move deliberately — `repin` acts on the
    // scope the run NAMES, so the band it is leaving has to be closed while it
    // still names that one, and it can only join the new band once it does.
    const moving = run.pinnedPosition !== null && run.groupId !== groupId;
    const leaving = run.groupId;
    if (moving) {
      await this.runDao.repin(run, false, em);
    }
    await this.runDao.updateWithoutActivity(runId, { groupId }, em);
    run.groupId = groupId;
    if (moving) {
      await this.runDao.repin(run, true, em);
    }
    const previews = await this.wireReads([run], em);
    const answer = this.toRunWire(run, previews.of(runId));
    if (!moving) {
      return this.announceRefiled(answer);
    }
    await this.announceBands([leaving, groupId], [answer], em);
    return answer;
  }

  /**
   * Announce the rows this route changed together with every PINNED run in
   * the named bands, which a pin leaving or joining renumbers.
   *
   * The route's own answer names only the run it moved, while the renumbering
   * reaches every row of the band — and those writes deliberately do not touch
   * `updatedAt`, so nothing on the client could tell its stale copy from the
   * daemon's. REPORTED as a pinned thread jumping above the other pins the
   * moment it asked a question: archiving the second of five pins renumbered
   * three rows the sidebar never heard about, a later listing then mixed the
   * stale numbers with the fresh ones, two rows came to share a slot, and the
   * tie fell to the sidebar's needs-input tier.
   */
  private async announceBands(
    groupIds: readonly (string | null)[],
    changed: readonly RunWire[],
    em: EntityManager,
  ): Promise<void> {
    const named = new Set(changed.map((row) => row.id));
    const band: Run[] = [];
    for (const groupId of new Set(groupIds)) {
      for (const row of await this.runDao.pinnedInScope(groupId, em)) {
        if (!named.has(row.id)) {
          named.add(row.id);
          band.push(row);
        }
      }
    }
    const previews = await this.wireReads(band, em);
    this.announceRefiled([
      ...changed,
      ...band.map((row) => this.toRunWire(row, previews.of(row.id))),
    ]);
  }

  /**
   * Pin a run to the top of its own scope, or unpin it.
   *
   * Kind-blind like {@link setGroup} and {@link rename}, and for their reason:
   * the sidebar lists chats and team runs together, so this is a run-row
   * property rather than a command that has to reach the right engine.
   *
   * An ARCHIVED run is refused rather than pinned. The archive is the shelf a
   * thread goes to when it is done being on the desk, and the pinned band is
   * drawn at the top of the desk — pinning something that is not there would
   * be a state with no rendering, and {@link archive} clears the pin for the
   * same reason from the other direction.
   *
   * It answers with the whole SCOPE rather than the pressed run, which is the
   * one way this differs from {@link setGroup}: a pin renumbers the band it
   * joins and an unpin closes the gap behind it, so a client handed only the
   * row it pressed keeps a stale position for every other row in that band —
   * after which two of them can claim one slot, and the order the sidebar
   * draws is one neither side chose. The pressed run rides along even when it
   * has just left the band, since its cleared pin is what the caller pressed
   * for.
   */
  async setPinned(runId: string, pinned: boolean): Promise<RunWire[]> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    if (pinned && run.archivedAt !== null) {
      throw new BadRequestException(
        'RUN_ARCHIVED',
        `run ${runId} is archived — unarchive it before pinning`,
      );
    }
    await this.runDao.repin(run, pinned, em);
    const band = await this.runDao.pinnedInScope(run.groupId, em);
    const affected = band.some((row) => row.id === run.id)
      ? band
      : [...band, run];
    const previews = await this.wireReads(affected, em);
    return this.announceRefiled(
      affected.map((row) => this.toRunWire(row, previews.of(row.id))),
    );
  }

  /**
   * Rearrange ONE scope's pinned band, and answer with it.
   *
   * Takes the whole arrangement rather than "move this one up", exactly as
   * `RunGroupsService.reorder` does and for its reason: the band is reordered
   * by DRAGGING, where the gesture produces an arrangement rather than a
   * displacement — which also makes the write idempotent, where a relative
   * move replayed moves twice.
   *
   * A pinned run the client did not name is APPENDED in its current order
   * rather than dropped: the list is a snapshot of what one window could see,
   * and a thread pinned in another window (or by a request still in flight
   * when the drag started) must not lose its place because a stale client
   * failed to mention it. An id naming nothing pinned in THIS scope is
   * ignored for the same reason — a thread unpinned or re-filed mid-drag is
   * not a reason to refuse the arrangement, and it is also what keeps the
   * write inside one band when a client names a run from another.
   */
  async reorderPinned(
    groupId: string | null,
    ids: readonly string[],
  ): Promise<RunWire[]> {
    const em = this.em.fork();
    const band = await this.runDao.pinnedInScope(groupId, em);
    const byId = new Map(band.map((run) => [run.id, run]));
    const named = ids
      .map((id) => byId.get(id))
      .filter((run): run is Run => run !== undefined);
    const namedIds = new Set(named.map((run) => run.id));
    const ordered = [...named, ...band.filter((run) => !namedIds.has(run.id))];
    await this.runDao.applyPinnedOrder(ordered, em);
    const previews = await this.wireReads(ordered, em);
    return this.announceRefiled(
      ordered.map((run) => this.toRunWire(run, previews.of(run.id))),
    );
  }

  /**
   * Shelve a RUN out of the sidebar without destroying any part of it — a chat
   * or a team run alike.
   *
   * Kind-BLIND, like {@link rename} and {@link setGroup} and unlike
   * {@link cancel} and {@link delete}: `archivedAt` is a property of the run
   * ROW, and the sidebar that reads it lists both kinds together. It was
   * chat-only for a release, on the reading that the archive was a chat
   * feature — which left a finished team run with Delete as its only row
   * action, so the one kind of thread whose history is most worth keeping had
   * no way off the desk but destroying it. REPORTED as exactly that, against a
   * completed `Dev Team Manifest` row. Nothing about shelving is per-kind; only
   * how a RUNNING one is stopped is, and that is {@link stopForArchive}.
   *
   * The reversible half of what used to be a single one-way Delete: everything
   * the run owns — transcript, attachments, node state, call tokens — is left
   * exactly where it is, and {@link unarchive} puts the thread back. The purge
   * still exists and is still irreversible; it is reached from the archive.
   *
   * **Archiving a RUNNING chat cancels its turn first**, so a thread the user
   * has filed away cannot go on spending tokens out of sight. Ordered that way
   * deliberately: the cancel writes this run's terminal status through the
   * turn's own finalizer, and doing it after the mark would settle a run the
   * user had already shelved.
   *
   * The cancel is gated on `running` and NOT on `!isTerminalRunStatus`, which
   * looks like the more general test and is wrong: `pending` covers both a
   * chat whose turn is mid-claim AND one that never sent a message at all, and
   * `cancel()` would write the second a `cancelled` status and a
   * `turn_cancelled` row it never earned. The mid-claim case is answered by
   * {@link archiving} instead, which is the only mechanism that can see it —
   * and it is read by the CHAT turn path alone, so a team walk crossing its
   * own claim→register window can still register behind an archive. That window
   * is milliseconds at a run's very start, and the cost is a shelved run that
   * goes on working until it is cancelled by hand; closing it would mean this
   * service reaching into the executor's claim, which the module direction
   * forbids.
   *
   * The session is closed on EVERY archive, not only the running one. A kept
   * process is ~1GB of the machine's memory held so the next turn opens fast,
   * and a shelved conversation has no next turn until it comes back — at which
   * point it re-opens like any other cold chat.
   */
  async archive(runId: string): Promise<RunWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    // Claimed BEFORE the cancel, exactly as `delete` claims — see {@link archiving}.
    this.archiving.add(runId);
    this.commandEndWakes?.forgetRun(runId);
    try {
      if (run.status === 'running') {
        await this.stopForArchive(run);
      }
      // EVERY process of the run — its CLIs and what their agents left running
      // detached — so a shelved thread does not go on serving the dev servers
      // its agents started. The desk offers no delete, so for the user this
      // archive IS deleting the thread.
      this.teardown.endProcesses(runId);
      await this.retireStandingCard(runId);
      // An archived run refuses messages, so a verdict held for it would only
      // be refused at release.
      this.heldVerdicts.delete(runId);
      const archivedAt = new Date();
      // Shelving is not activity: the archive lists threads by when they were
      // last WORKED in, so this must not re-date the row to the moment it was
      // filed away (see `RunDao.updateWithoutActivity`).
      await this.runWrites.run(runId, () =>
        this.runDao.updateWithoutActivity(runId, { archivedAt }, em),
      );
      await this.threadInbox?.cancelFor(runId, 'archived');
      // Re-read rather than patch the entity in hand: the cancel above settles
      // this run through the turn's own finalizer, on a DIFFERENT fork, so the
      // row loaded before it still says `running` — and answering the archive
      // with a status the run no longer has is a lie the caller cannot detect.
      const fresh = (await this.runDao.getById(runId, em)) ?? run;
      fresh.archivedAt = archivedAt;
      // Shelving CLEARS the pin, and the band closes behind it. A pin is a
      // property of an OPEN thread — the band is drawn at the top of the desk
      // — so one kept across the archive would either hold a slot in a list it
      // is no longer drawn in, or come back months later in the middle of an
      // arrangement the user has since rebuilt. Unarchiving therefore returns
      // the thread unpinned, which is the state it is in while shelved rather
      // than a second rule.
      await this.runDao.repin(fresh, false, em);
      const answer = this.toRunWire(
        fresh,
        (await this.wireReads([fresh], em)).of(runId),
      );
      // The band the pin left was renumbered, and every OTHER client's copy of
      // it has to hear so — see {@link announceBands}.
      await this.announceBands([fresh.groupId], [answer], em);
      return answer;
    } finally {
      this.archiving.delete(runId);
    }
  }

  /**
   * Tell every OTHER client about the row(s) this route just re-filed, and
   * hand the same answer back to the one that asked.
   *
   * The pressing client re-files its row from the reply; nothing reached a
   * second window or the phone on the LAN gateway, so a thread archived there
   * stayed on the desktop's desk until the next full re-list (REPORTED as "I
   * deleted threads from mobile, but still can see it on PC"). Broadcast rather
   * than room-scoped, on `run_deleted`'s reasoning — see `AgentEventBus`.
   */
  private announceRefiled<T extends RunWire | RunWire[]>(answer: T): T {
    this.bus.publishRunsChanged(Array.isArray(answer) ? answer : [answer]);
    return answer;
  }

  /**
   * Stop a run that is being shelved, whichever engine owns it.
   *
   * A chat goes through {@link cancel}, which also RECONCILES a row left
   * `running` by a daemon that died mid-turn — nothing else writes a chat's
   * status, so without it a shelved thread would keep a spinner for good.
   *
   * A team run gets the registry cancel alone, which is the whole of
   * `TeamExecutorService.cancel` once its own kind guard has run: both engines
   * converge on ONE registry key. It cannot call that service — `TeamsModule`
   * imports `AgentsModule`, so the dependency points one way — and it does not
   * need to, because cancelling the aggregate handle runs the executor's own
   * teardown and revokes the run's call tokens; its kept processes are closed
   * by the archive's teardown, as the Stop's (`noteUserStop`, the mark
   * `TeamExecutorService.cancel` sets too). A team row left `running` by
   * a crash is that engine's boot reconcile to fix, and it does.
   */
  private async stopForArchive(run: Run): Promise<void> {
    if (run.teamId === null) {
      await this.cancel(run.id);
      return;
    }
    this.sessions.noteUserStop(run.id);
    this.registry.cancel(run.id);
  }

  /** Put an archived run back on the desk. Nothing else about it changed. */
  async unarchive(runId: string): Promise<RunWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    await this.runDao.updateWithoutActivity(runId, { archivedAt: null }, em);
    run.archivedAt = null;
    this.teardown.resumeProcesses(runId);
    const previews = await this.wireReads([run], em);
    return this.announceRefiled(this.toRunWire(run, previews.of(runId)));
  }

  async getHistory(
    runId: string,
    afterSeq = -1,
    window?: HistoryWindow,
    inCalls?: readonly string[],
  ): Promise<ItemWire[]> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (!run) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const items = await this.itemDao.getByRun(
      runId,
      afterSeq,
      em,
      window,
      inCalls,
    );
    return items.map(itemToWire);
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    // Kind-guarded like sendMessage: this cancel and the team executor's
    // converge on the same registry key, so a wrong-endpoint call must 400
    // instead of silently cancelling the other kind's run.
    let run = assertChatRun(await this.runDao.getById(runId, em), runId);
    // Ahead of every early return below: a Stop ends the thread's monitors
    // whether or not a turn was in flight, and wakes nobody — what they had
    // already printed is dropped too.
    this.monitors?.stopRun(runId, 'thread-stop');
    this.commandEndWakes?.forgetRun(runId);
    this.notify(this.stopListeners, runId, 'stop');
    const cancelled = this.registry.cancel(runId);
    if (cancelled) {
      // Remembered for the turn's own terminal event, so this Stop still reads
      // as the user's if the daemon begins shutting down before that event is
      // handled — see {@link stopsRequested}.
      this.stopsRequested.add(runId);
      this.closeStoppedSession(runId);
      // A live turn owns the run: its finalizer writes the terminal status
      // when the handle settles, and writing one here would race it.
      return { cancelled };
    }
    // No HANDLE is in flight — which is not the same as no TURN. The registry
    // drops a turn the moment its handle settles, and `spawn-cli` settles the
    // handle as soon as it has handed the terminal event to this turn's
    // persist queue, so the `turn_complete` row and its `completed` status can
    // still be queued behind the finalizer. A Stop landing in that window read
    // `running` off the row and wrote `cancelled with no turn in flight` over a
    // turn that had just COMPLETED. So wait for the finalizer, then ask again.
    const finalizing = this.finalizing.get(runId);
    if (finalizing) {
      await finalizing;
      // A turn that started meanwhile (a queued message sent on the settle)
      // owns the run now, and is not the one this Stop was pressed at.
      if (this.registry.has(runId)) {
        return { cancelled };
      }
      // A FRESH fork: the one above holds the stale row in its identity map,
      // and a primary-key read would hand that back without asking the DB.
      run = assertChatRun(
        await this.runDao.getById(runId, this.em.fork()),
        runId,
      );
    }
    // A kept process can be running a continuation with no registered turn,
    // or waiting for a delegate to wake it. Stop must end that work too.
    this.closeStoppedSession(runId);
    const writingStatus = this.statusWrites.get(runId);
    if (writingStatus) {
      // An off-turn write can already be in the database when Stop closes
      // its process. Drain it before deciding which status needs cancelling.
      await writingStatus.catch(() => undefined);
      if (this.registry.has(runId)) {
        return { cancelled };
      }
      run = assertChatRun(
        await this.runDao.getById(runId, this.em.fork()),
        runId,
      );
    }
    // NOTHING was in flight. Before, this returned false and wrote nothing —
    // so a run whose row still said `running` (a daemon killed mid-turn, a
    // handle that vanished) stayed "running" forever with no turn left to
    // settle it, and its badge lied in every list that showed it. Cancel is
    // the user saying "this is over": make the row say so.
    if (!isTerminalRunStatus(run.status)) {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'turn_cancelled',
        null,
        { reason: 'cancelled with no turn in flight' },
      );
      await this.setRunStatus(em, runId, 'cancelled');
      this.logger.warn(
        `cancel found no live turn for run ${runId} — reconciled its status from '${run.status}' to cancelled`,
      );
    }
    return { cancelled };
  }

  private closeStoppedSession(runId: string): void {
    // The session-close listener normally restores an off-turn badge to its
    // previous status. A user's Stop owns this settle instead: restoring an
    // earlier `completed` would overwrite the cancellation.
    this.clearDelegateLease(runId);
    this.offTurnRuns.delete(runId);
    this.offTurnSignalClaims.delete(runId);
    this.partials.retire(runId, SINGLE_AGENT_NODE, null);
    this.sessions.close(runId, 'its turn was stopped', 'user-stop');
  }

  private ownsSession(runId: string, session: AgentSession | null): boolean {
    return session !== null && this.sessions.peek(runId) === session;
  }

  /**
   * Delete a chat and everything it owns — a ONE-WAY DOOR. The teardown itself
   * is {@link RunTeardownService}, shared with the team-run delete so the
   * two cannot drift; what this method owns is the chat-specific part: the
   * run-kind guard, the claim→register window, and WHICH promise counts as
   * "the run has stopped writing" (this turn's finalizer, not its handle).
   */
  async delete(runId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    // Kind-guarded like cancel and sendMessage: a team run deleted through
    // the chat route would skip the team executor's own teardown.
    assertChatRun(await this.runDao.getById(runId, em), runId);

    // Claimed BEFORE the cancel, so a turn still crossing the claim→register
    // window (where it has no finalizer to wait on) sees the delete and aborts
    // rather than registering behind our back.
    this.deleting.add(runId);
    this.commandEndWakes?.forgetRun(runId);
    try {
      return await this.teardown.purge(em, runId, this.finalizing.get(runId));
    } finally {
      this.deleting.delete(runId);
      this.cardIdsByRun.delete(runId);
      // A DEFERRED question card is the one registry entry no settle sweeps,
      // so the delete is what retires it. Nothing is written for it, unlike
      // every other sweep's obligation: the transcript it would be written
      // into has just been destroyed.
      this.approvals.sweepDeferred(runId);
      this.heldVerdicts.delete(runId);
      this.offTurnToolCalls.delete(runId);
      this.holds.forget(runId);
      // The run is gone, so its posture has nothing left to govern — and the
      // teardown has already closed the process that would have consulted it.
      this.runPosture.delete(runId);
      // The ONE place this is cleared. A shell deliberately outlives its turn,
      // so neither the settle finalizer nor the next turn may drop it the way
      // `heldRuns` and `closedDelegates` are dropped — the whole point of the
      // map is that a detached command is still out after the turn ended. A
      // deleted run is the only state in which nothing can be waiting on it.
      // The delegate twin rides the same call, on the identical rule: a
      // background sub-agent outlives its turn by construction.
      this.backgroundWork.forget(runId);
      // Same rule, same one place: nothing can read a deleted run's context.
      this.contexts.forget(runId);
      this.compactionBaselines.delete(runId);
      // Nor send a notification about it.
      this.dropKeptHostTools(runId);
    }
  }

  /**
   * Which card each CLI request is shown as, per run — the protocol id a CLI
   * WITHDRAWS a request by is not the card id the registry and the transcript
   * know it by (`ApprovalRegistry.mintCardId`). Only the newest card per
   * protocol id is kept, which is the one a withdrawal can be about: an older
   * one was answered or swept before its id could be reused.
   */
  private readonly cardIdsByRun = new Map<string, Map<string, string>>();

  /**
   * Cards whose row is still being written, so not yet in the registry — an
   * in-turn card and a held one can be raised at once, and the prune must not
   * read either as closed.
   */
  private readonly raisingCards = new Set<string>();

  /**
   * Cards whose request the CLI withdrew while their row was still being
   * written. The withdrawal finds no registry entry to retire yet, so it leaves
   * the id here and the raiser closes the card instead of tracking it — tracked,
   * it would stand open for a request nobody can deliver a verdict to.
   */
  private readonly withdrawnWhileRaising = new Set<string>();

  /**
   * End a card's filing. Answers true when its request was withdrawn meanwhile,
   * having written the `unanswerable` row that turns its buttons off, and the
   * raiser must then not track it.
   */
  /** Forget a card whose row could not be written — it will never be filed. */
  private abandonRaising(cardId: string): void {
    this.raisingCards.delete(cardId);
    this.withdrawnWhileRaising.delete(cardId);
  }

  private async finishRaising(
    runId: string,
    cardId: string,
    toolName: string,
  ): Promise<boolean> {
    this.raisingCards.delete(cardId);
    if (!this.withdrawnWhileRaising.delete(cardId)) {
      return false;
    }
    try {
      await this.persist(
        this.em.fork(),
        runId,
        await this.seqs.reserve(runId),
        'unanswerable',
        null,
        { id: cardId, toolName },
      );
    } catch (err) {
      this.logger.error(
        `run ${runId} could not close withdrawn card ${cardId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return true;
  }

  /**
   * Record a card, first forgetting the run's closed ones: pruned on every
   * write, the map holds a run's open cards and the ones being filed, however
   * its turns ended. Ends with the card marked as being filed — its raiser
   * clears that once the card is in the registry or refused.
   */
  private rememberCardId(
    runId: string,
    protocolId: string,
    cardId: string,
  ): void {
    this.forgetClosedCards(runId);
    const cards = this.cardIdsByRun.get(runId) ?? new Map<string, string>();
    cards.set(protocolId, cardId);
    this.cardIdsByRun.set(runId, cards);
    this.raisingCards.add(cardId);
  }

  /**
   * Forget the cards of `runId` that are no longer open — a withdrawal can only
   * be about an open one. A card still being filed is kept.
   */
  private forgetClosedCards(runId: string): void {
    const cards = this.cardIdsByRun.get(runId);
    if (cards === undefined) {
      return;
    }
    const open = new Set(
      this.approvals.listByRun(runId).map((card) => card.requestId),
    );
    for (const [protocolId, cardId] of cards) {
      if (!open.has(cardId) && !this.raisingCards.has(cardId)) {
        cards.delete(protocolId);
      }
    }
    if (cards.size === 0) {
      this.cardIdsByRun.delete(runId);
    }
  }

  /**
   * Close the card for a request its CLI took back: drop it from the registry
   * without a verdict (there is nobody left to deliver one to), write the
   * `unanswerable` row that turns its buttons off, and say the run is no longer
   * waiting on the user. A request with no card — auto-approved, or already
   * answered — needs nothing.
   */
  private async retireWithdrawnCard(
    runId: string,
    protocolId: string,
  ): Promise<void> {
    const cards = this.cardIdsByRun.get(runId);
    const cardId = cards?.get(protocolId);
    if (cardId === undefined) {
      return;
    }
    cards?.delete(protocolId);
    if (cards?.size === 0) {
      this.cardIdsByRun.delete(runId);
    }
    const approval = this.approvals.abandon(runId, cardId);
    if (approval === null) {
      // Still being filed: its raiser closes it once the row is written.
      if (this.raisingCards.has(cardId)) {
        this.withdrawnWhileRaising.add(cardId);
      }
      return;
    }
    this.announceAwaiting(runId);
    await this.persist(
      this.em.fork(),
      runId,
      await this.seqs.reserve(runId),
      'unanswerable',
      null,
      unanswerablePayload(approval),
    );
  }

  /**
   * Put a request that arrived with NO turn in flight in front of the user, as
   * the same card an in-turn one gets.
   *
   * The path this replaces is what a whole run was lost to. claude's process
   * outlives its turn and goes on working (`handleBetweenTurnEvent`), and eight
   * minutes after a turn had settled it asked an `AskUserQuestion`. With no turn
   * to raise a card, the session HELD it for a later turn to adopt — so the
   * transcript grew the tool-call row, the badge went on saying the agent was
   * working, and nothing anywhere offered a way to answer. Twenty-two minutes
   * later the idle window closed the process, the CLI read the close as a
   * refusal, and the user was shown a bare `claude run failed` for a question
   * they had never seen. Both halves are fixed: this raises the card, and the
   * session reports itself `parked` so the reaper leaves it alone.
   *
   * SYNCHRONOUS by contract — the session needs an immediate yes/no about who
   * owns the request — so the writes ride a floating promise. The claim is
   * therefore optimistic, and the one way it can be wrong is handled the way
   * the in-turn branch handles it: if the card cannot be persisted the user will
   * never see it, so the CLI is refused rather than left blocked forever.
   */
  private raiseHeldApproval(
    runId: string,
    adapter: AgentAdapter,
    event: Extract<AgentEvent, { type: 'approval_request' }>,
    respond: (
      allow: boolean,
      input?: unknown,
      option?: ApprovalOption,
    ) => boolean,
  ): boolean {
    const mapped = mapEventToItem(event);
    if (!mapped) {
      return false;
    }
    const isQuestion = isUserQuestion(
      adapter.getConfig().questionToolName,
      event.toolName,
    );
    // A card id, never `event.id` — the in-turn branch states why.
    const cardId = this.approvals.mintCardId(event.id);
    this.rememberCardId(runId, event.id, cardId);
    void (async () => {
      const em = this.em.fork();
      try {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          mapped.kind,
          mapped.role,
          {
            ...mapped.payload,
            id: cardId,
            ...(await threadCardFields(
              this.runDao,
              em,
              hostMcpServerName(runId),
              event.toolName,
              event.input,
            )),
          },
        );
      } catch (err) {
        this.abandonRaising(cardId);
        respond(false);
        this.logger.error(
          `run ${runId} could not persist a between-turn card for '${event.toolName}' — refused it instead: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
      if (await this.finishRaising(runId, cardId, event.toolName)) {
        return;
      }
      this.approvals.track({
        runId,
        memberId: SINGLE_AGENT_NODE,
        requestId: cardId,
        toolName: event.toolName,
        input: event.input,
        question: isQuestion,
        respond: (allow, answer, optionId) => {
          const { delivered, record } = deliverApprovalAnswer(
            adapter,
            event,
            allow,
            answer,
            // Arity-preserving, as `ApprovalRegistry.resolve` is: a one-time
            // verdict keeps the two-argument call it always made.
            (input, option) =>
              option === undefined
                ? respond(allow, input)
                : respond(allow, input, option),
            optionId,
          );
          this.announceAwaiting(runId);
          // Answering IS acting in this thread, and the sidebar orders by the
          // row — see `noteUserActivity` for the jump this stops.
          void this.noteUserActivity(runId);
          if (delivered) {
            void (async () => {
              await this.persist(
                em,
                runId,
                await this.seqs.reserve(runId),
                'approval_verdict',
                null,
                {
                  id: cardId,
                  allow,
                  ...record,
                },
              );
            })().catch((err: unknown) => {
              this.logger.error(
                `run ${runId} between-turn verdict item write failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
          }
          return delivered;
        },
      });
      // After the track, so the registry this reads already holds the card —
      // exactly as the in-turn branch orders it. Without this the badge keeps
      // announcing whatever the CLI was last doing, which is the half of the
      // report that read as "it says it is working while it waits for me".
      this.announceAwaiting(runId);
    })();
    return true;
  }

  /**
   * Everything the CLI produces with no turn of ours in flight.
   *
   * **This is a whole conversation, not a stray line.** After a turn's `result`
   * the CLI can start a further turn of its own accord — a delegate reporting
   * back is the measured cause, and its result line names itself
   * `origin:{kind:"task-notification"}`. `spawn-cli` has no turn to hand that
   * output to, so it arrives here.
   *
   * It used to be filtered down to the two halves of a tool call, on the
   * argument that those carry an id that pairs them while a stray message has
   * no anchor. The pairing half of that is right and is kept; the conclusion
   * was not. Measured on a live delegating chat (2026-08-14, claude 2.1.232):
   * seven seconds after the turn settled the CLI ran a whole further turn, and
   * this method dropped 2 `text` events, 5 `text_delta`, 2 `turn_complete`, a
   * `session`, and every progress and harvest event with them — keeping only
   * the tool call and its result. What the user saw is exactly what was
   * reported: a run badged `completed` with more work appearing under it, and
   * the agent's own messages after that point simply not arriving. Dropping an
   * event because geniro has no turn to file it under is geniro's bookkeeping
   * problem being charged to the user's transcript.
   *
   * So the rule is now the same one the in-turn path uses — whatever
   * `mapEventToItem` yields a row for is persisted, in arrival order, under
   * this run — plus the three things that are not rows: the live signals feed
   * the same partial stream, the self-reports feed the same harvest stores, and
   * a terminal event settles the run again.
   *
   * **The one thing that does NOT follow the in-turn path is the run status
   * after a Stop.** A cancelled run's trailing output is still recorded (the
   * work happened, and hiding it is how a transcript starts lying), but it must
   * not move the badge: the user asked this to stop, and a straggling `result`
   * flipping `cancelled` back to `completed` is the defect that first put a
   * filter here.
   *
   * Run-scoped by construction — its own `em` fork and the run's seq
   * allocator, nothing borrowed from a turn that has already settled. Failure
   * is logged and swallowed: this is called from the session's event path,
   * where a throw has no caller to reach.
   */
  /**
   * Add what a stretch the CLI ran by itself worked to the run's totals —
   * `Run.workedMs` and `toolCalls`, which the in-turn closure adds for a turn
   * of ours. Its main-thread tool calls are counted as they arrive and added
   * with its ending, whatever that ending is; only a completion carries a
   * duration.
   */
  private async countOffTurnWork(
    runId: string,
    event: AgentEvent,
  ): Promise<void> {
    if (event.type === 'tool_call' && event.parentToolUseId === undefined) {
      this.offTurnToolCalls.set(
        runId,
        (this.offTurnToolCalls.get(runId) ?? 0) + 1,
      );
      return;
    }
    if (terminalStatus(event) === null) {
      return;
    }
    const toolCalls = this.offTurnToolCalls.get(runId) ?? 0;
    this.offTurnToolCalls.delete(runId);
    const workedMs =
      event.type === 'turn_complete' ? (event.usage?.durationMs ?? null) : null;
    // Awaited, unlike the in-turn write: the ending's settle announce, a few
    // lines on, reads the totals back.
    await this.runDao.rememberWork(runId, workedMs, toolCalls).catch(() => {});
  }

  private async handleBetweenTurnEvent(
    runId: string,
    agent: AgentKind,
    cwd: string,
    /** The profile the turn ran under — see the `mcp_servers` arm below. */
    configDir: string | null,
    event: AgentEvent,
    session: AgentSession | null,
  ): Promise<void> {
    // A dying process can still flush stdout. Keep durable rows, but it no
    // longer owns the live plane or the badge of the run's next session.
    if (
      !this.ownsSession(runId, session) &&
      [
        'text_delta',
        'thinking_progress',
        'reasoning_delta',
        'tool_compose',
        'usage_progress',
        'cost_progress',
        'context_progress',
      ].includes(event.type)
    ) {
      return;
    }
    // The in-turn hold's twin, for a stretch the CLI opened by itself: the
    // agent has stopped and waits on sub-agents it launched there. It maps to
    // no row, so it is read ahead of the row gate.
    if (event.type === 'turn_held') {
      if (this.ownsSession(runId, session)) {
        this.announceRunHold(
          runId,
          event.open,
          heldActivity(event.open, event.unit),
        );
      }
      return;
    }
    if (event.type === 'off_turn_started') {
      if (this.ownsSession(runId, session)) {
        this.holds.startStretch(runId, event.at);
      }
      return;
    }
    await this.countOffTurnWork(runId, event);
    // A continuation the CLI ran by itself made requests too, so the cache was
    // re-warmed by it. Awaited ahead of everything below, which is where the
    // continuation's own terminal settles the run and announces the expiry.
    if (event.type === 'turn_complete') {
      await this.rememberPromptCache(runId, event.usage);
    }
    // Live-only signals: no row, no seq, no replay — the same treatment the
    // in-turn handler gives them. Without these the transcript grows rows with
    // no live row above them, which is the "it says completed while it works"
    // half of the report seen from the other side.
    if (event.type === 'text_delta') {
      if (event.parentToolUseId === undefined) {
        this.partials.append(runId, SINGLE_AGENT_NODE, null, event.text);
        await this.restatusAfterOffTurnSignal(runId, event, session);
      }
      return;
    }
    if (event.type === 'thinking_progress') {
      if (event.parentToolUseId === undefined) {
        this.partials.thinking(runId, SINGLE_AGENT_NODE, null, event.tokens);
        await this.restatusAfterOffTurnSignal(runId, event, session);
      }
      return;
    }
    if (event.type === 'reasoning_delta') {
      if (event.parentToolUseId === undefined) {
        this.partials.reasoning(runId, SINGLE_AGENT_NODE, null, event.text);
        await this.restatusAfterOffTurnSignal(runId, event, session);
      }
      return;
    }
    if (event.type === 'tool_compose') {
      // The mapper already excludes a delegate's stream, so there is no
      // `parentToolUseId` guard to repeat here — the frame either describes the
      // main thread or was never produced.
      this.partials.composing(runId, SINGLE_AGENT_NODE, null, event);
      await this.restatusAfterOffTurnSignal(runId, event, session);
      return;
    }
    if (event.type === 'usage_progress') {
      // The live half of what the turn is COSTING. No durable twin beside it,
      // unlike `context_progress` below: the turn's own `turn_complete` usage
      // already carries these four counts for the whole turn, so filing them
      // per request would be the same money written down twice.
      this.partials.spend(runId, SINGLE_AGENT_NODE, null, event);
      return;
    }
    if (event.type === 'cost_progress') {
      // What a continuation the CLI opened by itself has spent so far — the
      // same live figure the in-turn site publishes, and ephemeral for the
      // same reason: its `result` line zeroes it as it writes the durable row.
      this.partials.cost(
        runId,
        SINGLE_AGENT_NODE,
        null,
        event.costUsd,
        event.estimatedCostUsd ?? null,
      );
      return;
    }
    if (event.type === 'context_progress') {
      this.partials.context(
        runId,
        SINGLE_AGENT_NODE,
        null,
        event.contextTokens,
      );
      await this.rememberContext(runId, SINGLE_AGENT_NODE, {
        contextTokens: event.contextTokens,
        contextWindowTokens: this.partials.isOwnReading(
          runId,
          SINGLE_AGENT_NODE,
          event.contextModel ?? null,
        )
          ? (event.contextWindowTokens ?? null)
          : null,
      });
      return;
    }
    // What the CLI reports about ITSELF is true whether or not a turn of ours
    // is open, and each of these feeds a panel rather than the transcript.
    if (event.type === 'slash_commands') {
      // The turn's own profile, exactly as the MCP arm below takes it: a CLI
      // answers for the plugins installed in the config directory it is
      // running under, so a chat on a profile reports a different set.
      this.skillHarvest.record(agent, cwd, configDir, event.commands);
      return;
    }
    if (event.type === 'mcp_servers') {
      // The turn's own profile, for the reason spelled out at the in-turn twin
      // of this arm: a chat carries one now, and filing it under the default
      // account's key both starves the profile's panel and poisons the default
      // one with another subscription's servers.
      this.mcpHarvest.record(agent, cwd, configDir, event.servers);
      this.noteMcpMismatch(runId, agent, cwd, configDir, event.servers);
      return;
    }
    if (event.type === 'session') {
      // The continuation runs in the same conversation, so this is the id a
      // later resume has to reach. Dropping it left the run resuming a session
      // that no longer had the last of its history. Written straight through
      // rather than through the turn's changed-only saver, which belongs to a
      // turn that no longer exists — the id repeats at most once per off-turn
      // continuation, so the dedupe it provides is not worth the coupling.
      await this.nodeStateDao.saveSessionId(
        runId,
        SINGLE_AGENT_NODE,
        event.sessionId,
        this.em.fork(),
      );
      return;
    }
    // A between-turn card the CLI took back — see the in-turn twin.
    if (event.type === 'approval_withdrawn') {
      await this.retireWithdrawnCard(runId, event.id);
      return;
    }
    // Above the row gate: it maps to no row, and it ends the stretch the late
    // calls' rows opened below.
    if (endsOffTurnStretch(event)) {
      await this.settleLateWork(runId, session);
      return;
    }
    // ABOVE the row gate, like the in-turn twin: a `shell_open` yields no row,
    // so a launch recorded below this line would be dropped and the count would
    // only ever go down.
    this.recordShellBracket(runId, event);
    if (
      event.type === 'shell_info' &&
      event.ending !== undefined &&
      !this.deleting.has(runId) &&
      !this.archiving.has(runId) &&
      this.adapters.for(agent).getConfig().shells.lateEndWakeReason !== null
    ) {
      this.commandEndWakes?.ended(
        chatWakeOwner(runId),
        event.workId,
        event.ending,
        () => this.registry.has(runId),
      );
    }
    const kept =
      event.type === 'follow_up_dropped'
        ? await this.withoutReturnedMessages(runId, event)
        : event;
    const mapped = kept === null ? null : mapEventToItem(kept);
    // Taken synchronously, before any await, so the pairing follows the order
    // events ARRIVED in rather than the order their writes finish.
    const compactions =
      this.offTurnCompactions.get(runId) ?? new CompactionRows();
    const compactionRows = compactions.rowsBefore(event, mapped);
    if (compactions.holding) {
      this.offTurnCompactions.set(runId, compactions);
    } else {
      this.offTurnCompactions.delete(runId);
    }
    if (!mapped && compactionRows.length === 0) {
      // No row and no live meaning — `background_work` bookkeeping for a turn
      // that no longer exists is the standing example.
      return;
    }
    try {
      const em = this.em.fork();
      for (const row of compactionRows) {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          row.kind,
          row.role,
          row.payload,
        );
      }
      if (!mapped) {
        return;
      }
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        mapped.kind,
        mapped.role,
        mapped.payload,
      );
      // Main thread only, exactly as in the in-turn path above: the tail holds
      // the main agent's words, so a delegate's durable message must not take
      // them away.
      if (mapped.kind === 'message' && event.parentToolUseId === undefined) {
        this.partials.retire(runId, SINGLE_AGENT_NODE, null);
      }
      // The ROW is written whatever produced it — a transcript that hides work
      // is the other way of lying. What the RUN is doing is a different
      // question, and a DELEGATE's row does not answer it.
      //
      // A delegate is the background work the turn was already held for, and
      // its trailing rows land as it finishes. Restating them as the run
      // working again put a `still working` spinner on screen at the exact
      // moment the work ENDED — and nothing could ever take it down, because
      // only a terminal event settles this state and a delegate winding up
      // opens no turn of its own to produce one. Reproduced: the delegate's
      // block reads `done`, the turn reads `✓ done`, and the row under them
      // counts upward for as long as the chat is open. That is the reported
      // "the agent seems to have finished working, but its status didn't
      // change — it's still writing still working".
      //
      // A delegate still working is not lost by this: the renderer derives it
      // from the transcript (`subagentRunning`), which closes by itself when
      // the delegate's block returns. The CLI genuinely carrying on — a
      // task-notification continuation — writes MAIN-THREAD rows and still
      // flips the run back to `running`, and its own result settles it again.
      //
      // The delegate LIFECYCLE announcement is main-thread and so passes that
      // test, and its two directions mean opposite things. A delegate STARTING
      // is the run working — that is the whole point of routing it here, since
      // a delegate launched between turns is otherwise invisible and the run
      // reads `completed` under agents that are demonstrably still going. A
      // delegate FINISHING is the same "restated the end of work as the start
      // of some" the paragraph above is about, and would latch the spinner on
      // with nothing left to take it down.
      //
      // A delegate's OWN row takes the third path, {@link leaseOnDelegateRow}:
      // it makes the same "something is being produced" claim, under an expiry
      // rather than under a terminal event it will never get. Refusing it
      // outright — which is what this branch used to do — is what left a run
      // reading `completed` while its sub-agent blocks went on filling up.
      this.recordDelegateBracket(runId, event);
      if (event.parentToolUseId !== undefined) {
        await this.leaseOnDelegateRow(runId, event.parentToolUseId, session);
      } else if (restatesRunAsWorking(event)) {
        await this.restatusAfterOffTurnEvent(em, runId, event, session);
      }
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} failed to persist a between-turn ${event.type}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * What an off-turn row does to the run's badge.
   *
   * A settled run that is producing rows again is working again, so it goes
   * back to `running`; the continuation's own result settles it. Two runs are
   * left alone entirely:
   *
   * - one the user CANCELLED. Stop is final — a straggling result flipping
   *   `cancelled` back to `completed` tells them their Stop did not take.
   * - one whose status this method did not write. `spawn-cli` only routes here
   *   while no turn is open, but this handler is async, so a new turn can have
   *   opened in between — and settling THAT turn's run on the previous one's
   *   trailing result is the exact defect `cancelledTurnMayStillEmit` was
   *   written to stop. {@link offTurnRuns} is how it knows the difference: it
   *   holds the runs whose `running` is its own.
   */
  private async restatusAfterOffTurnEvent(
    em: EntityManager,
    runId: string,
    event: AgentEvent,
    session: AgentSession | null,
  ): Promise<void> {
    const settled = terminalStatus(event);
    if (settled) {
      // A restate read before this ending must not write `running` after it.
      if (this.ownsSession(runId, session)) {
        this.offTurnEventClaims.delete(runId);
        this.offTurnSignalClaims.delete(runId);
      }
      const run = await this.runDao.getById(runId, em);
      if (
        !this.ownsSession(runId, session) ||
        !run ||
        run.status === 'cancelled'
      ) {
        return;
      }
      // The continuation has finished, so nothing is owed to a delegate whose
      // rows opened this stretch — its lease has just been answered by the very
      // terminal event it existed for want of.
      this.clearDelegateLease(runId);
      if (this.offTurnRuns.delete(runId)) {
        await this.setRunStatus(em, runId, settled);
        // A continuation the CLI opened by itself grows the context as much as
        // a turn the user sent, so it is checked on the same terms.
        if (settled === 'completed') {
          void this.autoCompactIfDue(runId);
        }
      }
      return;
    }
    // Before the claim: a stopped process's flushed row must not take it over
    // from the live session's.
    if (!this.ownsSession(runId, session)) {
      return;
    }
    const claim = Symbol('off-turn-event');
    this.offTurnEventClaims.set(runId, claim);
    try {
      const run = await this.runDao.getById(runId, em);
      // A turn the user sent may have claimed the run during the read: it owns
      // the badge now, and `offTurnRuns` set under it would let a trailing
      // terminal settle that turn.
      if (
        this.offTurnEventClaims.get(runId) !== claim ||
        !this.ownsSession(runId, session) ||
        !run ||
        run.status === 'cancelled' ||
        this.registry.has(runId)
      ) {
        return;
      }
      if (run.status === 'running' || this.offTurnRuns.has(runId)) {
        // Either a real turn owns it, or this method already moved it — the
        // phrase is worth repeating either way, the write is not.
        this.announceActivity(runId, offTurnActivity(event));
        return;
      }
      this.offTurnRuns.set(runId, run.status);
      try {
        await this.setRunStatus(em, runId, 'running', {
          activity: offTurnActivity(event),
        });
      } catch (err: unknown) {
        // Unwritten, so not flipped: the next row must try again.
        if (this.offTurnRuns.get(runId) === run.status) {
          this.offTurnRuns.delete(runId);
        }
        throw err;
      }
    } finally {
      if (this.offTurnEventClaims.get(runId) === claim) {
        this.offTurnEventClaims.delete(runId);
      }
    }
  }

  /**
   * Hand back the badge an off-turn stretch of LATE calls took
   * ({@link endsOffTurnStretch}). Such a stretch has no terminal event to end
   * it, so without this the run reads `running` until its session closes.
   * Guarded like the terminal branch of {@link restatusAfterOffTurnEvent}: a
   * restate read before this must not write `running` after it, and a badge
   * this path did not take is not its to hand back. A delegate still producing
   * rows keeps the stretch: its lease's expiry hands the badge back. Runs only
   * after the run's earlier between-turn handlers ({@link offTurnInFlight}),
   * so the late result's own `running` has landed before the re-read.
   */
  private async settleLateWork(
    runId: string,
    session: AgentSession | null,
  ): Promise<void> {
    if (!this.ownsSession(runId, session)) {
      return;
    }
    this.offTurnEventClaims.delete(runId);
    this.offTurnSignalClaims.delete(runId);
    const restoreTo = this.offTurnRuns.get(runId);
    if (
      restoreTo === undefined ||
      this.registry.has(runId) ||
      this.delegateLeases.has(runId)
    ) {
      return;
    }
    this.offTurnRuns.delete(runId);
    await this.restoreOffTurnBadge(runId, restoreTo);
  }

  /**
   * File the CLI's own context reading on the run row.
   *
   * The DURABLE twin of the live `context_progress` delta, written from the same
   * event at both of its sites so the two cannot report different moments. It is
   * what a client with no live reading draws the ring from — a reload, a
   * reconnect, a chat opened for the first time this session — and the
   * alternative it replaces is the last SETTLED turn's usage, which on this
   * app's work can be an hour and half a million tokens old. REPORTED against a
   * chat whose ring read 2% beside a panel reading 46%: the last settled turn
   * ended right after a `/compact`.
   *
   * Every reading, unthrottled. This is one small UPDATE per main-thread model
   * response — the same cadence at which the transcript is already gaining rows,
   * and a fraction of what each of those costs.
   *
   * Failure is swallowed with a log line: this is bookkeeping for a readout, and
   * a run must never fail a turn over it. Which halves of the reading are
   * usable is the DAO's rule, since it is the one that must never clear either.
   */
  /**
   * The user just acted in this thread — move its row so the sidebar knows.
   *
   * The sidebar orders by `updatedAt` inside its tier, and the only writers of
   * that column are status changes: a message that starts a turn, and a settle.
   * Two interactions write no status at all — ANSWERING a question card, and a
   * follow-up delivered into a turn already running — so both left the row
   * stamped with whenever the turn had begun. The first is what got reported:
   * a thread led the list while it was asking and dropped several places the
   * moment it was answered, because that is where its turn-start time put it.
   *
   * It ANNOUNCES rather than only writing, since the sort reads the client's
   * copy of the row and nothing else would refresh it; and it never touches the
   * status, which is not this event's to state — the turn is running before the
   * answer and running after it.
   *
   * Failure is swallowed with a log line, like the context write beside it: a
   * row that did not move is a thread one place lower in a list, and no turn
   * should fail over it.
   */
  private async noteUserActivity(runId: string): Promise<void> {
    const at = new Date();
    try {
      await this.runDao.touch(runId, at);
      this.bus.publishRunStatus({
        runId,
        status: null,
        at: at.toISOString(),
      });
    } catch (err) {
      this.logger.warn(
        `failed to record user activity for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async rememberContext(
    runId: string,
    ownerKey: string,
    reading: {
      contextTokens?: number | null;
      contextWindowTokens?: number | null;
      contextEstimated?: boolean;
    },
  ): Promise<void> {
    // A reading that names no window borrows the one the live plane already
    // resolved for this owner — most readings carry a count alone, so without
    // this the durable row keeps a numerator nothing can divide. Above BOTH
    // writes rather than between them, for the reason the next comment gives:
    // resolving after the twin would fix the stored row and leave every
    // client's ring undrawn.
    const window =
      reading.contextWindowTokens ?? this.partials.windowFor(runId, ownerKey);
    // The in-memory twin FIRST, and unconditionally: it is what every status
    // broadcast is stamped from, so a database write that fails must not also
    // cost every client its reading. Same rule the DAO applies — a half of the
    // pair that was not reported does not clear the half that was.
    this.contexts.remember(runId, {
      tokens: reading.contextTokens ?? null,
      window,
      estimated: reading.contextEstimated === true,
    });
    const tokens = reading.contextTokens ?? null;
    if (
      tokens !== null &&
      tokens > 0 &&
      this.compactionBaselines.get(runId) === 'pending'
    ) {
      this.compactionBaselines.set(runId, tokens);
    }
    try {
      await this.runDao.rememberContext(runId, {
        ...reading,
        contextWindowTokens: window,
      });
    } catch (err) {
      this.logger.warn(
        `failed to record the context reading for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Move the chat's prompt-cache expiry on as one of its turns ends — see
   * {@link RunDao.rememberPromptCache}. Logged and swallowed: a missed expiry
   * costs a warning on the composer, never the turn.
   */
  private async rememberPromptCache(
    runId: string,
    usage: AgentUsage | null | undefined,
  ): Promise<void> {
    try {
      await this.runDao.rememberPromptCache(
        runId,
        {
          ttlMs: usage?.promptCacheTtlMs ?? null,
          reason: usage?.promptCacheTtlReason ?? null,
        },
        new Date(),
      );
    } catch (err) {
      this.logger.warn(
        `failed to record the prompt cache expiry for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Drop the run's context count after a compaction — see
   * {@link RunDao.forgetContext}. Logged and swallowed like the write beside
   * it: a stale ring is worth a warning, never a failed turn.
   */
  private async forgetContext(runId: string): Promise<void> {
    this.contexts.forgetTokens(runId);
    try {
      await this.runDao.forgetContext(runId);
    } catch (err) {
      this.logger.warn(
        `failed to clear the context reading for run ${runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * What a LIVE off-turn signal does to the run's badge.
   *
   * Rows are only half of what a continuation produces. An agent that is
   * THINKING has emitted no row at all — and on a long think it will not for
   * minutes — and neither has one part-way through a sentence. Both signals
   * were routed to the live tail and nowhere else, so the transcript grew a
   * `Thinking… 500 tokens · 6s` line directly under a `✓ done` footer while the
   * sidebar row still read `completed`. That is the reported "it show as
   * completed, but its actually thinking", and the claim it needs is the one
   * {@link restatusAfterOffTurnEvent} already makes about rows: something is
   * being produced under a run that had settled, so the run is working again.
   *
   * Deliberately a separate method rather than another caller of that one, for
   * two reasons a shared body could not hold:
   *
   * - A delta fires many times a second. Once the flip has happened the phrase
   *   never changes, so {@link offTurnRuns} short-circuits the rest of the
   *   burst before it reaches the database.
   * - A run whose `running` belongs to a REAL turn is left entirely alone here,
   *   instead of having that turn's activity phrase restated as `still
   *   working`. A row is worth re-announcing for; an unfinished word is not.
   *
   * `context_progress` is the one live signal deliberately NOT routed here: it
   * measures the WINDOW rather than asserting that anything is being produced,
   * and it is also emitted synthetically once a compaction has FINISHED — the
   * one moment the CLI is demonstrably not working. The other three
   * (`text_delta`, `thinking_progress`, `reasoning_delta`) each carry something
   * the model just authored, which is exactly the claim this makes.
   */
  private async restatusAfterOffTurnSignal(
    runId: string,
    event: AgentEvent,
    session: AgentSession | null,
  ): Promise<void> {
    if (this.offTurnRuns.has(runId) || this.offTurnSignalClaims.has(runId)) {
      return;
    }
    const claim = Symbol('off-turn-signal');
    this.offTurnSignalClaims.set(runId, claim);
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      // A cancelled run stays cancelled — Stop is final, exactly as it is for an
      // off-turn row — and a `running` one, or one a sent turn has claimed
      // during the read, is somebody else's to describe.
      if (
        this.offTurnSignalClaims.get(runId) !== claim ||
        !this.ownsSession(runId, session) ||
        !run ||
        run.status === 'cancelled' ||
        run.status === 'running' ||
        this.registry.has(runId)
      ) {
        return;
      }
      this.offTurnRuns.set(runId, run.status);
      await this.setRunStatus(em, runId, 'running', {
        activity: offTurnActivity(event),
      });
    } finally {
      if (this.offTurnSignalClaims.get(runId) === claim) {
        this.offTurnSignalClaims.delete(runId);
      }
    }
  }

  /**
   * What a DELEGATE's off-turn row does to the run's badge.
   *
   * A delegate whose launching `Task` call has already returned goes on working
   * with nothing holding the turn open for it: `spawn-cli` only holds on
   * `background_work`, which is the CLI's own `task_started` bracket, and a
   * delegate it never brackets is invisible to that mechanism. The turn's
   * `result` therefore settles the run while the delegate's steps keep arriving
   * — reproduced against the real renderer: two sub-agent blocks climbing from
   * 0 to 7 tool calls, their rows persisted the whole time, under a header
   * reading `✓ completed`. That is the reported "some internal processes are
   * running, but it's shown as Completed".
   *
   * So a delegate's row makes the same claim a main-thread one does — something
   * is being produced under a run that had settled — and the two directions
   * that used to be refused here are both kept:
   *
   * - It is still not {@link restatusAfterOffTurnEvent}. That method's `running`
   *   is ENDED by a terminal event, and a delegate produces none; restating a
   *   delegate's trailing rows through it is what latched a `still working`
   *   spinner on at the exact moment the work ended, with nothing able to take
   *   it down. The lease is that missing off-switch.
   * - A delegate CLOSING still restates nothing — `restatesRunAsWorking`
   *   answers no — and now need not be special-cased: a close carries no
   *   `parentToolUseId`, so it never reaches here at all.
   *
   * Renewal is free — a live delegate emits rows continuously, and re-arming a
   * timer must not cost a write — so only the FIRST row of a quiet stretch
   * touches the database.
   */
  private async leaseOnDelegateRow(
    runId: string,
    delegateId: string,
    session: AgentSession | null,
  ): Promise<void> {
    if (this.closedDelegates.get(runId)?.has(delegateId)) {
      // Its trailing rows, not its work — see {@link closedDelegates}. This is
      // the case the row path refuses outright, and it stays refused.
      return;
    }
    if (this.backgroundWork.isDelegateOut(runId, delegateId)) {
      // A BRACKETED delegate — its CLI announced it out and will announce it
      // closed. The badge already says so (`subagentsOut` holds the run in
      // `waiting on background work`), and its close is what ends that. A lease
      // here would put `running · still working` over it instead, and since a
      // close is no terminal event, keep it there for the whole lease after the
      // work had ended: measured on codex, whose sub-agents stream their own
      // steps, a chat read `running` with both blocks closed and the composer
      // queueing messages behind an agent that had finished.
      return;
    }
    const held = this.delegateLeases.get(runId);
    if (held) {
      held.timer.refresh();
      return;
    }
    if (this.leaseClaims.has(runId)) {
      // A lease for this run is being taken as this row arrives, so the row
      // that started it covers this one too — and there is no timer to renew
      // yet. See {@link leaseClaims}.
      return;
    }
    const claim = Symbol('delegate-lease');
    this.leaseClaims.set(runId, claim);
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      // Same two exemptions as every other off-turn restate: Stop is final, and
      // a `running` run is somebody else's to describe — either a real turn owns
      // it, or the main thread's own continuation already flipped it, and that
      // one settles itself.
      if (
        !this.ownsSession(runId, session) ||
        !run ||
        run.status === 'cancelled' ||
        run.status === 'running'
      ) {
        return;
      }
      if (this.leaseClaims.get(runId) !== claim) {
        // Something took the badge over while the run was being read, and said
        // so by dropping this claim. Installing the lease now would take it
        // back — and the key may already belong to a later acquisition, which
        // is why identity is compared rather than presence.
        return;
      }
      const timer = setTimeout(() => {
        void this.expireDelegateLease(runId);
      }, DELEGATE_ROW_LEASE_MS);
      timer.unref?.();
      this.delegateLeases.set(runId, { timer });
      this.offTurnRuns.set(runId, run.status);
      await this.setRunStatus(em, runId, 'running', {
        activity: 'still working',
      });
    } finally {
      // Only ever our OWN claim: the read can throw (the caller swallows it),
      // and a stranded claim would send every later delegate row home at the
      // guard above — no lease ever taken again, the badge reading `completed`
      // while sub-agents fill, which is the defect the lease exists to remove.
      if (this.leaseClaims.get(runId) === claim) {
        this.leaseClaims.delete(runId);
      }
    }
  }

  /**
   * The delegate has gone quiet for a whole lease, so hand the badge back.
   *
   * Re-reads rather than trusting the lease: a real turn may have started in
   * the meantime (which clears the lease, but the timer may already have been
   * queued), and only a run still wearing the `running` this lease put there is
   * this method's to change back.
   */
  private async expireDelegateLease(runId: string): Promise<void> {
    const held = this.delegateLeases.get(runId);
    if (!held) {
      return;
    }
    this.delegateLeases.delete(runId);
    const restoreTo = this.offTurnRuns.get(runId);
    if (restoreTo === undefined || this.registry.has(runId)) {
      return;
    }
    this.offTurnRuns.delete(runId);
    try {
      await this.restoreOffTurnBadge(runId, restoreTo);
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} delegate-lease expiry failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The run's CLI process is gone, so no terminal event is ever coming.
   *
   * REPORTED as "seems like its stuck" and "It finished but stucked - i have to
   * ask about a status to continue". An off-turn `running` — the latch a
   * main-thread row takes, and the lease a delegate's row takes — ends on a
   * terminal event from that process. Close the process and the badge is
   * stranded: measured on run 1fb3a9f5, the idle window reaped the session
   * three seconds after its last row and the run read `running · still working`
   * from then on, with the composer refusing to send rather than queueing
   * behind anything. The only way out was to send a message, which is exactly
   * what the second report describes doing.
   *
   * A close is therefore the OTHER ending an off-turn badge can have, and the
   * only one available once the process cannot speak. It is not a lease expiry
   * with a shorter clock: the expiry is a GUESS that a quiet delegate has
   * finished, this is the certainty that nothing more can arrive.
   *
   * Deliberately does nothing for a run a real turn owns ({@link registry}) —
   * that turn settles itself, and the session it is closing is being REPLACED
   * (`it could not serve the next turn`) rather than abandoned — nor for one
   * being deleted, whose rows are on their way out.
   *
   * **A close that INTERRUPTED work owes the user a sentence**, which is the
   * `interrupted` half. Restoring the badge is right either way, but the badge
   * it restores is the status the off-turn stretch took over — routinely
   * `completed`, from a turn that ended before the agent carried on — so a
   * cut-off agent left a thread reading `completed` over eleven pending tasks
   * with nothing anywhere naming what happened. REPORTED as "Тред сам по себе
   * остановился … я должен писать ему какое-то сообщение, чтобы он продолжил",
   * and the transcript agreed with the badge rather than with the truth. The
   * eviction that caused THAT case cannot happen any more (`OFF_TURN_ACTIVE_MS`
   * in the registry), so this is the net under the cases that remain — and it
   * is deliberately gated on the work being RECENT rather than fired on every
   * close, because reaping a session that has sat quiet for half an hour is
   * housekeeping and a row per chat would be noise.
   *
   * **A process that ENDED BY ITSELF arrives here too** (`exited`) — a crash,
   * an OOM kill, a `pkill` — and strands the badge in exactly the same way.
   * It is handled identically except for the sentence, which must not claim
   * geniro closed a process that died under it.
   */
  private async settleAfterSessionClosed(
    runId: string,
    interrupted = false,
    exited = false,
    cause: SessionCloseCause | null = null,
  ): Promise<void> {
    this.clearDelegateLease(runId);
    // No process, so nothing is held for: a hold announced between turns has
    // no finalizer to clear it, and its own release arrives after the session
    // stopped being this run's.
    if (this.heldRuns.has(runId) && !this.registry.has(runId)) {
      this.announceRunHold(runId, 0, null);
    }
    // A TEAM's sessions reach this listener too, under the executor's
    // composite key (`<runId>::node:…` / `<runId>::call:…`), which names no run
    // and so matches nothing below. That is the right outcome rather than a
    // lucky one: the executor numbers its run's rows with its own counter, so a
    // close written from here with this service's allocator could collide with
    // them. The executor states those endings itself
    // (`TeamExecutorService.sessionClosers`).
    //
    // AHEAD of the early return below, which is about the off-turn BADGE and
    // asks a question this does not share: a run that never took an off-turn
    // stretch has no badge to hand back and returns here, and that is the very
    // shape the strand appears in — the agent said its piece, the turn settled
    // `completed`, and its delegates were still out. Skipped only for a run
    // being deleted, whose transcript is going away with it.
    if (!this.deleting.has(runId)) {
      await this.closeStrandedDelegates(runId, cause === 'user-stop');
    }
    const restoreTo = this.offTurnRuns.get(runId);
    if (
      restoreTo === undefined ||
      this.registry.has(runId) ||
      this.deleting.has(runId)
    ) {
      return;
    }
    this.offTurnRuns.delete(runId);
    try {
      if (interrupted) {
        await this.noteInterruptedSession(runId, exited);
      }
      await this.restoreOffTurnBadge(runId, restoreTo);
    } catch (err: unknown) {
      this.logger.error(
        `run ${runId} failed to settle after its session closed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Say in the TRANSCRIPT that the agent was cut off, not merely in the log.
   *
   * A WARNING, and one of the few that is genuinely about geniro rather than
   * about the agent: the CLI was working and this app stopped it. The sentence
   * names the recovery, because there is one and it is not obvious — the
   * conversation is intact, so the next message resumes it with everything the
   * agent had said still in the thread.
   *
   * Best-effort, like every other note here: the process is already gone, and
   * failing to explain that must not also fail the badge restore that follows.
   *
   * `exited` picks the cause the sentence names. A process that died under
   * geniro — crashed, killed from outside — was not closed by it, and saying
   * it was would send the user looking for a setting that did nothing.
   */
  private async noteInterruptedSession(
    runId: string,
    exited: boolean,
  ): Promise<void> {
    await this.persist(
      this.em.fork(),
      runId,
      await this.seqs.reserve(runId),
      'system',
      null,
      {
        message: exited
          ? "The agent's process ended on its own while it was still " +
            'working, so it stopped here. The conversation is intact — send ' +
            'a message to pick the thread up where it left off.'
          : 'The agent was still working when geniro closed its process, so ' +
            'it stopped here. Nothing is lost — send a message to pick the ' +
            'thread up where it left off.',
        severity: 'warning',
      },
    ).catch((err: unknown) => {
      this.logger.error(
        `run ${runId} interrupted-session note failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * State the ending for every delegate this run still has out, because the
   * process that owed it is gone.
   *
   * The ONE thing geniro can honestly say about a background delegate whose CLI
   * never announces an ending — see `utils/open-delegates.ts` for the two
   * measurements this rests on: cursor-agent reports no such ending on any
   * channel, and its delegates run inside the ACP process that launched them.
   * So a session closing is not a guess about the work, it is the work being
   * over, and it is the SAME rule `spawn-cli` already follows for shells: the
   * daemon writes a close for every unit still open when the CLI process dies.
   * Delegates were simply the half of that rule nobody had written.
   *
   * `untracked` with `trackingLost: 'process-ended'`, on the vocabulary's own
   * terms: the delegate did not report back, so `completed` is an outcome
   * nothing measured, while its work is over. Its CLI's record may still say
   * how it ended (`SubagentRecoveryService`). On the user's Stop it is
   * `stopped`: the Stop is what ended it.
   *
   * A TURN settling closes nothing here. A turn-settle closer existed for a
   * release, writing a close with no outcome for every delegate still out when
   * a cursor turn completed — and the renderer draws such a block `completed`,
   * so nine reviewers still working read as nine green checks under a Manager
   * that then had to send the QA back to wait for them. A cursor delegate's
   * ending is now read off its own transcript (`AcpSession`'s delegate watch),
   * which is the only closer that can tell a finished delegate from a working
   * one.
   *
   * Written through `mapEventToItem` like every other row, so the payload keeps
   * ONE writer and a closing row a client folds is byte-identical to one a CLI
   * produced.
   */
  private async closeStrandedDelegates(
    runId: string,
    /** The user's Stop closed the session, which is what ended them. */
    stopped = false,
  ): Promise<boolean> {
    try {
      const em = this.em.fork();
      // WHERE each delegate belongs, taken from its own rows — the member, and the
      // call when a callee sub-turn launched it.
      //
      // A delegate is launched BY a member and every row it produces carries that
      // member's id; the closes written here used to carry null, because this
      // service is the chat path and a chat has no members. On a chat that is
      // invisible — null is the right answer there — and on a TEAM run it
      // silently voided the whole repair: the renderer folds delegates per
      // agent, so eleven closes filed at run level reached none of the eleven
      // delegates sitting under `qa`, and the card went on counting them.
      //
      // REPORTED as "он пишет, что один из app-агентов активен, хотя он же
      // должен быть закончен", and measured on that very run — 22 opens under
      // `qa`, 11 closes under NULL, `11 active · 14 threads` on a card whose
      // run had finished an hour earlier. The call id is the same defect one
      // level down: a callee's rows are nested under its call block by the
      // payload's `callId`, so a close without one never reached the delegate.
      const stranded = strandedDelegates(
        await this.itemDao.subagentInfoRows(runId, em),
      );
      for (const delegate of stranded) {
        const mapped = mapEventToItem(
          stopped
            ? delegateCloseEvent(delegate.id, 'stopped')
            : processEndedCloseEvent(delegate.id),
        );
        if (mapped === null) {
          continue;
        }
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          mapped.kind,
          mapped.role,
          {
            ...(mapped.payload as Record<string, unknown>),
            ...ownerFields(delegate),
          },
          delegate.memberId,
        );
      }
      if (stranded.length > 0) {
        this.logger.log(
          `run ${runId}: closed ${stranded.length} sub-agent(s) left out by its agent session`,
        );
      }
      return true;
    } catch (err: unknown) {
      // Best-effort, like every other note on this path: the process is already
      // gone, and failing to record that must not also fail the badge restore
      // that follows.
      this.logger.error(
        `run ${runId} failed to close its stranded sub-agents: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      // The rows above are persisted directly rather than raised as agent
      // events, so `recordDelegateBracket` never sees them — the badge count is
      // retired here, once, instead of per row. In a FINALLY: the process that
      // ran those delegates is gone either way, and a write that threw half way
      // used to skip this and leave the run reporting delegates out over closes
      // that said otherwise, until the run was deleted.
      this.backgroundWork.retireDelegates(runId);
    }
  }

  /**
   * The boot half of {@link closeStrandedDelegates}: close what a daemon that
   * died never got to.
   *
   * A session close is the ordinary writer, and it runs in-process — so a
   * SIGKILL, a crash or a machine restart leaves those rows unwritten and the
   * delegates declared out forever, which reads on screen as a finished chat
   * with nine sub-agents eternally working. No session can exist at boot, so
   * every open delegate in the database is by construction stranded and this
   * needs no liveness test of its own.
   *
   * Run by `StrandedWorkReconcileService` before listen over the runs written
   * to since it last found them closed; answers the ones it could not close.
   */
  async reconcileStrandedDelegates(
    runIds: readonly string[],
  ): Promise<string[]> {
    try {
      const em = this.em.fork();
      const byRun = new Map<string, unknown[]>();
      for (const row of await this.itemDao.subagentInfoRowsOfRuns(runIds, em)) {
        const payloads = byRun.get(row.runId);
        if (payloads) {
          payloads.push(parsePayload(row.payload));
        } else {
          byRun.set(row.runId, [parsePayload(row.payload)]);
        }
      }
      let repaired = 0;
      const unsettled: string[] = [];
      for (const [runId, payloads] of byRun) {
        if (openDelegateIds(payloads).length === 0) {
          continue;
        }
        if (await this.closeStrandedDelegates(runId)) {
          repaired += 1;
        } else {
          unsettled.push(runId);
        }
      }
      if (repaired > 0) {
        this.logger.warn(
          `closed the stranded sub-agents of ${repaired} run(s) on boot`,
        );
      }
      return unsettled;
    } catch (err: unknown) {
      // Never block boot — a fresh database whose schema sync has not created
      // the table yet has nothing to reconcile.
      this.logger.error(
        `boot reconcile of stranded sub-agents failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [...runIds];
    }
  }

  /**
   * The shell twin of {@link reconcileStrandedDelegates}: close every detached
   * command a prior daemon left declared running.
   *
   * A command's close is announced by the CLI process's own exit (`spawn-cli`),
   * so a daemon killed before that exit was heard leaves the command listed as
   * running for the life of the transcript — and before the executor wrote its
   * own closes at a team's end, every finished team did the same to
   * whatever its members still had out. No process can exist this early, so every
   * open command on disk is stranded by construction. Answers the runs it
   * could not close.
   */
  async reconcileStrandedShells(runIds: readonly string[]): Promise<string[]> {
    try {
      const em = this.em.fork();
      const byRun = new Map<string, ShellRow[]>();
      for (const row of await this.itemDao.shellRowsOfRuns(runIds, em)) {
        const rows = byRun.get(row.runId);
        if (rows) {
          rows.push(row);
        } else {
          byRun.set(row.runId, [row]);
        }
      }
      let repaired = 0;
      for (const [runId, rows] of byRun) {
        const stranded = strandedShells(rows);
        for (const shell of stranded) {
          const mapped = mapEventToItem(shellCloseEvent(shell));
          if (mapped === null) {
            continue;
          }
          await this.persist(
            em,
            runId,
            await this.seqs.reserve(runId),
            mapped.kind,
            mapped.role,
            {
              ...(mapped.payload as Record<string, unknown>),
              ...ownerFields(shell),
            },
            shell.memberId,
          );
        }
        if (stranded.length > 0) {
          repaired += 1;
        }
      }
      if (repaired > 0) {
        this.logger.warn(
          `closed the stranded background commands of ${repaired} run(s) on boot`,
        );
      }
      return [];
    } catch (err: unknown) {
      this.logger.error(
        `boot reconcile of stranded background commands failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [...runIds];
    }
  }

  /**
   * Hand an off-turn badge back to the status it took over.
   *
   * A RESTORE, not an ending, and the flag says so: announced as an ordinary
   * settle it is a second non-terminal→terminal crossing for a turn that ended
   * minutes ago, which the client reads as a fresh ending and notifies about.
   *
   * Re-reads rather than trusting the caller: every caller reaches this after an
   * `await`, and only a run still wearing the `running` the off-turn stretch
   * put there is theirs to change back.
   */
  private async restoreOffTurnBadge(
    runId: string,
    restoreTo: RunStatus,
  ): Promise<void> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    // Asked again after the read: a send can claim the run inside it, and a
    // flagged settle announced then would end that new turn in every window.
    if (run?.status !== 'running' || this.registry.has(runId)) {
      return;
    }
    await this.setRunStatus(em, runId, restoreTo, {
      restored: true,
      noTerminalItem: true,
    });
  }

  /** Drop a run's delegate lease — whoever takes the badge over owns it now. */
  private clearDelegateLease(runId: string): void {
    const held = this.delegateLeases.get(runId);
    if (held) {
      clearTimeout(held.timer);
      this.delegateLeases.delete(runId);
    }
    // A lease that has not landed yet is taken over too: the claim is dropped
    // here and its holder compares identity after its read.
    this.leaseClaims.delete(runId);
  }

  /**
   * Note that the CLI has told us a delegate started or finished.
   *
   * Called from BOTH event handlers, because which of them a bracket lands in
   * is the CLI's timing rather than a fact about the delegate: a turn held open
   * for its delegates sees every close in-turn, while one that settled first
   * sees them off-turn. Recording only the off-turn half would leave every
   * delegate that finished inside its own turn looking un-bracketed to
   * {@link leaseOnDelegateRow}, so its tail would take a lease.
   *
   * A null `backgroundOpen` says nothing either way — the announcement carrying
   * a delegate's label or duration must not be read as a lifecycle claim.
   */
  private recordDelegateBracket(runId: string, event: AgentEvent): void {
    if (event.type !== 'subagent_info' || event.backgroundOpen === null) {
      return;
    }
    // The badge count first — `BackgroundWorkCounts` announces, and a close
    // only when it actually retired one (claude reports an ending twice).
    this.backgroundWork.record(runId, event);
    if (event.backgroundOpen) {
      this.closedDelegates.get(runId)?.delete(event.id);
      return;
    }
    const closed = this.closedDelegates.get(runId);
    if (closed) {
      closed.add(event.id);
      return;
    }
    this.closedDelegates.set(runId, new Set([event.id]));
  }

  /**
   * Track the DETACHED commands this run still has out — see
   * {@link BackgroundWorkCounts}.
   *
   * Read off the two ANNOUNCEMENTS `spawn-cli` makes about a detached command,
   * `shell_open` and `shell_info`, never off the `background_work` bracket they
   * are derived from: that bracket is turn plumbing and is deliberately not
   * forwarded to the owner, so a recorder written against it would watch every
   * command end and never see one begin. The delegate/shell split is already
   * made at the announce, so nothing here asks what `unit` a bracket named.
   *
   * Called ABOVE the row gate in both event handlers, because `shell_open`
   * yields no row — the launch is in the transcript as the tool call that made
   * it. Both handlers, on {@link recordDelegateBracket}'s own reasoning: a
   * command backgrounded inside a turn that then settles reports its end
   * off-turn, while one whose whole life fits inside its turn reports it
   * in-turn. Recording one half only leaves the count latched on for the life of
   * the session, which is the phantom-shell defect from a new direction.
   */
  private recordShellBracket(runId: string, event: AgentEvent): void {
    // Shell brackets ONLY: the call sites pair this with
    // `recordDelegateBracket`, which records the delegate half.
    if (event.type === 'shell_open' || event.type === 'shell_info') {
      this.backgroundWork.record(runId, event);
    }
  }

  /**
   * A detached command the USER stopped is out of the live count too —
   * `ChatShellsService.kill`'s half of the close.
   *
   * The count is kept off the CLI's OWN brackets, and a kill reaches none of
   * them: the launch was answered the moment the command was accepted and the
   * process is dead by the time this is called, so no `shell_info` event is
   * ever coming for it. Without this the badge reads `working · waiting on
   * background work` for the rest of the session over a command the user just
   * stopped — the same defect the announce below exists to prevent, arriving by
   * a road the CLI does not travel.
   *
   * A shell whose open recorded no work id is a NO-OP here rather than a guess:
   * the map is keyed by that id, so there is nothing to remove, and the row is
   * off the list either way — that count comes back down when the run's live
   * state is dropped. Same for a run this daemon holds no live state for at all
   * (the case a kill is most often pressed in: a command left over from a
   * conversation whose CLI is long gone), where the count is already zero and
   * announcing again would say nothing new.
   */
  noteShellClosed(
    runId: string,
    workId: string | null,
    memberId: string | null = null,
  ): void {
    this.backgroundWork.noteShellClosed(runId, workId, memberId);
    if (workId !== null) {
      this.commandEndWakes?.stoppedByUser(
        memberId === null
          ? chatWakeOwner(runId)
          : memberWakeOwner(runId, memberId),
        workId,
      );
    }
  }

  /**
   * Carry on from a failed turn — in ONE of two ways, decided by the CLI.
   *
   * What the user pressed is Retry on an error row: the conversation is intact
   * and the work is not.
   *
   * It RE-SENDS the message the interrupted turn was answering, on every CLI.
   * That is a real second send and is written as one: the message is persisted
   * again as the user's row, so the transcript shows what was asked twice
   * rather than implying the agent replied to nothing. Until this path existed
   * the button was drawn on every claude error row and could only ever refuse
   * ("retry doesnt work") — and on cursor it only REOPENED the conversation,
   * asking the agent nothing, so the chat sat idle under "Reopened this
   * conversation … nothing was sent again" (REPORTED as "ретрай: когда я на
   * него нажимаю, он не работает").
   *
   * The reopen survives for the one case it is right for: a conversation with
   * no message to send again, on a CLI that can reopen one WITHOUT a prompt (an
   * ACP `session/load` with the prompt branched away). The agent is asked
   * nothing there, and the transcript row the turn writes is the only evidence
   * the recovery happened. A CLI that cannot is refused instead.
   *
   * A session id is required either way. Without one there is nothing to carry
   * on FROM: the resume-only turn would open a fresh session and settle at once
   * (a success reported for a recovery that did not happen), and the re-send
   * would start a brand-new conversation with the old message in it, losing
   * every earlier turn the reader can still see above the button.
   *
   * The kept session is CLOSED first, and that is what keeps a turn that merely
   * reloads an already-live session out of reach: a failure the agent reports
   * about ITSELF settles the turn while its process lives on
   * (`AcpAgentFailureProtocol`), and reloading a session that never went away
   * would report a recovery that recovered nothing.
   */
  async retry(runId: string): Promise<{ retried: boolean }> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        'this chat is archived — unarchive it before retrying',
      );
    }
    const node = await this.nodeStateDao.getByRunNode(
      runId,
      SINGLE_AGENT_NODE,
      em,
    );
    // BEFORE the close below, which is destructive and unconditional: it
    // terminates the process group, taking the live turn's CLI, its MCP
    // servers and every delegate still out with it. `sendMessage`'s own busy
    // check is downstream of that, so refusing there would refuse having
    // already destroyed the work — and an error row is durable, so Retry stays
    // pressable on an old row while a later turn runs.
    if (this.registry.has(runId)) {
      throw new ConflictException(
        'RUN_BUSY',
        'this chat is still working — retry is for a turn that has already failed',
      );
    }
    // A run with no agent named cannot be carried on either way, and
    // `sendMessage` would refuse it a moment later as RUN_NOT_CONFIGURED — but
    // only after the close below had already fired.
    if (!run.agentKind) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing an agent',
      );
    }
    if (!node?.agentSessionId) {
      throw new ConflictException(
        'RUN_NOT_RESUMABLE',
        'this chat has no agent session to carry on from — send a message to start one',
      );
    }
    // What a retry SENDS. Read BEFORE the close below, so a transcript this
    // cannot answer for costs the user nothing: closing first would take the
    // session down and then refuse, leaving the chat worse off than the failed
    // turn did.
    const resend = await this.messageToResend(runId, em);
    if (resend !== null) {
      this.sessions.close(runId, 'its turn was retried');
      await this.sendMessage(runId, resend.text, resend.images);
      return { retried: true };
    }
    // Nothing to send again. A per-CLI fact decides the rest, not a branch on
    // the agent's name: an adapter that cannot honour a resume-only turn would
    // otherwise run this one as an ordinary turn and spend a real, billed
    // request on the EMPTY prompt it composes.
    const cannotReopen = this.adapterFor(run.agentKind).getConfig()
      .resumeOnlyUnavailableReason;
    if (cannotReopen !== null) {
      throw new ConflictException(
        'RUN_NOT_RESUMABLE',
        'there is no message to send again — write your next one and the agent continues from where it left off',
      );
    }
    this.sessions.close(runId, 'its turn was retried');
    await this.sendMessage(runId, '', [], { resumeOnly: true });
    return { retried: true };
  }

  /**
   * The user message a retry re-sends, with its attachments read back as bytes.
   *
   * The images are re-read from the attachment store rather than referenced,
   * because `sendMessage` takes them the way the HTTP edge delivers them — as
   * base64 to be SAVED — and saves its own copies. So a retried message keeps
   * the screenshot the first one carried instead of silently becoming a
   * text-only version of itself, which the agent would answer differently.
   *
   * An attachment whose file has since gone is DROPPED rather than failing the
   * retry: the words are most of the message, and refusing to carry on because
   * one image is missing helps nobody looking at a stuck thread.
   *
   * Null when the conversation holds no message to send again — the caller
   * decides what a retry means then, since that is a per-CLI question.
   */
  private async messageToResend(
    runId: string,
    em: EntityManager,
  ): Promise<{ text: string; images: SendMessageImage[] } | null> {
    const row = await this.itemDao.latestUserMessage(runId, em);
    const payload = row === null ? null : asRecord(parsePayload(row.payload));
    const text = asString(payload?.['text']) ?? '';
    const stored = asArray(payload?.['images']);
    if (text.trim() === '' && stored.length === 0) {
      return null;
    }
    const images: SendMessageImage[] = [];
    for (const entry of stored) {
      const id = asString(asRecord(entry)?.id);
      if (id === null) {
        continue;
      }
      try {
        const { mediaType, bytes } = this.attachments.read(runId, id);
        images.push({ mediaType, data: bytes.toString('base64') });
      } catch {
        // See the doc block: a missing file costs its image, never the retry.
      }
    }
    return { text, images };
  }

  /**
   * Persist the opening row, then start a turn whose streamed events are each
   * persisted-then-emitted. Returns that row immediately; the agent's reply
   * streams over the bus → WS while this method has already resolved.
   *
   * `resumeOnly` makes it the RETRY turn instead: no prompt is composed or
   * sent, and the opening row is a `system` note rather than the user's
   * message. One method rather than two, because everything after that row —
   * the claim, the seq allocation, the spawn, the event chain, the delegate
   * leases, every settle path — is identical, and a second copy of it is how
   * the two would come to disagree about what ending a turn means.
   */
  async sendMessage(
    runId: string,
    text: string,
    images: SendMessageImage[] = [],
    options: {
      resumeOnly?: boolean;
      clientMessageId?: string;
      /**
       * The recommendations this message applies — persisted on the message
       * row as `payload.apply`, the durable record `save_team_change`
       * checks a write against. Refused while a turn runs.
       */
      apply?: RecommendationApply;
      /**
       * Start a turn of its own or be refused `RUN_BUSY` — never be delivered
       * into a running one. An owned card's verdict, which must reach the
       * agent between turns.
       */
      ownTurn?: boolean;
      /**
       * A Send-now press: `ask` refuses a message that would cancel running
       * sub-agents with a question for the user, `cancel` is their answer.
       */
      backgroundWork?: FollowUpBackgroundWork;
      /**
       * The queue's own send, which nobody pressed: refused while a card waits
       * for the user, so it never retires a question they have not seen.
       */
      waitForAnswer?: boolean;
      /**
       * The turn is geniro's, not the user's: `text` is still the prompt, but
       * the opening row is this `system` payload rather than a user message —
       * a monitor's output starting a turn must not read as something the user
       * typed.
       */
      hostRow?: HostRowWire;
      /** Told once `hostRow` is written — a send can still fail after it. */
      onHostRowWritten?: () => void;
      /**
       * Join the running turn or start nothing: `text` goes in as a follow-up
       * under `deliveryId`, its row is `hostRow`, and the user's activity is
       * not touched. With no turn running it is refused `RUN_NOT_RUNNING`; a
       * turn on its way out stays `RUN_BUSY`.
       */
      joinOnly?: boolean;
      deliveryId?: string;
    } = {},
  ): Promise<ItemWire> {
    const em = this.em.fork();
    const run = assertChatRun(await this.runDao.getById(runId, em), runId);
    // `MessageSendService` acknowledges only a user row, and a joined row is a
    // system row.
    if (options.joinOnly === true && options.clientMessageId !== undefined) {
      throw new BadRequestException(
        'JOIN_WITH_CLIENT_ID',
        'a joined message carries no client message id',
      );
    }
    // An ARCHIVED chat is inert: shelving one cancels the turn it had, and
    // without this the very next message would start another on a row the desk
    // never shows — the thing archiving a running chat exists to prevent,
    // reached one step later. Unarchiving is the way back.
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        'this chat is archived — unarchive it to send a message',
      );
    }
    if (options.hostRow === undefined) {
      this.commandEndWakes?.userSpoke(runId);
    }
    return this.messageSends.send(runId, text, options.clientMessageId, () =>
      this.sendMessageOnce(em, run, text, images, options),
    );
  }

  /**
   * What a builder chat's turn reads of its team's history: its newest
   * runs, each at its snapshot as the turn begins, so the turn reads the same
   * rows throughout. Null when the team has no run yet, or the read failed
   * — the turn then goes on without the run tools.
   */
  private async builderAnalysisTurn(
    runId: string,
    slug: string,
  ): Promise<AnalysisTurn | null> {
    try {
      const runs = await teamRunSnapshots(
        { em: this.em, runDao: this.runDao, itemDao: this.itemDao },
        slug,
        BUILDER_CHAT_ANALYSED_RUNS,
      );
      return teamAnalysisTurn(runId, slug, runs);
    } catch (err) {
      this.logger.warn(
        `builder chat ${runId} goes without the runs of ${slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async sendMessageOnce(
    em: EntityManager,
    run: Run,
    text: string,
    images: SendMessageImage[],
    options: {
      resumeOnly?: boolean;
      apply?: RecommendationApply;
      ownTurn?: boolean;
      backgroundWork?: FollowUpBackgroundWork;
      waitForAnswer?: boolean;
      hostRow?: HostRowWire;
      onHostRowWritten?: () => void;
      joinOnly?: boolean;
      deliveryId?: string;
    },
  ): Promise<ItemWire> {
    const runId = run.id;
    if (options.waitForAnswer === true && this.awaitsCardAnswer(runId)) {
      throw new ConflictException(
        'RUN_AWAITS_ANSWER',
        'a card is waiting for your answer — your message goes out after it',
      );
    }
    if (!run.cwd || !run.agentKind) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing a working directory or agent',
      );
    }
    // Resolved BEFORE the claim, because the busy branch below needs it and
    // the claim must stay the first thing that can be raced. A pure lookup
    // against this CLI's own static list — no probe, no await.
    const geniroCommand = this.adapterFor(run.agentKind).geniroCommandFor(text);
    // Nor is a message handed to — or started behind — a geniro compaction. On
    // a CLI whose compaction replaces the session, a follow-up interrupts the
    // summary prompt and the reply to it is what gets committed as the summary;
    // and that compaction is not over when its turn ends — its finalizer still
    // commits the summary and retires the process, so a turn started in that
    // window would resume the replaced session and be missing from the summary.
    // Synchronous, so it cannot open a window ahead of the claim below.
    if (this.compactingRuns.has(runId)) {
      throw new ConflictException(
        'RUN_BUSY',
        'the agent is compacting its conversation — your message goes out once it has',
      );
    }
    // Reserve the run synchronously BEFORE any further await — this closes the
    // check-then-act window where two concurrent messages would both pass the
    // busy check, share one `maxSeq` base, allocate colliding seq values (the
    // renderer then de-dupes by seq and silently drops one), and spawn two CLIs.
    if (!this.registry.tryClaim(runId)) {
      // A geniro command is never handed to a running turn. Delivery there
      // writes the message into the CLI's own conversation, where `/compact`
      // is either the wrong CLI's word or a rewrite that never happens — and
      // on a CLI whose compaction geniro performs, the turn that would carry
      // it out is the very turn already in flight.
      //
      // This refusal is what the renderer QUEUES on, and that is the whole of
      // its job here: the composer used to pre-empt it with a refusal of its
      // own ("wait for this turn to finish"), so the command never went
      // anywhere at all. Reported as "Компакт должно вставаться в очередь, как
      // и до этого. Это должно работать." The message now waits in the strip
      // and the drain re-sends it when the turn ends — which is also the first
      // moment it can compact what that turn just said.
      if (geniroCommand) {
        throw new ConflictException(
          'RUN_BUSY',
          `/${geniroCommand.name} needs the agent to be idle — wait for this turn to finish`,
        );
      }
      // A turn holds the run. That used to be the end of it — the message went
      // back as RUN_BUSY and sat in the renderer's queue until the CLI process
      // exited, so "send this next" meant "after everything currently running
      // finishes", which can be minutes. The CLI itself does not work that way:
      // its stream-json stdin is a conversation, and a follow-up written into a
      // running turn is picked up at the next tool boundary. So try that first,
      // and fall back to the queue only when this CLI has no such channel (ACP)
      // or the turn is already on its way out.
      if (options.resumeOnly === true) {
        // A retry has nothing to recover on a run that is WORKING: the
        // conversation is live rather than lost. Falling through would deliver
        // this turn's empty text as a follow-up — writing a blank user message
        // into the transcript, and on ACP sending a second `session/prompt`,
        // which CANCELS the turn in flight. The press would then destroy the
        // work it was meant to rescue, while sending the very frame this route
        // exists not to send.
        throw new ConflictException(
          'RUN_BUSY',
          'this chat is still working — retry is for a turn that has already failed',
        );
      }
      if (options.apply !== undefined) {
        // An Apply starts its own turn: delivered into a running one, the
        // agent would take the selection mid-thought, and the analysis it is
        // still writing could post a second card the selection never saw.
        throw new ConflictException(
          'RUN_BUSY',
          'the analysis is still working — apply once it has finished',
        );
      }
      if (options.ownTurn === true) {
        throw new ConflictException('RUN_BUSY', 'a turn is running');
      }
      if (options.joinOnly === true && options.hostRow !== undefined) {
        return await this.deliverIntoRunningTurn(
          runId,
          text,
          images,
          undefined,
          {
            row: options.hostRow,
            deliveryId: options.deliveryId ?? randomUUID(),
          },
        );
      }
      return await this.deliverIntoRunningTurn(
        runId,
        text,
        images,
        options.backgroundWork,
      );
    }
    if (options.joinOnly === true) {
      this.registry.release(runId);
      throw new ConflictException('RUN_NOT_RUNNING', 'no turn is running');
    }
    // The claim is ours, so a turn is about to start — and a turn supersedes a
    // standing question card. AFTER the claim rather than before it: the check
    // above must stay the first thing that can be raced, and this is an await.
    // It is a no-op on the commonest path by construction (nothing standing,
    // nothing swept) and, on the answer's own turn, has already been cleared by
    // `deliverDeferredAnswer` before it called in here.
    await this.retireDeferredQuestions(runId);
    if (this.hasStandingCard(runId)) {
      this.announceAwaiting(runId);
    }
    /**
     * Take geniro's own host channels down, whatever ends the turn.
     *
     * Declared out here, ahead of the try, because the failure path that needs
     * it most is the CATCH below: `startTurn` can throw synchronously, and a
     * registration made inside the try would then have nothing left able to
     * remove it — leaving the tools listed on the run's own MCP endpoint with
     * no turn behind them. Reassigned once the registrations exist.
     */
    let disposeHostTools = (): void => {};
    let dropKeptOnFailedStart = (): void => {};
    const compactionToken = Symbol(runId);
    if (geniroCommand) {
      this.compactingRuns.set(runId, compactionToken);
    }
    const releaseCompaction = (): void => {
      if (this.compactingRuns.get(runId) === compactionToken) {
        this.compactingRuns.delete(runId);
      }
    };
    // Whether any window shows this run working — already `running` from an
    // off-turn stretch when the send claimed it, or announced so below. Only
    // then does a failure owe the windows a settle that ends that state.
    let shownWorking = run.status === 'running';
    const statusBefore = run.status;
    let wroteRunning = false;
    try {
      const cwd = resolveValidCwd(run.cwd);
      const agentKind = run.agentKind;

      // Before the settings re-read below, so the turn reads the brief it wrote.
      if (run.editsTeamSlug !== null) {
        await this.rebriefTeamChat(
          runId,
          run.editsTeamSlug,
          cwd,
          run.editsProjectId,
        );
      } else if (isProjectChat(run)) {
        await this.rebriefProjectChat(runId, run.editsProjectId, cwd);
      }

      // Re-read the committed settings from a FRESH fork now that the claim is
      // held: a settings PATCH that flushed to its own fork between the getById
      // above and the claim never mutated `run`, so its ACKed values would
      // otherwise be ignored. The claim now 409s any later PATCH, and
      // updateSettings reverts a PATCH that raced the claim, so this read
      // reflects exactly the acknowledged settings. Read as one row, not field
      // by field: `committed.model ?? run.model` would resurrect the old model
      // for a PATCH that deliberately cleared it back to the CLI default.
      const settings =
        (await this.runDao.getById(runId, this.em.fork())) ?? run;
      // Every chat row is created with a mode; the column is nullable only for
      // team runs. Never let a null ride through as `undefined`: a turn
      // with no permission flag inherits the CLI's own default, which for
      // claude (2.1.227) is now `auto` — approving every tool call unattended.
      // `ask` is the answer because "the user never chose a posture" and "do
      // not act unattended" are the same statement.
      const approvalDefault: ChatApprovalMode = 'ask';
      let approvalMode: ChatApprovalMode = settings.approval ?? approvalDefault;
      this.runPosture.set(runId, approvalMode);
      /**
       * Whether the daemon answers this tool's permission itself, without a
       * card — the stand-in for `--dangerously-skip-permissions`.
       *
       * ONE predicate, read by both seams that need it: the in-turn
       * `approval_request` branch, and the between-turn policy handed to the
       * session. They must never diverge — a request judged one way inside the
       * turn and the other way a second after it settled is precisely the
       * inconsistency this change exists to remove.
       *
       * The POSTURE it reads differs by seam, and deliberately: in-turn takes
       * the turn's own `approvalMode` (which `liveApproval` rewrites on a
       * mid-turn chip change), while between turns there is no turn to have a
       * mode, so it reads the run's. Passing the turn's copy there is what let
       * a chip moved to `ask` after a turn ended go on auto-approving.
       */
      /**
       * geniro's own MCP server for this run, per host tool that could ride it.
       *
       * Two predicates because they answer two different questions. The
       * QUESTION tool goes only to a CLI whose own model has no way to ask
       * (`AdapterConfig.hostQuestionToolReason`) — claude has AskUserQuestion,
       * and a second question tool beside it is a second way to do one thing.
       * The FINDINGS tool goes to every chat: a host-rendered card is a
       * property of THIS app's transcript, so there is no CLI that already has
       * one of its own to be duplicated.
       *
       * The question one is a FUNCTION because it reads `adapter`, which is
       * resolved further down while every reader of this runs later still. Both
       * are computed here rather than read off the endpoint built below,
       * because the permission gate needs them and the endpoint does not exist
       * at that point.
       */
      const hostQuestionServer = (): string | null =>
        adapter.getConfig().hostQuestionToolReason === null
          ? null
          : hostMcpServerName(runId);
      // The one name the run's own MCP server is published under, and so the
      // name every host tool is matched against. Unconditional where
      // `hostQuestionServer` is not: the RENDER tools are registered for every
      // chat, because a transcript that can draw is a property of this app
      // rather than of the CLI behind it.
      const hostServerName = hostMcpServerName(runId);
      const autoApproves = (
        toolName: string,
        mode: ChatApprovalMode | undefined,
        input: unknown,
      ): boolean =>
        isHostQuestionCall(hostQuestionServer(), toolName) ||
        isHostFindingsCall(hostServerName, toolName) ||
        isHostChartCall(hostServerName, toolName) ||
        (isHostGalleryCall(hostServerName, toolName) &&
          !hostGalleryDownloads(input)) ||
        // The artifact tool, on the render family's reading. It looks like the
        // one that should be gated — the agent is handing over a page of its
        // own code — and it is the one that least needs to be: the document
        // reaches a sandboxed frame in an opaque origin, never the user's disk,
        // and its CSP opens no channel of its own. Its one way out is a
        // library request to the fixed CDNs, whose URL a page could fill with
        // data it holds — a residual risk accepted by decision, see
        // `isHostArtifactCall`, which also says why an encrypted share
        // (`share: true`) needs no card either.
        isHostArtifactCall(hostServerName, toolName) ||
        // The notify tool, on the render family's reading: a banner the agent
        // asks for is not something a permission card meaningfully guards.
        isHostNotifyCall(hostServerName, toolName) ||
        // The patch tool auto-approves TOO, and the reason is worth stating
        // because the opposite looks right: this tool writes to disk, so surely
        // it should be gated? It IS — by its own card. Two different gates were
        // being confused. Approving the CALL applies nothing; all it does is
        // put a diff on screen with Apply and Reject, and the write happens
        // only behind that second press. Measured on a live turn before this
        // arm existed: the user got a meaningless "allow propose_patch?" card
        // first and the patch card second, and answering the first decided
        // nothing at all.
        isHostPatchCall(hostServerName, toolName) ||
        isHostProjectInstructionsCall(hostServerName, toolName) ||
        // The plan tool, on the same reading and one step further from the
        // disk: proposing a plan does not even offer to change a file. Its card
        // is the gate; a permission card in front of it would ask the user to
        // approve the asking.
        isHostPlanCall(hostServerName, toolName) ||
        isHostMetricsCall(hostServerName, toolName) ||
        isHostComparisonCall(hostServerName, toolName) ||
        // The action tools: a published button does nothing until the user
        // presses it, so the press is the gate — see `isHostActionCall`.
        isHostActionCall(hostServerName, toolName) ||
        // A team proposal only raises its card — the file is written behind
        // that card's Approve, never by the call. An ordinary chat's
        // `read_teams` is NOT here, nor below: like the history tools, a read of
        // the user's data outside this chat is the user's to allow.
        isHostTeamProposalCall(hostServerName, toolName) ||
        // A builder chat's own read, backup and check — see
        // `isHostBuilderTeamCall`.
        (run.editsTeamSlug !== null &&
          isHostBuilderTeamCall(hostServerName, toolName)) ||
        ((isProjectChat(run) || isAnalysisRun(run)) &&
          isHostLibraryReadCall(hostServerName, toolName)) ||
        // The board tools: a card filed or changed is on the board in front of
        // the user and one click to undo. The writes that would hand an
        // agent's text to unattended work — a card landing in, or edited
        // inside, an armed project's intake column, or a card's approval set
        // to `auto` — are refused by the board itself for any chat not
        // already in `auto` (`TaskBoardToolService.refuseUnattended`), since
        // this gate sees only the tool name.
        isHostBoardCall(hostServerName, toolName) ||
        // The analysis chat's own reader and card, installed only on an
        // analysis and scoped to its one source — see `isHostAnalysisReadCall`.
        isHostAnalysisReadCall(hostServerName, toolName) ||
        isHostRecommendationsCall(hostServerName, toolName) ||
        // The shared memory: its limits live in `MemoryService` — see
        // `isHostMemoryCall`.
        isHostMemoryCall(hostServerName, toolName) ||
        // The knowledge store, on the same terms: `isHostKnowledgeCall`.
        isHostKnowledgeCall(hostServerName, toolName) ||
        // The browser tools, in every mode: calling one is not the decision.
        // The first open of each new host outside `auto` is put to the user on
        // a card of its own (`BrowserBroker`).
        isHostBrowserCall(hostServerName, toolName) ||
        (mode === 'auto' &&
          !isUserQuestion(adapter.getConfig().questionToolName, toolName));
      const model = settings.model ?? undefined;
      const effort = settings.effort ?? undefined;
      const contextWindow = settings.contextWindow ?? undefined;
      const modelParameters = readModelParameters(settings.modelParameters);
      // Re-resolved per turn, exactly like `cwd` above: the row holds the
      // canonical path as of creation, and a directory deleted (or a symlink
      // re-pointed) since then would otherwise reach argv, where the CLI
      // SILENTLY ignores it — probe-verified, and the reason
      // `resolveValidConfigDir` exists. Refusing the send is the only thing
      // that can tell the user; running the turn under a directory claude
      // freshly created would fail as "Not logged in" against a profile the
      // user never named.
      const configDir = settings.configDir
        ? resolveValidConfigDir(settings.configDir)
        : undefined;
      // The threshold handed to the CLI itself, where it has a control for one
      // — see `turnAutoCompact`. Resolved per turn rather than once per chat,
      // because the window it is a share of is learned from the turn that just
      // settled. After `configDir`: the profile resolves the model.
      const autoCompact = await this.turnAutoCompact(
        run,
        agentKind,
        model ?? null,
        configDir ?? null,
        contextWindow ?? null,
      );
      // Read off the ROW, not off the app's settings: the value was
      // snapshotted when the chat was created, and re-reading the live setting
      // here is exactly what would respawn this run's CLI process mid-thread
      // (`AgentAdapter.sessionKey` hashes it).
      const customInstructions = settings.customInstructions ?? undefined;
      const replyLanguage = settings.replyLanguage ?? undefined;
      const projectInstructions = settings.projectInstructions ?? undefined;
      const memoryIndex = settings.memoryIndex ?? undefined;
      const knowledgeIndex = settings.knowledgeIndex ?? undefined;
      const nativeMemoryOff = settings.nativeMemoryOff === true;
      // Off the row too; `TaskRunsService` rewrites it before continuing a
      // card's thread, which is the one time it is meant to change.
      const taskInstructions = settings.taskInstructions ?? undefined;
      // Off the row, as `rebriefTeamChat` left it above: rewritten only when
      // the team's brief reads differently now, so an unchanged brief keeps
      // the conversation's CLI process.
      const teamInstructions = settings.teamInstructions ?? undefined;
      // Off the ROW for the same reason, and only this run's own CLI's slice —
      // an id the slice does not carry reads as that option's default, which
      // is the right reading of a run created before the option existed.
      const agentOptions = settings.agentKind
        ? readAgentOptions(settings.agentOptions)[settings.agentKind]
        : undefined;

      // Store the bytes BEFORE persisting the item: the payload records only
      // the attachment rows, so an item written first would reference files
      // that a failed write never created.
      const attachments = images.map((image) =>
        this.attachments.save(runId, image.mediaType, image.data),
      );

      // Every write below allocates from the run's ONE allocator rather than
      // from a counter local to this turn. A turn is not the only writer of
      // its run's transcript — a follow-up message handed to it mid-flight
      // (`deliverIntoRunningTurn`) writes a user item on its own request
      // chain — and a local counter cannot see that row, so it reissued the
      // seq the follow-up had just taken. See {@link ItemSeqAllocator}.
      const openingWire =
        options.resumeOnly === true
          ? // A retry writes a SYSTEM row where the message would go. It sends
            // no prompt and the agent answers nothing, so this row is the only
            // evidence the recovery happened — without it the press is
            // indistinguishable from a dead button.
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'system',
              null,
              {
                message:
                  'Reopened this conversation. Your next message carries on ' +
                  'from here — nothing was sent again.',
              },
            )
          : options.hostRow !== undefined
            ? await this.persist(
                em,
                runId,
                await this.seqs.reserve(runId),
                'system',
                null,
                options.hostRow,
              ).then((wire) => {
                options.onHostRowWritten?.();
                return wire;
              })
            : await this.persist(
                em,
                runId,
                await this.seqs.reserve(runId),
                'message',
                'user',
                {
                  text,
                  ...(attachments.length > 0 ? { images: attachments } : {}),
                  ...(options.apply === undefined
                    ? {}
                    : { apply: options.apply }),
                },
              );

      const adapter: AgentAdapter = this.adapterFor(agentKind);
      await adapter.validateModel(model);

      // The mode this turn actually runs under is the ADAPTER's answer, and any
      // degrade is persisted so the user sees it — the same seam the team
      // executor uses for a member, so a fix here cannot miss that path. The
      // probe is awaited only for a mode whose support is empirical, so a turn
      // that never asks for one never pays for it.
      const resolved = adapter.resolveApprovalMode(
        approvalMode,
        // The run's OWN adapter answers for its own binary — its probe is its
        // own, and a probe that cannot run degrades to `unknown` rather than
        // failing the send.
        adapter.getConfig().approval.probedModes.includes(approvalMode)
          ? await adapter.settledApprovalSupport()
          : { supported: {} },
      );
      if (resolved.degradeReason !== null) {
        await this.persist(
          em,
          runId,
          await this.seqs.reserve(runId),
          'system',
          null,
          { message: resolved.degradeReason },
        );
      }
      approvalMode = resolved.mode;

      const threadMessages =
        options.resumeOnly === true ||
        geniroCommand !== null ||
        isSlashCommand(text)
          ? []
          : ((await this.threadInbox?.takeForTurn(runId, em)) ?? []);
      /**
       * What the CLI is actually asked this turn.
       *
       * Three rewrites, in this order. A geniro command REPLACES the text with
       * what its adapter says this CLI needs — the transcript still records the
       * `/compact` the user typed, because the rewrite is what the agent is
       * asked, not what the conversation says was asked. And a run owed a
       * carried summary gets it prepended, once: a geniro compaction drops the
       * agent's session, so without this the next turn opens on an agent that
       * has forgotten the conversation it just summarised. What other threads
       * left waiting follows the text.
       *
       * The take is read-and-clear, so the column cannot ride a second prompt —
       * including this one's own retry.
       */
      const turnPrompt =
        options.resumeOnly === true
          ? // Nothing is composed for a turn that sends no prompt — and the
            // take is read-and-CLEAR, so reaching it here would consume a
            // carried summary this turn cannot deliver and leave the next real
            // message opening on an agent that has forgotten the conversation
            // it just summarised.
            ''
          : withCarriedContext(
              await this.runDao.takePendingContext(runId, em),
              threadMessages.length === 0
                ? geniroCommand
                  ? geniroCommand.prompt
                  : text
                : `${text}\n\n${threadMessagesPrompt(threadMessages)}`,
            );

      const node = await this.nodeStateDao.getByRunNode(
        runId,
        SINGLE_AGENT_NODE,
        em,
      );
      const resumeSessionId = node?.agentSessionId ?? null;
      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        SINGLE_AGENT_NODE,
        resumeSessionId,
        em,
      );
      // A real turn takes the run over, so whatever an off-turn continuation
      // was still holding is no longer this method's to settle — including a
      // delegate lease, whose expiry would otherwise fire mid-turn and try to
      // hand a badge back that this turn now owns.
      this.offTurnRuns.delete(runId);
      this.clearDelegateLease(runId);
      // The previous turn's delegates cannot outlive this one's badge, and the
      // set is what would otherwise grow for the life of a long chat.
      this.closedDelegates.delete(runId);
      this.holds.forget(runId);
      // To the CLI this is an ordinary prompt, so it never reports a compaction.
      const turnActivity =
        geniroCommand?.replacesSession === true ? COMPACTING_ACTIVITY : null;
      await this.setRunStatus(em, runId, 'running', { activity: turnActivity });
      shownWorking = true;
      wroteRunning = true;

      let chain: Promise<void> = Promise.resolve();
      let sawTerminal = false;
      /**
       * How this turn ENDED, kept because a geniro compaction may only be
       * committed for a turn that finished.
       *
       * `sawTerminal` alone cannot answer it — a cancelled turn and a failed
       * one both set it — and dropping the agent's session on the strength of a
       * turn the user stopped mid-summary would throw the conversation away in
       * exchange for half a paragraph.
       */
      let settledStatus: RunStatus | null = null;
      /**
       * The last thing the agent SAID this turn — what a settle announcement
       * carries so a client can tell the user what happened rather than merely
       * that something did.
       *
       * Held here rather than read back from the database at the settle: the
       * text is passing through this very handler, and a run's newest `message`
       * row is not reliably the agent's (a queued follow-up drains into the
       * transcript as a user message the moment the turn ends).
       */
      let lastAgentText: string | null = null;
      /**
       * What this turn has PRODUCED, split into the CLI's own compaction and
       * everything else — the two counters behind `RunStatusEvent.housekeeping`.
       *
       * Structural, never a match on the text `/compact`: that string is a
       * thing a user may type as prose, and an AUTOMATIC compaction lands in
       * the middle of a turn doing real work, which must still announce itself.
       * Anything besides the compaction summary — an assistant message, a tool
       * call, a notice of its own — is work and takes the exemption away.
       *
       * TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`'s
       * `compactionOnlyTurnEnds` decides the same thing from the persisted
       * items, to drop the redundant `✓ done` row under a compaction. The two
       * readings must agree — a turn the transcript treats as pure
       * housekeeping and the sidebar marks unseen is the app contradicting
       * itself about one turn.
       */
      let compactionRows = 0;
      let workRows = 0;
      let eventHandlingFailed = false;
      /**
       * The compaction this turn finished, until the row that records it is
       * written — stamped onto the CLI's summary when one follows, else a row
       * of its own ahead of the next one (`CompactionRows`).
       *
       * The two are separate lines on the stream and neither can see the other:
       * the boundary has the numbers and no text, the injected summary has the
       * text and no numbers. Ordering is MEASURED, not assumed — 2.1.228, this
       * daemon's own debug log: the boundary landed at 10:36:13.025 and the
       * summary at 10:36:13.026. Turn-scoped rather than a service field because
       * a compaction belongs to the turn it happened in, and a stale figure must
       * not be able to reach a later turn's summary.
       */
      const compactions = new CompactionRows();
      /**
       * Tool calls this turn has made on the MAIN thread — counted here because
       * no CLI reports a total, and the durable row is what keeps the figure
       * from describing only the transcript a client happens to hold.
       *
       * Per TURN, in this closure, like `compactions` above — so it already
       * starts at zero and the zeroing below is unobservable, verified by
       * mutation: removing it changes no test. It stays because the durable
       * write ADDS, so the day a closure serves two turns an un-zeroed counter
       * would contribute the first turn's tools again on the second settle, and
       * the figure would silently overcount rather than fail.
       */
      let turnToolCalls = 0;
      /**
       * How many units of background work this turn is being HELD for — 0
       * whenever the agent is itself still working.
       *
       * Per TURN, in this closure, like `compactions` above: one turn's
       * hold says nothing about the next.
       *
       * Fed by `turn_held`, which `runCliSession` raises, and NOT by counting
       * `background_work` here. That was the first attempt and it was dead code
       * on the real path: `spawn-cli` consumes those events as turn plumbing
       * and never forwards them, so the tally never moved outside a spec that
       * called this handler directly. It was also the wrong question — a
       * delegate can be running while its parent edits files, and what both
       * consumers need to know is whether the AGENT has stopped.
       *
       * It exists so the run can SAY what it is waiting for. A turn is held
       * open while units are outstanding (`spawn-cli`'s `TurnState.openWork`),
       * which is deliberate — a delegate that reports after the result line
       * would otherwise have its whole output dropped — but the holding was
       * invisible: the row went on showing the last tool name, so a finished
       * answer sat under "running Read" with a climbing timer and no way to
       * tell a live delegate from a dead one. That was the reported "it
       * finished, but it says it's still in process".
       */
      let heldOnBackgroundWork = 0;
      let heldOnUnit: 'command' | undefined;
      /**
       * The MAIN thread's tool calls that have started and not yet returned,
       * `id → name`, newest last (a `Map` keeps insertion order).
       *
       * A running tool is the most specific thing the run can be said to be
       * doing, so it wins over the background tally: without this a delegate
       * settling mid-`Bash` would rename the row to "waiting on 2 background
       * tasks" while the parent was demonstrably running Bash.
       *
       * A SET of ids rather than the boolean this started as, because a model
       * routinely issues several tool calls in ONE assistant message and their
       * results come back independently. A boolean is taken down by whichever
       * finishes first, so a batch of `Read`+`Edit` stopped naming the Edit the
       * moment the Read returned — the same "the line does not match the work"
       * complaint as the stale phrase, arriving from the other side. Keeping
       * the names is what lets the announce fall back to a tool that IS still
       * running instead of to silence.
       */
      const openMainTools = new Map<string, string>();
      /**
       * What to say while the main thread still has tools out: the most
       * recently STARTED one that has not returned.
       *
       * Newest rather than oldest because it is the call the model made last
       * and therefore the one the transcript has just shown the user — an
       * `Edit` issued alongside a slow `Bash` should not report the Bash it was
       * batched with. Null when nothing is out.
       */
      const runningToolActivity = (): string | null => {
        let latest: string | null = null;
        for (const name of openMainTools.values()) {
          latest = name;
        }
        return latest === null ? null : `running ${latest}`;
      };
      /**
       * What to say when the MAIN thread is not itself running a tool: either
       * the background work being waited on, or nothing.
       *
       * Null leaves the run's own "Working…" standing, which is the honest
       * phrase for an agent that is simply thinking.
       */
      const idleActivity = (): string | null =>
        heldActivity(heldOnBackgroundWork, heldOnUnit) ?? turnActivity;
      const enqueue = (work: () => Promise<void>): void => {
        chain = chain.then(work).catch((err: unknown) => {
          eventHandlingFailed = true;
          this.logger.error(
            `run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      };

      // Asked of the adapter, never inferred from the agent kind: the answer
      // is per-INSTALLED-BINARY (an older claude rejects the flag on argv).
      const streamPartials = await adapter
        .supportsLiveStream()
        .catch(() => false);
      if (!this.registry.canStart(runId)) {
        throw new ConflictException(
          'RUN_STOPPING',
          'daemon shutdown started before the agent could launch',
        );
      }
      // The last check before this turn acquires a finalizer, and it covers BOTH
      // shapes of the race the awaits above open up:
      //   - a delete still in flight (rows not yet gone) — `deleting`;
      //   - a delete that already FINISHED while we were probing — the run row
      //     is gone, and `deleting` has been cleared again, so only re-reading
      //     it catches this one.
      // Either way, spawning now would write a whole turn's rows for a run that
      // no longer exists, which no later delete could ever reach.
      // The re-read is resolved FIRST, and `deleting` is consulted only after
      // it: `||` would short-circuit, evaluating the Set BEFORE suspending on
      // the read, so a delete that set the flag during that suspension would be
      // missed by both halves — the flag was checked too early and the row was
      // read too early to be gone yet. Post-await, the Set catches every
      // in-flight delete (it is set before any row is destroyed) and the null
      // read catches every completed one, with no await left between the check
      // and `register`.
      const current = await this.runDao.getById(runId, this.em.fork());
      if (this.deleting.has(runId) || current === null) {
        throw new ConflictException(
          'RUN_DELETING',
          'this chat was deleted while the turn was starting',
        );
      }
      // The same window and the same two shapes, for the reversible act: the
      // Set catches an archive still in flight, the re-read one that FINISHED
      // while we were probing (the Set is cleared the moment `archive`
      // returns). Its own branch because the outcome differs — the chat is
      // still there, and the sentence has to say so.
      if (this.archiving.has(runId) || current.archivedAt !== null) {
        throw new ConflictException(
          'RUN_ARCHIVED',
          'this chat was archived while the turn was starting',
        );
      }
      /**
       * The question CARDS this turn has on screen, keyed by what each ASKS,
       * and every ask parked on one.
       *
       * A card outlives the agent call that raised it — see
       * {@link StandingHostQuestion} for the measurement that forces it — so a
       * re-ask adopts the card already up rather than raising a second one, and
       * an answer given between the two is held for the retry to collect. The
       * map and its four transitions live in {@link StandingQuestions}, which
       * holds no persistence, so the states two racing calls can put one card
       * into are reachable without driving a whole turn.
       *
       * Its sweep is what `ApprovalRegistry.sweepNode` cannot do:
       * that one DROPS a pending card without responding — correct for a
       * CLI-raised question, whose asker dies with the process, and not for
       * this one, where the promise is held by an MCP request that would
       * otherwise wait for its own client timeout with the turn already gone.
       *
       * Per TURN, like the sets beside it: the agent's retry lands inside the
       * same turn (measured — 14 seconds later on the reported run), and a map
       * outliving the turn would offer a card the sweep has already closed.
       */
      const standingQuestions = new StandingQuestions();
      /**
       * Its twin for {@link HOST_PATCH_TOOL}, and a SECOND set rather than a
       * widening of the one above.
       *
       * Both hold promises parked on a card, and both are swept the same way
       * when the turn settles — but the sentence each is swept with is what the
       * agent reads, and "the turn ended before the question was answered" is
       * the wrong thing to tell one that proposed a patch. One set with one
       * generic sentence would save four lines and cost both tools the ability
       * to say what actually happened.
       */
      const outstandingPatches = new Set<
        (outcome: HostPatchOutcome) => boolean
      >();
      /** The same again for {@link HOST_PLAN_TOOL}, on the reason just above. */
      const outstandingPlans = new Set<(outcome: HostPlanOutcome) => boolean>();
      /** And for {@link HOST_PROJECT_INSTRUCTIONS_TOOL}. */
      const outstandingProjectChanges = new Set<
        (outcome: HostProjectInstructionsOutcome) => boolean
      >();
      /**
       * Close a parked host-tool card whose CALLER has given up on it.
       *
       * Every parking tool here waits on a person, and the agent that called it
       * does NOT: an MCP client puts its own deadline on a `tools/call` —
       * cursor-agent's is 60s, measured to the millisecond on run `4829d8ed`
       * (call at 10:35:29.069, `MCP error -32001: Request timed out` at
       * 10:36:29.272) — and when it lapses the model is told the call failed
       * while nothing here learns anything. The card stayed on screen with live
       * buttons, the registry entry stayed parked, and the badge went on saying
       * the run was waiting on a question. REPORTED after the agent re-asked
       * the same question, the user answered the SECOND card, and the first was
       * still sitting above it offering to be answered too.
       *
       * The signal is the cancellation the client sends alongside its own
       * timeout, routed here by `McpServerService`. What is written is the same
       * `unanswerable` row the settle-time sweep writes, so the renderer closes
       * the card through the one path it already has rather than a second one.
       *
       * Ordered so a verdict racing the cancellation WINS: `settle` is the
       * one-shot guard both paths go through, and a card answered in the same
       * tick has already left the registry with its verdict written.
       */
      const abandonOnCancel = <TOutcome>(
        signal: AbortSignal | undefined,
        requestId: string,
        settle: (outcome: TOutcome) => boolean,
        outcome: TOutcome,
      ): void => {
        if (signal === undefined) {
          return;
        }
        const close = (): void => {
          if (!settle(outcome)) {
            return;
          }
          const approval = this.approvals.abandon(runId, requestId);
          if (approval === null) {
            return;
          }
          this.announceAwaiting(runId, runningToolActivity() ?? idleActivity());
          enqueue(async () => {
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'unanswerable',
              null,
              unanswerablePayload(approval),
            );
          });
        };
        if (signal.aborted) {
          close();
          return;
        }
        signal.addEventListener('abort', close, { once: true });
      };
      /**
       * The QUESTION channel's own cancel handling, and the one place it parts
       * company with {@link abandonOnCancel} above.
       *
       * That one closes the card, which is right for a patch or a plan: those
       * are decisions about work the agent is holding, and a caller that has
       * given up is no longer holding it. A question is different — the person
       * is mid-answer, and the deadline that just lapsed is 60 seconds long. So
       * this DETACHES the call and leaves the card standing: the buttons still
       * work, the badge still says the run is waiting on the user, and the
       * answer is held for the agent's retry.
       *
       * The identity check is what keeps an OLD call's abort from detaching a
       * NEWER one: by the time a client's deadline fires, its retry may already
       * have adopted this record.
       */
      const detachAskOnCancel = (
        signal: AbortSignal | undefined,
        record: StandingHostQuestion,
        resolve: (outcome: HostQuestionOutcome) => void,
      ): void => {
        if (signal === undefined) {
          return;
        }
        const detach = (): void => {
          standingQuestions.detach(record, resolve);
        };
        if (signal.aborted) {
          detach();
          return;
        }
        signal.addEventListener('abort', detach, { once: true });
      };
      /**
       * geniro's own question channel, for a CLI that hands its model none
       * (`AdapterConfig.hostQuestionToolReason`).
       *
       * It puts the SAME card the CLI's own questions put — one
       * `approval_request` item, one entry in the shared `ApprovalRegistry` —
       * because the alternative is a second question surface with its own
       * badge, its own verdict path and its own way of going wrong. What
       * differs is only where the answer goes: there it is folded back into a
       * paused tool call, here it resolves the MCP call the agent is blocked
       * on.
       */
      const askUser = async (
        questions: HostQuestion[],
        title: string | null,
        signal?: AbortSignal,
      ): Promise<HostQuestionOutcome> => {
        // What IDENTIFIES an ask: every word the card shows. A retry after the
        // client's deadline re-sends exactly this — observed on the reported
        // run, where the agent said "the question timed out — re-firing it" —
        // so the same words are the same question and get the same card. Any
        // rewording is a NEW question, which is the honest reading: the user is
        // being asked something else.
        const key = StandingQuestions.keyFor(title, questions);
        // A CLI whose MCP client will not hold this call open for a person is
        // answered at once and told to wait, and the card outlives the turn —
        // see the deferred-card block near `announceAwaiting`. Everything below
        // is the BLOCKING path, whose whole premise is that the call is still
        // there to be resolved when the user presses a button.
        if (adapter.getConfig().hostQuestionDeferredReason !== null) {
          return await this.askUserDeferred(em, runId, key, questions, title);
        }
        const standing = standingQuestions.peek(key);
        if (standing !== undefined) {
          // The user answered while the agent had nothing in flight. Hand it
          // over at once — this is the collection the retry came for.
          const held = standingQuestions.collectHeld(key);
          if (held !== null) {
            return held;
          }
          // Still unanswered: ADOPT the card rather than raise a second one.
          // Two cards for one question is the older defect this whole path was
          // written for, and it is what a naive retry produces.
          return await new Promise<HostQuestionOutcome>((resolve) => {
            standingQuestions.adopt(standing, resolve);
            detachAskOnCancel(signal, standing, resolve);
          });
        }
        const requestId = randomUUID();
        const input = {
          ...(title === null ? {} : { title }),
          questions,
        };
        try {
          await this.persist(
            em,
            runId,
            await this.seqs.reserve(runId),
            'approval_request',
            null,
            {
              id: requestId,
              toolName: HOST_QUESTION_TOOL,
              input,
              questions: hostCardQuestions(questions),
            },
          );
        } catch (err) {
          // The card is what the user answers through, so a card that was
          // never written is a question nobody can ever see — reported back
          // as unavailable rather than left parked forever on a verdict that
          // cannot arrive.
          return {
            status: 'unavailable',
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        return await new Promise<HostQuestionOutcome>((resolve) => {
          const record = standingQuestions.open(key, requestId, resolve);
          this.approvals.track({
            runId,
            memberId: SINGLE_AGENT_NODE,
            requestId,
            toolName: HOST_QUESTION_TOOL,
            input,
            // The badge's whole reason for existing: this is the agent asking
            // the user something, not a tool held at a permission gate.
            question: true,
            respond: (allow, answer) => {
              if (record.closed) {
                return false;
              }
              const outcome: HostQuestionOutcome =
                allow && answer !== undefined
                  ? { status: 'answered', answer }
                  : allow
                    ? // Approved with nothing said — the card's own arity can
                      // produce this, and an empty answer is not the same as
                      // a refusal.
                      { status: 'answered', answer: '' }
                    : { status: 'declined' };
              // Reaches the agent when one is still on the line; otherwise the
              // client's 60s deadline lapsed while the user was answering and
              // the outcome is HELD for the retry, which is the whole point of
              // the card outliving the call.
              standingQuestions.deliver(key, record, outcome);
              // Either way the verdict is recorded and reported delivered: a
              // held answer reaches the agent a moment later, and the answer IS
              // the tool's result, so there is no fold that could drop it.
              const delivered = true;
              this.announceAwaiting(
                runId,
                runningToolActivity() ?? idleActivity(),
              );
              if (delivered) {
                enqueue(async () => {
                  await this.persist(
                    em,
                    runId,
                    await this.seqs.reserve(runId),
                    'approval_verdict',
                    null,
                    {
                      id: requestId,
                      allow,
                      // Recorded whenever it reached the agent, which for this
                      // channel is whenever there was one — the answer IS the
                      // tool's result, so there is no fold that could silently
                      // drop it.
                      ...(allow && answer !== undefined ? { answer } : {}),
                    },
                  );
                });
              }
              return delivered;
            },
          });
          detachAskOnCancel(signal, record, resolve);
          this.announceAwaiting(runId);
        });
      };
      /**
       * A card whose Apply runs a write: put on screen as an
       * `approval_request`, parked until the press, the write run behind
       * Apply, and the verdict row recording what it did — the patch card and
       * the project-instructions card. `outstanding` is the tool's own set, so
       * the turn-end sweep tells each agent what actually happened.
       */
      const parkWriteCard = async <TOutcome>(card: {
        toolName: string;
        input: unknown;
        /** What the card is, for the log line when it cannot be written. */
        what: string;
        outstanding: Set<(outcome: TOutcome) => boolean>;
        write: () => Promise<TOutcome>;
        verdictOf: (outcome: TOutcome) => Record<string, unknown>;
        declined: TOutcome;
        unavailable: (reason: string) => TOutcome;
        signal: AbortSignal | undefined;
      }): Promise<TOutcome> => {
        const requestId = randomUUID();
        try {
          await this.persist(
            em,
            runId,
            await this.seqs.reserve(runId),
            'approval_request',
            null,
            { id: requestId, toolName: card.toolName, input: card.input },
          );
        } catch (err) {
          // The card is what the user answers through, so a card that was never
          // written is a change nobody can accept — said so rather than left
          // parked forever on a verdict that cannot arrive. The reason is
          // logged and NOT returned: a persist failure names an absolute
          // database path.
          this.logger.error(
            `run ${runId} could not persist ${card.what}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return card.unavailable('the card could not be written');
        }
        return await new Promise<TOutcome>((resolve) => {
          const settle = (outcome: TOutcome): boolean => {
            if (!card.outstanding.delete(settle)) {
              return false;
            }
            resolve(outcome);
            return true;
          };
          card.outstanding.add(settle);
          this.approvals.track({
            runId,
            memberId: SINGLE_AGENT_NODE,
            requestId,
            toolName: card.toolName,
            input: card.input,
            question: false,
            respond: (allow) => {
              // Liveness is answered SYNCHRONOUSLY, because that is what the
              // registry's contract returns — while the write itself is async,
              // so it is queued and the promise settles after it.
              if (!card.outstanding.has(settle)) {
                return false;
              }
              this.announceAwaiting(
                runId,
                runningToolActivity() ?? idleActivity(),
              );
              enqueue(async () => {
                const outcome = allow ? await card.write() : card.declined;
                // Settled first, so the agent is released the moment the write
                // is done rather than behind the row.
                settle(outcome);
                // Written even when the settle found nobody. The turn can be
                // cancelled between the press and the write completing, and in
                // that window the write HAS HAPPENED — a transcript that
                // recorded nothing would leave the user with a change and no
                // row saying who made it.
                await this.persist(
                  em,
                  runId,
                  await this.seqs.reserve(runId),
                  'approval_verdict',
                  null,
                  { id: requestId, allow, ...card.verdictOf(outcome) },
                );
              });
              return true;
            },
          });
          // Nothing is written on the way out, exactly as the settle-time sweep
          // writes nothing: the agent that proposed it has stopped listening,
          // so an Apply here would change the user's files or project for a
          // call nothing will ever be told the result of.
          abandonOnCancel(
            card.signal,
            requestId,
            settle,
            card.unavailable('the agent stopped waiting for an answer'),
          );
        });
      };
      /**
       * geniro's own patch channel: the agent proposes a change it has NOT
       * made, the user sees the diff with Apply and Reject, and this writes the
       * file if they accept.
       *
       * PARKS, unlike its two drawing siblings and exactly like {@link askUser}
       * — and, like it, rides an ordinary `approval_request` row rather than a
       * second card channel, so the card, the verdict route, the WS gateway and
       * the settle-time sweep all serve it unchanged. The `input` is spelled in
       * `Edit`'s own field names so the renderer's `editDiffOf` draws the diff
       * it already knows how to draw.
       *
       * `question: false`: this IS a tool held at a permission gate, which is
       * what the badge says — the agent is not asking the user something, it is
       * asking to change their files.
       *
       * THIS card appears even in `auto` approval mode, and deliberately. Mode
       * governs `autoApproves`, which is the path the CLI's request to CALL the
       * tool takes — and that one is auto-approved, since calling it writes
       * nothing. Nothing here goes through that path: a proposal whose whole
       * purpose is the gate would be pointless auto-applied, and
       * `ask_user_question` already behaves this way for the same reason.
       */
      const proposePatch = async (
        patch: HostPatch,
        signal?: AbortSignal,
      ): Promise<HostPatchOutcome> => {
        // A CLI that will not hold the call open is answered at once. The
        // card stands, and Apply writes the file when the verdict message
        // goes out — see the deferred-card block. Everything below parks.
        if (adapter.getConfig().hostQuestionDeferredReason !== null) {
          return this.proposePatchDeferred(em, runId, patch, cwd);
        }
        const fingerprint = await captureHostPatchFingerprint(cwd, patch);
        return parkWriteCard({
          toolName: HOST_PATCH_TOOL,
          input: patchWireInput(patch),
          what: 'a patch proposal',
          outstanding: outstandingPatches,
          write: () => applyHostPatch(cwd, patch, fingerprint),
          verdictOf: hostPatchVerdict,
          declined: { status: 'declined' },
          unavailable: (reason) => ({ status: 'unavailable', reason }),
          signal,
        });
      };
      /**
       * An analysis's change to a project's instructions: {@link proposePatch}'s
       * shape, a card with the old and new text in every approval mode, and
       * the write behind its Apply.
       */
      const proposeProjectInstructions = async (
        change: HostProjectInstructions,
        signal?: AbortSignal,
      ): Promise<HostProjectInstructionsOutcome> => {
        if (adapter.getConfig().hostQuestionDeferredReason !== null) {
          return this.proposeProjectInstructionsDeferred(em, runId, change);
        }
        return parkWriteCard({
          toolName: HOST_PROJECT_INSTRUCTIONS_TOOL,
          input: projectInstructionsCardInput(change),
          what: 'a project-instructions card',
          outstanding: outstandingProjectChanges,
          write: () => this.writeProjectInstructions(runId, change),
          verdictOf: projectInstructionsVerdict,
          declined: { status: 'declined' },
          unavailable: (reason) => ({ status: 'unavailable', reason }),
          signal,
        });
      };
      /**
       * geniro's own plan channel: the agent shows how it means to carry a
       * request out, and waits.
       *
       * {@link proposePatch}'s twin structurally — an ordinary
       * `approval_request` row, `question: false`, parked until the press — and
       * simpler in the one way that matters: approving performs NO action, so
       * there is nothing to run inside the responder and nothing that can fail
       * between the press and the effect. The verdict IS the answer.
       *
       * What it adds is the NOTE. `respond` already carries the user's words
       * for question cards, so a plan approved with a caveat or refused with a
       * redirection reaches the agent in the same press rather than costing a
       * round trip to ask what they meant. Blank is normalized away here rather
       * than at the card: an empty string travelling as a note would have the
       * agent quoting silence back at the user.
       */
      const proposePlan = async (
        plan: HostPlan,
        signal?: AbortSignal,
      ): Promise<HostPlanOutcome> => {
        // Same deferral as {@link proposePatch}: the call returns `posted`
        // and the verdict arrives as the run's next message.
        if (adapter.getConfig().hostQuestionDeferredReason !== null) {
          return this.proposePlanDeferred(em, runId, plan);
        }
        const requestId = randomUUID();
        const input = { title: plan.title, steps: plan.steps };
        try {
          await this.persist(
            em,
            runId,
            await this.seqs.reserve(runId),
            'approval_request',
            null,
            { id: requestId, toolName: HOST_PLAN_TOOL, input },
          );
        } catch (err) {
          // The card is what the user answers through, so a card that was never
          // written is a plan nobody can approve. The reason is logged and NOT
          // returned: a persist failure names an absolute database path, and
          // this string is handed to a model whose provider is off this machine.
          this.logger.error(
            `run ${runId} could not persist a plan proposal: ${err instanceof Error ? err.message : String(err)}`,
          );
          return {
            status: 'unavailable',
            reason: 'the card could not be written',
          };
        }
        return await new Promise<HostPlanOutcome>((resolve) => {
          const settle = (outcome: HostPlanOutcome): boolean => {
            if (!outstandingPlans.delete(settle)) {
              return false;
            }
            resolve(outcome);
            return true;
          };
          outstandingPlans.add(settle);
          this.approvals.track({
            runId,
            memberId: SINGLE_AGENT_NODE,
            requestId,
            toolName: HOST_PLAN_TOOL,
            input,
            question: false,
            respond: (allow, answer) => {
              const note =
                answer !== undefined && answer.trim().length > 0
                  ? answer.trim()
                  : undefined;
              const delivered = settle({
                status: allow ? 'approved' : 'declined',
                ...(note === undefined ? {} : { note }),
              });
              this.announceAwaiting(
                runId,
                runningToolActivity() ?? idleActivity(),
              );
              if (delivered) {
                enqueue(async () => {
                  await this.persist(
                    em,
                    runId,
                    await this.seqs.reserve(runId),
                    'approval_verdict',
                    null,
                    {
                      id: requestId,
                      allow,
                      // Recorded whenever there was a note, on either verdict:
                      // it reached the agent, so it belongs in the transcript
                      // beside the yes or no it qualified.
                      ...(note === undefined ? {} : { answer: note }),
                    },
                  );
                });
              }
              return delivered;
            },
          });
          abandonOnCancel(signal, requestId, settle, {
            status: 'unavailable',
            reason: 'the agent stopped waiting for an answer',
          });
          this.announceAwaiting(runId);
        });
      };
      // The endpoint is granted for the UNION of reasons a host tool could be
      // wanted here, and the listing itself stays composed per request, so an
      // agent is only ever told about the tools it can actually use. What that
      // works out to today is: every chat gets the endpoint, because the RENDER
      // tools have a use in all of them, while the question tool is
      // still registered only where `hostQuestionServer` is non-null — so
      // claude is never offered a second question tool beside its own, which
      // is the invariant this grant has always carried.
      //
      // The token is REUSED across a run's turns where one was already minted:
      // it is the run's credential for its own route, and re-minting per turn
      // would leave the previous turn's endpoint refused for no reason.
      // Read before any host tool is registered: a failure past this point
      // must find every registration covered by `disposeHostTools`.
      const builderAnalysisTurn =
        this.runtime.port !== null && run.editsTeamSlug !== null
          ? await this.builderAnalysisTurn(runId, run.editsTeamSlug)
          : null;
      const questionServer = hostQuestionServer();
      // Only where there is a port to reach: a token nobody can present is a
      // credential registered as a redaction secret and held to run teardown
      // for nothing.
      const port = this.runtime.port;
      const callToken =
        port === null ? null : this.callTokens.ensure(runId, SINGLE_AGENT_NODE);
      const mcpEndpoint =
        port !== null && callToken !== null
          ? {
              url: `http://127.0.0.1:${port}/v1/mcp/${encodeURIComponent(runId)}/${encodeURIComponent(SINGLE_AGENT_NODE)}`,
              token: callToken,
              serverName: hostServerName,
            }
          : null;
      const disposeAsker =
        mcpEndpoint && questionServer !== null
          ? this.userQuestions.register(runId, SINGLE_AGENT_NODE, askUser)
          : null;
      // The listing says whether the call returns at once. Stored with the
      // sink and gone with it, so a later turn of the same run is described
      // from its own adapter.
      const answersAtOnce =
        adapter.getConfig().hostQuestionDeferredReason !== null;
      const disposeProposer = mcpEndpoint
        ? this.patches.register(runId, SINGLE_AGENT_NODE, proposePatch, {
            answersAtOnce,
          })
        : null;
      const disposePlanner = mcpEndpoint
        ? this.plans.register(runId, SINGLE_AGENT_NODE, proposePlan, {
            answersAtOnce,
          })
        : null;
      if (mcpEndpoint) {
        this.keepHostTools(runId, adapter.getConfig().identity.displayName);
        dropKeptOnFailedStart = () => this.dropKeptHostTools(runId);
      }
      // A monitor's command runs in no sandbox of its own, so the tools are
      // offered only where calling one is put to the user first, or where the
      // turn already runs unattended — see `hostToolCallUngatedReason`. The
      // chip can move while no turn runs, so only the first outlives the turn.
      const disposeMonitors =
        mcpEndpoint &&
        this.monitorSinks !== undefined &&
        offersMonitorTools(adapter.getConfig(), approvalMode)
          ? this.monitorSinks.register(
              runId,
              SINGLE_AGENT_NODE,
              monitorSinkOf(runId, cwd),
            )
          : null;
      const monitorsDieWithTurn =
        adapter.getConfig().hostToolCallUngatedReason !== null;
      if (disposeMonitors !== null && !monitorsDieWithTurn) {
        this.keptHostTools.get(runId)?.push(disposeMonitors);
      }
      // Every chat reads the library and proposes, whatever it was opened on:
      // the gate is the card, and a builder chat's or project chat's sink below
      // only says what a call that names no target means. Never a team member.
      const disposeTeamProposals = mcpEndpoint
        ? this.teamProposals.register(runId, SINGLE_AGENT_NODE, {
            runId,
          })
        : null;
      const editsTeamSlug = run.editsTeamSlug;
      const disposeTeamBuilder =
        mcpEndpoint && editsTeamSlug !== null
          ? this.teamBuilders.register(runId, SINGLE_AGENT_NODE, {
              slug: editsTeamSlug,
              projectId: run.editsProjectId,
              turnStartedAt: Date.now(),
              savedHash: null,
              acceptsAnyVersion: false,
            })
          : null;
      // An analysis chat reads what it was started on; a builder chat its
      // team's newest runs — see `AnalysisBroker`.
      const analysisTurn = analysisTurnOf(runId, run) ?? builderAnalysisTurn;
      const disposeAnalysis =
        mcpEndpoint && analysisTurn !== null
          ? this.analyses.register(
              runId,
              SINGLE_AGENT_NODE,
              this.analysisReports.sinkFor(
                analysisTurn,
                async (kind, payload) =>
                  this.persist(
                    em,
                    runId,
                    await this.seqs.reserve(runId),
                    kind,
                    null,
                    this.attributeCard(runId, payload),
                  ),
              ),
            )
          : null;
      const disposeProjectChat =
        mcpEndpoint && isProjectChat(run) && this.projectChats !== undefined
          ? this.projectChats.register(runId, SINGLE_AGENT_NODE, {
              projectId: run.editsProjectId,
            })
          : null;
      const disposeProjectCards =
        mcpEndpoint && this.projectInstructionCards !== undefined
          ? this.projectInstructionCards.register(
              runId,
              SINGLE_AGENT_NODE,
              proposeProjectInstructions,
              { answersAtOnce },
            )
          : null;
      // Idempotent by construction — each disposer only deletes the entry it
      // installed — which is what lets the settle path call it for ORDERING
      // (before the sweep) while the two failure paths call it for COVERAGE,
      // without either having to know about the other.
      disposeHostTools = (): void => {
        disposeAsker?.();
        disposeProposer?.();
        disposePlanner?.();
        if (monitorsDieWithTurn) {
          disposeMonitors?.();
        }
        disposeTeamProposals?.();
        disposeTeamBuilder?.();
        disposeAnalysis?.();
        disposeProjectCards?.();
        disposeProjectChat?.();
      };
      // ZERO the last turn's running bill before this one's first request can
      // report. It belongs HERE rather than at the settle for the reason the
      // comment below gives about the process: a chat's CLI is kept across
      // turns, so the live plane's state is too — and clearing at the settle
      // would leave the figure blank for the whole gap between turns, which is
      // exactly when a reader is looking at what the last one cost.
      this.partials.startTurn(runId, SINGLE_AGENT_NODE);
      // Through the session registry, never `adapter.start`: a chat is the one
      // run kind that sends turn after turn to the same agent in the same
      // folder, so its CLI process is kept between them. That is what stops
      // every message re-booting the user's MCP servers — and whatever one of
      // them owns, up to a browser they are logged into.
      let owningSession: AgentSession | null = null;
      const handle = this.sessions.startTurn(
        runId,
        adapter,
        {
          prompt: turnPrompt,
          cwd,
          model,
          effort,
          contextWindow,
          modelParameters,
          // Absent rather than null when there is none, so a CLI's own default
          // stands — the same rule every optional field here follows.
          ...(autoCompact === null ? {} : { autoCompact }),
          configDir,
          customInstructions,
          replyLanguage,
          projectInstructions,
          memoryIndex,
          knowledgeIndex,
          nativeMemoryOff,
          taskInstructions,
          teamInstructions,
          agentOptions,
          resumeSessionId,
          // Only ever set alongside a resume id — `retry` refuses the pairing
          // without one, since a resume-only turn on a fresh session opens a
          // conversation nobody asked for and settles at once.
          ...(options.resumeOnly === true ? { resumeOnly: true } : {}),
          approvalMode,
          // A human is watching a chat: let the agent ask, and stream its
          // words as they are written. Each adapter decides what that costs —
          // a CLI without either capability spawns exactly as before.
          allowUserQuestions: true,
          // …and geniro's own endpoint, carrying whichever host tools this
          // turn registered — the findings tool always, the question tool only
          // for a CLI whose own model has no way to ask. Null only where the
          // daemon has no bound port to publish.
          ...(mcpEndpoint === null ? {} : { mcpEndpoint }),
          streamPartials,
          images: attachments.map((attachment) => ({
            path: this.attachments.pathOf(runId, attachment.id),
            mediaType: attachment.mediaType,
          })),
          // Tee this turn's raw stdio for the live terminal mirror. Keyed by
          // the same single agent the rest of a chat's per-member state is.
        },
        (event) => {
          // Serialize handling so seq allocation and writes stay ordered even
          // though onEvent is a sync callback firing as stdout arrives.
          enqueue(async () => {
            if (event.type === 'session') {
              await saveSessionId(event.sessionId);
              return;
            }
            if (event.type === 'text_delta') {
              // EPHEMERAL: no seq, no row, no replay — just the live tail.
              //
              // MAIN THREAD ONLY. There is exactly ONE tail per run, so two
              // sub-agents writing at once interleave into it character by
              // character and the result is nobody's words. Skipping them loses
              // nothing durable: the completed `text` event still becomes a row,
              // marked as that sub-agent's. Only the live PREVIEW is reserved
              // for the agent the user is addressing. Per-thread tails would
              // need a renderer surface to show them in — a feature, not this.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              this.partials.append(runId, SINGLE_AGENT_NODE, null, event.text);
              return;
            }
            if (event.type === 'thinking_progress') {
              // EPHEMERAL, like a text delta: the only honest signal during a
              // reasoning stretch this CLI has REDACTED. Main thread only, for
              // the same reason — one counter per run.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              this.partials.thinking(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.tokens,
              );
              return;
            }
            if (event.type === 'reasoning_delta') {
              // The other half of the same answer, for a CLI that DISCLOSES
              // what it is thinking. EPHEMERAL and main-thread-only on exactly
              // the terms above — there is one live tail per run, so two
              // sub-agents reasoning at once would interleave into nobody's
              // words.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              this.partials.reasoning(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.text,
              );
              return;
            }
            if (event.type === 'tool_compose') {
              // The third live channel: the model is serializing a tool call,
              // which is the one stretch of a turn neither of the two above can
              // see. Main-thread-only like them, and enforced one layer up —
              // `mapClaudeStreamEvent` drops a delegate's frames outright,
              // because this one drives a placeholder in the MAIN transcript.
              this.partials.composing(runId, SINGLE_AGENT_NODE, null, event);
              return;
            }
            if (event.type === 'usage_progress') {
              // The IN-TURN site, and the one that matters: its off-turn twin
              // above only ever sees a CLI carrying on by itself after a turn
              // settled. Wiring only that one was measured to draw nothing at
              // all through a whole live turn.
              this.partials.spend(runId, SINGLE_AGENT_NODE, null, event);
              return;
            }
            if (event.type === 'cost_progress') {
              // The dollars this turn has spent that its `turn_complete` has
              // not recorded yet — what the header adds to the thread's
              // recorded total while the turn runs.
              this.partials.cost(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.costUsd,
                event.estimatedCostUsd ?? null,
              );
              return;
            }
            if (event.type === 'context_progress') {
              // BEFORE the figure it scales, so the delta this publishes
              // already carries both halves: `context` publishes, and a window
              // remembered after it would not reach the client until the NEXT
              // reading — which for a CLI reporting one figure per turn is a
              // whole turn of a ring with a numerator and no denominator.
              const ownWindow =
                event.contextWindowTokens !== undefined &&
                event.contextWindowTokens !== null &&
                this.partials.rememberWindow(
                  runId,
                  SINGLE_AGENT_NODE,
                  event.contextWindowTokens,
                  event.contextModel ?? null,
                  contextWindow,
                );
              // The live plane is what lets the meter move DURING the turn
              // instead of only when it ends — and it is EPHEMERAL, so the same
              // reading is filed on the run row beside it.
              this.partials.context(
                runId,
                SINGLE_AGENT_NODE,
                null,
                event.contextTokens,
              );
              void this.rememberContext(runId, SINGLE_AGENT_NODE, {
                contextTokens: event.contextTokens,
                contextWindowTokens: ownWindow
                  ? (event.contextWindowTokens ?? null)
                  : null,
              });
              return;
            }
            if (event.type === 'turn_model') {
              // Named at session start, before any usage exists — this is what
              // lets a run's FIRST request be scaled against the real window
              // rather than an assumed one, provided some turn of that model
              // has finished at least once this session.
              this.partials.useModel(
                runId,
                SINGLE_AGENT_NODE,
                adapter.getConfig().kind,
                event.model,
                contextWindow,
              );
              return;
            }
            if (event.type === 'turn_complete') {
              // The ONLY line carrying the model's window. Remembered so the
              // next turn's live context figure has something to scale
              // against from its very first request — under the model that
              // REPORTED it, so a turn that fell back to a second model
              // cannot file that model's window under the requested one, nor
              // take it as this chat's own.
              const ownWindow = this.partials.rememberWindow(
                runId,
                SINGLE_AGENT_NODE,
                event.usage?.contextWindowTokens ?? null,
                event.usage?.contextModel ?? null,
                contextWindow,
              );
              // …and the DURABLE copy of the same pair. It is the same write
              // the live readings above make, taken here because this is the
              // one line that carries a WINDOW: claude names it on its result
              // and on no assistant line, so a chat's very first turn would
              // otherwise leave the row a numerator with no denominator, and
              // the ring is withheld rather than drawn against an assumed size.
              // From the second turn on the row already holds one — the write
              // never clears it — so this is what gets a new chat its ring.
              void this.rememberContext(runId, SINGLE_AGENT_NODE, {
                contextTokens: event.usage?.contextTokens ?? null,
                contextWindowTokens: ownWindow
                  ? (event.usage?.contextWindowTokens ?? null)
                  : null,
                contextEstimated: event.usage?.contextEstimated === true,
              });
              // This turn's worked time and tool count, ADDED to the chat's
              // running totals. Read out and zeroed synchronously, for the
              // reason the window above is resolved eagerly: the write is
              // fire-and-forget, and by the time it runs the next turn's calls
              // could already have moved the counter.
              const workedMs = event.usage?.durationMs ?? null;
              const toolCalls = turnToolCalls;
              turnToolCalls = 0;
              void this.runDao
                .rememberWork(runId, workedMs, toolCalls)
                // A failed bookkeeping write must not fail the turn — the same
                // rule every durable write on this path follows.
                .catch(() => {});
              // AWAITED, unlike the two writes above: the settle announce reads
              // the expiry back, and this callback runs on the event chain the
              // finalizer drains before it settles — so the announce can never
              // carry the PREVIOUS turn's expiry, which by now would be in the
              // past and put a false "cache expired" warning on the composer.
              await this.rememberPromptCache(runId, event.usage);
            }
            if (event.type === 'turn_cancelled' || event.type === 'error') {
              // A turn the user STOPPED, or one that failed, still called the
              // tools it called: that work happened, and the column answers how
              // much this agent has done rather than how much of it finished.
              // Counting it only on `turn_complete` left a delegate-heavy chat
              // — the long kind these columns exist for — permanently short by
              // every turn that ended any other way, since the per-turn counter
              // dies with this closure.
              //
              // The TOOLS alone: neither terminal carries a `usage`, so there is
              // no duration to add, and `rememberWork` takes the two
              // independently precisely so a figure nobody measured stays null
              // rather than being written as a zero.
              const stoppedToolCalls = turnToolCalls;
              turnToolCalls = 0;
              void this.runDao
                .rememberWork(runId, null, stoppedToolCalls)
                .catch(() => {});
              // Its requests kept the cache warm too; no usage says for how
              // long, so the lifetime the chat last stated is used.
              await this.rememberPromptCache(runId, null);
            }
            if (event.type === 'approval_withdrawn') {
              // The CLI took its own request back (claude's
              // `control_cancel_request`), so the card on screen asks about
              // something nothing is waiting on any more. Retired here, as its
              // own row, rather than at the turn's end — until then its buttons
              // would answer into nothing and the badge would say the run is
              // waiting on the user.
              await this.retireWithdrawnCard(runId, event.id);
              return;
            }
            if (endsOffTurnStretch(event)) {
              // The late calls a previous turn left behind have ended, but this
              // turn owns the badge now: there is no off-turn stretch to end.
              return;
            }
            if (event.type === 'slash_commands') {
              // The CLI's own invokable set for this cwd — feeds the
              // composer's `/` autocomplete, never the transcript.
              this.skillHarvest.record(
                adapter.getConfig().kind,
                cwd,
                configDir ?? null,
                event.commands,
              );
              return;
            }
            if (event.type === 'mcp_servers') {
              // What this turn actually loaded here — feeds the MCP panel so
              // it need not re-dial every server to answer, never the
              // transcript.
              //
              // Filed under the turn's OWN profile. This passed `null` on the
              // reasoning that "a chat turn carries no config directory (only a
              // team member does)", which stopped being true when chats gained
              // the profile chip — and a profile is a separate ACCOUNT with a
              // different set of servers, so the null was wrong in both
              // directions: the profile's own panel found no harvest and paid
              // the full cold dial, while the DEFAULT profile's panel was
              // painted with another account's servers. Measured on this
              // machine — a panel listing 15 servers belonging to
              // `.claude-work-personal` where the default profile's own
              // dial found 10.
              this.mcpHarvest.record(
                adapter.getConfig().kind,
                cwd,
                configDir ?? null,
                event.servers,
              );
              this.noteMcpMismatch(
                runId,
                adapter.getConfig().kind,
                cwd,
                configDir ?? null,
                event.servers,
              );
              return;
            }
            if (event.type === 'context_compacted') {
              // Announced rather than persisted, because what it explains is
              // momentary: a long pause with nothing happening on screen. A
              // compaction measured 46s in the probe behind
              // `CLAUDE_COMPACTING_STATUS`, and for that whole time the row said
              // only "Working…" with a climbing timer — the reported defect the
              // `started` phrase answers.
              //
              // BOTH endings announce NULL, which is what takes the phrase back
              // down; see below for why `finished` joined `failed` there.
              // Saying nothing is right rather than "compaction failed" or
              // "compacted the conversation": the durable `system` row carries
              // the CLI's own reason or its own summary, and the activity
              // channel describes what the run is DOING — afterwards it is back
              // to whatever it was doing before.
              //
              // MAIN THREAD ONLY, like the `tool_call` announce below and for
              // the same measured reason: a sub-agent's events arrive on this
              // same stream, and letting one rename the parent's activity was
              // already fixed once there.
              if (event.parentToolUseId !== undefined) {
                return;
              }
              // Held for the summary line that may follow (see `compactions`);
              // what comes back is an EARLIER compaction that none followed.
              for (const row of compactions.rowsBefore(event, null)) {
                await this.persist(
                  em,
                  runId,
                  await this.seqs.reserve(runId),
                  row.kind,
                  row.role,
                  row.payload,
                );
                compactionRows += 1;
              }
              if (event.phase === 'finished') {
                // A compaction that said what it left behind has already
                // published it (the driver synthesizes a `context_progress`
                // from `postTokens`, which files itself on the row above). One
                // that did NOT has emptied the window and told nobody how far
                // — so the figure on the row now describes a conversation that
                // no longer exists, and the ring goes on showing it full.
                if (event.postTokens === null || event.postTokens <= 0) {
                  void this.forgetContext(runId);
                }
              }
              // ONE phrase, and it is the present-tense one. A `finished`
              // announce used to word itself by trigger ("compacted the
              // conversation", or "… to free up context") — a PAST-TENSE
              // sentence on a channel that means "what this run is doing right
              // now", and which the transcript draws as a spinning row with a
              // climbing clock. Reported against a `/compact` whose whole turn
              // is the compaction, so nothing came along to replace it: the row
              // read `⟳ compacted the conversation · 54s` directly under the
              // durable summary that already said it was over — "it's still
              // saying that the compact keeps working".
              //
              // Null is what `failed` already does, for the reason that applies
              // here too: afterwards the run is back to whatever it was doing,
              // and "Working…" is the honest standing phrase for that. Nothing
              // is lost with it — the CLI's own summary lands as a durable row
              // carrying the figures the phrase never had (`compactions`
              // below), which is both a better sentence and one that survives a
              // reload. Measured on the author's own database: 14 compactions,
              // 14 summary rows.
              this.announceActivity(
                runId,
                event.phase === 'started' ? COMPACTING_ACTIVITY : null,
              );
              return;
            }
            // Anything durable ends a silent reasoning stretch — the tool call
            // the model went quiet to prepare is the commonest one, and it
            // carries no text delta to close it (see `endThinking`). Before the
            // persist, so the row stops saying "Thinking…" as the tool row
            // lands rather than a write later.
            //
            // MAIN THREAD ONLY, like every other write into this plane: there
            // is one stretch per run and it belongs to the agent the user is
            // addressing. A delegate's rows arrive on this same stream while
            // the parent is genuinely still reasoning, so letting one close the
            // stretch took the "Thinking…" row away from an agent that had not
            // stopped.
            if (event.parentToolUseId === undefined) {
              this.partials.endThinking(runId, SINGLE_AGENT_NODE, null);
            }
            if (event.type === 'turn_held') {
              // ABOVE the `mapEventToItem` gate below, and it has to stay
              // there: this event yields no ROW, so the `if (!mapped) return`
              // is exactly what it falls into. Placed after it, the tally never
              // counts anything and the phrase never appears — which is how the
              // first version of this branch was written.
              heldOnBackgroundWork = event.open;
              heldOnUnit = event.unit;
              // The agent has stopped talking, so nothing it was doing is still
              // true — a tool left open by a turn that ended is not running.
              openMainTools.clear();
              this.announceRunHold(runId, event.open, idleActivity());
              return;
            }
            // Above the row gate for the same reason `turn_held` is: this is
            // bookkeeping the OFF-turn plane reads later, and a delegate whose
            // whole life fits inside its turn is bracketed only here.
            this.recordDelegateBracket(runId, event);
            this.recordShellBracket(runId, event);
            const kept = await this.withoutReturnedMessages(runId, event);
            const mapped = kept === null ? null : mapEventToItem(kept);
            if (!mapped) {
              return;
            }
            // The held compaction's row: stamped onto `mapped` when this is the
            // CLI's summary, else written on its own ahead of it — an automatic
            // compaction puts no summary on the stream at all, and used to leave
            // no trace in the transcript.
            for (const row of compactions.rowsBefore(event, mapped)) {
              await this.persist(
                em,
                runId,
                await this.seqs.reserve(runId),
                row.kind,
                row.role,
                row.payload,
              );
              compactionRows += 1;
            }
            if (
              event.type === 'tool_call' &&
              event.parentToolUseId === undefined
            ) {
              // This chat's OWN tools. The `parentToolUseId` guard this branch
              // already applies is the delegate exclusion the durable count
              // needs too — a sub-agent has its own card, so folding its
              // toolbelt in here would report a fan-out's total as the chat's.
              turnToolCalls += 1;
              // What "running" actually means right now, for a badge the user
              // is not looking at.
              //
              // MAIN THREAD ONLY. A sub-agent's tool calls arrive on this same
              // stream, and announcing them renamed the parent run's activity
              // after work that is not the parent's — measured on a real
              // delegating turn, eight consecutive `running Bash` announces
              // that all belonged to two sub-agents. The transcript already
              // keeps their rows in their own blocks; this is the one channel
              // that still leaked them upward.
              //
              // What the badge shows instead is the `running Agent` this same
              // branch announced when the delegating tool call started, which
              // stands until the parent itself does something else — and
              // "running Agent" is the truth for the whole delegation.
              openMainTools.set(event.id, event.name);
              this.announceActivity(runId, `running ${event.name}`);
            }
            if (
              event.type === 'tool_result' &&
              event.parentToolUseId === undefined
            ) {
              // The tool is DONE, so stop saying it is running.
              //
              // Without this the phrase set above is never taken down: it is
              // only ever replaced by the NEXT tool call, so the last tool of a
              // turn keeps its present tense for as long as the turn lasts.
              // That is what put "running Read · 7m 57s" under a finished
              // answer on a turn held open by background work — a claim that
              // was false twice over, since the read had returned minutes
              // earlier and nothing was reading anything.
              //
              // Null rather than a phrase of its own: what the agent does
              // between tools is think, which is exactly what the run's own
              // "Working…" already says. Inventing "thinking" here would also
              // be a guess — the turn may equally be waiting on background work
              // it started.
              //
              // MAIN THREAD ONLY, on the same measured reason as the announce
              // above: a delegate's tool results arrive on this stream too, and
              // clearing on one would take down the parent's "running Agent"
              // while the delegation is still running.
              //
              // ...and only once this call's SIBLINGS have returned too. A
              // batch issued in one assistant message returns one result at a
              // time, so retiring the phrase on the first of them reports a
              // still-running `Edit` as idle — see `openMainTools`.
              openMainTools.delete(event.id);
              this.announceActivity(
                runId,
                runningToolActivity() ?? idleActivity(),
              );
            }
            if (event.type === 'approval_request') {
              const isQuestion = isUserQuestion(
                adapter.getConfig().questionToolName,
                event.toolName,
              );
              if (!isQuestion && event.requiresUserInteraction === true) {
                // Flag-only drift: a tool we don't recognize as THE question
                // tool claims it needs the user. It stays on the approval path
                // (card, or the auto-approve below) so a future interactive
                // tool can never silently acquire a human gate it shouldn't
                // have — but the drift is loud. Mirrors the executor's warning.
                this.logger.warn(
                  `interactive control_request for unrecognized tool '${event.toolName}' on run ${runId} — kept on the approval path`,
                );
              }
              if (autoApproves(event.toolName, approvalMode, event.input)) {
                // The daemon-side stand-in for --dangerously-skip-permissions.
                // An auto chat spawns on the stdio dialogue ONLY so the
                // question channel survives (buildArgs), so every plain
                // permission is approved here with its input unchanged and no
                // transcript item — auto stays exactly as unattended as before.
                //
                // This reply is QUEUED, unlike the user-verdict path below: it
                // sits behind every pending DB write on the same `enqueue`
                // chain. `delivered` is false when the turn settled underneath
                // it, which is worth a line — a silent false here would look
                // like the agent ignoring its own approval.
                const delivered = handle.respondApproval(
                  event.id,
                  true,
                  event.input,
                );
                if (!delivered) {
                  this.logger.warn(
                    `run ${runId} auto-approval for '${event.toolName}' was not delivered — the turn had already settled`,
                  );
                }
                return;
              }
              // The CLI is now parked waiting for a verdict. Persist the card
              // first (persist-then-emit, so the user sees it), then track it
              // under the chat's one synthetic member so the WS verdict
              // round-trip resolves it. If persisting the card FAILS the user
              // will never see it — so deny to unblock the parked CLI, letting
              // handle.done resolve and the finalizer record a clean failure
              // rather than hang forever on a verdict that can never arrive
              // (a parked ask-mode turn never exits on its own).
              //
              // The row, the entry and the verdict go by a CARD id rather than
              // `event.id`, which restarts with every process (cursor numbers
              // `n:0`, `n:1`, … per connection) and repeats when a settled
              // turn's request is re-offered to the next one. The renderer
              // keys verdicts and `unanswerable` rows by id across the whole
              // transcript, so a repeat drew the new card already answered or
              // already expired (`ApprovalRegistry.mintCardId`).
              const cardId = this.approvals.mintCardId(event.id);
              this.rememberCardId(runId, event.id, cardId);
              try {
                await this.persist(
                  em,
                  runId,
                  await this.seqs.reserve(runId),
                  mapped.kind,
                  mapped.role,
                  {
                    ...mapped.payload,
                    id: cardId,
                    ...(await threadCardFields(
                      this.runDao,
                      em,
                      hostServerName,
                      event.toolName,
                      event.input,
                    )),
                  },
                );
              } catch (err) {
                this.abandonRaising(cardId);
                handle.respondApproval(event.id, false, undefined);
                throw err;
              }
              if (await this.finishRaising(runId, cardId, event.toolName)) {
                return;
              }
              this.approvals.track({
                runId,
                memberId: SINGLE_AGENT_NODE,
                requestId: cardId,
                toolName: event.toolName,
                input: event.input,
                question: isQuestion,
                respond: (allow, answer, optionId) => {
                  const { delivered, record } = deliverApprovalAnswer(
                    adapter,
                    event,
                    allow,
                    answer,
                    // Arity-preserving: a one-time verdict keeps the
                    // three-argument call it always made.
                    (input, option) =>
                      option === undefined
                        ? handle.respondApproval(event.id, allow, input)
                        : handle.respondApproval(
                            event.id,
                            allow,
                            input,
                            option,
                          ),
                    optionId,
                  );
                  // The entry is already out of the registry by the time this
                  // runs (resolve() deletes before responding), so re-reading it
                  // reports what is STILL open — nothing, unless this turn holds
                  // another card. Announced whether or not the verdict was
                  // delivered: an undeliverable one means the turn settled
                  // underneath the card, which is equally not-parked.
                  //
                  // …and it carries what the run goes BACK to doing, because
                  // the tool the user just approved announced itself before the
                  // card went up and will not announce itself again.
                  this.announceAwaiting(
                    runId,
                    runningToolActivity() ?? idleActivity(),
                  );
                  void this.noteUserActivity(runId);
                  if (delivered) {
                    enqueue(async () => {
                      await this.persist(
                        em,
                        runId,
                        await this.seqs.reserve(runId),
                        'approval_verdict',
                        null,
                        {
                          id: cardId,
                          allow,
                          ...record,
                        },
                      );
                    });
                  }
                  return delivered;
                },
              });
              // Parked on the user — announced AFTER the track, so the registry
              // it reads already holds this card. Two things at once, and both
              // matter: the badge stops saying "running" (nothing will move
              // without the user, and a spinner in the sidebar of a chat they
              // are not looking at is the reported complaint), and the line
              // under it says which kind of answer is wanted.
              this.announceAwaiting(runId);
              // An approval_request is never terminal — nothing else to do.
              return;
            }
            if (terminalStatus(event) !== null) {
              // Consumed by whichever terminal this turn ends on, so a Stop
              // can never outlive the turn it was pressed at.
              const stoppedByUser = this.stopsRequested.delete(runId);
              if (
                event.type === 'turn_cancelled' &&
                this.shuttingDown &&
                !stoppedByUser
              ) {
                // The DAEMON is going away, and that is what cancelled this
                // turn — not a Stop (see {@link shuttingDown}). So neither the
                // `turn_cancelled` row, which the transcript reads as the
                // user's Stop, nor the `cancelled` status is written: the run
                // stays `running`, and the next boot closes it as interrupted.
                //
                // Counted as this turn's ending all the same, or the finalizer
                // would write the synthetic completion it keeps for a turn
                // that ended with no terminal event at all.
                sawTerminal = true;
                this.logger.log(
                  `run ${runId}: turn ended by the daemon shutting down — left running for the next boot to close as interrupted`,
                );
                return;
              }
            }
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              mapped.kind,
              mapped.role,
              mapped.payload,
            );
            // ONLY a message retires the tail: it is the durable copy of the
            // very words being streamed. Retiring on any item would let a
            // terminal one (turn_cancelled/error) erase the tail a moment
            // before the finalizer flushes it — the text the user watched
            // would vanish from the replayed transcript.
            //
            // …and only the MAIN thread's message, which is the same rule
            // `text_delta` follows above. There is one tail per run and it
            // holds the words the user is watching appear; a DELEGATE's
            // message is the durable copy of text that was never in it, so
            // retiring on one threw away the head of a sentence the main
            // agent was still writing. That is the reported "it started
            // streaming messages, then cut off the first part and streamed
            // out the second one" — the bubble restarted mid-word, and the
            // whole message only appeared when its own durable row landed at
            // the end. The screenshot's turn had a sub-agent producing rows
            // throughout, which is exactly when it bites.
            if (
              mapped.kind === 'message' &&
              event.parentToolUseId === undefined
            ) {
              this.partials.retire(runId, SINGLE_AGENT_NODE, null);
              if (mapped.role === 'assistant') {
                // Straight off the mapped payload, which is the shape the row
                // is written from — no re-read, no second reading of what a
                // message IS.
                const text = (mapped.payload as { text?: unknown }).text;
                lastAgentText =
                  typeof text === 'string' && text.trim() !== ''
                    ? text
                    : lastAgentText;
              }
            }
            const status = terminalStatus(event);
            if (status === null) {
              // The row this turn just produced, tallied for `housekeeping`.
              // The compaction summary is identified by the MARKER stamped
              // above and never by its text: a CLI free to reword "This
              // session is being continued…" would silently stop matching.
              if (
                (mapped.payload as { compaction?: unknown }).compaction !==
                undefined
              ) {
                compactionRows += 1;
              } else if (mapped.kind !== 'message' || mapped.role !== 'user') {
                // The prompt that ASKED for the compaction is not work — it is
                // the user talking. Everything else the agent produced is.
                workRows += 1;
              }
            }
            if (
              event.type === 'turn_complete' &&
              cliTurnDurationMs({ usage: event.usage }) === null
            ) {
              // A turn the CLI did not time (every ACP agent) is measured by
              // the wall clock from the chat's durable rows — AFTER its
              // `turn_complete` row above is written, which the fold needs to
              // see the turn end, and BEFORE the settle below, whose announce
              // reads the served figure back.
              await this.catchUpWallWork(runId);
            }
            if (status) {
              // What the settle SAYS, for whoever is not looking at this chat.
              // A failure speaks for itself; a completion is summarised by the
              // agent's own closing words, which is the only text that answers
              // "what happened" without opening the thread.
              await this.setRunStatus(em, runId, status, {
                summary: event.type === 'error' ? event.message : lastAgentText,
                housekeeping: compactionRows > 0 && workRows === 0,
                hostTurn: options.hostRow !== undefined,
              });
              // Spent — the tally describes ONE turn, so anything arriving
              // after this ending is counted from zero rather than inheriting
              // a compaction that belonged to the turn before it.
              compactionRows = 0;
              workRows = 0;
              // Set only after the write succeeds: if it throws, the finalizer
              // still writes a synthetic completion rather than leaving 'running'.
              sawTerminal = true;
              settledStatus = status;
            }
          });
        },
        // This turn's answer for a request that arrives after it settles —
        // literally the same predicate the in-turn branch uses, so a tool call
        // cannot be judged one way inside the turn and the other way a moment
        // later. The registry installs it on EVERY turn, spawn or reuse, so the
        // posture is the one the user most recently chose rather than the one
        // the session was opened with.
        //
        // Everything else returns null, which HOLDS the request for the next
        // turn to adopt as an ordinary card, rather than refusing it. A refusal
        // reached the agent as the user's own "no" for a card nobody rendered —
        // which is how an `auto` chat came to report that it had lost write
        // access to the worktree.
        ({ toolName, input }) =>
          autoApproves(toolName, this.runPosture.get(runId), input)
            ? true
            : null,
        (event) => {
          const inFlight = this.offTurnInFlight.get(runId) ?? new Set();
          this.offTurnInFlight.set(runId, inFlight);
          const handle = (): Promise<void> =>
            this.handleBetweenTurnEvent(
              runId,
              adapter.getConfig().kind,
              cwd,
              configDir ?? null,
              event,
              owningSession,
            );
          if (startsLateWork(event)) {
            this.offTurnLateCalls.set(
              runId,
              (this.offTurnLateCalls.get(runId) ?? 0) + 1,
            );
          }
          const seen = this.offTurnLateCalls.get(runId) ?? 0;
          // Every other event starts at once: the handler takes some of its
          // ordering synchronously, in the order events arrive.
          const handled = (
            endsOffTurnStretch(event)
              ? Promise.allSettled([...inFlight]).then(() =>
                  (this.offTurnLateCalls.get(runId) ?? 0) === seen
                    ? handle()
                    : undefined,
                )
              : handle()
          ).catch((err: unknown) => {
            this.logger.error(
              `run ${runId} between-turn event failed: ${String(err)}`,
            );
          });
          inFlight.add(handled);
          void handled.finally(() => {
            inFlight.delete(handled);
            if (inFlight.size === 0) {
              this.offTurnInFlight.delete(runId);
              this.offTurnLateCalls.delete(runId);
            }
          });
        },
        // A chat HAS a card surface, so a request the posture above will not
        // decide is shown rather than held — see {@link raiseHeldApproval} for
        // the run that was lost to holding one.
        (event, respond) =>
          this.raiseHeldApproval(runId, adapter, event, respond),
      );
      owningSession = this.sessions.peek(runId);
      this.registry.register(runId, handle);
      this.commandEndWakes?.turnStarted(chatWakeOwner(runId));
      // A Stop can arrive during the claim→register window, before there is
      // a session to close. The registry interrupts the newly registered turn;
      // retire its process as well so delegates cannot restart it afterwards.
      if (this.stopsRequested.has(runId)) {
        this.closeStoppedSession(runId);
      }
      // Only a session that came up has an agent to read them: after a failed
      // spawn they stay waiting for the next turn.
      if (threadMessages.length > 0 && owningSession !== null) {
        enqueue(async () => {
          await this.threadInbox?.markDelivered(
            runId,
            threadMessages.map((message) => message.id),
          );
          await this.persist(
            em,
            runId,
            await this.seqs.reserve(runId),
            'system',
            null,
            threadMessagesRow(threadMessages),
          );
        });
      }
      // How a mid-turn approval change reaches THIS turn's own seam. The
      // closure variable above is what the auto-approve branch reads on every
      // `approval_request`, so telling the CLI alone would leave the daemon
      // half of the posture on the mode the turn started with — an `auto`
      // turn switched to `ask` would keep auto-approving even though the CLI
      // had begun asking.
      this.liveApproval.set(runId, (mode) => {
        // The CLI FIRST, and only adopt the mode it accepted. The reverse
        // order would move the daemon's own gate for a change the running
        // turn never received.
        if (!handle.setApprovalMode(mode)) {
          return false;
        }
        approvalMode = mode;
        // The run's posture moves with the turn's, so a mode changed mid-turn
        // still governs a request that arrives once this turn has settled.
        this.runPosture.set(runId, mode);
        return true;
      });

      const finalized = handle.done
        .then(async () => {
          await chain; // drain pending persists before finalizing
          // The turn that could put a question on screen is over: take the
          // asker down FIRST, so a call arriving during the rest of this
          // finalizer is refused outright rather than parked on a card the
          // sweep below is in the middle of closing. The reporter goes with
          // it, and for the same reason on its own terms — the persist chain
          // has just been drained, so a report landing after this point would
          // reserve a seq against a turn that has finished writing.
          disposeHostTools();
          standingQuestions.sweep({
            status: 'unavailable',
            reason: 'the turn ended before the question was answered',
          });
          for (const settle of [...outstandingPatches]) {
            settle({
              status: 'unavailable',
              reason: 'the turn ended before the patch was answered',
            });
          }
          for (const settle of [...outstandingPlans]) {
            settle({
              status: 'unavailable',
              reason: 'the turn ended before the plan was answered',
            });
          }
          for (const settle of [...outstandingProjectChanges]) {
            settle({
              status: 'unavailable',
              reason: 'the turn ended before the change was answered',
            });
          }
          // Sweep BEFORE the branches below — the failure path early-returns,
          // and a settled turn must never leave a pending card that no
          // verdict can ever reach. Each swept request is SAID so in the
          // transcript: dropping it silently is what left the card on screen
          // with live buttons that answer into nothing.
          for (const approval of this.approvals.sweepNode(
            runId,
            SINGLE_AGENT_NODE,
          )) {
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'unanswerable',
              null,
              unanswerablePayload(approval),
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} unanswerable item write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
          // A turn that died mid-block leaves text the user WATCHED being
          // written but that no durable item covers. Persist it once, flagged,
          // so an afterSeq replay shows the same transcript they saw. The only
          // item row the live plane is ever allowed to create.
          const tail = this.partials.takeTail(runId, SINGLE_AGENT_NODE, null);
          if (tail !== null) {
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'message',
              'assistant',
              { text: tail, partial: true },
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} partial-text flush failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
          }
          this.partials.clearRun(runId);
          // The turn is over, so nothing is being held for anything. Cleared
          // on EVERY settle path (the finalizer runs for a failure and a cancel
          // too), or a run that was held when it died would keep telling every
          // window that opens afterwards that its agent is idle and waiting.
          //
          // ANNOUNCED, not merely deleted, and that is the other half of the
          // same sentence. The map is what a later `GET /v1/chats` reads, so
          // deleting it fixed the SNAPSHOT and left every window already open
          // to learn the release from an event that was never sent — the hold
          // is only ever announced on its two transitions, so a client's copy
          // latches until something else happens to refetch the list.
          // REPORTED with a screenshot: a chat reading `⌛ working · waiting on
          // background work` while the daemon answered `holdingFor: 0`,
          // `shellsOpen: 0` for it, with no sub-agent and no command anywhere
          // on screen to account for the phrase. It also costs more than a
          // word: `held` is not settled, so the stale reading suppressed that
          // chat's turn-end notification and told the composer the agent was
          // idle.
          //
          // Only when there WAS a hold, on `recordShellBracket`'s rule: a
          // settle is the commonest event in the app, and a `holdingFor: 0` on
          // every one of them is a broadcast to every window restating what it
          // already believes.
          if (this.heldRuns.has(runId)) {
            this.announceRunHold(runId, 0, null);
          }
          this.heldRuns.delete(runId);
          if (eventHandlingFailed) {
            const message = 'run event persistence failed';
            await this.setRunStatus(em, runId, 'failed').catch(
              (err: unknown) => {
                this.logger.error(
                  `run ${runId} failure-status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            );
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'error',
              null,
              { message },
            ).catch((err: unknown) => {
              this.logger.error(
                `run ${runId} terminal failure item write failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
            this.restoreDeferredAwaiting(runId);
            return;
          }
          if (!sawTerminal) {
            // The turn ended with no terminal event (e.g. a clean exit with no
            // result line). Persist+emit a synthetic turn_complete so the client
            // always receives a terminal item and never wedges waiting for one.
            await this.persist(
              em,
              runId,
              await this.seqs.reserve(runId),
              'turn_complete',
              null,
              { usage: null, stopReason: null },
            );
            await this.setRunStatus(em, runId, 'completed').catch(
              (err: unknown) => {
                this.logger.error(
                  `run ${runId} synthetic-completion status write failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              },
            );
            // A turn end no CLI timed, measured like any other — AFTER the
            // status write, which a cancel landing in between must not lose.
            await this.catchUpWallWork(runId);
            settledStatus = 'completed';
          }
          // Only a compaction that FINISHED re-bases the auto-compact rule. One
          // that was stopped or failed shrank nothing, and arming the baseline
          // anyway would measure the next turn at the same size and switch
          // auto-compaction off for exactly the conversation that needs it.
          if (geniroCommand && settledStatus === 'completed') {
            this.compactionBaselines.set(runId, 'pending');
          }
          // LAST, once the transcript is drained and the run's status is
          // final: this is the only step that destroys something (the CLI's
          // own conversation), so it must not run beside writes that could
          // still fail the turn.
          if (geniroCommand?.replacesSession === true) {
            await this.commitCarriedCompaction(
              em,
              runId,
              geniroCommand.name,
              settledStatus,
              lastAgentText,
            );
          }
          this.restoreDeferredAwaiting(runId);
        })
        .catch((err: unknown) => {
          this.logger.error(
            `run ${runId} turn finalize failed: ${String(err)}`,
          );
        });
      // Published so `delete` can wait for this turn's LAST write rather than
      // for its child's exit. Dropped on settle, and only if this exact turn is
      // still the tracked one — a fast follow-up turn must not have its
      // finalizer cleared by its predecessor's.
      this.finalizing.set(runId, finalized);
      void finalized.finally(() => {
        if (this.finalizing.get(runId) === finalized) {
          this.finalizing.delete(runId);
        }
      });
      // On the TURN's end for a compaction done in place, so a later turn's
      // follow-ups are never refused on its account — but on the FINALIZER's
      // for one that replaces the session, which is not over until the summary
      // is committed and the process retired.
      void (
        geniroCommand?.replacesSession === true ? finalized : handle.done
      ).finally(releaseCompaction);
      // Every ending of the turn, failed finalizers included, and after the
      // compaction claim is gone: a verdict held behind this turn starts the
      // next one (`deliverOwnedCardVerdict`).
      void finalized.finally(() => {
        this.releaseHeldVerdicts(runId);
        this.notifyTurnSettled(runId);
      });
      // After the finalizer rather than inside it: the claim this turn held
      // must be gone before `/compact` can take the run. A compaction turn
      // never re-arms it, or a conversation that stays over the threshold
      // would compact itself in a loop.
      if (!geniroCommand && options.resumeOnly !== true) {
        void finalized.then(() => this.autoCompactIfDue(runId));
      }
      // Dropped on the same settle, so a PATCH arriving after the turn ends
      // takes the plain persist-only path instead of writing into a dead
      // closure and reporting the change as live.
      void handle.done.finally(() => this.liveApproval.delete(runId));
      // Attached to the FINALIZER, not to `handle.done`: the finalizer disposes
      // them itself, in order, after the persist chain drains — hanging this off
      // `handle.done` would run it first and move that teardown moment earlier
      // for every ordinary settle. What it covers is the finalizer failing
      // partway (`await chain` rejecting), where the registrations would
      // otherwise outlive the turn and leave the tools listed on the run's
      // endpoint with nothing able to serve them. `handle.done` itself never
      // rejects, per `AgentTurnHandle.done`.
      void finalized.finally(disposeHostTools);

      return openingWire;
    } catch (err) {
      // Failed before the handle took over the slot's lifecycle — drop the claim
      // so the run is not wedged as permanently busy, and take the host tools
      // down with it: `startTurn` can throw synchronously, and nothing else
      // would ever unregister them.
      disposeHostTools();
      dropKeptOnFailedStart();
      // No terminal row stands behind this settle. While a window shows the
      // run working, the flag is what ends that state in every window, not
      // only the one that sent; a send refused over a settled run changed no
      // window's state and is answered by its own error.
      // A host turn that never started leaves the run as it found it: its
      // delivery tries again, and says in the transcript if it gives up.
      const hostTurn = options.hostRow !== undefined;
      const settleTo = !hostTurn
        ? 'failed'
        : !wroteRunning
          ? null
          : isTerminalRunStatus(statusBefore)
            ? statusBefore
            : 'failed';
      if (settleTo !== null) {
        await this.setRunStatus(em, runId, settleTo, {
          ...(shownWorking ? { noTerminalItem: true } : {}),
          ...(hostTurn ? { hostTurn: true } : {}),
        }).catch((statusErr: unknown) => {
          this.logger.error(
            `run ${runId} start-failure status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
          );
        });
      }
      // A Stop pressed while this turn was only CLAIMED has no terminal event
      // left to consume it; dropped here, before the claim is, so it cannot be
      // mistaken for a Stop of the next turn.
      this.stopsRequested.delete(runId);
      this.registry.release(runId);
      // The failed write above ran while the claim still held, so a standing
      // card was left uncounted; nothing runs now.
      if (this.hasStandingCard(runId)) {
        this.announceAwaiting(runId);
      }
      releaseCompaction();
      this.releaseHeldVerdicts(runId);
      this.notifyTurnSettled(runId);
      throw err;
    }
  }

  /**
   * This chat's threshold as a TURN carries it — what the CLI is told so it
   * compacts itself before the window fills, rather than waiting for the turn
   * to end (see `AdapterConfig.autoCompact`).
   *
   * The window is this conversation's own last reading, live first and the row
   * behind it — the same pair {@link autoCompactIfDue} judges on, so the two
   * rules can never disagree about how full the window is. Before any turn has
   * reported one, the model's known window stands in (`firstTurnWindow`). Null
   * only when nothing knows it, where the between-turn rule below covers the
   * first turn.
   */
  private async turnAutoCompact(
    run: Run,
    agent: AgentKind,
    model: string | null,
    configDir: string | null,
    contextWindow: string | null,
  ): Promise<TurnAutoCompact | null> {
    if (run.autoCompactPercent === null) {
      return null;
    }
    const window =
      this.contexts.read(run.id)?.window ??
      run.contextWindowTokens ??
      (await firstTurnWindow(
        this.adapterFor(agent),
        this.partials,
        model,
        configDir,
        contextWindow,
      ));
    if (window === null || window <= 0) {
      return null;
    }
    return { percent: run.autoCompactPercent, windowTokens: window };
  }

  /**
   * Compact a chat whose settled turn left its context at or over the run's
   * auto-compact threshold.
   *
   * It sends the adapter's own `/compact` through {@link sendMessage}, exactly
   * as if the user had typed it, so the compaction commits, reports and
   * refuses the same way a typed one does — including losing the race to a
   * message the user sent first, which is fine: the next settle checks again.
   */
  private async autoCompactIfDue(runId: string): Promise<void> {
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (
        !run ||
        run.status !== 'completed' ||
        run.archivedAt !== null ||
        run.autoCompactPercent === null ||
        !run.agentKind ||
        this.registry.has(runId) ||
        this.adapterFor(run.agentKind).geniroCommandFor(
          AUTO_COMPACT_COMMAND,
        ) === null
      ) {
        return;
      }
      const live = this.contexts.read(runId);
      const reading = {
        tokens: live?.tokens ?? run.contextTokens,
        window: live?.window ?? run.contextWindowTokens,
      };
      const baseline = this.compactionBaselines.get(runId);
      if (baseline === 'pending') {
        // Only a turn that reported no reading of its own reaches this — the
        // baseline is normally taken by the first reading after a compaction
        // (see `compactionBaselines`). With nothing measured since, the last
        // known size is the best answer, and nothing has shown regrowth.
        if (reading.tokens !== null) {
          this.compactionBaselines.set(runId, reading.tokens);
        }
        return;
      }
      if (!autoCompactDue(run.autoCompactPercent, reading, baseline ?? null)) {
        return;
      }
      // Sent FIRST: a message the user sent a moment earlier can still win the
      // claim, and a note written ahead of that refusal would announce a
      // compaction that never ran.
      await this.sendMessage(runId, AUTO_COMPACT_COMMAND);
      // Its own catch: the compaction is already running by now, so a failed
      // note must not be reported as a compaction that never started.
      const notice = autoCompactNotice(run.autoCompactPercent, reading);
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        { message: notice, severity: 'info' },
      ).catch((err: unknown) => {
        this.logger.warn(
          `run ${runId} auto-compaction note write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    } catch (err) {
      this.logger.warn(
        `run ${runId} auto-compaction did not start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Finish a compaction geniro performed ITSELF: drop the CLI's conversation
   * and put the summary aside for the turn that replaces it.
   *
   * Two writes and they are ordered, because only one order is recoverable. The
   * summary is stored FIRST: a daemon that dies between them leaves a run whose
   * session is intact and whose next turn carries the summary as well — a
   * conversation that repeats itself, which is untidy. The reverse leaves a
   * dropped session with nothing to carry, which is the conversation gone.
   *
   * A turn that did not COMPLETE, or completed saying nothing, commits neither
   * and says so. That covers the cases that matter: the user pressed Stop
   * partway through the summary, the CLI failed, the agent answered with
   * whitespace. Destroying the conversation on the strength of any of those
   * buys the user nothing and costs them everything they were working on — so
   * the compaction is ABANDONED, in a transcript row rather than silently,
   * because the user asked for something and is entitled to know it did not
   * happen.
   */
  private async commitCarriedCompaction(
    em: EntityManager,
    runId: string,
    commandName: string,
    settledStatus: RunStatus | null,
    summary: string | null,
  ): Promise<void> {
    const carried = summary?.trim() ?? '';
    if (settledStatus !== 'completed' || carried === '') {
      await this.persist(
        em,
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        {
          message:
            settledStatus === 'completed'
              ? `/${commandName} produced no summary — the conversation was left as it was.`
              : `/${commandName} did not finish — the conversation was left as it was.`,
          // A WARNING, and the one of the pair that is: the user asked for
          // something and it did not happen.
          severity: 'warning',
        },
      ).catch((err: unknown) => {
        this.logger.error(
          `run ${runId} abandoned-compaction note failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return;
    }
    await this.runDao.setPendingContext(runId, carried, em);
    await this.nodeStateDao.clearSessionId(runId, SINGLE_AGENT_NODE, em);
    // Clearing the id is not enough on a KEPT process: a later turn is opened
    // on the session it already holds, so the summary would be sent into the
    // very conversation it replaced and the window would never shrink.
    this.sessions.retire(runId, 'its conversation was compacted');
    // The conversation this run's context figure was measured on has just been
    // DISCARDED — the next turn opens a fresh session carrying the summary
    // above. REPORTED as "после компакта кружочек не обновляется, он всё ещё
    // так же заполнен": nothing reports a smaller window here, because there
    // is nothing yet to report on, so the pre-compaction reading stood as the
    // newest thing the run knew. There is no replacement figure to write —
    // see {@link RunDao.forgetContext}. The registry's count goes with the
    // stored one: it is what the status announce stamps onto the row, so a
    // count left there put the pre-compaction figure back on the ring one event
    // later. The CLI path (`forgetContext` above) clears both for the same reason.
    this.contexts.forgetTokens(runId);
    await this.runDao.forgetContext(runId, em);
    await this.persist(
      em,
      runId,
      await this.seqs.reserve(runId),
      'system',
      null,
      {
        // INFO, not the failure chrome every other daemon notice wears: this
        // row reports the thing the user just ASKED for having worked, and
        // rendered as a warning it reads as the compaction having gone wrong.
        message:
          'Conversation compacted. The agent starts fresh from the summary ' +
          'above; everything before it is no longer in its context.',
        severity: 'info',
        // The marker that says the CLI's conversation was REPLACED here, so a
        // client can stop reading context figures from above this row — the
        // transcript is the only place those survive once the run row has been
        // cleared. Its own key rather than the `compaction` one a relayed CLI
        // summary carries: that one identifies a wall of prose to collapse, and
        // this row is a sentence geniro wrote.
        //
        // TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`'s
        // `conversationReplaced`.
        conversationReplaced: true,
      },
    ).catch((err: unknown) => {
      // The compaction ITSELF has already happened — this row only explains
      // it, and losing the explanation must not look like losing the work.
      this.logger.error(
        `run ${runId} compaction note failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Hand a message to the turn that is ALREADY running, or refuse so the
   * caller can queue it.
   *
   * The order is deliberate and is the whole safety of this path: the CLI gets
   * the message FIRST, and only a delivery it confirmed is written to the
   * transcript. Persisting first and then failing to deliver would leave a user
   * message on screen that no agent ever received — the silent failure this is
   * meant to replace — while the reverse loses at worst a transcript row for a
   * message the agent is demonstrably answering.
   *
   * A refusal is a plain RUN_BUSY, identical to the one the claim used to
   * throw, so a CLI with no mid-turn channel needs no special handling
   * anywhere above: the renderer queues it and drains on settle exactly as
   * before.
   */
  private async deliverIntoRunningTurn(
    runId: string,
    text: string,
    images: SendMessageImage[],
    backgroundWork?: FollowUpBackgroundWork,
    joined?: { row: HostRowWire; deliveryId: string },
  ): Promise<ItemWire> {
    const busy = new ConflictException(
      'RUN_BUSY',
      'a turn is already in progress for this run',
    );
    // Null for a run that is only CLAIMED — reserved microseconds ago by a
    // concurrent send, with no process to write to yet.
    const handle = this.registry.runningHandle(runId);
    if (!handle) {
      throw busy;
    }
    const cancels = handle.subagentsAFollowUpCancels?.() ?? 0;
    if (backgroundWork === 'ask' && cancels > 0) {
      throw subagentsWouldBeCancelled(cancels);
    }
    // Written before the send because the payload the adapter builds reads
    // these files. A delivery that then fails leaves them unreferenced under
    // the run's own attachments directory, which its teardown removes wholesale
    // — the same place a failed first-turn send already leaves them.
    const attachments = images.map((image) =>
      this.attachments.save(runId, image.mediaType, image.data),
    );
    // Names this row to the turn: a driver that accepts the message but never
    // gets it to the agent reports it by this id (`follow_up_dropped`), and the
    // renderer pairs that report back to the row through the same key.
    // TWIN PARSER: `apps/ui/src/renderer/chats/not-sent-messages.ts` reads the
    // row's `deliveryId`; rename it on both sides.
    const deliveryId = joined?.deliveryId ?? randomUUID();
    const delivered = handle.sendUserMessage({
      text,
      images: attachments.map((attachment) => ({
        path: this.attachments.pathOf(runId, attachment.id),
        mediaType: attachment.mediaType,
      })),
      deliveryId,
      ...(backgroundWork === 'cancel' ? { cancelBackgroundWork: true } : {}),
    });
    if (!delivered) {
      throw busy;
    }
    if (joined !== undefined) {
      return this.persist(
        this.em.fork(),
        runId,
        await this.seqs.reserve(runId),
        'system',
        null,
        joined.row,
      );
    }
    // The other write that changes no status: a follow-up joins a turn that is
    // already `running`, so without this the row keeps the timestamp of when
    // that turn began and the thread the user is typing in sinks past ones they
    // have not touched.
    void this.noteUserActivity(runId);
    const em = this.em.fork();
    // Its OWN seq, allocated now: the follow-up belongs after everything the
    // turn has already written, not at the position it would have had when the
    // user pressed send.
    //
    // From the run's ALLOCATOR, never from `maxSeq`. This is the exact seam
    // the duplicate-seq defect lived in: the turn running underneath this call
    // holds reservations the table cannot show, so a database read handed this
    // message the number the turn had already claimed for its next item — and
    // the renderer, which de-dupes by seq, then dropped whichever arrived
    // second. That was reliably the agent's reply, which is why the reported
    // symptom was "it deletes its last message".
    const seq = await this.seqs.reserve(runId);
    return this.persist(em, runId, seq, 'message', 'user', {
      text,
      ...(attachments.length > 0 ? { images: attachments } : {}),
      deliveryId,
      // NOT stamped with how it was sent. A `midTurn: true` flag used to ride
      // here so the renderer could caption the row ("Sent into the turn already
      // running — the agent picks this up when its current step finishes"),
      // explaining why a message written behind a long tool call sits there
      // while the live row goes on naming the tool that was already running.
      // The caption was reported as noise under every such message and removed,
      // and the flag went with it rather than staying as a key nothing reads —
      // a payload key with no reader is indistinguishable from one whose reader
      // was lost. Bringing the explanation back means bringing both back.
    });
  }

  /** Take a chat's kept host tools down — see {@link keptHostTools}. */
  private dropKeptHostTools(runId: string): void {
    for (const dispose of this.keptHostTools.get(runId) ?? []) {
      dispose();
    }
    this.keptHostTools.delete(runId);
  }

  /**
   * Install a chat's host tools that hold nothing of the turn — see
   * {@link keptHostTools}. Out here, off the turn's own scope, so a sink kept
   * past it cannot close over anything of it: each row is written on a fork of
   * its own.
   */
  private keepHostTools(runId: string, agentName: string): void {
    this.dropKeptHostTools(runId);
    /**
     * geniro's own findings channel: the tool hands over an already-parsed
     * report, this writes the one row the card is drawn from.
     *
     * Nothing is parked, unlike {@link askUser}: the agent is not waiting on
     * a person, only on the row being durable. Resolving on the persist is
     * also what keeps the receipt honest — it says the findings are on
     * screen, and by then they are.
     */
    const reportFindings = async (
      report: HostFindingsReport,
    ): Promise<HostFindingsOutcome> => {
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'report_findings',
          null,
          this.attributeCard(runId, report),
        );
      } catch (err) {
        // The row IS the card, so a row that was never written is a report
        // nobody will ever see. Said so, rather than answered with a count
        // the agent would take as delivery — but the REASON is logged here
        // and kept here: a persist failure names an absolute database path,
        // and this string is handed to a model whose provider is off this
        // machine. The MCP host's own error path refuses the same thing.
        this.logger.error(
          `run ${runId} could not persist a findings report: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return { status: 'recorded', count: report.findings.length };
    };
    /**
     * geniro's own chart channel — {@link reportFindings}'s twin, and
     * deliberately its structural copy rather than a shared helper: what the
     * two share is the SINK contract, which {@link HostSinkBroker} already
     * holds, while the item kind, the payload and the receipt's counts are
     * each tool's own. Folding them together would buy four lines and cost
     * the ability to give either one a different failure.
     */
    const drawChart = async (chart: HostChart): Promise<HostChartOutcome> => {
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'show_chart',
          null,
          this.attributeCard(runId, chart),
        );
      } catch (err) {
        // Logged here and kept here, for the reason spelled out above: a
        // persist failure names an absolute database path, and the string
        // this returns is handed to a model whose provider is off this
        // machine.
        this.logger.error(
          `run ${runId} could not persist a chart: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return {
        status: 'drawn',
        series: chart.series.length,
        // The labels ARE the points: every series was aligned to them at the
        // reader, so this is the x-axis length rather than any one series'.
        points: chart.labels.length,
      };
    };
    /**
     * geniro's own scorecard channel — {@link drawChart}'s twin, and its
     * structural copy for the reason spelled out there: what the drawing
     * tools share is the SINK contract, which `HostSinkBroker` already holds,
     * while the item kind, the payload and the receipt's count belong to each
     * tool alone.
     */
    const drawMetrics = async (
      metrics: HostMetrics,
    ): Promise<HostMetricsOutcome> => {
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'show_metrics',
          null,
          this.attributeCard(runId, metrics),
        );
      } catch (err) {
        // Logged here and kept here, like its siblings: a persist failure
        // names an absolute database path, and the string this returns is
        // handed to a model whose provider is off this machine.
        this.logger.error(
          `run ${runId} could not persist a scorecard: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return { status: 'drawn', count: metrics.metrics.length };
    };
    /**
     * geniro's own comparison channel — the third of the drawing twins, and
     * its structural copy for the reason spelled out at {@link drawChart}.
     */
    const drawComparison = async (
      comparison: HostComparison,
    ): Promise<HostComparisonOutcome> => {
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'show_comparison',
          null,
          this.attributeCard(runId, comparison),
        );
      } catch (err) {
        // Logged here and kept here, like its siblings: a persist failure
        // names an absolute database path, and the string this returns is
        // handed to a model whose provider is off this machine.
        this.logger.error(
          `run ${runId} could not persist a comparison: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return {
        status: 'drawn',
        options: comparison.options.length,
        criteria: comparison.criteria.length,
      };
    };
    /**
     * geniro's own gallery channel — the fourth drawing twin, and its
     * structural copy for the reason spelled out at {@link drawChart}.
     *
     * What is NOT copied is any reading of the files: this stores the paths
     * the gallery names — the agent's, or the files a URL was downloaded to
     * before the call reached here — and nothing else. The renderer fetches
     * each one over
     * the image route, which owns the guards, so a picture that has since
     * moved or was never there costs one broken tile rather than a failed
     * call — and the agent is told the row landed, which is the only thing
     * this step actually did.
     */
    const drawGallery = async (
      gallery: HostGallery,
    ): Promise<HostGalleryOutcome> => {
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'show_gallery',
          null,
          this.attributeCard(runId, gallery),
        );
      } catch (err) {
        // Logged here and kept here, like its siblings: a persist failure
        // names an absolute database path, and the string this returns is
        // handed to a model whose provider is off this machine.
        this.logger.error(
          `run ${runId} could not persist a gallery: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return { status: 'drawn', images: gallery.images.length };
    };
    /**
     * geniro's own artifact channel — the agent publishing a page it wrote.
     *
     * Unlike its five drawing siblings this one STORES before it persists,
     * and the order is load-bearing in the same direction persist-then-emit
     * is: the row advertises a page, so the page has to exist before any
     * reader can be told about it. A store failure therefore returns without
     * writing a row at all, where a row written first would name a document
     * the artifact route answers 404 for, permanently, in the scrollback.
     *
     * The row carries the DESCRIPTOR and never the html — the same split the
     * gallery makes, for a sharper version of the same reason. A transcript
     * is replayed whole on every reopen, and a conversation that published a
     * handful of 512KB pages would otherwise pay for all of them on every
     * load, forever.
     */
    const publishArtifact = async (
      artifact: HostArtifact,
    ): Promise<HostArtifactOutcome> => {
      const stored = await this.artifactStore.publish(runId, artifact);
      if (!stored.ok) {
        return { status: 'rejected', reason: stored.reason };
      }
      const row: HostArtifactRow = {
        artifactId: stored.stored.artifactId,
        version: stored.stored.version,
        title: artifact.title,
        key: stored.stored.key,
        ...(artifact.summary === undefined
          ? {}
          : { summary: artifact.summary }),
      };
      try {
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'show_artifact',
          null,
          this.attributeCard(runId, row),
        );
      } catch (err) {
        // Logged here and kept here, like its siblings: a persist failure
        // names an absolute database path, and the string this returns is
        // handed to a model whose provider is off this machine.
        this.logger.error(
          `run ${runId} could not persist an artifact: ${err instanceof Error ? err.message : String(err)}`,
        );
        return {
          status: 'unavailable',
          reason: 'the transcript row could not be written',
        };
      }
      return {
        status: 'published',
        artifactId: stored.stored.artifactId,
        version: stored.stored.version,
      };
    };
    /**
     * geniro's own notification channel — the agent telling the user,
     * outside the app, that it is done (`HOST_NOTIFY_TOOL`).
     *
     * Writes no row. The message rides the client-wide `run_status`
     * broadcast, which is what reaches a window not looking at this chat —
     * and a notification is only ever for that window.
     */
    const notifyUser = (message: string): Promise<HostNotifyOutcome> => {
      this.bus.publishRunStatus({ runId, status: null, notify: message });
      return Promise.resolve({ status: 'sent' });
    };
    const actionContext = {
      runId,
      rowNodeId: null,
      publisher: { nodeId: SINGLE_AGENT_NODE, conversationId: '' },
    };
    this.keptHostTools.set(runId, [
      this.findingsReports.register(runId, SINGLE_AGENT_NODE, reportFindings),
      this.charts.register(runId, SINGLE_AGENT_NODE, drawChart),
      this.metrics.register(runId, SINGLE_AGENT_NODE, drawMetrics),
      this.comparisons.register(runId, SINGLE_AGENT_NODE, drawComparison),
      this.galleries.register(runId, SINGLE_AGENT_NODE, drawGallery),
      this.artifacts.register(runId, SINGLE_AGENT_NODE, publishArtifact),
      this.notices.register(runId, SINGLE_AGENT_NODE, notifyUser),
      ...(this.browser === undefined
        ? []
        : [
            this.browser.register(
              runId,
              SINGLE_AGENT_NODE,
              this.browserSinkOf(this.browser, runId, agentName),
            ),
          ]),
      this.actionSinks.register(runId, SINGLE_AGENT_NODE, {
        publish: (input) => this.actionPublisher.publish(actionContext, input),
        remove: (actionId) =>
          this.actionPublisher.remove(actionContext, actionId),
      }),
      ...(this.runOutcomes === undefined
        ? []
        : [
            this.runOutcomes.register(runId, SINGLE_AGENT_NODE, {
              persistItem: async (_memberId, kind, role, payload) =>
                this.persist(
                  this.em.fork(),
                  runId,
                  await this.seqs.reserve(runId),
                  kind,
                  role,
                  payload,
                ),
              recorder: () => ({
                memberId: SINGLE_AGENT_NODE,
                conversationId: null,
                callId: null,
              }),
            }),
          ]),
    ]);
  }

  /**
   * A dropped follow-up that was a message from another thread goes back to
   * the mailbox under one info row, and leaves the event what the user wrote
   * themselves: null when nothing is left to report as not sent.
   */
  private async withoutReturnedMessages(
    runId: string,
    event: AgentEvent,
  ): Promise<AgentEvent | null> {
    if (event.type !== 'follow_up_dropped' || !this.threadInbox) {
      return event;
    }
    const returned = await this.threadInbox.returnDropped(event.deliveryIds);
    if (returned.deliveryIds.length === 0) {
      return event;
    }
    await this.persist(
      this.em.fork(),
      runId,
      await this.seqs.reserve(runId),
      'system',
      null,
      threadMessageReturnedRow(returned.titles),
    );
    const left = event.deliveryIds.filter(
      (id) => !returned.deliveryIds.includes(id),
    );
    return left.length === 0 ? null : { ...event, deliveryIds: left };
  }

  /**
   * Stamp a render-family card with the delegate that drew it, whenever the
   * turn can say which one that is.
   *
   * These rows are written by the host-tool sinks rather than by
   * `mapEventToItem`, which is where every OTHER row gets its
   * `parentToolUseId` — so without this they arrive attributed to the main
   * thread.
   *
   * WHETHER a delegate can be named is the turn's judgment and not this
   * service's: {@link AgentTurnHandle.attributableDelegate} owns the conditions
   * and answers null the moment any of them fails.
   *
   * TWIN PARSER: the renderer reads this key back in
   * `apps/ui/src/renderer/chats/subagent-payload.ts` (`subagentIdOf`), which
   * files the card under that thread. The payload crosses the wire as
   * `z.unknown()`, so nothing generated spans the seam and a rename on either
   * side compiles clean.
   */
  private attributeCard<T extends object>(
    runId: string,
    payload: T,
  ): T & { parentToolUseId?: string } {
    const delegate =
      this.registry.runningHandle(runId)?.attributableDelegate() ?? null;
    return delegate === null
      ? payload
      : { ...payload, parentToolUseId: delegate };
  }

  /**
   * Say in the transcript when a turn started without servers geniro's own
   * reading says are connected — and clear the record that held them back
   * (`AgentMcpService.observeTurnServers`). Unawaited: the report is the turn's
   * own housekeeping, and the note may land a row or two after it.
   */
  private noteMcpMismatch(
    runId: string,
    agent: AgentKind,
    cwd: string,
    configDir: string | null,
    servers: readonly AgentMcpServer[],
  ): void {
    if (this.agentMcp === undefined) {
      return;
    }
    void this.agentMcp
      .turnMismatchNotice(agent, cwd, configDir, servers)
      .then(async (message) => {
        if (message === null || this.deleting.has(runId)) {
          return;
        }
        await this.persist(
          this.em.fork(),
          runId,
          await this.seqs.reserve(runId),
          'system',
          null,
          { message, severity: 'info' },
        );
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not note the MCP servers its turn started without: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private async persist(
    em: EntityManager,
    runId: string,
    seq: number,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
    /**
     * Which member the row belongs to. Null — the chat path's own answer — for
     * everything but a row this service writes ON BEHALF of a team member,
     * which today is a stranded delegate's close.
     */
    memberId: string | null = null,
  ): Promise<ItemWire> {
    return persistItemAndEmit(
      {
        itemDao: this.itemDao,
        bus: this.bus,
        calls: this.calls,
        seqs: this.seqs,
      },
      em,
      {
        runId,
        memberId,
        seq,
        kind,
        role,
        payload,
      },
    );
  }

  /**
   * Record this chat's settled turns its CLI did not time
   * (`WallWorkService.catchUpChat`). Bookkeeping, so a failure is logged and
   * never fails the turn — any later catch-up, or the boot sweep, records the
   * turn still missing.
   */
  private async catchUpWallWork(runId: string): Promise<void> {
    await this.wallWork.catchUpChat(runId).catch((err: unknown) => {
      this.logger.warn(
        `run ${runId}: wall work not measured: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * The run row for the wire, with its live "parked on the user" reading folded
   * in from the registry.
   *
   * Every chat route projects through here, so the snapshot a reconnecting
   * window loads agrees with the `run_status` broadcasts it will then receive —
   * a run parked on a question emits nothing further by definition, so a client
   * that missed the transition has only this to learn it from.
   */
  private toRunWire(run: Run, reads: RunWireRead): RunWire {
    return runToWire(
      run,
      reads.preview,
      this.awaitingOf(run.id),
      this.heldRuns.get(run.id) ?? 0,
      this.configDirPins.forRun(run.agentKind, run.cwd),
      this.backgroundWork.shellsOpen(run.id),
      this.backgroundWork.subagentsOut(run.id),
      0,
      0,
      reads.wallMs,
      this.monitors?.list(run.id).length ?? 0,
      reads.projectName,
    );
  }

  /**
   * What {@link toRunWire} needs read for these runs beyond the row: each
   * one's newest transcript rows, and its wall-measured worked time — the
   * turns its CLI did not time (`WallWorkService`), served on top of the
   * CLI-reported `Run.workedMs`. Two queries however many runs.
   */
  private async wireReads(
    runs: readonly Pick<Run, 'id' | 'projectId'>[],
    em: EntityManager,
  ): Promise<{ of: (runId: string) => RunWireRead }> {
    const runIds = runs.map((run) => run.id);
    const projectOfRun = new Map(runs.map((run) => [run.id, run.projectId]));
    const [previews, wall, projectNames] = await Promise.all([
      this.itemDao.runPreviews(runIds, em),
      this.wallTurns.chatSums(runIds, em),
      this.projectScope.liveNamesOf(runs.map((run) => run.projectId)),
    ]);
    return {
      of: (runId) => ({
        preview: previews.get(runId) ?? null,
        wallMs: wall.get(runId) ?? null,
        projectName: projectNames.get(projectOfRun.get(runId) ?? '') ?? null,
      }),
    };
  }
}
