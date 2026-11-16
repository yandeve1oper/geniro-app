import { describe, expect, it } from 'vitest';

import { billedModelOf } from './billed-model';

describe('billedModelOf', () => {
  it('names the model the cost split charged most across the turns', () => {
    expect(
      billedModelOf([
        {
          usage: {
            contextModel: 'claude-haiku-5-5',
            modelCosts: [
              { model: 'claude-haiku-5-5', costUsd: 0.01 },
              { model: 'claude-sonnet-5-5', costUsd: 0.05 },
            ],
          },
        },
        {
          usage: {
            contextModel: 'claude-haiku-5-5',
            modelCosts: [{ model: 'claude-haiku-5-5', costUsd: 0.03 }],
          },
        },
      ]),
    ).toBe('claude-sonnet-5-5');
  });

  it('falls back to the model a turn named itself as running', () => {
    expect(
      billedModelOf([{ usage: { contextModel: 'gpt-5.5', modelCosts: null } }]),
    ).toBe('gpt-5.5');
  });

  it('answers null when no turn reported a model', () => {
    expect(billedModelOf([])).toBeNull();
    expect(billedModelOf([{ usage: { costUsd: 0.2 } }, null, 'x'])).toBeNull();
  });
});
