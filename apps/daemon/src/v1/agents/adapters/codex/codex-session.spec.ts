import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GROUP_KILL_GRACE_MS } from '../../utils/kill-tree';
import type { AgentEvent, AgentTurnInput, TurnIo } from '../adapter.types';
import {
  CODEX_ACTIVE_WRITER_RETRIES,
  CODEX_ACTIVE_WRITER_RETRY_MS,
  CODEX_FAILED_TOOL_RESULT,
  CODEX_STEER_ANSWER_GRACE_MS,
  CODEX_STOP_CLOSE_GRACE_MS,
  CODEX_STOPPED_TOOL_RESULT,
  CODEX_WAIT_GAP_GRACE_MS,
} from './codex.const';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import { codexTurnPolicy } from './utils/codex-policy.utils';

interface Frame {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

let written: string[];
let emitted: AgentEvent[];

function io(): TurnIo {
  return {
    write: (payload) => {
      written.push(payload);
      return true;
    },
    emit: (event) => emitted.push(event),
  };
}

function frames(): Frame[] {
  return written.map((payload) => JSON.parse(payload) as Frame);
}

function lastFrame(): Frame {
  const all = frames();
  return all[all.length - 1]!;
}

function frameFor(method: string): Frame {
  const found = frames().filter((frame) => frame.method === method);
  expect(found.length).toBeGreaterThan(0);
  return found[found.length - 1]!;
}

function turnInput(overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { prompt: 'Fix the test', cwd: '/repo', ...overrides };
}

function optionsFor(input: AgentTurnInput): CodexTurnOptions {
  return {
    input,
    developerInstructions: 'HOST BLOCK',
    config: null,
    policy: codexTurnPolicy(input.approvalMode),
    autoCompactTokens: null,
    mcpDisabled: input.mcpDisabled ?? [],
  };
}

function newSession(first: AgentTurnInput): CodexSession {
  return new CodexSession(
    { clientVersion: '9.9.9', turnOptions: optionsFor },
    first,
  );
}

/** Feed one server line and collect what the session returns. */
function feed(
  session: CodexSession,
  message: Record<string, unknown>,
): AgentEvent[] {
  return session.onMessage(message);
}

const THREAD = '01a0e3aa-7dc4-7703-8a60-497958241fd1';
const TURN = '01a0e3aa-959f-7493-8c1f-01cff8862a2a';

const usage = (lastTotal: number, total: number) => ({
  threadId: THREAD,
  turnId: TURN,
  tokenUsage: {
    total: {
      totalTokens: total,
      inputTokens: total - 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 0,
    },
    last: {
      totalTokens: lastTotal,
      inputTokens: lastTotal - 50,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 0,
    },
    modelContextWindow: 258400,
  },
});

/**
 * Answer the `hooks/list` a turn with an approval mode sends before it opens
 * its thread, as codex does for a user with no hooks; a no-op without one.
 */
function answerHooksList(session: CodexSession): void {
  const list = frames().find((frame) => frame.method === 'hooks/list');
  if (list === undefined) {
    return;
  }
  emitted.push(
    ...feed(session, {
      id: list.id,
      result: { data: [{ cwd: '/repo', errors: [], warnings: [], hooks: [] }] },
    }),
  );
}

/** Open a session through the handshake and the thread, up to its turn/start. */
function openSession(first: AgentTurnInput = turnInput()): CodexSession {
  const session = newSession(first);
  session.onStdinReady(io());
  answerHooksList(session);
  const start = frames().find(
    (frame) =>
      frame.method === 'thread/start' || frame.method === 'thread/resume',
  )!;
  emitted.push(
    ...feed(session, {
      id: start.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    }),
  );
  return session;
}

/** Announce a file-change item touching `path`, as codex does before asking. */
function startFileChange(session: CodexSession, path: string): void {
  feed(session, {
    method: 'item/started',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'fileChange',
        id: 'f',
        changes: [
          { path, kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
        ],
      },
    },
  });
}

/** Answer the newest `turn/start` as codex does when it takes the turn. */
function acceptTurnStart(session: CodexSession, turnId = TURN): void {
  feed(session, {
    id: frameFor('turn/start').id,
    result: { turn: { id: turnId } },
  });
}

beforeEach(() => {
  written = [];
  emitted = [];
});

/** A codex command's unit of work, keyed — like its call — by the item id. */
function commandUnit(
  id: string,
  phase: 'started' | 'backgrounded' | 'settled',
  delegate = false,
): AgentEvent {
  return {
    type: 'background_work',
    id,
    phase,
    unit: 'other',
    toolCallId: id,
    ...(phase === 'started' ? { foreground: true as const } : {}),
    ...(phase === 'started' && delegate
      ? { ownedByDelegate: true as const }
      : {}),
  };
}

describe('opening a conversation', () => {
  it('pipelines the handshake and the hook listing, then opens the thread carrying the instruction block', () => {
    const session = newSession(
      turnInput({ model: 'gpt-5.5', approvalMode: 'ask' }),
    );
    session.onStdinReady(io());
    expect(frames().map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'hooks/list',
    ]);
    answerHooksList(session);
    const sent = frames();
    expect(sent.map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'hooks/list',
      'thread/start',
    ]);
    expect(sent[0]!.params).toMatchObject({
      clientInfo: { name: 'geniro', version: '9.9.9' },
      capabilities: { experimentalApi: true },
    });
    expect(sent[3]!.params).not.toHaveProperty('config');
    expect(sent[3]!.params).toMatchObject({
      cwd: '/repo',
      model: 'gpt-5.5',
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
      developerInstructions: 'HOST BLOCK',
    });
  });

  it('announces the thread as the session, then sends the prompt with the turn’s own settings', () => {
    const session = newSession(
      turnInput({ model: 'gpt-5.5', effort: 'high', approvalMode: 'auto' }),
    );
    session.onStdinReady(io());
    answerHooksList(session);
    const start = frameFor('thread/start');
    const events = feed(session, {
      id: start.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(events).toEqual([
      { type: 'session', sessionId: THREAD },
      { type: 'turn_model', model: 'gpt-5.5' },
    ]);
    expect(frameFor('turn/start').params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'Fix the test', text_elements: [] }],
      cwd: '/repo',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      model: 'gpt-5.5',
      effort: 'high',
      summary: 'auto',
    });
  });

  it('sends pasted images as local image inputs ahead of the words', () => {
    openSession(
      turnInput({
        images: [{ path: '/att/shot.png', mediaType: 'image/png' }],
      }),
    );
    expect(frameFor('turn/start').params?.input).toEqual([
      { type: 'localImage', path: '/att/shot.png' },
      { type: 'text', text: 'Fix the test', text_elements: [] },
    ]);
  });

  it('reports a failed handshake once, not once per frame pipelined behind it', () => {
    const session = newSession(turnInput());
    session.onStdinReady(io());
    const [initialize] = frames();
    expect(
      feed(session, {
        id: initialize!.id,
        error: { code: -32600, message: 'unsupported client' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex: the handshake failed: unsupported client',
      },
    ]);
    expect(
      feed(session, {
        id: frameFor('thread/start').id,
        error: { code: -32600, message: 'not initialized' },
      }),
    ).toEqual([]);
  });

  it('reopens a thread without asking for its history back', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    expect(frameFor('thread/resume').params).toMatchObject({
      threadId: THREAD,
      excludeTurns: true,
    });
  });

  it('fails the turn when the reply to its resume was too long to read', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const resume = frameFor('thread/resume');
    const events = session.onDroppedLine(
      `{"id":${String(resume.id)},"result":{"thread":{"id":"${THREAD}","turns":[`,
      9_677_834,
    );
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'codex could not reopen this conversation: its reply was 9677834 characters, too long to read as one line',
      },
    ]);
    expect(frames().some((frame) => frame.method === 'turn/start')).toBe(false);
    expect(
      feed(session, { id: resume.id, result: { thread: { id: THREAD } } }),
    ).toEqual([]);
  });

  it('leaves its requests waiting when the dropped line answered none of them', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    expect(
      session.onDroppedLine(
        '{"method":"item/completed","params":{"item":{"type":"commandExecution"',
        9_000_000,
      ),
    ).toEqual([]);
    expect(
      feed(session, {
        id: frameFor('thread/resume').id,
        result: { thread: { id: THREAD }, model: 'gpt-5.5' },
      }),
    ).toContainEqual({ type: 'session', sessionId: THREAD });
  });

  it('keeps the original thread for a retry when codex refuses to resume it', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const resume = frameFor('thread/resume');
    expect(resume.params).toMatchObject({ threadId: THREAD });
    const events = feed(session, {
      id: resume.id,
      error: { code: -32600, message: 'thread not found' },
    });
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain(
      'thread not found',
    );
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
    expect(frames().some((frame) => frame.method === 'turn/start')).toBe(false);
    expect(session.threadId).toBeNull();
    session.openTurn(io(), turnInput({ resumeSessionId: THREAD }));
    const retry = frames()
      .filter((frame) => frame.method === 'thread/resume')
      .at(-1)!;
    expect(retry.id).not.toBe(resume.id);
    expect(retry.params).toMatchObject({ threadId: THREAD });
    expect(
      feed(session, { id: retry.id, result: { thread: { id: THREAD } } }),
    ).toContainEqual({ type: 'session', sessionId: THREAD });
    expect(frameFor('turn/start').params).toMatchObject({ threadId: THREAD });
  });
});

