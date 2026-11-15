import { asNumber, asRecord } from '../../utils/json-util';
import type {
  AgentEvent,
  ApprovalOption,
  TurnDriver,
  TurnIo,
} from '../adapter.types';
import {
  CLAUDE_CONTROL_REQUEST_ID_PREFIX,
  CLAUDE_LIVE_COST_ASK_INTERVAL_MS,
  CLAUDE_LIVE_COST_REPLY_TIMEOUT_MS,
  CLAUDE_MCP_NOT_READY_MESSAGE,
  CLAUDE_MCP_READINESS_UNCONFIRMED_MESSAGE,
  CLAUDE_MCP_READY_EMPTY_GRACE_MS,
  CLAUDE_MCP_READY_MAX_WAIT_MS,
  CLAUDE_MCP_READY_POLL_MS,
  CLAUDE_MCP_READY_REPLY_TIMEOUT_MS,
  CLAUDE_MCP_READY_SILENCE_MS,
  CLAUDE_MCP_READY_STALL_MS,
  CLAUDE_MCP_RECONNECT_FAILED_MESSAGE,
  CLAUDE_MCP_RECONNECTED_MESSAGE,
} from './claude.const';
import type { ClaudeDelegateSettler } from './utils/claude-delegate-spend.utils';
import {
  type ClaudeMcpStatusRow,
  mcpReadingKey,
  mcpStatusRequestLine,
  pendingMcpServers,
  readHookSignal,
  readMcpStatusReply,
} from './utils/claude-mcp-ready.utils';
import {
  mcpReconnectRequestLine,
  notConnectedMcpServer,
  readMcpReconnectReply,
} from './utils/claude-mcp-reconnect.utils';
import { isClaudeApiErrorLine } from './utils/claude-message.utils';
import { ClaudeModelMismatchNotice } from './utils/claude-model-mismatch.utils';
import {
  readSessionCostReply,
  usageRequestLine,
} from './utils/claude-plan-limits.utils';

/** The one cost question in flight, and what its answer is for. */
interface CostAsk {
  id: string;
  sentAt: number;
  /**
   * `baseline` is asked as a turn opens on a process that has not yet closed
   * one, and only records; `live` is asked while the turn works, and reports.
   */
  purpose: 'baseline' | 'live';
  /** A `live` ask whose turn ended before it was answered — read and dropped. */
  stale: boolean;
}

/** What the driver needs from the adapter, injected so a spec needs no process. */
export interface ClaudeTurnDriverDeps {
  requestedModel?: string | null;
  mapMessage: (obj: unknown) => AgentEvent[];
  buildApprovalResponse: (
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ) => string | undefined;
  /** Sink for the gate's account of itself; silent by default. */
  logger?: { warn(message: string): void; debug?(message: string): void };
  /** Settles each delegate's figures from its own transcript as it ends. */
  delegateSettler?: ClaudeDelegateSettler;
  /** Injected so a spec can run the gate's whole loop in no wall-clock time. */
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}

/** Resolvers for the one poll currently in flight. */
interface OpenPoll {
  id: string;
  settle: (rows: ClaudeMcpStatusRow[] | 'refused' | 'silent') => void;
}

/**
 * Claude's per-turn protocol driver.
 *
 * Line mapping and verdict encoding are the stateless pair every stream-json
 * CLI needs and are delegated straight back to the adapter. What makes this a
 * driver rather than the base's object literal is {@link awaitPromptReady} —
 * a short client-initiated conversation that has to happen BEFORE the turn's
 * prompt is written, and which therefore holds state (the poll in flight) that
 * must not live on the adapter: one adapter instance drives N concurrent turns
 * under team fan-out.
 *
 * The gate's reason for existing, the probe evidence behind it and every
 * number it uses are recorded at `CLAUDE_MCP_STATUS_SUBTYPE` in
 * `claude.const.ts`. In one line: the CLI starts its MCP servers when the
 * process starts and does not wait for them, so a turn that begins three
 * seconds in is handed a tool surface with the slower servers missing — and the
 * model, told once that a tool does not exist, spends the rest of the
 * conversation working around a capability it actually has.
 */
