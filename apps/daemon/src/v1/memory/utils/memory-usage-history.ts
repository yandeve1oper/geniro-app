import type { EntityManager } from '@mikro-orm/sqlite';

import {
  HOST_MEMORY_READ_TOOL,
  HOST_MEMORY_SEARCH_TOOL,
  type ToolCallTime,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import { hostMcpServerName } from '../../agents/utils/host-question';
import {
  hostToolArguments,
  hostToolCallNames,
} from '../../agents/utils/host-tool';
import { asRecord, parseJsonColumn } from '../../agents/utils/json-util';
import { pairToolCalls } from '../../agents/utils/thread-timeline';
import { MEMORY_READ_MAX, type MemoryUsageCount } from '../memory.types';
import { usageDay } from './memory-usage-day';

type HistoryTool =
  typeof HOST_MEMORY_READ_TOOL | typeof HOST_MEMORY_SEARCH_TOOL;

/** The fields of a stored `tool_call` or `tool_result` row the history reads. */
export interface MemoryHistoryRow {
  seq: number;
  memberId: string | null;
  inCall: string | null;
  payloadId: string | null;
  toolNameLower: string | null;
  payload: string;
  createdAt: Date;
}

/**
 * The stored (lowercased) names a run's own memory_read and memory_search
 * calls carry: claude's `mcp__geniro-<run8>__<tool>`, cursor's
 * `geniro-<run8>: <tool>` measured on stored rows, and the
 * `geniro-<run8>-<tool>: <tool>` title older cursor builds gave the call. A
 * name in any other spelling counts nothing.
 */
export function memoryHistoryToolNames(
  runId: string,
): Map<string, HistoryTool> {
  const server = hostMcpServerName(runId).toLowerCase();
  const names = new Map<string, HistoryTool>();
  const tools: HistoryTool[] = [HOST_MEMORY_READ_TOOL, HOST_MEMORY_SEARCH_TOOL];
  for (const tool of tools) {
    for (const name of [
      ...hostToolCallNames(server, tool),
      `${server}: ${tool}`,
    ]) {
      names.set(name, tool);
    }
  }
  return names;
}

/**
 * What a run's stored memory calls used, counted per entry and per day of the
 * call: each `memory_read` call answered with entries, and each
 * `memory_search` result's hits. Calls are paired with results by
 * `pairToolCalls`, since ids are unique per conversation, not per run, so
 * `calls` must hold every tool's calls under those ids, not only the memory
 * ones. A result naming another tool (cursor names its results) does not
 * answer a memory call: one never answered must not take the result of a
 * later call that reused its id. Only pairs whose call is before `cutoff`
 * count. An error result and a handle no entry holds count nothing.
 */
export function memoryUsageHistory(
  runId: string,
  calls: readonly MemoryHistoryRow[],
  results: readonly MemoryHistoryRow[],
  idsByHandle: ReadonlyMap<string, string>,
  cutoff: Date,
): MemoryUsageCount[] {
  const names = memoryHistoryToolNames(runId);
  const bySeq = new Map(
    [...calls, ...results].map((row) => [row.seq, row] as const),
  );
  const timed = (
    row: MemoryHistoryRow,
    kind: ToolCallTime['kind'],
  ): ToolCallTime => ({
    seq: row.seq,
    kind,
    memberId: row.memberId,
    inCall: row.inCall,
    at: row.createdAt.getTime(),
    toolId: row.payloadId,
    name: null,
    delegate: false,
    isError: false,
  });
  const rows = [
    ...calls.map((row) => timed(row, 'tool_call')),
    ...results.map((row) => timed(row, 'tool_result')),
  ].sort((a, b) => a.seq - b.seq);
  const pairs = pairToolCalls(rows, 0, false).flatMap((span) => {
    const call = bySeq.get(span.seq);
    const result =
      span.resultSeq === null ? undefined : bySeq.get(span.resultSeq);
    return call && result ? [{ call, result }] : [];
  });
  const counts: MemoryUsageCount[] = [];
  for (const { call, result } of pairs) {
    const tool = names.get(call.toolNameLower ?? '');
    if (
      tool === undefined ||
      call.createdAt >= cutoff ||
      (result.toolNameLower !== null &&
        result.toolNameLower !== call.toolNameLower)
    ) {
      continue;
    }
    const handles =
      tool === HOST_MEMORY_READ_TOOL
        ? readHandles(call.payload, result.payload)
        : searchHandles(result.payload);
    const day = usageDay(call.createdAt);
    for (const handle of new Set(handles)) {
      const memoryId = idsByHandle.get(handle);
      if (memoryId !== undefined) {
        counts.push({
          memoryId,
          day,
          reads: tool === HOST_MEMORY_READ_TOOL ? 1 : 0,
          searchHits: tool === HOST_MEMORY_SEARCH_TOOL ? 1 : 0,
          indexShows: 0,
        });
      }
    }
  }
  return counts;
}

/**
 * {@link memoryUsageHistory} over one run's stored memory calls made before
 * `cutoff`, read with every call and result sharing their ids.
 */
export async function runMemoryUsage(
  items: Pick<ItemDao, 'toolCallsNamed' | 'rowsByPayloadId'>,
  runId: string,
  idsByHandle: ReadonlyMap<string, string>,
  cutoff: Date,
  em: EntityManager,
): Promise<MemoryUsageCount[]> {
  const memoryCalls = await items.toolCallsNamed(
    runId,
    [...memoryHistoryToolNames(runId).keys()],
    em,
  );
  const callIds = [
    ...new Set(
      memoryCalls
        .filter((call) => call.createdAt < cutoff)
        .map((call) => call.payloadId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (callIds.length === 0) {
    return [];
  }
  const sharingIds = await items.rowsByPayloadId(
    runId,
    ['tool_call', 'tool_result'],
    callIds,
    undefined,
    em,
  );
  return memoryUsageHistory(
    runId,
    sharingIds.filter((row) => row.kind === 'tool_call'),
    sharingIds.filter((row) => row.kind === 'tool_result'),
    idsByHandle,
    cutoff,
  );
}

/**
 * The entries a `memory_read` result returned: the entry headers of its text,
 * read outside each entry's fenced body, so a body line shaped like a header
 * is never taken for one. A result with no text (cursor answers
 * `{"success": true}`) falls back to the handles the call asked for.
 *
 * TWIN PARSER: `memoryReadResultText` in
 * `apps/daemon/src/v1/mcp/tools/memory-read/memory-read.reader.ts` and
 * `memoryEntryText` in `apps/daemon/src/v1/mcp/tools/memory-mcp-tool.ts`.
 */
function readHandles(callPayload: string, resultPayload: string): string[] {
  const result = asRecord(parseJsonColumn(resultPayload));
  if (result === null || result.isError === true) {
    return [];
  }
  const text = resultTextOf(result.result);
  if (text === null) {
    return askedHandles(callPayload);
  }
  const lines = text.split('\n');
  const handles: string[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    const header = /^(m\d+) \(rev \d+, /.exec(lines[at] ?? '');
    const fence = /^<(memory-entry-[0-9a-f]+)>$/.exec(lines[at + 2] ?? '');
    if (
      header === null ||
      fence === null ||
      !lines[at + 1]?.startsWith('by ')
    ) {
      continue;
    }
    handles.push(normalizedHandle(header[1]!)!);
    const close = lines.indexOf(`</${fence[1]!}>`, at + 3);
    at = close === -1 ? lines.length : close;
  }
  return handles;
}

/**
 * The hits a `memory_search` result listed, one `- m12 (rev …` line each.
 *
 * TWIN PARSER: `memorySearchResultText` in
 * `apps/daemon/src/v1/mcp/tools/memory-search/memory-search.reader.ts`.
 */
function searchHandles(resultPayload: string): string[] {
  const result = asRecord(parseJsonColumn(resultPayload));
  if (result === null || result.isError === true) {
    return [];
  }
  return [...(resultTextOf(result.result) ?? '').matchAll(/^- (m\d+) \(rev /gm)]
    .map((match) => normalizedHandle(match[1]!))
    .filter((handle): handle is string => handle !== null);
}

/** The `ids` a `memory_read` call asked for, bare or in cursor's `{toolName, args}` wrap. */
function askedHandles(callPayload: string): string[] {
  const input = asRecord(parseJsonColumn(callPayload))?.input;
  const ids = asRecord(hostToolArguments(input, HOST_MEMORY_READ_TOOL))?.ids;
  if (!Array.isArray(ids)) {
    return [];
  }
  return ids
    .slice(0, MEMORY_READ_MAX)
    .map(normalizedHandle)
    .filter((handle): handle is string => handle !== null);
}

/**
 * The text of a result stored bare, as MCP content blocks, or wrapped.
 *
 * TWIN PARSER: `resultTextOf` in `apps/ui/src/renderer/chats/tool-result-text.ts`.
 */
function resultTextOf(result: unknown): string | null {
  if (typeof result === 'string') {
    return result;
  }
  if (Array.isArray(result)) {
    const texts = result.flatMap((block) => {
      const text = asRecord(block)?.text;
      return typeof text === 'string' ? [text] : [];
    });
    return texts.length > 0 ? texts.join('\n') : null;
  }
  const record = asRecord(result);
  return record === null ? null : resultTextOf(record.content);
}

function normalizedHandle(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^m?(\d{1,9})$/i.exec(value.trim());
  return match === null ? null : `m${Number(match[1])}`;
}