describe('a thread another codex process holds', () => {
  const HELD = {
    code: -32600,
    message: `thread ${THREAD} already has an active writer`,
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Refuse the newest `thread/resume` as held, then let any retry fire. */
  function refuseHeld(session: CodexSession): AgentEvent[] {
    const events = feed(session, {
      id: frameFor('thread/resume').id,
      error: HELD,
    });
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    return events;
  }

  /** The first ask, and every retry after it, all refused. */
  function refuseUntilItFails(session: CodexSession): AgentEvent[] {
    let events: AgentEvent[] = [];
    for (
      let attempt = 0;
      attempt <= CODEX_ACTIVE_WRITER_RETRIES;
      attempt += 1
    ) {
      events = refuseHeld(session);
    }
    return events;
  }

  it('asks for longer than a process geniro is replacing takes to be killed', () => {
    // The holder is routinely geniro's own previous process, and a group still
    // alive GROUP_KILL_GRACE_MS after it is asked to end is killed outright —
    // so a resume refused for that whole stretch must still be asked again.
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const refusalsWithinGrace = Math.ceil(
      GROUP_KILL_GRACE_MS / CODEX_ACTIVE_WRITER_RETRY_MS,
    );
    for (let refusal = 0; refusal < refusalsWithinGrace; refusal += 1) {
      expect(refuseHeld(session)).toEqual([]);
    }
    feed(session, {
      id: frameFor('thread/resume').id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(frameFor('turn/start').params).toMatchObject({ threadId: THREAD });
  });

  it('asks again while a process geniro just replaced lets go, then runs the turn', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    expect(refuseHeld(session)).toEqual([]);
    const resumes = frames().filter(
      (frame) => frame.method === 'thread/resume',
    );
    expect(resumes).toHaveLength(2);
    feed(session, {
      id: resumes[1]!.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(frameFor('turn/start').params).toMatchObject({ threadId: THREAD });
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('fails the turn, rather than forking the conversation, once it stays held', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    const events = refuseUntilItFails(session);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'error' });
    expect((events[0] as { message: string }).message).toContain(
      'another codex process has it open',
    );
    // A fresh thread's id would replace the run's session for good.
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('drops a retry still waiting when a newer turn has opened', () => {
    // Sent under the new turn it would be that turn's resume twice over, and
    // its reply would begin the turn a second time.
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    feed(session, { id: frameFor('thread/resume').id, error: HELD });
    session.openTurn(
      io(),
      turnInput({ prompt: 'next', resumeSessionId: THREAD }),
    );
    written = [];
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    expect(written).toEqual([]);
  });

  it('asks nothing once the process has gone', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    let obstacle: string | null = null;
    session.onStdinReady({ ...io(), writeObstacle: () => obstacle });
    feed(session, { id: frameFor('thread/resume').id, error: HELD });
    obstacle = 'the process exited';
    written = [];
    vi.advanceTimersByTime(CODEX_ACTIVE_WRITER_RETRY_MS);
    expect(written).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it('reopens the thread on the next turn, after one that could not', () => {
    const session = newSession(turnInput({ resumeSessionId: THREAD }));
    session.onStdinReady(io());
    refuseUntilItFails(session);
    written = [];
    session.openTurn(
      io(),
      turnInput({ prompt: 'again', resumeSessionId: THREAD }),
    );
    expect(frames().map((frame) => frame.method)).toEqual(['thread/resume']);
    feed(session, {
      id: frameFor('thread/resume').id,
      result: { thread: { id: THREAD } },
    });
    expect(frameFor('turn/start').params).toMatchObject({
      threadId: THREAD,
      input: [{ type: 'text', text: 'again', text_elements: [] }],
    });
  });
});

describe('a turn', () => {
  it('streams the answer and settles with the turn’s own usage and final text', () => {
    const session = openSession();
    const turnStart = frameFor('turn/start');
    feed(session, { id: turnStart.id, result: { turn: { id: TURN } } });
    expect(
      feed(session, {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD, turnId: TURN, itemId: 'm', delta: 'O' },
      }),
    ).toEqual([{ type: 'text_delta', text: 'O' }]);
    expect(
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: usage(16_000, 36_000),
      }),
    ).toEqual([
      {
        type: 'context_progress',
        contextTokens: 16_000,
        contextWindowTokens: 258400,
        contextModel: 'gpt-5.5',
      },
      // What the reading ADDED, live — the first reading's own request. No
      // running cost: nothing here can price the model.
      {
        type: 'usage_progress',
        inputTokens: 15_950,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
    ]);
    expect(
      feed(session, {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'agentMessage',
            id: 'm',
            text: 'OK',
            phase: 'final_answer',
          },
        },
      }),
    ).toEqual([{ type: 'text', text: 'OK' }]);
    const [terminal] = feed(session, {
      method: 'turn/completed',
      params: {
        threadId: THREAD,
        turn: { id: TURN, status: 'completed', error: null, durationMs: 8316 },
      },
    });
    expect(terminal).toMatchObject({
      type: 'turn_complete',
      finalText: 'OK',
      stopReason: 'completed',
      usage: {
        // The first reading's own request, not the thread's whole total.
        inputTokens: 15_950,
        outputTokens: 50,
        contextTokens: 16_000,
        durationMs: 8316,
      },
    });
  });

  it('prices the settled turn at the THREAD model’s list price', () => {
    const asked: (string | null)[] = [];
    const session = new CodexSession(
      {
        clientVersion: '9.9.9',
        turnOptions: optionsFor,
        listPriceOf: (model) => {
          asked.push(model);
          return {
            input: 4,
            output: 20,
            cacheRead: 0.4,
            cacheWrite: 5,
            tiers: [],
            contextTokens: null,
          };
        },
      },
      turnInput(),
    );
    session.onStdinReady(io());
    feed(session, {
      id: frameFor('thread/start').id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    acceptTurnStart(session);
    const live = feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    // The running cost rides the live plane as the reading lands…
    const running = live.find((event) => event.type === 'cost_progress');
    expect(
      running?.type === 'cost_progress' ? running.costUsd : undefined,
    ).toBeCloseTo(0.0648, 10);
    // codex states no price, so all of it is geniro's list-price estimate.
    expect(
      running?.type === 'cost_progress' ? running.estimatedCostUsd : undefined,
    ).toBeCloseTo(0.0648, 10);
    const [zero, terminal] = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    // …and is zeroed AHEAD of the row that records the same money, so a
    // reader adding the live figure to the totals never counts it twice.
    expect(zero).toEqual({ type: 'cost_progress', costUsd: 0 });

    // The model codex said the thread runs on — not the one the turn asked for.
    expect(asked.length).toBeGreaterThan(0);
    expect(new Set(asked)).toEqual(new Set(['gpt-5.5']));
    // 15,950 fresh input × $4 + 50 output × $20, per million.
    expect(terminal).toMatchObject({ type: 'turn_complete' });
    expect(
      terminal?.type === 'turn_complete' ? terminal.usage?.costUsd : undefined,
    ).toBeCloseTo(0.0648, 10);
  });

  it('leaves the turn unpriced when nothing can price its model', () => {
    const session = openSession();
    acceptTurnStart(session);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    const [terminal] = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    expect(terminal).toMatchObject({
      type: 'turn_complete',
      usage: { costUsd: null, inputTokens: 15_950 },
    });
  });

  it('ignores a completion that names another turn, and settles on its own', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: 'a-turn-this-one-never-started', status: 'completed' },
        },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      })[0],
    ).toMatchObject({ type: 'turn_complete' });
  });

  it('says so when codex ran the turn on another model, and labels the context with it', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'model/rerouted',
        params: {
          threadId: THREAD,
          turnId: TURN,
          fromModel: 'gpt-5.5',
          toModel: 'gpt-5.4-mini',
          reason: 'safety',
        },
      }),
    ).toEqual([
      {
        type: 'notice',
        severity: 'info',
        message:
          'codex ran this turn on gpt-5.4-mini instead of gpt-5.5 (safety).',
      },
      { type: 'turn_model', model: 'gpt-5.4-mini' },
    ]);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    const [terminal] = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    expect(terminal).toMatchObject({
      type: 'turn_complete',
      usage: { contextModel: 'gpt-5.4-mini' },
    });
  });

  it('ignores a reroute that names no model to run on', () => {
    const session = openSession();
    acceptTurnStart(session);
    expect(
      feed(session, {
        method: 'model/rerouted',
        params: { threadId: THREAD, turnId: TURN, fromModel: 'gpt-5.5' },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: usage(16_000, 36_000),
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'context_progress',
        contextModel: 'gpt-5.5',
      }),
    );
  });

  it('streams reasoning as it arrives, from the summary and from the raw text', () => {
    const session = openSession();
    acceptTurnStart(session);
    const delta = (method: string, text: string) =>
      feed(session, {
        method,
        params: { threadId: THREAD, turnId: TURN, itemId: 'r', delta: text },
      });
    expect(
      delta('item/reasoning/summaryTextDelta', 'Reading the test'),
    ).toEqual([{ type: 'reasoning_delta', text: 'Reading the test' }]);
    expect(delta('item/reasoning/textDelta', 'the cap is off by one')).toEqual([
      { type: 'reasoning_delta', text: 'the cap is off by one' },
    ]);
    // A delta with nothing in it is not an event.
    expect(delta('item/reasoning/textDelta', '')).toEqual([]);
  });

  it('settles a failed turn as an error carrying codex’s message', () => {
    const session = openSession();
    feed(session, {
      method: 'error',
      params: {
        threadId: THREAD,
        turnId: TURN,
        willRetry: false,
        error: {
          message: "You've hit your usage limit. Try again at 6:10 PM.",
        },
      },
    });
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: { id: TURN, status: 'failed', error: null },
        },
      }),
    ).toEqual([
      {
        type: 'error',
        message: "You've hit your usage limit. Try again at 6:10 PM.",
      },
    ]);
  });

  it('closes a failed turn’s unfinished tool call ahead of the error, and only that one', () => {
    const session = openSession();
    const command = (id: string) => ({
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'commandExecution', id, command: 'make build' },
    });
    feed(session, { method: 'item/started', params: command('done') });
    feed(session, { method: 'item/completed', params: command('done') });
    feed(session, { method: 'item/started', params: command('open') });
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: THREAD,
          turn: {
            id: TURN,
            status: 'failed',
            error: { message: 'stream disconnected' },
          },
        },
      }),
    ).toEqual([
      // A one-shot command ends with its turn.
      commandUnit('open', 'settled'),
      {
        type: 'tool_result',
        id: 'open',
        name: 'shell',
        result: CODEX_FAILED_TOOL_RESULT,
        isError: true,
      },
      { type: 'error', message: 'stream disconnected' },
    ]);
  });

  it('reports a retry as a notice without settling the turn', () => {
    const session = openSession();
    const events = feed(session, {
      method: 'error',
      params: {
        threadId: THREAD,
        willRetry: true,
        error: { message: 'stream disconnected' },
      },
    });
    expect(events).toEqual([
      {
        type: 'notice',
        severity: 'warning',
        message: 'codex: stream disconnected — retrying',
      },
    ]);
  });

  it('keeps the plan as a snapshot task list', () => {
    const session = openSession();
    expect(
      feed(session, {
        method: 'turn/plan/updated',
        params: {
          threadId: THREAD,
          turnId: TURN,
          explanation: null,
          plan: [
            { step: 'Read the failing test', status: 'completed' },
            { step: 'Fix the parser', status: 'inProgress' },
            { step: 'Run the suite', status: 'pending' },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'task_list',
        mode: 'snapshot',
        toolCallId: null,
        tasks: [
          {
            id: '1',
            title: 'Read the failing test',
            status: 'completed',
            activeForm: null,
          },
          {
            id: '2',
            title: 'Fix the parser',
            status: 'in_progress',
            activeForm: null,
          },
          {
            id: '3',
            title: 'Run the suite',
            status: 'pending',
            activeForm: null,
          },
        ],
      },
    ]);
  });
});

describe('approvals and questions', () => {
  it('parks a command request as a card and answers the verdict exactly once', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const [card] = feed(session, {
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'c',
        command: 'npm test',
        cwd: '/repo',
      },
    });
    expect(card).toEqual({
      type: 'approval_request',
      id: 'n:41',
      toolName: 'shell',
      input: { command: 'npm test', cwd: '/repo' },
      options: [
        {
          id: 'session',
          label: 'Allow for this session',
          allow: true,
          scope: 'session',
        },
      ],
    });
    const reply = session.buildApprovalResponse('n:41', true);
    expect(JSON.parse(reply!)).toMatchObject({
      id: 41,
      result: { decision: 'accept' },
    });
    expect(session.buildApprovalResponse('n:41', true)).toBeUndefined();
  });

  it("answers the card's session-long option with `acceptForSession`", () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const [card] = feed(session, {
      id: 43,
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'c',
        command: 'npm test',
        cwd: '/repo',
      },
    });
    const option =
      card?.type === 'approval_request' ? card.options?.[0] : undefined;
    expect(
      JSON.parse(
        session.buildApprovalResponse('n:43', true, undefined, option)!,
      ),
    ).toMatchObject({ id: 43, result: { decision: 'acceptForSession' } });
  });

  it('lets `acceptEdits` file changes through without a card', () => {
    const session = openSession(turnInput({ approvalMode: 'acceptEdits' }));
    startFileChange(session, '/repo/src/a.ts');
    const events = feed(session, {
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(events).toEqual([]);
    expect(lastFrame()).toMatchObject({
      id: 42,
      result: { decision: 'accept' },
    });
  });

  it('still cards an `acceptEdits` change to a file outside the folder', () => {
    const session = openSession(turnInput({ approvalMode: 'acceptEdits' }));
    startFileChange(session, '/Users/me/.zshrc');
    const [card] = feed(session, {
      id: 49,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(card).toMatchObject({ type: 'approval_request' });
  });

  it('cards an MCP tool approval under the call’s own name and accepts it', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const args = { title: 'Probe', metrics: [{ label: 'Tests', value: '43' }] };
    feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'mcpToolCall',
          id: 'exec-1',
          server: 'geniro-031a2e69',
          tool: 'show_metrics',
          status: 'inProgress',
          arguments: args,
        },
      },
    });
    const [card] = feed(session, {
      id: 50,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: THREAD,
        turnId: TURN,
        serverName: 'geniro-031a2e69',
        mode: 'form',
        message:
          'Allow the geniro-031a2e69 MCP server to run tool "show_metrics"?',
        requestedSchema: { type: 'object', properties: {} },
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_params: args },
      },
    });
    expect(card).toEqual({
      type: 'approval_request',
      id: 'n:50',
      toolName: 'mcp__geniro-031a2e69__show_metrics',
      input: args,
    });
    const reply = JSON.parse(session.buildApprovalResponse('n:50', true)!);
    expect(reply).toMatchObject({ id: 50 });
    expect(reply.result).toEqual({
      action: 'accept',
      content: {},
      _meta: null,
    });
  });

  it('cards a permissions request and grants what it asked for', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const permissions = { network: { enabled: true } };
    const [card] = feed(session, {
      id: 51,
      method: 'item/permissions/requestApproval',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'p',
        permissions,
        reason: 'fetch the schema',
      },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      input: { permissions, reason: 'fetch the schema' },
    });
    expect(
      JSON.parse(session.buildApprovalResponse('n:51', true)!).result,
    ).toEqual({ permissions, scope: 'turn' });
  });

  it('still cards a file change under `ask`', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    const [card] = feed(session, {
      id: 43,
      method: 'item/fileChange/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'f' },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      toolName: 'apply_patch',
    });
  });

  it('raises a question as a card that needs the user', () => {
    const session = openSession(turnInput({ approvalMode: 'plan' }));
    const [card] = feed(session, {
      id: 44,
      method: 'item/tool/requestUserInput',
      params: {
        threadId: THREAD,
        turnId: TURN,
        itemId: 'q',
        questions: [
          { id: 'q1', header: 'DB', question: 'Which DB?', options: [] },
        ],
      },
    });
    expect(card).toMatchObject({
      type: 'approval_request',
      toolName: 'request_user_input',
      requiresUserInteraction: true,
      questions: [
        {
          question: 'Which DB?',
          header: 'DB',
          options: [],
          multiSelect: false,
        },
      ],
    });
  });

  it('declines an MCP input request in-protocol and says so', () => {
    const session = openSession();
    const events = feed(session, {
      id: 45,
      method: 'mcpServer/elicitation/request',
      params: { threadId: THREAD, serverName: 's', mode: 'url' },
    });
    expect(events[0]).toMatchObject({ type: 'notice' });
    expect(lastFrame()).toMatchObject({
      id: 45,
      result: { action: 'decline' },
    });
  });

  it('refuses a request it does not know with method-not-found', () => {
    const session = openSession();
    feed(session, { id: 46, method: 'item/tool/call', params: {} });
    expect(lastFrame()).toMatchObject({ id: 46, error: { code: -32601 } });
  });
});

