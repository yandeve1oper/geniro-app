import {
  delegateCloseEvent,
  delegateDeclarationEvent,
} from '../../utils/open-delegates';
import type {
  AgentEvent,
  AgentTurnInput,
  ApprovalOption,
  BackgroundUnitOutcome,
  FollowUpMessage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  classifyMessage,
  encodeResult,
  type JsonRpcId,
} from '../utils/json-rpc.utils';
import {
  type PendingRequest,
  PendingRequests,
} from '../utils/json-rpc-pending.utils';
import {
  ACP_AGENT_METHODS,
  ACP_PROTOCOL_VERSION,
  type AcpAgentCapabilities,
  type AcpMcpServerHttp,
  type AcpMcpToolCall,
  type AcpParkedPermission,
  type AcpToolCall,
} from './acp.types';
import {
  type AcpDelegateEnding,
  type AcpEndedDelegate,
  type AcpSessionOptions,
  AcpTurnDriver,
  type PendingKind,
} from './acp-driver';

/**
 * How long each kind of frame's reply is waited for.
 *
 * PARTIAL on purpose, and the ABSENCES carry the reasoning. `prompt` is the
 * turn itself, so bounding it would give up on an agent that is working —
 * that is what `spawn-cli.ts`'s turn deadline already answers, measured
 * against SILENCE rather than against length. `initialize` / `session` /
 * `session_load` are the handshake: a reply that never comes leaves nothing to
 * run the turn on, so expiring one would emit a notice and change nothing.
 *
 * What is left is the two kinds that can HOLD a prompt: the model and parameter
 * frames, sent one at a time with the prompt behind them
 * (`AcpTurnDriver.configSteps`), where a reply that never arrives strands every
 * frame queued after it and the prompt — silently, a held turn emitting nothing
 * at all, until the turn-level silence deadline gives up on it half an hour
 * later. Expiring turns that into a notice plus a turn running on the agent's
 * own settings, which is what a REFUSAL of the same frame already produces.
 *
 * `set_mode` is absent for the reason the handshake frames are: it is not in
 * that queue, so it cannot strand anything, and arming it would only buy a
 * chance to narrate a turn that had already run on. Being listed here is not
 * on its own permission to speak — the last frame holds the prompt only for an
 * agent that asks it to (`AcpSessionOptions.promptAwaitsConfig`), so
 * `AcpTurnDriver.onRequestDeadline` re-checks before it emits.
 */
const REQUEST_DEADLINE_MS: Partial<Record<PendingKind, number>> = {
  set_model: 30_000,
  set_model_parameter: 30_000,
};

/**
 * How often a background delegate's own record is looked at while it is out.
 *
 * A poll because there is no event: the CLI this exists for writes the ending
 * to disk and says nothing on the wire. Five seconds is the detached-shell
 * sweep's own cadence (`spawn-cli`), for the same trade — a block that closes
 * a few seconds late, against a stat and a 4KB read per delegate per tick.
 * It runs only while a watchable delegate is out, so a session that never
 * backgrounds one never polls.
 */
const DELEGATE_ENDING_POLL_MS = 5_000;

/**
 * Consecutive missing records release the turn hold. The delegate becomes
 * untracked; durable recovery can still resolve it from a later CLI record.
 */
const DELEGATE_RECORD_MISS_LIMIT = 6;

/**
 * ONE `cursor-agent acp`-style process, and the turns run on it.
 *
 * This is the `TurnDriver` an ACP adapter returns, and it is the SESSION half
 * of what used to be one class: the transport, the requests awaiting a reply
 * (`PendingRequests`), the capabilities the agent negotiated, the session id,
 * the MCP servers that session registered, and the model it is running as. One
 * per process; a fresh {@link AcpTurnDriver} is built for each turn.
 *
 * **The split is what makes a kept process safe.** ACP allows many
 * `session/prompt` calls on one session (spec: "Once a prompt turn completes,
 * the Client may send another `session/prompt` to continue the conversation"),
 * and it was measured here — two prompts on one live cursor-agent process, the
 * second answering a codeword only the first had been told. What stood in the
 * way was not the protocol but this client: nearly every field of the old class
 * was per-TURN and said so in its own doc comments, harmless only while a
 * session was exactly one turn. `imageBlocks` and the turn's `input` were the
 * sharpest — both fixed at construction, so a second turn would have re-sent
 * the first turn's attachments and, worse, its prompt.
 *
 * Resetting ~20 fields between turns was the alternative, and it is the shape
 * this deliberately avoids: it makes "remember to reset" the invariant, and the
 * next field added breaks it in silence. Here a field is per-turn by DEFAULT —
 * it lives on the object that is thrown away — and surviving a turn is a
 * deliberate move to this class.
 */
