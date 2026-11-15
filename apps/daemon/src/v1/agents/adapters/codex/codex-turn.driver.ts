import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import type { ModelPrice } from '../../utils/model-prices';
import { ollamaModelName } from '../../utils/ollama';
import type {
  AgentEvent,
  AgentTask,
  AgentTaskStatus,
  AgentTurnInput,
  AgentUsage,
  ApprovalOption,
  FollowUpMessage,
} from '../adapter.types';
import {
  decodeRequestId,
  encodeError,
  encodeRequestId,
  encodeResult,
  JSONRPC_METHOD_NOT_FOUND,
  type JsonRpcId,
} from '../utils/json-rpc.utils';
import {
  CODEX_ACTIVE_WRITER_MARKER,
  CODEX_ACTIVE_WRITER_RETRIES,
  CODEX_ACTIVE_WRITER_RETRY_MS,
  CODEX_COMPACT_PROMPT,
  CODEX_DELEGATE_LABEL_MAX_CHARS,
  CODEX_FAILED_TOOL_RESULT,
  CODEX_METHODS,
  CODEX_MODEL_MISMATCH_MESSAGE,
  CODEX_NOTIFICATIONS,
  CODEX_OLLAMA_PROVIDER,
  CODEX_REASONING_SUMMARY,
  CODEX_SERVER_REQUESTS,
  CODEX_STEER_ANSWER_GRACE_MS,
  CODEX_STEER_PREVIEW_MAX_CHARS,
  CODEX_STOP_CLOSE_GRACE_MS,
  CODEX_STOPPED_COMMAND_PREVIEW_MAX_CHARS,
  CODEX_STOPPED_TOOL_RESULT,
  CODEX_TERMINAL_LIST_MAX_PAGES,
  CODEX_WAIT_GAP_GRACE_MS,
} from './codex.const';
import type {
  CodexItem,
  CodexTokenBreakdown,
  CodexTokenUsage,
  CodexTurnPolicy,
} from './codex.types';
import type { CodexSession } from './codex-session';
import {
  codexApprovalCard,
  encodeCodexReply,
  fileChangeStaysIn,
} from './utils/codex-approval.utils';
import { codexPermissionHookOverrides } from './utils/codex-hooks.utils';
import {
  codexUserInput,
  finishedAgentsOf,
  firstLine,
  itemCompletedEvents,
  itemStartedEvents,
  readCodexItem,
  receiverThreadsOf,
  spawnsSubagent,
  subAgentActivityOf,
  subagentOutcomeOf,
  subagentState,
  unitPhase,
  waitsOnSubagents,
} from './utils/codex-items.utils';
import { codexTurnMcpOverrides } from './utils/codex-mcp.utils';
import {
  codexServiceTierOf,
  priceAtServiceTier,
} from './utils/codex-service-tier.utils';
import { userMessageText } from './utils/codex-threads.utils';
import {
  baselineOf,
  type CodexSpend,
  type CodexSubagentsSpend,
  readTokenUsage,
  spendBetween,
  sumSpends,
  turnUsageOf,
} from './utils/codex-usage.utils';

/** What a frame awaiting a reply was, so the reply can be read. */
export type CodexPendingKind =
  | 'initialize'
  | 'config_read'
  | 'hooks_list'
  | 'thread_start'
  | 'thread_resume'
  | 'turn_start'
  | 'compact'
  | 'turn_steer'
  | 'turn_interrupt'
  | 'terminals_list'
  | 'terminal_terminate';

/** A steer in flight: the row id it carries, and the words codex echoes back. */
interface PendingSteer {
  deliveryId: string | null;
  text: string;
}

/** Everything about ONE turn, derived from that turn's own input. */
export interface CodexTurnOptions {
  input: AgentTurnInput;
  /** The composed instruction block, sent as the thread's developer text. */
  developerInstructions: string;
  /**
   * Thread config overrides — geniro's MCP endpoint and the memories switch —
   * or null for none.
   */
  config: Record<string, unknown> | null;
  policy: CodexTurnPolicy;
  /**
   * The auto-compaction threshold the PROCESS was spawned with (`-c
   * model_auto_compact_token_limit=N`), or null when geniro set none — kept
   * for the context readout, which has no other way to learn it.
   */
  autoCompactTokens: number | null;
  /**
   * The MCP servers this turn runs without — a team member's own switches,
   * geniro's own server already left out. Non-empty makes the thread's opening
   * read codex's config first (`config/read`), because which override reaches
   * a server depends on where codex defines it (`codexTurnMcpOverrides`).
   */
  mcpDisabled: readonly string[];
}

/** codex's plan-step status → the task list's. */
const PLAN_STATUS: Readonly<Record<string, AgentTaskStatus>> = {
  pending: 'pending',
  inProgress: 'in_progress',
  completed: 'completed',
};

/**
 * What a notification tagged with an ENDED turn may no longer say: the words,
 * tool calls and plan of the turn now open would otherwise carry it. Readings
 * (usage, reroutes) and errors stay out of this set — a usage reading is a
 * level of the thread, whichever turn it names.
 */
const ENDED_TURN_FENCED: ReadonlySet<string> = new Set([
  CODEX_NOTIFICATIONS.itemStarted,
  CODEX_NOTIFICATIONS.itemCompleted,
  CODEX_NOTIFICATIONS.agentMessageDelta,
  CODEX_NOTIFICATIONS.reasoningTextDelta,
  CODEX_NOTIFICATIONS.reasoningSummaryDelta,
  CODEX_NOTIFICATIONS.planUpdated,
]);

/**
 * ONE turn of a codex conversation — the state that must not outlive it.
 *
 * Built fresh per turn by {@link CodexSession}, which holds what does outlive
 * a turn (the process, the request ids, the thread). A field lives here by
 * default; surviving a turn is a deliberate move to the session.
 */
export class CodexTurnDriver {
  private modelNoticeReported = false;
  /** The turn codex opened for this driver's prompt, once it says which. */
  private turnId: string | null = null;
  /** The newest agent message, carried as the turn's `finalText`. */
  private finalText: string | null = null;
  private summaryPart: { itemId: string | null; index: number } | null = null;
  /** A failure codex reported without retrying, held for the turn's end. */
  private pendingError: string | null = null;
  /** The thread's running total before this turn, from its first reading. */
  private baseline: CodexTokenBreakdown | null = null;
  /** The thread's running total at this turn's previous reading. */
  private previousTotal: CodexTokenBreakdown | null = null;
  /** The context size a compaction started from. */
  private compactingFrom: number | null = null;
  /** A terminal event has been emitted; everything after it is the next turn's. */
  private settled = false;
  /**
   * Tool calls this turn opened that have no result yet, by item id → tool
   * name — what a stopped turn closes ({@link endUnfinishedTurn}).
   * `session.items` cannot answer it: it holds every turn's items and the
   * sub-agents' too.
   */
  private readonly openToolItems = new Map<string, string>();
  /**
   * Commands this turn left running when it was stopped, by item id → their
   * words, until `thread/backgroundTerminals/list` has shown which to end.
   */
  private readonly stoppedCommands = new Map<string, string>();
  /** Listing pages already asked for, so a repeating cursor cannot loop. */
  private readonly listedCursors = new Set<string>();
  /** This turn's `turn/start` carried a collaboration-mode switch. */
  private switchesPlanMode = false;
  /** Times this turn's resume was asked again after an active-writer refusal. */
  private writerRetries = 0;
  /**
   * Steers sent into this turn that codex has not answered yet, each with the
   * `deliveryId` it carried (null for one with no row) and its words.
   */
  private readonly steersOut: PendingSteer[] = [];
  /**
   * Steers codex ACCEPTED that it has not yet shown taking. An accepted steer
   * is only queued: codex takes it as a `userMessage` item at its next step
   * (probed on 0.162.0, ~55 ms later), and an interrupt that lands first
   * discards it — no item, and no trace in the thread. So a turn that ends
   * stopped or failed with one still here dropped it.
   */
  private readonly steersAccepted: PendingSteer[] = [];
  /** `userMessage` words this turn has shown, for an item ahead of its reply. */
  private readonly userMessagesSeen: string[] = [];
  /** The turn ended stopped or failed — what it held of a steer is lost. */
  private endedUnfinished = false;
  /**
   * The turn's ending while a steer is unanswered: a refusal must reach the
   * owner AHEAD of the terminal, as every owner matches a dropped message by
   * the turn it was sent into. Released when the last steer is answered, on a
   * Stop, or after {@link CODEX_STEER_ANSWER_GRACE_MS}.
   */
  private heldEnding: AgentEvent[] | null = null;
  /** The ending has gone out: a refusal now is no longer this turn's. */
  private endingReleased = false;
  /**
   * This turn's open `wait` calls on its sub-agents. While any is open the
   * turn is announced HELD (`turn_held`), as spawn-cli announces claude's
   * hold: the agent produces nothing until a sub-agent reports, so the
   * composer sends a message straight in.
   */
  private readonly openWaits = new Set<string>();
  /** Whether the turn is announced held for {@link openWaits}. */
  private waitHeld = false;
  /** The sub-agent count the hold last announced. */
  private waitHeldFor = 0;
  /** The pending end of the hold after the last wait returned, voided by a
   *  next wait, a message the agent took, or the turn's ending. */
  private waitGap: symbol | null = null;
  /**
   * The thread config that leaves this member's switched-off MCP servers out,
   * once codex's own config has been read — null until then (and for good on a
   * turn that switches nothing off, which never reads it).
   */
  private mcpOverrides: Record<string, unknown> | null = null;
  /**
   * The thread config that switches off the user's own permission-request
   * hooks, once codex has listed its hooks — null until then.
   */
  private hookOverrides: Record<string, unknown> | null = null;