describe('mid-turn', () => {
  it('steers the running turn with a follow-up once codex has named it', () => {
    const session = openSession();
    expect(session.sendFollowUp({ text: 'also update the docs' })).toBe(false);
    feed(session, {
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN, status: 'inProgress' } },
    });
    expect(session.sendFollowUp({ text: 'also update the docs' })).toBe(true);
    expect(lastFrame()).toMatchObject({
      method: 'turn/steer',
      params: {
        threadId: THREAD,
        expectedTurnId: TURN,
        input: [
          { type: 'text', text: 'also update the docs', text_elements: [] },
        ],
      },
    });
  });

  it('says so, quoting the message, when codex will not take a follow-up into the turn', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'also update the docs' });
    const steer = frameFor('turn/steer');
    const events = feed(session, {
      id: steer.id,
      error: { code: -32600, message: 'turn already finishing' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'notice' });
    const { message } = events[0] as { message: string };
    expect(message).toContain('turn already finishing');
    expect(message).toContain('"also update the docs"');
  });

  it('reports a refused steer of a message with a row as that message not sent', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({
      text: 'also update the docs',
      deliveryId: 'delivery-1',
    });

    const events = feed(session, {
      id: frameFor('turn/steer').id,
      error: { code: -32600, message: 'turn already finishing' },
    });

    expect(events).toEqual([
      {
        type: 'follow_up_dropped',
        deliveryIds: ['delivery-1'],
        reason: 'turn already finishing',
      },
    ]);
  });

  describe('a turn that ends while a steer is unanswered', () => {
    const COMPLETED = {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    };
    const INTERRUPTED = {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
    };
    /** codex taking the steer into the turn, as it shows it. */
    const TAKEN = {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'userMessage',
          id: 'steer-item',
          content: [
            { type: 'text', text: 'also update the docs', text_elements: [] },
          ],
        },
      },
    };
    function steered(): { session: CodexSession; steerId: unknown } {
      const session = openSession();
      acceptTurnStart(session);
      session.sendFollowUp({
        text: 'also update the docs',
        deliveryId: 'delivery-1',
      });
      return { session, steerId: frameFor('turn/steer').id };
    }

    it('holds its ending until the refusal, which is reported ahead of it', () => {
      const { session, steerId } = steered();

      expect(feed(session, COMPLETED)).toEqual([]);
      const events = feed(session, {
        id: steerId,
        error: { code: -32600, message: 'no active turn' },
      });

      expect(events.map((event) => event.type)).toEqual([
        'follow_up_dropped',
        'turn_complete',
      ]);
    });

    it('reports a steer codex never answered as dropped when the process ends', () => {
      // Measured in the app: a chat's Stop closes the session in the same
      // tick as the steer, and codex's rollout records the turn aborted with
      // no trace of the message.
      const { session } = steered();

      expect(session.onProcessEnded()).toEqual([
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      ]);
      // Once: the process-end path writes the terminal, not a held ending.
      expect(session.onProcessEnded()).toEqual([]);
    });

    it('reports nothing on process end for a steer codex took', () => {
      const { session, steerId } = steered();
      feed(session, { id: steerId, result: {} });
      feed(session, TAKEN);

      expect(session.onProcessEnded()).toEqual([]);
    });

    it('reports a steer codex accepted but never took as dropped when the process ends', () => {
      const { session, steerId } = steered();
      feed(session, { id: steerId, result: {} });

      expect(session.onProcessEnded()).toEqual([
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      ]);
    });

    it('reports an accepted steer the stop discarded ahead of the cancel', () => {
      // PROBED on codex 0.162.0, three of three: a steer accepted just before
      // the interrupt gets no `userMessage` item and is not in the thread.
      const { session, steerId } = steered();
      feed(session, { id: steerId, result: {} });

      const events = feed(session, INTERRUPTED);

      expect(
        events.filter((event) => event.type === 'follow_up_dropped'),
      ).toEqual([{ type: 'follow_up_dropped', deliveryIds: ['delivery-1'] }]);
      expect(events.map((event) => event.type).slice(-2)).toEqual([
        'follow_up_dropped',
        'turn_cancelled',
      ]);
    });

    it('reports nothing for a steer codex took before the stop, its item ahead of its reply or after', () => {
      const after = steered();
      feed(after.session, { id: after.steerId, result: {} });
      feed(after.session, TAKEN);
      const before = steered();
      feed(before.session, TAKEN);
      feed(before.session, { id: before.steerId, result: {} });

      for (const { session } of [after, before]) {
        expect(
          feed(session, INTERRUPTED).some(
            (event) => event.type === 'follow_up_dropped',
          ),
        ).toBe(false);
      }
    });

    it('asks a closing session to wait only while a steer is still unconfirmed', () => {
      const { session, steerId } = steered();
      expect(session.closeGraceMs()).toBe(CODEX_STOP_CLOSE_GRACE_MS);
      feed(session, { id: steerId, result: {} });
      expect(session.closeGraceMs()).toBe(CODEX_STOP_CLOSE_GRACE_MS);

      feed(session, TAKEN);

      expect(session.closeGraceMs()).toBe(0);
    });

    it('releases its ending when codex takes the steer', () => {
      const { session, steerId } = steered();
      feed(session, COMPLETED);

      expect(
        feed(session, { id: steerId, result: {} }).map((event) => event.type),
      ).toEqual(['turn_complete']);
    });

    it('ends after the grace, and a refusal later than that is a notice quoting the message', () => {
      vi.useFakeTimers();
      try {
        const { session, steerId } = steered();
        feed(session, COMPLETED);
        emitted = [];

        vi.advanceTimersByTime(CODEX_STEER_ANSWER_GRACE_MS);
        expect(emitted.map((event) => event.type)).toEqual(['turn_complete']);

        const late = feed(session, {
          id: steerId,
          error: { code: -32600, message: 'no active turn' },
        });
        expect(late).toEqual([
          expect.objectContaining({
            type: 'notice',
            message: expect.stringContaining('"also update the docs"'),
          }),
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('lets a Stop end the held turn at once, with its own ending', () => {
      const { session } = steered();
      feed(session, COMPLETED);
      emitted = [];

      expect(session.withdrawHeldPrompt()).toBe(true);
      expect(emitted.map((event) => event.type)).toEqual(['turn_complete']);
      expect(session.withdrawHeldPrompt()).toBe(false);
    });
  });

  it('quotes only the start of a long refused message', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'x'.repeat(200) });
    const events = feed(session, {
      id: frameFor('turn/steer').id,
      error: { code: -32600, message: 'no active turn' },
    });
    const { message } = events[0] as { message: string };
    expect(message).toContain(`"${'x'.repeat(59)}…"`);
    expect(message).not.toContain('x'.repeat(61));
  });

  it('still says so when a refused steer answers after the next turn has opened', () => {
    const session = openSession();
    acceptTurnStart(session);
    session.sendFollowUp({ text: 'also update the docs' });
    const steer = frameFor('turn/steer');
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    // The only signal the user gets that the message was not taken, so it is
    // not dropped with the turn it belonged to — and it names the message, since
    // "this turn" would point at the wrong one.
    const events = feed(session, {
      id: steer.id,
      error: { code: -32600, message: 'no active turn' },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'notice' });
    expect((events[0] as { message: string }).message).toContain(
      '"also update the docs"',
    );
  });

  it('takes a refused interrupt quietly, leaving the turn to settle', () => {
    const session = openSession();
    acceptTurnStart(session);
    const interrupt = JSON.parse(session.buildInterruptPayload()!) as Frame;
    expect(
      feed(session, {
        id: interrupt.id,
        error: { code: -32600, message: 'turn not running' },
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      })[0],
    ).toMatchObject({ type: 'turn_complete' });
  });

  it('stops the turn in-protocol and settles it cancelled', () => {
    const session = openSession();
    expect(session.buildInterruptPayload()).toBeUndefined();
    feed(session, {
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: TURN } },
    });
    expect(JSON.parse(session.buildInterruptPayload()!)).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: THREAD, turnId: TURN },
    });
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
      }),
    ).toEqual([{ type: 'turn_cancelled' }]);
  });
});

