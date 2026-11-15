import { createElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  type LiveDelegateFigures,
  LiveDelegatesContext,
  type LiveState,
  partialOwnerKey,
  useLiveDelegates,
} from './live-text';
import {
  subagentFiguresView,
  useSubagentLiveFigures,
} from './subagent-figures';
import type { SubagentBlockEntry } from './transcript-groups';

function block(over: Partial<SubagentBlockEntry> = {}): SubagentBlockEntry {
  return {
    type: 'subagent-block',
    id: 'task-1',
    createdAt: 'now',
    memberId: null,
    callId: null,
    kind: 'code-reviewer',
    label: 'Review the diff',
    prompt: null,
    returned: true,
    backgroundOpen: null,
    backgroundOutcome: null,
    recoverable: false,
    processEnded: false,
    failed: false,
    result: null,
    resultIsOwn: true,
    model: null,
    durationMs: null,
    tokens: null,
    toolUses: null,
    costUsd: null,
    estimatedCostUsd: null,
    requests: null,
    contextTokens: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    cumulative: false,
    messages: null,
    stepsUnavailableReason: null,
    lastRowAt: null,
    entries: [],
    ...over,
  };
}

function figures(over: Partial<LiveDelegateFigures> = {}): LiveDelegateFigures {
  return {
    requests: 2,
    inputTokens: 4_000,
    outputTokens: 300,
    cacheReadTokens: 12_000,
    cacheCreationTokens: 0,
    contextTokens: 16_000,
    model: 'claude-sonnet-5-5',
    costUsd: 0.04,
    estimatedCostUsd: 0.05,
    ...over,
  };
}

