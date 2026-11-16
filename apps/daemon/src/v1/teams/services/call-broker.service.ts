import { randomUUID } from 'node:crypto';

import { Injectable, type OnModuleInit, Optional } from '@nestjs/common';

import { awakeTimeout, type AwakeTimer } from '../../../utils/sleep-watch';
import type {
  CallResultPayload,
  CallStartedPayload,
  HostRowWire,
  MessageDeliveryFailure,
  PersistedResetWake,
  RunCallSeed,
} from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { callIdOf, callNumber } from '../../agents/utils/call-seed';
import type {
  CalleePoolPlan,
  CalleeTurnOutcome,
  CallEnvelope,
  CallHoldRelease,
  CallMode,
  CallPublishedAction,
  CallPublishedPage,
  CallSettledResult,
  ParkQuestionInput,
  PoolSkipWire,
  ResetWakeHooks,
  RunCallCapability,
  TeamMember,
} from '../teams.types';
import {
  conversationStartMember,
  poolAttempts,
  poolMemberNode,
  poolSize,
  preferredAttemptOrder,
} from '../utils/agent-pool';
import { calleeFailedEnvelopeError } from '../utils/callee-failure';
import {
  PUBLISHED_ACTIONS_NOTE,
  PUBLISHED_PAGES_NOTE,
  quotedCommand,
} from '../utils/callee-text';
import {
  callerConversationOf,
  callerKey,
  callerNodeOf,
} from '../utils/caller-key';
import {
  COLD_RESUME_RULE,
  type ConversationCacheFacts,
  conversationContextPercent,
  conversationFacts,
  isColdAndLarge,
  type PromptCacheStanding,
  promptCacheStanding,
  statedPercent,
} from '../utils/prompt-cache-standing';
import { resetInstantFrom } from '../utils/reset-instant';
import { resetWakePrompt } from '../utils/reset-wake-prompt';
import { PoolCooldowns, type PoolSite } from './pool-cooldowns.store';

/** The run has no live call surface — reused by call_agent and await_agent. */
const RUN_NOT_ACTIVE: CallEnvelope = {
  status: 'error',
  error: 'RUN_NOT_ACTIVE: this run is not accepting agent calls',
};

/**
 * Call-chain depth cap: a member a pass started sits at depth 0, its callee at
 * 1, a call made BY that callee lands at 2… — 3 keeps A→B→C legal while
 * braking runaway mutual-call loops. There is deliberately NO cap on how many
 * calls a run makes in total: a long-lived team's coordinator works by
 * calling, and a count-per-pass cap ran a Manager out of calls mid-task while
 * never more than the run's active-turn cap were live at once.
 */
const MAX_CALL_DEPTH = 3;

/**
 * How long a parked question may wait for answer_agent before the call fails
 * with QUESTION_TIMEOUT. Generous by design — the caller may be escalating to
 * a human through its own question card, or be deep in a long turn of its own
 * before it reaches the question. It was five minutes, which a caller busy
 * with other work routinely outlived.
 */
const QUESTION_TTL_MS = 30 * 60_000;

/**
 * How long a call may go with the callee producing NOTHING before the caller's
 * transcript says so.
 *
 * Bounded by SILENCE rather than by total duration, mirroring
 * `agents/utils/spawn-cli.ts`'s `TURN_SILENCE_DEADLINE_MS`: an agent turn
 * legitimately runs for many minutes, so a duration cap would abort real work,
 * while a callee that has emitted nothing at all for this long has either
 * wedged or is waiting on something nobody can see.
 *
 * It SURFACES and never settles the call — the wait continues untouched. A
 * sync call has no deadline; the one abandonment it notices is its HTTP
 * request going away, which ends only the reply and never cancels the callee. What was missing was never the ability to stop a call; it was
 * any way to tell that one had stopped producing.
 *
 * It is SUSPENDED while the callee is blocked on an approval card
 * ({@link ActiveCall.blockedOnVerdicts}), the same carve-out `spawn-cli.ts`
 * makes: a callee waiting on a person emits nothing by construction, so
 * without it the window would time the human and report a callee that is
 * doing exactly what it should.
 *
 * It counts AWAKE time only ({@link awakeTimeout}), like the turn deadline it
 * mirrors: node's timers count through a macOS sleep, so a window that ran out
 * while the lid was shut would otherwise report every open call as stalled
 * the moment the machine woke.
 */
const CALL_SILENCE_DEADLINE_MS = 10 * 60_000;

/**
 * A collection whose REQUEST went away before the callee settled.
 *
 * A sentinel rather than an error envelope, because the difference has to
 * survive the return: an envelope would be indistinguishable from an outcome
 * the caller is owed, and it is precisely the "nobody is there to receive
 * this" reading that must stop the entry being consumed.
 */
const ABANDONED = Symbol('await-abandoned');

/**
 * A collection whose own `timeout_ms` elapsed with the callee still working.
 *
 * A sentinel for {@link ABANDONED}'s reason — the difference between "still
 * running" and an outcome must survive the return, and it is what stops the
 * entry being consumed. The two are kept APART rather than folded into one
 * "did not collect" because they mean opposite things to the caller: an
 * abandonment says nobody was there to receive the answer, while this says the
 * caller deliberately stopped waiting and means to come back.
 */
const TIMED_OUT = Symbol('await-timed-out');

/**
 * A wait released because the USER wrote to the waiting caller — see
 * {@link CallBroker.interruptWaits}. A sentinel on {@link TIMED_OUT}'s terms:
 * nothing is consumed and every call stays collectable; only what the caller
 * is told differs.
 */
const INTERRUPTED = Symbol('await-interrupted');

/**
 * The share of a caller CLI's tool-call deadline (`AdapterConfig.mcp.
 * toolCallDeadlineMs`) one wait may take; the rest is margin for the answer to
 * travel back before the client gives up on the request carrying it.
 *
 * A wait that outlives that deadline is worse than a short one: the model is
 * handed the CLI's own timeout error, while this side still holds a waiter for
 * a reply nobody will read — a question parked meanwhile was handed to it,
 * marked delivered and failed QUESTION_TIMEOUT unseen. 0.8 of claude's 300s is
 * the 240s `MAX_AWAIT_TIMEOUT_MS` already measured safe; of cursor's 60s, 48s.
 */
const WAIT_CEILING_FRACTION = 0.8;

/**
 * The title of the call that picks a callee back up in its own conversation
 * when calls it made come back after its own call ended — see
 * `CallBroker.startOwnerTurn`. Shown on that call's card, under the caller it
 * is made for, which did not ask for it: this says why it exists.
 */
const PICKED_BACK_UP_TITLE =
  'Picked back up — calls it made came back after its own call ended';

/** What a SYNC caller whose call outlasted its wait ceiling is told. */
function syncOutlastedNote(callId: string): string {
  return (
    `This call is still running — it outlasted how long one tool call can stay open for you, so it continues as an async call. ` +
    `Nothing was cancelled: keep working or end your turn, and collect it with await_agent(call_id: '${callId}').`
  );
}

/** What a caller released by {@link INTERRUPTED} is told to do next. */
const USER_MESSAGE_NOTE =
  'A message reached you while you were waiting, from the user or from another thread, and it says which — it is delivered right after this result. ' +
  'Read it and respond to it first. Your calls are untouched and still running: collect them with await_agent afterwards ' +
  '(if you have already answered that message, simply wait again).';

interface AsyncCallEntry {
  /**
   * The caller that started the call — only it may collect the result. A
   * caller KEY (`utils/caller-key.ts`): a member in one conversation, never a
   * member across all of them.
   */
  owner: string;
  /**
   * The callee this call went to, so a {@link TIMED_OUT} collection can NAME it
   * without reaching into `activeCalls` — which a settled-but-uncollected call
   * has already left, and where a lookup would therefore have to fall back to a
   * blank agent on exactly the arm whose whole content is "who is still busy".
   */
  calleeId: string;
  settled: Promise<CallEnvelope>;
  /**
   * Whether the caller has been WOKEN to collect this result — once per call,
   * for the reason {@link ParkedQuestion.ownerTold} is once per question.
   */
  told: boolean;
}

/** Lets a wait that gave up (timed out, abandoned) stop listening for questions. */
interface WaitLease {
  release: () => void;
}

/** A parked mid-turn question — the callee is blocked on answer_agent. */
interface ParkedQuestion {
  question: string;
  options: string[];
  /**
   * The TTL clock — or null while it is SUSPENDED because the caller that
   * has to answer is itself blocked on a card of its own
   * ({@link RunCallState.blockedOwners}). A caller inside its own
   * AskUserQuestion cannot call answer_agent, so a window that kept running
   * timed the person reading the caller's card and failed the callee for it:
   * measured on a real run, both QUESTION_TIMEOUTs fired inside the Manager's
   * own question to the user (answered after 33 minutes, and after 12 hours).
   * Re-armed, with its full window, the moment that card is answered.
   */
  timer: AwakeTimer | null;
  /**
   * The window this question was parked with, kept so a re-arm uses the SAME
   * one — the executor's capture seam may name its own, and re-arming with the
   * module constant instead would silently give a test-scale TTL a
   * five-minute one.
   */
  ttlMs: number;
  deliver(answer: string): boolean;
  fail(): void;
  /**
   * Whether the caller has already been WOKEN with this question. A caller
   * that ends again without answering is not woken a second time — which is
   * what keeps one that keeps ending its turn from looping on one question.
   */
  ownerTold: boolean;
  /**
   * Whether a `question` envelope for it has been RETURNED to the caller — by
   * the wait it diverted, or by a wait that started after it parked. Once is
   * enough: a caller that reads the question and waits again is choosing to,
   * and handing it back on every await would keep that wait from ever starting.
   */
  envelopeDelivered: boolean;
}

interface ActiveCall {
  calleeId: string;
  /** The caller that started the call — only it may answer or collect. A caller key. */
  owner: string;
  depth: number;
  /** Fire-and-forget calls orphan their questions — nobody ever collects. */
  mode: CallMode;
  /** The FINAL envelope (call_result persisted) — never a question. */
  settled: Promise<CallEnvelope>;
  parked: ParkedQuestion | null;
  /**
   * Sync/await waiters diverted early when a question parks mid-wait. Each
   * answers whether it was still waiting — a settled wait leaves its entry
   * behind, and a delivery to it reaches nobody.
   */
  questionWaiters: ((envelope: CallEnvelope) => boolean)[];
  /**
   * Set BEFORE fail() cancels a parked turn (TTL / orphan drain) so the final
   * envelope carries the typed error instead of a generic CALLEE_CANCELLED.
   *
   * It replaces a FAILED or CANCELLED ending only. A turn that completed did the
   * work however the stop raced it, and the caller is owed that work — see
   * {@link turnEnded} for the window in which that race is usually lost.
   */
  failReason: string | null;
  /**
   * The callee's turn has ENDED — its result exists — while the executor still
   * holds the call open for the turn's bookkeeping: draining its rows, closing
   * what it left out, and possibly a whole automatic COMPACTION turn.
   *
   * `cancel_agent` in that window must not answer `cancelling` and stamp its
   * reason over the finished result, or the caller collects CALLEE_CANCELLED
   * instead of the work it has already paid for. Set by the executor
   * ({@link CallBroker.noteCalleeTurnEnded}) the moment the turn's handle
   * settles; a cancel arriving after it stops nothing and says so.
   */
  turnEnded: boolean;
  /**
   * The silence watchdog — re-armed by every row the callee produces, cleared
   * when the call settles. See {@link CALL_SILENCE_DEADLINE_MS}.
   */
  silence: AwakeTimer | null;
  /**
   * message_agent messages the callee could not take YET, oldest first — see
   * {@link PENDING_MESSAGE_RETRY_MS}. Delivered in order by
   * {@link messageRetry}; whatever is left when the call settles is recorded
   * as undelivered.
   */
  pendingMessages: string[];
  /** Messages in a held wake's prompt, awaiting evidence that the CLI took it. */
  wakingMessages: string[];
  messageRetry: NodeJS.Timeout | null;
  /**
   * Whether the transcript has ALREADY been told this call went quiet.
   *
   * One row per call, not one per silent stretch: the watchdog re-arms on the
   * callee's next row, and a call that goes quiet repeatedly would otherwise
   * write an advisory every ten minutes into the conversation it is warning
   * about.
   */
  saidStalled: boolean;
  /**
   * How many verdicts this callee is blocked on — approval cards raised for it
   * and not yet answered.
   *
   * The silence watchdog is SUSPENDED while this is non-zero, mirroring
   * `spawn-cli.ts`'s own deadline, which stands down while a turn has
   * outstanding requests. A callee parked on a card emits nothing by
   * construction, so timing it would be timing the person looking at the card
   * — and "has produced nothing" is then true and useless.
   *
   * A COUNT rather than a flag: a turn can have several cards open at once,
   * and the wait is over only when the last of them is answered.
   */
  blockedOnVerdicts: number;
  /**
   * Waiting for room under the run's active-turn cap: no turn has started, so
   * there is nothing whose silence to time. The watchdog is suspended until
   * the call leaves the queue ({@link CallBroker.noteCalleeQueued}).
   */
  queued: boolean;
  /**
   * The tool calls this callee has started and not yet had answered, by id.
   *
   * The silence watchdog is SUSPENDED while any is open: a callee waiting on
   * its own tool is working, however long the tool takes and whether or not it
   * writes anything meanwhile. REPORTED as "'qa' has produced nothing for 10
   * minutes" over a QA agent that had launched ten reviewer sub-agents as
   * `Task` tool calls — their results arrived at 16:39 and 16:50, and a cursor
   * delegate puts nothing on the wire in between. A SET rather than a count, so
   * a tool call announced twice is one open call.
   */
  openToolCalls: Set<string>;
  /**
   * The conversation this call runs in — see {@link ThreadRecord.conversationId}.
   * What a thread continuation is checked against: one conversation serves one
   * call at a time.
   */
  conversationId: string;
  /**
   * Set while the call is HELD ({@link CallBroker.holdCall}): its callee's turn
   * ended while calls it made from inside it are still running, so the call
   * waits for them rather than settling on an answer that is not its last.
   * `release` hands the executor what to do next.
   */
  hold: { release: (release: CallHoldRelease) => void } | null;
  /**
   * The call its OWNER was answering when it made this one, or null for a call
   * made from a member's own conversation. A conversation outlives its calls — a
   * `thread:` continuation is a later call of it — so this, not the owner key,
   * is what says which call's cancel this one goes down with.
   */
  madeIn: string | null;
  /**
   * Whether this call has ever been held. Its hold took over every open call
   * of its conversation, and a cancel must keep stopping those through the
   * wake turns that follow — see `cancelSubCalls`.
   */
  everHeld: boolean;
  /**
   * Whether the call still owed work — a call of its own running, a result it
   * was not woken for, a promised continue — when a cancel was accepted for
   * it. Read when its turn's ending is written: the cancel's own cascade
   * silences that work, so asking again then would find nothing owed and hand
   * the caller a partial answer as completed.
   */
  cancelledOwing: boolean;
  /**
   * How many calls the transcript last said this HELD call waits for, so the
   * card's count follows them down as they finish — written again only when
   * it changes.
   */
  reportedWaitingOn: number;
  /**
   * The pages published while this call ran — by its callee, or inside any
   * call made under it — keyed by artifact id. Named in its envelope
   * ({@link withPublished}).
   */
  published: Map<string, CallPublishedPage>;
  /**
   * The buttons published while this call ran, on the same terms as
   * {@link published}, keyed by the publisher's action key (two conversations
   * may each publish an id) and dropped again when removed.
   */
  publishedActions: Map<string, CallPublishedAction>;
}

/**
 * One settled call's conversation handle: `call_agent` with
 * `thread: <call_id>` resumes this record's callee CLI session, continuing
 * the conversation instead of starting fresh. Retained for the run's whole
 * life (bounded by the per-run turn cap) so any earlier point of a
 * conversation can be continued.
 */
interface ThreadRecord {
  /** The caller that made the call — only it may continue the thread. A caller key. */
  owner: string;
  calleeId: string;
  /** The resumable CLI session; null = the turn recorded none. */
  sessionId: string | null;
  /**
   * The FIRST call of this conversation — the id every continuation of it
   * is keyed by, however many calls deep it is.
   *
   * A continuation used to be keyed by its OWN call id, so the executor spawned
   * a fresh `--resume <session>` process for it while the previous call's
   * process was still kept alive under the previous id: two live CLI processes
   * on one session, each holding the conversation, each free to act. Measured
   * on a real run — an Engineer found two `claude -p --resume 43bb7bb7…`
   * children of the daemon editing its worktree at once, then three. Keyed by
   * the conversation, a continuation reaches the kept process (or resumes the
   * session in a fresh one only once that process is gone).
   */
  conversationId: string;
  /**
   * The callee POOL member (1-based) the session belongs to — 1 for a callee
   * with no pool. A continuation runs on it again: a CLI session cannot move
   * to another CLI or account.
   */
  member: number;
  /**
   * The pool member the caller last asked for by name (`member`), in this call
   * or one it continued, or null: the conversation starts there while it is
   * available and goes back to it once it is again.
   */
  preferredMember: number | null;
  /**
   * The call its owner was answering when it made this one
   * (`ActiveCall.madeIn`) — what a cancel of that call silences once this one
   * has settled. Absent on a record read back after a restart: such a result
   * is left alone.
   */
  madeIn?: string | null;
  /**
   * What this call left behind about its conversation's prompt cache — read
   * by {@link CallBroker.listThreads} and by the cold-resume refusal.
   */
  cache: ConversationCacheFacts;
}

interface RunCallState {
  /** The run this state belongs to — what a clock re-armed from a helper names. */
  runId: string;
  capability: RunCallCapability;
  callSeq: number;
  /** Live callee turns keyed by call id. */
  activeCalls: Map<string, ActiveCall>;
  /** Results retained until their caller collects them via await_agent. */
  pendingAsync: Map<string, AsyncCallEntry>;
  messageFailures: Map<string, MessageDeliveryFailure>;
  /** Settled calls' resume handles keyed by call id (thread continuation). */
  threads: Map<string, ThreadRecord>;
  /**
   * The call each SETTLED call was made in, however it settled — what a page
   * published under a call that already ended walks up through. `threads`
   * cannot serve: a call whose launch threw leaves no thread record.
   */
  settledMadeIn: Map<string, string | null>;
  /**
   * Each callee conversation's newest call, recorded when the call opens —
   * where a page or button its callee publishes after that call settled is
   * named from ({@link CallBroker.callToNoteOn}). Kept apart from `threads`
   * for `settledMadeIn`'s reason.
   */
  newestCallOf: Map<string, string>;
  /**
   * The highest call number an EARLIER daemon gave this run — what
   * {@link RunCallSeed} carried in. An id at or below it that no map holds is
   * a call whose result died with that daemon, and the refusal says so.
   */
  seededCallSeq: number;
  /**
   * What each caller is blocked on right now, as a set of names (caller key →
   * blockers) — the owner-side twin of {@link ActiveCall.blockedOnVerdicts}.
   * Per CONVERSATION: a card up in one of a member's conversations blocks the
   * questions put to that conversation, not to the member's others.
   * While a member holds any, every question ITS callees park has its TTL
   * suspended: see {@link ParkedQuestion.timer}.
   *
   * Two kinds of blocker, because a member can be stuck two ways: a CARD it
   * raised (its own question to the user, a permission in ask mode), named by
   * the executor; and a question it PARKED on its own caller, named here
   * ({@link parkBlocker}). A callee that is itself a caller — Manager →
   * Engineer → Researcher — cannot answer Researcher while it waits on Manager.
   *
   * A SET rather than a count: spawn-cli re-offers a request its turn settled
   * without an answer to the next turn of the same process, so one card can
   * arrive twice, and a count then needed two answers to that one card before
   * the member's callees' questions resumed.
   */
  blockedOwners: Map<string, Set<string>>;
  /**
   * How many waits each caller currently has OPEN on its own calls (caller key
   * → count) — a sync `call_agent`, an `await_agent` for one call, an
   * `await_agent` for all of them.
   *
   * A member in here is inside a tool call that cannot return until a callee it
   * started does: it is in a turn by every reading the daemon has, and it is
   * producing nothing. That is what the composer needs to know before it
   * queues a message — see {@link RunStatusEvent.awaitingCalls}, which this
   * map's SIZE is announced as.
   *
   * A COUNT per member rather than a flag, on {@link blockedOwners}' reasoning
   * one step over: a caller can hold a sync call open and start a collection
   * beside it, and the member stops waiting only when the last of them returns.
   */
  waitingOwners: Map<string, number>;
  /**
   * Conversations last reported BLOCKED to the executor
   * ({@link RunCallCapability.turnBlocked}): inside a wait on their own calls
   * ({@link waitingOwners}) or held by a blocker ({@link blockedOwners}). Kept
   * so only a change is reported.
   */
  reportedBlocked: Set<string>;
  /**
   * The release of every wait each caller has open right now (caller key → one
   * resolver per wait) — what {@link CallBroker.interruptWaits} calls.
   */
  waitReleases: Map<string, Set<() => void>>;
  /**
   * Owners in the GAP after their last wait returned (caller key → the timer
   * that ends it, {@link AWAIT_GAP_GRACE_MS}). Counted in `awaitingCalls`
   * beside {@link waitingOwners}, but never read as "inside a wait".
   */
  waitGaps: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * Nodes the user wrote to while they had NO wait open, and whose CLI has not
   * yet said it took the message. The CLI takes a mid-turn message at its next
   * tool boundary, so a caller that goes on to start a wait would sit on the
   * message for the whole of it: the next wait it starts returns at once
   * instead. Cleared when the CLI reports the message consumed or the member's
   * turn ends ({@link CallBroker.forgetUserMessage}).
   */
  unreadUserMessages: Set<string>;
  /**
   * Callee conversations whose drain is waiting for the call they answer to
   * settle (`CallBroker.drainCaller`) — so one is waited for once.
   */
  deferredDrains: Set<string>;
  /**
   * Calls a usage limit failed, waiting for the window to reopen — keyed by the
   * instant it does, so several calls stopped by one limit wake their caller
   * ONCE. See {@link CallBroker.scheduleResetWake}.
   */
  resetWakes: Map<number, ResetWake>;
  /**
   * Resets that FIRED while their owner's conversation had a call not yet
   * free to be continued, keyed by that owner: delivered when the call is
   * HELD (inside it) or settles, whichever comes first. Owed work while
   * pending, so a call ending meanwhile holds for it rather than settling.
   */
  pendingResetDeliveries: Map<string, PendingResetDelivery[]>;
}

/** A fired reset waiting for its owner's conversation — see `pendingResetDeliveries`. */
interface PendingResetDelivery {
  calls: readonly WakeResult[];
  resetsAt: string;
  instant: number;
}

/** A question a woken caller is being told about. */
interface WakeQuestion {
  callId: string;
  /** The callee, by the name the caller knows it by. */
  callee: string;
  question: string;
  options: readonly string[];
}

/** A result a woken caller is being told to collect. */
interface WakeResult {
  callId: string;
  callee: string;
}

/** One caller's calls a single usage-limit reset will reopen. */
interface ResetWake {
  timer: ReturnType<typeof setTimeout>;
  /** Owner member → the calls of its that limit stopped, with their callees. */
  owners: Map<string, WakeResult[]>;
  /** The CLI's own words for when, verbatim — what the caller is told. */
  resetsAt: string;
  /** When the continue is made — the reset plus the grace, epoch ms. */
  continuesAt: number;
}