export class AcpSession implements TurnDriver {
  /**
   * The child's stdin/stdout for this PROCESS.
   *
   * Re-set on every turn rather than captured once: `spawn-cli` hands a fresh
   * `TurnIo` per turn (its `emit` routes to the turn currently open), so a
   * captured one would publish turn 2's events into turn 1's settled stream.
   */
  io: TurnIo | null = null;
  /**
   * What the agent said it can do, from the one `initialize` handshake. A
   * property of the process — nothing later restates it.
   */
  capabilities: AcpAgentCapabilities = {
    loadSession: false,
    mcpHttp: false,
    promptImage: false,
    subagentSessions: false,
  };
  /** The conversation every turn on this process prompts into. */
  sessionId: string | null = null;
  /**
   * The MCP servers this SESSION registered. `composePrompt` derives the
   * call-surface grant from this rather than from a separate flag, so the "May
   * call" block and the tools it names cannot disagree — and it is session-wide
   * because `mcpServers` rides `session/new`, which happens once.
   */
  grantedMcpServers: AcpMcpServerHttp[] = [];
  /** This session was opened via `session/load` — and that load succeeded. */
  resumed = false;
  /**
   * The model the SESSION is running as, as the AGENT stated it — read from the
   * session reply's `models.currentModelId`, and replaced by the id the agent
   * CONFIRMS on a `set_model` reply. Never by the id a turn merely requested:
   * `turn_model` announces that one, and `PartialStreamService.rememberWindow`'s
   * anti-poisoning guard compares the two, so collapsing them onto this field
   * would leave it comparing a value against itself.
   *
   * Session-scoped because that is what it describes: ACP carries no model
   * announcement of its own, so this is the only thing a `turn_model` event can
   * be built from, and the fact it reports does not end with a turn.
   */
  currentModelId: string | null = null;
  /**
   * The `session/new` | `session/load` reply, verbatim.
   *
   * Keeps the opening mode/model vocabulary for later turns. Config replies
   * can restate the current model's options; `lastConfigReply` holds those for
   * agents that opt into comparing current parameter values.
   */
  lastSessionReply: Record<string, unknown> | null = null;
  /**
   * The latest session/config reply, including its current option values.
   * Replaced even when a config reply lists nothing: an accepted change with
   * no current values must invalidate the earlier snapshot for skipping.
   */
  lastConfigReply: unknown = null;
  /**
   * The instruction block this conversation holds most recently, verbatim, or
   * null when it holds none this client can vouch for.
   *
   * Prompt text is part of the CONVERSATION on this transport — there is no
   * out-of-band system-instruction field — so a block sent with one turn is in
   * the window for every turn after it, and `AcpTurnDriver.composePrompt`
   * sends it again only when the text it would send differs from this.
   *
   * Two writers, one per way a session comes to hold a block: a prompt that
   * carried one records it once the frame is WRITTEN, and a successful
   * `session/load` records the newest block its replay handed back. A value
   * rather than a flag because the block can legitimately change within one
   * conversation — a boolean would withhold the new text as "already sent".
   */
  deliveredInstructions: string | null = null;
  /**
   * The mode the session started in — the agent's own default, from the
   * session reply's `modes.currentModeId`.
   *
   * Kept because a mode is SESSION state that the client sets and nothing
   * resets: a turn that wants no particular mode has to name this to get back
   * to it. See {@link currentModeId}.
   */
  defaultModeId: string | null = null;
  /**
   * The mode the session is in NOW — {@link defaultModeId} until a turn's
   * `session/set_mode` is accepted, or until the AGENT moves itself and says so
   * on a `current_mode_update`, which is the only channel reporting a change
   * this client did not ask for.
   *
   * The pair exists because a mode outlives the turn that set it, which one
   * process per turn hid completely: a chat run under `plan` and then switched
   * back to `auto` sent nothing on its next turn (there being no mode to ask
   * for) and the agent stayed in plan mode, with the composer chip and the run
   * row both reading `auto`. That is the permission surface reading a posture
   * the CLI was never returned to.
   */
  currentModeId: string | null = null;

  // ── Keyed by a PROTOCOL id, which is the session's namespace ─────────────
  // Every map below is keyed by an ACP `toolCallId` or an encoded JSON-RPC
  // request id. Both are unique across the session and neither is re-minted
  // per turn, so a turn is the wrong scope for them — a fact hidden while a
  // session was one turn, and load-bearing now that a request raised in one
  // turn can be answered in the next (`spawn-cli` re-holds an unanswered
  // approval for the turn that follows).

