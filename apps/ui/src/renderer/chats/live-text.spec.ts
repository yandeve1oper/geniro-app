import { describe, expect, it } from 'vitest';

import {
  applyLiveText,
  CHAT_LIVE_KEY,
  formatLiveSpend,
  type LiveDelegateFigures,
  type LiveState,
  type LiveTextEvent,
  liveTextKey,
  OWNER_KEY_SEPARATOR,
  ownerOfKey,
  parseLiveText,
  partialOwnerKey,
} from './live-text';

const event = (over: Partial<LiveTextEvent> = {}): LiveTextEvent => ({
  runId: 'run-1',
  memberId: null,
  text: '',
  ownerKey: null,
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
  ...over,
});

describe('parseLiveText', () => {
  it('reads a well-formed delta off the untyped wire payload', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        memberId: 'node-a',
        text: 'hello',
        ownerKey: null,
        thinkingTokens: 120,
        thinkingStretch: 2,
        composingTool: null,
        composingBytes: null,
        contextTokens: 45_200,
        contextWindowTokens: 200_000,
        spentInputTokens: null,
        spentOutputTokens: null,
        spentCacheReadTokens: null,
        spentCostUsd: null,
      }),
    ).toEqual({
      runId: 'run-1',
      memberId: 'node-a',
      text: 'hello',
      ownerKey: null,
      thinkingTokens: 120,
      thinkingText: null,
      thinkingSince: null,
      thinkingStretch: 2,
      composingTool: null,
      composingBytes: null,
      contextTokens: 45_200,
      contextWindowTokens: 200_000,
      spentInputTokens: null,
      spentOutputTokens: null,
      spentCacheReadTokens: null,
      spentCostUsd: null,
    });
  });

  it('reads the part of the live spend geniro priced itself', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        memberId: null,
        text: '',
        spentCostUsd: 0.5,
        spentEstimatedCostUsd: 0.5,
      })?.spentEstimatedCostUsd,
    ).toBe(0.5);
    expect(
      parseLiveText({
        runId: 'run-1',
        memberId: null,
        text: '',
        spentCostUsd: 0.5,
      }),
    ).not.toHaveProperty('spentEstimatedCostUsd');
  });

  it('reads the reasoning TEXT a CLI that discloses its thinking sends', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        memberId: null,
        text: '',
        thinkingText: 'listing the primes',
        thinkingStretch: 1,
      })?.thinkingText,
    ).toBe('listing the primes');
  });

  it('reads an EMPTY reasoning text as none at all', () => {
    // '' and "this CLI redacts its thinking" are the same reading — neither has
    // anything to show — and letting the empty string through would draw a
    // reasoning bubble with no words in it.
    expect(
      parseLiveText({
        runId: 'run-1',
        memberId: null,
        text: '',
        thinkingText: '',
        thinkingStretch: 1,
      })?.thinkingText,
    ).toBeNull();
  });

  it('rejects a ZERO or negative number as "not reported"', () => {
    // A window of 0 is not a window: consumers read it as `?? DEFAULT`, which
    // passes 0 straight through into ContextMeter's divide. `agent-activity.ts`
    // rejects it on the durable-item path; without the same rule here the LIVE
    // path would leak one, which is the asymmetry this guard closes.
    const parsed = parseLiveText({
      runId: 'run-1',
      memberId: null,
      text: '',
      thinkingSince: -1,
      thinkingStretch: 0,
      composingTool: null,
      composingBytes: null,
      contextTokens: 0,
      contextWindowTokens: 0,
      spentInputTokens: null,
      spentOutputTokens: null,
      spentCacheReadTokens: null,
      spentCostUsd: null,
    });
    expect(parsed).toEqual({
      runId: 'run-1',
      memberId: null,
      text: '',
      ownerKey: null,
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
    });
  });

  it('KEEPS a zero token count — a stretch may not have spent any yet', () => {
    // The one field on this event whose zero is a real answer. Reading it as
    // "not reported" would hide the thinking row for exactly as long as the
    // agent had nothing to show for the wait; `thinkingStretch` is what says
    // whether the agent is thinking, so this field does not have to.
    const parsed = parseLiveText({
      runId: 'run-1',
      memberId: null,
      text: '',
      ownerKey: null,
      thinkingTokens: 0,
      thinkingStretch: 1,
    });
    expect(parsed?.thinkingTokens).toBe(0);
    expect(parsed?.thinkingStretch).toBe(1);
  });

  it('reads a running cost, and KEEPS its zero', () => {
    // Unlike a context figure, 0 here is a real reading: the turn's cost has
    // just been recorded and nothing is unrecorded any more.
    const base = { runId: 'run-1', memberId: null, text: '' };
    expect(parseLiveText({ ...base, spentCostUsd: 2.5 })?.spentCostUsd).toBe(
      2.5,
    );
    expect(parseLiveText({ ...base, spentCostUsd: 0 })?.spentCostUsd).toBe(0);
    expect(
      parseLiveText({ ...base, spentCostUsd: -1 })?.spentCostUsd,
    ).toBeNull();
  });

  it('rejects a payload with no run id, and a non-string node id', () => {
    expect(parseLiveText({ text: 'x' })).toBeNull();
    expect(parseLiveText(null)).toBeNull();
    expect(parseLiveText('not an object')).toBeNull();
    expect(
      parseLiveText({ runId: 'r', memberId: 42, text: 'x' })?.memberId,
    ).toBe(null);
  });
});