/** A wake as the run row keeps it — see `PersistedResetWake`. */
function persistedWake(instant: number, wake: ResetWake): PersistedResetWake {
  return {
    instant,
    continuesAt: wake.continuesAt,
    resetsAt: wake.resetsAt,
    owners: [...wake.owners].map(([owner, calls]) => ({
      owner,
      calls: calls.map((call) => ({ ...call })),
    })),
  };
}

/**
 * How long past the stated reset the caller is woken. The CLI states the
 * reset to the minute, and a turn begun a few seconds early is refused again.
 */
const RESET_WAKE_GRACE_MS = 60_000;

/**
 * How often a message_agent message the callee could not take yet is offered
 * again.
 *
 * A caller steers most often right after it dispatches, and that is exactly
 * when the callee cannot take a message: its sub-turn may still be queued on
 * the pool, and a claude turn holds its OWN prompt until the CLI's MCP servers
 * have dialled (up to 15s), refusing every follow-up meanwhile so one cannot
 * overtake the prompt it follows. MEASURED in the running app: a Manager
 * steering 2s after `call_agent` was answered MESSAGE_REFUSED, and its worker
 * ran the whole wrong task. So the message is held on the call and offered
 * again until it lands or the call ends — the caller is told it is queued.
 */
const PENDING_MESSAGE_RETRY_MS = 500;

/**
 * How long a message target still counts as waiting after a wait on its calls
 * returns — the gap in which a manager reads the result (or a `pending`) and
 * starts its next wait. A message typed in that gap goes straight in rather
 * than into the queue (the user's choice: a manager polling its callees is not
 * busy). Ended early by the agent writing its reply
 * ({@link CallBroker.noteOwnerReplying}), taking a message or ending its turn
 * ({@link CallBroker.forgetUserMessage}); a wait a user message released or
 * the CLI abandoned opens none. The twin of `CODEX_WAIT_GAP_GRACE_MS`.
 */
export const AWAIT_GAP_GRACE_MS = 15_000;

/**
 * The furthest ahead a reset is waited for. A monthly spend limit can name a
 * date weeks out, and a timer that long outlives any run anybody is watching —
 * past this the caller keeps the envelope's sentence and the user decides.
 */
const MAX_RESET_WAIT_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The message a woken caller receives. Written to the AGENT, since it opens a
 * turn of that agent's own conversation, and naming the exact tool call that
 * settles each item so nothing about what to do next has to be inferred.
 */
function wakePrompt(
  asked: readonly WakeQuestion[],
  finished: readonly WakeResult[],
  whileWorking = false,
  /** {@link unreadTeamNotesLine}, said last. */
  unreadLine: string | null = null,
): string {
  const lines = [
    whileWorking
      ? '[geniro] A call of yours needs you while you work:'
      : '[geniro] Your previous turn ended with calls of yours still open:',
  ];
  for (const item of asked) {
    const options =
      item.options.length > 0 ? ` (options: ${item.options.join(' / ')})` : '';
    lines.push(
      '',
      `- ${item.callee} is blocked on a question in ${item.callId}: "${item.question}"${options}`,
      `  Answer it with answer_agent(call_id: "${item.callId}", answer: ...) — or, if it is the user's decision rather than yours, ask the user first — then collect the result with await_agent(call_id: "${item.callId}").`,
    );
  }
  for (const item of finished) {
    lines.push(
      '',
      `- ${item.callee} has finished ${item.callId}. Collect its result with await_agent(call_id: "${item.callId}") and carry on from there.`,
    );
  }
  if (unreadLine !== null) {
    lines.push('', unreadLine);
  }
  return lines.join('\n');
}

/**
 * The line a wake carries when the woken conversation has team notes it has
 * not read, or null when it has none.
 */
function unreadTeamNotesLine(unread: number): string | null {
  return unread > 0
    ? `[geniro] ${unread} team ${unread === 1 ? 'note' : 'notes'} by other agents of this run ${unread === 1 ? 'is' : 'are'} unread — read them with team_notes before you change anything they may cover.`
    : null;
}

/**
 * The message a HELD call's callee is continued with, inside that same call.
 *
 * {@link wakePrompt}'s items, plus the two facts a callee cannot know without
 * being told: that its caller is still waiting on THIS call, so the answer it
 * now writes is the call's result — and that ending its turn while calls of
 * its own still run does not hand that result over.
 */
function heldWake(
  asked: readonly WakeQuestion[],
  finished: readonly WakeResult[],
  stillRunning: number,
  /** Said first instead of `wakePrompt`'s items — a reset wake's own news. */
  lead: string | null = null,
  /** {@link unreadTeamNotesLine}, said after the calls still running. */
  unreadLine: string | null = null,
): CallHoldRelease {
  const lines = [lead ?? wakePrompt(asked, finished)];
  if (stillRunning > 0) {
    lines.push(
      '',
      `${stillRunning} other call(s) of yours are still running — you are continued here again when they finish or ask.`,
    );
  }
  if (unreadLine !== null) {
    lines.push('', unreadLine);
  }
  return { kind: 'wake', prompt: lines.join('\n'), note: HELD_RESULT_NOTE };
}

/** Said last in every wake of a held call — see `CallHoldRelease`. */
const HELD_RESULT_NOTE =
  "[geniro] You are still answering your caller's call: it stays open until the calls you made have finished. " +
  'The reply you end this turn with is the result your caller receives — write it in full, as the answer to the task you were given, not as a reply to this message. ' +
  'If you start more calls and end your turn while they run, you are continued here again when they finish.';

/** Said last in a held callee's monitor wake — see `CallHoldRelease`. */
const HELD_MONITOR_NOTE =
  "[geniro] You are still answering your caller's call: it stays open while your monitors run. " +
  'The reply you end this turn with is the result your caller receives — write it in full, as the answer to the task you were given, not as a reply to this message. ' +
  'If a monitor is still running when you end this turn, you are continued here again with its output; stop one you no longer need with stop_monitor.';

/**
 * The transcript's account of a wake, filed under the caller that was woken.
 *
 * Without it the caller would start talking again unprompted. `wake` names the
 * calls so the renderer can draw a divider that opens their cards; `message` is
 * the same fact as a sentence for every reader that shows plain text.
 *
 * TWIN PARSER: read by the renderer's `readWakeNotice` in
 * `apps/ui/src/renderer/chats/wake-payload.ts`.
 */
function wakeNotice(
  asked: readonly WakeQuestion[],
  finished: readonly WakeResult[],
): {
  message: string;
  wake: { callId: string; callee: string; reason: 'asked' | 'finished' }[];
} {
  const wake = [
    ...asked.map((item) => ({
      callId: item.callId,
      callee: item.callee,
      reason: 'asked' as const,
    })),
    ...finished.map((item) => ({
      callId: item.callId,
      callee: item.callee,
      reason: 'finished' as const,
    })),
  ];
  const reasons = wake.map((item) =>
    item.reason === 'asked'
      ? `${item.callee} asked a question in ${item.callId}`
      : `${item.callee} finished ${item.callId}`,
  );
  return { message: `Picked back up — ${reasons.join('; ')}.`, wake };
}

/**
 * Agent-to-agent call semantics over the executor's capability seam: call
 * ids, the depth and total-turns caps, sync waiting, async + await_agent
 * collection, fire-and-forget, and the Q&A bridge's parked-question
 * lifecycle (park → answer_agent / TTL / orphan drain). One instance serves
 * every run; state is per-run and dies with `unregisterRun` (in-memory only —
 * a call never outlives its run). Modeled on ApprovalRegistry's pending
 * round-trip.
 */
@Injectable()
export class CallBroker implements OnModuleInit {
  private readonly runs = new Map<string, RunCallState>();

  /**
   * Which pool members are spent, for every run. The executor records every
   * attempt into it — a call's as well as a member's own turn — and reads it for
   * member turns; the broker only reads it, to pick a new call's first member.
   */
  readonly poolCooldowns: PoolCooldowns;

  /**
   * Promised continues read back off run rows at boot, for runs no pass has
   * registered since — adopted by the run's next `registerRun`, and otherwise
   * delivered through {@link ResetWakeHooks.wakeRestoredRun} when they fire.
   */
  private readonly restoredWakes = new Map<string, Map<number, ResetWake>>();

  /** Null until the executor installs them — then a promise survives a restart. */
  private resetWakeHooks: ResetWakeHooks | null = null;

  /**
   * `@Optional()` on the bus, exactly as `AgentEventBus` itself takes its
   * registry: a dozen specs build a bare `new CallBroker()` to drive call
   * semantics, and none of them is about run deletion. Without one the
   * subscription below simply never happens — which is the pre-existing
   * behaviour rather than a degraded one.
   */
  constructor(
    @Optional() private readonly bus?: AgentEventBus,
    @Optional() poolCooldowns?: PoolCooldowns,
  ) {
    this.poolCooldowns = poolCooldowns ?? new PoolCooldowns();
  }

  /**
   * Drop a run's call state when the run itself is DESTROYED.
   *
   * The executor already unregisters on its own delete, so this is the second
   * belt — and the one that covers a purge it never sees. The retention sweep
   * destroys an archived run through `ChatService`, which sits in the module
   * BELOW this one and cannot call into it; announcing the deletion downward is
   * the inversion `AgentEventBus.publishRunDeleted` exists for, and it says so
   * at its own definition. Without this, a swept team run left its capability,
   * its uncollected async results and any parked question's timer behind for the
   * life of the daemon.
   *
   * Idempotent, which is what makes two callers safe: `unregisterRun` on a run
   * it has never heard of clears nothing and throws nothing.
   */
  onModuleInit(): void {
    this.bus?.allDeleted().subscribe((runId) => {
      this.unregisterRun(runId);
    });
  }

  /**
   * The executor announces a run whose members can call each other.
   *
   * `seed` is what an earlier pass of this run left in the transcript — see
   * {@link RunCallSeed}. Call ids continue past it, and every settled call it
   * names is a thread again, so a conversation built before a daemon restart
   * can be continued after it. A continuation's conversation is rebuilt
   * through the parent chain, in transcript order, so two points of one old
   * conversation still share a key rather than each resuming the session in a
   * process of its own.
   */
  registerRun(
    runId: string,
    capability: RunCallCapability,
    seed: RunCallSeed | null = null,
  ): void {
    const threads = new Map<string, ThreadRecord>();
    for (const record of seed?.records ?? []) {
      threads.set(record.callId, {
        owner: callerKey(
          record.callerMemberId,
          record.callerConversationId ?? null,
        ),
        calleeId: record.calleeMemberId,
        sessionId: record.sessionId,
        conversationId:
          (record.thread === null
            ? null
            : threads.get(record.thread)?.conversationId) ?? record.callId,
        member: record.member ?? 1,
        preferredMember: record.preferredMember ?? null,
        cache: {
          endedAt: record.endedAt ?? null,
          promptCacheTtlMs: record.promptCacheTtlMs ?? null,
          contextTokens: record.contextTokens ?? null,
          contextWindowTokens: record.contextWindowTokens ?? null,
        },
      });
    }
    // Every pass of a run registers again, and a reset wake is the one piece
    // of the previous state that is about the FUTURE: a caller told "geniro
    // starts you again when it resets" waits for that, so a message sent in the
    // meantime — which is what starts a pass — must not silently cancel it.
    // The map itself is carried, not copied: a call still settling in the
    // previous pass schedules through the state it captured, and sharing the
    // map is what lands that wake here too. The calls it names come back as
    // threads through the seed, so the wake needs nothing else of the old state.
    const previous = this.runs.get(runId);
    // A call from the previous pass may still be writing its final receipt.
    const messageFailures =
      previous?.messageFailures ?? new Map<string, MessageDeliveryFailure>();
    for (const failure of seed?.messageFailures ?? []) {
      messageFailures.set(failure.deliveryId, failure);
    }
    // …and a promise a RESTART carried over, read back off the run row at
    // boot: the first pass since then is what can deliver it through a live
    // capability, so it is adopted here with its timer still armed.
    const resetWakes =
      previous?.resetWakes ??
      this.restoredWakes.get(runId) ??
      new Map<number, ResetWake>();
    this.restoredWakes.delete(runId);
    this.runs.set(runId, {
      runId,
      capability,
      // Past every id THIS daemon already gave the run, too, not only the ones
      // the transcript holds: the seed is read before the new pass registers,
      // and a call the previous pass minted in between (a kept process racing
      // the follow-up) has its `call_started` row still on the write chain —
      // counted from the seed alone, the next call would reuse its id.
      callSeq: Math.max(seed?.callSeq ?? 0, previous?.callSeq ?? 0),
      seededCallSeq: seed?.callSeq ?? 0,
      activeCalls: new Map(),
      settledMadeIn: new Map(),
      newestCallOf: new Map(),
      pendingAsync: new Map(),
      messageFailures,
      threads,
      blockedOwners: new Map(),
      waitingOwners: new Map(),
      reportedBlocked: new Set(),
      waitReleases: new Map(),
      waitGaps: new Map(),
      unreadUserMessages: new Set(),
      deferredDrains: new Set(),
      resetWakes,
      // Carried like `resetWakes`: a delivery waiting on a call of the
      // previous pass is read from here when that call settles.
      pendingResetDeliveries:
        previous?.pendingResetDeliveries ??
        new Map<string, PendingResetDelivery[]>(),
    });
  }

  /**
   * The user wrote to `nodeId` while its turn runs: release every wait it has
   * open on its own calls, so the tool call returns and the CLI reads the
   * message now rather than when a callee finishes.
   *
   * REPORTED as a Manager sitting in `waiting on Engineer · call-44` for
   * minutes under a message sent straight into its turn. claude takes a
   * mid-turn message at the next tool BOUNDARY, and an `await_agent` is one
   * tool call that lasts as long as the callee does — up to the 240s ceiling,
   * and then the Manager awaits again. Released waits answer `pending` with
   * `interrupted: 'user_message'`; nothing is consumed or cancelled.
   *
   * With no wait open the message is remembered, so a wait started before the
   * CLI takes it returns at once — see {@link RunCallState.unreadUserMessages}.
   * True when a wait was released. A run with no call runtime has nothing to
   * release.
   */
  interruptWaits(
    runId: string,
    /** The conversation written to — a caller key (`utils/caller-key.ts`). */
    caller: string,
  ): boolean {
    const state = this.runs.get(runId);
    if (!state) {
      return false;
    }
    const releases = state.waitReleases.get(caller);
    if (!releases || releases.size === 0) {
      state.unreadUserMessages.add(caller);
      return false;
    }
    for (const release of [...releases]) {
      release();
    }
    return true;
  }

