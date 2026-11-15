import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DelegateFigures } from '../adapters/adapter.types';
import type { RunDeltaEvent } from '../chat.types';
import { FakeContextWindowStore } from './__tests__/fake-context-window-store';
import { FakeDelegateSpendStore } from './__tests__/fake-delegate-spend-store';
import { FakeUnrecordedSpendStore } from './__tests__/fake-unrecorded-spend-store';
import type { AgentEventBus } from './agent-events.bus';
import {
  OWNER_KEY_SEPARATOR,
  ownerOfKey,
  partialOwnerKey,
  PartialStreamService,
} from './partial-stream.service';

const RUN = 'run-1';
const OWNER = 'agent';
const AGENT = 'claude';

let published: RunDeltaEvent[];
let service: PartialStreamService;
let windowStore: FakeContextWindowStore;
let spendStore: FakeUnrecordedSpendStore;
let delegateStore: FakeDelegateSpendStore;

beforeEach(() => {
  published = [];
  const bus = {
    publishDelta: (event: RunDeltaEvent) => published.push(event),
  } as unknown as AgentEventBus;
  windowStore = new FakeContextWindowStore();
  spendStore = new FakeUnrecordedSpendStore();
  delegateStore = new FakeDelegateSpendStore();
  service = new PartialStreamService(
    bus,
    windowStore.asStore(),
    spendStore.asStore(),
    delegateStore.asStore(),
  );
});

/** The most recent event on the wire. */
function last(): RunDeltaEvent {
  return published[published.length - 1]!;
}

function figuresWith(
  overrides: Partial<DelegateFigures> = {},
): DelegateFigures {
  return {
    requests: 3,
    inputTokens: 1_200,
    outputTokens: 340,
    cacheReadTokens: 9_000,
    cacheCreationTokens: 500,
    contextTokens: 9_700,
    model: 'claude-haiku-5-5',
    costUsd: 0.012,
    estimatedCostUsd: 0.011,
    ...overrides,
  };
}

describe('PartialStreamService — delegate figures', () => {
  it('replaces a delegate’s entry: the last reading for its id wins', () => {
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ requests: 1 }),
      final: false,
    });
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ requests: 2 }),
      final: false,
    });

    expect(last().delegates).toEqual({
      'call-1': figuresWith({ requests: 2 }),
    });
  });

  it('keeps delegates apart by id', () => {
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ requests: 1 }),
      final: false,
    });
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-2',
      figures: figuresWith({ requests: 5 }),
      final: false,
    });

    expect(last().delegates).toEqual({
      'call-1': figuresWith({ requests: 1 }),
      'call-2': figuresWith({ requests: 5 }),
    });
  });

  it('never moves the owner’s own spend', () => {
    service.cost(RUN, OWNER, null, 1.5, 1.5);

    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ costUsd: 9, estimatedCostUsd: 9 }),
      final: false,
    });

    expect(last()).toMatchObject({
      spentCostUsd: 1.5,
      spentEstimatedCostUsd: 1.5,
    });
  });

  it('publishes nothing for a reading equal to the one held', () => {
    const figures = figuresWith();
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures,
      final: false,
    });
    const before = published.length;

    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: { ...figures },
      final: false,
    });

    expect(published).toHaveLength(before);
  });

  it('hands every change to the durable store, and a final reading even when unchanged', () => {
    const write = vi.spyOn(delegateStore, 'set');
    const figures = figuresWith();

    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures,
      final: false,
    });
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: { ...figures },
      final: true,
    });

    expect(write.mock.calls).toEqual([
      [RUN, 'call-1', figures, false],
      [RUN, 'call-1', figures, true],
    ]);
    expect(delegateStore.of(RUN)).toEqual({ 'call-1': figures });
  });

  it('takes an ENDED delegate off the live plane, leaving the running ones', () => {
    const figures = figuresWith();
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures,
      final: false,
    });
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-2',
      figures,
      final: false,
    });

    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures,
      final: true,
    });

    expect(published.at(-1)?.delegates).toEqual({ 'call-2': figures });
    expect(delegateStore.of(RUN)).toEqual({
      'call-1': figures,
      'call-2': figures,
    });
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-2',
      figures,
      final: true,
    });
    expect(published.at(-1)?.delegates).toBeUndefined();
  });

  it('an unchanged, non-final reading does not reach the store again', () => {
    const write = vi.spyOn(delegateStore, 'set');
    const figures = figuresWith();
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures,
      final: false,
    });

    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: { ...figures },
      final: false,
    });

    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a store that fails does not fail the turn', () => {
    vi.spyOn(delegateStore, 'set').mockImplementation(() => {
      throw new Error('database is gone');
    });

    expect(() =>
      service.delegate(RUN, OWNER, null, {
        delegateId: 'call-1',
        figures: figuresWith(),
        final: false,
      }),
    ).not.toThrow();
  });

  it('appears in the snapshot a client joining mid-run is handed', () => {
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ requests: 4 }),
      final: false,
    });

    const owned = service.snapshot(RUN).find((e) => e.ownerKey === OWNER);
    expect(owned?.delegates).toEqual({
      'call-1': figuresWith({ requests: 4 }),
    });
  });

  it('carries no delegates key for an owner that has launched none', () => {
    service.append(RUN, OWNER, null, 'words');

    expect(last()).not.toHaveProperty('delegates');
  });

  it('keeps an owner’s delegates across its turn boundary, so the next event does not blank them', () => {
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith({ requests: 2 }),
      final: false,
    });

    service.clearRun(RUN);
    service.append(RUN, OWNER, null, 'next turn');

    expect(last()).toMatchObject({ text: 'next turn' });
    expect(last().delegates).toEqual({
      'call-1': figuresWith({ requests: 2 }),
    });
  });

  it('keeps the delegates when a tail is taken for a cancelled turn', () => {
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith(),
      final: false,
    });
    service.append(RUN, OWNER, null, 'half a sentence');

    expect(service.takeTail(RUN, OWNER, null)).toBe('half a sentence');

    const owned = service.snapshot(RUN).find((e) => e.ownerKey === OWNER);
    expect(owned?.delegates).toEqual({ 'call-1': figuresWith() });
  });

  it('asks the store to write what is pending at the turn boundary, and drops nothing it holds', () => {
    const flush = vi.spyOn(delegateStore, 'flushRun');
    service.delegate(RUN, OWNER, null, {
      delegateId: 'call-1',
      figures: figuresWith(),
      final: false,
    });

    service.clearRun(RUN);

    expect(flush).toHaveBeenCalledWith(RUN);
    expect(delegateStore.of(RUN)).toEqual({ 'call-1': figuresWith() });
  });
});

