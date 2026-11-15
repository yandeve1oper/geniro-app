import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import type {
  AgentEvent,
  BackgroundUnitOutcome,
  DelegateFigures,
  ToolCallMetric,
  TurnImage,
} from '../../adapter.types';
import { CODEX_MCP_TOOL_PREFIX, CODEX_TOOL_NAMES } from '../codex.const';
import type { CodexItem } from '../codex.types';

/** A `ThreadItem` off a notification's `item`, or null when it is not one. */
export function readCodexItem(value: unknown): CodexItem | null {
  const record = asRecord(value);
  const type = record ? asString(record.type) : null;
  const id = record ? asString(record.id) : null;
  if (record === null || type === null || id === null || id === '') {
    return null;
  }
  return { type, id, record };
}

/** One tool call an item opens, before its result. */
interface CodexToolCall {
  name: string;
  input: unknown;
  kind?: string;
  locations?: { path: string; line: number | null }[];
}

/**
 * Every path a `fileChange` item's changes touch, in its own order: each
 * change's `path`, then a move's destination (`kind.move_path`). A change that
 * names no path leaves a null, so a check over the list can refuse what it
 * cannot see rather than skip it.
 */
export function changeTargets(changes: unknown): (string | null)[] {
  return asArray(changes).flatMap((change) => {
    const entry = asRecord(change);
    const movePath = asString(asRecord(entry?.kind)?.move_path);
    return [asString(entry?.path), ...(movePath ? [movePath] : [])];
  });
}

/** The paths a `fileChange` item touches, as the tool call's locations. */
function changedPaths(record: Readonly<Record<string, unknown>>): string[] {
  return changeTargets(record.changes).filter((path): path is string => !!path);
}

/**
 * The tool call an item stands for, or null for an item that is not one
 * (messages, reasoning, a plan, a compaction).
 *
 * `kind` is ACP's tool-kind vocabulary, which the transcript reads first; an
 * MCP call carries none and is named `mcp__<server>__<tool>` instead, the
 * convention every consumer (the renderer's glyphs, geniro's own host-tool
 * recognition) already keys on.
 */
export function toolCallOf(item: CodexItem): CodexToolCall | null {
  const { record } = item;
  switch (item.type) {
    case 'subAgentActivity': {
      // Only the LAUNCH is a call. The `completed` activity reports on a
      // delegate already on screen, and drawing it would add a second block.
      const activity = subAgentActivityOf(item);
      return activity?.kind === 'started'
        ? {
            name: CODEX_TOOL_NAMES.subagent,
            input: { agent: activity.name },
          }
        : null;
    }
    case 'commandExecution':
      return {
        name: CODEX_TOOL_NAMES.command,
        input: {
          command: asString(record.command) ?? '',
          cwd: asString(record.cwd),
        },
        kind: 'execute',
      };
    case 'fileChange': {
      const paths = changedPaths(record);
      return {
        name: CODEX_TOOL_NAMES.fileChange,
        input: { paths },
        kind: 'edit',
        locations: paths.map((path) => ({ path, line: null })),
      };
    }
    case 'mcpToolCall': {
      const server = asString(record.server) ?? 'mcp';
      const tool = asString(record.tool) ?? 'tool';
      return {
        name: `${CODEX_MCP_TOOL_PREFIX}${server}__${tool}`,
        input: record.arguments ?? {},
      };
    }
    case 'dynamicToolCall':
      return {
        name: asString(record.tool) ?? 'tool',
        input: record.arguments ?? {},
      };
    case 'webSearch':
      return {
        name: CODEX_TOOL_NAMES.webSearch,
        input: { query: asString(record.query) ?? '' },
        kind: 'fetch',
      };
    case 'imageView': {
      const path = asString(record.path);
      return {
        name: CODEX_TOOL_NAMES.imageView,
        input: { path },
        kind: 'read',
        ...(path ? { locations: [{ path, line: null }] } : {}),
      };
    }
    case 'collabAgentToolCall':
      return {
        name: collabToolName(record),
        input: {
          prompt: asString(record.prompt),
          model: asString(record.model),
        },
      };
    default:
      return null;
  }
}

