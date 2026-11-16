import { awakeTimeout, type AwakeTimer } from '../../../../utils/sleep-watch';
import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import { mcpToolName } from '../../utils/mcp-tool-name';
import { delegateDeclarationEvent } from '../../utils/open-delegates';
import type {
  AgentEvent,
  AgentReportedCommand,
  AgentTask,
  AgentTurnInput,
  AgentUsage,
  ApprovalOption,
  ApprovalOptionScope,
  BackgroundUnitOutcome,
  CardQuestion,
  FollowUpMessage,
} from '../adapter.types';
import { approvalOption } from '../utils/approval-options.utils';
import {
  decodeRequestId,
  encodeError,
  encodeNotification,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from '../utils/json-rpc.utils';
import {
  ACP_AGENT_METHODS,
  ACP_CLIENT_METHODS,
  ACP_PROTOCOL_VERSION,
  ACP_STOP_REASONS,
  type AcpContentBlock,
  type AcpImageBlock,
  type AcpMcpServerHttp,
  type AcpMcpToolCall,
  type AcpPermissionOption,
  type AcpPermissionOptionKind,
  type AcpStopReason,
  type AcpToolCall,
  type AcpToolLocation,
  type AcpUsageSnapshot,
} from './acp.types';
import { buildAcpImageBlocks } from './acp-content';
import {
  acpOffersModel,
  readAcpConfigOption,
  readAcpConfigOptions,
  readAcpCurrentModelId,
  readAcpModelConfigId,
  readAcpModels,
} from './acp-models';
import type { AcpSession } from './acp-session';
import {
  ACP_SUBAGENT_SPAWNED,
  ACP_SUBAGENT_STATE_UPDATE,
  launchingCallOf,
  readSubagentEnd,
  readSubagentSpawn,
  subagentOutcome,
} from './acp-subagents';

/** What we sent, so the reply can be routed without a callback map. */
export type PendingKind =
  | 'initialize'
  | 'session'
  /**
   * A `session/load`, kept apart from a `session/new` only so its REFUSAL can be
   * handled: both replies mean the same thing and route to `onSessionReady`, but
   * a load that fails is recoverable (open a fresh session, say the history is
   * gone) while a `session/new` that fails leaves nothing to run the turn on.
   */
  | 'session_load'
  | 'set_mode'
  | 'set_model'
  | 'set_model_parameter'
  | 'prompt';

/**
 * One queued model or parameter frame (`AcpTurnDriver.configSteps`). `send`
 * writes it and answers the request id, or null when nothing went out — the
 * write failed, or the step decided at send time that the model cannot take it.
 */
interface ConfigStep {
  send: (events: AgentEvent[]) => JsonRpcId | null;
}

/** A permission verdict this turn can reach without asking the user. */
export type AutoDecision = 'allow' | 'deny' | null;

/**
 * How ONE agent asks the USER an open-ended question over its own extension
 * method, since baseline ACP has no such call.
 *
 * Supplied by the adapter, never known here: this file is the agent-agnostic
 * protocol client, and the method name, the params shape and the reply shape
 * are all that CLI's own facts. What the driver owns is the LIFECYCLE — park
 * the JSON-RPC id, surface an `approval_request` the daemon's question seam
 * recognises, and answer with the encoder below when a verdict arrives. That
 * split is what lets a second agent's question channel be four values rather
 * than another branch in here.
 *
 * An adapter that declares none keeps the old behaviour: the request is
 * declined in-protocol with `-32601`, which is still the right answer for
 * every OTHER vendor extension.
 */
export interface AcpQuestionProtocol {
  /** The agent→client method that carries a question for the user. */
  method: string;
  /**
   * The name this question is surfaced under — the adapter's own
   * `questionToolName`, which is the ONE discriminator the daemon keys "render
   * a question card" and "never auto-answer this" on. Passing anything else
   * here would surface the question as an ordinary permission request.
   */
  toolName: string;
  /**
   * Whether these params READ as a question. False falls through to the
   * decline path, deliberately: this contract is documented rather than
   * observed live, so a shape that has drifted costs today's behaviour and
   * nothing more — never a turn parked on a card the user cannot answer.
   */
  accepts(params: unknown): boolean;
  /** These params as the user's question card — the adapter's own reading. */
  card(params: unknown): CardQuestion[];
  /** The JSON-RPC result answering it, given the card's verdict. */
  encodeReply(params: unknown, allow: boolean, updatedInput: unknown): unknown;
}

/**
 * What one agent told us about a background sub-agent it launched, normalized.
 *
 * The reading itself belongs to the adapter (the params are that vendor's own
 * shape); what the driver owns is WHEN to ask for it and what to emit.
 */
export interface AcpDelegateFacts {
  /** The launching tool call's id — the anchor everything downstream joins on. */
  id: string;
  label: string | null;
  kind: string | null;
  prompt: string | null;
  model: string | null;
  durationMs: number | null;
}

/** Where one background delegate's OWN conversation can be looked up. */
export interface AcpDelegateRef {
  /** The delegate's own conversation id, as the CLI named it. */
  conversationId: string;
  /** The session's working directory — what the CLI files its state under. */
  cwd: string;
  /** The PARENT session's id, when it is known yet. */
  sessionId: string | null;
  /** Recovery must not accept a previous execution's terminal record. */
  notBeforeMs?: number;
}

/** What is known about a delegate that has no address yet. */
export interface AcpDelegateQuery {
  /** The session's working directory. */
  cwd: string;
  /** The PARENT session's id, when it is known yet. */
  sessionId: string | null;
  /** The brief the delegate was given, verbatim off its announcement. */
  prompt: string;
  /** When it was launched — a record older than this is not its record. */
  launchedAtMs: number;
  /**
   * Conversations already matched to OTHER delegates of this session still
   * out, each with that delegate's brief. A new transcript claimed by one is
   * never handed over; a RESUMED one is, when the brief written into it LAST
   * is no longer its claimant's — the claimant was cut off, and this delegate
   * is the one continuing it.
   */
  claimed: ReadonlyMap<string, string>;
}

/**
 * What a delegate's own record says about it right now: still going, or over —
 * with how it ended where the record says so.
 */
export type AcpDelegateEnding =
  | { state: 'running' }
  | {
      state: 'ended';
      outcome: BackgroundUnitOutcome | null;
      /**
       * The delegate's last words — its report — when the record holds them,
       * else null. Handed to the parent in the wake prompt (see
       * {@link AcpDelegateProtocol.wakePrompt}), because a CLI that never tells
       * its parent a delegate finished never hands over what it said either.
       */
      finalText?: string | null;
      /** Where the whole record can be read, when it is a file. */
      recordPath?: string | null;
    };

/**
 * One background delegate that ended since the parent agent was last told,
 * as {@link AcpDelegateProtocol.wakePrompt} receives it.
 */
export interface AcpEndedDelegate {
  /** The delegate's own description, off its announcement, when it had one. */
  label: string | null;
  /** How it ended; null when its record never turned up or did not say. */
  outcome: BackgroundUnitOutcome | null;
  durationMs: number | null;
  finalText: string | null;
  recordPath: string | null;
}

/**
 * How a background delegate can be seen to END, for a CLI whose wire never
 * says so.
 *
 * The ending is the one lifecycle fact such a CLI withholds, and without a
 * reader for it there are only two closers left, both wrong: the process going
 * (right, but a kept process can outlive the delegates by hours), or the turn
 * ending (a guess — and it guessed "finished" about nine reviewers that were
 * all still working, which rendered nine green checks under a Manager that
 * then had to send the QA back to wait for them).
 *
 * Both are the adapter's, since where a CLI records a delegate is a fact
 * about that CLI. What the session owns is WHEN to look — only while a
 * background delegate is out, and only while the process is alive.
 */
export interface AcpDelegateEndings {
  /**
   * Find the conversation the delegate was given, or null when none can be
   * matched yet — which counts against the watch the way an unreadable record
   * does.
   */
  locate(query: AcpDelegateQuery): Promise<string | null>;
  /**
   * Read the delegate's current state, or null when its record cannot be found
   * or read. Null is "cannot tell", never "over": a session that keeps getting
   * it gives up watching and falls back to closing the delegate with the turn.
   */
  read(ref: AcpDelegateRef): Promise<AcpDelegateEnding | null>;
}

/**
 * How ONE agent reports the background sub-agents it runs, since baseline ACP
 * models a delegation as an ordinary tool call and nothing more.
 *
 * Supplied by the adapter, never known here — the method name, the marker and
 * the params shape are that CLI's facts. What the driver owns is the LIFECYCLE:
 * recognise the launch so the delegate's block can open while it is still
 * working, ANSWER the announcement rather than declining it, and emit both as
 * `subagent_info` events.
 *
 * Answering matters more than it looks. cursor sends its announcement through
 * `connection.extMethod(...).catch(debugLog)` — a request whose outcome it
 * discards — so declining cost the turn nothing and was invisible, which is
 * exactly how every fact the CLI reports about its delegates (the brief, the
 * type, the model, the duration) came to be thrown away for two milestones
 * while the adapter declared the signal did not exist.
 */
export interface AcpDelegateProtocol {
  /** The agent→client method carrying the announcement. */
  method: string;
  /**
   * The `rawInput` entry that marks a tool call as a DELEGATION, so the block
   * can open at launch instead of at completion.
   *
   * A marker rather than a tool name, because an ACP `tool_call` carries no
   * machine name at all — only a human `title`, which cursor formats as
   * `Task: <description>` and so cannot be matched on. Measured on
   * cursor-agent 2026.08.11-e8db854: the launch arrives as
   * `rawInput: {"_toolName":"task"}` and its title is `Task: Subagent task`,
   * the description not yet known.
   */
  launchMarker: { key: string; value: string };
  /**
   * Read the announcement's params, or null when the shape is unrecognized —
   * which falls through to the ordinary decline, on the same reasoning as
   * {@link AcpQuestionProtocol.accepts}: a row built from a payload we could
   * not parse is worse than not having one.
   */
  read(params: unknown): AcpDelegateFacts | null;
  /**
   * The launching tool's own return value is this CLI's ACCOUNTING, not the
   * delegate's report — so it is dropped rather than presented as one.
   *
   * True for cursor, measured: the `task` call completes with
   * `rawOutput: {durationMs, isBackground}` and the delegate's actual findings
   * only ever appear in the MAIN agent's next message. Left in, the block framed
   * that object as `Result from <delegate>` and printed `{"durationMs": 15430,
   * "isBackground": false}` where the reader looks for what the delegate found.
   * The duration is not lost — it rides the announcement, which is where a fact
   * about the delegate belongs.
   *
   * False for a CLI whose delegate reports THROUGH that result (claude's `Task`
   * returns the delegate's own text), where dropping it would discard the answer.
   */
  resultIsBookkeeping: boolean;
  /**
   * `AdapterConfig.subagents.stepsUnavailableReason` — stamped onto every row
   * this protocol emits, so the block that has no thread to open carries the
   * reason with it rather than needing a second lookup.
   */
  stepsUnavailableReason: string | null;
  /**
   * Whether the LAUNCHING call's own return says the delegate goes on running
   * after it — read off that call's `rawOutput`, or null when this CLI says
   * nothing either way.
   *
   * The one fact that separates "the delegation was accepted" from "the work is
   * over", and without it a backgrounded delegate is indistinguishable from a
   * finished one: the call returns in a fifth of a second and carries the same
   * shape either way. MEASURED on cursor-agent 2026.08.11-e8db854 by asking for
   * a background delegate and watching the wire — `tool_call_update` completed
   * at +18.7s with `rawOutput: {durationMs: 203, isBackground: true}`, the turn
   * ended at +22.7s, and the delegate was still asking this client for shell
   * permissions at +89s. The `cursor/task` announcement carries no such field
   * (checked in the CLI's own `sendToolExtensionNotification`, which builds it
   * from the args and the duration alone), so `rawOutput` is the only carrier.
   *
   * This is the condition `cursor-acp.const.ts` wrote down as RE-CHECK IF —
   * "`isBackground: true` is ever seen" — and it has now been seen, on a real
   * thread: ten reviewers launched in the background, each block reading
   * `took 0s` under a green check while every one of them was still working.
   *
   * An adapter that declares none keeps the old reading, which is right for a
   * CLI whose launching call genuinely waits for its delegate.
   */
  readsBackgroundLaunch?: (rawOutput: unknown) => boolean | null;
  /**
   * How a delegate the launching call said is still running can be seen to
   * end — see {@link AcpDelegateEndings}. An adapter that declares none has its
   * background delegates marked untracked when the launching turn completes,
   * because no further observation channel is available.
   */
  endings?: AcpDelegateEndings;
  /**
   * The prompt that tells the parent its background delegates have ENDED, for a
   * CLI that never tells it itself — or undefined, and a turn then settles on
   * its own `end_turn` with its delegates still out, as it always did.
   *
   * Declaring it opts the CLI into the HOLD: a turn that ends with watchable
   * background delegates out is kept open (no `turn_complete`), and once every
   * one of them has ended this prompt goes to the same session and the turn
   * settles on ITS answer. That is what the CLI's own interactive client does —
   * it queues a wakeup for the parent when a delegate completes and runs the
   * parent on it — and what its ACP server never does. REPORTED as a cursor QA
   * callee that ended its turn with seven reviewers still out, so its caller
   * received "they are finishing now" as the review (run `bd1e43ae`, call-143).
   */
  wakePrompt?: (ended: readonly AcpEndedDelegate[]) => string;
  /**
   * The brief and description a delegation's OWN tool input carries, or null
   * when it carries neither.
   *
   * The announcement ({@link read}) is not enough for a delegate whose
   * launching call was CUT OFF: for one the call waits on, cursor sends it only
   * as the call completes (the brief rode run `a8f5fb5f`'s `cursor/task` rows
   * 2377–2385, each landing with its delegate's result), so a delegate still
   * working when its parent's request failed has never been announced. Its tool
   * input is the one place its brief exists — measured on 2026.10.01-e373342:
   * `{_toolName: "task", prompt, description, subagentType}` — and the brief is
   * what its record is located by.
   */
  readLaunchInput?: (
    rawInput: unknown,
  ) => { label: string | null; prompt: string | null } | null;
  /**
   * The tool call that launched a sub-agent SESSION, off the vendor `_meta` of
   * its `subagent_spawned` / `subagent_state_update` (see `acp-subagents.ts`),
   * or null when the frame does not say.
   *
   * The RFD draft links a child to its parent SESSION and never to a tool
   * call, so this is the one vendor fact the feature rests on: without it a
   * child's steps have no block to be drawn in, and its ending no row to
   * close. Measured on cursor-agent 2026.10.01-e373342:
   * `_meta.cursor.toolCallId`, equal to the `task` call's own id.
   */
  subagentToolCallId?: (meta: unknown) => string | null;
}

/**
 * What a transient-failure resume tells the agent about the sub-agents the
 * failed request was waiting on — see {@link AcpAgentFailureProtocol.resume}.
 */
export interface AcpResumeContext {
  /**
   * Delegates whose launching call the failure cut off and that are STILL
   * RUNNING: the request died, the delegates did not. Each is now watched as a
   * background delegate, so its report reaches the agent in the wake prompt.
   */
  stillRunning: readonly { label: string | null }[];
  /**
   * Delegates that FINISHED after the agent last produced anything — so their
   * results never became part of the conversation the agent resumes, and are
   * handed over here instead of being run again.
   */
  finished: readonly AcpEndedDelegate[];
}

/**
 * How ONE agent reports its own task list beyond baseline ACP's `plan` update,
 * which carries no ids and so cannot be joined to anything the agent says later.
 *
 * Supplied by the adapter — the method name and the params shape are that
 * vendor's facts. What the driver owns is the LIFECYCLE, and there is one thing
 * in it worth naming: the announcement arrives as a blocking REQUEST, so it must
 * be answered. Declining it (which is what happened for two milestones, quietly,
 * because `cursor/update_todos` is on `declinedWithoutNotice`) does not stall the
 * turn — the agent absorbs the refusal — it simply throws the list away.
 *
 * An adapter that declares none keeps the old behaviour, which is correct for an
 * agent that has no such channel.
 */
export interface AcpTodoProtocol {
  /** The agent→client method carrying the list. */
  method: string;
  /**
   * Read the params into the normalized announcement, or null when the shape is
   * unrecognized — which falls through to the ordinary decline, on the same
   * reasoning as {@link AcpQuestionProtocol.accepts}: a list built from a payload
   * we could not parse is worse than not having one.
   */
  read(params: unknown): AcpTodoUpdate | null;
  /**
   * Where this agent states the plan it just sent as a `plan` update AGAIN,
   * this time with its own ids — absent for an agent that does not.
   *
   * The ids are the whole point. A `plan` entry has none, so the rows it draws
   * carry ids made up from their position; when the agent later works through
   * that plan, its patches name the tasks by ITS ids, match none of those rows,
   * and land as a second copy of every task. Measured on cursor-agent
   * 2026.10.19: a plan of three todos became six rows across the plan turn and
   * the turn that executed it. So when this is declared, the `plan` update is
   * HELD and this request is the plan's one announcement — the held entries are
   * drawn only when the request's payload cannot be read.
   *
   * The request itself is still DECLINED after it is read: its reply is a
   * verdict on the plan (accept or reject) that this client does not give on
   * the user's behalf.
   */
  plan?: {
    method: string;
    /** The plan as a whole list, or null when the shape is unrecognized. */
    read(params: unknown): AgentTask[] | null;
  };
}

/**
 * How one agent reports its OWN failure — for a CLI that reports it inside the
 * conversation instead of on the protocol.
 *
 * ACP has no channel for this, and it is not an oversight either side can fix
 * from here: `session/prompt` answers a stop reason, and a request that never
 * completed still has to answer something. A CLI is therefore free to catch its
 * own transport failure, write the sentence out as an
 * `agent_message_chunk`, and reply `end_turn` — which is exactly what
 * cursor-agent does (see `cursor-acp/utils/cursor-agent-failure.utils.ts` for
 * the catch block it does it in). Nothing about that is visible to a client
 * reading the protocol correctly: the turn is a success carrying one more
 * paragraph of the agent's prose.
 *
 * So the recognition has to be the ADAPTER's, and this seam is the whole of
 * what the driver knows about it — one predicate over one chunk. An adapter
 * that declares none keeps the old behaviour, which is correct for an agent
 * whose failures reach the protocol.
 */
export interface AcpAgentFailureProtocol {
  /**
   * The failure this chunk reports, or null when it is the agent talking —
   * which is every chunk of a healthy turn, so this runs on all of them and
   * must be cheap and heavily anchored.
   *
   * Returning the message rather than a boolean because the CLI's own framing
   * (leading blank lines, a prefix) is the adapter's to strip: the driver would
   * otherwise have to know where the sentence starts.
   */
  read(text: string): string | null;
  /**
   * A failure a RETRY can fix, and how to carry on from it.
   *
   * Absent means every reported failure ends the turn. Present, a failure
   * `isTransient` accepts is answered with `prompt` on the same session instead
   * of settling the turn — once per entry of `delaysMs` for each run of failures
   * with no progress between them, and at most `maxPerTurn` times in all, with
   * a notice each time, after which the failure ends the turn as before. See
   * the cursor adapter for the measurement that makes this the agent's own
   * recovery rather than an invention: its interactive client resumes exactly
   * this way.
   *
   * WHICH failures qualify is entirely the adapter's, and is broader than the
   * dropped connection this was built for — cursor's list also carries a stall
   * its CLI never retried and a 429 its own policy retries three times. So
   * nothing on this side may word itself as though a drop were the only case.
   */
  resume?: {
    isTransient(message: string): boolean;
    /**
     * The continuation prompt for ONE attempt, told what the failure did to
     * the sub-agents it caught — a function rather than a sentence because
     * that differs per failure, and getting it wrong is expensive: told only
     * that every unreturned sub-agent "was stopped with the request", a cursor
     * QA agent relaunched all seven of its verifiers while two of the originals
     * ran on and finished, and the five that had ALREADY finished were run
     * again too (run `a8f5fb5f`).
     */
    prompt: (context: AcpResumeContext) => string;
    /**
     * The pause before each attempt, one entry per attempt — so its length is
     * the attempt budget of one run of failures with no progress between them.
     * A pause is what lets the budget outlast an outage: an attempt that meets
     * the same outage dies on the CLI's own stall threshold, so attempts sent
     * back to back all fall inside one short one.
     */
    delaysMs: readonly number[];
    /** The most resumes one turn gets in all, whatever progress came between them. */
    maxPerTurn: number;
  };
}

/** What one agent told us about its task list, normalized. */
export interface AcpTodoUpdate {
  /** See {@link AgentEvent}'s `task_list`: whole list, or only the rows named. */
  mode: 'snapshot' | 'patch';
  tasks: AgentTask[];
  /** The tool call this belongs to, so its opaque row can be replaced by the list. */
  toolCallId: string | null;
}

/**
 * How full one agent's window is, as read from OUTSIDE the protocol.
 *
 * Deliberately the three fields a meter needs and nothing else — not
 * `AgentContextUsage`, which is a whole breakdown for a panel. The driver's job
 * here is one figure and its denominator; anything richer would make this seam
 * the second place a breakdown is defined.
 */
export interface AcpContextReading {
  /** What the window currently holds, or null when the source cannot say. */
  usedTokens: number | null;
  /** What it is measured against, or null. */
  windowTokens: number | null;
  /** Which model that window belongs to, when the source named one. */
  model: string | null;
}

/**
 * What is true of the AGENT for the whole process — the half of the old flat
 * `AcpDriverOptions` that does NOT change between turns.
 *
 * The split is the point. A kept process serves turn after turn, and everything
 * per-turn is rebuilt from that turn's own input ({@link AcpTurnOptions}), so
 * "per-turn" is the DEFAULT and session scope is the explicit exception. The
 * alternative — one long-lived object with a reset for each field that must not
 * survive — makes "remember to reset" the invariant, and the next field added
 * breaks it silently. Two of them were already sharp: `input` and the image
 * blocks read from it were fixed at construction, so a second turn would have
 * re-sent the first turn's attachments.
 */
export interface AcpSessionOptions {
  /** Advertised to the agent as `clientInfo`. */
  clientName: string;
  clientVersion: string;
  /**
   * Build the options for ONE turn from that turn's own input.
   *
   * A factory rather than a value, and REQUIRED rather than defaulted: every
   * per-turn field derives from the argument, so an adapter physically cannot
   * leave one closed over the first turn's input. A default that reused the
   * previous turn's object would reintroduce exactly the leak this shape exists
   * to make impossible.
   */
  turnOptions: (input: AgentTurnInput) => AcpTurnOptions;
  /** How this agent asks the user a question, or absent when it cannot. */
  question?: AcpQuestionProtocol;
  /**
   * How this agent reports its background sub-agents, or absent when it does
   * not — in which case a delegation reads as the plain tool call it is.
   */
  delegate?: AcpDelegateProtocol;
  /** How this agent reports its own task list, or absent when it does not. */
  todos?: AcpTodoProtocol;
  /**
   * The MCP server, tool and arguments a call names when this agent spells an
   * MCP call its own way, else null. The call is then written as
   * `mcp__<server>__<tool>` over those arguments, the name every other CLI's
   * rows carry. Absent: every call keeps the name and arguments it was sent with.
   */
  mcpToolCall?: (call: AcpToolCall) => AcpMcpToolCall | null;
  /**
   * How long this agent keeps an `*_always` permission answer, as geniro runs
   * it — which is what decides whether such an option reaches the card, and
   * the reach its button claims. Absent: never offered, and every verdict is
   * answered with a `*_once` option as before.
   *
   * The adapter's fact, never the protocol's: ACP says only that `*_always`
   * is remembered, not where. cursor keeps it in its config directory, which
   * geniro gives each conversation's process afresh, so for cursor "always"
   * lasts exactly one session.
   */
  alwaysAnswerScope?: ApprovalOptionScope;
  /**
   * How this agent reports its OWN failure inside the conversation, or absent
   * when its failures reach the protocol.
   */
  agentFailure?: AcpAgentFailureProtocol;
  /**
   * How full this agent's window is, read OFF-PROTOCOL — absent for an agent
   * that reports it on the wire, or not at all.
   *
   * No shipped ACP agent here has been observed accounting for its context on
   * the wire — none sends the `usage_update` the protocol defines, and a prompt
   * reply carries no window — so an ACP turn's meter has nothing of its own to
   * draw and the ring would sit empty for the life of the chat. A CLI can KEEP that
   * accounting somewhere the adapter can read — cursor writes a full breakdown
   * per turn into its own session store — and this is the seam that brings it
   * onto the same plane every other agent's figures ride. The reading itself is
   * the adapter's business; what the driver owns is WHEN to take one, which is
   * why this is a function of the session id and not a value.
   *
   * It reaches BOTH planes — the live `context_progress` while the turn runs,
   * and the turn's own `turn_complete` usage after it ends (see
   * {@link AcpTurnDriver.contextReading}). Live alone was the first version and
   * was reported straight back: that plane is dropped on settle, so the ring it
   * feeds was filled during a turn and empty between turns.
   *
   * SYNCHRONOUS on purpose: it is consulted from the two handlers that build an
   * event list and return it, so an async reading would have to be published
   * out of band, past the ordering every other event in the turn is subject to.
   * An adapter whose source cannot be read synchronously should cache it rather
   * than make this seam async for everyone.
   */
  readContext?: (sessionId: string) => AcpContextReading | null;
  /**
   * Agent→client methods this client refuses WITHOUT narrating it — the ones
   * whose own agent absorbs the refusal, so nothing about the turn changed.
   *
   * They are still declined in-protocol; what is withheld is only the
   * transcript notice, which is a per-turn budget of ONE. Spending it on a
   * refusal that cost nothing leaves a refusal that cost something unmentioned
   * later in the same turn.
   *
   * Membership must be EVIDENCE, not a guess: the entry belongs here only once
   * that agent's own handling of the refusal has been read or observed. An
   * unlisted method keeps the notice, which is the safe default.
   */
  declinedWithoutNotice?: readonly string[];
  logger?: { warn(message: string): void; debug?(message: string): void };
  /**
   * Extra `clientCapabilities._meta` this client declares — a VENDOR extension
   * bag, so the adapter owns its contents and this file never spells one.
   *
   * cursor uses it to unlock its parameterized model picker, which is what turns
   * one opaque composed model id into a bare name plus a real effort vocabulary.
   * An agent that does not know the key ignores it, so sending it is free.
   */
  clientMeta?: Readonly<Record<string, unknown>>;
  /**
   * Whether a turn's prompt must WAIT for the reply to its last config frame —
   * the model or a parameter, whichever went last — rather than follow it
   * straight down the pipe.
   *
   * Without it the prompt is pipelined behind the last frame, on the reasoning
   * that one ordered stdio stream already puts them in order. That holds for
   * an agent that reads a setting per REQUEST, and it does not hold for one
   * that binds the turn's settings when the PROMPT arrives: a frame still in
   * flight then is accepted, its reply names the new value, and the turn runs
   * on the old one. Nothing but the timing tells the two apart.
   *
   * A fact about the CLI, not about one setting, so it is one switch: which
   * frame ends up last depends on what the turn happens to name, and a model
   * switch with no parameter is a turn whose last frame is the model's.
   *
   * The cost is one round trip per turn that sends a frame, however many it
   * sends: they already go out one at a time ({@link
   * AcpTurnDriver.configSteps}), so only the last can still be in flight when
   * the prompt is written. A turn that sends none pays nothing. A frame
   * refused, or unanswered past its deadline, releases the prompt the way an
   * answered one does.
   */
  promptAwaitsConfig?: boolean;
  /**
   * Trust the current values in config replies and omit a parameter frame
   * whose resolved option already has the requested value. Opt-in because a
   * CLI's reported value must first be verified against the turn it runs.
   */
  skipUnchangedParameters?: boolean;
}

/**
 * What is true of ONE turn, rebuilt for each of them from that turn's own input.
 *
 * Every field here is derived from {@link input} by the adapter's
 * `AcpSessionOptions.turnOptions` factory, which is what makes a second turn on
 * a kept process carry its OWN prompt, attachments, model settings and approval
 * posture rather than the first turn's.
 */
export interface AcpTurnOptions {
  /** The turn being driven — prompt, cwd, resume id, MCP endpoint. */
  input: AgentTurnInput;
  /**
   * Resolve a permission request without the user. `null` surfaces an
   * `approval_request` event and parks the agent until a verdict arrives —
   * which is a capability the legacy `cursor-agent -p --force` path never had.
   *
   * Per TURN because the approval posture is: a chat switched from `auto`
   * back to `ask` between two messages must be gated on the second one.
   *
   * The tool call is the request's own stub with only its name and arguments
   * restored from the `tool_call` update (`withCachedToolFacts`); its kind is
   * whatever the request itself carried, which a stub may omit.
   */
  autoDecide: (toolCall: AcpToolCall) => AutoDecision;
  /** Session mode to request after the session exists, when the agent offers it. */
  preferredModeId?: string | null;
  /**
   * The turn's instruction text, given whether the call tools were registered.
   * Supplied by the adapter so the include-the-callee-block rule stays owned by
   * `AgentAdapter.composeSystemPrompt` rather than re-derived per protocol.
   *
   * The driver decides only the BOOLEAN and whether the conversation still
   * needs the text — what the text is remains the adapter's answer.
   */
  composeSystemPrompt: (granted: boolean) => string;
  /**
   * What this turn should put the agent on: a model, then the parameters to set
   * after it — the shape a CLI needs when its model and its reasoning effort are
   * SEPARATE config options rather than one composed id.
   *
   * Supplied by the adapter, because splitting a stored id into the two is that
   * CLI's syntax. Absent means "apply `input.model` verbatim and nothing else",
   * which is what an agent with a single opaque model id wants.
   *
   * ORDER is the contract, not a detail: a parameter's very existence depends on
   * the current model (cursor's `auto-smart` has none at all), so the model
   * frame must precede them. They travel on one ordered stdio stream, so sending
   * in order is applying in order.
   */
  modelSelection?: {
    model: string | null;
    parameters: readonly AcpModelParameter[];
  } | null;
}

/**
 * One config option a turn sets after its model — a reasoning effort, a context
 * size.
 *
 * `alternateIds` exists because a config option's id belongs to the MODEL, and
 * one agent's models can name the same axis differently: cursor's
 * `claude-opus-5` calls it `effort` and its `gpt-5.2` calls it `reasoning`
 * (probed 2026-08-19 on 2026.08.11-e8db854). The adapter knows its own CLI's
 * spellings; the driver picks whichever one the current model enumerated. Left
 * empty, `id` is sent verbatim — which is every agent whose axis has one name.
 */
export interface AcpModelParameter {
  id: string;
  value: string;
  /** Other ids this SAME setting is known by, most-preferred first. */
  alternateIds?: readonly string[];
  /**
   * The option CATEGORY this setting belongs to — the last resort when the
   * current model spells the axis in a way no id above names.
   *
   * A category is the PROTOCOL's own vocabulary while an id is the agent's, so
   * this is the one thing about an unmeasured spelling that is still knowable:
   * cursor renamed `effort` to `reasoning_effort` on the newest model of two
   * families at once (measured 2026-09-22), under the same `thought_level` both
   * older spellings used. Adoption is deliberately narrow — see
   * {@link AcpTurnDriver.adoptParameterByCategory} — because a category can
   * hold more than one axis.
   */
  category?: string;
}

function textOf(content: unknown): string | null {
  const block = asRecord(content);
  if (!block || asString(block.type) !== 'text') {
    return null;
  }
  const text = asString(block.text);
  return text !== null && text.length > 0 ? text : null;
}

/**
 * An argument bag the agent sent but left EMPTY reads as null, because that is
 * what it means: the call was named and its arguments were not disclosed.
 *
 * `{}` is not a hypothetical. Probed on cursor-agent 2026.08.04-aaa8809 over
 * `cursor-agent acp`: a shell call carries real arguments
 * (`rawInput: {"command":"echo …"}`), while its `read`, `search` and `edit`
 * calls all send `rawInput: {}` on the initial `tool_call` and then send NO
 * `rawInput` on any later `tool_call_update` — so there is no fuller version
 * arriving behind it to wait for, and `locations` is never populated either.
 * Keeping the `{}` made every consumer state it as fact: the transcript row
 * rendered the arguments as `{}`, which is what the user reported.
 *
 * Normalized HERE rather than at each reader so the permission card and the
 * transcript row cannot disagree about whether arguments exist, and left
 * agent-agnostic because "sent an empty bag" is a protocol shape, not one
 * CLI's quirk — an ACP agent that discloses its arguments is unaffected.
 */
function disclosedInput(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  const record = asRecord(value);
  return record !== null && Object.keys(record).length === 0 ? null : value;
}

/**
 * The `diff` content blocks a tool call reports — ACP's own
 * `ToolCallContent` variant `{type:'diff', path, oldText, newText}`.
 *
 * This is the one place a cursor edit says WHAT IT DID: probed on cursor-agent
 * 2026.08.11-e8db854, its `edit` calls send `rawInput: {}` on the opening
 * `tool_call`, no `rawInput` ever after, no `locations` — and then the completing
 * `tool_call_update` carries the full diff, path included. Read here so the row
 * can render a diff and name the file instead of printing the raw block array as
 * JSON, which is what it did: `[{"type":"diff","path":"/private/tmp/…",
 * "oldText":"alpha\nbeta\n"…}]`, escaped newlines and all.
 *
 * `oldText` is nullable in the schema (a creation has no previous text) and is
 * normalized to null here, so a reader never has to tell `null` from absent.
 */
function readAcpDiffs(
  content: unknown,
): { path: string | null; oldText: string | null; newText: string }[] {
  const diffs: {
    path: string | null;
    oldText: string | null;
    newText: string;
  }[] = [];
  for (const entry of asArray(content)) {
    const block = asRecord(entry);
    if (!block || asString(block.type) !== 'diff') {
      continue;
    }
    const newText = asString(block.newText);
    if (newText === null) {
      // A diff with no new text is not renderable as one; let the caller fall
      // back to reporting the raw block rather than showing an empty panel.
      continue;
    }
    diffs.push({
      path: asString(block.path),
      oldText: asString(block.oldText),
      newText,
    });
  }
  return diffs;
}

/**
 * ACP `ToolCallLocation[]` — the files a tool call names.
 *
 * Answers NULL for an absent, empty or unreadable list, so the field keeps the
 * one meaning {@link AcpToolCall.locations} states — inventing an `[]` here
 * would file "the agent named no files" under it too.
 */
function readToolLocations(value: unknown): AcpToolLocation[] | null {
  const locations: AcpToolLocation[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const path = record ? asString(record.path) : null;
    if (path === null) {
      // A location naming no file names nothing.
      continue;
    }
    locations.push({ path, line: record ? asNumber(record.line) : null });
  }
  return locations.length > 0 ? locations : null;
}

/**
 * ACP `PlanEntry[]` — the agent's plan, as the task list it is.
 *
 * Null for an absent or non-array `entries`: an unreadable plan is not an empty
 * one, and reading it as empty would wipe a list the user is watching.
 *
 * An entry carries no id (ACP's schema has `content`, `priority`, `status` and
 * nothing else), so each row is given one from its position. `plan-` keeps them
 * apart from the numbers an agent gives its own todo list (`"1"`, `"2"`, …),
 * which a later patch would otherwise mistake for these rows. `priority` is not
 * carried: the task list has no place for it, and the one agent seen sending
 * plans writes `"medium"` for every entry whatever the model said.
 */
function readAcpPlan(entries: unknown): AgentTask[] | null {
  if (!Array.isArray(entries)) {
    return null;
  }
  const tasks: AgentTask[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const content = record ? asString(record.content) : null;
    if (content === null || content.length === 0) {
      // A step that says nothing is not a step the user can follow.
      continue;
    }
    const status = asString(record?.status);
    tasks.push({
      id: `plan-${tasks.length + 1}`,
      title: content,
      // ACP's own three words; anything else reads as unknown, never coerced.
      status:
        status === 'pending' ||
        status === 'in_progress' ||
        status === 'completed'
          ? status
          : null,
      activeForm: null,
    });
  }
  return tasks;
}

function readToolCall(source: Record<string, unknown>): AcpToolCall {
  return {
    toolCallId: asString(source.toolCallId) ?? '',
    // `name` is the machine identifier; `title` is the human label every ACP
    // tool call carries. Prefer the former, fall back so the transcript row is
    // never blank.
    name: asString(source.name) ?? asString(source.title) ?? '',
    status: (asString(source.status) as AcpToolCall['status']) ?? null,
    kind: asString(source.kind),
    rawInput: disclosedInput(source.rawInput),
    rawOutput: source.rawOutput ?? null,
    locations: readToolLocations(source.locations),
  };
}

function readPermissionOptions(value: unknown): AcpPermissionOption[] {
  const options: AcpPermissionOption[] = [];
  for (const entry of asArray(value)) {
    const record = asRecord(entry);
    const optionId = record ? asString(record.optionId) : null;
    const kind = record ? asString(record.kind) : null;
    if (record && optionId !== null && kind !== null) {
      options.push({
        optionId,
        name: asString(record.name) ?? optionId,
        kind: kind as AcpPermissionOptionKind,
      });
    }
  }
  return options;
}

/**
 * Pick the option to answer a permission request with. Only `*_once` kinds are
 * eligible: selecting an `*_always` option would persist a decision beyond the
 * turn that the user was never asked to make at that scope — the one path to
 * one is the user picking it off the card ({@link permissionAnswerOptionId}).
 * Returns null when the agent offered nothing matching, which the caller
 * reports as a `cancelled` outcome rather than guessing.
 */
export function selectPermissionOption(
  options: AcpPermissionOption[],
  allow: boolean,
): string | null {
  const wanted: AcpPermissionOptionKind = allow ? 'allow_once' : 'reject_once';
  return options.find((option) => option.kind === wanted)?.optionId ?? null;
}

/**
 * The card's remembering options for one permission request: each `*_always`
 * option the agent offered, under the id the agent gave it, worded by the
 * reach geniro actually gives it (`scope`). Empty when the adapter declares no
 * scope — `*_always` is then never offered.
 */
export function acpApprovalOptions(
  options: readonly AcpPermissionOption[],
  scope: ApprovalOptionScope | undefined,
): ApprovalOption[] {
  if (scope === undefined) {
    return [];
  }
  return options.flatMap((option) =>
    option.kind === 'allow_always' || option.kind === 'reject_always'
      ? [approvalOption(option.optionId, option.kind === 'allow_always', scope)]
      : [],
  );
}

/**
 * The option id a verdict answers a parked permission with: the picked card
 * option when it is one of this request's own `*_always` options pointing the
 * verdict's way, else the `*_once` option of {@link selectPermissionOption}.
 */
export function permissionAnswerOptionId(
  options: readonly AcpPermissionOption[],
  allow: boolean,
  picked: ApprovalOption | undefined,
): string | null {
  const wanted: AcpPermissionOptionKind = allow
    ? 'allow_always'
    : 'reject_always';
  const remembered =
    picked === undefined
      ? undefined
      : options.find(
          (option) => option.optionId === picked.id && option.kind === wanted,
        );
  return remembered?.optionId ?? selectPermissionOption([...options], allow);
}

/**
 * The element the turn's instructions are wrapped in, and the sentence inside
 * it saying what they are.
 *
 * ACP has no system-prompt field, so these instructions arrive as part of the
 * USER's turn — and an agent answers what the user says. REPORTED, and then
 * reproduced end to end: a chat opened with `Hello!` got back a paragraph
 * beginning "Got it — I'll treat this as a **rich markdown chat transcript**,
 * not terminal output", listing the formats geniro had just described. The
 * conversation was then genuinely ABOUT geniro's preamble — its own title,
 * however derived, said so — because the preamble was the only substantial
 * thing in the turn. claude never had this: `--append-system-prompt` is out of
 * band, so there is nothing there for the model to reply to.
 *
 * A named element with a stated role is what puts it back out of band as far
 * as anything here can. Both halves matter: the tag is a boundary a model
 * recognises as structure rather than speech, and the sentence is what says
 * which kind of structure, since an unexplained tag is just more text.
 */
export const HOST_CONTEXT_TAG = 'host-context';
export const HOST_CONTEXT_NOTE =
  'The block below is not a message from the user and not a request. It describes the app you are running inside. Follow it, and do not reply to it, summarise it, or mention it.';

const HOST_CONTEXT_OPEN = `<${HOST_CONTEXT_TAG}>\n\n${HOST_CONTEXT_NOTE}\n\n`;
const HOST_CONTEXT_CLOSE = `\n\n</${HOST_CONTEXT_TAG}>`;

/**
 * The user's words followed by the instruction block, wrapped — the one
 * spelling of a prompt that carries instructions.
 *
 * {@link readHostContext} is its inverse, and the two share their delimiters
 * so a change to the wrapping cannot leave the reader looking for the old one.
 */
export function wrapHostContext(prompt: string, instructions: string): string {
  const block = `${HOST_CONTEXT_OPEN}${instructions}${HOST_CONTEXT_CLOSE}`;
  return prompt.length > 0 ? `${prompt}\n\n${block}` : block;
}

/**
 * The instruction block the LAST wrapped block in `text` carried, or null when
 * the text holds none.
 *
 * Read off a `session/load` replay, where the agent hands back each prior user
 * message whole (cursor-agent 2026.09.10-fd3934a: `replayAgentTurn` sends
 * `userMessage.text` as ONE `user_message_chunk`), so this is how a resumed
 * session learns which instructions its conversation already holds without
 * geniro storing a copy. A text the agent altered on the way back simply
 * yields null — the caller then re-sends, which costs one block and never a
 * lost instruction.
 */
export function readHostContext(text: string): string | null {
  const start = text.lastIndexOf(HOST_CONTEXT_OPEN);
  if (start < 0) {
    return null;
  }
  const from = start + HOST_CONTEXT_OPEN.length;
  const end = text.indexOf(HOST_CONTEXT_CLOSE, from);
  return end < 0 ? null : text.slice(from, end);
}

/**
 * How often a running turn re-reads its agent's off-protocol context source.
 *
 * A measurement rather than a round number: on a fresh cursor chat the store's
 * root blob was rewritten at 17.2s, 18.7s, 21.2s, 21.7s and 24.2s into the
 * opening turn — gaps of 0.5s to 2.5s — so a two-second floor lands close to
 * one reading per rewrite without asking a turn's every chunk for one. The read
 * itself is cheap (0.14ms, a 4KB SQLite open and a protobuf walk); what this
 * bounds is the socket emission each new figure costs every watching client.
 */
const CONTEXT_REREAD_MS = 2_000;

/**
 * How long a mid-turn message waits for the agent to confirm it stopped the
 * prompt it is interrupting — see {@link AcpTurnDriver.sendFollowUp}.
 *
 * A bound on a reply that does not come, not a pacing: measured on
 * cursor-agent 2026.09.10-fd3934a, the interrupted prompt answers `cancelled`
 * within the same millisecond as the `session/cancel` — mid-tool, mid-stream,
 * and with a permission request still parked. Past it the message is sent
 * anyway, because a message held forever is worse than the duplicated work the
 * wait exists to prevent.
 */
export const INTERRUPT_ACK_DEADLINE_MS = 10_000;

/**
 * The result a tool call is closed with when a mid-turn message cancelled the
 * prompt it was running under. The agent sends nothing for such a call —
 * measured on cursor-agent 2026.09.10-fd3934a, a foreground sub-agent's own
 * transcript ends `turn_ended aborted` and a running shell is killed, with no
 * `tool_call_update` for either — so without this the row read as running
 * until the whole turn ended.
 */
export const INTERRUPTED_TOOL_RESULT =
  'Stopped — a new message interrupted this step before it finished.';

/**
 * The result a tool call is closed with when the REQUEST it ran under failed
 * before the call returned — the agent reporting its own failure, which on
 * cursor-agent is a dropped stream far more often than anything else.
 *
 * The agent never closes such a call itself. Read out of cursor-agent
 * 2026.10.01-e373342's ACP server (`3351.index.js`): when its run throws it
 * writes `Error: …` as a message chunk and answers `end_turn`, and no
 * `tool_call_update` of any status follows. Left open, the row read as running
 * for the rest of the conversation — REPORTED as two verifier blocks spinning
 * above a retry that had relaunched them (run `a8f5fb5f`). Closing them here
 * is what ACP's own v2 draft asks of the AGENT ("give each tool call that the
 * failed work left unfinished a terminal status, using `failed`"), what Zed
 * does on the client side, and what Cursor's staff advised for exactly this
 * drop in stream-json mode ("treat … as an implicit cancellation of all
 * pending tool calls").
 *
 * Worded as what is KNOWN — the result never came back — rather than as a
 * cancellation: nothing was cancelled, and the step may well have finished.
 */
export const CUT_OFF_TOOL_RESULT =
  'Cut off — the request this step ran under failed before its result came back.';

/**
 * The result a tool call carries when geniro did not grant its permission (a
 * Deny, a policy refusal, or a request answered `cancelled`) and the agent sent
 * no body of its own for it — the step never ran.
 */
export const REFUSED_TOOL_RESULT =
  'Not run — permission for this step was not granted.';

/**
 * The result a SUB-AGENT's step is closed with when the agent reports that
 * sub-agent ended (`subagent_state_update`) while the step was still open — a
 * cancelled or failed sub-agent says nothing more about the calls it was in.
 */
export const SUBAGENT_ENDED_TOOL_RESULT =
  'Stopped — the sub-agent ended before this step finished.';

/**
 * Said once per turn when a message is HELD because sending it would cancel
 * the turn's running background sub-agents — see {@link
 * AcpTurnDriver.sendFollowUp}.
 */
export const QUEUED_FOR_SUBAGENTS_NOTICE =
  'Your message waits until the background sub-agents finish — sending it now would cancel them. It goes out as soon as this turn ends.';

/**
 * How long a turn HELD for its background delegates waits with nothing moving
 * before it settles on the answer it already has — see
 * {@link AcpDelegateProtocol.wakePrompt}. Restarted by every delegate that
 * ends, so a long fan-out that keeps reporting is never cut off.
 *
 * Under `spawn-cli`'s 30-minute turn silence deadline on purpose: a hold that
 * outlasted it would end in that deadline's "produced nothing" failure, which
 * is false about a turn that DID produce its answer. Past this, the delegates
 * still out stay watched and their closes land after the turn.
 *
 * Awake time only ({@link awakeTimeout}), like that deadline: delegates asleep
 * with the machine have not stopped moving, and both windows restart in full
 * at a wake, so this one still ends first.
 */
export const DELEGATE_HOLD_IDLE_MS = 25 * 60_000;

/**
 * How many wake prompts one turn may send. An agent woken by its delegates may
 * legitimately launch more and be woken again (re-running the ones that
 * failed); the cap only stops an agent that does so forever from holding its
 * turn open forever.
 */
export const MAX_DELEGATE_WAKES = 10;

/**
 * Whether two readings say the same thing — the model included, since a turn
 * that switched models is reporting a different window even at an identical
 * count.
 */
function sameContextReading(
  a: AcpContextReading | null,
  b: AcpContextReading,
): boolean {
  return (
    a !== null &&
    a.usedTokens === b.usedTokens &&
    a.windowTokens === b.windowTokens &&
    a.model === b.model
  );
}

/** A resume pause as the transcript says it: `15s`, `1 min`, `3 min`. */
export function formatPause(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} min`;
}

/**
 * Drives ONE ACP turn: the mode/model/parameter frames it opens with, its
 * `session/prompt`, the agent's `session/update` stream, its
 * `session/request_permission` round-trips, and finally the `session/prompt`
 * reply carrying the stop reason that ends the turn.
 *
 * **Genuinely one instance per turn.** It holds the accumulated usage, the
 * parked permission requests, the open text block, the delegate bookkeeping and
 * this turn's own input — none of which may leak into the next turn on a kept
 * process, and none of which may be shared across the N concurrent turns one
 * adapter instance serves. What OUTLIVES a turn — the transport, the request-id
 * counter, the negotiated capabilities, the session id — lives on the
 * {@link AcpSession} this is constructed against, which is the whole of the
 * split: a field added here is per-turn by default, and making one survive is a
 * deliberate move to the other class.
 *
 * Everything inbound is read through the defensive `json-util` accessors: an
 * unrecognized notification, an unparseable update, or a field that moved
 * between CLI versions degrades to "no event", never to a thrown turn.
 */
export class AcpTurnDriver {
  /**
   * The model and parameter frames this turn has still to send, IN ORDER — and
   * sent ONE AT A TIME, each only once the agent has answered the one before.
   *
   * They were pipelined, on the reasoning that one ordered stdio stream already
   * orders them. It orders the WRITES, not the agent's handling of them: cursor
   * runs each `session/set_config_option` as its own async task, and each task
   * reads the model's whole parameter list, awaits, then writes the whole list
   * back with its one value changed. Frames in flight together therefore
   * overwrite each other with stale lists, and whichever lands last wins.
   * REPORTED as a Grok 4.7 member set to 500K that "shows 256k only sometimes";
   * two of its fresh sessions in the reporter's own store read 256,000 from
   * their very first reading. PROBED on cursor-agent 2026.09.10-fd3934a with the
   * four frames that turn sends (`model`, `reasoning_effort`, `context`, `fast`)
   * on a fresh session, three runs each: pipelined landed right ONCE — a second
   * run lost the effort, a third had every parameter refused and stayed at
   * `context=256k` — while one at a time landed `500k`/`xhigh`/`false` all three
   * times.
   *
   * One at a time also means a parameter goes out AFTER the model reply, which
   * lists the NEW model's options (`modelReply`) — so it can be resolved and
   * checked against the model it will actually apply to.
   */
  private readonly configSteps: ConfigStep[] = [];
  /** The config frame awaiting its reply, or null when none is. */
  private configInFlight: JsonRpcId | null = null;
  /** The prompt, not yet sent because a config frame is still ahead of it. */
  private promptHeld = false;
  /**
   * The agent's reply to THIS turn's model frame — the option list of the
   * model the turn switched TO — or null when it sent none or it was refused.
   */
  private modelReply: unknown = null;
  /**
   * The id of the most recent `session/prompt` — the only one whose reply ends
   * the turn.
   *
   * A mid-turn message ({@link sendFollowUp}) waits for the prompt it
   * interrupts to answer before sending its own, so two prompts are in flight
   * only when that wait gave up ({@link INTERRUPT_ACK_DEADLINE_MS}). The reply
   * the agent then still owes the SUPERSEDED prompt must not settle the turn —
   * it would end the run in the middle of answering the message the user just
   * pushed through, under `stopReason: "cancelled"`, reading as a Stop nobody
   * pressed. Matched by id rather than by counting what is outstanding,
   * because the two replies are not ordered.
   */
  private latestPromptId: JsonRpcId | null = null;
  /**
   * Whether {@link latestPromptId} is still unanswered — a prompt the agent is
   * working on right now. False before the turn's prompt went out and during a
   * transient-failure pause, which is when a mid-turn message has nothing to
   * interrupt and is sent at once.
   */
  private promptOutstanding = false;
  /**
   * The prompt a mid-turn message is CANCELLING, while its reply is awaited —
   * see {@link sendFollowUp}. Its reply is the agent confirming it stopped, and
   * is what releases {@link queuedFollowUps}; it ends the turn only when the
   * user pressed Stop in the meantime.
   */
  private interruptedPromptId: JsonRpcId | null = null;
  /**
   * Messages accepted while that cancel is in flight, oldest first, sent as
   * ONE prompt once the agent confirms — a second message arriving in the
   * window joins the first rather than interrupting a prompt not yet sent.
   */
  private readonly queuedFollowUps: FollowUpMessage[] = [];
  /** The {@link INTERRUPT_ACK_DEADLINE_MS} bound on that confirmation. */
  private interruptTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Tool calls this turn wrote a row for and nothing has settled yet.
   *
   * Read at two moments, each when no further prompt has gone out, so that
   * everything still open belonged to the prompt that just ended and the agent
   * will say nothing more about it: an interrupted prompt confirming it
   * stopped ({@link INTERRUPTED_TOOL_RESULT}), and a prompt the agent reported
   * FAILED ({@link CUT_OFF_TOOL_RESULT}).
   */
  private readonly openToolCalls = new Set<string>();
  /**
   * Delegates the agent WAITED on whose result arrived after it last produced
   * anything — results it has not yet acted on, and so results a failed
   * request takes with it.
   *
   * Read out of cursor-agent 2026.10.01-e373342: the conversation a resumed
   * prompt continues is the last checkpoint the SERVER sent (`index.js`,
   * `handleCheckpoint`), and nothing a client computed after it is kept. On run
   * `a8f5fb5f` five verifiers finished while the agent waited for all seven and
   * the stream then died, so the resumed agent "relaunched them" — all five,
   * again. Their reports are handed over by the resume instead.
   *
   * Cleared whenever the agent speaks or thinks: that is a new step, and a
   * step is generated FROM the results before it. A step of tool calls alone
   * does not clear it — calls run as they stream, so a fast delegate can
   * finish before the step's last call is written — which errs toward handing
   * over a report the agent already had, the cheap direction.
   */
  private readonly unconsumedDelegates = new Set<string>();
  /** {@link QUEUED_FOR_SUBAGENTS_NOTICE} has been said this turn. */
  private warnedQueuedForSubagents = false;
  /**
   * THIS turn's attachments, read off disk when the turn opens.
   *
   * The sharpest of the fields the session/turn split exists for: it was read
   * once at construction from an `input` that never changed, so on a kept
   * process every later turn would have re-sent the first turn's screenshots.
   */
  private readonly imageBlocks: AcpImageBlock[];
  /**
   * `session/load` makes the agent REPLAY the whole prior conversation as
   * `session/update` notifications before it replies. Those are history we
   * already have in SQLite — persisting them again would duplicate every past
   * message into the transcript on each resumed turn — so transcript-producing
   * updates are dropped until the load reply lands.
   */
  private replaying = false;
  /**
   * The newest `plan` update, held for an agent that restates its plan with ids
   * — see {@link AcpTodoProtocol.plan}. Drawn only when that restatement cannot
   * be read; turn-scoped because both frames come from one tool call.
   */
  private heldPlan: AgentTask[] | null = null;
  /**
   * Replay accounting for a resumed turn. `session/load` streams the whole
   * prior conversation back before the prompt can be sent, and nothing in the
   * protocol bounds that volume — so the cost is measured per turn rather than
   * assumed, which is what any decision to avoid `session/load` needs.
   */
  private replayStartedAt: number | null = null;
  private replayedUpdates = 0;
  /**
   * The instruction block the newest replayed user message carried — what the
   * loaded conversation already holds. Committed to the session only when the
   * load SUCCEEDS, since a refused load is followed by a `session/new` that
   * holds nothing.
   */
  private replayedInstructions: string | null = null;
  /**
   * The instruction block THIS turn's prompt carries, or null when the prompt
   * went out without one. Recorded on the session only once the prompt is
   * WRITTEN — see `sendPrompt`.
   */
  private promptInstructions: string | null = null;
  /** Mode we asked for, so the reply can report an honest failure. */
  private requestedModeId: string | null = null;
  private readonly usage: AcpUsageSnapshot = {
    inputTokens: null,
    outputTokens: null,
    contextUsed: null,
    costAmount: null,
    costCurrency: null,
  };
  /**
   * The last off-protocol context reading this turn took, or null.
   *
   * KEPT rather than merely emitted, and that is the fix for the reported "the
   * panel says 70% and the circle beside it is empty". A reading rides the
   * EPHEMERAL live plane, which the client drops when the run settles — so the
   * ring was fed for the length of a turn and lost its only figure the moment
   * the turn ended, while the readout behind it kept answering off the same
   * file on demand. Held here, the same number also reaches `turn_complete`
   * (see {@link buildUsage}), which is the durable half every other CLI's ring
   * is drawn from between turns.
   */
  private contextReading: AcpContextReading | null = null;
  /**
   * When the last reading was taken, so the mid-turn re-read is bounded by the
   * clock rather than by how chatty the agent happens to be.
   */
  private lastContextReadAt = 0;
  private readonly textChunks: string[] = [];
  /**
   * The failure this agent reported about ITSELF, kept until the stop reason
   * that would otherwise call the turn a success.
   *
   * Per-turn state, so it belongs to the driver rather than the adapter: one
   * adapter instance drives N concurrent turns under team fan-out. It has to
   * be state at all because the two halves arrive apart — the sentence in a
   * message chunk, the ending in the prompt reply — and it is the ENDING that
   * is wrong, so the sentence has to outlive its own notification to correct
   * it. See {@link AcpAgentFailureProtocol}.
   */
  private agentFailure: string | null = null;
  /** Resumes since the agent last progressed — indexes `resume.delaysMs`. */
  private transientResumes = 0;
  /** Resumes this turn has made in all — checked against `resume.maxPerTurn`. */
  private transientResumesThisTurn = 0;
  /** Set by progress, cleared by a resume: the next failure starts a fresh run. */
  private progressedSinceResume = false;
  /**
   * Whether this turn has produced anything of the agent's own — a message, a
   * thought or a tool call — which is what tells a resume whether the prompt
   * it continues was ever saved. A request that died before its first step
   * may not have been: on run 1b0f91aa (session fd93ef04) cursor's store held
   * no copy of a callee's brief, the bare continuation became the
   * conversation's FIRST message, and the agent went looking through other
   * sessions' transcripts for something to continue — and finished their work.
   * See {@link sendResume}.
   */
  private requestProgressed = false;
  /**
   * The turn's prompt has ended and the turn is HELD for its background
   * delegates — see {@link AcpDelegateProtocol.wakePrompt}. Like a transient
   * pause, the turn is alive with no prompt out: a Stop is answered by
   * {@link withdrawHeldPrompt} and a message by {@link sendFollowUp}, which
   * carries the turn on by itself.
   */
  private awaitingDelegates = false;
  /** The stop reason of the prompt the hold is standing in for. */
  private heldStopReason: string | null = null;
  /** Gives up on a hold nothing has moved for — see {@link DELEGATE_HOLD_IDLE_MS}. */
  private holdTimer: AwakeTimer | null = null;
  /** How many wake prompts this turn has sent — see {@link MAX_DELEGATE_WAKES}. */
  private delegateWakes = 0;
  /**
   * The background delegates THIS turn launched — the only ones it holds for
   * and is woken about. Session-wide would be wrong: a delegate an earlier
   * turn gave up on (a Stop, an idle bound, a record that never says it ended)
   * would hold every later turn of the conversation all over again.
   */
  private readonly launchedHere = new Set<string>();
  /**
   * Where the answer the turn settles on begins in {@link textChunks}: past the
   * text of the prompt a wake replaced, so a caller is handed the answer the
   * agent gave once its delegates reported — not "they are finishing now"
   * glued to the front of it.
   */
  private finalTextFrom = 0;
  /**
   * The pause before a transient-failure resume, while it runs. The turn is
   * alive and has NO prompt out, so a Stop here has nothing to cancel in
   * protocol: {@link withdrawHeldPrompt} clears this and the turn ends as a
   * cancellation, exactly as it does for a prompt held behind config frames.
   */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The scheduled resume itself, from the failure until its prompt goes out —
   * longer than {@link resumeTimer}, because the prompt may also wait on the
   * reports of finished delegates being read off disk. Identity, so a resume
   * called off (a Stop, a message) and a later one cannot be mistaken for each
   * other when a read lands late.
   */
  private scheduledResume: object | null = null;
  /**
   * The user pressed Stop on this turn and the in-protocol cancel went out
   * ({@link buildInterruptPayload}). Nothing this turn does afterwards may put
   * work back in front of the agent — the transient-failure resume is the one
   * path that would, answering a failure the cancel itself provoked with a
   * fresh `session/prompt` nobody asked for.
   */
  private stopRequested = false;
  /**
   * The user stopped this turn while its prompt was still held behind its own
   * config frames, so the prompt was never sent and never will be
   * ({@link withdrawHeldPrompt}). A config reply still in flight then lands in
   * a turn that is over: its acceptance is recorded (it describes the session,
   * which outlives the turn) and its refusal is not narrated.
   */
  private withdrawn = false;
  /**
   * The assistant-text or thought block being streamed right now, not yet
   * written as a transcript row.
   *
   * ACP delivers a message as a run of `agent_message_chunk` notifications with
   * no "block complete" frame, so the driver has to decide where a row ends.
   * Emitting a durable `text` per chunk — which is what this did — wrote ONE
   * ROW PER WORD: a single short cursor reply landed as 68 `message` rows and
   * 68 socket emissions, and the transcript rendered as a column of one-word
   * paragraphs. The words still stream live (each chunk is a `text_delta`,
   * EPHEMERAL by the contract in `adapter.types.ts`); only the join becomes a
   * row, which is exactly how the claude adapter already behaves.
   *
   * `kind` is carried so a thought and an answer cannot merge into one row when
   * the agent switches between them mid-turn.
   */
  private pendingBlock: {
    kind: 'text' | 'reasoning';
    parts: string[];
  } | null = null;
  /**
   * Tool calls announced `pending` with no arguments yet, not written until
   * they are described — oldest first.
   *
   * ACP's own definition of `pending` is "hasn't started running yet because
   * the input is either streaming or we're awaiting approval", and an agent
   * that announces a call while the model is still writing it sends the
   * arguments, and often the real name, in a later update. The row is written
   * once, so writing it at the opening frame fixed the placeholder into the
   * transcript for good: cursor-agent's MCP calls all read `MCP: tool` with no
   * input (see {@link refineToolCall}). A held call is written when the agent
   * starts it (`in_progress`), settles it, asks permission for it, sends any
   * other request, says anything, or ends the turn — so nothing it announced
   * is ever lost, only written a moment later. A call that opens WITH its
   * arguments is written at once, as before.
   */
  private readonly heldToolCalls = new Map<string, AcpToolCall>();
  /** One notice per turn for unimplemented agent→client requests. */
  private warnedUnsupportedRequest = false;
  /** The model asked for, so a refusal can name it. */
  private requestedModelId: string | null = null;
  /** The last `<id>=<value>` parameter asked for, so a refusal can name it. */
  private requestedParameter: string | null = null;

  /**
   * @param session the process this turn runs on, and the owner of everything
   *   that outlives it.
   * @param options THIS turn's own options, built by
   *   `AcpSessionOptions.turnOptions` from this turn's input.
   */
  constructor(
    private readonly session: AcpSession,
    private readonly options: AcpTurnOptions,
  ) {
    // Read here rather than lazily, so an unreadable attachment fails the turn
    // at its own opening — where `AgentAdapter.start`'s synchronous try and
    // `AcpSession.openTurn`'s catch each turn it into one honest `error` event
    // — instead of throwing out of the message pump mid-handshake.
    this.imageBlocks = buildAcpImageBlocks(options.input.images);
  }

  /**
   * Open this turn on a session that is ALREADY established — every message of
   * a chat after the first.
   *
   * The counterpart of the `session/new` reply's own tail, and literally the
   * same code ({@link beginTurn}): a later turn re-applies the mode, the model
   * and the model parameters before sending its prompt, because none of those
   * are argv on this transport and only `model` and `effort` are part of
   * `AgentAdapter.sessionKey` — a context window or a `fast` toggle changed
   * between two messages would otherwise silently keep the first turn's value
   * for the life of the conversation.
   *
   * The stored session reply supplies the opening vocabulary. An agent that
   * opts into comparing current parameters uses the latest config reply for
   * those, since a previous turn can have changed them.
   */
  openOnLiveSession(): AgentEvent[] {
    const events: AgentEvent[] = [];
    // Every turn names the session it runs in, not only the one that opened
    // it: a team call records its turn's session as the handle a later
    // `thread:` resumes, and a turn that names none leaves its call
    // unresumable once this process is gone.
    if (this.session.sessionId !== null) {
      events.push({ type: 'session', sessionId: this.session.sessionId });
    }
    this.beginTurn(this.session.lastSessionReply, events);
    return events;
  }

  /**
   * Encode a verdict for a parked agent request.
   *
   * For a `session/request_permission`, `updatedInput` is ignored: ACP's
   * permission outcome carries an option choice only, with no channel for a
   * modified tool input. For a parked QUESTION it is the whole payload — the
   * card's answer folded in by the adapter's `withAnswer` — and the adapter's
   * own encoder turns it into that agent's reply shape.
   */
  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string | undefined {
    const requestId = decodeRequestId(id);
    if (this.session.parkedQuestions.has(id)) {
      const params = this.session.parkedQuestions.get(id);
      this.session.parkedQuestions.delete(id);
      const question = this.session.options.question;
      if (requestId === null || question === undefined) {
        return undefined;
      }
      return encodeResult(
        requestId,
        question.encodeReply(params, allow, updatedInput),
      );
    }
    const parked = this.session.parkedPermissions.get(id);
    if (requestId === null || parked === undefined) {
      return undefined;
    }
    this.session.parkedPermissions.delete(id);
    const optionId = permissionAnswerOptionId(parked.options, allow, option);
    this.recordAnswer(parked.toolCallId, allow && optionId !== null);
    return encodeResult(requestId, {
      outcome:
        optionId === null
          ? // The agent offered no `*_once` option in the direction we need.
            // `cancelled` is the only honest answer — it unparks the agent
            // without claiming a permission we cannot express.
            { outcome: 'cancelled' }
          : { outcome: 'selected', optionId },
    });
  }

  // --- inbound ------------------------------------------------------------

  onReply(kind: PendingKind, result: unknown, id: JsonRpcId): AgentEvent[] {
    switch (kind) {
      case 'initialize':
        return this.onInitialized(result);
      case 'session':
      case 'session_load':
        // One reply shape, one handler: a loaded session is as ready as a new
        // one, and `onSessionReady` reads the resume id back for the load case
        // (`session/load` mints none — the id is the one we sent).
        return this.onSessionReady(result);
      case 'set_mode':
        // A mode the agent accepted needs no announcement; a mode it rejected
        // arrives as an error reply instead (see onErrorReply). What it DOES
        // need is recording: the mode outlives this turn, so the next one has
        // to know where the session actually is before deciding whether to move
        // it — see {@link pickMode}. Only on acceptance, so a refused frame
        // cannot make the client believe a mode it never got.
        this.session.currentModeId = this.requestedModeId;
        return [];
      case 'set_model':
        // Same contract as `set_mode` above: silence on acceptance, a `notice`
        // from `onErrorReply` on a refusal — and recorded for the same reason,
        // since this reply is the ONLY signal that the agent took the model.
        // The offers check in `applyModel` cannot stand in for it: that reads
        // the vocabulary the agent ENUMERATED, and a refusal is reachable past
        // it, so a model that passed it can still be running on something else.
        this.session.currentModelId = this.requestedModelId;
        // The NEW model's option list, which the parameters queued behind this
        // frame are resolved and checked against when they go out.
        this.modelReply = result;
        this.session.lastConfigReply = result;
        return this.onConfigAnswered(id);
      case 'set_model_parameter':
        // Silent too — but the next frame, or the prompt, waits on it.
        this.session.lastConfigReply = result;
        return this.onConfigAnswered(id);
      case 'prompt':
        return this.onPromptComplete(result, id);
    }
  }

  onErrorReply(
    kind: PendingKind,
    message: string,
    id: JsonRpcId,
  ): AgentEvent[] {
    if (kind === 'session_load') {
      if (this.options.input.resumeOnly === true) {
        // A resume-only turn has nothing to degrade TO. The fallback below is
        // right for an ordinary turn — it has a prompt to run, and running it
        // without the history beats losing it — but this turn's ONLY product
        // is the reopened conversation, so opening a fresh session would report
        // success while discarding the very thing the user pressed Retry to
        // recover.
        return [
          {
            type: 'error',
            message: `agent could not reopen this conversation: ${message}`,
          },
        ];
      }
      // The thread could not be reopened — so run the turn on a FRESH session
      // rather than ending it. A hard failure here is a dead end by
      // construction: every later turn of that chat resumes the same id, so the
      // conversation is unusable for good, and the user sees a turn that
      // finished instantly having written nothing. Losing the history is bad;
      // losing the chat is worse, and the notice is what keeps the loss from
      // being silent.
      //
      // Reachable in the ordinary way — the agent's store is not geniro's to
      // guarantee, and a chat whose session store was deleted (a cleared
      // userData dir, or the per-turn-profile defect this shipped with) is
      // exactly this. Measured against 2026.08.11-e8db854: a load of an id the
      // profile does not hold answers
      // `-32602 Invalid params {"message":"Session \"…\" not found"}`.
      const events: AgentEvent[] = [
        {
          type: 'notice',
          message: `agent could not reopen this conversation (${message}) — this turn runs on a fresh session, without the earlier history in its context`,
        },
      ];
      // Undo the replay bookkeeping the load armed: nothing is being replayed
      // now, and leaving `replaying` set would drop every transcript update of
      // the turn we are about to run.
      this.replaying = false;
      this.session.resumed = false;
      this.replayStartedAt = null;
      this.replayedUpdates = 0;
      // The fresh session holds none of what the refused load replayed.
      this.replayedInstructions = null;
      this.session.request(
        ACP_AGENT_METHODS.sessionNew,
        {
          cwd: this.options.input.cwd,
          mcpServers: this.session.grantedMcpServers,
        },
        'session',
        events,
      );
      return events;
    }
    if (
      this.withdrawn &&
      (kind === 'set_mode' ||
        kind === 'set_model' ||
        kind === 'set_model_parameter')
    ) {
      // A setting refused for a turn the user stopped before its prompt went
      // out — see {@link withdrawn}. There is no turn left to run on the
      // agent's own value, so the degrade sentence would be about nothing; and
      // said now it would reach the owner as off-turn output, which a settled
      // run reads as the agent working again.
      this.configSteps.length = 0;
      this.configInFlight = null;
      return [];
    }
    if (kind === 'set_mode') {
      // A refused mode is a degrade, not a failure: the turn still runs, just
      // in the agent's default mode. Say so rather than silently downgrading —
      // and say it at `warning`, which is what "a degrade, not a failure" has
      // meant all along and could not be expressed until the severity existed.
      return [
        {
          type: 'notice',
          severity: 'warning',
          message: `agent declined session mode '${this.requestedModeId ?? ''}': ${message}`,
        },
      ];
    }
    if (kind === 'set_model') {
      // Same shape as a refused mode, and the same reason it cannot be silent:
      // the turn goes on, on a model the user did not pick. Reachable even
      // after the offers check, because the check reads what the agent listed
      // and the agent is free to refuse anyway.
      //
      // The parameters queued behind it are DROPPED, on the rule the local
      // refusal in `applyModel` already follows: they belong to the model that
      // was refused, and setting them on whichever model the agent stayed on
      // would apply half of a selection the user never made.
      this.configSteps.length = 0;
      return [
        {
          type: 'notice',
          message: `agent declined model '${this.requestedModelId ?? ''}': ${message} — this turn runs on the agent's current model`,
        },
        ...this.onConfigAnswered(id),
      ];
    }
    if (kind === 'set_model_parameter') {
      // A degrade, like the two above: the turn runs, on the parameter value the
      // agent already had. Never silent, because a run the user set to `xhigh`
      // quietly thinking at `high` is a wrong turn that reports success — and
      // this arm is genuinely reachable, since a value is only offered for SOME
      // models and a chat's stored setting can name one the model dropped.
      //
      // A `warning`, not the default severity. Nothing failed: the turn ran and
      // went on running, which is precisely what made the full-width red panel
      // wrong — reported as "a strange error … and then it carried on working".
      // The frame is now only sent where it CANNOT be checked first (see
      // `applyModelParameters`), so this arm is the honest remainder rather than
      // the ordinary case it used to be.
      return [
        {
          type: 'notice',
          severity: 'warning',
          message: `the agent declined '${this.requestedParameter ?? ''}' (${message}) — the turn keeps its own value for it`,
        },
        // A refusal moves the queue on too: the setting did not apply, and a
        // turn must not be stranded behind a frame that was never going to
        // land. The notice above is what says so.
        ...this.onConfigAnswered(id),
      ];
    }
    if (
      kind === 'prompt' &&
      id === this.interruptedPromptId &&
      !this.stopRequested
    ) {
      // The prompt a mid-turn message stopped FAILED rather than answering
      // `cancelled` — it has stopped either way, and an `error` here would
      // settle the run as failed under the message about to be sent.
      return this.onInterruptConfirmed(id);
    }
    if (kind === 'prompt' && id !== this.latestPromptId) {
      // A SUPERSEDED prompt failed — same rule as {@link onPromptComplete}:
      // only the most recent prompt may end the turn. The open block is still
      // closed, exactly as a cancel closes one.
      this.dropSupersededFailure(id);
      return this.flushPending();
    }
    if (kind === 'prompt') {
      return this.onPromptFailed(message);
    }
    return [{ type: 'error', message: `acp ${kind} failed: ${message}` }];
  }

  /**
   * The turn's own last prompt answered with an error rather than a stop
   * reason — the same failure {@link onPromptComplete} reads from a reported
   * one, met where the CLI's own catch block does not reach it (cursor-agent
   * 2026.10.19-6bbf2c4 drains background-task completions after that block, so
   * a dropped stream there answers `-32603` instead of writing `Error: …`).
   */
  private onPromptFailed(message: string): AgentEvent[] {
    this.promptOutstanding = false;
    this.clearInterrupt();
    this.agentFailure = null;
    const dropped = this.dropped(this.queuedFollowUps.splice(0));
    const events: AgentEvent[] = [...this.flushPending(), ...dropped];
    const stillRunning = this.settleCutOffToolCalls(events);
    if (this.resumeAfterTransientFailure(message, events, stillRunning)) {
      return events;
    }
    return [
      ...events,
      { type: 'error', message: `acp prompt failed: ${message}` },
    ];
  }

  private onInitialized(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    const agentCapabilities = root ? asRecord(root.agentCapabilities) : null;
    const mcpCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.mcpCapabilities)
      : null;
    const promptCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.promptCapabilities)
      : null;
    const sessionCapabilities = agentCapabilities
      ? asRecord(agentCapabilities.sessionCapabilities)
      : null;
    this.session.capabilities = {
      loadSession: agentCapabilities?.loadSession === true,
      mcpHttp: mcpCapabilities?.http === true,
      promptImage: promptCapabilities?.image === true,
      // The RFD's own marker is an empty object; `true` is accepted the way
      // the client side accepts it, since both mean "supported".
      subagentSessions:
        sessionCapabilities?.subagents === true ||
        asRecord(sessionCapabilities?.subagents) !== null,
    };

    const version = root ? asNumber(root.protocolVersion) : null;
    if (version !== null && version !== ACP_PROTOCOL_VERSION) {
      // Best-effort: the agent named a version we don't implement. Keep going
      // (the methods we use are stable across v1) but leave a trace, because
      // this is the first thing to suspect if the turn behaves oddly.
      events.push({
        type: 'notice',
        message: `agent negotiated ACP protocol version ${version}; this client implements ${ACP_PROTOCOL_VERSION}`,
      });
    }

    const { mcpServers, notice } = this.buildMcpServers();
    this.session.grantedMcpServers = mcpServers;
    if (notice) {
      events.push({ type: 'notice', message: notice });
    }

    const resumeId = this.options.input.resumeSessionId?.trim();
    if (resumeId && this.session.capabilities.loadSession) {
      this.replaying = true;
      this.session.resumed = true;
      this.replayStartedAt = Date.now();
      this.session.request(
        ACP_AGENT_METHODS.sessionLoad,
        { sessionId: resumeId, cwd: this.options.input.cwd, mcpServers },
        'session_load',
        events,
      );
      return events;
    }
    if (this.options.input.resumeOnly === true) {
      // A resume-only turn that reaches here has nothing left to do: either the
      // agent does not advertise `loadSession`, or no id was given. Falling
      // through would open a FRESH session, and this turn's own branch in
      // `onSessionReady` would then settle it as a success — while
      // `createSessionIdSaver` wrote that new id over the one the run was
      // holding, destroying the pointer to the conversation being recovered.
      // The refused-load arm in `onErrorReply` covers a load the agent
      // REJECTED; this covers one that was never sent.
      return [
        {
          type: 'error',
          message: resumeId
            ? 'agent cannot reopen a conversation — it does not support loading a session'
            : 'there is no conversation to reopen',
        },
      ];
    }
    if (resumeId) {
      // Resume was asked for and the agent cannot do it. The turn still runs,
      // but it starts a FRESH conversation — the user must see that their
      // thread's history is not in this turn's context.
      events.push({
        type: 'notice',
        message:
          'this agent cannot resume a conversation — the turn starts fresh, without the earlier messages',
      });
    }
    this.session.request(
      ACP_AGENT_METHODS.sessionNew,
      { cwd: this.options.input.cwd, mcpServers },
      'session',
      events,
    );
    return events;
  }

  /**
   * Build the client-supplied MCP server list. The call token rides an HTTP
   * header inside a stdin JSON-RPC frame — never argv (`ps`-visible) and never
   * a file on disk, which is what both legacy delivery mechanisms had to use.
   */
  private buildMcpServers(): {
    mcpServers: AcpMcpServerHttp[];
    notice: string | null;
  } {
    const endpoint = this.options.input.mcpEndpoint;
    if (!endpoint) {
      return { mcpServers: [], notice: null };
    }
    if (!this.session.capabilities.mcpHttp) {
      // The awareness block goes with the tools. Leaving it in would instruct
      // the agent to route work through `call_agent` with nothing registered
      // under that name — its callees never run and the turn still reports
      // success, which is exactly what the pre-ACP degrade path prevented.
      return {
        mcpServers: [],
        notice:
          'agent calls disabled for this turn: the agent does not advertise HTTP MCP support (mcpCapabilities.http), so the callee list was removed from this turn’s instructions too',
      };
    }
    return {
      mcpServers: [
        {
          type: 'http',
          name: endpoint.serverName,
          url: endpoint.url,
          headers: [
            { name: 'Authorization', value: `Bearer ${endpoint.token}` },
          ],
        },
      ],
      notice: null,
    };
  }

  private onSessionReady(result: unknown): AgentEvent[] {
    const events: AgentEvent[] = [];
    const root = asRecord(result);
    // `session/new` mints an id; `session/load` returns none, because the id is
    // the one we just sent.
    this.session.sessionId =
      (root ? asString(root.sessionId) : null) ??
      this.options.input.resumeSessionId?.trim() ??
      null;
    // What a successful load replayed is what the conversation holds; a fresh
    // session holds nothing, and this is null for one.
    this.session.deliveredInstructions = this.replayedInstructions;
    this.replaying = false;
    this.reportReplayCost();

    if (this.session.sessionId === null) {
      return [
        {
          type: 'error',
          message: 'acp session failed: the agent returned no session id',
        },
      ];
    }
    events.push({ type: 'session', sessionId: this.session.sessionId });
    // The mode the agent OPENED in, and therefore the one a later turn that
    // wants no particular mode has to ask to be put back into.
    const openedIn = asString(asRecord(root?.modes)?.currentModeId);
    this.session.defaultModeId = openedIn;
    this.session.currentModeId = openedIn;
    // Keep the opening vocabulary and seed the current parameter snapshot;
    // config acceptances replace the latter — see `openOnLiveSession`.
    this.session.lastSessionReply = root;
    this.session.lastConfigReply = root;
    if (this.options.input.resumeOnly === true) {
      // The load reply IS the settle for this turn — the in-repo precedent is
      // `acpSessionLoadSettled` (`acp-sessions.ts`), which ends its spawned
      // handshake on exactly this frame. Nothing else could end it: no prompt
      // is in flight, so no stop reason is ever produced, and the turn would
      // otherwise wait out the transport's silence deadline and settle as a
      // failure having done precisely what it was asked to.
      //
      // The reading is still owed. `beginTurn` takes one on its way to a
      // prompt, and a reopened conversation is the case it exists for: the
      // window holds everything the agent already has.
      this.emitContextReading(events);
      events.push({
        type: 'turn_complete',
        usage: this.buildUsage(),
        // Neither is a figure this turn can honestly report: the agent was
        // asked nothing, so it stopped for no reason and answered nothing.
        stopReason: null,
        finalText: null,
      });
      return events;
    }
    this.beginTurn(root, events);
    return events;
  }

  /**
   * Put the agent on THIS turn's settings and send its prompt — the mode, the
   * model, the model's own parameters, then `session/prompt`.
   *
   * Shared by the two ways a turn opens (the `session/new`|`session/load` reply
   * for the first, {@link openOnLiveSession} for every later one) precisely so
   * they cannot drift: a later turn that skipped any of these would run under
   * the settings of the turn that happened to spawn the process.
   */
  private beginTurn(
    root: Record<string, unknown> | null,
    events: AgentEvent[],
  ): void {
    // Before the prompt goes out, so a RESUMED conversation shows what it
    // already holds for the whole of this turn instead of only once the turn
    // ends. A fresh session has written nothing yet and reads as no figure,
    // which is the honest answer for a window that holds nothing.
    this.emitContextReading(events);

    const modeId = this.pickMode(root);
    if (modeId !== null) {
      this.requestedModeId = modeId;
      this.session.request(
        ACP_AGENT_METHODS.sessionSetMode,
        { sessionId: this.session.sessionId, modeId },
        'set_mode',
        events,
      );
    } else if (this.options.preferredModeId) {
      // The requested mode was NOT applied. Either way this turn runs under
      // the agent's current mode, which for a read-only request like `plan`
      // means write access the user believed they had turned off — so it can
      // never be silent. WHICH message is truthful depends on what we sent: a
      // reply that enumerated modes and did not include this one is a refusal,
      // while one that enumerated none says nothing about what the agent offers.
      //
      // The `resumed` arm was written on the belief that a `session/load` reply
      // carries no `modes` block at all. That is REFUTED — measured on
      // 2026.08.11-e8db854, a load reply carries `modes`
      // (`currentModeId: 'agent'`, three `availableModes`), `models` and
      // `configOptions` alike, so a resumed turn takes the same path as a fresh
      // one and this arm is only reached if a build stops sending them. It was
      // mis-recorded because the reply could not be observed: cursor's session
      // store lived inside a per-turn config directory that was deleted on
      // settle, so every resume failed before its reply existed.
      events.push({
        type: 'notice',
        message: this.session.resumed
          ? `the '${this.options.preferredModeId}' mode could not be set on a resumed session — this turn runs under the agent's current mode`
          : `agent does not offer the '${this.options.preferredModeId}' mode — this turn runs under the agent's current mode instead`,
      });
    }

    // Queues the model and parameter frames; `advanceConfig` sends the first
    // and the prompt goes out behind the last (see `configSteps`). A turn
    // queueing nothing sends its prompt right here, as it always has.
    this.applyModel(root, events);
    this.promptHeld = true;
    this.advanceConfig(events);
  }

  /**
   * Send the next queued config frame — or, with none left, the prompt.
   *
   * The prompt follows the LAST frame straight down the pipe unless the agent
   * binds its settings when the prompt arrives
   * ({@link AcpSessionOptions.promptAwaitsConfig}), in which case it goes when
   * that frame is answered. A step that sends nothing is skipped.
   */
  private advanceConfig(events: AgentEvent[]): void {
    for (
      let step = this.configSteps.shift();
      step;
      step = this.configSteps.shift()
    ) {
      const id = step.send(events);
      if (id === null) {
        continue;
      }
      this.configInFlight = id;
      if (
        this.configSteps.length === 0 &&
        this.session.options.promptAwaitsConfig !== true
      ) {
        this.sendHeldPrompt(events);
      }
      return;
    }
    this.configInFlight = null;
    this.sendHeldPrompt(events);
  }

  /** The prompt, if it is still waiting behind the config frames. */
  private sendHeldPrompt(events: AgentEvent[]): void {
    if (!this.promptHeld) {
      return;
    }
    this.promptHeld = false;
    this.sendPrompt(events);
  }

  /** The turn's prompt — composed once, whether it goes now or after a reply. */
  private sendPrompt(events: AgentEvent[]): void {
    if (this.options.input.resumeOnly === true) {
      // The ONE place a prompt frame is written, so the one place that can
      // guarantee this turn never sends one. Both openers reach here by their
      // own route — `onSessionReady` after a handshake, `openOnLiveSession`
      // when the process is kept — and only the first carries the branch that
      // settles the turn, so a turn opened on a live session would otherwise
      // send the very frame this mode exists to withhold.
      return;
    }
    if (this.session.sessionId === null) {
      return;
    }
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.session.sessionId,
        prompt: this.composePromptBlocks(events),
      },
      'prompt',
      events,
    );
    if (id !== null) {
      this.latestPromptId = id;
      this.promptOutstanding = true;
      // Recorded on the WRITE, not on composing it: a prompt that never left is
      // a prompt the agent has not been told the instructions by, and marking
      // them delivered there would withhold them from the retry.
      if (this.promptInstructions !== null) {
        this.session.deliveredInstructions = this.promptInstructions;
      }
    }
  }

  /**
   * Deliver a user message into the turn already running — {@link
   * TurnDriver.sendFollowUp}.
   *
   * **ACP has no frame that ADDS to a prompt in flight, so a message mid-turn
   * STOPS the prompt and follows it with its own** — and it does so in that
   * order: `session/cancel`, the stopped prompt's reply, then the new
   * `session/prompt`. It used to send the second prompt straight away, which
   * this CLI answers by cancelling the first (probed on 2026.08.11-e8db854),
   * and which is wrong for a reason only a CHAIN of messages shows: measured on
   * cursor-agent 2026.09.10-fd3934a, a prompt that was itself sent to interrupt
   * another can never be cancelled — neither by the next prompt nor by a
   * `session/cancel` — and runs on to `end_turn` beside the prompt that
   * replaced it, repeating every step (grok-4.7 3/3 runs, gpt-5.6-sol 1/1).
   * REPORTED as a QA member running fourteen reviewers where it had launched
   * seven, then working on after its call had returned, from a conversation
   * whose history no longer held the correction its caller had sent. Cancel
   * first and wait, and every prompt stops cleanly — measured through a chain
   * of four. That is also simply the protocol's own shape: `session/prompt` is
   * one request per turn, and `session/cancel` is how a client ends one.
   *
   * The adapter declares that a message INTERRUPTS (`followUp.interrupts`), so
   * the user is told what a press costs before they make it; nothing here
   * decides it. What the stopped stretch had already said is not lost — the
   * open block is closed at the interrupt, as a Stop closes one.
   *
   * True means ACCEPTED, and a message accepted while the cancel is in flight
   * is sent when the agent confirms: the caller commits its row either way.
   * When it never goes out — a Stop pressed in that window, the process ending
   * under the turn, or the prompt failing to write — the turn emits
   * `follow_up_dropped` naming its `deliveryId`, ahead of its terminal, so the
   * owner can mark that row unsent.
   */
  sendFollowUp(message: FollowUpMessage): boolean {
    // No session yet, or a prompt still held behind a parameter frame: in both
    // the turn's OWN prompt has not gone out, so there is nothing to interrupt
    // and a follow-up would race it. False leaves the message queued, which is
    // the safe answer.
    //
    // A resume-only turn needs no clause of its own here: it runs on a process
    // spawned for it, so its session id is null until the load reply, and that
    // reply settles the turn. `ChatService.retry` is what keeps that true, by
    // closing a kept session before it starts one.
    const sessionId = this.session.sessionId;
    if (sessionId === null || this.promptHeld) {
      return false;
    }
    // A cancel already in flight: the prompt it stops has not answered yet,
    // and a second interrupt now would stop a prompt this turn has not even
    // sent. The message rides with the one already waiting.
    if (this.interruptedPromptId !== null) {
      this.queuedFollowUps.push(message);
      return true;
    }
    // Nothing is running — a transient-failure pause, whose failed prompt has
    // already answered. The message carries the turn on by itself.
    if (!this.promptOutstanding) {
      const events: AgentEvent[] = [];
      const sent = this.sendFollowUpPrompt([message], events);
      for (const event of events) {
        this.session.emit(event);
      }
      return sent;
    }
    // The prompt is out and background sub-agents are running: see
    // {@link subagentsAFollowUpCancels}. Unless the user chose to give them up
    // the message is NOT delivered: false is the caller's RUN_BUSY, which
    // queues it, and it goes out once the turn ends. Said once per turn, so
    // the queue is not a mystery.
    if (
      this.subagentsAFollowUpCancels() > 0 &&
      message.cancelBackgroundWork !== true
    ) {
      if (!this.warnedQueuedForSubagents) {
        this.warnedQueuedForSubagents = true;
        this.session.emit({
          type: 'notice',
          severity: 'info',
          message: QUEUED_FOR_SUBAGENTS_NOTICE,
        });
      }
      return false;
    }
    // A notification, so a write that did not land is the only failure there
    // is — and then nothing has changed and the message stays with its caller.
    if (
      !this.session.write(
        encodeNotification(ACP_AGENT_METHODS.sessionCancel, { sessionId }),
      )
    ) {
      return false;
    }
    // What the agent had already said is finished the moment it is told to
    // stop, and closing it HERE is what keeps it one row instead of a blob
    // merged with whatever the agent emits between the frame and its reply.
    // It does not decide where the row lands relative to the user's message:
    // the turn's events persist through a serialized chain while
    // `deliverIntoRunningTurn` reserves its own seq directly, so the user row
    // wins and the stopped text is filed under it.
    const events: AgentEvent[] = [...this.flushPending()];
    // The protocol's own rule for a `session/cancel`: every request still
    // parked MUST be answered `cancelled`. The old path left them unanswered —
    // the agent dropped them on its side, and their cards stayed on screen
    // with nothing behind a verdict. Withdrawn, so the owner retires each one.
    for (const id of this.releaseParkedRequests()) {
      events.push({ type: 'approval_withdrawn', id });
    }
    this.interruptedPromptId = this.latestPromptId;
    this.queuedFollowUps.push(message);
    this.armInterruptDeadline();
    for (const event of events) {
      this.session.emit(event);
    }
    return true;
  }

  /**
   * An agent with sub-agent SESSIONS holds its prompt open for its background
   * sub-agents, and anything that ends that prompt — `session/cancel`, or a
   * second prompt — cancels every one of them. Measured on cursor-agent
   * 2026.10.01-e373342: a prompt sent while a background sub-agent held the
   * turn answered the first `cancelled` and the sub-agent
   * `subagent_state_update: cancelled` within 3ms; 2026.10.22-27dcf5f's
   * `handlePrompt` still aborts the turn's sub-agents first.
   */
  subagentsAFollowUpCancels(): number {
    return this.session.capabilities.subagentSessions &&
      this.promptOutstanding &&
      this.interruptedPromptId === null
      ? this.session.runningBackgroundDelegates()
      : 0;
  }

  /**
   * The agent confirmed it stopped the prompt a message interrupted: close
   * what that prompt left open, and send what was waiting.
   */
  private onInterruptConfirmed(id: JsonRpcId): AgentEvent[] {
    this.clearInterrupt();
    this.promptOutstanding = false;
    // A failure the stopped prompt reported belongs to it, never to the
    // message that replaced it.
    this.dropSupersededFailure(id);
    const events: AgentEvent[] = [
      ...this.flushPending(),
      ...this.closeInterruptedToolCalls(),
    ];
    events.push(...this.sendQueuedFollowUps());
    return events;
  }

  /**
   * Bound the wait for the stopped prompt's reply — see
   * {@link INTERRUPT_ACK_DEADLINE_MS}. Past it the waiting messages go out as
   * the old path sent them, and the stopped prompt's reply, whenever it lands,
   * reads as superseded.
   */
  private armInterruptDeadline(): void {
    const interrupted = this.interruptedPromptId;
    this.interruptTimer = setTimeout(() => {
      this.interruptTimer = null;
      // A Stop owns what happens next, and a turn that has ended or been
      // replaced owns nothing a prompt could be sent on.
      if (
        this.interruptedPromptId !== interrupted ||
        this.stopRequested ||
        !this.session.isCurrentTurn(this)
      ) {
        return;
      }
      this.interruptedPromptId = null;
      this.session.options.logger?.warn(
        `acp: prompt ${String(interrupted)} did not answer its session/cancel within ${INTERRUPT_ACK_DEADLINE_MS}ms — sending the waiting message anyway`,
      );
      const events: AgentEvent[] = [
        {
          type: 'notice',
          severity: 'warning',
          message:
            'The agent did not confirm it had stopped before your message — it was sent anyway, and the agent may carry on with its earlier work beside it.',
        },
      ];
      events.push(...this.sendQueuedFollowUps());
      for (const event of events) {
        this.session.emit(event);
      }
    }, INTERRUPT_ACK_DEADLINE_MS);
    this.interruptTimer.unref?.();
  }

  /**
   * The process ended before this turn's last prompt answered — Stop's group
   * kill when the agent never confirmed the cancel, or a crash. Whatever was
   * waiting behind the cancel goes with it — `TurnDriver.onProcessEnded`.
   */
  onProcessEnded(): AgentEvent[] {
    this.clearInterrupt();
    return this.dropped(this.queuedFollowUps.splice(0));
  }

  /** `TurnDriver.onQuiet`: the text block only, as a held call is still being written. */
  onQuiet(): AgentEvent[] | null {
    if (
      !this.promptOutstanding ||
      this.stopRequested ||
      this.interruptedPromptId !== null ||
      this.openToolCalls.size > 0 ||
      this.heldToolCalls.size > 0 ||
      this.subagentsAFollowUpCancels() > 0
    ) {
      return null;
    }
    return this.flushTextBlock();
  }

  /** Forget an interrupt in flight — confirmed, or overtaken by a Stop. */
  private clearInterrupt(): void {
    this.interruptedPromptId = null;
    if (this.interruptTimer !== null) {
      clearTimeout(this.interruptTimer);
      this.interruptTimer = null;
    }
  }

  /**
   * Record how a permission was answered ON THE WIRE: anything but a selected
   * allow option — a reject, or `cancelled` because the agent offered no option
   * in the verdict's direction — means the step does not run.
   */
  private recordAnswer(toolCallId: string, granted: boolean): void {
    if (granted) {
      this.session.refusedToolCalls.delete(toolCallId);
    } else {
      this.session.refusedToolCalls.add(toolCallId);
    }
  }

  /**
   * The `result` and `isError` of a settled call. The agent closes a call whose
   * permission geniro refused as `completed`, so the refusal mark decides, and
   * a body the agent sent is kept over {@link REFUSED_TOOL_RESULT}.
   */
  private settledOutcome(
    call: AcpToolCall,
    body: unknown,
  ): { result: unknown; isError: boolean } {
    if (this.session.refusedToolCalls.delete(call.toolCallId)) {
      return { result: body ?? REFUSED_TOOL_RESULT, isError: true };
    }
    return { result: body, isError: call.status === 'failed' };
  }

  /** A parent request stopping is not a report about its delegate's outcome. */
  private cutOffToolCall(id: string, result: string): AgentEvent[] {
    const delegate = this.session.delegateToolCalls.has(id);
    const events: AgentEvent[] = [
      {
        type: 'tool_result',
        id,
        name: this.session.toolNames.get(id) ?? null,
        result: delegate ? null : result,
        isError: !delegate,
      },
    ];
    if (delegate) {
      events.push(this.session.closeCutOffDelegate(id));
    }
    return events;
  }

  /** Close the calls the stopped prompt left open. */
  private closeInterruptedToolCalls(): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const id of this.openToolCalls) {
      events.push(...this.cutOffToolCall(id, INTERRUPTED_TOOL_RESULT));
    }
    this.openToolCalls.clear();
    return events;
  }

  /**
   * Send the user's messages as ONE prompt, answering whether it went out.
   *
   * Several only when more than one arrived while a cancel was in flight; they
   * are joined in the order they were sent, since each was typed as the next
   * thing to say.
   */
  private sendFollowUpPrompt(
    messages: readonly FollowUpMessage[],
    events: AgentEvent[],
  ): boolean {
    const sessionId = this.session.sessionId;
    if (messages.length === 0 || sessionId === null) {
      return false;
    }
    const images = messages.flatMap((message) =>
      buildAcpImageBlocks(message.images),
    );
    // Gated on the agent's OWN advertised capability, the same check the turn's
    // opening prompt passes through: an unadvertised image block earns an error
    // reply, which here would lose the message rather than merely the picture.
    const withImages =
      images.length > 0 && this.session.capabilities.promptImage;
    if (images.length > 0 && !withImages) {
      events.push({
        type: 'notice',
        message: `agent does not accept image prompts — ${images.length} attached image${images.length === 1 ? ' was' : 's were'} not sent with this message`,
      });
    }
    const blocks: AcpContentBlock[] = [
      ...(withImages ? images : []),
      {
        type: 'text',
        text: messages.map((message) => message.text).join('\n\n'),
      },
    ];
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      { sessionId, prompt: blocks },
      'prompt',
      events,
    );
    if (id === null) {
      return false;
    }
    this.latestPromptId = id;
    this.promptOutstanding = true;
    // A message pushed through during a resume PAUSE carries the turn on by
    // itself, so the scheduled "continue where you left off" is called off —
    // fired later, it would stop the user's own prompt, or start one nobody
    // asked for once that one has ended the turn.
    this.cancelScheduledResume();
    // Likewise a hold for background delegates: the message carries the turn
    // on, and the prompt it starts decides afresh whether to wait for them.
    if (this.awaitingDelegates) {
      this.endHold();
    }
    events.push(...this.flushPending());
    return true;
  }

  /**
   * Send what waited behind the cancel. A send that fails reports its messages
   * dropped AHEAD of the error it ends the turn with: anything after a
   * terminal reaches the owner as off-turn work, after the run has settled.
   */
  private sendQueuedFollowUps(): AgentEvent[] {
    const waiting = this.queuedFollowUps.splice(0);
    const events: AgentEvent[] = [];
    return this.sendFollowUpPrompt(waiting, events)
      ? events
      : [...this.dropped(waiting), ...events];
  }

  /**
   * Report accepted follow-ups that will never reach the agent. Their owner
   * wrote each row when {@link sendFollowUp} answered true, so without this the
   * transcript shows them as sent.
   */
  private dropped(messages: readonly FollowUpMessage[]): AgentEvent[] {
    const deliveryIds = messages.flatMap((message) =>
      message.deliveryId === undefined ? [] : [message.deliveryId],
    );
    return deliveryIds.length === 0
      ? []
      : [{ type: 'follow_up_dropped', deliveryIds }];
  }

  /**
   * The in-protocol "stop what you are doing" — `TurnDriver.buildInterruptPayload`.
   *
   * ACP's own answer, and the ONLY correct one now that the process outlives its
   * turn: `session/cancel` is a NOTIFICATION (no id, no reply), and the spec
   * requires the agent to answer the pending `session/prompt` with stop reason
   * `cancelled`, which is what actually settles the turn. `spawn-cli` arms a
   * short deadline behind the write and kills the group only if that reply never
   * comes, so an agent that ignores the frame still stops.
   *
   * Killing instead is what it used to do and is no longer acceptable: the group
   * holds the whole conversation and every delegate still out, so Stop on one
   * turn would destroy the chat. It is also why this is a DRIVER hook rather
   * than an adapter one — the frame names the session id, which only the driver
   * holds.
   *
   * Undefined before the session exists: there is nothing to cancel, and
   * `spawn-cli` falls back to the group kill, which is the right answer for a
   * process that has not yet opened a conversation to lose.
   */
  buildInterruptPayload(): string | undefined {
    if (this.session.sessionId === null) {
      return undefined;
    }
    // Recorded so nothing this turn does next can carry on past the Stop — the
    // transient-failure resume in particular, which would otherwise answer a
    // failure the cancel provoked with a fresh prompt the user never sent.
    this.stopRequested = true;
    // Every parked request is answered BEFORE the cancel goes out. ACP's own
    // schema, on the `Cancelled` permission outcome: "When a client sends a
    // `session/cancel` notification to cancel an ongoing prompt turn, it MUST
    // respond to all pending `session/request_permission` requests with this
    // `Cancelled` outcome." Left unanswered they stayed parked on the agent
    // while their cards were written off with the stopped turn.
    this.releaseParkedRequests();
    return encodeNotification(ACP_AGENT_METHODS.sessionCancel, {
      sessionId: this.session.sessionId,
    });
  }

  /**
   * Answer every request parked on this session, because a `session/cancel`
   * is about to stop the prompt they belong to — a Stop's
   * ({@link buildInterruptPayload}) or a mid-turn message's
   * ({@link sendFollowUp}). Answers with the ids it released.
   *
   * A permission gets the protocol's `cancelled`; a QUESTION gets its agent's
   * own declined reply, since a question has no `cancelled` in the vendor's
   * shape and the one thing it must not be left is unanswered — its handler
   * waits on the reply with no deadline of its own.
   */
  private releaseParkedRequests(): string[] {
    const released: string[] = [];
    for (const [encodedId, parked] of [...this.session.parkedPermissions]) {
      this.session.parkedPermissions.delete(encodedId);
      this.recordAnswer(parked.toolCallId, false);
      released.push(encodedId);
      const requestId = decodeRequestId(encodedId);
      if (requestId !== null) {
        this.session.reply(requestId, { outcome: { outcome: 'cancelled' } });
      }
    }
    const question = this.session.options.question;
    for (const [encodedId, params] of [...this.session.parkedQuestions]) {
      this.session.parkedQuestions.delete(encodedId);
      released.push(encodedId);
      const requestId = decodeRequestId(encodedId);
      if (requestId !== null && question !== undefined) {
        this.session.reply(
          requestId,
          question.encodeReply(params, false, undefined),
        );
      }
    }
    return released;
  }

  /**
   * Withdraw this turn's prompt if it has not gone to the agent yet —
   * `TurnDriver.withdrawHeldPrompt`, asked by a Stop before anything is sent.
   *
   * True only while the prompt waits behind this turn's own config frames
   * (`promptHeld`). Then the agent has been asked nothing: a `session/cancel`
   * would cancel no prompt, the agent would stay silent, and the config reply
   * arriving next would release the prompt INTO the stopped turn — the agent
   * then ran it anyway, or the 5-second fallback killed the whole process
   * group, conversation and delegates with it. Withdrawing drops the prompt and
   * every frame still queued ahead of it, and the frame already in flight is
   * answered into a turn that is over (see {@link withdrawn}).
   *
   * False before the session exists (the handshake is the process's, and
   * killing a process that holds no conversation loses nothing) and once the
   * prompt is out, where the ordinary in-protocol cancel is the answer.
   */
  withdrawHeldPrompt(): boolean {
    if (this.awaitingDelegates) {
      // Held for background delegates: the prompt has answered and nothing is
      // out, so a Stop simply ends the wait. The delegates themselves run on
      // inside the process — no protocol frame reaches them.
      this.endHold();
      this.stopRequested = true;
      return true;
    }
    if (this.cancelScheduledResume()) {
      // Paused between a transient failure and its resume: the failed prompt
      // has already answered and the next one is not out, so this turn holds
      // nothing the agent could be told to stop.
      this.stopRequested = true;
      return true;
    }
    if (!this.promptHeld || this.session.sessionId === null) {
      return false;
    }
    this.promptHeld = false;
    this.withdrawn = true;
    this.configSteps.length = 0;
    return true;
  }

  /**
   * A frame this turn sent has gone unanswered past its deadline.
   *
   * The SAME shape a refusal takes (`onErrorReply`), and deliberately so: the
   * setting did not apply either way, and what a turn must not do is sit behind
   * a frame that is never going to land. So a notice says what was lost and the
   * prompt is released — never a teardown, since the session is perfectly able
   * to run this turn on whatever the agent kept, which is what it would have
   * done had the frame never been sent at all.
   */
  onRequestDeadline(
    id: JsonRpcId,
    kind: PendingKind,
    ms: number,
  ): AgentEvent[] {
    // Only the frame the queue is waiting on has anything to rescue — the
    // frames behind it and, until the queue drains, the prompt. Once the prompt
    // has gone out (it follows the last frame down the pipe unless the agent
    // asks it to wait, `promptAwaitsConfig`) the turn has run on regardless of
    // what this reply would have said.
    //
    // Speaking anyway is worse than silence: an event emitted once the turn has
    // settled reaches the off-turn handler, which reads a `notice` as the run
    // WORKING again — and since nothing terminal follows it, the badge stays
    // that way until the session closes.
    if (!this.promptHeld || this.configInFlight !== id) {
      return [];
    }
    const released = this.onConfigAnswered(id);
    // A release whose prompt did not actually go out means the TURN is gone —
    // the process was killed, or the pipe closed under it. Nothing here has a
    // reader in that case, and both halves would be untrue: the notice would
    // promise a turn that runs on, and the failed write's own error would
    // report a send nobody is waiting for. The session outlives its turns and
    // holds no settle signal, so this is what stands in for one — a prompt that
    // still writes is the evidence the turn is there to be told.
    if (released.some((event) => event.type === 'error')) {
      return [];
    }
    return [
      {
        type: 'notice',
        severity: 'warning',
        message: `the agent did not answer '${kind}' within ${Math.round(ms / 1000)}s — this turn runs on its own settings`,
      },
      ...released,
    ];
  }

  /**
   * A config frame has been answered — send the next one, or the prompt.
   *
   * Called for a REFUSAL and an expired deadline as well as an acceptance: a
   * turn must not be stranded because a setting did not apply. The refusal
   * itself is narrated by `onErrorReply`, so the turn runs on whatever the agent
   * kept, which is what it would have done had the frame never been sent.
   */
  private onConfigAnswered(id: JsonRpcId): AgentEvent[] {
    // Only the frame the queue is waiting on moves it — a reply matched by
    // id, so nothing else can release the prompt early.
    if (this.configInFlight !== id) {
      return [];
    }
    this.configInFlight = null;
    const events: AgentEvent[] = [];
    this.advanceConfig(events);
    return events;
  }

  /**
   * Put the turn on the model it asked for, before the prompt goes out.
   *
   * Queued ahead of its parameters (`configSteps`), with the prompt behind the
   * last of them — pipelined, unless the agent binds its settings when the
   * prompt arrives ({@link AcpSessionOptions.promptAwaitsConfig}); then the
   * prompt waits for this frame's reply when it is the last one.
   *
   * A turn that names no model is left alone — the agent's own default is the
   * right answer, and forcing the id it just reported as current would spend a
   * frame to change nothing.
   */
  private applyModel(
    sessionResult: Record<string, unknown> | null,
    events: AgentEvent[],
  ): void {
    if (this.session.sessionId === null) {
      return;
    }
    // The adapter's split when it supplied one, else the stored id verbatim.
    const selection = this.options.modelSelection ?? {
      model: this.options.input.model ?? null,
      parameters: [],
    };
    const wanted = selection.model?.trim();
    // The agent's own statement SEEDS the field, and only while it is still
    // unset. Every later turn on a kept process is handed the STORED
    // `session/new` reply, which names the model the session was CREATED with —
    // so re-seeding from it once per turn would undo a switch an earlier turn
    // had confirmed. Same rule `pickMode` states for the mode: the reply says
    // where the session started, never where it is now.
    const announced = readAcpCurrentModelId(sessionResult);
    if (
      this.session.currentModelId === null &&
      announced !== null &&
      announced !== ''
    ) {
      this.session.currentModelId = announced;
    }
    // The requested model is ANNOUNCED, never RECORDED. `currentModelId` holds
    // what the agent CONFIRMED — the `set_model` acceptance arm in `onReply` is
    // what moves it — while `turn_model` reports what this turn asked to run
    // as. The two differ exactly while a switch is unconfirmed, and that
    // difference is load-bearing downstream: it is what
    // `PartialStreamService.rememberWindow`'s anti-poisoning guard compares —
    // a settle reading labelled with the unconfirmed model is refused, and the
    // owner keeps the window it already had.
    // Writing `wanted` here would collapse both of that guard's operands onto
    // this one field — cursor's context reading names no model, so a window's
    // own label falls back to it too — leaving the guard comparing a value
    // against itself, unable to fire, and filing a refused model's window under
    // the requested one.
    const runningAs = wanted ? wanted : this.session.currentModelId;
    if (runningAs !== null && runningAs !== '') {
      events.push({ type: 'turn_model', model: runningAs });
    }
    // Parameters are applied EVEN WHEN the model needs no change — they are a
    // separate axis, and a run that keeps the agent's current model while
    // choosing a different effort is the ordinary case for a chat left on
    // "default model". Both early returns below therefore fall through to them.
    // Against what the session is ON now, not against the reply — which on any
    // turn but the first describes a model an earlier turn may have switched
    // away from, so comparing with it re-sends the frame every turn.
    if (!wanted || this.session.currentModelId === wanted) {
      // The one path where the reply on hand DESCRIBES the model this turn will
      // run on — nothing is switching — so a parameter it does not offer can be
      // answered here instead of by a refusal from the agent.
      this.applyModelParameters(selection.parameters, sessionResult, true);
      return;
    }
    // The offers check applies only when the agent actually ENUMERATED a
    // vocabulary. It exists to save a round-trip to be refused, and that is
    // worth doing only against a reply that says what is on offer — silence is
    // not a refusal. `readAcpModels` states the contract this obeys: an empty
    // result means "the agent said nothing", never "the agent has no models",
    // and every caller must read it as unknown.
    //
    // A reply is free to say nothing here, and reading silence as "not offered"
    // would refuse LOCALLY — asserting something the agent never said, on the
    // path every turn after a chat's first takes (cursor cannot keep its
    // process, so those all resume). Sending it and letting the agent answer is
    // strictly better: `onErrorReply` turns a genuine refusal into the same
    // notice, earned rather than assumed. So there is no branch on `resumed`.
    //
    // A `session/load` reply was recorded here as carrying no model block at
    // all. REFUTED on 2026.08.11-e8db854: it carries `models.currentModelId`
    // AND a full `configOptions` list with each option's `currentValue`, so a
    // resumed turn reads the same fields as a fresh one and applies the model
    // through `set_config_option` exactly as it does on turn 1 (measured:
    // `model=claude-opus-5` then `effort=xhigh` both ACCEPTED on a loaded
    // session). The old note was written when no resume could succeed — the
    // session store was being deleted with the turn's config directory.
    const offered = readAcpModels(sessionResult);
    if (offered.length > 0 && !acpOffersModel(sessionResult, wanted)) {
      // Never silent, for the reason the mode degrade above is not: a member the
      // user pointed at one model quietly running on another is a wrong turn
      // that reports success.
      events.push({
        type: 'notice',
        message: `agent does not offer the model '${wanted}' — this turn runs on the agent's current model instead`,
      });
      // Deliberately WITHOUT the parameters. They belong to the model that was
      // refused, and setting them against whichever model the agent stays on
      // would apply half of a selection the user never made.
      return;
    }
    this.requestedModelId = wanted;
    // ACP 1.0 stabilized `session/set_config_option`, the general form that
    // replaces `session/set_model`. Which one this agent gets is decided by
    // whether IT enumerated a model config option, not by its version string —
    // an agent that listed its models there implements the method that sets
    // them. Both replies route to the same `set_model` pending kind: the
    // operation the user asked for is "put this turn on that model", and the
    // degrade notice owes them that sentence whichever frame carried it.
    const configId = readAcpModelConfigId(sessionResult);
    const sessionId = this.session.sessionId;
    this.configSteps.push({
      send: (sent) =>
        configId !== null
          ? this.session.sendRequest(
              ACP_AGENT_METHODS.sessionSetConfigOption,
              { sessionId, configId, value: wanted },
              'set_model',
              sent,
            )
          : this.session.sendRequest(
              ACP_AGENT_METHODS.sessionSetModel,
              { sessionId, modelId: wanted },
              'set_model',
              sent,
            ),
    });
    // AFTER the model frame, never instead of it: a parameter's own existence
    // depends on which model is current, so this ordering is the contract. The
    // reply on hand describes the model being switched AWAY from, so nothing
    // is checked against it — each parameter is checked against the model
    // frame's own reply instead, once that has come back (`modelReply`).
    this.applyModelParameters(selection.parameters, sessionResult, false);
  }

  /**
   * Set the model's own parameters — a reasoning effort, a context size — after
   * the model frame and before the prompt.
   *
   * Each frame carries `configId`/`value`, which is the only shape this protocol
   * has for a parameter. An agent with no config-option support answers
   * `-32601` and the turn continues on its defaults.
   *
   * `describesTurnModel` is the whole of what makes a LOCAL answer legitimate,
   * and it is why this cannot simply check every parameter. A config option's
   * available values belong to the model that was current when the reply was
   * written, so:
   *
   * - When the turn is NOT switching models, that reply describes the model this
   *   turn will run on, so the vocabulary on hand is the right one and a value
   *   outside it can be refused here — with a sentence naming what the model
   *   does take, rather than by spending a round-trip to be told `Invalid
   *   params`.
   * - When the turn IS switching, the reply describes the PREVIOUS model and
   *   says nothing about the new one. Each parameter now goes out only after
   *   the model frame is answered (see `configSteps` for why the frames cannot
   *   be pipelined), and that reply carries the new model's full option list —
   *   so the check runs against it (`modelReply`). A model frame answered with
   *   no list (the pre-1.0 `session/set_model`) leaves nothing to check, and
   *   the frame goes out as handed and the agent answers.
   *
   * The vocabulary really is per-MODEL, which the config's `efforts` list had
   * recorded as a possibility and this now answers with measurements (same
   * build, 2026-08-19): `claude-opus-5` offers `low|medium|high|xhigh|max`,
   * `grok-4.6` offers the same minus `max`, and `auto-smart` and `composer-2.5`
   * enumerate no `effort` option at all — so a chat that remembers `max` per CLI
   * and is then pointed at Grok asks for a value that model has never had.
   */
  private applyModelParameters(
    parameters: readonly AcpModelParameter[],
    sessionResult: unknown,
    describesTurnModel: boolean,
  ): void {
    const sessionId = this.session.sessionId;
    if (sessionId === null) {
      return;
    }
    for (const parameter of parameters) {
      this.configSteps.push({
        send: (events) => {
          // Read at SEND time: by then the model frame ahead of this one has
          // been answered, and its reply is the list that describes the model
          // this parameter will actually land on.
          const describing = this.optionsDescribingTurnModel(
            sessionResult,
            describesTurnModel,
          );
          const configId =
            describing === null
              ? parameter.id
              : this.resolveParameterId(parameter, describing);
          if (
            describing !== null &&
            this.refuseUnofferedParameter(
              { ...parameter, id: configId },
              describing,
              events,
            )
          ) {
            return null;
          }
          if (
            this.session.options.skipUnchangedParameters === true &&
            readAcpConfigOption(describing, configId)?.currentValue ===
              parameter.value
          ) {
            return null;
          }
          this.requestedParameter = `${configId}=${parameter.value}`;
          return this.session.sendRequest(
            ACP_AGENT_METHODS.sessionSetConfigOption,
            { sessionId, configId, value: parameter.value },
            'set_model_parameter',
            events,
          );
        },
      });
    }
  }

  /**
   * The option list that describes the model this turn's parameters land on,
   * or null when none on hand does. Agents that compare current values use
   * the latest reply, including parameter replies and earlier live turns.
   */
  private optionsDescribingTurnModel(
    sessionResult: unknown,
    describesTurnModel: boolean,
  ): unknown {
    if (this.session.options.skipUnchangedParameters === true) {
      // Only a confirmed model reply can replace the old model's list during
      // a switch. After that, each parameter reply is the newest snapshot.
      return describesTurnModel || this.modelReply !== null
        ? this.session.lastConfigReply
        : null;
    }
    if (readAcpConfigOptions(this.modelReply).length > 0) {
      return this.modelReply;
    }
    return describesTurnModel ? sessionResult : null;
  }

  /**
   * Which SPELLING of this setting the current model actually offers.
   *
   * One setting can be named differently by different models of one agent, and
   * that is a real property of this protocol rather than a quirk to paper over:
   * a config option's id belongs to the model, and the vendor is free to call
   * the same axis two things. Measured on cursor-agent 2026.08.11-e8db854 —
   * `claude-opus-5` and `grok-4.6` call the reasoning axis `effort`, `gpt-5.2`
   * calls it `reasoning`, and sending the other name is
   * `-32602 Unknown model config option`. So a caller that knows its CLI's
   * spellings supplies them (`alternateIds`) and the FIRST one this model
   * enumerates wins.
   *
   * Only reachable where the reply describes the turn's model, for the same
   * reason the refusal above is: the ids on a reply about a different model say
   * nothing about this one. Nothing offered, nothing known — the caller's own
   * id goes out and the agent answers.
   */
  private resolveParameterId(
    parameter: AcpModelParameter,
    sessionResult: unknown,
  ): string {
    for (const id of [parameter.id, ...(parameter.alternateIds ?? [])]) {
      if (readAcpConfigOption(sessionResult, id) !== null) {
        return id;
      }
    }
    return (
      this.adoptParameterByCategory(parameter, sessionResult) ?? parameter.id
    );
  }

  /**
   * The same setting under a spelling nobody has measured — adopted from its
   * CATEGORY, and only when the adoption cannot be wrong in a way that shows.
   *
   * Two conditions, both narrowing: the option is in the category the caller
   * declared, and it OFFERS the very value being set. The second is what makes
   * this safe where a bare category match would not be — a category can hold
   * more than one axis (cursor puts a `false|true` thinking toggle under
   * `thought_level` beside the graded effort axis on 10 of 37 models), and no
   * level this app sends is one of those two words. A tie adopts NOTHING: two
   * options offering the same value is a coin flip on which axis the user's
   * choice is written to, and the caller's own id going out unchanged earns the
   * agent's own refusal, which at least says so on the turn.
   */
  private adoptParameterByCategory(
    parameter: AcpModelParameter,
    sessionResult: unknown,
  ): string | null {
    if (parameter.category === undefined) {
      return null;
    }
    const candidates = readAcpConfigOptions(sessionResult).filter(
      (option) =>
        option.category === parameter.category &&
        option.options.some(({ value }) => value === parameter.value),
    );
    return candidates.length === 1 ? (candidates[0]?.id ?? null) : null;
  }

  /**
   * Whether this parameter is one the CURRENT model cannot take — and if so,
   * says so instead of sending it.
   *
   * Only ever consulted against a reply that describes the model the turn will
   * run on (see `describesTurnModel` above). Silence is not a refusal here
   * either: an agent that enumerated NO options for this id has said nothing
   * about it, so the frame still goes out and the agent answers.
   *
   * The notice is a `warning`, not the default severity: nothing failed. The
   * turn runs, on this model's own value for the setting, and the previous
   * rendering — the full-width red panel every daemon advisory wears — is what
   * got this reported as "a strange error … and then it carried on working".
   */
  private refuseUnofferedParameter(
    parameter: { id: string; value: string },
    sessionResult: unknown,
    events: AgentEvent[],
  ): boolean {
    const option = readAcpConfigOption(sessionResult, parameter.id);
    if (option === null) {
      // The model offers no such setting AT ALL, which for cursor is `effort` on
      // `auto-smart` and `composer-2.5` — the agent's own words for it are
      // `Unknown model config option: effort`.
      if (!this.sessionOffersConfigOptions(sessionResult)) {
        return false;
      }
      events.push({
        type: 'notice',
        severity: 'warning',
        message: `this model has no '${parameter.id}' setting — the turn runs without it`,
      });
      return true;
    }
    if (option.options.length === 0) {
      return false;
    }
    if (option.options.some(({ value }) => value === parameter.value)) {
      return false;
    }
    events.push({
      type: 'notice',
      severity: 'warning',
      message: `this model does not offer '${parameter.id}=${parameter.value}' — the turn runs at '${option.currentValue ?? 'its own value'}' (it offers ${option.options.map(({ value }) => value).join(', ')})`,
    });
    return true;
  }

  /**
   * Whether the reply enumerated a config-option list at all.
   *
   * The guard on the "no such setting" arm above: an agent that sent no
   * `configOptions` (the pre-1.0 shape, or one that simply says nothing) has
   * not declared the absence of anything, and reading its silence as a refusal
   * would drop every parameter on that transport.
   */
  private sessionOffersConfigOptions(sessionResult: unknown): boolean {
    return asArray(asRecord(sessionResult)?.configOptions).length > 0;
  }

  /**
   * The turn's `session/prompt` blocks: its attachments first, then its text —
   * the order the claude path sends, and the one that reads as "here is the
   * picture, here is what I'm asking about it".
   *
   * The images go ONLY to an agent that advertised `promptCapabilities.image`.
   * One that did not gets the text alone plus a `notice`, because the two
   * silent alternatives are both worse: sending anyway earns an error reply
   * that fails the whole turn over an attachment, and dropping them quietly
   * leaves the user watching the agent answer about a screenshot it never
   * received. This is the same class of gap as an unavailable session mode,
   * and it is reported the same way.
   */
  private composePromptBlocks(events: AgentEvent[]): AcpContentBlock[] {
    const text: AcpContentBlock = { type: 'text', text: this.composePrompt() };
    if (this.imageBlocks.length === 0) {
      return [text];
    }
    if (!this.session.capabilities.promptImage) {
      const count = this.imageBlocks.length;
      events.push({
        type: 'notice',
        message: `agent does not accept image prompts — ${count} attached image${count === 1 ? ' was' : 's were'} not sent with this turn`,
      });
      return [text];
    }
    return [...this.imageBlocks, text];
  }

  /**
   * Log what this turn's `session/load` replay actually cost. The prompt is
   * structurally blocked behind it, so this is per-turn latency that grows
   * with thread length — and the volume depends on the agent's own
   * implementation, which is why it is measured rather than extrapolated.
   */
  private reportReplayCost(): void {
    if (this.replayStartedAt === null) {
      return;
    }
    const elapsedMs = Date.now() - this.replayStartedAt;
    this.replayStartedAt = null;
    this.session.options.logger?.debug?.(
      `acp session/load replayed ${this.replayedUpdates} update(s) in ${elapsedMs}ms before this turn's prompt could be sent`,
    );
  }

  /**
   * ACP carries no system-prompt parameter, so the turn's instructions ride the
   * prompt text. WHICH instructions is the base adapter's rule, not this
   * driver's — see `AgentAdapter.composeSystemPrompt`; this only supplies the
   * two facts the protocol knows: whether the call tools ended up registered,
   * and whether the conversation already holds the block.
   *
   * **The user's own words come FIRST, and the instructions follow inside a
   * named block — both halves are fixes, and neither works alone.** See
   * {@link HOST_CONTEXT_TAG} for what the block is for. The ORDER is about the
   * name: a CLI names the conversation from its first prompt, and this text is
   * that prompt, so with the instructions leading cursor-agent named every
   * geniro chat after geniro's own preamble. Measured on 2026-08-25 against
   * "Explain in three sentences how a bloom filter works" — instructions first
   * gave `Markdown Not Terminal`, the user's sentence first gave `Bloom Filter
   * Explained` — with `Markdown Renderer Instructions` and `Markdown Display
   * Info` across the rest of the sidebar, and nothing on screen to suggest a
   * name the user never wrote came from a block they cannot see. Order alone
   * was not enough: a SHORT opening is still swamped, and `Hello!` came back
   * `Geniro Markdown Display`. Neither costs the instructions anything —
   * probed on the same build, an agent asked where its replies are displayed
   * still answered from the preamble ("Geniro's rich GFM chat transcript, and
   * no, remote HTTPS images cannot render"), which is the claim the preamble
   * exists to make.
   *
   * **The block is sent when the conversation does not already hold it — in
   * practice once per SESSION, never once per turn.** Prompt text is part of
   * the conversation here, not out-of-band like claude's
   * `--append-system-prompt`, so every block a turn carries stays in the window
   * for every turn after it. Re-sending it each turn put a full copy of the
   * user's instructions, the member's instruction blocks and its instructions
   * into every message: a team member with ~20KB of instructions and blocks had ~5k tokens
   * of duplicate instructions added to its window per turn, on top of the ~1.1KB
   * preamble that alone had put ~40 copies (~11k tokens) into a 40-message
   * thread.
   *
   * "Holds it" is compared as TEXT against {@link AcpSession.deliveredInstructions},
   * which both ways a session can already carry a block keep current: a turn
   * on a KEPT process records what its prompt delivered, and a `session/load`
   * reads the newest block back out of the replayed history
   * ({@link readHostContext}). So a change is still delivered — a call surface
   * this process was not granted, the user's instructions forgotten, a task's
   * label instructions re-resolved — because the text no longer matches, and
   * the newer block then supersedes the one the conversation already holds. A
   * replay the reader cannot parse re-sends, which is the safe direction.
   *
   * A compaction needs nothing here: this CLI's `/compact` replaces the
   * session, and a fresh session holds nothing, so its first turn carries the
   * block again.
   */
  private composePrompt(): string {
    const instructions = this.options.composeSystemPrompt(
      this.session.grantedMcpServers.length > 0,
    );
    if (
      instructions.length === 0 ||
      instructions === this.session.deliveredInstructions
    ) {
      this.promptInstructions = null;
      return this.options.input.prompt;
    }
    this.promptInstructions = instructions;
    return wrapHostContext(this.options.input.prompt, instructions);
  }

  /**
   * The preferred mode, but only when the agent actually offers it and is not
   * already in it. Asking for a mode that isn't in `availableModes` earns an
   * error reply, so check first rather than spend a round-trip to be refused.
   */
  private pickMode(
    sessionResult: Record<string, unknown> | null,
  ): string | null {
    // A turn that wants no particular mode wants the agent's OWN default, and
    // on a kept process that is something it has to ASK for. The mode is
    // session state the client sets and nothing resets, so `plan` set by turn 1
    // is still in force on turn 2 — which sent nothing at all here, there being
    // no mode to request, and left a chat the user had switched back to `auto`
    // running read-only under a composer chip and a run row that both said
    // `auto`. Unreachable while each turn was a fresh `session/new`.
    const wanted = this.options.preferredModeId ?? this.session.defaultModeId;
    if (!wanted) {
      return null;
    }
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return null;
    }
    // Against what the session is in NOW, not against the reply — the reply is
    // the one the session OPENED with, so on turn 2 it describes a mode a
    // previous turn may have moved away from.
    if (this.session.currentModeId === wanted) {
      return null;
    }
    return this.offersMode(sessionResult, wanted) ? wanted : null;
  }

  /** Whether the session reply lists `modeId` among its available modes. */
  private offersMode(
    sessionResult: Record<string, unknown> | null,
    modeId: string,
  ): boolean {
    const modes = sessionResult ? asRecord(sessionResult.modes) : null;
    if (!modes) {
      return false;
    }
    if (asString(modes.currentModeId) === modeId) {
      return true;
    }
    return asArray(modes.availableModes).some((entry) => {
      const record = asRecord(entry);
      return record !== null && asString(record.id) === modeId;
    });
  }

  private onPromptComplete(result: unknown, id: JsonRpcId): AgentEvent[] {
    if (id === this.interruptedPromptId && !this.stopRequested) {
      // The agent confirming it stopped for a mid-turn message — whatever the
      // stop reason says, since a prompt that happened to finish as the cancel
      // went out is superseded all the same. Not the turn's end: the message
      // goes out now.
      return this.onInterruptConfirmed(id);
    }
    if (id !== this.latestPromptId) {
      // This reply answers a prompt we superseded ourselves, which only
      // happens once the wait for its confirmation gave up and the message went
      // out beside it (`armInterruptDeadline`). The turn is not over: emitting
      // the terminal here would settle the run while the message the user just
      // pushed through is being answered, and `stopReason: "cancelled"` would
      // badge it as a Stop nobody pressed. What the agent wrote in between is
      // still closed as a row.
      this.dropSupersededFailure(id);
      return this.flushPending();
    }
    // The turn's own last prompt has answered. A mid-turn message still
    // waiting here was overtaken by a Stop, which ends the turn it was for —
    // reported, since its row already reads as sent.
    this.promptOutstanding = false;
    this.clearInterrupt();
    const dropped = this.dropped(this.queuedFollowUps.splice(0));
    const root = asRecord(result);
    const rawStopReason = root ? asString(root.stopReason) : null;
    const stopReason = (ACP_STOP_REASONS as readonly string[]).includes(
      rawStopReason ?? '',
    )
      ? (rawStopReason as AcpStopReason)
      : null;

    if (stopReason === 'cancelled') {
      // A cancelled turn is not a completion — it must not record usage or a
      // final answer a caller would then consume. What the user
      // ALREADY SAW is a different question: the open block is still written,
      // so cancelling does not erase the words that reached the screen.
      return [...this.flushPending(), ...dropped, { type: 'turn_cancelled' }];
    }

    if (this.agentFailure !== null) {
      // The CLI told us the turn FAILED and then told us it ended normally.
      // The first statement is the true one, so the turn settles on an `error`
      // INSTEAD of a `turn_complete` — not as well as, or the run would settle
      // twice and the second reading would put the success badge back.
      //
      // What the agent said BEFORE it died is still flushed: the failure came
      // at the end of real work, and a transcript that dropped it would hide
      // the part the user can act on. What is dropped is the failure's own
      // usage and `finalText` — a turn that produced no answer has none, and
      // publishing a `finalText` here would hand a caller the
      // transport error as this member's output.
      const message = this.agentFailure;
      this.agentFailure = null;
      const events: AgentEvent[] = [...this.flushPending(), ...dropped];
      // Whatever the request left open, the agent will never close — whether
      // the turn is resumed or ends here.
      const stillRunning = this.settleCutOffToolCalls(events);
      if (this.resumeAfterTransientFailure(message, events, stillRunning)) {
        return events;
      }
      return [...events, { type: 'error', message }];
    }
    const promptUsage = root ? asRecord(root.usage) : null;
    if (promptUsage) {
      this.usage.inputTokens = asNumber(promptUsage.inputTokens);
      this.usage.outputTokens = asNumber(promptUsage.outputTokens);
    }
    // The prompt is over, so the last block has no more chunks coming — this
    // is the ONLY close for a reply that ended without a tool call after it.
    const events: AgentEvent[] = [...this.flushPending(), ...dropped];
    if (this.holdForDelegates(rawStopReason, events)) {
      return events;
    }
    events.push(...this.completionEvents(rawStopReason));
    return events;
  }

  /**
   * The events that END the turn: the last context reading, the closes of the
   * delegates nothing can watch, then `turn_complete`.
   */
  private completionEvents(stopReason: string | null): AgentEvent[] {
    const events: AgentEvent[] = [];
    // AHEAD of `turn_complete`, which is what settles the run: the live plane a
    // context reading rides is cleared on settle, so one emitted after it would
    // be published into a state the client has already been told to drop.
    this.emitContextReading(events);
    // Ahead of it for the same reason: a delegate nothing can watch is closed
    // with the turn that launched it, and a close after the settle would put
    // the run back to work in the client's eyes.
    events.push(...this.session.onTurnCompleted());
    // Endings the agent was never told about are not carried into a later
    // turn's wake: that turn did not wait for them, and reporting them there
    // would hand the agent news about work it has moved on from.
    this.session.takeEndedDelegates(this.launchedHere);
    const text = this.textChunks.slice(this.finalTextFrom).join('');
    events.push({
      type: 'turn_complete',
      usage: this.buildUsage(),
      stopReason,
      finalText: text.length > 0 ? text : null,
    });
    return events;
  }

  /**
   * HOLD the turn when its prompt has ended with background delegates still out
   * that can be seen to end — true when held, and the turn is then not over.
   * See {@link AcpDelegateProtocol.wakePrompt} for why, and for which agents.
   *
   * Only delegates the session can WATCH hold it: one whose record cannot be
   * found would hold the turn for a report that never comes, so it is closed
   * with the turn as before.
   *
   * The agent is TOLD it can rely on this hold (`AdapterConfig.backgroundWork
   * .agentNote` of every adapter declaring a `wakePrompt`): a change to what
   * it holds for, or when it wakes, changes what that note may promise. Its
   * bounds ({@link DELEGATE_HOLD_IDLE_MS}, {@link MAX_DELEGATE_WAKES}) are
   * deliberately NOT in the note: they are safety valves the agent cannot act
   * on, and a stated wait limit is what agents turn into a polling rhythm.
   */
  private holdForDelegates(
    stopReason: string | null,
    events: AgentEvent[],
  ): boolean {
    if (
      this.session.options.delegate?.wakePrompt === undefined ||
      this.stopRequested ||
      this.options.input.internalProbe === true ||
      this.delegateWakes >= MAX_DELEGATE_WAKES
    ) {
      return false;
    }
    const out = this.session.watchedDelegatesOut(this.launchedHere);
    if (out === 0) {
      return false;
    }
    this.awaitingDelegates = true;
    this.heldStopReason = stopReason;
    events.push({
      type: 'notice',
      severity: 'info',
      message: `Waiting for ${out} background sub-agent${out === 1 ? '' : 's'} to finish — the agent is told when ${out === 1 ? 'it does' : 'they do'}, and this turn ends on its answer.`,
    });
    // The same fact spawn-cli announces for its own holds: the reply is over,
    // so the composer sends a message straight in, which ends this hold.
    events.push({ type: 'turn_held', open: out });
    this.session.awaitDelegates(() => this.onDelegatesEnded());
    this.armHoldTimer();
    return true;
  }

  /**
   * The session's watch closed one or more delegates. Once none THIS turn
   * launched is left, the agent is told — the wake prompt — and the turn
   * settles on that prompt's answer instead of the one it was holding.
   */
  private onDelegatesEnded(): void {
    if (
      !this.awaitingDelegates ||
      this.stopRequested ||
      !this.session.isCurrentTurn(this)
    ) {
      return;
    }
    // Something moved, so the idle bound starts over.
    this.armHoldTimer();
    const remaining = this.session.watchedDelegatesOut(this.launchedHere);
    if (remaining > 0) {
      // Still held, by fewer: re-announced so the badge counts down.
      this.session.emit({ type: 'turn_held', open: remaining });
      return;
    }
    this.endHold();
    const wake = this.session.options.delegate?.wakePrompt;
    const ended = this.session.takeEndedDelegates(this.launchedHere);
    const sent: AgentEvent[] = [];
    const answerFrom = this.textChunks.length;
    let events: AgentEvent[];
    if (wake !== undefined && this.sendWakePrompt(wake(ended), sent)) {
      this.delegateWakes += 1;
      this.finalTextFrom = answerFrom;
      events = sent;
    } else {
      // The wake could not go out — the turn still has the answer it held, and
      // the failed send's own error is dropped: emitted beside that answer it
      // would settle the turn twice, once as a failure.
      this.session.options.logger?.warn(
        'acp: could not send the wake prompt — settling the held turn on the answer it had',
      );
      events = this.completionEvents(this.heldStopReason);
    }
    for (const event of events) {
      this.session.emit(event);
    }
  }

  /** Send the wake prompt on this session, answering whether it went out. */
  private sendWakePrompt(text: string, events: AgentEvent[]): boolean {
    const sessionId = this.session.sessionId;
    if (sessionId === null) {
      return false;
    }
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      { sessionId, prompt: [{ type: 'text', text }] },
      'prompt',
      events,
    );
    if (id === null) {
      return false;
    }
    this.latestPromptId = id;
    this.promptOutstanding = true;
    return true;
  }

  /**
   * (Re)start the idle bound on a hold — see {@link DELEGATE_HOLD_IDLE_MS}.
   * Past it the turn settles on the answer it was holding; the delegates still
   * out stay watched, and their closes land after the turn.
   */
  private armHoldTimer(): void {
    if (this.holdTimer !== null) {
      this.holdTimer.clear();
    }
    this.holdTimer = awakeTimeout(() => {
      this.holdTimer = null;
      if (
        !this.awaitingDelegates ||
        !this.session.isCurrentTurn(this) ||
        !this.session.processAlive()
      ) {
        return;
      }
      const out = this.session.watchedDelegatesOut(this.launchedHere);
      this.endHold();
      this.session.options.logger?.warn(
        `acp: settling a turn held for ${out} background sub-agent(s) — none ended for ${Math.round(DELEGATE_HOLD_IDLE_MS / 60_000)} minutes`,
      );
      const events: AgentEvent[] = [
        {
          type: 'notice',
          severity: 'warning',
          message: `Stopped waiting for ${out} background sub-agent${out === 1 ? '' : 's'} — none finished for ${Math.round(DELEGATE_HOLD_IDLE_MS / 60_000)} minutes. This turn ends on the answer it had; ${out === 1 ? 'it is' : 'they are'} still shown as running until ${out === 1 ? 'it ends' : 'they end'}.`,
        },
        ...this.completionEvents(this.heldStopReason),
      ];
      for (const event of events) {
        this.session.emit(event);
      }
    }, DELEGATE_HOLD_IDLE_MS);
  }

  /** Leave the hold — the delegates ended, or a Stop or a message ended it. */
  private endHold(): void {
    this.awaitingDelegates = false;
    this.session.emit({ type: 'turn_held', open: 0 });
    if (this.holdTimer !== null) {
      this.holdTimer.clear();
      this.holdTimer = null;
    }
    this.session.stopAwaitingDelegates();
  }

  /**
   * Forget a failure the agent reported for a prompt this turn has since
   * SUPERSEDED — called as that prompt's own reply lands.
   *
   * A failure arrives as a message chunk with no prompt id on it, so which
   * prompt it belongs to is decided by WHEN: one reported before the
   * superseded prompt's reply is that prompt's (the CLI writes the sentence and
   * only then answers the request it failed). Kept, it outlived its own prompt
   * and turned the follow-up's clean `end_turn` into an `error` — failing the
   * very message the user pushed through to replace it. It goes to the log,
   * where it is still a diagnosis.
   */
  private dropSupersededFailure(id: JsonRpcId): void {
    if (this.agentFailure === null) {
      return;
    }
    this.session.options.logger?.warn(
      `acp: the superseded prompt ${String(id)} reported a failure; the prompt that replaced it goes on: ${this.agentFailure}`,
    );
    this.agentFailure = null;
  }

  /**
   * Forget a reported failure the agent has since talked past. cursor-agent
   * drains background-task completions after reporting one, and that drain
   * carries the conversation on (measured on 2026.10.19-6bbf2c4: a
   * `userMessageAction` died on `[unknown] Premature close` and the agent went
   * on to launch nine reviewers in the same prompt).
   */
  private forgetOutlivedFailure(): void {
    if (this.agentFailure === null) {
      return;
    }
    this.session.options.logger?.warn(
      `acp: the agent carried on after reporting a failure: ${this.agentFailure}`,
    );
    this.agentFailure = null;
  }

  /**
   * Carry the turn on after the agent reported only a DROPPED CONNECTION — true
   * when a continuation went out, or is scheduled, and the turn is therefore
   * not over.
   *
   * Each attempt waits its own pause (`resume.delaysMs`) first. A run of failures
   * with no progress between them spends that budget; progress starts a new run,
   * and the turn's `resume.maxPerTurn` caps the total. Sent back to
   * back, every attempt that meets the same outage dies on the CLI's own 30s
   * stall threshold, so three attempts spanned 90 seconds and were all spent
   * inside one two-minute Cursor outage (run `f1fa241c`, measured from the
   * daemon log: attempts at 13:12:30, 13:13:00 and 13:13:30, none answered by a
   * single byte, and a caller's retry at 13:14:19 went through). During a pause
   * the turn has no prompt out, so Stop ends it through
   * {@link withdrawHeldPrompt} rather than through `session/cancel`.
   *
   * The prompt is told what the failure did to the request's delegates
   * ({@link AcpResumeContext}): the ones `stillRunning` were adopted as
   * background delegates by {@link settleCutOffToolCalls}, so the turn HOLDS for
   * them once the resumed prompt ends and wakes the agent with their reports;
   * the finished ones' reports are read off their records first, which is the
   * only wait a delay of zero can still incur.
   */
  private resumeAfterTransientFailure(
    message: string,
    events: AgentEvent[],
    stillRunning: readonly string[],
  ): boolean {
    const resume = this.session.options.agentFailure?.resume;
    if (
      resume === undefined ||
      // Stop outranks a resume: the failure may be the cancel itself, and
      // either way the user has asked for this turn to end.
      this.stopRequested ||
      this.session.sessionId === null ||
      !resume.isTransient(message)
    ) {
      return false;
    }
    if (this.progressedSinceResume) {
      this.transientResumes = 0;
    }
    if (
      this.transientResumes >= resume.delaysMs.length ||
      this.transientResumesThisTurn >= resume.maxPerTurn
    ) {
      return false;
    }
    const attempts = resume.delaysMs.length;
    const ceiling = resume.maxPerTurn;
    const delayMs = resume.delaysMs[this.transientResumes] ?? 0;
    const running = stillRunning.map((id) => ({
      label: this.session.delegateLabel(id),
    }));
    const finishedIds = [...this.unconsumedDelegates];
    // Handed over by THIS resume; a later failure's resume owes only what
    // finished after it.
    this.unconsumedDelegates.clear();
    const compose = (finished: readonly AcpEndedDelegate[]): string =>
      resume.prompt({ stillRunning: running, finished });
    if (delayMs <= 0 && finishedIds.length === 0) {
      if (!this.sendResume(compose([]), events)) {
        return false;
      }
      this.announceResume(message, attempts, ceiling, 0, events);
      return true;
    }
    this.announceResume(message, attempts, ceiling, delayMs, events);
    this.scheduleResume(compose, finishedIds, delayMs);
    return true;
  }

  /**
   * Send the resume once BOTH its pause has run and the finished delegates'
   * reports are read — in parallel, so the reading costs nothing a pause was
   * going to cost anyway.
   */
  private scheduleResume(
    compose: (finished: readonly AcpEndedDelegate[]) => string,
    finishedIds: readonly string[],
    delayMs: number,
  ): void {
    this.cancelScheduledResume();
    const token = {};
    this.scheduledResume = token;
    let reports: readonly AcpEndedDelegate[] | null =
      finishedIds.length === 0 ? [] : null;
    let paused = true;
    const fire = (): void => {
      if (this.scheduledResume !== token || paused || reports === null) {
        return;
      }
      this.scheduledResume = null;
      // A turn that ended meanwhile — its process gone, or replaced — owns
      // nothing a prompt could be sent on.
      if (this.stopRequested || !this.session.isCurrentTurn(this)) {
        return;
      }
      const later: AgentEvent[] = [];
      this.sendResume(compose(reports), later);
      for (const event of later) {
        this.session.emit(event);
      }
    };
    if (reports === null) {
      void this.session.readFinishedDelegates(finishedIds).then((read) => {
        reports = read;
        fire();
      });
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      paused = false;
      fire();
    }, delayMs);
    this.resumeTimer.unref?.();
  }

  /**
   * Call off a resume that has not gone out yet — answering whether there was
   * one. A Stop, and a message the user pushed through, each carry the turn
   * somewhere else.
   */
  private cancelScheduledResume(): boolean {
    const had = this.scheduledResume !== null;
    this.scheduledResume = null;
    if (this.resumeTimer !== null) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
    return had;
  }

  /**
   * Close every tool call the failed request left open — the agent will never
   * say another word about them — and answer with the delegates among them that
   * are still running and are now watched instead.
   *
   * A delegate is not a step that stopped. Its context is not tied to the
   * request (see `AcpSession.adoptCutOffDelegate`), so closing its block as
   * cut off would draw a verifier that went on to finish as one that did not;
   * it is closed the way a background launch closes — its call answered, its
   * block left open — and its own record says when it is over. One that cannot
   * be watched (no brief, no reader) is marked untracked.
   */
  private settleCutOffToolCalls(events: AgentEvent[]): string[] {
    const stillRunning: string[] = [];
    const delegate = this.session.options.delegate;
    for (const id of [...this.openToolCalls]) {
      this.openToolCalls.delete(id);
      if (
        this.session.delegateToolCalls.has(id) &&
        this.session.wireEndings.has(id)
      ) {
        // The agent already said this delegate ENDED — it holds a failed
        // prompt open until its sub-agents end (cursor-agent 2026.10.01,
        // `processPrompt`'s drain) — so it is closed the way it ended, and
        // its result, which the failed request never delivered, is handed to
        // the resume like any other finished delegate's.
        this.unconsumedDelegates.add(id);
        events.push(
          {
            type: 'tool_result',
            id,
            name: this.session.toolNames.get(id) ?? null,
            result: null,
            isError: false,
          },
          this.session.closeCutOffDelegate(id),
        );
        continue;
      }
      if (
        this.session.delegateToolCalls.has(id) &&
        this.session.adoptCutOffDelegate(
          id,
          delegate?.readLaunchInput?.(this.session.toolInputs.get(id)) ?? null,
        )
      ) {
        stillRunning.push(id);
        this.launchedHere.add(id);
        events.push(
          {
            type: 'tool_result',
            id,
            name: this.session.toolNames.get(id) ?? null,
            // The launching call's return is bookkeeping on this transport,
            // and here there is not even that — so no body, only the close.
            result: null,
            isError: false,
          },
          this.delegateEvent({
            id,
            label: this.session.delegateLabel(id),
            kind: null,
            prompt: null,
            model: null,
            durationMs: null,
          }),
        );
        continue;
      }
      events.push(...this.cutOffToolCall(id, CUT_OFF_TOOL_RESULT));
    }
    return stillRunning;
  }

  /**
   * Send the continuation prompt, answering whether it went out.
   *
   * A turn that has produced nothing of the agent's own is sent its PROMPT
   * again instead ({@link requestProgressed}): the continuation assumes the
   * conversation holds the request it continues, and a request that died
   * before its first step may never have been saved — nor the instructions it
   * carried, which {@link AcpSession.deliveredInstructions} records on the
   * write. A brief the conversation did keep arrives twice, which costs a
   * repeat; a continuation of nothing sent the agent looking for work in other
   * conversations.
   */
  private sendResume(prompt: string, events: AgentEvent[]): boolean {
    if (this.session.sessionId === null) {
      return false;
    }
    const resendBrief = !this.requestProgressed;
    if (
      resendBrief &&
      this.session.deliveredInstructions === this.promptInstructions
    ) {
      this.session.deliveredInstructions = null;
    }
    const id = this.session.sendRequest(
      ACP_AGENT_METHODS.sessionPrompt,
      {
        sessionId: this.session.sessionId,
        prompt: resendBrief
          ? this.composePromptBlocks(events)
          : [{ type: 'text', text: prompt }],
      },
      'prompt',
      events,
    );
    if (id === null) {
      return false;
    }
    if (resendBrief && this.promptInstructions !== null) {
      this.session.deliveredInstructions = this.promptInstructions;
    }
    this.latestPromptId = id;
    this.promptOutstanding = true;
    return true;
  }

  /** Count the attempt, log the raw sentence, and tell the transcript. */
  private announceResume(
    message: string,
    attempts: number,
    ceiling: number,
    delayMs: number,
    events: AgentEvent[],
  ): void {
    this.transientResumes += 1;
    this.transientResumesThisTurn += 1;
    this.progressedSinceResume = false;
    // The raw sentence goes to the log, where it is a diagnosis; the transcript
    // gets one quiet line, since the turn carries on and nothing needs the user.
    this.session.options.logger?.warn(
      `acp: resuming after a transient failure in ${delayMs}ms (attempt ${this.transientResumes}/${attempts}, ${this.transientResumesThisTurn} of ${ceiling} this turn): ${message}`,
    );
    events.push({
      type: 'notice',
      severity: 'info',
      // The CAUSE is deliberately unnamed: what `isTransient` accepts is the
      // adapter's business and spans more than dropped connections, so a
      // sentence naming one would be false for the rest — and this row is the
      // user's only account of why their turn paused.
      message:
        delayMs <= 0
          ? `The agent's service interrupted this turn — asked it to continue (attempt ${this.transientResumes} of ${attempts}).`
          : `The agent's service interrupted this turn — trying again in ${formatPause(delayMs)} (attempt ${this.transientResumes} of ${attempts}).`,
    });
  }

  /**
   * Take one off-protocol context reading, when this agent has a source for
   * one, and put it on the turn's event stream.
   *
   * Total by construction — a source that throws, has nothing yet, or cannot
   * name a used figure is simply no reading. This is a meter, and no meter is
   * worth failing a turn over.
   *
   * `everyMs` is what separates the turn's two BOUNDARY readings from the ones
   * taken WHILE it runs. A boundary reading passes 0 and is unconditional; a
   * mid-turn one names the interval below which the source is not re-read and
   * an unmoved figure is not re-published. See {@link CONTEXT_REREAD_MS}.
   */
  private emitContextReading(events: AgentEvent[], everyMs = 0): void {
    const read = this.session.options.readContext;
    if (read === undefined || this.session.sessionId === null) {
      return;
    }
    const now = Date.now();
    if (everyMs > 0 && now - this.lastContextReadAt < everyMs) {
      return;
    }
    this.lastContextReadAt = now;
    let reading: AcpContextReading | null;
    try {
      reading = read(this.session.sessionId);
    } catch (err) {
      this.session.options.logger?.warn(
        `acp context reading failed (the turn is unaffected): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (reading === null || reading.usedTokens === null) {
      return;
    }
    // The store is rewritten several times a turn and the figure does not move
    // with every rewrite, so a mid-turn reading equal to the one already on
    // screen is traffic rather than news — each one is a socket emission to
    // every client watching the run. The BOUNDARY readings are exempt: the one
    // before `turn_complete` is what the settle path is built around, and
    // suppressing it would make the durable half depend on whether the last
    // mid-turn read happened to catch the same number.
    if (everyMs > 0 && sameContextReading(this.contextReading, reading)) {
      return;
    }
    // Remembered before it is published, so the turn's own `turn_complete`
    // carries it too — see the field.
    this.contextReading = reading;
    events.push({
      type: 'context_progress',
      contextTokens: reading.usedTokens,
      contextWindowTokens: reading.windowTokens,
      contextModel: reading.model,
    });
  }

  /**
   * Close everything still open as durable events: the tool calls held for
   * their arguments, then the open text block. The two never both hold
   * something — a chunk releases the held calls before it opens a block — so
   * the order cannot reverse anything. Idempotent.
   */
  private flushPending(): AgentEvent[] {
    return [...this.releaseHeldToolCalls(), ...this.flushTextBlock()];
  }

  /**
   * Close the open text block as ONE durable event, or nothing when none is
   * open. Idempotent: a second call before the next chunk yields nothing.
   */
  private flushTextBlock(): AgentEvent[] {
    const block = this.pendingBlock;
    this.pendingBlock = null;
    if (!block) {
      return [];
    }
    const text = block.parts.join('');
    if (text.length === 0) {
      return [];
    }
    return [
      block.kind === 'text'
        ? { type: 'text', text }
        : { type: 'reasoning', text },
    ];
  }

  /**
   * Add a chunk to the open block, closing a block of the OTHER kind first —
   * an agent that thinks, answers, then thinks again produces three rows, not
   * one merged blob.
   */
  private appendPending(
    kind: 'text' | 'reasoning',
    text: string,
  ): AgentEvent[] {
    // A call still held for its arguments came BEFORE these words, so it is
    // written before the block they open.
    const released = this.releaseHeldToolCalls();
    const closed =
      this.pendingBlock !== null && this.pendingBlock.kind !== kind
        ? this.flushTextBlock()
        : [];
    if (this.pendingBlock === null) {
      this.pendingBlock = { kind, parts: [] };
    }
    this.pendingBlock.parts.push(text);
    return [...released, ...closed];
  }

  /**
   * The transcript row for one tool call, plus the delegate anchor when the
   * call is a delegation.
   */
  private toolCallEvents(toolCall: AcpToolCall): AgentEvent[] {
    this.openToolCalls.add(toolCall.toolCallId);
    return [
      {
        type: 'tool_call',
        id: toolCall.toolCallId,
        name: toolCall.name,
        input: toolCall.rawInput,
        // ACP classifies its own calls, so the transcript can say what the
        // agent DID without recognising this agent's tool names. Omitted
        // rather than defaulted when the agent sent none: `other` would
        // claim a classification nobody made.
        ...(toolCall.kind === null ? {} : { kind: toolCall.kind }),
        // Same spread-only-when-present rule as `kind` above, and it
        // carries a distinction rather than tidiness: the agent omits the
        // field when a call touches no files, so an empty array here would
        // put words in its mouth.
        ...(toolCall.locations === null
          ? {}
          : { locations: toolCall.locations }),
      },
      // A delegation announces itself twice: here, so the block opens while
      // the delegate is still working, and again with its brief when the
      // agent sends it. Emitted AFTER the tool call it anchors to, so a
      // consumer replaying in `seq` order has the row before the reference
      // to it.
      ...this.delegateLaunchEvents(toolCall),
    ];
  }

  /**
   * Fold what a `tool_call_update` says about a call into what is known of it.
   *
   * ACP lets an update carry a new `title` and `rawInput`, and cursor-agent
   * depends on it: an MCP call opens as `MCP: tool` with no arguments, because
   * the frame goes out while the model is still writing them, and the server
   * and tool name arrive afterwards in a status-less update (its
   * `refreshToolCall`, read out of 2026.09.10-fd3934a's `7214.index.js`). Only
   * the opening frame was ever read, so every MCP row in a cursor transcript
   * said `MCP: tool` over no input — REPORTED with a screenshot of four of
   * them.
   *
   * A call still held is updated in place and released later; one already
   * written keeps its row, and only the caches the result and a permission
   * card read are corrected. Returns nothing: an update draws no row.
   */
  private refineToolCall(update: AcpToolCall): AgentEvent[] {
    const id = update.toolCallId;
    if (id === '') {
      return [];
    }
    if (update.name !== '') {
      this.session.toolNames.set(id, update.name);
    }
    if (update.rawInput !== null) {
      this.session.toolInputs.set(id, update.rawInput);
    }
    const held = this.heldToolCalls.get(id);
    if (held !== undefined) {
      this.heldToolCalls.set(id, {
        ...held,
        name: update.name !== '' ? update.name : held.name,
        rawInput: update.rawInput ?? held.rawInput,
        kind: update.kind ?? held.kind,
        locations: update.locations ?? held.locations,
      });
    }
    return [];
  }

  /**
   * Write the held tool calls, oldest first — every one of them, or only as
   * far as `upTo` when one call has started and the ones after it may still be
   * receiving their arguments.
   */
  private releaseHeldToolCalls(upTo?: string): AgentEvent[] {
    if (upTo !== undefined && !this.heldToolCalls.has(upTo)) {
      return [];
    }
    const events: AgentEvent[] = [];
    for (const [id, toolCall] of this.heldToolCalls) {
      this.heldToolCalls.delete(id);
      events.push(...this.toolCallEvents(toolCall));
      if (id === upTo) {
        break;
      }
    }
    return events;
  }

  private buildUsage(): AgentUsage {
    const statedContext =
      this.usage.contextUsed ?? this.contextReading?.usedTokens ?? null;
    return {
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      // ACP has no prompt-cache accounting on the wire — `UsageUpdate` carries
      // occupancy and a price and nothing about caching — and no output
      // breakdown, so an agent's thinking is inside `outputTokens` with no way
      // to separate it. Null rather than 0: the reading does not exist.
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      // ACP reports context occupancy directly (`UsageUpdate.used`), so unlike
      // the claude adapter there are no cache counters to sum.
      //
      // Then the OFF-PROTOCOL reading, and only then the plain input count.
      // The order is by what each figure actually measures: `used` and the
      // reading are both the window's occupancy — one stated on the wire, one
      // read out of the CLI's own accounting — while `inputTokens` is the
      // prompt of a single request, which is a different quantity that merely
      // beats nothing. Putting the reading here is what keeps the ring drawn
      // between turns rather than only during one; see {@link contextReading}.
      contextTokens: statedContext ?? this.usage.inputTokens,
      // The plain input count is geniro's stand-in for an occupancy nobody
      // stated, so the meter says so.
      ...(statedContext === null && this.usage.inputTokens !== null
        ? { contextEstimated: true }
        : {}),
      // The denominator comes from the off-protocol reading because no shipped
      // ACP agent here has been observed SENDING a window, not because the
      // protocol has none: `usage_update` defines `size` as required beside
      // `used`, and the arm below reads `used` alone — this file's own spec
      // builds a frame carrying `size: 200_000` and pins it discarded. Absent a
      // reading, the consumer shows the count with no denominator rather than
      // this client claiming a window no agent stated.
      contextWindowTokens: this.contextReading?.windowTokens ?? null,
      // From the same reading as the window and never on its own: a model id
      // here is a label ON that denominator, so one without the other names
      // something no figure is being measured against.
      contextModel:
        this.contextReading?.windowTokens == null
          ? null
          : // The reading's own name when it carries one; otherwise the model
            // the AGENT said it was running as. cursor's session store records
            // a full breakdown and names no model at all, so without the
            // fallback every window this transport measures is unattributable —
            // and a figure nobody can file is a figure the next turn cannot
            // reuse. The `windowTokens == null` guard above is untouched: a
            // model id here is still a label ON a denominator, never a name
            // offered with nothing being measured.
            (this.contextReading.model ?? this.session.currentModelId),
      // The field is `costUsd`: report an amount only when the agent priced the
      // turn in USD, rather than silently relabelling another currency.
      costUsd:
        this.usage.costCurrency?.toUpperCase() === 'USD'
          ? this.usage.costAmount
          : null,
      // ACP has no turn-timing channel at all: `session/prompt` answers with a
      // stop reason, and `UsageUpdate` carries token occupancy and a price and
      // no clock. Deliberately NOT timed here from the driver's own turn
      // boundaries — that would be a wall clock wearing the CLI's name, and it
      // would count a stretch parked on `session/request_permission` as work
      // the agent did. The consumer measures the wall clock where this is null
      // and knows that is what it has.
      durationMs: null,
      apiMs: null,
      // Same reasoning as durationMs/apiMs above: ACP has no timing channel at
      // all, so these are unmeasured rather than a wall-clock guess wearing
      // the agent's name.
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    };
  }

  onAgentRequest(id: JsonRpcId, method: string, params: unknown): AgentEvent[] {
    // A request is the agent acting on what it announced — a permission card,
    // a question or a delegate names a call that must already be on screen.
    return [
      ...this.releaseHeldToolCalls(),
      ...this.handleAgentRequest(id, method, params),
    ];
  }

  private handleAgentRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): AgentEvent[] {
    if (method === ACP_CLIENT_METHODS.sessionRequestPermission) {
      return this.onPermissionRequest(id, params);
    }
    const question = this.session.options.question;
    if (question !== undefined && method === question.method) {
      // The agent is asking the USER something. Declining this one is not a
      // neutral refusal like the others below: an agent that has a fallback
      // takes it, and the fallback cannot carry a question — cursor's replays
      // each one as a bare permission request whose Approve silently means
      // "the first option" (measured; see CURSOR_ASK_QUESTION_METHOD). So the
      // cost of refusing is a fabricated answer, not a stall. Park it as a
      // card instead, where the user sees what they are choosing between.
      if (question.accepts(params)) {
        return this.onQuestionRequest(id, params, question);
      }
      // Params that do not read as a question fall through to the decline.
      // The shape is documented rather than probe-observed, and a card built
      // from a payload we could not parse is worse than the refusal.
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than shown as a question`,
      );
    }
    const delegate = this.session.options.delegate;
    if (delegate !== undefined && method === delegate.method) {
      const facts = delegate.read(params);
      if (facts !== null) {
        // ANSWERED, not declined. The agent discards the outcome either way, so
        // this changes nothing about the turn — what it changes is that the
        // delegate's brief, type, model and duration reach the transcript
        // instead of being refused and dropped.
        this.session.reply(id, {});
        this.session.noteDelegatePrompt(facts.id, facts.prompt, facts.label);
        return [this.delegateEvent(facts)];
      }
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a sub-agent`,
      );
    }
    const todos = this.session.options.todos;
    if (todos !== undefined && method === todos.method) {
      const update = todos.read(params);
      if (update !== null) {
        // ANSWERED. Like the delegate announcement, the agent discards the
        // outcome either way, so this changes nothing about the turn — what it
        // changes is that the task list reaches the transcript instead of being
        // refused and dropped, which is what the user could not see.
        this.session.reply(id, {});
        return [{ type: 'task_list', ...update }];
      }
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — declined rather than recorded as a task list`,
      );
    }
    const plan = todos?.plan;
    if (plan !== undefined && method === plan.method) {
      // READ, then declined like any other below — see `AcpTodoProtocol.plan`.
      return [
        ...this.onPlanRestated(method, plan.read(params)),
        ...this.decline(id, method),
      ];
    }
    return this.decline(id, method);
  }

  /**
   * The plan an agent restated with its own ids, drawn in place of the `plan`
   * update held for it — or that held update, when the restatement could not be
   * read or named no tasks (cursor's `plan` update then carries one stand-in
   * entry naming the plan, which is still worth a row).
   */
  private onPlanRestated(
    method: string,
    tasks: AgentTask[] | null,
  ): AgentEvent[] {
    if (tasks === null) {
      this.session.options.logger?.warn(
        `acp: ${method} arrived in an unrecognized shape — its plan is drawn from the plan update instead`,
      );
    }
    const drawn = tasks !== null && tasks.length > 0 ? tasks : this.heldPlan;
    this.heldPlan = null;
    return drawn === null ? [] : [this.planEvent(drawn)];
  }

  /**
   * A plan, announced as the agent's whole task list — ACP's own rule for the
   * `plan` update ("the client MUST replace the current plan completely"), and
   * true of a restatement for the same reason. No `toolCallId`: a list that
   * names one is drawn INSTEAD of that tool's row, and the row a plan rides on
   * (cursor's `Create Plan`) carries the plan's document, which the list does
   * not.
   */
  private planEvent(tasks: AgentTask[]): AgentEvent {
    return { type: 'task_list', mode: 'snapshot', tasks, toolCallId: null };
  }

  /**
   * Refuse a request this client does not take.
   *
   * It is a client capability we deliberately did not advertise (`fs/*`,
   * `terminal/*`) or a vendor extension we don't implement. A blocking request
   * MUST be answered or the agent parks forever, so refuse it in-protocol — and
   * say so once, since a refused extension can change what the agent is able
   * to do this turn.
   */
  private decline(id: JsonRpcId, method: string): AgentEvent[] {
    if (
      !this.session.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `${method} is not implemented by this client`,
        ),
      )
    ) {
      this.session.options.logger?.warn(
        `acp: dropped the error reply to ${method}${this.session.writeFailure()}`,
      );
    }
    if (this.session.options.declinedWithoutNotice?.includes(method) === true) {
      // A refusal its own agent absorbs. The notice above is a per-TURN
      // budget of one, so narrating a harmless refusal does not merely add
      // noise — it spends the slot, and a consequential refusal later in the
      // same turn then goes unmentioned. Measured: an ordinary planning turn
      // on cursor-agent 2026.08.04 sends `cursor/update_todos`, which would
      // have burnt it. Still recorded, on the debug channel.
      this.session.options.logger?.debug?.(
        `acp: declined ${method}; the agent handles that refusal itself`,
      );
      return [];
    }
    if (this.warnedUnsupportedRequest) {
      return [];
    }
    this.warnedUnsupportedRequest = true;
    return [
      {
        type: 'notice',
        message: `agent asked for '${method}', which this client does not implement; it was declined`,
      },
    ];
  }

  /**
   * Park a question and surface it as a card.
   *
   * `autoDecide` is deliberately NOT consulted, unlike the permission path
   * below: that hook resolves a PERMISSION posture (`auto` approves, plan
   * rejects), and a question has no safe machine answer — approving one on the
   * user's behalf invents an opinion they never gave. The same floor is
   * enforced again in `spawn-cli`, so neither layer relies on the other.
   */
  private onQuestionRequest(
    id: JsonRpcId,
    params: unknown,
    question: AcpQuestionProtocol,
  ): AgentEvent[] {
    const encodedId = encodeRequestId(id);
    this.session.parkedQuestions.set(encodedId, params);
    const questions = question.card(params);
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: question.toolName,
        input: params,
        requiresUserInteraction: true,
        ...(questions.length > 0 ? { questions } : {}),
      },
    ];
  }

  /**
   * The anchor row for a tool call that IS a delegation, or nothing.
   *
   * Reads the marker off the input the agent actually disclosed, so a call that
   * sent no arguments at all (`rawInput: {}`, normalized to null upstream —
   * routine on this transport) is simply not recognised as one, rather than
   * throwing on a property read.
   */
  private delegateLaunchEvents(toolCall: AcpToolCall): AgentEvent[] {
    const delegate = this.session.options.delegate;
    if (delegate === undefined) {
      return [];
    }
    const input = asRecord(toolCall.rawInput);
    if (
      input === null ||
      asString(input[delegate.launchMarker.key]) !== delegate.launchMarker.value
    ) {
      return [];
    }
    // Per-TURN state on the driver, never on the adapter: one adapter instance
    // serves N concurrent turns under team fan-out.
    this.session.delegateToolCalls.add(toolCall.toolCallId);
    this.session.noteDelegateLaunch(toolCall.toolCallId);
    return [
      this.delegateEvent({
        id: toolCall.toolCallId,
        // Every fact is still unknown: this CLI's launch frame carries only the
        // tool's own name, and its title at that moment is the placeholder
        // `Task: Subagent task`. Announcing the anchor alone is the point — the
        // block exists and says "working" until the brief arrives.
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
      }),
    ];
  }

  /** This tool call launched a delegate whose result is the CLI's own accounting. */
  private isBookkeepingResult(toolCallId: string): boolean {
    return (
      this.session.options.delegate?.resultIsBookkeeping === true &&
      this.session.delegateToolCalls.has(toolCallId)
    );
  }

  /**
   * The `subagent_info` saying this delegate is still out, when the launching
   * call's return said so — and nothing at all otherwise.
   *
   * Recording it is what makes {@link delegateEvent} drop the duration: the
   * announcement that follows carries the LAUNCH's milliseconds (198–408ms
   * across the ten delegates on the reported thread), and a block reading
   * `took 0s` states, about work that runs for minutes, a figure that measures
   * how long it took to ask for it.
   */
  private delegateBackgroundEvents(toolCall: AcpToolCall): AgentEvent[] {
    const reads = this.session.options.delegate?.readsBackgroundLaunch;
    if (
      reads === undefined ||
      !this.session.delegateToolCalls.has(toolCall.toolCallId)
    ) {
      return [];
    }
    if (reads(toolCall.rawOutput) !== true) {
      return [];
    }
    this.session.noteBackgroundDelegate(toolCall.toolCallId);
    this.launchedHere.add(toolCall.toolCallId);
    return [
      this.delegateEvent({
        id: toolCall.toolCallId,
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
      }),
    ];
  }

  /** One `subagent_info` row, with this protocol's steps reason stamped on. */
  private delegateEvent(facts: AcpDelegateFacts): AgentEvent {
    // A delegate the CLI said outlives its launching call: its announcement's
    // duration measured the LAUNCH, so it is dropped rather than published as
    // the delegate's own. Null cannot overwrite a figure under the merge rule,
    // so a later announcement carrying a real one still wins.
    const background = this.session.backgroundDelegates.has(facts.id);
    return {
      type: 'subagent_info',
      ...facts,
      ...(background ? { durationMs: null } : {}),
      // This protocol's delegate frame carries a duration and nothing else it
      // spent — measured on cursor's `cursor/task`, whose result is
      // `{durationMs, isBackground}` — so the figures are declared absent
      // rather than left off, which is what keeps the merge rule safe: a null
      // here cannot overwrite a value some other announcement gave.
      tokens: null,
      toolUses: null,
      // And with no tokens at all there is no breakdown to bill and nothing to
      // price. The cost derivation needs a per-kind split and a model name,
      // both of which this protocol withholds — so an ACP delegate reports its
      // duration and no money, which is what the reader should see.
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      // Declared absent for the same reason, and it is the honest answer: this
      // protocol's delegate frame says a delegate ran and how long for, never
      // how it ended. A guessed `completed` here would put a green check on a
      // delegate nobody reported the fate of.
      backgroundOutcome: null,
      // Withdrawn when the agent runs its sub-agents as SESSIONS: their steps
      // then arrive under their own session id and are drawn in this block,
      // so the sentence explaining an empty one would be false.
      stepsUnavailableReason: this.session.capabilities.subagentSessions
        ? null
        : (this.session.options.delegate?.stepsUnavailableReason ?? null),
      // Null unless the launching call's own return said the work outlives it,
      // which is the ONE thing this protocol reports about a delegate's
      // lifecycle. Null leaves the transcript's own reading (the launching call
      // returning) exactly as it was for every ACP agent; true withdraws it,
      // because a call that returned in 203ms did not wait for anything.
      //
      // It is never set FALSE here. False would mean "the CLI told us the work
      // is over", which this protocol has no frame for — nothing announces a
      // background delegate's ending on this wire, measured across 70s of
      // listening past the turn's own end.
      backgroundOpen: background ? true : null,
    };
  }

  private onPermissionRequest(id: JsonRpcId, params: unknown): AgentEvent[] {
    const root = asRecord(params);
    const toolCallRecord = root ? asRecord(root.toolCall) : null;
    // The permission request's own toolCall is a stub: it may omit the name and
    // the arguments the approval card shows. Both were announced on the
    // `tool_call` update for this id, so fall back to those rather than asking
    // the user about a call the card cannot describe.
    const toolCall = this.withCachedToolFacts(
      this.toolCallOf(toolCallRecord ?? {}),
    );
    const options = readPermissionOptions(root?.options);

    const decision = this.options.autoDecide(toolCall);
    if (decision !== null) {
      const optionId = selectPermissionOption(options, decision === 'allow');
      this.recordAnswer(
        toolCall.toolCallId,
        decision === 'allow' && optionId !== null,
      );
      this.session.reply(id, {
        outcome:
          optionId === null
            ? { outcome: 'cancelled' }
            : { outcome: 'selected', optionId },
      });
      return [];
    }

    const encodedId = encodeRequestId(id);
    this.session.parkedPermissions.set(encodedId, {
      options,
      toolCallId: toolCall.toolCallId,
    });
    const remembering = acpApprovalOptions(
      options,
      this.session.options.alwaysAnswerScope,
    );
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: toolCall.name,
        input: toolCall.rawInput,
        ...(remembering.length > 0 ? { options: remembering } : {}),
      },
    ];
  }

  /**
   * Restore the name and arguments cached from this id's `tool_call` update.
   *
   * The kind and `locations` are deliberately NOT among them. The only caller
   * is {@link onPermissionRequest}, and what it needs restored is what the
   * card shows — the name and the arguments. No approval policy reads a kind
   * or a location, so merging either would cache a value with no reader. The transcript row needs no merge either: the six
   * kinds that carry locations carry them on the OPENING frame, which is the
   * frame that becomes the row.
   */
  private withCachedToolFacts(toolCall: AcpToolCall): AcpToolCall {
    const id = toolCall.toolCallId;
    if (id === '') {
      return toolCall;
    }
    return {
      ...toolCall,
      name:
        toolCall.name === ''
          ? (this.session.toolNames.get(id) ?? '')
          : toolCall.name,
      rawInput: toolCall.rawInput ?? this.session.toolInputs.get(id) ?? null,
    };
  }

  /** One tool call as this client reads it, an MCP call under its `mcp__<server>__<tool>` name. */
  private toolCallOf(source: Record<string, unknown>): AcpToolCall {
    const call = readToolCall(source);
    const mcp = this.session.options.mcpToolCall?.(call) ?? null;
    return mcp === null
      ? call
      : {
          ...call,
          name: mcpToolName(mcp.server, mcp.tool),
          rawInput: disclosedInput(mcp.args),
        };
  }

  onNotification(method: string, params: unknown): AgentEvent[] {
    if (method !== ACP_CLIENT_METHODS.sessionUpdate) {
      // A vendor NOTIFICATION is fire-and-forget by definition — ignoring one
      // is a no-op, not a stall. Note that cursor's `cursor/*` extensions are
      // not these: every one observed on the wire carries a JSON-RPC `id` and
      // so arrives as a request (`onAgentRequest`), including the ones whose
      // outcome the agent then throws away.
      return [];
    }
    const root = asRecord(params);
    const update = root ? asRecord(root.update) : null;
    if (!update) {
      return [];
    }
    // An update under a SUB-AGENT's session id (see `acp-subagents.ts`) must
    // never be read as the parent's: its words would be glued into the
    // parent's answer and its tool calls drawn as the parent's own. A session
    // is a sub-agent's only once the agent ANNOUNCED it — the RFD requires the
    // announcement to precede any traffic bearing the child's id — so every
    // other id is read as the parent's, exactly as before sub-agent sessions
    // existed: this driver has never matched an update's session id, and an
    // agent that addresses its own session by another name keeps working.
    const updateSessionId = root ? asString(root.sessionId) : null;
    if (
      updateSessionId !== null &&
      (this.session.childSessions.has(updateSessionId) ||
        this.session.unplacedChildSessions.has(updateSessionId))
    ) {
      return this.onChildUpdate(
        updateSessionId,
        asString(update.sessionUpdate),
        update,
      );
    }
    const events = this.onSessionUpdate(asString(update.sessionUpdate), update);
    // The turn's THIRD reading moment, and the one a first turn depends on.
    // The other two are boundaries: the session reply, where a conversation
    // the agent has never held has written nothing to read, and the settle.
    // So a brand-new chat's ring stayed empty for the whole of its opening
    // turn and filled only as that turn ended — reported as a chat that "still
    // hadn't loaded any context, and loaded it only later". Measured on a
    // fresh cursor chat (2026-08-25): the store held a complete reading of
    // 47,221 of 272,000 at 18.2s and went on moving, while the turn ran for
    // considerably longer. Notifications are the carrier because a turn that
    // is working always has them and one that is not has nothing worth
    // re-reading for; during a `session/load` replay `sessionId` is not yet
    // set, so the reading cannot fire against the previous turn's figures.
    this.emitContextReading(events, CONTEXT_REREAD_MS);
    return events;
  }

  /**
   * A `subagent_spawned` or `subagent_state_update` — on the parent session,
   * or on a sub-agent's for one it launched in turn (the agent files a nested
   * child under its immediate parent).
   *
   * A spawn records which tool call the child belongs to, so its steps can be
   * drawn inside that delegate's block. An end closes whatever the child left
   * open and records how it ended — which, for a BACKGROUND delegate, is its
   * close row, the same one its transcript would eventually give it.
   */
  private onSubagentFrame(
    kind: string,
    update: Record<string, unknown>,
  ): AgentEvent[] {
    // A `session/load` replays every child the conversation ever had, spawned
    // and ended in one breath, under ids that are not live tool calls.
    if (this.replaying) {
      return [];
    }
    const readCall = this.session.options.delegate?.subagentToolCallId;
    if (kind === ACP_SUBAGENT_SPAWNED) {
      const spawn = readSubagentSpawn(update);
      const launch =
        spawn === null ? null : launchingCallOf(spawn.meta, readCall);
      if (spawn === null || launch === null) {
        // Nothing to draw its steps in, so they are DROPPED where they arrive
        // — remembered for that, since an id this client was never told about
        // is read as the parent's.
        if (spawn !== null) {
          this.session.unplacedChildSessions.add(spawn.childSessionId);
        }
        this.session.options.logger?.debug?.(
          'acp: a sub-agent session was announced with no launching tool call this client can read',
        );
        return [];
      }
      this.session.childSessions.set(spawn.childSessionId, launch);
      this.session.noteDelegateLaunch(launch);
      return [
        delegateDeclarationEvent(launch, {
          subagentSessionId: spawn.childSessionId,
        }),
      ];
    }
    const end = readSubagentEnd(update);
    if (end === null) {
      return [];
    }
    const launch =
      this.session.childSessions.get(end.childSessionId) ??
      launchingCallOf(end.meta, readCall);
    if (launch === null) {
      return [];
    }
    const outcome = subagentOutcome(end.state);
    const events: AgentEvent[] = [
      ...this.flushChild(end.childSessionId, launch),
      ...this.closeChildCalls(end.childSessionId, launch),
    ];
    const close = this.session.endDelegateOnWire(launch, outcome);
    if (close !== null) {
      // A BACKGROUND delegate ending is where the agent, holding its prompt
      // open for it, carries on by itself on its result — measured on
      // 2026.10.01-e373342, the parent's continuation streams inside the same
      // prompt. What it said before is closed as its own row here, or the two
      // would be one paragraph glued at the seam (`LAUNCHED-77No follow-up…`),
      // and the turn's answer keeps the break between them.
      events.unshift(...this.flushPending());
      if ((this.textChunks.at(-1) ?? '\n').endsWith('\n') === false) {
        this.textChunks.push('\n\n');
      }
      events.push(close);
    }
    return events;
  }

  /**
   * One `session/update` a SUB-AGENT sent under its own session id, drawn
   * inside its delegate's block: every event carries the launching call as its
   * `parentToolUseId`, which is how a delegate's rows are told from the
   * parent's everywhere downstream (the renderer's nesting, the tool counts,
   * the held-turn rules — the same field claude's delegates have always used).
   *
   * Only durable rows, no live deltas: the live plane is the parent's, and a
   * sub-agent streaming into it would put its words in the parent's working
   * row. Its own words are written block by block, as the parent's are.
   */
  private onChildUpdate(
    childSessionId: string,
    kind: string | null,
    update: Record<string, unknown>,
  ): AgentEvent[] {
    if (this.replaying) {
      return [];
    }
    if (kind === ACP_SUBAGENT_SPAWNED || kind === ACP_SUBAGENT_STATE_UPDATE) {
      return this.onSubagentFrame(kind, update);
    }
    const launch = this.session.childSessions.get(childSessionId);
    if (launch === undefined) {
      this.session.options.logger?.debug?.(
        `acp: dropped a '${String(kind)}' update for session ${childSessionId}, which this client was never told about`,
      );
      return [];
    }
    switch (kind) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const text = textOf(update.content);
        if (text === null) {
          return [];
        }
        return this.appendChild(
          childSessionId,
          launch,
          kind === 'agent_message_chunk' ? 'text' : 'reasoning',
          text,
        );
      }
      case 'tool_call': {
        const call = this.toolCallOf(update);
        this.session.toolNames.set(call.toolCallId, call.name);
        if (call.rawInput !== null) {
          this.session.toolInputs.set(call.toolCallId, call.rawInput);
        }
        const events = this.flushChild(childSessionId, launch);
        if (call.status === 'pending' && call.rawInput === null) {
          // Named and not yet described — the same hold the parent's calls
          // get (`heldToolCalls`), released when it starts, settles, or the
          // sub-agent moves on.
          this.session.childHeldCalls.set(call.toolCallId, {
            child: childSessionId,
            call,
          });
          return events;
        }
        return [
          ...events,
          ...this.childToolCallEvents(childSessionId, launch, call),
        ];
      }
      case 'tool_call_update': {
        const call = this.toolCallOf(update);
        this.refineToolCall(call);
        const held = this.session.childHeldCalls.get(call.toolCallId);
        if (held !== undefined) {
          this.session.childHeldCalls.set(call.toolCallId, {
            child: held.child,
            call: {
              ...held.call,
              name: call.name !== '' ? call.name : held.call.name,
              rawInput: call.rawInput ?? held.call.rawInput,
              kind: call.kind ?? held.call.kind,
              locations: call.locations ?? held.call.locations,
            },
          });
        }
        if (call.status === 'in_progress') {
          return this.releaseChildCalls(childSessionId, launch);
        }
        if (call.status !== 'completed' && call.status !== 'failed') {
          return [];
        }
        const events = this.flushChild(childSessionId, launch);
        const open = this.session.childOpenCalls.get(childSessionId);
        if (open === undefined || !open.has(call.toolCallId)) {
          // A settle for a call never written — or written and settled once
          // already. One result per call.
          return events;
        }
        open.delete(call.toolCallId);
        const diffs = readAcpDiffs(update.content);
        events.push({
          type: 'tool_result',
          id: call.toolCallId,
          name:
            this.session.toolNames.get(call.toolCallId) ??
            (call.name.length > 0 ? call.name : null),
          ...this.settledOutcome(
            call,
            this.isBookkeepingResult(call.toolCallId)
              ? null
              : (call.rawOutput ??
                  (diffs.length > 0 ? { diffs } : (update.content ?? null))),
          ),
          parentToolUseId: launch,
        });
        return events;
      }
      default:
        return [];
    }
  }

  /** A sub-agent's tool call as rows of its delegate's block. */
  private childToolCallEvents(
    childSessionId: string,
    launch: string,
    call: AcpToolCall,
  ): AgentEvent[] {
    let open = this.session.childOpenCalls.get(childSessionId);
    if (open === undefined) {
      open = new Set();
      this.session.childOpenCalls.set(childSessionId, open);
    }
    open.add(call.toolCallId);
    return [
      {
        type: 'tool_call',
        id: call.toolCallId,
        name: call.name,
        input: call.rawInput,
        ...(call.kind === null ? {} : { kind: call.kind }),
        ...(call.locations === null ? {} : { locations: call.locations }),
        parentToolUseId: launch,
      },
      // A sub-agent can delegate in turn; its delegation opens a block nested
      // inside this one.
      ...this.delegateLaunchEvents(call).map((event) => ({
        ...event,
        parentToolUseId: launch,
      })),
    ];
  }

  /** Write a sub-agent's held calls — the ones its next step proves are final. */
  private releaseChildCalls(
    childSessionId: string,
    launch: string,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const [id, held] of [...this.session.childHeldCalls]) {
      if (held.child !== childSessionId) {
        continue;
      }
      this.session.childHeldCalls.delete(id);
      events.push(
        ...this.childToolCallEvents(childSessionId, launch, held.call),
      );
    }
    return events;
  }

  /** Add to a sub-agent's open block, closing one of the other kind first. */
  private appendChild(
    childSessionId: string,
    launch: string,
    kind: 'text' | 'reasoning',
    text: string,
  ): AgentEvent[] {
    const events = this.releaseChildCalls(childSessionId, launch);
    const block = this.session.childBlocks.get(childSessionId);
    if (block !== undefined && block.kind !== kind) {
      events.push(...this.flushChild(childSessionId, launch));
    }
    const open = this.session.childBlocks.get(childSessionId) ?? {
      kind,
      parts: [],
    };
    open.parts.push(text);
    this.session.childBlocks.set(childSessionId, open);
    return events;
  }

  /**
   * Close a sub-agent's open block as ONE row — and remember it, when it is
   * what the sub-agent SAID, as its report so far: the last of these is what a
   * delegate hands back, so it is what a resume or a wake passes on.
   */
  private flushChild(childSessionId: string, launch: string): AgentEvent[] {
    const block = this.session.childBlocks.get(childSessionId);
    this.session.childBlocks.delete(childSessionId);
    const text = block?.parts.join('') ?? '';
    if (block === undefined || text.length === 0) {
      return [];
    }
    if (block.kind === 'text') {
      this.session.childReports.set(launch, text);
    }
    return [{ type: block.kind, text, parentToolUseId: launch }];
  }

  /**
   * Close everything an ENDED sub-agent left open: its held calls are written
   * first, so a step that never started still has a row to be closed on.
   */
  private closeChildCalls(
    childSessionId: string,
    launch: string,
  ): AgentEvent[] {
    const events = this.releaseChildCalls(childSessionId, launch);
    const open = this.session.childOpenCalls.get(childSessionId);
    this.session.childOpenCalls.delete(childSessionId);
    for (const id of open ?? []) {
      this.session.refusedToolCalls.delete(id);
      events.push({
        type: 'tool_result',
        id,
        name: this.session.toolNames.get(id) ?? null,
        result: SUBAGENT_ENDED_TOOL_RESULT,
        isError: true,
        parentToolUseId: launch,
      });
    }
    return events;
  }

  private onSessionUpdate(
    kind: string | null,
    update: Record<string, unknown>,
  ): AgentEvent[] {
    if (this.replaying) {
      this.replayedUpdates += 1;
    }
    switch (kind) {
      case 'agent_message_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        if (text === null) {
          return [];
        }
        // This CLI reporting its own failure, which it does as an ordinary
        // message — see {@link AcpAgentFailureProtocol}. Held rather than
        // emitted: the terminal is what says a turn failed, and it has not
        // arrived yet. Deliberately NOT pushed onto `textChunks` either, so it
        // cannot become the turn's `finalText` — a caller
        // consuming "the answer" must not be handed the transport error as one.
        const failure = this.session.options.agentFailure?.read(text) ?? null;
        if (failure !== null) {
          this.agentFailure = failure;
          return [];
        }
        this.forgetOutlivedFailure();
        this.textChunks.push(text);
        this.requestProgressed = true;
        this.progressedSinceResume = true;
        // A new step, generated from every result before it.
        this.unconsumedDelegates.clear();
        // The chunk streams as an EPHEMERAL delta; the row is written when the
        // block closes (see `pending`).
        return [
          ...this.appendPending('text', text),
          { type: 'text_delta', text },
        ];
      }
      case 'agent_thought_chunk': {
        if (this.replaying) {
          return [];
        }
        const text = textOf(update.content);
        if (text === null) {
          return [];
        }
        // The ephemeral twin is `reasoning_delta`, NOT `thinking_progress`:
        // that event carries a token COUNT, which is claude's answer to
        // redacted thinking and cannot express text. Without a live twin here
        // a thinking stretch emitted nothing at all — `appendPending` buffers
        // until the block closes — so the transcript sat on `Working…` for the
        // whole of it while chunks were arriving. Measured on a real turn:
        // thought chunks at 16.8–20.0s and again at 32.1–34.4s, none of it on
        // screen until the block closed.
        this.requestProgressed = true;
        this.progressedSinceResume = true;
        this.unconsumedDelegates.clear();
        return [
          ...this.appendPending('reasoning', text),
          { type: 'reasoning_delta', text },
        ];
      }
      case 'tool_call': {
        if (this.replaying) {
          return [];
        }
        this.requestProgressed = true;
        this.progressedSinceResume = true;
        const toolCall = this.toolCallOf(update);
        this.session.toolNames.set(toolCall.toolCallId, toolCall.name);
        if (toolCall.rawInput !== null) {
          this.session.toolInputs.set(toolCall.toolCallId, toolCall.rawInput);
        }
        // A tool call is a transcript row, so whatever text preceded it is a
        // finished block — closing it here is what keeps the interleaving
        // (say something → call a tool → say something) intact. The TEXT block
        // only: a call held before this one is still waiting for its own
        // arguments, and a sibling arriving says nothing about them.
        const closed = this.flushTextBlock();
        if (toolCall.status === 'pending' && toolCall.rawInput === null) {
          // Named and not yet described — see `heldToolCalls`.
          this.heldToolCalls.set(toolCall.toolCallId, toolCall);
          return closed;
        }
        return [...closed, ...this.toolCallEvents(toolCall)];
      }
      case 'tool_call_update': {
        if (this.replaying) {
          return [];
        }
        const toolCall = this.toolCallOf(update);
        // What an update adds to a call it already announced: its real name and
        // its arguments. Recorded for EVERY status, so a result and a permission
        // card name the call by what it turned out to be.
        const refined = this.refineToolCall(toolCall);
        if (toolCall.status === 'in_progress') {
          // The agent has started running it, so its arguments are final.
          return this.releaseHeldToolCalls(toolCall.toolCallId);
        }
        // Only a settled tool call closes the pair; `pending` updates are
        // progress the transcript does not model.
        if (toolCall.status !== 'completed' && toolCall.status !== 'failed') {
          return refined;
        }
        // A diff is the one thing an agent may report INSTEAD of arguments, so
        // it is normalized here rather than passed through as the raw ACP block
        // array: `{diffs}` is the shape the transcript renders as a diff, and it
        // carries the path an undisclosed edit is otherwise missing.
        const diffs = readAcpDiffs(update.content);
        this.openToolCalls.delete(toolCall.toolCallId);
        const background = this.delegateBackgroundEvents(toolCall);
        if (
          this.session.delegateToolCalls.has(toolCall.toolCallId) &&
          !this.session.backgroundDelegates.has(toolCall.toolCallId)
        ) {
          // A delegate the agent waited on has answered, and the agent has not
          // yet produced anything from that answer — see `unconsumedDelegates`.
          this.unconsumedDelegates.add(toolCall.toolCallId);
        }
        return [
          ...this.releaseHeldToolCalls(toolCall.toolCallId),
          ...this.flushTextBlock(),
          {
            type: 'tool_result',
            id: toolCall.toolCallId,
            name:
              this.session.toolNames.get(toolCall.toolCallId) ??
              (toolCall.name.length > 0 ? toolCall.name : null),
            ...this.settledOutcome(
              toolCall,
              this.isBookkeepingResult(toolCall.toolCallId)
                ? // The pair still CLOSES — the block reads `completed` off
                  // the result's existence — it just carries no body to frame
                  // as the delegate's report.
                  null
                : (toolCall.rawOutput ??
                    (diffs.length > 0 ? { diffs } : (update.content ?? null))),
            ),
          },
          // …and, when this call launched a delegate that OUTLIVES it, the row
          // that says so. It rides the settled launching call because that is
          // the only frame carrying the flag, and it is emitted here rather
          // than folded into the announcement below because the announcement is
          // fire-and-forget on the agent's side — a delegate whose `cursor/task`
          // never arrived would otherwise be recorded as finished.
          ...background,
        ];
      }
      case ACP_SUBAGENT_SPAWNED:
      case ACP_SUBAGENT_STATE_UPDATE:
        return this.onSubagentFrame(kind, update);
      case 'available_commands_update': {
        // The session's invokable set for this cwd — feeds the composer's `/`
        // autocomplete. Useful during a replay too (it is current state, not
        // history), so it is deliberately outside the replay guard.
        //
        // The DESCRIPTION is read alongside the name because this transport is
        // the only place it exists: an ACP agent may have no on-disk convention
        // geniro can scan, and dropping the sentence left every row in the
        // popup a bare word. Verified against cursor-agent 2026.08.11-e8db854,
        // whose 27 entries all carry one.
        const commands = asArray(update.availableCommands)
          .map((entry) => {
            const record = asRecord(entry);
            const name = record ? asString(record.name) : null;
            return name === null || name.length === 0
              ? null
              : {
                  name,
                  description: record ? asString(record.description) : null,
                };
          })
          .filter(
            (command): command is AgentReportedCommand => command !== null,
          );
        return commands.length > 0
          ? [{ type: 'slash_commands', commands }]
          : [];
      }
      case 'usage_update': {
        this.usage.contextUsed =
          asNumber(update.used) ?? this.usage.contextUsed;
        const cost = asRecord(update.cost);
        if (cost) {
          this.usage.costAmount = asNumber(cost.amount);
          this.usage.costCurrency = asString(cost.currency);
        }
        return [];
      }
      case 'current_mode_update': {
        // The agent moving itself between modes, which is the ONLY channel that
        // reports one: `set_mode`'s reply covers a change this client asked for
        // and nothing else. Recorded because the mode outlives the turn —
        // `pickMode` decides whether the next turn needs a frame at all by
        // comparing against where the session actually IS, so a mode changed
        // behind our back leaves it re-sending one that is already applied, or
        // skipping one it needed. It draws no transcript row: this is session
        // state, not something the agent said.
        const mode = asString(update.currentModeId);
        if (mode) {
          this.session.currentModeId = mode;
        }
        return [];
      }
      case 'user_message_chunk': {
        // Our own prompt echoed back. It draws no row — an IMPORT reads these
        // out of a `session/load` replay in `acp-sessions.ts` instead, at
        // creation time, so they land BELOW the first message the user sends
        // here. What a REPLAYED one is still worth is the instruction block it
        // carried: the newest one is what the loaded conversation already
        // holds, which is what lets `composePrompt` leave it out.
        if (this.replaying) {
          const text = textOf(update.content);
          const block = text === null ? null : readHostContext(text);
          if (block !== null) {
            this.replayedInstructions = block;
          }
        }
        return [];
      }
      case 'plan': {
        // The agent's plan — sent whatever capabilities the client declares
        // (cursor-agent 2026.10.19 sends one from every CreatePlan, before its
        // own `cursor/create_plan`). History during a replay, like any row.
        if (this.replaying) {
          return [];
        }
        const tasks = readAcpPlan(update.entries);
        if (tasks === null) {
          return [];
        }
        if (this.session.options.todos?.plan !== undefined) {
          // The agent restates this plan with ids — see `AcpTodoProtocol.plan`.
          this.heldPlan = tasks;
          return [];
        }
        // A row, so the text before it is a finished block — the same close a
        // tool call makes, without which the list would be written ahead of
        // the words that introduced it.
        return [...this.flushTextBlock(), this.planEvent(tasks)];
      }
      default:
        // config_option_update, session_info_update — real ACP updates this
        // transcript does not model.
        //
        // `session_info_update` carries a `title` and nothing else, and the
        // agent WRITES that same name into its own session store before
        // emitting the frame (measured in cursor-agent 2026.08.31-4057e58's
        // own auto-name path). `AgentAdapter.readSessionTitle` reads that
        // store, so the name already reaches geniro by a route that survives a
        // restart; the frame would buy only TIMING, and collecting it needs a
        // consumer able to hand the title to `ChatTitleService` — which owns
        // the guard that keeps a user's manual rename permanent, and which no
        // driver can reach. Recording it here without that consumer is state
        // nobody reads.
        return [];
    }
  }
}