describe('applyLiveText', () => {
  const stored = (map: ReadonlyMap<string, LiveState>): LiveState | undefined =>
    map.get(CHAT_LIVE_KEY);

  it('KEEPS an entry that carries only a context figure', () => {
    // A context figure keeps arriving after the words go durable. Dropping the
    // entry then would blank the meter mid-turn — the entry is kept, and it is
    // `withLiveText` that declines to draw a bubble for it.
    const next = applyLiveText(new Map(), event({ contextTokens: 45_200 }));
    expect(stored(next)?.contextTokens).toBe(45_200);
  });

  it('KEEPS an entry whose only news is a running COST — the zero included', () => {
    // The zero is the reading that says the turn's cost just became durable.
    // Dropping the entry on it would leave nothing to REPLACE the last figure,
    // and a card adding the live figure to its recorded total would count the
    // same money twice.
    const costed = applyLiveText(new Map(), event({ spentCostUsd: 1.25 }));
    expect(stored(costed)?.spentCostUsd).toBe(1.25);

    expect(
      stored(applyLiveText(costed, event({ spentCostUsd: 0 })))?.spentCostUsd,
    ).toBe(0);
  });

  it('REMOVES an entry with nothing at all to say', () => {
    const seeded = applyLiveText(new Map(), event({ text: 'writing…' }));
    expect(stored(seeded)).toBeDefined();

    expect(stored(applyLiveText(seeded, event()))).toBeUndefined();
  });

  it('keeps an entry that has words, or an open reasoning stretch, alone', () => {
    expect(stored(applyLiveText(new Map(), event({ text: 'hi' })))?.text).toBe(
      'hi',
    );
    // Retention keys on the STRETCH, not the token count: a stretch that has
    // spent nothing yet is still a wait the transcript has to show, and
    // keying on tokens would drop it.
    const thinking = stored(
      applyLiveText(
        new Map(),
        event({ thinkingStretch: 1, thinkingTokens: 0 }),
      ),
    );
    expect(thinking?.thinkingStretch).toBe(1);
    expect(thinking?.thinkingTokens).toBe(0);
  });

  it('keys a graph node separately from the single-agent chat', () => {
    const next = applyLiveText(
      new Map(),
      event({ memberId: 'node-a', text: 'hi' }),
    );
    expect(next.get('node-a')?.text).toBe('hi');
    expect(next.get(CHAT_LIVE_KEY)).toBeUndefined();
  });
});

describe('the owner-key twin', () => {
  it('composes a node’s own turn as the bare node id', () => {
    expect(partialOwnerKey('reviewer', null)).toBe('reviewer');
  });

  it('composes a CALL thread with the separator the daemon publishes under', () => {
    expect(partialOwnerKey('reviewer', 'call-1')).toBe('reviewer::call-1');
  });

  it('reads the node back out of either shape', () => {
    expect(ownerOfKey(partialOwnerKey('reviewer', null))).toBe('reviewer');
    expect(ownerOfKey(partialOwnerKey('reviewer', 'call-1'))).toBe('reviewer');
  });

  it('keeps a node id that itself contains the separator whole', () => {
    // Splits at the FIRST separator, so a call id may contain one and a node id
    // may not. This pins THIS side only — a renderer assertion cannot see the
    // daemon's decomposer; `partial-stream.service.spec.ts` pins that one.
    expect(
      ownerOfKey(partialOwnerKey('reviewer', `a${OWNER_KEY_SEPARATOR}b`)),
    ).toBe('reviewer');
  });

  it('gives two calls of one node two entries', () => {
    // The defect the per-call key exists for: keyed by node alone the two
    // shared an entry and the last writer won, so a caller running the same
    // callee twice showed one ring flickering between two conversations.
    const first = applyLiveText(
      new Map(),
      event({
        memberId: 'a',
        ownerKey: partialOwnerKey('a', 'call-1'),
        text: 'one',
      }),
    );
    const both = applyLiveText(
      first,
      event({
        memberId: 'a',
        ownerKey: partialOwnerKey('a', 'call-2'),
        text: 'two',
      }),
    );

    expect(both.get('a::call-1')?.text).toBe('one');
    expect(both.get('a::call-2')?.text).toBe('two');
  });
});

