import { asNumber, asRecord } from '../../../utils/json-util';
import { type ModelPrice, tokenCostUsd } from '../../../utils/model-prices';

/**
 * A claude model's LIST price, by its CANONICAL id ({@link canonicalClaudeModel})
 * — the adapter's lookup into the public price catalog
 * (`AgentAdapter.listPriceOf`, provider `anthropic`), or null when the catalog
 * does not list the model.
 *
 * It prices ONE thing the CLI refuses to price itself: a single delegate.
 * Probed on 2.1.251 across every channel that says anything about one —
 * `task_started`, `task_updated`, `task_notification`, the launching call's
 * `tool_use_result`, and the delegate's own sidechain JSONL — not one carries
 * money. The turn's `result` line carries all of it, and
 * `modelUsage[model].costUSD` covers the main thread and every delegate
 * together with no split. So a delegate's dollars are either derived here or
 * not shown at all.
 *
 * **It is never trusted on its own.** Every figure it produces is multiplied by
 * a calibration factor solved from the SAME turn's `result` line — see
 * {@link ClaudeDelegateCostLedger}. A catalog that lags a price change is
 * corrected by exactly the factor it lags by, and a model the catalog does not
 * list prices to null: the delegate shows tokens and no dollars, which is the
 * failure mode a price source must have for a model nobody has listed yet.
 */
export type ClaudeListPrices = (canonicalModel: string) => ModelPrice | null;

/** No prices at all — every model reads as one nobody listed. */
export const NO_CLAUDE_LIST_PRICES: ClaudeListPrices = () => null;

/**
 * The canonical id behind a reported one — `claude-opus-5[1m]` →
 * `claude-opus-5`.
 *
 * The CLI's `modelUsage` keys and a delegate's `resolvedModel` both carry the
 * variant suffix, and both are priced and calibrated through here so the two
 * can never disagree about what a model is called. The bracket is deliberately
 * NOT a catalog id of its own: it selects a context tier whose premium is
 * exactly what the calibration measures, so pricing the variant at its own
 * rate and calibrating on top would count the same premium twice. Anything
 * else the CLI reports (a dated id such as `claude-haiku-4-5-20251001`) is
 * already the API's own id and is looked up as it stands.
 */
export function canonicalClaudeModel(model: string): string {
  const bracket = model.indexOf('[');
  return bracket === -1 ? model : model.slice(0, bracket);
}

/**
 * One piece of work's token spend, broken down the way BILLING breaks it down.
 *
 * Four figures rather than a total, and that is the whole reason this exists:
 * the four are priced at rates that differ by a factor of 12.5 (a cache write
 * bills 1.25x input, a cache read 0.1x), so a delegate's total token count says
 * almost nothing about what it cost. Measured on the 2.1.251 probe: a delegate
 * that was 99.98% cache-write cost roughly twice what its share of the turn's
 * blended per-token rate would have claimed.
 */
