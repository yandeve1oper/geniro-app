import { createContext, useMemo } from 'react';

import { formatTokens } from './agent-activity';

/**
 * The live (not-yet-durable) assistant text one agent is writing right now.
 *
 * TWIN PARSER: `apps/daemon/src/v1/agents/chat.types.ts` `RunDeltaEvent` is the
 * producing shape, published on the `agent_delta` Socket.IO event. No route
 * carries it — it is deliberately outside the generated HTTP contract, since
 * nothing about it is persisted — so the two sides are independent
 * implementations and a shape change on either MUST be mirrored on the other.
 *
 * The wire carries the WHOLE tail rather than an increment, which is what makes
 * a dropped event harmless: the next one is authoritative, and an empty string
 * means "those words are durable now, stop showing this". Everything here is
 * throwaway state — a reload or a reconnect simply shows the persisted
 * transcript, which is never missing anything a delta was carrying.
 */

/**
 * The map key used for a 1:1 chat's agent, whose items carry no node id.
 *
 * NUL-prefixed so it cannot collide with a real one. A team node id is any
 * non-empty string, so `agent` is a legal — and obvious — node name; while the
 * sentinel was that same word, `liveTextKey` and its inverse stopped being
 * inverses for such a node, and its streamed words were torn out of its own
 * block and rendered in a phantom one at the bottom of the transcript.
 */
export const CHAT_LIVE_KEY = '\u0000chat';

/**
 * One delegate's figures over every request it has made so far, as the live
 * plane states them.
 *
 * TWIN of `DelegateFigures` in `apps/daemon/src/v1/agents/adapters/adapter.types.ts`
 * (the `delegate_progress` level). Every figure is null when not measured.
 */
export interface LiveDelegateFigures {
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  model: string | null;
  costUsd: number | null;
  estimatedCostUsd: number | null;
}

/** The delegates one owner launched, keyed by launching tool call id. */
export type LiveDelegates = Readonly<Record<string, LiveDelegateFigures>>;

/** One `agent_delta` payload, as read defensively off an untyped WS event. */
export interface LiveTextEvent {
  runId: string;
  memberId: string | null;
  /**
   * Which CONVERSATION of that node this is — see {@link liveTextKey}. Null
   * from a daemon predating the per-call key, where the node WAS the key.
   */
  ownerKey: string | null;
  text: string;
  /**
   * Reasoning tokens spent in the CURRENT stretch, or null when not thinking.
   * Per stretch, not cumulative over the turn.
   */
  thinkingTokens: number | null;
  /**
   * What the agent is thinking, as it thinks it — the WHOLE tail of the current
   * stretch — or null when there is nothing to show.
   *
   * Which of this and {@link LiveTextEvent.thinkingTokens} arrives is a
   * property of the CLI: cursor and codex stream the words, claude sends a
   * token count and, where its binary can summarize, the words too. So null
   * here means "no text", never "not thinking".
   */
  thinkingText: string | null;
  /** Epoch ms the CURRENT stretch began, or null when not thinking. */
  thinkingSince: number | null;
  /**
   * Which reasoning stretch of this turn the two fields above describe
   * (counting from 1), or null when not thinking. Only its CHANGE matters: a
   * new number means a new wait, which gets its own row and its own clock.
   */
  thinkingStretch: number | null;
  /**
   * The tool whose ARGUMENTS the model is writing right now, or null.
   *
   * The third thing an agent can be doing, beside talking and thinking, and
   * the only one with no other signal: between the decision to call a tool and
   * the whole call having been serialized nothing reaches the transcript at
   * all. For a shell command that is milliseconds; for a host tool whose
   * argument IS the deliverable — `show_artifact` carries a whole HTML page —
   * it is the longest silence in the turn.
   *
   * Null for a CLI that streams no partial messages, which reads the same way
   * as "not composing": there is nothing to draw either way.
   */
  composingTool: string | null;
  /** Argument bytes that composition has produced so far, or null. */
  composingBytes: number | null;
  /** Prompt-side tokens as of the turn's latest request, or null. */
  contextTokens: number | null;
  /** The window those tokens are measured against, or null if unreported. */
  contextWindowTokens: number | null;
  /**
   * What THIS TURN has spent so far, summed over its requests as they land.
   *
   * A RUNNING TOTAL where `contextTokens` above is a level — the two move
   * independently, and a compaction sends them opposite ways. Cache reads stay
   * their own figure because they are priced apart and dominate the input side
   * of any resumed conversation.
   *
   * claude and codex, and null for cursor — which exposes no token accounting a
   * client can reach at all (see the daemon's `RunDeltaEvent` for the four
   * channels that were measured and found empty). Null is "not measured", so
   * the row simply does not draw the figure rather than showing a zero.
   */
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
  /**
   * Dollars this conversation's process has spent that no durable row carries
   * yet — the running part of the turn, as the CLI's own cost ledger states
   * it, and 0 again once the turn's `turn_complete` records it.
   *
   * So it is ADDED to the daemon's recorded totals (`withLiveCost` in
   * `call-context.ts`), never chosen between: the sum is what a running call
   * has cost so far. claude and codex (codex's list-priced, so all of it is
   * {@link spentEstimatedCostUsd}), null elsewhere.
   */
  spentCostUsd: number | null;
  /**
   * Of {@link spentCostUsd}, the part geniro priced itself; null or absent
   * when none.
   */
  spentEstimatedCostUsd?: number | null;
  /**
   * The delegates this owner launched, each with its figures over every request
   * so far. The owner's WHOLE set on every event: null when it has none, which
   * replaces whatever was there. Never part of {@link spentCostUsd}.
   */
  delegates?: LiveDelegates | null;
}

