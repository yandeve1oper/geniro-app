import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import { splitOf } from '../../../utils/model-costs';
import type { AgentModelCost, AgentUsage } from '../../adapter.types';
import {
  CLAUDE_CACHE_1H_KEY,
  CLAUDE_CACHE_1H_TTL_MS,
  CLAUDE_CACHE_5M_KEY,
  CLAUDE_CACHE_5M_TTL_MS,
} from '../claude.const';
import {
  type ClaudeCostTotalsFile,
  type ClaudeSessionTotals,
  readModelUsageCosts,
} from './claude-cost-totals.utils';
import {
  canonicalClaudeModel,
  ClaudeDelegateCostLedger,
  type ClaudeListPrices,
  listCostUsd,
  NO_CLAUDE_LIST_PRICES,
  readCalibration,
} from './claude-delegate-cost.utils';
import { ClaudeDelegateSpendTracker } from './claude-delegate-spend.utils';

/**
 * The running totals claude's own cost ledger reports, per CLI SESSION.
 *
 * `result.total_cost_usd` and `result.duration_api_ms` are NOT this turn's
 * figures — they are the session's, and they keep climbing for as long as the
 * process lives. Probe-verified on 2.1.233, two turns on one stdin session:
 *
 *   turn 1  total_cost_usd 0.1166802   duration_api_ms 2219
 *   turn 2  total_cost_usd 0.1384620   duration_api_ms 4159
 *
 * Turn 2 cost $0.0218 and spent 1940ms in the API; the line says $0.1385 and
 * 4159ms. The binary says the same thing outright — both fields are read off
 * `pr.costLedger` (`totalCostUSD()` / `totalAPIDuration()`), one ledger per
 * session (`costLedger: e.kind === "fork" ? e.root.costLedger : new ecs`).
 *
 * Recording the running total as the turn's own is how a chat that cost $141
 * came to be billed at $1,356 on the Stats page: the ledger SUMS what it is
 * given, so a climbing ladder is added to itself once per rung. This class is
 * what turns the ladder back into steps.
 *
 * **Keyed by claude's own `session_id`, which is what makes it safe on a shared
 * adapter.** One adapter instance serves N concurrent turns under team
 * fan-out, but a session id belongs to exactly one CLI process, and a run's
 * turns are serialized behind RUN_BUSY — so two turns can never be reading and
 * writing the same entry.
 *
 * Note what is deliberately NOT here: `usage.*` and `duration_ms` are already
 * per-turn on the wire (same probe — `cache_creation_input_tokens` fell 18,212
 * → 1,485, and `duration_ms` 2,395 → 2,093), so subtracting them would turn
 * correct figures into nonsense.
 */
/**
 * How many delegates one process remembers having announced a model for.
 *
 * A bound rather than a target: a fan-out of a dozen is a busy turn, and past
 * this the oldest entry is dropped, which costs at most one repeated
 * declaration row for a delegate still running after a hundred others started.
 */
export const MAX_TRACKED_DELEGATE_MODELS = 200;

export class ClaudeSessionCostLedger {
  /** Insertion-ordered, so the oldest entry is the first key — see `remember`. */
  private readonly totals = new Map<string, SessionTotals>();

  /**
   * The OTHER cost state this adapter carries across lines: what each delegate
   * spent, held until the `result` line that can price it.
   *
   * Composed here rather than threaded as a second parameter because the two
   * want the identical lifetime and the identical call sites — both are read
   * on the `result` line, both belong to one CLI process, and both are born
   * and discarded with the adapter. A second parameter would say the same
   * thing in ninety signatures, and every one of them a place to pass the
   * wrong one.
   */
  readonly delegates: ClaudeDelegateCostLedger;

  /**
   * @param prices The list prices this process's delegates and the running-
   *   total bound are priced at — the adapter's catalog lookup. Defaults to
   *   none, which prices nothing: right for a history import, which never sees
   *   a `result` line, and for a spec that does not exercise money.
   */
  /** A write of {@link totals} not yet flushed to {@link store}. */
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param store Where the per-session totals survive a daemon restart — see
   *   `ClaudeCostTotalsFile`. Absent, they live as long as this object.
   */
  constructor(
    readonly prices: ClaudeListPrices = NO_CLAUDE_LIST_PRICES,
    private readonly store: ClaudeCostTotalsFile | null = null,
  ) {
    this.delegates = new ClaudeDelegateCostLedger(prices);
    this.delegateSpend = new ClaudeDelegateSpendTracker(prices);
    for (const [sessionId, totals] of store?.read() ?? []) {
      this.remember(sessionId, totals, false);
    }
  }

  /** Each live delegate's running totals over every request it made. */
  readonly delegateSpend: ClaudeDelegateSpendTracker;