describe('later turns on the kept process', () => {
  it('opens the next turn with a turn/start and no second handshake', () => {
    const session = openSession();
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    written = [];
    session.openTurn(io(), turnInput({ prompt: 'next', approvalMode: 'ask' }));
    expect(frames().map((frame) => frame.method)).toEqual(['turn/start']);
    expect(frameFor('turn/start').params).toMatchObject({
      input: [{ type: 'text', text: 'next', text_elements: [] }],
      approvalPolicy: 'untrusted',
    });
  });

  it('fails a turn whose settings cannot be built, instead of throwing past it', () => {
    // `openTurn` must stay total: spawn-cli has already registered the turn.
    const session = new CodexSession(
      {
        clientVersion: '9.9.9',
        turnOptions: (input) => {
          if (input.prompt === 'boom') {
            throw new Error('no policy for this turn');
          }
          return optionsFor(input);
        },
      },
      turnInput(),
    );
    session.onStdinReady(io());
    feed(session, {
      id: frameFor('thread/start').id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    emitted = [];
    session.openTurn(io(), turnInput({ prompt: 'boom' }));
    expect(emitted).toEqual([
      {
        type: 'error',
        message: 'codex: could not open this turn: no policy for this turn',
      },
    ]);
  });

  it('drops a reply owed to a turn that has already ended', () => {
    const session = openSession();
    const firstTurnStart = frameFor('turn/start');
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    expect(
      feed(session, {
        id: firstTurnStart.id,
        result: { turn: { id: 'stale' } },
      }),
    ).toEqual([]);
  });

  it('keeps a stopped turn’s command, finishing after the next turn opened, out of that turn', () => {
    // codex does not kill a command when its turn is interrupted: the command
    // runs on, and its output and completion arrive later under the STOPPED
    // turn's id — measured on codex-cli 0.162.0, 2–6 s into the next turn.
    const session = openSession();
    acceptTurnStart(session);
    const command = (id: string, turnId: string) => ({
      threadId: THREAD,
      turnId,
      item: {
        type: 'commandExecution',
        id,
        command: `sleep 6 && echo ${id}`,
        status: 'completed',
        exitCode: 0,
        aggregatedOutput: `${id}\n`,
      },
    });
    feed(session, { method: 'item/started', params: command('stopped', TURN) });
    // The stop is the call's only ending, so it is closed with the turn.
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
      }),
    ).toEqual([
      commandUnit('stopped', 'settled'),
      {
        type: 'tool_result',
        id: 'stopped',
        name: 'shell',
        result: CODEX_STOPPED_TOOL_RESULT,
        isError: true,
      },
      { type: 'turn_cancelled' },
    ]);
    const NEXT = '01a0e3aa-ffff-7493-8c1f-01cff8862a2b';
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    acceptTurnStart(session, NEXT);
    feed(session, {
      method: 'turn/started',
      params: { threadId: THREAD, turn: { id: NEXT } },
    });

    expect(
      feed(session, {
        method: 'item/completed',
        params: command('stopped', TURN),
      }),
    ).toEqual([]);
    expect(
      feed(session, {
        method: 'item/agentMessage/delta',
        params: { threadId: THREAD, turnId: TURN, delta: 'stopped turn words' },
      }),
    ).toEqual([]);

    // The next turn's own command still reaches it.
    feed(session, { method: 'item/started', params: command('own', NEXT) });
    expect(
      feed(session, {
        method: 'item/completed',
        params: command('own', NEXT),
      }),
    ).toEqual([
      expect.objectContaining({ type: 'tool_result', id: 'own' }),
      commandUnit('own', 'settled'),
    ]);
  });

  it('keeps a stopped turn’s late command out of the next turn before codex has named that turn', () => {
    const session = openSession();
    acceptTurnStart(session);
    const stopped = {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'commandExecution', id: 'late', command: 'sleep 9' },
    };
    feed(session, { method: 'item/started', params: stopped });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
    });
    // The next turn/start is out but unanswered, so its driver has no id yet.
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    expect(
      feed(session, { method: 'item/completed', params: stopped }),
    ).toEqual([]);
  });

  it('gives a stopped turn’s call no second result when its command finishes between turns', () => {
    const session = openSession();
    acceptTurnStart(session);
    const stopped = {
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'commandExecution', id: 'late', command: 'sleep 9' },
    };
    feed(session, { method: 'item/started', params: stopped });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
    });
    // No next turn: the settled driver still receives the frame, and the stop
    // already closed the call.
    expect(
      feed(session, { method: 'item/completed', params: stopped }),
    ).toEqual([]);
  });

  it.each([
    [
      'collabAgentToolCall',
      {
        type: 'collabAgentToolCall',
        id: 'launch',
        tool: 'spawnAgent',
        prompt: 'Review the parser',
      },
    ],
    [
      'subAgentActivity',
      {
        type: 'subAgentActivity',
        id: 'launch',
        kind: 'started',
        agentThreadId: 'sub-7',
        agentPath: '/root/review',
      },
    ],
  ])(
    'leaves a %s launch open at the stop unclosed, so its delegate is not drawn failed',
    (_shape, item) => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, {
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item },
      });
      expect(
        feed(session, {
          method: 'turn/completed',
          params: {
            threadId: THREAD,
            turn: { id: TURN, status: 'interrupted' },
          },
        }).filter((event) => event.type === 'tool_result'),
      ).toEqual([]);
    },
  );

  describe('a command codex starts after the turn completed, in its process store', () => {
    // codex 0.162 (unified exec) gives every command a processId from its
    // start, one-shot or not, and sends nothing while one keeps running: only
    // time tells a dev server from a `touch`. Its exec tool yields after at
    // most 30 s, so a command still running past that has been handed back.
    const stored = (id: string, done = false) => ({
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id,
        command: `/bin/zsh -lc 'cmd ${id}'`,
        source: 'unifiedExecStartup',
        processId: '19963',
        ...(done
          ? { status: 'completed', exitCode: 0, aggregatedOutput: '' }
          : { status: 'inProgress' }),
      },
    });
    const backgrounded = (id: string): AgentEvent => ({
      type: 'background_work',
      id,
      phase: 'backgrounded',
      unit: 'other',
      toolCallId: id,
    });
    function settledSession(): CodexSession {
      const session = openSession(turnInput({ approvalMode: 'ask' }));
      acceptTurnStart(session);
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      });
      emitted = [];
      return session;
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is not a background shell when it starts', () => {
      const session = settledSession();
      const started = feed(session, {
        method: 'item/started',
        params: stored('touch'),
      });

      expect(started).not.toContainEqual(backgrounded('touch'));
      expect(started.map((event) => event.type)).toContain('tool_call');
    });

    it('ends the late work after its result when it finishes inside the window', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('touch') });

      const done = feed(session, {
        method: 'item/completed',
        params: stored('touch', true),
      });

      expect(done.map((event) => event.type)).toContain('tool_result');
      expect(done.at(-1)).toEqual({ type: 'late_work_ended' });
    });

    it('becomes a background shell, ending the late work, once still running past the 30 s window', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('dev') });

      vi.advanceTimersByTime(29_000);
      expect(emitted).toEqual([]);
      vi.advanceTimersByTime(2_000);

      expect(emitted).toEqual([
        backgrounded('dev'),
        { type: 'late_work_ended' },
      ]);
      expect(
        feed(session, {
          method: 'item/completed',
          params: stored('dev', true),
        }),
      ).toContainEqual(
        expect.objectContaining({
          type: 'tool_result',
          id: 'dev',
          endsBackgroundWork: true,
        }),
      );
    });

    it('lets a later late call end its own stretch once a long one went to the background', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('dev') });
      vi.advanceTimersByTime(31_000);
      emitted = [];

      feed(session, { method: 'item/started', params: stored('touch') });
      const done = feed(session, {
        method: 'item/completed',
        params: stored('touch', true),
      });

      expect(done.at(-1)).toEqual({ type: 'late_work_ended' });
    });

    it('backgrounds nothing once the process has ended', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('dev') });
      session.onProcessEnded();

      vi.advanceTimersByTime(60_000);
      expect(emitted).not.toContainEqual(backgrounded('dev'));
    });

    it('backgrounds nothing when the process died while no turn was open', () => {
      // A process ending between turns reaches no driver hook; the window
      // asks the process itself.
      let alive = true;
      const session = newSession(turnInput({ approvalMode: 'ask' }));
      session.onStdinReady({ ...io(), processAlive: () => alive });
      answerHooksList(session);
      feed(session, {
        id: frames().find((frame) => frame.method === 'thread/start')!.id,
        result: { thread: { id: THREAD }, model: 'gpt-5.5' },
      });
      acceptTurnStart(session);
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      });
      feed(session, { method: 'item/started', params: stored('dev') });
      emitted = [];
      alive = false;

      vi.advanceTimersByTime(31_000);
      expect(emitted).toEqual([]);
    });

    it('keeps the late work open while another late call is still running when its window ends', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('dev') });
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'mcpToolCall',
            id: 'mcp',
            server: 's',
            tool: 't',
            status: 'inProgress',
          },
        },
      });
      emitted = [];

      vi.advanceTimersByTime(31_000);
      expect(emitted).toEqual([backgrounded('dev')]);
    });

    it('backgrounds a command without a processId that was waiting on its card when the turn completed', () => {
      const session = openSession(turnInput({ approvalMode: 'ask' }));
      acceptTurnStart(session);
      const { processId: _none, ...oneShot } = stored('dev').item;
      feed(session, {
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item: oneShot },
      });
      feed(session, {
        id: 79,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD,
          turnId: TURN,
          itemId: 'dev',
          command: 'pnpm dev',
          cwd: '/repo',
        },
      });
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      });
      emitted = [];

      session.buildApprovalResponse('n:79', true);
      vi.advanceTimersByTime(31_000);
      expect(emitted).toEqual([
        backgrounded('dev'),
        { type: 'late_work_ended' },
      ]);
    });

    it('backgrounds a command without a processId that was still running with no card when the turn completed', () => {
      // A hook of the user's can hold a call inside codex, past turn/completed,
      // without geniro ever being asked.
      const session = openSession(turnInput({ approvalMode: 'ask' }));
      acceptTurnStart(session);
      const { processId: _none, ...oneShot } = stored('dev').item;
      feed(session, {
        method: 'item/started',
        params: { threadId: THREAD, turnId: TURN, item: oneShot },
      });
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      });
      emitted = [];

      vi.advanceTimersByTime(31_000);
      expect(emitted).toEqual([
        backgrounded('dev'),
        { type: 'late_work_ended' },
      ]);
    });

    it('does not start the window while an approval asked before the item started waits', () => {
      const session = settledSession();
      feed(session, {
        id: 78,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD,
          turnId: TURN,
          itemId: 'dev',
          command: 'pnpm dev',
          cwd: '/repo',
        },
      });
      feed(session, { method: 'item/started', params: stored('dev') });

      vi.advanceTimersByTime(120_000);
      expect(emitted).not.toContainEqual(backgrounded('dev'));

      session.buildApprovalResponse('n:78', true);
      vi.advanceTimersByTime(31_000);
      expect(emitted.slice(-2)).toEqual([
        backgrounded('dev'),
        { type: 'late_work_ended' },
      ]);
    });

    it('does not count the time its approval card waits toward the window', () => {
      const session = settledSession();
      feed(session, { method: 'item/started', params: stored('dev') });
      feed(session, {
        id: 77,
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD,
          turnId: TURN,
          itemId: 'dev',
          command: 'pnpm dev',
          cwd: '/repo',
        },
      });

      vi.advanceTimersByTime(120_000);
      expect(emitted).not.toContainEqual(backgrounded('dev'));

      session.buildApprovalResponse('n:77', true);
      vi.advanceTimersByTime(29_000);
      expect(emitted).not.toContainEqual(backgrounded('dev'));
      vi.advanceTimersByTime(2_000);
      expect(emitted).toContainEqual(backgrounded('dev'));
    });
  });

  describe('a tool call codex starts after the turn completed', () => {
    // A user's PermissionRequest hook held a call past `turn/completed`; codex
    // then started it under the completed turn's id, with no turn open.
    const late = (id: string, done = false) => ({
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'commandExecution',
        id,
        command: `/bin/zsh -lc 'touch ${id}.txt'`,
        ...(done
          ? { status: 'declined', exitCode: null, aggregatedOutput: null }
          : { status: 'inProgress' }),
      },
    });
    const types = (events: AgentEvent[]) => events.map((event) => event.type);
    const completeTurn = (session: CodexSession) =>
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
      });
    const complete = (session: CodexSession, id: string) =>
      feed(session, { method: 'item/completed', params: late(id, true) });

    it('ends the late work after its result', () => {
      const session = openSession();
      acceptTurnStart(session);
      completeTurn(session);
      feed(session, { method: 'item/started', params: late('one') });

      const done = types(complete(session, 'one'));
      expect(done).toContain('tool_result');
      expect(done.at(-1)).toBe('late_work_ended');
    });

    it('ends it only after the last late call still open', () => {
      const session = openSession();
      acceptTurnStart(session);
      completeTurn(session);
      feed(session, { method: 'item/started', params: late('one') });
      feed(session, { method: 'item/started', params: late('two') });

      expect(types(complete(session, 'one'))).not.toContain('late_work_ended');
      expect(types(complete(session, 'two')).at(-1)).toBe('late_work_ended');
    });

    it('ends it after a call still open when the turn completed', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: late('own') });
      completeTurn(session);

      expect(types(complete(session, 'own')).at(-1)).toBe('late_work_ended');
    });

    it('says nothing of late work for a call that completes inside its turn', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: late('own') });

      expect(types(complete(session, 'own'))).not.toContain('late_work_ended');
    });

    it('counts a call started while the ending is held for an unanswered steer', () => {
      const session = openSession();
      acceptTurnStart(session);
      session.sendFollowUp({ text: 'also this', deliveryId: 'delivery-1' });
      const steerId = frameFor('turn/steer').id;
      expect(completeTurn(session)).toEqual([]);
      feed(session, { method: 'item/started', params: late('held') });
      feed(session, {
        id: steerId,
        error: { code: -32600, message: 'no active turn' },
      });

      expect(types(complete(session, 'held')).at(-1)).toBe('late_work_ended');
    });

    it('still ends it when the result reaches the next turn’s driver', () => {
      const session = openSession();
      acceptTurnStart(session);
      completeTurn(session);
      feed(session, { method: 'item/started', params: late('one') });
      const NEXT = '01a0e3aa-eeee-7493-8c1f-01cff8862a2b';
      session.openTurn(io(), turnInput({ prompt: 'next' }));
      acceptTurnStart(session, NEXT);
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: NEXT, status: 'completed' } },
      });

      expect(types(complete(session, 'one')).at(-1)).toBe('late_work_ended');
    });
  });

  describe('commands codex holds in its process store', () => {
    // Measured on codex-cli 0.162.0: an `exec_command` is a commandExecution
    // item carrying the store's `processId` from its start; one that outlives
    // its yield is still `inProgress` at `turn/completed`, and when it ends by
    // itself `item/completed` arrives under the OLD turn's id, with no turn
    // open.
    const command = (id: string, turnId = TURN, done = false) => ({
      threadId: THREAD,
      turnId,
      item: {
        type: 'commandExecution',
        id,
        command: "/bin/zsh -lc 'pnpm dev'",
        source: 'unifiedExecStartup',
        processId: '76956',
        ...(done
          ? { status: 'completed', exitCode: 0, aggregatedOutput: 'ready\n' }
          : { status: 'inProgress' }),
      },
    });
    const unit = (
      id: string,
      phase: 'started' | 'backgrounded' | 'settled',
    ): AgentEvent => ({
      type: 'background_work',
      id,
      phase,
      unit: 'other',
      toolCallId: id,
      ...(phase === 'started' ? { foreground: true as const } : {}),
    });
    const units = (events: AgentEvent[]) =>
      events.filter((event) => event.type === 'background_work');
    const endTurn = (session: CodexSession, status: string, turnId = TURN) =>
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: turnId, status } },
      });

    it('reports one from its start as work the agent waits on, after its call', () => {
      const session = openSession();
      acceptTurnStart(session);

      expect(
        feed(session, { method: 'item/started', params: command('dev') }),
      ).toEqual([
        expect.objectContaining({ type: 'tool_call', id: 'dev' }),
        unit('dev', 'started'),
      ]);
    });

    it('moves one still running at the turn’s end to the background, ahead of the ending', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });

      const ending = endTurn(session, 'completed');

      expect(units(ending)).toEqual([unit('dev', 'backgrounded')]);
      expect(ending.at(-1)?.type).toBe('turn_complete');
    });

    it('settles it, after its result marked as its end, when codex completes it with no turn open', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });
      endTurn(session, 'completed');

      expect(
        feed(session, {
          method: 'item/completed',
          params: command('dev', TURN, true),
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          id: 'dev',
          endsBackgroundWork: true,
        }),
        unit('dev', 'settled'),
      ]);
      // Once: a second report of the same ending settles nothing again.
      expect(
        units(
          feed(session, {
            method: 'item/completed',
            params: command('dev', TURN, true),
          }),
        ),
      ).toEqual([]);
    });

    it('settles it when its completion lands during a later turn', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });
      endTurn(session, 'completed');
      const NEXT = '01a0e3aa-ffff-7493-8c1f-01cff8862a2d';
      session.openTurn(io(), turnInput({ prompt: 'next' }));
      acceptTurnStart(session, NEXT);

      expect(
        feed(session, {
          method: 'item/completed',
          params: command('dev', TURN, true),
        }),
      ).toContainEqual(unit('dev', 'settled'));
    });

    it('settles one that finished inside its turn, unmarked and never backgrounded', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('ls') });

      expect(
        feed(session, {
          method: 'item/completed',
          params: command('ls', TURN, true),
        }),
      ).toEqual([
        expect.not.objectContaining({ endsBackgroundWork: true }),
        unit('ls', 'settled'),
      ]);
      expect(units(endTurn(session, 'completed'))).toEqual([]);
    });

    it('records a one-shot command from its start, and settles it with its turn', () => {
      const session = openSession();
      acceptTurnStart(session);
      const once = {
        threadId: THREAD,
        turnId: TURN,
        item: { type: 'commandExecution', id: 'once', command: 'make build' },
      };

      expect(
        units(feed(session, { method: 'item/started', params: once })),
      ).toEqual([unit('once', 'started')]);
      // codex holds it in no process store: it never runs on past its turn.
      expect(units(endTurn(session, 'failed'))).toEqual([
        unit('once', 'settled'),
      ]);
    });

    it('keeps the call of one a failed turn leaves running open, and writes its real result when it ends', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: { type: 'commandExecution', id: 'once', command: 'make' },
        },
      });

      expect(endTurn(session, 'failed')).toEqual([
        unit('dev', 'backgrounded'),
        unit('once', 'settled'),
        {
          type: 'tool_result',
          id: 'once',
          name: 'shell',
          result: CODEX_FAILED_TOOL_RESULT,
          isError: true,
        },
        expect.objectContaining({ type: 'error' }),
      ]);
      // Fenced as a failed turn's frame, it still carries the open call's
      // own result.
      expect(
        feed(session, {
          method: 'item/completed',
          params: command('dev', TURN, true),
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          id: 'dev',
          result: 'ready\n',
          isError: false,
          endsBackgroundWork: true,
        }),
        unit('dev', 'settled'),
      ]);
    });

    it('leaves a Stop’s own command a unit, never backgrounded, settled by its fenced completion', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });
      written = [];

      const ending = endTurn(session, 'interrupted');

      expect(units(ending)).toEqual([]);
      expect(ending).toContainEqual(
        expect.objectContaining({
          type: 'tool_result',
          id: 'dev',
          result: CODEX_STOPPED_TOOL_RESULT,
        }),
      );
      // The Stop still asks codex to end it.
      expect(frameFor('thread/backgroundTerminals/list').params).toEqual({
        threadId: THREAD,
      });
      expect(
        feed(session, {
          method: 'item/completed',
          params: command('dev', TURN, true),
        }),
      ).toEqual([unit('dev', 'settled')]);
    });

    it('leaves an earlier turn’s command running, and backgrounded, through a later Stop', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('dev') });
      endTurn(session, 'completed');
      const NEXT = '01a0e3aa-ffff-7493-8c1f-01cff8862a2e';
      session.openTurn(io(), turnInput({ prompt: 'next' }));
      acceptTurnStart(session, NEXT);

      expect(units(endTurn(session, 'interrupted', NEXT))).toEqual([]);
      expect(
        feed(session, {
          method: 'item/completed',
          params: command('dev', TURN, true),
        }),
      ).toContainEqual(unit('dev', 'settled'));
    });
  });

  describe('ending the commands a Stop left running', () => {
    const command = (id: string, words: string) => ({
      threadId: THREAD,
      turnId: TURN,
      item: { type: 'commandExecution', id, command: words },
    });
    function stopWith(session: CodexSession, ...started: string[]): void {
      for (const id of started) {
        feed(session, {
          method: 'item/started',
          params: command(id, `sleep 60 # ${id}`),
        });
      }
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
      });
    }
    const listed = (...entries: [string, string][]) => ({
      data: entries.map(([itemId, processId]) => ({
        itemId,
        processId,
        command: 'sleep 60',
        cwd: '/repo',
        osPid: null,
      })),
      nextCursor: null,
    });

    it('ends exactly the stopped turn’s running command, even once the next turn has opened', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, { method: 'item/started', params: command('done', 'ls') });
      feed(session, {
        method: 'item/completed',
        params: command('done', 'ls'),
      });
      stopWith(session, 'running');
      const list = frameFor('thread/backgroundTerminals/list');
      expect(list.params).toEqual({ threadId: THREAD });
      session.openTurn(io(), turnInput({ prompt: 'next' }));
      written = [];
      // `dev` is a server an earlier turn left running on purpose.
      expect(
        feed(session, {
          id: list.id,
          result: listed(['dev', '9'], ['running', '41']),
        }),
      ).toEqual([]);
      expect(
        frames().filter(
          (frame) => frame.method === 'thread/backgroundTerminals/terminate',
        ),
      ).toEqual([
        expect.objectContaining({
          params: { threadId: THREAD, processId: '41' },
        }),
      ]);
      expect(
        feed(session, {
          id: frameFor('thread/backgroundTerminals/terminate').id,
          result: { terminated: true },
        }),
      ).toEqual([]);
    });

    it('says nothing of a command that finished by itself before the listing came back', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopWith(session, 'running');
      feed(session, {
        method: 'item/completed',
        params: command('running', 'sleep 60 # running'),
      });
      expect(
        feed(session, {
          id: frameFor('thread/backgroundTerminals/list').id,
          result: listed(),
        }),
      ).toEqual([]);
    });

    it('stops following a listing whose cursor repeats', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopWith(session, 'running');
      const page = { ...listed(['dev', '9']), nextCursor: 'same' };
      feed(session, {
        id: frameFor('thread/backgroundTerminals/list').id,
        result: page,
      });
      const again = feed(session, {
        id: frameFor('thread/backgroundTerminals/list').id,
        result: page,
      });
      expect(
        frames().filter(
          (frame) => frame.method === 'thread/backgroundTerminals/list',
        ),
      ).toHaveLength(2);
      expect(again).toEqual([
        expect.objectContaining({ type: 'notice', severity: 'warning' }),
      ]);
    });

    it('asks nothing when the stopped turn left no command running', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopWith(session);
      expect(
        frames().some(
          (frame) => frame.method === 'thread/backgroundTerminals/list',
        ),
      ).toBe(false);
    });

    it('follows the listing’s pages until it has found the command', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopWith(session, 'running');
      feed(session, {
        id: frameFor('thread/backgroundTerminals/list').id,
        result: { ...listed(['dev', '9']), nextCursor: 'page-2' },
      });
      const second = frameFor('thread/backgroundTerminals/list');
      expect(second.params).toEqual({ threadId: THREAD, cursor: 'page-2' });
      feed(session, { id: second.id, result: listed(['running', '41']) });
      expect(frameFor('thread/backgroundTerminals/terminate').params).toEqual({
        threadId: THREAD,
        processId: '41',
      });
    });

    it.each([
      [
        'the listing does not show it',
        (session: CodexSession) =>
          feed(session, {
            id: frameFor('thread/backgroundTerminals/list').id,
            result: listed(['dev', '9']),
          }),
        'codex did not list it as running',
      ],
      [
        'codex refuses the listing',
        (session: CodexSession) =>
          feed(session, {
            id: frameFor('thread/backgroundTerminals/list').id,
            error: { code: -32600, message: 'experimental api required' },
          }),
        'codex refused to list its running commands (experimental api required)',
      ],
      [
        'codex cannot end it',
        (session: CodexSession) => {
          feed(session, {
            id: frameFor('thread/backgroundTerminals/list').id,
            result: listed(['running', '41']),
          });
          return feed(session, {
            id: frameFor('thread/backgroundTerminals/terminate').id,
            result: { terminated: false },
          });
        },
        'codex reported it could not end it',
      ],
    ])(
      'says the command may still be running when %s',
      (_case, answer, reason) => {
        const session = openSession();
        acceptTurnStart(session);
        stopWith(session, 'running');
        expect(answer(session)).toEqual([
          {
            type: 'notice',
            severity: 'warning',
            message: `The Stop did not end \`sleep 60 # running\` — ${reason}. It may still be running.`,
          },
        ]);
      },
    );
  });

  describe('a frame naming a stopped turn, once the next has opened', () => {
    const NEXT = '01a0e3aa-ffff-7493-8c1f-01cff8862a2c';
    const stoppedFrame = (extra: Record<string, unknown>) => ({
      threadId: THREAD,
      turnId: TURN,
      ...extra,
    });
    function stopAndOpenNext(session: CodexSession): void {
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'interrupted' } },
      });
      session.openTurn(io(), turnInput({ prompt: 'next' }));
      acceptTurnStart(session, NEXT);
    }

    it.each([
      [
        'item/started',
        {
          item: { type: 'commandExecution', id: 'late', command: 'make' },
        },
      ],
      [
        'item/completed',
        {
          item: { type: 'agentMessage', id: 'late-msg', text: 'old words' },
        },
      ],
      ['item/agentMessage/delta', { delta: 'old words' }],
      ['item/reasoning/textDelta', { delta: 'old thought' }],
      ['item/reasoning/summaryTextDelta', { delta: 'old thought' }],
      [
        'turn/plan/updated',
        { explanation: null, plan: [{ step: 'old', status: 'pending' }] },
      ],
    ])('gives the open turn nothing from %s', (method, extra) => {
      const session = openSession();
      acceptTurnStart(session);
      stopAndOpenNext(session);
      expect(feed(session, { method, params: stoppedFrame(extra) })).toEqual(
        [],
      );
    });

    it('still takes its usage reading, a level of the thread', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopAndOpenNext(session);
      expect(
        feed(session, {
          method: 'thread/tokenUsage/updated',
          params: usage(9_000, 40_000),
        }),
      ).toContainEqual(
        expect.objectContaining({
          type: 'context_progress',
          contextTokens: 9_000,
        }),
      );
    });

    it('still closes a sub-agent a late collab call reports finished', () => {
      const session = openSession();
      acceptTurnStart(session);
      feed(session, {
        method: 'item/completed',
        params: stoppedFrame({
          item: {
            type: 'collabAgentToolCall',
            id: 'call_spawn',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['sub-1'],
            agentsStates: { 'sub-1': { status: 'running' } },
          },
        }),
      });
      stopAndOpenNext(session);
      expect(
        feed(session, {
          method: 'item/completed',
          params: stoppedFrame({
            item: {
              type: 'collabAgentToolCall',
              id: 'call_wait',
              tool: 'wait',
              status: 'completed',
              receiverThreadIds: ['sub-1'],
              agentsStates: { 'sub-1': { status: 'completed' } },
            },
          }),
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'subagent_info',
          id: 'call_spawn',
          backgroundOpen: false,
          backgroundOutcome: 'completed',
        }),
      ]);
    });

    it('still maps a late spawn’s sub-agent, so its own items nest under the launch', () => {
      const session = openSession();
      acceptTurnStart(session);
      stopAndOpenNext(session);
      feed(session, {
        method: 'item/completed',
        params: stoppedFrame({
          item: {
            type: 'collabAgentToolCall',
            id: 'call_spawn',
            tool: 'spawnAgent',
            status: 'completed',
            receiverThreadIds: ['sub-1'],
            agentsStates: { 'sub-1': { status: 'running' } },
          },
        }),
      });
      expect(
        feed(session, {
          method: 'item/started',
          params: {
            threadId: 'sub-1',
            turnId: 'x',
            item: { type: 'commandExecution', id: 'sub_cmd', command: 'ls' },
          },
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_call',
          id: 'sub_cmd',
          parentToolUseId: 'call_spawn',
        }),
        commandUnit('sub_cmd', 'started', true),
      ]);
    });
  });

  it('answers a request parked in one turn after the next has opened', () => {
    const session = openSession(turnInput({ approvalMode: 'ask' }));
    feed(session, {
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: THREAD, turnId: TURN, itemId: 'c', command: 'ls' },
    });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    session.openTurn(io(), turnInput({ prompt: 'next', approvalMode: 'ask' }));
    expect(
      JSON.parse(session.buildApprovalResponse('n:41', false)!),
    ).toMatchObject({ id: 41, result: { decision: 'decline' } });
  });

  it('fails a turn codex refused to start, once', () => {
    const session = openSession();
    const turnStart = frameFor('turn/start');
    expect(
      feed(session, {
        id: turnStart.id,
        error: { code: -32600, message: 'model not available' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex: starting the turn failed: model not available',
      },
    ]);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: THREAD, turn: { id: TURN, status: 'failed' } },
      }),
    ).toEqual([]);
  });

  it('enters plan mode, and leaves it exactly once', () => {
    const session = openSession(
      turnInput({ approvalMode: 'plan', model: 'gpt-5.5' }),
    );
    expect(frameFor('turn/start').params?.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.5',
        reasoning_effort: null,
        developer_instructions: null,
      },
    });
    acceptTurnStart(session);
    session.openTurn(io(), turnInput({ approvalMode: 'ask' }));
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'default',
    });
    acceptTurnStart(session, 'turn-2');
    session.openTurn(io(), turnInput({ approvalMode: 'ask' }));
    expect(frameFor('turn/start').params).not.toHaveProperty(
      'collaborationMode',
    );
  });

  it('asks for plan mode again when codex refused the switch', () => {
    const session = openSession(
      turnInput({ approvalMode: 'plan', model: 'gpt-5.5' }),
    );
    feed(session, {
      id: frameFor('turn/start').id,
      error: { code: -32600, message: 'collaboration modes are experimental' },
    });
    session.openTurn(io(), turnInput({ approvalMode: 'plan' }));
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'plan',
    });
  });

  it('takes a resumed thread out of the plan mode it was left in', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, approvalMode: 'auto' }),
    );
    session.onStdinReady(io());
    answerHooksList(session);
    feed(session, {
      id: frameFor('thread/resume').id,
      result: {
        thread: { id: THREAD },
        model: 'gpt-5.5',
        collaborationMode: { mode: 'plan', settings: { model: 'gpt-5.5' } },
      },
    });
    expect(frameFor('turn/start').params?.collaborationMode).toMatchObject({
      mode: 'default',
    });
  });
});

