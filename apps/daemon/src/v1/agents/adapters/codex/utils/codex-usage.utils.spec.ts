import { describe, expect, it } from 'vitest';

import type { ModelPrice } from '../../../utils/model-prices';
import {
  baselineOf,
  CodexSubagentSpend,
  readTokenUsage,
  spendBetween,
  sumSpends,
  turnUsageOf,
} from './codex-usage.utils';

/** `gpt-6-astra` as models.dev listed it on 2026-10-05, per million tokens. */
const ASTRA: ModelPrice = {
  input: 10,
  output: 50,
  cacheRead: 1,
  cacheWrite: 12.5,
  tiers: [
    {
      input: 20,
      output: 75,
      cacheRead: 2,
      cacheWrite: 25,
      aboveContextTokens: 272_000,
    },
  ],
  contextTokens: null,
};

/**
 * Shapes transcribed from a live `thread/tokenUsage/updated` on codex 0.157.1
 * (a `gpt-5.5` turn, then the reading right after `thread/compact/start`).
 */
const breakdown = (
  total: number,
  input: number,
  cached: number,
  output: number,
  reasoning = 0,
) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: cached,
  cacheWriteInputTokens: 0,
  outputTokens: output,
  reasoningOutputTokens: reasoning,
});

describe('readTokenUsage', () => {
  it('reads the running total, the last request and the window', () => {
    const usage = readTokenUsage({
      threadId: 't',
      turnId: 'u',
      tokenUsage: {
        total: breakdown(16990, 16969, 8064, 21, 14),
        last: breakdown(16990, 16969, 8064, 21, 14),
        modelContextWindow: 258400,
      },
    });
    expect(usage?.total.totalTokens).toBe(16990);
    expect(usage?.last.cachedInputTokens).toBe(8064);
    expect(usage?.modelContextWindow).toBe(258400);
  });

  it('answers null when a required figure is missing, never a partial reading', () => {
    expect(
      readTokenUsage({
        tokenUsage: { total: { totalTokens: 1 }, last: breakdown(1, 1, 0, 0) },
      }),
    ).toBeNull();
  });

  it('treats an absent or non-positive window as unknown', () => {
    const usage = readTokenUsage({
      tokenUsage: {
        total: breakdown(10, 8, 0, 2),
        last: breakdown(10, 8, 0, 2),
        modelContextWindow: 0,
      },
    });
    expect(usage?.modelContextWindow).toBeNull();
  });
});

describe('baselineOf', () => {
  it('recovers the total BEFORE the turn from its first reading', () => {
    // A resumed thread: the first reading's total already holds every earlier
    // turn. Subtracting that request's own figures is what makes the turn's
    // usage its own rather than the whole thread's.
    const first = readTokenUsage({
      tokenUsage: {
        total: breakdown(50_000, 49_000, 30_000, 1_000),
        last: breakdown(16_000, 15_900, 8_000, 100),
        modelContextWindow: 258400,
      },
    })!;
    expect(baselineOf(first)).toEqual(breakdown(34_000, 33_100, 22_000, 900));
  });
});