  /** Main-thread request ids already reported live, per session. */
  private readonly mainRequests = new Map<string, Set<string>>();

  /**
   * Whether this main-thread line is the FIRST of its model response. A
   * response arrives as one line per content block, every one repeating the
   * response's `usage`, so only the first may count. A line naming no id
   * always counts.
   */
  firstLineOfRequest(
    sessionId: string | null,
    messageId: string | null,
  ): boolean {
    if (messageId === null) {
      return true;
    }
    const session = sessionId ?? '';
    let seen = this.mainRequests.get(session);
    if (seen === undefined) {
      seen = new Set();
      this.mainRequests.set(session, seen);
      trimOldest(this.mainRequests, MAX_TRACKED_SESSIONS);
    }
    if (seen.has(messageId)) {
      return false;
    }
    seen.add(messageId);
    trimOldest(seen, MAX_TRACKED_MAIN_REQUESTS);
    return true;
  }

  /**
   * Which delegates have already had their MODEL announced, and as what.
   *
   * Not cost state, and it rides this object anyway for the reason
   * {@link delegates} does: this is the adapter's ONE piece of per-process,
   * across-lines state, born and discarded with the CLI process a delegate's
   * launching call belongs to. A second parameter would say the same thing in
   * ninety signatures.
   *
   * Keyed by the LAUNCHING TOOL CALL, which is what a `subagent_info` names —
   * so an entry is per delegate rather than per line, and the map answers "have
   * we said this already".
   */
  private readonly delegateModels = new Map<string, string>();

  /**
   * Record a delegate's model and say whether it is NEWS.
   *
   * The caller announces only on a true, because a delegate writes an assistant
   * line per response and every one of them names its model — announcing each
   * would persist dozens of identical declaration rows per delegate.
   *
   * A CHANGED model is news again: nothing observed on this wire changes one
   * mid-delegate, but reporting a change costs one row where suppressing it
   * would leave the transcript naming a model the delegate had stopped using.
   *
   * Bounded like {@link ClaudeDelegateCostLedger}'s own pending set, and the
   * eviction is harmless in a way that one is not: the worst a forgotten entry
   * can do is let a long-lived delegate announce its model a second time.
   */
  noteDelegateModel(toolCallId: string, model: string): boolean {
    if (this.delegateModels.get(toolCallId) === model) {
      return false;
    }
    this.delegateModels.set(toolCallId, model);
    trimOldest(this.delegateModels, MAX_TRACKED_DELEGATE_MODELS);
    return true;
  }

  /**
   * Each delegate TASK's first launching tool call, keyed by the CLI's task id.
   *
   * Per-process, across-lines state on this object for the reason
   * {@link delegates} gives. It exists because a RESUMED delegate reports its
   * work against the wrong call: claude keys an agent's task by its agentId
   * (`resolverState().tasks[agentId]` in the 2.1.280 bundle), so resuming it
   * with `SendMessage` re-registers the SAME task id — but its `task_started`
   * names the `SendMessage` call as `tool_use_id`, while every row the resumed
   * delegate writes is still parented to the ORIGINAL `Agent` call. Without
   * this map the open and the close land on a block nothing else belongs to,
   * and the delegate's own block keeps the ending of its first run — so one
   * that failed at launch on a usage limit and was resumed after the reset
   * shows that first failure over every row it wrote since.
   */
  private readonly delegateLaunches = new Map<string, string>();

  /**
   * The call a delegate task's lifecycle belongs to: the FIRST call that
   * launched this task id, remembered on first sight — so a resume is credited
   * to the delegate it resumes. Null when neither this line nor an earlier one
   * named a call.
   */
  launchOfTask(taskId: string, toolCallId: string | null): string | null {
    const first = this.delegateLaunches.get(taskId);
    if (first !== undefined) {
      return first;
    }
    if (toolCallId === null) {
      return null;
    }
    this.delegateLaunches.set(taskId, toolCallId);
    trimOldest(this.delegateLaunches, MAX_TRACKED_DELEGATE_MODELS);
    return toolCallId;
  }

  /**
   * Whether each session's account is on paid EXTRA USAGE, as the session's
   * newest `rate_limit_event` said (`isUsingOverage`).
   *
   * Billing state of the account rather than of a turn, on this object for the
   * reason {@link delegates} gives. Kept because the CLI states it only when it
   * CHANGES — once early in a process, then on each transition — while the
   * question it answers ("why is this turn's cache five minutes?") is asked at
   * every `result` line. Keyed by session, since one adapter serves every
   * concurrent process and each reads its own account's state.
   */
  private readonly extraUsage = new Map<string, boolean>();