/** A collab tool's own name — `spawnAgent` → `spawn_agent`, and so on. */
function collabToolName(record: Readonly<Record<string, unknown>>): string {
  const tool = asString(record.tool);
  if (tool === null) {
    return CODEX_TOOL_NAMES.subagent;
  }
  return tool.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/**
 * The first line of a text, trimmed — cut to `maxChars` with an ellipsis when
 * one is given. A thread's title before it has a name, and a delegate's label.
 */
export function firstLine(text: string, maxChars?: number): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return maxChars !== undefined && line.length > maxChars
    ? `${line.slice(0, maxChars - 1)}…`
    : line;
}

/** One user message as `UserInput` items: its pictures, then its words. */
export function codexUserInput(
  text: string,
  images: readonly TurnImage[] | undefined,
): unknown[] {
  return [
    ...(images ?? []).map((image) => ({
      type: 'localImage',
      path: image.path,
    })),
    { type: 'text', text, text_elements: [] },
  ];
}

/** A command unit's later phase, keyed — like its start — by the item id. */
export function unitPhase(
  id: string,
  phase: 'backgrounded' | 'settled',
): AgentEvent {
  return { type: 'background_work', id, phase, unit: 'other', toolCallId: id };
}

/**
 * A delegate's cumulative figures as its closing `subagent_info` states them.
 * Codex reports no request count, so `requests` is null by definition.
 */
function cumulativeFiguresOf(figures: DelegateFigures) {
  const kinds = [
    figures.inputTokens,
    figures.outputTokens,
    figures.cacheReadTokens,
    figures.cacheCreationTokens,
  ];
  return {
    tokens: kinds.every((kind) => kind === null)
      ? null
      : kinds.reduce<number>((sum, kind) => sum + (kind ?? 0), 0),
    inputTokens: figures.inputTokens,
    outputTokens: figures.outputTokens,
    cacheReadTokens: figures.cacheReadTokens,
    cacheCreationTokens: figures.cacheCreationTokens,
    estimatedCostUsd: figures.estimatedCostUsd,
    requests: null,
    contextTokens: figures.contextTokens,
    cumulative: true as const,
  };
}

/**
 * A delegate's `subagent_info`: whether it is running and how it ended, plus
 * whatever its launch said about it (the brief, its first line as a label, the
 * model). A fact left out is unknown, which the renderer merges past. A closing
 * row given the delegate's figures states them as its cumulative totals.
 */
export function subagentState(
  id: string,
  facts: {
    open?: boolean | null;
    outcome?: BackgroundUnitOutcome | null;
    label?: string | null;
    prompt?: string | null;
    model?: string | null;
    childSessionId?: string;
    figures?: DelegateFigures | null;
  },
): AgentEvent {
  return {
    type: 'subagent_info',
    id,
    label: facts.label ?? null,
    kind: null,
    prompt: facts.prompt ?? null,
    model: facts.model ?? null,
    durationMs: null,
    tokens: null,
    toolUses: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    stepsUnavailableReason: null,
    backgroundOutcome: facts.outcome ?? null,
    backgroundOpen: facts.open ?? null,
    ...(facts.childSessionId === undefined
      ? {}
      : { subagentSessionId: facts.childSessionId }),
    ...(facts.figures == null ? {} : cumulativeFiguresOf(facts.figures)),
  };
}

/**
 * A `subAgentActivity` item: how codex 0.157.1 reports a sub-agent on the
 * PARENT's thread — or null for any other item.
 *
 * MEASURED 2026-09-30 through this daemon's raw frames: a `spawn_agent` call
 * arrives as no `collabAgentToolCall` at all, but as
 * `{type:"subAgentActivity", id:<call id>, kind:"started",
 * agentThreadId, agentPath:"/root/<name>"}` — and once the sub-agent's own
 * turn ends, a second one, `{id:"subagent-completed-<turn id>",
 * kind:"completed", agentThreadId}`, which arrives even after the parent's
 * turn has ended. The sub-agent's thread streams on the same connection in
 * between (its items, its `turn/completed`).
 */
