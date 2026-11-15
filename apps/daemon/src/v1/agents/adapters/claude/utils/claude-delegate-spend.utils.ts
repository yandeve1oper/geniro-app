import { dirname, join } from 'node:path';

import {
  asArray,
  asNumber,
  asRecord,
  asString,
} from '../../../utils/json-util';
import { isPlainSessionId } from '../../../utils/session-id';
import type { AgentEvent, DelegateFigures, TurnIo } from '../../adapter.types';
import {
  CLAUDE_TASK_NOTIFICATION_SUBTYPE,
  CLAUDE_TASK_TERMINAL_STATUSES,
} from '../claude.const';
import {
  type ClaudeDelegateSpend,
  type ClaudeListPrices,
  listCostUsd,
} from './claude-delegate-cost.utils';
import { eachJsonLine, findSessionFile } from './claude-sessions.utils';

/**
 * One delegate's spend over every model request it made.
 *
 * A request is one model response. claude splits a response into one stream
 * line per content block, every line carrying the same `message.id` and the
 * same `usage` — so a request is counted, and its tokens added, once per id.
 */
export interface ClaudeDelegateTotals extends ClaudeDelegateSpend {
  requests: number;
  /** Responses carrying text, when read from the transcript. */
  messages?: number;
  /** The four kinds of the latest request, summed. */
  contextTokens: number | null;
}

/** One request's usage, off an `assistant` message envelope. */
interface ClaudeRequestUsage {
  id: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  model: string | null;
}

/** How often, and how far apart, a transcript behind its stream is read again. */
const TRANSCRIPT_REREADS = 3;
const TRANSCRIPT_REREAD_MS = 1000;

/** How many delegates the tracker remembers across every live process. */
const MAX_TRACKED_DELEGATES = 256;

/** How many request ids one delegate remembers — its whole run in practice. */
const MAX_REQUEST_IDS_PER_DELEGATE = 4096;

interface DelegateAccount {
  totals: ClaudeDelegateTotals;
  seen: Set<string>;
  costUsd: number | null;
  /** The latest request folded in, for the closing request's comparison. */
  last: ClaudeRequestUsage | null;
}

/**
 * Each live delegate's running totals, built from its own stream lines.
 *
 * The stream is an ESTIMATE of output: the `usage.output_tokens` on a stream
 * line is the count reported when the response STARTED (measured on claude
 * 2.1.325: 17 on the line, 77 in the delegate's own transcript), and the
 * delegate's `message_delta` that carries the final count is not streamed. The
 * delegate's transcript replaces these totals when it ends
 * ({@link ClaudeDelegateSettler}).
 *
 * Keyed by session AND delegate: one adapter drives every claude process, and
 * a member's calls resume one session from several processes.
 */
export class ClaudeDelegateSpendTracker {
  private readonly accounts = new Map<string, DelegateAccount>();

  constructor(private readonly prices: ClaudeListPrices) {}

  /** Fold one stream line of the delegate in; the new figures, or null when unchanged. */
  noteLine(
    sessionId: string | null,
    delegateId: string,
    message: Record<string, unknown>,
  ): DelegateFigures | null {
    const request = readRequestUsage(message);
    if (request === null) {
      return null;
    }
    const account = this.account(sessionId, delegateId);
    if (request.id !== null) {
      if (account.seen.has(request.id)) {
        return null;
      }
      account.seen.add(request.id);
      trimOldest(account.seen, MAX_REQUEST_IDS_PER_DELEGATE);
    }
    addRequest(account.totals, request);
    account.last = request;
    return this.figuresOf(account);
  }

  /**
   * The delegate's closing request, which the stream never carries for a
   * foreground delegate: its final text-only response reaches the parent only
   * as the closing `tool_use_result.usage`.
   */
  noteClosingRequest(
    sessionId: string | null,
    delegateId: string,
    usage: Record<string, unknown>,
    model: string | null,
  ): DelegateFigures | null {
    const request = readUsage(usage, null, model);
    if (request === null) {
      return null;
    }
    const account = this.account(sessionId, delegateId);
    // The closing usage names no response id. When it repeats the last
    // streamed response exactly, that response WAS streamed and is counted.
    if (account.last !== null && sameUsage(account.last, request)) {
      return null;
    }
    addRequest(account.totals, request);
    account.last = request;
    return this.figuresOf(account);
  }

  /** Replace the delegate's totals with figures read from its own transcript. */
  replace(
    sessionId: string | null,
    delegateId: string,
    totals: ClaudeDelegateTotals,
  ): DelegateFigures {
    const account = this.account(sessionId, delegateId);
    account.totals = { ...totals };
    return this.figuresOf(account);
  }