  /** Seeds waiting for their process's `init` — see {@link expectResume}. */
  private readonly pendingResumes = new Map<
    string,
    () => SessionTotals | null | undefined
  >();

  /**
   * Sessions that compacted since their last `result`. Each entry is taken by
   * that result, so the set holds only sessions mid-compaction.
   */
  private readonly compacted = new Set<string>();

  /**
   * Resumed sessions whose seed could not read the restored total — see
   * {@link seedPendingResume}. Taken by the session's next result.
   */
  private readonly unconfirmedResumes = new Set<string>();

  /** Record what a session's newest `rate_limit_event` said. */
  noteExtraUsage(sessionId: string, onExtraUsage: boolean): void {
    this.extraUsage.delete(sessionId);
    this.extraUsage.set(sessionId, onExtraUsage);
    trimOldest(this.extraUsage, MAX_TRACKED_SESSIONS);
  }

  /**
   * Whether the session was last reported on extra usage. False when nothing
   * was reported, which claims nothing: the reason is offered only when stated.
   */
  isOnExtraUsage(sessionId: string | null): boolean {
    return sessionId !== null && this.extraUsage.get(sessionId) === true;
  }

  /**
   * This turn's own cost and API time, from the session totals the line
   * carries.
   *
   * A session id we have not seen contributes its full total, which is right
   * for a first turn and is also the only honest answer for a session this
   * process did not watch from the start (an adopted daemon, a restarted UI).
   *
   * A total that went DOWN means a new ledger behind a reused id, so the figure
   * is taken whole rather than clamped to zero — the alternative silently drops
   * a real turn's spend.
   */
  perTurn(
    sessionId: string | null,
    cumulative: SessionTotals,
    ownSpendUsd: number | null = null,
  ): {
    costUsd: number | null;
    apiMs: number | null;
    modelCosts: AgentModelCost[] | null;
    /** The part of `costUsd` priced here rather than the CLI's own figure. */
    estimatedCostUsd: number | null;
  } {
    if (sessionId === null) {
      // Nothing to key on. Reporting the running total would be the very bug
      // this class exists to stop, and no `result` line has been observed
      // without the field — so the honest answer is "not measured".
      return {
        costUsd: null,
        apiMs: null,
        modelCosts: null,
        estimatedCostUsd: null,
      };
    }
    const previous = this.totals.get(sessionId);
    const unconfirmed = this.unconfirmedResumes.delete(sessionId);
    this.remember(sessionId, cumulative);
    const costUsd = step(previous?.costUsd ?? null, cumulative.costUsd);
    // `modelUsage` runs on the same ledger as `total_cost_usd` (its schema
    // description in the 2.1.295 bundle: "cumulative across turns … shares its
    // lifecycle"), so each model's share steps the same way — and is kept only
    // when the shares add up to the step taken, see `splitOf`.
    const modelCosts = splitOf(modelSteps(previous, cumulative), costUsd);
    // A step off a KNOWN base that did not go down is this process's own
    // spend, and it is trusted whole. The base is known because it is either
    // what this ledger last saw (kept on disk across restarts) or what the
    // process restored as it started (`seedForResume`), so no earlier process's
    // history can be in it — while a background sub-agent's spend, billed to
    // the result after the one it ran under, legitimately can. Measured on a
    // real profile before this: of 181 clipped turns, 57 had their real spend
    // cut — $522.85 recorded where the session files priced $2,385.51.
    //
    // Except a resumed process's FIRST result when its seed could not read
    // what the CLI restored: that base is a guess, so the step is bounded.
    const trustedStep =
      !unconfirmed &&
      previous !== undefined &&
      previous.costUsd !== null &&
      cumulative.costUsd !== null &&
      cumulative.costUsd >= previous.costUsd;
    if (trustedStep) {
      return {
        costUsd,
        apiMs: step(previous.apiMs, cumulative.apiMs),
        modelCosts,
        estimatedCostUsd: null,
      };
    }
    // With no base, or a total that went DOWN, a step far past what the turn's
    // own tokens can have cost is not this turn's — it is history the ledger
    // could not subtract. Two ways that happens, both measured on the
    // reporter's team run `a0877ce9`:
    //
    //   - a RESUMED process starts from the session's SAVED totals (the CLI
    //     restores `costState` on `--resume`), so its first result carries every
    //     earlier turn — which this ledger, seeing the id for the first time in
    //     this process, took whole: a 12.8s call billed $0.79 for $0.47 of tokens;
    //   - every call into a team member resumes that member's ONE session, so
    //     several processes report under one id and their totals interleave —
    //     a total that "dropped" was taken whole: $29.41 for $13.79 of tokens.
    //
    // The turn is then billed at its own priced tokens, and its API time — a
    // figure from the same untrustworthy total, with nothing to price it by —
    // is reported as unmeasured rather than as history.
    if (
      costUsd !== null &&
      ownSpendUsd !== null &&
      costUsd > ownSpendUsd * RUNNING_TOTAL_TOLERANCE + RUNNING_TOTAL_SLACK_USD
    ) {
      // The CLI's per-model figures are the same untrustworthy history.
      return {
        costUsd: ownSpendUsd,
        apiMs: null,
        modelCosts: null,
        estimatedCostUsd: ownSpendUsd,
      };
    }
    return {
      costUsd,
      apiMs: step(previous?.apiMs ?? null, cumulative.apiMs),
      modelCosts,
      estimatedCostUsd: null,
    };
  }