export class ClaudeTurnDriver implements TurnDriver {
  private readonly modelMismatch: ClaudeModelMismatchNotice;
  private polls = 0;
  private openPoll: OpenPoll | null = null;
  /**
   * What the window holds after a compaction that NOTHING has measured since —
   * or null when the freshest reading is a request's own.
   *
   * Per-turn state, which is why it is here and not on the adapter: one adapter
   * instance drives N concurrent turns under team fan-out.
   *
   * It exists because a compaction leaves BOTH readings of the window wrong in
   * the same direction. The live one is the prompt of the last request, which
   * was the whole conversation the compaction has just replaced; the durable one
   * is the `result` line's copy of that same request. So a chat that had just
   * gone from 515k to 12.6k went on reporting 515k in the composer's ring — the
   * defect this reads as, and the one the user reported as "after compact the
   * current context wasn't updated".
   *
   * Cleared by the next {@link AgentEvent} `context_progress`, because that IS a
   * measurement of the window and a later one: an AUTO compaction happens mid
   * turn and every request after it reports the real figure, so only a turn that
   * ENDED on its compaction needs this.
   */
  private compactedTo: number | null = null;
  /**
   * The CLI's own hooks still running, by `hook_id`, and when one last started
   * or finished — read off stdout by {@link onMessage}. The gate times silence
   * only while both are quiet, because a running hook is WHY the CLI is not
   * answering (see `CLAUDE_HOOK_STARTED_SUBTYPE`).
   */
  private readonly runningHooks = new Set<string>();
  private lastHookSignalAt: number | null = null;

  constructor(private readonly deps: ClaudeTurnDriverDeps) {
    this.modelMismatch = new ClaudeModelMismatchNotice(deps.requestedModel);
  }

  /**
   * Held between the child's stdin being wired and the turn's prompt going out.
   *
   * Never rejects and never runs unbounded: every exit below is a release, and
   * the caller writes the prompt the moment this resolves. A gate that could
   * throw or hang would cost the user their message, which is a far worse
   * failure than the one it is fixing.
   */
  async awaitPromptReady(io: TurnIo): Promise<void> {
    this.io = io;
    this.deps.delegateSettler?.attach(io);
    const now = this.deps.now ?? Date.now;
    const startedAt = now();
    const ceiling = startedAt + CLAUDE_MCP_READY_MAX_WAIT_MS;
    let previousKey: string | null = null;
    let sawServers = false;
    let pending: string[] = [];
    // When the CLI first ANSWERED a poll — null until it has. The empty grace
    // counts from here, and "never answered" is what the notice below reports.
    let firstAnswerAt: number | null = null;
    // When the reading last CHANGED. The gate gives up on a STALL rather than
    // on a total elapsed time, so a folder whose servers are visibly still
    // coming up keeps its wait while one that is stuck still releases promptly.
    let lastChangeAt = startedAt;

    while (
      now() < ceiling &&
      now() - lastChangeAt < CLAUDE_MCP_READY_STALL_MS
    ) {
      const reading = await this.poll(io);
      if (reading === 'refused') {
        // This CLI will not answer the question, so there is nothing to wait
        // for. Releasing at once is exactly the behaviour that shipped before
        // the gate existed — a renamed subtype costs the fix, never the turn.
        this.deps.logger?.debug?.(
          'claude: mcp readiness unavailable on this CLI — sending the prompt now',
        );
        return;
      }
      if (reading === 'silent') {
        // Not an answer, and so not an empty list either — see
        // CLAUDE_MCP_READY_REPLY_TIMEOUT_MS. Nothing was learned, so neither
        // the grace nor the stall clock moves; ask again, unless the CLI has
        // answered nothing for longer than a cold start takes.
        //
        // Unless it is running its hooks: it reads no control request until
        // its SessionStart hooks finish, and it says so on stdout. That is the
        // CLI starting up rather than refusing to answer, so the silence and
        // stall clocks both count from its last hook signal instead — the
        // ceiling and the CLI's own hook timeout still bound a hook that hangs.
        const hooksRunning = this.runningHooks.size > 0;
        if (hooksRunning) {
          lastChangeAt = now();
        }
        const quietSince = Math.max(startedAt, this.lastHookSignalAt ?? 0);
        if (
          firstAnswerAt === null &&
          !hooksRunning &&
          now() - quietSince >= CLAUDE_MCP_READY_SILENCE_MS
        ) {
          break;
        }
        await this.wait(CLAUDE_MCP_READY_POLL_MS);
        continue;
      }
      firstAnswerAt ??= now();
      pending = pendingMcpServers(reading);
      if (reading.length > 0) {
        sawServers = true;
      }
      const key = mcpReadingKey(reading);
      if (sawServers && pending.length === 0 && key === previousKey) {
        // Two identical readings, not one: a single "nothing pending" is also
        // what a half-discovered list looks like, and releasing on it puts the
        // prompt out mid-discovery — which is the bug.
        this.deps.logger?.debug?.(
          `claude: ${reading.length} MCP server(s) ready after ${now() - startedAt}ms`,
        );
        return;
      }
      if (
        !sawServers &&
        now() - firstAnswerAt >= CLAUDE_MCP_READY_EMPTY_GRACE_MS
      ) {
        // Nothing has ever been reported here, so there is nothing to dial.
        return;
      }
      if (key !== previousKey) {
        // Discovery moved — a server appeared, or one left `pending`. Whatever
        // it did, this folder is not stuck, so the stall window starts again.
        lastChangeAt = now();
      }
      previousKey = key;
      await this.wait(CLAUDE_MCP_READY_POLL_MS);
    }

    if (pending.length > 0) {
      // The turn is about to run without these, which is the old broken
      // behaviour — so it is said out loud rather than left for the user to
      // rediscover as "the agent can't use it".
      io.emit({
        type: 'notice',
        message: CLAUDE_MCP_NOT_READY_MESSAGE.replace('%s', pending.join(', ')),
        // INFO, and this REPLACES an earlier deliberate choice of the advisory
        // (warning) chrome on the grounds that a turn missing tools is a
        // degrade. The degrade is real; the chrome was still wrong, and the
        // user's own report is the evidence — "i see this error", about a turn
        // that had run correctly. Nothing here failed: the servers were slow,
        // the turn ran, they finish dialling behind it and the next message has
        // them, which is exactly what the sentence goes on to say. Reserving the
        // red banner for things that actually went wrong is what keeps it
        // meaning anything.
        severity: 'info',
      });
      return;
    }
    if (firstAnswerAt === null) {
      // The CLI answered not one poll inside the whole stall window, so the
      // turn may be running on a partial surface exactly as above — only
      // without names to give. Said on the same terms and at the same volume.
      io.emit({
        type: 'notice',
        message: CLAUDE_MCP_READINESS_UNCONFIRMED_MESSAGE,
        severity: 'info',
      });
    }
  }