/** What one agent is doing right now, as the transcript renders it. */
export interface LiveState {
  text: string;
  thinkingTokens: number | null;
  thinkingText: string | null;
  thinkingSince: number | null;
  thinkingStretch: number | null;
  composingTool: string | null;
  composingBytes: number | null;
  contextTokens: number | null;
  contextWindowTokens: number | null;
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
  spentCostUsd: number | null;
  spentEstimatedCostUsd?: number | null;
  delegates?: LiveDelegates | null;
}

/**
 * Every delegate's live figures, by delegate id. Null outside a provider, where
 * a card falls back to its own rows.
 *
 * Derived from the live plane by {@link useLiveDelegates} rather than handed the
 * plane itself: a card that read the plane would re-render on every streamed
 * word of every agent.
 */
export const LiveDelegatesContext = createContext<ReadonlyMap<
  string,
  LiveDelegateFigures
> | null>(null);

function liveDelegatesKeyOf(
  plane: ReadonlyMap<string, LiveState> | null,
): string | null {
  if (plane === null) {
    return null;
  }
  const entries: [string, LiveDelegateFigures][] = [];
  for (const state of plane.values()) {
    entries.push(...Object.entries(state.delegates ?? {}));
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * The delegates' live figures as one map object, kept for as long as no
 * delegate's figures change. A delta to a message's words leaves the same object
 * in place, so nothing reading the map renders again for it.
 */
export function useLiveDelegates(
  plane: ReadonlyMap<string, LiveState> | null,
): ReadonlyMap<string, LiveDelegateFigures> | null {
  const key = liveDelegatesKeyOf(plane);
  return useMemo(
    () =>
      key === null
        ? null
        : new Map(JSON.parse(key) as [string, LiveDelegateFigures][]),
    [key],
  );
}

/**
 * Read an `agent_delta` payload, or null when it is not one. Defensive because
 * this shape has no generated type to guarantee it: a daemon/renderer version
 * skew must degrade to "no live text", never to a crashed transcript.
 */
export function parseLiveText(data: unknown): LiveTextEvent | null {
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const { runId, memberId, ownerKey, text } = data as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof text !== 'string') {
    return null;
  }
  const record = data as Record<string, unknown>;
  const delegates = parseDelegates(record.delegates);
  return {
    runId,
    memberId: typeof memberId === 'string' ? memberId : null,
    // Absent on an event from a daemon older than the per-call key, where the
    // node WAS the key — so falling back to it is the honest reading of that
    // wire rather than a guess.
    ownerKey: typeof ownerKey === 'string' ? ownerKey : null,
    text,
    // Zero is a real answer here and nowhere else on this event: a stretch's
    // very first delta can legitimately report no tokens yet, and reading that
    // as "not thinking" would hide the row for exactly as long as the agent
    // had nothing to show for the wait. Whether the agent IS thinking is
    // `thinkingStretch`'s job, not this field's.
    thinkingTokens: nonNegativeNumber(record.thinkingTokens),
    // An EMPTY string reads as null on purpose: it is what a stretch with
    // nothing said yet and a CLI that withholds its thinking both amount to, and
    // treating it as text would draw an empty reasoning bubble for both.
    thinkingText:
      typeof record.thinkingText === 'string' && record.thinkingText !== ''
        ? record.thinkingText
        : null,
    thinkingSince: positiveNumber(record.thinkingSince),
    thinkingStretch: positiveNumber(record.thinkingStretch),
    // An EMPTY tool name reads as null on the `thinkingText` rule: a name is
    // the whole point of this field — it decides whether the wait is worth
    // drawing a placeholder for — so a blank one says nothing a reader could
    // act on.
    composingTool:
      typeof record.composingTool === 'string' && record.composingTool !== ''
        ? record.composingTool
        : null,
    // NON-NEGATIVE, unlike the figures above: a composition's first published
    // frame legitimately carries 0 bytes, and reading that as "unmeasured"
    // would blank the count for exactly the moment the loader appears.
    composingBytes: nonNegativeNumber(record.composingBytes),
    contextTokens: positiveNumber(record.contextTokens),
    contextWindowTokens: positiveNumber(record.contextWindowTokens),
    // NON-NEGATIVE, unlike the two above: a turn whose first request produced
    // nothing yet has genuinely spent 0 output tokens, and reading that as
    // "unmeasured" would hide the whole figure for as long as the agent was
    // still thinking — which is precisely the stretch this exists to fill.
    spentInputTokens: nonNegativeNumber(record.spentInputTokens),
    spentOutputTokens: nonNegativeNumber(record.spentOutputTokens),
    spentCacheReadTokens: nonNegativeNumber(record.spentCacheReadTokens),
    // NON-NEGATIVE: the zero is the reading that says the turn's cost has just
    // become durable, and it has to REPLACE the last figure rather than be
    // dropped as "unmeasured" — or the same money is counted in both.
    spentCostUsd: nonNegativeNumber(record.spentCostUsd),
    // Absent unless some of that spend is geniro's own pricing.
    ...(positiveNumber(record.spentEstimatedCostUsd) === null
      ? {}
      : {
          spentEstimatedCostUsd: positiveNumber(record.spentEstimatedCostUsd),
        }),
    ...(delegates === null ? {} : { delegates }),
  };
}

/**
 * This turn's running token bill as one short phrase, or null when nothing has
 * reported it.
 *
 * `↑` is what the turn PUT IN and `↓` what it got back — arrows rather than
 * words because the row carrying this already has an activity phrase and a
 * clock and one line to fit them in. Cache reads are folded into the input side
 * here, unlike on the wire: the split decides a bill and not a glance, and a
 * third figure is what pushes the phrase off the row.
 *
 * Null when NEITHER half was measured, which is every cursor turn — see
 * {@link LiveState.spentInputTokens}. A measured ZERO still draws: "this turn
 * has produced nothing yet" is true, useful, and exactly what the reader of a
 * long-running turn is asking.
 *
 * Here rather than in the component: the fold is where the live state is in
 * hand, and the row's own renderer holds a payload with no plane behind it.
 */
export function formatLiveSpend(state: {
  spentInputTokens: number | null;
  spentOutputTokens: number | null;
  spentCacheReadTokens: number | null;
}): string | null {
  const input =
    state.spentInputTokens === null && state.spentCacheReadTokens === null
      ? null
      : (state.spentInputTokens ?? 0) + (state.spentCacheReadTokens ?? 0);
  const output = state.spentOutputTokens;
  if (input === null && output === null) {
    return null;
  }
  const parts: string[] = [];
  if (input !== null) {
    parts.push(`↑${formatTokens(input)}`);
  }
  if (output !== null) {
    parts.push(`↓${formatTokens(output)}`);
  }
  return parts.join(' ');
}

/** A positive number off an untyped field, else null — the defensive default. */
function positiveNumber(value: unknown): number | null {
  return typeof value === 'number' && value > 0 ? value : null;
}

/** Same, for a count whose zero is meaningful rather than absent. */
function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 ? value : null;
}