  /**
   * Set where a session's running totals START in a process about to resume
   * it, from what the CLI restores (`readLastClaudeCostState`: the
   * transcript's last `cost-state`, or null when it holds none).
   *
   * The base the next step is measured from:
   *
   * - a session this ledger does NOT know, or whose last total is ABOVE what
   *   the CLI restores, starts from the restored total. The second case is a
   *   previous process killed without writing a `cost-state`: the new one
   *   counts on from an older line, and its first result is that line plus its
   *   own work. Without the restored base the first result was billed whole —
   *   measured on a real profile, 169 `/compact` turns in a month carried
   *   $2,141 of earlier processes' spend, and one chat turn recorded $653.74
   *   that its session files price at $1.80;
   * - a session it knows at or below the restored total keeps its own figure:
   *   the gap is what the previous process spent after its last `result` — a
   *   turn the user stopped reports no cost of its own, and background
   *   sub-agents keep spending past their turn — and measuring from the
   *   ledger's figure bills that to this turn instead of dropping it;
   * - a session that restores NOTHING starts from zero, because that is where
   *   the CLI's running total starts — unless this ledger already holds a
   *   total for it. A read that finds no line cannot tell "none was ever
   *   written" from "the previous process has not written it yet", and zero
   *   is the base that bills the whole earlier spend to the next result.
   */
  seedForResume(sessionId: string, restored: SessionTotals | null): void {
    const known = this.totals.get(sessionId);
    if (restored === null && known !== undefined) {
      return;
    }
    const base: SessionTotals = restored ?? {
      costUsd: 0,
      apiMs: 0,
      costByModel: {},
    };
    if (
      known !== undefined &&
      known.costUsd !== null &&
      base.costUsd !== null &&
      known.costUsd <= base.costUsd
    ) {
      return;
    }
    this.remember(sessionId, base);
  }

  /**
   * Seed a resumed session from what `readRestored` answers, once its new
   * process reports `system/init` ({@link seedPendingResume}) rather than at
   * spawn.
   *
   * The CLI restores its total when it starts, and the process it replaces
   * writes the `cost-state` line it restores only as it exits — which a
   * replacement does not wait for. Read at spawn, the line was not there yet;
   * read at init, the file holds what the CLI itself restored from.
   *
   * `readRestored` answers `undefined` when it cannot say (no transcript
   * found), which leaves the base alone.
   */
  expectResume(
    sessionId: string,
    readRestored: () => SessionTotals | null | undefined,
  ): void {
    this.pendingResumes.delete(sessionId);
    this.pendingResumes.set(sessionId, readRestored);
    trimOldest(this.pendingResumes, MAX_TRACKED_SESSIONS);
  }

  /**
   * Apply the seed {@link expectResume} registered for this session, if one is
   * waiting. Once per spawn: a kept process reports `init` again on later
   * turns, and re-reading then would lower the base below its own results.
   *
   * A read that finds no line, finds no transcript or fails leaves the base a
   * guess, so the process's first result is not trusted (`perTurn`).
   */
  seedPendingResume(sessionId: string): void {
    const readRestored = this.pendingResumes.get(sessionId);
    if (readRestored === undefined) {
      return;
    }
    this.pendingResumes.delete(sessionId);
    let restored: SessionTotals | null | undefined;
    try {
      restored = readRestored();
    } catch {
      restored = undefined;
    }
    if (restored === null || restored === undefined) {
      this.markUnconfirmed(sessionId);
    } else {
      this.unconfirmedResumes.delete(sessionId);
    }
    if (restored !== undefined) {
      this.seedForResume(sessionId, restored);
    }
  }

  private markUnconfirmed(sessionId: string): void {
    this.unconfirmedResumes.delete(sessionId);
    this.unconfirmedResumes.add(sessionId);
    trimOldest(this.unconfirmedResumes, MAX_TRACKED_SESSIONS);
  }

  /**
   * A process reported `system/init` for this session: apply its pending
   * resume seed, and drop a compaction noted before it — that one belonged to
   * a process whose result never came, not to this process's next result.
   */
  noteInit(sessionId: string): void {
    this.compacted.delete(sessionId);
    this.seedPendingResume(sessionId);
  }