  /**
   * The session's stdin, kept so a repair can be sent from {@link onMessage}.
   *
   * Both opening hooks are FIRST-turn only, which is enough because this object
   * is not per turn at all: `createTurnDriver` runs once per `start()`, and a
   * claude session then serves every later message of the chat through the same
   * driver and the same open pipe (`sessionWrite` in `spawn-cli.ts` re-reads
   * `child.stdin` per call, so the captured writer does not go stale).
   *
   * Set from both rather than from the gate alone: the gate is skipped for
   * whole classes of turn (`waitsForMcpServers`), and a repair that silently
   * stopped working because a condition elsewhere changed is exactly the kind
   * of coupling that does not announce itself.
   */
  private io: TurnIo | null = null;

  onStdinReady(io: TurnIo): void {
    this.io = io;
    this.deps.delegateSettler?.attach(io);
  }

  onMessage(obj: unknown): AgentEvent[] {
    // Recorded, never consumed: the line still reaches the mapper below.
    this.trackHook(obj);
    this.deps.delegateSettler?.observe(obj);
    const open = this.openPoll;
    if (open) {
      const reading = readMcpStatusReply(obj, open.id);
      if (reading !== null) {
        // The gate's own traffic: consumed here, never mapped. A reply nobody
        // asked for reaches `mapMessage` like any other line.
        open.settle(reading);
        return [];
      }
    }
    const repaired = this.readRepairReply(obj);
    if (repaired !== null) {
      // This driver's own traffic too, and consumed for the same reason.
      return repaired;
    }
    const costed = this.readCostReply(obj);
    if (costed !== null) {
      // And the running-cost dialogue's — see `trackCost`.
      return costed;
    }
    this.rememberApiFailure(obj);
    // BEFORE the mapping, so the zero a `result` line announces is published
    // ahead of the `turn_complete` that records the same money durably — a
    // reader adding the two never sees the turn's cost in both at once.
    const cost = this.trackCost(obj);
    const mapped = this.deps
      .mapMessage(obj)
      .flatMap((event) => this.trackWindow(event))
      .map((event) => this.withFailureDetail(event));
    return this.modelMismatch.onMessage(obj, [
      ...cost,
      ...this.reconcileApiNotice(mapped, isClaudeApiErrorLine(obj)),
      // AFTER the mapped events, so the failed tool row lands before anything
      // said about it — and it says nothing yet: the attempt is silent and only
      // its REPLY speaks, since the reply is the half that knows whether the
      // server came back and, when it did not, why (see `readRepairReply`).
      ...this.repairDeadServer(obj),
    ]);
  }