describe('compaction', () => {
  it('answers `/compact` with codex’s own compaction and reports its sizes', () => {
    const session = openSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(120_000, 200_000),
    });
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    written = [];
    session.openTurn(io(), turnInput({ prompt: '/compact' }));
    expect(frames().map((frame) => frame.method)).toEqual([
      'thread/compact/start',
    ]);
    const started = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: 'c1',
        item: { type: 'contextCompaction', id: 'cc' },
      },
    });
    expect(started).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        trigger: 'manual',
        preTokens: 120_000,
        postTokens: null,
      },
    ]);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(5_742, 200_010),
    });
    const finished = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: 'c1',
        item: { type: 'contextCompaction', id: 'cc' },
      },
    });
    expect(finished).toEqual([
      {
        type: 'context_compacted',
        phase: 'finished',
        trigger: 'manual',
        preTokens: 120_000,
        postTokens: 5_742,
      },
    ]);
  });
});

describe('automatic compaction', () => {
  it('reports a compaction codex ran by itself mid-turn as automatic', () => {
    const session = openSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(230_000, 300_000),
    });
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: { type: 'contextCompaction', id: 'cc' },
        },
      }),
    ).toEqual([
      {
        type: 'context_compacted',
        phase: 'started',
        trigger: 'auto',
        preTokens: 230_000,
        postTokens: null,
      },
    ]);
  });
});