  /**
   * The session compacted its conversation, so its next `result` did work even
   * if it reports no tokens of its own — see `describesQuietResult`.
   */
  noteCompaction(sessionId: string): void {
    this.compacted.delete(sessionId);
    this.compacted.add(sessionId);
    trimOldest(this.compacted, MAX_TRACKED_SESSIONS);
  }

  /** Whether a compaction was noted since the session's last result. */
  takeCompaction(sessionId: string | null): boolean {
    return sessionId !== null && this.compacted.delete(sessionId);
  }

  /** Drop a finished session's entry. */
  forget(sessionId: string): void {
    this.totals.delete(sessionId);
    this.extraUsage.delete(sessionId);
    this.pendingResumes.delete(sessionId);
    this.compacted.delete(sessionId);
    this.unconfirmedResumes.delete(sessionId);
  }

  /**
   * Record the new high-water mark, evicting the oldest entry past the cap.
   *
   * The cap is the whole reason this is not a plain Map: a long-lived daemon
   * sees a new session id per chat, and `forget` is best-effort — a SIGKILLed
   * CLI never reports its own end. Losing the oldest entry costs one turn's
   * delta on a session nobody has touched in hundreds of chats.
   */
  private remember(
    sessionId: string,
    totals: SessionTotals,
    persist = true,
  ): void {
    this.totals.delete(sessionId);
    this.totals.set(sessionId, totals);
    trimOldest(this.totals, MAX_TRACKED_SESSIONS);
    if (persist) {
      this.scheduleFlush();
    }
  }

  /**
   * Write the totals out shortly after they move — batched, because a turn's
   * fan-out can settle several sessions at once, and unref'd so a pending write
   * never holds the daemon open.
   */
  private scheduleFlush(): void {
    if (this.store === null || this.flushTimer !== null) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.store?.write(this.totals);
    }, TOTALS_FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }
}

/**
 * Drop the oldest entries of an insertion-ordered collection past `max` — the
 * bound every per-session and per-delegate record here keeps.
 */
function trimOldest<K>(
  collection: Map<K, unknown> | Set<K>,
  max: number,
): void {
  while (collection.size > max) {
    const oldest = collection.keys().next();
    if (oldest.done === true) {
      break;
    }
    collection.delete(oldest.value);
  }
}

/** One session's running totals, as the last `result` line stated them. */
type SessionTotals = ClaudeSessionTotals;

/**
 * What each model added since `previous`, on {@link step}'s rules — null when
 * the line names no models, or the base it would step from has no per-model
 * figures (an entry written before they were kept).
 */
function modelSteps(
  previous: SessionTotals | undefined,
  cumulative: SessionTotals,
): AgentModelCost[] | null {
  const current = cumulative.costByModel;
  if (current === null || current === undefined) {
    return null;
  }
  // A total that went down is a new ledger behind a reused id: the cost step
  // takes it whole, so the per-model steps do too.
  const restarted =
    previous?.costUsd != null &&
    cumulative.costUsd !== null &&
    cumulative.costUsd < previous.costUsd;
  const base = previous === undefined || restarted ? {} : previous.costByModel;
  if (base === null || base === undefined) {
    return null;
  }
  return Object.entries(current).map(([model, costUsd]) => ({
    model,
    // Own keys only: a model id is CLI text, and `constructor` is a key too.
    costUsd: step(Object.hasOwn(base, model) ? base[model]! : 0, costUsd) ?? 0,
  }));
}

/** How long after a total moves it is written to disk. */
const TOTALS_FLUSH_DELAY_MS = 1_000;

/**
 * How many sessions' running totals to keep. Two numbers per entry, so this is
 * kilobytes at the cap — sized to never evict an entry still in use rather than
 * to save memory.
 */
const MAX_TRACKED_SESSIONS = 512;

/** How many main-thread response ids one session remembers. */
const MAX_TRACKED_MAIN_REQUESTS = 512;

/**
 * How far the CLI's own figure may exceed the turn's token-priced spend before
 * it is read as history rather than as this turn.
 *
 * The priced figure is already CALIBRATED against the line's own `modelUsage`,
 * so on a healthy turn the two agree to a few percent (the Manager's own turns
 * on the reporter's run matched to the cent). The margin is for what the
 * calibration cannot see — a 1-hour cache write billed at 2x where the list
 * price assumes the 5-minute write's 1.25x — and the slack keeps a cents-sized turn from being clipped by
 * rounding. The inflated turns this exists for ran 1.4x to 3.7x over.
 */