  private trackHook(obj: unknown): void {
    const signal = readHookSignal(obj);
    if (signal === null) {
      return;
    }
    this.lastHookSignalAt = (this.deps.now ?? Date.now)();
    if (signal.running) {
      this.runningHooks.add(signal.hookId);
    } else {
      this.runningHooks.delete(signal.hookId);
    }
  }

  /** In-flight reconnect attempts, request id → the server each is repairing. */
  private readonly repairs = new Map<string, string>();

  /**
   * Servers with a repair in flight right now.
   *
   * A model told a tool is unavailable RETRIES it — four calls in 23 seconds on
   * the reported run — and each retry re-raises the same failure while the
   * first reconnect is still being answered. Without this, one dead server
   * would earn a reconnect request per retry.
   */
  private readonly repairing = new Set<string>();

  /**
   * Servers the CLI has already said it could not reconnect.
   *
   * Never asked again for the life of this session: the reasons measured here
   * are properties of somebody else's server (a 404 for the account's connector
   * record), so a second identical request costs a round trip and produces the
   * same sentence. A repair that SUCCEEDED leaves no mark, so a server that
   * drops again later in the same chat is repaired again — that is a new
   * incident rather than a retry of this one.
   */
  private readonly unrepairable = new Set<string>();
  private repairsSent = 0;

  /**
   * Re-dial a server this line just reported as not connected.
   *
   * Returns no events by design — see the call site. A session with no stdin
   * channel simply cannot ask, and says nothing, which is the behaviour that
   * shipped before this existed.
   */
  private repairDeadServer(obj: unknown): AgentEvent[] {
    const server = notConnectedMcpServer(obj);
    if (
      server === null ||
      this.repairing.has(server) ||
      this.unrepairable.has(server)
    ) {
      return [];
    }
    const io = this.io;
    if (io === null) {
      return [];
    }
    const id = `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}mcp-repair-${++this.repairsSent}`;
    if (io.write(mcpReconnectRequestLine(id, server))) {
      this.repairs.set(id, server);
      this.repairing.add(server);
    }
    return [];
  }

  /**
   * Turn one reconnect reply into the row that explains it, or null when this
   * line answers no attempt of ours.
   *
   * A reply that never arrives — a CLI that renamed the subtype, a process that
   * ended first — leaves its entry in {@link repairs} for the life of this
   * per-turn object and says nothing, which is the same degrade the readiness
   * gate takes and costs the diagnosis rather than the turn.
   */
  private readRepairReply(obj: unknown): AgentEvent[] | null {
    for (const [id, server] of this.repairs) {
      const reply = readMcpReconnectReply(obj, id);
      if (reply === null) {
        continue;
      }
      this.repairs.delete(id);
      this.repairing.delete(server);
      if (reply.error !== null) {
        this.unrepairable.add(server);
      }
      return [
        reply.error === null
          ? {
              type: 'notice',
              severity: 'info',
              message: CLAUDE_MCP_RECONNECTED_MESSAGE.replace('%s', server),
            }
          : {
              type: 'notice',
              severity: 'warning',
              message: CLAUDE_MCP_RECONNECT_FAILED_MESSAGE.replace(
                '%s',
                server,
              ).replace('%r', reply.error),
            },
      ];
    }
    return null;
  }

  /**
   * The api-error advisory, held one line so it cannot be published beside a
   * terminal error that says the very same thing.
   *
   * See {@link reconcileApiNotice} for what it is held against and why one line
   * is enough.
   */
  private heldApiNotice: Extract<AgentEvent, { type: 'notice' }> | null = null;