  constructor(
    private readonly session: CodexSession,
    readonly options: CodexTurnOptions,
  ) {}

  private get input(): AgentTurnInput {
    return this.options.input;
  }

  /** This turn is codex's own `/compact`, run as a compaction, not a prompt. */
  private get compacts(): boolean {
    return this.input.prompt.trim() === CODEX_COMPACT_PROMPT;
  }

  // ── Opening ───────────────────────────────────────────────────────────────

  /**
   * The thread this conversation runs in: resumed when the run holds a codex
   * thread id, else started. The instruction block and geniro's MCP endpoint
   * ride here because they belong to the THREAD — a turn has no field for
   * either.
   */
  openThread(events: AgentEvent[]): void {
    const params = this.threadParams();
    const resume = this.input.resumeSessionId?.trim();
    if (this.input.resumeOnly === true && !resume) {
      // Falling through would start a FRESH thread and settle it as a
      // successful reopen — while its id replaced the one the run holds.
      events.push({
        type: 'error',
        message: 'there is no conversation to reopen',
      });
      this.settled = true;
      return;
    }
    if (this.options.mcpDisabled.length > 0 && this.mcpOverrides === null) {
      // Read where codex defines each server first: the override that
      // switches one off differs by where it comes from, and the wrong one
      // fails the whole thread. The reply opens the thread (`config_read`).
      this.session.request(
        CODEX_METHODS.configRead,
        { cwd: this.input.cwd },
        'config_read',
        events,
      );
      return;
    }
    if (this.input.approvalMode !== undefined && this.hookOverrides === null) {
      // In every mode, `auto` included: a live process is re-moded, never
      // respawned, so a thread opened unattended can ask later.
      this.session.request(
        CODEX_METHODS.hooksList,
        { cwds: [this.input.cwd] },
        'hooks_list',
        events,
      );
      return;
    }
    if (resume) {
      this.session.request(
        CODEX_METHODS.threadResume,
        // The reply otherwise carries the whole history as one line (9.7M
        // characters for a 35 MB rollout on 0.162.0), and nothing reads it.
        { threadId: resume, ...params, excludeTurns: true },
        'thread_resume',
        events,
      );
      return;
    }
    this.session.request(
      CODEX_METHODS.threadStart,
      params,
      'thread_start',
      events,
    );
  }

  /**
   * Send this turn's prompt on the thread the session holds — a
   * `thread/compact/start` for `/compact`, else a `turn/start` carrying the
   * turn's own settings.
   *
   * Every setting is sent on every turn, because codex keeps a turn's
   * overrides for the turns after it: a turn that sent nothing would run under
   * whatever the previous one asked for.
   */
  beginTurn(events: AgentEvent[]): void {
    const threadId = this.session.threadId;
    if (threadId === null) {
      // This process holds no thread — the resume on its first turn was
      // refused, or it never got one. Open it now; the reply begins the turn.
      this.openThread(events);
      return;
    }
    if (this.input.resumeOnly === true) {
      // The thread is open and nothing is to be asked of it: that IS this
      // turn's whole outcome, and no prompt is ever in flight to end it later.
      this.settled = true;
      events.push({
        type: 'turn_complete',
        usage: null,
        stopReason: null,
        finalText: null,
      });
      return;
    }
    if (this.compacts) {
      this.session.request(
        CODEX_METHODS.threadCompact,
        { threadId },
        'compact',
        events,
      );
      return;
    }
    const { policy } = this.options;
    const collaborationMode = this.session.collaborationModeFor(
      policy.plan,
      ollamaModelName(this.input.model) ?? this.input.model ?? null,
      this.input.effort ?? null,
    );
    this.switchesPlanMode = collaborationMode !== null;
    const serviceTier = codexServiceTierOf(this.input.modelParameters);
    this.session.request(
      CODEX_METHODS.turnStart,
      {
        threadId,
        input: codexUserInput(this.input.prompt, this.input.images),
        cwd: this.input.cwd,
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
        ...(this.input.model
          ? { model: ollamaModelName(this.input.model) ?? this.input.model }
          : {}),
        ...(this.input.effort ? { effort: this.input.effort } : {}),
        // Never `serviceTier`: that sticks to the thread, across a resume too
        // (measured on 0.166.0), so the user's own `codex resume` would stay on it.
        ...(serviceTier ? { serviceTierForTurn: serviceTier } : {}),
        summary: CODEX_REASONING_SUMMARY,
        ...(collaborationMode ? { collaborationMode } : {}),
      },
      'turn_start',
      events,
    );
  }

  // ── Replies ───────────────────────────────────────────────────────────────

