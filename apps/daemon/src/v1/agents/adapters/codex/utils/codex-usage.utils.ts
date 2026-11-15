import { asNumber, asRecord } from '../../../utils/json-util';
import { mergeModelCosts, splitOf } from '../../../utils/model-costs';
import {
  type ModelPrice,
  ratesForPrompt,
  tokenCostUsd,
} from '../../../utils/model-prices';
import type {
  AgentModelCost,
  AgentUsage,
  DelegateFigures,
} from '../../adapter.types';
import type { CodexTokenBreakdown, CodexTokenUsage } from '../codex.types';

/** One breakdown, or null when a figure is missing — a partial one is unusable. */
function readBreakdown(value: unknown): CodexTokenBreakdown | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const fields = {
    totalTokens: asNumber(record.totalTokens),
    inputTokens: asNumber(record.inputTokens),
    cachedInputTokens: asNumber(record.cachedInputTokens) ?? 0,
    cacheWriteInputTokens: asNumber(record.cacheWriteInputTokens) ?? 0,
    outputTokens: asNumber(record.outputTokens),
    reasoningOutputTokens: asNumber(record.reasoningOutputTokens) ?? 0,
  };
  if (
    fields.totalTokens === null ||
    fields.inputTokens === null ||
    fields.outputTokens === null
  ) {
    return null;
  }
  return {
    totalTokens: fields.totalTokens,
    inputTokens: fields.inputTokens,
    cachedInputTokens: fields.cachedInputTokens,
    cacheWriteInputTokens: fields.cacheWriteInputTokens,
    outputTokens: fields.outputTokens,
    reasoningOutputTokens: fields.reasoningOutputTokens,
  };
}

/** A `thread/tokenUsage/updated` params object's `tokenUsage`, or null. */
export function readTokenUsage(params: unknown): CodexTokenUsage | null {
  const usage = asRecord(asRecord(params)?.tokenUsage);
  const total = readBreakdown(usage?.total);
  const last = readBreakdown(usage?.last);
  if (total === null || last === null) {
    return null;
  }
  const window = asNumber(usage?.modelContextWindow);
  return {
    total,
    last,
    modelContextWindow: window !== null && window > 0 ? window : null,
  };
}

/**
 * The thread's running total as it stood BEFORE a turn, derived from that
 * turn's first reading: the first request's own figures (`last`) subtracted
 * from the total they were added to. Exact where "the total we saw last turn"
 * is not — a resumed thread's first turn on a fresh process has no earlier
 * reading at all, and its total starts at every token the thread ever used.
 */
export function baselineOf(first: CodexTokenUsage): CodexTokenBreakdown {
  const minus = (a: number, b: number): number => Math.max(0, a - b);
  return {
    totalTokens: minus(first.total.totalTokens, first.last.totalTokens),
    inputTokens: minus(first.total.inputTokens, first.last.inputTokens),
    cachedInputTokens: minus(
      first.total.cachedInputTokens,
      first.last.cachedInputTokens,
    ),
    cacheWriteInputTokens: minus(
      first.total.cacheWriteInputTokens,
      first.last.cacheWriteInputTokens,
    ),
    outputTokens: minus(first.total.outputTokens, first.last.outputTokens),
    reasoningOutputTokens: minus(
      first.total.reasoningOutputTokens,
      first.last.reasoningOutputTokens,
    ),
  };
}

/**
 * What a thread spent between two of its running totals, in the units every
 * reader here means: input FRESH (cache reads and writes are details of
 * codex's input figure and are split out), output with reasoning inside it,
 * and the dollars at the model's list price — null when nobody can price it.
 */
export interface CodexSpend {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  costUsd: number | null;
}

/**
 * The sub-agents' spend, with its dollars split by the model each thread ran
 * on — null when a thread that spent has no model or no price to split by.
 */
export interface CodexSubagentsSpend extends CodexSpend {
  modelCosts: AgentModelCost[] | null;
}

/**
 * {@link CodexSpend} between `from` (a running total) and `latest`, priced at
 * the context tier of `latest`'s own last request — see {@link turnUsageOf}
 * for why the last request's tier stands for all of them.
 */
export function spendBetween(
  latest: CodexTokenUsage,
  from: CodexTokenBreakdown,
  price: ModelPrice | null,
): CodexSpend {
  const minus = (pick: (b: CodexTokenBreakdown) => number): number =>
    Math.max(0, pick(latest.total) - pick(from));
  const input = minus((b) => b.inputTokens);
  const cached = minus((b) => b.cachedInputTokens);
  const cacheWrite = minus((b) => b.cacheWriteInputTokens);
  const output = minus((b) => b.outputTokens);
  const uncached = Math.max(0, input - cached - cacheWrite);
  return {
    inputTokens: uncached,
    cachedInputTokens: cached,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: minus((b) => b.reasoningOutputTokens),
    costUsd:
      price === null
        ? null
        : tokenCostUsd(ratesForPrompt(price, latest.last.inputTokens), {
            inputTokens: uncached,
            outputTokens: output,
            cacheReadTokens: cached,
            cacheWriteTokens: cacheWrite,
          }),
  };
}