describe('liveTextKey', () => {
  it("keys a 1:1 chat's delta by the sentinel, not by the owner key it carries", () => {
    // The drift this exists to stop: the daemon publishes `SINGLE_AGENT_NODE`
    // ('agent') as a chat's owner key, and the sentinel here was renamed away
    // from that very word. Every reader that has no event to derive a key from
    // — `workingAgents`, `awaitingAnswer`, the context meter's live source —
    // asks for the sentinel, so the two could never match. REPORTED as a chat
    // showing `Thinking…` and `Working…` at once, which is the working
    // fallback failing to see that the agent already had a live row.
    expect(liveTextKey(null, 'agent')).toBe(CHAT_LIVE_KEY);
    expect(liveTextKey(null, null)).toBe(CHAT_LIVE_KEY);
  });

  it('leaves a team node named `agent` as itself', () => {
    // The collision the sentinel was introduced for, and the reason the
    // discriminator is the NODE ID rather than the owner key's value: a node's
    // delta always carries its id, a chat's never does.
    expect(liveTextKey('agent', 'agent')).toBe('agent');
    expect(liveTextKey('agent', partialOwnerKey('agent', 'call-1'))).toBe(
      `agent${OWNER_KEY_SEPARATOR}call-1`,
    );
  });

  it('round-trips through the inverse for every shape', () => {
    // `ownerOfKey` is what turns a key back into a node, and a key the
    // inverse cannot read is one whose live row lands in a phantom block.
    expect(ownerOfKey(liveTextKey('node-a', 'node-a'))).toBe('node-a');
    expect(
      ownerOfKey(liveTextKey('node-a', partialOwnerKey('node-a', 'c1'))),
    ).toBe('node-a');
  });
});

describe('formatLiveSpend', () => {
  const unmeasured = {
    spentInputTokens: null,
    spentOutputTokens: null,
    spentCacheReadTokens: null,
    spentCostUsd: null,
  };

  it('draws NOTHING when neither half was measured', () => {
    // Every cursor turn, and every claude turn before its first request lands.
    // A `↑0 ↓0` there would be a figure nobody took.
    expect(formatLiveSpend(unmeasured)).toBeNull();
  });

  it('folds cache reads into the input side', () => {
    // The split is priced apart and reported apart, and it decides a BILL. On
    // this row it would be a third figure competing with the activity phrase
    // for one line, so the glance gets two arrows and the wire keeps three
    // fields.
    expect(
      formatLiveSpend({
        spentInputTokens: 1_200,
        spentOutputTokens: 340,
        spentCacheReadTokens: 58_800,
      }),
    ).toBe('↑60k ↓340');
  });

  it('draws a measured ZERO — it is what a turn that has produced nothing says', () => {
    // The distinction the whole plane is built on: 0 was measured, null was
    // not. A turn thinking its way through a long prompt has spent input and
    // produced nothing, and saying so is the point of a live row.
    expect(
      formatLiveSpend({
        spentInputTokens: 4_000,
        spentOutputTokens: 0,
        spentCacheReadTokens: null,
      }),
    ).toBe('↑4k ↓0');
  });

  it('states the half it has when the other is unmeasured', () => {
    expect(formatLiveSpend({ ...unmeasured, spentOutputTokens: 12 })).toBe(
      '↓12',
    );
    expect(formatLiveSpend({ ...unmeasured, spentInputTokens: 12 })).toBe(
      '↑12',
    );
  });
});