export interface ClaudeTokenSpend {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** A delegate's spend, plus the model that has to price it. */
export interface ClaudeDelegateSpend extends ClaudeTokenSpend {
  /** The CLI's `resolvedModel`, variant suffix and all. */
  model: string | null;
}

/**
 * What one delegate cost, derived from its tokens and CALIBRATED against the
 * CLI's own figure for the turn that ran it.
 *
 * The problem this solves: claude prices a turn and never a delegate, and the
 * turn's price cannot be split by token share (see {@link ClaudeTokenSpend}).
 * Pricing the delegate's own breakdown at list price gets close but not
 * right, because a model's rate DOUBLES above the 200k context boundary and
 * nothing on the wire says how much of a turn fell on either side. Measured on
 * the 2.1.251 probe: the turn's `modelUsage` priced at Opus 5 list came to
 * $0.3605 where the CLI reported $0.4439 — an implied 1.23x, i.e. a turn billed
 * partly at each tier.
 *
 * So the factor is not assumed, it is SOLVED, per model, from the same
 * `result` line: whatever the CLI says a model's tokens cost, divided by what
 * their list price ({@link ClaudeListPrices}) says they cost. Applying that to
 * the delegate's own breakdown priced the probe's delegate at $0.226, inside
 * the $0.18-$0.37 band its cache-write-heavy mix has to fall in, where a
 * proportional split of the turn said $0.117.
 *
 * Two properties worth naming, because they are why a list price is tolerable
 * here at all. Its error is MEASURED every turn rather than assumed away, so a
 * uniformly stale price self-corrects — the factor drifts by exactly the amount
 * the price is wrong by. And a model the catalog does not list prices to null,
 * which reaches the reader as tokens with no dollars rather than as a wrong
 * number.
 *
 * The prices are handed in rather than imported because they come from the
 * daemon's live catalog, which only the adapter holds; a ledger built without
 * them (a history import, a spec) prices nothing.
 *
 * Scope-safe whether `modelUsage` is the turn's or the session's running total
 * (`total_cost_usd` is known to be the latter — see
 * {@link ClaudeSessionCostLedger}): the numerator and denominator are read from
 * the SAME entry, so the ratio means the same thing either way.
 */
export class ClaudeDelegateCostLedger {
  constructor(
    private readonly prices: ClaudeListPrices = NO_CLAUDE_LIST_PRICES,
  ) {}

  /**
   * Insertion-ordered — see {@link record}. Keyed by the CLI session AND the
   * launching tool call, through {@link pendingKey}.
   *
   * The session is in the key because one ledger serves every process one
   * adapter drives: the adapter is a singleton and team fan-out runs N claude
   * processes through it at once. Keyed by call id alone, the first `result`
   * line to arrive — from ANY of them — settled every delegate pending across
   * all of them, pricing turn A's delegates with turn B's calibration, emitting
   * their costs into B's event stream (another member's transcript), and leaving
   * A's own `result` nothing to price. Both lines that matter carry claude's
   * `session_id`, and a session belongs to exactly one process.
   */
  private readonly pending = new Map<
    string,
    { session: string; toolCallId: string; spend: ClaudeDelegateSpend }
  >();

  /**
   * Hold one ENDED delegate's breakdown — every request it made — until the
   * turn that ran it reports its price. Only an ended delegate is recorded, so
   * a `result` never prices one still running on partial figures.
   *
   * `sessionId` is the recording LINE's `session_id` — null for a line that
   * names none, which files it with every other such line rather than under a
   * session it may not belong to.
   */
  record(
    sessionId: string | null,
    toolCallId: string,
    spend: ClaudeDelegateSpend,
  ): void {
    const key = pendingKey(sessionId, toolCallId);
    // A delegate claude reports ended again (a resumed one, or one whose
    // detached command reported back) was already priced into the turn that
    // ran it; holding it again would add its whole spend to a later turn.
    if (this.priced.has(key)) {
      return;
    }
    this.pending.delete(key);
    this.pending.set(key, {
      session: sessionId ?? '',
      toolCallId,
      spend,
    });
    while (this.pending.size > MAX_PENDING_DELEGATES) {
      const oldest = this.pending.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.pending.delete(oldest.value);
    }
  }