/** A figure that is a finite number of zero or more, else null — never NaN or Infinity. */
function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The delegates of one owner, read defensively: an entry that is not an object
 * is dropped, and a figure that is not a finite non-negative number reads as
 * unmeasured. Null when no entry survives, so an owner with none stays absent.
 */
function parseDelegates(value: unknown): LiveDelegates | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  const entries: [string, LiveDelegateFigures][] = [];
  for (const [id, figures] of Object.entries(value)) {
    if (id === '' || typeof figures !== 'object' || figures === null) {
      continue;
    }
    const record = figures as Record<string, unknown>;
    entries.push([
      id,
      {
        requests: finiteNonNegative(record.requests),
        inputTokens: finiteNonNegative(record.inputTokens),
        outputTokens: finiteNonNegative(record.outputTokens),
        cacheReadTokens: finiteNonNegative(record.cacheReadTokens),
        cacheCreationTokens: finiteNonNegative(record.cacheCreationTokens),
        contextTokens: finiteNonNegative(record.contextTokens),
        model:
          typeof record.model === 'string' && record.model !== ''
            ? record.model
            : null,
        costUsd: finiteNonNegative(record.costUsd),
        estimatedCostUsd: finiteNonNegative(record.estimatedCostUsd),
      },
    ]);
  }
  return entries.length === 0 ? null : Object.fromEntries(entries);
}