describe('turnUsageOf', () => {
  it('bills the turn its delta, with input net of cached tokens', () => {
    const latest = readTokenUsage({
      tokenUsage: {
        total: breakdown(40_000, 38_000, 20_000, 2_000, 300),
        last: breakdown(19_000, 18_500, 10_000, 500, 100),
        modelContextWindow: 258400,
      },
    });
    const usage = turnUsageOf({
      latest,
      baseline: breakdown(20_000, 19_000, 9_000, 1_000, 100),
      model: 'gpt-5.5',
      durationMs: 8316,
      price: null,
    });
    // input delta 19,000 of which 11,000 were cache reads.
    expect(usage.inputTokens).toBe(8_000);
    expect(usage.cacheReadTokens).toBe(11_000);
    expect(usage.outputTokens).toBe(1_000);
    expect(usage.thinkingTokens).toBe(200);
    // The window holds what the LAST request carried, not the thread's sum.
    expect(usage.contextTokens).toBe(19_000);
    expect(usage.contextWindowTokens).toBe(258400);
    expect(usage.contextModel).toBe('gpt-5.5');
    expect(usage.durationMs).toBe(8316);
    // codex prices nothing on its wire, and nothing priced this model.
    expect(usage.costUsd).toBeNull();
    // No cost is not an estimated cost.
    expect(usage.estimatedCostUsd).toBeUndefined();
  });

  it('reports no token figures, rather than zeros, when nothing was measured', () => {
    const usage = turnUsageOf({
      latest: null,
      baseline: null,
      model: 'gpt-5.5',
      durationMs: null,
      price: ASTRA,
    });
    // A price with no measured tokens is still no cost — never $0.
    expect(usage.costUsd).toBeNull();
    expect(usage.inputTokens).toBeNull();
    expect(usage.outputTokens).toBeNull();
    expect(usage.contextTokens).toBeNull();
    expect(usage.contextModel).toBeNull();
  });

  /** A turn on top of a 20k-token baseline, with every kind of token in it. */
  const priced = (lastPrompt: number, price: ModelPrice | null) =>
    turnUsageOf({
      latest: {
        total: {
          totalTokens: 20_000 + 600_000 + 30_000,
          inputTokens: 19_000 + 600_000,
          cachedInputTokens: 9_000 + 400_000,
          // Cache writes are a DETAIL of input, like cache reads.
          cacheWriteInputTokens: 50_000,
          outputTokens: 1_000 + 30_000,
          reasoningOutputTokens: 100 + 20_000,
        },
        last: {
          totalTokens: lastPrompt + 3_000,
          inputTokens: lastPrompt,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 3_000,
          reasoningOutputTokens: 0,
        },
        modelContextWindow: 1_000_000,
      },
      baseline: {
        totalTokens: 20_000,
        inputTokens: 19_000,
        cachedInputTokens: 9_000,
        cacheWriteInputTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 100,
      },
      model: 'gpt-6-astra',
      durationMs: 1_000,
      price,
    });

  it('prices the turn at list: uncached, cached, cache-written and output at their own rates', () => {
    const usage = priced(200_000, ASTRA);
    // input 600k = 150k fresh + 400k cache reads + 50k cache writes.
    expect(usage.inputTokens).toBe(150_000);
    expect(usage.cacheReadTokens).toBe(400_000);
    expect(usage.cacheCreationTokens).toBe(50_000);
    expect(usage.outputTokens).toBe(30_000);
    // 150k × $10 + 400k × $1 + 50k × $12.5 + 30k × $50, per million.
    expect(usage.costUsd).toBeCloseTo(1.5 + 0.4 + 0.625 + 1.5, 10);
    // All of it is geniro's list-price arithmetic, so all of it is marked.
    expect(usage.estimatedCostUsd).toBeCloseTo(1.5 + 0.4 + 0.625 + 1.5, 10);
  });

  it('bills reasoning ONCE, as the share of output codex already counts it as', () => {
    const usage = priced(200_000, ASTRA);
    expect(usage.thinkingTokens).toBe(20_000);
    // Adding the 20k reasoning tokens to the 30k output would bill $1.00 more.
    expect(usage.costUsd).toBeCloseTo(4.025, 10);
  });

  it('applies the long-context tier when the turn’s last prompt is past it', () => {
    const usage = priced(272_001, ASTRA);
    // 150k × $20 + 400k × $2 + 50k × $25 + 30k × $75, per million.
    expect(usage.costUsd).toBeCloseTo(3 + 0.8 + 1.25 + 2.25, 10);
  });

  it('keeps the base rates for a last prompt AT the tier’s size', () => {
    expect(priced(272_000, ASTRA).costUsd).toBeCloseTo(4.025, 10);
  });

  it('leaves an unknown model unpriced — null, never $0', () => {
    const usage = priced(200_000, null);
    expect(usage.costUsd).toBeNull();
    // The tokens are still reported in full.
    expect(usage.outputTokens).toBe(30_000);
  });
});

