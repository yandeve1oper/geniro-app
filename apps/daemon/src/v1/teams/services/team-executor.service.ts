import { randomUUID } from 'node:crypto';

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
import type {
  AgentEvent,
  AgentMcpServer,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalResolution,
  InstalledApprovalSupport,
  SessionCloseCause,
  TurnImage,
} from '../../agents/adapters/adapter.types';
import type { AgentAdapter } from '../../agents/adapters/agent-adapter';
import {
  type AttachmentWire,
  type BrowserHostCardInput,
  type ChatListScope,
  type ChatTotalsWire,
  type FollowUpBackgroundWork,
  HOST_BROWSER_HOST_CARD,
  HOST_QUESTION_TOOL,
  type HostArtifact,
  type HostArtifactOutcome,
  type HostArtifactRow,
  type HostProjectInstructions,
  type HostProjectInstructionsOutcome,
  type HostQuestion,
  type HostQuestionOutcome,
  type HostRowWire,
  type HostWakeOpener,
  type ItemWire,
  type PersistedResetWake,
  type RunCallSeed,
  type RunListPage,
  type RunWire,
  type SendMessageImage,
  type StandingHostQuestion,
} from '../../agents/chat.types';
import {
  CALL_CONTEXT_SNAPSHOT_LIMIT,
  CallContextDao,
} from '../../agents/dao/call-context.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { ActionBroker } from '../../agents/services/action.broker';
import {
  type ActionPublishContext,
  ActionPublishService,
} from '../../agents/services/action-publish.service';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { AgentMcpService } from '../../agents/services/agent-mcp.service';
import { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import { ApprovalRegistry } from '../../agents/services/approval-registry';
import { ArtifactBroker } from '../../agents/services/artifact.broker';
import { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import {
  BROWSER_SESSION_OPTION,
  BROWSER_SESSION_VERDICT_OPTION,
  BrowserBroker,
  type BrowserSink,
} from '../../agents/services/browser.broker';
import {
  CommandEndWakeService,
  memberWakeOwner,
} from '../../agents/services/command-end-wake.service';
import { GoalWritersBroker } from '../../agents/services/goal-writers.broker';
import { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { McpHarvestStore } from '../../agents/services/mcp-harvest.store';
import { MessageSendService } from '../../agents/services/message-send.service';
import { MonitorBroker } from '../../agents/services/monitor.broker';
import { MonitorRegistry } from '../../agents/services/monitor.registry';
import {
  partialOwnerKey,
  PartialStreamService,
} from '../../agents/services/partial-stream.service';
import { ProcessRegistry } from '../../agents/services/process-registry';
import { ProjectInstructionsBroker } from '../../agents/services/project-instructions.broker';
import { PullRequestCaptureService } from '../../agents/services/pull-request-capture.service';
import { RunGroupsService } from '../../agents/services/run-groups.service';
import { RunKindRowsCache } from '../../agents/services/run-kind-rows.cache';
import { RunOutcomeBroker } from '../../agents/services/run-outcome.broker';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import { SkillHarvestStore } from '../../agents/services/skill-harvest.store';
import { TeamNoteBroker } from '../../agents/services/team-note.broker';
import { TeamProposalBroker } from '../../agents/services/team-proposal.broker';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { UserQuestionBroker } from '../../agents/services/user-question.broker';
import { WallWorkService } from '../../agents/services/wall-work.service';
import { SPAN_ROW_KINDS } from '../../agents/utils/active-spans';
import {
  type AgentOptionsSnapshot,
  readAgentOptions,
  writeAgentOptions,
} from '../../agents/utils/agent-options';
import {
  deliverApprovalAnswer,
  isUserQuestion,
} from '../../agents/utils/approval-answer';
import {
  AUTO_COMPACT_COMMAND,
  autoCompactDue,
  autoCompactNotice,
  type AutoCompactReading,
} from '../../agents/utils/auto-compact';
import { BackgroundWorkCounts } from '../../agents/utils/background-work-counts';
import { callClocksFrom } from '../../agents/utils/call-clock';
import {
  CALL_RECORDS,
  callNumber,
  readCallSeed,
} from '../../agents/utils/call-seed';
import {
  adapterQuestionOf,
  asksForSecret,
} from '../../agents/utils/card-questions';
import { withCarriedContext } from '../../agents/utils/carried-context';
import { CompactionRows } from '../../agents/utils/compaction-rows';
import { effortListed } from '../../agents/utils/effort-listed';
import {
  endsOffTurnStretch,
  mapEventToItem,
  restatesRunAsWorking,
  terminalStatus,
} from '../../agents/utils/event-to-item';
import { firstTurnWindow } from '../../agents/utils/first-turn-window';
import { subagentsWouldBeCancelled } from '../../agents/utils/follow-up-background-work';
import { isHostArtifactAnswersCall } from '../../agents/utils/host-artifact';
import { isHostBrowserCall } from '../../agents/utils/host-browser';
import { hostEndpointPath } from '../../agents/utils/host-endpoint';
import { isHostKnowledgeCall } from '../../agents/utils/host-knowledge';
import { isHostMemoryCall } from '../../agents/utils/host-memory';
import { isHostProjectInstructionsCall } from '../../agents/utils/host-project-instructions';
import {
  hostCardQuestions,
  hostMcpServerName,
  hostQuestionCardInput,
  isHostQuestionCall,
} from '../../agents/utils/host-question';
import {
  isHostTeamProposalCall,
  standingProposalCardId,
} from '../../agents/utils/host-teams';
import { threadCardFields } from '../../agents/utils/host-thread-message';
import { asRecord, parseJsonColumn } from '../../agents/utils/json-util';
import { sanitizeModelParameters } from '../../agents/utils/model-parameters';
import { offersMonitorTools } from '../../agents/utils/monitor-offer';
import { wakesOnMonitorProgress } from '../../agents/utils/monitor-text';
import {
  readNodePoolMembers,
  readNodePoolPins,
} from '../../agents/utils/node-pool-members';
import {
  delegateCloseEvent,
  ownerFields,
  processEndedCloseEvent,
  strandedDelegates,
} from '../../agents/utils/open-delegates';
import {
  launchingCallOf,
  shellCloseEvent,
  shellCommandOf,
  type StrandedShell,
  strandedShells,
} from '../../agents/utils/open-shells';
import { persistItemAndEmit, runToWire } from '../../agents/utils/persist-item';
import {
  nodePolledSpend,
  pollsSpendFor,
  withNodePolledSpend,
} from '../../agents/utils/polled-spend';
import {
  conversationsBill,
  readPolledSpendLedger,
} from '../../agents/utils/polled-spend-ledger';
import { resolveValidConfigDir } from '../../agents/utils/resolve-config-dir';
import { resolveValidCwd } from '../../agents/utils/resolve-cwd';
import { assertTeamRun, type TeamRun } from '../../agents/utils/run-kind';
import {
  readPersistedResetWakes,
  resetWakesWire,
} from '../../agents/utils/run-reset-wakes';
import {
  type RunStatusAnnounce,
  writeRunStatus,
} from '../../agents/utils/run-status';
import {
  callSessionKey,
  nodeSessionKey,
  runSessionKeyPrefix,
} from '../../agents/utils/session-keys';
import { isSlashCommand } from '../../agents/utils/session-replacement-notes';
import { createSessionIdSaver } from '../../agents/utils/session-saver';
import {
  snapshotNodePoolProfiles,
  snapshotPoolKinds,
} from '../../agents/utils/snapshot-config-dirs';
import {
  askThroughStanding,
  hostQuestionOutcomeOf,
  StandingQuestions,
} from '../../agents/utils/standing-questions';
import { teamProjectCardId } from '../../agents/utils/team-project-card';
import {
  threadMessagesPrompt,
  threadMessagesRow,
} from '../../agents/utils/thread-message-text';
import {
  ANSWERABILITY_KINDS,
  unanswerablePayload,
  unansweredRequests,
} from '../../agents/utils/unanswerable';
import {
  addUsage,
  carriesUsage,
  emptyTotals,
  turnMemberOf,
  USAGE_ITEM_KINDS,
  type UsageFigures,
  usageFiguresFrom,
} from '../../agents/utils/usage-figures';
import {
  cliTurnDurationMs,
  servedWorkedMs,
} from '../../agents/utils/wall-worked';
import { KnowledgeService } from '../../knowledge/services/knowledge.service';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { placedFacts } from '../../projects/utils/placed-facts';
import {
  AgentKind,
  type ItemKind,
  type RunStatus,
} from '../../runs/runs.types';
import type {
  CalleePoolPlan,
  CalleeTurnOutcome,
  CallHoldRelease,
  MemberQuestionCards,
  NodeStateWire,
  PoolSkip,
  ResetWakesCancelled,
  SetPoolMemberResult,
  ShellStillOut,
  Team,
  TeamAgentPoolMember,
  TeamMember,
} from '../teams.types';
import { CALL_START_BRIEF_MAX } from '../teams.types';
import {
  callPoolHandOffPrompt,
  conversationStartMember,
  fallsThroughPool,
  nodePoolHandOffPrompt,
  nodePoolHandOffRow,
  poolAttempts,
  poolHandOffNotice,
  poolHandOffPrompt,
  poolMemberNode,
  poolMembersOf,
  poolMoveNotice,
  poolSize,
  poolSwitchNotice,
} from '../utils/agent-pool';
import { geniroSideFailure, readCalleeFailure } from '../utils/callee-failure';
import {
  callerConversationOf,
  callerKey,
  callerNodeOf,
} from '../utils/caller-key';
import {
  callToolsAdmitted,
  instructionBlocksByMember,
  memberInstructionFields,
} from '../utils/member-instructions';
import {
  OPEN_WORK_KINDS,
  openCalls,
  openNodeTurns,
} from '../utils/open-call-work';
import { MAX_PARALLEL_AGENTS } from '../utils/parallelism';
import {
  advanceCacheClock,
  cacheExpiryOf,
  type ConversationCacheFacts,
  statedTtlOf,
  type TurnCacheClock,
} from '../utils/prompt-cache-standing';
import { resetWakePrompt } from '../utils/reset-wake-prompt';
import { initialStageProgress } from '../utils/stage-fold';
import { stageLabel, stageMapOf, stageNotice } from '../utils/stage-text';
import {
  calleesOf as calleesOfTeam,
  onDemandMemberIds,
  possibleLeadsOf,
  startingLeadOf,
  triggerMemberId,
} from '../utils/team-roster';
import { teamSnapshotOf } from '../utils/team-snapshot';
import { assertValidTeam } from '../utils/team-validate';
import { createTurnSemaphore, type TurnSlot } from '../utils/turn-semaphore';
import { CallBroker } from './call-broker.service';
import { RunTeamService } from './run-team.service';
import { StageService } from './stage.service';
import { TeamHealthService } from './team-health.service';
import { TeamOverlayService } from './team-overlay.service';
import { TeamStoreService } from './team-store.service';

/** How one member's turn ended (the run-level rollup derives from these). */
type NodeOutcome = 'completed' | 'failed' | 'cancelled' | 'skipped';

/**
 * The statuses a member's turn ENDS on — the ones an off-turn stretch may take
 * the badge from, and hand it back to.
 *
 * `pending` and `running` are deliberately absent and are not an oversight: a
 * member that has yet to start has no turn to carry on from, and one already
 * running is drawn as working by the turn that is running it. Restating either
 * would write a `running` row that nothing balances, and the renderer counts
 * those rows (`computeAgentActivity`) rather than reading a level.
 */
const NODE_OUTCOMES: ReadonlySet<string> = new Set<NodeOutcome>([
  'completed',
  'failed',
  'cancelled',
  'skipped',
]);

/**
 * How many times one call may be continued inside itself after its callee
 * ended a turn waiting on calls of its own (`CallBroker.holdCall`). Past it
 * the call settles on the answer it has, telling its caller what is still
 * running — a callee that keeps delegating and waiting is bounded here the way
 * a cursor turn's delegate wakes are (`MAX_DELEGATE_WAKES`).
 */
const MAX_CALL_WAKES = 10;

/**
 * How many times one call may be continued inside itself with its callee's
 * monitor output — a budget of its own, so a CI watch reporting step after
 * step does not spend the waits its delegations are owed. Past it the
 * callee's monitors are stopped and the call settles on the answer it has.
 */
const MAX_MONITOR_WAKES = 50;

/** How a team conversation took a monitor's output. */
export type MonitorWake = 'woken' | 'busy' | 'refused';

export interface StartTeamRunInput {
  /** Library slug — persisted as `Run.teamId`. */
  slug: string;
  team: Team;
  /** Shared working folder every member runs in. */
  cwd: string;
  /** The user's task — seeds every member's prompt. */
  prompt: string;
  /** Pictures pasted with the task, for the agents the trigger feeds. */
  images?: SendMessageImage[];
  /**
   * The app's global custom instructions, snapshotted onto the run like a
   * chat's. Every member composes it BEHIND its own `instructions`.
   */
  customInstructions?: string;
  /** The app's reply language, snapshotted onto the run like a chat's. */
  replyLanguage?: string;
  /**
   * What the board card this run works asks of it — its label instructions and
   * the report ask, already composed. Absent for a run started from the
   * library; every member composes it right after the user's own text.
   */
  taskInstructions?: string;
  /**
   * The user's per-CLI switches, snapshotted onto the run like the
   * instructions above; each member's turn carries its own CLI's slice.
   */
  agentOptions?: AgentOptionsSnapshot;
  /** The folder's commit and dirty flag when the run started (`Run.startSha`). */
  startSha?: string;
  startDirty?: boolean;
  /**
   * The board card this run was started for, when one was.
   *
   * Absent for every run started from the team library, which is the case
   * `Run.taskId` describes as "a run nobody started from a card". A task run
   * sets it because it is one half of the run↔task edge — `Task.runId` is the
   * other, written by `TaskRunsService` in the same operation — and without it
   * `TaskSettleService` cannot move the card when the run finishes.
   */
  taskId?: string;
  /**
   * That card's identifier (`GEN-12`), on `taskId`'s own terms and passed in
   * for the same reason it is on the chat path: see `Run.taskIdentifier`.
   */
  taskIdentifier?: string;
  /**
   * A name for the run, overriding the deliberate `title: null` below.
   *
   * Only a caller that has a better name than the seed prompt passes one, and
   * today that is a task run, whose card already carries the title a person
   * wrote. Nothing else should: see the block at the `title` field for why a
   * run of a team must not be stamped with that team's own name.
   */
  title?: string;
  /**
   * The sidebar group to file this run under, overriding the team's own
   * auto-file rule.
   *
   * A task run belongs to its PROJECT's group — the same answer the chat arm of
   * `TaskRunsService` gives — because the run works in a worktree, a path no
   * folder rule has ever seen. Absent means resolve the rule as usual.
   */
  groupId?: string | null;
  /**
   * The project this run was started under by choice — a run configuration's
   * or the composer's pick, reaching every member: an id binds it, null means
   * none, absent leaves it to the card and the folder (`ProjectScopeService`).
   */
  projectId?: string | null;
}

/** How long a message waits for a relay hand-off's turn to open before it goes to the new lead anyway. */
export const HANDOFF_START_GRACE_MS = 15_000;

/**
 * What each of the team's CLIs has proved about its approval modes, keyed
 * by agent kind.
 *
 * Awaited only for a CLI some member asks a PROBED mode of — a team that
 * asks for none never pays for a probe turn — and each CLI's answer is its own
 * adapter's, so no member is ever judged against another CLI's binary.
 */
async function approvalSupportByKind(
  team: Team,
  adapterFor: (kind: AgentKind) => AgentAdapter,
): Promise<Map<AgentKind, InstalledApprovalSupport>> {
  const needsProbe = new Map<AgentKind, boolean>();
  for (const node of team.members) {
    // A pool member runs its own approval mode — else the member's — on its
    // OWN CLI.
    for (const { agent, approval } of poolMembersOf(node)) {
      const probed = adapterFor(agent)
        .getConfig()
        .approval.probedModes.includes(approval ?? node.approval);
      needsProbe.set(agent, (needsProbe.get(agent) ?? false) || probed);
    }
  }
  const support = new Map<AgentKind, InstalledApprovalSupport>();
  for (const [kind, probed] of needsProbe) {
    const adapter = adapterFor(kind);
    support.set(
      kind,
      probed
        ? await adapter.settledApprovalSupport()
        : adapter.currentApprovalSupport(),
    );
  }
  return support;
}

/**
 * One member setting that was dropped because its CLI cannot honour it — a
 * `configDir` on a CLI with no such mechanism, an `effort` level the CLI does
 * not list.
 *
 * ONE type for both, and one system-item template, because the two are the
 * same event: a value the team editor would have refused, arriving on a team
 * that came in as YAML, dropped rather than passed to a CLI that would either
 * ignore it or fail on it. A second parallel struct and loop is how the two
 * would drift into wording only one of them explains.
 *
 * Private to this file (only `withResolvedNodeSettings` produces it and only
 * `driveResolved` reads it), so it stays here rather than in `teams.types.ts`
 * — it is not part of the module's shared vocabulary and nothing on the wire
 * carries it.
 */
/**
 * The run-scoped facts every member of one walk shares.
 *
 * Bundled rather than appended as positionals, because the three are all
 * strings-or-null and sit adjacent: `string` is assignable to `string | null`,
 * so a transposition of `cwd`, `seedPrompt` and `customInstructions` is caught
 * in only one direction and the compiler would wave the other through. Each
 * new run-scoped snapshot is the same shape, so the next one goes in here
 * instead of widening two signatures again.
 */
/**
 * What one member turn ended with, read once its events have drained — see
 * `beginAgentTurn`'s `finish`.
 */
interface NodeTurnResult {
  outcome: NodeOutcome;
  finalText: string | null;
  sessionId: string | null;
  /** The last context reading the turn reported — what auto-compaction judges. */
  reading: AutoCompactReading;
  /**
   * The FIRST positive context reading the turn reported — its opening size,
   * which after a compaction is what that compaction left behind.
   */
  firstTokens: number | null;
  /** The registry key the turn ran under — the conversation it belongs to. */
  sessionKey: string;
  /**
   * The last failure the CLI itself reported this turn, verbatim — what a CALLER
   * is told instead of the constant this field replaced. Null when the turn
   * reported none, which for a `failed` outcome means the failure was geniro's
   * own. See `utils/callee-failure.ts`.
   */
  error: string | null;
  /** Whether the turn called any tool of its own — whether it did any work. */
  madeToolCalls: boolean;
  /**
   * The prompt-cache lifetime the turn's CLI reported, or null when it stated
   * none — what a caller is later told about this conversation's cache.
   */
  promptCacheTtlMs: number | null;
}

interface RunContext {
  /** Shared working folder every member runs in, already canonicalized. */
  cwd: string;
  /** The user's task — seeds every member's prompt. */
  seedPrompt: string;
  /** The member this pass starts and a message goes to: the run's lead as the pass begins. */
  lead: string | null;
  /** The run's snapshotted global instructions; every member composes it. */
  customInstructions: string | null;
  /** The run's snapshotted reply language; every member composes it. */
  replyLanguage: string | null;
  /** The run's snapshotted project instructions; every member composes them. */
  projectInstructions: string | null;
  /** The run's snapshotted memory index; every member composes it. */
  memoryIndex: string | null;
  /** The run's snapshotted knowledge index; every member composes it. */
  knowledgeIndex: string | null;
  /** Whether the run switches each CLI's own memory off (`Run.nativeMemoryOff`). */
  nativeMemoryOff: boolean;
  /** The card's instructions for a task run; every member composes them too. */
  taskInstructions: string | null;
  /** The run's snapshotted per-CLI switches; each member reads its CLI's slice. */
  agentOptions: AgentOptionsSnapshot;
  /**
   * Each member's CLI session from an earlier pass of this run, so a follow-up
   * carries every agent's conversation on instead of starting it over. Empty
   * on a run's first pass.
   */
  resumeSessions: ReadonlyMap<string, string>;
  /** The pool member holding each member's own conversation after a hand-off. */
  nodePoolMembers: ReadonlyMap<string, number>;
  /**
   * Members whose own conversation the user pinned to its pool member, each
   * with whether the pin moved it off another member.
   */
  nodePoolPins: ReadonlyMap<string, boolean>;
  /**
   * Each member's context window as an earlier pass recorded it. Every user
   * message starts a pass and nearly every trigger-member turn is a pass's FIRST, so
   * without this those turns never carried the member's `--autocompact` threshold.
   */
  nodeWindows: ReadonlyMap<string, number>;
  /**
   * The calls an earlier pass of this run made, read back off the transcript
   * so this pass's call ids continue past them and their conversations can be
   * continued — see `RunCallSeed`. Null on a run's first pass.
   */
  callSeed: RunCallSeed | null;
  /**
   * The seed row is already written: a follow-up persists its message before
   * the walk starts, because the route answers with that row.
   */
  seedPersisted: boolean;
  /** Pictures that came with the seed — for the agents a trigger feeds. */
  seedImages: TurnImage[];
  /** The same pictures as the seed row's attachments, when this pass writes it. */
  seedAttachments: readonly AttachmentWire[];
}

/** How a follow-up reaches a team run that is still being walked. */
interface LiveRunControl {
  /**
   * Hand the message to the agents the trigger feeds. Null once the run has
   * finished, which leaves the caller to walk it again from the trigger.
   */
  deliver(
    text: string,
    images: SendMessageImage[],
    backgroundWork?: FollowUpBackgroundWork,
  ): Promise<ItemWire | null>;
  /** Hand the message to the callee of ONE running call — see `deliverToCall`. */
  deliverToCall(
    memberId: string,
    callId: string,
    text: string,
    images: SendMessageImage[],
  ): Promise<ItemWire>;
  /** Hand a message from another thread to the lead's running turn. */
  joinThreadMessage(join: ThreadMessageJoin): Promise<ThreadMessageJoinAnswer>;
  /**
   * Pin the member's own conversation to pool member `member` on the pass's
   * write chain, so no turn of it starts halfway through: `busy` while a turn
   * of it runs, `unchanged` when it is already pinned there, else `now` with
   * `row(from, previousSessionId, moved)` written. A move leaves the session,
   * so the next turn starts on `member` from a transcript excerpt.
   */
  pinPoolMember(
    memberId: string,
    member: number,
    row: (
      from: number,
      previousSessionId: string | null,
      moved: boolean,
    ) => Record<string, unknown>,
  ): Promise<'now' | 'unchanged' | 'busy'>;
}

/**
 * A message from another thread going into the lead's running turn. `row` is
 * what the run shows for it; `onDropped` runs when the turn gave it back.
 * `overBudget`: the thread has taken its joins for this hour.
 */
export interface ThreadMessageJoin {
  prompt: string;
  row: HostRowWire;
  deliveryId: string;
  overBudget: boolean;
  onDropped: () => void;
}

/**
 * `idle`: no turn of the lead to join. `busy`: one that cannot take it now.
 * `question`: one parked on the user's question, which reads nothing until they answer.
 * `over_budget`: one that could, and the thread has taken its joins this hour.
 */
export type ThreadMessageJoinAnswer =
  'joined' | 'busy' | 'idle' | 'question' | 'over_budget';

/** The refusal for a message addressed to a call that is not running. */
function callNotRunning(): ConflictException {
  return new ConflictException(
    'CALL_NOT_RUNNING',
    'this call is no longer running — message the team instead',
  );
}

/** A user message row's payload — pictures only when there are any. */
function messagePayload(
  text: string,
  stored: readonly AttachmentWire[],
): { text: string; images?: AttachmentWire[] } {
  return {
    text,
    ...(stored.length > 0 ? { images: [...stored] } : {}),
  };
}

interface DroppedNodeSetting {
  memberId: string;
  /** The member's own name, or its id when unnamed — the same fallback every
   * other user-facing mention of a member uses. */
  name: string;
  /** What the setting is called in the sentence, e.g. `a config directory`. */
  setting: string;
  /** What the member asked for, quoted back so the user can find it. */
  value: string;
  /** The adapter's own sentence, shown to the user unchanged. */
  reason: string;
}

/**
 * A copy of `team` whose members carry the CANONICAL form of their
 * config directory, refusing any that cannot be used.
 *
 * Two things at once, deliberately: the refusal (a bad path fails the run
 * once, up front, rather than one member halfway through the run) and the
 * canonicalization (what a turn spawns with must be what was actually
 * checked — `resolveValidCwd` one line above has always worked this way, and
 * a `configDir` that stayed raw could reach argv as a symlink re-pointed
 * after the check).
 *
 * A member whose CLI declares no plugin mechanism has the field STRIPPED — not
 * validated, not refused, not passed on. Refusing a whole run over a path that
 * adapter would ignore would be geniro inventing a failure, and handing it to
 * the turn anyway would be geniro going silent, which is the very thing this
 * field exists to prevent. Only the in-memory run copy is stripped; the
 * team on disk keeps whatever the user wrote.
 *
 * Every strip is REPORTED back, because "stripped quietly" is its own version
 * of going silent: a team imported from YAML can carry a `configDir` on a
 * CLI that has no such mechanism — the team editor never offered the field, so the
 * user never saw it refused — and the run would otherwise proceed as though
 * the member had never named one. The caller turns each entry into a run-level
 * system item carrying the adapter's own reason.
 */
function withResolvedNodeSettings(
  team: Team,
  adapterFor: (kind: AgentKind) => AgentAdapter,
): { team: Team; dropped: DroppedNodeSetting[] } {
  const dropped: DroppedNodeSetting[] = [];
  const members = team.members.map((node) => {
    const drop =
      (member: number) =>
      (setting: string, value: string, reason: string): void => {
        dropped.push({
          memberId: node.id,
          name: node.name,
          setting:
            node.pool && node.pool.length > 0
              ? `${setting} (pool member ${member})`
              : setting,
          value,
          reason,
        });
      };
    // Every pool member is checked as the member itself is: each runs
    // under its own CLI, which is the one whose vocabulary decides.
    const resolved = resolveMemberSettings(node, adapterFor, drop(1));
    return resolved.pool
      ? {
          ...resolved,
          pool: resolved.pool.map((member, index) =>
            resolveMemberSettings(member, adapterFor, drop(index + 2)),
          ),
        }
      : resolved;
  });
  return { team: { ...team, members }, dropped };
}

/**
 * One configuration's CLI settings — a member's own, or one pool member's —
 * checked against that configuration's CLI: an unusable value is reported
 * through `drop` and removed, a usable path canonicalized.
 */
function resolveMemberSettings<T extends TeamAgentPoolMember>(
  settings: T,
  adapterFor: (kind: AgentKind) => AgentAdapter,
  drop: (setting: string, value: string, reason: string) => void,
): T {
  let resolved = settings;
  if (resolved.configDir) {
    const reason = adapterFor(resolved.agent).getConfig().configDir
      .unavailableReason;
    if (reason === null) {
      resolved = {
        ...resolved,
        configDir: resolveValidConfigDir(resolved.configDir),
      };
    } else {
      drop('a config directory', resolved.configDir, reason);
      resolved = { ...resolved, configDir: undefined };
    }
  }
  if (resolved.effort) {
    // Asked of the ADAPTER, never of a list here: the levels are the CLI's
    // own, and `listEfforts` is already the one answer the composer's picker
    // and this run agree on.
    //
    // Only for a CLI whose list is COMPLETE, which is the same rule
    // `EffortsService.accepts` follows. A CLI whose levels belong to the
    // MODEL has only a union here, and `gpt-5.2`'s `extra-high` is absent
    // from it — dropping against that stripped a level a chat accepts, so the
    // same value ran at the CLI's default on a member while the app reported it
    // as unsupported. There the turn's own driver checks the value against
    // the model that runs it and reports what does not apply.
    const adapter = adapterFor(resolved.agent);
    const levels = adapter.listEfforts();
    const effort = resolved.effort;
    if (effortListed(adapter, effort) === false) {
      drop(
        'a reasoning effort',
        effort,
        adapter.getConfig().effortsUnavailableReason ??
          (levels.length === 0
            ? `${resolved.agent} lists no reasoning-effort levels`
            : `${resolved.agent} accepts only ${levels.map((level) => level.id).join(', ')}`),
      );
      resolved = { ...resolved, effort: undefined };
    }
  }
  if (resolved.modelParameters) {
    // Bounded in count and value length through the SAME sanitizer the chat
    // path applies to a run's stored settings — an imported team arrives
    // as YAML the user could have hand-edited, and without this its member
    // parameters reached the turn with no cap at all.
    resolved = {
      ...resolved,
      modelParameters: sanitizeModelParameters(resolved.modelParameters),
    };
  }
  return resolved;
}

/**
 * The team executor: a pass starts the member the trigger names, and every
 * other member runs when a member calls it (`CallBroker`), all in the shared
 * cwd. Built on the chat path's execution substrate — the adapters,
 * `ProcessRegistry` (via one aggregate handle per run, so cancel/shutdown
 * reaps every live CLI group), and persist-then-emit ordering: all of a run's
 * writes serialize through one promise chain, so `seq` stays monotonic even
 * while N members stream at once. The run rolls up to
 * completed / failed / cancelled once the pass's turns and calls settle.
 */

@Injectable()
export class TeamExecutorService
  implements OnModuleInit, BeforeApplicationShutdown
{
  private readonly logger = new Logger(TeamExecutorService.name);

  /**
   * Set once the daemon has begun shutting down, BEFORE anything reaps a
   * turn — the executor twin of `ChatService`'s flag, and for its reason.
   *
   * The reap happens in `onApplicationShutdown`, which Nest runs only after
   * every `beforeApplicationShutdown`: `ProcessRegistry` cancels each run's
   * aggregate handle and `AgentSessionRegistry` closes each member's kept
   * process. Either way the walk rolled up `cancelled` (or `failed`, when a
   * process was closed under its turn first), and the task board read quitting
   * the app as the user stopping the card. A pass that ends that way without
   * anyone having pressed Stop is left `running`, for the next boot's
   * {@link reconcileOrphanedRuns} to close as interrupted.
   */
  private shuttingDown = false;

  beforeApplicationShutdown(): void {
    this.shuttingDown = true;
  }

  /**
   * Runs whose delete is in progress — the team twin of ChatService's
   * `deleting` Set, covering the same window.
   *
   * `startRun` claims the run, then `drive` awaits the capability probes before
   * `driveResolved` registers the aggregate handle. A delete landing in there
   * finds no handle to wait on, destroys the rows, and the walk would then
   * register and write a whole run's items for a run that no longer exists.
   */
  private readonly deleting = new Set<string>();

  /**
   * The runs being walked right now, each with the one way a follow-up can
   * reach its agents while they are live — see {@link sendMessage}.
   */
  private readonly liveRuns = new Map<string, LiveRunControl>();
  /**
   * The pool member the user picked for a member's own conversation while a
   * turn of it ran, by run then member — applied when its next turn starts.
   */
  private readonly poolChoices = new Map<string, Map<string, number>>();
  private readonly runSettledListeners = new Set<(runId: string) => void>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly pullRequests: PullRequestCaptureService,
    private readonly itemDao: ItemDao,
    private readonly messageSends: MessageSendService,
    private readonly nodeStateDao: NodeStateDao,
    private readonly callContextDao: CallContextDao,
    private readonly bus: AgentEventBus,
    private readonly registry: ProcessRegistry,
    private readonly sessions: AgentSessionRegistry,
    private readonly approvals: ApprovalRegistry,
    private readonly adapters: AgentAdapterRegistry,
    private readonly callTokens: CallTokenRegistry,
    private readonly callBroker: CallBroker,
    private readonly skillHarvest: SkillHarvestStore,
    private readonly mcpHarvest: McpHarvestStore,
    private readonly store: TeamStoreService,
    private readonly runTeams: RunTeamService,
    private readonly teardown: RunTeardownService,
    private readonly groups: RunGroupsService,
    @Inject(RUNTIME_TOKEN) private readonly runtime: RuntimeInfo,
    private readonly partials: PartialStreamService,
    private readonly attachments: AttachmentStoreService,
    private readonly seqs: ItemSeqAllocator,
    private readonly calls: ItemCallIndexService,
    private readonly wallWork: WallWorkService,
    private readonly wallTurns: WallTurnDao,
    private readonly kindRows: RunKindRowsCache,
    private readonly memory: MemoryService,
    private readonly knowledge: KnowledgeService,
    private readonly projectScope: ProjectScopeService,
    private readonly overlays: TeamOverlayService,
    /**
     * The page tool (`show_artifact`) for team agents. Optional only so the
     * executor's specs, which construct it positionally, need not supply it.
     */
    @Optional() private readonly artifacts?: ArtifactBroker,
    @Optional() private readonly artifactStore?: ArtifactStoreService,
    @Optional() parallelism?: number,
    @Optional() private readonly agentMcp?: AgentMcpService,
    /** The button tools (`publish_action`), optional on `artifacts`' terms. */
    @Optional() private readonly actionSinks?: ActionBroker,
    @Optional() private readonly actionPublisher?: ActionPublishService,
    /** The monitor tools, optional on `artifacts`' terms. */
    @Optional() private readonly monitors?: MonitorRegistry,
    @Optional() private readonly monitorSinks?: MonitorBroker,
    /** The team-note tools, optional on `artifacts`' terms. */
    @Optional() private readonly teamNotes?: TeamNoteBroker,
    /** `record_outcome`, optional on `artifacts`' terms. */
    @Optional() private readonly runOutcomes?: RunOutcomeBroker,
    @Optional() private readonly stages?: StageService,
    @Optional() private readonly health?: TeamHealthService,
    /** Messages from other threads, drained at a lead's turn. Optional on `artifacts`' terms. */
    @Optional() private readonly threadInbox?: ThreadInboxService,
    /** The in-app browser's tools, optional on `artifacts`' terms. */
    @Optional() private readonly browser?: BrowserBroker,
    /** The lead's `read_teams` / `propose_team`, optional on `artifacts`' terms. */
    @Optional() private readonly teamProposals?: TeamProposalBroker,
    /** The lead's `save_project_instructions`, optional on `artifacts`' terms. */
    @Optional()
    private readonly projectInstructionCards?: ProjectInstructionsBroker,
    /** Who writes the run's goals (the lead alone), optional on `artifacts`' terms. */
    @Optional() private readonly goalWriters?: GoalWritersBroker,
    /** Wakes for members' commands that end between turns, optional on `artifacts`' terms. */
    @Optional() private readonly commandEndWakes?: CommandEndWakeService,
    /** geniro's own `ask_user_question`, optional on `artifacts`' terms. */
    @Optional() private readonly userQuestions?: UserQuestionBroker,
  ) {
    this.parallelism = parallelism ?? MAX_PARALLEL_AGENTS;
  }

  /**
   * The size of the pool a pass starts its members from and the ceiling of
   * its active-turn cap, defaulting to what the machine affords
   * ({@link MAX_PARALLEL_AGENTS}).
   *
   * - Pass members: those past the cap stay queued, and each settling member
   *   re-enters schedule(), which launches them as slots free up.
   * - Callee turns: a gate SEPARATE from the pass's pool (`activeTurns`, at
   *   most `Team.maxActiveTurns`), because a sync caller keeps its pass
   *   slot while blocked on its callee, so one shared pool would deadlock
   *   sync callers (every slot held by a caller, none left for their callees).
   *
   * A constructor argument purely as a TEST SEAM, on
   * `AgentSessionRegistry`'s `ceiling` terms: the specs pin a width so a
   * queueing case means the same thing on a 16GB box and a 128GB one.
   */
  private readonly parallelism: number;

  /** Each run's artifact publishers, disposed when the run is deleted. */
  private readonly artifactDisposers = new Map<string, (() => void)[]>();

  /** Each run's button publishers, on the same terms. */
  private readonly actionDisposers = new Map<string, (() => void)[]>();

  /** Each run's monitor sinks, on the same terms. */
  private readonly monitorDisposers = new Map<string, (() => void)[]>();

  /** Each run's team-note sinks, on the same terms. */
  private readonly teamNoteDisposers = new Map<string, (() => void)[]>();

  /** Each run's `record_outcome` sinks, on the same terms. */
  private readonly runOutcomeDisposers = new Map<string, (() => void)[]>();

  /** Each run's browser sinks, on the same terms. */
  private readonly browserDisposers = new Map<string, (() => void)[]>();

  /** Each run's lead-only card sinks (`registerLeadCardSinks`), on the same terms. */
  private readonly leadCardDisposers = new Map<string, (() => void)[]>();

  /** How the lead's `save_project_instructions` card is raised — set by `TeamCardsService`. */
  private leadProjectCards:
    | ((
        runId: string,
        change: HostProjectInstructions,
      ) => Promise<HostProjectInstructionsOutcome>)
    | null = null;

  /** How a member's deferred question card is raised and retired — set by `TeamCardsService`. */
  private memberQuestionCards: MemberQuestionCards | null = null;

  /**
   * How a monitor's output reaches one of a run's conversations — installed by
   * each pass over that pass's own turn machinery, whether or not the team
   * can call (`wakeNode` exists only where it can).
   */
  private readonly monitorWakers = new Map<
    string,
    (
      caller: string,
      prompt: string,
      row: HostRowWire,
      onDropped: (requeue: boolean) => void,
      opener: HostWakeOpener,
    ) => MonitorWake
  >();

  private readonly wakerStopped = new Map<string, () => boolean>();

  /** Told whenever one of a run's conversations ends its turn. */
  private readonly conversationTurnEndListeners = new Set<
    (runId: string, caller: string) => void
  >();

  /**
   * Whether output waits to be delivered to a conversation — the monitor
   * delivery's answer, installed by it, so a held call is not let go while it
   * still owes its callee a message.
   */
  private monitorOutputHeld: (runId: string, caller: string) => boolean = () =>
    false;

  /**
   * What to do when one of a LIVE run's sessions is closed by something other
   * than that run's own teardown — keyed by the session key it was opened
   * under, and consumed by the first close.
   *
   * The registry closes a kept process on its own account (it went unused,
   * the ceiling needed its slot, it went stale), and every delegate running
   * inside that process dies with it. `ChatService` states that ending for a
   * chat, but it cannot for a team run: the key it is handed is this
   * executor's composite one, and it must not write into a run whose rows are
   * numbered by this executor's own counter. So the executor listens for its
   * own keys.
   */
  private readonly sessionClosers = new Map<
    string,
    (cause: SessionCloseCause | null) => void
  >();

  /**
   * The summary an automatic CARRIED compaction owes the next turn on one
   * session key — a CLI whose compaction geniro performs itself
   * (`AgentGeniroCommand.replacesSession`) — and whose presence makes that turn
   * open a fresh session rather than resume the one it replaced. Per KEY
   * because a member's own conversation and each call conversation are compacted
   * apart.
   *
   * In memory: after a restart the summary is gone and the member resumes its
   * old session, which is intact — the conversation is merely not compacted.
   */
  private readonly carriedSummaries = new Map<string, string>();

  /**
   * Per session key, the context a conversation held when it was first
   * measured after an automatic compaction ('pending' until then) — the member
   * twin of `ChatService.compactionBaselines`; see `autoCompactDue`.
   */
  private readonly compactionBaselines = new Map<string, number | 'pending'>();

  /**
   * The conversations whose `running` an OFF-TURN stretch wrote, and what
   * each member's badge is handed back to when that stretch ends.
   *
   * A turn's terminal line ends what the AGENT was saying; the process is
   * kept, and it routinely opens a further turn of its own when work it
   * backgrounded reports back — a timer it set, a build it started. Its rows
   * are written by `onOffTurnEvent`; this is what says the member is WORKING
   * again, so its card does not read `completed` over work in progress.
   *
   * The team's half of `ChatService`'s `offTurnRuns`, and the same shape for
   * the same reason: the status to restore has to be REMEMBERED, since only
   * a `running` this stretch wrote is this stretch's to take back.
   *
   * Keyed by SESSION KEY rather than by member, because that is the grain of
   * the thing producing the events — one kept process — and a callable member
   * holds its own conversation and one per call it serves at once. Keyed by
   * member, two concurrent stretches would share one entry and the second
   * would write a `running` the restore never balances.
   *
   * SERVICE-scoped rather than per pass, because the process is: a stretch an
   * earlier pass's process opened is ended by the next turn on that process,
   * and that turn is routinely started by a LATER pass. Per pass, the later
   * pass's `persistTurnStart` looked in an empty map and the stretch's
   * `running` was never answered — measured on run `b98d7f8c`, where the
   * Researcher's call-3 stretch outlived call-5 (which continued it from the
   * next pass) and an empty `RESEARCHER · Whittling…` block stood at the end of
   * the transcript.
   */
  private readonly offTurnNodes = new Map<
    string,
    { memberId: string; callId: string | null; restoreTo: NodeOutcome }
  >();

  /**
   * How many detached commands and background sub-agents each team run
   * still has out — the chat path's own counter (`BackgroundWorkCounts`),
   * recorded from this executor's event sinks. A team run is listed in the
   * same sidebar as a chat and reported 0 for both figures, so its badge could
   * never reach the held state and its shelf never counted a delegate launched
   * earlier than the loaded page.
   */
  private readonly backgroundWork = new BackgroundWorkCounts((runId, patch) =>
    this.bus.publishRunStatus({ runId, status: null, ...patch }),
  );

  /**
   * Per run, the lead (or leads) inside a turn right now — what
   * `RunWire.rootsWorking` counts. Service-scoped rather than inside the walk
   * because the runs LISTING answers it too.
   */
  private readonly workingRoots = new Map<string, Set<string>>();

  private setRootWorking(
    runId: string,
    memberId: string,
    on: boolean,
    announce = true,
    monitorProgress = false,
  ): void {
    const roots = this.workingRoots.get(runId) ?? new Set<string>();
    if (roots.has(memberId) === on) {
      return;
    }
    if (on) {
      roots.add(memberId);
      this.workingRoots.set(runId, roots);
    } else {
      roots.delete(memberId);
      if (roots.size === 0) {
        this.workingRoots.delete(runId);
      }
    }
    if (announce) {
      this.bus.publishRunStatus({
        runId,
        status: null,
        rootsWorking: roots.size,
        ...(monitorProgress && roots.size === 0 ? { hostTurn: true } : {}),
      });
    }
  }

  /**
   * Mark a pass's roots working BEFORE its `running` is announced: a message
   * arriving between that status and the root's turn starting would otherwise
   * read the Manager as idle and bounce off "the team is still starting".
   */
  private markRootsStarting(runId: string, lead: string | null): void {
    if (lead !== null) {
      this.setRootWorking(runId, lead, true);
    }
  }

  /** Each live pass's hook for the run's lead changing, by run. */
  private readonly leadWatchers = new Map<string, (lead: string) => void>();

  /**
   * Who leads a run now — the member a message, a press and a pass go to:
   * the trigger's member in `lead` mode, the current stage's lead in `relay`
   * mode (`StageService` holds it with the progress).
   */
  private async leadNow(runId: string, team: Team): Promise<string | null> {
    return leadIn(
      team,
      team.mode === 'relay'
        ? (await this.stages?.current(runId))?.leadId
        : undefined,
    );
  }

  onModuleInit(): void {
    // Every way a run is destroyed announces it here — this executor's own
    // delete and the archive sweep's shared teardown alike — so the per-key
    // compaction facts are dropped whichever path took the run.
    this.bus.allDeleted().subscribe((runId) => {
      this.forgetCompactions(runId);
      this.workingRoots.delete(runId);
      this.leadWatchers.delete(runId);
      this.disposeHostPublishers(runId);
      // `deleteRun` forgets these itself; the archive sweep reaches this run
      // only through the shared teardown, so without this line a swept run's
      // detached commands stayed counted for the life of the daemon.
      this.backgroundWork.forget(runId);
    });
    this.stages?.onMoved((runId, moved) => {
      if (moved.lead !== null) {
        this.leadWatchers.get(runId)?.(moved.lead);
      }
    });
    this.sessions.onClosed((key, _interrupted, _exited, cause) => {
      const closer = this.sessionClosers.get(key);
      if (closer) {
        this.sessionClosers.delete(key);
        closer(cause);
      }
    });
    this.callBroker.useResetWakeHooks({
      save: (runId, wakes) => this.saveResetWakes(runId, wakes),
      wakeRestoredRun: (runId, wake) => {
        void this.wakeRestoredRun(runId, wake);
      },
      note: (runId, memberId, payload) => {
        void this.noteOnRun(runId, memberId, payload);
      },
    });
  }

  /**
   * The chain every write of a run's promised continues goes through, so two
   * saves in one tick land in the order they were made — the newest list is
   * the whole truth, and a reordered pair would leave the older one standing.
   */
  private resetWakeWrites: Promise<void> = Promise.resolve();

  /**
   * File a run's promised continues on its row, and tell every client — the
   * composer's "continues at" line is read off the row, and nothing else would
   * refresh it between full listings.
   */
  private saveResetWakes(runId: string, wakes: PersistedResetWake[]): void {
    this.resetWakeWrites = this.resetWakeWrites
      .then(async () => {
        await this.runDao.setResetWakes(
          runId,
          wakes.length === 0 ? null : JSON.stringify(wakes),
          this.em.fork(),
        );
        this.bus.publishRunStatus({
          runId,
          status: null,
          resetWakes: resetWakesWire(wakes),
        });
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not record its usage-limit continues: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * The team twin of `ChatService.noteMcpMismatch`: say on the member when its
   * turn started without servers geniro's own reading says are connected, and
   * clear the record that held them back.
   */
  private noteMcpMismatch(
    runId: string,
    memberId: string,
    callId: string | null,
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
        if (message !== null && !this.deleting.has(runId)) {
          // A callee's turn files the note in its call block, as its rows are.
          await this.noteOnRun(runId, memberId, {
            message,
            severity: 'info',
            ...(callId !== null ? { callId } : {}),
          });
        }
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `run ${runId}: could not note the MCP servers member ${memberId} started without: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** A transcript row on a run no pass is writing through right now. */
  private async noteOnRun(
    runId: string,
    memberId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      const em = this.em.fork();
      await this.persist(
        em,
        runId,
        memberId,
        await this.seqs.reserve(runId),
        'system',
        null,
        payload,
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not write a note: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Arm again every continue a run's row says geniro promised before this
   * daemon started — called once at boot, after the schema sync.
   *
   * Without it a restart in the hours a team waits on a usage limit dropped
   * the promise the agents were told to wait for, and nothing said so.
   */
  async rehydrateResetWakes(): Promise<void> {
    const em = this.em.fork();
    for (const run of await this.runDao.listRunsWithResetWakes(em)) {
      // A shelved run is inert, so its promise will never be kept — and the
      // row would go on saying it will, to whoever puts the run back.
      if (run.archivedAt !== null) {
        this.saveResetWakes(run.id, []);
        continue;
      }
      this.callBroker.restoreResetWakes(
        run.id,
        readPersistedResetWakes(run.resetWakes),
      );
    }
  }

  /**
   * Call off every continue promised to one run, on the user's own press.
   *
   * A row still naming continues nothing holds — an archived run's, whose
   * promise was never armed again — is cleared too, so the line promising one
   * goes away when it is pressed rather than lingering over nothing.
   */
  async cancelResetWakes(runId: string): Promise<ResetWakesCancelled> {
    const run = assertTeamRun(
      await this.runDao.getById(runId, this.em.fork()),
      runId,
    );
    const cancelledCallIds = this.callBroker.cancelResetWakes(runId);
    if (cancelledCallIds.length === 0 && run.resetWakes !== null) {
      this.saveResetWakes(runId, []);
    }
    return { cancelledCallIds };
  }

  /**
   * The reset has come for a promise a restart carried over, on a run no pass
   * has registered since: walk the run again with the continue as its seed.
   *
   * Only a promise to the run's TRIGGER-FED agents can be kept this way — the
   * walk is what reaches them, and it is the ordinary case (the Manager whose
   * Engineer hit the limit). A promise to an agent that only answers inside a
   * call has no turn a walk could open, and a run whose walk would ALSO start
   * agents that were not waiting cannot be walked for it either — both are
   * SAID instead of kept, with what to do about it.
   */
  private async wakeRestoredRun(
    runId: string,
    wake: PersistedResetWake,
  ): Promise<void> {
    const ids = wake.owners.flatMap((owner) =>
      owner.calls.map((call) => call.callId),
    );
    const unreachable = async (why: string): Promise<void> => {
      for (const owner of wake.owners) {
        await this.noteOnRun(runId, callerNodeOf(owner.owner), {
          severity: 'info',
          message: `The usage limit reset (${wake.resetsAt}), but ${why} — send this agent a message to pick up ${owner.calls.map((call) => call.callId).join(', ')}.`,
          resetWake: {
            phase: 'unreachable',
            instant: wake.instant,
            callIds: owner.calls.map((call) => call.callId),
          },
        });
      }
    };
    try {
      const em = this.em.fork();
      const run = await this.runDao.getById(runId, em);
      if (
        run === null ||
        run.teamId === null ||
        run.archivedAt !== null ||
        run.status === 'cancelled'
      ) {
        return;
      }
      const team = await this.runTeams.teamOf(assertTeamRun(run, runId), em);
      const lead = await this.leadNow(runId, team);
      if (
        !wake.owners.every(
          (owner) =>
            callerConversationOf(owner.owner) === null && owner.owner === lead,
        )
      ) {
        await unreachable(
          'geniro was restarted while it waited and this agent only answers inside a call',
        );
        return;
      }
      await this.walkAgain(
        em,
        assertTeamRun(run, runId),
        wake.owners
          .map((owner) => resetWakePrompt(wake.resetsAt, owner.calls))
          .join('\n\n'),
        [],
        {
          severity: 'info',
          message: `The usage limit reset (${wake.resetsAt}) — continuing ${ids.join(', ')}.`,
          resetWake: {
            phase: 'fired',
            instant: wake.instant,
            callIds: ids,
          },
        },
      );
    } catch (err) {
      this.logger.warn(
        `run ${runId}: could not continue after the usage-limit reset: ${err instanceof Error ? err.message : String(err)}`,
      );
      await unreachable('the run could not be started again');
    }
  }

  /**
   * The adapter driving one agent kind — the single kind→adapter dispatch in
   * this file. Every other per-CLI decision asks the adapter it returns; an
   * `if (agent === …)` anywhere else is a missing abstract method.
   */
  private adapterFor(kind: AgentKind): AgentAdapter {
    return this.adapters.for(kind);
  }

  /**
   * Write a team run's status AND announce it — the same helper the chat
   * path uses, so the two cannot drift. The chat sidebar lists team runs
   * beside chats, and a status written without the announce leaves that row's
   * badge stale until something else forces a refetch: "still running with no
   * active jobs", fixed for one row type and not the other.
   */
  private async setRunStatus(
    em: EntityManager,
    runId: string,
    status: RunStatus,
    announce: RunStatusAnnounce = {},
  ): Promise<void> {
    await writeRunStatus(
      { runDao: this.runDao, bus: this.bus, wallTurns: this.wallTurns },
      em,
      runId,
      status,
      announce,
    );
  }

  /**
   * The run-start composition (library lookup → run start) lives in the
   * service layer so the controller stays one-call and a future run-start
   * guard cannot be bypassed from the route.
   */
  async startRunBySlug(
    slug: string,
    input: Omit<StartTeamRunInput, 'slug' | 'team'>,
  ): Promise<RunWire> {
    const { team } = await this.store.get(slug);
    return this.startRun({ ...input, slug, team });
  }

  /**
   * Create the run + pending member states, persist the seed message, kick off
   * the pass, and return immediately — the transcript streams over the
   * bus → WS while the team works.
   */
  async startRun(input: StartTeamRunInput): Promise<RunWire> {
    const cwd = resolveValidCwd(input.cwd);
    const scopeFacts = {
      taskId: input.taskId ?? null,
      cwd,
      projectId: input.projectId,
    };
    const placement = await this.projectScope.placeNewRun(scopeFacts);
    // The project's overlay applies only to its DEFAULT team; every check
    // below and the snapshot read the team as this project runs it.
    const effective = await this.overlays.effective(
      input.slug,
      input.team,
      placement.projectId,
    );
    await this.assertMembersReady(effective.team);
    // Member settings are resolved HERE rather than per turn, for the same two
    // reasons `cwd` is: a bad config directory is a configuration mistake, so
    // refusing the run names it once up front instead of failing one member
    // halfway through the run — and the CANONICAL path is what the turn must
    // spawn with, since that is what was actually checked. The CLI itself would
    // say nothing: it ignores an unusable --plugin-dir silently
    // (probe-verified), which reads as "this member has no MCP servers".
    const { team, dropped } = await this.assertRunnable(effective.team);
    const lead = startingLeadOf(team);

    // Which sidebar group claims this run — by the TEAM first, which is the
    // rule a team exists for: one team runs over a dozen repositories,
    // so no folder names its runs. Resolved here for the reason the chat
    // service resolves its own here: this is the one place a team run row
    // is created, so the rule cannot be missed by a second caller.
    // A caller that names one WINS (a task run, for its project's group), and
    // a project chosen at start files the run in that project's group: both
    // are deliberate answers about where this run belongs, where the rule is
    // a guess made from a folder the run does not work in. An explicit null
    // is a caller saying "no group", which is also an answer — hence
    // `!== undefined` rather than a `??` that would re-resolve it.
    const groupId =
      input.groupId !== undefined
        ? input.groupId
        : await this.groups.groupForNewRun({
            cwd,
            teamId: input.slug,
            chosenProjectGroupId: placement.chosenProjectGroupId,
          });
    const placed = placedFacts(
      { ...scopeFacts, teamSlug: input.slug },
      placement,
    );
    const { indexIds, ...memory } = await this.memory.runSnapshot(placed);
    const knowledge = await this.knowledge.runSnapshot(placed);
    const em = this.em.fork();
    const run = await this.runDao.create(
      {
        teamId: input.slug,
        // The team as it is NOW, kept with the run: a later edit of the
        // library team must not reach this run (`Run.teamSnapshot`).
        teamSnapshot: teamSnapshotOf(effective.team),
        teamBaseSnapshot: teamSnapshotOf(input.team),
        teamOverlaySnapshot: effective.overlay
          ? JSON.stringify(effective.overlay)
          : null,
        stageProgress: initialStageProgress(effective.team),
        currentLead: lead,
        groupId,
        status: 'running',
        agentKind: null,
        cwd,
        model: null,
        // Snapshotted at run start, exactly as a chat does it — blank
        // normalizes to null so a cleared box and an untouched one are one
        // state. Every member of this run then composes the same text.
        customInstructions: input.customInstructions?.trim() || null,
        replyLanguage: input.replyLanguage?.trim() || null,
        projectId: placement.projectId,
        projectSource: placement.source,
        projectInstructions: placement.instructions,
        ...memory,
        ...knowledge,
        taskInstructions: input.taskInstructions?.trim() || null,
        agentOptions: writeAgentOptions(input.agentOptions),
        startSha: input.startSha ?? null,
        startDirty: input.startDirty ?? null,
        // NOT the team's name. A stamped title reads as "this run has been
        // named", which is what kept `ChatTitleService` off team runs
        // entirely — so every run of one team carried the identical row and
        // the sidebar said which TEAM three times and which TASK not once
        // (reported as "title generation should work for team as well").
        // Left null, `title === null` means unnamed here exactly as it does for
        // a chat, and the seed prompt names it a moment later. Nothing is
        // nameless in between: the renderer's own `runLabel` already falls back
        // to the team's name for an untitled team run, which is also
        // where that name now lives permanently — as the row's label chip.
        //
        // A CALLER may still name one, and exactly one does: a task run, whose
        // card carries a title a person wrote. That is the opposite of the
        // stamp this null exists to prevent — it names the WORK rather than
        // restating which team ran it.
        title: input.title?.trim() || null,
        taskId: input.taskId ?? null,
        taskIdentifier: input.taskIdentifier ?? null,
      },
      em,
    );
    // Announced as soon as the row is durable, ahead of the claim: every
    // refusal below leaves this row behind, and it must still be announced.
    this.bus.publishRunCreated({
      runId: run.id,
      createdAt: run.createdAt.toISOString(),
    });
    await this.memory.countIndexShows(indexIds);
    if (!this.registry.tryClaim(run.id)) {
      throw new ConflictException('RUN_BUSY', 'run is already executing');
    }
    // Call tokens are minted per caller member inside drive(); nothing to
    // revoke here yet — the catch keeps the
    // revokeRun call for symmetry with the settle path.
    let seed: { stored: AttachmentWire[]; turnImages: TurnImage[] };
    try {
      seed = this.storeImages(run.id, input.images ?? []);
      for (const member of input.team.members) {
        await this.nodeStateDao.createPending(run.id, member.id, em);
      }
      await this.setRunStatus(em, run.id, 'running');
    } catch (err) {
      // Failed before drive() registered the aggregate handle — drop the claim
      // and any call tokens, and close the run so it is not wedged as
      // permanently busy/running (mirror of the chat turn's pre-handle catch).
      this.registry.release(run.id);
      this.callTokens.revokeRun(run.id);
      await this.setRunStatus(em, run.id, 'failed').catch(() => {});
      throw err;
    }

    if (!this.registry.canStart(run.id)) {
      this.registry.release(run.id);
      this.callTokens.revokeRun(run.id);
      await this.setRunStatus(em, run.id, 'failed');
      throw new ConflictException(
        'RUN_STOPPING',
        'daemon shutdown started before the team could launch',
      );
    }
    this.markRootsStarting(run.id, lead);
    this.drive(
      em,
      run.id,
      team,
      {
        cwd,
        seedPrompt: input.prompt,
        lead,
        customInstructions: run.customInstructions,
        replyLanguage: run.replyLanguage,
        projectInstructions: run.projectInstructions,
        memoryIndex: run.memoryIndex,
        knowledgeIndex: run.knowledgeIndex,
        nativeMemoryOff: run.nativeMemoryOff === true,
        taskInstructions: run.taskInstructions,
        agentOptions: readAgentOptions(run.agentOptions),
        resumeSessions: new Map(),
        nodePoolMembers: new Map(),
        nodePoolPins: new Map(),
        nodeWindows: new Map(),
        callSeed: null,
        seedPersisted: false,
        seedImages: seed.turnImages,
        seedAttachments: seed.stored,
      },
      dropped,
    );

    const projectNames = await this.projectScope.liveNamesOf([run.projectId]);
    return runToWire(
      run,
      null,
      null,
      0,
      null,
      0,
      0,
      0,
      this.workingRoots.get(run.id)?.size ?? 0,
      null,
      0,
      projectNames.get(run.projectId ?? '') ?? null,
    );
  }

  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    const em = this.em.fork();
    // Kind-guarded mirror of ChatService.cancel (shared assert — the two
    // cancels converge on one registry key) + the 404 the chat siblings return.
    assertTeamRun(await this.runDao.getById(runId, em), runId);
    // Before the cancel, which can end a process at once: whatever closes the
    // run's processes from here — that, or a later close, since they are kept
    // past the Stop — says it was the Stop's.
    this.sessions.noteUserStop(runId);
    this.commandEndWakes?.forgetRun(runId);
    // The run's monitors end with it, waking nobody.
    this.monitors?.stopRun(runId, 'thread-stop');
    return { cancelled: this.registry.cancel(runId) };
  }

  /**
   * Wake one of a run's conversations with a monitor's output, as a turn of
   * its own after the one it is in: `busy` while that conversation's turn
   * runs (the caller holds the output for {@link onConversationTurnEnded}),
   * `refused` when no pass of the run can take it — stopped, deleted, or a
   * callee conversation whose call has already settled. `onDropped` is told
   * when a wake answered `woken` is dropped after all, before its turn could
   * start: `requeue` true when a user's message started the run's next pass
   * meanwhile (the caller holds the output again for that conversation's next
   * turn end), false when the run was stopped (the caller records what it
   * carried).
   */
  wakeConversation(
    runId: string,
    caller: string,
    prompt: string,
    row: HostRowWire,
    onDropped: (requeue: boolean) => void = () => undefined,
    opener: HostWakeOpener = 'monitor',
  ): MonitorWake {
    return (
      this.monitorWakers.get(runId)?.(caller, prompt, row, onDropped, opener) ??
      'refused'
    );
  }

  /** Whether any member still has a detached command or a background sub-agent out. */
  holdsBackgroundWork(runId: string): boolean {
    return (
      this.backgroundWork.shellsOpen(runId) > 0 ||
      this.backgroundWork.subagentsOut(runId) > 0
    );
  }

  canWake(runId: string): boolean {
    return (
      this.monitorWakers.has(runId) && this.wakerStopped.get(runId)?.() !== true
    );
  }

  async continueAsHost(
    runId: string,
    memberId: string,
    text: string,
    row: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const em = this.em.fork();
      const found = await this.runDao.getById(runId, em);
      if (
        found === null ||
        found.teamId === null ||
        found.archivedAt !== null
      ) {
        return false;
      }
      const run = assertTeamRun(found, runId);
      const team = await this.runTeams.teamOf(run, em);
      if ((await this.leadNow(runId, team)) !== memberId) {
        return false;
      }
      await this.walkAgain(em, run, text, [], row);
      return true;
    } catch (err) {
      this.logger.warn(
        `team run ${runId}: could not continue it through ${memberId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /** Into the lead's running turn, when a message from another thread can go there. */
  async joinThreadMessage(
    runId: string,
    join: ThreadMessageJoin,
  ): Promise<ThreadMessageJoinAnswer> {
    return (await this.liveRuns.get(runId)?.joinThreadMessage(join)) ?? 'idle';
  }

  /**
   * Open the lead a turn of its own for a waiting message: `prompt` opens it
   * and the turn's drain carries the message. A settled run is walked again,
   * only when it completed, since a stopped one starts nothing on its own.
   */
  async wakeLeadForThreadMessage(
    runId: string,
    prompt: string,
    row: HostRowWire,
    onDropped: (requeue: boolean) => void,
  ): Promise<MonitorWake> {
    const em = this.em.fork();
    const found = await this.runDao.getById(runId, em);
    if (found === null || found.archivedAt !== null) {
      return 'refused';
    }
    const run = assertTeamRun(found, runId);
    const lead = await this.leadNow(runId, await this.runTeams.teamOf(run, em));
    if (lead === null) {
      return 'refused';
    }
    const woke = this.wakeConversation(
      runId,
      callerKey(lead, null),
      prompt,
      row,
      onDropped,
      'host',
    );
    if (woke !== 'refused' || run.status !== 'completed') {
      return woke;
    }
    return (await this.continueAsHost(runId, lead, prompt, { ...row }))
      ? 'woken'
      : 'refused';
  }

  /** The conversation a message to this team run reaches, or null. */
  async threadLeadCaller(runId: string): Promise<string | null> {
    const em = this.em.fork();
    const found = await this.runDao.getById(runId, em);
    if (found === null || found.teamId === null) {
      return null;
    }
    const lead = await this.leadNow(
      runId,
      await this.runTeams.teamOf(assertTeamRun(found, runId), em),
    );
    return lead === null ? null : callerKey(lead, null);
  }

  /** A member's name as a thread shows it. */
  async memberNameOf(runId: string, memberId: string): Promise<string> {
    const em = this.em.fork();
    const found = await this.runDao.getById(runId, em);
    if (found === null || found.teamId === null) {
      return memberId;
    }
    const team = await this.runTeams.teamOf(assertTeamRun(found, runId), em);
    return (
      team.members.find((member) => member.id === memberId)?.name ?? memberId
    );
  }

  /** What the lead's own conversation last measured, for the cold-wake rule. */
  async leadCacheFacts(runId: string): Promise<ConversationCacheFacts | null> {
    const caller = await this.threadLeadCaller(runId);
    if (caller === null) {
      return null;
    }
    const lead = callerNodeOf(caller);
    let clock: TurnCacheClock | undefined;
    const statedTtls = new Map<string, number>();
    for (const turn of await this.kindRows.rowsOf(
      runId,
      USAGE_ITEM_KINDS,
      'fresh',
    )) {
      if (turn.memberId !== lead) {
        continue;
      }
      const payload = asRecord(parseJsonColumn(turn.payload));
      const agentKind = turnMemberOf(payload)?.agentKind ?? '';
      if (typeof payload?.callId !== 'string') {
        clock = advanceCacheClock(
          clock,
          turn.createdAt,
          payload,
          statedTtls.get(agentKind) ?? null,
        );
      }
      const stated = statedTtlOf(payload);
      if (stated !== null) {
        statedTtls.set(agentKind, stated);
      }
    }
    const row = await this.nodeStateDao.getByRunNode(
      runId,
      lead,
      this.em.fork(),
    );
    return {
      endedAt: clock?.endedAt ?? null,
      promptCacheTtlMs: clock?.promptCacheTtlMs ?? null,
      contextTokens: row?.contextTokens ?? null,
      contextWindowTokens: row?.contextWindowTokens ?? null,
    };
  }

  onRunSettledCompleted(listener: (runId: string) => void): () => void {
    this.runSettledListeners.add(listener);
    return () => {
      this.runSettledListeners.delete(listener);
    };
  }

  private notifyRunSettledCompleted(runId: string): void {
    for (const listener of this.runSettledListeners) {
      try {
        listener(runId);
      } catch (err) {
        this.logger.error(
          `team run ${runId}: a settle listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Be told whenever one of a run's conversations ends its turn. */
  onConversationTurnEnded(
    listener: (runId: string, caller: string) => void,
  ): () => void {
    this.conversationTurnEndListeners.add(listener);
    return () => {
      this.conversationTurnEndListeners.delete(listener);
    };
  }

  private notifyConversationTurnEnded(runId: string, caller: string): void {
    for (const listener of this.conversationTurnEndListeners) {
      try {
        listener(runId, caller);
      } catch (err) {
        this.logger.error(
          `team run ${runId} conversation ${caller}: a turn-end listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** Installed by the monitor delivery — see {@link monitorOutputHeld}. */
  setMonitorOutputHeld(
    check: (runId: string, caller: string) => boolean,
  ): void {
    this.monitorOutputHeld = check;
  }

  /** A callee's monitor ended unannounced: its held call may settle now. */
  reviewMonitorHold(runId: string, caller: string): void {
    this.callBroker.reviewHeldCallee(runId, caller);
  }

  /**
   * A follow-up message for a team run — handed to the agents its trigger
   * feeds, as though the trigger had fired again with this text.
   *
   * REPORTED as "i should be able to add message for team. In this case it
   * will just go to same trigger": the composer of a team run was disabled
   * outright, so a run could only be followed up by starting another that
   * remembered nothing of this one.
   *
   * Two shapes, decided by whether the run is still being walked. A LIVE run
   * holds those agents' processes, so the message joins the conversation each
   * one is in (`deliverFollowUp`, inside `driveResolved`). A SETTLED run is
   * walked again from its trigger with this message as the seed, every member
   * resuming its own earlier session — the same team and the same
   * conversations, one more pass.
   */
  async sendMessage(
    runId: string,
    text: string,
    images: SendMessageImage[] = [],
    clientMessageId?: string,
    backgroundWork?: FollowUpBackgroundWork,
  ): Promise<ItemWire> {
    const em = this.em.fork();
    const run = await this.assertRunTakesMessage(em, runId, text, images);
    this.commandEndWakes?.userSpoke(runId);
    return this.messageSends.send(runId, text, clientMessageId, async () => {
      // Not awaited: the message must reach the run in this same tick, ahead
      // of any wake already scheduled for it.
      void this.memberQuestionCards?.retireForUserMessage(runId);
      const live = this.liveRuns.get(runId);
      if (live) {
        const item = await live.deliver(text, images, backgroundWork);
        if (item !== null) {
          return item;
        }
      }
      return this.walkAgain(em, run, text, images);
    });
  }

  /** A user retry can replay its row after the addressed call has settled. */
  async sendCallMessage(
    runId: string,
    memberId: string,
    callId: string,
    text: string,
    images: SendMessageImage[] = [],
    clientMessageId?: string,
  ): Promise<ItemWire> {
    await this.assertRunTakesMessage(this.em.fork(), runId, text, images);
    return this.messageSends.send(runId, text, clientMessageId, async () => {
      const live = this.liveRuns.get(runId);
      if (!live) {
        throw callNotRunning();
      }
      return live.deliverToCall(memberId, callId, text, images);
    });
  }

  /** The refusals every message into a team run shares, whatever it targets. */
  private async assertRunTakesMessage(
    em: EntityManager,
    runId: string,
    text: string,
    images: readonly SendMessageImage[],
  ): Promise<TeamRun> {
    if (text.trim() === '' && images.length === 0) {
      throw new BadRequestException(
        'MESSAGE_EMPTY',
        'a message needs words or a picture',
      );
    }
    const run = assertTeamRun(await this.runDao.getById(runId, em), runId);
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        'this run is archived — unarchive it to send a message',
      );
    }
    return run;
  }

  /**
   * Walk a SETTLED run again from its trigger, with `text` as the seed.
   *
   * The claim is what a second follow-up, a delete or a cancel is refused
   * against, exactly as for a new run. A run whose last pass is still tearing
   * down holds it for a moment longer, which is a RUN_BUSY the renderer queues
   * on rather than an error.
   */
  private async walkAgain(
    em: EntityManager,
    run: TeamRun,
    text: string,
    images: SendMessageImage[],
    seedRow: Record<string, unknown> | null = null,
  ): Promise<ItemWire> {
    if (!this.registry.tryClaim(run.id)) {
      throw new ConflictException(
        'RUN_BUSY',
        'this run is still finishing — your message goes out once it has',
      );
    }
    let pass: Awaited<ReturnType<TeamExecutorService['prepareNextPass']>>;
    try {
      pass = await this.prepareNextPass(em, run, text, images, seedRow);
    } catch (err) {
      this.registry.release(run.id);
      throw err;
    }
    if (!this.registry.canStart(run.id)) {
      this.registry.release(run.id);
      await this.setRunStatus(em, run.id, 'failed');
      throw new ConflictException(
        'RUN_STOPPING',
        'daemon shutdown started before the team could continue',
      );
    }
    this.drive(em, run.id, pass.team, pass.context, pass.dropped);
    return pass.item;
  }

  /**
   * Everything a further pass needs before its walk starts.
   *
   * The team is the run's OWN copy, taken when it started — never the
   * library as it is now. Asked for as "old teams chats should not be
   * changed if i change current team": an edit made since is what the next
   * RUN of it runs, not what this one continues with. A run made before runs
   * kept a copy is frozen on this first read (`RunTeamService`). Each
   * member's recorded CLI session is collected so it can
   * resume, and the message row is written here rather than by the walk,
   * because the route answers with it.
   */
  private async prepareNextPass(
    em: EntityManager,
    run: TeamRun,
    text: string,
    images: SendMessageImage[],
    /**
     * The row to write in place of the user's message, for a pass GENIRO
     * starts (a promised continue) — the agents are handed `text` either way,
     * but the transcript must not show geniro's words as the user's.
     */
    seedRow: Record<string, unknown> | null = null,
  ): Promise<{
    team: Team;
    dropped: DroppedNodeSetting[];
    context: RunContext;
    item: ItemWire;
  }> {
    if (!run.cwd) {
      throw new BadRequestException(
        'RUN_NOT_CONFIGURED',
        'run is missing a working directory',
      );
    }
    const stored = await this.runTeams.teamOf(run, em);
    const { team, dropped } = await this.assertRunnable(stored);
    const cwd = resolveValidCwd(run.cwd);
    const resumeSessions = new Map<string, string>();
    const nodePoolMembers = new Map<string, number>();
    const nodePoolPins = new Map<string, boolean>();
    if (team.members.some((node) => node.pool?.length)) {
      const handOffs = await this.itemDao.poolHandOffRows(run.id, em);
      const pins = readNodePoolPins(handOffs);
      for (const [memberId, member] of readNodePoolMembers(handOffs)) {
        const node = team.members.find((node) => node.id === memberId);
        if (node !== undefined && poolMemberNode(node, member) !== null) {
          nodePoolMembers.set(node.id, member);
          const moved = pins.get(node.id);
          if (moved !== undefined) {
            nodePoolPins.set(node.id, moved);
          }
        }
      }
    }
    const nodeWindows = new Map<string, number>();
    const states = await this.nodeStateDao.listByRun(run.id, em);
    for (const state of states) {
      if (state.agentSessionId) {
        resumeSessions.set(state.memberId, state.agentSessionId);
      }
      if (state.contextWindowTokens !== null && state.contextWindowTokens > 0) {
        nodeWindows.set(state.memberId, state.contextWindowTokens);
      }
    }
    // The broker's call state is in memory and died with whichever daemon ran
    // the earlier pass; the transcript is what survived. Without this the
    // pass started over at `call-1` — colliding with the rows already there —
    // and every conversation the earlier pass had built was unreachable.
    const callSeed = readCallSeed(
      await this.kindRows.rowsOfView(run.id, CALL_RECORDS, 'fresh'),
    );
    // The member a pass starts is pending again, as it was the first time —
    // and so is any member added to the team since, which has no row yet.
    //
    // A CALL-ONLY member that already has a row keeps it. A pass never starts
    // it, so `pending` there would promise a turn no pass gives it, and erase
    // how its last call ended.
    const lead = await this.leadNow(run.id, team);
    const hasRow = new Set(states.map((state) => state.memberId));
    for (const node of team.members) {
      if (node.id !== lead && hasRow.has(node.id)) {
        continue;
      }
      await this.nodeStateDao.setStatus(
        run.id,
        node.id,
        { status: 'pending' },
        em,
      );
    }
    const { stored: storedImages, turnImages } = this.storeImages(
      run.id,
      images,
    );
    const item = await this.persist(
      em,
      run.id,
      null,
      await this.seqs.reserve(run.id),
      seedRow === null ? 'message' : 'system',
      seedRow === null ? 'user' : null,
      seedRow ?? messagePayload(text, storedImages),
    );
    this.markRootsStarting(run.id, lead);
    await this.setRunStatus(em, run.id, 'running');
    return {
      team,
      dropped,
      item,
      context: {
        cwd,
        seedPrompt: text,
        lead,
        customInstructions: run.customInstructions,
        replyLanguage: run.replyLanguage,
        projectInstructions: run.projectInstructions,
        memoryIndex: run.memoryIndex,
        knowledgeIndex: run.knowledgeIndex,
        nativeMemoryOff: run.nativeMemoryOff === true,
        taskInstructions: run.taskInstructions,
        agentOptions: readAgentOptions(run.agentOptions),
        resumeSessions,
        nodePoolMembers,
        nodePoolPins,
        nodeWindows,
        callSeed,
        seedPersisted: true,
        seedImages: turnImages,
        seedAttachments: [],
      },
    };
  }

  /**
   * Save a follow-up's pictures under the run, the way a chat's are saved: the
   * rows go in the message payload, the paths go to the CLI.
   */
  private storeImages(
    runId: string,
    images: SendMessageImage[],
  ): { stored: AttachmentWire[]; turnImages: TurnImage[] } {
    const stored = images.map((image) =>
      this.attachments.save(runId, image.mediaType, image.data),
    );
    return {
      stored,
      turnImages: stored.map((attachment) => ({
        path: this.attachments.pathOf(runId, attachment.id),
        mediaType: attachment.mediaType,
      })),
    };
  }

  /**
   * Delete a team run and everything it owns — a ONE-WAY DOOR, and the
   * team sibling of `ChatService.delete`. The chats sidebar lists both
   * kinds of run, so without this the team rows in it were undeletable:
   * the chat route refuses them (`NOT_A_CHAT_RUN`) precisely because deleting
   * one there would skip everything below.
   *
   * The teardown itself is shared ({@link RunTeardownService}). What is
   * team-specific: the settle promise is the run's AGGREGATE handle (it
   * resolves only after the pass's final status + `turn_complete` writes), and
   * the CallBroker's per-run call surface has no chat analogue.
   */
  async deleteRun(runId: string): Promise<{ deleted: boolean }> {
    const em = this.em.fork();
    assertTeamRun(await this.runDao.getById(runId, em), runId);

    // Claimed BEFORE the cancel, so a walk still crossing the claim→register
    // window sees the delete and abandons itself rather than registering
    // behind our back.
    this.deleting.add(runId);
    try {
      const purged = await this.teardown.purge(
        em,
        runId,
        this.registry.settled(runId),
      );
      this.backgroundWork.forget(runId);
      this.workingRoots.delete(runId);
      return purged;
    } finally {
      // The call surface dies with the run even if the purge threw half-way:
      // leaving it registered would let a child that outlived its run dispatch
      // into rows that are already (partly) gone.
      this.callBroker.unregisterRun(runId);
      this.disposeHostPublishers(runId);
      this.deleting.delete(runId);
    }
  }

  /**
   * Drop a run's host-tool sinks (pages, buttons, monitors, team notes,
   * outcomes) and
   * forget its team notes' read state — every way a run is destroyed calls
   * this.
   */
  private disposeHostPublishers(runId: string): void {
    this.commandEndWakes?.forgetRun(runId);
    this.poolChoices.delete(runId);
    for (const disposers of [
      this.artifactDisposers,
      this.actionDisposers,
      this.monitorDisposers,
      this.teamNoteDisposers,
      this.runOutcomeDisposers,
      this.browserDisposers,
      this.leadCardDisposers,
    ]) {
      for (const dispose of disposers.get(runId) ?? []) {
        dispose();
      }
      disposers.delete(runId);
    }
    this.monitorWakers.delete(runId);
    this.wakerStopped.delete(runId);
    // A browser card is deferred, so no member's settle retires it; the run's
    // destruction does, with nothing written for a transcript that is gone.
    this.approvals.sweepDeferred(runId);
    this.teamNotes?.forgetRun(runId);
    this.runOutcomes?.forgetRun(runId);
    this.stages?.forget(runId);
  }

  private async stageNoticeOf(runId: string): Promise<string | null> {
    const loaded = (await this.stages?.current(runId)) ?? null;
    return loaded === null ? null : stageNotice(loaded.stages, loaded.progress);
  }

  /**
   * Give each member of this pass geniro's PAGE tool (`show_artifact`),
   * the one a chat has had since the family existed. Re-registered every pass,
   * which the broker's identity-checked disposers make safe, and deliberately
   * NOT disposed at the pass's end: a kept process goes on working between
   * passes, and its rows are recorded there like any other.
   */
  private registerArtifactPublishers(
    runId: string,
    memberIds: readonly string[],
    persistItem: (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
  ): void {
    const broker = this.artifacts;
    const store = this.artifactStore;
    if (broker === undefined || store === undefined) {
      return;
    }
    // The previous pass's publishers go first: each holds that pass's whole
    // scope (its database fork, its queues), and without this every pass of a
    // long-lived run added another set that only a delete would release.
    for (const dispose of this.artifactDisposers.get(runId) ?? []) {
      dispose();
    }
    const disposers: (() => void)[] = [broker.markTeamRun(runId)];
    for (const memberId of memberIds) {
      disposers.push(
        broker.register(
          runId,
          memberId,
          async (
            artifact: HostArtifact,
            caller: string,
          ): Promise<HostArtifactOutcome> => {
            const stored = await store.publish(runId, artifact);
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
            // Named to the call (and every call above it) BEFORE the write:
            // a call that settles while the row is written must still name
            // it. A row that then fails takes the page back from every call
            // still running; one that settled in between keeps naming it.
            const callId = this.callBroker.callAnsweredBy(runId, caller);
            const noteOn = this.callBroker.callToNoteOn(runId, caller);
            const unnote =
              noteOn === null
                ? () => {}
                : this.callBroker.notePublishedArtifact(runId, noteOn, {
                    artifact_id: row.artifactId,
                    title: row.title,
                    version: row.version,
                  });
            try {
              await persistItem(
                memberId,
                'show_artifact',
                null,
                callId === null ? row : { ...row, callId },
              );
            } catch (err) {
              unnote();
              // Logged and kept here, on the chat's rule: a persist failure
              // names an absolute database path, and the string returned goes
              // to a model whose provider is off this machine.
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
          },
        ),
      );
    }
    this.artifactDisposers.set(runId, disposers);
  }

  /**
   * Give each member of this pass the button tools (`publish_action`,
   * `remove_action`), on {@link registerArtifactPublishers}' terms. A button
   * belongs to the conversation publishing it — the member's own, or one it
   * answers calls in — and one published inside a call is named to that call
   * and every call above it still running.
   *
   * `agentLabel` is stamped on every publisher but the run's sole
   * trigger-fed agent in its own conversation: a press goes to every
   * trigger-fed agent whoever published, so any other publisher says who it
   * is, on the chip and in the message.
   */
  private registerActionPublishers(
    runId: string,
    nodes: readonly TeamMember[],
    roots: ReadonlySet<string>,
  ): void {
    const broker = this.actionSinks;
    const publisher = this.actionPublisher;
    if (broker === undefined || publisher === undefined) {
      return;
    }
    for (const dispose of this.actionDisposers.get(runId) ?? []) {
      dispose();
    }
    const disposers: (() => void)[] = [];
    for (const node of nodes) {
      // Per call, not per registration: one member speaks in several
      // conversations, and which call one answers changes as calls settle.
      const contextOf = (caller: string): ActionPublishContext => {
        const conversationId = callerConversationOf(caller) ?? '';
        const callId = this.callBroker.callAnsweredBy(runId, caller);
        const noteOn = this.callBroker.callToNoteOn(runId, caller);
        const unattributed =
          conversationId === '' && roots.size === 1 && roots.has(node.id);
        return {
          runId,
          rowNodeId: node.id,
          publisher: {
            nodeId: node.id,
            conversationId,
            ...(callId === null ? {} : { callId }),
            ...(unattributed ? {} : { agentLabel: node.name ?? node.id }),
          },
          notes: {
            published: (key, action) =>
              this.callBroker.notePublishedAction(runId, noteOn, key, {
                action_id: action.actionId,
                label: action.label,
                kind: action.kind,
              }),
            removed: (key) => this.callBroker.forgetPublishedAction(runId, key),
          },
        };
      };
      disposers.push(
        broker.register(runId, node.id, {
          publish: (input, caller) =>
            publisher.publish(contextOf(caller), input),
          remove: (actionId, caller) =>
            publisher.remove(contextOf(caller), actionId),
        }),
      );
    }
    this.actionDisposers.set(runId, disposers);
  }

  /**
   * Give each member of this pass the monitor tools, on
   * {@link registerActionPublishers}' terms: a monitor belongs to the
   * conversation that started it, and one started inside a call is filed
   * under that call. Offered only where calling a geniro tool is put to the
   * user first, or the member runs unattended anyway — the command runs in no
   * sandbox of its own (`AdapterConfig.hostToolCallUngatedReason`).
   */
  private registerMonitorSinks(
    runId: string,
    nodes: readonly TeamMember[],
    cwd: string,
    approvalOf: (node: TeamMember) => string,
  ): void {
    const broker = this.monitorSinks;
    if (broker === undefined) {
      return;
    }
    for (const dispose of this.monitorDisposers.get(runId) ?? []) {
      dispose();
    }
    const disposers: (() => void)[] = [];
    for (const node of nodes) {
      // Every pool member must pass, on the mode it actually runs: a call
      // may land on any of them.
      const offered = Array.from({ length: poolSize(node) }, (_, index) =>
        index === 0 ? node : poolMemberNode(node, index + 1),
      ).every(
        (member) =>
          member !== null &&
          offersMonitorTools(
            this.adapterFor(member.agent).getConfig(),
            approvalOf(member),
          ),
      );
      if (!offered) {
        continue;
      }
      disposers.push(
        broker.register(runId, node.id, {
          ownerOf: (caller) => ({
            owner: {
              runId,
              memberId: node.id,
              caller,
              conversationId: callerConversationOf(caller),
              callId: this.callBroker.callAnsweredBy(runId, caller),
              target: 'team',
            },
            cwd,
          }),
        }),
      );
    }
    this.monitorDisposers.set(runId, disposers);
  }

  /**
   * Give each member of this pass the team-note tools (`team_note`,
   * `team_notes`), on {@link registerArtifactPublishers}' terms. Every agent
   * of the run shares one store, whether or not it calls the others; a
   * note is written into its author's own transcript and, when that
   * conversation answers a call, filed in that call's card.
   */
  private registerTeamNoteSinks(
    runId: string,
    hostToolNodes: readonly TeamMember[],
    nodes: readonly TeamMember[],
    persistItem: (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
  ): void {
    const broker = this.teamNotes;
    if (broker === undefined) {
      return;
    }
    for (const dispose of this.teamNoteDisposers.get(runId) ?? []) {
      dispose();
    }
    const names = new Map<string, string>();
    for (const node of nodes) {
      names.set(node.id, node.name);
    }
    const disposers: (() => void)[] = [];
    for (const node of hostToolNodes) {
      disposers.push(
        broker.register(runId, node.id, {
          persistItem,
          writer: (caller) => ({
            memberId: callerNodeOf(caller),
            conversationId: callerConversationOf(caller),
            callId: this.callBroker.callAnsweredBy(runId, caller),
          }),
          agentName: (memberId) => names.get(memberId) ?? memberId,
        }),
      );
    }
    this.teamNoteDisposers.set(runId, disposers);
    void broker.prime(runId);
  }

  /**
   * Give each member of this pass the browser tools, on
   * {@link registerArtifactPublishers}' terms. A member's tabs are the run's, so
   * they share one cookie jar.
   *
   * The new-host card is raised in the shared {@link ApprovalRegistry} for that
   * member, deferred and standing: it outlives the member's turn, the user
   * answers it whenever, and the verdict reaches the member as a host wake
   * (`HostWakeGraphDelivery`), never as a message of the user's.
   */
  private registerBrowserSinks(
    runId: string,
    hostToolNodes: readonly TeamMember[],
    approvalOf: (node: TeamMember) => string,
    persistItem: (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
  ): void {
    const broker = this.browser;
    if (broker === undefined) {
      return;
    }
    for (const dispose of this.browserDisposers.get(runId) ?? []) {
      dispose();
    }
    this.browserDisposers.set(
      runId,
      hostToolNodes.map((node) => {
        // A call may land on any pool member, so every one must be unattended
        // for the member to skip the card.
        const members = Array.from({ length: poolSize(node) }, (_, index) =>
          index === 0 ? node : poolMemberNode(node, index + 1),
        );
        const sink: BrowserSink = {
          memberName: node.name ?? node.id,
          approvesEveryHost: () =>
            members.every(
              (member) => member !== null && approvalOf(member) === 'auto',
            ),
          askHost: (ask) =>
            this.raiseBrowserHostCard(broker, runId, node, persistItem, ask),
        };
        return broker.register(runId, node.id, sink);
      }),
    );
  }

  private async raiseBrowserHostCard(
    broker: BrowserBroker,
    runId: string,
    node: TeamMember,
    persistItem: (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
    ask: Parameters<BrowserSink['askHost']>[0],
  ): ReturnType<BrowserSink['askHost']> {
    const memberName = node.name ?? node.id;
    const standing = this.approvals
      .listByRun(runId)
      .some(
        (entry) =>
          entry.toolName === HOST_BROWSER_HOST_CARD &&
          entry.memberId === node.id &&
          (entry.input as BrowserHostCardInput).host === ask.host,
      );
    if (standing) {
      return { status: 'standing' };
    }
    const found = await this.runDao.getById(runId, this.em.fork());
    if (found === null || found.archivedAt !== null) {
      return {
        status: 'unavailable',
        reason: 'this thread is archived, so the user cannot be asked',
      };
    }
    const requestId = this.approvals.mintCardId('browser-host');
    const input: BrowserHostCardInput = {
      host: ask.host,
      url: ask.url,
      memberName,
    };
    await persistItem(node.id, 'approval_request', null, {
      id: requestId,
      nodeId: node.id,
      toolName: HOST_BROWSER_HOST_CARD,
      input,
    });
    const answered = async (
      allow: boolean,
      optionId: string | undefined,
    ): Promise<void> => {
      const forSession = allow && optionId === BROWSER_SESSION_OPTION;
      try {
        await persistItem(node.id, 'approval_verdict', null, {
          id: requestId,
          nodeId: node.id,
          allow,
          ...(forSession
            ? {
                option: BROWSER_SESSION_VERDICT_OPTION,
              }
            : {}),
        });
      } catch (err) {
        this.logger.error(
          `team run ${runId} browser card verdict write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.announceAwaiting(runId);
      await broker.settleHostCard(
        {
          requestId,
          owner: {
            runId,
            memberId: node.id,
            conversationId: null,
            caller: callerKey(node.id, null),
            target: 'team',
          },
          memberName,
          host: ask.host,
          op: ask.op,
        },
        { allow, optionId },
      );
    };
    this.approvals.track({
      runId,
      memberId: node.id,
      requestId,
      toolName: HOST_BROWSER_HOST_CARD,
      input,
      question: false,
      deferred: true,
      standing: true,
      respond: (allow, _answer, optionId) => {
        void answered(allow, optionId);
        return true;
      },
    });
    this.announceAwaiting(runId);
    return { status: 'asked' };
  }

  /**
   * Give each member that can lead this run `read_teams`, `propose_team` and
   * `save_project_instructions` (user decision: only the lead), offered while
   * it leads and only inside a turn of its own conversation — the one the
   * user talks to; between turns it is refused as an idle chat's is. Every
   * member gets a goal writer's sink on the same terms, so only the lead
   * writes the run's goals and the rest are known as the team's.
   * The project tool also needs every pool member on a CLI that holds a call
   * open; a cursor lead is not offered it yet.
   */
  private registerLeadCardSinks(
    runId: string,
    team: Team,
    hostToolNodes: readonly TeamMember[],
    ownTurnLive: (memberId: string) => boolean,
  ): void {
    for (const dispose of this.leadCardDisposers.get(runId) ?? []) {
      dispose();
    }
    const leads = possibleLeadsOf(team);
    const disposers: (() => void)[] = [];
    for (const node of hostToolNodes) {
      const offeredTo = (conversationId: string | null): boolean =>
        leads.has(node.id) &&
        conversationId === null &&
        ownTurnLive(node.id) &&
        this.isLeadNow(runId, team, node.id);
      if (this.goalWriters !== undefined) {
        disposers.push(
          this.goalWriters.register(runId, node.id, { runId }, { offeredTo }),
        );
      }
      if (!leads.has(node.id)) {
        continue;
      }
      if (this.teamProposals !== undefined) {
        disposers.push(
          this.teamProposals.register(runId, node.id, { runId }, { offeredTo }),
        );
      }
      const propose = this.leadProjectCards;
      const holdsCallsOpen = Array.from(
        { length: poolSize(node) },
        (_, index) => (index === 0 ? node : poolMemberNode(node, index + 1)),
      ).every(
        (member) =>
          member !== null &&
          this.adapterFor(member.agent).getConfig()
            .hostQuestionDeferredReason === null,
      );
      if (
        this.projectInstructionCards !== undefined &&
        propose !== null &&
        holdsCallsOpen
      ) {
        disposers.push(
          this.projectInstructionCards.register(
            runId,
            node.id,
            (change) => propose(runId, change),
            { offeredTo, answersAtOnce: true },
          ),
        );
      }
    }
    this.leadCardDisposers.set(runId, disposers);
  }

  /**
   * {@link leadNow}, answered synchronously for a tool listing. A relay run
   * whose progress is not loaded yet (a restart mid-stage) offers nobody until
   * it is, rather than the starting lead.
   */
  private isLeadNow(runId: string, team: Team, memberId: string): boolean {
    if (team.mode !== 'relay' || this.stages === undefined) {
      return leadIn(team, undefined) === memberId;
    }
    const loaded = this.stages.cached(runId);
    return loaded !== null && leadIn(team, loaded.leadId) === memberId;
  }

  /** Install how the lead's project card is raised (`TeamCardsService`). */
  useLeadProjectCards(
    propose: (
      runId: string,
      change: HostProjectInstructions,
    ) => Promise<HostProjectInstructionsOutcome>,
  ): void {
    this.leadProjectCards = propose;
  }

  useMemberQuestionCards(cards: MemberQuestionCards): void {
    this.memberQuestionCards = cards;
  }

  /** A member's own question on a CLI that will not hold the call open. */
  private askMemberDeferred(
    runId: string,
    memberId: string,
    questions: HostQuestion[],
    title: string | null,
  ): Promise<HostQuestionOutcome> {
    return (
      this.memberQuestionCards?.ask(runId, memberId, questions, title) ??
      Promise.resolve({
        status: 'unavailable',
        reason: 'no question card can be put up in this run',
      })
    );
  }

  /** Who leads a team run now, or null for no team run or no lead. */
  async currentLead(runId: string): Promise<string | null> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null || run.teamId === null) {
      return null;
    }
    return this.leadNow(
      runId,
      await this.runTeams.teamOf(assertTeamRun(run, runId), em),
    );
  }

  /**
   * Give each call-capable member of this pass `record_outcome`, on
   * {@link registerArtifactPublishers}' terms. The row goes into the recording
   * conversation's own transcript and, when that conversation answers a call,
   * into that call's card — a team note's filing.
   */
  private registerRunOutcomeSinks(
    runId: string,
    hostToolNodes: readonly TeamMember[],
    persistItem: (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ) => Promise<ItemWire>,
  ): void {
    const broker = this.runOutcomes;
    if (broker === undefined) {
      return;
    }
    for (const dispose of this.runOutcomeDisposers.get(runId) ?? []) {
      dispose();
    }
    this.runOutcomeDisposers.set(
      runId,
      hostToolNodes.map((node) =>
        broker.register(runId, node.id, {
          persistItem,
          recorder: (caller) => ({
            memberId: callerNodeOf(caller),
            conversationId: callerConversationOf(caller),
            callId: this.callBroker.callAnsweredBy(runId, caller),
          }),
        }),
      ),
    );
  }

  /** Drop every per-key fact of one run — its keys are `<runId>::…`. */
  private forgetCompactions(runId: string): void {
    const prefix = runSessionKeyPrefix(runId);
    for (const key of [...this.offTurnNodes.keys()]) {
      if (key.startsWith(prefix)) {
        this.offTurnNodes.delete(key);
      }
    }
    for (const key of [...this.carriedSummaries.keys()]) {
      if (key.startsWith(prefix)) {
        this.carriedSummaries.delete(key);
      }
    }
    for (const key of [...this.compactionBaselines.keys()]) {
      if (key.startsWith(prefix)) {
        this.compactionBaselines.delete(key);
      }
    }
  }

  /**
   * Team runs, newest first (the Chats page's run picker).
   *
   * `scope` is the chat listing's own, and the sidebar sends the SAME one to
   * both: a team run is shelved by `archivedAt` exactly as a chat is, so
   * the two halves of one list have to agree about how much of the archive they
   * are showing.
   */
  async listRuns(
    scope: ChatListScope = 'active',
    page: RunListPage = {},
  ): Promise<RunWire[]> {
    const em = this.em.fork();
    const runs = await this.runDao.listTeamRuns(scope, em, page);
    // The chat listing's own backfill, on the same terms: incremental and
    // error-swallowing by construction, so this is a `max(seq)` read per run in
    // the steady state and can never fail the listing. It is what recovers a
    // pull request opened while no window was watching — and every one opened
    // before a team run was captured at all, since those runs carry a null
    // marker and are read once from the beginning.
    await this.pullRequests.sync(runs, em);
    const [previews, projectNames] = await Promise.all([
      this.itemDao.runPreviews(
        runs.map((run) => run.id),
        em,
      ),
      this.projectScope.liveNamesOf(runs.map((run) => run.projectId)),
    ]);
    // Same registry the chat list reads: a team member parked on an `ask`
    // card blocks its run exactly as a chat's question blocks that chat, and
    // both lists feed the same sidebar.
    return runs.map((run) =>
      runToWire(
        run,
        previews.get(run.id) ?? null,
        this.approvals.awaitingFor(run.id),
        0,
        null,
        this.backgroundWork.shellsOpen(run.id),
        this.backgroundWork.subagentsOut(run.id),
        // The one reading here that a CHAT row can never carry: a team
        // agent parked inside `await_agent` is in a turn and producing
        // nothing, and the composer has to know before it queues a message.
        // On the snapshot rather than the announce alone because the wait
        // lasts as long as the callees do — see `RunWire.awaitingCalls`.
        this.callBroker.awaitingCalls(run.id),
        this.workingRoots.get(run.id)?.size ?? 0,
        null,
        this.monitors?.list(run.id).length ?? 0,
        projectNames.get(run.projectId ?? '') ?? null,
      ),
    );
  }

  /**
   * Tell every window what this run is parked on NOW — the team twin of
   * `ChatService.announceAwaiting`, read from the same registry.
   *
   * The runs listing answers `awaiting` per run, but a listing is a SNAPSHOT:
   * a window keeps whatever it last read until an announce moves it. The chat
   * path announces at every transition; this path announced at none, so a
   * listing taken while a member's question was open left the row reading
   * `needs more info` for good after the question was answered. The open
   * thread derives its badge from the transcript (card answered → `running`),
   * the sidebar and the notification rules read the row — so every switch
   * AWAY from the thread flipped it back to waiting and posted "Waiting for
   * your answer" again. REPORTED as a notification that came back each time
   * another thread was opened, over a run the daemon itself reported as
   * `awaiting: null`.
   *
   * `status: null`: the badge's status belongs to whatever settles the run,
   * and an announce that never read the row must not assert one.
   */
  announceAwaiting(runId: string): void {
    this.bus.publishRunStatus({
      runId,
      status: null,
      awaiting: this.approvals.awaitingFor(runId),
    });
  }

  /** Per-member execution states of one run (member chips + reconnect snapshot). */
  async getNodeStates(runId: string): Promise<NodeStateWire[]> {
    const em = this.em.fork();
    const run = assertTeamRun(await this.runDao.getById(runId, em), runId);
    const rows = await this.nodeStateDao.listByRun(runId, em);
    // Each member's wall-measured turns — what its CLI did not time — served on
    // top of the CLI-reported `workedMs` the row holds.
    const wallByNode = await this.wallTurns.nodeSums(runId, em);
    const adapters = this.adapters.all();
    const poolKinds = snapshotPoolKinds(run.teamSnapshot);
    const handOffs =
      poolKinds.size === 0 ? [] : await this.itemDao.poolHandOffRows(runId, em);
    const ownPoolMembers = readNodePoolMembers(handOffs);
    const ownPoolPins = readNodePoolPins(handOffs);
    const poolSizes = new Map(
      [...snapshotNodePoolProfiles(run.teamSnapshot)].map(([id, profiles]) => [
        id,
        profiles.length,
      ]),
    );
    /** The recorded pool member, unless the pool no longer has it. */
    const ownPoolMemberOf = (memberId: string): number | null => {
      const size = poolSizes.get(memberId);
      if (size === undefined) {
        return null;
      }
      const recorded = ownPoolMembers.get(memberId);
      return recorded !== undefined && recorded <= size ? recorded : null;
    };
    const poolChoices = this.poolChoices.get(runId);
    // Spend over EVERY turn the run wrote, per member, per call and per member's
    // own conversation — the figures a client's loaded window cannot sum.
    const nodeTotals = new Map<string, ChatTotalsWire>();
    // The part of each member's spend run on a CLI that prices its own turns —
    // what a polled bill is added to (`withNodePolledSpend`).
    const selfPriced = new Map<string, ChatTotalsWire>();
    const callSelfPriced = new Map<string, ChatTotalsWire>();
    const stampKinds = new Map(
      rows.map((row) => [row.memberId, row.agentKind]),
    );
    const mainTotals = new Map<string, ChatTotalsWire>();
    const callTotals = new Map<
      string,
      { memberId: string; totals: ChatTotalsWire }
    >();
    // Each conversation's newest turn ending and the lifetime last stated for
    // it, per call and per member's own conversation — what its prompt-cache
    // expiry is read from.
    const callCache = new Map<string, TurnCacheClock>();
    const mainCache = new Map<string, TurnCacheClock>();
    const nodeTtl = new Map<string, number>();
    const addTo = <K>(
      map: Map<K, ChatTotalsWire>,
      key: K,
      figures: UsageFigures,
    ): void => {
      const totals = map.get(key) ?? emptyTotals();
      addUsage(totals, figures);
      map.set(key, totals);
    };
    // The newest model each member's turns named, on the transcript fold's rule:
    // a turn that named none says nothing about a switch.
    const models = new Map<string, string>();
    for (const turn of await this.kindRows.rowsOf(runId, USAGE_ITEM_KINDS)) {
      if (turn.memberId === null) {
        continue;
      }
      const payload = asRecord(parseJsonColumn(turn.payload));
      const member = turnMemberOf(payload);
      const model = asRecord(payload?.usage)?.contextModel;
      // Call-only members show pool member 1. A pooled member a pass starts
      // instead shows the pool member holding its own conversation, beside
      // that pool member's window.
      const ownMember = payload?.nodePoolMember;
      const ownsModel =
        typeof ownMember === 'number' &&
        ownMember === (ownPoolMembers.get(turn.memberId) ?? 1) &&
        payload?.callId == null &&
        payload?.parentToolUseId == null;
      if (
        (member === null || ownsModel) &&
        typeof model === 'string' &&
        model.length > 0
      ) {
        models.set(turn.memberId, model);
      }
      const callId =
        typeof payload?.callId === 'string' ? payload.callId : null;
      const clocks = callId === null ? mainCache : callCache;
      const clockKey = callId ?? turn.memberId;
      // Every ending moves the clock, priced or not: a turn served wholly
      // from cache may report no figures and still refreshed the cache.
      // Per member AND CLI: a pool member on another CLI states its own
      // lifetime, or none, and must not inherit this one.
      const ttlKey = `${turn.memberId}#${member?.agentKind ?? ''}`;
      clocks.set(
        clockKey,
        advanceCacheClock(
          clocks.get(clockKey),
          turn.createdAt,
          payload,
          nodeTtl.get(ttlKey) ?? null,
        ),
      );
      const stated = statedTtlOf(payload);
      if (stated !== null) {
        nodeTtl.set(ttlKey, stated);
      }
      const figures = usageFiguresFrom(payload);
      if (figures === null) {
        continue;
      }
      addTo(nodeTotals, turn.memberId, figures);
      if (
        !pollsSpendFor(
          adapters,
          member?.agentKind ?? stampKinds.get(turn.memberId) ?? null,
        )
      ) {
        addTo(selfPriced, turn.memberId, figures);
        if (callId !== null) {
          addTo(callSelfPriced, callId, figures);
        }
      }
      if (callId === null) {
        addTo(mainTotals, turn.memberId, figures);
        continue;
      }
      const call = callTotals.get(callId) ?? {
        memberId: turn.memberId,
        totals: emptyTotals(),
      };
      addUsage(call.totals, figures);
      callTotals.set(callId, call);
    }
    // Each call's START as its own row recorded it, keyed by call — what a
    // client whose window opens after that row needs to title the call's card.
    const starts = new Map<
      string,
      {
        memberId: string;
        start: NonNullable<NodeStateWire['calls'][number]['start']>;
      }
    >();
    const callRows = await this.kindRows.rowsOfView(
      runId,
      CALL_RECORDS,
      'fresh',
    );
    for (const row of callRows) {
      if (row.kind !== 'call_started') {
        continue;
      }
      const payload = asRecord(parseJsonColumn(row.payload));
      const text = (key: string): string | null =>
        typeof payload?.[key] === 'string' ? payload[key] : null;
      const callId = text('callId');
      const calleeMemberId = text('calleeNodeId');
      if (callId === null || calleeMemberId === null || starts.has(callId)) {
        continue;
      }
      const message = text('message');
      starts.set(callId, {
        memberId: calleeMemberId,
        start: {
          callerMemberId: text('callerNodeId'),
          title: text('title'),
          message:
            message === null || message.length <= CALL_START_BRIEF_MAX
              ? message
              : `${message.slice(0, CALL_START_BRIEF_MAX)}…`,
          mode: text('mode'),
          thread: text('thread'),
          startedAt: Number.isFinite(row.createdAt?.getTime())
            ? row.createdAt.getTime()
            : null,
        },
      });
    }
    // Grouped by the member that ran each call, so a reconnecting client gets one
    // ring per call thread beside the member's own collapsed figure.
    const callsByNode = new Map<string, NodeStateWire['calls']>();
    const pushCall = (
      memberId: string,
      call: NodeStateWire['calls'][number],
    ): void => {
      const forNode = callsByNode.get(memberId) ?? [];
      forNode.push(call);
      callsByNode.set(memberId, forNode);
    };
    // Each call's own tools, keyed by call and the member that ran it — counted
    // by `in_call`, so the run's rows are stamped first.
    await this.calls.ensureIndexed(runId);
    const callTools = new Map(
      (await this.itemDao.ownToolCallsByCall(runId, em)).map((count) => [
        `${count.memberId}\u0000${count.callId}`,
        count,
      ]),
    );
    const toolsOf = (
      memberId: string,
      callId: string,
    ): Pick<
      NodeStateWire['callFigures'][number],
      'toolCalls' | 'toolCallsThroughSeq'
    > => {
      const count = callTools.get(`${memberId}\u0000${callId}`);
      return {
        toolCalls: count?.calls ?? 0,
        toolCallsThroughSeq: count?.lastSeq ?? null,
      };
    };
    const callClocks = callClocksFrom(
      await this.kindRows.rowsOf(runId, SPAN_ROW_KINDS, 'fresh'),
    );
    // Every call's FIGURES, never capped: the maps above already cover every
    // call of the run, so only the heavy listing below is bounded.
    const callNodes = new Map<string, string>();
    for (const [callId, started] of starts) {
      callNodes.set(callId, started.memberId);
    }
    for (const [callId, spent] of callTotals) {
      if (!callNodes.has(callId)) {
        callNodes.set(callId, spent.memberId);
      }
    }
    for (const count of callTools.values()) {
      if (!callNodes.has(count.callId)) {
        callNodes.set(count.callId, count.memberId);
      }
    }
    const callSessions = await this.callContextDao.sessionsByCall(runId, em);
    for (const record of readCallSeed(callRows).records) {
      if (record.sessionId !== null) {
        const sessions = callSessions.get(record.callId) ?? [];
        callSessions.set(record.callId, [...sessions, record.sessionId]);
      }
    }
    const ledgers = new Map(
      rows.map((row) => [row.memberId, readPolledSpendLedger(row.polledSpend)]),
    );
    // Summed per conversation by the client, so a session the conversation's
    // calls share is billed to the first of them alone.
    const billed = new Set<string>();
    const figuresByNode = new Map<string, NodeStateWire['callFigures']>();
    for (const [callId, memberId] of [...callNodes].sort(
      ([a], [b]) => (callNumber(a) ?? 0) - (callNumber(b) ?? 0),
    )) {
      const forNode = figuresByNode.get(memberId) ?? [];
      const sessions = (callSessions.get(callId) ?? []).filter(
        (sessionId) => !billed.has(sessionId),
      );
      for (const sessionId of sessions) {
        billed.add(sessionId);
      }
      forNode.push({
        callId,
        totals: withNodePolledSpend(
          callTotals.get(callId)?.totals ?? emptyTotals(),
          callSelfPriced.get(callId) ?? emptyTotals(),
          conversationsBill(
            ledgers.get(memberId) ?? new Map(),
            new Set(sessions),
          ),
        ),
        clock: callClocks.get(callId) ?? null,
        ...toolsOf(memberId, callId),
        promptCacheExpiresAt: cacheExpiryOf(callCache.get(callId)),
      });
      figuresByNode.set(memberId, forNode);
    }
    const readings = await this.callContextDao.listByRun(runId, em);
    for (const call of readings) {
      pushCall(call.memberId, {
        callId: call.callId,
        contextTokens: call.contextTokens,
        contextEstimated: call.contextEstimated === true,
        contextWindowTokens: call.contextWindowTokens,
        start: starts.get(call.callId)?.start ?? null,
      });
    }
    // A call that has no `call_context` row — it has not reported a context
    // reading — is still owed its start. Newest first and within the listing's
    // own cap, which bounds the briefs every re-read carries.
    const read = new Set(readings.map((call) => call.callId));
    const unread = [...callNodes.keys()]
      .filter((callId) => !read.has(callId))
      .sort((a, b) => (callNumber(b) ?? 0) - (callNumber(a) ?? 0))
      .slice(0, Math.max(0, CALL_CONTEXT_SNAPSHOT_LIMIT - readings.length))
      .reverse();
    for (const callId of unread) {
      pushCall(callNodes.get(callId)!, {
        callId,
        contextTokens: null,
        contextEstimated: false,
        contextWindowTokens: null,
        start: starts.get(callId)?.start ?? null,
      });
    }
    return rows.map((row) => ({
      runId: row.runId,
      memberId: row.memberId,
      status: row.status,
      contextTokens: row.contextTokens,
      contextEstimated: row.contextEstimated === true,
      contextWindowTokens: row.contextWindowTokens,
      model: models.get(row.memberId) ?? null,
      calls: callsByNode.get(row.memberId) ?? [],
      callFigures: figuresByNode.get(row.memberId) ?? [],
      // A polled-spend member's turns carry no price; its polled bill stands for
      // them, beside whatever a self-pricing pool member's turns cost.
      totals: withNodePolledSpend(
        nodeTotals.get(row.memberId) ?? emptyTotals(),
        selfPriced.get(row.memberId) ?? emptyTotals(),
        nodePolledSpend(
          row,
          (kind) => pollsSpendFor(adapters, kind),
          poolKinds.get(row.memberId),
        ),
      ),
      mainTotals: mainTotals.get(row.memberId) ?? emptyTotals(),
      promptCacheExpiresAt: cacheExpiryOf(mainCache.get(row.memberId)),
      workedMs: servedWorkedMs(row.workedMs, wallByNode.get(row.memberId)),
      toolCalls: row.toolCalls,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      error: row.error,
      poolMember: poolSizes.has(row.memberId)
        ? (ownPoolMemberOf(row.memberId) ?? 1)
        : null,
      poolMemberPinned:
        ownPoolMemberOf(row.memberId) !== null && ownPoolPins.has(row.memberId),
      poolMemberNext: poolChoices?.get(row.memberId) ?? null,
    }));
  }

  /**
   * Run a member's OWN conversation on pool member `member` from now on, and
   * pin it there: it never moves back on its own, until a turn of it fails
   * through the pool (a usage limit, a sign-out), which hands it on and
   * releases the pin. An idle conversation moves at once; one whose turn is
   * running moves when its next turn starts. A move leaves the CLI session,
   * which belongs to the account it was opened on, and the next turn starts
   * on the new member from a transcript excerpt.
   */
  async setOwnPoolMember(
    runId: string,
    memberId: string,
    member: number,
  ): Promise<SetPoolMemberResult> {
    const em = this.em.fork();
    const run = assertTeamRun(await this.runDao.getById(runId, em), runId);
    if (run.archivedAt !== null) {
      throw new ConflictException(
        'RUN_ARCHIVED',
        "this run is archived — unarchive it to change an agent's pool member",
      );
    }
    const team = await this.runTeams.teamOf(run, em);
    const node = team.members.find((entry) => entry.id === memberId);
    if (node === undefined) {
      throw new NotFoundException(
        'NODE_NOT_FOUND',
        `team ${run.teamId} has no member: ${memberId}`,
      );
    }
    const size = poolSize(node);
    if (size === 1) {
      throw new BadRequestException(
        'NO_AGENT_POOL',
        `'${memberId}' has no agent pool`,
      );
    }
    const target = poolMemberNode(node, member);
    if (target === null) {
      throw new BadRequestException(
        'UNKNOWN_POOL_MEMBER',
        `'${memberId}' has pool members 1–${size}, not ${member}`,
      );
    }
    const rowFor = (
      from: number,
      previousSessionId: string | null,
      moved: boolean,
    ): Record<string, unknown> =>
      nodePoolHandOffRow({
        member,
        fromMember: from,
        previousSessionId,
        message: poolSwitchNotice(
          node.name ?? node.id,
          { member, node: target },
          moved,
        ),
        pinnedByUser: true,
      });
    const live = this.liveRuns.get(runId);
    if (live !== undefined) {
      const applied = await live.pinPoolMember(memberId, member, rowFor);
      if (applied !== 'busy') {
        this.dropPoolChoice(runId, memberId);
        return { member, applied };
      }
      const choices = this.poolChoices.get(runId) ?? new Map<string, number>();
      choices.set(memberId, member);
      this.poolChoices.set(runId, choices);
      return { member, applied: 'next_turn' };
    }
    this.dropPoolChoice(runId, memberId);
    const handOffs = await this.itemDao.poolHandOffRows(runId, em);
    const recorded = readNodePoolMembers(handOffs).get(memberId) ?? 1;
    const from = poolMemberNode(node, recorded) === null ? 1 : recorded;
    const moved = member !== from;
    if (!moved && readNodePoolPins(handOffs).has(memberId)) {
      return { member, applied: 'unchanged' };
    }
    let previousSessionId: string | null = null;
    if (moved) {
      previousSessionId =
        (await this.nodeStateDao.getByRunNode(runId, memberId, em))
          ?.agentSessionId ?? null;
      const sessionKey = nodeSessionKey(runId, memberId);
      this.sessions.retire(
        sessionKey,
        'the user moved its conversation to another pool member',
      );
      this.compactionBaselines.delete(sessionKey);
      await this.nodeStateDao.clearConversation(runId, memberId, em);
    }
    await this.persist(
      em,
      runId,
      memberId,
      await this.seqs.reserve(runId),
      'system',
      null,
      rowFor(from, previousSessionId, moved),
    );
    return { member, applied: 'now' };
  }

  /** The pool member the user picked while a turn ran, taken by its next turn. */
  private takePoolChoice(runId: string, node: TeamMember): number | null {
    const member = this.poolChoices.get(runId)?.get(node.id);
    if (member === undefined) {
      return null;
    }
    this.dropPoolChoice(runId, node.id);
    return poolMemberNode(node, member) === null ? null : member;
  }

  private dropPoolChoice(runId: string, memberId: string): void {
    const choices = this.poolChoices.get(runId);
    choices?.delete(memberId);
    if (choices?.size === 0) {
      this.poolChoices.delete(runId);
    }
  }

  /**
   * Close team runs a crash / SIGKILL left non-terminal (mirror of the
   * chat service's boot reconcile — see its doc for why this is called from
   * `main.ts` after the schema sync). Stuck `running` members go `failed`,
   * never-started `pending` members go `skipped`, and the run rolls up `failed`.
   * `cause` is written onto the run's row as the chat twin's is.
   */
  async reconcileOrphanedRuns(cause: InterruptCause): Promise<void> {
    try {
      const em = this.em.fork();
      const stale = await this.runDao.listRunningTeamRuns(em);
      let reconciled = 0;
      for (const run of stale) {
        if (this.registry.has(run.id)) {
          continue; // a live executor legitimately owns this run
        }
        let seq = (await this.itemDao.maxSeq(run.id, em)) + 1;
        await this.persist(em, run.id, null, seq++, 'error', null, {
          message: `team run interrupted — ${interruptCauseClause(cause)} while it was running`,
          // Written at BOOT — see the chat twin in `ChatService`.
          interrupted: true,
          interruptCause: cause,
        });
        // The kill took the in-memory registry with it, so no settle path ever
        // swept these — without this the cards come back looking answerable.
        // Not the lead's standing cards, which are put back at boot from their
        // columns (the chat twin spares its own the same way).
        const history = await this.itemDao.rowsOfKinds(
          run.id,
          [...ANSWERABILITY_KINDS, ...OPEN_WORK_KINDS],
          undefined,
          em,
        );
        const standing = new Set(
          [
            standingProposalCardId(run.pendingTeamProposal ?? null),
            teamProjectCardId(run.pendingTeamProjectCard ?? null),
          ].filter((id): id is string => id !== null),
        );
        for (const request of unansweredRequests(history).filter(
          (request) => !standing.has(request.payload.id),
        )) {
          await this.persist(
            em,
            run.id,
            request.memberId,
            seq++,
            'unanswerable',
            null,
            {
              ...request.payload,
              ...(request.memberId ? { nodeId: request.memberId } : {}),
            },
          );
        }
        // The renderer reads a member's liveness and a call block's status off
        // the TRANSCRIPT before node_state, so failing the member rows below
        // alone left the card and the call block spinning under a failed run.
        // Settle both where the renderer looks.
        for (const turn of openNodeTurns(history)) {
          await this.persist(em, run.id, turn.memberId, seq++, 'status', null, {
            nodeId: turn.memberId,
            status: 'failed',
            ...(turn.callId !== null ? { callId: turn.callId } : {}),
          });
        }
        for (const call of openCalls(history)) {
          await this.persist(
            em,
            run.id,
            call.callerMemberId,
            seq++,
            'call_result',
            null,
            {
              callId: call.callId,
              callerNodeId: call.callerMemberId,
              calleeNodeId: call.calleeMemberId,
              mode: call.mode,
              status: 'error',
              error: `CALLEE_FAILED: interrupted — ${interruptCauseClause(cause)} before the call finished`,
            },
          );
        }
        for (const node of await this.nodeStateDao.listByRun(run.id, em)) {
          if (node.status === 'running') {
            await this.nodeStateDao.setStatus(
              run.id,
              node.memberId,
              { status: 'failed', endedAt: Date.now(), error: 'interrupted' },
              em,
            );
          } else if (node.status === 'pending') {
            await this.nodeStateDao.setStatus(
              run.id,
              node.memberId,
              { status: 'skipped', endedAt: Date.now() },
              em,
            );
          }
        }
        await this.setRunStatus(em, run.id, 'failed');
        reconciled += 1;
      }
      if (reconciled > 0) {
        this.logger.warn(
          `reconciled ${reconciled} orphaned team run(s) to failed on boot`,
        );
      }
    } catch (err) {
      // Best-effort cleanup — never block daemon boot.
      this.logger.error(
        `boot reconcile of orphaned team runs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Everything a run start refuses a team for — the team rules, a mode this
   * build runs, and a model each CLI can run — asked without starting one, so
   * a team can be judged runnable before it is saved. Resolves to the copy a
   * run would execute, with the member settings its CLI cannot honour
   * stripped, and what was stripped. The setup-health gate (a CLI not
   * installed, a profile folder gone) is `startRun`'s own, not this one.
   */
  async assertRunnable(
    team: Team,
  ): Promise<{ team: Team; dropped: DroppedNodeSetting[] }> {
    assertValidTeam(team);
    const resolved = withResolvedNodeSettings(team, (kind) =>
      this.adapterFor(kind),
    );
    await this.validateTeamModels(resolved.team);
    return resolved;
  }

  /**
   * Refuse to start a run a red setup problem would stop anyway — the leading
   * member's CLI not installed, a profile folder gone, no trigger member —
   * naming each. Amber problems never refuse.
   */
  private async assertMembersReady(team: Team): Promise<void> {
    const problems = (await this.health?.blockingProblems(team)) ?? [];
    if (problems.length > 0) {
      throw new BadRequestException(
        'TEAM_NOT_READY',
        problems.map((problem) => problem.message).join(' '),
      );
    }
  }

  private async validateTeamModels(team: Team): Promise<void> {
    const onDemand = onDemandMemberIds(team);
    const models = new Map<
      string,
      { agent: AgentKind; model: string | null }
    >();
    for (const node of team.members) {
      if (onDemand.has(node.id)) {
        continue;
      }
      // Pools validate on each attempt, including a trigger-fed root: an
      // unavailable first member must not prevent trying its backup.
      if (node.pool?.length) {
        continue;
      }
      const model = node.model ?? null;
      models.set(JSON.stringify([node.agent, model]), {
        agent: node.agent,
        model,
      });
    }
    await Promise.all(
      [...models.values()].map(({ agent, model }) =>
        this.adapterFor(agent).validateModel(model),
      ),
    );
  }

  /**
   * The pass. Never throws — every failure becomes transcript + status.
   *
   * Resolve the cursor call capability, then run the pass. The probe await
   * lives HERE — off the run-start POST — so the first cursor-caller run on a
   * machine returns its run row instantly and only its execution waits out
   * the probe turn (~90s worst case). Cancel/shutdown during the await is
   * covered by the registry's claim→register intent window.
   */
  private drive(
    em: EntityManager,
    runId: string,
    team: Team,
    run: RunContext,
    dropped: DroppedNodeSetting[],
  ): void {
    void (async () => {
      let approvalSupport: ReadonlyMap<AgentKind, InstalledApprovalSupport>;
      try {
        // A member asking a probed mode waits on its CLI's probe: cached per
        // installed binary, so only the first such run on a machine pays the
        // probe turn.
        approvalSupport = await approvalSupportByKind(team, (kind) =>
          this.adapterFor(kind),
        );
      } catch {
        // Unknown is NOT a fail — every member runs with its requested mode and
        // any real CLI rejection surfaces loudly in the transcript.
        approvalSupport = new Map();
      }
      // A delete can have landed while those probes were awaiting, and it has
      // TWO shapes this walk must not survive:
      //   - one still in flight (cancelled, rows not yet gone) — `deleting`;
      //   - one that already finished — the run row is gone, and `deleting`
      //     has been cleared again, so only re-reading catches it.
      // The re-read is resolved FIRST and `deleting` consulted only after, so
      // a delete that starts during the read is still seen by the Set (the
      // chat turn's start applies the same order for the same reason).
      const runStillExists = (await this.runDao.getById(runId, em)) !== null;
      if (this.deleting.has(runId) || !runStillExists) {
        // Abandon the walk: no handle registered, no item written. The delete
        // owns this run's rows from here — writing any would orphan them.
        this.registry.release(runId);
        this.logger.warn(
          `team run ${runId} was deleted while starting — abandoning its walk`,
        );
        return;
      }
      this.driveResolved(em, runId, team, run, approvalSupport, dropped);
    })();
  }

  private driveResolved(
    em: EntityManager,
    runId: string,
    team: Team,
    run: RunContext,
    approvalSupport: ReadonlyMap<AgentKind, InstalledApprovalSupport>,
    dropped: DroppedNodeSetting[],
  ): void {
    const {
      cwd,
      seedPrompt,
      customInstructions,
      replyLanguage,
      projectInstructions,
      memoryIndex,
      knowledgeIndex,
      nativeMemoryOff,
      taskInstructions,
      agentOptions,
    } = run;
    const nodes = team.members;
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    // What a pass starts: the run's lead as the pass begins, and only it.
    // Every other member runs per CallBroker call or, in `relay` mode, in its
    // own conversation once the run is handed to it — never in the settled
    // denominator (an uncalled one settles 'skipped' at run end).
    const passMembers = nodes.filter((n) => n.id === run.lead);
    const passMemberIds = new Set(passMembers.map((n) => n.id));
    // A member that may lead keeps its call turns' session and readings apart
    // from its own conversation.
    const onDemand = onDemandMemberIds(team);
    const blocksOf = instructionBlocksByMember(team);
    // A mid-run change to an instruction part changes sessionKey; the stage rides each prompt.
    const stageMap = stageMapOf(team);
    this.stages?.register(runId, team);
    if (stageMap !== null) {
      void this.stages?.current(runId);
    }
    // Caller → every other member. Drives the broker's dispatch, each
    // caller's MCP endpoint grant, and its "May call" block.
    const calleesOf = calleesOfTeam(team.members);

    const settled = new Map<string, NodeOutcome>();
    const runningHandles = new Map<string, AgentTurnHandle>();
    // Callee sub-turns: cancel fans to these, but they never enter `settled`,
    // `runningHandles`, or the ProcessRegistry — they ride the aggregate
    // handle, and only `liveSubTurns` holds the run open for them. Keyed by
    // call id; the callee is what a message addressed to that call is filed
    // under, and the conversation is which of the callee's conversations the
    // turn speaks in — what a message meant for that conversation is handed to.
    const subTurns = new Map<
      string,
      {
        handle: AgentTurnHandle;
        callee: TeamMember;
        conversationId: string;
      }
    >();
    /**
     * Calls between two turns of a hold (`CallBroker.holdCall`), by call id:
     * held, or woken and not started yet. Neither has a sub-turn, so this is
     * what a message addressed to one is checked against — the member the callee
     * ran as — and where one arriving after the wake but before its turn
     * starts waits to be added to that turn's prompt. Whether the call is
     * still HELD is the broker's to say.
     */
    const waitingCalls = new Map<
      string,
      { node: TeamMember; messages: string[] }
    >();
    /**
     * The member a callee CONVERSATION last ran as, keyed by its caller key —
     * the pool member's resolved settings for a pooled callee. What a question
     * about that conversation's own CLI (its tool-call deadline, whether a
     * message interrupts it) is answered against; the team's member names only
     * pool member 1.
     */
    const conversationNodes = new Map<string, TeamMember>();
    /**
     * What was said INTO each running call after it started — the caller's
     * `message_agent` and the user's own — so a call its pool hands to the next
     * member carries them, that member starting a conversation of its own.
     */
    const callMessages = new Map<string, string[]>();
    const noteCallMessage = (callId: string, text: string): void => {
      callMessages.set(callId, [...(callMessages.get(callId) ?? []), text]);
    };
    /**
     * `message_agent` messages handed to a callee's running turn, by the
     * delivery id they rode in with. A turn that reports one dropped
     * (`follow_up_dropped`) has the broker record it undelivered, so its
     * caller is told — a user message the same report names is a row instead.
     */
    const brokerDeliveries = new Map<
      string,
      { callId: string; text: string }
    >();
    /** A settled call's entries: nothing it was handed can be dropped now. */
    const forgetCallDeliveries = (callId: string): void => {
      for (const [deliveryId, delivery] of brokerDeliveries) {
        if (delivery.callId === callId) {
          brokerDeliveries.delete(deliveryId);
        }
      }
    };
    /**
     * Prompts handed to a WORKING conversation's turn — a broker tell
     * (`tellLiveNode`) or a wake that found the conversation working — by the
     * delivery id they rode in with. A turn that drops one
     * (`follow_up_dropped`) has its `redeliver` run once that turn has ended
     * (`endConversationTurn`); one the turn ended without dropping, it took.
     * Registered even with nothing to redeliver, so a dropped tell is never
     * read as the user's own message.
     */
    const promptDeliveries = new Map<
      string,
      { caller: string; redeliver?: () => void }
    >();
    /** Dropped prompts' redeliveries, by the conversation whose turn ends. */
    const droppedPrompts = new Map<string, (() => void)[]>();
    const redeliverWhenEnded = (
      caller: string,
      redeliver: () => void,
    ): void => {
      droppedPrompts.set(caller, [
        ...(droppedPrompts.get(caller) ?? []),
        redeliver,
      ]);
    };
    /**
     * A run follow-up's per-root delivery ids. One message reaches several
     * roots under ONE row, so nothing is said until every root has answered
     * for it — dropped it, or ended its turn having taken it. All dropped:
     * the row reads "not sent". Some: a note names each root that missed it.
     */
    interface SharedDelivery {
      /** The `deliveryId` on the message's own row. */
      rowDeliveryId: string;
      /** Roots it went to, live or started fresh with it. */
      roots: number;
      /** Roots that took it: started fresh with it, or ended without a drop. */
      took: number;
      dropped: { memberId: string; name: string }[];
    }
    const rootDeliveries = new Map<
      string,
      { delivery: SharedDelivery; memberId: string; name: string }
    >();
    /** Say what became of a shared delivery once every root has answered. */
    const settleSharedDelivery = async (
      delivery: SharedDelivery,
    ): Promise<string | null> => {
      if (delivery.took + delivery.dropped.length < delivery.roots) {
        return null;
      }
      if (delivery.took === 0) {
        return delivery.rowDeliveryId;
      }
      for (const missed of delivery.dropped) {
        await persistItem(missed.memberId, 'system', null, {
          message: `Not sent to ${missed.name} — its turn ended before it took the message. The other agents got it.`,
          severity: 'warning',
          caption: 'Not sent',
          nodeId: missed.memberId,
        });
      }
      return null;
    };
    /** A root's own turn ended: what it was handed and did not drop, it took. */
    const forgetRootDeliveries = async (memberId: string): Promise<void> => {
      for (const [deliveryId, rooted] of [...rootDeliveries]) {
        if (rooted.memberId !== memberId) {
          continue;
        }
        rootDeliveries.delete(deliveryId);
        rooted.delivery.took += 1;
        await settleSharedDelivery(rooted.delivery);
      }
    };
    /**
     * Calls a CALLER asked to stop (`cancel_agent`), by call id.
     *
     * A mark rather than only a `handle.cancel()`, because the commonest call
     * worth cancelling has no handle yet: it is queued under the run's
     * active-turn cap, which a fan-out keeps full. `launchCalleeTurn` reads
     * this at the points it already reads the run's own cancel, and the cancel
     * also takes the call out of the queue (`queuedStarts`), so such a call
     * settles `cancelled` at once without ever spawning a process.
     *
     * Bounded by the per-run turn cap and freed with the run's closure.
     */
    const cancelledCalls = new Set<string>();
    // The run's lead — where the seed goes, and where a follow-up goes while
    // the run is live. A relay hand-off moves it mid-pass.
    const leadIds = new Set<string>(run.lead === null ? [] : [run.lead]);
    /**
     * Leads the run was just handed to, until their hand-off turn opens: a
     * message waits (RUN_BUSY) so the brief reaches the new lead first.
     * Bounded, so a hand-off wake that never arrives holds nothing for good.
     */
    const handingOver = new Map<string, ReturnType<typeof setTimeout>>();
    /** Members whose own turn is HELD for background sub-agents right now. */
    const heldOwnTurns = new Set<string>();
    const tookOver = (memberId: string): void => {
      clearTimeout(handingOver.get(memberId));
      handingOver.delete(memberId);
    };
    // Every turn the pass started counts: a message sent while the pass is
    // still under way waits for it — only CALLS run on past an idle Manager.
    // Going idle during a cancel is recorded silently: an idle announce is
    // what drains the queue, and Stop must never be answered by sending the
    // next message.
    const markRootWorking = (
      memberId: string,
      on: boolean,
      monitorProgress = false,
    ): void => {
      this.setRootWorking(
        runId,
        memberId,
        on,
        on || !cancelRequested,
        !on && monitorProgress,
      );
    };
    /**
     * Follow-up turns on agents whose own turn has ended, keyed by member — see
     * `continueNode`. Cancel fans to these as it does to callee sub-turns, and
     * they hold the run open the same way.
     */
    const continuationHandles = new Map<string, AgentTurnHandle>();
    // Validation awaits reserve a launch before a process handle exists.
    const startingPassMembers = new Set<string>();
    const startingContinuations = new Map<
      string,
      { ready: Promise<void>; release: () => void }
    >();
    const reserveContinuation = (memberId: string) => {
      const reserved = startingContinuations.get(memberId);
      if (reserved) {
        return reserved;
      }
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const starting = { ready, release };
      startingContinuations.set(memberId, starting);
      return starting;
    };
    /**
     * The automatic compactions running right now — reached by the run's
     * cancel like every other live turn. See `compactIfDue`.
     */
    const compactionHandles = new Set<AgentTurnHandle>();
    /**
     * The window each member's conversation last reported, in tokens — what the
     * CLI's OWN auto-compaction is given a share of (the turn's `autoCompact`).
     *
     * Per MEMBER rather than per conversation, and that is exact rather than
     * loose: what is stored is the MODEL's window, which is the same figure for
     * a member's own turn and for every call turn it serves, since they run
     * the same model. `nodeStateDao.rememberContext` is written per member for
     * the same reason. The token COUNT is the per-conversation half and is
     * deliberately not here — nothing in this map is a reading of how full
     * anything is.
     *
     * Seeded from the earlier passes' readings (`RunContext.nodeWindows`); a
     * member with none yet falls back to its model's measured window at the
     * turn (`PartialStreamService.knownWindow`).
     */
    const nodeWindows = new Map<string, number>(run.nodeWindows);
    const rememberNodeWindow = (
      memberId: string,
      window: number | null,
    ): void => {
      if (window !== null && window > 0) {
        nodeWindows.set(memberId, window);
      }
    };
    /**
     * Nodes whose OWN conversation is being compacted. A follow-up is refused
     * while a member is here rather than delivered into the compaction.
     *
     * A WAKE needs no such guard: the member's turn is still retained while it
     * compacts, so the broker reads its caller as live and wakes nobody, and
     * the wake `drainCaller` issues at the settle is queued behind that settle.
     */
    const compactingNodes = new Set<string>();
    /**
     * The CLI session each member's own turns reported in THIS pass, so a
     * follow-up can still resume the conversation after the registry has
     * reaped the kept process. Callee turns resume per call, not from here.
     */
    const nodeSessionIds = new Map<string, string>();
    const nodePoolMembers = new Map(run.nodePoolMembers);
    const nodePoolPins = new Set(run.nodePoolPins.keys());
    /**
     * Each member's session from an earlier pass, until its conversation moves
     * to another pool member — that session belongs to the account it left.
     */
    const resumeSessions = new Map(run.resumeSessions);
    /**
     * Pinned members whose conversation the user moved before any turn ran on
     * the new pool member: no session to resume there, so the next turn opens
     * with a transcript excerpt instead.
     */
    const nodePoolExcerpts = new Set(
      [...run.nodePoolPins]
        .filter(([id, moved]) => moved && !resumeSessions.has(id))
        .map(([id]) => id),
    );
    /**
     * Members whose own turn in this pass, or a follow-up of it, ended other
     * than completed, until a later follow-up of their own completes. A woken
     * run settles failed while any is left — see {@link settleReopenedIfIdle}.
     */
    const failedMembers = new Set<string>();
    /** This pass's `liveRuns` entry — removed only by the pass that set it. */
    let liveControl: LiveRunControl | null = null;
    /**
     * The calls each callee process has served since it was spawned — what its
     * closer closes the stranded work of. One conversation's process is
     * continued by several calls, and a delegate the first launched is still
     * running inside it after the second has taken the next turn.
     */
    const callsBySessionKey = new Map<string, Set<string>>();
    /**
     * The run's cap on callee turns working at once (`Team.maxActiveTurns`,
     * never above this machine's ceiling), at every call depth. Only a FRESH
     * turn waits for room; see `utils/turn-semaphore.ts` for why a blocked
     * turn stops counting and a resumed one or a wake never queues.
     */
    const turnCap = Math.min(
      team.maxActiveTurns ?? this.parallelism,
      this.parallelism,
    );
    const activeTurns = createTurnSemaphore(turnCap);
    /** Each counted callee turn's slot, by the conversation it speaks in. */
    const turnSlots = new Map<string, TurnSlot>();
    /**
     * Conversations the broker reports BLOCKED (`RunCallCapability.turnBlocked`)
     * — kept so a slot taken while its conversation is blocked starts blocked.
     */
    const blockedConversations = new Set<string>();
    /** The way out of the queue for each call waiting to start, by call id. */
    const queuedStarts = new Map<string, AbortController>();
    const holdTurnSlot = (caller: string, slot: TurnSlot): void => {
      turnSlots.set(caller, slot);
      if (blockedConversations.has(caller)) {
        slot.block();
      }
    };
    const dropTurnSlot = (caller: string, slot: TurnSlot): void => {
      slot.release();
      if (turnSlots.get(caller) === slot) {
        turnSlots.delete(caller);
      }
    };
    const noteTurnBlocked = (caller: string, blocked: boolean): void => {
      if (blocked) {
        blockedConversations.add(caller);
        turnSlots.get(caller)?.block();
      } else {
        blockedConversations.delete(caller);
        turnSlots.get(caller)?.unblock();
      }
    };
    let liveSubTurns = 0;
    const calleeTurnCounts = new Map<string, number>();
    // Live turns per member id — the approval sweep must wait for a member's LAST
    // turn (a member can hold its own turn and callee turns at once).
    const liveTurnsByNode = new Map<string, number>();
    const retainNodeTurn = (memberId: string): void => {
      liveTurnsByNode.set(memberId, (liveTurnsByNode.get(memberId) ?? 0) + 1);
    };
    const releaseNodeTurn = (memberId: string): boolean => {
      const next = (liveTurnsByNode.get(memberId) ?? 1) - 1;
      if (next <= 0) {
        liveTurnsByNode.delete(memberId);
        return true;
      }
      liveTurnsByNode.set(memberId, next);
      return false;
    };
    /**
     * Live turns per CONVERSATION (caller key, `utils/caller-key.ts`) — what
     * the broker's liveness question is answered from.
     *
     * Not the member count above, which counts a member's callee turns too:
     * by that count a member whose OWN conversation has ended reads as live
     * while any call to it runs, so a question or a result owed to that
     * conversation would neither reach it (nothing can be handed to a turn it
     * does not have) nor wake it — and a callee that is itself a caller would
     * be woken as the MEMBER, in a new process with none of the call's
     * context.
     */
    const liveConversations = new Map<string, number>();
    const retainConversation = (caller: string): void => {
      liveConversations.set(caller, (liveConversations.get(caller) ?? 0) + 1);
      if (callerConversationOf(caller) === null) {
        this.commandEndWakes?.turnStarted(memberWakeOwner(runId, caller));
      }
    };
    /**
     * One conversation's turn has ended: it is live no more, and what its
     * callees left it — a parked question, an uncollected result — is drained
     * to it now (`CallBroker.drainCaller`), each conversation on its own.
     */
    const endConversationTurn = (caller: string): void => {
      const next = (liveConversations.get(caller) ?? 1) - 1;
      if (next > 0) {
        liveConversations.set(caller, next);
        return;
      }
      liveConversations.delete(caller);
      if (callerConversationOf(caller) === null) {
        this.commandEndWakes?.turnEnded(memberWakeOwner(runId, caller));
      }
      // A message the turn never took reaches the conversation as its next
      // turn's prompt, not inside a wait of this one.
      this.callBroker.forgetUserMessage(runId, caller);
      this.callBroker.drainCaller(runId, caller);
      // What the turn was handed and did not drop, it took. What it dropped is
      // delivered again now — after the drain, so it joins any turn the drain
      // opened rather than racing it.
      for (const [deliveryId, prompted] of promptDeliveries) {
        if (prompted.caller === caller) {
          promptDeliveries.delete(deliveryId);
        }
      }
      const dropped = droppedPrompts.get(caller) ?? [];
      droppedPrompts.delete(caller);
      for (const redeliver of dropped) {
        redeliver();
      }
      this.notifyConversationTurnEnded(runId, caller);
    };
    let cancelRequested = false;
    /**
     * Whether the run's cancel came from somebody ASKING — a Stop, an archive,
     * a delete — rather than from the shutdown reap. Decided by the FIRST
     * cancel, which is the only one the aggregate handle acts on: a Stop
     * pressed a moment before quitting is still the user's, and the reap that
     * follows it changes nothing.
     */
    let stoppedByUser = false;
    /**
     * Whether this pass is ending because the DAEMON is going away rather than
     * because anyone stopped it — see {@link TeamExecutorService.shuttingDown}.
     * Read at the two places a run's own status is written from a walk, and
     * only for an ending other than `completed`: a pass whose every member
     * finished as the shutdown began completed, and says so.
     */
    const endedByShutdown = (status: RunStatus): boolean =>
      status !== 'completed' && this.shuttingDown && !stoppedByUser;
    let runFinished = false;
    /**
     * Whether the run's current reopened stretch was started by output of
     * monitors still running alone — its settle is then a host turn's
     * (`hostTurn`), which posts no banner. Set only by the wake that reopens
     * the run; any other turn, wake or user message in the stretch clears it
     * for the rest of it.
     */
    let wokenOnlyByMonitors = false;
    let persistenceFailed = false;

    // One serialized write chain for the whole pass: persist-then-emit ordering
    // stays correct while N members stream at once. The seq itself comes from the
    // SHARED allocator rather than a counter of this pass's own, because this
    // pass is no longer the run's only writer: its agents' processes outlive
    // it, and what they do between passes is written by the sinks of the pass
    // that spawned them while a later pass may already be writing.
    let chain: Promise<void> = Promise.resolve();
    const enqueue = (work: () => Promise<void> | void): void => {
      chain = chain.then(work).catch((err: unknown) => {
        persistenceFailed = true;
        this.logger.error(
          `team run ${runId} event handling failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    };

    /** Resolves once every write queued so far has run. */
    const drained = (): Promise<void> =>
      new Promise<void>((resolve) => {
        enqueue(() => resolve());
      });

    const persistItem = async (
      memberId: string | null,
      kind: ItemKind,
      role: string | null,
      payload: unknown,
    ): Promise<ItemWire> =>
      this.persist(
        em,
        runId,
        memberId,
        await this.seqs.reserve(runId),
        kind,
        role,
        payload,
      );

    /**
     * Add the wall time of this member's settled turns its CLI did not time
     * (`WallWorkService`). Run on this chain after the turn's
     * `turn_complete` row is written. Bookkeeping, so a failure is logged and
     * never fails the turn — the next catch-up (or the boot sweep) finds the
     * turn still above the member's mark.
     */
    const catchUpWallWork = (memberId: string): Promise<void> =>
      this.wallWork.catchUpNode(runId, memberId, em).catch((err: unknown) => {
        this.logger.warn(
          `wall work for team run ${runId} member ${memberId} not measured: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

    /**
     * Drop one member's pending approvals NOW and hand back the work that
     * records each as `unanswerable`.
     *
     * Two halves because they belong at different moments: the sweep must be
     * synchronous at the settle point (a verdict must not slip into the gap),
     * while the rows are written on the serialized chain like every other
     * item. One helper for all FOUR settle paths in this method — a path that
     * swept without writing the rows would leave a card on screen with live
     * buttons that answer into nothing, which is precisely the reported bug.
     */
    const sweepApprovals = (memberId: string): (() => Promise<void>) =>
      recordUnanswerable(memberId, this.approvals.sweepNode(runId, memberId));

    /**
     * The row-writing half of a sweep, for cards already dropped from the
     * registry — shared by the member-wide sweep above and a single turn's own
     * retirement (`beginAgentTurn`'s `retireCards`).
     */
    const recordUnanswerable = (
      memberId: string,
      swept: ReturnType<ApprovalRegistry['sweepNode']>,
    ): (() => Promise<void>) => {
      // Every settle path sweeps through here, so this one announce is what
      // takes the badge down for all four — a swept card is no longer
      // something the run waits on.
      if (swept.length > 0) {
        this.announceAwaiting(runId);
      }
      return async () => {
        for (const approval of swept) {
          await persistItem(memberId, 'unanswerable', null, {
            ...unanswerablePayload(approval),
            nodeId: memberId,
          }).catch((err: unknown) => {
            this.logger.error(
              `team run ${runId} unanswerable item write failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      };
    };

    /**
     * State the ending of the work this run's transcript still declares out:
     * every delegate and — with `withShells` — every detached command, or only
     * what ONE session's process was running when `scope` names it.
     *
     * The process that owed each ending is gone or about to be: a delegate
     * lives inside the CLI process that launched it, and a detached command is
     * that process's own child. `ChatService`'s session-close hook cannot say
     * so for a team run: it keys by RUN and is handed this executor's
     * per-turn session key.
     *
     * Read from the transcript, so one fold answers both callers, and written
     * through `persistItem`, so the rows take this run's own seq.
     */
    const closeStrandedWork = async (
      scope: { callId: string } | { memberId: string } | null,
      withShells: boolean,
      /** The user's Stop is what ended the process. */
      stopped = false,
    ): Promise<void> => {
      const inScope = (unit: {
        memberId: string | null;
        callId: string | null;
      }): boolean =>
        scope === null ||
        ('callId' in scope
          ? unit.callId === scope.callId
          : unit.callId === null && unit.memberId === scope.memberId);
      const closes: {
        event: AgentEvent;
        owner: { memberId: string | null; callId: string | null };
      }[] = [];
      for (const delegate of strandedDelegates(
        await this.itemDao.subagentInfoRows(runId, em),
      )) {
        if (inScope(delegate)) {
          closes.push({
            event: stopped
              ? delegateCloseEvent(delegate.id, 'stopped')
              : processEndedCloseEvent(delegate.id),
            owner: delegate,
          });
        }
      }
      if (withShells) {
        for (const shell of strandedShells(
          await this.itemDao.shellRows(runId, em),
        )) {
          if (inScope(shell)) {
            closes.push({ event: shellCloseEvent(shell), owner: shell });
          }
        }
      }
      for (const { event, owner } of closes) {
        // The count comes down with the row that states the ending.
        this.backgroundWork.record(runId, event, owner.memberId);
        const mapped = mapEventToItem(event);
        if (mapped) {
          await persistItem(owner.memberId, mapped.kind, mapped.role, {
            ...(mapped.payload as Record<string, unknown>),
            ...ownerFields(owner),
          });
        }
      }
    };

    let resolveAllDone!: () => void;
    /**
     * The aggregate handle THIS pass registered last — what tells the pass's own
     * registry entry apart from a LATER pass's claim on the same run (see
     * {@link supersededByNextPass}).
     */
    let ownAggregate: AgentTurnHandle | null = null;
    /**
     * Register a fresh aggregate handle for this run — once at the start of the
     * pass, and again each time the run WAKES BACK UP for work its own agents
     * started (see {@link reopenRun}).
     *
     * A handle's `done` is fixed when the handle is built and the registry
     * drops an entry whose `done` has settled, so waking up needs a NEW one:
     * re-using the settled handle would leave the callee turn spawned
     * afterwards reachable by neither Stop nor shutdown — which is exactly the
     * objection `launchCalleeTurn` used to answer by refusing the call.
     *
     * {@link resolveAllDone} is re-assigned with it, so a finalizer that has
     * already run cannot settle the handle its own successor registered.
     */
    const registerAggregate = (): void => {
      const done = new Promise<void>((resolve) => {
        resolveAllDone = resolve;
      });
      const aggregateHandle: AgentTurnHandle = {
        done,
        cancel: () => {
          if (cancelRequested) {
            return;
          }
          cancelRequested = true;
          stoppedByUser = !this.shuttingDown;
          for (const handle of runningHandles.values()) {
            handle.cancel();
          }
          for (const { handle } of subTurns.values()) {
            handle.cancel();
          }
          for (const queued of queuedStarts.values()) {
            queued.abort();
          }
          for (const handle of continuationHandles.values()) {
            handle.cancel();
          }
          for (const handle of compactionHandles) {
            handle.cancel();
          }
          // A call HELD for its callee's own calls runs no turn to cancel.
          this.callBroker.releaseHolds(runId);
          // Nodes that never started settle as cancelled in the next pass.
          enqueue(() => schedule());
        },
        // Approvals route through the ApprovalRegistry per request, not the
        // aggregate — a run-level respond has no single target turn.
        respondApproval: () => false,
        // Same reason: a run fanning out over N members has no ONE conversation a
        // follow-up belongs to. A team's follow-up goes through
        // `sendMessage`, which hands it to the agents the trigger feeds.
        sendUserMessage: () => false,
        attributableDelegate: () => null,
        setApprovalMode: () => false,
      };
      ownAggregate = aggregateHandle;
      this.registry.register(runId, aggregateHandle);
    };
    registerAggregate();

    /**
     * Whether a LATER pass of this run holds it now — a follow-up message's walk
     * has claimed the registry (or already registered its own handle), so this
     * pass, and the call surface it registered, are about to be replaced.
     *
     * Only meaningful once this pass has finished: until then its own handle is
     * the registry entry and no follow-up can claim over it. A kept process can
     * still reach this pass's call surface in that window, and serving it there
     * was what put two passes on one run — the wake's `register` overwrote the
     * claim, so the follow-up's walk started too, its broker registration
     * replaced the call the wake had minted (`UNKNOWN_CALL` on collection), and
     * Stop reached only the newer handle, leaving the first callee running.
     */
    const supersededByNextPass = (): boolean =>
      runFinished &&
      this.registry.has(runId) &&
      this.registry.runningHandle(runId) !== ownAggregate;

    /**
     * Whether the pass's own bookkeeping failed, as it stood when the pass
     * rolled up. A woken run stays failed for it, but a write that fails
     * during a wake does not pin every later wake as well.
     */
    let passPersistenceFailed = false;
    /**
     * The status the run's last closing `team_<status>` row names, or null
     * while none has been written. A woken run writes a closing row of its own
     * only when it settles to a different status, so the feed never ends on
     * a stale one while a wake that changes nothing adds no row.
     */
    let closingRowStatus: RunStatus | null = null;
    /** The run is AWAKE again, for work its own agents started. */
    let reopened = false;
    /**
     * The pass's roll-up while it is being written, so a call arriving in that
     * window waits for it instead of racing it — see {@link reopenRun}.
     */
    let finalizing: Promise<void> | null = null;
    /**
     * A wake's settle while it writes the pass's status back — the twin of
     * {@link finalizing} for {@link settleReopenedIfIdle}, and null when none
     * is in flight.
     */
    let sleeping: Promise<void> | null = null;

    /**
     * Wake the run back up for a call one of its agents makes after the pass
     * has ended.
     *
     * A member's CLI process is KEPT between passes, so a Manager that set itself
     * a timer wakes on its own and dispatches to its team — into a run that had
     * already let go of everything needed to run one. That is why the call used
     * to be refused outright, and the refusal reached the agent as
     * `RUN_NOT_ACTIVE: this run is not accepting agent calls`: REPORTED after a
     * Manager woke on time with three briefs prepared and could not hand out a
     * single one, having spent hours getting them ready.
     *
     * So the refusal becomes a WAKE. The run's own PASS is deliberately
     * untouched — `runFinished` stays true — so a USER's follow-up still walks
     * a fresh pass from the trigger rather than being delivered into a walk
     * that is over, which is the one thing here that already worked.
     *
     * It answers `stopped` for a run that must not wake, and re-reads the row
     * to decide rather than trusting this closure: the call surface now
     * outlives the walk, and an archive stops the run through the registry
     * without this pass ever hearing of it. It answers `superseded` when a
     * follow-up message has claimed the run for its next pass meanwhile
     * ({@link supersededByNextPass}) — decided in the same synchronous stretch
     * as the registration, since the claim lands during the awaits above it.
     */
    const reopenRun = async (
      monitorProgress = false,
    ): Promise<'awake' | 'stopped' | 'superseded'> => {
      if (!monitorProgress) {
        wokenOnlyByMonitors = false;
      }
      // The roll-up writes this run's terminal status; waking ahead of it puts
      // `running` on the row and has it overwritten a moment later.
      await finalizing;
      // The same for a previous wake going back to sleep, which has already
      // said `reopened = false` and is writing the pass's status. Waking under
      // it registered a handle that settle then resolved as its own — dropping
      // the registry entry of a run with a callee still spawning, so Stop found
      // nothing, a delete waited on nothing and a follow-up could walk a second
      // pass beside it — and its status landed over this wake's `running`. A
      // loop, because the check below must see no settle in flight at the
      // moment it reads `reopened`, and another may have begun while this one
      // was awaited.
      while (sleeping !== null) {
        await sleeping;
      }
      if (cancelRequested || this.deleting.has(runId)) {
        return 'stopped';
      }
      if (reopened) {
        return 'awake';
      }
      const run = await this.runDao.getById(runId, em);
      if (!run || run.archivedAt !== null || run.status === 'cancelled') {
        return 'stopped';
      }
      // Asked again after the read: two calls waking the run at once both got
      // past the check above, and each registered a handle — the first of
      // which nothing would ever settle.
      if (reopened) {
        return 'awake';
      }
      if (cancelRequested || this.deleting.has(runId)) {
        return 'stopped';
      }
      // A follow-up's walk claimed the run during the awaits above. Registering
      // now would overwrite that claim — see `supersededByNextPass`.
      if (supersededByNextPass()) {
        return 'superseded';
      }
      reopened = true;
      wokenOnlyByMonitors = monitorProgress;
      registerAggregate();
      // A user's message reaches an AWAKE run through the same control a live
      // pass offers — the wake holds the run's claim, so the walk a settled run
      // takes instead would refuse every message RUN_BUSY for as long as the
      // woken work runs.
      if (liveControl !== null) {
        this.liveRuns.set(runId, liveControl);
      }
      await this.setRunStatus(em, runId, 'running');
      return 'awake';
    };

    /**
     * Put the run back once the work it woke for has drained — the other half
     * of {@link reopenRun}, and the only thing that settles the handle that one
     * registered.
     *
     * Reached through {@link finishRunIfSettled}, which every path already
     * calls after decrementing `liveSubTurns`; a second settle point of its own
     * would be one more place for a path to forget.
     */
    const settleReopenedIfIdle = async (): Promise<void> => {
      if (!reopened || liveSubTurns > 0) {
        return;
      }
      reopened = false;
      // Back to a settled run, whose messages walk a fresh pass.
      if (liveControl !== null && this.liveRuns.get(runId) === liveControl) {
        this.liveRuns.delete(runId);
      }
      // THIS wake's handle, captured before the write — the rule
      // `finishRunIfSettled` follows for the pass's own. `reopenRun` now waits
      // for this settle, so nothing re-assigns `resolveAllDone` under it; the
      // capture is what keeps that true if a second path ever registers one.
      const settleWake = resolveAllDone;
      let slept!: () => void;
      sleeping = new Promise<void>((resolve) => {
        slept = resolve;
      });
      try {
        const status = cancelRequested
          ? 'cancelled'
          : passPersistenceFailed || failedMembers.size > 0
            ? 'failed'
            : 'completed';
        // A wake the shutdown ended leaves the `running` it wrote, on the
        // roll-up's own terms below.
        if (!endedByShutdown(status)) {
          // Without a closing row the open thread's working state is this
          // announce's to end; with one, the row ends it, as a pass's does.
          const closes = status !== closingRowStatus;
          await this.setRunStatus(em, runId, status, {
            ...(closes ? {} : { noTerminalItem: true }),
            ...(wokenOnlyByMonitors ? { hostTurn: true } : {}),
          });
          if (closes) {
            await persistItem(null, 'turn_complete', null, {
              usage: null,
              stopReason: `team_${status}`,
            });
            closingRowStatus = status;
          }
          wokenOnlyByMonitors = false;
          if (status === 'completed' && !this.shuttingDown) {
            this.notifyRunSettledCompleted(runId);
          }
        }
      } finally {
        // The handle settles even if the write failed, as the pass's own does
        // — otherwise the registry entry outlives the work it stood for.
        settleWake();
        sleeping = null;
        slept();
      }
    };

    const finishRunIfSettled = async (
      monitorProgress = false,
    ): Promise<void> => {
      // Sub-turns stay OUT of the denominator, but a live one (a
      // fire-and-forget still streaming) holds the run open until it settles.
      if (runFinished) {
        // The PASS is over, so there is nothing here left to roll up — but the
        // run may have woken since for work its own agents started, and this is
        // the one point every path reaches after decrementing `liveSubTurns`.
        await settleReopenedIfIdle();
        return;
      }
      if (settled.size !== passMembers.length || liveSubTurns > 0) {
        return;
      }
      runFinished = true;
      // Captured BEFORE the body: from here on a call can wake the run, and a
      // wake re-assigns `resolveAllDone` to the handle IT registered.
      const settlePass = resolveAllDone;
      let finalized!: () => void;
      // What {@link reopenRun} waits on. `runFinished` is already true, so a
      // call arriving now would otherwise race the roll-up below and have its
      // `running` overwritten by this pass's own terminal status.
      finalizing = new Promise<void>((resolve) => {
        finalized = resolve;
      });
      // EVERY final write is inside the try: the skipped-marking loop, the
      // status roll-up, and the run update must all sit under the finally, or
      // a SQLite failure in the skipped loop would leave runFinished true with
      // the aggregate handle never settling — the registry entry and call
      // token would leak and the run would wedge as `running` forever.
      try {
        // A call-only member no pass has called (still `pending`, since
        // `calleeTurnCounts` counts this pass only) settles 'skipped' so its
        // chip does not read as pending forever — in `node_state` alone, with
        // no transcript row: the agents panel says what became of every
        // member, and the transcript records what happened, which for an
        // uncalled member is nothing.
        for (const node of nodes) {
          if (
            passMemberIds.has(node.id) ||
            (calleeTurnCounts.get(node.id) ?? 0) > 0
          ) {
            continue;
          }
          const state = await this.nodeStateDao.getByRunNode(
            runId,
            node.id,
            em,
          );
          if (state !== null && state.status !== 'pending') {
            continue;
          }
          await this.nodeStateDao.setStatus(
            runId,
            node.id,
            { status: 'skipped', endedAt: Date.now() },
            em,
          );
        }
        // A delegate or detached command still out at the end of a pass is NOT
        // stranded: its process is kept (see the `finally`), so it is still
        // running and says its own ending when it has one. What dies with a
        // process is written when that process goes, by its closer.
        //
        // A user cancel rolls up cancelled; any other non-completed member (a
        // failure, or a CLI killed externally without cancel()) is a failure,
        // so the run must never read as success.
        for (const [memberId, outcome] of settled) {
          if (outcome !== 'completed') {
            failedMembers.add(memberId);
          }
        }
        const status = cancelRequested
          ? 'cancelled'
          : failedMembers.size > 0 || persistenceFailed
            ? 'failed'
            : 'completed';
        passPersistenceFailed = persistenceFailed;
        if (endedByShutdown(status)) {
          // Nobody stopped this run: the daemon is shutting down, and that is
          // what ended its turns. Neither the status nor the closing
          // `team_<status>` row is written — the run stays `running`, and
          // the next boot's reconcile closes it with the `interrupted` error a
          // SIGKILL leaves, which is what the task board reads it as.
          this.logger.log(
            `team run ${runId}: pass ended by the daemon shutting down — left running for the next boot to close as interrupted`,
          );
        } else {
          await this.setRunStatus(
            em,
            runId,
            status,
            monitorProgress && status === 'completed' ? { hostTurn: true } : {},
          );
          await persistItem(null, 'turn_complete', null, {
            usage: null,
            stopReason: `team_${status}`,
          });
          closingRowStatus = status;
          if (status === 'completed' && !this.shuttingDown) {
            this.notifyRunSettledCompleted(runId);
          }
        }
      } catch (err) {
        persistenceFailed = true;
        passPersistenceFailed = true;
        this.logger.error(
          `team run ${runId} finalization failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        await this.setRunStatus(em, runId, 'failed').catch(
          (statusErr: unknown) => {
            this.logger.error(
              `team run ${runId} failure-status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
            );
          },
        );
        closingRowStatus = 'failed';
        await persistItem(null, 'error', null, {
          message: 'team finalization persistence failed',
        }).catch((itemErr: unknown) => {
          this.logger.error(
            `team run ${runId} terminal failure item write failed: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
          );
        });
      } finally {
        // First, so a follow-up arriving during the teardown below is walked
        // again from the trigger instead of being handed to a process that is
        // being closed.
        if (liveControl !== null && this.liveRuns.get(runId) === liveControl) {
          this.liveRuns.delete(runId);
        }
        // After the status: leads going idle under a run still `running` is
        // the Manager replying with calls out, which marks the thread unread.
        for (const memberId of leadIds) {
          markRootWorking(memberId, false, monitorProgress);
        }
        // The aggregate handle MUST settle even if the final writes fail, or
        // the ProcessRegistry entry leaks and the run can never be re-driven.
        //
        // The agents' PROCESSES are deliberately left running, as a chat's are
        // between its turns: a reply ends a PASS, not the conversation, and what
        // an agent started in the background — a dev server the user is about
        // to open — lives inside its process. REPORTED as "This site can't be
        // reached" right after a Manager started `web` and `api` and handed over
        // the links: closing every session here killed both the moment its
        // reply settled. The next message reuses each kept process (same key);
        // the registry reaps one that goes unused, never while a detached
        // command is still running; and a delete or archive ends them all
        // (`AgentSessionRegistry.closeRun`). Their closers stay armed, so the
        // endings of what dies with a process are still written when it goes.
        //
        // The call surface OUTLIVES the pass, exactly as the processes above
        // do and for the same reason: a kept Manager wakes on its own when
        // work it backgrounded reports back, and dispatching to its team is
        // the whole of what it wakes up to do. It used to be dropped here, so
        // that call was answered `RUN_NOT_ACTIVE` and the team went unused.
        // `reopenRun` is what makes serving it safe; a later pass REPLACES the
        // registration, and the run's teardown drops it along with the caller
        // tokens — which were already kept for this reason, a kept process
        // presenting the token it spawned with.
        //
        // The live plane's per-member state ends with the pass, exactly as a
        // chat's ends with its turn. The remembered window survives (it
        // describes the model), so a re-run of the same team is scaled from
        // its first request.
        this.partials.clearRun(runId);
        // THIS pass's handle, captured before the body ran: a call that woke
        // the run meanwhile has registered a handle of its own, and settling
        // that one here would drop a registry entry whose callee is still
        // spawning.
        settlePass();
        finalized();
      }
    };

    /**
     * What the member's requested approval mode actually becomes, answered by
     * the CLI's own adapter: a mode the installed binary was PROVED to reject
     * degrades, an unprobed one rides through so a genuine rejection stays
     * loud, and a CLI with no permission channel at all lands on auto. The
     * degrade line is surfaced by persistTurnStart below, never silent.
     */
    // Settled once per run, per CLI: a member is judged only by its own CLI's
    // verdict, and a CLI no member asked a probed mode of reads as unprobed.
    const resolveApproval = (node: TeamMember): ApprovalResolution =>
      this.adapterFor(node.agent).resolveApprovalMode(
        node.approval,
        approvalSupport.get(node.agent) ?? { supported: {} },
      );

    /**
     * The member's "turn is starting" bookkeeping shared by the pass's own
     * launches and callee sub-turns: node_state → running, the status item, and the
     * approval-degrade note. A callee sub-turn passes its callId so the
     * renderer can attribute the status to ONE call even when two parallel
     * calls target the same member.
     *
     * It also ENDS an off-turn stretch the same conversation was still
     * carrying — the third of {@link restoreOffTurnNodeBadge}'s endings, and
     * the one that is reached on ACP at all. A continuation's own terminal
     * event never comes there (an agent speaking unprompted is answered by no
     * `session/prompt` reply), and the process is KEPT, so the close could be
     * half an hour away: a `thread:` continuation was handed the very process
     * still holding the badge, the stretch's `running` row was never answered,
     * and the renderer counted that callee as working for good. Measured on
     * run `20a2b92b`: QA's call-8 stretch took the badge at 23:41:50, call-9
     * continued the thread at 23:47:23, and an empty `QA · Forging…` block
     * stood at the end of the transcript long after call-9 completed. A turn
     * of ours starting on the process is proof the stretch is over.
     */
    const persistTurnStart = (
      node: TeamMember,
      sessionKey: string,
      callId: string | null = null,
      pool: {
        /** The settings holding the member's own conversation. */
        stamp: TeamMember;
        /** False for a later attempt: the call's first one already said so. */
        announce: boolean;
      } = { stamp: node, announce: true },
    ): void => {
      enqueue(async () => {
        await restoreOffTurnNodeBadge(sessionKey);
        await this.nodeStateDao.setStatus(
          runId,
          node.id,
          // agentKind and model stamp WHAT ran this turn — the terminal mirror
          // must resume against both even after the team YAML is edited.
          {
            status: 'running',
            startedAt: Date.now(),
            agentKind: pool.stamp.agent,
            model: pool.stamp.model ?? null,
          },
          em,
        );
        // One `running` row per CALL, balanced by its one ending: an attempt
        // the pool hands on writes no ending, so a later one writes no start.
        if (pool.announce) {
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: 'running',
            ...(callId ? { callId } : {}),
          });
        }
        const degradeReason = resolveApproval(node).degradeReason;
        if (degradeReason !== null) {
          // A degrade the user cannot see reads as enforced permissions that
          // never were — so ANY mode the CLI could not honour says so here,
          // not just the one that looks dangerous.
          await persistItem(node.id, 'system', null, {
            message: degradeReason,
          });
        }
      });
    };

    /**
     * Say a member is working again, for an off-turn row that means it is.
     *
     * A team member's liveness is read off its `status` ROWS and nothing
     * else: the renderer counts `running` rows against terminal ones
     * (`computeAgentActivity`'s `activeTurns`) and draws its live row from that
     * count, so rows arriving with no `running` above them draw nothing —
     * whatever the RUN's own badge says, which is a different question and is
     * answered by `shellsOpen`. Writing this pair is therefore what makes the
     * stretch visible, and — just as much — what ENDS it, since the terminal
     * row is what takes the count back down.
     *
     * Once per stretch: the map is the CLAIM as well as the memory.
     */
    const takeOffTurnNodeBadge = async (
      sessionKey: string,
      memberId: string,
      callId: string | null,
    ): Promise<void> => {
      if (this.offTurnNodes.has(sessionKey)) {
        return;
      }
      const status = (await this.nodeStateDao.getByRunNode(runId, memberId, em))
        ?.status;
      // Only a member whose turn has ENDED has a badge to take — see
      // {@link NODE_OUTCOMES}. A member with no row at all is one this run never
      // started, and is not this stretch's to describe.
      if (status === undefined || !NODE_OUTCOMES.has(status)) {
        return;
      }
      this.offTurnNodes.set(sessionKey, {
        memberId,
        callId,
        restoreTo: status as NodeOutcome,
      });
      await this.nodeStateDao.setStatus(
        runId,
        memberId,
        { status: 'running' },
        em,
      );
      await persistItem(memberId, 'status', null, {
        nodeId: memberId,
        status: 'running',
        ...(callId ? { callId } : {}),
        // Not a turn starting: `pausedSpansFrom` ends a lost card only on that.
        offTurn: true,
      });
    };

    /**
     * Hand a member's badge back when its off-turn stretch ends.
     *
     * Two endings, and neither can stand in for the other: the continuation's
     * own terminal event, and the PROCESS closing — which is the one that owed
     * that event, so once it is gone nothing else could ever take the row down.
     * The chat side learned the same thing the same way
     * (`settleAfterSessionClosed`).
     */
    const restoreOffTurnNodeBadge = async (
      sessionKey: string,
    ): Promise<void> => {
      const held = this.offTurnNodes.get(sessionKey);
      if (held === undefined) {
        return;
      }
      this.offTurnNodes.delete(sessionKey);
      await this.nodeStateDao.setStatus(
        runId,
        held.memberId,
        { status: held.restoreTo },
        em,
      );
      await persistItem(held.memberId, 'status', null, {
        nodeId: held.memberId,
        status: held.restoreTo,
        ...(held.callId ? { callId: held.callId } : {}),
      });
    };

    /**
     * Whether this agent kind may hold the call tools in THIS run — the shared
     * `callToolsAdmitted` rule, which the "May call" block also reads through
     * `holdsCallTools`, so a change there cannot silently miss a sibling gate.
     */
    const callCapable = (node: TeamMember): boolean =>
      callToolsAdmitted(this.adapterFor(node.agent).getConfig());

    /**
     * Nodes handed the MCP endpoint: EVERY call-capable agent, not callers
     * alone — otherwise a callee, and any member of an ordinary run, has none of
     * geniro's own tools at all, and an agent asked for a Geniro artifact
     * writes a real HTML page and opens it in a browser instead. What each
     * member is OFFERED on the endpoint is still decided per request: the call
     * tools need callees, the page tool the publisher below; the board tools
     * go to every holder, under the member's own approval mode.
     */
    const holdsEndpoint = (node: TeamMember): boolean => callCapable(node);

    /**
     * The member's MCP grant: every call-capable member gets the endpoint
     * (`holdsEndpoint`); what it is offered there depends on what it can use.
     * Null when the server has no bound port yet or the run's token is already
     * revoked.
     */
    const mcpEndpointFor = (
      node: TeamMember,
      /**
       * The callee conversation this turn speaks in, or null for the member's
       * own. It is the endpoint's last segment, and so the caller identity the
       * broker keys everything this process calls by (`utils/caller-key.ts`):
       * every conversation of a member is its own process, and a process can
       * only be told apart from its siblings by the address it was given.
       */
      conversationId: string | null = null,
    ): { url: string; token: string; serverName: string } | null => {
      if (!holdsEndpoint(node)) {
        return null;
      }
      const token = this.callTokens.get(runId, node.id);
      const port = this.runtime.port;
      if (token === null || port === null) {
        return null;
      }
      return {
        url: `http://127.0.0.1:${port}${hostEndpointPath(runId, node.id, conversationId)}`,
        token,
        // Per-run — see `AgentTurnInput.mcpEndpoint.serverName` for why.
        serverName: hostMcpServerName(runId),
      };
    };

    /**
     * Spawn one adapter turn for `node` and wire its event stream into the
     * transcript (session save, text/terminal capture, item persistence,
     * approval tracking). Shared by the pass's own launches and callee sub-turns — the
     * paths differ only in prompt source, handle registry, and settle
     * bookkeeping. `finish()` applies the synthetic-completion fallback (a
     * clean exit with no result line still completes) and is only meaningful
     * after `handle.done` AND the event chain drained — call it from an
     * enqueue()d continuation.
     */
    const beginAgentTurn = async (
      node: TeamMember,
      prompt: string,
      /**
       * A callee turn's identity: its call, the session it resumes when no
       * kept process holds the conversation, and the CONVERSATION it belongs
       * to — the call id its kept process is keyed by (see `sessionKey`).
       */
      callContext?: {
        callId: string;
        resumeSessionId?: string | null;
        conversationId: string;
        /** The callee pool member this turn runs as; absent without a pool. */
        poolMember?: number;
      },
      /**
       * What a member's OWN turn carries beyond its prompt: the session to resume
       * when no kept process holds the conversation, and the pictures a seed
       * or a follow-up came with. A callee's resume rides `callContext`.
       */
      extras: {
        resumeSessionId?: string | null;
        images?: TurnImage[];
        poolMember?: number;
        compaction?: boolean;
      } = {},
    ): Promise<{
      handle: AgentTurnHandle;
      finish: () => NodeTurnResult;
      /**
       * How the turn ended, known the moment its terminal event arrives —
       * {@link finish}'s outcome without waiting for the bookkeeping to drain.
       */
      endedAs: () => NodeOutcome;
      retireCards: () => () => Promise<void>;
    }> => {
      const adapter = this.adapterFor(node.agent);
      await adapter.validateModel(node.model);
      // Until this member has a reading of its own, its model's known window
      // arms the FIRST turn — see `firstTurnWindow`. Asked only of a member that
      // has a threshold, since resolving a model may probe the CLI, and ahead
      // of the stop check below so a Stop during the probe is still honoured.
      const firstWindow =
        node.autoCompactPercent && !nodeWindows.has(node.id)
          ? await firstTurnWindow(
              adapter,
              this.partials,
              node.model ?? null,
              node.configDir ?? null,
              node.contextWindow ?? null,
            )
          : null;
      if (
        cancelRequested ||
        !this.registry.canStart(runId) ||
        (callContext !== undefined && cancelledCalls.has(callContext.callId))
      ) {
        throw new Error('Team stopped before the agent could launch.');
      }
      // One registry key per CONVERSATION — see the note at `startTurn` below.
      const sessionKey = callContext
        ? callSessionKey(runId, callContext.conversationId)
        : nodeSessionKey(runId, node.id);
      // WHO this turn is, to the call broker: the member, in this conversation.
      const caller = callerKey(node.id, callContext?.conversationId ?? null);
      const plainTurn =
        !extras.compaction &&
        adapter.geniroCommandFor(prompt) === null &&
        !isSlashCommand(prompt);
      const deliveryNotice = plainTurn
        ? this.callBroker.messageDeliveryNotice(runId, caller)
        : null;
      const stageLine =
        plainTurn && stageMap !== null ? await this.stageNoticeOf(runId) : null;
      let deliveryNoticeAcknowledged = false;
      const threadMessages =
        plainTurn && callContext === undefined && leadIds.has(node.id)
          ? ((await this.threadInbox?.takeForTurn(runId, this.em.fork())) ?? [])
          : [];
      let threadMessagesTaken = false;
      // An automatic carried compaction replaced this conversation: its summary
      // rides this turn, once, and the session it replaced is not resumed.
      const carried = this.carriedSummaries.get(sessionKey) ?? null;
      this.carriedSummaries.delete(sessionKey);
      /**
       * Put the summary back for a turn that never delivered it — a start that
       * threw, or a turn that ended before its CLI opened a session. Without
       * it the conversation would resume the replaced session with no summary,
       * and measure its pre-compaction size as the new baseline.
       */
      const restoreCarried = (): void => {
        if (carried !== null && !this.carriedSummaries.has(sessionKey)) {
          this.carriedSummaries.set(sessionKey, carried);
        }
      };
      // The newest context reading this turn reported, for auto-compaction.
      let lastContextTokens: number | null = null;
      let lastWindowTokens: number | null = null;
      let firstContextTokens: number | null = null;
      let promptCacheTtlMs: number | null = null;
      const textChunks: string[] = [];
      let finalText: string | null = null;
      /**
       * How the turn ended, set as its terminal event ARRIVES rather than once
       * the event's bookkeeping drains — so a call learns it the moment the
       * turn is over (`endedAs`), and `finish` reads the same value.
       */
      let outcome: NodeOutcome | null = null;
      const endedAs = (): NodeOutcome =>
        outcome ?? (cancelRequested ? 'cancelled' : 'completed');
      /**
       * Tool calls not yet added to the member's total, counted here because no
       * CLI reports a total and the transcript a client loads is windowed.
       *
       * The `turn_complete` write zeroes it in the same breath: the durable
       * write ADDS, and `finish` adds whatever is left, so a count left
       * standing would be added twice.
       */
      let toolCalls = 0;
      // Never zeroed, unlike the counter above: whether the turn ACTED at all,
      // which decides if a failed pool member's call may be handed to the next.
      let madeToolCalls = false;
      // The turn's own CLI session — the broker's thread-resume handle.
      let capturedSessionId: string | null = null;
      /**
       * The last failure this turn's CLI reported, verbatim — the fact a CALLER
       * used to be denied (see `utils/callee-failure.ts`).
       *
       * The LAST rather than the first: a turn can report a recoverable error
       * and carry on, so what matters is whatever it said closest to ending.
       * Captured here, in the same closure `outcome` lives in, because the
       * `error` event is the only place the sentence exists — by `finish()` it
       * has already been written to the transcript and gone.
       */
      let lastError: string | null = null;
      /**
       * The cards THIS turn raised that nobody has answered yet (card id → the
       * blocker it holds on the broker) — what `retireCards` closes when the
       * turn ends. See there for why the member-wide sweep is not enough.
       */
      const openCards = new Map<string, string>();
      /**
       * Take one of this turn's cards down: its blockers released, its
       * registry entry abandoned — the card handed back for its row, or null
       * when the registry no longer held it.
       */
      const releaseCard = (
        cardId: string,
        blockerId: string,
      ): ReturnType<ApprovalRegistry['abandon']> => {
        openCards.delete(cardId);
        if (callContext) {
          this.callBroker.noteCalleeUnblocked(runId, callContext.callId);
        }
        this.callBroker.noteCallerUnblocked(runId, caller, blockerId);
        return this.approvals.abandon(runId, cardId);
      };

      /**
       * geniro's own `ask_user_question`, for a turn whose CLI hands its model
       * no question tool (`AdapterConfig.hostQuestionToolReason`). A CLI that
       * will not hold the call open for a person is answered at once and
       * continued with the answer later.
       */
      const deferQuestions =
        adapter.getConfig().hostQuestionDeferredReason !== null;
      /** The question cards this turn has up, swept when it ends. */
      const standingQuestions = new StandingQuestions();
      /**
       * A callee's question goes to its CALLER, as a claude callee's own
       * AskUserQuestion does: parked on its call and answered with
       * `answer_agent`.
       */
      const askCaller = (
        callId: string,
        questions: HostQuestion[],
        title: string | null,
        signal?: AbortSignal,
      ): Promise<HostQuestionOutcome> => {
        const asked = adapterQuestionOf(hostCardQuestions(questions), title);
        const unparked: HostQuestionOutcome = {
          status: 'unavailable',
          reason:
            'the call you are answering has ended, or a question of yours in it is still waiting',
        };
        if (asked === null) {
          return Promise.resolve(unparked);
        }
        const payload = hostQuestionCardInput(title, questions);
        if (deferQuestions) {
          return Promise.resolve(
            this.callBroker.parkQuestion(runId, callId, {
              question: asked.text,
              options: asked.options,
              payload,
              deferred: true,
            })
              ? { status: 'posted' }
              : unparked,
          );
        }
        const key = StandingQuestions.keyFor(title, questions);
        let parkedCard: StandingHostQuestion | null = null;
        return askThroughStanding(
          standingQuestions,
          key,
          signal,
          () =>
            Promise.resolve(
              this.callBroker.parkQuestion(runId, callId, {
                question: asked.text,
                options: asked.options,
                payload,
                keepsTurn: true,
                deliver: (answer) => {
                  if (parkedCard === null || parkedCard.closed) {
                    return false;
                  }
                  standingQuestions.deliver(key, parkedCard, {
                    status: 'answered',
                    answer,
                  });
                  return true;
                },
                fail: () => {
                  if (parkedCard !== null) {
                    standingQuestions.deliver(key, parkedCard, {
                      status: 'unavailable',
                      reason: 'the agent that called you never answered it',
                    });
                  }
                },
              })
                ? callId
                : unparked,
            ),
          (_requestId, card) => {
            parkedCard = card;
          },
        );
      };
      /**
       * A member's own question, on a CLI that holds the call open: one card in
       * its flow, closed with the turn like every card this turn raises.
       */
      const askUser = (
        questions: HostQuestion[],
        title: string | null,
        signal?: AbortSignal,
      ): Promise<HostQuestionOutcome> => {
        const key = StandingQuestions.keyFor(title, questions);
        const input = hostQuestionCardInput(title, questions);
        return askThroughStanding(
          standingQuestions,
          key,
          signal,
          async () => {
            const cardId = this.approvals.mintCardId(randomUUID(), sessionKey);
            try {
              await persistItem(node.id, 'approval_request', null, {
                id: cardId,
                toolName: HOST_QUESTION_TOOL,
                input,
                questions: hostCardQuestions(questions),
                nodeId: node.id,
              });
            } catch (err) {
              return {
                status: 'unavailable',
                reason: err instanceof Error ? err.message : String(err),
              };
            }
            return cardId;
          },
          (cardId, card) => {
            const blockerId = `${sessionKey}#${cardId}`;
            this.callBroker.noteCallerBlocked(runId, caller, blockerId);
            openCards.set(cardId, blockerId);
            this.approvals.track({
              runId,
              memberId: node.id,
              requestId: cardId,
              toolName: HOST_QUESTION_TOOL,
              input,
              question: true,
              respond: (allow, answer) => {
                if (card.closed) {
                  return false;
                }
                openCards.delete(cardId);
                this.callBroker.noteCallerUnblocked(runId, caller, blockerId);
                standingQuestions.deliver(
                  key,
                  card,
                  hostQuestionOutcomeOf(allow, answer),
                );
                enqueue(async () => {
                  await persistItem(node.id, 'approval_verdict', null, {
                    id: cardId,
                    nodeId: node.id,
                    allow,
                    ...(allow && answer !== undefined ? { answer } : {}),
                  });
                });
                this.announceAwaiting(runId);
                return true;
              },
            });
            this.announceAwaiting(runId);
          },
        );
      };

      // A member a pass starts owns a separate conversation. Its call
      // turns must never overwrite that conversation's session or context.
      // A call-only member keeps pool member 1's readings on its member row.
      const otherPoolMember =
        callContext?.poolMember !== undefined && callContext.poolMember !== 1;
      const separateCallState =
        otherPoolMember ||
        (callContext !== undefined && !onDemand.has(node.id));
      const stampUsage =
        otherPoolMember ||
        extras.poolMember !== undefined ||
        (callContext !== undefined &&
          !onDemand.has(node.id) &&
          nodePoolMembers.has(node.id));
      // Stamped on every row that can carry this turn's spend, in the turn and
      // after it: which CLI and model that spend is filed under (`turnMemberOf`).
      const usageOwner = (kind: string): Record<string, string> =>
        stampUsage && carriesUsage(kind)
          ? {
              agentKind: node.agent,
              ...(node.model !== undefined ? { agentModel: node.model } : {}),
            }
          : {};
      const saveSessionId = createSessionIdSaver(
        this.nodeStateDao,
        runId,
        node.id,
        null,
        em,
        separateCallState,
      );
      /**
       * Every member's turn can raise a question — a callee's goes to its
       * caller, any other to the user's card — so every turn spawns in the
       * CLI's ask mode (stdin control protocol, stdin held open): headless
       * claude strips its question tool entirely under
       * --dangerously-skip-permissions (probe-verified on 2.1.202). The daemon
       * auto-approves the plain permission requests in onEvent below, so an
       * 'auto' member keeps today's unattended semantics. A CLI with no
       * question channel is never question-capable, so it keeps its requested
       * mode.
       */
      const questionCapable = adapter.getConfig().questionToolName !== null;
      const approval = resolveApproval(node).mode;
      const nodeWindow = separateCallState
        ? null
        : (nodeWindows.get(node.id) ?? firstWindow);
      // Asked of the adapter, never inferred from the agent kind — the team
      // twin of `ChatService`'s probe, and the answer is per INSTALLED binary
      // (an older claude rejects the flag on argv). Without it a member never
      // streams the `tool_compose` frames the card loader is drawn from, so a
      // team agent writing an artifact showed nothing until the card landed.
      const streamPartials = await adapter
        .supportsLiveStream()
        .catch(() => false);
      const input: AgentTurnInput = {
        ...(streamPartials ? { streamPartials: true } : {}),
        prompt: withCarriedContext(
          carried,
          [
            deliveryNotice?.prompt ?? null,
            prompt,
            threadMessages.length === 0
              ? null
              : threadMessagesPrompt(threadMessages),
            stageLine,
          ]
            .filter((part): part is string => part !== null)
            .join('\n\n'),
        ),
        ...(extras.images?.length ? { images: extras.images } : {}),
        cwd,
        model: node.model ?? null,
        // Per MEMBER like the model, and already checked against this CLI's own
        // `listEfforts` at run start — a level it does not accept was dropped
        // there with a system item, so nothing unsupported reaches argv.
        effort: node.effort ?? null,
        // Per MEMBER too, and deliberately NOT pre-checked at run start the way
        // the effort is: the sizes belong to the model rather than to the CLI,
        // so there is no list here to check against — the turn's own driver
        // reports a size the model does not offer, against the live agent.
        contextWindow: node.contextWindow ?? null,
        modelParameters: node.modelParameters ?? null,
        // The member's threshold handed to the CLI ITSELF, so a turn that fills
        // the window compacts inside itself rather than running to the end and
        // being judged by `compactIfDue` when it is already too late. The same
        // percent both rules read, so the two can only ever agree; absent while
        // no window is known for this member or its model, and absent for good on
        // a CLI with no such control — `compactIfDue` remains the threshold there.
        ...(nodeWindow !== null && node.autoCompactPercent
          ? {
              autoCompact: {
                percent: node.autoCompactPercent,
                windowTokens: nodeWindow,
              },
            }
          : {}),
        // Never the session a carried compaction replaced: resuming it would
        // hand the summary to the conversation it summarised.
        resumeSessionId:
          carried !== null
            ? null
            : (callContext?.resumeSessionId ?? extras.resumeSessionId ?? null),
        // The member's instructions and character, the blocks addressed to it,
        // the answering-a-call note and "May call" block — built by the helper
        // the inspector's size readout measures with. Blocks are joined there
        // because the order of several blocks is the team's, which no adapter
        // could recover; the rest are peers ranked by `turnInstructionParts`.
        ...memberInstructionFields(node, {
          blocks: blocksOf.get(node.id),
          callees: calleesOf.get(node.id),
          answeringACall: callContext !== undefined,
          config: adapter.getConfig(),
          stageMap,
        }),
        // A PEER of the member's instructions rather than something joined
        // into them: the two are composed by `AgentAdapter.composeSystemPrompt`,
        // which ranks the member's instructions after this so a member
        // authored for one job still outranks a standing preference. Joining them here would put that ordering in
        // the executor and leave the chat path free to disagree about it.
        customInstructions,
        replyLanguage,
        projectInstructions,
        memoryIndex,
        knowledgeIndex,
        nativeMemoryOff,
        // A peer on the same terms; ranked right after the user's own text.
        taskInstructions,
        // This member's own CLI's slice; an option it does not carry reads as
        // that option's declared default, never as off.
        agentOptions: agentOptions[node.agent],
        // A questionCapable AUTO member spawns in ask mode when its CLI's
        // question channel COSTS that posture (the daemon auto-approves plain
        // permissions below, so unattended semantics survive).
        // ask/acceptEdits already carry the dialogue and spawn as themselves.
        // A CLI whose questions arrive out-of-band declares the cost as false
        // and keeps `auto` — forcing ask there would park every permission in
        // an unwatched team on a human verdict that never comes.
        approvalMode:
          questionCapable &&
          approval === 'auto' &&
          adapter.getConfig().questionsCostAskPosture
            ? 'ask'
            : approval,
        mcpEndpoint: mcpEndpointFor(node, callContext?.conversationId ?? null),
        // Per MEMBER, not per run: two members pointed at different plugin
        // directories are meant to run with different tools. Already refused
        // at startRun if unusable.
        configDir: node.configDir ?? null,
        // The servers this member — or, on a call, the pool MEMBER it runs as,
        // since `node` is that member's resolved view — switched off. Every
        // turn of the member carries them: its own turn, a callee sub-turn, a
        // continuation and the member's own compaction turn all come through
        // here. Each CLI applies them in its own adapter.
        ...(node.mcpDisabled?.length ? { mcpDisabled: node.mcpDisabled } : {}),
      };
      // This turn's compaction, until the row recording it is written — the
      // chat path's `compactions`, for a member's or a callee's own window.
      const compactions = new CompactionRows();
      const onEvent = (event: AgentEvent): void => {
        const promptTaken =
          event.parentToolUseId === undefined &&
          (event.type === 'text' ||
            event.type === 'text_delta' ||
            event.type === 'reasoning' ||
            event.type === 'reasoning_delta' ||
            event.type === 'thinking_progress' ||
            event.type === 'tool_compose' ||
            event.type === 'tool_call' ||
            event.type === 'turn_complete');
        if (promptTaken && callContext !== undefined && !extras.compaction) {
          this.callBroker.confirmWakingMessages(runId, callContext.callId);
        }
        // Writing its reply: no longer in the gap between two waits.
        if (
          event.parentToolUseId === undefined &&
          (event.type === 'text' || event.type === 'text_delta')
        ) {
          this.callBroker.noteOwnerReplying(runId, caller);
        }
        const arrived = terminalStatus(event);
        const ended =
          arrived === 'completed' ||
          arrived === 'failed' ||
          arrived === 'cancelled';
        if (ended) {
          outcome = arrived;
        }
        // A lead whose turn is HELD has finished its reply and
        // waits only on its background sub-agents; a message delivered into it
        // ends the hold, so it stops counting in `rootsWorking` until the hold
        // ends. A hold can also end with no `open: 0` (the silence deadline, an
        // idle with units unreported), so the terminal counts it again: the
        // compaction that may follow is work, and the walk's own idle mark is
        // what announces the end. Only the agents a message goes to, and not
        // their compaction turns: a compacting agent refuses messages.
        if (callContext === undefined && !extras.compaction) {
          if (event.type === 'turn_held' && event.open > 0) {
            heldOwnTurns.add(node.id);
          } else if (event.type === 'turn_held' || ended) {
            heldOwnTurns.delete(node.id);
          }
          if (leadIds.has(node.id)) {
            if (event.type === 'turn_held') {
              markRootWorking(node.id, event.open === 0);
            } else if (ended) {
              markRootWorking(node.id, true);
            }
          }
        }
        enqueue(async () => {
          if (ended && callContext === undefined) {
            // On the chain, so a drop this turn reported ahead of its terminal
            // has been matched first. A call sub-turn of the same member holds
            // none of them.
            await forgetRootDeliveries(node.id);
          }
          // Whether THIS event's approval request is the agent asking something
          // — set by the routing branch below and read by the registry track
          // further down. Per-event, declared here because the two blocks that
          // need it are siblings; false for every non-request event, which
          // never reaches either.
          let isQuestion = false;
          // The id this request's CARD goes by — its transcript row, its
          // registry entry and the verdict that comes back — minted once here
          // and scoped to this turn's process. `event.id` is unique only
          // within that process (cursor numbers `n:0`, `n:1`, … per
          // connection), so two cursor members, or two calls to one cursor
          // callee, both parked `n:1` and a verdict for one answered the other
          // (`ApprovalRegistry.mintCardId`). The CLI is still answered under
          // `event.id`, which the closures below keep.
          const cardId =
            event.type === 'approval_request'
              ? this.approvals.mintCardId(event.id, sessionKey)
              : null;
          if (event.type === 'user_message_consumed') {
            // The CLI took a message it was handed mid-turn; a wait started
            // from here on has nothing to make way for.
            this.callBroker.forgetUserMessage(runId, caller);
          }
          if (event.type === 'approval_withdrawn') {
            // The CLI took its request back, so its card has nobody left to
            // deliver a verdict to: close it, and release the blocker it held,
            // or the member reads as waiting on the user until its turn ends.
            const blockerId = `${sessionKey}#${event.id}`;
            for (const [openId, blocker] of [...openCards]) {
              if (blocker === blockerId) {
                const card = releaseCard(openId, blocker);
                // Announces the run is no longer waiting when it closed one.
                await recordUnanswerable(
                  node.id,
                  card === null ? [] : [card],
                )();
              }
            }
            return;
          }
          if (event.type === 'follow_up_dropped') {
            // Each marker is written where the row it names lives: a run
            // follow-up's at run level — under the root that answered last it
            // opened an empty member block, since the row draws itself on the
            // message — and a message into this turn's call in that call.
            const runDeliveries: string[] = [];
            const userDeliveries: string[] = [];
            for (const deliveryId of event.deliveryIds) {
              const prompted = promptDeliveries.get(deliveryId);
              const brokered = brokerDeliveries.get(deliveryId);
              const rooted = rootDeliveries.get(deliveryId);
              if (prompted !== undefined) {
                promptDeliveries.delete(deliveryId);
                if (prompted.redeliver !== undefined) {
                  redeliverWhenEnded(prompted.caller, prompted.redeliver);
                }
              } else if (brokered !== undefined) {
                brokerDeliveries.delete(deliveryId);
                this.callBroker.markMessageDropped(
                  runId,
                  brokered.callId,
                  brokered.text,
                  deliveryId,
                );
              } else if (rooted !== undefined) {
                rootDeliveries.delete(deliveryId);
                rooted.delivery.dropped.push({
                  memberId: rooted.memberId,
                  name: rooted.name,
                });
                const rowId = await settleSharedDelivery(rooted.delivery);
                if (rowId !== null) {
                  runDeliveries.push(rowId);
                }
              } else {
                userDeliveries.push(deliveryId);
              }
            }
            const runMarker =
              runDeliveries.length === 0
                ? null
                : mapEventToItem({ ...event, deliveryIds: runDeliveries });
            if (runMarker) {
              await persistItem(
                null,
                runMarker.kind,
                runMarker.role,
                runMarker.payload,
              );
            }
            const mapped =
              userDeliveries.length === 0
                ? null
                : mapEventToItem({ ...event, deliveryIds: userDeliveries });
            if (mapped) {
              await persistItem(node.id, mapped.kind, mapped.role, {
                ...(mapped.payload as Record<string, unknown>),
                nodeId: node.id,
                ...(callContext ? { callId: callContext.callId } : {}),
              });
            }
            return;
          }
          if (event.type === 'session') {
            capturedSessionId = event.sessionId;
            if (!callContext) {
              nodeSessionIds.set(node.id, event.sessionId);
            }
            await saveSessionId(event.sessionId);
            if (callContext) {
              enqueue(() =>
                this.callContextDao
                  .rememberSession(
                    runId,
                    callContext.callId,
                    node.id,
                    event.sessionId,
                    em,
                  )
                  .catch(() => {}),
              );
            }
            return;
          }
          // Session creation alone does not mean the CLI took its prompt.
          if (
            deliveryNotice !== null &&
            !deliveryNoticeAcknowledged &&
            promptTaken
          ) {
            deliveryNoticeAcknowledged = true;
            this.callBroker.acknowledgeMessageDeliveryNotice(
              runId,
              caller,
              deliveryNotice,
            );
          }
          if (
            threadMessages.length > 0 &&
            !threadMessagesTaken &&
            promptTaken
          ) {
            threadMessagesTaken = true;
            await this.threadInbox?.markDelivered(
              runId,
              threadMessages.map((message) => message.id),
            );
            await persistItem(
              null,
              'system',
              null,
              threadMessagesRow(threadMessages),
            );
          }
          if (event.type === 'slash_commands') {
            // The CLI's own invokable set for this run's cwd — feeds the
            // composer's `/` autocomplete, never the transcript.
            // Keyed by the MEMBER's config directory for the reason the MCP
            // harvest below takes it: a CLI answers for the plugins installed
            // in the profile it is running under.
            this.skillHarvest.record(
              node.agent,
              cwd,
              node.configDir ?? null,
              event.commands,
            );
            return;
          }
          if (event.type === 'mcp_servers') {
            // What this member actually loaded — feeds the MCP panel so it need
            // not re-dial every server to answer, never the transcript. Keyed
            // by the MEMBER's config directory, because a plugin ships its own
            // servers: two members on one CLI pointed at different ones load
            // genuinely different sets, and filing both under the folder alone
            // would serve each the other's answer.
            this.mcpHarvest.record(
              node.agent,
              cwd,
              node.configDir ?? null,
              event.servers,
            );
            this.noteMcpMismatch(
              runId,
              node.id,
              callContext?.callId ?? null,
              node.agent,
              cwd,
              node.configDir ?? null,
              event.servers,
            );
            return;
          }
          if (event.type === 'tool_compose') {
            // The model is serializing a tool call — the team twin of
            // `ChatService`'s site, and ephemeral like it: the live plane's
            // `composingTool` is what the transcript draws a card's loader from,
            // and the finished call is the durable copy. A delegate's frames
            // are already dropped by the claude mapper.
            this.partials.composing(runId, ownerKey, node.id, event);
            return;
          }
          if (event.type === 'delegate_progress') {
            this.partials.delegate(runId, ownerKey, node.id, event);
            return;
          }
          if (event.type === 'usage_progress') {
            // The member's own running bill for this turn — the team twin of
            // `ChatService`'s site, and ephemeral for the same reason: the
            // turn's `turn_complete` usage is the durable copy.
            this.partials.spend(runId, ownerKey, node.id, event);
            return;
          }
          if (event.type === 'cost_progress') {
            // The dollars this turn has spent that no durable row carries yet,
            // under the same owner key — so a CALL's card adds its own running
            // turn to what its finished turns recorded, rather than showing the
            // finished turns alone as if they were the bill.
            this.partials.cost(
              runId,
              ownerKey,
              node.id,
              event.costUsd,
              event.estimatedCostUsd ?? null,
            );
            return;
          }
          if (event.type === 'context_progress') {
            lastContextTokens = event.contextTokens;
            if (firstContextTokens === null && event.contextTokens > 0) {
              firstContextTokens = event.contextTokens;
            }
            // BEFORE the figure it scales — `context` publishes, so a window
            // remembered after it would not reach the client until the next
            // reading. See the same pair in `ChatService`.
            const ownWindow =
              event.contextWindowTokens !== undefined &&
              event.contextWindowTokens !== null &&
              this.partials.rememberWindow(
                runId,
                ownerKey,
                event.contextWindowTokens,
                event.contextModel ?? null,
                node.contextWindow ?? null,
              );
            if (ownWindow) {
              lastWindowTokens = event.contextWindowTokens ?? lastWindowTokens;
            }
            // EPHEMERAL, like a text delta: the durable copy is the
            // turn_complete usage. This is what lets a MEMBER's meter move while
            // its turn runs — the owner key is the member, so a fan-out's agents
            // each report their own conversation rather than one shared figure.
            this.partials.context(
              runId,
              ownerKey,
              node.id,
              event.contextTokens,
            );
            // …and the DURABLE copy, which is what a client with no live plane
            // reads. The live plane is dropped on a reload, a reconnect and a
            // first open, and a member parked in `await_agent` emits nothing for
            // minutes — so without this the ring simply went blank on exactly
            // the member the reader was asking about. Fire-and-forget for the
            // reason every other write on this path is: a failed bookkeeping
            // write must not fail the turn.
            //
            // A reading naming no window borrows the one the live plane holds
            // for this owner, resolved HERE rather than inside the queued
            // callback: the queue drains later, and a model change in between
            // deletes that entry — so a deferred read would file null for a
            // reading that had a window at the moment it was taken.
            const windowTokens =
              (ownWindow ? event.contextWindowTokens : null) ??
              this.partials.windowFor(runId, ownerKey);
            // Separate call conversations keep their readings on the call
            // row; the member's own account and window must stay untouched.
            if (!separateCallState) {
              rememberNodeWindow(node.id, windowTokens);
              enqueue(() =>
                this.nodeStateDao
                  .rememberContext(
                    runId,
                    node.id,
                    {
                      contextTokens: event.contextTokens,
                      contextWindowTokens: windowTokens,
                    },
                    em,
                  )
                  .catch(() => {}),
              );
            }
            // And again per CALL, where there is one: a turn the pass started
            // carries no `callContext` and no call identity to key a row on, so
            // it writes the member row above and nothing here.
            if (callContext) {
              enqueue(() =>
                this.callContextDao
                  .rememberContext(
                    runId,
                    callContext.callId,
                    node.id,
                    {
                      contextTokens: event.contextTokens,
                      contextWindowTokens: windowTokens,
                    },
                    em,
                  )
                  .catch(() => {}),
              );
            }
            return;
          }
          if (event.type === 'turn_model') {
            // Named at session start, before any usage exists — this is what
            // lets a member's FIRST request be scaled against the real window,
            // and what teaches the cross-run cache a model it has never seen.
            this.partials.useModel(
              runId,
              ownerKey,
              adapter.getConfig().kind,
              event.model,
              node.contextWindow ?? null,
            );
            return;
          }
          if (
            event.type === 'tool_call' &&
            event.parentToolUseId === undefined
          ) {
            // This member's OWN tools, never its delegates'. `parentToolUseId` is
            // the daemon-side twin of the renderer's `subagentIdOf` exclusion:
            // a delegate has its own card and its own rows, so folding its
            // toolbelt in here would report a fan-out's total as one member's.
            toolCalls += 1;
            madeToolCalls = true;
          }
          if (event.type === 'text') {
            textChunks.push(event.text);
          }
          if (event.type === 'turn_complete') {
            finalText = event.finalText ?? textChunks.join('');
            lastContextTokens = event.usage?.contextTokens ?? lastContextTokens;
            if (firstContextTokens === null && (lastContextTokens ?? 0) > 0) {
              firstContextTokens = lastContextTokens;
            }
            promptCacheTtlMs =
              event.usage?.promptCacheTtlMs ?? promptCacheTtlMs;
            // The ONLY line carrying the model's window — under the model that
            // REPORTED it, so a member that fell back to a second model cannot
            // file that model's window under the requested one, nor take it as
            // its own.
            const ownWindow = this.partials.rememberWindow(
              runId,
              ownerKey,
              event.usage?.contextWindowTokens ?? null,
              event.usage?.contextModel ?? null,
              node.contextWindow ?? null,
            );
            if (ownWindow) {
              lastWindowTokens =
                event.usage?.contextWindowTokens ?? lastWindowTokens;
            }
            // The result line is the ONLY one carrying the window, so it is
            // where a member's denominator becomes durable — the count beside it
            // is written too, since a turn that reported none mid-flight still
            // states its total here. A result line that names no window falls
            // back to the live plane, resolved eagerly for the reason the
            // reading above states.
            const settledWindowTokens =
              (ownWindow ? event.usage?.contextWindowTokens : null) ??
              this.partials.windowFor(runId, ownerKey);
            if (!separateCallState) {
              rememberNodeWindow(node.id, settledWindowTokens);
              enqueue(() =>
                this.nodeStateDao
                  .rememberContext(
                    runId,
                    node.id,
                    {
                      contextTokens: event.usage?.contextTokens ?? null,
                      contextWindowTokens: settledWindowTokens,
                      contextEstimated: event.usage?.contextEstimated === true,
                    },
                    em,
                  )
                  .catch(() => {}),
              );
            }
            if (callContext) {
              enqueue(() =>
                this.callContextDao
                  .rememberContext(
                    runId,
                    callContext.callId,
                    node.id,
                    {
                      contextTokens: event.usage?.contextTokens ?? null,
                      contextWindowTokens: settledWindowTokens,
                      contextEstimated: event.usage?.contextEstimated === true,
                    },
                    em,
                  )
                  .catch(() => {}),
              );
            }
            // This turn's worked time and tool count, ADDED to the member's
            // running totals. `rememberWork` rather than another
            // `rememberContext` because these are totals rather than levels —
            // the reading above may be overwritten harmlessly, this one may not.
            // Read out and zeroed HERE, synchronously, for the reason the window
            // above is resolved eagerly: the queue drains later, and by then the
            // next turn's calls would already have moved the counter.
            const turnToolCalls = toolCalls;
            toolCalls = 0;
            const turnWorkedMs = event.usage?.durationMs ?? null;
            enqueue(() =>
              this.nodeStateDao
                .rememberWork(runId, node.id, turnWorkedMs, turnToolCalls, em)
                .catch(() => {}),
            );
            // A turn the CLI did not time (every ACP agent) is measured by the
            // wall clock from the member's durable rows instead. Queued from
            // INSIDE this task, so it runs after the task has finished — and
            // with it the `persistItem` below that writes this turn's
            // `turn_complete` row, which the fold needs to see the turn end.
            if (cliTurnDurationMs({ usage: event.usage }) === null) {
              enqueue(() => catchUpWallWork(node.id));
            }
          }
          if (event.type === 'error') {
            lastError = event.message;
          }
          const terminal = terminalStatus(event);
          if (
            (terminal === 'failed' || terminal === 'cancelled') &&
            capturedSessionId === null
          ) {
            restoreCarried();
          }
          if (event.type === 'approval_request') {
            // The caller-bridge admits ONLY AskUserQuestion by NAME: bridging
            // on the CLI-owned requires_user_interaction flag alone could let
            // a future interactive tool bypass an 'ask' member's human gate via
            // version drift. A flag-only request stays on the approval path
            // (card or daemon auto-approve per member.approval) with a warning
            // so the drift is loud, never silent.
            // Read ONCE per request and kept for the track below, which sits in
            // a second `approval_request` block further down: recomputing it
            // there would be a second reading of one adapter fact, free to
            // disagree with the branch that already routed this request.
            isQuestion = isUserQuestion(
              adapter.getConfig().questionToolName,
              event.toolName,
            );
            if (!isQuestion && event.requiresUserInteraction === true) {
              this.logger.warn(
                `interactive control_request for unrecognized tool '${event.toolName}' on ${node.id} — kept on the approval path, not bridged to the caller`,
              );
            }
            if (callContext && isQuestion && !asksForSecret(event.questions)) {
              // A call-initiated callee's question goes to its CALLER (the
              // M4 Q&A bridge) — never to a renderer card. The broker parks
              // it; answer_agent delivers the answer through these closures.
              //
              // Except a question asking for a SECRET, which falls through to
              // the user's own card: only the user can answer it, and a caller
              // escalating it would ask on a card of its own CLI, which cannot
              // mask the field or keep the answer out of the transcript.
              //
              // The payload is the CLI's own, so the ADAPTER projects it and
              // folds the answer back in: the executor bridges the question
              // without ever knowing which CLI's shape it is carrying.
              const question = adapter.questionFrom(event.input);
              const parked =
                question !== null &&
                this.callBroker.parkQuestion(runId, callContext.callId, {
                  question: question.text,
                  options: question.options,
                  payload: event.input,
                  deliver: (answer) =>
                    deliverApprovalAnswer(
                      adapter,
                      event,
                      true,
                      answer,
                      (input) => handle.respondApproval(event.id, true, input),
                    ).delivered,
                  fail: () => handle.cancel(),
                });
              if (!parked) {
                // Unknown/settled call (or a second question raced the
                // first) — deny so the callee continues instead of hanging
                // on a question nobody can answer. An adapter that projects
                // NO question takes this path too: parking a blank question
                // would strand the caller on something it cannot answer.
                handle.respondApproval(event.id, false);
              }
              return;
            }
            if (questionCapable && approval === 'auto' && !isQuestion) {
              // The daemon-side stand-in for --dangerously-skip-permissions:
              // ONLY an 'auto' member spawned in ask mode (for the question
              // channel) skips plain permissions — approve with the input
              // unchanged, no transcript item (matching auto-mode silence).
              // ask/acceptEdits members keep the human card for every
              // permission the CLI routes to the stdio dialogue.
              handle.respondApproval(event.id, true, event.input);
              return;
            }
            if (
              !isQuestion &&
              (isHostMemoryCall(hostMcpServerName(runId), event.toolName) ||
                isHostQuestionCall(hostMcpServerName(runId), event.toolName) ||
                isHostKnowledgeCall(hostMcpServerName(runId), event.toolName) ||
                isHostArtifactAnswersCall(
                  hostMcpServerName(runId),
                  event.toolName,
                ) ||
                isHostBrowserCall(hostMcpServerName(runId), event.toolName) ||
                isHostTeamProposalCall(
                  hostMcpServerName(runId),
                  event.toolName,
                ) ||
                isHostProjectInstructionsCall(
                  hostMcpServerName(runId),
                  event.toolName,
                ))
            ) {
              // The shared memory and the knowledge store, at every approval
              // level, as in a chat: their limits live in their services — see
              // `isHostMemoryCall` and `isHostKnowledgeCall`; reading back the
              // run's own page answers likewise (`isHostArtifactAnswersCall`). The lead's
              // `propose_team` and `save_project_instructions` write nothing:
              // their own card is the gate.
              handle.respondApproval(event.id, true, event.input);
              return;
            }
          }
          // Anything durable ends a silent reasoning stretch — the tool call
          // the model went quiet to prepare carries no text delta to close it
          // (see `PartialStreamService.endThinking`). Kept in step with the
          // chat path, which does the same at its own persist seam.
          this.partials.endThinking(runId, ownerKey, node.id);
          this.backgroundWork.record(runId, event, node.id);
          const mapped = mapEventToItem(event);
          // A compaction the agent finished: stamped onto its summary, or
          // written on its own ahead of this row — nothing else records one.
          for (const row of compactions.rowsBefore(event, mapped)) {
            await persistItem(node.id, row.kind, row.role, {
              ...row.payload,
              nodeId: node.id,
              ...(callContext ? { callId: callContext.callId } : {}),
            });
          }
          if (mapped) {
            // A callee sub-turn tags every streamed item with its callId so
            // the renderer can nest the whole sub-turn under its call block —
            // unambiguous even when parallel calls hit the SAME member.
            try {
              await persistItem(node.id, mapped.kind, mapped.role, {
                ...(mapped.payload as Record<string, unknown>),
                // A card row carries the CARD id, which is what the renderer
                // sends back as the verdict's `requestId`.
                ...(cardId !== null ? { id: cardId } : {}),
                ...(event.type === 'approval_request'
                  ? await threadCardFields(
                      this.runDao,
                      this.em.fork(),
                      hostMcpServerName(runId),
                      event.toolName,
                      event.input,
                    )
                  : {}),
                nodeId: node.id,
                ...(callContext ? { callId: callContext.callId } : {}),
                ...usageOwner(mapped.kind),
                ...(mapped.kind === 'turn_complete' &&
                extras.poolMember !== undefined
                  ? {
                      nodePoolMember: extras.poolMember,
                      sessionId: capturedSessionId,
                    }
                  : {}),
              });
              if (callContext) {
                // A tool call in flight holds the watchdog off until it
                // answers: the callee is waiting on its own work, however long
                // that takes (a delegate can run for many minutes and say
                // nothing on the wire).
                if (event.type === 'tool_call') {
                  this.callBroker.noteCalleeToolStarted(
                    runId,
                    callContext.callId,
                    event.id,
                  );
                } else if (event.type === 'tool_result') {
                  this.callBroker.noteCalleeToolFinished(
                    runId,
                    callContext.callId,
                    event.id,
                  );
                } else if (
                  event.type === 'subagent_info' &&
                  event.parentToolUseId == null
                ) {
                  // A BACKGROUND delegate is the same wait, outliving the tool
                  // call that launched it — a cursor turn is held open for its
                  // delegates with nothing on the wire until they end. Keyed
                  // apart from tool ids, since a delegate's id IS its launching
                  // call's, which already answered.
                  const unit = `delegate:${event.id}`;
                  if (event.backgroundOpen === true) {
                    this.callBroker.noteCalleeToolStarted(
                      runId,
                      callContext.callId,
                      unit,
                    );
                  } else if (
                    event.backgroundOpen === false ||
                    event.backgroundOutcome != null
                  ) {
                    this.callBroker.noteCalleeToolFinished(
                      runId,
                      callContext.callId,
                      unit,
                    );
                  }
                }
                // This callee is demonstrably alive — restart its silence
                // watchdog. The broker holds a promise and nothing else, so
                // this seam is the only place a callee's output is visible.
                this.callBroker.noteCalleeActivity(runId, callContext.callId);
              }
            } catch (err) {
              // The card can't be shown — deny to unblock the parked member CLI
              // so the member settles instead of hanging forever on a verdict
              // that can never arrive (mirrors the chat service's card path;
              // the track below, which routes the verdict, would be skipped).
              if (event.type === 'approval_request') {
                handle.respondApproval(event.id, false);
              }
              throw err;
            }
          }
          if (event.type === 'approval_request' && cardId !== null) {
            // A CALLEE parked on a card is waiting on a person, not wedged —
            // stand its silence window down until the verdict lands, the same
            // carve-out `spawn-cli.ts` makes for its own deadline. A CALLER
            // parked on one cannot answer its callees until the verdict lands
            // either, so the questions they park wait with it rather than
            // expiring against a caller that cannot see them.
            //
            // Any member, a callee included: one that is itself a caller
            // (Manager → Engineer → Researcher) is blocked by its cards on the
            // same terms. The BLOCKER is named by its session and request id —
            // not by the card id, which is fresh per card — so a request
            // re-offered to a later turn of the same process is one blocker
            // rather than two.
            const blockerId = `${sessionKey}#${event.id}`;
            if (callContext) {
              this.callBroker.noteCalleeBlocked(runId, callContext.callId);
            }
            this.callBroker.noteCallerBlocked(runId, caller, blockerId);
            openCards.set(cardId, blockerId);
            this.approvals.track({
              runId,
              memberId: node.id,
              requestId: cardId,
              toolName: event.toolName,
              input: event.input,
              // Already decided above from this member's adapter — the registry
              // never re-derives it (`PendingApproval.question`).
              question: isQuestion,
              respond: (allow, answer, optionId) => {
                openCards.delete(cardId);
                // The card is gone whatever the delivery outcome, so the
                // window restarts either way — a refused delivery leaves the
                // callee unblocked from this side's point of view.
                if (callContext) {
                  this.callBroker.noteCalleeUnblocked(
                    runId,
                    callContext.callId,
                  );
                }
                this.callBroker.noteCallerUnblocked(runId, caller, blockerId);
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
                      : handle.respondApproval(event.id, allow, input, option),
                  optionId,
                );
                if (delivered) {
                  enqueue(async () => {
                    await persistItem(node.id, 'approval_verdict', null, {
                      id: cardId,
                      nodeId: node.id,
                      allow,
                      ...record,
                    });
                  });
                }
                // The registry dropped this entry before calling here, so the
                // reading is already the post-verdict one — whatever the
                // delivery outcome, the card is gone.
                this.announceAwaiting(runId);
                return delivered;
              },
            });
            this.announceAwaiting(runId);
          }
        });
      };
      /**
       * What the CLI does AFTER this turn's terminal line, filed under the member
       * that was working — the team's half of `ChatService`'s own between-turn
       * handler, and the reason the process is now kept.
       *
       * A turn's `result` ends what the AGENT was saying; it does not stop the
       * process, which routinely opens a further turn of its own when work it
       * backgrounded reports back. Every row of that used to be dropped here —
       * `adapter.start` supplied no sink — so a callee that launched a build and
       * said so left nothing in the transcript afterwards but the sentence that
       * it had started.
       *
       * Rows ONLY. It deliberately touches none of the turn bookkeeping above:
       * `outcome`, `finalText` and `textChunks` describe a turn whose envelope
       * the caller has already been handed, and rewriting any of them would
       * change an answer that has been acted on. So this makes the work VISIBLE
       * without re-opening a settled call.
       *
       * It goes on writing after this PASS has ended: the process is kept
       * between passes, so a dev server exiting, or the CLI reacting to it,
       * is real work that happened in this run and must reach its transcript —
       * dropping it left a finished command listed as running for good. Only a
       * run being DELETED is refused, since its rows are going.
       */
      const offTurnCompactions = new CompactionRows();
      // The main-thread tool calls of a stretch the CLI runs by itself, added
      // to the member's totals with its ending, as a turn of ours adds its own.
      let offTurnToolCalls = 0;
      const onOffTurnEvent = (event: AgentEvent): void => {
        if (
          event.type === 'shell_info' &&
          event.ending !== undefined &&
          !callContext &&
          adapter.getConfig().shells.lateEndWakeReason !== null &&
          !this.deleting.has(runId)
        ) {
          this.commandEndWakes?.ended(
            memberWakeOwner(runId, node.id),
            event.workId,
            event.ending,
            () => liveConversations.has(caller),
          );
        }
        if (event.type === 'tool_call' && event.parentToolUseId === undefined) {
          offTurnToolCalls += 1;
        } else if (terminalStatus(event) !== null) {
          const toolCalls = offTurnToolCalls;
          offTurnToolCalls = 0;
          const workedMs =
            event.type === 'turn_complete'
              ? (event.usage?.durationMs ?? null)
              : null;
          enqueue(() =>
            this.nodeStateDao
              .rememberWork(runId, node.id, workedMs, toolCalls, em)
              .catch(() => {}),
          );
        }
        enqueue(async () => {
          if (this.deleting.has(runId)) {
            return;
          }
          this.backgroundWork.record(runId, event, node.id);
          // A stretch of late calls has no terminal; this event, which maps to
          // no row, is what ends it.
          if (endsOffTurnStretch(event)) {
            await restoreOffTurnNodeBadge(sessionKey);
            return;
          }
          const mapped = mapEventToItem(event);
          const settles = terminalStatus(event) !== null;
          const callId = callContext ? callContext.callId : null;
          // AHEAD of the rows this event produces, so the live row stands above
          // the work rather than appearing under the last of it.
          //
          // `restatesRunAsWorking` is the same predicate the chat side applies,
          // and it earns its place here for the same reason: a backgrounded
          // command's own open and close are bookkeeping ABOUT work rather than
          // an agent producing any, and a close emits nothing after it — so
          // reading one as the member working would latch a spinner that nothing
          // could take down. A TERMINAL event is excluded on top of it, or a
          // stretch that begins with one (a held result released off-turn)
          // would write a `running` and restore it in the same breath.
          //
          // A BRACKETED delegate's own rows are excluded too, as the chat side
          // excludes them from its lease: the delegate is on the card already
          // (its block, `subagentsOut`), its close is what ends it, and a close
          // is no terminal event — so its steps, read as the MEMBER working,
          // latched the member `running` for good after its sub-agents finished.
          // Measured on a codex callee whose sub-agents stream their steps.
          const bracketedDelegateRow =
            event.parentToolUseId !== undefined &&
            this.backgroundWork.isDelegateOut(runId, event.parentToolUseId);
          if (
            mapped !== null &&
            !settles &&
            !bracketedDelegateRow &&
            restatesRunAsWorking(event)
          ) {
            await takeOffTurnNodeBadge(sessionKey, node.id, callId);
          }
          for (const row of offTurnCompactions.rowsBefore(event, mapped)) {
            await persistItem(node.id, row.kind, row.role, {
              ...row.payload,
              nodeId: node.id,
              ...(callId ? { callId } : {}),
            });
          }
          if (!mapped) {
            return;
          }
          await persistItem(node.id, mapped.kind, mapped.role, {
            ...(mapped.payload as Record<string, unknown>),
            nodeId: node.id,
            ...(callId ? { callId } : {}),
            ...usageOwner(mapped.kind),
          });
          // A turn the callee's kept process ran on its own after the call
          // settled refreshed that conversation's cache: the caller's listing
          // and its cold-resume refusal must see it, as the nodes route does.
          if (callId !== null && event.type === 'turn_complete') {
            this.callBroker.noteConversationTurnEnded(runId, callId, {
              endedAt: Date.now(),
              promptCacheTtlMs: event.usage?.promptCacheTtlMs ?? null,
              contextTokens: event.usage?.contextTokens ?? null,
              contextWindowTokens: this.partials.isOwnReading(
                runId,
                ownerKey,
                event.usage?.contextModel ?? null,
              )
                ? (event.usage?.contextWindowTokens ?? null)
                : null,
            });
          }
          // A continuation the CLI did not time is wall work like an in-turn
          // one, and its row is durable by now (written just above).
          if (
            event.type === 'turn_complete' &&
            cliTurnDurationMs({ usage: event.usage }) === null
          ) {
            await catchUpWallWork(node.id);
          }
          // AFTER the terminal row, which is the continuation ENDING: the badge
          // goes back to whatever this stretch took it from.
          if (settles) {
            await restoreOffTurnNodeBadge(sessionKey);
          }
        });
      };
      /**
       * The same verdict the in-turn path gives, for a request that arrives with
       * no turn left to carry it — see the `questionCapable && auto` branch in
       * `onEvent`.
       *
       * Without it the between-turn default (refuse a permission) would reach
       * the agent as the USER's own "no" on an unattended team member, for a card
       * nobody was ever shown — and the continuation that a backgrounded unit's
       * report opens is made almost entirely of tool calls, so keeping the
       * process alive while refusing everything it then tries to do would be a
       * worse failure than killing it.
       *
       * Everything else HOLDS (`null`) rather than being decided: a question
       * raised here can no longer be bridged to a caller whose call has settled,
       * and no card can be drawn for it, so answering either way would be
       * inventing a verdict. The request stays parked until the run closes the
       * session, which is the honest end for it.
       *
       * The same verdict after this PASS has ended as during it: the process is
       * kept between passes and `onOffTurnEvent` goes on recording what it does,
       * so the grant is no longer one with no transcript — which was the only
       * reason it used to hold everything once the pass had finished.
       */
      const onBetweenTurnApproval = (request: {
        toolName: string;
      }): boolean | null =>
        (questionCapable &&
          approval === 'auto' &&
          !isUserQuestion(
            adapter.getConfig().questionToolName,
            request.toolName,
          )) ||
        isHostMemoryCall(hostMcpServerName(runId), request.toolName) ||
        isHostQuestionCall(hostMcpServerName(runId), request.toolName) ||
        isHostKnowledgeCall(hostMcpServerName(runId), request.toolName) ||
        isHostArtifactAnswersCall(hostMcpServerName(runId), request.toolName) ||
        isHostBrowserCall(hostMcpServerName(runId), request.toolName) ||
        isHostTeamProposalCall(hostMcpServerName(runId), request.toolName) ||
        isHostProjectInstructionsCall(
          hostMcpServerName(runId),
          request.toolName,
        )
          ? true
          : null;
      // One registry key per CONVERSATION, never per member: a member
      // can hold its own turn and several callee turns at once, and a key
      // serving two concurrent turns would have the second refused — which the
      // registry reads as "replace it", killing the first turn's process
      // mid-work. A member's own turns are one conversation, so `node:<id>` is its key;
      // a callee's is the FIRST call of its conversation, which a `thread:`
      // continuation shares with every call before it. It was the call's own
      // id for a while, and that spawned a second `--resume <session>` process
      // for every continuation while the previous call's process was still
      // kept under the previous id — two live CLIs on one session, both
      // answering one message and editing one worktree (measured: an Engineer
      // found two, then three, `claude -p --resume 43bb7bb7…` children of the
      // daemon in its worktree). Keyed by the conversation, the continuation
      // is handed to the kept process, and the session is resumed in a fresh
      // one only once that process is gone. The broker refuses a continuation
      // while a call on that conversation is live, which is what keeps the
      // "one turn per key" premise of the registry true. The `call:`/`node:`
      // prefixes keep a callable member's two kinds of turn from colliding on
      // its own id.
      // The live plane's key for THIS turn. Per CALL rather than per member,
      // because a member can hold several at once — a caller running two of the
      // same callee had both write to one key, so the panel showed one ring
      // flickering between two unrelated conversations while honestly counting
      // "2 active · 2 threads" above it. The published nodeId stays the member's,
      // so a client can still attribute the reading.
      const ownerKey = partialOwnerKey(node.id, callContext?.callId ?? null);
      // The turn's spend starts from nothing, as a chat turn's does — and
      // BEFORE the turn can emit a reading: a member's own key is reused by
      // every pass, and a figure a previous process left on it (persisted
      // across a restart) is the CLI's to bill on this session's next
      // `result`, not still owed beside it.
      this.partials.startTurn(runId, ownerKey);
      const disposeQuestions =
        input.mcpEndpoint !== null &&
        this.userQuestions !== undefined &&
        adapter.getConfig().hostQuestionToolReason !== null
          ? this.userQuestions.register(
              runId,
              caller,
              (questions, title, signal) =>
                callContext !== undefined
                  ? askCaller(callContext.callId, questions, title, signal)
                  : deferQuestions
                    ? this.askMemberDeferred(runId, node.id, questions, title)
                    : askUser(questions, title, signal),
              { answersAtOnce: deferQuestions },
            )
          : null;
      let handle: AgentTurnHandle;
      try {
        handle = this.sessions.startTurn(
          sessionKey,
          adapter,
          input,
          onEvent,
          onBetweenTurnApproval,
          onOffTurnEvent,
        );
      } catch (err) {
        disposeQuestions?.();
        restoreCarried();
        throw err;
      }
      if (disposeQuestions !== null) {
        const endQuestions = (): void => {
          disposeQuestions();
          standingQuestions.sweep({
            status: 'unavailable',
            reason: 'the turn ended before the question was answered',
          });
        };
        void handle.done.then(endQuestions, endQuestions);
      }
      // The registry may close this process at any time — reaped as unused,
      // evicted, replaced as stale, or ended by the run's archive — during this
      // pass or long after it, since the process is kept between passes. Every
      // delegate inside it dies with it. Its detached commands need nothing
      // from here: the process exit announces their closes through
      // `onOffTurnEvent` itself.
      //
      // Installed AFTER `startTurn`, never before it: a kept process that
      // cannot serve this turn is REPLACED inside that call and its close
      // fires synchronously, so a closer installed first was consumed by the
      // replacement of the process before it — closing nothing that process
      // had left out, and leaving the new process with no closer at all.
      //
      // For a callee it covers every CALL the process has served, not this one
      // alone ({@link callsBySessionKey}).
      if (callContext) {
        const calls = callsBySessionKey.get(sessionKey) ?? new Set<string>();
        calls.add(callContext.callId);
        callsBySessionKey.set(sessionKey, calls);
      }
      this.sessionClosers.set(sessionKey, (cause) => {
        // Read as the process CLOSES: the calls it served are the ones whose
        // work died with it, and a process spawned on this key later starts
        // its own list.
        const scopes: Parameters<typeof closeStrandedWork>[0][] = callContext
          ? [...(callsBySessionKey.get(sessionKey) ?? [])].map((callId) => ({
              callId,
            }))
          : [{ memberId: node.id }];
        callsBySessionKey.delete(sessionKey);
        enqueue(async () => {
          // A deleted run's rows are going; every other close is written.
          if (this.deleting.has(runId)) {
            return;
          }
          for (const scope of scopes) {
            await closeStrandedWork(scope, false, cause === 'user-stop');
          }
          // The process that owed this stretch's terminal event is gone, so
          // nothing else could ever end it — the second of the two endings
          // {@link restoreOffTurnNodeBadge} exists for. A no-op unless this
          // conversation actually took a badge.
          await restoreOffTurnNodeBadge(sessionKey);
        });
      });

      const finish = (): NodeTurnResult => {
        // What this turn spent that no row carries is either recorded by now
        // or will be by a line this key no longer answers for — so the live
        // figure comes down with the turn, never to be added twice.
        this.partials.retireCost(runId, ownerKey, node.id);
        // A turn that failed, was stopped, or exited with no terminal at all
        // still called its tools; only `turn_complete` adds them earlier. No
        // usage came with them, so the time stays unmeasured.
        if (toolCalls > 0) {
          const leftToolCalls = toolCalls;
          toolCalls = 0;
          enqueue(() =>
            this.nodeStateDao
              .rememberWork(runId, node.id, null, leftToolCalls, em)
              .catch((err: unknown) => {
                this.logger.warn(
                  `run ${runId}: could not add ${leftToolCalls} tool calls to ${node.id}'s total: ${err instanceof Error ? err.message : String(err)}`,
                );
              }),
          );
        }
        // A clean exit with no result line still completes the member — the
        // synthetic-completion mirror of the chat turn's finalizer.
        const finalOutcome = endedAs();
        const text =
          finalOutcome === 'completed'
            ? (finalText ?? textChunks.join(''))
            : finalText;
        return {
          outcome: finalOutcome,
          finalText: text,
          sessionId: capturedSessionId,
          reading: {
            tokens: lastContextTokens,
            window:
              lastWindowTokens ?? this.partials.windowFor(runId, ownerKey),
          },
          firstTokens: firstContextTokens,
          sessionKey,
          error: lastError,
          madeToolCalls,
          promptCacheTtlMs,
        };
      };
      /**
       * Close the cards THIS turn left unanswered, and release the blockers
       * they held — for a settle path to call when the turn ends while its member
       * still has OTHER live turns, where the member-wide sweep does not run.
       *
       * Each such card is dead the moment its turn settles: its buttons answer
       * the settled turn's handle, which refuses the write, and a request the
       * CLI still holds is offered to the next turn as a card of its own. Left
       * in place, the card stayed on screen answering into nothing, and its
       * blocker kept every question this member's own callees parked
       * TTL-suspended until the member's LAST turn ended — so a callee that was
       * itself a caller could never time its callees' questions out while any
       * other call to it was running.
       *
       * The same two halves as `sweepApprovals`: the registry and the broker
       * are released now, synchronously, and the rows are written by the
       * returned work on the chain.
       */
      const retireCards = (): (() => Promise<void>) => {
        const retired: ReturnType<ApprovalRegistry['sweepNode']> = [];
        for (const [cardId, blockerId] of [...openCards]) {
          const card = releaseCard(cardId, blockerId);
          if (card !== null) {
            retired.push(card);
          }
        }
        return recordUnanswerable(node.id, retired);
      };
      return { handle, finish, endedAs, retireCards };
    };

    /**
     * Compact one conversation right after the turn that filled it, while the
     * unit that owns its session key still holds it — so nothing else can open
     * a turn on that key meanwhile: a callee's call is still active
     * (`THREAD_BUSY`), and a member's own turn is still retained and unsettled.
     * The member's settle, and a sync caller's result, simply wait for it.
     *
     * NEVER called from inside `enqueue`: the compaction's own events are
     * enqueued, and awaiting them from a queued callback would wait forever.
     *
     * `onStart` fires only when a compaction actually begins, which is what
     * lets a member's settle path mark it busy for exactly that long.
     */
    /**
     * How many delegates ONE call launched that its transcript still declares
     * out — read on the write chain, so every row the turn produced has landed.
     * A read that fails
     * answers 0: it only decides whether the caller is WARNED, and must never
     * cost the call its result.
     */
    const delegatesOutOfCall = (callId: string): Promise<number> =>
      new Promise((resolve) => {
        enqueue(async () => {
          try {
            resolve(
              strandedDelegates(
                await this.itemDao.subagentInfoRows(runId, em),
              ).filter((delegate) => delegate.callId === callId).length,
            );
          } catch {
            resolve(0);
          }
        });
      });

    /**
     * The commands a callee CONVERSATION detached that its transcript still
     * declares running, oldest first, each with the call it was started in and
     * the words its tool call ran it with (null where those were never
     * recorded). An earlier call's count: a continued thread answers in the
     * same kept process, so what its first call started is still the thread's
     * — and a continuation resumed in a fresh process finds none open, since
     * the old process's exit wrote their closes. A call settling closes none
     * of them; they end only with the process. Read on the write chain, and a
     * failed read answers none, for the reason {@link delegatesOutOfCall}
     * gives.
     */
    const shellsOutOfConversation = (
      memberId: string,
      callId: string,
      conversationId: string,
    ): Promise<ShellStillOut[]> =>
      new Promise((resolve) => {
        enqueue(async () => {
          try {
            // The call settling now is not recorded on its thread yet.
            const calls = new Set([
              callId,
              ...this.callBroker.recordedCallsOf(runId, conversationId),
            ]);
            const shells = strandedShells(
              await this.itemDao.shellRows(runId, em),
            ).filter(
              (shell): shell is StrandedShell & { callId: string } =>
                shell.memberId === memberId &&
                shell.callId !== null &&
                calls.has(shell.callId),
            );
            const launching = await this.itemDao.toolCallsByIds(
              runId,
              shells.flatMap((shell) =>
                shell.toolCallId === null ? [] : [shell.toolCallId],
              ),
              em,
            );
            resolve(
              shells.map((shell) => {
                const call = launchingCallOf(shell, launching);
                return {
                  command:
                    call === undefined ? null : shellCommandOf(call.payload),
                  callId: shell.callId,
                };
              }),
            );
          } catch (err) {
            this.logger.warn(
              `team run ${runId} call ${callId}: the read of commands left running failed, so its result names none: ${err instanceof Error ? err.message : String(err)}`,
            );
            resolve([]);
          }
        });
      });

    const compactIfDue = async (
      node: TeamMember,
      turn: NodeTurnResult,
      callContext:
        | { callId: string; conversationId: string; poolMember?: number }
        | undefined,
      onStart: () => void,
    ): Promise<void> => {
      try {
        const percent = node.autoCompactPercent ?? null;
        const command = this.adapterFor(node.agent).geniroCommandFor(
          AUTO_COMPACT_COMMAND,
        );
        if (
          percent === null ||
          command === null ||
          turn.outcome !== 'completed' ||
          cancelRequested ||
          // A pass that is over refuses — unless the run is AWAKE for work its
          // own agents started (`reopenRun`), which is where a call-driven
          // team spends nearly all of its life: the Manager dispatches,
          // ends its turn, and every call after that wakes the run. Refusing
          // there meant the rule never ran for a CLI with no in-turn control of
          // its own, nor for a claude member's first turn before its window is
          // known.
          (runFinished && !reopened)
        ) {
          return;
        }
        let baseline = this.compactionBaselines.get(turn.sessionKey);
        if (baseline === 'pending') {
          // What the compaction left behind is the conversation's size at the
          // START of the next turn, never at its end: a long turn that regrew
          // past the threshold was measured as its own baseline, so it had to
          // grow a further tenth of the window before it compacted again.
          const opening = turn.firstTokens ?? turn.reading.tokens;
          if (opening === null) {
            return;
          }
          baseline = opening;
          this.compactionBaselines.set(turn.sessionKey, opening);
        }
        if (!autoCompactDue(percent, turn.reading, baseline ?? null)) {
          return;
        }
        onStart();
        const owner = {
          nodeId: node.id,
          ...(callContext ? { callId: callContext.callId } : {}),
        };
        /**
         * The line explaining the compaction, written ONLY once one has
         * actually happened — the chat path's own rule
         * (`ChatService.autoCompactIfDue` writes it after `/compact` has taken
         * the run), and this path did the opposite.
         *
         * REPORTED as auto-compact "not working", and reconstructed from the
         * reporter's run `8ad93b70`: the row said `Context reached the 80%
         * auto-compact threshold (84% — 840k of 1000k tokens) — compacting the
         * conversation` at seq 2121, five milliseconds after the previous
         * turn's end, and no compaction ever followed it. So the transcript
         * claimed a compaction that did not happen, which is the half of the
         * defect the user could see.
         */
        const sayCompacted = (): void => {
          enqueue(async () => {
            await persistItem(node.id, 'system', null, {
              message: autoCompactNotice(percent, turn.reading),
              severity: 'info',
              ...owner,
            }).catch(() => {});
          });
        };
        /** Said instead when the turn ran and the conversation did not shrink. */
        const sayNotCompacted = (why: string): void => {
          enqueue(async () => {
            await persistItem(node.id, 'system', null, {
              message: `Automatic compaction did not take — ${why}. The conversation was left as it was, and it will be tried again after the next turn.`,
              severity: 'warning',
              ...owner,
            }).catch(() => {});
          });
        };
        const compaction = await beginAgentTurn(
          node,
          command.prompt,
          callContext
            ? { ...callContext, resumeSessionId: turn.sessionId }
            : undefined,
          {
            ...(callContext ? {} : { resumeSessionId: turn.sessionId }),
            compaction: true,
          },
        );
        compactionHandles.add(compaction.handle);
        try {
          await compaction.handle.done;
          await drained();
        } finally {
          compactionHandles.delete(compaction.handle);
        }
        const result = compaction.finish();
        if (result.outcome !== 'completed') {
          // Stopped or failed: nothing shrank, so the rule stays armed.
          return;
        }
        if (command.replacesSession) {
          const summary = result.finalText?.trim() ?? '';
          if (summary === '') {
            enqueue(async () => {
              await persistItem(node.id, 'system', null, {
                message:
                  'Automatic compaction produced no summary — the conversation was left as it was.',
                severity: 'warning',
                ...owner,
              }).catch(() => {});
            });
            return;
          }
          this.carriedSummaries.set(turn.sessionKey, summary);
          this.sessions.retire(
            turn.sessionKey,
            'its conversation was compacted',
          );
          sayCompacted();
          enqueue(async () => {
            // The CONVERSATION's figure: a call's own row for a callee, the
            // member's for its own conversation — never the other one.
            await (
              callContext
                ? this.callContextDao.forgetContext(
                    runId,
                    callContext.callId,
                    em,
                  )
                : this.nodeStateDao.forgetContext(runId, node.id, em)
            ).catch(() => {});
            await persistItem(node.id, 'system', null, {
              message:
                'Conversation compacted. The agent starts fresh from the summary above; everything before it is no longer in its context.',
              severity: 'info',
              // TWIN PARSER: `apps/ui/src/renderer/chats/compaction-payload.ts`'s
              // `conversationReplaced` — the chat twin is `commitCarriedCompaction`.
              conversationReplaced: true,
              ...owner,
            }).catch(() => {});
          });
        } else {
          /**
           * A CLI that compacts IN PLACE has to be checked, because a turn
           * that "completed" is not a compaction — it is only a turn that
           * ended.
           *
           * MEASURED on run `8ad93b70`: the `/compact` reached the model as
           * ordinary text and it answered in prose, writing a message headed
           * `## State at compaction`, running three shell commands, and leaving
           * the window at 847,339 tokens against the 840k it started from. The
           * CLI's own compaction never ran and no compaction marker was ever
           * written. The likeliest reason is that the process was mid
           * CONTINUATION of its own — that engineer had background work
           * (`shell_info` three rows earlier), and a turn opened on a process
           * already working is delivered as a mid-turn follow-up, where a
           * leading slash command is not expanded.
           *
           * Nothing on the wire announces that, so this does not try to predict
           * it: it checks the one thing a compaction is FOR. The window must
           * have shrunk. An unshrunk window, or a turn that reported no reading
           * at all, is not a compaction — and both leave the rule ARMED, which
           * is what turns the failure into one wasted turn instead of a run.
           *
           * Because without this the failure DISARMED the feature: the baseline
           * below was set anyway, the next turn recorded ~847k as what the
           * compaction had left behind, and at a 1M window the next trigger
           * moved to ~94.7% — so nothing compacted again for the rest of that
           * run, under a transcript line saying one had.
           */
          const before = turn.reading.tokens;
          const after = result.reading.tokens;
          if (before === null || after === null) {
            sayNotCompacted('the agent reported no context reading for it');
            return;
          }
          if (after >= before) {
            sayNotCompacted(
              `the conversation did not shrink (${after} tokens against ${before} before it)`,
            );
            return;
          }
          sayCompacted();
        }
        this.compactionBaselines.set(turn.sessionKey, 'pending');
      } catch (err) {
        this.logger.warn(
          `team run ${runId} member ${node.id} auto-compaction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };

    /** One member turn keeps its pass slot and caller identity across attempts. */
    const beginNodeTurn = async (
      node: TeamMember,
      prompt: string,
      extras: { resumeSessionId?: string | null; images?: TurnImage[] },
    ): Promise<Awaited<ReturnType<typeof beginAgentTurn>>> => {
      const sessionKey = nodeSessionKey(runId, node.id);
      if (!node.pool?.length) {
        persistTurnStart(node, sessionKey);
        return beginAgentTurn(node, prompt, undefined, extras);
      }
      const cooldowns = this.callBroker.poolCooldowns;
      const held = nodePoolMembers.get(node.id) ?? 1;
      const choice = this.takePoolChoice(runId, node);
      const wasPinned = nodePoolPins.has(node.id);
      const excerptOwed = nodePoolExcerpts.delete(node.id);
      const heldSessionId = excerptOwed
        ? null
        : (extras.resumeSessionId ?? null);
      const heldWindow = nodeWindows.get(node.id);
      const heldBaseline = this.compactionBaselines.get(sessionKey);
      const site = { cwd, runId, memberId: node.id };
      const { standings, proven, order } = cooldowns.order(node, site);
      const start =
        choice ??
        (wasPinned
          ? held
          : conversationStartMember({
              standings,
              proven,
              order,
              held,
              hasSession: heldSessionId !== null,
              holdsWork: this.sessions.holdsWorkFor(sessionKey),
            }));
      const attempts = poolAttempts(node, [
        start,
        ...order.filter((member) => member !== start),
      ]);
      let index = 0;
      let stopped = false;
      let currentPrompt = prompt;
      let resumeSessionId = heldSessionId;
      /** Whether any attempt of this turn so far made a tool call. */
      let turnDidWork = false;
      let finalResult: NodeTurnResult | null = null;
      const failureOf = (turn: NodeTurnResult): CalleeTurnOutcome => ({
        status: turn.outcome === 'skipped' ? 'failed' : turn.outcome,
        finalText: turn.finalText,
        sessionId: turn.sessionId,
        ...readCalleeFailure(turn.error, (message) =>
          this.adapterFor(attempts[index]!.node.agent).failureFrom(message),
        ),
      });
      /**
       * Move the member's conversation to member `to`: its session belongs to
       * the account it was opened on, so the next attempt starts a fresh one,
       * and the row records which member now holds the member for later passes.
       */
      /** Write `row` on the pass's chain, after `before`, and wait for it. */
      const recordOnChain = (
        row: Record<string, unknown>,
        before?: () => Promise<void>,
      ): Promise<void> =>
        new Promise<void>((resolve, reject) => {
          enqueue(async () => {
            try {
              await before?.();
              await persistItem(node.id, 'system', null, row);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });
      const moveConversation = async (
        from: number,
        to: number,
        previousSessionId: string | null,
        message: string,
        retireReason: string,
        recordRetired?: () => Promise<void>,
        pinnedByUser = false,
      ): Promise<void> => {
        this.sessions.retire(sessionKey, retireReason);
        nodeSessionIds.delete(node.id);
        resumeSessions.delete(node.id);
        nodeWindows.delete(node.id);
        this.compactionBaselines.delete(sessionKey);
        await recordOnChain(
          nodePoolHandOffRow({
            member: to,
            fromMember: from,
            previousSessionId,
            message,
            pinnedByUser,
          }),
          async () => {
            await recordRetired?.();
            await this.nodeStateDao.clearConversation(runId, node.id, em);
          },
        );
        nodePoolMembers.set(node.id, to);
        if (pinnedByUser) {
          nodePoolPins.add(node.id);
        } else {
          nodePoolPins.delete(node.id);
        }
      };
      const handOn = async (
        outcome: CalleeTurnOutcome,
        madeToolCalls: boolean,
        retireCards?: () => () => Promise<void>,
      ): Promise<void> => {
        const from = attempts[index]!;
        const next = attempts[++index]!;
        turnDidWork ||= madeToolCalls;
        cooldowns.record(from.node, site, outcome, true);
        // Keep the caller retained: its asynchronous calls must still wake
        // this member, and must not be orphaned between accounts.
        const recordRetired = retireCards?.();
        await moveConversation(
          from.member,
          next.member,
          outcome.sessionId,
          poolHandOffNotice(
            node.name ?? node.id,
            from.member,
            next,
            outcome,
            'turn',
          ),
          'its turn was handed to another pool member',
          recordRetired,
        );
        // Back on the member the conversation left before this turn: its own
        // session still holds everything, so it resumes rather than starts
        // over from a transcript excerpt — unless an attempt of this turn
        // already did work, which that session never saw.
        if (next.member === held && heldSessionId !== null && !turnDidWork) {
          resumeSessionId = heldSessionId;
          currentPrompt = prompt;
          if (heldWindow !== undefined) {
            nodeWindows.set(node.id, heldWindow);
          }
          if (heldBaseline !== undefined) {
            this.compactionBaselines.set(sessionKey, heldBaseline);
          }
          return;
        }
        resumeSessionId = null;
        currentPrompt = nodePoolHandOffPrompt(
          prompt,
          node.id,
          await this.itemDao.nodePoolContextRows(runId, node.id, em),
        );
      };
      const startAttempt = async (): Promise<
        Awaited<ReturnType<typeof beginAgentTurn>>
      > => {
        for (;;) {
          if (stopped || cancelRequested) {
            throw new Error('Team stopped before the agent could launch.');
          }
          const attempt = attempts[index]!;
          conversationNodes.set(node.id, attempt.node);
          persistTurnStart(attempt.node, sessionKey, null, {
            stamp: attempt.node,
            announce: index === 0,
          });
          try {
            return await beginAgentTurn(
              attempt.node,
              currentPrompt,
              undefined,
              {
                ...extras,
                poolMember: attempt.member,
                resumeSessionId,
              },
            );
          } catch (err) {
            if (stopped || cancelRequested || index === attempts.length - 1) {
              throw err;
            }
            await handOn(
              {
                status: 'failed',
                finalText: null,
                sessionId: null,
                ...geniroSideFailure(
                  `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
                ),
              },
              false,
            );
          }
        }
      };
      const nodeName = node.name ?? node.id;
      if (start !== held) {
        await moveConversation(
          held,
          start,
          heldSessionId,
          choice !== null
            ? poolSwitchNotice(nodeName, attempts[0]!, true)
            : poolMoveNotice(nodeName, held, attempts[0]!),
          choice !== null
            ? 'the user moved its conversation to another pool member'
            : 'its conversation moved to another pool member',
          undefined,
          choice !== null,
        );
      } else if (choice !== null && !wasPinned) {
        await recordOnChain(
          nodePoolHandOffRow({
            member: held,
            fromMember: held,
            previousSessionId: null,
            message: poolSwitchNotice(nodeName, attempts[0]!, false),
            pinnedByUser: true,
          }),
        );
        nodePoolPins.add(node.id);
      }
      if (excerptOwed || (start !== held && heldSessionId !== null)) {
        currentPrompt = nodePoolHandOffPrompt(
          prompt,
          node.id,
          await this.itemDao.nodePoolContextRows(runId, node.id, em),
        );
        resumeSessionId = null;
      }
      let current = await startAttempt();
      const done = (async (): Promise<void> => {
        for (;;) {
          await current.handle.done;
          await drained();
          const turn = current.finish();
          const outcome = failureOf(turn);
          if (
            stopped ||
            cancelRequested ||
            index === attempts.length - 1 ||
            !fallsThroughPool(outcome, turn.madeToolCalls)
          ) {
            cooldowns.record(attempts[index]!.node, site, outcome, false);
            finalResult = turn;
            return;
          }
          try {
            await handOn(outcome, turn.madeToolCalls, current.retireCards);
            current = await startAttempt();
          } catch (err) {
            finalResult = {
              ...turn,
              outcome: cancelRequested || stopped ? 'cancelled' : 'failed',
              error: `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
              finalText: null,
              sessionId: null,
            };
            return;
          }
        }
      })();
      return {
        handle: {
          done,
          cancel: () => {
            stopped = true;
            current.handle.cancel();
          },
          respondApproval: (...args) => current.handle.respondApproval(...args),
          sendUserMessage: (message) => current.handle.sendUserMessage(message),
          subagentsAFollowUpCancels: () =>
            current.handle.subagentsAFollowUpCancels?.() ?? 0,
          attributableDelegate: () => current.handle.attributableDelegate(),
          setApprovalMode: (mode) => current.handle.setApprovalMode(mode),
        },
        finish: () => finalResult ?? current.finish(),
        endedAs: () => finalResult?.outcome ?? current.endedAs(),
        retireCards: () => current.retireCards(),
      };
    };

    const launchNode = async (node: TeamMember): Promise<void> => {
      startingPassMembers.add(node.id);
      markRootWorking(node.id, true);

      const prompt = seedPrompt;
      retainNodeTurn(node.id);
      retainConversation(node.id);
      // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
      // config-file write fails) must settle THIS member as failed and keep the
      // pass going — drive()/startRun promise "never throws", and letting it
      // escape would leave the aggregate handle registered but never settling.
      let handle: AgentTurnHandle;
      let finish: () => NodeTurnResult;
      let retireCards: () => () => Promise<void>;
      try {
        ({ handle, finish, retireCards } = await beginNodeTurn(node, prompt, {
          // An earlier pass of this run left this member a conversation; a
          // follow-up's pass carries it on rather than starting it over.
          resumeSessionId: resumeSessions.get(node.id) ?? null,
          images: node.id === run.lead ? run.seedImages : [],
        }));
      } catch (err) {
        startingPassMembers.delete(node.id);
        markRootWorking(node.id, false);
        // Gated like the three sibling settle paths (:1193, and the two cancel
        // routes): a member can hold live CALLEE turns alongside its own
        // turn — which is why `liveTurnsByNode` exists at all — so sweeping
        // unconditionally here would mark a still-answerable card unanswerable
        // and drain a live caller's parked questions, because an unrelated
        // turn failed to spawn.
        const lastTurn = releaseNodeTurn(node.id);
        const recordSwept = lastTurn ? sweepApprovals(node.id) : null;
        endConversationTurn(node.id);
        const outcome = cancelRequested ? 'cancelled' : 'failed';
        settled.set(node.id, outcome);
        enqueue(async () => {
          await recordSwept?.();
          await this.nodeStateDao
            .setStatus(
              runId,
              node.id,
              {
                status: outcome,
                endedAt: Date.now(),
                error:
                  outcome === 'failed'
                    ? `turn start failed: ${err instanceof Error ? err.message : String(err)}`
                    : null,
              },
              em,
            )
            .catch(() => {});
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: outcome,
          }).catch(() => {});
          schedule();
        });
        return;
      }
      startingPassMembers.delete(node.id);
      runningHandles.set(node.id, handle);

      void handle.done.then(async () => {
        // Compacted BEFORE the settle, while this turn still owns the member's
        // session key — see `compactIfDue`.
        await drained();
        const settledTurn = finish();
        await compactIfDue(
          conversationNodes.get(node.id) ?? node,
          settledTurn,
          undefined,
          () => {
            compactingNodes.add(node.id);
          },
        );
        enqueue(async () => {
          // Other turns of this member may live on, and then the member-wide sweep
          // does not run — but THIS turn's cards are dead all the same.
          const recordSwept = releaseNodeTurn(node.id)
            ? sweepApprovals(node.id)
            : retireCards();
          // What this conversation's callees left it is drained to it now:
          // woken for, or orphaned when it was already told.
          endConversationTurn(node.id);
          await recordSwept();
          runningHandles.delete(node.id);
          const { outcome } = finish();
          try {
            await this.nodeStateDao.setStatus(
              runId,
              node.id,
              {
                status: outcome,
                endedAt: Date.now(),
                error: outcome === 'failed' ? 'member turn failed' : null,
              },
              em,
            );
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: outcome,
            });
            settled.set(node.id, outcome);
          } catch (err) {
            persistenceFailed = true;
            settled.set(node.id, 'failed');
            const message = `member bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`;
            await this.nodeStateDao
              .setStatus(
                runId,
                node.id,
                {
                  status: 'failed',
                  endedAt: Date.now(),
                  error: message,
                },
                em,
              )
              .catch((statusErr: unknown) => {
                this.logger.error(
                  `team run ${runId} member ${node.id} failure-status write failed: ${statusErr instanceof Error ? statusErr.message : String(statusErr)}`,
                );
              });
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: 'failed',
              error: message,
            }).catch((itemErr: unknown) => {
              this.logger.error(
                `team run ${runId} member ${node.id} failure item write failed: ${itemErr instanceof Error ? itemErr.message : String(itemErr)}`,
              );
            });
          } finally {
            // The pass must continue even if this member's bookkeeping write
            // throws — schedule() is the only path that enqueues the run
            // finalizer (always AFTER any skip writes, so the run-level
            // turn_complete stays last).
            compactingNodes.delete(node.id);
            // Scheduled FIRST, so the pass moving on never reads as idle; and
            // after `settled`, so a message arriving on a real idle announce
            // finds the root settled, not "still starting".
            schedule();
            enqueue(() => markRootWorking(node.id, false));
          }
        });
      });
    };

    const cancelledOutcome: CalleeTurnOutcome = {
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      // A cancel is not a failure, so it carries no class: the broker answers a
      // cancelled call with CALLEE_CANCELLED and never reads these.
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    };

    /**
     * A call the CALLER stopped, before its turn ever ran. Told apart from the
     * run's own cancel in wording alone — the broker stamps the reason the
     * caller gave onto the envelope it finally hands back.
     */
    const callerCancelledOutcome: CalleeTurnOutcome = {
      status: 'cancelled',
      finalText: null,
      error: 'cancelled by the calling agent',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    };

    /**
     * A call that reached this pass after a follow-up message had claimed the
     * run for its next one — see `supersededByNextPass`. Nothing ran, so it is
     * geniro's own side and the caller's right move is to make it again: by
     * then the next pass serves the call surface.
     */
    const supersededOutcome: CalleeTurnOutcome = {
      status: 'failed',
      finalText: null,
      ...geniroSideFailure(
        'a new message to this run was starting its next pass as this call arrived, so the call did not run — make it again',
      ),
      sessionId: null,
    };

    /**
     * The ending a HELD call writes when it is let go without another turn —
     * nothing left to integrate, or stopped while it waited: the member's
     * status and its row, which the turn that held the call did not write,
     * then the settle the broker wakes the caller on.
     */
    const settleHeldCall = (
      callee: TeamMember,
      callId: string,
      outcome: CalleeTurnOutcome,
      /** User messages accepted for the turn that will now never run. */
      undelivered: readonly string[] = [],
    ): Promise<CalleeTurnOutcome> =>
      new Promise((resolve) => {
        enqueue(async () => {
          try {
            // Shown as sent when they were accepted; said here that no turn
            // read them, as the broker says of a caller's queued messages.
            for (const message of undelivered) {
              await persistItem(callee.id, 'system', null, {
                callId,
                severity: 'info',
                message: `Not delivered — ${callee.name ?? callee.id}'s call was stopped before the turn that would have read it: ${message}`,
              });
            }
            await this.nodeStateDao.setStatus(
              runId,
              callee.id,
              {
                status: outcome.status,
                endedAt: Date.now(),
                error:
                  outcome.status === 'failed' ? 'member turn failed' : null,
              },
              em,
            );
            await persistItem(callee.id, 'status', null, {
              nodeId: callee.id,
              status: outcome.status,
              callId,
            });
          } catch (err) {
            this.logger.warn(
              `team run ${runId} held call ${callId} bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            this.callBroker.noteCalleeSettling(runId, callId);
            resolve(outcome);
          }
        });
      });

    /**
     * One fresh callee turn per CallBroker call. Items stream under the
     * CALLEE's nodeId and the node_state row is upserted per call (the latest
     * call wins). Resolves only after the turn's bookkeeping drained through
     * the write chain — a sync caller's envelope must not outrun the items it
     * summarizes.
     *
     * Every turn, at any depth, is counted against the run's active-turn cap
     * (`activeTurns`) while it works. A fresh one waits for room; a `wake`
     * starts at once, as does a held call's wake below.
     */
    const launchCalleeTurn = async (
      callee: TeamMember,
      message: string,
      callId: string,
      resumeSessionId: string | null,
      conversationId: string,
      { pool, wake }: { pool?: CalleePoolPlan; wake: boolean },
    ): Promise<CalleeTurnOutcome> => {
      /** Whether the run, or the call's own caller, has stopped this call. */
      const callStopped = (): boolean =>
        cancelRequested || cancelledCalls.has(callId);
      /** How a stopped call ends, keeping the session it can be continued from. */
      const stoppedOutcome = (sessionId: string | null): CalleeTurnOutcome => ({
        ...(cancelRequested ? cancelledOutcome : callerCancelledOutcome),
        sessionId,
      });
      /**
       * ONE attempt at the call, as one member of the callee's pool. `handsOn`
       * decides — once, inside the attempt's own settle — whether the call
       * moves on to the next member; such an attempt does not report the call
       * as settling, since the call has no result yet.
       */
      const runAttempt = async (
        callee: TeamMember,
        member: number | undefined,
        /** Whether this is the call's first attempt. */
        first: boolean,
        prompt: string,
        resumeSessionId: string | null,
        /** Null for the last attempt, which nothing can hand on. */
        handsOn:
          | ((outcome: CalleeTurnOutcome, madeToolCalls: boolean) => boolean)
          | null,
        /**
         * Whether a completed turn may HOLD the call for the calls it made
         * (`CallBroker.holdCall`) — false once the call has used its wakes.
         */
        mayHold: boolean,
      ): Promise<{
        outcome: CalleeTurnOutcome;
        handedOn: boolean;
        /** Set when the call is held: what to do once the hold lets go. */
        hold: Promise<CallHoldRelease> | null;
      }> => {
        calleeTurnCounts.set(
          callee.id,
          (calleeTurnCounts.get(callee.id) ?? 0) + 1,
        );
        retainNodeTurn(callee.id);
        // The conversation this call speaks in — what its own calls are
        // owned by (`utils/caller-key.ts`).
        const calleeCaller = callerKey(callee.id, conversationId);
        retainConversation(calleeCaller);
        // A synchronous throw out of beginAgentTurn (e.g. prepareTurn's
        // config-file write hits ENOSPC) must settle the turn as failed and
        // release the retained member turn — never leak the count (which would
        // suppress this member's approval sweep for the rest of the run) nor
        // reject into the broker with an unbalanced ledger.
        let handle: AgentTurnHandle;
        let finish: () => NodeTurnResult;
        let endedAs: () => NodeOutcome;
        let retireCards: () => () => Promise<void>;
        // The silence window measures the CALLEE, so it starts when the
        // callee does — not when `call_agent` returned. A call can queue under
        // the run's active-turn cap for minutes before anything of its own
        // could have been produced, and a window armed at the call would
        // report a callee that had not begun.
        this.callBroker.noteCalleeActivity(runId, callId);
        try {
          const teamMember = nodesById.get(callee.id);
          persistTurnStart(
            callee,
            callSessionKey(runId, conversationId),
            callId,
            member !== undefined && teamMember !== undefined
              ? {
                  stamp: onDemand.has(callee.id)
                    ? teamMember
                    : poolMemberNode(
                        teamMember,
                        nodePoolMembers.get(callee.id) ?? 1,
                      )!,
                  announce: first,
                }
              : undefined,
          );
          ({ handle, finish, endedAs, retireCards } = await beginAgentTurn(
            callee,
            prompt,
            {
              callId,
              resumeSessionId,
              conversationId,
              ...(member !== undefined ? { poolMember: member } : {}),
            },
          ));
        } catch (err) {
          const recordSwept = releaseNodeTurn(callee.id)
            ? sweepApprovals(callee.id)
            : null;
          endConversationTurn(calleeCaller);
          const outcome: CalleeTurnOutcome = {
            status: 'failed',
            finalText: null,
            // geniro's own side: nothing about the work was wrong, so the
            // caller's right move is one retry.
            ...geniroSideFailure(
              `turn start failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
            sessionId: null,
          };
          const handedOn = handsOn?.(outcome, false) ?? false;
          enqueue(async () => {
            await recordSwept?.();
            // An attempt the pool hands on writes no ending: the call has
            // none yet, and a terminal row is what the transcript reads as
            // the call's own.
            if (handedOn) {
              return;
            }
            await this.nodeStateDao
              .setStatus(
                runId,
                callee.id,
                {
                  status: 'failed',
                  endedAt: Date.now(),
                  error: 'turn start failed',
                },
                em,
              )
              .catch(() => {});
            // Mirror the pass-launch catch: persistTurnStart already emitted
            // the 'running' status item, and the renderer only balances it
            // against a terminal one — without this the agents panel counts
            // the callee as live for the rest of the run.
            await persistItem(callee.id, 'status', null, {
              nodeId: callee.id,
              status: 'failed',
              ...(callId ? { callId } : {}),
            }).catch(() => {});
          });
          return { outcome, handedOn, hold: null };
        }
        subTurns.set(callId, { handle, callee, conversationId });
        conversationNodes.set(calleeCaller, callee);
        await handle.done;
        // The result EXISTS from here on, while everything below — draining,
        // closing what the turn left out, possibly a whole compaction turn —
        // still holds the call open. A `cancel_agent` landing in that window
        // must not stamp its reason over finished work.
        //
        // Not yet for a FAILED attempt the pool may still hand on: until that
        // is decided the call has no result, and a cancel arriving meanwhile
        // must stop the hand-on rather than be told the work already finished.
        if (handsOn === null || endedAs() !== 'failed') {
          this.callBroker.noteCalleeTurnEnded(runId, callId);
        }
        // Compacted BEFORE the result is handed back: the call is still
        // active, so no continuation can open a turn on this conversation
        // while it runs — see `compactIfDue`.
        await drained();
        // The callee's own half of the same close — scoped to this CALL, so
        // a conversation's other calls keep whatever they still have out.
        const settledCall = finish();
        // Counted BEFORE that close, which states an ending for exactly the
        // delegates this is about: once it lands, the transcript says none
        // are out, while the work goes on inside the kept process.
        const delegatesStillOut =
          settledCall.outcome === 'completed'
            ? await delegatesOutOfCall(callId)
            : 0;
        const shellsStillOut =
          settledCall.outcome === 'completed'
            ? await shellsOutOfConversation(callee.id, callId, conversationId)
            : [];
        // As the member that filled the window: the compaction is that
        // member's turn, not member 1's, and must leave member 1's row alone.
        const compaction = { started: false };
        await compactIfDue(
          callee,
          settledCall,
          {
            callId,
            conversationId,
            ...(member !== undefined ? { poolMember: member } : {}),
          },
          () => {
            compaction.started = true;
          },
        );
        return await new Promise<{
          outcome: CalleeTurnOutcome;
          handedOn: boolean;
          hold: Promise<CallHoldRelease> | null;
        }>((resolve) => {
          enqueue(async () => {
            // Resolve in finally: a bookkeeping write failure must never
            // leave the broker's envelope pending (a sync caller would
            // hang and the run could never finish).
            let result: CalleeTurnOutcome = {
              status: 'failed',
              finalText: null,
              // geniro's own bookkeeping, not the callee: one retry is right.
              ...geniroSideFailure('callee bookkeeping failed'),
              sessionId: null,
            };
            let handedOn = false;
            let hold: Promise<CallHoldRelease> | null = null;
            try {
              // Another call (or the member's own turn) may still be live, and
              // then the member-wide sweep waits for it — this turn's cards do
              // not.
              const recordSwept = releaseNodeTurn(callee.id)
                ? sweepApprovals(callee.id)
                : retireCards();
              // A callee can itself be a caller: what ITS callees left this
              // conversation is drained to it — once its call has settled,
              // by continuing the conversation (`CallBroker.drainCaller`).
              endConversationTurn(calleeCaller);
              await recordSwept();
              subTurns.delete(callId);
              const { outcome, finalText, sessionId, error, reading } =
                finish();
              const status =
                outcome === 'completed'
                  ? 'completed'
                  : outcome === 'cancelled'
                    ? 'cancelled'
                    : 'failed';
              result = {
                status,
                finalText,
                // The CLI's OWN sentence, classified by the CALLEE's adapter
                // — never a constant. This line read
                // `status === 'failed' ? 'callee turn failed' : null` for two
                // milestones, which is the whole subject of
                // `utils/callee-failure.ts`.
                ...(status === 'failed'
                  ? readCalleeFailure(error, (message) =>
                      this.adapterFor(callee.agent).failureFrom(message),
                    )
                  : { error: null, failureClass: null, resetsAt: null }),
                sessionId,
                ...(delegatesStillOut > 0 ? { delegatesStillOut } : {}),
                ...(shellsStillOut.length > 0 ? { shellsStillOut } : {}),
                // A compaction that ran after the turn left a conversation
                // nothing has measured yet, so its old size says nothing.
                promptCacheTtlMs: settledCall.promptCacheTtlMs,
                contextTokens: compaction.started ? null : reading.tokens,
                contextWindowTokens: reading.window,
              };
              handedOn = handsOn?.(result, settledCall.madeToolCalls) ?? false;
              // Decided before the ending is written, for the turn-start
              // catch's reason: a handed-on attempt's call has no ending yet.
              if (handedOn) {
                return;
              }
              if (handsOn !== null) {
                this.callBroker.noteCalleeTurnEnded(runId, callId);
              }
              // A callee that ended its turn with calls of its own still
              // running has not finished: the call waits for them, writing no
              // ending of its own, and the callee is continued inside it. Only
              // a turn with a session to continue, and only while the call has
              // wakes left — past that it settles saying what is still out.
              const stopped = callStopped();
              // A resumed turn that reported no session of its own is still
              // in the one it resumed.
              if (
                status === 'completed' &&
                mayHold &&
                !stopped &&
                (sessionId ?? resumeSessionId) !== null
              ) {
                hold = this.callBroker.holdCall(runId, callId);
                if (hold !== null) {
                  return;
                }
              }
              // Not held: the call settles now, and a monitor its callee
              // started has nobody left to wake.
              this.monitors?.stopConversation(runId, calleeCaller, 'teardown');
              // Stopped while its turn was ending with work of its own still
              // out: that work is being cancelled with it, so the call ends
              // cancelled rather than handing over an answer it never finished.
              let ending = outcome;
              if (
                status === 'completed' &&
                stopped &&
                this.callBroker.owesWork(runId, callId)
              ) {
                result = stoppedOutcome(sessionId);
                ending = 'cancelled';
              }
              if (ending === 'completed') {
                const callsStillOut = this.callBroker.openSubCallCount(
                  runId,
                  callId,
                );
                if (callsStillOut > 0) {
                  result = { ...result, callsStillOut };
                }
              }
              await this.nodeStateDao.setStatus(
                runId,
                callee.id,
                {
                  status: ending,
                  endedAt: Date.now(),
                  error: ending === 'failed' ? 'member turn failed' : null,
                },
                em,
              );
              await persistItem(callee.id, 'status', null, {
                nodeId: callee.id,
                status: ending,
                callId,
              });
            } finally {
              // BEFORE this turn stops holding the run open: a result owed
              // to a caller that has ended wakes it, and that wake has to be
              // counted before the run can decide it is finished. Not for an
              // attempt the pool hands on — the call has no result yet — nor
              // for a HELD call, whose result is not this turn's.
              if (!handedOn && hold === null) {
                this.callBroker.noteCalleeSettling(runId, callId);
              }
              resolve({ outcome: result, handedOn, hold });
            }
          });
        });
      };

      liveSubTurns += 1;
      try {
        if (cancelRequested) {
          return cancelledOutcome;
        }
        // A call arriving after the walk is over — the caller's POST still in
        // flight through the finalization window, or its KEPT process waking on
        // a timer hours later — must not spawn a child nothing can reach: the
        // run's aggregate handle has settled, so neither Stop nor shutdown
        // would find it. This used to be answered by refusing the call
        // (`RUN_NOT_ACTIVE`); it is answered by WAKING the run instead, which
        // registers a handle again. A run that must not wake still refuses.
        if (runFinished) {
          const woke = await reopenRun();
          if (woke === 'superseded') {
            return supersededOutcome;
          }
          if (woke === 'stopped') {
            return cancelledOutcome;
          }
        }
        if (cancelledCalls.has(callId)) {
          return callerCancelledOutcome;
        }
        const conversation = callerKey(callee.id, conversationId);
        // Given back while the call is HELD and taken again for its wake — a
        // held call runs nothing, and its own calls may need the slot.
        let slot: TurnSlot | null = wake
          ? activeTurns.admit()
          : activeTurns.tryAcquire();
        if (slot === null) {
          const queued = new AbortController();
          queuedStarts.set(callId, queued);
          const working = activeTurns.active();
          enqueue(async () => {
            // TWIN PARSER: `apps/ui/src/renderer/chats/transcript-groups.ts`
            // reads `queuedCall` onto the call block, which then draws a call
            // that has not started as queued rather than running; the
            // run-state route reads it too (`ItemDao.callQueueRows` →
            // `foldRunCalls`, `RunCallState.queued`).
            await persistItem(callee.id, 'system', null, {
              callId,
              severity: 'info',
              queuedCall: { cap: turnCap },
              message: `Queued — ${working} agent turn(s) of this run are already working, at its cap of ${turnCap}. ${callee.name ?? callee.id} starts as soon as one of them finishes or waits.`,
            }).catch(() => {});
          });
          this.callBroker.noteCalleeQueued(runId, callId, true);
          slot = await activeTurns.acquire(queued.signal);
          queuedStarts.delete(callId);
          if (slot === null) {
            return cancelRequested ? cancelledOutcome : callerCancelledOutcome;
          }
          this.callBroker.noteCalleeQueued(runId, callId, false);
        }
        holdTurnSlot(conversation, slot);
        let callWakes = 0;
        let monitorWakes = 0;
        let currentMessage = message;
        /**
         * The HELD loop: the call waits for the calls its callee made, and is
         * continued inside itself until a turn ends with none of them
         * running. Its result is that LAST turn's answer.
         */
        const followHold = async (
          node: TeamMember,
          member: number | undefined,
          first: CalleeTurnOutcome,
          firstHold: Promise<CallHoldRelease> | null,
          asReported: (outcome: CalleeTurnOutcome) => CalleeTurnOutcome,
          handsOn: Parameters<typeof runAttempt>[5],
        ): Promise<{ outcome: CalleeTurnOutcome; handedOn: boolean }> => {
          let reported = first;
          let pending = firstHold;
          while (pending !== null) {
            const waiting = { node, messages: [] as string[] };
            waitingCalls.set(callId, waiting);
            if (slot !== null) {
              dropTurnSlot(conversation, slot);
              slot = null;
            }
            const release = await pending;
            // A wake serves calls already running, so it never queues: its
            // own calls' answers may be what every slot is waiting on.
            if (release.kind === 'wake' && !callStopped()) {
              slot = activeTurns.admit();
              holdTurnSlot(conversation, slot);
            }
            waitingCalls.delete(callId);
            if (release.kind === 'settle' && !callStopped()) {
              // Read again: a command can end while the call is held, and
              // the caller is told what is running when it actually settles.
              return {
                outcome: await settleHeldCall(
                  node,
                  callId,
                  reported.status === 'completed'
                    ? {
                        ...reported,
                        shellsStillOut: await shellsOutOfConversation(
                          node.id,
                          callId,
                          conversationId,
                        ),
                      }
                    : reported,
                  waiting.messages,
                ),
                handedOn: false,
              };
            }
            if (release.kind !== 'wake' || callStopped()) {
              return {
                outcome: await settleHeldCall(
                  node,
                  callId,
                  stoppedOutcome(reported.sessionId),
                  waiting.messages,
                ),
                handedOn: false,
              };
            }
            if (release.monitor === true) {
              monitorWakes += 1;
              if (monitorWakes >= MAX_MONITOR_WAKES) {
                // The last wake it is given: the turn it starts settles the
                // call, so nothing may be left running to wake it again.
                this.monitors?.stopConversation(
                  runId,
                  callerKey(node.id, conversationId),
                  'teardown',
                );
              }
            } else {
              callWakes += 1;
            }
            currentMessage = [
              release.prompt,
              ...this.callBroker.takeQueuedMessages(runId, callId),
              ...waiting.messages,
              release.note,
            ].join('\n\n');
            const woken = await runAttempt(
              node,
              member,
              false,
              // What was sent between the wake and its turn's start — the
              // caller's queued messages first, as a held wake orders them —
              // and the note that the reply is the result, said last.
              currentMessage,
              reported.sessionId,
              handsOn,
              callWakes < MAX_CALL_WAKES && monitorWakes < MAX_MONITOR_WAKES,
            );
            if (woken.handedOn) {
              return { outcome: woken.outcome, handedOn: true };
            }
            reported = asReported({
              ...woken.outcome,
              sessionId: woken.outcome.sessionId ?? reported.sessionId,
            });
            pending = woken.hold;
          }
          return { outcome: reported, handedOn: false };
        };
        try {
          if (cancelRequested || (runFinished && !reopened)) {
            return cancelledOutcome;
          }
          // Checked AGAIN after the slot: the whole point of the mark is the
          // cancel that lands after the slot was granted, which the queue's own
          // abort no longer reaches.
          if (cancelledCalls.has(callId)) {
            return callerCancelledOutcome;
          }
          // The pool plan: the member `callee` already is, then the members a
          // failure another account could get past hands the call to.
          const attempts = [
            { member: pool?.member ?? 1, node: callee },
            ...(pool?.fallbacks ?? []),
          ];
          const skipped: PoolSkip[] = [];
          const recordAttempt = (
            member: TeamMember,
            outcome: CalleeTurnOutcome,
            handedPast: boolean,
          ): void => {
            if (pool !== undefined) {
              this.callBroker.poolCooldowns.record(
                member,
                { cwd, runId, memberId: callee.id },
                outcome,
                handedPast,
              );
            }
          };
          /** The member whose CLI session `resumeSessionId` is. */
          const sessionMember =
            pool === undefined ? attempts[0]!.member : pool.sessionMember;
          /** Whether an attempt of this call handed on had made a tool call. */
          let callDidWork = false;
          /**
           * The task a member that holds none of this conversation is opened
           * with: the call's message, what was said into it since, and the
           * conversation's recent history.
           */
          const transcriptPrompt = async (): Promise<string> => {
            await drained();
            const calls = [
              callId,
              ...this.callBroker.recordedCallsOf(runId, conversationId),
            ];
            const [recent, briefs] = await Promise.all([
              this.itemDao.getByRun(
                runId,
                -1,
                em,
                { limit: 200, take: 'newest' },
                calls,
              ),
              this.itemDao.callRowsOf(runId, calls, em),
            ]);
            return callPoolHandOffPrompt(
              poolHandOffPrompt(currentMessage, callMessages.get(callId) ?? []),
              [
                ...new Map(
                  [...briefs, ...recent].map((row) => [row.id, row]),
                ).values(),
              ].sort((a, b) => a.seq - b.seq),
            );
          };
          /** The member's own process must not serve another member's turn. */
          const retireConversationProcess = (reason: string): void => {
            this.sessions.retire(callSessionKey(runId, conversationId), reason);
          };
          const noteMember = (to: number, text: string): void => {
            enqueue(async () => {
              await persistItem(callee.id, 'system', null, {
                callId,
                severity: 'info',
                // The member now running the call, for the reader to name it
                // before the call settles — `call_started` names the first
                // member and only the settle names the one that answered.
                member: to,
                message: text,
              }).catch(() => {});
            });
          };
          let attemptPrompt = message;
          let attemptSession =
            sessionMember === attempts[0]!.member ? resumeSessionId : null;
          if (
            sessionMember !== null &&
            resumeSessionId !== null &&
            sessionMember !== attempts[0]!.member
          ) {
            retireConversationProcess(
              'its conversation moved to another pool member',
            );
            noteMember(
              attempts[0]!.member,
              poolMoveNotice(
                callee.name ?? callee.id,
                sessionMember,
                attempts[0]!,
                pool?.preferred ?? null,
              ),
            );
            attemptPrompt = await transcriptPrompt();
          }
          for (let index = 0; ; index += 1) {
            const attempt = attempts[index]!;
            const isLast = index === attempts.length - 1;
            const member = pool === undefined ? undefined : attempt.member;
            const asReported = (
              outcome: CalleeTurnOutcome,
            ): CalleeTurnOutcome =>
              pool === undefined
                ? outcome
                : {
                    ...outcome,
                    member: attempt.member,
                    ...(skipped.length > 0 ? { poolSkipped: skipped } : {}),
                  };
            const handsOn: Parameters<typeof runAttempt>[5] = isLast
              ? null
              : (result, madeToolCalls) => {
                  const handing =
                    !callStopped() && fallsThroughPool(result, madeToolCalls);
                  callDidWork ||= handing && madeToolCalls;
                  return handing;
                };
            const attempted = await runAttempt(
              attempt.node,
              member,
              index === 0,
              attemptPrompt,
              attemptSession,
              handsOn,
              callWakes < MAX_CALL_WAKES,
            );
            let { outcome } = attempted;
            const { handedOn, hold } = attempted;
            if (!handedOn) {
              const followed = await followHold(
                attempt.node,
                member,
                // Held on the session this turn RESUMED when it reported none
                // of its own — the wake must continue that conversation.
                asReported(
                  hold === null
                    ? outcome
                    : {
                        ...outcome,
                        sessionId: outcome.sessionId ?? attemptSession,
                      },
                ),
                hold,
                asReported,
                handsOn,
              );
              if (!followed.handedOn) {
                recordAttempt(attempt.node, followed.outcome, false);
                callMessages.delete(callId);
                forgetCallDeliveries(callId);
                return followed.outcome;
              }
              outcome = followed.outcome;
            }
            // Recorded as it is handed on, not when the call settles: until
            // then every other run would still start new work on it.
            recordAttempt(attempt.node, outcome, true);
            const next = attempts[index + 1]!;
            skipped.push({
              member: attempt.member,
              failureClass: outcome.failureClass,
              error: outcome.error,
              resetsAt: outcome.resetsAt,
            });
            this.callBroker.noteCalleeHandedOn(runId, callId);
            // The next member runs under the same conversation key, and the
            // process this member left there must not serve it: a session
            // judges whether it fits a turn by its OWN CLI's key, which another
            // CLI's turn can match field for field.
            retireConversationProcess(
              'its call was handed to another pool member',
            );
            noteMember(
              next.member,
              poolHandOffNotice(
                callee.name ?? callee.id,
                attempt.member,
                next,
                outcome,
                'call',
                pool?.preferred ?? null,
              ),
            );
            // Back on the member holding the conversation's session: it
            // resumes rather than starts over from a transcript excerpt —
            // unless an attempt of this call already did work it never saw.
            if (
              next.member === sessionMember &&
              resumeSessionId !== null &&
              !callDidWork
            ) {
              attemptSession = resumeSessionId;
              attemptPrompt = poolHandOffPrompt(
                currentMessage,
                callMessages.get(callId) ?? [],
              );
              continue;
            }
            attemptSession = null;
            attemptPrompt = await transcriptPrompt();
          }
        } finally {
          if (slot !== null) {
            dropTurnSlot(conversation, slot);
          }
        }
      } finally {
        liveSubTurns -= 1;
        enqueue(() => finishRunIfSettled());
      }
    };

    /**
     * Another turn for an agent whose own turn has already ended, while the run
     * is still live — how a follow-up reaches an agent the trigger feeds without
     * starting another pass.
     *
     * It rides the member's OWN session key, so the process that agent's turn
     * kept takes it and the answer comes from inside the conversation it is
     * already in; a process the registry has since reaped is spawned again on
     * the session id this member reported. It is counted like a callee sub-turn —
     * outside the walk's denominator, holding the run open while it lasts —
     * because it is not a step of the walk: the member already has its outcome.
     */
    const continueNode = async (
      node: TeamMember,
      prompt: string,
      images: TurnImage[],
      monitorProgress = false,
    ): Promise<void> => {
      if (!monitorProgress) {
        wokenOnlyByMonitors = false;
      }
      const starting = reserveContinuation(node.id);
      tookOver(node.id);
      if (leadIds.has(node.id)) {
        markRootWorking(node.id, true);
      }
      liveSubTurns += 1;
      retainNodeTurn(node.id);
      retainConversation(node.id);
      let handle: AgentTurnHandle;
      let finish: () => NodeTurnResult;
      let retireCards: () => () => Promise<void>;
      try {
        ({ handle, finish, retireCards } = await beginNodeTurn(node, prompt, {
          images,
          resumeSessionId:
            nodeSessionIds.get(node.id) ?? resumeSessions.get(node.id) ?? null,
        }));
      } catch (err) {
        startingContinuations.delete(node.id);
        starting.release();
        markRootWorking(node.id, false, monitorProgress);
        const lastTurn = releaseNodeTurn(node.id);
        const recordSwept = lastTurn ? sweepApprovals(node.id) : null;
        endConversationTurn(node.id);
        const outcome = cancelRequested ? 'cancelled' : 'failed';
        if (outcome === 'failed') {
          failedMembers.add(node.id);
        }
        enqueue(async () => {
          await recordSwept?.();
          await this.nodeStateDao
            .setStatus(
              runId,
              node.id,
              {
                status: outcome,
                endedAt: Date.now(),
                error:
                  outcome === 'failed'
                    ? `turn start failed: ${err instanceof Error ? err.message : String(err)}`
                    : null,
              },
              em,
            )
            .catch(() => {});
          await persistItem(node.id, 'status', null, {
            nodeId: node.id,
            status: outcome,
          }).catch(() => {});
          liveSubTurns -= 1;
          await finishRunIfSettled();
        });
        return;
      }
      startingContinuations.delete(node.id);
      continuationHandles.set(node.id, handle);
      starting.release();
      void handle.done.then(async () => {
        await drained();
        const settledTurn = finish();
        await compactIfDue(
          conversationNodes.get(node.id) ?? node,
          settledTurn,
          undefined,
          () => {
            compactingNodes.add(node.id);
          },
        );
        enqueue(async () => {
          const recordSwept = releaseNodeTurn(node.id)
            ? sweepApprovals(node.id)
            : retireCards();
          endConversationTurn(node.id);
          await recordSwept();
          continuationHandles.delete(node.id);
          const { outcome } = finish();
          if (outcome === 'failed') {
            failedMembers.add(node.id);
          } else if (outcome === 'completed') {
            failedMembers.delete(node.id);
          }
          try {
            await this.nodeStateDao.setStatus(
              runId,
              node.id,
              {
                status: outcome,
                endedAt: Date.now(),
                error: outcome === 'failed' ? 'member turn failed' : null,
              },
              em,
            );
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: outcome,
            });
          } catch (err) {
            persistenceFailed = true;
            this.logger.error(
              `team run ${runId} member ${node.id} follow-up bookkeeping failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          } finally {
            compactingNodes.delete(node.id);
            liveSubTurns -= 1;
            try {
              await finishRunIfSettled(monitorProgress);
            } finally {
              markRootWorking(node.id, false, monitorProgress);
            }
          }
        });
      });
    };

    /** Write a user message row on the serialized chain and hand it back. */
    const persistUserMessage = (
      memberId: string | null,
      payload: unknown,
    ): Promise<ItemWire> =>
      new Promise<ItemWire>((resolve, reject) => {
        enqueue(async () => {
          try {
            resolve(await persistItem(memberId, 'message', 'user', payload));
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

    /**
     * A follow-up for this LIVE run: the agents the trigger feeds get it, as
     * though the trigger had fired again — `TeamExecutorService.sendMessage`
     * holds the settled half.
     *
     * An agent mid-turn is told through its CLI's own mid-turn channel, the one
     * a chat's follow-up rides; an idle one is given another turn on its kept
     * process. Null once the run has finished, which hands the message back to
     * be walked from the trigger instead.
     */
    const releaseWaitsFor = (
      node: TeamMember,
      /** The conversation the message went into — its own, unless named. */
      conversationId: string | null = null,
    ): void => {
      // A message delivered into a turn that is blocked in `await_agent` (or a
      // sync `call_agent`) is read by the CLI only once that tool call returns,
      // so the wait is released and the caller answers the user now. Not on a
      // CLI whose follow-up INTERRUPTS: its new prompt already replaces the
      // one waiting, and no consumption report would ever clear the mark left
      // for a wait that has not started.
      if (!this.adapterFor(node.agent).getConfig().followUp.interrupts) {
        this.callBroker.interruptWaits(
          runId,
          callerKey(node.id, conversationId),
        );
      }
    };

    /**
     * The handle of the turn `caller` is speaking in right now — the member's own
     * turn or follow-up for its own conversation, or the callee sub-turn
     * of the call its conversation is answering — or null when it has none.
     */
    const conversationHandle = (caller: string): AgentTurnHandle | null => {
      const memberId = callerNodeOf(caller);
      const conversationId = callerConversationOf(caller);
      if (conversationId === null) {
        return (
          continuationHandles.get(memberId) ??
          runningHandles.get(memberId) ??
          null
        );
      }
      for (const turn of subTurns.values()) {
        if (
          turn.callee.id === memberId &&
          turn.conversationId === conversationId
        ) {
          return turn.handle;
        }
      }
      return null;
    };

    /** Why nothing can be handed to the run's roots right now, or null. */
    const whyRootsNotReady = (roots: readonly TeamMember[]): string | null => {
      // A root the pass's cap has held back has no conversation to carry on yet,
      // and its own turn is about to start from the seed. A lead the run was
      // handed to mid-pass is no pass member: it has a turn or takes one now.
      if (
        roots.some(
          (root) =>
            (passMemberIds.has(root.id) &&
              !settled.has(root.id) &&
              !runningHandles.has(root.id)) ||
            startingContinuations.has(root.id),
        )
      ) {
        return 'the team is still starting';
      }
      const takingOver = roots.find(
        (root) =>
          handingOver.has(root.id) &&
          !runningHandles.has(root.id) &&
          !continuationHandles.has(root.id),
      );
      if (takingOver) {
        return `${takingOver.name ?? takingOver.id} is taking over the run`;
      }
      // Never delivered into a compaction: on a CLI whose compaction replaces
      // the session, a message landing in it would be summarised away.
      const compactingRoot = roots.find((root) => compactingNodes.has(root.id));
      if (compactingRoot) {
        return `${compactingRoot.name ?? compactingRoot.id} is compacting its conversation`;
      }
      return null;
    };

    /**
     * A message from another thread, into the lead's running turn: the user's
     * follow-up without the user. It stays out of the shared delivery, because
     * no user row stands behind it, and leaves `wokenOnlyByMonitors` alone,
     * because the user is not driving this stretch.
     */
    const joinThreadMessage = async (
      join: ThreadMessageJoin,
    ): Promise<ThreadMessageJoinAnswer> => {
      if (runFinished && !reopened) {
        return 'idle';
      }
      const roots = nodes.filter((node) => leadIds.has(node.id));
      if (cancelRequested || whyRootsNotReady(roots) !== null) {
        return 'busy';
      }
      const lead = roots.find(
        (root) =>
          runningHandles.has(root.id) || continuationHandles.has(root.id),
      );
      if (lead === undefined) {
        return 'idle';
      }
      if (
        this.approvals
          .listByRun(runId)
          .some((card) => card.question && card.memberId === lead.id)
      ) {
        return 'question';
      }
      const running = conversationNodes.get(lead.id) ?? lead;
      if (this.adapterFor(running.agent).getConfig().followUp.interrupts) {
        return 'busy';
      }
      if (join.overBudget) {
        return 'over_budget';
      }
      const told = (
        runningHandles.get(lead.id) ?? continuationHandles.get(lead.id)
      )?.sendUserMessage({
        text: join.prompt,
        images: [],
        deliveryId: join.deliveryId,
      });
      if (told !== true) {
        return 'busy';
      }
      promptDeliveries.set(join.deliveryId, {
        caller: callerKey(lead.id, null),
        redeliver: join.onDropped,
      });
      enqueue(async () => {
        await persistItem(null, 'system', null, join.row);
      });
      releaseWaitsFor(running);
      return 'joined';
    };

    const deliverFollowUp = async (
      text: string,
      images: SendMessageImage[],
      backgroundWork?: FollowUpBackgroundWork,
    ): Promise<ItemWire | null> => {
      // A pass that is over hands the message back to be walked from the
      // trigger — unless the run is AWAKE for work its own agents started
      // (`reopenRun`), which holds the run's claim a new walk would need. Then
      // the message is delivered here, exactly as into a live pass.
      if (runFinished && !reopened) {
        return null;
      }
      // RUN_BUSY, which the renderer queues on and drains when a turn ends.
      const busy = (why: string): ConflictException =>
        new ConflictException(
          'RUN_BUSY',
          `${why} — your message goes out once it has`,
        );
      if (cancelRequested) {
        throw busy('this run is stopping');
      }
      const roots = nodes.filter((node) => leadIds.has(node.id));
      const notReady = whyRootsNotReady(roots);
      if (notReady !== null) {
        throw busy(notReady);
      }
      if (backgroundWork === 'ask') {
        const cancels = roots.reduce(
          (sum, root) =>
            sum +
            ((
              runningHandles.get(root.id) ?? continuationHandles.get(root.id)
            )?.subagentsAFollowUpCancels?.() ?? 0),
          0,
        );
        if (cancels > 0) {
          throw subagentsWouldBeCancelled(cancels);
        }
      }
      const { stored, turnImages } = this.storeImages(runId, images);
      // TWIN PARSER: the renderer reads the row's `deliveryId` back
      // (`chats/not-sent-messages.ts`). Each root is told under its own id.
      const deliveryId = randomUUID();
      const shared: SharedDelivery = {
        rowDeliveryId: deliveryId,
        roots: roots.length,
        took: 0,
        dropped: [],
      };
      // The user drives this stretch now: its settle is theirs to hear about.
      wokenOnlyByMonitors = false;
      const told: string[] = [];
      for (const root of roots) {
        const running =
          runningHandles.get(root.id) ?? continuationHandles.get(root.id);
        if (!running) {
          // Started fresh with the message below: it cannot be dropped.
          shared.took += 1;
          continue;
        }
        const rootDeliveryId = randomUUID();
        // Told FIRST, recorded after: only a delivery the CLI confirmed may be
        // written to the transcript — the reverse leaves a message on screen
        // that no agent received.
        if (
          !running.sendUserMessage({
            text,
            images: turnImages,
            deliveryId: rootDeliveryId,
            ...(backgroundWork === 'cancel'
              ? { cancelBackgroundWork: true }
              : {}),
          })
        ) {
          for (const id of told) {
            rootDeliveries.delete(id);
          }
          throw busy(`${root.name ?? root.id} is finishing a turn`);
        }
        told.push(rootDeliveryId);
        rootDeliveries.set(rootDeliveryId, {
          delivery: shared,
          memberId: root.id,
          name: root.name ?? root.id,
        });
      }
      // The roots this message will START a turn for are counted live from
      // NOW, across the write below: on an awake run the woken work can drain
      // during it, and the wake would then settle — status written back, claim
      // released — under a turn that is about to begin.
      const starting = roots
        .filter(
          (root) =>
            !runningHandles.has(root.id) && !continuationHandles.has(root.id),
        )
        .map((root) => ({ root, reservation: reserveContinuation(root.id) }));
      liveSubTurns += starting.length;
      let item: ItemWire;
      let persisted = false;
      try {
        item = await persistUserMessage(null, {
          ...messagePayload(text, stored),
          deliveryId,
        });
        persisted = true;
      } finally {
        liveSubTurns -= starting.length;
        if (!persisted) {
          for (const id of told) {
            rootDeliveries.delete(id);
          }
          for (const { root, reservation } of starting) {
            startingContinuations.delete(root.id);
            reservation.release();
          }
        }
      }
      for (const root of roots) {
        if (!runningHandles.has(root.id) && !continuationHandles.has(root.id)) {
          continueNode(root, text, turnImages);
        } else {
          releaseWaitsFor(conversationNodes.get(root.id) ?? root);
        }
      }
      // A turn that could not be started leaves nothing live to settle the
      // wake, so the check the reservation above deferred is made here.
      await finishRunIfSettled();
      return item;
    };

    /**
     * A message from the user to the callee of ONE running call — the direct
     * line past the caller. It goes through the CLI's mid-turn channel, so the
     * callee answers inside the work it was briefed for and its result still
     * goes back to the caller.
     *
     * Refused rather than re-routed once the call is not running: a settled
     * callee has no turn to join and nobody waiting on its answer, and text
     * meant for one agent must not reach another. The row carries the callee's
     * member id and the call id, which files it inside that call's block.
     *
     * The addressed member must match the call's callee: call ids are numbered
     * per PASS of a run, so a block left reading "running" by an earlier pass
     * can name an id a later pass gave to a different agent.
     */
    const deliverToCall = async (
      memberId: string,
      callId: string,
      text: string,
      images: SendMessageImage[],
    ): Promise<ItemWire> => {
      const subTurn = subTurns.get(callId);
      const waiting = waitingCalls.get(callId);
      // A call between two turns of its hold: the message opens the turn
      // that continues it, inside the call, rather than waiting for the calls
      // its callee made — or, once that turn is already due and has not
      // started, joins its prompt.
      if (
        subTurn === undefined &&
        waiting !== undefined &&
        waiting.node.id === memberId &&
        !cancelRequested
      ) {
        const { node } = waiting;
        if (images.length > 0) {
          throw new ConflictException(
            'CALL_MESSAGE_REFUSED',
            `${node.name ?? node.id} is between turns of its call — a message to it now can carry text only`,
          );
        }
        if (!this.callBroker.messageHeldCall(runId, callId, text)) {
          waiting.messages.push(text);
        }
        noteCallMessage(callId, text);
        return persistUserMessage(node.id, {
          ...messagePayload(text, []),
          nodeId: node.id,
          callId,
        });
      }
      if (
        subTurn === undefined ||
        subTurn.callee.id !== memberId ||
        cancelRequested
      ) {
        throw callNotRunning();
      }
      const { handle, callee, conversationId } = subTurn;
      const { stored, turnImages } = this.storeImages(runId, images);
      // TWIN PARSER: the renderer reads it back off the row
      // (`chats/not-sent-messages.ts`).
      const deliveryId = randomUUID();
      wokenOnlyByMonitors = false;
      // Told FIRST, recorded after, for `deliverFollowUp`'s reason.
      if (!handle.sendUserMessage({ text, images: turnImages, deliveryId })) {
        throw new ConflictException(
          'CALL_MESSAGE_REFUSED',
          `${callee.name ?? callee.id} can't take a message while it works — its CLI accepts none mid-turn, or the turn is ending`,
        );
      }
      noteCallMessage(callId, text);
      // A callee that is itself a caller may be waiting on ITS callees — in
      // the conversation this call speaks in.
      releaseWaitsFor(callee, conversationId);
      return persistUserMessage(callee.id, {
        ...messagePayload(text, stored),
        nodeId: callee.id,
        callId,
        deliveryId,
      });
    };

    /**
     * Start the member the pass runs, unless it settled, runs or is starting;
     * a cancelled pass settles it `cancelled` instead.
     */
    const schedule = (): void => {
      for (const node of passMembers) {
        if (
          settled.has(node.id) ||
          runningHandles.has(node.id) ||
          startingPassMembers.has(node.id)
        ) {
          continue;
        }
        if (cancelRequested) {
          settled.set(node.id, 'cancelled');
          enqueue(async () => {
            await this.nodeStateDao.setStatus(
              runId,
              node.id,
              { status: 'cancelled', endedAt: Date.now() },
              em,
            );
            await persistItem(node.id, 'status', null, {
              nodeId: node.id,
              status: 'cancelled',
            });
          });
          continue;
        }
        if (
          runningHandles.size + startingPassMembers.size >=
          this.parallelism
        ) {
          continue;
        }
        void launchNode(node);
      }
      enqueue(() => finishRunIfSettled());
    };

    // Every call-capable agent needs a token whether or not it calls anyone —
    // the board and render tools ride the same endpoint.
    //
    // ONCE per run, not per pass, for the reason the callers' loop below
    // states — and this loop is where that rule was broken. It re-minted on
    // every pass, and because it runs FIRST, its fresh token is the one the
    // callers' loop then found already present and left alone: so on a task
    // run, which is every run started from the board, a Manager's kept process
    // was locked out of its own endpoint by the second message the user sent.
    // REPORTED as `call_agent` and `get_task` both answering 403 FORBIDDEN in a
    // thread that had been calling its team all morning; reconstructed from the
    // daemon log, where four passes 20 seconds apart re-minted four times and
    // every tool call after the first of them was refused by the guard.
    //
    // Every call-capable agent, not only a board task's — see `holdsEndpoint`.
    for (const node of nodes) {
      if (callCapable(node)) {
        this.callTokens.ensure(runId, node.id);
      }
    }
    const hostToolNodes = nodes.filter((node) => callCapable(node));
    this.registerArtifactPublishers(
      runId,
      hostToolNodes.map((node) => node.id),
      persistItem,
    );
    // A relay run's press goes to whoever leads at the press, so every
    // publisher says who it is.
    this.registerActionPublishers(
      runId,
      hostToolNodes,
      team.mode === 'relay' ? new Set() : leadIds,
    );
    const watchLead = (lead: string): void => {
      if (leadIds.has(lead) || !nodesById.has(lead)) {
        return;
      }
      for (const previous of leadIds) {
        markRootWorking(previous, false);
      }
      leadIds.clear();
      leadIds.add(lead);
      if (cancelRequested || (runFinished && !reopened)) {
        return;
      }
      if (
        runningHandles.has(lead) ||
        continuationHandles.has(lead) ||
        startingContinuations.has(lead)
      ) {
        if (!heldOwnTurns.has(lead)) {
          markRootWorking(lead, true);
        }
        return;
      }
      markRootWorking(lead, true);
      tookOver(lead);
      const timer = setTimeout(() => {
        if (
          !handingOver.delete(lead) ||
          this.leadWatchers.get(runId) !== watchLead
        ) {
          return;
        }
        if (!continuationHandles.has(lead) && !runningHandles.has(lead)) {
          markRootWorking(lead, false);
        }
      }, HANDOFF_START_GRACE_MS);
      timer.unref();
      handingOver.set(lead, timer);
    };
    this.leadWatchers.set(runId, watchLead);
    this.registerMonitorSinks(
      runId,
      hostToolNodes,
      cwd,
      (node) => resolveApproval(node).mode,
    );
    this.registerTeamNoteSinks(runId, hostToolNodes, nodes, persistItem);
    this.registerRunOutcomeSinks(runId, hostToolNodes, persistItem);
    this.registerBrowserSinks(
      runId,
      hostToolNodes,
      (node) => resolveApproval(node).mode,
      persistItem,
    );
    this.registerLeadCardSinks(runId, team, hostToolNodes, (memberId) =>
      liveConversations.has(memberId),
    );
    /**
     * Open a turn of a member's OWN conversation on the write chain — what a
     * wake (`wakeNode`) and a monitor's output share: counted live from now
     * rather than from when the turn begins (the turn starts on the write
     * chain, and a finalizer queued ahead of it would otherwise see nothing
     * live and close the run under it), after any continuation still being
     * reserved, waking a finished run first. `onStopped` runs when the run was
     * cancelled meanwhile or refuses to wake — `stopped` (stopped, archived,
     * being deleted) or `superseded` (a user's message claimed the run for its
     * next pass meanwhile); `onBusy` when the conversation is working again,
     * handed what opens this turn once more; `start` opens it.
     */
    const scheduleOwnTurn = (
      memberId: string,
      caller: string,
      monitorProgress: boolean,
      steps: {
        onStopped: (why: 'stopped' | 'superseded') => void;
        onBusy: (rewake: () => void) => void;
        start: () => Promise<void> | void;
      },
    ): void => {
      liveSubTurns += 1;
      const deliver = async (): Promise<void> => {
        const starting = startingContinuations.get(memberId);
        if (starting) {
          // The reservation may depend on a later write in this chain.
          void starting.ready.then(() => enqueue(deliver));
          return;
        }
        liveSubTurns -= 1;
        const woke = cancelRequested
          ? 'stopped'
          : runFinished
            ? await reopenRun(monitorProgress)
            : 'awake';
        if (woke !== 'awake') {
          steps.onStopped(woke);
          await finishRunIfSettled();
          return;
        }
        if (liveConversations.has(caller)) {
          steps.onBusy(() => {
            liveSubTurns += 1;
            enqueue(deliver);
          });
          // This path opens NO turn, so nothing else would put a run that
          // woke for it back to sleep.
          await finishRunIfSettled();
          return;
        }
        await steps.start();
      };
      enqueue(deliver);
    };
    // A monitor's output reaches a member's OWN conversation as a turn of its
    // own once the one it is in has ended — `wakeNode`'s path, which exists
    // only where the team can call — and a callee conversation inside the
    // call it holds open.
    this.wakerStopped.set(runId, () => cancelRequested);
    this.monitorWakers.set(runId, (caller, prompt, row, onDropped, opener) => {
      if (cancelRequested) {
        return 'refused';
      }
      if (liveConversations.has(caller)) {
        return 'busy';
      }
      if (callerConversationOf(caller) !== null) {
        // Only a monitor's output reopens a call it holds; anything else
        // geniro owes a callee waits for its next turn as a note.
        if (opener !== 'monitor') {
          return 'refused';
        }
        const woke = this.callBroker.wakeHeldCallee(runId, caller, prompt, row);
        return woke === 'pending' ? 'busy' : woke;
      }
      const memberId = callerNodeOf(caller);
      const node = nodesById.get(memberId);
      if (node === undefined) {
        return 'refused';
      }
      const monitorProgress =
        opener === 'monitor' && wakesOnMonitorProgress(row);
      scheduleOwnTurn(memberId, caller, monitorProgress, {
        // Its delivery already let the output go: handed back, it holds it
        // for the next pass's turn of this conversation, or records what
        // ended when the run is stopped.
        onStopped: (why) => onDropped(why === 'superseded'),
        // A follow-up took the conversation meanwhile: never into its turn.
        onBusy: (rewake) => redeliverWhenEnded(caller, rewake),
        start: async () => {
          await persistItem(memberId, 'system', null, row);
          void continueNode(node, prompt, [], monitorProgress);
        },
      });
      return 'woken';
    });
    /** The member a caller conversation runs as — its pool member, once known. */
    const agentNodeOfConversation = (caller: string): TeamMember | null => {
      const ran = conversationNodes.get(caller);
      if (ran !== undefined) {
        return ran;
      }
      return nodesById.get(callerNodeOf(caller)) ?? null;
    };
    // The broker gets a capability only when the team can call at all —
    // the MCP endpoint answers RUN_NOT_ACTIVE for call-free runs.
    if (calleesOf.size > 0) {
      // Mint one call token per call-capable caller member up front — the token
      // must exist before the caller turn spawns and reads its config (the
      // claude mcp-config file / the merged .cursor/mcp.json entry). A
      // probe-failed cursor caller gets no token: every admission surface
      // keys on the same callCapable predicate.
      for (const callerId of calleesOf.keys()) {
        const caller = nodesById.get(callerId);
        // ONCE per run, not per pass: a caller's process is kept between passes
        // and presents the token it spawned with, so a fresh one here would
        // lock a reused Manager out of its own team. Revoked by the teardown.
        // The idempotence lives in the registry (`ensure`) rather than in a
        // `get(...) === null` guard here, because the guard beside it is what
        // one of the two loops forgot.
        if (caller !== undefined && callCapable(caller)) {
          this.callTokens.ensure(runId, callerId);
        }
      }
      this.callBroker.registerRun(
        runId,
        {
          calleesOf,
          cwd,
          messageTargets: leadIds,
          launchCalleeTurn,
          persistItem: (memberId, kind, role, payload) => {
            enqueue(async () => {
              await persistItem(memberId, kind, role, payload);
            });
          },
          isCancelled: () => cancelRequested,
          isSuperseded: supersededByNextPass,
          conversationHoldsWork: (conversationId) =>
            this.sessions.holdsWorkFor(callSessionKey(runId, conversationId)),
          monitorsOwed: (caller) =>
            this.monitors?.isRunningFor(runId, caller) === true ||
            this.monitorOutputHeld(runId, caller),
          stopMonitors: (caller) =>
            this.monitors?.stopConversation(runId, caller, 'thread-stop'),
          callHeld: (caller) => this.notifyConversationTurnEnded(runId, caller),
          currentStage: () => {
            const loaded = this.stages?.cached(runId) ?? null;
            return loaded === null
              ? null
              : stageLabel(loaded.stages, loaded.progress);
          },
          unreadTeamNotes: (caller) =>
            this.teamNotes?.unreadCount(runId, {
              memberId: callerNodeOf(caller),
              conversationId: callerConversationOf(caller),
            }) ?? 0,
          toolCallDeadlineMs: (caller) => {
            const node = agentNodeOfConversation(caller);
            return node !== null
              ? this.adapterFor(node.agent).getConfig().mcp.toolCallDeadlineMs
              : null;
          },
          turnBlocked: noteTurnBlocked,
          cancelCalleeTurn: (callId) => {
            cancelledCalls.add(callId);
            queuedStarts.get(callId)?.abort();
            const subTurn = subTurns.get(callId);
            subTurn?.handle.cancel();
            return subTurn !== undefined;
          },
          messageCallee: (callId, text) => {
            const subTurn = subTurns.get(callId);
            if (
              subTurn === undefined ||
              cancelRequested ||
              cancelledCalls.has(callId)
            ) {
              return { delivered: false, reason: 'not_started' };
            }
            const { handle, callee, conversationId } = subTurn;
            const deliveryId = randomUUID();
            if (!handle.sendUserMessage({ text, images: [], deliveryId })) {
              return { delivered: false, reason: 'refused' };
            }
            brokerDeliveries.set(deliveryId, { callId, text });
            noteCallMessage(callId, text);
            // `deliverToCall`'s reason: a callee that is itself a caller may be
            // blocked waiting on ITS callees, and would read this only then.
            releaseWaitsFor(callee, conversationId);
            return {
              delivered: true,
              interrupts: this.adapterFor(callee.agent).getConfig().followUp
                .interrupts,
              deliveryId,
            };
          },
          // Per CONVERSATION: a member's callee turns say nothing about whether
          // its own conversation — or another call's — has a turn to answer in.
          isNodeLive: (caller) => liveConversations.has(caller),
          tellLiveNode: (caller, prompt, redeliver) => {
            const node = agentNodeOfConversation(caller);
            if (
              node === null ||
              cancelRequested ||
              runFinished ||
              !liveConversations.has(caller) ||
              this.adapterFor(node.agent).getConfig().followUp.interrupts
            ) {
              return false;
            }
            // Into the turn of THAT conversation — for a callee, the sub-turn
            // of the call it is answering, which the member-wide lookup this
            // replaced never reached, so a question for a working callee was
            // pushed nowhere and timed out.
            const deliveryId = randomUUID();
            const told =
              conversationHandle(caller)?.sendUserMessage({
                text: prompt,
                images: [],
                deliveryId,
              }) ?? false;
            if (told) {
              promptDeliveries.set(deliveryId, { caller, redeliver });
            }
            return told;
          },
          wakeNode: (caller, prompt) => {
            const memberId = callerNodeOf(caller);
            const node = nodesById.get(memberId);
            // A member's OWN conversation only: a callee conversation has no turn
            // outside the calls it answers, and the broker continues it as a
            // call instead (`CallBroker.startOwnerTurn`). Waking the MEMBER for it
            // would open the wrong conversation, in a process with none of the
            // call's context.
            if (callerConversationOf(caller) !== null) {
              return false;
            }
            // `runFinished` is NOT a refusal any more, and this is the other
            // half of `reopenRun`: callers are steered to call ASYNC, end the
            // turn and expect to be started again, so a Manager that dispatched
            // after waking would otherwise never be told its Engineer had
            // finished. The wake itself is decided below, where it can await.
            if (node === undefined || cancelRequested) {
              return false;
            }
            // Cancelled meanwhile — every callee dies with the run, so there
            // is nothing left for this turn to answer or collect — or a run
            // that refuses to wake: nothing to do.
            scheduleOwnTurn(memberId, caller, false, {
              onStopped: () => undefined,
              // A follow-up raced the wake and the conversation is working
              // again: hand it the message inside that turn rather than
              // opening a second one on it. Asked of the CONVERSATION: a member
              // "live" only through a callee turn has no handle here, and the
              // prompt its wake was already counted as told went nowhere.
              // A turn that drops it — or is already ending and refuses it —
              // has it woken for again once that turn has ended.
              onBusy: (rewake) => {
                const deliveryId = randomUUID();
                if (
                  conversationHandle(caller)?.sendUserMessage({
                    text: prompt,
                    images: [],
                    deliveryId,
                  })
                ) {
                  promptDeliveries.set(deliveryId, {
                    caller,
                    redeliver: rewake,
                  });
                } else {
                  redeliverWhenEnded(caller, rewake);
                }
              },
              start: () => {
                void continueNode(node, prompt, []);
              },
            });
            return true;
          },
        },
        // What an earlier pass of this run left in the transcript — null on the
        // first pass. Read at follow-up time, where the transcript is read for
        // the member sessions too.
        run.callSeed,
      );
      // Daemon-side self-check: a dead endpoint degrades SILENTLY child-side
      // (claude exits 0 with an unreachable server), so probe our own route
      // once at run start and leave a system item when it fails. Advisory —
      // callers still launch; they just run without working call tools.
      this.selfCheckCallEndpoint(
        [...calleesOf.keys()]
          .map((id) => nodesById.get(id))
          .find((n): n is TeamMember => n !== undefined && callCapable(n)) ??
          null,
        mcpEndpointFor,
        (message) => {
          enqueue(async () => {
            await persistItem(null, 'system', null, { message });
          });
        },
      );
    }

    // Ahead of the seed, because these are facts about the run's CONFIGURATION
    // rather than about anything an agent did: a member named a setting its CLI
    // cannot honour. The value is dropped either way (see
    // `withResolvedNodeSettings`) — this is what stops the drop being silent
    // for a team that arrived as YAML, where the team editor never had the
    // chance to refuse the field.
    for (const setting of dropped) {
      enqueue(async () => {
        await persistItem(null, 'system', null, {
          message:
            `'${setting.name}' names ${setting.setting} (${setting.value}) ` +
            `that will be ignored: ${setting.reason}`,
        });
      });
    }
    // Seed message first, then the trigger member starts — unless this pass carries a
    // follow-up, whose row the route has already written.
    if (!run.seedPersisted) {
      enqueue(async () => {
        await persistItem(
          null,
          'message',
          'user',
          messagePayload(seedPrompt, run.seedAttachments),
        );
      });
    }
    liveControl = {
      deliver: deliverFollowUp,
      deliverToCall,
      joinThreadMessage,
      pinPoolMember: (memberId, member, row) =>
        new Promise((resolve, reject) => {
          enqueue(async () => {
            try {
              if (liveConversations.has(memberId)) {
                resolve('busy');
                return;
              }
              const from = nodePoolMembers.get(memberId) ?? 1;
              const moved = member !== from;
              if (!moved && nodePoolPins.has(memberId)) {
                resolve('unchanged');
                return;
              }
              const previousSessionId = moved
                ? (nodeSessionIds.get(memberId) ??
                  resumeSessions.get(memberId) ??
                  null)
                : null;
              if (moved) {
                const sessionKey = nodeSessionKey(runId, memberId);
                this.sessions.retire(
                  sessionKey,
                  'the user moved its conversation to another pool member',
                );
                this.compactionBaselines.delete(sessionKey);
                nodeSessionIds.delete(memberId);
                resumeSessions.delete(memberId);
                nodeWindows.delete(memberId);
                nodePoolMembers.set(memberId, member);
                nodePoolExcerpts.add(memberId);
                await this.nodeStateDao.clearConversation(runId, memberId, em);
              }
              nodePoolPins.add(memberId);
              await persistItem(
                memberId,
                'system',
                null,
                row(from, previousSessionId, moved),
              );
              resolve('now');
            } catch (err) {
              reject(err);
            }
          });
        }),
    };
    this.liveRuns.set(runId, liveControl);
    schedule();
  }

  /**
   * Probe the run's own MCP route with a JSON-RPC initialize (3s cap) and
   * report a failure through `onFailure`. Fire-and-forget: the pass never
   * waits on it. No call-capable caller → nothing to check.
   */
  private selfCheckCallEndpoint(
    caller: TeamMember | null,
    mcpEndpointFor: (node: TeamMember) => { url: string; token: string } | null,
    onFailure: (message: string) => void,
  ): void {
    if (!caller) {
      return;
    }
    const endpoint = mcpEndpointFor(caller);
    if (!endpoint) {
      onFailure(
        'agent-call endpoint unavailable (no bound port or call token) — callers run without call tools',
      );
      return;
    }
    void (async () => {
      try {
        const res = await fetch(endpoint.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            authorization: `Bearer ${endpoint.token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 0,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'geniro-selfcheck', version: '0' },
            },
          }),
          signal: AbortSignal.timeout(3000),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        onFailure(
          `agent-call endpoint self-check failed (${err instanceof Error ? err.message : String(err)}) — callers may run without call tools`,
        );
      }
    })();
  }

  private async persist(
    em: EntityManager,
    runId: string,
    memberId: string | null,
    seq: number,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
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
}

/** Who leads: the trigger's member in `lead` mode, else the stage lead the progress names or the starting lead. */
function leadIn(
  team: Team,
  stageLead: string | null | undefined,
): string | null {
  if (team.mode !== 'relay') {
    return triggerMemberId(team);
  }
  return stageLead ?? startingLeadOf(team);
}