/**
 * Which CONVERSATION a delta belongs to — the map key.
 *
 * The daemon's own owner key when it sent one: a node can hold several threads
 * at once (its own turn, and one per call it is serving), and each has its own
 * context window. Keyed by node alone they shared one entry and the last
 * writer won, which is what put one flickering ring over a panel honestly
 * counting two threads.
 */
export function liveTextKey(
  memberId: string | null,
  ownerKey: string | null = null,
): string {
  // NO NODE ID means the 1:1 chat, whatever owner key rides with it — and one
  // always does: the daemon publishes `SINGLE_AGENT_NODE` ('agent'), the
  // pseudo-node a chat's own rows are filed under, as the owner of its live
  // plane. Reading that owner key as the map key is how this twin drifted from
  // its producer: the sentinel here was renamed from that very word to a
  // NUL-prefixed one (see {@link CHAT_LIVE_KEY}), and nothing on the daemon
  // side changed, so a chat's deltas landed under `agent` while every reader
  // that has no event to derive a key from — `workingAgents`,
  // `awaitingAnswer`, the context meter's live source — went on asking for the
  // sentinel. Nothing failed to compile, which is what the TWIN PARSER block
  // above warns about.
  //
  // REPORTED as a chat showing `Thinking… · 2s` and `Working… · 15s` at the
  // same time, and reproduced in the running app: `withLiveText` suppresses the
  // working fallback for an agent that already has a live row, by KEY, and the
  // two keys could never match. The context ring's live source was the quieter
  // half of the same drift.
  //
  // The discriminator is exact rather than a guess: a team node's delta
  // always carries its node id (`GraphExecutorService` passes `node.id`), so a
  // node literally named `agent` — the collision the sentinel exists for —
  // still keys as itself.
  if (memberId === null) {
    return CHAT_LIVE_KEY;
  }
  return ownerKey ?? memberId;
}