export function subAgentActivityOf(
  item: CodexItem,
): { kind: string; threadId: string; name: string | null } | null {
  if (item.type !== 'subAgentActivity') {
    return null;
  }
  const kind = asString(item.record.kind);
  const threadId = asString(item.record.agentThreadId);
  if (kind === null || threadId === null) {
    return null;
  }
  const path = asString(item.record.agentPath);
  const name =
    path
      ?.split('/')
      .filter((part) => part !== '')
      .pop() ?? null;
  return { kind, threadId, name };
}

/**
 * How a sub-agent ended, from a word codex uses for it — a turn's `status` or
 * a `subAgentActivity`'s `kind` — or null when the word names no ending.
 */
export function subagentOutcomeOf(
  word: string | null,
): BackgroundUnitOutcome | null {
  switch (word) {
    case 'completed':
      return 'completed';
    case 'interrupted':
    case 'cancelled':
    case 'shutdown':
      return 'stopped';
    case 'failed':
    case 'errored':
      return 'failed';
    default:
      return null;
  }
}

/**
 * The `wait` collab calls — codex's own blocking wait on its sub-agents
 * (`CollabAgentTool` `wait`, 0.162.0), which the agent's note tells it to use.
 */
export function waitsOnSubagents(item: CodexItem): boolean {
  return (
    item.type === 'collabAgentToolCall' && asString(item.record.tool) === 'wait'
  );
}

/** The `spawnAgent` collab calls — the ones that start a sub-agent. */
export function spawnsSubagent(item: CodexItem): boolean {
  return (
    item.type === 'collabAgentToolCall' &&
    asString(item.record.tool) === 'spawnAgent'
  );
}

/** The threads a collab call addresses, in its own order. */
export function receiverThreadsOf(item: CodexItem): string[] {
  return asArray(item.record.receiverThreadIds).flatMap((id) => {
    const text = asString(id);
    return text ? [text] : [];
  });
}

/**
 * The sub-agent threads a collab call reports as FINISHED, with how each
 * ended — read off its `agentsStates`, which every collab call carries.
 */
export function finishedAgentsOf(
  item: CodexItem,
): { threadId: string; outcome: 'completed' | 'failed' }[] {
  const states = asRecord(item.record.agentsStates);
  if (states === null) {
    return [];
  }
  const finished: { threadId: string; outcome: 'completed' | 'failed' }[] = [];
  for (const [threadId, state] of Object.entries(states)) {
    const status = asString(asRecord(state)?.status);
    if (status === 'completed') {
      finished.push({ threadId, outcome: 'completed' });
    } else if (status === 'errored' || status === 'shutdown') {
      finished.push({ threadId, outcome: 'failed' });
    }
  }
  return finished;
}

/**
 * One `fileChange` change as the `{path, oldText, newText}` diff the
 * transcript draws.
 *
 * TWIN PARSER: `resultDiffsOf` in `apps/ui/src/renderer/chats/tool-render.ts`
 * reads this `{diffs}` shape off a tool result (the ACP driver writes the same
 * one from ACP's diff blocks). A tool payload is `z.unknown()` on the wire, so
 * no generated type spans the two sides.
 *
 * codex reports a change as a unified diff, not as a before and after, so each
 * side is rebuilt from the hunks: context and removed lines are the old text,
 * context and added lines the new — the region that changed, which is what
 * claude's own `Edit` shows too. A diff with no hunk header is a whole file's
 * content: the new text of an added file, the old text of a deleted one.
 */
export function fileChangeDiffs(
  changes: unknown,
): { path: string | null; oldText: string | null; newText: string }[] {
  const diffs: {
    path: string | null;
    oldText: string | null;
    newText: string;
  }[] = [];
  for (const entry of asArray(changes)) {
    const change = asRecord(entry);
    if (change === null) {
      continue;
    }
    const diff = asString(change.diff) ?? '';
    const kind = asString(asRecord(change.kind)?.type) ?? asString(change.kind);
    // A move names its destination only on the kind; it goes into the label,
    // so a card approving the change shows where the file is going.
    const movePath = asString(asRecord(change.kind)?.move_path);
    const source = asString(change.path);
    const path = movePath ? `${source ?? ''} → ${movePath}` : source;
    if (!/^@@/m.test(diff)) {
      diffs.push(
        kind === 'delete'
          ? { path, oldText: diff, newText: '' }
          : { path, oldText: null, newText: diff },
      );
      continue;
    }
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (const line of diff.split('\n')) {
      if (
        line.startsWith('@@') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('\\')
      ) {
        continue;
      }
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1));
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else {
        const context = line.startsWith(' ') ? line.slice(1) : line;
        oldLines.push(context);
        newLines.push(context);
      }
    }
    diffs.push({
      path,
      oldText: kind === 'add' ? null : oldLines.join('\n'),
      newText: newLines.join('\n'),
    });
  }
  return diffs;
}