  /** Tool name by ACP toolCallId, so a later update can name its result. */
  readonly toolNames = new Map<string, string>();
  /**
   * Tool arguments by ACP toolCallId. Same stub problem: a permission request
   * that omits the name and kind usually omits these too, and an approval card
   * showing no arguments asks the user to approve something they cannot see.
   */
  readonly toolInputs = new Map<string, unknown>();
  /**
   * The MCP call each renamed toolCallId named (`AcpSessionOptions.mcpToolCall`),
   * kept until it settles: the settling update carries neither title nor
   * arguments to read it from again.
   */
  readonly mcpCalls = new Map<string, AcpMcpToolCall>();
  /**
   * Each parked permission request — its offered options and the tool call it
   * asked about — keyed by encoded id.
   *
   * SESSION-scoped, and that is a fix rather than a tidy-up. A request the user
   * has not answered when its turn settles is re-held and re-offered to the
   * NEXT turn (`spawn-cli`'s `pendingApprovals`), so the verdict arrives while
   * a different turn is current — and a per-turn map would then have no entry
   * for it, `buildApprovalResponse` would answer undefined, and the card would
   * read as answered while the agent stayed parked forever. Unreachable while
   * one process served one turn, because the session died with the turn.
   */
  readonly parkedPermissions = new Map<string, AcpParkedPermission>();
  /**
   * Tool calls whose permission geniro answered with anything but a selected
   * allow option (a Deny, an auto-deny, a request released unanswered, an allow
   * the agent offered no option for). The agent still closes such a call as
   * `completed`; the mark is what lets its result read as an error. Session
   * scoped like {@link parkedPermissions}: a verdict can land in a later turn
   * than the call's update.
   */
  readonly refusedToolCalls = new Set<string>();
  /**
   * Params of each parked QUESTION, keyed by encoded id. A separate map from
   * the permissions above, and not merely for the payload: which map an id is
   * in is what picks the reply encoder, so a question can never be answered
   * with a permission outcome the agent would reject.
   */
  readonly parkedQuestions = new Map<string, unknown>();
  /**
   * Tool calls recognised as sub-agent launches, so their result can be treated
   * as the CLI's accounting rather than the delegate's answer (see
   * `AcpDelegateProtocol.resultIsBookkeeping`).
   */
  readonly delegateToolCalls = new Set<string>();
  /** Of those, the ones the CLI said keep running past their launching call. */
  readonly backgroundDelegates = new Set<string>();
  /**
   * Each delegate's OWN conversation id, keyed by its launching tool call —
   * the address {@link AcpDelegateEndings.read} looks its ending up by, found
   * by {@link AcpDelegateEndings.locate}.
   */
  private readonly delegateConversations = new Map<string, string>();
  /** Each delegate's brief, which is what an unnamed one is located by. */
  private readonly delegatePrompts = new Map<string, string>();
  /** Each delegate's own description, for the parent's wake prompt. */
  private readonly delegateLabels = new Map<string, string>();
  /**
   * Background delegates that ended and that the AGENT has not been told about
   * yet — what the next wake prompt reports ({@link takeEndedDelegates}).
   */
  private endedDelegates: (AcpEndedDelegate & { id: string })[] = [];
  /**
   * The turn waiting for its watched delegates ({@link awaitDelegates}), told
   * after each sweep that closed one.
   */
  private delegateWaiter: (() => void) | null = null;
  /** When each background delegate was seen to launch, for its duration. */
  private readonly delegateLaunchedAt = new Map<string, number>();
  /** Background delegates whose close has been emitted — by any closer here. */
  private readonly closedDelegates = new Set<string>();
  private readonly untrackedDelegates = new Set<string>();
  /** Consecutive reads that found no record, per delegate. */
  private readonly delegateRecordMisses = new Map<string, number>();

  // ── Sub-agent SESSIONS (`acp-subagents.ts`) ──────────────────────────────
  // Keyed by a child's session id or its launching tool call id — protocol ids
  // again, and a child routinely outlives the turn that launched it.

  /** Each announced child session → the tool call that launched it. */
  readonly childSessions = new Map<string, string>();
  /**
   * Announced child sessions with no launching call this client could read —
   * their traffic is dropped rather than drawn without a block to hold it.
   */
  readonly unplacedChildSessions = new Set<string>();
  /**
   * How each delegate ended, as the agent STATED it on the wire, by launching
   * call, including `untracked` for a disconnected child.
   */
  readonly wireEndings = new Map<string, BackgroundUnitOutcome | null>();
  /** What each child said last, by launching call — its report. */
  readonly childReports = new Map<string, string>();
  /** The block each child is streaming right now, by child session id. */
  readonly childBlocks = new Map<
    string,
    { kind: 'text' | 'reasoning'; parts: string[] }
  >();
  /** Each child's tool calls nothing has settled yet, by child session id. */
  readonly childOpenCalls = new Map<string, Set<string>>();
  /**
   * A child's calls announced before their arguments exist, by tool call id —
   * the parent's `heldToolCalls`, for a stream that outlives a turn.
   */
  readonly childHeldCalls = new Map<
    string,
    { child: string; call: AcpToolCall }
  >();
  /** The pending look at the delegates' records, or null while none is due. */
  private delegateWatch: NodeJS.Timeout | null = null;
  /**
   * Once the parent has completed, an unwatchable delegate becomes untracked.
   * Reset as a turn opens.
   */
  private turnCompleted = false;
  /**
   * The directory the session was opened in. A session's cwd is fixed by
   * `session/new`, which only the first turn sends, so every later turn's
   * delegates are filed under this one.
   */
  private readonly cwd: string;

  /** Frames awaiting a reply, and the turn that sent each. */
  private readonly pending = new PendingRequests<PendingKind, AcpTurnDriver>(
    'acp',
    (message) => this.options.logger?.warn(message),
  );
  /**
   * The deadline timers {@link armDeadline} started, keyed like
   * {@link pending} — a separate map because only some kinds carry one.
   */
  private readonly deadlines = new Map<JsonRpcId, NodeJS.Timeout>();
  /** The turn running right now. Replaced wholesale by {@link openTurn}. */
  private turn: AcpTurnDriver;