/** True when a spend moved no token at all. */
function isEmptySpend(spend: CodexSpend): boolean {
  return (
    spend.inputTokens === 0 &&
    spend.cachedInputTokens === 0 &&
    spend.cacheWriteInputTokens === 0 &&
    spend.outputTokens === 0
  );
}

/**
 * Several spends as one: tokens summed, and the dollars summed only when every
 * part that moved a token could be priced — a part nobody can price makes the
 * total "not measured", never a smaller figure passed off as the whole.
 */
export function sumSpends(parts: readonly CodexSpend[]): CodexSpend | null {
  if (parts.length === 0) {
    return null;
  }
  // A part that moved nothing cannot make a priced total unmeasured — unless
  // nothing moved at all, when the one honest answer is the parts' own.
  const moved = parts.filter((part) => !isEmptySpend(part));
  let costUsd: number | null = 0;
  for (const part of moved.length > 0 ? moved : parts) {
    costUsd =
      costUsd === null || part.costUsd === null ? null : costUsd + part.costUsd;
  }
  const sum = (pick: (s: CodexSpend) => number): number =>
    parts.reduce((total, part) => total + pick(part), 0);
  return {
    inputTokens: sum((s) => s.inputTokens),
    cachedInputTokens: sum((s) => s.cachedInputTokens),
    cacheWriteInputTokens: sum((s) => s.cacheWriteInputTokens),
    outputTokens: sum((s) => s.outputTokens),
    reasoningOutputTokens: sum((s) => s.reasoningOutputTokens),
    costUsd,
  };
}

const NO_TOKENS: CodexTokenBreakdown = {
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
};

/**
 * What a conversation's SUB-AGENTS have spent that no turn has recorded yet —
 * kept on the session, because a sub-agent is a codex thread of its own whose
 * `thread/tokenUsage/updated` arrives on the parent's connection under its own
 * thread id, often after the parent's turn has ended.
 *
 * Each thread's newest reading is held beside what has already been BILLED
 * (folded into some parent turn's usage). A parent turn's ending folds every
 * thread's unbilled part into that turn and marks it billed, so a dollar is
 * written once: spend that lands after the parent's turn settled is folded into
 * the NEXT turn on the same process. What a sub-agent spends after the
 * conversation's last turn on that process is never written — there is no row
 * left to carry it.
 */
export class CodexSubagentSpend {
  private readonly threads = new Map<
    string,
    { billed: CodexTokenBreakdown; latest: CodexTokenUsage; readAt: number }
  >();
  private readonly models = new Map<string, string>();
  private readings = 0;

  /** The model a sub-agent thread runs on, when codex named it. */
  noteModel(threadId: string, model: string): void {
    this.models.set(threadId, model);
  }

  /**
   * One reading of a sub-agent thread. Answers what it added since the
   * previous reading — the live plane's increment — or null for the first,
   * whose own request is still counted (its baseline is the total BEFORE it).
   */
  record(
    threadId: string,
    usage: CodexTokenUsage,
  ): { previous: CodexTokenBreakdown } {
    this.readings += 1;
    const readAt = this.readings;
    const held = this.threads.get(threadId);
    if (held === undefined) {
      const billed = baselineOf(usage);
      this.threads.set(threadId, { billed, latest: usage, readAt });
      return { previous: billed };
    }
    const previous = held.latest.total;
    held.latest = usage;
    held.readAt = readAt;
    return { previous };
  }

  /** Every thread's spend not yet folded into a turn, or null when none. */
  unbilled(
    priceOf: (model: string | null) => ModelPrice | null,
    fallbackModel: string | null,
  ): CodexSubagentsSpend | null {
    const parts: CodexSpend[] = [];
    let modelCosts: AgentModelCost[] | null = [];
    for (const [threadId, { billed, latest }] of this.threads) {
      const model = this.models.get(threadId) ?? fallbackModel;
      const spend = spendBetween(latest, billed, priceOf(model));
      if (isEmptySpend(spend)) {
        continue;
      }
      parts.push(spend);
      modelCosts =
        modelCosts === null || model === null || spend.costUsd === null
          ? null
          : [...modelCosts, { model, costUsd: spend.costUsd }];
    }
    const total = sumSpends(parts);
    return total === null ? null : { ...total, modelCosts };
  }