  /** Set the calibrated cost a `result` line priced the delegate at. */
  setCost(
    sessionId: string | null,
    delegateId: string,
    costUsd: number | null,
  ): DelegateFigures | null {
    const account = this.accounts.get(accountKey(sessionId, delegateId));
    if (account === undefined) {
      return null;
    }
    account.costUsd = costUsd;
    return this.figuresOf(account);
  }

  /** What the tracker holds for a delegate, or null when it holds nothing. */
  totalsOf(
    sessionId: string | null,
    delegateId: string,
  ): ClaudeDelegateTotals | null {
    const account = this.accounts.get(accountKey(sessionId, delegateId));
    return account === undefined || account.totals.requests === 0
      ? null
      : { ...account.totals };
  }

  private figuresOf(account: DelegateAccount): DelegateFigures {
    const { totals } = account;
    return {
      requests: totals.requests,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheCreationTokens: totals.cacheCreationTokens,
      contextTokens: totals.contextTokens,
      model: totals.model,
      ...(totals.messages === undefined ? {} : { messages: totals.messages }),
      costUsd: account.costUsd,
      estimatedCostUsd: positiveOrNull(
        totals.model === null
          ? null
          : listCostUsd(totals.model, totals, this.prices),
      ),
    };
  }

  private account(
    sessionId: string | null,
    delegateId: string,
  ): DelegateAccount {
    const key = accountKey(sessionId, delegateId);
    let account = this.accounts.get(key);
    if (account === undefined) {
      account = {
        totals: emptyTotals(),
        seen: new Set(),
        costUsd: null,
        last: null,
      };
      this.accounts.set(key, account);
      trimOldest(this.accounts, MAX_TRACKED_DELEGATES);
    }
    return account;
  }
}

/**
 * Read a delegate's totals from its own transcript, which claude writes beside
 * the session's: `<project>/<sessionId>/subagents/agent-<agentId>.jsonl`.
 * Null when the file cannot be found or read, or records no request.
 */
export async function readClaudeDelegateTranscript(
  profileDir: string,
  sessionId: string,
  cwd: string | null,
  agentId: string,
): Promise<ClaudeDelegateTotals | null> {
  if (!isPlainSessionId(agentId)) {
    return null;
  }
  const sessionFile = await findSessionFile(profileDir, sessionId, cwd);
  if (sessionFile === null) {
    return null;
  }
  const path = join(
    dirname(sessionFile),
    sessionId,
    'subagents',
    `agent-${agentId}.jsonl`,
  );
  return readDelegateTranscriptFile(path);
}

/** {@link readClaudeDelegateTranscript} for a known path. */
export async function readDelegateTranscriptFile(
  path: string,
): Promise<ClaudeDelegateTotals | null> {
  const totals = emptyTotals();
  const seen = new Set<string>();
  const texts = new Set<string>();
  try {
    // A torn last line (claude still appending) is skipped, not fatal: every
    // complete request before it is still exactly what was billed.
    const read = await eachJsonLine(
      path,
      null,
      (line) => {
        if (line.type !== 'assistant') {
          return true;
        }
        const message = asRecord(line.message);
        const request = message === null ? null : readRequestUsage(message);
        if (request === null || request.id === null) {
          return true;
        }
        if (message !== null && hasText(message)) {
          texts.add(request.id);
        }
        if (seen.has(request.id)) {
          return true;
        }
        seen.add(request.id);
        addRequest(totals, request);
        return true;
      },
      undefined,
      'assistant',
    );
    return read && totals.requests > 0
      ? { ...totals, messages: texts.size }
      : null;
  } catch {
    return null;
  }
}

/**
 * Settles a delegate's figures when it ends: reads its transcript (exact
 * output tokens, every request), replaces the stream estimate and announces
 * the final figures — a `delegate_progress` for the live plane and the run row,
 * and a cumulative `subagent_info` for the transcript.
 *
 * Per CLI process, attached to that process's driver: the transcript read is
 * asynchronous, so its events go out through the process's own `emit`.
 *
 * An end is read off the terminal `task_notification` (foreground and
 * background alike) and off a foreground delegate's closing `tool_use_result`,
 * whichever comes first. claude can report a background delegate completed
 * more than once (each time a command it detached reports back), so a settle
 * is a replacement, never an addition, and a read already in flight for the
 * same delegate is run once more after it.
 */
export class ClaudeDelegateSettler {
  private io: TurnIo | null = null;
  private readonly inFlight = new Map<string, boolean>();