  constructor(
    readonly options: AcpSessionOptions,
    firstTurn: AgentTurnInput,
  ) {
    this.turn = new AcpTurnDriver(this, options.turnOptions(firstTurn));
    this.cwd = firstTurn.cwd;
  }

  /**
   * The FIRST turn's opening: wire stdin and start the handshake the agent
   * expects the client to begin (`initialize` → `session/new` | `session/load`).
   *
   * Only ever called for the first turn (`AgentAdapter.startTurn` gates it), and
   * that is right by construction — a handshake belongs to the PROCESS. Later
   * turns arrive through {@link openTurn}.
   */
  onStdinReady(io: TurnIo): void {
    this.io = io;
    this.turnCompleted = false;
    const events: AgentEvent[] = [];
    this.request(
      ACP_AGENT_METHODS.initialize,
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          // Spread rather than assigned, so an adapter that declares nothing
          // sends no `_meta` key at all — an empty object is a claim too.
          ...(this.options.clientMeta
            ? { _meta: this.options.clientMeta }
            : {}),
        },
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
      },
      'initialize',
      events,
    );
    for (const event of events) {
      io.emit(event);
    }
  }

  /**
   * Open a SECOND (or later) turn on this live session —
   * `TurnDriver.openTurn`.
   *
   * A fresh {@link AcpTurnDriver} built from THIS turn's input, then that
   * turn's own mode, model, parameters and prompt. Nothing of the previous turn
   * comes with it, which is the whole reason the driver is per-turn.
   *
   * TOTAL by construction. The one thing here that can throw is reading this
   * turn's attachments off disk, and it is called from inside `spawn-cli`'s
   * `startTurn` — where a throw would unwind past a turn already registered as
   * current, wedging the session. An `error` event settles the turn instead,
   * which is the same outcome the first turn gets for an unreadable attachment
   * and says the same thing to the user.
   */
  openTurn(io: TurnIo, input: AgentTurnInput): void {
    this.io = io;
    this.turnCompleted = false;
    this.delegateWaiter = null;
    // An ending nobody was told about belongs to the turn that launched it,
    // which is over — never news for this one.
    this.endedDelegates = [];
    let events: AgentEvent[];
    try {
      this.turn = new AcpTurnDriver(this, this.options.turnOptions(input));
      events = this.turn.openOnLiveSession();
    } catch (err) {
      events = [
        {
          type: 'error',
          message: `acp: could not open this turn: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ];
    }
    for (const event of events) {
      io.emit(event);
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const pending = this.takePending(message.id);
        return pending === null
          ? []
          : pending.turn.onReply(pending.kind, message.result, message.id);
      }
      case 'error': {
        const pending = this.takePending(message.id);
        return pending === null
          ? []
          : pending.turn.onErrorReply(
              pending.kind,
              message.message,
              message.id,
            );
      }
      case 'request':
        return this.turn.onAgentRequest(
          message.id,
          message.method,
          message.params,
        );
      case 'notification':
        return this.turn.onNotification(message.method, message.params);
      case 'unknown':
        return [];
    }
  }

  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string | undefined {
    return this.turn.buildApprovalResponse(id, allow, updatedInput, option);
  }

  sendFollowUp(message: FollowUpMessage): boolean {
    return this.turn.sendFollowUp(message);
  }

  subagentsAFollowUpCancels(): number {
    return this.turn.subagentsAFollowUpCancels();
  }

  buildInterruptPayload(): string | undefined {
    return this.turn.buildInterruptPayload();
  }

  withdrawHeldPrompt(): boolean {
    return this.turn.withdrawHeldPrompt();
  }

  onProcessEnded(): AgentEvent[] {
    return this.turn.onProcessEnded();
  }

  onQuiet(): AgentEvent[] | null {
    return this.turn.onQuiet();
  }

  /**
   * Whether this process can serve ANOTHER turn — `TurnDriver.canOpenTurn`.
   *
   * Only once it holds a conversation. A handshake that failed (`initialize`
   * refused, `session/new` refused or answered with no id, a resume-only load
   * the agent turned down) leaves the process alive with no session, and every
   * later turn opened on it went nowhere: `openTurn` reached `beginTurn`, whose
   * model frame and prompt both return early on a null session id, so the turn
   * wrote no frame, produced no event, and waited out the 30-minute silence
   * deadline. Refusing here is what makes the owner spawn a fresh process
   * instead — the failed turn itself has already settled on its own error.
   */
  canOpenTurn(): boolean {
    return this.sessionId !== null;
  }

  /**
   * Whether `turn` is still the one this process runs — false once a later
   * turn replaced it. A timer a turn armed asks this before it acts, since it
   * can outlive the turn that armed it.
   */
  isCurrentTurn(turn: AcpTurnDriver): boolean {
    return this.turn === turn;
  }

  /** False once the process is known to be gone; true while it may be alive. */
  processAlive(): boolean {
    return this.io?.processAlive?.() !== false;
  }

  // --- outbound -------------------------------------------------------------

  /** Send one request, answering whether it actually went out. */
  request(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): boolean {
    return this.sendRequest(method, params, kind, events) !== null;
  }

  /**
   * {@link request}, answering with the id the frame went out under, or null
   * when it did not go out at all.
   *
   * The id is what correlates a reply with the frame that earned it, which only
   * the frames whose reply changes a turn's own state need: the model or
   * parameter frame the rest of the turn is queued behind (`configInFlight`)
   * and the prompt itself (`latestPromptId`).
   */
  sendRequest(
    method: string,
    params: unknown,
    kind: PendingKind,
    events: AgentEvent[],
  ): JsonRpcId | null {
    const id = this.pending.send(
      method,
      params,
      kind,
      this.turn,
      (frame) => this.io?.write(frame) === true,
    );
    if (id === null) {
      events.push({
        type: 'error',
        message: `acp: failed to send ${method}${this.writeFailure()}`,
      });
      return null;
    }
    // Only a frame that actually went out is waited for — the branch above
    // returns before this, so a write that failed arms nothing.
    this.armDeadline(id, kind);
    return id;
  }

  /**
   * Give up on one frame's reply once {@link REQUEST_DEADLINE_MS} has passed.
   *
   * `unref`ed, so a timer still armed can never hold the process open past the
   * work it belongs to. A kind the map does not name is waited for indefinitely,
   * exactly as before.
   */
  private armDeadline(id: JsonRpcId, kind: PendingKind): void {
    const ms = REQUEST_DEADLINE_MS[kind];
    if (ms === undefined) {
      return;
    }
    const timer = setTimeout(() => {
      // Dropped first, so the `takePending` below finds nothing left to clear.
      this.deadlines.delete(id);
      // Which also applies the stale-turn guard: a frame whose turn has since
      // ended is logged and dropped rather than narrated into the turn that
      // replaced it, on the same terms a late REPLY is.
      const entry = this.takePending(id);
      if (entry === null) {
        return;
      }
      for (const event of entry.turn.onRequestDeadline(id, entry.kind, ms)) {
        this.emit(event);
      }
    }, ms);
    timer.unref();
    this.deadlines.set(id, timer);
  }

  /** Answer one agent→client request. */
  reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.options.logger?.warn(
        `acp: dropped a reply to request ${String(id)}${this.writeFailure()}`,
      );
    }
  }

  /** Write a frame this class did not build (an in-protocol error reply). */
  write(payload: string): boolean {
    return this.io?.write(payload) === true;
  }

  /** Publish one event outside a handler's own return — see `sendFollowUp`. */
  emit(event: AgentEvent): void {
    this.io?.emit(event);
  }

  // --- background delegates ----------------------------------------------

  /**
   * A delegate the launching call said goes on running. Recorded here, on the
   * session, because it outlives the turn that launched it — which is the
   * whole of what makes it a background delegate.
   */
  noteBackgroundDelegate(id: string): void {
    if (this.backgroundDelegates.has(id)) {
      return;
    }
    this.backgroundDelegates.add(id);
    this.noteDelegateLaunch(id);
    this.armDelegateWatch();
  }

  /**
   * When a delegation's launching call was written — kept for EVERY delegate,
   * not only a background one, because a delegate the call waits on can become
   * one later ({@link adoptCutOffDelegate}) and its record is located by being
   * born after this moment. The first time seen wins: the background path
   * notes it again ~200ms later, as the call returns.
   */
  noteDelegateLaunch(id: string): void {
    if (!this.delegateLaunchedAt.has(id)) {
      this.delegateLaunchedAt.set(id, Date.now());
    }
  }

  /**
   * Take a delegate whose launching call the failed request CUT OFF and watch
   * it as a background delegate — true when it can be watched, and is now.
   *
   * The request dying does not stop the delegate. Read out of cursor-agent
   * 2026.10.01-e373342 (`9577.index.js`, `runSession`): a delegate's context is
   * detached and cancelled only by an action abort or a user cancel, while the
   * stream failure cancels the stream alone. MEASURED on run `a8f5fb5f`: the
   * parent's stream closed at 08:28:45Z and the two verifiers still running
   * wrote `turn_ended success` at 08:35:06Z and 08:36:23Z — their results
   * written into a stream that no longer existed. Watching their records is
   * what lets those results reach the agent at all, through the wake.
   *
   * `launch` is the brief off the call's own input, for a delegate never
   * announced (see `AcpDelegateProtocol.readLaunchInput`). A delegate with no
   * brief, or an agent with no way to see endings, cannot be watched and is
   * left to the caller to close.
   */
  adoptCutOffDelegate(
    id: string,
    launch: { label: string | null; prompt: string | null } | null,
  ): boolean {
    if (launch !== null) {
      // Only what the announcement did not already say — it is the richer
      // source whenever it arrived.
      this.noteDelegatePrompt(
        id,
        this.delegatePrompts.has(id) ? null : launch.prompt,
        this.delegateLabels.has(id) ? null : launch.label,
      );
    }
    if (!this.canWatch(id)) {
      return false;
    }
    this.noteBackgroundDelegate(id);
    return true;
  }

  /** A delegate's own description, when it gave one. */
  delegateLabel(id: string): string | null {
    return this.delegateLabels.get(id) ?? null;
  }

  /**
   * The agent said, on the wire, that the delegate `id` ended — answered with
   * the close row for a BACKGROUND delegate still out, or null.
   *
   * Recorded for every delegate, because a foreground one's ending is what a
   * failed request needs to know (`AcpTurnDriver.settleCutOffToolCalls`): the
   * agent holds its prompt until its sub-agents end, so a delegate cut off by
   * a dropped stream has usually ended by the time the failure is read.
   *
   * A background delegate is closed exactly as its transcript watch would
   * close it — reported to a turn waiting on it, too — because the two are
   * the same fact from two sources and whichever lands first wins. The waiter
   * is told on a microtask, after the row the caller is about to emit: it may
   * send the wake prompt, and the close must be on screen before that.
   */
  endDelegateOnWire(
    id: string,
    outcome: BackgroundUnitOutcome | null,
  ): AgentEvent | null {
    const wasUntracked = this.untrackedDelegates.has(id);
    this.wireEndings.set(id, outcome);
    if (
      outcome !== null &&
      outcome !== 'untracked' &&
      this.untrackedDelegates.delete(id)
    ) {
      this.closedDelegates.delete(id);
    }
    if (
      (!this.backgroundDelegates.has(id) && !wasUntracked) ||
      this.closedDelegates.has(id)
    ) {
      return null;
    }
    const launchedAt = this.delegateLaunchedAt.get(id);
    const durationMs =
      launchedAt === undefined ? null : Date.now() - launchedAt;
    const event = this.closeDelegate(id, outcome, durationMs);
    this.noteEnded(
      id,
      outcome,
      durationMs,
      this.childReports.get(id) ?? null,
      null,
    );
    queueMicrotask(() => this.delegateWaiter?.());
    return event;
  }

  /** How many background delegates are still running. */
  runningBackgroundDelegates(): number {
    return this.outstandingDelegates().length;
  }

  /**
   * What each of these FINISHED delegates reported, read off its record — for
   * a resume that has to hand the agent results the failed request lost.
   *
   * Never rejects: a delegate whose record cannot be found or read is still
   * listed, with its outcome and report unknown, because naming it is what
   * stops the agent from assuming it never ran.
   */
  async readFinishedDelegates(
    ids: readonly string[],
  ): Promise<AcpEndedDelegate[]> {
    const endings = this.options.delegate?.endings;
    const reports: AcpEndedDelegate[] = [];
    for (const id of ids) {
      if (this.wireEndings.has(id)) {
        // The agent streamed this child and said how it ended: its last words
        // ARE its report, with no file to find.
        reports.push({
          label: this.delegateLabels.get(id) ?? null,
          outcome: this.wireEndings.get(id) ?? null,
          durationMs: null,
          finalText: this.childReports.get(id) ?? null,
          recordPath: null,
        });
        continue;
      }
      let ending: AcpDelegateEnding | null = null;
      if (endings !== undefined && this.delegatePrompts.has(id)) {
        try {
          const conversationId = await this.delegateAddress(
            id,
            this.delegateLaunchedAt.get(id) ?? Date.now(),
          );
          ending =
            conversationId === null
              ? null
              : await endings.read({
                  conversationId,
                  cwd: this.cwd,
                  sessionId: this.sessionId,
                });
        } catch (err) {
          this.options.logger?.debug?.(
            `acp: could not read finished delegate ${id}'s record: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const ended = ending?.state === 'ended' ? ending : null;
      reports.push({
        label: this.delegateLabels.get(id) ?? null,
        outcome: ended?.outcome ?? null,
        // The announcement's duration rode a row already; the report is about
        // what the delegate FOUND.
        durationMs: null,
        finalText: ended?.finalText ?? null,
        recordPath: ended?.recordPath ?? null,
      });
    }
    return reports;
  }

  /**
   * The delegate's brief, off its announcement — what its record is located
   * by. Recorded for every delegate, background or not, because the two frames
   * that decide which it is arrive in either order and a foreground one is
   * simply never watched.
   */
  noteDelegatePrompt(
    id: string,
    prompt: string | null,
    label: string | null = null,
  ): void {
    if (label !== null && label.trim() !== '') {
      this.delegateLabels.set(id, label.trim());
    }
    if (prompt !== null && prompt.trim() !== '') {
      this.delegatePrompts.set(id, prompt);
      this.armDelegateWatch();
    }
  }

  /**
   * A turn on this session COMPLETED: mark untracked every
   * background delegate still out that nothing can watch — no reader, no
   * address, or a record that never turned up.
   *
   * Returned rather than emitted, so the driver can put them AHEAD of the
   * turn's `turn_complete`. A delegate that CAN be watched is left out here on
   * purpose: the turn ending says nothing about it, and closing it anyway is
   * what drew nine working reviewers as nine finished ones.
   */
  onTurnCompleted(): AgentEvent[] {
    this.turnCompleted = true;
    this.delegateWaiter = null;
    return this.outstandingDelegates()
      .filter((id) => !this.canWatch(id))
      .map((id) => this.closeDelegate(id, 'untracked', null));
  }

  /**
   * How many background delegates are out that the watch can see end — of
   * `only`, when given (the ones a turn launched itself).
   */
  watchedDelegatesOut(only?: ReadonlySet<string>): number {
    return this.outstandingDelegates().filter(
      (id) => (only === undefined || only.has(id)) && this.canWatch(id),
    ).length;
  }

  /**
   * Have the current turn told as its watched delegates end — after every sweep
   * that closed one; it counts what is left itself. One waiter at a time: it is
   * the HELD turn's, and a turn that opens replaces it.
   *
   * While a turn waits, a delegate whose record never turns up is closed as the
   * watch gives up on it, exactly as it would be once the turn had completed —
   * the turn is not going to complete until it is.
   */
  awaitDelegates(waiter: () => void): void {
    this.delegateWaiter = waiter;
    this.armDelegateWatch();
  }

  /** Stop telling the waiting turn — it settled, was stopped, or moved on. */
  stopAwaitingDelegates(): void {
    this.delegateWaiter = null;
  }

  /**
   * The delegates of `only` that ended since the agent was last told, now
   * handed over — so each ending is reported to it once.
   */
  takeEndedDelegates(only: ReadonlySet<string>): AcpEndedDelegate[] {
    const taken = this.endedDelegates.filter((ended) => only.has(ended.id));
    this.endedDelegates = this.endedDelegates.filter(
      (ended) => !only.has(ended.id),
    );
    return taken.map(({ id: _id, ...ended }) => ended);
  }

  private outstandingDelegates(): string[] {
    return [...this.backgroundDelegates].filter(
      (id) => !this.closedDelegates.has(id),
    );
  }

  private canWatch(id: string): boolean {
    return (
      this.options.delegate?.endings !== undefined &&
      this.delegatePrompts.has(id) &&
      (this.delegateRecordMisses.get(id) ?? 0) < DELEGATE_RECORD_MISS_LIMIT
    );
  }

  /** Remember synthetic closes so a later wire ending can resolve tracking loss. */
  closeCutOffDelegate(id: string): AgentEvent {
    return this.closeDelegate(
      id,
      this.wireEndings.get(id) ?? 'untracked',
      null,
    );
  }

  private closeDelegate(
    id: string,
    outcome: BackgroundUnitOutcome | null,
    durationMs: number | null,
  ): Extract<AgentEvent, { type: 'subagent_info' }> {
    this.closedDelegates.add(id);
    if (outcome === null || outcome === 'untracked') {
      this.untrackedDelegates.add(id);
    } else {
      this.untrackedDelegates.delete(id);
    }
    this.delegateRecordMisses.delete(id);
    return delegateCloseEvent(id, outcome, durationMs);
  }

  /**
   * The conversation a delegate's record is filed under — the one
   * {@link AcpDelegateEndings.locate} matches to its brief, remembered once
   * found so it is matched only once and never handed to a second delegate
   * with the same brief.
   */
  private async delegateAddress(
    id: string,
    launchedAtMs: number,
  ): Promise<string | null> {
    const known = this.delegateConversations.get(id);
    const prompt = this.delegatePrompts.get(id);
    const endings = this.options.delegate?.endings;
    if (known !== undefined || prompt === undefined || endings === undefined) {
      return known ?? null;
    }
    const found = await endings.locate({
      cwd: this.cwd,
      sessionId: this.sessionId,
      prompt,
      launchedAtMs,
      // Only delegates still OUT hold a claim. One that ended leaves its
      // conversation free to be continued: a RESUMED delegate writes into the
      // transcript of the one it continues, and a claim that outlived that
      // delegate would hide the record from the very delegate now writing it.
      claimed: this.claimsExcept(id),
    });
    if (found === null || this.delegateConversations.has(id)) {
      return this.delegateConversations.get(id) ?? null;
    }
    // Continued by a later delegate: the one that held it was cut off, and
    // nothing it says from here on is its own. Marked stopped, with recovery
    // off since its record now belongs to the continuation — and never
    // reported to the agent, which hears about the work from its continuation.
    for (const [other, conversation] of this.delegateConversations) {
      if (
        other !== id &&
        conversation === found &&
        !this.closedDelegates.has(other)
      ) {
        this.delegateConversations.delete(other);
        const closed = this.closeDelegate(other, 'stopped', null);
        this.emit({ ...closed, recovery: null });
      }
    }
    this.delegateConversations.set(id, found);
    this.emit(delegateDeclarationEvent(id, { subagentSessionId: found }));
    return found;
  }

  /** The conversations held by delegates still out other than `id`, with their briefs. */
  private claimsExcept(id: string): Map<string, string> {
    const claims = new Map<string, string>();
    for (const other of this.outstandingDelegates()) {
      const conversation = this.delegateConversations.get(other);
      if (other !== id && conversation !== undefined) {
        claims.set(conversation, this.delegatePrompts.get(other) ?? '');
      }
    }
    return claims;
  }

  /**
   * Schedule the next look, when there is anything to look at.
   *
   * Chained timeouts rather than an interval, so a slow disk cannot overlap
   * one sweep with the next — the timer stays set until its sweep finishes —
   * and `unref`'d, so a forgotten watch can never keep the daemon alive. It
   * stops once the process is gone; durable recovery owns later record reads.
   */
  private armDelegateWatch(): void {
    if (
      this.delegateWatch !== null ||
      this.io?.processAlive?.() === false ||
      !this.outstandingDelegates().some((id) => this.canWatch(id))
    ) {
      return;
    }
    this.delegateWatch = setTimeout(() => {
      void this.sweepDelegateEndings().finally(() => {
        this.delegateWatch = null;
        this.armDelegateWatch();
      });
    }, DELEGATE_ENDING_POLL_MS);
    this.delegateWatch.unref();
  }

  /**
   * Look at every watched delegate's record once, and close each one that says
   * it is over — with the outcome it states and the duration measured here,
   * since a background delegate's announcement carried only its LAUNCH's.
   *
   * Emitted through the session's I/O, which routes to the turn that is open
   * or, between turns, to the owner's off-turn sink — a delegate finishing is
   * no less a fact for arriving while nobody is talking to the agent.
   */
  private async sweepDelegateEndings(): Promise<void> {
    const endings = this.options.delegate?.endings;
    if (endings === undefined || this.io?.processAlive?.() === false) {
      return;
    }
    let closedAny = false;
    for (const id of this.outstandingDelegates()) {
      if (!this.canWatch(id)) {
        continue;
      }
      const launchedAtMs = this.delegateLaunchedAt.get(id) ?? Date.now();
      let ending: AcpDelegateEnding | null = null;
      try {
        const conversationId = await this.delegateAddress(id, launchedAtMs);
        ending =
          conversationId === null
            ? null
            : await endings.read({
                conversationId,
                cwd: this.cwd,
                sessionId: this.sessionId,
              });
      } catch (err) {
        this.options.logger?.debug?.(
          `acp: could not read delegate ${id}'s record: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      // Closed while this read was out — by a turn completing, say.
      if (this.closedDelegates.has(id)) {
        continue;
      }
      if (ending === null) {
        const misses = (this.delegateRecordMisses.get(id) ?? 0) + 1;
        this.delegateRecordMisses.set(id, misses);
        if (misses >= DELEGATE_RECORD_MISS_LIMIT) {
          this.options.logger?.warn(
            `acp: delegate ${id}'s record never turned up — it will be closed with its turn instead of when it ends`,
          );
          // The turn it would have been closed with may already be over, and
          // nothing else would ever come for it then — nor will a turn that is
          // WAITING on it ever be over, until it is closed.
          if (this.turnCompleted || this.delegateWaiter !== null) {
            this.emit(this.closeDelegate(id, 'untracked', null));
            this.noteEnded(id, 'untracked', null, null, null);
            closedAny = true;
          }
        }
        continue;
      }
      this.delegateRecordMisses.delete(id);
      if (ending.state === 'ended') {
        const launchedAt = this.delegateLaunchedAt.get(id);
        const durationMs =
          launchedAt === undefined ? null : Date.now() - launchedAt;
        this.emit(this.closeDelegate(id, ending.outcome, durationMs));
        this.noteEnded(
          id,
          ending.outcome,
          durationMs,
          ending.finalText ?? null,
          ending.recordPath ?? null,
        );
        closedAny = true;
      }
    }
    if (closedAny) {
      this.delegateWaiter?.();
    }
  }

  private noteEnded(
    id: string,
    outcome: BackgroundUnitOutcome | null,
    durationMs: number | null,
    finalText: string | null,
    recordPath: string | null,
  ): void {
    // Kept only for an agent that is ever told — nothing else reads them.
    if (this.options.delegate?.wakePrompt === undefined) {
      return;
    }
    this.endedDelegates.push({
      id,
      label: this.delegateLabels.get(id) ?? null,
      outcome,
      durationMs,
      finalText,
      recordPath,
    });
  }

  /**
   * The " — <cause>" tail for a write that did not land, or `''` when the
   * writer named none.
   *
   * ASKED, never assumed. Every one of these sites used to assert `stdin is
   * closed`, which this client cannot know: `write` answers a bare boolean and
   * four different things produce that false (see `TurnIo.writeObstacle`). The
   * invented one named geniro as the closer, and it was wrong in the case that
   * mattered — cursor-agent closing its own read end while still running —
   * which sent a live investigation after the wrong process.
   */
  writeFailure(): string {
    const obstacle = this.io?.writeObstacle?.() ?? null;
    return obstacle === null ? '' : ` — ${obstacle}`;
  }

  /**
   * The pending entry for a reply, or null when nothing here is owed one — a
   * reply owed to a turn that is no longer current is dropped, not given to the
   * turn that is. The deadline is cleared first either way: a reply that
   * arrives has beaten its own timer, stale or not.
   */
  private takePending(
    id: JsonRpcId,
  ): PendingRequest<PendingKind, AcpTurnDriver> | null {
    const timer = this.deadlines.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.deadlines.delete(id);
    }
    return this.pending.take(id, this.turn);
  }
}
