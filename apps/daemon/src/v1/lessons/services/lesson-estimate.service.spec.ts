import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it, vi } from 'vitest';

import type { ItemDao } from '../../agents/dao/item.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type {
  ModelPrice,
  ModelPriceRates,
} from '../../agents/utils/model-prices';
import type { MemoryService } from '../../memory/services/memory.service';
import type { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import type { ReflectionChoice } from '../utils/reflection-choice';
import { LessonEstimateService } from './lesson-estimate.service';

/** A guide of a known length, so the literals below are worked out by hand. */
vi.mock('../utils/lessons-reflection-guide', () => ({
  lessonsReflectionGuide: (memoryEnabled: boolean) =>
    'g'.repeat(memoryEnabled ? 396 : 96),
}));

const RATES: ModelPriceRates = {
  input: 3,
  output: 15,
  cacheRead: null,
  cacheWrite: null,
};

const SOURCE = {
  id: 'src',
  agentKind: AgentKind.Claude,
  configDir: null,
} as Pick<Run, 'id' | 'agentKind' | 'configDir'>;

function choiceOf(overrides: Partial<ReflectionChoice> = {}): ReflectionChoice {
  return {
    agentKind: AgentKind.Claude,
    model: null,
    effort: null,
    configDir: null,
    contextWindow: null,
    modelParameters: {},
    ...overrides,
  };
}

function build(
  options: {
    payloadChars?: number;
    rates?: ModelPriceRates | ModelPrice | null;
    resolveModel?: (model: string | null) => Promise<string | null>;
    memoryEnabled?: boolean;
  } = {},
) {
  const itemDao = {
    payloadCharsBetween: vi.fn(() =>
      Promise.resolve(options.payloadChars ?? 4_000),
    ),
  };
  const adapter = {
    resolveModel: vi.fn(
      options.resolveModel ??
        ((model: string | null) => Promise.resolve(model)),
    ),
    billingRatesOf: vi.fn(() =>
      options.rates === undefined ? RATES : options.rates,
    ),
  };
  const adapters = { for: vi.fn(() => adapter) };
  const em = { fork: () => em } as unknown as EntityManager;
  const service = new LessonEstimateService(
    em,
    itemDao as unknown as ItemDao,
    adapters as unknown as AgentAdapterRegistry,
    { enabled: options.memoryEnabled ?? true } as MemoryService,
  );
  return { service, itemDao, adapter, adapters };
}

describe('LessonEstimateService', () => {
  it('counts the stretch and the guide in characters, the CLI context on each of its passes, and the answer', async () => {
    const h = build({ payloadChars: 4_001 });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 3, toSeq: 9 },
      choiceOf(),
    );

    expect(h.itemDao.payloadCharsBetween).toHaveBeenCalledWith(
      'src',
      3,
      9,
      expect.anything(),
    );
    // (4 001 + 396) chars / 4 → 1 100 (rounded up); + 30 000 CLI context = 31 100, × 4 passes = 124 400; + 4 000 answer = 128 400.
    expect(estimate.tokens).toBe(128_400);
  });

  it('leaves the guide out of the count when the memory is off', async () => {
    const h = build({ payloadChars: 4_000, memoryEnabled: false });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf(),
    );

    // (4 000 + 96) chars / 4 = 1 024; + 30 000 CLI context = 31 024, × 4 passes = 124 096; + 4 000 answer = 128 096.
    expect(estimate.tokens).toBe(128_096);
  });

  it('prices the input and the answer at the list price of the model', async () => {
    const h = build({ payloadChars: 4_000 });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf(),
    );

    // 124 396 input tokens ((1 099 + 30 000) × 4 passes) at $3/M = $0.373188; 4 000 output tokens at $15/M = $0.06; total $0.433188.
    expect(h.adapter.billingRatesOf).toHaveBeenCalledWith(estimate.model);
    expect(estimate.usd).toBeCloseTo(0.433188, 10);
  });

  it('bills a pass over a context tier at the tier rate, and a pass under it at the base rate', async () => {
    const tiered: ModelPrice = {
      ...RATES,
      contextTokens: null,
      tiers: [
        {
          aboveContextTokens: 100_000,
          input: 6,
          output: 30,
          cacheRead: null,
          cacheWrite: null,
        },
      ],
    };

    const over = build({ payloadChars: 280_000, rates: tiered });
    const overEstimate = await over.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf(),
    );
    // 280 396 chars / 4 = 70 099; + 30 000 CLI context = 100 099 prompt tokens, past the 100 000 tier, × 4 passes = 400 396 input at $6/M = $2.402376; 4 000 output at $30/M = $0.12.
    expect(overEstimate.usd).toBeCloseTo(2.522376, 10);

    const under = build({ payloadChars: 279_000, rates: tiered });
    const underEstimate = await under.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf(),
    );
    // 279 396 chars / 4 = 69 849; + 30 000 = 99 849 prompt tokens, not past the tier, × 4 passes = 399 396 input at $3/M = $1.198188; 4 000 output at $15/M = $0.06.
    expect(underEstimate.usd).toBeCloseTo(1.258188, 10);
  });

  it('answers a null price when the model has no list price, never 0', async () => {
    const h = build({ rates: null });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf(),
    );

    expect(estimate.usd).toBeNull();
    expect(estimate.tokens).toBeGreaterThan(0);
  });

  it('shows the model the adapter resolves the choice to, with the choice’s profile', async () => {
    const h = build({
      resolveModel: (model) =>
        Promise.resolve(model === 'haiku' ? 'claude-haiku-5-5' : model),
    });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf({ model: 'haiku', configDir: '/cfg/claude' }),
    );

    expect(h.adapter.resolveModel).toHaveBeenCalledWith('haiku', '/cfg/claude');
    expect(estimate.model).toBe('claude-haiku-5-5');
  });

  it('shows the chosen model when the adapter cannot resolve it', async () => {
    const h = build({
      resolveModel: () => Promise.reject(new Error('no catalog')),
    });

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf({ model: 'haiku' }),
    );

    expect(estimate.model).toBe('haiku');
  });

  it('prices the CLI the choice names, not the thread’s own', async () => {
    const h = build();

    const estimate = await h.service.estimate(
      SOURCE,
      { fromSeq: 0, toSeq: 5 },
      choiceOf({ agentKind: AgentKind.Codex, model: 'gpt-6-luna' }),
    );

    expect(h.adapters.for).toHaveBeenCalledWith(AgentKind.Codex);
    expect(h.adapter.resolveModel).toHaveBeenCalledWith('gpt-6-luna', null);
    expect(estimate.agentKind).toBe(AgentKind.Codex);
  });
});