describe('PartialStreamService — thinking is scoped to ONE stretch', () => {
  it('starts a new stretch, with its own count, after the agent writes', () => {
    // The CLI's `estimated_tokens` restarts per reasoning stretch and so does
    // the row: a turn that thinks, writes, then thinks again is two separate
    // waits. Carrying the first stretch's total into the second is what made
    // one endless "thinking" row whose number never returned to zero.
    service.thinking(RUN, OWNER, null, 300);
    expect(last().thinkingTokens).toBe(300);
    expect(last().thinkingStretch).toBe(1);

    service.append(RUN, OWNER, null, 'some words');
    expect(last().thinkingTokens).toBeNull(); // not reasoning right now
    expect(last().thinkingStretch).toBeNull();

    service.thinking(RUN, OWNER, null, 120);
    expect(last().thinkingTokens).toBe(120);
    expect(last().thinkingStretch).toBe(2);
  });

  it('more deltas about the SAME stretch keep its identity and its clock', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      service.thinking(RUN, OWNER, null, 10);
      const started = last().thinkingSince;
      expect(started).toBe(Date.parse('2026-07-29T00:00:00Z'));

      // No `append` between them, so the stretch never closed — the anchor must
      // not move, or the row's elapsed time would restart on every delta.
      vi.setSystemTime(new Date('2026-07-29T00:00:30Z'));
      service.thinking(RUN, OWNER, null, 40);
      expect(last().thinkingSince).toBe(started);
      expect(last().thinkingStretch).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a REOPENED stretch gets a fresh clock, not the previous one', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-29T00:00:00Z'));
      service.thinking(RUN, OWNER, null, 10);

      // Words closed the stretch; the next one is a new wait and its elapsed
      // time starts now. Reading 30s here is the "it never cleans the time"
      // defect this reset exists to fix.
      vi.setSystemTime(new Date('2026-07-29T00:00:30Z'));
      service.append(RUN, OWNER, null, 'words');
      service.thinking(RUN, OWNER, null, 5);
      expect(last().thinkingSince).toBe(Date.parse('2026-07-29T00:00:30Z'));
      expect(last().thinkingStretch).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes no thinking anchor while the agent is writing', () => {
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'words');
    expect(last().thinkingSince).toBeNull();
    expect(last().thinkingStretch).toBeNull();
  });

  it('a durable message closes the stretch but does not restart the counter', () => {
    // `retire` fires per message, and a turn routinely lands several. The
    // stretch counter is what tells the NEXT stretch apart from this one, so
    // resetting it here would give two different waits the same identity.
    service.thinking(RUN, OWNER, null, 300);
    service.append(RUN, OWNER, null, 'first paragraph');
    service.retire(RUN, OWNER, null);
    expect(last().text).toBe('');

    service.thinking(RUN, OWNER, null, 50);
    expect(last().thinkingTokens).toBe(50);
    expect(last().thinkingStretch).toBe(2);
  });

  it('a tool call ends the stretch, even though it carries no words', () => {
    // Probe-measured on claude 2.1.222: a model that thinks and then calls a
    // tool with nothing to say first emits no text delta at all, so `append`
    // never fires and the row claimed "Thinking… 74 tokens" for the whole
    // command (3.5s on that turn; a `sleep 40` would hold it for 40).
    service.thinking(RUN, OWNER, null, 74);
    expect(last().thinkingStretch).toBe(1);

    service.endThinking(RUN, OWNER, null);

    expect(last().thinkingTokens).toBeNull();
    expect(last().thinkingStretch).toBeNull();
  });

  it('the tool call’s NEXT stretch is a new row, not a continuation', () => {
    // The second half of the same defect: with the stretch left open, the
    // CLI's next reasoning merged into it, so a fresh wait inherited the
    // previous one's clock and token count instead of starting over.
    service.thinking(RUN, OWNER, null, 74);
    service.endThinking(RUN, OWNER, null);

    service.thinking(RUN, OWNER, null, 50);

    expect(last().thinkingStretch).toBe(2);
    expect(last().thinkingTokens).toBe(50);
  });

  it('ending a stretch that is already closed puts nothing on the wire', () => {
    // It is called on EVERY durable event, so a turn of a hundred tool rows
    // must not mean a hundred identical events.
    service.thinking(RUN, OWNER, null, 10);
    service.endThinking(RUN, OWNER, null);
    const count = published.length;

    service.endThinking(RUN, OWNER, null);
    service.endThinking(RUN, OWNER, null);

    expect(published).toHaveLength(count);
  });

  it('the TURN boundary resets it', () => {
    service.thinking(RUN, OWNER, null, 300);
    service.clearRun(RUN);
    service.thinking(RUN, OWNER, null, 25);
    expect(last().thinkingTokens).toBe(25);
    expect(last().thinkingStretch).toBe(1);
  });

  it('still closes the stretch past the 64 KB cap', () => {
    // The cap's early return used to skip the thinking null-out too; the
    // accounting must not silently stop just because the tail is full.
    service.thinking(RUN, OWNER, null, 10);
    service.append(RUN, OWNER, null, 'x'.repeat(64 * 1024 + 10));
    const capped = last().text.length;
    expect(capped).toBe(64 * 1024);
    // The words ended the stretch, so the live indicator clears — this is the
    // assertion the title promises, and without it the cap's early return
    // left the stretch open: past 64 KB the "thinking" row never cleared again
    // for that agent.
    expect(last().thinkingTokens).toBeNull();

    // A second stretch still opens while capped, rather than being lost.
    service.thinking(RUN, OWNER, null, 7);
    expect(last().thinkingTokens).toBe(7);
    expect(last().thinkingStretch).toBe(2);

    service.append(RUN, OWNER, null, 'more');
    expect(last().text.length).toBe(capped);
    expect(last().thinkingTokens).toBeNull();
  });

  it('reports a stretch that has spent no tokens yet, rather than hiding it', () => {
    // A stretch's first delta can carry 0. The row must still appear — the
    // wait is the thing being shown, and `thinkingStretch` is what says it is
    // happening, so a zero count cannot be mistaken for "not thinking".
    service.thinking(RUN, OWNER, null, 0);
    expect(last().thinkingTokens).toBe(0);
    expect(last().thinkingStretch).toBe(1);
    expect(last().thinkingSince).not.toBeNull();
  });

  it('does not re-publish the capped tail for deltas that change nothing', () => {
    // The cap exists to stop pushing an unbounded string across the wire on
    // every delta. Closing the stretch there must not reinstate that: with no
    // stretch open, a further delta has nothing new to say and a 64 KB
    // byte-identical event per delta would lock the renderer on a long dump.
    service.append(RUN, OWNER, null, 'x'.repeat(64 * 1024 + 10));
    const afterCap = published.length;

    service.append(RUN, OWNER, null, 'more');
    service.append(RUN, OWNER, null, 'and more');
    expect(published.length).toBe(afterCap);

    // ...but a delta that ENDS a stretch still reports, because the live
    // thinking row has to clear.
    service.thinking(RUN, OWNER, null, 5);
    const afterThinking = published.length;
    service.append(RUN, OWNER, null, 'words again');
    expect(published.length).toBe(afterThinking + 1);
    expect(last().thinkingTokens).toBeNull();
  });
});