  constructor(
    private readonly deps: {
      tracker: ClaudeDelegateSpendTracker;
      launchOfTask: (
        taskId: string,
        toolCallId: string | null,
      ) => string | null;
      priceNow: (
        sessionId: string | null,
        spend: ClaudeDelegateSpend,
      ) => number | null;
      record: (
        sessionId: string | null,
        delegateId: string,
        spend: ClaudeDelegateSpend,
      ) => void;
      readTranscript: (
        sessionId: string,
        agentId: string,
      ) => Promise<ClaudeDelegateTotals | null>;
      /** How a re-read waits; injected so a spec needs no wall clock. */
      wait?: (ms: number) => Promise<void>;
    },
  ) {}

  attach(io: TurnIo): void {
    this.io = io;
  }

  /** Look at one stdout line; schedules a settle when it ends a delegate. */
  observe(obj: unknown): void {
    const end = readDelegateEnd(obj, this.deps.launchOfTask);
    if (end !== null) {
      this.schedule(end);
    }
  }

  /** The settle itself, exposed so a spec can await it. */
  async settle(end: ClaudeDelegateEnd): Promise<AgentEvent[]> {
    const streamed = this.deps.tracker.totalsOf(end.sessionId, end.delegateId);
    const read = await this.readSettled(end, streamed);
    const totals =
      read !== null && (streamed === null || read.requests >= streamed.requests)
        ? read
        : (streamed ?? read);
    if (totals === null) {
      return [];
    }
    this.deps.tracker.replace(end.sessionId, end.delegateId, totals);
    this.deps.record(end.sessionId, end.delegateId, totals);
    const figures = this.deps.tracker.setCost(
      end.sessionId,
      end.delegateId,
      positiveOrNull(this.deps.priceNow(end.sessionId, totals)),
    );
    if (figures === null) {
      return [];
    }
    return [
      {
        type: 'delegate_progress',
        delegateId: end.delegateId,
        figures,
        final: true,
      },
      cumulativeDeclaration(end.delegateId, figures),
    ];
  }

  /**
   * The delegate's transcript, read again while it holds fewer requests than
   * its stream showed: claude announces the end before it has written the
   * last response to that file (measured: a background delegate's final text
   * reply, missing from the first read).
   */
  private async readSettled(
    end: ClaudeDelegateEnd,
    streamed: ClaudeDelegateTotals | null,
  ): Promise<ClaudeDelegateTotals | null> {
    if (end.sessionId === null) {
      return null;
    }
    const sessionId = end.sessionId;
    const read = (): Promise<ClaudeDelegateTotals | null> =>
      this.deps.readTranscript(sessionId, end.agentId).catch(() => null);
    const wait =
      this.deps.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let totals = await read();
    for (
      let attempt = 0;
      attempt < TRANSCRIPT_REREADS &&
      totals !== null &&
      streamed !== null &&
      totals.requests < streamed.requests;
      attempt += 1
    ) {
      await wait(TRANSCRIPT_REREAD_MS);
      totals = await read();
    }
    return totals;
  }

  private schedule(end: ClaudeDelegateEnd): void {
    const key = accountKey(end.sessionId, end.delegateId);
    if (this.inFlight.has(key)) {
      this.inFlight.set(key, true);
      return;
    }
    this.inFlight.set(key, false);
    void this.run(key, end);
  }

  private async run(key: string, end: ClaudeDelegateEnd): Promise<void> {
    try {
      for (const event of await this.settle(end)) {
        this.io?.emit(event);
      }
    } catch {
      // The figures stay the stream's; nothing about the turn depends on them.
    } finally {
      const again = this.inFlight.get(key) === true;
      this.inFlight.delete(key);
      if (again) {
        this.schedule(end);
      }
    }
  }
}

/** One delegate's end, as a stdout line states it. */
export interface ClaudeDelegateEnd {
  sessionId: string | null;
  delegateId: string;
  agentId: string;
}

/** The delegate a line ENDS, or null when it ends none. */
export function readDelegateEnd(
  obj: unknown,
  launchOfTask: (taskId: string, toolCallId: string | null) => string | null,
): ClaudeDelegateEnd | null {
  const root = asRecord(obj);
  if (root === null) {
    return null;
  }
  const sessionId = asString(root.session_id);
  if (
    root.type === 'system' &&
    root.subtype === CLAUDE_TASK_NOTIFICATION_SUBTYPE
  ) {
    const agentId = asString(root.task_id);
    const status = asString(root.status);
    const toolCallId = asString(root.tool_use_id);
    if (
      agentId === null ||
      status === null ||
      !CLAUDE_TASK_TERMINAL_STATUSES.has(status)
    ) {
      return null;
    }
    const delegateId = launchOfTask(agentId, toolCallId);
    return delegateId === null ? null : { sessionId, delegateId, agentId };
  }
  if (root.type === 'user') {
    const result = asRecord(root.tool_use_result);
    const agentId = asString(result?.agentId);
    if (result === null || agentId === null || result.status !== 'completed') {
      return null;
    }
    const content = asRecord(root.message)?.content;
    const closes = asArray(content)
      .map(asRecord)
      .filter((block) => block?.type === 'tool_result')
      .map((block) => asString(block?.tool_use_id))
      .filter((id): id is string => id !== null);
    return closes.length === 1
      ? { sessionId, delegateId: closes[0] ?? '', agentId }
      : null;
  }
  return null;
}