function liveState(delegates?: LiveState['delegates']): LiveState {
  return {
    text: '',
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

describe('subagentFiguresView', () => {
  it('draws the live figures of a delegate still working, over its block’s own', () => {
    const view = subagentFiguresView(
      block({
        returned: false,
        cumulative: true,
        requests: 2,
        inputTokens: 200,
      }),
      figures({ requests: 5, inputTokens: 900 }),
    );

    expect(view).toMatchObject({ requests: 5, inputTokens: 900, live: true });
  });

  it('keeps a finished delegate’s durable figures over a live reading still standing', () => {
    const view = subagentFiguresView(
      block({
        returned: true,
        cumulative: true,
        requests: 4,
        inputTokens: 400,
      }),
      figures({ requests: 9, inputTokens: 900 }),
    );

    expect(view).toMatchObject({
      requests: 4,
      inputTokens: 400,
      live: false,
    });
  });

  it('ignores a live reading a stopped delegate left standing, and keeps its durable figures', () => {
    const view = subagentFiguresView(
      block({
        returned: true,
        backgroundOutcome: 'stopped',
        cumulative: true,
        requests: 4,
        inputTokens: 400,
      }),
      figures({ requests: 9, inputTokens: 900 }),
    );

    expect(view).toMatchObject({ requests: 4, inputTokens: 400, live: false });
  });

  it('ignores a live reading an untracked old row left standing, and reads it as its context at the end', () => {
    const view = subagentFiguresView(
      block({
        returned: true,
        daemonStatus: 'untracked',
        cumulative: false,
        tokens: 26_124,
      }),
      figures({ requests: 9, inputTokens: 900, contextTokens: 16_000 }),
    );

    expect(view).toMatchObject({
      requests: null,
      inputTokens: null,
      contextTokens: null,
      contextAtEnd: 26_124,
      live: false,
    });
  });

  it('fills a field the live reading does not state from a cumulative block, and never reads it as zero', () => {
    const view = subagentFiguresView(
      block({
        returned: false,
        cumulative: true,
        requests: 2,
        contextTokens: 1_200,
      }),
      figures({ requests: 3, contextTokens: null }),
    );

    expect(view).toMatchObject({ requests: 3, contextTokens: 1_200 });
  });

  it('reads an old row as its last request only: the context at the end, and nothing else as measured', () => {
    const view = subagentFiguresView(
      block({
        returned: true,
        cumulative: false,
        tokens: 26_124,
        requests: 7,
        inputTokens: 25_000,
        costUsd: 0.5,
        messages: 3,
      }),
      null,
    );

    expect(view).toMatchObject({
      contextAtEnd: 26_124,
      requests: null,
      tokensProcessed: null,
      inputTokens: null,
      costUsd: null,
      messages: 3,
      live: false,
    });
  });

  it('does not show an old row’s context at the end while a live reading stands', () => {
    const view = subagentFiguresView(
      block({ returned: false, cumulative: false, tokens: 26_124 }),
      figures(),
    );

    expect(view).toMatchObject({ live: true, contextAtEnd: null });
  });

  it('states no cost for a delegate with no price, and marks a list-price cost as an estimate', () => {
    expect(
      subagentFiguresView(
        block({ cumulative: true, costUsd: null, estimatedCostUsd: null }),
        null,
      ).costUsd,
    ).toBeNull();

    expect(
      subagentFiguresView(
        block({ cumulative: true, costUsd: null, estimatedCostUsd: 0.45 }),
        null,
      ),
    ).toMatchObject({ costUsd: 0.45, costIsEstimate: true });

    expect(
      subagentFiguresView(
        block({ cumulative: true, costUsd: 0.4, estimatedCostUsd: 0.45 }),
        null,
      ),
    ).toMatchObject({ costUsd: 0.4, costIsEstimate: false });
  });

  it('marks a cost read off the live channel as an estimate, whatever the block says', () => {
    const view = subagentFiguresView(
      block({ returned: false, cumulative: true, costUsd: 0.4 }),
      figures({ costUsd: 0.6, estimatedCostUsd: 0.65 }),
    );

    expect(view).toMatchObject({ costUsd: 0.6, costIsEstimate: true });
  });

  it('shows a codex delegate’s tokens with no request count, and leaves its unmeasured cache legs out of the total', () => {
    const view = subagentFiguresView(
      block({ returned: false, cumulative: true }),
      figures({
        requests: null,
        inputTokens: 1_000,
        outputTokens: 50,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        contextTokens: 1_000,
      }),
    );

    expect(view).toMatchObject({
      requests: null,
      tokensProcessed: 1_050,
      inputTokens: 1_000,
      outputTokens: 50,
      live: true,
    });
  });

  it('shows only the message count for a cursor delegate, which reports no figures', () => {
    expect(
      subagentFiguresView(block({ returned: true, messages: 3 }), null),
    ).toEqual({
      requests: null,
      messages: 3,
      tokensProcessed: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      contextTokens: null,
      costUsd: null,
      costIsEstimate: false,
      contextAtEnd: null,
      live: false,
    });
  });

  it('keeps a measured zero, and leaves a leg it did not measure out of the total', () => {
    const view = subagentFiguresView(
      block({
        returned: true,
        cumulative: true,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: null,
      }),
      null,
    );

    expect(view).toMatchObject({
      requests: 0,
      inputTokens: 0,
      cacheReadTokens: null,
      tokensProcessed: 0,
    });
  });
});

describe('useSubagentLiveFigures', () => {
  function PlaneProvider({
    plane,
    children,
  }: {
    plane: ReadonlyMap<string, LiveState> | null;
    children?: ReactNode;
  }): ReactElement {
    const delegates = useLiveDelegates(plane);
    return createElement(
      LiveDelegatesContext.Provider,
      { value: delegates },
      children,
    );
  }

  function Probe({
    id,
    into,
  }: {
    id: string;
    into: (figures: LiveDelegateFigures | null) => void;
  }): null {
    into(useSubagentLiveFigures(id));
    return null;
  }

  function liveFor(
    id: string,
    plane: ReadonlyMap<string, LiveState> | null,
  ): LiveDelegateFigures | null {
    const seen: (LiveDelegateFigures | null)[] = [];
    renderToStaticMarkup(
      createElement(
        PlaneProvider,
        { plane },
        createElement(Probe, { id, into: (found) => seen.push(found) }),
      ),
    );
    return seen[0] ?? null;
  }

  it('finds a delegate launched under one of a node’s call threads, not only under its own turn', () => {
    const plane = new Map<string, LiveState>([
      ['node-a', liveState({ toolu_1: figures({ requests: 1 }) })],
      [
        partialOwnerKey('node-a', 'call-2'),
        liveState({ toolu_2: figures({ requests: 7 }) }),
      ],
    ]);

    expect(liveFor('toolu_2', plane)?.requests).toBe(7);
    expect(liveFor('toolu_1', plane)?.requests).toBe(1);
  });

  it('answers null for a delegate no owner holds, and outside any provider', () => {
    const plane = new Map<string, LiveState>([
      ['node-a', liveState({ toolu_1: figures() })],
    ]);

    expect(liveFor('toolu_9', plane)).toBeNull();
    expect(liveFor('toolu_1', null)).toBeNull();
  });

  it('does not match an inherited object key', () => {
    const plane = new Map<string, LiveState>([
      ['node-a', liveState({ toolu_1: figures() })],
    ]);

    expect(liveFor('constructor', plane)).toBeNull();
  });
});