const RUNNING_TOTAL_TOLERANCE = 1.5;
const RUNNING_TOTAL_SLACK_USD = 0.05;

/**
 * What this turn's OWN tokens cost, plus its delegates — the bound
 * {@link ClaudeSessionCostLedger.perTurn} checks the running-total step against.
 *
 * `result.usage` is per-turn on the wire (see the ledger's own probe), so this
 * does not depend on any running total. Null whenever a part cannot be priced —
 * an unknown model, a delegate nobody could price, a line with no usage — and a
 * null bound caps nothing: an unpriceable turn keeps the CLI's figure.
 */
function turnOwnSpendUsd(
  root: Record<string, unknown>,
  usage: Record<string, unknown> | null,
  model: string | null,
  delegatesUsd: number | null,
  prices: ClaudeListPrices,
): number | null {
  if (!usage || model === null || delegatesUsd === null) {
    return null;
  }
  const list = listCostUsd(
    model,
    {
      inputTokens: asNumber(usage.input_tokens),
      outputTokens: asNumber(usage.output_tokens),
      cacheReadTokens: asNumber(usage.cache_read_input_tokens),
      cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
    },
    prices,
  );
  if (list === null || list <= 0) {
    return null;
  }
  const calibration = readCalibration(root, prices);
  // With nothing to calibrate against, assume the LONG-CONTEXT tier — the rate
  // doubles past 200k — so an uncalibrated bound can only be loose, never clip
  // a real 1M-window turn billed at twice the table.
  const factor =
    calibration.byModel.get(canonicalClaudeModel(model)) ??
    calibration.overall ??
    UNCALIBRATED_FACTOR;
  return list * factor + delegatesUsd;
}

/** @see turnOwnSpendUsd */
const UNCALIBRATED_FACTOR = 2;

/**
 * Whether a `result` line made no API request of its own: no tokens in its
 * usage and a sub-second wall clock — what a resumed process answers before
 * any work. Such a line can have cost only what its delegates did, which is
 * the bound an untrusted step on it is held to; the token-priced bound would
 * call zero tokens unpriceable and cap nothing. A compaction since the last
 * result is work the usage does not show, so it is never quiet.
 */
function describesQuietResult(
  root: Record<string, unknown>,
  usage: Record<string, unknown> | null,
  compacted: boolean,
): boolean {
  const durationMs = asNumber(root.duration_ms);
  if (compacted || durationMs === null || durationMs >= QUIET_RESULT_MAX_MS) {
    return false;
  }
  return [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
  ].every((key) => !(asNumber(usage?.[key]) ?? 0));
}

/** @see describesQuietResult */
const QUIET_RESULT_MAX_MS = 1_000;

/**
 * One rung of the ladder: what this turn added to a session total.
 *
 * Null in either position yields null rather than a guess — an unmeasured
 * figure must not become a measured zero, which is the same rule the whole
 * usage path follows.
 */
function step(previous: number | null, current: number | null): number | null {
  if (current === null) {
    return null;
  }
  if (previous === null || current < previous) {
    return current;
  }
  return current - previous;
}

/**
 * Read one claude `result` line's token accounting.
 *
 * The subtlety this file exists for: `result.usage` is the turn's CUMULATIVE
 * total across every API request the turn made, NOT the conversation's size.
 * A turn that calls eight tools bills eight prompts, each one re-reading the
 * whole (cached) conversation — so summing that usage reports several times
 * the context that ever existed. Probed live on claude 2.1.220:
 *
 *   result.usage        input 12 · cache_creation 20_281 · cache_read 171_614  → 191_907
 *   last API request    input  2 · cache_creation    158 · cache_read  28_123  →  28_283
 *
 * The 191,907 figure is what put "ctx 2.8M / 200k" on a chat whose context had
 * never passed 30k. So context comes from `usage.iterations` — the per-request
 * breakdown, whose LAST entry is the final request's prompt — and never from
 * the roll-up. A CLI build that reports no iterations yields `null`: an unknown
 * context reads as "not shown", where the roll-up would read as a wrong number.
 *
 * `modelUsage` additionally names each model's real window
 * (`claude-opus-5[1m]` → 1_000_000), which is the only reason the ring can stop
 * measuring every model against an assumed 200k.
 */