  /**
   * Price every delegate THIS SESSION's turn held, off that turn's own `result`
   * line — and none of another session's (see {@link pending}).
   *
   * Empties the session's pending entries whether or not a figure came out of
   * them: a `result` ends the turn, so a delegate left unpriced here has no
   * later line to be priced by, and keeping it would attach this turn's
   * delegates to the next turn's calibration.
   */
  settle(
    sessionId: string | null,
    root: Record<string, unknown>,
  ): { id: string; costUsd: number }[] {
    const session = sessionId ?? '';
    const delegates: [string, ClaudeDelegateSpend][] = [];
    for (const [key, entry] of [...this.pending]) {
      if (entry.session !== session) {
        continue;
      }
      this.pending.delete(key);
      this.priced.add(key);
      trimSet(this.priced, MAX_PENDING_DELEGATES * 4);
      delegates.push([entry.toolCallId, entry.spend]);
    }
    this.settledUsd = 0;
    this.settledSession = session;
    const calibration = readCalibration(root, this.prices);
    if (calibration.overall !== null || calibration.byModel.size > 0) {
      this.calibrations.delete(session);
      this.calibrations.set(session, calibration);
      while (this.calibrations.size > MAX_PENDING_DELEGATES) {
        const oldest = this.calibrations.keys().next();
        if (oldest.done === true) {
          break;
        }
        this.calibrations.delete(oldest.value);
      }
    }
    if (delegates.length === 0) {
      return [];
    }
    const priced: { id: string; costUsd: number }[] = [];
    for (const [id, spend] of delegates) {
      const costUsd = priceWith(calibration, spend, this.prices);
      if (costUsd === null) {
        // One delegate nobody can price makes the turn's delegate spend
        // UNKNOWN, not smaller — see `takeSettledUsd`.
        this.settledUsd = null;
        continue;
      }
      priced.push({ id, costUsd });
      if (this.settledUsd !== null) {
        this.settledUsd += costUsd;
      }
    }
    return priced;
  }

  /**
   * A delegate that has just ENDED, priced with the factor this session's most
   * recent `result` line solved — null before any. The delegate stays pending
   * too, so the turn's own `result` re-prices it with that turn's factor.
   */
  priceNow(
    sessionId: string | null,
    spend: ClaudeDelegateSpend,
  ): number | null {
    const calibration = this.calibrations.get(sessionId ?? '');
    return calibration === undefined
      ? null
      : priceWith(calibration, spend, this.prices);
  }

  /** Delegates a `result` line has already priced, by {@link pendingKey}. */
  private readonly priced = new Set<string>();

  /** Each session's latest usable calibration, insertion-ordered. */
  private readonly calibrations = new Map<
    string,
    ReturnType<typeof readCalibration>
  >();

  /**
   * What the delegates priced by the last {@link settle} of THIS session cost
   * together — null when any of them could not be priced — and forget it.
   *
   * Read by the SAME `result` line right after `settle`, to bound what the turn
   * itself can plausibly have cost (`readClaudeUsage`). A delegate's spend is in
   * the CLI's running total and not in the turn's own token roll-up, so a bound
   * that left it out would clip a real fan-out turn to its launcher's tokens.
   *
   * A different session's figure is never handed over: it answers 0, which is
   * "no delegate spend to add" — the same answer a turn with no delegates gets.
   */
  takeSettledUsd(sessionId: string | null): number | null {
    const usd = this.settledSession === (sessionId ?? '') ? this.settledUsd : 0;
    this.settledUsd = 0;
    this.settledSession = null;
    return usd;
  }

  private settledUsd: number | null = 0;
  /** Whose figure {@link settledUsd} is — the session of the last settle. */
  private settledSession: string | null = null;
}

function trimSet(set: Set<string>, max: number): void {
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done === true) {
      break;
    }
    set.delete(oldest.value);
  }
}

function priceWith(
  calibration: ReturnType<typeof readCalibration>,
  spend: ClaudeDelegateSpend,
  prices: ClaudeListPrices,
): number | null {
  if (spend.model === null) {
    return null;
  }
  const factor =
    calibration.byModel.get(canonicalClaudeModel(spend.model)) ??
    calibration.overall;
  const list = listCostUsd(spend.model, spend, prices);
  return factor === null || list === null ? null : list * factor;
}

/** One pending delegate's key: its session and its launching call. */
function pendingKey(sessionId: string | null, toolCallId: string): string {
  return `${sessionId ?? ''}\u0000${toolCallId}`;
}

