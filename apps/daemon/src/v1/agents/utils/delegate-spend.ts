import type { DelegateFigures } from '../adapters/adapter.types';
import { asNumber, asRecord, asString } from './json-util';

/**
 * The run row's delegate figures (`Run.delegateSpend`): launching tool call
 * id → {@link DelegateFigures}.
 *
 * Read back DEFENSIVELY — a row from an older build or a hand edit costs the
 * entries it cannot read, never the run. A figure that is not a finite,
 * non-negative number reads as null ("not measured"); an entry with no figure
 * at all is dropped.
 */
export function readDelegateSpend(
  json: string | null,
): Map<string, DelegateFigures> {
  const figures = new Map<string, DelegateFigures>();
  if (json === null || json === '') {
    return figures;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return figures;
  }
  for (const [delegateId, value] of Object.entries(asRecord(parsed) ?? {})) {
    const entry = readFigures(value);
    if (delegateId !== '' && entry !== null) {
      figures.set(delegateId, entry);
    }
  }
  return figures;
}

/**
 * The column's value for a set of entries — null when there are none. Keys
 * are sorted so an unchanged set always serializes to the same text, which is
 * what lets a writer skip a write that would change nothing.
 */
export function writeDelegateSpend(
  figures: ReadonlyMap<string, DelegateFigures>,
): string | null {
  const entries = [...figures]
    .filter(([delegateId, entry]) => delegateId !== '' && hasFigure(entry))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([delegateId, entry]) => [delegateId, normalized(entry)] as const);
  return entries.length === 0
    ? null
    : JSON.stringify(Object.fromEntries(entries));
}

function readFigures(value: unknown): DelegateFigures | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const entry: DelegateFigures = {
    requests: count(record.requests),
    inputTokens: count(record.inputTokens),
    outputTokens: count(record.outputTokens),
    cacheReadTokens: count(record.cacheReadTokens),
    cacheCreationTokens: count(record.cacheCreationTokens),
    contextTokens: count(record.contextTokens),
    model: asString(record.model),
    costUsd: money(record.costUsd),
    estimatedCostUsd: money(record.estimatedCostUsd),
    ...(record.messages === undefined
      ? {}
      : { messages: count(record.messages) }),
  };
  return hasFigure(entry) ? entry : null;
}

function normalized(entry: DelegateFigures): DelegateFigures {
  return {
    requests: count(entry.requests),
    inputTokens: count(entry.inputTokens),
    outputTokens: count(entry.outputTokens),
    cacheReadTokens: count(entry.cacheReadTokens),
    cacheCreationTokens: count(entry.cacheCreationTokens),
    contextTokens: count(entry.contextTokens),
    model: entry.model,
    costUsd: money(entry.costUsd),
    estimatedCostUsd: money(entry.estimatedCostUsd),
    ...(entry.messages === undefined
      ? {}
      : { messages: count(entry.messages) }),
  };
}

function hasFigure(entry: DelegateFigures): boolean {
  return [
    entry.requests,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheReadTokens,
    entry.cacheCreationTokens,
    entry.contextTokens,
    entry.costUsd,
    entry.estimatedCostUsd,
  ].some((figure) => figure !== null);
}

function count(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function money(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}
