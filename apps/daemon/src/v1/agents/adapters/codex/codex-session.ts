import { awakeTimeout, type AwakeTimer } from '../../../../utils/sleep-watch';
import type { ModelPrice } from '../../utils/model-prices';
import type { SessionLogger } from '../../utils/spawn-cli';
import type {
  AgentEvent,
  AgentTurnInput,
  ApprovalOption,
  BackgroundUnitOutcome,
  DelegateFigures,
  FollowUpMessage,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  classifyMessage,
  encodeNotification,
  encodeResult,
  type JsonRpcId,
  replyIdOfPrefix,
} from '../utils/json-rpc.utils';
import { PendingRequests } from '../utils/json-rpc-pending.utils';
import {
  CODEX_INITIALIZED_NOTIFICATION,
  CODEX_LATE_COMMAND_BACKGROUND_MS,
  CODEX_METHODS,
} from './codex.const';
import type {
  CodexItem,
  CodexThreadFacts,
  CodexTokenUsage,
} from './codex.types';
import {
  type CodexPendingKind,
  CodexTurnDriver,
  type CodexTurnOptions,
} from './codex-turn.driver';
import { codexInitializeParams } from './utils/codex-handshake.utils';
import { subagentState, unitPhase } from './utils/codex-items.utils';
import { CodexSubagentSpend } from './utils/codex-usage.utils';

/**
 * Ending a stopped turn's commands is asked AFTER that turn ended, often while
 * the next one runs, so its replies — answers and refusals — must still reach
 * the turn that asked.
 */
function outlivesItsTurn(kind: CodexPendingKind): boolean {
  return kind === 'terminals_list' || kind === 'terminal_terminate';
}

/**
 * A refused `turn/steer` also still matters after its turn has ended: it is how
 * the user learns that a message they sent was not taken.
 */
function refusalOutlivesItsTurn(kind: CodexPendingKind): boolean {
  return kind === 'turn_steer' || outlivesItsTurn(kind);
}

/** What a {@link CodexSession} needs from the adapter that built it. */
export interface CodexSessionOptions {
  clientVersion: string;
  /** Everything about one turn, from that turn's own input — never captured. */
  turnOptions: (input: AgentTurnInput) => CodexTurnOptions;
  logger?: SessionLogger;
  /**
   * A model's list price — the adapter's catalog lookup. Absent: no turn is
   * priced, which reads as "cost not measured".
   */
  listPriceOf?: (model: string | null) => ModelPrice | null;
  /**
   * What this conversation's thread has reported about itself, handed to the
   * adapter so its context readout can answer between turns — see
   * `CodexThreadFacts`. Absent: nothing is kept.
   */
  onThreadFacts?: (threadId: string, patch: Partial<CodexThreadFacts>) => void;
}

/**
 * ONE `codex app-server` process and the turns run on it — the `TurnDriver`
 * the codex adapter returns.
 *
 * The SESSION half of the protocol state: the transport, the requests awaiting
 * a reply (`PendingRequests`), the thread every turn runs in, the model it is
 * on, and everything keyed by an id codex mints for the whole thread (items,
 * parked requests, sub-agent threads). A fresh {@link CodexTurnDriver} holds
 * each turn's own state, so nothing of one message leaks into the next.
 */