export function readClaudeUsage(
  root: Record<string, unknown>,
  ledger: ClaudeSessionCostLedger,
): AgentUsage {
  const usage = asRecord(root.usage);
  const iterations = usage ? asArray(usage.iterations) : [];
  const lastRequest = asRecord(iterations[iterations.length - 1]);
  const context = readContextWindow(root);
  const cacheTtlMs = readPromptCacheTtl(lastRequest, usage);
  // The two SESSION-scoped fields, turned back into this turn's own. Required
  // rather than optional: an overload that silently reported the running total
  // when the ledger was left out is exactly the defect, and it would be
  // invisible in every spec that did not pass one.
  const sessionId = asString(root.session_id);
  // THIS session's delegates only — the ledger is shared by every process the
  // adapter drives.
  const delegatesUsd = ledger.delegates.takeSettledUsd(sessionId);
  const quiet = describesQuietResult(
    root,
    usage,
    ledger.takeCompaction(sessionId),
  );
  const step = ledger.perTurn(
    sessionId,
    {
      costUsd: asNumber(root.total_cost_usd),
      apiMs: asNumber(root.duration_api_ms),
      costByModel: readModelUsageCosts(root.modelUsage),
    },
    quiet
      ? delegatesUsd
      : turnOwnSpendUsd(
          root,
          usage,
          context.model,
          delegatesUsd,
          ledger.prices,
        ),
  );
  return {
    // Cumulative by nature and labelled as such — the turn's billed input.
    inputTokens: usage ? asNumber(usage.input_tokens) : null,
    outputTokens: usage ? asNumber(usage.output_tokens) : null,
    // The other two thirds of the same roll-up, and what makes it explicable:
    // a turn billing 2 fresh input tokens beside 17,950 cache reads and 19,473
    // cache writes did not send almost nothing, which is what `input_tokens`
    // alone says (probed on 2.1.232, a one-line "say hi" turn).
    cacheReadTokens: usage ? asNumber(usage.cache_read_input_tokens) : null,
    cacheCreationTokens: usage
      ? asNumber(usage.cache_creation_input_tokens)
      : null,
    thinkingTokens: readThinkingTokens(usage),
    contextTokens: promptSideTokens(lastRequest),
    contextWindowTokens: context.window,
    contextModel: context.model,
    // THIS TURN's spend, not the session's running total — see
    // {@link ClaudeSessionCostLedger} for the probe and for what summing the
    // total instead did to the Stats page.
    costUsd: step.costUsd,
    // Absent unless some of the cost was priced here.
    ...(step.estimatedCostUsd === null
      ? {}
      : { estimatedCostUsd: step.estimatedCostUsd }),
    // What that spend ran on — the turn's own model and every model its
    // sub-agents and side calls used, which `usage` above does not count.
    modelCosts: step.modelCosts,
    // The CLI's OWN clock for the turn, which is the number worth having: it
    // starts when the CLI begins working and so counts neither geniro's
    // MCP-readiness hold nor a stretch parked on an approval card. Probed on
    // 2.1.x (2026-08-14): `duration_ms` 7618 / `duration_api_ms` 7176 on a
    // one-tool turn. Both were being dropped, which is why a finished turn
    // could show its cost and never its time.
    //
    // `duration_ms` is genuinely per-turn and is read straight; `duration_api_ms`
    // is the session roll-up and goes through the ledger with the cost.
    durationMs: asNumber(root.duration_ms),
    apiMs: step.apiMs,
    // Genuinely per-turn on the wire, like `duration_ms` beside them — read
    // straight, with no ledger involved.
    ttftMs: asNumber(root.ttft_ms),
    timeToRequestMs: asNumber(root.time_to_request_ms),
    numTurns: asNumber(root.num_turns),
    promptCacheTtlMs: cacheTtlMs,
    // Only the five-minute cache has a reason worth stating, and only while the
    // CLI has said the account is on extra usage — which is exactly when its
    // TTL choice drops the hour (see `CLAUDE_RATE_LIMIT_EVENT_TYPE`).
    promptCacheTtlReason:
      cacheTtlMs === CLAUDE_CACHE_5M_TTL_MS &&
      ledger.isOnExtraUsage(asString(root.session_id))
        ? 'extra-usage'
        : null,
  };
}

/**
 * Which cache lifetime the turn wrote under — the LAST request's split first,
 * since that request is the one whose cache the next message will read, and
 * the turn's roll-up when the last request wrote nothing (a request that only
 * READ the cache carries `0` in both halves and states no lifetime).
 *
 * The longer lifetime wins when a request wrote both: the conversation prefix
 * goes to the cache the CLI asked for, and the hour is the one that decides
 * when the next message stops being cheap.
 */
function readPromptCacheTtl(
  ...sources: (Record<string, unknown> | null)[]
): number | null {
  for (const source of sources) {
    const split = source ? asRecord(source.cache_creation) : null;
    if (!split) {
      continue;
    }
    if ((asNumber(split[CLAUDE_CACHE_1H_KEY]) ?? 0) > 0) {
      return CLAUDE_CACHE_1H_TTL_MS;
    }
    if ((asNumber(split[CLAUDE_CACHE_5M_KEY]) ?? 0) > 0) {
      return CLAUDE_CACHE_5M_TTL_MS;
    }
  }
  return null;
}