  /**
   * Withhold the api-error `notice` when the turn is about to END on that same
   * sentence, and release it when the turn instead carried on.
   *
   * MEASURED over the author's own database — every api-error row a real
   * claude run has produced (14, across four codes) — and the two populations
   * are cleanly separable by what comes NEXT:
   *
   * - FATAL (4: `Connection lost mid-response`, `The response stopped
   *   arriving`, `529 Overloaded` ×2): the next item is the turn's own `error`,
   *   one seq later, 2–4ms later, carrying a BYTE-IDENTICAL message. Publishing
   *   the notice there stacks an amber row directly on top of a red one saying
   *   the same words.
   * - RECOVERED (8, every one the image failure): the next item is real work —
   *   1.3s to 29s later — with 15 to 211 further rows before the turn's
   *   `turn_complete`. Here the notice is the ONLY record that anything went
   *   wrong, so it must be published.
   *
   * ONE line of hold is therefore enough, and it is what keeps the recovered
   * case in its right place: the notice is released ahead of whatever event
   * proved the turn continued, which on the measured data is the very next
   * item. Holding it to the terminal instead would file a failure that happened
   * at row 6614 underneath row 6666.
   *
   * The `error` arm compares MESSAGES rather than assuming adjacency — the
   * result line's own sentence is what it carries, and a turn that failed for
   * an unrelated reason after recovering from an api error must still show
   * both.
   */
  private reconcileApiNotice(
    events: AgentEvent[],
    fromApiErrorLine: boolean,
  ): AgentEvent[] {
    const held = this.heldApiNotice;
    if (held !== null) {
      this.heldApiNotice = null;
      const swallowed =
        events[0]?.type === 'error' && events[0].message === held.message;
      if (!swallowed) {
        events = [held, ...events];
      }
    }
    // Gated on the LINE, never on the event shape: several unrelated producers
    // emit a lone `notice` (the MCP-readiness advisory, a relayed compaction
    // summary), and holding one of those would be this method silently taking
    // charge of rows it knows nothing about.
    const only = events.length === 1 ? events[0] : undefined;
    if (fromApiErrorLine && only?.type === 'notice') {
      this.heldApiNotice = only;
      return [];
    }
    return events;
  }

  /**
   * The provider's own account of a failed request, kept until the `result`
   * line that ends the turn on it.
   *
   * Per-turn state, so it belongs to the driver rather than the adapter (one
   * adapter instance drives N concurrent turns), and it has to be state at all
   * because the two halves arrive on DIFFERENT lines: the request id and the
   * error code ride the synthetic `assistant` line that carries the failure's
   * prose, and the failure itself is only declared one line later. A pure
   * per-line mapper cannot join them, which is why this is here and not there.
   *
   * Probed on 2.1.234 (`--model definitely-not-a-model`):
   *
   *   {"type":"assistant","message":{…"model":"<synthetic>"…},
   *    "error":"model_not_found","request_id":"req_011CeAL4…",
   *    "is_api_error_message":true}
   *
   * `is_api_error_message` is what makes this readable at all: without it the
   * line is indistinguishable from the agent talking, and `request_id` appears
   * on ordinary lines too.
   */
  private apiFailure: { requestId?: string; code?: string } | null = null;

  /** Read the failure facts off a synthetic api-error `assistant` line. */
  private rememberApiFailure(obj: unknown): void {
    if (typeof obj !== 'object' || obj === null) {
      return;
    }
    if (!isClaudeApiErrorLine(obj)) {
      return;
    }
    const line = obj as {
      request_id?: unknown;
      error?: unknown;
    };
    const requestId =
      typeof line.request_id === 'string' ? line.request_id : undefined;
    const code = typeof line.error === 'string' ? line.error : undefined;
    if (requestId === undefined && code === undefined) {
      return;
    }
    this.apiFailure = {
      ...(requestId ? { requestId } : {}),
      ...(code ? { code } : {}),
    };
  }