/**
 * TWIN PARSER: `apps/daemon/src/v1/agents/services/partial-stream.service.ts`
 * `OWNER_KEY_SEPARATOR` / {@link partialOwnerKey} / {@link ownerOfKey}.
 *
 * The daemon OWNS this encoding — it is what `agent_delta` is published under —
 * and nothing generated spans the seam, since the event is deliberately outside
 * the HTTP contract. So the separator and both directions are spelled here as
 * an independent implementation, and a change to either side MUST be mirrored
 * on the other. Nothing fails to compile when they drift: the symptom is every
 * call thread's context ring going blank.
 */
export const OWNER_KEY_SEPARATOR = '::';

/** The live-plane owner key for one node's turn, or one of its CALL threads. */
export function partialOwnerKey(
  memberId: string,
  callId: string | null,
): string {
  return callId === null
    ? memberId
    : `${memberId}${OWNER_KEY_SEPARATOR}${callId}`;
}

/**
 * The NODE an owner key belongs to — the key itself for a node's own turn, and
 * the part before the separator for a callee turn's per-call key.
 */
export function ownerOfKey(ownerKey: string): string {
  const split = ownerKey.indexOf(OWNER_KEY_SEPARATOR);
  return split === -1 ? ownerKey : ownerKey.slice(0, split);
}

/**
 * The CALL an owner key belongs to — the part after the separator for a callee
 * turn's per-call key, and null for a node's own turn (and for the chat's
 * sentinel, which carries no separator).
 */
export function callIdOfKey(ownerKey: string): string | null {
  const split = ownerKey.indexOf(OWNER_KEY_SEPARATOR);
  return split === -1
    ? null
    : ownerKey.slice(split + OWNER_KEY_SEPARATOR.length);
}

/**
 * Apply one event to the per-agent live map. An agent with neither words nor a
 * reasoning total is REMOVED rather than stored empty, so callers can treat
 * "has a key" as "is doing something right now".
 */
export function applyLiveText(
  current: ReadonlyMap<string, LiveState>,
  event: LiveTextEvent,
): Map<string, LiveState> {
  const next = new Map(current);
  const key = liveTextKey(event.memberId, event.ownerKey);
  // A context figure alone is NOT "doing something" — it keeps arriving after
  // a block goes durable — so the entry is KEPT (the meter still needs the
  // number) while `withLiveText` declines to draw a bubble for it. Only an
  // entry with nothing at all to say is dropped.
  if (
    event.text === '' &&
    event.thinkingStretch === null &&
    // A COMPOSITION is emphatically "doing something" — it is the one stretch
    // of a turn where the agent produces nothing else at all, so dropping the
    // entry here would remove the row precisely while its loader is wanted.
    event.composingTool === null &&
    event.contextTokens === null &&
    // A SPEND figure keeps the entry too, on the same reasoning the context
    // figure is kept for: it is not "doing something", but the row that shows
    // what this turn has cost needs it, and dropping the entry would blank
    // that figure between two deltas.
    event.spentOutputTokens === null &&
    event.spentInputTokens === null &&
    event.spentCostUsd === null &&
    // A DELEGATE still out keeps its owner's entry: its spend is on the row
    // the same way the owner's own spend is.
    event.delegates == null
  ) {
    next.delete(key);
  } else {
    next.set(key, {
      text: event.text,
      thinkingTokens: event.thinkingTokens,
      thinkingText: event.thinkingText,
      thinkingSince: event.thinkingSince,
      thinkingStretch: event.thinkingStretch,
      composingTool: event.composingTool,
      composingBytes: event.composingBytes,
      contextTokens: event.contextTokens,
      contextWindowTokens: event.contextWindowTokens,
      spentInputTokens: event.spentInputTokens,
      spentOutputTokens: event.spentOutputTokens,
      spentCacheReadTokens: event.spentCacheReadTokens,
      spentCostUsd: event.spentCostUsd,
      ...(event.spentEstimatedCostUsd == null
        ? {}
        : { spentEstimatedCostUsd: event.spentEstimatedCostUsd }),
      // Replaced whole: an owner whose delegates have all settled sends none,
      // and its last set goes with this event.
      ...(event.delegates == null ? {} : { delegates: event.delegates }),
    });
  }
  return next;
}