  onReply(
    kind: CodexPendingKind,
    result: unknown,
    detail: string | null = null,
    deliveryId: string | null = null,
  ): AgentEvent[] {
    const events: AgentEvent[] = [];
    switch (kind) {
      case 'terminals_list':
        return this.onTerminalsListed(result);
      case 'terminal_terminate':
        return asRecord(result)?.terminated === true
          ? []
          : this.stillRunningNotices(
              detail === null ? [] : [detail],
              'codex reported it could not end it',
            );
      case 'config_read': {
        const { config, unreachable } = codexTurnMcpOverrides(
          result,
          this.options.mcpDisabled,
        );
        this.mcpOverrides = config;
        if (unreachable.length > 0) {
          // Not a turn failure: the builder already says which rows codex
          // cannot switch for one turn, and a name it does not load at all is
          // ignored by design.
          this.session.log(
            `codex: left on for this turn — no per-turn switch reaches ${unreachable.join(', ')}`,
          );
        }
        this.openThread(events);
        break;
      }
      case 'hooks_list':
        this.hookOverrides = codexPermissionHookOverrides(result);
        this.openThread(events);
        break;
      case 'thread_start':
      case 'thread_resume': {
        const record = asRecord(result);
        const threadId = asString(asRecord(record?.thread)?.id);
        if (threadId === null) {
          events.push({
            type: 'error',
            message: `codex: the ${kind === 'thread_start' ? 'new' : 'resumed'} thread came back without an id`,
          });
          this.settled = true;
          break;
        }
        this.session.threadId = threadId;
        this.session.threadServiceTier = asString(record?.serviceTier);
        const model = asString(record?.model);
        if (model) {
          this.session.threadModel = model;
          events.push(...this.modelMismatchNotice(model));
        }
        // A resumed thread keeps the mode its last turn ran in — plan mode
        // included, whatever process ran it — and a fresh one starts outside
        // it. The turn below decides from this whether to switch.
        const mode = asString(asRecord(record?.collaborationMode)?.mode);
        if (mode !== null) {
          this.session.notePlanMode(mode === 'plan');
        } else if (kind === 'thread_start') {
          this.session.notePlanMode(false);
        }
        // What the context readout lists: the instruction files codex says
        // this thread loaded (`instructionSources`), the model, and the
        // threshold this process compacts at.
        this.session.noteFacts({
          instructionSources: asArray(record?.instructionSources).flatMap(
            (path) => {
              const text = asString(path);
              return text ? [text] : [];
            },
          ),
          model: this.session.threadModel,
          autoCompactTokens: this.options.autoCompactTokens,
        });
        events.push({ type: 'session', sessionId: threadId });
        if (this.session.threadModel) {
          events.push({ type: 'turn_model', model: this.session.threadModel });
        }
        this.beginTurn(events);
        break;
      }
      case 'turn_start': {
        const record = asRecord(result);
        const turn = asRecord(record?.turn);
        const id = asString(turn?.id);
        if (id !== null && this.turnId === null) {
          this.turnId = id;
        }
        events.push(
          ...this.onReportedModel(
            asString(record?.model) ?? asString(turn?.model),
          ),
        );
        if (this.switchesPlanMode) {
          this.session.notePlanMode(this.options.policy.plan);
        }
        break;
      }
      case 'turn_steer':
        events.push(...this.steerAnswered(deliveryId, true));
        break;
      default:
        break;
    }
    return events;
  }

  /**
   * A steer was answered — `accepted` by codex, or refused. An accepted one is
   * owed its `userMessage` item unless that already came. The held ending goes
   * out once no steer is left unanswered.
   */
  private steerAnswered(
    deliveryId: string | null,
    accepted: boolean,
  ): AgentEvent[] {
    const index = this.steersOut.findIndex(
      (steer) => steer.deliveryId === deliveryId,
    );
    const [steer] = this.steersOut.splice(index === -1 ? 0 : index, 1);
    if (accepted && steer !== undefined) {
      const seen = this.userMessagesSeen.indexOf(steer.text);
      if (seen === -1) {
        this.steersAccepted.push(steer);
      } else {
        this.userMessagesSeen.splice(seen, 1);
      }
    }
    return this.steersOut.length === 0 ? this.releaseEnding() : [];
  }

  /** codex showed a user message taken into the turn: a steer it matches landed. */
  private noteUserMessage(text: string): void {
    const index = this.steersAccepted.findIndex((steer) => steer.text === text);
    if (index === -1) {
      this.userMessagesSeen.push(text);
    } else {
      this.steersAccepted.splice(index, 1);
    }
  }

  /**
   * The steers in `lists` this turn will never deliver, emptied into one
   * `follow_up_dropped` said ahead of whatever ends the turn.
   */
  private dropSteers(lists: PendingSteer[][]): AgentEvent[] {
    const dropped = lists
      .flatMap((list) => list.splice(0))
      .flatMap((steer) =>
        steer.deliveryId === null ? [] : [steer.deliveryId],
      );
    return dropped.length === 0
      ? []
      : [{ type: 'follow_up_dropped', deliveryIds: dropped }];
  }

  /**
   * The process ended under this turn: every steer codex never answered, and
   * every one it accepted but never took, died with it. Its ending — held for
   * those answers — will never be released: the session's process-end path
   * writes the terminal instead.
   */
  onProcessEnded(): AgentEvent[] {
    this.heldEnding = null;
    this.endingReleased = true;
    return this.dropSteers([this.steersOut, this.steersAccepted]);
  }

  /**
   * How long a session closed under this turn should let it finish first: a
   * Stop's interrupt is on its way, and while a steer's fate is unknown the
   * only honest answer about it is the one codex gives on finishing
   * ({@link CODEX_STOP_CLOSE_GRACE_MS}). Zero when there is nothing to learn.
   */
  closeGraceMs(): number {
    return !this.settled &&
      this.steersOut.length + this.steersAccepted.length > 0
      ? CODEX_STOP_CLOSE_GRACE_MS
      : 0;
  }

  /**
   * The held ending, once — `[]` when nothing is held, or when another turn has
   * opened since: its stream is no longer this turn's to end.
   */
  private releaseEnding(): AgentEvent[] {
    const ending = this.heldEnding;
    if (ending === null) {
      return [];
    }
    this.heldEnding = null;
    this.endingReleased = true;
    if (!this.session.isCurrentTurn(this)) {
      return [];
    }
    // A steer accepted while the stopped turn's ending was held can no longer
    // be taken: the turn is over.
    return this.endedUnfinished
      ? [...this.dropSteers([this.steersAccepted]), ...ending]
      : ending;
  }

  /**
   * A Stop while the ending is held: the turn has finished, so there is
   * nothing to interrupt — its ending goes out now, which settles the turn, and
   * the caller is told nothing is left to stop.
   */
  withdrawHeldPrompt(): boolean {
    const ending = this.releaseEnding();
    if (ending.length === 0) {
      return false;
    }
    this.session.emitNow(ending);
    return true;
  }

  onErrorReply(
    kind: CodexPendingKind,
    message: string,
    detail: string | null = null,
    deliveryId: string | null = null,
  ): AgentEvent[] {
    switch (kind) {
      case 'config_read': {
        // The conversation still opens — without the switches, said out loud
        // rather than run on a surface nobody chose.
        this.mcpOverrides = {};
        const events: AgentEvent[] = [
          {
            type: 'notice',
            message: `codex could not read its own config (${message}), so the MCP servers switched off for this member stay on for this turn.`,
          },
        ];
        this.openThread(events);
        return events;
      }
      case 'hooks_list': {
        this.hookOverrides = {};
        const events: AgentEvent[] = [
          {
            type: 'notice',
            message: `codex could not list its hooks (${message}), so your own PermissionRequest hooks stay on in this conversation and run before each approval it asks for.`,
          },
        ];
        this.openThread(events);
        return events;
      }
      case 'thread_resume': {
        if (message.includes(CODEX_ACTIVE_WRITER_MARKER)) {
          // A process geniro itself just replaced may take a moment to let go
          // of the thread, so the resume is asked again before anything fails.
          if (this.writerRetries < CODEX_ACTIVE_WRITER_RETRIES) {
            this.writerRetries += 1;
            this.session.schedule(this, CODEX_ACTIVE_WRITER_RETRY_MS, (later) =>
              this.openThread(later),
            );
            return [];
          }
          // The conversation is intact and merely open somewhere else. A fresh
          // thread here would replace the run's session id for good — every
          // later turn would resume the copy — so the turn fails instead, and
          // sending again once that process has gone reopens the real one.
          this.settled = true;
          return [
            {
              type: 'error',
              message: `codex could not open this conversation: another codex process has it open — for example \`codex resume\` in a terminal (${message}). Close that one, then send the message again.`,
            },
          ];
        }
        // Keep the saved thread id so a retry can reopen it. Starting a new
        // thread here would replace the conversation and discard its context.
        this.settled = true;
        return [
          {
            type: 'error',
            message: `codex could not reopen this conversation: ${message}`,
          },
        ];
      }
      case 'turn_steer': {
        // The message's row was written when the steer went out, so a
        // refusal inside its turn is the message dropped: its row is marked
        // not sent. A steer with no row, or a refusal after the turn's ending
        // went out, says so in words, quoting the message.
        const events: AgentEvent[] =
          deliveryId !== null && !this.endingReleased
            ? [
                {
                  type: 'follow_up_dropped',
                  deliveryIds: [deliveryId],
                  reason: message,
                },
              ]
            : [
                {
                  type: 'notice',
                  message: `codex did not take your message${detail ? ` "${detail}"` : ''} into the turn it was sent during (${message}) — send it again.`,
                },
              ];
        this.session.log(`codex: turn/steer was refused (${message})`);
        return [...events, ...this.steerAnswered(deliveryId, false)];
      }
      case 'turn_interrupt':
        this.session.log(`codex: turn/interrupt was refused: ${message}`);
        return [];
      case 'terminals_list': {
        const commands = [...this.stoppedCommands.values()];
        this.stoppedCommands.clear();
        return this.stillRunningNotices(
          commands,
          `codex refused to list its running commands (${message})`,
        );
      }
      case 'terminal_terminate':
        return this.stillRunningNotices(
          detail === null ? [] : [detail],
          `codex refused to end it (${message})`,
        );
      default:
        // A failed handshake fails every frame pipelined behind it; the first
        // failure is the turn's, the rest would only repeat it.
        if (this.settled) {
          return [];
        }
        this.settled = true;
        return [
          {
            type: 'error',
            message: `codex: ${this.describe(kind)} failed: ${message}`,
          },
        ];
    }
  }

