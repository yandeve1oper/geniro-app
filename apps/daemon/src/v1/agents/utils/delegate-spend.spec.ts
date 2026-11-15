import { describe, expect, it } from 'vitest';

import type { DelegateFigures } from '../adapters/adapter.types';
import { readDelegateSpend, writeDelegateSpend } from './delegate-spend';

const figures = (
  overrides: Partial<DelegateFigures> = {},
): DelegateFigures => ({
  requests: 4,
  inputTokens: 2_000,
  outputTokens: 800,
  cacheReadTokens: 30_000,
  cacheCreationTokens: 1_000,
  contextTokens: 31_000,
  model: 'claude-haiku-5-5',
  costUsd: 0.02,
  estimatedCostUsd: 0.019,
  ...overrides,
});

describe('readDelegateSpend', () => {
  it('reads a column that was never written as no delegates', () => {
    expect(readDelegateSpend(null)).toEqual(new Map());
    expect(readDelegateSpend('')).toEqual(new Map());
  });

  it('reads text that is not JSON as no delegates, rather than failing the run', () => {
    expect(readDelegateSpend('{"call-1": ')).toEqual(new Map());
  });

  it('reads a JSON value that is not an object as no delegates', () => {
    expect(readDelegateSpend('[{"requests": 2}]')).toEqual(new Map());
    expect(readDelegateSpend('"call-1"')).toEqual(new Map());
  });

  it('drops an entry whose value is not an object', () => {
    expect(readDelegateSpend('{"call-1": 3}')).toEqual(new Map());
  });

  it('drops an entry with no figure, even when it names a model', () => {
    expect(
      readDelegateSpend(
        '{"call-1": {"model": "claude-haiku-5-5"}, "call-2": {"requests": 1}}',
      ),
    ).toEqual(
      new Map([
        [
          'call-2',
          figures({
            requests: 1,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            contextTokens: null,
            model: null,
            costUsd: null,
            estimatedCostUsd: null,
          }),
        ],
      ]),
    );
  });

  it('drops an entry under an empty id', () => {
    expect(readDelegateSpend('{"": {"requests": 2}}')).toEqual(new Map());
  });

  it('reads a negative or non-numeric figure as not measured, and keeps the rest of the entry', () => {
    const read = readDelegateSpend(
      '{"call-1": {"requests": -2, "inputTokens": "12", "costUsd": -1, "outputTokens": 7}}',
    );

    expect(read.get('call-1')).toEqual({
      requests: null,
      inputTokens: null,
      outputTokens: 7,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      contextTokens: null,
      model: null,
      costUsd: null,
      estimatedCostUsd: null,
    });
  });
});

describe('writeDelegateSpend', () => {
  it('writes no text when there is nothing to keep', () => {
    expect(writeDelegateSpend(new Map())).toBeNull();
  });

  it('writes no text when every entry has no figure', () => {
    expect(
      writeDelegateSpend(
        new Map([
          [
            'call-1',
            figures({
              requests: null,
              inputTokens: null,
              outputTokens: null,
              cacheReadTokens: null,
              cacheCreationTokens: null,
              contextTokens: null,
              costUsd: null,
              estimatedCostUsd: null,
            }),
          ],
        ]),
      ),
    ).toBeNull();
  });

  it('writes the entries with a figure in sorted id order, so an unchanged set always writes the same text', () => {
    const inOrder = writeDelegateSpend(
      new Map([
        ['call-1', figures({ requests: 1 })],
        ['call-2', figures({ requests: 2 })],
      ]),
    );
    const reversed = writeDelegateSpend(
      new Map([
        ['call-2', figures({ requests: 2 })],
        ['call-1', figures({ requests: 1 })],
      ]),
    );

    expect(inOrder).toBe(reversed);
    expect(Object.keys(JSON.parse(inOrder ?? '{}'))).toEqual([
      'call-1',
      'call-2',
    ]);
  });

  it('leaves out an entry with no figure, and keeps the others', () => {
    const text = writeDelegateSpend(
      new Map([
        [
          'call-1',
          figures({
            requests: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            contextTokens: null,
            costUsd: null,
            estimatedCostUsd: null,
          }),
        ],
        ['call-2', figures({ requests: 2 })],
      ]),
    );

    expect(Object.keys(JSON.parse(text ?? '{}'))).toEqual(['call-2']);
  });

  it('writes a negative figure as not measured, never as a smaller total', () => {
    const text = writeDelegateSpend(
      new Map([['call-1', figures({ requests: 2, costUsd: -3 })]]),
    );

    expect(JSON.parse(text ?? '{}')).toMatchObject({
      'call-1': { requests: 2, costUsd: null },
    });
  });

  it('reads back exactly what it wrote', () => {
    const written = new Map([
      ['call-1', figures({ requests: 2, model: null })],
      ['call-2', figures({ costUsd: null, estimatedCostUsd: 0.5 })],
    ]);

    expect(readDelegateSpend(writeDelegateSpend(written))).toEqual(written);
  });
});