describe('sub-agent spend', () => {
  const PLAIN: ModelPrice = {
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    tiers: [],
    contextTokens: null,
  };
  const breakdown = (input: number, output: number, cached = 0) => ({
    totalTokens: input + output,
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteInputTokens: 0,
    outputTokens: output,
    reasoningOutputTokens: 0,
  });
  const reading = (total: [number, number], last: [number, number]) => ({
    total: breakdown(...total),
    last: breakdown(...last),
    modelContextWindow: 258_400,
  });

  it('counts a thread’s first request, then only what each later reading added', () => {
    const spend = new CodexSubagentSpend();
    spend.record('S', reading([10_000, 100], [10_000, 100]));
    expect(spend.unbilled(() => PLAIN, null)).toMatchObject({
      inputTokens: 10_000,
      outputTokens: 100,
    });
    spend.markBilled();
    expect(spend.unbilled(() => PLAIN, null)).toBeNull();
    spend.record('S', reading([12_000, 150], [2_000, 50]));
    expect(spend.unbilled(() => PLAIN, null)).toMatchObject({
      inputTokens: 2_000,
      outputTokens: 50,
    });
  });

  it('prices each thread at the model it named, else the parent’s', () => {
    const asked: (string | null)[] = [];
    const spend = new CodexSubagentSpend();
    spend.noteModel('A', 'gpt-mini');
    spend.record('A', reading([1_000, 0], [1_000, 0]));
    spend.record('B', reading([1_000, 0], [1_000, 0]));
    spend.unbilled((model) => {
      asked.push(model);
      return PLAIN;
    }, 'gpt-parent');
    expect(asked.sort()).toEqual(['gpt-mini', 'gpt-parent']);
  });

  it('splits a turn’s cost into its own model and each sub-agent’s', () => {
    const MINI: ModelPrice = { ...PLAIN, input: 1, output: 5 };
    const spend = new CodexSubagentSpend();
    spend.noteModel('A', 'gpt-mini');
    spend.record('A', reading([10_000, 100], [10_000, 100]));
    spend.record('B', reading([1_000, 0], [1_000, 0]));
    const latest = reading([36_000, 100], [16_000, 50]);

    const usage = turnUsageOf({
      latest,
      baseline: baselineOf(latest),
      model: 'gpt-5.5',
      durationMs: null,
      price: PLAIN,
      subagents: spend.unbilled(
        (model) => (model === 'gpt-mini' ? MINI : PLAIN),
        'gpt-5.5',
      ),
    });

    // Own 16,000 in + 50 out and thread B's 1,000 in at the parent's model;
    // thread A's 10,000 in + 100 out at the mini model's price.
    expect(usage.modelCosts).toEqual([
      { model: 'gpt-5.5', costUsd: (17_000 * 4 + 50 * 20) / 1e6 },
      { model: 'gpt-mini', costUsd: (10_000 * 1 + 100 * 5) / 1e6 },
    ]);
  });

  it('reports no split when a sub-agent that spent cannot be priced', () => {
    const spend = new CodexSubagentSpend();
    spend.record('S', reading([1_000, 0], [1_000, 0]));
    const latest = reading([36_000, 100], [16_000, 50]);

    const usage = turnUsageOf({
      latest,
      baseline: baselineOf(latest),
      model: 'gpt-5.5',
      durationMs: null,
      price: PLAIN,
      subagents: spend.unbilled(() => null, null),
    });
    expect(usage.modelCosts).toBeNull();
  });

  it('makes the sum unmeasured when a thread that spent cannot be priced', () => {
    const spend = new CodexSubagentSpend();
    spend.record('S', reading([1_000, 0], [1_000, 0]));
    expect(spend.unbilled(() => null, null)?.costUsd).toBeNull();
  });

  it('folds into a turn: tokens and dollars added, the window left the parent’s', () => {
    const latest = reading([36_000, 100], [16_000, 50]);
    const subagents = {
      ...spendBetween(
        reading([10_000, 100], [10_000, 100]),
        breakdown(0, 0),
        PLAIN,
      ),
      modelCosts: null,
    };
    const usage = turnUsageOf({
      latest,
      baseline: baselineOf(latest),
      model: 'gpt-5.5',
      durationMs: null,
      price: PLAIN,
      subagents,
    });
    expect(usage).toMatchObject({
      inputTokens: 16_000 + 10_000,
      outputTokens: 50 + 100,
      contextTokens: 16_050,
    });
    expect(usage.costUsd).toBeCloseTo(
      (16_000 * 4 + 50 * 20 + 10_000 * 4 + 100 * 20) / 1e6,
      10,
    );
  });

  it('keeps a priced total when a part moved nothing and could not be priced', () => {
    const moved = spendBetween(
      reading([1_000, 0], [1_000, 0]),
      breakdown(0, 0),
      PLAIN,
    );
    const idle = spendBetween(reading([0, 0], [0, 0]), breakdown(0, 0), null);
    expect(sumSpends([moved, idle])?.costUsd).toBeCloseTo(0.004, 10);
  });

  it('sums a delegate’s threads as its whole work, each priced at its own model', () => {
    const MINI: ModelPrice = { ...PLAIN, input: 1, output: 5 };
    const spend = new CodexSubagentSpend();
    spend.record('B', reading([1_000, 0], [1_000, 0]));
    spend.noteModel('A', 'gpt-mini');
    spend.record('A', reading([10_000, 100], [10_000, 100]));
    spend.record('A', reading([12_000, 150], [2_000, 50]));

    expect(
      spend.delegateFigures(
        ['A', 'B'],
        (model) => (model === 'gpt-mini' ? MINI : PLAIN),
        'gpt-parent',
      ),
    ).toEqual({
      requests: null,
      inputTokens: 12_000 + 1_000,
      outputTokens: 150,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextTokens: 2_050,
      model: 'gpt-mini',
      costUsd: null,
      estimatedCostUsd: (12_000 * 1 + 150 * 5 + 1_000 * 4) / 1e6,
    });
  });

  it('reads a delegate’s fresh input apart from what came from the cache', () => {
    const spend = new CodexSubagentSpend();
    spend.record('A', {
      total: breakdown(20_000, 100, 15_000),
      last: breakdown(20_000, 100, 15_000),
      modelContextWindow: null,
    });
    expect(spend.delegateFigures(['A'], () => PLAIN, null)).toMatchObject({
      inputTokens: 5_000,
      cacheReadTokens: 15_000,
      cacheCreationTokens: 0,
      outputTokens: 100,
      contextTokens: 20_100,
    });
  });

  it('skips a thread nobody has read, and states nothing while none has been', () => {
    const spend = new CodexSubagentSpend();
    expect(spend.delegateFigures(['A'], () => PLAIN, null)).toBeNull();
    spend.record('A', reading([1_000, 0], [1_000, 0]));
    expect(spend.delegateFigures(['A', 'X'], () => PLAIN, null)).toMatchObject({
      inputTokens: 1_000,
    });
  });

  it('leaves the estimate unmeasured when a thread that spent cannot be priced', () => {
    const spend = new CodexSubagentSpend();
    spend.record('A', reading([1_000, 0], [1_000, 0]));
    expect(spend.delegateFigures(['A'], () => null, null)).toMatchObject({
      inputTokens: 1_000,
      estimatedCostUsd: null,
    });
  });
});