  /**
   * The cumulative figures of one delegate: every thread in `threadIds` that has
   * been read, summed as the whole of its work. The context and the model stand
   * for the thread that read last. Null while none of them has been read.
   */
  delegateFigures(
    threadIds: readonly string[],
    priceOf: (model: string | null) => ModelPrice | null,
    fallbackModel: string | null,
  ): DelegateFigures | null {
    const read = threadIds.flatMap((threadId) => {
      const held = this.threads.get(threadId);
      return held === undefined ? [] : [{ threadId, ...held }];
    });
    const spend = sumSpends(
      read.map(({ threadId, latest }) =>
        spendBetween(
          latest,
          NO_TOKENS,
          priceOf(this.models.get(threadId) ?? fallbackModel),
        ),
      ),
    );
    if (spend === null) {
      return null;
    }
    const newest = read.reduce((a, b) => (b.readAt > a.readAt ? b : a));
    const context = newest.latest.last.totalTokens;
    return {
      requests: null,
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      cacheReadTokens: spend.cachedInputTokens,
      cacheCreationTokens: spend.cacheWriteInputTokens,
      contextTokens: context > 0 ? context : null,
      model: this.models.get(newest.threadId) ?? null,
      costUsd: null,
      estimatedCostUsd: spend.costUsd,
    };
  }

  /** Everything read so far is now on a turn's row. */
  markBilled(): void {
    for (const held of this.threads.values()) {
      held.billed = held.latest.total;
    }
  }
}

/**
 * What one turn used, as the `AgentUsage` a `turn_complete` carries.
 *
 * `inputTokens` is the UNCACHED input, so it means what claude's does: codex
 * counts cached AND cache-written tokens inside its input figure (OpenAI's
 * convention — codex 0.157.1's own binary reads them from the Responses API's
 * `input_tokens_details.{cached_tokens, cache_write_tokens}`, i.e. as DETAILS
 * of `input_tokens`), while every consumer here reads fresh input, cache reads
 * and cache writes as separate, additive quantities.
 *
 * Output, by contrast, already INCLUDES reasoning: measured on 0.157.1, a
 * reading of `input 35167 · output 250 · reasoning 167 · total 35417` has
 * `total = input + output`, so reasoning is a share of output and is never
 * added to it again — `thinkingTokens` reports the share, the price bills the
 * output once.
 *
 * codex prices nothing on its wire (only an Enterprise workspace sees a dollar
 * estimate), so the cost is the turn's tokens at the model's LIST price, when
 * the caller has one ({@link ModelPrice} from the public catalog):
 *
 *   uncached input × input + cached × cache_read
 *     + cache-write × cache_write + output × output
 *
 * at the rates of the context tier the turn's LAST request fell in (its
 * prompt, `last.inputTokens`, past a tier's size bills the whole turn at that
 * tier). That is an approximation in one direction only: a turn whose early
 * requests were under the threshold and whose last one was over it is billed
 * at the higher rate throughout. A turn's requests are not reported one by one
 * reliably enough to price them separately, and the last request is the
 * largest in all but a turn that compacted.
 *
 * No price — an unknown model, or no catalog — is a null cost, never $0.
 *
 * `subagents` is what this conversation's sub-agents spent that no earlier
 * turn recorded ({@link CodexSubagentSpend}): folded in here so the turn's
 * row, the run's totals and the usage ledger all carry it, written once.
 */
export function turnUsageOf(options: {
  latest: CodexTokenUsage | null;
  baseline: CodexTokenBreakdown | null;
  model: string | null;
  durationMs: number | null;
  /** The model's list price, or null when nobody can price it. */
  price: ModelPrice | null;
  subagents?: CodexSubagentsSpend | null;
}): AgentUsage {
  const { latest, baseline, price } = options;
  const own =
    latest === null || baseline === null
      ? null
      : spendBetween(latest, baseline, price);
  const spend = sumSpends(
    [own, options.subagents ?? null].filter(
      (part): part is CodexSpend => part !== null,
    ),
  );
  // List-price estimates like `costUsd` itself: the thread's own requests at
  // its model, each sub-agent's at the model it ran on.
  const ownCosts =
    own === null || isEmptySpend(own)
      ? []
      : own.costUsd === null || options.model === null
        ? null
        : [{ model: options.model, costUsd: own.costUsd }];
  const subagentCosts =
    options.subagents == null ? [] : options.subagents.modelCosts;
  const context = latest?.last.totalTokens ?? null;
  const window = latest?.modelContextWindow ?? null;
  return {
    inputTokens: spend?.inputTokens ?? null,
    outputTokens: spend?.outputTokens ?? null,
    cacheReadTokens: spend?.cachedInputTokens ?? null,
    cacheCreationTokens: spend?.cacheWriteInputTokens ?? null,
    thinkingTokens: spend?.reasoningOutputTokens ?? null,
    contextTokens: context !== null && context > 0 ? context : null,
    contextWindowTokens: window,
    contextModel: window !== null ? options.model : null,
    costUsd: spend?.costUsd ?? null,
    // Every dollar here is the list price above — codex states none.
    ...(spend?.costUsd == null ? {} : { estimatedCostUsd: spend.costUsd }),
    durationMs: options.durationMs,
    apiMs: null,
    ttftMs: null,
    timeToRequestMs: null,
    numTurns: null,
    modelCosts:
      ownCosts === null || subagentCosts === null
        ? null
        : splitOf(
            mergeModelCosts([ownCosts, subagentCosts]),
            spend?.costUsd ?? null,
          ),
  };
}