describe('sub-agents', () => {
  it('nests a sub-agent’s items under its spawn and closes it when its thread finishes', () => {
    const session = openSession();
    const spawnStarted = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          prompt: 'Review the parser\nfor edge cases',
          model: 'gpt-5.5',
        },
      },
    });
    expect(spawnStarted[1]).toMatchObject({
      type: 'subagent_info',
      id: 'call_spawn',
      label: 'Review the parser',
      prompt: 'Review the parser\nfor edge cases',
    });
    const spawnDone = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'running' } },
        },
      },
    });
    expect(spawnDone[1]).toMatchObject({
      type: 'subagent_info',
      id: 'call_spawn',
      backgroundOpen: true,
    });
    const nested = feed(session, {
      method: 'item/started',
      params: {
        threadId: 'sub-1',
        turnId: 'x',
        item: {
          type: 'commandExecution',
          id: 'sub_cmd',
          command: 'grep -n parse',
        },
      },
    });
    expect(nested).toEqual([
      {
        type: 'tool_call',
        id: 'sub_cmd',
        name: 'shell',
        input: { command: 'grep -n parse', cwd: null },
        kind: 'execute',
        parentToolUseId: 'call_spawn',
      },
      commandUnit('sub_cmd', 'started', true),
    ]);
    // A sub-agent's turn ending is not this conversation's.
    const closed = feed(session, {
      method: 'turn/completed',
      params: { threadId: 'sub-1', turn: { id: 'x', status: 'completed' } },
    });
    expect(closed).toEqual([
      // Its one-shot command ends with the sub-agent's turn.
      commandUnit('sub_cmd', 'settled'),
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_spawn',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      }),
    ]);
    // Announced once, whichever report of the ending arrives second.
    expect(
      feed(session, {
        method: 'turn/completed',
        params: { threadId: 'sub-1', turn: { id: 'x', status: 'completed' } },
      }),
    ).toEqual([]);
  });

  it('closes a delegate a later collab call reports finished', () => {
    const session = openSession();
    feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_spawn',
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'running' } },
        },
      },
    });
    const waited = feed(session, {
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id: 'call_wait',
          tool: 'wait',
          status: 'completed',
          receiverThreadIds: ['sub-1'],
          agentsStates: { 'sub-1': { status: 'errored' } },
        },
      },
    });
    expect(waited).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_spawn',
        backgroundOpen: false,
        backgroundOutcome: 'failed',
      }),
    );
  });

  it('ignores a thread it never saw spawned', () => {
    const session = openSession();
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: 'stranger',
          item: { type: 'commandExecution', id: 'z', command: 'ls' },
        },
      }),
    ).toEqual([]);
  });
});

describe('a wait on sub-agents', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const waitItem = (id: string, status: string) => ({
    method: status === 'inProgress' ? 'item/started' : 'item/completed',
    params: {
      threadId: THREAD,
      turnId: TURN,
      item: {
        type: 'collabAgentToolCall',
        id,
        tool: 'wait',
        status,
        receiverThreadIds: ['sub-1', 'sub-2'],
        agentsStates: {},
      },
    },
  });
  const holds = (events: AgentEvent[]) =>
    events.filter((event) => event.type === 'turn_held');

  it('holds the turn while codex waits on its sub-agents, and ends the hold once the gap after the last wait has passed', () => {
    const session = openSession();
    // The agent produces nothing until a sub-agent reports: announced like
    // claude's hold, so the composer sends a message straight in.
    expect(holds(feed(session, waitItem('w1', 'inProgress')))).toEqual([
      { type: 'turn_held', open: 2 },
    ]);
    expect(holds(feed(session, waitItem('w1', 'completed')))).toEqual([]);
    emitted = [];
    vi.advanceTimersByTime(CODEX_WAIT_GAP_GRACE_MS);
    expect(holds(emitted)).toEqual([{ type: 'turn_held', open: 0 }]);
  });

  it('keeps the hold through the gap when the agent waits again', () => {
    const session = openSession();
    expect(holds(feed(session, waitItem('w1', 'inProgress')))).toHaveLength(1);
    feed(session, waitItem('w1', 'completed'));
    vi.advanceTimersByTime(CODEX_WAIT_GAP_GRACE_MS - 1);
    expect(holds(feed(session, waitItem('w2', 'inProgress')))).toEqual([]);
    emitted = [];
    vi.advanceTimersByTime(CODEX_WAIT_GAP_GRACE_MS);
    expect(holds(emitted)).toEqual([]);
  });

  it('ends the hold at once when the agent starts writing its reply in the gap', () => {
    const session = openSession();
    feed(session, waitItem('w1', 'inProgress'));
    feed(session, waitItem('w1', 'completed'));
    const writing = feed(session, {
      method: 'item/agentMessage/delta',
      params: { threadId: THREAD, turnId: TURN, delta: 'All done' },
    });
    expect(holds(writing)).toEqual([{ type: 'turn_held', open: 0 }]);
  });

  it('ends the hold at once when the agent takes a message in the gap, or the turn ends', () => {
    const session = openSession();
    feed(session, waitItem('w1', 'inProgress'));
    feed(session, waitItem('w1', 'completed'));
    const took = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: { type: 'userMessage', id: 'u1', content: [] },
      },
    });
    expect(holds(took)).toEqual([{ type: 'turn_held', open: 0 }]);

    feed(session, waitItem('w2', 'inProgress'));
    const ended = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    expect(holds(ended)).toEqual([{ type: 'turn_held', open: 0 }]);
    emitted = [];
    vi.advanceTimersByTime(CODEX_WAIT_GAP_GRACE_MS);
    expect(holds(emitted)).toEqual([]);
  });
});

describe('reopening only', () => {
  it('reopens the thread and settles without sending a prompt', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, resumeOnly: true }),
    );
    session.onStdinReady(io());
    const resume = frameFor('thread/resume');
    const events = feed(session, {
      id: resume.id,
      result: { thread: { id: THREAD }, model: 'gpt-5.5' },
    });
    expect(events).toContainEqual({
      type: 'turn_complete',
      usage: null,
      stopReason: null,
      finalText: null,
    });
    expect(frames().some((frame) => frame.method === 'turn/start')).toBe(false);
  });

  it('fails a reopen codex refuses, without starting a fresh thread', () => {
    const session = newSession(
      turnInput({ resumeSessionId: THREAD, resumeOnly: true }),
    );
    session.onStdinReady(io());
    expect(
      feed(session, {
        id: frameFor('thread/resume').id,
        error: { code: -32600, message: 'thread not found' },
      }),
    ).toEqual([
      {
        type: 'error',
        message: 'codex could not reopen this conversation: thread not found',
      },
    ]);
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });

  it('refuses to start a fresh thread in the name of a reopen', () => {
    const session = newSession(turnInput({ resumeOnly: true }));
    session.onStdinReady(io());
    expect(emitted).toContainEqual({
      type: 'error',
      message: 'there is no conversation to reopen',
    });
    expect(frames().some((frame) => frame.method === 'thread/start')).toBe(
      false,
    );
  });
});