describe('parseLiveText — a tool call being written', () => {
  it('reads the tool and its byte count', () => {
    expect(
      parseLiveText({
        runId: 'run-1',
        text: '',
        composingTool: 'mcp__geniro-abc12345__show_artifact',
        composingBytes: 4096,
      }),
    ).toMatchObject({
      composingTool: 'mcp__geniro-abc12345__show_artifact',
      composingBytes: 4096,
    });
  });

  it('reads a ZERO byte count as measured', () => {
    // A composition's first published frame legitimately carries none; reading
    // that as "unmeasured" would blank the figure for exactly the moment the
    // loader appears.
    expect(
      parseLiveText({ runId: 'run-1', text: '', composingBytes: 0 }),
    ).toMatchObject({ composingBytes: 0 });
  });

  it('reads an empty or absent tool as nothing being composed', () => {
    // The NAME is the whole point of the field — it decides whether the wait is
    // worth a placeholder — so a blank one says nothing a reader could act on.
    expect(
      parseLiveText({ runId: 'run-1', text: '', composingTool: '' }),
    ).toMatchObject({ composingTool: null });
    expect(parseLiveText({ runId: 'run-1', text: '' })).toMatchObject({
      composingTool: null,
      composingBytes: null,
    });
  });
});

describe('applyLiveText — a composition keeps the entry alive', () => {
  it('keeps an agent that is writing a call but saying nothing else', () => {
    // A composition is emphatically "doing something" — it is the one stretch
    // of a turn where the agent produces nothing else at all, so dropping the
    // entry would remove the row precisely while its loader is wanted.
    const next = applyLiveText(
      new Map(),
      event({ composingTool: 'mcp__geniro-abc12345__show_artifact' }),
    );
    expect(next.get(CHAT_LIVE_KEY)).toMatchObject({
      composingTool: 'mcp__geniro-abc12345__show_artifact',
    });
  });

  it('drops the entry once the composition closes with nothing else to say', () => {
    const open = applyLiveText(
      new Map(),
      event({ composingTool: 'mcp__geniro-abc12345__show_artifact' }),
    );
    expect(applyLiveText(open, event()).has(CHAT_LIVE_KEY)).toBe(false);
  });
});

describe('delegates on the live plane', () => {
  const figures = (
    over: Partial<LiveDelegateFigures> = {},
  ): LiveDelegateFigures => ({
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
  });

  it('reads each delegate’s figures, and keeps a zero request count', () => {
    const parsed = parseLiveText({
      runId: 'run-1',
      memberId: 'node-a',
      ownerKey: 'node-a',
      text: '',
      delegates: { toolu_1: figures({ requests: 0 }) },
    });
    expect(parsed?.delegates).toEqual({ toolu_1: figures({ requests: 0 }) });
  });

  it('reads a non-finite or negative figure as unmeasured, and drops an entry that is not an object', () => {
    const parsed = parseLiveText({
      runId: 'run-1',
      text: '',
      delegates: {
        toolu_1: {
          requests: Number.NaN,
          inputTokens: -1,
          outputTokens: Number.POSITIVE_INFINITY,
          costUsd: 'x',
          model: '',
        },
        toolu_2: null,
        toolu_3: 'junk',
      },
    });
    expect(parsed?.delegates).toEqual({
      toolu_1: {
        requests: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        contextTokens: null,
        model: null,
        costUsd: null,
        estimatedCostUsd: null,
      },
    });
  });

  it('leaves the delegates out of the parse when the owner has none', () => {
    expect(parseLiveText({ runId: 'run-1', text: '' })).not.toHaveProperty(
      'delegates',
    );
    expect(
      parseLiveText({ runId: 'run-1', text: '', delegates: {} }),
    ).not.toHaveProperty('delegates');
  });

  it('replaces the owner’s whole set on every event, not only the delegates it names', () => {
    const first = applyLiveText(
      new Map(),
      event({
        memberId: 'node-a',
        ownerKey: 'node-a',
        delegates: { toolu_1: figures(), toolu_2: figures() },
      }),
    );
    const second = applyLiveText(
      first,
      event({
        memberId: 'node-a',
        ownerKey: 'node-a',
        delegates: { toolu_2: figures({ requests: 5 }) },
      }),
    );
    expect(second.get('node-a')?.delegates).toEqual({
      toolu_2: figures({ requests: 5 }),
    });
  });

  it('KEEPS an owner whose only news is a delegate still out', () => {
    const kept = applyLiveText(
      new Map(),
      event({
        memberId: 'node-a',
        ownerKey: 'node-a',
        delegates: { toolu_1: figures() },
      }),
    );
    expect(kept.has('node-a')).toBe(true);
  });

  it('REMOVES the owner once its delegates are gone and it has nothing else to say', () => {
    const kept = applyLiveText(
      new Map(),
      event({
        memberId: 'node-a',
        ownerKey: 'node-a',
        delegates: { toolu_1: figures() },
      }),
    );
    const cleared = applyLiveText(
      kept,
      event({ memberId: 'node-a', ownerKey: 'node-a' }),
    );
    expect(cleared.has('node-a')).toBe(false);
  });
});