/**
 * How many delegates' breakdowns to hold. One small record each, and sized to
 * never drop a delegate still waiting for its turn to end rather than to save
 * memory — a turn that fans out to dozens is the case this feature is for.
 *
 * It is a cap and not a leak-fix: `settle` empties the map on every `result`.
 * This only bounds a CLI that streams delegate results and then never reports
 * a turn end at all.
 */
const MAX_PENDING_DELEGATES = 256;

/**
 * The band a solved calibration factor has to fall in to be believed.
 *
 * The real factor is bounded by construction: 1.0 when every token billed at
 * the standard tier, 2.0 when every one billed at the long-context tier, and
 * between the two for the mixes that actually occur. The band is widened well
 * past that so a catalog one price revision out of date still self-corrects
 * instead of going dark, while a factor outside it — a model priced as the
 * wrong family entirely — is treated as a price too wrong to correct from, and
 * the delegate simply shows no dollars.
 */
const MIN_CALIBRATION = 0.5;
const MAX_CALIBRATION = 4;

/**
 * What the CLI charged for a model's tokens over what their LIST price says
 * they cost — per model, and pooled across all of them as a fallback for a
 * delegate that ran on a model the turn's own roll-up does not name.
 */
export function readCalibration(
  root: Record<string, unknown>,
  prices: ClaudeListPrices,
): {
  byModel: Map<string, number>;
  overall: number | null;
} {
  const modelUsage = asRecord(root.modelUsage);
  const byModel = new Map<string, number>();
  if (!modelUsage) {
    return { byModel, overall: null };
  }
  let chargedTotal = 0;
  let listTotal = 0;
  for (const [id, value] of Object.entries(modelUsage)) {
    const entry = asRecord(value);
    const charged = entry ? asNumber(entry.costUSD) : null;
    if (!entry || charged === null) {
      continue;
    }
    const list = listCostUsd(
      id,
      {
        inputTokens: asNumber(entry.inputTokens),
        outputTokens: asNumber(entry.outputTokens),
        cacheReadTokens: asNumber(entry.cacheReadInputTokens),
        cacheCreationTokens: asNumber(entry.cacheCreationInputTokens),
      },
      prices,
    );
    if (list === null || list <= 0) {
      continue;
    }
    chargedTotal += charged;
    listTotal += list;
    const factor = charged / list;
    if (inBand(factor)) {
      byModel.set(canonicalClaudeModel(id), factor);
    }
  }
  const overall = listTotal > 0 ? chargedTotal / listTotal : null;
  return {
    byModel,
    overall: overall !== null && inBand(overall) ? overall : null,
  };
}

function inBand(factor: number): boolean {
  return (
    Number.isFinite(factor) &&
    factor >= MIN_CALIBRATION &&
    factor <= MAX_CALIBRATION
  );
}

/**
 * A token breakdown at LIST price, before calibration — null for a model the
 * catalog does not list, which is the whole of how an unknown model degrades
 * to "tokens, no dollars".
 *
 * At the model's BASE rates, never a context tier: the long-context premium is
 * exactly what the calibration measures, so applying a tier here as well would
 * count it twice. The cache rates are the catalog's own (a 5-minute write and
 * a read); a 1-hour write, which the breakdown cannot tell apart, is absorbed
 * by the calibration for a turn that used one.
 *
 * An absent figure counts as zero rather than voiding the sum: the four are
 * independent, and a build that reports three of them has still measured most
 * of the bill. A breakdown that is entirely absent yields 0 and is refused by
 * the callers, which both require a positive figure.
 */
export function listCostUsd(
  model: string,
  spend: ClaudeTokenSpend,
  prices: ClaudeListPrices,
): number | null {
  const price = prices(canonicalClaudeModel(model));
  if (price === null) {
    return null;
  }
  return tokenCostUsd(price, {
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    cacheReadTokens: spend.cacheReadTokens,
    cacheWriteTokens: spend.cacheCreationTokens,
  });
}