export class CodexSession implements TurnDriver {
  /**
   * The child's stdin/stdout, re-set on every turn: `spawn-cli` hands a fresh
   * `TurnIo` per turn whose `emit` routes to the turn now open.
   */
  private io: TurnIo | null = null;
  /** The codex thread this conversation is — its session id. */
  threadId: string | null = null;
  /** The model the thread runs on, as codex last stated it. */
  threadModel: string | null = null;
  /** The speed tier the thread runs on, as codex last stated it. */
  threadServiceTier: string | null = null;
  /** The newest token reading — the window's size between turns. */
  lastUsage: CodexTokenUsage | null = null;
  /**
   * What the conversation's sub-agent threads have spent that no turn has
   * recorded yet — process-scoped, because a sub-agent's readings routinely
   * arrive after the turn that launched it has ended.
   */
  readonly subagentSpend = new CodexSubagentSpend();
  /**
   * A non-zero running cost is on the live plane, so a zero is owed ahead of
   * the next terminal event — the moment the same money becomes a durable row,
   * which a reader adding the live figure would otherwise count twice. On the
   * session rather than the turn, since a sub-agent's spend published between
   * turns is folded into whichever turn ends next.
   */
  liveCostReported = false;
  /**
   * Items by id, from their start to their completion — a file-change
   * approval names only its item, and the changes it asks about are on that
   * item's start.
   */
  readonly items = new Map<string, CodexItem>();
  /**
   * The codex turn ids that ended stopped or failed — the turns whose frames
   * may still arrive after them.
   *
   * codex does not end a command on `turn/interrupt`: the command runs on and
   * reports under the stopped turn's id, often after the next turn opened.
   * Notifications go to whichever driver is current, so the next turn would
   * take that report as its own; a frame naming one of these turns does only
   * the session's bookkeeping instead. On the session because the frames
   * outlive the driver they belong to, and keyed by codex's id because they
   * can land before the next turn's own id is known.
   */
  readonly endedTurns = new Set<string>();
  /**
   * Every command codex runs, by item id → the sub-agent thread that runs it
   * (null for this conversation's own), from the item's start until codex
   * completes it — or, for one held in no process store, until its turn (or
   * its sub-agent's turn) ends. Each is reported as a unit of work from its
   * first moment, so `spawn-cli` records where it runs while the CLI lives.
   * On the session: a command outlives the turn that started it.
   */
  readonly commandUnits = new Map<string, string | null>();
  /**
   * Of {@link commandUnits}, the ones codex holds in its process store that
   * were still running when their turn ended — codex ends a turn without
   * waiting on a command it has backgrounded. Their
   * completion, under the old turn's id and usually with no turn open, is
   * that command's end rather than the agent at work again.
   */
  readonly leftRunning = new Set<string>();
  /**
   * Tool calls whose result will land after a COMPLETED turn's ending: those
   * still open when it completed, and those codex starts after it. A completed
   * turn is not fenced like a stopped or failed one ({@link endedTurns}), so
   * such a result arrives as ordinary work on a settled run, and no turn ending
   * follows it: `late_work_ended` is emitted when this set empties instead. On
   * the session: the result reaches whichever driver is current.
   */
  readonly lateToolItems = new Set<string>();
  /** The background window of each late command now running ({@link startLateWindow}). */
  private readonly lateWindows = new Map<string, AwakeTimer>();
  /**
   * Server requests awaiting the user's verdict, by encoded id. Thread-scoped
   * rather than per-turn: a request left unanswered when its turn settles is
   * re-offered to the next turn, and its verdict has to find it there.
   */
  readonly parked = new Map<string, { method: string; params: unknown }>();
  /** A sub-agent's thread → the collab call that spawned it. */
  readonly subagents = new Map<string, string>();
  /** Spawning calls whose delegate this session has announced as running. */
  private readonly openSubagents = new Set<string>();
  private readonly untrackedSubagents = new Set<string>();
  /**
   * The thread is in plan mode, as codex last confirmed it. codex keeps a
   * turn's collaboration mode for the turns after it — across processes too,
   * since it is saved on the thread — so the turn that leaves plan mode has to
   * say so. Moved only by what codex answered ({@link notePlanMode}).
   */
  private inPlanMode = false;

  /** Frames awaiting a reply, and the turn that sent each. */
  private readonly pending = new PendingRequests<
    CodexPendingKind,
    CodexTurnDriver
  >('codex', (message) => this.log(message));
  private turn: CodexTurnDriver;

  constructor(
    private readonly options: CodexSessionOptions,
    firstTurn: AgentTurnInput,
  ) {
    this.turn = new CodexTurnDriver(this, options.turnOptions(firstTurn));
  }

  /** The model's list price, for pricing a turn codex did not price itself. */
  listPriceOf(model: string | null): ModelPrice | null {
    return this.options.listPriceOf?.(model) ?? null;
  }

  /** Hand the adapter a fact about this conversation's thread, once it has one. */
  noteFacts(patch: Partial<CodexThreadFacts>): void {
    if (this.threadId !== null) {
      this.options.onThreadFacts?.(this.threadId, patch);
    }
  }

  /**
   * The FIRST turn's opening: the handshake, then the thread — after the
   * `config/read` and `hooks/list` replies it waits on, when it asks them —
   * then, once the thread's id is back, the prompt. The handshake and the first
   * request go back to back: codex reads one ordered stream.
   */
  onStdinReady(io: TurnIo): void {
    this.io = io;
    const events: AgentEvent[] = [];
    this.request(
      CODEX_METHODS.initialize,
      codexInitializeParams(this.options.clientVersion),
      'initialize',
      events,
    );
    this.write(encodeNotification(CODEX_INITIALIZED_NOTIFICATION, {}));
    this.turn.openThread(events);
    for (const event of events) {
      io.emit(event);
    }
  }

