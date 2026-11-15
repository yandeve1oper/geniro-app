// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type LiveDelegateFigures,
  type LiveDelegates,
  type LiveState,
  useLiveDelegates,
} from './live-text';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function stateOf(
  text: string,
  delegates: LiveDelegates | null = null,
): LiveState {
  return {
    text,
    thinkingTokens: null,
    thinkingText: null,
    thinkingSince: null,
    thinkingStretch: null,
    composingTool: null,
    composingBytes: null,
    contextTokens: null,
    contextWindowTokens: null,
    spentInputTokens: null,
    spentOutputTokens: null,
    spentCacheReadTokens: null,
    spentCostUsd: null,
    delegates,
  };
}

function figures(over: Partial<LiveDelegateFigures> = {}): LiveDelegateFigures {
  return {
    requests: 1,
    inputTokens: 100,
    outputTokens: 5,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    contextTokens: 100,
    model: 'claude-opus-5',
    costUsd: null,
    estimatedCostUsd: 0.01,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useLiveDelegates', () => {
  /** Renders the hook over each plane in turn, and returns every map it gave. */
  function mapsOver(
    planes: (ReadonlyMap<string, LiveState> | null)[],
  ): (ReadonlyMap<string, LiveDelegateFigures> | null)[] {
    const maps: (ReadonlyMap<string, LiveDelegateFigures> | null)[] = [];
    function Probe({
      plane,
    }: {
      plane: ReadonlyMap<string, LiveState> | null;
    }): null {
      maps.push(useLiveDelegates(plane));
      return null;
    }
    for (const plane of planes) {
      act(() => root.render(<Probe plane={plane} />));
    }
    return maps;
  }

  it('hands back the same map through a text delta that moves no delegate figure', () => {
    const before = new Map([
      ['agent', stateOf('hello', { 'toolu_1': figures({ requests: 2 }) })],
    ]);
    const streamed = new Map([
      [
        'agent',
        stateOf('hello, streamed on', { 'toolu_1': figures({ requests: 2 }) }),
      ],
    ]);

    const [first, second] = mapsOver([before, streamed]);

    expect(first?.get('toolu_1')?.requests).toBe(2);
    expect(second).toBe(first);
  });

  it('hands back a new map once a delegate figure changes', () => {
    const before = new Map([
      ['agent', stateOf('hello', { 'toolu_1': figures({ requests: 2 }) })],
    ]);
    const counted = new Map([
      ['agent', stateOf('hello', { 'toolu_1': figures({ requests: 3 }) })],
    ]);

    const [first, second] = mapsOver([before, counted]);

    expect(second).not.toBe(first);
    expect(second?.get('toolu_1')?.requests).toBe(3);
  });

  it('gathers a delegate from any owner of the plane, and is null outside one', () => {
    const plane = new Map([
      ['agent', stateOf('', { 'toolu_1': figures({ requests: 1 }) })],
      ['agent::call-2', stateOf('', { 'toolu_2': figures({ requests: 7 }) })],
    ]);

    const [found, outside] = mapsOver([plane, null]);

    expect(found?.get('toolu_1')?.requests).toBe(1);
    expect(found?.get('toolu_2')?.requests).toBe(7);
    expect(outside).toBeNull();
  });
});