describe('PartialStreamService — live context', () => {
  it('publishes the mid-turn context figure', () => {
    service.context(RUN, OWNER, null, 28_283);
    expect(last().contextTokens).toBe(28_283);
  });

  it('scales it with the window remembered from the last completed turn', () => {
    // The window rides the `result` line only, so without remembering it a
    // turn's first request would report a token count with nothing to scale
    // against — the ring would sit at zero while the number climbed.
    expect(published).toHaveLength(0);
    service.rememberWindow(RUN, OWNER, 1_000_000);
    service.context(RUN, OWNER, null, 28_283);
    expect(last().contextWindowTokens).toBe(1_000_000);
    // The same figure a DURABLE writer reads — one expression behind both, so a
    // reopened chat cannot disagree with the ring it was just showing.
    expect(service.windowFor(RUN, OWNER)).toBe(1_000_000);
  });

  it('keeps the window across the turn boundary that clears everything else', () => {
    service.rememberWindow(RUN, OWNER, 1_000_000);
    service.clearRun(RUN);
    service.context(RUN, OWNER, null, 100);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('ignores a missing or nonsensical window rather than storing it', () => {
    service.rememberWindow(RUN, OWNER, 200_000);
    service.rememberWindow(RUN, OWNER, null);
    service.rememberWindow(RUN, OWNER, 0);
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(200_000);
  });

  it('forgetRun drops the window too — the run itself is gone', () => {
    service.rememberWindow(RUN, OWNER, 1_000_000);
    service.forgetRun(RUN);
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('windowFor is scoped to the OWNER, not to the run', () => {
    // The map is keyed by the pair, so a team member must not read the window
    // a sibling member on the same run reported.
    service.rememberWindow(RUN, OWNER, 1_000_000);
    expect(service.windowFor(RUN, 'another-node')).toBeNull();
  });
});

describe('PartialStreamService — every method stays total', () => {
  it('never throws out into the persist chain when the bus fails', () => {
    // These run inside the turn's persist chain, where a throw marks the run
    // failed. A nicety must not be able to do that.
    const exploding = {
      publishDelta: () => {
        throw new Error('bus down');
      },
    } as unknown as AgentEventBus;
    const fragile = new PartialStreamService(
      exploding,
      new FakeContextWindowStore().asStore(),
      new FakeUnrecordedSpendStore().asStore(),
      new FakeDelegateSpendStore().asStore(),
    );
    expect(() => fragile.append(RUN, OWNER, null, 'x')).not.toThrow();
    expect(() => fragile.thinking(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.context(RUN, OWNER, null, 1)).not.toThrow();
    expect(() => fragile.retire(RUN, OWNER, null)).not.toThrow();
    // Called on EVERY durable event, so this one is on the hottest path of all.
    expect(() => fragile.endThinking(RUN, OWNER, null)).not.toThrow();
  });
});

describe('PartialStreamService — the window is a property of the MODEL', () => {
  it('scales a run’s FIRST request from a window learned in an earlier run', () => {
    // The window rides the `result` line only, so a brand-new chat had nothing
    // to scale against until its first turn finished — and the meter fell back
    // to an assumed 200k, which is how a 1M-window model came to be shown a
    // fifth full before it had said anything.
    service.useModel('run-old', OWNER, AGENT, 'claude-opus-5[1m]');
    service.rememberWindow('run-old', OWNER, 1_000_000, 'claude-opus-5[1m]');

    service.useModel('run-new', OWNER, AGENT, 'claude-opus-5[1m]');
    service.context('run-new', OWNER, null, 26_000);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('says nothing rather than guessing for a model never seen before', () => {
    // Unknown must stay unknown: the renderer shows a bare token count for a
    // null window, where a substituted default would state a denominator
    // nobody reported.
    service.useModel(RUN, OWNER, AGENT, 'some-model-we-have-never-run');
    service.context(RUN, OWNER, null, 26_000);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('keeps the run’s own window across turns while the model is unchanged', () => {
    // The run's own `result` line describes the conversation actually on
    // screen, so re-announcing the SAME model at the next turn's start must not
    // reset the meter to whatever the per-model memory happens to hold.
    service.useModel(RUN, OWNER, AGENT, 'a-model');
    service.rememberWindow(RUN, OWNER, 1_000_000, 'a-model');

    service.useModel(RUN, OWNER, AGENT, 'a-model');
    service.context(RUN, OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('does NOT file a fallback model’s window under the announced one', () => {
    // A turn can fall back to a second model, and `result.modelUsage` then
    // reports THAT model's window. Filing it under the model the turn asked for
    // poisons every later chat on the requested model for the life of the
    // process — the 1M-shown-as-200k defect, cached.
    service.useModel(RUN, OWNER, AGENT, 'big-model');
    service.rememberWindow(RUN, OWNER, 200_000, 'a-smaller-fallback-model');

    service.useModel('run-next', OWNER, AGENT, 'big-model');
    service.context('run-next', OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('does not share a window between two CLIs that name the same model', () => {
    // `.claude/rules/agent-adapters.md`: per-agent state is keyed by agent,
    // never by the thing it is about. A window measured through one CLI says
    // nothing about another that happens to accept the same model id.
    service.useModel(RUN, OWNER, 'claude', 'shared-name');
    service.rememberWindow(RUN, OWNER, 1_000_000, 'shared-name');

    service.useModel('run-other', OWNER, 'cursor-agent', 'shared-name');
    service.context('run-other', OWNER, null, 10);
    expect(last().contextWindowTokens).toBeNull();
  });

  it('keeps the per-model memory when a run is deleted', () => {
    // The window describes the model, not the chat — deleting a conversation
    // is no reason for the next one to start guessing again.
    service.useModel(RUN, OWNER, AGENT, 'a-model');
    service.rememberWindow(RUN, OWNER, 1_000_000, 'a-model');
    service.forgetRun(RUN);

    service.useModel('run-next', OWNER, AGENT, 'a-model');
    service.context('run-next', OWNER, null, 10);
    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('rescales when the chat switches to a model with a different window', () => {
    // A chat is free to change model between turns, and the window is a
    // property of the MODEL. The run-scoped memory below was learned from the
    // PREVIOUS model's result line, so preferring it here measures the new
    // model's context against the old model's window for the whole turn — a
    // 300k request on a 1M model reading "300k / 200k · 150%", which is the
    // very "wrong context" the per-model memory exists to prevent.
    service.useModel(RUN, OWNER, AGENT, 'small-window-model');
    service.rememberWindow(RUN, OWNER, 200_000, 'small-window-model');
    // The big model's window was learned from another chat this session.
    service.useModel('run-elsewhere', OWNER, AGENT, 'big-window-model');
    service.rememberWindow(
      'run-elsewhere',
      OWNER,
      1_000_000,
      'big-window-model',
    );

    // This chat's next turn announces the big model at session start.
    service.useModel(RUN, OWNER, AGENT, 'big-window-model');
    service.context(RUN, OWNER, null, 300_000);

    expect(last().contextWindowTokens).toBe(1_000_000);
  });
});

describe('PartialStreamService — a settled turn stops claiming to be live', () => {
  it('withdraws a tail the finalizer handed to a durable partial item', () => {
    // The cancel/failure path: `takeTail` gives the watched-but-undurable words
    // to a `partial`-flagged message row, then `clearRun` ends the turn.
    // Neither says so on the wire, so the client is still holding those same
    // words as a LIVE tail and shows the sentence twice — once as the live row,
    // once as the durable item that was written to replace it. The whole point
    // of publishing the WHOLE tail is that the last event is authoritative;
    // here the last event is a lie the moment the flush lands.
    service.append(RUN, OWNER, null, 'half a senten');
    expect(last().text).toBe('half a senten');

    expect(service.takeTail(RUN, OWNER, null)).toBe('half a senten');
    service.clearRun(RUN);

    expect(last().text).toBe('');
  });

  it('closes a reasoning stretch that was open when the turn ended', () => {
    // Stop pressed while the agent is reasoning: the tail is empty, so the
    // flush above never fires and `clearRun` is the only thing that runs. With
    // no event to withdraw it, the last word on the wire still names an OPEN
    // stretch — and the transcript keeps a spinning "Thinking… 4m 12s" row,
    // clock ticking, under a chat whose turn stopped minutes ago.
    service.thinking(RUN, OWNER, null, 300);
    expect(last().thinkingStretch).toBe(1);

    service.clearRun(RUN);

    expect(last().thinkingStretch).toBeNull();
  });

  it('takes a finished owner’s live spend down, so the next recorded result is not counted twice', () => {
    // A call's turn settled with no `result` line of its own; the CLI's next
    // `result` records that money durably. A reader adds the live figure to
    // the recorded totals, so leaving it standing counts it a second time.
    service.cost(RUN, 'node::call-1', 'engineer', 1.25);
    expect(last().spentCostUsd).toBe(1.25);

    service.retireCost(RUN, 'node::call-1', 'engineer');

    expect(last().spentCostUsd).toBeNull();
    expect(last().ownerKey).toBe('node::call-1');
  });

  it('publishes nothing when there was no live spend to take down', () => {
    service.append(RUN, OWNER, null, 'hello');
    const before = published.length;

    service.retireCost(RUN, OWNER, null);
    service.retireCost(RUN, 'never-seen', null);

    expect(published).toHaveLength(before);
  });

  it('withdraws the live spend when the run is cleared', () => {
    service.cost(RUN, OWNER, null, 0.5, 0.5);
    expect(last().spentCostUsd).toBe(0.5);

    service.clearRun(RUN);

    expect(last().spentCostUsd).toBeNull();
    expect(last().spentEstimatedCostUsd).toBeNull();
  });

  it('publishes which part of the live spend geniro priced itself', () => {
    service.cost(RUN, OWNER, null, 0.5, 0.2);
    expect(last()).toMatchObject({
      spentCostUsd: 0.5,
      spentEstimatedCostUsd: 0.2,
    });

    // Same dollars, now all the CLI's own: still news, so it is published.
    service.cost(RUN, OWNER, null, 0.5);
    expect(last().spentEstimatedCostUsd).toBeNull();
  });

  it('withdraws the live spend with the tail a finalizer takes', () => {
    service.cost(RUN, OWNER, null, 0.5);
    service.append(RUN, OWNER, null, 'half');

    service.takeTail(RUN, OWNER, null);

    expect(last().spentCostUsd).toBeNull();
  });
});

describe('PartialStreamService — a client joining late is owed the plane', () => {
  it('answers each owner of the run with the event it last published', () => {
    service.cost(RUN, OWNER, null, 0.75);
    service.append(RUN, 'engineer::call-2', 'engineer', 'working on it');
    service.cost('another-run', OWNER, null, 3);

    const snapshot = service.snapshot(RUN);

    const lastOf = (ownerKey: string): RunDeltaEvent | undefined =>
      published
        .filter((event) => event.runId === RUN && event.ownerKey === ownerKey)
        .at(-1);
    expect(snapshot).toEqual([lastOf(OWNER), lastOf('engineer::call-2')]);
    // The chat's sentinel owner carries no member; a callee key carries its member.
    expect(snapshot.map((event) => event.memberId)).toEqual([null, 'engineer']);
  });

  it('holds nothing for a run whose turn was cleared', () => {
    service.cost(RUN, OWNER, null, 0.75);

    service.clearRun(RUN);

    expect(service.snapshot(RUN)).toEqual([]);
  });

  it('publishes nothing itself', () => {
    service.cost(RUN, OWNER, null, 0.75);
    const before = published.length;

    service.snapshot(RUN);

    expect(published).toHaveLength(before);
  });
});

describe('PartialStreamService — unrecorded spend is DURABLE', () => {
  // The live plane used to be the only place a running turn's spend existed,
  // so a restart — or a client that missed the moment it moved — read the
  // recorded total as the whole bill. Every change is now written through to
  // the run row, and in step with the plane, so the row never claims money
  // the plane has already taken down (which would count it twice once the
  // turn's `turn_complete` records it).

  it('writes each reading through, and takes it down with the turn', () => {
    service.cost(RUN, 'engineer::call-1', 'engineer', 12.5);
    service.cost(RUN, OWNER, null, 0.4);
    expect(spendStore.of(RUN)).toEqual({
      'engineer::call-1': 12.5,
      [OWNER]: 0.4,
    });

    service.cost(RUN, OWNER, null, 0.9);
    service.retireCost(RUN, 'engineer::call-1', 'engineer');

    expect(spendStore.of(RUN)).toEqual({ [OWNER]: 0.9 });
  });

  it('clears the row on every path that clears the plane', () => {
    service.cost(RUN, OWNER, null, 0.4);
    service.startTurn(RUN, OWNER);
    expect(spendStore.of(RUN)).toEqual({});

    service.cost(RUN, OWNER, null, 0.4);
    service.append(RUN, OWNER, null, 'half');
    service.takeTail(RUN, OWNER, null);
    expect(spendStore.of(RUN)).toEqual({});

    service.cost(RUN, OWNER, null, 0.4);
    service.clearRun(RUN);
    expect(spendStore.of(RUN)).toEqual({});
  });

  it('retires a figure the row holds even when this process never published one', () => {
    // Seeded across a restart: the owner has no state in a fresh plane until
    // the rehydration runs, and a retirement must still reach the row.
    spendStore.set(RUN, 'engineer::call-1', 5);

    service.retireCost(RUN, 'engineer::call-1', 'engineer');

    expect(spendStore.of(RUN)).toEqual({});
  });

  it('puts the persisted figures back on the plane at boot, without announcing them', async () => {
    const restoredStore = new FakeUnrecordedSpendStore({
      [RUN]: { 'engineer::call-1': 38.5, [OWNER]: 0.25 },
    });
    const restored = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      new FakeContextWindowStore().asStore(),
      restoredStore.asStore(),
      new FakeDelegateSpendStore().asStore(),
    );
    const before = published.length;

    await restored.rehydrateUnrecordedSpend();

    expect(published).toHaveLength(before);
    expect(
      restored
        .snapshot(RUN)
        .map((event) => [event.ownerKey, event.memberId, event.spentCostUsd]),
    ).toEqual([
      ['engineer::call-1', 'engineer', 38.5],
      [OWNER, null, 0.25],
    ]);
  });

  it('keeps the part of a persisted figure geniro priced itself across the restart', async () => {
    service.cost(RUN, OWNER, null, 2, 2);
    expect(spendStore.estimates.get(RUN)?.get(OWNER)).toBe(2);

    const restored = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      new FakeContextWindowStore().asStore(),
      spendStore.asStore(),
      new FakeDelegateSpendStore().asStore(),
    );
    await restored.rehydrateUnrecordedSpend();

    expect(restored.snapshot(RUN)[0]).toMatchObject({
      spentCostUsd: 2,
      spentEstimatedCostUsd: 2,
    });
  });
});

describe('PartialStreamService — the window survives a daemon restart', () => {
  it('scales a run’s FIRST request from a window persisted by an EARLIER launch', () => {
    // The reported defect. Both in-memory maps start empty in a fresh process,
    // so before the store existed a run had nothing to scale against until its
    // own first turn COMPLETED — and on a machine where the app is restarted
    // often that is most of what the user ever sees: `ctx 91.6k` with no ring.
    const restarted = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      new FakeContextWindowStore({
        [FakeContextWindowStore.key(AGENT, 'claude-opus-5')]: 1_000_000,
      }).asStore(),
      new FakeUnrecordedSpendStore().asStore(),
      new FakeDelegateSpendStore().asStore(),
    );

    restarted.useModel(RUN, OWNER, AGENT, 'claude-opus-5');
    restarted.context(RUN, OWNER, null, 91_600);

    expect(last().contextWindowTokens).toBe(1_000_000);
  });

  it('writes a newly learned window through, so the NEXT launch already knows it', () => {
    service.useModel(RUN, OWNER, AGENT, 'claude-opus-5');
    service.rememberWindow(RUN, OWNER, 1_000_000, 'claude-opus-5');

    expect(windowStore.writes).toEqual([
      {
        agent: AGENT,
        model: 'claude-opus-5',
        window: 1_000_000,
        contextWindow: null,
      },
    ]);
  });

  it('does NOT persist a fallback model’s window under the announced one', () => {
    // The in-memory cache already refuses this; the durable one must refuse it
    // too, or the poisoning that used to last one process would last forever.
    service.useModel(RUN, OWNER, AGENT, 'big-model');
    service.rememberWindow(RUN, OWNER, 200_000, 'a-smaller-fallback-model');

    expect(windowStore.writes).toEqual([]);
  });

  it('still says nothing for a model the store has never seen', () => {
    // Persistence must not become a licence to guess: an unknown model stays
    // unknown, which is what keeps the meter honest rather than assuming 200k.
    service.useModel(RUN, OWNER, AGENT, 'a-model-nobody-has-run');
    service.context(RUN, OWNER, null, 26_000);

    expect(last().contextWindowTokens).toBeNull();
  });
});

describe('PartialStreamService — knownWindow, asked before a turn exists', () => {
  it('answers by the model id with the window a turn of it measured, across a restart', () => {
    service.useModel(RUN, OWNER, AGENT, 'claude-haiku-5-5');
    service.rememberWindow(RUN, OWNER, 1_000_000, 'claude-haiku-5-5');

    expect(service.knownWindow(AGENT, 'claude-haiku-5-5')).toBe(1_000_000);
    const restarted = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      windowStore.asStore(),
      new FakeUnrecordedSpendStore().asStore(),
      new FakeDelegateSpendStore().asStore(),
    );
    expect(restarted.knownWindow(AGENT, 'claude-haiku-5-5')).toBe(1_000_000);
    expect(restarted.knownWindow(AGENT, 'a-model-nobody-has-run')).toBeNull();
  });

  it('keys the answer by the window CHOICE, never parsing the choice itself', () => {
    // codex's `872k` reports 828,400. A number read off the label would differ
    // from the one the turn then measures, and the changed threshold would
    // respawn the CLI on its second turn.
    const seeded = new FakeContextWindowStore({
      [FakeContextWindowStore.key('codex', 'gpt-6.1-sol', '872k')]: 828_400,
    });
    const fresh = new PartialStreamService(
      {
        publishDelta: (event: RunDeltaEvent) => published.push(event),
      } as unknown as AgentEventBus,
      seeded.asStore(),
      new FakeUnrecordedSpendStore().asStore(),
      new FakeDelegateSpendStore().asStore(),
    );

    expect(fresh.knownWindow('codex', 'gpt-6.1-sol', '872k')).toBe(828_400);
    expect(fresh.knownWindow('codex', 'gpt-6.1-sol')).toBeNull();
    expect(fresh.knownWindow('codex', 'gpt-6.2-sol', '1m')).toBeNull();
  });

  it('does not take a reading from another model as the owner’s window', () => {
    // `modelUsage` names the model that spent the most, which can be a
    // delegate's: its window is not this conversation's, and taken as one it
    // would move the `--autocompact` threshold the owner's next turn carries.
    service.useModel(RUN, OWNER, AGENT, 'big-model');
    expect(service.rememberWindow(RUN, OWNER, 1_000_000, 'big-model')).toBe(
      true,
    );
    expect(
      service.rememberWindow(RUN, OWNER, 200_000, 'a-delegate-model'),
    ).toBe(false);

    expect(service.windowFor(RUN, OWNER)).toBe(1_000_000);
    expect(service.knownWindow(AGENT, 'a-delegate-model')).toBeNull();
  });
});

describe('PartialStreamService — a window belongs to an OWNER, not to a run', () => {
  const BIG = 'node-big';
  const SMALL = 'node-small';

  /** The last event published for one owner, which is what its meter reads. */
  function lastFor(memberId: string): RunDeltaEvent {
    const own = published.filter((event) => event.memberId === memberId);
    return own[own.length - 1]!;
  }

  it('gives two members of one run their own windows', () => {
    // A team run is N agents, and they routinely run on DIFFERENT models. A
    // run-scoped window is whichever member reported LAST, so the 1M member's
    // 800k-token conversation was drawn against the 200k member's window — a ring
    // pinned at 100% on an agent with three quarters of its context free.
    service.useModel(RUN, BIG, AGENT, 'big-window-model');
    service.rememberWindow(RUN, BIG, 1_000_000, 'big-window-model');
    service.useModel(RUN, SMALL, AGENT, 'small-window-model');
    service.rememberWindow(RUN, SMALL, 200_000, 'small-window-model');

    service.context(RUN, BIG, BIG, 800_000);
    service.context(RUN, SMALL, SMALL, 100_000);

    expect(lastFor(BIG).contextWindowTokens).toBe(1_000_000);
    expect(lastFor(SMALL).contextWindowTokens).toBe(200_000);
  });

  it('does not let one member’s model change reset another member’s window', () => {
    // `useModel` drops the remembered window when the model changes. Keyed by
    // run, a second member announcing a different model wiped the FIRST member's
    // window mid-turn, and its ring vanished with the number still climbing.
    service.useModel(RUN, BIG, AGENT, 'big-window-model');
    service.rememberWindow(RUN, BIG, 1_000_000, 'big-window-model');

    service.useModel(RUN, SMALL, AGENT, 'some-other-model');

    service.context(RUN, BIG, BIG, 10);
    expect(lastFor(BIG).contextWindowTokens).toBe(1_000_000);
  });

  it('forgetRun sweeps EVERY member of that run, and no other run', () => {
    // The maps are keyed per (run, owner), so deleting the bare run id leaves a
    // team's per-member entries behind for the life of the process — a leak
    // nothing can reach again, the run they belong to being gone.
    service.rememberWindow(RUN, BIG, 1_000_000);
    service.rememberWindow(RUN, SMALL, 200_000);
    service.rememberWindow('another-run', BIG, 500_000);

    service.forgetRun(RUN);

    service.context(RUN, BIG, BIG, 10);
    expect(lastFor(BIG).contextWindowTokens).toBeNull();
    service.context(RUN, SMALL, SMALL, 10);
    expect(lastFor(SMALL).contextWindowTokens).toBeNull();
    // The sweep is by PREFIX, so it must not be a substring match on the id.
    service.context('another-run', BIG, BIG, 10);
    expect(lastFor(BIG).contextWindowTokens).toBe(500_000);
  });
});

describe('PartialStreamService — a CLI that DISCLOSES what it is thinking', () => {
  it('opens a stretch on the first thought chunk, with no token count to show', () => {
    // The reported defect: cursor streams `agent_thought_chunk` and no stretch
    // was ever opened for them, so the transcript drew its generic "the agent
    // has shown nothing" row for the whole wait — measured at three minutes on
    // the chat this came from.
    service.reasoning(RUN, OWNER, null, 'Let me work through');

    expect(last().thinkingStretch).toBe(1);
    expect(last().thinkingText).toBe('Let me work through');
    // Null rather than 0: this CLI reports no reasoning token count at all, and
    // a zero would render as "Thinking… 0 tokens" — a figure nobody measured.
    expect(last().thinkingTokens).toBeNull();
  });

  it('publishes the WHOLE tail on every chunk, never the increment', () => {
    // REPLACE semantics, the same contract the text tail carries: a client that
    // missed one event is correct again on the very next one.
    service.reasoning(RUN, OWNER, null, 'first ');
    service.reasoning(RUN, OWNER, null, 'second');

    expect(last().thinkingText).toBe('first second');
    // Still ONE stretch — a second chunk is more of the same wait, so the row
    // must not remount with a clock starting again at zero.
    expect(last().thinkingStretch).toBe(1);
    expect(published.at(-2)?.thinkingSince).toBe(last().thinkingSince);
  });

  it('drops the text the moment the agent starts writing words', () => {
    service.reasoning(RUN, OWNER, null, 'thinking about it');
    service.append(RUN, OWNER, null, 'Here is the answer');

    expect(last().text).toBe('Here is the answer');
    expect(last().thinkingText).toBeNull();
    expect(last().thinkingStretch).toBeNull();
  });

  it('closes a text-only stretch on the next durable event', () => {
    // `endThinking` fires at the persist seam, and its early return used to ask
    // only about the TOKEN total — so a stretch opened by text alone was
    // invisible to it and stayed open for the whole tool call that followed,
    // exactly the defect the token path was fixed for.
    service.reasoning(RUN, OWNER, null, 'about to call a tool');
    service.endThinking(RUN, OWNER, null);

    expect(last().thinkingText).toBeNull();
    expect(last().thinkingStretch).toBeNull();

    // …and the NEXT stretch is a fresh one rather than the old one resumed.
    service.reasoning(RUN, OWNER, null, 'now what');
    expect(last().thinkingStretch).toBe(2);
  });

  it('announces the empty state when the turn ends mid-thought', () => {
    // Deleting the state locally says nothing on the wire, so the client would
    // keep a thinking bubble whose clock ticked on under a settled chat.
    service.reasoning(
      RUN,
      OWNER,
      null,
      'still going when the user pressed Stop',
    );
    published.length = 0;

    service.clearRun(RUN);

    expect(last().thinkingText).toBeNull();
    expect(last().thinkingStretch).toBeNull();
  });
});

describe('the owner key — this side of the twin', () => {
  // TWIN PARSER: `apps/ui/src/renderer/chats/live-text.ts` re-implements all
  // three of these. This is the AUTHORITATIVE side — the daemon composes the
  // key the `agent_delta` event is published under — and it had no test of its
  // own while the mirror had five, so a drift here would misattribute every
  // live-plane owner with nothing failing to compile.

  it('composes a member’s own turn as the bare member id', () => {
    expect(partialOwnerKey('reviewer', null)).toBe('reviewer');
  });

  it('composes a CALL thread with the separator', () => {
    expect(partialOwnerKey('reviewer', 'call-1')).toBe('reviewer::call-1');
  });

  it('reads the member back out of either shape', () => {
    expect(ownerOfKey(partialOwnerKey('reviewer', null))).toBe('reviewer');
    expect(ownerOfKey(partialOwnerKey('reviewer', 'call-1'))).toBe('reviewer');
  });

  it('splits at the FIRST separator, so a call id may contain one', () => {
    expect(
      ownerOfKey(partialOwnerKey('reviewer', `a${OWNER_KEY_SEPARATOR}b`)),
    ).toBe('reviewer');
  });
});

describe('PartialStreamService — a tool call being WRITTEN', () => {
  /** Open a composition and take the count of events it cost. */
  function open(tool = 'mcp__geniro-abc12345__show_artifact'): number {
    service.composing(RUN, OWNER, null, { tool, bytes: 0, done: false });
    return published.length;
  }

  it('announces the tool by NAME the moment the model starts writing it', () => {
    // The name is the whole reason this crosses the wire: a client uses it to
    // decide whether the wait is one worth drawing a card skeleton for, which a
    // byte count alone could never answer.
    open();
    expect(last().composingTool).toBe('mcp__geniro-abc12345__show_artifact');
    expect(last().composingBytes).toBe(0);
  });

  it('accumulates bytes rather than reporting each frame', () => {
    // The CLI chunks arguments finely — measured at ~8 bytes a frame — so what
    // a reader needs is the running total, not the increment.
    open();
    service.composing(RUN, OWNER, null, {
      tool: null,
      bytes: 3000,
      done: false,
    });
    expect(last().composingBytes).toBe(3000);
    service.composing(RUN, OWNER, null, {
      tool: null,
      bytes: 3000,
      done: false,
    });
    expect(last().composingBytes).toBe(6000);
  });

  it('publishes in STEPS, so a big payload costs tens of events not thousands', () => {
    // A 50KB artifact arrives in roughly 6,000 frames. Unthrottled that is
    // 6,000 socket broadcasts of a figure changing faster than anyone can read
    // it; the step is what bounds the traffic by the payload's SIZE instead.
    const before = open();
    const frames = 1_000;
    for (let i = 0; i < frames; i += 1) {
      service.composing(RUN, OWNER, null, {
        tool: null,
        bytes: 8,
        done: false,
      });
    }
    const events = published.length - before;
    expect(events).toBeGreaterThan(0);
    expect(events).toBeLessThan(frames / 100);
    // The published figure LAGS by less than one step — that is what a step
    // throttle is — and the last one before the close is therefore a little
    // behind. Harmless on a loader, where the reading is evidence of progress
    // rather than a measurement anybody quotes.
    expect(last().composingBytes).toBeGreaterThan(frames * 8 - 2048);
    expect(last().composingBytes).toBeLessThanOrEqual(frames * 8);
    // Throttled, never LOSSY: nothing that did not publish was dropped, so the
    // next frame to cross a step reports the true running total.
    service.composing(RUN, OWNER, null, {
      tool: null,
      bytes: 2048,
      done: false,
    });
    expect(last().composingBytes).toBe(frames * 8 + 2048);
  });

  it('clears on the CLI’s own block stop', () => {
    open();
    service.composing(RUN, OWNER, null, { tool: null, bytes: 0, done: true });
    expect(last().composingTool).toBeNull();
    // Null rather than 0, so a client that sees a count is always looking at a
    // live composition and never at the leftovers of one.
    expect(last().composingBytes).toBeNull();
  });

  it('ignores a block stop while nothing is being composed', () => {
    // Every block sends one — a text block, a thinking block — and the mapper
    // cannot tell them apart by index. A no-op here is what keeps those from
    // putting an empty event on the wire for each.
    const before = published.length;
    service.composing(RUN, OWNER, null, { tool: null, bytes: 0, done: true });
    expect(published.length).toBe(before);
  });

  it('drops a byte frame that names no open composition', () => {
    // A count with no name says nothing a reader could act on, and opening an
    // anonymous composition would flicker a nameless placeholder onto the
    // screen for every Bash the agent runs.
    const before = published.length;
    service.composing(RUN, OWNER, null, {
      tool: null,
      bytes: 900,
      done: false,
    });
    expect(published.length).toBe(before);
  });

  it('resets the count when a SECOND call is written in the same turn', () => {
    open();
    service.composing(RUN, OWNER, null, {
      tool: null,
      bytes: 5000,
      done: false,
    });
    service.composing(RUN, OWNER, null, { tool: null, bytes: 0, done: true });
    open('mcp__geniro-abc12345__show_chart');
    expect(last().composingTool).toBe('mcp__geniro-abc12345__show_chart');
    expect(last().composingBytes).toBe(0);
  });

  it('ends a reasoning stretch, like words arriving do', () => {
    // A model that thinks and then calls a tool without saying anything would
    // otherwise keep a `Thinking…` row above the loader for the whole
    // composition — two rows about one wait.
    service.thinking(RUN, OWNER, null, 400);
    expect(last().thinkingStretch).not.toBeNull();
    open();
    expect(last().thinkingStretch).toBeNull();
    expect(last().thinkingTokens).toBeNull();
  });

  it('is cleared by words arriving, even with no block stop', () => {
    open();
    service.append(RUN, OWNER, null, 'Here it is.');
    expect(last().composingTool).toBeNull();
  });

  it('is cleared when the turn ends', () => {
    // A composition left standing would keep a skeleton on screen under a
    // settled chat, exactly as an open reasoning stretch once kept a ticking
    // "Thinking…" row there.
    open();
    published.length = 0;
    service.clearRun(RUN);
    expect(last().composingTool).toBeNull();
  });
});