/** The `subagent_info` carrying a delegate's figures over every request. */
export function cumulativeDeclaration(
  delegateId: string,
  figures: DelegateFigures,
): AgentEvent {
  const parts = [
    figures.inputTokens,
    figures.outputTokens,
    figures.cacheReadTokens,
    figures.cacheCreationTokens,
  ];
  return {
    type: 'subagent_info',
    id: delegateId,
    label: null,
    kind: null,
    prompt: null,
    model: figures.model,
    durationMs: null,
    tokens: parts.some((part) => part !== null)
      ? parts.reduce<number>((sum, part) => sum + (part ?? 0), 0)
      : null,
    toolUses: null,
    inputTokens: figures.inputTokens,
    outputTokens: figures.outputTokens,
    cacheReadTokens: figures.cacheReadTokens,
    cacheCreationTokens: figures.cacheCreationTokens,
    costUsd: figures.costUsd,
    estimatedCostUsd: figures.estimatedCostUsd,
    requests: figures.requests,
    contextTokens: figures.contextTokens,
    cumulative: true,
    stepsUnavailableReason: null,
    backgroundOutcome: null,
    backgroundOpen: null,
  };
}

function readRequestUsage(
  message: Record<string, unknown>,
): ClaudeRequestUsage | null {
  const usage = asRecord(message.usage);
  return usage === null
    ? null
    : readUsage(usage, asString(message.id), asString(message.model));
}

function readUsage(
  usage: Record<string, unknown>,
  id: string | null,
  model: string | null,
): ClaudeRequestUsage | null {
  const request: ClaudeRequestUsage = {
    id,
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheCreationTokens: count(usage.cache_creation_input_tokens),
    model,
  };
  return [
    request.inputTokens,
    request.outputTokens,
    request.cacheReadTokens,
    request.cacheCreationTokens,
  ].some((part) => part !== null)
    ? request
    : null;
}

function addRequest(
  totals: ClaudeDelegateTotals,
  request: ClaudeRequestUsage,
): void {
  totals.requests += 1;
  totals.inputTokens = add(totals.inputTokens, request.inputTokens);
  totals.outputTokens = add(totals.outputTokens, request.outputTokens);
  totals.cacheReadTokens = add(totals.cacheReadTokens, request.cacheReadTokens);
  totals.cacheCreationTokens = add(
    totals.cacheCreationTokens,
    request.cacheCreationTokens,
  );
  totals.contextTokens =
    (request.inputTokens ?? 0) +
    (request.outputTokens ?? 0) +
    (request.cacheReadTokens ?? 0) +
    (request.cacheCreationTokens ?? 0);
  totals.model = request.model ?? totals.model;
}

function hasText(message: Record<string, unknown>): boolean {
  return asArray(message.content).some((block) => {
    const record = asRecord(block);
    return (
      record?.type === 'text' && (asString(record.text) ?? '').trim() !== ''
    );
  });
}

function sameUsage(a: ClaudeRequestUsage, b: ClaudeRequestUsage): boolean {
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens
  );
}

function emptyTotals(): ClaudeDelegateTotals {
  return {
    requests: 0,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    contextTokens: null,
    model: null,
  };
}

function add(total: number | null, part: number | null): number | null {
  return part === null ? total : (total ?? 0) + part;
}

function count(value: unknown): number | null {
  const n = asNumber(value);
  return n !== null && Number.isFinite(n) && n >= 0 ? n : null;
}

function positiveOrNull(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value > 0 ? value : null;
}

function accountKey(sessionId: string | null, delegateId: string): string {
  return `${sessionId ?? ''}\u0000${delegateId}`;
}

function trimOldest<K>(
  collection: Map<K, unknown> | Set<K>,
  max: number,
): void {
  while (collection.size > max) {
    const oldest = collection.keys().next();
    if (oldest.done === true) {
      break;
    }
    collection.delete(oldest.value);
  }
}