/** An item's reasoning text: its summary where it has one, else its raw content. */
function reasoningText(record: Readonly<Record<string, unknown>>): string {
  const join = (value: unknown): string =>
    asArray(value)
      .flatMap((part) => {
        const text = asString(part);
        return text ? [text] : [];
      })
      .join('\n\n');
  return join(record.summary) || join(record.content);
}

/** The events an item's START produces — the tool calls, opened as they begin. */
export function itemStartedEvents(item: CodexItem): AgentEvent[] {
  const call = toolCallOf(item);
  if (call === null) {
    return [];
  }
  return [
    {
      type: 'tool_call',
      id: item.id,
      name: call.name,
      input: call.input,
      ...(call.kind ? { kind: call.kind } : {}),
      ...(call.locations && call.locations.length > 0
        ? { locations: call.locations }
        : {}),
    },
  ];
}

/** Whether a finished tool item FAILED, from its own status and exit code. */
function failed(record: Readonly<Record<string, unknown>>): boolean {
  const status = asString(record.status);
  if (status === 'failed' || status === 'declined') {
    return true;
  }
  const exitCode = asNumber(record.exitCode);
  return exitCode !== null && exitCode !== 0;
}

/** A finished tool item's result, in the shape the transcript reads. */
function toolResultOf(item: CodexItem): unknown {
  const { record } = item;
  switch (item.type) {
    case 'commandExecution':
      return asString(record.status) === 'declined'
        ? 'The command was declined.'
        : (asString(record.aggregatedOutput) ?? '');
    case 'fileChange':
      return { diffs: fileChangeDiffs(record.changes) };
    case 'mcpToolCall': {
      const error = asString(asRecord(record.error)?.message);
      if (error !== null) {
        return error;
      }
      const result = asRecord(record.result);
      return result?.content ?? result?.structuredContent ?? null;
    }
    case 'dynamicToolCall':
      return record.contentItems ?? null;
    case 'collabAgentToolCall':
      return {
        receiverThreadIds: receiverThreadsOf(item),
        agentsStates: record.agentsStates ?? null,
      };
    // The launch's own completion is codex's bookkeeping (it completes in the
    // same millisecond it starts); what the delegate did is its own thread.
    case 'subAgentActivity':
    default:
      return null;
  }
}

/**
 * The events an item's COMPLETION produces: the message or reasoning it
 * finished, or the result of the tool call its start opened.
 */
export function itemCompletedEvents(item: CodexItem): AgentEvent[] {
  const { record } = item;
  switch (item.type) {
    case 'agentMessage':
    case 'plan': {
      const text = asString(record.text);
      return text ? [{ type: 'text', text }] : [];
    }
    case 'reasoning': {
      const text = reasoningText(record);
      return text ? [{ type: 'reasoning', text }] : [];
    }
    default: {
      const call = toolCallOf(item);
      if (call === null) {
        return [];
      }
      return [
        {
          type: 'tool_result',
          id: item.id,
          name: call.name,
          result: toolResultOf(item),
          isError: failed(record),
        },
      ];
    }
  }
}

/**
 * A codex tool call as the tool ledger counts it: the `mcp__<server>__<tool>`
 * name this adapter gives an `mcpToolCall` item is an MCP tool of `<server>`
 * (read as far as its first `__`); every other name is codex's own.
 */
export function codexToolCallMetric(name: string): ToolCallMetric {
  if (!name.startsWith(CODEX_MCP_TOOL_PREFIX)) {
    return { tool: name, server: null };
  }
  const rest = name.slice(CODEX_MCP_TOOL_PREFIX.length);
  const split = rest.indexOf('__');
  return split <= 0 || split + 2 >= rest.length
    ? { tool: name, server: null }
    : { tool: rest.slice(split + 2), server: rest.slice(0, split) };
}