describe('sub-agents reported as subAgentActivity (codex 0.157.1)', () => {
  /**
   * The frames below are transcribed from this daemon's raw capture of a real
   * `spawn_agent` call on 0.157.1 (2026-09-30): no `collabAgentToolCall` at
   * all — a `subAgentActivity` on the parent thread at the launch and at the
   * end, with the sub-agent's own thread streaming in between, and its ending
   * arriving AFTER the parent's turn had completed.
   */
  const launch = (kind: string, id: string) => ({
    type: 'subAgentActivity',
    id,
    kind,
    agentThreadId: 'sub-7',
    agentPath: '/root/delayed_file',
  });

  function spawn(session: ReturnType<typeof openSession>) {
    return [
      ...feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('started', 'call_u7z'),
        },
      }),
      ...feed(session, {
        method: 'item/completed',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('started', 'call_u7z'),
        },
      }),
    ];
  }

  it('opens a background delegate at the launch, named after its agent', () => {
    const session = openSession();
    const events = spawn(session);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool_call',
        id: 'call_u7z',
        name: 'spawn_agent',
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_u7z',
        label: 'delayed_file',
        backgroundOpen: true,
      }),
    );
    expect(
      events.some(
        (event) =>
          event.type === 'subagent_info' && event.backgroundOpen === false,
      ),
    ).toBe(false);
  });

  describe('a command a sub-agent runs', () => {
    // Measured on codex-cli 0.162.0: a sub-agent's `exec_command` outlives the
    // sub-agent's turn and its parent's, is listed in neither thread's
    // background terminals, and completes ~45 s later under the SUB-AGENT's
    // thread and turn.
    const subCommand = (
      id: string,
      done: boolean,
      thread = 'sub-7',
      processId: string | null = '43526',
    ) => ({
      threadId: thread,
      turnId: `${thread}-turn`,
      item: {
        type: 'commandExecution',
        id,
        command: "/bin/zsh -lc 'sleep 47'",
        source: 'unifiedExecStartup',
        ...(processId === null ? {} : { processId }),
        ...(done
          ? { status: 'completed', exitCode: 0, aggregatedOutput: '' }
          : { status: 'inProgress' }),
      },
    });
    const subTurnEnds = (session: CodexSession, thread = 'sub-7') =>
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: thread,
          turn: { id: `${thread}-turn`, status: 'completed' },
        },
      });
    const settled = (id: string): AgentEvent => ({
      type: 'background_work',
      id,
      phase: 'settled',
      unit: 'other',
      toolCallId: id,
    });

    it('reports it from its start as its delegate’s own command', () => {
      const session = openSession();
      spawn(session);

      expect(
        feed(session, {
          method: 'item/started',
          params: subCommand('exec-sub', false),
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_call',
          id: 'exec-sub',
          parentToolUseId: 'call_u7z',
        }),
        commandUnit('exec-sub', 'started', true),
      ]);
    });

    it('moves it to the background when it outlives the sub-agent’s turn, ahead of the delegate’s close', () => {
      const session = openSession();
      spawn(session);
      feed(session, {
        method: 'item/started',
        params: subCommand('exec-sub', false),
      });

      expect(subTurnEnds(session)).toEqual([
        commandUnit('exec-sub', 'backgrounded'),
        expect.objectContaining({ type: 'subagent_info', id: 'call_u7z' }),
      ]);
    });

    it('settles it, its result marked as its end, when it outlived the sub-agent’s turn', () => {
      const session = openSession();
      spawn(session);
      feed(session, {
        method: 'item/started',
        params: subCommand('exec-sub', false),
      });
      subTurnEnds(session);

      expect(
        feed(session, {
          method: 'item/completed',
          params: subCommand('exec-sub', true),
        }),
      ).toEqual([
        expect.objectContaining({
          type: 'tool_result',
          id: 'exec-sub',
          parentToolUseId: 'call_u7z',
          endsBackgroundWork: true,
        }),
        settled('exec-sub'),
      ]);
    });

    it('leaves another sub-agent’s command unmarked when one sub-agent’s turn ends', () => {
      const session = openSession();
      spawn(session);
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'subAgentActivity',
            id: 'call_other',
            kind: 'started',
            agentThreadId: 'sub-8',
            agentPath: '/root/other',
          },
        },
      });
      feed(session, {
        method: 'item/started',
        params: subCommand('exec-7', false),
      });
      feed(session, {
        method: 'item/started',
        params: subCommand('exec-8', false, 'sub-8'),
      });
      subTurnEnds(session, 'sub-7');

      expect(
        feed(session, {
          method: 'item/completed',
          params: subCommand('exec-8', true, 'sub-8'),
        }),
      ).toEqual([
        expect.not.objectContaining({ endsBackgroundWork: true }),
        settled('exec-8'),
      ]);
    });

    it('settles a one-shot command with the sub-agent’s turn', () => {
      const session = openSession();
      spawn(session);
      feed(session, {
        method: 'item/started',
        params: subCommand('once-sub', false, 'sub-7', null),
      });

      expect(subTurnEnds(session)[0]).toEqual(
        commandUnit('once-sub', 'settled'),
      );
    });
  });

  it('nests the sub-agent’s own items under the launch', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: 'sub-7',
          turnId: 'sub-turn',
          item: { type: 'commandExecution', id: 'exec-1', command: 'sleep 30' },
        },
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'tool_call',
        id: 'exec-1',
        parentToolUseId: 'call_u7z',
      }),
      commandUnit('exec-1', 'started', true),
    ]);
  });

  it('closes it once, completed, when it ends after the parent’s turn', () => {
    const session = openSession();
    spawn(session);
    feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: TURN, status: 'completed' } },
    });
    const byThread = feed(session, {
      method: 'turn/completed',
      params: {
        threadId: 'sub-7',
        turn: { id: 'sub-turn', status: 'completed' },
      },
    });
    const byActivity = feed(session, {
      method: 'item/started',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: launch('completed', 'subagent-completed-sub-turn'),
      },
    });
    const closes = [...byThread, ...byActivity].filter(
      (event) =>
        event.type === 'subagent_info' && event.backgroundOpen === false,
    );
    expect(closes).toEqual([
      expect.objectContaining({
        id: 'call_u7z',
        backgroundOutcome: 'completed',
      }),
    ]);
    // The ending activity is not a second call.
    expect(byActivity.some((event) => event.type === 'tool_call')).toBe(false);
  });

  it('closes it from the parent-side activity when that arrives first', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: launch('completed', 'subagent-completed-sub-turn'),
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'call_u7z',
        backgroundOpen: false,
        backgroundOutcome: 'completed',
      }),
    );
  });

  it('reads an interrupted sub-agent turn as stopped, not failed', () => {
    const session = openSession();
    spawn(session);
    expect(
      feed(session, {
        method: 'turn/completed',
        params: {
          threadId: 'sub-7',
          turn: { id: 'sub-turn', status: 'interrupted' },
        },
      }),
    ).toContainEqual(expect.objectContaining({ backgroundOutcome: 'stopped' }));
  });
});