/**
 * Of the turn's output, how much was thinking — `usage.output_tokens_details.
 * thinking_tokens` (probed on 2.1.232; `0` on a turn that did not think).
 *
 * Absent means the build does not break output down, which is not the same as
 * a turn that thought nothing — so a missing block reads null and the readout
 * withholds the split rather than reporting a zero nobody stated.
 */
function readThinkingTokens(
  usage: Record<string, unknown> | null,
): number | null {
  const details = usage ? asRecord(usage.output_tokens_details) : null;
  return details ? asNumber(details.thinking_tokens) : null;
}

/**
 * How full the window is as of ONE `assistant` line — its `message.usage`.
 *
 * The live counterpart of {@link readClaudeUsage}'s `contextTokens`, and the
 * same arithmetic: an `assistant` line reports the usage of the single request
 * that produced it, which is exactly the per-request shape the roll-up must
 * never be confused with. PROBE-VERIFIED on claude 2.1.220 — every `assistant`
 * line carried `input_tokens` + `cache_creation_input_tokens` +
 * `cache_read_input_tokens`, while `contextWindow` appeared ONLY on `result`.
 *
 * Null when the line carries no usage, so a CLI build that omits it degrades
 * to "the meter waits for the turn to finish", never to a wrong number.
 */
export function readClaudeAssistantContext(
  message: Record<string, unknown>,
): number | null {
  return promptSideTokens(asRecord(message.usage));
}

/** What ONE request spent, off the same `message.usage` the context reads. */
export interface ClaudeRequestSpend {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/**
 * The SPEND half of an `assistant` line's usage — the four counts, unsummed.
 *
 * Kept apart from {@link readClaudeAssistantContext} above, which folds three
 * of them into one prompt-side total: that sum answers "how full is the
 * window", and it is the wrong number for "what did this cost" precisely
 * because cache reads dominate it on a resumed conversation while being the
 * cheapest tokens on the bill. Both readings come off the same object and
 * neither can stand in for the other.
 *
 * Null for a whole line with no usage, so a build that stops sending it
 * degrades to "the figures appear when the turn ends" rather than to a zero
 * nobody measured. Each FIELD is independently null on the same rule.
 */
export function readClaudeRequestSpend(
  message: Record<string, unknown>,
): ClaudeRequestSpend | null {
  const usage = asRecord(message.usage);
  if (!usage) {
    return null;
  }
  const spend: ClaudeRequestSpend = {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheReadTokens: asNumber(usage.cache_read_input_tokens),
    cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
  };
  return Object.values(spend).some((part) => part !== null) ? spend : null;
}

/**
 * Everything one request put on the prompt side of the window: fresh input,
 * newly cached input, and cache reads. `input_tokens` alone excludes all cache
 * traffic, which on a resumed conversation is nearly the entire context.
 */
function promptSideTokens(
  request: Record<string, unknown> | null,
): number | null {
  if (!request) {
    return null;
  }
  const parts = [
    asNumber(request.input_tokens),
    asNumber(request.cache_creation_input_tokens),
    asNumber(request.cache_read_input_tokens),
  ].filter((part): part is number => part !== null);
  return parts.length > 0 ? parts.reduce((sum, part) => sum + part, 0) : null;
}

/**
 * The window of the model that did the turn's work.
 *
 * `modelUsage` is keyed by model id and a turn can touch more than one (a small
 * model runs side errands), so the entry that spent the most prompt tokens is
 * the one the context figure above belongs to — matching by name would mean
 * this file knowing model ids, which is exactly what asking the CLI avoids.
 */
function readContextWindow(root: Record<string, unknown>): {
  window: number | null;
  model: string | null;
} {
  const modelUsage = asRecord(root.modelUsage);
  if (!modelUsage) {
    return { window: null, model: null };
  }
  let window: number | null = null;
  let model: string | null = null;
  let best = -1;
  for (const [id, value] of Object.entries(modelUsage)) {
    const entry = asRecord(value);
    const contextWindow = entry ? asNumber(entry.contextWindow) : null;
    if (!entry || contextWindow === null) {
      continue;
    }
    const spent =
      (asNumber(entry.inputTokens) ?? 0) +
      (asNumber(entry.cacheCreationInputTokens) ?? 0) +
      (asNumber(entry.cacheReadInputTokens) ?? 0);
    if (spent > best) {
      best = spent;
      window = contextWindow;
      // The KEY, which is the id `system/init` announces
      // (`claude-opus-5[1m]`) — not the entry's `canonicalModel`, which drops
      // the variant and so cannot tell a 1M model from its 200k sibling.
      model = id;
    }
  }
  return { window, model };
}