  /**
   * Hand the remembered facts to the error event the turn ends on.
   *
   * The result line's own reading WINS where both have one — it describes the
   * turn's ending, while this describes a request that may have been retried —
   * and the id is only ever here, which is the whole reason for keeping it.
   * Consumed once: a second failure in the same turn reports its own facts or
   * none, never the previous one's.
   */
  private withFailureDetail(event: AgentEvent): AgentEvent {
    if (event.type !== 'error' || this.apiFailure === null) {
      return event;
    }
    const remembered = this.apiFailure;
    this.apiFailure = null;
    return {
      ...event,
      detail: {
        ...(remembered.code ? { code: remembered.code } : {}),
        ...(remembered.requestId ? { requestId: remembered.requestId } : {}),
        ...event.detail,
      },
    };
  }

  /**
   * Keep the turn's account of the window honest across a compaction — see
   * {@link compactedTo}.
   *
   * Two things happen to a finished compaction that reported what it left
   * behind: the figure is announced on the live plane at once (a
   * `context_progress` is exactly "how full the window is now", so the composer's
   * ring drops as the compaction lands instead of at the next request), and it
   * is stamped onto this turn's `turn_complete` so a reopened chat reads the
   * same number rather than the pre-compaction one the CLI's `result` carries.
   *
   * A compaction that reported NO `post_tokens` — 2.1.228 sends it only
   * sometimes — changes nothing here. The reading is then simply unknown, and
   * inventing one is the single thing a context meter must never do.
   *
   * MAIN THREAD ONLY, like the `context_progress` the mapper emits and for the
   * same reason: a delegate's context is its own, and the meter reports the
   * conversation.
   */
  private trackWindow(event: AgentEvent): AgentEvent[] {
    if (event.parentToolUseId !== undefined) {
      return [event];
    }
    if (event.type === 'context_progress') {
      this.compactedTo = null;
      return [event];
    }
    if (event.type === 'context_compacted' && event.phase === 'finished') {
      const post = event.postTokens;
      if (post === null || post <= 0) {
        return [event];
      }
      this.compactedTo = post;
      return [event, { type: 'context_progress', contextTokens: post }];
    }
    if (
      event.type === 'turn_complete' &&
      event.usage !== null &&
      this.compactedTo !== null
    ) {
      return [
        {
          ...event,
          usage: { ...event.usage, contextTokens: this.compactedTo },
        },
      ];
    }
    return [event];
  }

  /**
   * The process's running cost at its last `result` line — what a live reading
   * is measured FROM — or null until one is known.
   *
   * Per PROCESS, which this driver is (see {@link io}), and deliberately not
   * the adapter's `ClaudeSessionCostLedger`: that one is keyed by the CLI's
   * session id, and a team member's calls resume ONE session id from several
   * processes, so its last-seen total can be another process's. This process's
   * own accumulator, read off its own lines, cannot be.
   *
   * A process that has not closed a turn yet is asked for it as its first turn
   * opens, because it does not start at zero when it RESUMED a session: the
   * CLI restores the saved totals on `--resume`, so without the ask a resumed
   * call's first reading would bill every earlier turn a second time.
   */
  private costBaseline: number | null = null;
  private costAsk: CostAsk | null = null;
  private costAsksSent = 0;
  /** When the last `live` ask went out — null right after a turn closes. */
  private lastLiveCostAskAt: number | null = null;
  /** Whether a non-zero figure has been published since the last `result`. */
  private costReported = false;
  /** The CLI said it cannot answer — stop asking for the life of the process. */
  private costRefused = false;

  /**
   * Ask what the turn has cost so far, on the lines where the answer can have
   * moved, and close the reading at the line that makes it durable.
   *
   * The ask rides an `assistant` line — a request just finished, so the
   * ledger moved — and never a timer, so an idle process is asked nothing. It
   * is spaced by {@link CLAUDE_LIVE_COST_ASK_INTERVAL_MS} after the first ask
   * of a turn, which goes out on that turn's first response.
   *
   * A `result` line is where the running part stops being unrecorded: its
   * total becomes the new baseline, and if anything was published a zero is,
   * ahead of the `turn_complete` the caller maps from the same line.
   */
  private trackCost(obj: unknown): AgentEvent[] {
    const line = asRecord(obj);
    if (!line || this.costRefused) {
      return [];
    }
    if (line.type === 'result') {
      // A line without the figure leaves the baseline UNKNOWN rather than
      // stale: measuring the next turn from the previous one's start would
      // bill that turn a second time.
      const total = asNumber(line.total_cost_usd);
      this.costBaseline =
        total !== null && Number.isFinite(total) && total >= 0 ? total : null;
      this.lastLiveCostAskAt = null;
      if (this.costAsk?.purpose === 'live') {
        this.costAsk.stale = true;
      }
      if (!this.costReported) {
        return [];
      }
      this.costReported = false;
      return [{ type: 'cost_progress', costUsd: 0 }];
    }
    const opensTurn = line.type === 'system' && line.subtype === 'init';
    if (opensTurn && this.costBaseline === null) {
      this.askCost('baseline');
      return [];
    }
    if (line.type !== 'assistant') {
      return [];
    }
    if (this.costBaseline === null) {
      // The opening ask went unanswered in time; measure from here rather than
      // never measure at all.
      this.askCost('baseline');
      return [];
    }
    const now = (this.deps.now ?? Date.now)();
    if (
      this.lastLiveCostAskAt !== null &&
      now - this.lastLiveCostAskAt < CLAUDE_LIVE_COST_ASK_INTERVAL_MS
    ) {
      return [];
    }
    if (this.askCost('live')) {
      this.lastLiveCostAskAt = now;
    }
    return [];
  }

