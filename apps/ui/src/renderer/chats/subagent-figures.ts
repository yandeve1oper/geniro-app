import { useContext } from 'react';

import { type LiveDelegateFigures, LiveDelegatesContext } from './live-text';
import {
  type SubagentBlockEntry,
  subagentBlockStatus,
} from './transcript-groups';

export type { LiveDelegateFigures } from './live-text';

/**
 * What a sub-agent card states about one delegate's spend — the ONE reading of
 * those figures. A card renders from this view and decides nothing of its own.
 *
 * Every figure is null when it was not measured, never zero.
 */
export interface SubagentFiguresView {
  requests: number | null;
  messages: number | null;
  /** Input, output and both cache kinds summed; null without input and output. */
  tokensProcessed: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  /** Calibrated when one stands, else the list-price estimate. */
  costUsd: number | null;
  /** True when the shown cost is the list-price one, or comes from the live channel. */
  costIsEstimate: boolean;
  /**
   * An OLD row's tokens — the last request's figure — shown as the context the
   * delegate ended with. Only for a row that does not sum its requests and has no
   * live reading.
   */
  contextAtEnd: number | null;
  /** The figures came from the live channel. */
  live: boolean;
}

/**
 * The figures a sub-agent card draws, decided once.
 *
 * The live channel beats the block's own figures field by field, and only while
 * the delegate is still working: once it has ended, a reading left standing (a
 * cancelled or untracked turn never sends a final one) must not replace the
 * figures the block holds. A block whose figures are not cumulative contributes
 * none of them, so an old row never reads as a total it does not have.
 */
export function subagentFiguresView(
  entry: SubagentBlockEntry,
  live: LiveDelegateFigures | null,
): SubagentFiguresView {
  const liveNow =
    live !== null && subagentBlockStatus(entry) === 'running' ? live : null;
  const durable = (value: number | null): number | null =>
    entry.cumulative ? value : null;

  const requests = liveNow?.requests ?? durable(entry.requests);
  const inputTokens = liveNow?.inputTokens ?? durable(entry.inputTokens);
  const outputTokens = liveNow?.outputTokens ?? durable(entry.outputTokens);
  const cacheReadTokens =
    liveNow?.cacheReadTokens ?? durable(entry.cacheReadTokens);
  const cacheCreationTokens =
    liveNow?.cacheCreationTokens ?? durable(entry.cacheCreationTokens);
  const contextTokens = liveNow?.contextTokens ?? durable(entry.contextTokens);

  const calibrated = liveNow?.costUsd ?? durable(entry.costUsd);
  const estimated =
    liveNow?.estimatedCostUsd ?? durable(entry.estimatedCostUsd);
  const calibratedFromLive = liveNow !== null && liveNow.costUsd !== null;
  const costUsd = calibrated ?? estimated;

  // Cache legs a CLI does not count stay out of the total rather than read as
  // zero. Input and output are the two the card prints, so without both there is
  // no total at all.
  const tokensProcessed =
    inputTokens === null || outputTokens === null
      ? null
      : [
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheCreationTokens,
        ].reduce<number>((sum, leg) => sum + (leg ?? 0), 0);

  return {
    requests,
    messages: entry.messages,
    tokensProcessed,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    contextTokens,
    costUsd,
    costIsEstimate:
      costUsd !== null && (calibrated === null || calibratedFromLive),
    contextAtEnd: liveNow === null && !entry.cumulative ? entry.tokens : null,
    live: liveNow !== null,
  };
}

/**
 * One delegate's live figures, from whichever owner of the run launched it — the
 * owners are folded into {@link LiveDelegatesContext} once, so this reads a map.
 */
export function useSubagentLiveFigures(
  delegateId: string,
): LiveDelegateFigures | null {
  return useContext(LiveDelegatesContext)?.get(delegateId) ?? null;
}