  /** What `thread/start` and `thread/resume` both carry about this turn. */
  private threadParams(): Record<string, unknown> {
    const { policy, config, developerInstructions } = this.options;
    // Each source sets keys of its own (dotted, or one `hooks.state` table),
    // so they merge without either replacing a table of another's.
    const merged = {
      ...(config ?? {}),
      ...(this.mcpOverrides ?? {}),
      ...(this.hookOverrides ?? {}),
    };
    return {
      cwd: this.input.cwd,
      ...(this.input.model
        ? { model: ollamaModelName(this.input.model) ?? this.input.model }
        : {}),
      ...(ollamaModelName(this.input.model)
        ? { modelProvider: CODEX_OLLAMA_PROVIDER }
        : {}),
      approvalPolicy: policy.approvalPolicy,
      sandbox: policy.sandbox,
      ...(Object.keys(merged).length > 0 ? { config: merged } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };
  }

  private describe(kind: CodexPendingKind): string {
    switch (kind) {
      case 'initialize':
        return 'the handshake';
      case 'config_read':
        return 'reading its config';
      case 'hooks_list':
        return 'listing its hooks';
      case 'thread_start':
        return 'starting the conversation';
      case 'thread_resume':
        return 'reopening the conversation';
      case 'turn_start':
        return 'starting the turn';
      case 'compact':
        return 'compacting the conversation';
      case 'turn_steer':
        return 'adding the message to the turn';
      case 'turn_interrupt':
        return 'stopping the turn';
      case 'terminals_list':
        return 'listing its running commands';
      case 'terminal_terminate':
        return 'ending a stopped command';
    }
  }

  // ── Server requests ───────────────────────────────────────────────────────

  onServerRequest(
    id: JsonRpcId,
    method: string,
    params: unknown,
  ): AgentEvent[] {
    const card = codexApprovalCard(method, params, this.session.items);
    if (card === null) {
      if (method === CODEX_SERVER_REQUESTS.mcpElicitation) {
        // An MCP server asking the user for input (a form, or a URL to open)
        // — a tool-call APPROVAL got its card above. Declined in-protocol
        // rather than left to hang: codex then reports the tool call as
        // failed and the agent carries on.
        this.session.reply(id, {
          action: 'decline',
          content: null,
          _meta: null,
        });
        return [
          {
            type: 'notice',
            message:
              'An MCP server asked for input geniro cannot show yet, so the request was declined.',
          },
        ];
      }
      this.session.write(
        encodeError(
          id,
          JSONRPC_METHOD_NOT_FOUND,
          `geniro does not handle ${method}`,
        ),
      );
      return [];
    }
    if (
      method === CODEX_SERVER_REQUESTS.fileChangeApproval &&
      this.options.policy.autoAcceptFileChanges &&
      fileChangeStaysIn(params, this.session.items, this.input.cwd)
    ) {
      this.session.reply(id, encodeCodexReply(method, params, true, params));
      return [];
    }
    const encodedId = encodeRequestId(id);
    this.session.parked.set(encodedId, { method, params });
    // A late command waiting on its card is not running yet.
    this.session.stopLateWindow(asString(asRecord(params)?.itemId) ?? '');
    return [
      {
        type: 'approval_request',
        id: encodedId,
        toolName: card.toolName,
        input: card.input,
        ...(card.question ? { requiresUserInteraction: true } : {}),
        ...(card.questions && card.questions.length > 0
          ? { questions: card.questions }
          : {}),
        ...(card.options && card.options.length > 0
          ? { options: card.options }
          : {}),
      },
    ];
  }

  /**
   * The reply for a verdict on a parked request, or undefined when nothing
   * here is parked under that id — a request the user answered twice, or one
   * this session never raised.
   */
  buildApprovalResponse(
    encodedId: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string | undefined {
    const parked = this.session.parked.get(encodedId);
    const id = decodeRequestId(encodedId);
    if (parked === undefined || id === null) {
      return undefined;
    }
    this.session.parked.delete(encodedId);
    const itemId = asString(asRecord(parked.params)?.itemId) ?? '';
    if (allow && this.session.lateToolItems.has(itemId)) {
      this.session.startLateWindow(itemId);
    }
    return encodeResult(
      id,
      encodeCodexReply(
        parked.method,
        parked.params,
        allow,
        updatedInput,
        option,
      ),
    );
  }

  // ── Mid-turn ──────────────────────────────────────────────────────────────

  /**
   * Hand the running turn another user message — `turn/steer`, which JOINS
   * the turn rather than replacing its prompt: codex folds the input in at its
   * next step and answers it before the turn completes.
   *
   * False until the turn's id is known, since the frame must name it; the
   * caller then keeps the message queued, which is always safe.
   */
  sendFollowUp(message: FollowUpMessage): boolean {
    const threadId = this.session.threadId;
    if (threadId === null || this.turnId === null || this.settled) {
      return false;
    }
    const sent = this.session.request(
      CODEX_METHODS.turnSteer,
      {
        threadId,
        input: codexUserInput(message.text, message.images),
        expectedTurnId: this.turnId,
      },
      'turn_steer',
      [],
      firstLine(message.text, CODEX_STEER_PREVIEW_MAX_CHARS),
      this,
      message.deliveryId ?? null,
    );
    if (sent) {
      this.steersOut.push({
        deliveryId: message.deliveryId ?? null,
        text: message.text,
      });
    }
    return sent;
  }

  /**
   * `turn/interrupt` for the running turn, or undefined before codex has named
   * it — the caller then falls back to ending the process group.
   */
  buildInterruptPayload(): string | undefined {
    const threadId = this.session.threadId;
    if (threadId === null || this.turnId === null || this.settled) {
      return undefined;
    }
    return this.session.frame(
      CODEX_METHODS.turnInterrupt,
      { threadId, turnId: this.turnId },
      'turn_interrupt',
    );
  }

  // ── Notifications ─────────────────────────────────────────────────────────

  onNotification(method: string, params: unknown): AgentEvent[] {
    const record = asRecord(params) ?? {};
    const threadId = asString(record.threadId);
    if (threadId !== null && threadId !== this.session.threadId) {
      // Any other thread on this connection is one this conversation started
      // — a sub-agent, or a sub-agent's own — so what it spends is this
      // conversation's spend, whether or not its launch was seen.
      if (method === CODEX_NOTIFICATIONS.tokenUsageUpdated) {
        return this.onSubagentUsage(threadId, readTokenUsage(record));
      }
      return this.onSubagentNotification(threadId, method, record);
    }
    const turnId = asString(record.turnId);
    if (
      turnId !== null &&
      this.session.endedTurns.has(turnId) &&
      ENDED_TURN_FENCED.has(method)
    ) {
      return this.onEndedTurnNotification(method, record);
    }
    switch (method) {
      case CODEX_NOTIFICATIONS.threadStarted: {
        // A sub-agent's thread announces itself with the model it runs on,
        // which is what its spend is priced at.
        const thread = asRecord(record.thread);
        const id = asString(thread?.id);
        const model = asString(thread?.model);
        if (id !== null && id !== this.session.threadId && model) {
          this.session.subagentSpend.noteModel(id, model);
        }
        return [];
      }
      case CODEX_NOTIFICATIONS.turnStarted: {
        const turn = asRecord(record.turn);
        const id = asString(turn?.id);
        if (id !== null && this.turnId === null) {
          this.turnId = id;
        }
        return this.onReportedModel(asString(turn?.model));
      }
      case CODEX_NOTIFICATIONS.agentMessageDelta: {
        const delta = asString(record.delta);
        return delta
          ? [...this.endWaitGap(), { type: 'text_delta', text: delta }]
          : [];
      }
      case CODEX_NOTIFICATIONS.reasoningSummaryDelta: {
        const delta = asString(record.delta);
        return delta
          ? [
              {
                type: 'reasoning_delta',
                text: this.summaryPartBreak(record) + delta,
              },
            ]
          : [];
      }
      case CODEX_NOTIFICATIONS.reasoningTextDelta: {
        const delta = asString(record.delta);
        return delta ? [{ type: 'reasoning_delta', text: delta }] : [];
      }
      case CODEX_NOTIFICATIONS.itemStarted:
        return this.onItemStarted(readCodexItem(record.item));
      case CODEX_NOTIFICATIONS.itemCompleted:
        return this.onItemCompleted(readCodexItem(record.item));
      case CODEX_NOTIFICATIONS.planUpdated:
        return this.onPlanUpdated(record);
      case CODEX_NOTIFICATIONS.tokenUsageUpdated:
        return [
          ...this.onReportedModel(
            asString(record.model) ??
              asString(asRecord(record.tokenUsage)?.model),
          ),
          ...this.onTokenUsage(readTokenUsage(record)),
        ];
      case CODEX_NOTIFICATIONS.error:
        return this.onError(record);
      case CODEX_NOTIFICATIONS.modelRerouted:
        return this.onModelRerouted(record);
      case CODEX_NOTIFICATIONS.turnCompleted:
        return this.onTurnCompleted(asRecord(record.turn));
      default:
        return [];
    }
  }

  /** codex streams a reasoning item's summary parts with no separator. */
  private summaryPartBreak(record: Readonly<Record<string, unknown>>): string {
    const itemId = asString(record.itemId);
    const index = asNumber(record.summaryIndex) ?? 0;
    const previous = this.summaryPart;
    this.summaryPart = { itemId, index };
    return previous !== null &&
      previous.itemId === itemId &&
      previous.index !== index
      ? '\n\n'
      : '';
  }

  private onItemStarted(item: CodexItem | null): AgentEvent[] {
    if (item === null) {
      return [];
    }
    this.session.items.set(item.id, item);
    // The agent took a message or is writing its reply: it is busy, not
    // between two waits.
    const released =
      item.type === 'userMessage' || item.type === 'agentMessage'
        ? this.endWaitGap()
        : [];
    if (item.type === 'userMessage') {
      this.noteUserMessage(userMessageText(item.record));
    }
    if (item.type === 'contextCompaction') {
      this.compactingFrom = this.session.lastUsage?.last.totalTokens ?? null;
      return [
        {
          type: 'context_compacted',
          phase: 'started',
          trigger: this.compacts ? 'manual' : 'auto',
          preTokens: this.compactingFrom,
          postTokens: null,
        },
      ];
    }
    const events = [...released, ...itemStartedEvents(item)];
    // Not a delegate launch (either shape): its delegate's block is keyed by
    // this call, an `isError` close outranks every later ending the renderer
    // reads for it, and the real ending arrives through sub-agent tracking.
    if (!spawnsSubagent(item) && subAgentActivityOf(item)?.kind !== 'started') {
      for (const event of events) {
        if (event.type === 'tool_call') {
          this.openToolItems.set(event.id, event.name);
          if (this.settled) {
            this.session.lateToolItems.add(event.id);
            if (
              item.type === 'commandExecution' &&
              !this.awaitsVerdict(item.id)
            ) {
              this.session.startLateWindow(item.id);
            }
          }
        }
      }
    }
    events.push(...this.trackSubAgentActivity(item));
    events.push(...this.startCommandUnit(item, null));
    if (spawnsSubagent(item)) {
      const prompt = asString(item.record.prompt);
      events.push(
        subagentState(item.id, {
          label: prompt
            ? firstLine(prompt, CODEX_DELEGATE_LABEL_MAX_CHARS)
            : null,
          prompt,
          model: asString(item.record.model),
        }),
      );
    }
    events.push(...this.beginSubagentWait(item));
    return events;
  }

  /** A `wait` on sub-agents opened: the turn is held, if it was not yet. */
  private beginSubagentWait(item: CodexItem): AgentEvent[] {
    if (!waitsOnSubagents(item)) {
      return [];
    }
    this.openWaits.add(item.id);
    this.waitGap = null;
    const open = Math.max(1, receiverThreadsOf(item).length);
    if (this.waitHeld && open === this.waitHeldFor) {
      return [];
    }
    this.waitHeld = true;
    this.waitHeldFor = open;
    return [{ type: 'turn_held', open }];
  }

  /** A `wait` returned: the hold ends after the gap, unless voided first. */
  private endSubagentWait(item: CodexItem): void {
    if (
      !this.openWaits.delete(item.id) ||
      this.openWaits.size > 0 ||
      !this.waitHeld
    ) {
      return;
    }
    const gap = Symbol('wait-gap');
    this.waitGap = gap;
    this.session.schedule(this, CODEX_WAIT_GAP_GRACE_MS, (events) => {
      if (this.waitGap === gap && !this.settled) {
        events.push(...this.releaseWaitHold());
      }
    });
  }

  /** End the hold now if it stands only for the gap after a wait. */
  private endWaitGap(): AgentEvent[] {
    return this.waitGap !== null && this.openWaits.size === 0
      ? this.releaseWaitHold()
      : [];
  }

  /** End the hold {@link beginSubagentWait} announced, if it stands. */
  private releaseWaitHold(): AgentEvent[] {
    this.waitGap = null;
    if (!this.waitHeld) {
      return [];
    }
    this.waitHeld = false;
    this.waitHeldFor = 0;
    return [{ type: 'turn_held', open: 0 }];
  }

  private onItemCompleted(item: CodexItem | null): AgentEvent[] {
    if (item === null) {
      return [];
    }
    this.session.items.delete(item.id);
    this.openToolItems.delete(item.id);
    if (item.type === 'contextCompaction') {
      const after = this.session.lastUsage?.last.totalTokens ?? null;
      return [
        {
          type: 'context_compacted',
          phase: 'finished',
          trigger: this.compacts ? 'manual' : 'auto',
          preTokens: this.compactingFrom,
          postTokens: after,
        },
      ];
    }
    if (item.type === 'agentMessage') {
      const text = asString(item.record.text);
      if (text) {
        this.finalText = text;
      }
    }
    const events = this.markLateWorkEnd(
      item.id,
      this.endCommandUnit(item.id, itemCompletedEvents(item)),
    );
    if (item.type === 'collabAgentToolCall') {
      events.push(...this.trackSubagents(item));
    }
    this.endSubagentWait(item);
    return events;
  }

  /** Whether a request about this item is parked, waiting on its card. */
  private awaitsVerdict(itemId: string): boolean {
    for (const { params } of this.session.parked.values()) {
      if (asString(asRecord(params)?.itemId) === itemId) {
        return true;
      }
    }
    return false;
  }

  /** After the last late tool call's result, the end of late work. */
  private markLateWorkEnd(id: string, events: AgentEvent[]): AgentEvent[] {
    this.session.stopLateWindow(id);
    const late = this.session.lateToolItems;
    if (!late.delete(id) || late.size > 0) {
      return events;
    }
    return [...events, { type: 'late_work_ended' }];
  }

  /**
   * A notification about a turn codex has already ended — a stopped turn's
   * command finishing late, most often. Nothing of it reaches the turn now
   * open; what stays is the session's own bookkeeping: the item map an
   * approval card reads, sub-agent tracking, since a sub-agent belongs to the
   * conversation rather than to any one turn, and a command's end
   * ({@link endCommandUnit}).
   */
  private onEndedTurnNotification(
    method: string,
    record: Record<string, unknown>,
  ): AgentEvent[] {
    const item = readCodexItem(record.item);
    if (item === null) {
      return [];
    }
    if (method === CODEX_NOTIFICATIONS.itemStarted) {
      this.session.items.set(item.id, item);
      return this.trackSubAgentActivity(item);
    }
    if (method === CODEX_NOTIFICATIONS.itemCompleted) {
      this.session.items.delete(item.id);
      // A command the turn left running keeps its call open for this result;
      // any other call of the turn was closed with it.
      return [
        ...(item.type === 'collabAgentToolCall'
          ? this.trackSubagents(item)
          : []),
        ...this.endCommandUnit(
          item.id,
          this.session.leftRunning.has(item.id)
            ? itemCompletedEvents(item)
            : [],
        ),
      ];
    }
    return [];
  }

  /**
   * A command codex runs, reported from its start as work the agent is
   * waiting on, so `spawn-cli` records where it runs while the CLI lives. One
   * codex holds in its process store — its item carries the store's
   * `processId`, what `terminate` names it by — may outlive its turn and then
   * becomes background work ({@link backgroundLeftRunning}); a one-shot one
   * ends with its turn ({@link settleOneShots}). A sub-agent's is its
   * delegate's own: recorded, and never a shell row.
   */
  private startCommandUnit(
    item: CodexItem,
    subagentThread: string | null,
  ): AgentEvent[] {
    if (item.type !== 'commandExecution') {
      return [];
    }
    this.session.commandUnits.set(item.id, subagentThread);
    return [
      {
        type: 'background_work',
        id: item.id,
        phase: 'started',
        unit: 'other',
        toolCallId: item.id,
        foreground: true,
        ...(subagentThread === null ? {} : { ownedByDelegate: true as const }),
      },
    ];
  }

  /** Whether codex holds this command in its process store. */
  private heldInStore(id: string): boolean {
    return (
      (asString(this.session.items.get(id)?.record.processId) ?? '') !== ''
    );
  }

  /**
   * The turn ended with these commands still running, and codex runs them
   * on: moved to the background, each is counted and listed as a shell. Their
   * calls stay open for the result codex reports when they end, so a failed
   * turn closes only the rest.
   */
  private backgroundLeftRunning(): AgentEvent[] {
    const moved: AgentEvent[] = [];
    for (const id of [...this.openToolItems.keys()]) {
      if (!this.session.commandUnits.has(id) || !this.heldInStore(id)) {
        continue;
      }
      this.openToolItems.delete(id);
      moved.push(this.session.moveToBackground(id));
    }
    return moved;
  }

  /**
   * A one-shot command still open as its turn is stopped or fails goes with
   * it: codex holds it in no process store, and a Stop kills it with the turn.
   */
  private settleOneShots(): AgentEvent[] {
    const settled: AgentEvent[] = [];
    for (const id of this.openToolItems.keys()) {
      if (this.session.commandUnits.has(id) && !this.heldInStore(id)) {
        this.session.commandUnits.delete(id);
        settled.push(unitPhase(id, 'settled'));
      }
    }
    return settled;
  }

  /**
   * A command's end, once codex completes its item: the unit's settle after
   * the item's own completion `events` — the result of one its turn left
   * running marked as that end, since it often lands with no turn open.
   */
  private endCommandUnit(id: string, events: AgentEvent[]): AgentEvent[] {
    if (!this.session.commandUnits.delete(id)) {
      return events;
    }
    const left = this.session.leftRunning.delete(id);
    return [
      ...events.map((event) =>
        left && event.type === 'tool_result'
          ? { ...event, endsBackgroundWork: true as const }
          : event,
      ),
      unitPhase(id, 'settled'),
    ];
  }

  /**
   * What a collab call says about the sub-agents it concerns: a spawn names
   * the threads it opened, and every collab call reports which of them have
   * finished.
   */
  private trackSubagents(item: CodexItem): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (spawnsSubagent(item)) {
      for (const threadId of receiverThreadsOf(item)) {
        this.session.subagents.set(threadId, item.id);
      }
      if (receiverThreadsOf(item).length > 0) {
        this.session.openSubagent(item.id);
        events.push(
          subagentState(item.id, {
            open: true,
            childSessionId:
              receiverThreadsOf(item).length === 1
                ? receiverThreadsOf(item)[0]
                : undefined,
          }),
        );
        events.push(...this.session.delegateProgressOf(item.id));
      }
    }
    for (const { threadId, outcome } of finishedAgentsOf(item)) {
      events.push(...this.session.closeSubagent(threadId, outcome));
    }
    return events;
  }

  /**
   * What a `subAgentActivity` says: a launch opens the delegate — in the
   * background, since the parent's turn goes on (and may end) without it — and
   * any later activity naming an ending closes it. Read at the item's START,
   * the only moment it is reported: codex completes these items in the same
   * millisecond.
   */
  private trackSubAgentActivity(item: CodexItem): AgentEvent[] {
    const activity = subAgentActivityOf(item);
    if (activity === null) {
      return [];
    }
    if (activity.kind === 'started') {
      this.session.subagents.set(activity.threadId, item.id);
      this.session.openSubagent(item.id);
      return [
        subagentState(item.id, {
          open: true,
          label: activity.name,
          childSessionId: activity.threadId,
        }),
        ...this.session.delegateProgressOf(item.id),
      ];
    }
    const outcome = subagentOutcomeOf(activity.kind);
    return outcome === null
      ? []
      : this.session.closeSubagent(activity.threadId, outcome);
  }

  /**
   * A notification about a thread that is not this conversation's own — one of
   * its sub-agents. Their items nest under the spawning call; their turn ending
   * closes the delegate. Everything else about them (deltas, their own token
   * counts) is left out: it is not the conversation the user is reading.
   */
  private onSubagentNotification(
    threadId: string,
    method: string,
    record: Record<string, unknown>,
  ): AgentEvent[] {
    const parent = this.session.subagents.get(threadId);
    if (parent === undefined) {
      return [];
    }
    const origin = { parentToolUseId: parent };
    switch (method) {
      case CODEX_NOTIFICATIONS.itemStarted: {
        const item = readCodexItem(record.item);
        if (item === null) {
          return [];
        }
        this.session.items.set(item.id, item);
        return [
          ...itemStartedEvents(item).map((event) => ({ ...event, ...origin })),
          ...this.startCommandUnit(item, threadId),
        ];
      }
      case CODEX_NOTIFICATIONS.itemCompleted: {
        const item = readCodexItem(record.item);
        if (item === null) {
          return [];
        }
        this.session.items.delete(item.id);
        return this.endCommandUnit(
          item.id,
          itemCompletedEvents(item).map((event) => ({ ...event, ...origin })),
        );
      }
      case CODEX_NOTIFICATIONS.turnCompleted: {
        // What the sub-agent's turn left in codex's process store runs on,
        // whatever ended it — no Stop of geniro's reaches a sub-agent's
        // commands — and is background work from here; a one-shot one ended.
        const left: AgentEvent[] = [];
        for (const [id, owner] of this.session.commandUnits) {
          if (owner !== threadId) {
            continue;
          }
          if (this.heldInStore(id)) {
            left.push(this.session.moveToBackground(id));
          } else {
            this.session.commandUnits.delete(id);
            left.push(unitPhase(id, 'settled'));
          }
        }
        const status = asString(asRecord(record.turn)?.status);
        return [
          ...left,
          ...this.session.closeSubagent(
            threadId,
            subagentOutcomeOf(status) ?? 'untracked',
          ),
        ];
      }
      default:
        return [];
    }
  }

  private onPlanUpdated(record: Record<string, unknown>): AgentEvent[] {
    const tasks: AgentTask[] = asArray(record.plan).flatMap((entry, index) => {
      const step = asRecord(entry);
      const title = step ? asString(step.step) : null;
      if (!title) {
        return [];
      }
      return [
        {
          id: String(index + 1),
          title,
          status: PLAN_STATUS[asString(step?.status) ?? ''] ?? null,
          activeForm: null,
        },
      ];
    });
    // codex re-sends its whole plan every time it changes one step, so each
    // update is a snapshot, never a patch.
    return tasks.length > 0
      ? [{ type: 'task_list', mode: 'snapshot', tasks, toolCallId: null }]
      : [];
  }

  /**
   * One reading of this conversation's own thread: the window's size (a
   * LEVEL), what the requests since the last reading spent (an INCREMENT, the
   * live twin of the turn's own usage), and the turn's running cost.
   */
  private onTokenUsage(usage: CodexTokenUsage | null): AgentEvent[] {
    if (usage === null) {
      return [];
    }
    if (this.baseline === null) {
      this.baseline = baselineOf(usage);
    }
    const previous = this.previousTotal ?? this.baseline;
    this.previousTotal = usage.total;
    this.session.lastUsage = usage;
    this.session.noteFacts({ usage });
    const events: AgentEvent[] = [];
    const context = usage.last.totalTokens;
    if (context > 0) {
      events.push({
        type: 'context_progress',
        contextTokens: context,
        contextWindowTokens: usage.modelContextWindow,
        contextModel:
          usage.modelContextWindow !== null ? this.session.threadModel : null,
      });
    }
    events.push(...this.spendEvents(spendBetween(usage, previous, null)));
    return events;
  }

  /**
   * One reading of a SUB-AGENT's thread. Its spend is held on the session and
   * folded into the next ending of a turn of this conversation; meanwhile it
   * rides the live plane like the parent's own, and once codex has mapped its
   * thread to a delegate, the delegate's card states the figures.
   */
  private onSubagentUsage(
    threadId: string,
    usage: CodexTokenUsage | null,
  ): AgentEvent[] {
    if (usage === null) {
      return [];
    }
    const { previous } = this.session.subagentSpend.record(threadId, usage);
    const parent = this.session.subagents.get(threadId);
    return [
      ...this.spendEvents(spendBetween(usage, previous, null)),
      ...(parent === undefined ? [] : this.session.delegateProgressOf(parent)),
    ];
  }

  /**
   * The live plane's two spend events for what just landed: the tokens it
   * added, and the running cost of everything not yet on a durable row — this
   * turn's own requests (until it settles) plus every sub-agent's unbilled
   * spend. The cost is a LEVEL the consumer replaces; it is published only
   * when it can be priced.
   */
  private spendEvents(added: CodexSpend): AgentEvent[] {
    const events: AgentEvent[] = [];
    if (
      added.inputTokens > 0 ||
      added.outputTokens > 0 ||
      added.cachedInputTokens > 0 ||
      added.cacheWriteInputTokens > 0
    ) {
      events.push({
        type: 'usage_progress',
        inputTokens: added.inputTokens,
        outputTokens: added.outputTokens,
        cacheReadTokens: added.cachedInputTokens,
        cacheCreationTokens: added.cacheWriteInputTokens,
      });
    }
    const cost = this.runningCost();
    if (cost !== null) {
      if (cost > 0) {
        this.session.liveCostReported = true;
      }
      // List-priced like the turn's own cost, so all of it is an estimate.
      events.push({
        type: 'cost_progress',
        costUsd: cost,
        ...(cost > 0 ? { estimatedCostUsd: cost } : {}),
      });
    }
    return events;
  }

  /** What this turn's own requests have spent so far, or null before any. */
  private ownSpend(): CodexSpend | null {
    const latest = this.session.lastUsage;
    return latest === null || this.baseline === null
      ? null
      : spendBetween(latest, this.baseline, this.turnPrice());
  }

  /** The thread's model at the speed tier this turn runs on. */
  private turnPrice(): ModelPrice | null {
    return priceAtServiceTier(
      this.session.listPriceOf(this.session.threadModel),
      codexServiceTierOf(this.input.modelParameters) ??
        this.session.threadServiceTier,
    );
  }

  /** The sub-agents' spend no turn has recorded yet. */
  private subagentSpend(): CodexSubagentsSpend | null {
    return this.session.subagentSpend.unbilled(
      (model) => this.session.listPriceOf(model),
      this.session.threadModel,
    );
  }

  /** Everything spent and not yet on a row, in dollars — null when unpriceable. */
  private runningCost(): number | null {
    const parts = [this.settled ? null : this.ownSpend(), this.subagentSpend()];
    return (
      sumSpends(parts.filter((part): part is CodexSpend => part !== null))
        ?.costUsd ?? null
    );
  }

  /**
   * This turn's usage for its terminal event — its own requests plus every
   * sub-agent's unbilled spend, which is then marked billed so the next turn
   * does not carry it again. Null when nothing at all was measured, so an
   * ending with no reading carries no usage rather than an empty one.
   */
  private settleUsage(durationMs: number | null): AgentUsage | null {
    const subagents = this.subagentSpend();
    if (this.baseline === null && subagents === null) {
      return null;
    }
    this.session.subagentSpend.markBilled();
    return turnUsageOf({
      latest: this.session.lastUsage,
      baseline: this.baseline,
      model: this.session.threadModel,
      durationMs,
      price: this.turnPrice(),
      subagents,
    });
  }

  /**
   * The zero a turn owes the live plane before its terminal event, when it
   * published a running cost — see `CodexSession.liveCostReported`.
   */
  private retireLiveCost(): AgentEvent[] {
    if (!this.session.liveCostReported) {
      return [];
    }
    this.session.liveCostReported = false;
    return [{ type: 'cost_progress', costUsd: 0 }];
  }

  private onError(record: Record<string, unknown>): AgentEvent[] {
    const message =
      asString(asRecord(record.error)?.message) ?? 'codex reported an error';
    if (record.willRetry === true) {
      return [
        {
          type: 'notice',
          severity: 'warning',
          message: `codex: ${message} — retrying`,
        },
      ];
    }
    this.pendingError = message;
    return [];
  }

  private onModelRerouted(record: Record<string, unknown>): AgentEvent[] {
    const to = asString(record.toModel);
    if (!to) {
      return [];
    }
    const from = this.input.model ?? asString(record.fromModel);
    const reason = asString(record.reason);
    this.session.threadModel = to;
    this.session.noteFacts({ model: to });
    const notices: AgentEvent[] = [];
    if (!this.modelNoticeReported) {
      this.modelNoticeReported = true;
      notices.push({
        type: 'notice',
        severity: 'info',
        message: `codex ran this turn on ${to}${from ? ` instead of ${from}` : ''}${reason ? ` (${reason})` : ''}.`,
      });
    }
    return [...notices, { type: 'turn_model', model: to }];
  }

  private modelMismatchNotice(model: string): AgentEvent[] {
    const requested = this.input.model?.trim();
    // Unresolved aliases and custom providers cannot be compared reliably.
    if (
      this.modelNoticeReported ||
      !requested ||
      !/^(?:gpt-\d|o\d)/.test(requested) ||
      requested.endsWith('-latest') ||
      requested === model
    ) {
      return [];
    }
    this.modelNoticeReported = true;
    return [
      {
        type: 'notice',
        severity: 'info',
        message: CODEX_MODEL_MISMATCH_MESSAGE.replace('%served', model).replace(
          '%requested',
          requested,
        ),
      },
    ];
  }

  private onReportedModel(model: string | null): AgentEvent[] {
    if (!model) {
      return [];
    }
    const changed = this.session.threadModel !== model;
    this.session.threadModel = model;
    this.session.noteFacts({ model });
    return [
      ...this.modelMismatchNotice(model),
      ...(changed ? [{ type: 'turn_model' as const, model }] : []),
    ];
  }

  /**
   * Fence a turn that ended stopped or failed, and close every tool call it
   * left open: their completions, if codex ever sends them, arrive under this
   * turn's id and are fenced off ({@link onEndedTurnNotification}), so without
   * the close a call would read as running for good.
   */
  private endUnfinishedTurn(id: string | null, result: string): AgentEvent[] {
    if (id !== null) {
      this.session.endedTurns.add(id);
    }
    const events: AgentEvent[] = [...this.openToolItems].map(
      ([callId, name]) => ({
        type: 'tool_result',
        id: callId,
        name,
        result,
        isError: true,
      }),
    );
    this.openToolItems.clear();
    return events;
  }

  /** The commands among this turn's open tool calls, by item id → their words. */
  private runningCommands(): Map<string, string> {
    const commands = new Map<string, string>();
    for (const id of this.openToolItems.keys()) {
      const item = this.session.items.get(id);
      if (item?.type === 'commandExecution') {
        commands.set(id, asString(item.record.command) ?? 'a command');
      }
    }
    return commands;
  }

  /**
   * End the commands a Stop left running. codex keeps them alive by design —
   * `turn/interrupt` stops only the model — so a Stop that should stop the
   * work asks codex to end them, matching each by the item id its
   * background-terminal listing carries. Only this turn's own running
   * commands: anything an earlier turn left running (a dev server) stays.
   */
  private endStoppedCommands(commands: Map<string, string>): AgentEvent[] {
    if (commands.size === 0) {
      return [];
    }
    for (const [id, command] of commands) {
      this.stoppedCommands.set(id, command);
    }
    return this.listRunningCommands(null);
  }

  private listRunningCommands(cursor: string | null): AgentEvent[] {
    const threadId = this.session.threadId;
    const sent =
      threadId !== null &&
      this.session.request(
        CODEX_METHODS.backgroundTerminalsList,
        { threadId, ...(cursor === null ? {} : { cursor }) },
        'terminals_list',
        [],
        null,
        this,
      );
    if (sent) {
      return [];
    }
    const commands = [...this.stoppedCommands.values()];
    this.stoppedCommands.clear();
    return this.stillRunningNotices(commands, 'geniro could not ask codex');
  }

  private onTerminalsListed(result: unknown): AgentEvent[] {
    const record = asRecord(result);
    const threadId = this.session.threadId;
    const events: AgentEvent[] = [];
    for (const entry of asArray(record?.data)) {
      const terminal = asRecord(entry);
      const itemId = asString(terminal?.itemId);
      const processId = asString(terminal?.processId);
      if (itemId === null || processId === null || threadId === null) {
        continue;
      }
      const command = this.stoppedCommands.get(itemId);
      if (command === undefined) {
        continue;
      }
      this.stoppedCommands.delete(itemId);
      const sent = this.session.request(
        CODEX_METHODS.backgroundTerminalsTerminate,
        { threadId, processId },
        'terminal_terminate',
        [],
        command,
        this,
      );
      if (!sent) {
        events.push(
          ...this.stillRunningNotices([command], 'geniro could not ask codex'),
        );
      }
    }
    const next = asString(record?.nextCursor);
    if (
      next !== null &&
      this.stoppedCommands.size > 0 &&
      !this.listedCursors.has(next) &&
      this.listedCursors.size < CODEX_TERMINAL_LIST_MAX_PAGES
    ) {
      this.listedCursors.add(next);
      return [...events, ...this.listRunningCommands(next)];
    }
    // Not listed: out of codex's reach — unless it finished by itself in the
    // meantime, which its fenced `item/completed` took out of `session.items`.
    const unlisted = [...this.stoppedCommands]
      .filter(([id]) => this.session.items.has(id))
      .map(([, command]) => command);
    this.stoppedCommands.clear();
    return [
      ...events,
      ...this.stillRunningNotices(unlisted, 'codex did not list it as running'),
    ];
  }

  private stillRunningNotices(
    commands: readonly string[],
    reason: string,
  ): AgentEvent[] {
    return commands.map((command) => ({
      type: 'notice',
      severity: 'warning',
      message: `The Stop did not end \`${firstLine(command, CODEX_STOPPED_COMMAND_PREVIEW_MAX_CHARS)}\` — ${reason}. It may still be running.`,
    }));
  }

  /**
   * The turn's ending — held while a steer is unanswered (see
   * {@link heldEnding}), else at once.
   */
  private onTurnCompleted(turn: Record<string, unknown> | null): AgentEvent[] {
    const ending = this.endingOf(turn);
    if (ending.length === 0 || this.steersOut.length === 0) {
      this.endingReleased = ending.length > 0 || this.endingReleased;
      return ending;
    }
    this.heldEnding = ending;
    this.session.schedule(this, CODEX_STEER_ANSWER_GRACE_MS, (events) => {
      events.push(...this.releaseEnding());
    });
    return [];
  }

  private endingOf(turn: Record<string, unknown> | null): AgentEvent[] {
    const id = asString(turn?.id);
    if (this.settled || (this.turnId !== null && id !== this.turnId)) {
      return [];
    }
    this.settled = true;
    this.openWaits.clear();
    const released = this.releaseWaitHold();
    const modelEvents = this.onReportedModel(asString(turn?.model));
    const status = asString(turn?.status);
    // Every ending carries what the turn spent: a stopped or failed codex turn
    // has done its requests all the same, and its usage — its own and its
    // sub-agents' — is recorded nowhere else (measured: a cancelled turn on
    // chat 00ffe314 had spent $0.48 that no row carried). The live figure is
    // zeroed FIRST, because from the next event on that money is durable.
    const usage = this.settleUsage(asNumber(turn?.durationMs));
    const events = [...released, ...modelEvents, ...this.retireLiveCost()];
    // A command still running at the turn's end runs on: codex ends a turn
    // without waiting on a backgrounded command. A Stop ends this turn's own
    // ({@link endStoppedCommands}); any other ending leaves them running.
    if (status === 'interrupted') {
      const running = this.runningCommands();
      events.push(...this.settleOneShots());
      events.push(...this.endUnfinishedTurn(id, CODEX_STOPPED_TOOL_RESULT));
      events.push(...this.endStoppedCommands(running));
    } else {
      events.push(...this.backgroundLeftRunning());
      if (status === 'failed') {
        events.push(...this.settleOneShots());
        events.push(...this.endUnfinishedTurn(id, CODEX_FAILED_TOOL_RESULT));
      } else {
        // A one-shot still open (waiting on its card, or held by a hook of
        // the user's) runs on as late work: its unit ends with its result,
        // or goes to the background at the window's end.
        for (const open of this.openToolItems.keys()) {
          this.session.lateToolItems.add(open);
          if (
            this.session.items.get(open)?.type === 'commandExecution' &&
            !this.awaitsVerdict(open)
          ) {
            this.session.startLateWindow(open);
          }
        }
      }
    }
    // A stopped or failed turn takes no more input: a steer codex accepted and
    // never took is gone, said ahead of the terminal. One still unanswered is
    // the held ending's business ({@link releaseEnding}).
    if (status === 'interrupted' || status === 'failed') {
      this.endedUnfinished = true;
      events.push(...this.dropSteers([this.steersAccepted]));
    }
    if (status === 'interrupted') {
      events.push({
        type: 'turn_cancelled',
        ...(usage === null ? {} : { usage }),
      });
      return events;
    }
    if (status === 'failed') {
      const message =
        asString(asRecord(turn?.error)?.message) ??
        this.pendingError ??
        'codex: the turn failed';
      events.push({
        type: 'error',
        message,
        ...(usage === null ? {} : { usage }),
      });
      return events;
    }
    events.push({
      type: 'turn_complete',
      usage:
        usage ??
        turnUsageOf({
          latest: this.session.lastUsage,
          baseline: this.baseline,
          model: this.session.threadModel,
          durationMs: asNumber(turn?.durationMs),
          price: this.turnPrice(),
        }),
      stopReason: status ?? 'completed',
      finalText: this.finalText,
    });
    return events;
  }
}