  /** Write one cost question, unless one is already out and not yet stale. */
  private askCost(purpose: CostAsk['purpose']): boolean {
    const io = this.io;
    if (io === null) {
      return false;
    }
    const now = (this.deps.now ?? Date.now)();
    const out = this.costAsk;
    if (out !== null && now - out.sentAt < CLAUDE_LIVE_COST_REPLY_TIMEOUT_MS) {
      return false;
    }
    const id = `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}cost-${++this.costAsksSent}`;
    if (!io.write(usageRequestLine(id))) {
      return false;
    }
    this.costAsk = { id, sentAt: now, purpose, stale: false };
    return true;
  }

  /**
   * Turn one cost reply into the reading it makes, or null when this line
   * answers no question of ours.
   *
   * A `live` answer reports what the turn has spent since the baseline — never
   * below zero, since a total can only have grown on one process's ledger and
   * a smaller one means the line raced a `result` that already moved the
   * baseline past it.
   */
  private readCostReply(obj: unknown): AgentEvent[] | null {
    const ask = this.costAsk;
    if (ask === null) {
      return null;
    }
    const reply = readSessionCostReply(obj, ask.id);
    if (reply === null) {
      return null;
    }
    this.costAsk = null;
    if (reply === 'refused') {
      this.costRefused = true;
      return [];
    }
    if (ask.purpose === 'baseline') {
      this.costBaseline ??= reply;
      return [];
    }
    if (ask.stale || this.costBaseline === null) {
      return [];
    }
    const costUsd = Math.max(0, reply - this.costBaseline);
    if (costUsd > 0) {
      this.costReported = true;
    }
    return [{ type: 'cost_progress', costUsd }];
  }

  buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string | undefined {
    return this.deps.buildApprovalResponse(id, allow, updatedInput, option);
  }

  /**
   * One request/reply round trip.
   *
   * A write the transport refuses resolves `'refused'`: a dialogue that cannot
   * be held is the same as one this CLI does not know. A reply that does not
   * arrive in time resolves `'silent'` — "we do not know yet", distinct from an
   * empty reading because it is not one (see
   * {@link CLAUDE_MCP_READY_REPLY_TIMEOUT_MS} for the two runs that made the
   * difference matter).
   */
  private poll(
    io: TurnIo,
  ): Promise<ClaudeMcpStatusRow[] | 'refused' | 'silent'> {
    const id = `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}mcp-${++this.polls}`;
    return new Promise((resolve) => {
      let done = false;
      const settle = (
        reading: ClaudeMcpStatusRow[] | 'refused' | 'silent',
      ): void => {
        if (done) {
          return;
        }
        done = true;
        this.openPoll = null;
        resolve(reading);
      };
      this.openPoll = { id, settle };
      if (!io.write(mcpStatusRequestLine(id))) {
        settle('refused');
        return;
      }
      void this.wait(CLAUDE_MCP_READY_REPLY_TIMEOUT_MS).then(() =>
        settle('silent'),
      );
    });
  }

  private wait(ms: number): Promise<void> {
    if (this.deps.delay) {
      return this.deps.delay(ms);
    }
    return new Promise((resolve) => {
      // Unref'd: a pending poll timer must never be the reason node stays up.
      setTimeout(resolve, ms).unref();
    });
  }
}