  /**
   * The CLI has taken the user's message, or the member's turn has ended — a
   * later wait no longer has a message to make way for.
   */
  forgetUserMessage(
    runId: string,
    /** The conversation that took it — a caller key. */
    caller: string,
  ): void {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }
    state.unreadUserMessages.delete(caller);
    // Busy with the message, or done: no longer between two waits.
    this.endWaitGap(state, caller);
  }

  /**
   * The conversation is writing its reply — main-thread text — so it is no
   * longer between two waits.
   */
  noteOwnerReplying(
    runId: string,
    /** The conversation writing — a caller key. */
    caller: string,
  ): void {
    const state = this.runs.get(runId);
    if (state) {
      this.endWaitGap(state, caller);
    }
  }

  /**
   * How many of a run's agents are sitting inside a wait on their own calls —
   * what {@link runToWire} puts on the run's snapshot.
   *
   * 0 for a run this broker has never heard of, which is every chat: a chat has
   * no call runtime, so nothing in one can be waiting.
   */
  awaitingCalls(runId: string): number {
    const state = this.runs.get(runId);
    return state ? waitingTargets(state) : 0;
  }

  /**
   * One member has entered a wait on its own calls; announce if it is the first.
   *
   * The announce is per RUN and carries the number of waiting NODES, so a
   * caller opening a second wait beside its first says nothing new — the fact
   * the composer reads ("is anything in this run merely waiting") has not
   * changed, and re-announcing it would be a socket emission per await.
   */
  private beginOwnerWait(state: RunCallState, owner: string): void {
    const before = waitingTargets(state);
    this.clearWaitGap(state, owner);
    state.waitingOwners.set(owner, (state.waitingOwners.get(owner) ?? 0) + 1);
    this.reportBlocked(state, owner);
    if (waitingTargets(state) !== before) {
      this.announceWaiting(state);
    }
  }

  /**
   * One member's wait has returned — by a result, a question, a timeout or an
   * abandonment, all of which end the tool call it was parked in. With `gap`,
   * the last of them opens the gap before its next wait.
   *
   * Every call site pairs this with {@link beginOwnerWait} in a `finally`: a
   * wait that threw its way out would otherwise leave the member counted as
   * waiting for the life of the run, and the composer would go on sending
   * messages straight into turns that really are working.
   */
  private endOwnerWait(state: RunCallState, owner: string, gap: boolean): void {
    const open = state.waitingOwners.get(owner) ?? 0;
    if (open > 1) {
      state.waitingOwners.set(owner, open - 1);
      return;
    }
    const before = waitingTargets(state);
    state.waitingOwners.delete(owner);
    this.reportBlocked(state, owner);
    if (gap) {
      const timer = setTimeout(() => {
        if (state.waitGaps.get(owner) === timer) {
          this.endWaitGap(state, owner);
        }
      }, AWAIT_GAP_GRACE_MS);
      timer.unref?.();
      state.waitGaps.set(owner, timer);
    }
    if (waitingTargets(state) !== before) {
      this.announceWaiting(state);
    }
  }

  /** End `owner`'s gap, announcing if that changes the count. */
  private endWaitGap(state: RunCallState, owner: string): void {
    if (!state.waitGaps.has(owner)) {
      return;
    }
    const before = waitingTargets(state);
    this.clearWaitGap(state, owner);
    if (waitingTargets(state) !== before) {
      this.announceWaiting(state);
    }
  }

  private clearWaitGap(state: RunCallState, owner: string): void {
    const timer = state.waitGaps.get(owner);
    if (timer !== undefined) {
      clearTimeout(timer);
      state.waitGaps.delete(owner);
    }
  }

  /**
   * Run one wait with its owner counted as waiting for exactly its duration.
   *
   * A helper rather than a begin/finally pair at each of the three wait sites,
   * because the pairing is the whole invariant: a site that begins and does not
   * end leaves the member counted as waiting for the life of the run.
   */
  private async whileWaiting<T>(
    state: RunCallState,
    owner: string,
    wait: () => Promise<T>,
  ): Promise<T | typeof INTERRUPTED> {
    // A message the user sent before this wait began, which the CLI has not
    // taken yet: it would be held for the whole wait.
    if (state.unreadUserMessages.delete(owner)) {
      return INTERRUPTED;
    }
    let release: () => void = () => {};
    const interrupted = new Promise<typeof INTERRUPTED>((resolve) => {
      release = () => resolve(INTERRUPTED);
    });
    const releases = state.waitReleases.get(owner) ?? new Set();
    releases.add(release);
    state.waitReleases.set(owner, releases);
    this.beginOwnerWait(state, owner);
    // Only a wait that RETURNED to a polling agent opens a gap: one a user
    // message released hands it work, one the CLI abandoned has no next wait.
    let gap = false;
    try {
      const outcome = await Promise.race([wait(), interrupted]);
      gap = outcome !== INTERRUPTED && outcome !== ABANDONED;
      return outcome;
    } finally {
      releases.delete(release);
      if (releases.size === 0 && state.waitReleases.get(owner) === releases) {
        state.waitReleases.delete(owner);
      }
      this.endOwnerWait(state, owner, gap);
    }
  }

  private announceWaiting(state: RunCallState): void {
    this.bus?.publishRunStatus({
      runId: state.runId,
      status: null,
      awaitingCalls: waitingTargets(state),
    });
  }

  /** Drop a settled run's state (uncollected async results included). */
  unregisterRun(runId: string): void {
    for (const wake of this.restoredWakes.get(runId)?.values() ?? []) {
      clearTimeout(wake.timer);
    }
    this.restoredWakes.delete(runId);
    const state = this.runs.get(runId);
    if (state) {
      // No timer of a call open at teardown may fire into a dead run (the
      // executor already cancelled every callee handle on the way here). BOTH
      // kinds: the parked question's TTL, and the silence watchdog — a wedged
      // callee is exactly what arms the second one AND what makes the delete's
      // own settle wait time out, so it is the likeliest to still be here.
      for (const call of state.activeCalls.values()) {
        if (call.parked) {
          stopQuestionTimer(call.parked);
          call.parked = null;
        }
        if (call.silence !== null) {
          call.silence.clear();
          call.silence = null;
        }
        if (call.messageRetry !== null) {
          clearTimeout(call.messageRetry);
          call.messageRetry = null;
        }
        call.pendingMessages = [];
        call.wakingMessages = [];
        // A held call has no turn the teardown's cancel reached: its
        // executor is waiting on this, and must not wait forever.
        this.releaseHold(call, { kind: 'cancelled' });
      }
      state.activeCalls.clear();
      for (const wake of state.resetWakes.values()) {
        clearTimeout(wake.timer);
      }
      state.resetWakes.clear();
      // A run being torn down is waiting on nothing. The waits themselves end
      // on their own (their calls are cancelled), but the ANNOUNCE they would
      // make goes to a run this map no longer holds — so it is made here, while
      // the state is still reachable, and the composer is not left believing a
      // destroyed run's agents are parked.
      for (const timer of state.waitGaps.values()) {
        clearTimeout(timer);
      }
      const wasWaiting = waitingTargets(state) > 0;
      state.waitGaps.clear();
      state.waitingOwners.clear();
      if (wasWaiting) {
        this.announceWaiting(state);
      }
    }
    this.runs.delete(runId);
  }

  /** Callees `callerNodeId` may invoke — [] when unknown or unwired. */
  listCallees(runId: string, callerMemberId: string): readonly TeamMember[] {
    return this.runs.get(runId)?.capability.calleesOf.get(callerMemberId) ?? [];
  }

  /**
   * How many of the run's conversations are blocked — inside a wait on their
   * own calls, or on a card or a parked question — or null for a run this
   * broker does not hold.
   */
  blockedConversations(runId: string): number | null {
    return this.runs.get(runId)?.reportedBlocked.size ?? null;
  }

  /** True while the run is registered (its MCP endpoint is live). */
  hasRun(runId: string): boolean {
    return this.runs.has(runId);
  }

  /**
   * The longest ONE wait of `nodeId`'s may block before it answers `pending`
   * — below the tool-call deadline of the CLI that member runs — or null when
   * nothing bounds it (an unknown run, a caller with no CLI behind it). What
   * `await_agent`'s listing tells the model its window is.
   */
  waitCeiling(runId: string, memberId: string): number | null {
    const state = this.runs.get(runId);
    return state ? this.ceilingFor(state, memberId) : null;
  }

  private ceilingFor(state: RunCallState, owner: string): number | null {
    const deadline = state.capability.toolCallDeadlineMs(owner);
    return deadline === null
      ? null
      : Math.floor(deadline * WAIT_CEILING_FRACTION);
  }

  /**
   * The call_agent tool. Sync resolves with the callee's settled envelope OR
   * an early `question` envelope when the callee parks mid-turn (the call
   * then becomes await_agent-collectable); async/fire-and-forget resolve
   * immediately with `{ call_id, state }` — async results are retained for
   * await_agent, fire-and-forget results go to the transcript only.
   */
  async callAgent(
    runId: string,
    /**
     * WHO is calling — a caller key (`utils/caller-key.ts`): the member id for a
     * member's own conversation, member + conversation for one answering a call.
     */
    caller: string,
    args: {
      agent: string;
      message: string;
      mode?: CallMode;
      thread?: string;
      /**
       * A short, human-readable reason for this call, shown on its transcript
       * card and carried onto the `call_started` item. Validated and trimmed
       * by `validateCallAgentArgs` in `v1/mcp/tools/call-agent/`.
       */
      title: string;
      /**
       * The callee POOL member (1-based) the caller prefers: the call starts
       * on it while it is available and still hands on. Absent = the first
       * available member in pool order.
       */
      member?: number;
      /**
       * Continue a `thread` even when its prompt cache has lapsed and its
       * window is large — see {@link isColdAndLarge}. Absent = refused.
       */
      resumeCold?: boolean;
    },
    /**
     * Trips when the HTTP request this sync call is answering has gone away —
     * a client that cuts long tool calls off. Absent = cannot be abandoned.
     */
    signal?: AbortSignal,
  ): Promise<CallEnvelope> {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const opened = this.openCall(runId, state, caller, {
      ...args,
      coldGuard: args.resumeCold !== true,
    });
    if ('refused' in opened) {
      return opened.refused;
    }
    const { callId, call, calleeId, mode } = opened;
    if (mode === 'sync') {
      const lease: WaitLease = { release: () => {} };
      // A sync call had no bound of its own, so one longer than the caller
      // CLI's tool-call deadline ended in that CLI's timeout error — with its
      // result later consumed by a reply nobody read (cursor, whose client
      // keeps the socket open), or collectable under an id the model was never
      // told (claude). Past the ceiling it becomes the async call it already is.
      const ceiling = this.ceilingFor(state, caller);
      const outcome = signal?.aborted
        ? ABANDONED
        : await (this.readyOutcome(state, callId, call.settled) ??
            this.whileWaiting(state, caller, () =>
              this.untilAbandoned(
                signal,
                this.untilDeadline(
                  ceiling ?? undefined,
                  this.waitForOutcome(state, callId, call.settled, lease),
                ),
              ),
            ));
      if (outcome === TIMED_OUT) {
        lease.release();
        makeCollectable(state, callId, call);
        return {
          status: 'pending',
          call_id: callId,
          agent: calleeId,
          note: syncOutlastedNote(callId),
        };
      }
      if (outcome === ABANDONED) {
        // Nobody is reading this reply, so the waiter must not keep accepting
        // questions — and the result must stay reachable for a retry.
        lease.release();
        makeCollectable(state, callId, call);
        return {
          status: 'error',
          error: `AWAIT_ABANDONED: the request for '${callId}' ended before the callee did — collect it with await_agent`,
        };
      }
      if (outcome === INTERRUPTED) {
        // The call carries on; only this reply returns, so the sync call
        // becomes the await-collectable entry an abandoned one becomes.
        lease.release();
        makeCollectable(state, callId, call);
        return {
          status: 'pending',
          call_id: callId,
          agent: calleeId,
          interrupted: 'user_message',
          note: USER_MESSAGE_NOTE,
        };
      }
      if (outcome.status === 'question') {
        this.rearmQuestionTtl(runId, outcome.call_id);
      }
      return outcome;
    }
    return {
      status: 'ok',
      result: {
        call_id: callId,
        agent: calleeId,
        state: mode === 'async' ? 'started' : 'detached',
      },
    };
  }

  /**
   * Everything `call_agent` decides before it waits: the refusals, the new
   * call id, its `call_started` row and its launch — synchronously, so a wake
   * that CONTINUES a callee's conversation on its caller's behalf
   * ({@link startOwnerTurn}) learns at once whether the call went out.
   */
  private openCall(
    runId: string,
    state: RunCallState,
    caller: string,
    args: {
      agent: string;
      message: string;
      mode?: CallMode;
      thread?: string;
      title: string;
      member?: number;
      /**
       * Refuse a continuation whose cache has lapsed over a large window. Only
       * a caller's own `call_agent` asks for it: geniro continuing a
       * conversation on a caller's behalf is delivering what it owes, which no
       * cost argument should stop.
       */
      coldGuard?: boolean;
      /**
       * geniro continuing a conversation on its caller's behalf to deliver
       * what calls already running owe it ({@link startOwnerTurn}) — started
       * without waiting under the run's active-turn cap, as any wake is.
       */
      wake?: boolean;
    },
  ):
    | { refused: CallEnvelope }
    | { callId: string; call: ActiveCall; calleeId: string; mode: CallMode } {
    const refuse = (error: string): { refused: CallEnvelope } => ({
      refused: { status: 'error', error },
    });
    const callerMemberId = callerNodeOf(caller);
    if (state.capability.isCancelled()) {
      return refuse('RUN_CANCELLED: the run was cancelled — no new calls');
    }
    // Refused BEFORE an id is minted: a call accepted here would live in state
    // the next pass's registration is about to replace, so its caller would be
    // told `started` and then UNKNOWN_CALL for it.
    if (state.capability.isSuperseded()) {
      return refuse(
        'RUN_BUSY: a new message is starting this run’s next pass — make the call again in a moment',
      );
    }
    const callees = state.capability.calleesOf.get(callerMemberId) ?? [];
    const callee = resolveCallee(callees, args.agent);
    if (!callee) {
      const callable = callees.map((c) => c.name).join(', ') || 'none';
      return refuse(
        `UNKNOWN_AGENT: '${args.agent}' is not a member of this team you can call (callable: ${callable})`,
      );
    }
    const upTheChain = this.callUpTheChain(state, caller, callee);
    if (upTheChain !== null) {
      return refuse(upTheChain);
    }
    const depth = this.callerDepth(state, caller) + 1;
    if (depth > MAX_CALL_DEPTH) {
      return refuse(
        `DEPTH_LIMIT: call chains are capped at depth ${MAX_CALL_DEPTH}`,
      );
    }
    // Thread continuation: resume the callee CLI session a prior call of THIS
    // caller recorded. Ownership gates the lookup like await/answer do — one
    // caller can never continue (and thus read) another caller's conversation.
    let resumeSessionId: string | null = null;
    let conversationId: string | null = null;
    let continuedMember: number | null = null;
    let preferredMember = args.member ?? null;
    if (args.thread !== undefined) {
      let thread = state.threads.get(args.thread);
      if (!thread || thread.owner !== caller) {
        return refuse(
          `UNKNOWN_THREAD: no settled call '${args.thread}' started by you`,
        );
      }
      if (thread.calleeId !== callee.id) {
        return refuse(
          `THREAD_AGENT_MISMATCH: call '${args.thread}' was a conversation with '${thread.calleeId}', not '${callee.id}'`,
        );
      }
      // Earlier call IDs still name this conversation after a pool handoff.
      thread =
        callsOfConversation(state, thread.conversationId).findLast(
          (record) => record.sessionId !== null,
        ) ?? thread;
      if (!thread.sessionId) {
        return refuse(
          `THREAD_UNAVAILABLE: call '${args.thread}' recorded no resumable session`,
        );
      }
      // One conversation serves one call at a time. A second continuation
      // while the first still runs would either resume the session in a
      // second process (the fork this keying exists to end) or, keyed
      // together, have the registry replace the running process — killing the
      // first call mid-work. Refusing is the only reading under which the
      // conversation stays one conversation; the caller awaits and continues
      // from the call that is running.
      for (const [liveId, live] of state.activeCalls) {
        if (live.conversationId === thread.conversationId) {
          return refuse(
            `THREAD_BUSY: '${liveId}' is still running on that conversation — to correct or add to what it is doing now, send it message_agent(call_id: '${liveId}'); otherwise continue with thread: '${liveId}' once it has finished (await_agent collects it if you started it async)`,
          );
        }
      }
      if (args.coldGuard === true) {
        const facts = conversationCache(
          state,
          callsOfConversation(state, thread.conversationId),
        );
        if (isColdAndLarge(facts, Date.now())) {
          return refuse(coldResumeRefusal(callee.id, args.thread, facts));
        }
      }
      resumeSessionId = thread.sessionId;
      conversationId = thread.conversationId;
      continuedMember = thread.member;
      preferredMember ??= thread.preferredMember;
    }
    const selected = this.selectPoolMember(
      { cwd: state.capability.cwd ?? null, runId, memberId: callee.id },
      callee,
      args.member ?? null,
      preferredMember,
      continuedMember,
      () =>
        conversationId !== null &&
        state.capability.conversationHoldsWork?.(conversationId) === true,
    );
    if ('refused' in selected) {
      return selected;
    }
    state.callSeq += 1;
    const callId = callIdOf(state.callSeq);
    const mode: CallMode = args.mode ?? 'sync';
    const call: ActiveCall = {
      calleeId: callee.id,
      owner: caller,
      depth,
      mode,
      settled: Promise.resolve(RUN_NOT_ACTIVE), // reassigned synchronously below
      parked: null,
      questionWaiters: [],
      failReason: null,
      turnEnded: false,
      silence: null,
      saidStalled: false,
      pendingMessages: [],
      wakingMessages: [],
      messageRetry: null,
      blockedOnVerdicts: 0,
      queued: false,
      openToolCalls: new Set(),
      // A fresh call opens a conversation of its own, named after itself.
      conversationId: conversationId ?? callId,
      hold: null,
      madeIn: callEntryInConversation(state, caller)?.[0] ?? null,
      everHeld: false,
      cancelledOwing: false,
      reportedWaitingOn: 0,
      published: new Map(),
      publishedActions: new Map(),
    };
    state.activeCalls.set(callId, call);
    state.newestCallOf.set(call.conversationId, callId);
    this.armSilenceWatch(runId, callId, call);
    // TWIN PARSER: apps/ui/src/renderer/chats/transcript-groups.ts reads this
    // payload — `buildCallBlock` (`title` onto `CallBlockEntry.title`) and
    // `resolveCallChains` (`thread`, which folds a continued conversation into
    // one card); a renamed or reshaped key is mirrored there.
    //
    // `callerConversationId` names the conversation a callee made this call
    // from; `utils/call-seed.ts` reads it back so a restart keeps the call
    // owned by that conversation rather than by its member.
    const callerConversationId = callerConversationOf(caller);
    state.capability.persistItem(callerMemberId, 'call_started', null, {
      callId,
      callerNodeId: callerMemberId,
      ...(callerConversationId !== null ? { callerConversationId } : {}),
      calleeNodeId: callee.id,
      mode,
      message: args.message,
      ...(args.thread !== undefined ? { thread: args.thread } : {}),
      title: args.title,
      ...(selected.plan !== null ? { member: selected.plan.member } : {}),
    } satisfies CallStartedPayload);

    // The settled turn's CLI session id, mirrored into the call_result item so
    // the UI can open a terminal on (or reason about) that specific thread.
    let threadSessionId: string | null = null;
    // The member that took the call, for a pooled callee — on the result row,
    // where a restart reads it back (`utils/call-seed.ts`).
    let threadMember: number | null = null;
    // What the settled turn said about its prompt cache and window, mirrored
    // onto the result row so a restart can tell a caller the same thing.
    let threadCache: ConversationCacheFacts | null = null;
    call.settled = state.capability
      .launchCalleeTurn(
        selected.node,
        args.message,
        callId,
        resumeSessionId,
        call.conversationId,
        {
          ...(selected.plan !== null ? { pool: selected.plan } : {}),
          wake: args.wake === true,
        },
      )
      .then((outcome) => {
        const member = outcome.member ?? selected.plan?.member ?? 1;
        // Every settled turn leaves a resume handle so the conversation can
        // be continued from THIS point with `thread: <this call_id>`.
        const cache: ConversationCacheFacts = {
          endedAt: Date.now(),
          promptCacheTtlMs: outcome.promptCacheTtlMs ?? null,
          contextTokens: outcome.contextTokens ?? null,
          contextWindowTokens: outcome.contextWindowTokens ?? null,
        };
        state.threads.set(callId, {
          owner: caller,
          calleeId: callee.id,
          sessionId: outcome.sessionId,
          conversationId: call.conversationId,
          member,
          preferredMember: selected.plan?.preferred ?? null,
          madeIn: call.madeIn,
          cache,
        });
        threadCache = cache;
        threadSessionId = outcome.sessionId;
        if (selected.plan !== null) {
          threadMember = member;
        }
        const envelope = toEnvelope(callId, callee.id, outcome, call);
        if (
          envelope.status === 'error' &&
          outcome.failureClass === 'rate_limited' &&
          outcome.resetsAt !== null &&
          outcome.sessionId !== null &&
          this.scheduleResetWake(
            runId,
            state,
            caller,
            callId,
            callee.id,
            outcome.resetsAt,
          )
        ) {
          // Said in the envelope, so the caller does not improvise a timer of
          // its own (the reported Manager ran `sleep 5300` in a shell).
          return {
            ...envelope,
            error: `${envelope.error} — geniro starts you again when it resets, to continue it; wait for that rather than setting a timer or retrying`,
          };
        }
        return envelope;
      })
      .catch((err: unknown): CallEnvelope => ({
        status: 'error',
        error: `CALL_FAILED: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((envelope) => {
        // A TTL/orphan drain cancelled the parked turn — surface its typed
        // reason, not the generic CALLEE_CANCELLED the cancel maps to. Never
        // over a COMPLETED turn: a stop that lost the race to the callee's own
        // ending stopped nothing, and the finished work is the caller's.
        const final = withPublished(
          call.failReason !== null && envelope.status !== 'ok'
            ? { status: 'error', error: call.failReason }
            : envelope,
          call,
        );
        // The turn died with a question still parked (external cancel,
        // crash) — the timer must not fire into a settled call, and the
        // callee must not stay counted as blocked on it.
        this.unpark(state, callId, call);
        // Same rule for the silence watchdog, and the same reason: a settled
        // call must not later announce that it went quiet.
        if (call.silence !== null) {
          call.silence.clear();
          call.silence = null;
        }
        this.dropPendingMessages(state, callId, call);
        state.settledMadeIn.set(callId, call.madeIn);
        state.activeCalls.delete(callId);
        state.capability.persistItem(callerMemberId, 'call_result', null, {
          callId,
          callerNodeId: callerMemberId,
          ...(callerConversationId !== null ? { callerConversationId } : {}),
          calleeNodeId: callee.id,
          mode,
          sessionId: threadSessionId,
          ...(threadMember !== null ? { member: threadMember } : {}),
          ...(threadMember !== null && selected.plan?.preferred != null
            ? { preferredMember: selected.plan.preferred }
            : {}),
          ...cacheResultFields(threadCache),
          ...final,
        } satisfies CallResultPayload);
        // The conversation that made this call may be HELD waiting for it —
        // and only now, with it gone from `activeCalls`, can that wait see it
        // is over. After the result row, so the wake reads below it.
        const holder = heldCallOf(state, caller);
        if (holder !== undefined && this.runs.get(runId) === state) {
          this.reviewHold(runId, state, holder[0], holder[1]);
        }
        return final;
      });

    if (mode === 'async') {
      state.pendingAsync.set(callId, {
        owner: caller,
        calleeId: callee.id,
        settled: call.settled,
        told: false,
      });
    }
    return { callId, call, calleeId: callee.id, mode };
  }

  /**
   * A settled call's conversation ran a turn of its own (its kept process
   * carried on after the call) — move that call's cache facts to it. A figure
   * the turn did not report keeps the one it had. Nothing for a call that is
   * not settled: its own settle writes the facts.
   */
  noteConversationTurnEnded(
    runId: string,
    callId: string,
    facts: ConversationCacheFacts,
  ): void {
    const thread = this.runs.get(runId)?.threads.get(callId);
    if (thread === undefined) {
      return;
    }
    thread.cache = {
      endedAt: facts.endedAt ?? thread.cache.endedAt,
      promptCacheTtlMs: facts.promptCacheTtlMs ?? thread.cache.promptCacheTtlMs,
      contextTokens: facts.contextTokens ?? thread.cache.contextTokens,
      contextWindowTokens:
        facts.contextWindowTokens ?? thread.cache.contextWindowTokens,
    };
  }

  /**
   * The list_agent_threads tool: every conversation this caller holds with its
   * callees — the handle to continue it with, whether a call is running on it,
   * how full its window is and where its prompt cache stands.
   *
   * What it exists for is the choice before a follow-up: a conversation whose
   * cache is warm is cheap to continue, while one whose cache has lapsed is
   * re-billed WHOLE on its next turn — which is why `callAgent` refuses one past
   * half its window (CACHE_EXPIRED). The listing states the figures and that
   * refusal and recommends neither choice. The figures move with the clock,
   * which is why they are a tool's answer rather than a line of the
   * "May call" block — that block is part of the caller's session identity,
   * and changing it would restart the caller's own process and cache.
   */
  listThreads(
    runId: string,
    /** WHO is asking — a caller key, as `callAgent` takes one. */
    caller: string,
  ): CallEnvelope {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const now = Date.now();
    const byConversation = new Map<
      string,
      { calleeId: string; settled: string[]; running: string[] }
    >();
    const entry = (conversationId: string, calleeId: string) => {
      const found = byConversation.get(conversationId) ?? {
        calleeId,
        settled: [],
        running: [],
      };
      byConversation.set(conversationId, found);
      return found;
    };
    for (const [callId, thread] of state.threads) {
      // A call that recorded no session never ran (cancelled while queued, or
      // restored after a restart with no result): it is not a handle anything
      // can continue, and it measured nothing about the conversation.
      if (thread.owner === caller && thread.sessionId !== null) {
        entry(thread.conversationId, thread.calleeId).settled.push(callId);
      }
    }
    for (const [callId, call] of state.activeCalls) {
      if (call.owner === caller) {
        entry(call.conversationId, call.calleeId).running.push(callId);
      }
    }
    const threads = [...byConversation.values()]
      .map((found) => {
        const settled = [...found.settled].sort(byCallNumber);
        const running = [...found.running].sort(byCallNumber);
        const facts = conversationCache(
          state,
          settled.map((callId) => state.threads.get(callId)!),
        );
        const standing = promptCacheStanding(facts, now);
        const percent = conversationContextPercent(facts);
        const busy = running.length > 0;
        const newest = [...settled, ...running].sort(byCallNumber).pop() ?? '';
        const wire = {
          agent: found.calleeId,
          thread: settled[settled.length - 1] ?? null,
          status: busy ? 'running' : 'idle',
          ...(busy ? { running_call: running[running.length - 1] } : {}),
          calls: settled.length + running.length,
          last_turn_ended_at:
            facts.endedAt === null
              ? null
              : new Date(facts.endedAt).toISOString(),
          // Only what was measured: no `context` without a token reading, no
          // window without a window reading, no percent without both.
          ...(facts.contextTokens === null
            ? {}
            : {
                context: {
                  tokens: facts.contextTokens,
                  ...(facts.contextWindowTokens === null
                    ? {}
                    : { window: facts.contextWindowTokens }),
                  ...(percent === null
                    ? {}
                    : { percent: statedPercent(percent) }),
                },
              }),
          cache: cacheWire(standing, now),
          ...(!busy && isColdAndLarge(facts, now)
            ? { resume_refused: 'CACHE_EXPIRED' }
            : {}),
        };
        return { newest, wire };
      })
      // Oldest conversation first, by its newest call — the order they were
      // last worked in.
      .sort((a, b) => byCallNumber(a.newest, b.newest))
      .map(({ wire }) => wire);
    return {
      status: 'ok',
      result: {
        now: new Date(now).toISOString(),
        threads,
        rule: COLD_RESUME_RULE,
      },
    };
  }

  /**
   * The await_agent tool: collect one of the caller's own async (or
   * question-parked sync) results. Returns an early `question` envelope when
   * the callee parks mid-wait — the entry stays collectable for the retry
   * after answer_agent.
   */
  async awaitAgent(
    runId: string,
    /** WHO is collecting — a caller key, as `callAgent` takes one. */
    caller: string,
    args: {
      /**
       * The call to collect. Absent = wait on ALL of the caller's open calls
       * and return the FIRST thing any of them produces — see `awaitAny`.
       */
      call_id?: string;
      /**
       * How long to block before answering `pending` instead — absent means
       * block until the callee settles, which is what every caller got before
       * this existed.
       *
       * Taken as given: the BOUNDS are the MCP layer's, where a model's
       * arguments are validated and an out-of-range one becomes INVALID_ARGS.
       * Here it is a plain number, so a spec can name a millisecond window and
       * drive the whole path in no wall-clock time.
       */
      timeout_ms?: number;
    },
    /**
     * Trips when the HTTP request this collection is answering has gone away —
     * see {@link ABANDONED}. Absent = a caller that cannot be abandoned (a
     * test, an in-process caller).
     */
    signal?: AbortSignal,
  ): Promise<CallEnvelope> {
    const state = this.runs.get(runId);
    if (!state) {
      return {
        status: 'error',
        error: 'RUN_NOT_ACTIVE: this run is not accepting agent calls',
      };
    }
    // Whatever window was asked for, never past what the caller's CLI holds a
    // tool call open for — see WAIT_CEILING_FRACTION.
    const timeoutMs = boundedWait(
      args.timeout_ms,
      this.ceilingFor(state, caller),
    );
    if (args.call_id === undefined) {
      return this.awaitAny(runId, state, caller, timeoutMs, signal);
    }
    const callId = args.call_id;
    const entry = state.pendingAsync.get(callId);
    if (!entry || entry.owner !== caller) {
      return this.unknownCall(state, null, callId, 'un-collected async call');
    }
    const lease: WaitLease = { release: () => {} };
    // A request already gone must not reach `waitForOutcome`, which would hand
    // it — and mark delivered — a question nobody will read.
    const envelope = signal?.aborted
      ? ABANDONED
      : await (this.readyOutcome(state, callId, entry.settled) ??
          this.whileWaiting(state, caller, () =>
            this.untilAbandoned(
              signal,
              this.untilDeadline(
                timeoutMs,
                this.waitForOutcome(state, callId, entry.settled, lease),
              ),
            ),
          ));
    // A collection that stopped waiting must stop LISTENING too: left
    // registered, its waiter would accept a later question from another call
    // and hand it to a reply that has already been sent.
    if (
      envelope === ABANDONED ||
      envelope === TIMED_OUT ||
      envelope === INTERRUPTED
    ) {
      lease.release();
    }
    // The request is GONE — its socket closed while this collection was
    // blocked. Consuming here is what cost a caller a whole callee turn: the
    // entry is deleted, `await_collected` is written, and the envelope is
    // handed to a reply nobody will read, so the retry is told UNKNOWN_CALL
    // and the work is unreachable for the rest of the run.
    if (envelope === ABANDONED) {
      return {
        status: 'error',
        error: `AWAIT_ABANDONED: the request collecting '${callId}' ended before the callee did — the result is still collectable`,
      };
    }
    // The caller asked to stop waiting, so it is told exactly that and NOTHING
    // is consumed: the entry stays, no `await_collected` row is written, and
    // the next await picks up where this one left off. Identical mechanics to
    // the abandonment above — the two differ only in what the caller is told,
    // because only one of them was the caller's own decision.
    if (envelope === TIMED_OUT) {
      return {
        status: 'pending',
        call_id: callId,
        agent: entry.calleeId,
      };
    }
    if (envelope === INTERRUPTED) {
      return {
        status: 'pending',
        call_id: callId,
        agent: entry.calleeId,
        interrupted: 'user_message',
        note: USER_MESSAGE_NOTE,
      };
    }
    if (envelope.status === 'question') {
      // The TTL counts from the moment the caller can actually SEE the
      // question, not from the park — this is the one delivery that is
      // observed rather than assumed. The envelope's own call id, since a
      // question from ANOTHER call of this caller's can divert this wait.
      this.rearmQuestionTtl(runId, envelope.call_id);
      return envelope;
    }
    // A concurrent waiter may have collected while this one was blocked —
    // collection stays exactly-once (question envelopes are the only
    // non-consuming reads), so the loser is told the call is gone rather
    // than duplicating the await_collected row.
    return (
      this.collect(state, caller, callId, envelope) ?? {
        status: 'error',
        error: `UNKNOWN_CALL: no un-collected async call '${callId}' started by you`,
      }
    );
  }

  /**
   * Consume one settled call's result, exactly once — null when a concurrent
   * collection already took it.
   */
  private collect(
    state: RunCallState,
    caller: string,
    callId: string,
    envelope: CallEnvelope,
  ): CallEnvelope | null {
    if (!state.pendingAsync.has(callId)) {
      return null;
    }
    state.pendingAsync.delete(callId);
    state.capability.persistItem(
      callerNodeOf(caller),
      'await_collected',
      null,
      {
        callId,
        callerNodeId: callerNodeOf(caller),
      },
    );
    return envelope;
  }

  /**
   * await_agent with no call_id: wait on EVERY call the caller has open and
   * return the first thing any of them produces — a question, or a finished
   * result — naming the call it came from. What a caller that fanned out work
   * needs: waiting on one call while another finished or asked is how a
   * question sat unseen until it timed out.
   *
   * An unseen question and an already-settled result are answered at once;
   * otherwise one waiter per call races, and every one is released when the
   * wait ends however it ends. The others stay collectable.
   */
  private async awaitAny(
    runId: string,
    state: RunCallState,
    caller: string,
    timeoutMs: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<CallEnvelope> {
    const abandoned: CallEnvelope = {
      status: 'error',
      error:
        'AWAIT_ABANDONED: the request ended before any call produced anything — every call is still collectable',
    };
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    // A LOOP because a result can be taken by a concurrent collection between
    // the race and the collect; the calls still open are then waited on again
    // rather than the caller being told about a call that is not its to take.
    for (;;) {
      const open = [...state.pendingAsync].filter(
        ([, entry]) => entry.owner === caller,
      );
      if (open.length === 0) {
        return {
          status: 'error',
          error:
            'NO_OPEN_CALLS: you have no un-collected calls — start one with call_agent first',
        };
      }
      if (signal?.aborted) {
        return abandoned;
      }
      for (const [callId] of open) {
        const call = state.activeCalls.get(callId);
        if (call?.parked && !call.parked.envelopeDelivered) {
          markEnvelopeDelivered(call);
          this.rearmQuestionTtl(runId, callId);
          return questionEnvelope(callId, call);
        }
      }
      // Every open call is waiting on an answer the caller has already been
      // shown: waiting would only run those questions out of time, so they are
      // shown again instead.
      const parkedCall = open
        .map(([callId]) => [callId, state.activeCalls.get(callId)] as const)
        .find(([, call]) => call?.parked);
      if (
        parkedCall !== undefined &&
        open.every(([callId]) => state.activeCalls.get(callId)?.parked)
      ) {
        return questionEnvelope(parkedCall[0], parkedCall[1]!);
      }
      let collectedSettled: CallEnvelope | null = null;
      for (const [callId, entry] of open) {
        if (!state.activeCalls.has(callId)) {
          const settled = await entry.settled;
          const collected = this.collect(state, caller, callId, settled);
          if (collected !== null) {
            collectedSettled = withCallId(collected, callId);
            break;
          }
        }
      }
      if (collectedSettled !== null) {
        return collectedSettled;
      }
      const leases: WaitLease[] = [];
      const questionsSeen: string[] = [];
      // The question the race returned: undefined until it is decided, null
      // when it returned a result instead.
      let shown: string | null | undefined;
      const first = Promise.race(
        open.map(([callId, entry]) => {
          const lease: WaitLease = { release: () => {} };
          leases.push(lease);
          return this.listen(state, callId, entry.settled, lease).then(
            (envelope) => {
              if (envelope.status === 'question') {
                questionsSeen.push(envelope.call_id);
                if (shown !== undefined && shown !== envelope.call_id) {
                  this.unseeQuestion(state, envelope.call_id);
                }
              }
              return { callId, envelope };
            },
          );
        }),
      ).then((outcome) => {
        shown =
          outcome.envelope.status === 'question'
            ? outcome.envelope.call_id
            : null;
        return outcome;
      });
      const outcome = await this.whileWaiting(state, caller, () =>
        this.untilAbandoned(
          signal,
          this.untilDeadline(
            deadline === null ? undefined : Math.max(0, deadline - Date.now()),
            first,
          ),
        ),
      );
      for (const lease of leases) {
        lease.release();
      }
      if (typeof outcome === 'symbol') {
        shown = null;
      }
      // A question that reached a waiter which then lost the race was marked
      // delivered and shown to nobody — put it back for the next wait.
      for (const callId of questionsSeen) {
        if (callId !== shown) {
          this.unseeQuestion(state, callId);
        }
      }
      if (outcome === ABANDONED) {
        return abandoned;
      }
      if (outcome === TIMED_OUT || outcome === INTERRUPTED) {
        const waitingOn = open.map(([callId, entry]) => ({
          call_id: callId,
          agent: entry.calleeId,
        }));
        return {
          status: 'pending',
          ...waitingOn[0]!,
          waiting_on: waitingOn,
          ...(outcome === INTERRUPTED
            ? { interrupted: 'user_message' as const, note: USER_MESSAGE_NOTE }
            : {}),
        };
      }
      if (outcome.envelope.status === 'question') {
        this.rearmQuestionTtl(runId, outcome.envelope.call_id);
        return outcome.envelope;
      }
      const collected = this.collect(
        state,
        caller,
        outcome.callId,
        outcome.envelope,
      );
      if (collected !== null) {
        return withCallId(collected, outcome.callId);
      }
    }
  }

  /**
   * The cancel_agent tool: stop a call the caller no longer wants.
   *
   * It exists because a caller that has LEARNED its call is pointless could do
   * nothing about it. Measured on run `09d69570`: at 04:40Z the Manager knew the
   * build it had dispatched rested on a premise its own UAT check had just
   * refuted, and wrote "its call cannot be interrupted" — the Engineer ran ~100
   * more minutes and spent ~$100 on work that was discarded on arrival. The user
   * was asleep, so the only other stop (a run-wide Stop) was not available
   * either, and it would have taken the whole run down with it.
   *
   * THREE properties are deliberate, and each was decided against an
   * alternative:
   *
   * - **No confirmation card.** The agent cancels its OWN call and reports what
   *   it did; a card would park an overnight run on a verdict nobody is there to
   *   give while the unwanted call goes on spending. The user's protection is
   *   that the act is narrow — see the next point — and that it is recorded.
   * - **Ownership is enforced HERE, not asked of the tool's caller.** A callee
   *   is handed the same endpoint shape as its caller, so without this check a
   *   nested agent could cancel a sibling's work. `owner !== caller` reads
   *   as UNKNOWN_CALL rather than as a refusal, exactly as `answerAgent`'s does:
   *   a caller has no business learning that a call it does not own exists.
   * - **The REASON is required.** It is stamped onto the envelope the caller
   *   collects and onto the transcript row, so a cancelled call says who stopped
   *   it and why. An optional field here would routinely be omitted, and the
   *   whole record of a hundred-minute call ending early would be its absence.
   */
  cancelAgent(
    runId: string,
    /** WHO is asking — a caller key, as `callAgent` takes one. */
    caller: string,
    args: { call_id: string; reason: string },
  ): CallEnvelope {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const call = state.activeCalls.get(args.call_id);
    if (!call || call.owner !== caller) {
      return this.unknownCall(state, caller, args.call_id, 'live call');
    }
    const agent = this.calleeName(state, call.owner, call.calleeId);
    // The callee has already FINISHED; only the executor's bookkeeping holds the
    // call open. There is nothing left to stop, and stamping a reason here would
    // hand the caller CALLEE_CANCELLED in place of work it already has. A call
    // whose turn ended with work of its own still out — held, or about to be —
    // has not finished, and is cancelled like a running one.
    if (isFinishedWork(state, call)) {
      const collectable = state.pendingAsync.has(args.call_id);
      return {
        status: 'ok',
        result: {
          call_id: args.call_id,
          agent: call.calleeId,
          state: 'already_finished',
          note: `${agent} had already finished '${args.call_id}' when this arrived, so nothing was stopped and its result stands${collectable ? ` — collect it with await_agent(call_id: '${args.call_id}')` : ''}.`,
        },
      };
    }
    // Stamped BEFORE the turn is stopped, on `failParked`'s rule: the settled
    // chain reads `failReason` the moment the turn resolves, and a cancel can
    // resolve it synchronously.
    call.failReason = `CALLEE_CANCELLED: ${agent} was stopped by ${callerNodeOf(caller)} — ${args.reason}`;
    this.dropPendingMessages(state, args.call_id, call);
    // A question parked on this call dies with the turn, and its row must not be
    // left dangling unresolved in the transcript. Same two steps `failParked`
    // takes, minus its own `failReason` (already set, and more specific).
    const parked = this.unpark(state, args.call_id, call);
    if (parked) {
      state.capability.persistItem(
        callerNodeOf(call.owner),
        'call_answer',
        null,
        {
          callId: args.call_id,
          callerNodeId: callerNodeOf(caller),
          calleeNodeId: call.calleeId,
          outcome: 'cancelled',
        },
      );
    }
    // Before the cascade below silences what it owed.
    call.cancelledOwing = owesHold(state, call);
    // Its callee's monitors are part of the work being stopped.
    state.capability.stopMonitors?.(calleeKeyOf(call));
    // The calls its callee made for it are part of the work being stopped.
    this.cancelSubCalls(state, call, args.call_id);
    if (call.hold !== null) {
      // Marked as well, so no wake turn can start on it from here.
      state.capability.cancelCalleeTurn(args.call_id);
      this.releaseHold(call, { kind: 'cancelled' });
      return {
        status: 'ok',
        result: {
          call_id: args.call_id,
          agent: call.calleeId,
          state: 'cancelling',
        },
      };
    }
    const signalled = state.capability.cancelCalleeTurn(args.call_id);
    return {
      status: 'ok',
      result: {
        call_id: args.call_id,
        agent: call.calleeId,
        // A call still queued under the active-turn cap is cancelled just as
        // effectively and never started, which is worth saying: the caller then
        // knows nothing was spent on it.
        state: signalled ? 'cancelling' : 'cancelled_before_it_started',
      },
    };
  }

  /**
   * Stop the calls `parent`'s callee made that are still running — async and
   * sync, and theirs in turn — because the call they were made for is being
   * stopped. Fire-and-forget calls are left alone: they were detached from it
   * when they were made.
   *
   * WHICH calls is the hold's own set once the parent's turn has ended: a held
   * call waits for every open call of its conversation, an earlier call's
   * leftovers included, so its cancel must stop exactly those — anything left
   * running would later continue the conversation the caller just cancelled.
   * While the turn is still running it is only the calls made inside it: a
   * later call of a conversation does not own an earlier one's work.
   */
  private cancelSubCalls(
    state: RunCallState,
    parent: ActiveCall,
    parentCallId: string,
  ): void {
    const key = calleeKeyOf(parent);
    // `everHeld` is set with the hold and never cleared, so it also covers a
    // call that is held right now.
    const adopted = parent.turnEnded || parent.everHeld;
    for (const [subId, sub] of openSubCalls(state, key)) {
      if (!adopted && sub.madeIn !== parentCallId) {
        continue;
      }
      // Its result — cancelled here, failed already, or real for finished
      // work — is not news to wake anyone with: the call it was made for is
      // being stopped. It stays collectable with await_agent either way.
      const entry = state.pendingAsync.get(subId);
      if (entry) {
        entry.told = true;
      }
      // Already stopped, or finished work, which stands: only bookkeeping
      // holds it open.
      if (sub.failReason !== null || isFinishedWork(state, sub)) {
        continue;
      }
      const agent = this.calleeName(state, sub.owner, sub.calleeId);
      sub.failReason = `CALLEE_CANCELLED: ${agent} was stopped because the call it was working for ('${parentCallId}') was cancelled`;
      this.dropPendingMessages(state, subId, sub);
      sub.cancelledOwing = owesHold(state, sub);
      state.capability.stopMonitors?.(calleeKeyOf(sub));
      if (this.unpark(state, subId, sub)) {
        state.capability.persistItem(
          callerNodeOf(sub.owner),
          'call_answer',
          null,
          {
            callId: subId,
            callerNodeId: callerNodeOf(sub.owner),
            calleeNodeId: sub.calleeId,
            outcome: 'cancelled',
          },
        );
      }
      this.cancelSubCalls(state, sub, subId);
      state.capability.cancelCalleeTurn(subId);
      this.releaseHold(sub, { kind: 'cancelled' });
    }
    this.silenceConversation(state, key, adopted ? null : parentCallId);
  }

  /**
   * Nothing owed to a cancelled conversation may continue it later: results
   * it was not woken for are marked told, and a usage-limit continue promised
   * to it — scheduled, or fired and waiting for the conversation — is dropped.
   * Either would otherwise reopen it as a call made for the caller that just
   * stopped it.
   *
   * `madeIn` narrows it to what the calls made inside that one call left —
   * the scope of a cancel while that call's turn still runs, which does not
   * own the conversation's earlier work (see `cancelSubCalls`); null covers
   * the whole conversation.
   */
  private silenceConversation(
    state: RunCallState,
    owner: string,
    madeIn: string | null,
  ): void {
    const inScope = (callId: string): boolean =>
      madeIn === null || state.threads.get(callId)?.madeIn === madeIn;
    for (const callId of untoldResults(state, owner)) {
      const entry = state.pendingAsync.get(callId);
      if (entry && inScope(callId)) {
        entry.told = true;
      }
    }
    // The transcript promised each continue; it says why it will not come.
    const calledOff = (instant: number, stopped: readonly WakeResult[]) => {
      this.noteResetWakeCalledOff({
        runId: state.runId,
        state,
        owner,
        instant,
        ids: stopped.map((call) => call.callId),
        why: 'because the call it was for was cancelled',
      });
    };
    const split = (calls: readonly WakeResult[]) => ({
      stopped: calls.filter((call) => inScope(call.callId)),
      kept: calls.filter((call) => !inScope(call.callId)),
    });
    let dropped = false;
    for (const [instant, wake] of state.resetWakes) {
      const { stopped, kept } = split(wake.owners.get(owner) ?? []);
      if (stopped.length === 0) {
        continue;
      }
      if (kept.length > 0) {
        wake.owners.set(owner, kept);
      } else {
        wake.owners.delete(owner);
      }
      dropped = true;
      calledOff(instant, stopped);
      if (wake.owners.size === 0) {
        clearTimeout(wake.timer);
        state.resetWakes.delete(instant);
      }
    }
    if (dropped) {
      this.saveResetWakes(state.runId);
    }
    const fired = state.pendingResetDeliveries.get(owner);
    if (fired !== undefined) {
      const left: PendingResetDelivery[] = [];
      for (const delivery of fired) {
        const { stopped, kept } = split(delivery.calls);
        if (stopped.length > 0) {
          calledOff(delivery.instant, stopped);
        }
        if (kept.length > 0) {
          left.push({ ...delivery, calls: kept });
        }
      }
      if (left.length > 0) {
        state.pendingResetDeliveries.set(owner, left);
      } else {
        state.pendingResetDeliveries.delete(owner);
      }
    }
  }

  /**
   * Hand the USER's `userMessage` — typed into the call's block — to a HELD
   * call: its callee's turn is over, so the message cannot join it; it opens
   * the next one instead, inside the same call. True when the call was held
   * and is now being woken with it. (The caller's `message_agent` reaches a
   * held call through `messageAgent` instead.)
   *
   * Without this the message would sit unread until the calls it waits on
   * finished.
   */
  messageHeldCall(runId: string, callId: string, userMessage: string): boolean {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (
      !state ||
      !call ||
      call.hold === null ||
      call.failReason !== null ||
      state.capability.isCancelled()
    ) {
      return false;
    }
    this.wakeHeldWithMessages(state, call, [], userMessage);
    return true;
  }

  /**
   * Wake a held call with what was said to it: the caller's messages queued on
   * it first, then `callerMessages`, then the user's `userMessage` — in the
   * order they were sent, so none overtakes one queued before it. The caller's
   * keep a pending receipt until the CLI takes the wake prompt; the user's row
   * belongs to its sender.
   */
  private wakeHeldWithMessages(
    state: RunCallState,
    call: ActiveCall,
    callerMessages: readonly string[],
    userMessage: string | null,
  ): void {
    const fromCaller = [...call.pendingMessages.splice(0), ...callerMessages];
    call.wakingMessages.push(...fromCaller);
    this.releaseHold(
      call,
      heldWake(
        [],
        [],
        openSubCalls(state, calleeKeyOf(call)).length,
        [...fromCaller, ...(userMessage !== null ? [userMessage] : [])].join(
          '\n\n',
        ),
        this.unreadLine(state, calleeKeyOf(call)),
      ),
    );
  }

  /**
   * The message_agent tool: hand the caller's message to one of ITS running
   * calls, into the turn the callee is working in.
   *
   * A caller that learned something mid-call had two moves, and both were
   * wrong for the commonest case: wait for the call to finish (so the callee
   * goes on building the thing the correction is about), or cancel it and
   * re-dispatch (paying for everything it had already done correctly). A
   * continuation with `thread` is refused while the call runs (THREAD_BUSY).
   * REPORTED on a Dev Team run where a Manager held the user's corrections in
   * a queue "until the engineer finishes" six times, for 8–32 minutes each —
   * and once the engineer finished by shipping the very version the user had
   * just objected to, which cost a second call to redo.
   *
   * Ownership is `cancelAgent`'s: a call the asker does not own reads as
   * UNKNOWN_CALL. A PARKED callee is waiting on the caller's answer, and a
   * message there would sit behind a question nobody is answering — so it is
   * sent to `answer_agent` instead. The result still arrives as the call's own.
   */
  messageAgent(
    runId: string,
    /** WHO is asking — a caller key, as `callAgent` takes one. */
    caller: string,
    args: { call_id: string; message: string },
  ): CallEnvelope {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const call = state.activeCalls.get(args.call_id);
    if (!call || call.owner !== caller) {
      const refusal = this.unknownCall(
        state,
        caller,
        args.call_id,
        'live call',
      );
      const thread =
        state.pendingAsync.get(args.call_id) ?? state.threads.get(args.call_id);
      if (thread?.owner === caller && refusal.status === 'error') {
        this.recordUndeliveredMessage(
          state,
          args.call_id,
          caller,
          thread.calleeId,
          args.message,
          refusal.error,
        );
      }
      return refusal;
    }
    if (call.failReason !== null || state.capability.isCancelled()) {
      const reason = call.failReason ?? 'RUN_CANCELLED: the team was stopped';
      this.recordUndeliveredMessage(
        state,
        args.call_id,
        caller,
        call.calleeId,
        args.message,
        reason,
      );
      return { status: 'error', error: `NOT_DELIVERED: ${reason}` };
    }
    // The callee has FINISHED and only the executor's bookkeeping holds the
    // call open: no turn is left to take the message, and holding it would
    // only see it dropped as undelivered a moment later.
    if (isFinishedWork(state, call)) {
      const refusal = this.finishedCall(
        state,
        caller,
        args.call_id,
        call.calleeId,
        false,
      );
      if (refusal.status === 'error') {
        this.recordUndeliveredMessage(
          state,
          args.call_id,
          caller,
          call.calleeId,
          args.message,
          refusal.error,
        );
      }
      return refusal;
    }
    const agent = this.calleeName(state, call.owner, call.calleeId);
    if (call.parked) {
      this.recordUndeliveredMessage(
        state,
        args.call_id,
        caller,
        call.calleeId,
        args.message,
        `CALLEE_PARKED: ${agent} is waiting for answer_agent`,
      );
      return {
        status: 'error',
        error: `CALLEE_PARKED: ${agent} is waiting on your answer to its question in '${args.call_id}' — reply with answer_agent instead`,
      };
    }
    // A call held for its callee's own calls has no turn to join: the message
    // opens the next one, with anything queued ahead of it in front.
    if (call.hold !== null) {
      this.wakeHeldWithMessages(state, call, [args.message], null);
      return {
        status: 'ok',
        result: {
          call_id: args.call_id,
          agent: call.calleeId,
          state: 'queued',
          note: `${agent} had ended its turn to wait for calls of its own; it is continued with your message now. Delivery is pending until that turn takes the prompt. Its answer arrives as this call's result.`,
        },
      };
    }
    // Behind an earlier message still waiting, or not takeable yet: held on
    // the call and delivered in order (PENDING_MESSAGE_RETRY_MS). Never
    // overtakes one queued before it.
    const outcome =
      call.pendingMessages.length > 0
        ? null
        : state.capability.messageCallee(args.call_id, args.message);
    if (outcome === null || !outcome.delivered) {
      call.pendingMessages.push(args.message);
      this.scheduleMessageRetry(runId, args.call_id, call);
      return {
        status: 'ok',
        result: {
          call_id: args.call_id,
          agent: call.calleeId,
          state: 'queued',
          note: `${agent} cannot take a message this moment (its turn is still starting, or it is between steps). geniro holds it and delivers it as soon as ${agent} can — do NOT send it again. If the call ends first, the message is marked not delivered and you are told at your next turn; continue with thread: '${args.call_id}' then.`,
        },
      };
    }
    this.recordDeliveredMessage(
      state,
      args.call_id,
      call,
      args.message,
      outcome.deliveryId,
    );
    return {
      status: 'ok',
      result: {
        call_id: args.call_id,
        agent: call.calleeId,
        state: 'delivered',
        note: outcome.interrupts
          ? `${agent}'s CLI replaces the step in flight with a new message: it stopped what it was doing and continues from yours. Its answer arrives as this call's result.`
          : `${agent} reads it at its next tool boundary and carries on in the same turn. Its answer arrives as this call's result.`,
      },
    };
  }

  /**
   * A message_agent message that reached the callee: row, and a fresh silence
   * window. `followUpId` is the id it rode into the turn with, kept on the row
   * so a drop's "not delivered" row can retract it (`markMessageDropped`).
   */
  private recordDeliveredMessage(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
    message: string,
    followUpId?: string,
  ): void {
    this.noteCalleeActivity(state.runId, callId);
    state.capability.persistItem(
      callerNodeOf(call.owner),
      'call_answer',
      null,
      {
        callId,
        callerNodeId: callerNodeOf(call.owner),
        ...(callerConversationOf(call.owner) !== null
          ? { callerConversationId: callerConversationOf(call.owner) }
          : {}),
        calleeNodeId: call.calleeId,
        message,
        outcome: 'message',
        // TWIN PARSER: `apps/ui/src/renderer/chats/not-sent-messages.ts`
        // pairs this with the `followUpId` of a later "not delivered" row and
        // draws only that one. Rename it there too.
        ...(followUpId !== undefined ? { followUpId } : {}),
      },
    );
  }

  confirmWakingMessages(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (
      !state ||
      !call ||
      call.failReason !== null ||
      state.capability.isCancelled()
    ) {
      return;
    }
    for (const message of call.wakingMessages.splice(0)) {
      this.recordDeliveredMessage(state, callId, call, message);
    }
  }

  /**
   * A `message_agent` message the callee's turn accepted (recorded delivered)
   * but dropped because the turn ended before its agent took it. Recorded
   * undelivered so the caller is told at its next turn, the same as one the
   * call ended before. Its row carries `followUpId`, the id the "delivered"
   * row was written with, so the transcript shows the message once, as not
   * delivered.
   */
  markMessageDropped(
    runId: string,
    callId: string,
    message: string,
    followUpId: string,
  ): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call) {
      return;
    }
    this.recordUndeliveredMessage(
      state,
      callId,
      call.owner,
      call.calleeId,
      message,
      "The callee's turn ended before it took the message.",
      followUpId,
    );
  }

  private recordUndeliveredMessage(
    state: RunCallState,
    callId: string,
    caller: string,
    calleeMemberId: string,
    message: string,
    reason: string,
    followUpId?: string,
  ): void {
    const conversation = callerConversationOf(caller);
    const failure: MessageDeliveryFailure = {
      deliveryId: randomUUID(),
      callId,
      callerNodeId: callerNodeOf(caller),
      ...(conversation !== null ? { callerConversationId: conversation } : {}),
      calleeNodeId: calleeMemberId,
      message,
      reason,
    };
    state.capability.persistItem(failure.callerNodeId, 'call_answer', null, {
      ...failure,
      outcome: 'undelivered',
      ...(followUpId !== undefined ? { followUpId } : {}),
    });
    state.messageFailures.set(failure.deliveryId, failure);
  }

  messageDeliveryNotice(
    runId: string,
    caller: string,
  ): {
    ids: string[];
    prompt: string;
  } | null {
    const state = this.runs.get(runId);
    if (!state) {
      return null;
    }
    const failures = [...state.messageFailures.values()].filter(
      (failure) =>
        callerKey(
          failure.callerNodeId,
          failure.callerConversationId ?? null,
        ) === caller,
    );
    if (failures.length === 0) {
      return null;
    }
    const messages = failures
      .map(
        (failure) =>
          `Not delivered to ${failure.calleeNodeId} (${failure.callId}): ${failure.reason}\nMessage: ${JSON.stringify(failure.message)}`,
      )
      .join('\n\n');
    return {
      ids: failures.map((failure) => failure.deliveryId),
      prompt: `Delivery receipts for your earlier message_agent sends:\n${messages}\nThese messages did not reach the callee. Reassess its result before continuing the conversation.`,
    };
  }

  acknowledgeMessageDeliveryNotice(
    runId: string,
    caller: string,
    notice: { ids: string[]; prompt: string },
  ): void {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }
    const acknowledged = notice.ids.filter((id) => {
      const failure = state.messageFailures.get(id);
      return (
        failure !== undefined &&
        callerKey(
          failure.callerNodeId,
          failure.callerConversationId ?? null,
        ) === caller
      );
    });
    if (acknowledged.length === 0) {
      return;
    }
    state.capability.persistItem(callerNodeOf(caller), 'system', null, {
      severity: 'info',
      ...inAnsweredCall(state, caller),
      message: notice.prompt,
      messageDeliveryNotices: acknowledged,
    });
    for (const id of acknowledged) {
      state.messageFailures.delete(id);
    }
  }

  private scheduleMessageRetry(
    runId: string,
    callId: string,
    call: ActiveCall,
  ): void {
    if (call.messageRetry !== null) {
      return;
    }
    call.messageRetry = setTimeout(() => {
      call.messageRetry = null;
      this.deliverPendingMessages(runId, callId);
    }, PENDING_MESSAGE_RETRY_MS);
    call.messageRetry.unref?.();
  }

  /** Offer the held messages again, oldest first, stopping at the first refusal. */
  private deliverPendingMessages(runId: string, callId: string): void {
    // Re-read, never captured: the run or the call may be gone by now.
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call) {
      return;
    }
    if (call.failReason !== null || state.capability.isCancelled()) {
      this.dropPendingMessages(state, callId, call);
      return;
    }
    // Queued while the turn was ending, and the call is now HELD: no turn will
    // take them until one is opened for them.
    if (call.hold !== null && call.pendingMessages.length > 0) {
      this.wakeHeldWithMessages(state, call, [], null);
      return;
    }
    // A parked callee is blocked on its caller's answer; the messages wait
    // behind it rather than being written into a turn that cannot read them.
    for (;;) {
      const message = call.pendingMessages[0];
      if (message === undefined || call.parked !== null) {
        break;
      }
      const outcome = state.capability.messageCallee(callId, message);
      if (!outcome.delivered) {
        break;
      }
      call.pendingMessages.shift();
      this.recordDeliveredMessage(
        state,
        callId,
        call,
        message,
        outcome.deliveryId,
      );
    }
    if (call.pendingMessages.length > 0) {
      this.scheduleMessageRetry(runId, callId, call);
    }
  }

  /**
   * The caller's messages still queued on `callId`, taken now to open the
   * turn that continues a woken HELD call. Between the wake and that turn the call has no
   * turn to take them, so without this they would wait for the retry to land
   * in it mid-turn, behind anything the user sent meanwhile.
   */
  takeQueuedMessages(runId: string, callId: string): string[] {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call || call.pendingMessages.length === 0) {
      return [];
    }
    if (call.failReason !== null || state.capability.isCancelled()) {
      this.dropPendingMessages(state, callId, call);
      return [];
    }
    if (call.messageRetry !== null) {
      clearTimeout(call.messageRetry);
      call.messageRetry = null;
    }
    const taken = call.pendingMessages.splice(0);
    call.wakingMessages.push(...taken);
    return taken;
  }

  /**
   * The call ended with messages still held: stop offering them and say so in
   * the transcript, so a correction that never landed is not read as one the
   * callee ignored.
   */
  private dropPendingMessages(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): void {
    if (call.messageRetry !== null) {
      clearTimeout(call.messageRetry);
      call.messageRetry = null;
    }
    for (const message of [...call.wakingMessages, ...call.pendingMessages]) {
      this.recordUndeliveredMessage(
        state,
        callId,
        call.owner,
        call.calleeId,
        message,
        call.failReason ??
          'The callee ended before the message could be delivered.',
      );
    }
    call.pendingMessages = [];
    call.wakingMessages = [];
  }

  /**
   * The answer_agent tool (M4): deliver the caller's answer into its parked
   * callee turn. Ownership is per caller member — a callee child can never
   * answer a question it did not cause its own callee to raise.
   */
  answerAgent(
    runId: string,
    /** WHO is answering — a caller key, as `callAgent` takes one. */
    caller: string,
    args: { call_id: string; answer: string },
  ): CallEnvelope {
    const state = this.runs.get(runId);
    if (!state) {
      return RUN_NOT_ACTIVE;
    }
    const call = state.activeCalls.get(args.call_id);
    if (!call || call.owner !== caller) {
      return this.unknownCall(state, caller, args.call_id, 'live call');
    }
    const parked = call.parked;
    if (!parked) {
      return {
        status: 'error',
        error: `NO_QUESTION: call '${args.call_id}' has no outstanding question (already answered, or still running)`,
      };
    }
    this.unpark(state, args.call_id, call);
    // The callee is working again — its silence window, stood down while it
    // waited on this answer, starts over from here.
    this.armSilenceWatch(runId, args.call_id, call);
    if (!parked.deliver(args.answer)) {
      // The question row must not dangle unresolved in the transcript even
      // when the callee died under it.
      state.capability.persistItem(
        callerNodeOf(call.owner),
        'call_answer',
        null,
        {
          callId: args.call_id,
          callerNodeId: callerNodeOf(caller),
          calleeNodeId: call.calleeId,
          outcome: 'undelivered',
        },
      );
      return {
        status: 'error',
        error:
          'DELIVERY_FAILED: the callee turn ended before the answer arrived',
      };
    }
    state.capability.persistItem(
      callerNodeOf(call.owner),
      'call_answer',
      null,
      {
        callId: args.call_id,
        callerNodeId: callerNodeOf(caller),
        calleeNodeId: call.calleeId,
        answer: args.answer,
        outcome: 'answered',
      },
    );
    return {
      status: 'ok',
      result: { call_id: args.call_id, state: 'answered' },
    };
  }

  /**
   * Park a callee's mid-turn question (M4): the executor's capture seam calls
   * this instead of tracking a renderer approval. False when the call is
   * unknown/settled or already parked — the executor then denies the request
   * so the callee continues instead of hanging.
   */
  parkQuestion(
    runId: string,
    callId: string,
    input: ParkQuestionInput,
  ): boolean {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call || call.parked) {
      return false;
    }
    const ttlMs = input.ttlMs ?? QUESTION_TTL_MS;
    call.parked = {
      question: input.question,
      options: input.options,
      // Armed below, so a question parked while its owner is blocked on a
      // card of its own starts suspended rather than counting down toward a
      // caller that cannot answer.
      timer: null,
      ttlMs,
      deliver: input.deliver,
      fail: input.fail,
      ownerTold: false,
      envelopeDelivered: false,
    };
    this.rearmQuestionTtl(runId, callId);
    // The callee is now waiting on ITS caller, so it cannot answer the
    // questions its own callees park — theirs wait with it.
    this.blockOwner(state, calleeKeyOf(call), parkBlocker(callId));
    // A parked callee emits nothing by construction — it is waiting on its
    // caller — so its silence window stands down exactly as it does behind an
    // approval card, and restarts when the answer lands.
    if (call.silence !== null) {
      call.silence.clear();
      call.silence = null;
    }
    state.capability.persistItem(
      callerNodeOf(call.owner),
      'call_question',
      null,
      {
        callId,
        callerNodeId: callerNodeOf(call.owner),
        calleeNodeId: call.calleeId,
        question: input.question,
        options: input.options,
        payload: input.payload,
      },
    );
    // A fire-and-forget caller never sees envelopes, so nobody can ever
    // answer_agent this question: orphan NOW instead of grinding through the
    // TTL with the run held open (the question row above still shows what was
    // asked).
    if (call.mode === 'fire_and_forget') {
      this.orphan(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
      );
      return true;
    }
    // A sync call that parks becomes await_agent-collectable — its caller got
    // the question envelope in place of the final result.
    makeCollectable(state, callId, call);
    // A caller whose turns have all ENDED is woken with the question rather
    // than having its callee killed under it. Orphaning here is what made a
    // team "stop in the middle without any error": a Manager said "I'll
    // report back" and ended its turn, its Engineer then asked something, and
    // the Engineer was cancelled while the run closed as completed. It is
    // orphaned only when there is no turn left to give the caller.
    const ownerLive = state.capability.isNodeLive(call.owner);
    if (!ownerLive && !this.wakeOwner(runId, state, call.owner, [callId], [])) {
      this.orphan(
        state,
        callId,
        call,
        'QUESTION_ORPHANED: no live caller can answer this question',
      );
      return true;
    }
    if (!this.handToWaiter(state, callId, call) && ownerLive) {
      this.tellWorkingOwner(state, call.owner, callId);
    }
    return true;
  }

  /**
   * Put a freshly parked question in front of a caller that is BLOCKED on one
   * of its calls: a wait on this call first, else a wait on any other call the
   * same caller owns. A caller blocked in await_agent on call-5 cannot read a
   * message, so a question from call-7 that waited for an await on call-7
   * reached nobody and timed out. The interrupted call stays collectable.
   */
  private handToWaiter(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): boolean {
    const envelope = questionEnvelope(callId, call);
    if (notifyWaiters(call, envelope)) {
      markEnvelopeDelivered(call);
      return true;
    }
    for (const [otherId, other] of state.activeCalls) {
      if (otherId === callId || other.owner !== call.owner) {
        continue;
      }
      if (notifyWaiters(other, { ...envelope, still_running: otherId })) {
        markEnvelopeDelivered(call);
        makeCollectable(state, otherId, other);
        return true;
      }
    }
    return false;
  }

  /**
   * A caller that is working but waiting on none of its calls — running its
   * own tools, or thinking — is handed the question inside its running turn,
   * where its CLI can take a message without interrupting (otherwise its next
   * wait delivers it — see `waitForOutcome`). `ownerTold` stays false: a
   * message joining a turn at its next tool boundary is not an observed
   * delivery, so a caller that ends without answering still earns the one wake
   * `drainCaller` gives.
   */
  private tellWorkingOwner(
    state: RunCallState,
    owner: string,
    callId: string,
  ): void {
    const call = state.activeCalls.get(callId);
    if (!call?.parked) {
      return;
    }
    const asked: WakeQuestion = {
      callId,
      callee: this.calleeName(state, owner, call.calleeId),
      question: call.parked.question,
      options: call.parked.options,
    };
    if (
      !state.capability.tellLiveNode(
        owner,
        wakePrompt([asked], [], true, this.unreadLine(state, owner)),
      )
    ) {
      return;
    }
    state.capability.persistItem(callerNodeOf(owner), 'system', null, {
      severity: 'info',
      ...inAnsweredCall(state, owner),
      message: `Passed ${asked.callee}'s question in ${callId} to this agent while it was working.`,
    });
  }

  /**
   * A caller member's LAST live turn has settled (the executor calls this next
   * to its approval sweep): wake it ONCE with whatever it left open — the
   * questions its callees are blocked on, and the async results nothing has
   * collected — so the conversation it started can finish.
   *
   * It used to fail the questions outright as QUESTION_ORPHANED, on the
   * reasoning that a settled caller can never answer_agent. It can now: a wake
   * is another turn of that caller's own conversation. A question it was
   * ALREADY woken for, and ended again without answering, is orphaned as
   * before — with a row that says so — which bounds this to one wake apiece.
   */
  drainCaller(
    runId: string,
    /**
     * The CONVERSATION whose turn ended — a caller key. The executor drains
     * each conversation as its own turn ends, so a member's own conversation and
     * each call it serves are drained apart.
     */
    caller: string,
  ): void {
    const state = this.runs.get(runId);
    if (!state) {
      return;
    }
    // Its cards went with its turn (the executor sweeps them beside this
    // call), so nothing blocks it any more — and a blocker left over here would
    // keep every question it is woken with suspended for good.
    state.blockedOwners.delete(caller);
    this.reportBlocked(state, caller);
    this.drainWhenFree(runId, state, caller);
  }

  /**
   * The drain itself, once the conversation has no call on it — run now, or
   * as soon as the call that holds it has settled.
   *
   * A CALLEE conversation's turn IS a call, and that call is still settling
   * when its turn ends; a conversation can also hold a call that has not got
   * its turn yet (queued under the active-turn cap, or waking the run). It can be
   * continued (see `startOwnerTurn`) only once that call has settled, so the
   * drain waits for exactly that — and re-checks then, since a further call may
   * have taken the conversation meanwhile.
   */
  private drainWhenFree(
    runId: string,
    state: RunCallState,
    caller: string,
  ): void {
    const answering = callInConversation(state, caller);
    if (answering !== undefined) {
      // Once per conversation: a second turn-end arriving while one drain is
      // already waiting (a continuation opened and ended meanwhile) would run
      // the drain twice, and the second pass would orphan the very question
      // the first had just woken the conversation for.
      if (!state.deferredDrains.has(caller)) {
        state.deferredDrains.add(caller);
        void answering.settled.then(() => {
          state.deferredDrains.delete(caller);
          const current = this.runs.get(runId);
          if (current !== undefined) {
            this.drainWhenFree(runId, current, caller);
          }
        });
      }
      return;
    }
    const questions: string[] = [];
    for (const [callId, call] of state.activeCalls) {
      if (call.owner !== caller || !call.parked) {
        continue;
      }
      if (call.parked.ownerTold) {
        this.orphan(
          state,
          callId,
          call,
          'QUESTION_ORPHANED: the calling agent ended before answering',
        );
        continue;
      }
      questions.push(callId);
    }
    // A result is WAITING once its call has settled — one still running is
    // reported by `noteCalleeSettling` when it lands instead.
    const results = untoldResults(state, caller);
    if (questions.length === 0 && results.length === 0) {
      return;
    }
    if (this.wakeOwner(runId, state, caller, questions, results)) {
      return;
    }
    for (const callId of questions) {
      const call = state.activeCalls.get(callId);
      if (call) {
        this.orphan(
          state,
          callId,
          call,
          'QUESTION_ORPHANED: the calling agent ended before answering',
        );
      }
    }
  }

  /**
   * A callee's turn is settling. If its result is owed to a caller whose turns
   * have all ENDED — an async call, or a sync one that parked and so became
   * collectable — wake that caller to collect it.
   *
   * The half `drainCaller` cannot cover: that runs when the CALLER ends, and a
   * callee still working at that moment has no result to report yet. A Manager
   * that launches an Engineer, says "I'll report back" and ends its turn is
   * exactly this case — without it the Engineer's work lands in a result
   * nothing ever collects, and the run closes as though the work were done.
   *
   * Called by the executor from the callee's own settle bookkeeping, BEFORE the
   * turn stops holding the run open, so the wake is counted before the run can
   * decide it has finished.
   */
  noteCalleeSettling(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    const entry = state?.pendingAsync.get(callId);
    if (!state || !call || !entry || entry.told) {
      return;
    }
    // A live caller is told inside its running turn; one that then ends
    // without collecting is woken by `drainCaller`.
    if (state.capability.isNodeLive(call.owner)) {
      this.tellWorkingOwnerFinished(state, call.owner, callId, call);
      return;
    }
    this.wakeOwner(runId, state, call.owner, [], [callId]);
  }

  /**
   * A caller that is WORKING when its async call settles is told so inside
   * its running turn — the result twin of `tellWorkingOwner`.
   *
   * A live caller used to be told nothing, on the reasoning that it collects
   * the result itself. It does only if it happens to wait: a caller that is
   * busy elsewhere goes on believing the call runs. REPORTED (run `82dd8617`,
   * call-74): the Engineer finished while the Manager sat on its user's
   * question card, and the Manager then steered the finished call with
   * message_agent and was refused. Told here, the note reaches it at its next
   * tool boundary — the card's answer, in that run.
   *
   * Not while it waits on calls of its own: that wait is how it learns, and
   * a note would only repeat what the wait hands it. `told` stays false, as
   * `tellWorkingOwner` leaves `ownerTold`: a message joining a turn is not an
   * observed collection, so a caller that ends without collecting still earns
   * the one wake `drainCaller` gives. A CLI whose message would interrupt the
   * turn is not told at all (`tellLiveNode` refuses it).
   */
  private tellWorkingOwnerFinished(
    state: RunCallState,
    owner: string,
    callId: string,
    call: ActiveCall,
  ): void {
    if ((state.waitingOwners.get(owner) ?? 0) > 0) {
      return;
    }
    const finished: WakeResult = {
      callId,
      callee: this.calleeName(state, owner, call.calleeId),
    };
    if (
      !state.capability.tellLiveNode(
        owner,
        wakePrompt([], [finished], true, this.unreadLine(state, owner)),
      )
    ) {
      return;
    }
    state.capability.persistItem(callerNodeOf(owner), 'system', null, {
      severity: 'info',
      ...inAnsweredCall(state, owner),
      message: `Told this agent that ${finished.callee} finished ${callId} while it was working.`,
    });
  }

  /**
   * Wake `owner` when the usage window that stopped `callId` reopens.
   *
   * A rate-limited call is the one failure whose cure is only TIME, and nothing
   * in the run kept that time: the caller was told when the limit resets and
   * left to wake itself. REPORTED on a Dev Team run — the Manager ran `sleep
   * 5300` in a background shell to do it, and the team sat idle 2h23m. So the
   * broker keeps the clock. Calls stopped by the same reset share ONE timer and
   * one wake per caller. False when the sentence names no exact instant, or one
   * too far out to wait on — the caller then keeps the envelope's sentence.
   */
  private scheduleResetWake(
    runId: string,
    state: RunCallState,
    owner: string,
    callId: string,
    calleeId: string,
    resetsAt: string,
  ): boolean {
    const instant = resetInstantFrom(resetsAt, new Date());
    if (instant === null) {
      return false;
    }
    const delay = instant + RESET_WAKE_GRACE_MS - Date.now();
    if (delay > MAX_RESET_WAIT_MS) {
      return false;
    }
    const call: WakeResult = {
      callId,
      callee: this.calleeName(state, owner, calleeId),
    };
    const continuesAt = instant + RESET_WAKE_GRACE_MS;
    const existing = state.resetWakes.get(instant);
    if (existing) {
      existing.owners.set(owner, [...(existing.owners.get(owner) ?? []), call]);
    } else {
      state.resetWakes.set(instant, {
        timer: this.armResetWake(runId, instant, delay),
        owners: new Map([[owner, [call]]]),
        resetsAt,
        continuesAt,
      });
    }
    this.saveResetWakes(runId);
    // SAID, in the caller's transcript, the moment it is promised — before this
    // the caller was told and the user was not, so a team idle for hours read
    // as stuck with nothing on screen explaining it.
    state.capability.persistItem(callerNodeOf(owner), 'system', null, {
      severity: 'info',
      message: `${callId} stopped at the usage limit — geniro continues it when the limit resets (${resetsAt}).`,
      resetWake: {
        phase: 'scheduled',
        instant,
        continuesAt,
        callIds: [callId],
      },
    });
    return true;
  }

  /** The one timer a promised continue fires on — never what keeps us alive. */
  private armResetWake(
    runId: string,
    instant: number,
    delay: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => this.fireResetWake(runId, instant),
      Math.max(0, delay),
    );
    timer.unref?.();
    return timer;
  }

  /** The run's promised continues, wherever they are held right now. */
  private resetWakesOf(runId: string): Map<number, ResetWake> | undefined {
    return this.runs.get(runId)?.resetWakes ?? this.restoredWakes.get(runId);
  }

  /** Write the run's promised continues to its row — the whole list. */
  private saveResetWakes(runId: string): void {
    const wakes = this.resetWakesOf(runId);
    this.resetWakeHooks?.save(
      runId,
      [...(wakes ?? new Map<number, ResetWake>())].map(([instant, wake]) =>
        persistedWake(instant, wake),
      ),
    );
  }

  /** Install what lets a promised continue survive the daemon. */
  useResetWakeHooks(hooks: ResetWakeHooks): void {
    this.resetWakeHooks = hooks;
  }

  /**
   * Arm again the continues a run's row says were promised before a restart.
   *
   * A run a pass has already registered holds its own — nothing is added
   * there. A reset that passed while the daemon was down fires at once.
   */
  restoreResetWakes(runId: string, wakes: readonly PersistedResetWake[]): void {
    if (this.runs.has(runId) || wakes.length === 0) {
      return;
    }
    const held = this.restoredWakes.get(runId) ?? new Map<number, ResetWake>();
    for (const wake of wakes) {
      if (held.has(wake.instant)) {
        continue;
      }
      held.set(wake.instant, {
        timer: this.armResetWake(
          runId,
          wake.instant,
          wake.continuesAt - Date.now(),
        ),
        owners: new Map(
          wake.owners.map((owner) => [owner.owner, [...owner.calls]]),
        ),
        resetsAt: wake.resetsAt,
        continuesAt: wake.continuesAt,
      });
    }
    this.restoredWakes.set(runId, held);
  }

  /**
   * Call off every continue promised to this run — the user's own press, for a
   * team they would rather pick up themselves. Answers the calls that will NOT
   * be continued; nothing for a run holding no promise.
   */
  cancelResetWakes(runId: string): string[] {
    const wakes = this.resetWakesOf(runId);
    const state = this.runs.get(runId);
    // Continues that already fired and wait for their conversation's call are
    // still promised (`hasPendingResetWake`), so they are called off as well.
    const fired = state?.pendingResetDeliveries;
    if ((wakes?.size ?? 0) === 0 && (fired?.size ?? 0) === 0) {
      return [];
    }
    const cancelled: string[] = [];
    const owners = new Set<string>();
    const calledOff = (owner: string, instant: number, ids: string[]) => {
      owners.add(owner);
      cancelled.push(...ids);
      this.noteResetWakeCalledOff({
        runId,
        state,
        owner,
        instant,
        ids,
        why: null,
      });
    };
    for (const [instant, wake] of wakes ?? []) {
      clearTimeout(wake.timer);
      for (const [owner, calls] of wake.owners) {
        calledOff(
          owner,
          instant,
          calls.map((call) => call.callId),
        );
      }
    }
    for (const [owner, deliveries] of fired ?? []) {
      for (const delivery of deliveries) {
        calledOff(
          owner,
          delivery.instant,
          delivery.calls.map((call) => call.callId),
        );
      }
    }
    fired?.clear();
    if (wakes !== undefined && wakes.size > 0) {
      wakes.clear();
      this.saveResetWakes(runId);
    }
    // A call held only for one of these continues has nothing left to wait for.
    if (state !== undefined) {
      for (const owner of owners) {
        const held = heldCallOf(state, owner);
        if (held !== undefined) {
          this.reviewHold(runId, state, held[0], held[1]);
        }
      }
    }
    return cancelled;
  }

  /**
   * The transcript row closing a promised usage-limit continue that will not
   * come — `why` says what called it off, absent when the user did.
   */
  private noteResetWakeCalledOff({
    runId,
    state,
    owner,
    instant,
    ids,
    why,
  }: {
    runId: string;
    state: RunCallState | undefined;
    owner: string;
    instant: number;
    ids: readonly string[];
    why: string | null;
  }): void {
    const payload = {
      severity: 'info',
      message: `The continue of ${ids.join(', ')} at the usage-limit reset was called off${why !== null ? ` ${why}` : ''} — send this agent a message when you want it picked up.`,
      resetWake: { phase: 'cancelled', instant, callIds: [...ids] },
    };
    if (state !== undefined) {
      state.capability.persistItem(
        callerNodeOf(owner),
        'system',
        null,
        payload,
      );
    } else {
      this.resetWakeHooks?.note(runId, callerNodeOf(owner), payload);
    }
  }

  /**
   * The window has reopened: start each caller again with its stopped calls —
   * or, when it is working right now, hand it the news inside its turn.
   * Nothing for a run that has since been torn down or cancelled.
   *
   * The state is the run's CURRENT one, read at fire time rather than the one
   * the call settled in: a pass started meanwhile registered its own, and only
   * that one's capability reaches the live agents — the previous pass's would
   * wake a member through a walk that is over. Nor is it checked against the
   * captured state: that identity check would bail on every reset that
   * outlives a pass, and the caller told to wait for it would never hear.
   */
  private fireResetWake(runId: string, instant: number): void {
    const state = this.runs.get(runId);
    if (state === undefined) {
      // No pass since the daemon started: a promise read back off the row.
      // Nothing here can reach an agent, so the executor starts a pass for it.
      const restored = this.restoredWakes.get(runId);
      const wake = restored?.get(instant);
      restored?.delete(instant);
      if (restored === undefined || wake === undefined) {
        return;
      }
      if (restored.size === 0) {
        this.restoredWakes.delete(runId);
      }
      this.resetWakeHooks?.save(
        runId,
        [...restored].map(([at, held]) => persistedWake(at, held)),
      );
      this.resetWakeHooks?.wakeRestoredRun(runId, persistedWake(instant, wake));
      return;
    }
    const wake = state.resetWakes.get(instant);
    state.resetWakes.delete(instant);
    if (wake === undefined) {
      return;
    }
    // Written off the row whatever happens next: a promise that fires is kept
    // or broken HERE, and a cancelled run keeps none.
    this.saveResetWakes(runId);
    if (state.capability.isCancelled()) {
      return;
    }
    for (const [owner, calls] of wake.owners) {
      this.deliverResetWake(runId, owner, calls, wake.resetsAt, instant);
    }
  }

  /**
   * Tell one owner its usage limit has reset — inside its running turn, by a
   * turn of its own, or, when its conversation's call is not free yet (queued,
   * or its turn ending and not held yet), queued as owed work and delivered
   * inside that call once it is held, or when it settles
   * (`pendingResetDeliveries`). The run is re-read each time, for
   * `fireResetWake`'s reason.
   */
  private deliverResetWake(
    runId: string,
    owner: string,
    calls: readonly WakeResult[],
    resetsAt: string,
    instant: number,
  ): void {
    const state = this.runs.get(runId);
    if (state === undefined || state.capability.isCancelled()) {
      return;
    }
    // Every branch below sends this one text, so the unread line rides all.
    const unread = this.unreadLine(state, owner);
    const news = resetWakePrompt(resetsAt, calls);
    const prompt = unread === null ? news : `${news}\n\n${unread}`;
    const held = heldCallOf(state, owner);
    let told = false;
    if (held !== undefined) {
      this.releaseHold(
        held[1],
        heldWake([], [], openSubCalls(state, owner).length, prompt),
      );
      told = true;
    } else {
      const live = state.capability.isNodeLive(owner);
      if (live) {
        // A turn that ends before taking it was told nothing: the reset is
        // delivered afresh once that turn has ended.
        told = state.capability.tellLiveNode(owner, prompt, () =>
          this.deliverResetWake(runId, owner, calls, resetsAt, instant),
        );
      }
      // A live conversation that could not be told is one whose turn is
      // ending with its call not held yet — waited for like a queued call.
      const started = told
        ? null
        : live
          ? callInConversation(state, owner) !== undefined
            ? 'deferred'
            : null
          : this.startOwnerTurn(runId, state, owner, prompt);
      if (started === 'deferred') {
        // Its call may be held before it settles — the news then belongs
        // inside it (`holdCall` delivers it), and until then it is owed.
        const pending = state.pendingResetDeliveries.get(owner) ?? [];
        pending.push({ calls, resetsAt, instant });
        state.pendingResetDeliveries.set(owner, pending);
        void callInConversation(state, owner)?.settled.then(() =>
          this.deliverPendingResets(runId, owner),
        );
        return;
      }
      told ||= started !== null;
    }
    const ids = calls.map((call) => call.callId).join(', ');
    state.capability.persistItem(callerNodeOf(owner), 'system', null, {
      severity: 'info',
      // Inside the held call's block, as every row of the turn it opens is.
      ...(held !== undefined ? { callId: held[0] } : {}),
      message: told
        ? `The usage limit reset (${resetsAt}) — told this agent to continue ${ids}.`
        : `The usage limit reset (${resetsAt}), but this agent could not be reached to continue ${ids} — send it a message to pick them up.`,
      resetWake: {
        phase: told ? 'fired' : 'unreachable',
        instant,
        callIds: calls.map((call) => call.callId),
      },
    });
  }

  /**
   * Deliver the resets that fired while `owner`'s conversation had a call not
   * yet free — now that the call is held or has settled. Taken off the queue
   * first, so a delivery that defers again queues itself afresh.
   */
  private deliverPendingResets(runId: string, owner: string): void {
    const state = this.runs.get(runId);
    const pending = state?.pendingResetDeliveries.get(owner);
    if (state === undefined || pending === undefined) {
      return;
    }
    state.pendingResetDeliveries.delete(owner);
    for (const { calls, resetsAt, instant } of pending) {
      this.deliverResetWake(runId, owner, calls, resetsAt, instant);
    }
  }

  /**
   * Start another turn for `owner` carrying what it left open, marking each
   * item told so it is never woken for twice, and saying in its transcript why
   * it is talking again. False when the run cannot take a turn (cancelled,
   * finished) — the caller then falls back to what it did before wakes existed.
   */
  private wakeOwner(
    runId: string,
    state: RunCallState,
    owner: string,
    questions: readonly string[],
    results: readonly string[],
  ): boolean {
    // A conversation whose own call is HELD is waiting for exactly this: it is
    // continued inside that call, never as a new one — a new call would defer
    // to the held one, which is waiting for it, and neither would settle.
    const held = heldCallOf(state, owner);
    if (held !== undefined) {
      this.reviewHold(runId, state, held[0], held[1]);
      return true;
    }
    const { asked, finished } = this.wakeItems(
      state,
      owner,
      questions,
      results,
    );
    if (asked.length === 0 && finished.length === 0) {
      return false;
    }
    const started = this.startOwnerTurn(
      runId,
      state,
      owner,
      wakePrompt(asked, finished, false, this.unreadLine(state, owner)),
    );
    if (started === null) {
      return false;
    }
    if (started === 'deferred') {
      // The conversation has a call waiting to run: nothing is told yet, so
      // nothing is marked told. That call's turn meets the items at its first
      // wait, and the drain scheduled here — once it has settled — wakes the
      // conversation for whatever is still open, including when the call is
      // stopped before it ever ran. Handled, so nothing is orphaned meanwhile.
      this.drainWhenFree(runId, state, owner);
      return true;
    }
    this.markTold(runId, state, owner, asked, finished, started.callId);
    return true;
  }

  /** The questions and results a wake would tell `owner` about, as it names them. */
  private wakeItems(
    state: RunCallState,
    owner: string,
    questions: readonly string[],
    results: readonly string[],
  ): { asked: WakeQuestion[]; finished: WakeResult[] } {
    const asked = questions.flatMap((callId): WakeQuestion[] => {
      const call = state.activeCalls.get(callId);
      return call?.parked
        ? [
            {
              callId,
              callee: this.calleeName(state, owner, call.calleeId),
              question: call.parked.question,
              options: call.parked.options,
            },
          ]
        : [];
    });
    const finished = results.flatMap((callId): WakeResult[] => {
      const entry = state.pendingAsync.get(callId);
      return entry
        ? [{ callId, callee: this.calleeName(state, owner, entry.calleeId) }]
        : [];
    });
    return { asked, finished };
  }

  /**
   * A wake went out: mark each item told so it is never woken for twice, and
   * say in the transcript why the agent is talking again — inside `callId`'s
   * block when the turn it opens is that call's.
   */
  private markTold(
    runId: string,
    state: RunCallState,
    owner: string,
    asked: readonly WakeQuestion[],
    finished: readonly WakeResult[],
    callId: string | null,
  ): void {
    for (const item of asked) {
      const parked = state.activeCalls.get(item.callId)?.parked;
      if (parked) {
        parked.ownerTold = true;
      }
      // Its window counts from the moment the caller is TOLD, as it does for
      // a question first seen through await_agent.
      this.rearmQuestionTtl(runId, item.callId);
    }
    for (const item of finished) {
      const entry = state.pendingAsync.get(item.callId);
      if (entry) {
        entry.told = true;
      }
    }
    state.capability.persistItem(callerNodeOf(owner), 'system', null, {
      severity: 'info',
      ...wakeNotice(asked, finished),
      ...(callId !== null ? { callId } : {}),
    });
  }

  /**
   * The callee of `callId` ended a COMPLETED turn: hold the call open while the
   * calls it made from inside it are still running, rather than letting it
   * settle on an answer that is not its last. Null when the conversation is
   * owed nothing — the call settles now.
   *
   * A call is the callee's whole job, and the calls it makes are part of that
   * job: Manager → Engineer → Middle, where the Engineer delegates and ends its
   * turn, is not an Engineer that has finished.
   *
   * Held, the call waits; when the last of those calls settles (or one parks a
   * question) the callee is continued inside THIS call
   * ({@link CallHoldRelease} `wake`) and the call settles on that turn's
   * answer. A fire-and-forget call holds nothing: nobody collects it.
   */
  holdCall(runId: string, callId: string): Promise<CallHoldRelease> | null {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call || call.hold !== null) {
      return null;
    }
    const key = calleeKeyOf(call);
    // A question it was already woken for, and ended again without answering,
    // is orphaned — `drainWhenFree`'s rule, which bounds a wake to one apiece.
    for (const [subId, sub] of state.activeCalls) {
      if (sub.owner === key && sub.parked?.ownerTold) {
        this.orphan(
          state,
          subId,
          sub,
          'QUESTION_ORPHANED: the calling agent ended before answering',
        );
      }
    }
    if (!owesHold(state, call)) {
      return null;
    }
    const open = openSubCalls(state, key).length;
    const released = new Promise<CallHoldRelease>((resolve) => {
      call.hold = { release: resolve };
    });
    call.everHeld = true;
    // Nothing of the callee's own can arrive while it waits, so its silence
    // window would be timing the calls it is waiting on — which have their own.
    if (call.silence !== null) {
      call.silence.clear();
      call.silence = null;
    }
    if (open > 0) {
      const callee = this.calleeName(state, call.owner, call.calleeId);
      // TWIN PARSER: `apps/ui/src/renderer/chats/transcript-groups.ts` folds
      // `heldCall` rows into the call block's `heldOn` reading by `callId`.
      state.capability.persistItem(call.calleeId, 'system', null, {
        callId,
        severity: 'info',
        heldCall: { waitingOn: open },
        message: `${callee} ended its turn with ${open} call(s) it started still running. This call stays open until they finish, and ${callee} is continued here to finish its answer.`,
      });
    }
    call.reportedWaitingOn = open;
    this.reviewHold(runId, state, callId, call);
    // A reset that fired while this turn was ending is news for this hold.
    if (call.hold !== null) {
      this.deliverPendingResets(runId, key);
    }
    // Monitor output that waited for this turn to end can wake the hold now.
    if (call.hold !== null) {
      state.capability.callHeld?.(key);
    }
    return released;
  }

  /**
   * Whether a held call can be let go yet: when one of its conversation's
   * calls is asking, or none is still running. Called whenever one of them
   * settles or parks — through {@link wakeOwner}, which a held conversation
   * routes here — and once as the hold begins.
   */
  private reviewHold(
    runId: string,
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): void {
    if (call.hold === null) {
      return;
    }
    const key = calleeKeyOf(call);
    const open = openSubCalls(state, key);
    const questions = open
      .filter(([, sub]) => sub.parked !== null && !sub.parked.ownerTold)
      .map(([subId]) => subId);
    if (questions.length === 0 && open.length > 0) {
      if (open.length !== call.reportedWaitingOn) {
        call.reportedWaitingOn = open.length;
        // TWIN PARSER: `apps/ui/src/renderer/chats/transcript-groups.ts` — a
        // `heldCall` row with no `message` only updates the card's count, and
        // draws nothing.
        state.capability.persistItem(call.calleeId, 'system', null, {
          callId,
          heldCall: { waitingOn: open.length },
        });
      }
      return;
    }
    const { asked, finished } = this.wakeItems(
      state,
      key,
      questions,
      untoldResults(state, key),
    );
    if (asked.length === 0 && finished.length === 0) {
      // A call stopped by a usage limit is continued when the limit resets
      // (`deliverResetWake`), which wakes this hold rather than settling it;
      // one whose monitors still run is woken by their output
      // (`wakeHeldCallee`).
      if (
        !hasPendingResetWake(state, key) &&
        state.capability.monitorsOwed?.(key) !== true
      ) {
        this.releaseHold(call, { kind: 'settle' });
      }
      return;
    }
    this.markTold(runId, state, key, asked, finished, callId);
    this.releaseHold(
      call,
      heldWake(
        asked,
        finished,
        open.length - asked.length,
        null,
        this.unreadLine(state, key),
      ),
    );
  }

  /**
   * Continue a held callee inside its call with its monitors' output.
   * `pending` while its call is still open but not yet held — its turn is
   * ending, and the hold says so when it begins (`callHeld`); `refused` once
   * the conversation answers no open call.
   */
  wakeHeldCallee(
    runId: string,
    caller: string,
    prompt: string,
    row: HostRowWire,
  ): 'woken' | 'pending' | 'refused' {
    const state = this.runs.get(runId);
    if (state === undefined) {
      return 'refused';
    }
    const held = heldCallOf(state, caller);
    if (held === undefined) {
      return callEntryInConversation(state, caller) === undefined
        ? 'refused'
        : 'pending';
    }
    const [callId, call] = held;
    state.capability.persistItem(call.calleeId, 'system', null, {
      ...row,
      callId,
    });
    this.releaseHold(call, {
      kind: 'wake',
      prompt,
      note: HELD_MONITOR_NOTE,
      monitor: true,
    });
    return 'woken';
  }

  /** A held callee's monitor ended unannounced: settle the call if nothing else is owed. */
  reviewHeldCallee(runId: string, caller: string): void {
    const state = this.runs.get(runId);
    const held = state === undefined ? undefined : heldCallOf(state, caller);
    if (state !== undefined && held !== undefined) {
      this.reviewHold(runId, state, held[0], held[1]);
    }
  }

  /** Let a held call go — the ONE way out of a hold. */
  private releaseHold(call: ActiveCall, release: CallHoldRelease): void {
    const hold = call.hold;
    if (hold === null) {
      return;
    }
    call.hold = null;
    // A wake opens a new turn of the callee, which a cancel can stop again.
    if (release.kind === 'wake') {
      call.turnEnded = false;
    }
    hold.release(release);
  }

  /**
   * Let every held call of a run go as cancelled — the run is stopping, and a
   * held call has no turn the run's cancel could reach.
   */
  releaseHolds(runId: string): void {
    for (const call of this.runs.get(runId)?.activeCalls.values() ?? []) {
      this.releaseHold(call, { kind: 'cancelled' });
    }
  }

  /**
   * Whether `callId`'s callee conversation is still owed work a hold would
   * wait for — see {@link holdCall} — or was when a cancel was accepted for it
   * (`ActiveCall.cancelledOwing`): the cancel silences that work, so a stopped
   * call asked only now would read as finished.
   */
  owesWork(runId: string, callId: string): boolean {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    return (
      state !== undefined &&
      call !== undefined &&
      (call.cancelledOwing || owesHold(state, call))
    );
  }

  /**
   * How many calls `callId`'s callee made from inside it are still running —
   * what a call settled past its wake limit tells its caller.
   */
  openSubCallCount(runId: string, callId: string): number {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    return state && call ? openSubCalls(state, calleeKeyOf(call)).length : 0;
  }

  /**
   * Start `owner` talking again with `prompt` — or null when that cannot be
   * done. The call id is the call that now carries the turn, when it is one.
   *
   * A member's OWN conversation is woken by the executor, as another turn of it.
   * A CALLEE conversation has no turn of its own outside the calls it answers,
   * and waking the MEMBER instead would open a turn in the member's own
   * conversation, in a new process with none of the callee's context, whose
   * identity owns none of the calls it is being told about — so whatever it
   * then did would reach nobody: with Manager → Engineer → Researcher, all
   * async, the Manager would never get the research.
   *
   * So the conversation is continued the one way a callee conversation ever
   * is: as a new call on it, made on behalf of the caller of the call it last
   * answered, with `prompt` as the message. The callee picks up in its own
   * conversation, as the caller that owns what it is told about, and its
   * answer is that caller's to collect — which wakes the caller in turn when
   * it has ended, on exactly the path any finished call takes.
   */
  private startOwnerTurn(
    runId: string,
    state: RunCallState,
    owner: string,
    prompt: string,
  ): { callId: string | null } | 'deferred' | null {
    const conversationId = callerConversationOf(owner);
    if (conversationId === null) {
      return state.capability.wakeNode(owner, prompt) ? { callId: null } : null;
    }
    // A call already on the conversation that is not LIVE (this runs only for
    // an owner that is not): queued under the active-turn cap, or waking the run.
    // Continuing the conversation beside it is THREAD_BUSY, and reading that as
    // "nobody can be reached" orphaned a question — and killed its callee — a
    // moment before a turn of this very conversation was due to run.
    if (callInConversation(state, owner) !== undefined) {
      return 'deferred';
    }
    // The newest point of the conversation that can be RESUMED. The newest
    // record alone can have no session — a continuation stopped before it ever
    // ran — and continuing from it is THREAD_UNAVAILABLE, which lost the very
    // result this wake exists to deliver.
    const memberId = callerNodeOf(owner);
    let last: [string, ThreadRecord] | undefined;
    for (const entry of state.threads) {
      if (
        entry[1].conversationId === conversationId &&
        entry[1].calleeId === memberId &&
        entry[1].sessionId !== null
      ) {
        last = entry;
      }
    }
    if (last === undefined) {
      return null;
    }
    const [lastCallId, record] = last;
    const opened = this.openCall(runId, state, record.owner, {
      agent: record.calleeId,
      message: prompt,
      thread: lastCallId,
      mode: 'async',
      title: PICKED_BACK_UP_TITLE,
      wake: true,
    });
    if ('refused' in opened) {
      // The run is stopping, superseded, or out of call turns or depth — the
      // conversation cannot be continued, and the caller falls back.
      return null;
    }
    return { callId: opened.callId };
  }

  /**
   * Which pool member a call runs on, and the members it may be handed to.
   *
   * A continued thread starts on the member holding its session, unless
   * `conversationStartMember` moves it — back to an earlier member whose limit
   * has reset, or off one a limit spent; a move or a fallback carries its
   * history into a fresh session. A new conversation starts with the first
   * available member in pool order, with members that recently failed on a
   * limit or a sign-in moved to the back, and may fall through to every
   * member after the one it starts on. The member a caller asked for
   * (`preferred`: `requested`, else the one the thread was asked for) only
   * comes first in that order; it never stops a hand-on. A callee with no
   * pool runs as itself, planless.
   */
  private selectPoolMember(
    site: PoolSite,
    callee: TeamMember,
    requested: number | null,
    preferred: number | null,
    threadMember: number | null,
    holdsWork: () => boolean,
  ):
    | { refused: CallEnvelope }
    | { node: TeamMember; plan: CalleePoolPlan | null } {
    const size = poolSize(callee);
    const refuse = (error: string): { refused: CallEnvelope } => ({
      refused: { status: 'error', error },
    });
    if (requested !== null && poolMemberNode(callee, requested) === null) {
      return refuse(
        size === 1
          ? `UNKNOWN_MEMBER: '${callee.id}' has no agent pool — call it without a member`
          : `UNKNOWN_MEMBER: '${callee.id}' has pool members 1–${size}, not ${requested}`,
      );
    }
    // A session belongs to the member that opened it; resuming it as any other
    // would hand a CLI a session id it has never seen.
    if (
      threadMember !== null &&
      poolMemberNode(callee, threadMember) === null
    ) {
      return refuse(
        `THREAD_UNAVAILABLE: that thread ran on pool member ${threadMember} of '${callee.id}', which its pool no longer has — start a new conversation`,
      );
    }
    if (size === 1) {
      return { node: callee, plan: null };
    }
    const pool = this.poolCooldowns.order(callee, site);
    const wanted =
      preferred !== null && poolMemberNode(callee, preferred) !== null
        ? preferred
        : null;
    const order = preferredAttemptOrder(pool.order, pool.standings, wanted);
    const first =
      threadMember === null
        ? order[0]!
        : conversationStartMember({
            standings: pool.standings,
            proven: pool.proven,
            order,
            held: threadMember,
            hasSession: true,
            holdsWork: holdsWork(),
            preferred: wanted,
          });
    return {
      node: poolMemberNode(callee, first)!,
      plan: {
        member: first,
        fallbacks: poolAttempts(
          callee,
          order.filter((member) => member !== first),
        ),
        sessionMember: threadMember,
        preferred: wanted,
      },
    };
  }

  /**
   * Orphan a parked question — and say so in the caller's transcript, since a
   * callee cancelled under its own question is otherwise a stop with no error
   * anywhere. The result is marked told as well: the caller has had its
   * chance, and a turn spent only to report this orphaning back would be noise.
   */
  private orphan(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
    reason: string,
  ): void {
    const entry = state.pendingAsync.get(callId);
    if (entry) {
      entry.told = true;
    }
    state.capability.persistItem(callerNodeOf(call.owner), 'system', null, {
      message: `${this.calleeName(state, call.owner, call.calleeId)} was stopped: it asked a question in ${callId} and no turn of this agent was left to answer it.`,
    });
    this.failParked(state, callId, call, reason, 'orphaned');
  }

  /** A callee by the name its caller knows it by, else its member id. */
  private calleeName(
    state: RunCallState,
    owner: string,
    calleeId: string,
  ): string {
    return (
      state.capability.calleesOf
        .get(callerNodeOf(owner))
        ?.find((member) => member.id === calleeId)?.name ?? calleeId
    );
  }

  /**
   * Unpark-and-fail, exactly once: clear the parked state FIRST so a
   * re-entrant deliver/expire cannot double-settle, stamp the typed reason
   * the settled chain surfaces instead of CALLEE_CANCELLED, persist the
   * resolution row, then cancel the parked turn.
   */
  private failParked(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
    reason: string,
    outcome: 'timeout' | 'orphaned',
  ): void {
    const parked = this.unpark(state, callId, call);
    if (!parked) {
      return;
    }
    call.failReason = reason;
    state.capability.persistItem(
      callerNodeOf(call.owner),
      'call_answer',
      null,
      {
        callId,
        callerNodeId: callerNodeOf(call.owner),
        calleeNodeId: call.calleeId,
        outcome,
      },
    );
    parked.fail();
  }

  /**
   * Resolve with the call's FINAL envelope — or divert early with a
   * `question` envelope the moment the callee parks. `settled` is the
   * fallback for calls that already left `activeCalls`.
   */
  private unseeQuestion(state: RunCallState, callId: string): void {
    const parked = state.activeCalls.get(callId)?.parked;
    if (parked) {
      parked.envelopeDelivered = false;
    }
  }

  /**
   * One waiter on a call: its question the moment one parks, else its final
   * envelope. No handoffs — the caller decides those.
   */
  private listen(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
    lease: WaitLease,
  ): Promise<CallEnvelope> {
    const call = state.activeCalls.get(callId);
    if (!call) {
      return settled;
    }
    return new Promise((resolve) => {
      let done = false;
      const once = (envelope: CallEnvelope): boolean => {
        if (done) {
          return false;
        }
        done = true;
        resolve(envelope);
        return true;
      };
      call.questionWaiters.push(once);
      void call.settled.then(once);
      lease.release = () => {
        done = true;
        const at = call.questionWaiters.indexOf(once);
        if (at !== -1) {
          call.questionWaiters.splice(at, 1);
        }
      };
    });
  }

  private waitForOutcome(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
    lease?: WaitLease,
  ): Promise<CallEnvelope> {
    const ready = this.readyOutcome(state, callId, settled);
    if (ready !== null) {
      return ready;
    }
    const call = state.activeCalls.get(callId)!;
    return new Promise((resolve) => {
      let done = false;
      const once = (envelope: CallEnvelope): boolean => {
        if (done) {
          return false;
        }
        done = true;
        resolve(envelope);
        return true;
      };
      call.questionWaiters.push(once);
      void call.settled.then(once);
      if (lease) {
        lease.release = () => {
          done = true;
          const at = call.questionWaiters.indexOf(once);
          if (at !== -1) {
            call.questionWaiters.splice(at, 1);
          }
        };
      }
    });
  }

  /**
   * What a collection of `callId` can be handed WITHOUT waiting, decided
   * synchronously — or null when there is nothing yet and it has to wait.
   *
   * Its own step, taken BEFORE {@link whileWaiting}, because a user message
   * releases a WAIT and must never stand in front of an answer that already
   * exists. Reconstructed on run `bd1e43ae`: a Researcher finished `call-32` at
   * 15:20:27, the Manager was woken for it at 15:20:39 in the same second the
   * user wrote to it, and its `await_agent(call-32)` five seconds later was
   * answered `pending` — "Your calls are untouched and still running" — because
   * the unread message was checked before the finished result. The wake had
   * been spent, so nothing told the Manager again; it went on reporting the
   * fix as in progress, and a daemon restart then lost the uncollected result.
   * Handing the answer over costs the message nothing: the CLI still takes it
   * at this tool call's boundary, and it stays unread for the next real wait.
   * `awaitAny` makes the same checks inline ahead of its own wait.
   *
   * A call that has left `activeCalls` has SETTLED — the one delete is inside
   * `settled`'s own final callback — so `settled` is already fulfilled and
   * awaiting it waits on nothing.
   */
  private readyOutcome(
    state: RunCallState,
    callId: string,
    settled: Promise<CallEnvelope>,
  ): Promise<CallEnvelope> | null {
    const call = state.activeCalls.get(callId);
    if (!call) {
      return settled;
    }
    if (call.parked) {
      markEnvelopeDelivered(call);
      return Promise.resolve(questionEnvelope(callId, call));
    }
    // A question one of this caller's OTHER calls parked while it was not
    // waiting — between two awaits, or busy with its own tools — is handed to
    // the next wait it starts. Otherwise that wait (routinely a five-minute
    // await on a different call) runs out the question's whole window, which
    // is QUESTION_TIMEOUT on a caller that was never shown the question.
    for (const [otherId, other] of state.activeCalls) {
      if (
        otherId !== callId &&
        other.owner === call.owner &&
        other.parked !== null &&
        !other.parked.envelopeDelivered
      ) {
        markEnvelopeDelivered(other);
        makeCollectable(state, callId, call);
        return Promise.resolve({
          ...questionEnvelope(otherId, other),
          still_running: callId,
        });
      }
    }
    return null;
  }

  /**
   * The callee produced a row — it is demonstrably alive, so restart its
   * silence watchdog.
   *
   * Called from the executor's own callee persist seam, which is the only
   * place that sees a callee's output: the broker launches the turn and then
   * holds a promise, so without this hook its only measurable quantity is
   * total duration — the bound {@link CALL_SILENCE_DEADLINE_MS} exists not to
   * use.
   *
   * A no-op for a call that is settled or unknown, so a row arriving after the
   * result cannot re-arm a clock on a call that is over.
   */
  noteCalleeActivity(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (call) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * The call started or stopped waiting under the run's active-turn cap — the
   * executor says so on both sides of the wait. Its silence window stands down
   * while it waits and is armed afresh once it leaves the queue.
   */
  noteCalleeQueued(runId: string, callId: string, queued: boolean): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.queued = queued;
    this.armSilenceWatch(runId, callId, call);
  }

  /** {@link RunCallCapability.unreadTeamNotes} for one conversation; 0 off-run. */
  unreadTeamNotes(runId: string, caller: string): number {
    return this.runs.get(runId)?.capability.unreadTeamNotes?.(caller) ?? 0;
  }

  currentStage(runId: string): string | null {
    return this.runs.get(runId)?.capability.currentStage?.() ?? null;
  }

  private unreadLine(state: RunCallState, caller: string): string | null {
    const stage = state.capability.currentStage?.() ?? null;
    const lines = [
      stage === null ? null : `[geniro] Current stage: ${stage}.`,
      unreadTeamNotesLine(state.capability.unreadTeamNotes?.(caller) ?? 0),
    ].filter((line): line is string => line !== null);
    return lines.length === 0 ? null : lines.join('\n');
  }

  /**
   * The call `caller`'s conversation is answering right now, or null when it
   * answers none — a member's own conversation, or a callee carrying on after
   * its call settled.
   */
  callAnsweredBy(runId: string, caller: string): string | null {
    const state = this.runs.get(runId);
    return state ? (callEntryInConversation(state, caller)?.[0] ?? null) : null;
  }

  /**
   * The call a page or button `caller` publishes is named from: the one it
   * answers, else — a callee carrying on after its call settled — the newest
   * call its conversation answered, whose ancestors may still be running
   * (the notes walk up past a settled call). Null for a member's own
   * conversation.
   */
  callToNoteOn(runId: string, caller: string): string | null {
    const answered = this.callAnsweredBy(runId, caller);
    const conversationId = callerConversationOf(caller);
    if (answered !== null || conversationId === null) {
      return answered;
    }
    return this.runs.get(runId)?.newestCallOf.get(conversationId) ?? null;
  }

  /**
   * The ids of the calls recorded on the callee conversation `conversationId`
   * (its first call's id) — the calls whose rows that conversation wrote. A
   * call is recorded once it settles, so the one settling now is not listed.
   */
  recordedCallsOf(runId: string, conversationId: string): string[] {
    const state = this.runs.get(runId);
    return state === undefined
      ? []
      : threadEntriesOf(state, conversationId).map(([callId]) => callId);
  }

  /**
   * A page is being published from call `callId` (the one
   * {@link callToNoteOn} names — possibly settled; the walk goes up past it):
   * record it on that call AND on every call above it still running, so each caller up the chain is told in its envelope — a
   * page a callee of a callee publishes is what the run's root agent has to
   * point the user at.
   *
   * Answers the undo, for a page whose transcript row then could not be
   * written: it puts back what each call named before, unless a newer page
   * replaced this one meanwhile.
   */
  notePublishedArtifact(
    runId: string,
    callId: string,
    page: CallPublishedPage,
  ): () => void {
    // Set on an existing key keeps its place: pages are listed in the order
    // they first appeared, each at its newest version.
    return noteOnCalls(
      this.runningCallsUpFrom(runId, callId).map((call) => call.published),
      page.artifact_id,
      page,
    );
  }

  /**
   * A button is being published, on {@link notePublishedArtifact}'s terms:
   * named before its row is written, with the undo for a row that then fails.
   * It is named on call `callId` (the one {@link callToNoteOn} names —
   * possibly settled, null for none) and every call above it still running, and
   * refreshed on every running call already naming `key`. `key` is its
   * publisher's action key, unique within the run.
   */
  notePublishedAction(
    runId: string,
    callId: string | null,
    key: string,
    action: CallPublishedAction,
  ): () => void {
    const state = this.runs.get(runId);
    if (!state) {
      return () => {};
    }
    const calls = new Set([
      ...(callId === null ? [] : this.runningCallsUpFrom(runId, callId)),
      ...[...state.activeCalls.values()].filter((call) =>
        call.publishedActions.has(key),
      ),
    ]);
    return noteOnCalls(
      [...calls].map((call) => call.publishedActions),
      key,
      action,
    );
  }

  /** A button was removed: no running call's envelope names it now. */
  forgetPublishedAction(runId: string, key: string): void {
    for (const call of this.runs.get(runId)?.activeCalls.values() ?? []) {
      call.publishedActions.delete(key);
    }
  }

  /**
   * Call `callId` and every call above it still running, innermost first. A
   * call that settled already — a fire-and-forget callee outlives the call
   * that launched it — has nobody left to tell, but a call above it may still
   * be running.
   */
  private runningCallsUpFrom(runId: string, callId: string): ActiveCall[] {
    const state = this.runs.get(runId);
    return state ? runningCallsUpFrom(state, callId) : [];
  }

  /**
   * Refuses a call to a member that is waiting on this caller: the owner of
   * any running call in the chain the caller's conversation answers. Its turn
   * is blocked on this caller's answer, so the call could only wait on itself.
   * The refusal names the chain, so the caller knows who waits on it.
   */
  private callUpTheChain(
    state: RunCallState,
    caller: string,
    callee: TeamMember,
  ): string | null {
    const answering = callEntryInConversation(state, caller)?.[0];
    if (answering === undefined) {
      return null;
    }
    const walked = runningCallEntriesUpFrom(state, answering);
    const unheard = walked.findIndex(
      ([, call]) => call.mode === 'fire_and_forget',
    );
    const chain = unheard === -1 ? walked : walked.slice(0, unheard);
    const waiting = chain.find(
      ([, call]) => callerNodeOf(call.owner) === callee.id,
    );
    if (waiting === undefined) {
      return null;
    }
    const nameOf = (id: string): string =>
      state.capability.calleesOf
        .get(callerNodeOf(caller))
        ?.find((member) => member.id === id)?.name ?? id;
    const path = [...chain]
      .reverse()
      .map(([, call]) => nameOf(callerNodeOf(call.owner)))
      .concat('you')
      .join(' → ');
    return `CALL_UP_THE_CHAIN: ${callee.name} is waiting on your answer (${path}; ${waiting[0]}), so calling it now would wait on itself. Answer by finishing this turn — put what you need from ${callee.name} in your reply.`;
  }

  /**
   * The callee's turn has ENDED — its handle settled — though the call stays
   * open while the executor finishes the turn's bookkeeping (see
   * {@link ActiveCall.turnEnded}). Called by the executor at that one seam, which
   * is the only place the moment is visible from: the broker holds a promise
   * that resolves only once the bookkeeping is done.
   */
  noteCalleeTurnEnded(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (call) {
      call.turnEnded = true;
    }
  }

  /**
   * The call's turn ended in a failure its callee's POOL gets past, and the
   * call now runs again on the next member. What the failed attempt left open
   * is not the new one's — an unanswered tool call would keep the silence
   * watchdog suspended for the rest of the call — and the window measures the
   * new attempt from its start.
   */
  noteCalleeHandedOn(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.openToolCalls.clear();
    this.noteCalleeActivity(runId, callId);
  }

  /**
   * An approval card went up for this callee — SUSPEND its silence watchdog
   * until the card is answered.
   *
   * A callee blocked on a verdict emits nothing by construction, so a window
   * that kept running would be timing the person reading the card, and would
   * report "has produced nothing" about a callee doing exactly what it should.
   * `spawn-cli.ts` stands its own silence deadline down for the same reason and
   * on the same reasoning.
   *
   * Called by the executor, which is where a callee's card is raised and where
   * its verdict lands — so no cross-module read is needed to know either.
   */
  noteCalleeBlocked(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.blockedOnVerdicts += 1;
    if (call.silence !== null) {
      call.silence.clear();
      call.silence = null;
    }
  }

  /**
   * A card this callee was blocked on has been answered (or has gone away) —
   * restart the window once the LAST of them is settled.
   *
   * Floors at zero rather than trusting the pairing: the card is gone on every
   * `respond`, delivered or not, and a settle can sweep one that was never
   * answered at all, so an unmatched call here must not drive the count
   * negative and suspend the watchdog for the rest of the call.
   */
  noteCalleeUnblocked(runId: string, callId: string): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.blockedOnVerdicts = Math.max(0, call.blockedOnVerdicts - 1);
    if (call.blockedOnVerdicts === 0) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * The callee started a tool call — SUSPEND its silence watchdog until the
   * tool answers ({@link ActiveCall.openToolCalls}).
   *
   * Called by the executor at the same seam as {@link noteCalleeActivity},
   * which is the only place a callee's tool calls are visible from.
   */
  noteCalleeToolStarted(
    runId: string,
    callId: string,
    toolCallId: string,
  ): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call) {
      return;
    }
    call.openToolCalls.add(toolCallId);
    if (call.silence !== null) {
      call.silence.clear();
      call.silence = null;
    }
  }

  /**
   * A callee's tool call answered — restart the window once the LAST open one
   * has. A result for a call this never saw start changes nothing.
   */
  noteCalleeToolFinished(
    runId: string,
    callId: string,
    toolCallId: string,
  ): void {
    const call = this.runs.get(runId)?.activeCalls.get(callId);
    if (!call?.openToolCalls.delete(toolCallId)) {
      return;
    }
    if (call.openToolCalls.size === 0) {
      this.armSilenceWatch(runId, callId, call);
    }
  }

  /**
   * A card went up for a member — its own AskUserQuestion to the user, or a
   * permission it holds in ask mode — so it cannot answer anything until a
   * person does. Suspend the TTL of every question its callees have parked,
   * and of any they park meanwhile ({@link ParkedQuestion.timer}).
   *
   * Any member, not only the one a pass started: a callee that is itself a caller is
   * blocked by its cards on the same terms.
   *
   * The owner-side twin of {@link noteCalleeBlocked}, called from the same
   * seam: the executor raises the card and receives its verdict, so it knows
   * both moments without a cross-module read. `cardId` names the card, so the
   * same card offered twice is one blocker ({@link RunCallState.blockedOwners}).
   */
  noteCallerBlocked(
    runId: string,
    /** The conversation the card was raised in — a caller key. */
    owner: string,
    cardId: string,
  ): void {
    const state = this.runs.get(runId);
    if (state) {
      this.blockOwner(state, owner, cardId);
    }
  }

  /**
   * A card this member was blocked on has been answered (or has gone away) —
   * once the LAST of its blockers is, every question its callees have parked
   * gets its full window again, counted from now: the member has only now been
   * able to read it.
   *
   * A card it never noted is a no-op rather than an error: a settle sweeps
   * cards that were never answered, and the card is gone on every `respond`,
   * delivered or not.
   */
  noteCallerUnblocked(
    runId: string,
    /** The conversation the card was raised in — a caller key. */
    owner: string,
    cardId: string,
  ): void {
    const state = this.runs.get(runId);
    if (state) {
      this.unblockOwner(state, owner, cardId);
    }
  }

  /** Add one blocker to a member, suspending its callees' questions on the first. */
  private blockOwner(
    state: RunCallState,
    owner: string,
    blocker: string,
  ): void {
    const blockers = state.blockedOwners.get(owner) ?? new Set<string>();
    const wasBlocked = blockers.size > 0;
    blockers.add(blocker);
    state.blockedOwners.set(owner, blockers);
    this.reportBlocked(state, owner);
    if (wasBlocked) {
      return;
    }
    for (const [callId, call] of state.activeCalls) {
      if (call.owner === owner && call.parked) {
        this.rearmQuestionTtl(state.runId, callId);
      }
    }
  }

  /** Remove one blocker; the last one gives its callees' questions full windows. */
  private unblockOwner(
    state: RunCallState,
    owner: string,
    blocker: string,
  ): void {
    const blockers = state.blockedOwners.get(owner);
    if (!blockers?.delete(blocker) || blockers.size > 0) {
      return;
    }
    state.blockedOwners.delete(owner);
    this.reportBlocked(state, owner);
    for (const [callId, call] of state.activeCalls) {
      if (call.owner === owner && call.parked) {
        this.rearmQuestionTtl(state.runId, callId);
      }
    }
  }

  /**
   * Tell the executor when `owner` starts or stops being blocked — inside a
   * wait on its own calls, on its own parked question or on a card — so its
   * turn stops counting against the run's active-turn cap while it can
   * produce nothing. Reported on a change only.
   */
  private reportBlocked(state: RunCallState, owner: string): void {
    const blocked =
      state.waitingOwners.has(owner) || state.blockedOwners.has(owner);
    if (blocked === state.reportedBlocked.has(owner)) {
      return;
    }
    if (blocked) {
      state.reportedBlocked.add(owner);
    } else {
      state.reportedBlocked.delete(owner);
    }
    state.capability.turnBlocked?.(owner, blocked);
  }

  /**
   * Take a parked question down — its clock stopped, and its callee no longer
   * blocked by it — and hand back what was parked, or null when nothing was.
   *
   * The ONE way out of a park, so a new way for a question to end cannot leave
   * the callee blocked with nothing left to release it.
   */
  private unpark(
    state: RunCallState,
    callId: string,
    call: ActiveCall,
  ): ParkedQuestion | null {
    const parked = call.parked;
    if (!parked) {
      return null;
    }
    call.parked = null;
    stopQuestionTimer(parked);
    this.unblockOwner(state, calleeKeyOf(call), parkBlocker(callId));
    return parked;
  }

  /**
   * (Re)arm one call's silence watchdog; each row the callee produces restarts
   * its full window.
   */
  private armSilenceWatch(
    runId: string,
    callId: string,
    call: ActiveCall,
  ): void {
    // A blocked callee stays suspended however many rows arrive: an approval
    // card is itself persisted as a row, so without this the very event that
    // suspends the window would immediately re-arm it. A PARKED one too —
    // waiting on its caller's answer is the same silence.
    // And one waiting on its own tool call, for the same reason: the tool call
    // is persisted as a row too, and it is what starts the wait.
    // And a HELD one: its callee's turn is over and it is waiting on calls of
    // its own, whose silence is theirs to report. And a QUEUED one, whose turn
    // has not begun.
    if (
      call.queued ||
      call.blockedOnVerdicts > 0 ||
      call.parked !== null ||
      call.openToolCalls.size > 0 ||
      call.hold !== null
    ) {
      if (call.silence !== null) {
        call.silence.clear();
        call.silence = null;
      }
      return;
    }
    // Refreshed rather than rebuilt, so the sleep watch's ticker is not
    // stopped and restarted on every row.
    if (call.silence !== null) {
      call.silence.refresh();
      return;
    }
    call.silence = awakeTimeout(() => {
      call.silence = null;
      this.announceStall(runId, callId, call);
    }, CALL_SILENCE_DEADLINE_MS);
  }

  /**
   * Say ONCE, in the caller's own transcript, that its callee has stopped
   * producing — and do nothing else.
   *
   * Not a cancellation: the wait is untouched and the call may still settle
   * normally, which is what keeps `sync` meaning what it meant. A stalled call
   * that recovers simply produces a row, which re-arms the watchdog.
   *
   * The run is re-read from `this.runs` rather than closed over, exactly as
   * {@link expireQuestion} does and for the same reason: a captured state
   * object survives `unregisterRun`, and its `activeCalls` map still holds this
   * id — so the guard would pass and the write would insert an item for a run
   * whose rows the teardown has already purged. `Item.runId` has no foreign
   * key, so such an insert SUCCEEDS and leaves transcript text no route can
   * reach or delete.
   *
   * TWIN PARSER: this payload is read by
   * `apps/ui/src/renderer/chats/transcript-groups.ts` — `CallBlockEntry.stalled`
   * folds it by `stalledCall` + `callId`, and a later callee row for the same
   * call supersedes it. The SENTENCE is rendered by that file's `system` arm in
   * `transcript-item.tsx`, which reads the `message` key and draws nothing when
   * it is absent — so this row's wording lives under `message`, never `text`,
   * and carries `severity: 'info'` because an absent severity resolves to the
   * red failure chrome, which this row is not.
   */
  private announceStall(runId: string, callId: string, call: ActiveCall): void {
    const state = this.runs.get(runId);
    if (call.saidStalled || !state?.activeCalls.has(callId)) {
      return;
    }
    call.saidStalled = true;
    const minutes = Math.round(CALL_SILENCE_DEADLINE_MS / 60_000);
    state.capability.persistItem(callerNodeOf(call.owner), 'system', null, {
      callId,
      callerNodeId: callerNodeOf(call.owner),
      calleeNodeId: call.calleeId,
      stalledCall: true,
      severity: 'info',
      message: `'${call.calleeId}' has produced nothing for ${minutes} minutes. The call is still open — nothing has been cancelled.`,
    });
  }

  /**
   * Restart a parked question's TTL, because the caller has only NOW been
   * handed it — or SUSPEND it, when the caller is blocked on a card of its
   * own and so could not be handed anything ({@link ParkedQuestion.timer}).
   *
   * A no-op for a call that is no longer parked (answered, failed, gone), so a
   * late collection cannot resurrect a clock on a question that is over.
   */
  private rearmQuestionTtl(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    const parked = call?.parked;
    if (!state || !call || !parked) {
      return;
    }
    stopQuestionTimer(parked);
    if ((state.blockedOwners.get(call.owner)?.size ?? 0) > 0) {
      return;
    }
    // Awake time only: nobody can answer while the machine sleeps, so a TTL
    // that ran out during a sleep must not time the question out at the wake.
    parked.timer = awakeTimeout(
      () => this.expireQuestion(runId, callId),
      parked.ttlMs,
    );
  }

  /**
   * The UNKNOWN_CALL refusal — and, for an id from BEFORE the daemon
   * restarted, the reason it is unknown, since "no such call" is exactly what
   * a caller reading its own transcript cannot square: the call is right
   * there. Its result died with that daemon; what survives is the thread,
   * when the callee recorded a session, and the sentence says so.
   *
   * A call the asker DOES own that has already finished is not unknown, and
   * the tools that steer a live call refuse it as CALL_FINISHED instead
   * (`finishedCall`). `caller` is null for `await_agent`, whose refusal of a
   * result already collected is its own exactly-once contract.
   */
  private unknownCall(
    state: RunCallState,
    caller: string | null,
    callId: string,
    what: string,
  ): CallEnvelope {
    const pending = state.pendingAsync.get(callId);
    if (caller !== null && pending?.owner === caller) {
      return this.finishedCall(state, caller, callId, pending.calleeId, false);
    }
    const number = callNumber(callId);
    if (
      number !== null &&
      number <= state.seededCallSeq &&
      !state.activeCalls.has(callId) &&
      !state.pendingAsync.has(callId)
    ) {
      const resumable = (state.threads.get(callId)?.sessionId ?? null) !== null;
      return {
        status: 'error',
        error: `UNKNOWN_CALL: '${callId}' was made before the daemon restarted and its result did not survive — call the agent again${resumable ? ` (thread: '${callId}' continues that conversation)` : ''}`,
      };
    }
    const thread = state.threads.get(callId);
    if (caller !== null && thread?.owner === caller) {
      return this.finishedCall(state, caller, callId, thread.calleeId, true);
    }
    return {
      status: 'error',
      error: `UNKNOWN_CALL: no ${what} '${callId}' started by you`,
    };
  }

  /**
   * The refusal for a call the asker owns that has already FINISHED — what
   * `message_agent`, `cancel_agent` and `answer_agent` meet when the callee
   * ended while the caller was busy elsewhere. It used to read as
   * UNKNOWN_CALL ("no live call 'call-74' started by you") about a call the
   * caller had started minutes earlier and whose result was waiting for it.
   * REPORTED as a Manager that blocked on its user's question card while its
   * Engineer finished, then steered the finished call: the refusal named no
   * cause, and the agent had to guess its way to `await_agent` and a
   * `thread:` continuation (run `82dd8617`, call-74). So the sentence says what
   * happened and both moves that work, in the order they are needed.
   */
  private finishedCall(
    state: RunCallState,
    caller: string,
    callId: string,
    calleeId: string,
    collected: boolean,
  ): CallEnvelope {
    const agent = this.calleeName(state, caller, calleeId);
    // No record yet is a call whose settle is still being written — its
    // session lands with it, so the thread is the move once it is collected.
    const thread = state.threads.get(callId);
    const resumable = thread === undefined || thread.sessionId !== null;
    // "Nothing left to collect" rather than "you collected it": a
    // fire-and-forget call settles here too, and it never had a collector.
    const result = collected
      ? 'nothing of it is left to collect'
      : `its result is waiting — collect it with await_agent(call_id: '${callId}')`;
    const next = resumable
      ? `To say more, continue the conversation with call_agent(thread: '${callId}')`
      : 'It recorded no session to continue, so call the agent again to say more';
    return {
      status: 'error',
      error: `CALL_FINISHED: ${agent} already finished '${callId}' — ${result}. ${next}.`,
    };
  }

  /**
   * Resolve with `promise`, or with {@link ABANDONED} the moment `signal`
   * trips — whichever happens first. A rejection from `promise` REJECTS the
   * returned promise too (never left pending) — `awaitAgent`'s caller needs
   * that to reach the MCP dispatcher's ordinary error mapping instead of
   * hanging forever.
   *
   * The point is the CALLER's side of the race rather than the callee's:
   * nothing here cancels the callee, which goes on working and settles into
   * its own entry exactly as before. All this decides is whether the
   * collection that was waiting is still there to be given the answer.
   */
  private untilAbandoned<TOutcome>(
    signal: AbortSignal | undefined,
    promise: Promise<TOutcome>,
  ): Promise<TOutcome | typeof ABANDONED> {
    if (!signal) {
      return promise;
    }
    if (signal.aborted) {
      return Promise.resolve(ABANDONED);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => resolve(ABANDONED);
      signal.addEventListener('abort', onAbort, { once: true });
      // Both arms must remove the listener before settling — a rejection
      // left it attached, which is otherwise harmless (the promise is
      // already settled) but keeps the signal referencing this closure.
      void promise.then(
        (envelope) => {
          signal.removeEventListener('abort', onAbort);
          resolve(envelope);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * Resolve with `promise`, or with {@link TIMED_OUT} after `timeoutMs` —
   * whichever happens first. No window means no race at all, which is the
   * unbounded wait every caller had before. A rejection from `promise`
   * REJECTS the returned promise too, on the same terms as
   * {@link untilAbandoned}.
   *
   * Nothing here touches the callee, exactly as {@link untilAbandoned} does
   * not: this decides only how long THIS collection stands there. It nests
   * INSIDE the abandonment race rather than beside it because the two answers
   * are not peers — a socket that closed means the answer cannot be delivered
   * at all, which outranks the caller having wanted a shorter wait, and a
   * flat three-way race would let a deadline that fired in the same tick
   * report `pending` into a reply nobody will read.
   */
  private untilDeadline<TOutcome>(
    timeoutMs: number | undefined,
    promise: Promise<TOutcome>,
  ): Promise<TOutcome | typeof TIMED_OUT> {
    if (timeoutMs === undefined) {
      return promise;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      // A deadline is a convenience for the caller, never a reason to keep the
      // daemon alive — the callee's own turn is what holds the run open.
      timer.unref?.();
      void promise.then(
        (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** TTL fired: fail the parked call with the typed question_timeout error. */
  private expireQuestion(runId: string, callId: string): void {
    const state = this.runs.get(runId);
    const call = state?.activeCalls.get(callId);
    if (!state || !call) {
      return;
    }
    this.failParked(
      state,
      callId,
      call,
      'QUESTION_TIMEOUT: the caller never answered the question',
      'timeout',
    );
  }

  /**
   * The caller's own chain depth. A callee CONVERSATION inherits the depth of
   * the call it is answering, read per conversation — taking the deepest live
   * turn of the whole member charged one conversation for another's chain. One
   * with no call live (its kept process calling off-turn) falls back to the
   * member's deepest, and never below 1.
   *
   * A member's OWN conversation keeps the member-wide reading: 0 for a
   * member a pass started, else the deepest live callee turn of that member — which
   * over-counts a member serving calls beside its own turn, the conservative
   * direction for a cap that exists to brake runaway loops.
   */
  private callerDepth(state: RunCallState, caller: string): number {
    const own = callerConversationOf(caller) === null;
    let depth = own ? 0 : 1;
    for (const call of state.activeCalls.values()) {
      if (!own && calleeKeyOf(call) === caller) {
        return call.depth;
      }
      if (call.calleeId === callerNodeOf(caller) && call.depth > depth) {
        depth = call.depth;
      }
    }
    return depth;
  }
}

/**
 * How many of the run's MESSAGE TARGETS (`RunCallCapability.messageTargets`,
 * in their own conversations) are inside a wait on their own calls or in the
 * gap after one — what the run's `awaitingCalls` announces. Only they: the
 * composer asks whether the agents a message goes to are merely waiting, and a
 * callee polling its own callees says nothing about a manager still replying.
 */
function waitingTargets(state: RunCallState): number {
  const targets = state.capability.messageTargets;
  return new Set(
    [...state.waitingOwners.keys(), ...state.waitGaps.keys()].filter(
      (key) =>
        callerConversationOf(key) === null && targets.has(callerNodeOf(key)),
    ),
  ).size;
}

/**
 * The call a callee conversation is answering, or about to answer — any call
 * on it that has not settled, live or still waiting for its turn.
 */
function callInConversation(
  state: RunCallState,
  caller: string,
): ActiveCall | undefined {
  return callEntryInConversation(state, caller)?.[1];
}

/** The running calls from `callId` up the chain it was made in, settled ones skipped. */
function runningCallsUpFrom(state: RunCallState, callId: string): ActiveCall[] {
  return runningCallEntriesUpFrom(state, callId).map(([, call]) => call);
}

function runningCallEntriesUpFrom(
  state: RunCallState,
  callId: string,
): [string, ActiveCall][] {
  const calls: [string, ActiveCall][] = [];
  // `madeIn` cannot loop — a call is made inside one already live — but a
  // walk over shared state stays bounded regardless.
  const seen = new Set<string>();
  let next: string | null = callId;
  while (next !== null && !seen.has(next)) {
    seen.add(next);
    const call = state.activeCalls.get(next);
    if (call) {
      calls.push([next, call]);
      next = call.madeIn;
    } else {
      next = state.settledMadeIn.get(next) ?? null;
    }
  }
  return calls;
}

/** The call a callee conversation is answering, with its id, if any. */
function callEntryInConversation(
  state: RunCallState,
  caller: string,
): [string, ActiveCall] | undefined {
  for (const entry of state.activeCalls) {
    if (calleeKeyOf(entry[1]) === caller) {
      return entry;
    }
  }
  return undefined;
}

/**
 * Files a note about `owner`'s turn inside the call its conversation answers.
 * Call membership places a row by its `callId`, so a note without one is drawn
 * in the run's own flow — REPORTED (run `99ac3def`): a Senior Engineer told
 * mid-call-10 showed up there as a stray block of its own. A member's own
 * conversation answers no call, and its note stays in the run's flow.
 */
function inAnsweredCall(
  state: RunCallState,
  owner: string,
): { callId?: string } {
  const callId = callEntryInConversation(state, owner)?.[0];
  return callId === undefined ? {} : { callId };
}

/** The HELD call a callee conversation is answering, with its id, if any. */
function heldCallOf(
  state: RunCallState,
  caller: string,
): [string, ActiveCall] | undefined {
  const entry = callEntryInConversation(state, caller);
  return entry !== undefined && entry[1].hold !== null ? entry : undefined;
}

/**
 * Whether `call`'s conversation is still owed work a hold would wait for: a
 * call of its own still running, a result it has not been woken for, or a
 * usage-limit continue promised to it.
 */
function owesHold(state: RunCallState, call: ActiveCall): boolean {
  const key = calleeKeyOf(call);
  return (
    openSubCalls(state, key).length > 0 ||
    untoldResults(state, key).length > 0 ||
    hasPendingResetWake(state, key) ||
    state.capability.monitorsOwed?.(key) === true
  );
}

/**
 * Whether `call`'s callee has FINISHED: its turn ended, it is not held and owes
 * nothing a hold would wait for — only the executor's bookkeeping keeps it
 * open. Such work stands: a cancel answers `already_finished` for it, and a
 * cascade passes it by.
 */
function isFinishedWork(state: RunCallState, call: ActiveCall): boolean {
  return call.turnEnded && call.hold === null && !owesHold(state, call);
}

/** Whether a usage-limit continue is promised to `owner`. */
function hasPendingResetWake(state: RunCallState, owner: string): boolean {
  if (state.pendingResetDeliveries.has(owner)) {
    return true;
  }
  for (const wake of state.resetWakes.values()) {
    if (wake.owners.has(owner)) {
      return true;
    }
  }
  return false;
}

/**
 * The calls `owner` made that a held call of its waits for — every one still
 * running except fire-and-forget, whose result nobody collects.
 */
function openSubCalls(
  state: RunCallState,
  owner: string,
): [string, ActiveCall][] {
  return [...state.activeCalls].filter(
    ([, call]) => call.owner === owner && call.mode !== 'fire_and_forget',
  );
}

/** Results `owner` is owed and has not been woken for: settled, uncollected. */
function untoldResults(state: RunCallState, owner: string): string[] {
  return [...state.pendingAsync]
    .filter(
      ([callId, entry]) =>
        entry.owner === owner && !entry.told && !state.activeCalls.has(callId),
    )
    .map(([callId]) => callId);
}

/**
 * The caller key of a call's CALLEE in the conversation the call runs in —
 * what the calls that callee makes from inside it are owned by.
 */
function calleeKeyOf(call: ActiveCall): string {
  return callerKey(call.calleeId, call.conversationId);
}

/**
 * The blocker a callee holds while its question in `callId` waits on its
 * caller — named apart from the executor's card ids, which carry a session key.
 */
function parkBlocker(callId: string): string {
  return `park:${callId}`;
}

/**
 * The window a wait actually gets: the one asked for, capped at the caller's
 * ceiling — and the ceiling alone when none was asked for. Undefined only when
 * neither exists, which is the unbounded wait an in-process caller has.
 */
function boundedWait(
  requested: number | undefined,
  ceiling: number | null,
): number | undefined {
  if (ceiling === null) {
    return requested;
  }
  return requested === undefined ? ceiling : Math.min(requested, ceiling);
}

/** Stop a parked question's clock, whether or not one is running. */
function stopQuestionTimer(parked: ParkedQuestion): void {
  if (parked.timer !== null) {
    parked.timer.clear();
    parked.timer = null;
  }
}

/** Resolve a callee by member id first, then by display name (trimmed). */
function resolveCallee(
  callees: readonly TeamMember[],
  ref: string,
): TeamMember | null {
  const wanted = ref.trim();
  const byId = callees.find((c) => c.id === wanted);
  if (byId) {
    return byId;
  }
  const byName = callees.filter((c) => c.name === wanted);
  // An ambiguous display name must not silently pick a callee.
  return byName.length === 1 ? byName[0]! : null;
}

function markEnvelopeDelivered(call: ActiveCall): void {
  if (call.parked) {
    call.parked.envelopeDelivered = true;
  }
}

/**
 * A call whose wait a question diverted becomes await_agent-collectable: a
 * sync call's result had exactly one collector, and it just went to the
 * question instead.
 */
function makeCollectable(
  state: RunCallState,
  callId: string,
  call: ActiveCall,
): void {
  if (!state.pendingAsync.has(callId)) {
    state.pendingAsync.set(callId, {
      owner: call.owner,
      calleeId: call.calleeId,
      settled: call.settled,
      told: false,
    });
  }
}

/** An envelope stamped with the call it came from, for a wait over several. */
function withCallId(envelope: CallEnvelope, callId: string): CallEnvelope {
  return envelope.status === 'error'
    ? { ...envelope, call_id: callId }
    : envelope;
}

/** Resolve every waiter on `call`; true when at least one was still waiting. */
function notifyWaiters(call: ActiveCall, envelope: CallEnvelope): boolean {
  let delivered = false;
  for (const notify of call.questionWaiters.splice(0)) {
    delivered = notify(envelope) || delivered;
  }
  return delivered;
}

function questionEnvelope(
  callId: string,
  call: ActiveCall,
): Extract<CallEnvelope, { status: 'question' }> {
  return {
    status: 'question',
    call_id: callId,
    agent: call.calleeId,
    question: call.parked?.question ?? '',
    options: call.parked?.options ?? [],
  };
}

/**
 * What a pooled call's envelope adds: which member answered, and which were
 * passed over and why — so a caller can name a member itself next time.
 */
function poolEnvelopeFields(outcome: CalleeTurnOutcome): {
  member?: number;
  pool_skipped?: PoolSkipWire[];
} {
  if (outcome.member === undefined) {
    return {};
  }
  return {
    member: outcome.member,
    ...(outcome.poolSkipped !== undefined && outcome.poolSkipped.length > 0
      ? {
          pool_skipped: outcome.poolSkipped.map((skip) => ({
            member: skip.member,
            failure: skip.failureClass,
            ...(skip.resetsAt !== null ? { resets_at: skip.resetsAt } : {}),
            ...(skip.error !== null ? { error: skip.error } : {}),
          })),
        }
      : {}),
  };
}

/**
 * `text` as a markdown code span that survives the backticks inside it: the
 * fence is one longer than its longest run, padded where the text touches it.
 */
function inlineCode(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((run) => run[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Set `value` at `key` in each call's published map, answering the undo: it
 * puts back what each map held before, unless something newer replaced
 * `value` meanwhile.
 */
function noteOnCalls<T>(
  maps: readonly Map<string, T>[],
  key: string,
  value: T,
): () => void {
  const replaced = maps.map((map) => [map, map.get(key)] as const);
  for (const map of maps) {
    map.set(key, value);
  }
  return () => {
    for (const [map, before] of replaced) {
      if (map.get(key) !== value) {
        continue;
      }
      if (before === undefined) {
        map.delete(key);
      } else {
        map.set(key, before);
      }
    }
  };
}

/** What a call published while it ran, as its envelope names it. */
type CallPublished = Pick<ActiveCall, 'published' | 'publishedActions'>;

function toEnvelope(
  callId: string,
  calleeId: string,
  outcome: CalleeTurnOutcome,
  { published, publishedActions }: CallPublished,
): CallEnvelope {
  if (outcome.status === 'completed') {
    const stillOut = outcome.delegatesStillOut ?? 0;
    const callsOut = outcome.callsStillOut ?? 0;
    const commandsOut = outcome.shellsStillOut?.length ?? 0;
    const quoted = (outcome.shellsStillOut ?? []).flatMap((shell) => {
      const line = shell.command === null ? '' : quotedCommand(shell.command);
      return line === '' ? [] : [{ line, callId: shell.callId }];
    });
    const commands = quoted.map((shell) => shell.line);
    // A command an earlier call on the thread started says so: a server the
    // caller asked for then is not work this call left unfinished.
    const listed = quoted.map(
      (shell) =>
        `${inlineCode(shell.line)}${shell.callId === callId ? '' : ` (started in ${shell.callId})`}`,
    );
    // Said IN the envelope, because the text alone reads as a finished
    // answer — which is exactly how a partial one was taken for done.
    const notes = [
      ...(stillOut > 0
        ? [
            `${calleeId} ended its turn with ${stillOut} sub-agent(s) it launched still working, so this result may be PARTIAL. Continue the conversation (call_agent with thread: '${callId}') to collect what they report.`,
          ]
        : []),
      ...(callsOut > 0
        ? [
            `This call is NOT finished: ${calleeId} ended with ${callsOut} call(s) of its own still running, and this call could not wait for them any longer. Continue the conversation (call_agent with thread: '${callId}') to collect what they report.`,
          ]
        : []),
      ...(commandsOut > 0
        ? [
            // Facts, not orders: a test run still going is as likely as a
            // server the caller asked for, and nothing here tells them apart.
            `${calleeId} answered while ${commandsOut} command(s) it started in the background were still running${listed.length > 0 ? `: ${listed.join('; ')}` : ''}. Its work may not be finished: they keep running after this result, and what they print arrives in its conversation (call_agent with thread: '${callId}'), which is also where it can be asked to stop them.`,
          ]
        : []),
      ...(published.size > 0 ? [PUBLISHED_PAGES_NOTE] : []),
      ...(publishedActions.size > 0 ? [PUBLISHED_ACTIONS_NOTE] : []),
    ];
    const result: CallSettledResult = {
      call_id: callId,
      agent: calleeId,
      ...poolEnvelopeFields(outcome),
      text: outcome.finalText ?? '',
      ...(stillOut > 0 ? { delegates_still_running: stillOut } : {}),
      ...(callsOut > 0 ? { calls_still_running: callsOut } : {}),
      ...(commandsOut > 0 ? { commands_still_running: commandsOut } : {}),
      ...(commands.length > 0 ? { running_commands: commands } : {}),
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
      ...(published.size > 0 ? { artifacts: [...published.values()] } : {}),
      ...(publishedActions.size > 0
        ? { actions: [...publishedActions.values()] }
        : {}),
    };
    return { status: 'ok', result };
  }
  if (outcome.status === 'cancelled') {
    return {
      status: 'error',
      error: 'CALLEE_CANCELLED: the callee turn was cancelled',
    };
  }
  return {
    status: 'error',
    error: calleeFailedEnvelopeError(outcome, callId),
    ...poolEnvelopeFields(outcome),
  };
}

/**
 * A FAILED call's envelope naming the pages and buttons it published before
 * it failed — they stay in the user's chat. A completed call names them in
 * its result ({@link toEnvelope}).
 */
function withPublished(
  envelope: CallEnvelope,
  { published, publishedActions }: CallPublished,
): CallEnvelope {
  if (envelope.status !== 'error') {
    return envelope;
  }
  return {
    ...envelope,
    ...(published.size > 0 ? { artifacts: [...published.values()] } : {}),
    ...(publishedActions.size > 0
      ? { actions: [...publishedActions.values()] }
      : {}),
  };
}

/** A settled call's measured cache facts, as optional `call_result` keys. */
function cacheResultFields(
  cache: ConversationCacheFacts | null,
): Pick<
  CallResultPayload,
  'promptCacheTtlMs' | 'contextTokens' | 'contextWindowTokens'
> {
  if (cache === null) {
    return {};
  }
  const { promptCacheTtlMs, contextTokens, contextWindowTokens } = cache;
  return {
    ...(promptCacheTtlMs !== null ? { promptCacheTtlMs } : {}),
    ...(contextTokens !== null ? { contextTokens } : {}),
    ...(contextWindowTokens !== null ? { contextWindowTokens } : {}),
  };
}

/** Orders `call-N` ids by N; anything else after them, by text. */
function byCallNumber(a: string, b: string): number {
  return (
    (callNumber(a) ?? Number.MAX_SAFE_INTEGER) -
      (callNumber(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b)
  );
}

/**
 * One conversation's cache facts, from those of its calls that ran (recorded a
 * session), in call order. Its lifetime falls back to the one the same callee
 * and pool member last stated in ANY conversation — the reading the nodes route
 * gives the user, so the agent and the badge agree.
 */
function conversationCache(
  state: RunCallState,
  calls: readonly ThreadRecord[],
): ConversationCacheFacts {
  const ran = calls.filter((thread) => thread.sessionId !== null);
  const facts = conversationFacts(ran.map((thread) => thread.cache));
  if (facts.promptCacheTtlMs !== null || ran.length === 0) {
    return facts;
  }
  const { calleeId, member } = ran[0]!;
  let ttl: number | null = null;
  for (const [, thread] of [...state.threads].sort(([a], [b]) =>
    byCallNumber(a, b),
  )) {
    if (thread.calleeId === calleeId && thread.member === member) {
      ttl = thread.cache.promptCacheTtlMs ?? ttl;
    }
  }
  return { ...facts, promptCacheTtlMs: ttl };
}

/** Every recorded call of one conversation, by call id. */
function threadEntriesOf(
  state: RunCallState,
  conversationId: string,
): [string, ThreadRecord][] {
  return [...state.threads.entries()].filter(
    ([, thread]) => thread.conversationId === conversationId,
  );
}

/** Every call of one conversation, in call order. */
function callsOfConversation(
  state: RunCallState,
  conversationId: string,
): ThreadRecord[] {
  return threadEntriesOf(state, conversationId)
    .sort(([a], [b]) => byCallNumber(a, b))
    .map(([, thread]) => thread);
}

/** A cache standing as the listing states it — instants and seconds, never ms. */
function cacheWire(
  standing: PromptCacheStanding,
  now: number,
): Record<string, unknown> {
  if (standing.state === 'warm') {
    return {
      state: 'warm',
      expires_at: new Date(standing.expiresAt).toISOString(),
      expires_in_s: Math.round((standing.expiresAt - now) / 1000),
    };
  }
  if (standing.state === 'expired') {
    return {
      state: 'expired',
      expired_at: new Date(standing.expiredAt).toISOString(),
      expired_s_ago: Math.round((now - standing.expiredAt) / 1000),
    };
  }
  return {
    state: 'unknown',
    note: 'this agent’s CLI reports no prompt-cache lifetime',
  };
}

/** A span as a model reads it best: minutes under two hours, else hours. */
function spanText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

/** The refusal for continuing a cold, large conversation. */
function coldResumeRefusal(
  calleeId: string,
  thread: string,
  facts: ConversationCacheFacts,
): string {
  const standing = promptCacheStanding(facts, Date.now());
  const ago =
    standing.state === 'expired'
      ? ` ${spanText(Date.now() - standing.expiredAt)} ago`
      : '';
  const percent = statedPercent(conversationContextPercent(facts) ?? 0);
  return `CACHE_EXPIRED: the prompt cache of your conversation with '${calleeId}' (thread '${thread}') expired${ago} and its context is ${percent}% full (${facts.contextTokens ?? 0} tokens), so continuing it would re-bill all of that uncached. Start a new instance instead: call_agent without thread, with a self-contained brief of what it needs from the old conversation. Only if that history is worth the cost, call again with resume_cold: true.`;
}