describe('what a turn spends', () => {
  const PRICE = {
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite: 5,
    tiers: [],
    contextTokens: null,
  };
  const SUB = '01a0e3aa-0000-7000-8000-00000000aaaa';

  /** A sub-agent thread's reading: its running total and its last request. */
  const reading = (
    threadId: string,
    total: { input: number; output: number },
    last: { input: number; output: number },
  ) => {
    const breakdown = (b: { input: number; output: number }) => ({
      totalTokens: b.input + b.output,
      inputTokens: b.input,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: b.output,
      reasoningOutputTokens: 0,
    });
    return {
      threadId,
      turnId: 'sub-turn',
      tokenUsage: {
        total: breakdown(total),
        last: breakdown(last),
        modelContextWindow: 258400,
      },
    };
  };

  function pricedSession(
    facts: { threadId: string; patch: Record<string, unknown> }[] = [],
    input = turnInput(),
    serviceTier?: string,
  ): CodexSession {
    const session = new CodexSession(
      {
        clientVersion: '9.9.9',
        turnOptions: (input) => ({
          ...optionsFor(input),
          autoCompactTokens: 200_000,
        }),
        listPriceOf: () => PRICE,
        onThreadFacts: (threadId, patch) =>
          void facts.push({ threadId, patch: { ...patch } }),
      },
      input,
    );
    session.onStdinReady(io());
    feed(session, {
      id: frameFor('thread/start').id,
      result: {
        thread: { id: THREAD },
        model: 'gpt-5.5',
        serviceTier,
        instructionSources: ['/home/u/.codex/AGENTS.md', '/repo/AGENTS.md'],
      },
    });
    acceptTurnStart(session);
    return session;
  }

  const settle = (session: CodexSession, status: string) =>
    feed(session, {
      method: 'turn/completed',
      params: {
        threadId: THREAD,
        turn: {
          id: TURN,
          status,
          error: status === 'failed' ? { message: 'boom' } : null,
        },
      },
    });

  const usageOf = (events: AgentEvent[]) => {
    const terminal = events.find(
      (event) =>
        event.type === 'turn_complete' ||
        event.type === 'turn_cancelled' ||
        event.type === 'error',
    );
    return terminal && 'usage' in terminal ? terminal.usage : undefined;
  };

  it.each([
    ['at standard speed', undefined, undefined, 1],
    ['at the tier it asked for', { service_tier: 'priority' }, undefined, 2],
    ['at the tier its thread runs on', undefined, 'priority', 2],
    [
      'at standard over a Fast thread',
      { service_tier: 'default' },
      'priority',
      1,
    ],
  ])('prices a turn %s', (_name, modelParameters, threadTier, factor) => {
    const session = pricedSession(
      [],
      turnInput({ modelParameters }),
      threadTier,
    );
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    expect(usageOf(settle(session, 'completed'))?.costUsd).toBeCloseTo(
      0.0648 * factor,
      10,
    );
  });

  it('records what a STOPPED turn spent on its turn_cancelled', () => {
    const session = pricedSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    const events = settle(session, 'interrupted');
    expect(events.at(-1)).toMatchObject({
      type: 'turn_cancelled',
      usage: { inputTokens: 15_950, outputTokens: 50 },
    });
    expect(usageOf(events)?.costUsd).toBeCloseTo(0.0648, 10);
  });

  it('records what a FAILED turn spent on its error', () => {
    const session = pricedSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    const events = settle(session, 'failed');
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      message: 'boom',
      usage: { inputTokens: 15_950, outputTokens: 50 },
    });
  });

  it('carries no usage on an ending that measured nothing', () => {
    const session = pricedSession();
    const events = settle(session, 'interrupted');
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('streams the turn’s running cost and zeroes it ahead of the row', () => {
    const session = pricedSession();
    const first = feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    expect(first).toContainEqual({
      type: 'usage_progress',
      inputTokens: 15_950,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    // A second request: only what it ADDED is the live increment, while the
    // cost is the turn's whole running figure.
    const second = feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(17_000, 37_000),
    });
    expect(second).toContainEqual({
      type: 'usage_progress',
      inputTokens: 1_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    const cost = second.find((event) => event.type === 'cost_progress');
    // 16,950 fresh input × $4 + 50 output × $20, per million.
    expect(cost?.type === 'cost_progress' && cost.costUsd).toBeCloseTo(
      0.0688,
      10,
    );
    const ending = settle(session, 'completed');
    expect(ending[0]).toEqual({ type: 'cost_progress', costUsd: 0 });
    expect(usageOf(ending)?.costUsd).toBeCloseTo(0.0688, 10);
  });

  it('folds a sub-agent’s spend into the parent turn, and bills it once', () => {
    const session = pricedSession();
    feed(session, {
      method: 'thread/started',
      params: { thread: { id: SUB, model: 'gpt-5.5' } },
    });
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    // The sub-agent's own thread: its first request, 10,000 in + 100 out —
    // a fresh thread, so its total is its last.
    const live = feed(session, {
      method: 'thread/tokenUsage/updated',
      params: reading(
        SUB,
        { input: 10_000, output: 100 },
        { input: 10_000, output: 100 },
      ),
    });
    expect(live).toContainEqual(
      expect.objectContaining({ type: 'usage_progress', inputTokens: 10_000 }),
    );
    const running = live.find((event) => event.type === 'cost_progress');
    // Parent $0.0648 + sub-agent 10,000 × $4 + 100 × $20 per million.
    expect(running?.type === 'cost_progress' && running.costUsd).toBeCloseTo(
      0.0648 + 0.042,
      10,
    );
    const ending = settle(session, 'completed');
    expect(usageOf(ending)).toMatchObject({
      inputTokens: 15_950 + 10_000,
      outputTokens: 50 + 100,
      // The window is the PARENT's own — a sub-agent's thread is not it.
      contextTokens: 16_000,
    });
    expect(usageOf(ending)?.costUsd).toBeCloseTo(0.1068, 10);

    // The next turn carries none of it again — only what the sub-agent spent
    // AFTER the first turn recorded it.
    session.openTurn(io(), turnInput({ prompt: 'again' }));
    acceptTurnStart(session, 'turn-2');
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: reading(
        SUB,
        { input: 11_000, output: 100 },
        { input: 1_000, output: 0 },
      ),
    });
    const next = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-2', status: 'completed' } },
    });
    expect(usageOf(next)).toMatchObject({
      inputTokens: 1_000,
      outputTokens: 0,
    });
  });

  it('records a sub-agent’s spend even when it lands after the parent turn settled', () => {
    const session = pricedSession();
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    settle(session, 'completed');
    // Off-turn: the live plane hears it, no row records it yet.
    const offTurn = feed(session, {
      method: 'thread/tokenUsage/updated',
      params: reading(
        SUB,
        { input: 5_000, output: 100 },
        { input: 5_000, output: 100 },
      ),
    });
    const running = offTurn.find((event) => event.type === 'cost_progress');
    expect(running?.type === 'cost_progress' && running.costUsd).toBeCloseTo(
      0.022,
      10,
    );
    session.openTurn(io(), turnInput({ prompt: 'next' }));
    acceptTurnStart(session, 'turn-2');
    const next = feed(session, {
      method: 'turn/completed',
      params: { threadId: THREAD, turn: { id: 'turn-2', status: 'completed' } },
    });
    // The live figure the off-turn reading put up is retired first…
    expect(next[0]).toEqual({ type: 'cost_progress', costUsd: 0 });
    // …and the money lands on the next turn's row.
    expect(usageOf(next)).toMatchObject({
      inputTokens: 5_000,
      outputTokens: 100,
    });
    expect(usageOf(next)?.costUsd).toBeCloseTo(0.022, 10);
  });

  describe('a delegate’s figures', () => {
    const SUB_TWO = '01a0e3aa-0000-7000-8000-00000000bbbb';
    const GRAND = '01a0e3aa-0000-7000-8000-00000000cccc';

    const startThread = (session: CodexSession, id: string) =>
      feed(session, {
        method: 'thread/started',
        params: { thread: { id, model: 'gpt-5.5' } },
      });

    const spawnCall = (id: string, receivers: string[]) => ({
      method: 'item/completed',
      params: {
        threadId: THREAD,
        turnId: TURN,
        item: {
          type: 'collabAgentToolCall',
          id,
          tool: 'spawnAgent',
          status: 'completed',
          receiverThreadIds: receivers,
          agentsStates: Object.fromEntries(
            receivers.map((receiver) => [receiver, { status: 'running' }]),
          ),
        },
      },
    });

    const figuresOf = (events: AgentEvent[]) =>
      events.flatMap((event) =>
        event.type === 'delegate_progress' ? [event.figures] : [],
      );

    it('states a mapped sub-agent’s spend on its delegate’s card, live and without a request count', () => {
      const session = pricedSession();
      startThread(session, SUB);
      feed(session, spawnCall('call_spawn', [SUB]));
      const live = feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB,
          { input: 10_000, output: 100 },
          { input: 10_000, output: 100 },
        ),
      });
      expect(live).toContainEqual({
        type: 'delegate_progress',
        delegateId: 'call_spawn',
        final: false,
        figures: expect.objectContaining({
          requests: null,
          inputTokens: 10_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          contextTokens: 10_100,
          model: 'gpt-5.5',
          costUsd: null,
        }),
      });
      // 10,000 × $4 + 100 × $20 per million, at the list price.
      expect(figuresOf(live)[0]?.estimatedCostUsd).toBeCloseTo(0.042, 10);
    });

    it('holds a reading that lands before its spawn names the thread, and states it once the spawn does', () => {
      const session = pricedSession();
      startThread(session, SUB);
      const early = feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB,
          { input: 10_000, output: 100 },
          { input: 10_000, output: 100 },
        ),
      });
      expect(figuresOf(early)).toEqual([]);
      expect(feed(session, spawnCall('call_spawn', [SUB]))).toContainEqual({
        type: 'delegate_progress',
        delegateId: 'call_spawn',
        final: false,
        figures: expect.objectContaining({
          inputTokens: 10_000,
          outputTokens: 100,
          requests: null,
        }),
      });
    });

    it('states a held reading as soon as a sub-agent launch names its thread', () => {
      const session = pricedSession();
      startThread(session, SUB);
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB,
          { input: 10_000, output: 100 },
          { input: 10_000, output: 100 },
        ),
      });
      const launched = feed(session, {
        method: 'item/started',
        params: {
          threadId: THREAD,
          turnId: TURN,
          item: {
            type: 'subAgentActivity',
            id: 'call_launch',
            kind: 'started',
            agentThreadId: SUB,
            agentPath: '/root/review',
          },
        },
      });
      expect(launched).toContainEqual(
        expect.objectContaining({
          type: 'delegate_progress',
          delegateId: 'call_launch',
          final: false,
          figures: expect.objectContaining({ inputTokens: 10_000 }),
        }),
      );
    });

    it('sums every thread of one spawn into the one delegate’s figures', () => {
      const session = pricedSession();
      startThread(session, SUB);
      startThread(session, SUB_TWO);
      feed(session, spawnCall('call_spawn', [SUB, SUB_TWO]));
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB,
          { input: 10_000, output: 100 },
          { input: 10_000, output: 100 },
        ),
      });
      const second = feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB_TWO,
          { input: 4_000, output: 50 },
          { input: 4_000, output: 50 },
        ),
      });
      expect(figuresOf(second)).toEqual([
        expect.objectContaining({
          inputTokens: 14_000,
          outputTokens: 150,
          // The newest reading's request stands for the delegate.
          contextTokens: 4_050,
        }),
      ]);
    });

    it('states no delegate figures for a thread codex never mapped to one', () => {
      const session = pricedSession();
      feed(session, spawnCall('call_spawn', [SUB]));
      expect(
        figuresOf(
          feed(session, {
            method: 'thread/tokenUsage/updated',
            params: reading(
              GRAND,
              { input: 3_000, output: 10 },
              { input: 3_000, output: 10 },
            ),
          }),
        ),
      ).toEqual([]);
    });

    it('closes with its final figures on the delegate and on its closing row, and states nothing after', () => {
      const session = pricedSession();
      startThread(session, SUB);
      feed(session, spawnCall('call_spawn', [SUB]));
      feed(session, {
        method: 'thread/tokenUsage/updated',
        params: reading(
          SUB,
          { input: 10_000, output: 100 },
          { input: 10_000, output: 100 },
        ),
      });
      const ending = feed(session, {
        method: 'turn/completed',
        params: {
          threadId: SUB,
          turn: { id: 'sub-turn', status: 'completed' },
        },
      });
      expect(ending).toContainEqual({
        type: 'delegate_progress',
        delegateId: 'call_spawn',
        final: true,
        figures: expect.objectContaining({
          requests: null,
          inputTokens: 10_000,
          outputTokens: 100,
          contextTokens: 10_100,
        }),
      });
      expect(figuresOf(ending)[0]?.estimatedCostUsd).toBeCloseTo(0.042, 10);
      expect(ending).toContainEqual(
        expect.objectContaining({
          type: 'subagent_info',
          id: 'call_spawn',
          backgroundOpen: false,
          backgroundOutcome: 'completed',
          tokens: 10_100,
          inputTokens: 10_000,
          outputTokens: 100,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: null,
          requests: null,
          contextTokens: 10_100,
          cumulative: true,
        }),
      );
      expect(
        figuresOf(
          feed(session, {
            method: 'thread/tokenUsage/updated',
            params: reading(
              SUB,
              { input: 12_000, output: 100 },
              { input: 2_000, output: 0 },
            ),
          }),
        ),
      ).toEqual([]);
    });
  });

  it('hands the adapter what the thread reported about itself', () => {
    const facts: { threadId: string; patch: Record<string, unknown> }[] = [];
    const session = pricedSession(facts);
    feed(session, {
      method: 'thread/tokenUsage/updated',
      params: usage(16_000, 36_000),
    });
    expect(facts[0]).toEqual({
      threadId: THREAD,
      patch: {
        instructionSources: ['/home/u/.codex/AGENTS.md', '/repo/AGENTS.md'],
        model: 'gpt-5.5',
        autoCompactTokens: 200_000,
      },
    });
    expect(facts[1]?.patch.usage).toMatchObject({
      last: { totalTokens: 16_000 },
      modelContextWindow: 258400,
    });
  });
});

describe('a team member’s switched-off MCP servers', () => {
  /** A `config/read` reply defining `playwright` in the user's config.toml. */
  const CONFIG_REPLY = {
    config: {
      mcp_servers: {
        playwright: { command: 'npx' },
        'geniro-run': { url: 'http://127.0.0.1:1/v1/mcp/r/n' },
      },
    },
    origins: {
      'mcp_servers.playwright.command': { name: { type: 'user' } },
    },
  };

  function sessionWith(mcpDisabled: string[]): CodexSession {
    return new CodexSession(
      {
        clientVersion: '9.9.9',
        turnOptions: (input) => ({
          ...optionsFor(input),
          // geniro's endpoint, as the adapter adds it — the switches must
          // MERGE with it rather than replace it.
          config: { 'mcp_servers.geniro-run': { url: 'http://x' } },
          mcpDisabled,
        }),
      },
      turnInput(),
    );
  }

  it('reads codex’s config before the thread, then starts it with the overrides that reach each server', () => {
    const session = sessionWith(['playwright', 'codex_apps', 'cua_repl']);
    session.onStdinReady(io());
    // No thread until codex has said where each server is defined.
    expect(frames().map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'config/read',
    ]);
    expect(frameFor('config/read').params).toEqual({ cwd: '/repo' });

    feed(session, { id: frameFor('config/read').id, result: CONFIG_REPLY });
    expect(frameFor('thread/start').params?.config).toEqual({
      'mcp_servers.geniro-run': { url: 'http://x' },
      // Defined in config.toml → its own `enabled` override.
      'mcp_servers.playwright.enabled': false,
      // The built-in Apps server → the Apps feature flag.
      'features.apps': false,
      // `cua_repl` (a plugin's, in no config) gets NOTHING: an `enabled`
      // override for a name the config does not define fails the thread.
    });
  });

  it('opens the thread without the switches, and says so, when the config cannot be read', () => {
    const session = sessionWith(['playwright']);
    session.onStdinReady(io());
    const events = feed(session, {
      id: frameFor('config/read').id,
      error: { code: -32603, message: 'boom' },
    });
    expect(events).toEqual([
      {
        type: 'notice',
        message: expect.stringContaining(
          'the MCP servers switched off for this member stay on for this turn',
        ),
      },
    ]);
    expect(frameFor('thread/start').params?.config).toEqual({
      'mcp_servers.geniro-run': { url: 'http://x' },
    });
  });

  it('reads nothing first when the member switches nothing off', () => {
    const session = sessionWith([]);
    session.onStdinReady(io());
    expect(frames().map((frame) => frame.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
    ]);
  });
});