  /**
   * A SECOND (or later) turn on the live thread — `TurnDriver.openTurn`. TOTAL:
   * a throw here would unwind past a turn `spawn-cli` has already registered.
   */
  openTurn(io: TurnIo, input: AgentTurnInput): void {
    this.io = io;
    const events: AgentEvent[] = [];
    try {
      this.turn = new CodexTurnDriver(this, this.options.turnOptions(input));
      this.turn.beginTurn(events);
    } catch (err) {
      events.push({
        type: 'error',
        message: `codex: could not open this turn: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
    }
    for (const event of events) {
      io.emit(event);
    }
  }

  onMessage(obj: unknown): AgentEvent[] {
    const message = classifyMessage(obj);
    switch (message.kind) {
      case 'response': {
        const entry = this.pending.take(message.id, this.turn, outlivesItsTurn);
        return entry === null
          ? []
          : entry.turn.onReply(
              entry.kind,
              message.result,
              entry.detail,
              entry.deliveryId,
            );
      }
      case 'error': {
        const entry = this.pending.take(
          message.id,
          this.turn,
          refusalOutlivesItsTurn,
        );
        return entry === null
          ? []
          : entry.turn.onErrorReply(
              entry.kind,
              message.message,
              entry.detail,
              entry.deliveryId,
            );
      }
      case 'request':
        return this.turn.onServerRequest(
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

  /** A reply too long to read is answered as a refusal, so nothing waits on it. */
  onDroppedLine(prefix: string, length: number): AgentEvent[] {
    const id = replyIdOfPrefix(prefix);
    return id === null
      ? []
      : this.onMessage({
          id,
          error: {
            message: `its reply was ${length} characters, too long to read as one line`,
          },
        });
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

  withdrawHeldPrompt(): boolean {
    return this.turn.withdrawHeldPrompt();
  }

  onProcessEnded(): AgentEvent[] {
    for (const window of this.lateWindows.values()) {
      window.clear();
    }
    this.lateWindows.clear();
    return this.turn.onProcessEnded();
  }

  closeGraceMs(): number {
    return this.turn.closeGraceMs();
  }

  /** Whether `turn` is the one this session is serving now. */
  isCurrentTurn(turn: CodexTurnDriver): boolean {
    return this.turn === turn;
  }

  /**
   * (Re)start a late command's window ({@link CODEX_LATE_COMMAND_BACKGROUND_MS},
   * awake time): a command still running at its end goes to the background like
   * one a turn left running, and stops holding the late work open. Not
   * {@link schedule}, which drops its step once another turn has opened.
   */
  startLateWindow(id: string): void {
    this.stopLateWindow(id);
    this.lateWindows.set(
      id,
      awakeTimeout(() => {
        this.lateWindows.delete(id);
        if (
          this.io?.processAlive?.() === false ||
          !this.commandUnits.has(id) ||
          !this.lateToolItems.delete(id)
        ) {
          return;
        }
        this.emitNow([
          this.moveToBackground(id),
          ...(this.lateToolItems.size === 0
            ? [{ type: 'late_work_ended' as const }]
            : []),
        ]);
      }, CODEX_LATE_COMMAND_BACKGROUND_MS),
    );
  }

  /** A command still running goes to the background ({@link leftRunning}). */
  moveToBackground(id: string): AgentEvent {
    this.leftRunning.add(id);
    return unitPhase(id, 'backgrounded');
  }

  /** Stop a late command's window: it ended, or it is waiting on its card. */
  stopLateWindow(id: string): void {
    this.lateWindows.get(id)?.clear();
    this.lateWindows.delete(id);
  }

  /** Emit to the turn now open, outside any reply — the held ending's release. */
  emitNow(events: readonly AgentEvent[]): void {
    for (const event of events) {
      this.io?.emit(event);
    }
  }

  buildInterruptPayload(): string | undefined {
    return this.turn.buildInterruptPayload();
  }

  /**
   * The collaboration mode a turn must carry, or null when it needs none.
   *
   * Sent only on the way INTO plan mode and on the way back out: a mode on
   * every turn would also send a `default` settings block, and codex lets a
   * collaboration mode's settings take precedence over the thread's own.
   */
  collaborationModeFor(
    plan: boolean,
    model: string | null,
    effort: string | null,
  ): Record<string, unknown> | null {
    if (plan === this.inPlanMode) {
      return null;
    }
    const settingsModel = model ?? this.threadModel;
    if (settingsModel === null) {
      return null;
    }
    return {
      mode: plan ? 'plan' : 'default',
      settings: {
        model: settingsModel,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    };
  }

  /**
   * Record the collaboration mode codex confirmed — a thread's reply naming it,
   * or a `turn/start` that carried a switch and was accepted. A refused switch
   * leaves the thread where it was, so it records nothing.
   */
  notePlanMode(plan: boolean): void {
    this.inPlanMode = plan;
  }

  /**
   * Publish the first known ending, allowing it to replace tracking loss.
   */
  closeSubagent(
    threadId: string,
    outcome: BackgroundUnitOutcome,
  ): AgentEvent[] {
    const parent = this.subagents.get(threadId);
    if (parent === undefined) {
      return [];
    }
    const wasOpen = this.openSubagents.delete(parent);
    const wasUntracked = this.untrackedSubagents.has(parent);
    if (!wasOpen && !wasUntracked) {
      return [];
    }
    if (outcome === 'untracked') {
      this.untrackedSubagents.add(parent);
    } else {
      this.untrackedSubagents.delete(parent);
    }
    const figures = this.delegateFiguresOf(parent);
    if (figures === null) {
      return [subagentState(parent, { open: false, outcome })];
    }
    return [
      { type: 'delegate_progress', delegateId: parent, figures, final: true },
      subagentState(parent, { open: false, outcome, figures }),
    ];
  }

  /** Mark a spawning call's delegate as running, so its ending is owed. */
  openSubagent(spawnItemId: string): void {
    this.openSubagents.add(spawnItemId);
    this.untrackedSubagents.delete(spawnItemId);
  }

  /**
   * The cumulative figures of one delegate: every thread codex mapped to its
   * spawning call, summed. Null until one of them has been read.
   */
  delegateFiguresOf(spawnItemId: string): DelegateFigures | null {
    const threadIds = [...this.subagents]
      .filter(([, parent]) => parent === spawnItemId)
      .map(([threadId]) => threadId);
    return this.subagentSpend.delegateFigures(
      threadIds,
      (model) => this.listPriceOf(model),
      this.threadModel,
    );
  }

  /**
   * A delegate's figures so far, as a live row, while it is open. A reading
   * that lands after its end is not a live figure any more.
   */
  delegateProgressOf(spawnItemId: string): AgentEvent[] {
    if (!this.openSubagents.has(spawnItemId)) {
      return [];
    }
    const figures = this.delegateFiguresOf(spawnItemId);
    return figures === null
      ? []
      : [
          {
            type: 'delegate_progress',
            delegateId: spawnItemId,
            figures,
            final: false,
          },
        ];
  }

  /**
   * Run `step` for `turn` after `ms`, emitting what it produces — unless
   * another turn has opened by then or the process can no longer be written
   * to (stopped, or exited), when nothing is listening for what it would say.
   */
  schedule(
    turn: CodexTurnDriver,
    ms: number,
    step: (events: AgentEvent[]) => void,
  ): void {
    const timer = setTimeout(() => {
      const io = this.io;
      if (this.turn !== turn || io === null || io.writeObstacle?.()) {
        return;
      }
      const events: AgentEvent[] = [];
      step(events);
      for (const event of events) {
        io.emit(event);
      }
    }, ms);
    timer.unref?.();
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /**
   * Send one request, answering whether it actually went out. `detail` is what
   * the turn wants said about the reply. `owner` is the turn the reply goes to:
   * the current one, unless an ended turn is still finishing its own work.
   * `deliveryId` is the message's own, for a `turn/steer` refusal to name.
   */
  request(
    method: string,
    params: unknown,
    kind: CodexPendingKind,
    events: AgentEvent[],
    detail: string | null = null,
    owner: CodexTurnDriver = this.turn,
    deliveryId: string | null = null,
  ): boolean {
    const id = this.pending.send(
      method,
      params,
      kind,
      owner,
      (frame) => this.write(frame),
      detail,
      deliveryId,
    );
    if (id === null) {
      events.push({
        type: 'error',
        message: `codex: failed to send ${method}${this.writeFailure()}`,
      });
      return false;
    }
    return true;
  }

  /**
   * A request frame for the CALLER to write — registered as pending first, so
   * the reply to it is recognised.
   */
  frame(method: string, params: unknown, kind: CodexPendingKind): string {
    return this.pending.frame(method, params, kind, this.turn);
  }

  /** Answer one server request. */
  reply(id: JsonRpcId, result: unknown): void {
    if (this.io?.write(encodeResult(id, result)) !== true) {
      this.log(
        `codex: dropped a reply to request ${String(id)}${this.writeFailure()}`,
      );
    }
  }

  /** Write a frame this class did not build. */
  write(payload: string): boolean {
    return this.io?.write(payload) === true;
  }

  log(message: string): void {
    this.options.logger?.warn(message);
  }

  /** " — <cause>" for a write that did not land, as the writer names it. */
  private writeFailure(): string {
    const obstacle = this.io?.writeObstacle?.() ?? null;
    return obstacle === null ? '' : ` — ${obstacle}`;
  }
}
