import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import { simulateSleep } from '../../../__tests__/simulate-sleep';
import { FakeChild, fakeSpawn } from '../__tests__/fake-child';
import type {
  AgentEvent,
  CommandRecord,
  TurnIo,
} from '../adapters/adapter.types';
import {
  type ChildJournalFile,
  configureChildJournal,
  resetChildJournal,
} from './child-journal';
import type { PlainProcess } from './run-process-scan';
import {
  COMMAND_GROUP_READ_DELAY_MS,
  COMMAND_GROUP_REFRESH_MS,
  CUT_OFF_COMMAND_RESULT,
  runCliSession,
  runHeadlessCli,
  type SessionLogger,
} from './spawn-cli';

const noopMapper = (): AgentEvent[] => [];

/** The turn's `result` line, mapped — the shape a real mapper produces. */
const COMPLETE: AgentEvent = {
  type: 'turn_complete',
  usage: null,
  stopReason: null,
  finalText: null,
};

/**
 * A mapper turning `{done:true}` into that terminal event and `{failed:true}`
 * into an error — the two shapes a real `result` line reduces to.
 */
const resultOnDone = (obj: unknown): AgentEvent[] => {
  const row = obj as {
    done?: boolean;
    /** A result the CLI marked as ending a continuation it ran by itself. */
    continuationDone?: boolean;
    /** The same, for a continuation that FAILED (an `is_error` result with origin). */
    continuationFailed?: boolean;
    failed?: boolean;
    tool?: string;
    work?: string;
    phase?: 'started' | 'settled' | 'backgrounded';
    /** The launching call BLOCKS on the unit (claude's `is_backgrounded: false`). */
    fore?: boolean;
    /** What the unit IS, when the line says — a delegate or anything else. */
    unit?: 'agent' | 'other';
    /** The call that launched it, as a delegate's `started` line carries. */
    call?: string;
    finalText?: string;
    ask?: string;
    /** The agent AUTHORING something — what proves it is working again. */
    says?: string;
    /** The CLI echoing a message it has just TAKEN off stdin. */
    taken?: string;
    /** What a `done` line's segment cost, for the cases that fold two. */
    cost?: number;
    /** Of {@link cost}, the part geniro priced itself. */
    estimated?: number;
    /** How long a `done` line's segment worked, by the CLI's own clock. */
    ms?: number;
    /** Whose thread it came from: absent is the main one, a value a delegate's. */
    parent?: string;
    /** How the settling unit ended, when the fake line states it. */
    outcome?: 'completed' | 'failed' | 'stopped';
    /** What the settling unit spent, when the fake line states it. */
    spent?: {
      tokens: number | null;
      toolUses: number | null;
      durationMs: number | null;
    };
    /** The CLI announcing its session state, as claude's mapper reads it. */
    state?: 'idle' | 'running';
    /** The unit was started by a DELEGATE (claude's `owned_by_subagent`). */
    owned?: boolean;
    /** The CLI's running cost since its last `result` (claude's `get_usage`). */
    live?: number;
    /** Of {@link live}, the part geniro priced itself (codex's list price). */
    liveEstimated?: number;
    /** A tool call with this id — a delegate's own when `parent` is set. */
    run?: string;
    /** The command line that `run` call ran. */
    cmd?: string;
  };
  if (typeof row.run === 'string') {
    return [
      {
        type: 'tool_call',
        id: row.run,
        name: 'Bash',
        input: row.cmd === undefined ? {} : { command: row.cmd },
        ...(row.parent === undefined ? {} : { parentToolUseId: row.parent }),
      },
    ];
  }
  if (typeof row.live === 'number') {
    return [
      {
        type: 'cost_progress',
        costUsd: row.live,
        ...(row.liveEstimated === undefined
          ? {}
          : { estimatedCostUsd: row.liveEstimated }),
      },
    ];
  }
  if (row.state !== undefined) {
    return [{ type: 'session_state', idle: row.state === 'idle' }];
  }
  if (typeof row.work === 'string' && row.phase !== undefined) {
    return [
      {
        type: 'background_work',
        id: row.work,
        phase: row.phase,
        unit: row.unit ?? 'other',
        toolCallId: row.call ?? null,
        outcome: row.outcome,
        usage: row.spent,
        ...(row.owned === true ? { ownedByDelegate: true as const } : {}),
        ...(row.fore === true ? { foreground: true as const } : {}),
      },
    ];
  }
  // A card the CLI is now blocked on, waiting for a verdict.
  if (typeof row.ask === 'string') {
    return [
      {
        type: 'approval_request',
        id: row.ask,
        toolName: 'AskUserQuestion',
        input: { questions: [] },
        requiresUserInteraction: true,
      },
    ];
  }
  if (typeof row.taken === 'string') {
    return [{ type: 'user_message_consumed', text: row.taken }];
  }
  if (row.done === true && typeof row.cost === 'number') {
    return [
      {
        ...COMPLETE,
        finalText: row.finalText ?? null,
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreationTokens: null,
          thinkingTokens: null,
          contextTokens: null,
          contextWindowTokens: null,
          contextModel: null,
          costUsd: row.cost,
          ...(row.estimated === undefined
            ? {}
            : { estimatedCostUsd: row.estimated }),
          durationMs: row.ms ?? null,
          apiMs: null,
          ttftMs: null,
          timeToRequestMs: null,
          numTurns: null,
        },
      },
    ];
  }
  if (row.continuationDone === true) {
    // The result of a turn the CLI ran by itself (claude's
    // `origin:{kind:"task-notification"}`), as the adapter's mapper marks it.
    return [
      {
        ...COMPLETE,
        finalText: typeof row.finalText === 'string' ? row.finalText : null,
        continuation: true,
      },
    ];
  }
  if (row.continuationFailed === true) {
    return [
      {
        type: 'error',
        message: 'continuation: is_error',
        continuation: true,
      },
    ];
  }
  if (row.done === true) {
    // A result line's own text, for the cases that care WHICH result was kept.
    return typeof row.finalText === 'string'
      ? [{ ...COMPLETE, finalText: row.finalText }]
      : [COMPLETE];
  }
  if (row.failed === true) {
    return [{ type: 'error', message: 'result: is_error' }];
  }
  if (typeof row.says === 'string') {
    return [
      {
        type: 'text',
        text: row.says,
        ...(row.parent === undefined ? {} : { parentToolUseId: row.parent }),
      },
    ];
  }
  // A non-terminal line, for the cases that care where mid-turn output lands.
  if (typeof row.tool === 'string') {
    return [
      {
        type: 'tool_result',
        id: row.tool,
        name: null,
        result: 'ok',
        isError: false,
      },
    ];
  }
  return [];
};

function openSession(
  child?: Parameters<typeof fakeSpawn>[0],
  logger?: SessionLogger,
  onBetweenTurnEvent?: (event: AgentEvent) => void,
) {
  const { spawn, child: c, captured } = fakeSpawn(child);
  const session = runCliSession({
    command: 'claude',
    args: [],
    cwd: '/proj',
    stdinLifetime: 'session',
    mapper: resultOnDone,
    spawn,
    logger,
    onBetweenTurnEvent,
    // Never the machine's real table: a fake pid may name a real process.
    listProcessGroups: () => Promise.resolve(null),
  });
  return { session, child: c, captured };
}

/** Feed the child one NDJSON line. */
function line(
  child: { stdout: { emitData(chunk: string): void } },
  obj: unknown,
): void {
  child.stdout.emitData(`${JSON.stringify(obj)}\n`);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a run-scoped session outlives its turns', () => {
  it('serves a second turn on the SAME process, with stdin never closed', async () => {
    // This is the whole point of item 11, stated as a test. A CLI boots the
    // user's MCP servers when it starts, and an MCP server can own something
    // expensive — a browser the user is logged into. One process per turn
    // therefore tears that down on every message. One process per RUN boots it
    // once. The observable is the spawn count and the still-open stdin.
    const events: AgentEvent[] = [];
    const { session, child, captured } = openSession();

    const first = session.startTurn({
      stdinPayload: 'FIRST\n',
      onEvent: (e) => events.push(e),
    });
    expect(first).not.toBeNull();
    line(child, { done: true });
    await first?.done;

    // The turn is over…
    expect(events).toEqual([COMPLETE]);
    // …and the process is not.
    expect(child.stdin.ended).toBe(false);
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
    expect(session.idle).toBe(true);

    const second = session.startTurn({
      stdinPayload: 'SECOND\n',
      onEvent: (e) => events.push(e),
    });
    expect(second).not.toBeNull();
    expect(child.stdin.written).toBe('FIRST\nSECOND\n');
    // One spawn for two turns — asserted through the seam, not inferred.
    expect(captured.command).toBe('claude');
    line(child, { done: true });
    await second?.done;
    expect(child.kills).toBe(0);
  });

  it('stops serving a session whose stdin broke BETWEEN turns', async () => {
    // The gap a kept process opened: its pipe can break with no turn in
    // flight, and every exit from the stdin error handler was a bare `return`
    // — nothing marked, nothing recorded. The session then reported itself
    // idle AND alive forever, so the registry kept handing it out and each
    // later turn wrote into a pipe nobody was reading.
    const warnings: string[] = [];
    const { session, child } = openSession(undefined, {
      warn: (message: string) => warnings.push(message),
      info: () => {},
      error: () => {},
    } as unknown as SessionLogger);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;
    expect(session.idle).toBe(true);

    child.stdin.breakPipe();

    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
    // It left THE REASON behind, not merely a note that something happened.
    // Asserting the generic word passed on `handleOrphanEvent`'s own "dropped
    // a 'error' event" line while the EPIPE text was being discarded — a pin
    // that certified the opposite of what it claimed.
    expect(warnings.join('\n')).toContain('stdin error');
    expect(warnings.join('\n')).toContain('EPIPE');
  });

  it('announces the END of a session whose stdin broke between turns, so its owner can drop it', async () => {
    // Marking the session unusable is only half of it. `AgentSessionRegistry`
    // forgets an entry through ONE channel — `CliSession.closed` — and it
    // treats a non-idle entry as BUSY: the idle timer skips it, `evictIfFull`
    // skips it while still counting it against MAX_LIVE_SESSIONS, and
    // `!alive` (its only other escape hatch) is false because the process is
    // still running. So a pipe that breaks between turns leaves a session that
    // can never serve another turn holding a slot for the daemon's lifetime,
    // and a genuinely healthy idle session is evicted in its place — the exact
    // inversion `forgetWhenClosed` was written to prevent.
    //
    // The handler already does the right thing when a turn is in flight
    // (`endProcess()`); the between-turns branch is the asymmetry.
    const { session, child } = openSession();

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    let announced = false;
    void session.closed.then(() => {
      announced = true;
    });

    child.stdin.breakPipe();
    // A macrotask, so every pending microtask (the `closed` continuation
    // above) has already run — no timing to be lucky about.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(announced).toBe(true);
    expect(session.alive).toBe(false);
  });

  it('reports a write into a broken stdin as NOT delivered', async () => {
    // `sendUserMessage`'s answer decides whether the chat commits the user's
    // message to the transcript, so a true it cannot honour loses the message
    // silently. Writing past an ended pipe does not throw, so the old
    // try/catch answered true for a write that never landed.
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildFollowUpPayload: (message) => `${message.text}\n`,
    });

    expect(handle?.sendUserMessage({ text: 'lands', images: undefined })).toBe(
      true,
    );

    child.stdin.writable = false;

    expect(handle?.sendUserMessage({ text: 'lost', images: undefined })).toBe(
      false,
    );
    expect(child.stdin.written).not.toContain('lost');
  });

  it('settles a session turn on its terminal EVENT, not on the process dying', async () => {
    // A session turn whose `done` waited for the process would never resolve —
    // the process is meant to outlive it. Pinned by resolving `done` while the
    // child is demonstrably still running.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, { done: true });
    await handle?.done; // would hang forever if this waited on `close`

    expect(session.alive).toBe(true);
  });

  it('refuses a second turn while one is still in flight', () => {
    // One turn at a time per process: the CLI's stdout is a single stream and
    // two turns reading it would interleave into each other's transcripts.
    // Null (rather than a queue) is what lets the caller spawn a fresh process.
    const { session } = openSession();

    expect(session.startTurn({ onEvent: () => {} })).not.toBeNull();
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('refuses a turn once the process is gone', async () => {
    const { session, child } = openSession();

    child.emit('close', 0, null);
    await session.closed;

    expect(session.alive).toBe(false);
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('refuses a turn as soon as the process exits, without waiting out the settle grace', () => {
    // `close` is what settles, and on a run-scoped session it can lag `exit` by
    // the full grace window — MCP grandchildren hold the inherited stdio open.
    // For those two seconds nothing else has changed: `processGone` is false
    // and stdin was never ended, so the session used to report itself idle and
    // alive and hand the registry a handle on a process that had already gone.
    vi.useFakeTimers();
    const { session, child } = openSession();

    child.emit('exit', 0, null);

    expect(session.alive).toBe(false);
    expect(session.idle).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).toBeNull();
  });

  it('records a clean exit that produced no result as a failure, not a success', async () => {
    // The silence is the bug: with no terminal event, `ChatService` writes a
    // synthetic `turn_complete` and the transcript shows an answered turn that
    // has no answer in it.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(2000);
    await handle?.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('without completing') },
    ]);
  });

  it('drops a stray event arriving between turns instead of giving it to the next one', async () => {
    // Trailing stdout after a turn's `result` belongs to the turn that ended.
    // Holding it for the next turn would file one turn's output under another;
    // the warning is what keeps the drop from being silent.
    const warn = vi.fn();
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, { warn });

    const first = session.startTurn({ onEvent: (e) => events.push(e) });
    line(child, { done: true });
    await first?.done;

    line(child, { done: true }); // arrives with no turn in flight

    const second = session.startTurn({ onEvent: (e) => events.push(e) });
    expect(events).toEqual([COMPLETE]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('between turns'));
    expect(second).not.toBeNull();
  });

  it('fails the turn in flight when the process is killed from outside', async () => {
    // A signal geniro never asked for. It used to settle `turn_cancelled` —
    // reading every signal as a Stop — which put a killed agent under the one
    // badge the app deliberately never notifies about, so a crashed turn ended
    // silently and blamed the user for stopping it.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    child.emit('close', null, 'SIGKILL');
    await handle?.done;

    expect(events).toEqual([
      {
        type: 'error',
        message: expect.stringContaining('SIGKILL'),
        // The signal as a FIELD too, so a report of the kill needs no prose
        // parsing — see `AgentErrorDetail`.
        detail: { signal: 'SIGKILL' },
      },
    ]);
    expect(session.alive).toBe(false);
  });

  it('still reads a kill it asked for as a cancellation', async () => {
    // The other half, and what keeps the fix above from turning every Stop into
    // a failure: `cancel()` is the path Stop and the shutdown reap both take,
    // and the SAME signal on that path is still the user's own doing.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    handle?.cancel();
    child.emit('close', null, 'SIGKILL');
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('reads a kill from closing the session as a cancellation too', async () => {
    // `close()` retires a session the daemon is done with — deliberate, so its
    // signal is not a failure either.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    session.close();
    child.emit('close', null, 'SIGTERM');
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });
});

describe('a session turn that goes silent', () => {
  it('gives up on the turn, and leaves the process alive to serve the next one', async () => {
    // The gap this closes: a `session` turn ends on its terminal EVENT, so a
    // process that stays alive and never emits one leaves the turn open with
    // nothing to bound it — both other backstops hang off `handle.done`, which
    // is precisely what never resolves here.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await handle?.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('giving up') },
    ]);
    // The process holds this run's MCP servers up. Only the turn was given up
    // on, so the next one still reuses it.
    expect(session.alive).toBe(true);
    expect(session.startTurn({ onEvent: () => {} })).not.toBeNull();
  });

  it('does not give up on a turn that is merely long', async () => {
    // Measured against SILENCE, not against the turn's length: an agent
    // legitimately works for hours, and a wall-clock cap would abandon real
    // work while the CLI was still reporting progress.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(25 * 60 * 1000);
      // Deliberately a line this mapper makes NO event of: unrecognised
      // stdout is still the process talking, and settling over one would
      // present a vocabulary gap to the user as a hang.
      line(child, { note: i });
    }
    await vi.advanceTimersByTimeAsync(25 * 60 * 1000);

    // Two and a half hours in, still running.
    expect(events).toEqual([]);
    expect(handle).not.toBeNull();

    line(child, { done: true });
    await handle?.done;
    expect(events).toEqual([COMPLETE]);
  });

  it('does not count the time the machine slept as silence, and gives a full window from the wake', async () => {
    // The incident (2026-10-10): a card turn quiet for ~45s when the Mac slept
    // for four hours was failed "produced nothing for 30 minutes" at the very
    // second it woke, because node's timers count through a macOS sleep.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    await vi.advanceTimersByTimeAsync(45_000);
    await simulateSleep(4 * 60 * 60 * 1000);
    expect(events).toEqual([]);

    // A FULL thirty minutes from the wake — not the 45s-shortened remainder.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1000);
    expect(events).toEqual([]);

    // …after which it is still a deadline: genuine silence is given up on.
    await vi.advanceTimersByTimeAsync(1000);
    await handle?.done;
    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('giving up') },
    ]);
    line(child, { done: true });
  });
});

describe('a turn parked on a question nobody has answered yet', () => {
  /** A turn whose verdicts actually reach the child. */
  const startAnswerableTurn = (
    session: ReturnType<typeof openSession>['session'],
    events: AgentEvent[],
  ) =>
    session.startTurn({
      onEvent: (e) => events.push(e),
      buildApprovalResponse: (id, allow) =>
        `${JSON.stringify({ verdict: id, allow })}\n`,
    });

  it('is not given up on, however long the user takes', async () => {
    // The reported defect, measured on the user's own daemon log twice on
    // 2026-08-11: an AskUserQuestion card went up, the user stepped away, and
    // 30 minutes and one second later the turn was settled as `error` with
    // "produced nothing… giving up on the turn", the run marked failed and the
    // card the user was coming back to answer rewritten as `unanswerable`.
    //
    // Nothing arrived after the card because nothing COULD — the CLI was
    // blocked on a verdict geniro itself was withholding. This deadline exists
    // for UNEXPLAINED silence; here the silence is fully accounted for, so it
    // must not run at all.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    // Three hours away from the desk — six times the old deadline.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);

    expect(events).toEqual([
      expect.objectContaining({ type: 'approval_request', id: 'card-1' }),
    ]);

    // …and the card is still answerable, which is the whole point: the user
    // comes back and the turn carries on.
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);
    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('starts the clock again from the ANSWER, not from when the card went up', async () => {
    // Suspended, not lengthened. If the deadline had merely been rearmed when
    // the card was raised, an answer at minute 29 would leave the turn one
    // minute from being abandoned — the user answers and watches it fail
    // anyway. The window has to begin where the CLI's obligation to speak does.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);

    // 58 minutes into the turn, 29 since the answer: still running.
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    // …and the deadline is genuinely BACK, not disabled for good — a turn that
    // stays silent after its answer is still given up on.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await handle?.done;
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: expect.stringContaining('giving up'),
    });
  });

  it('keeps waiting while a SECOND card is still unanswered', async () => {
    // Answering one of two does not unblock the CLI, so the clock must stay
    // suspended. Rearming on the first delivery would abandon the turn while a
    // card was still on screen — the same failure, one card later.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = startAnswerableTurn(session, events);

    line(child, { ask: 'card-1' });
    line(child, { ask: 'card-2' });
    expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);

    await vi.advanceTimersByTimeAsync(90 * 60 * 1000);
    expect(events.some((e) => e.type === 'error')).toBe(false);

    expect(handle?.respondApproval('card-2', true, undefined)).toBe(true);
    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('can still be stopped by the user while it waits', async () => {
    // With no deadline behind it, Stop is the ONLY way out of a parked turn —
    // so the escape hatch the suspension leans on is pinned here rather than
    // assumed.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildApprovalResponse: (id, allow) =>
        `${JSON.stringify({ verdict: id, allow })}\n`,
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    line(child, { ask: 'card-1' });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

    handle?.cancel();
    // The CLI answers an interrupt with an errored result, which the cancel
    // normalizes.
    line(child, { failed: true });
    await handle?.done;

    expect(events.at(-1)).toEqual({ type: 'turn_cancelled' });
  });
});

describe('cancelling a session turn', () => {
  it('asks the CLI to stop in protocol and leaves the process group alive', async () => {
    // Killing the group is what takes the user's MCP servers — and through them
    // a browser they are driving — down with the turn. On a run-scoped session
    // that cost is unacceptable for an ordinary Stop, and unnecessary:
    // probe-verified on claude 2.1.223, a `control_request`/`interrupt` ended
    // the turn in 2ms with the process still running.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();

    expect(child.stdin.written).toBe('INTERRUPT\n');
    expect(child.kills).toBe(0);

    // The CLI answers an interrupt with an ERRORED result. The cancel
    // normalizes it, so the transcript records a deliberate stop rather than a
    // failure the user never caused — and the process is still not killed.
    line(child, { failed: true });
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
  });

  it('SERVES the next turn once the stopped one ended on its own line — Stop costs no respawn', async () => {
    // REPORTED as "я его остановил. У него был открыт браузер Playwright.
    // Потом он написал новое сообщение, и Playwright сразу закрылся": every
    // Stop retired the session, so the next message had the registry replace
    // the process, and its MCP servers — the browser among them — went with
    // it. Measured on claude 2.1.266, the CLI's own `result` line is the LAST
    // thing a stopped turn prints, so a turn settled on it leaves no tail to
    // mistake for the next turn's output.
    const { session, child } = openSession();
    const first = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    first?.cancel();
    line(child, { failed: true });
    await first?.done;

    expect(session.retired).toBe(false);
    expect(session.startTurn({ onEvent: () => {} })).not.toBeNull();
    expect(child.kills).toBe(0);
    expect(session.alive).toBe(true);
  });

  it('sends the cancelled turn’s STRAGGLERS to the between-turn path, not to a turn', async () => {
    // Where anything printed AFTER a stopped turn settled lands. With no turn
    // open it must reach `onBetweenTurnEvent`, which is where the run persists
    // it as its own late row — never a turn, where a terminal line would settle
    // the user's next message instantly and its text would render under a
    // message sent after it. (Measured, claude prints nothing after a stopped
    // turn's own `result`; this pins where it would go if a CLI did.)
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const first = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    first?.cancel();
    line(child, { failed: true });
    await first?.done;

    // The CLI keeps talking after the settle — including a terminal line, the
    // one that used to end the next turn on arrival.
    line(child, { tool: 't1' });
    line(child, { done: true });

    expect(betweenTurns).toEqual([
      {
        type: 'tool_result',
        id: 't1',
        name: null,
        result: 'ok',
        isError: false,
      },
      COMPLETE,
    ]);
  });

  it('reports the pid it spawned while the process lives, and null once it exits', () => {
    // The root the process monitor attributes a run's whole tree from.
    const { session, child } = openSession(new FakeChild(4242));
    expect(session.pid).toBe(4242);

    child.emit('exit', 0, null);
    expect(session.pid).toBeNull();
  });

  it('counts the detached commands a process is still running — a delegate is not one', () => {
    // What the session registry reads to keep a process serving a dev server
    // from being reaped as unused.
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    expect(session.shellsRunning).toBe(0);

    line(child, { work: 'b1', phase: 'started', unit: 'other', call: 't1' });
    // A command whose launching call the CLI never named is still running.
    line(child, { work: 'b2', phase: 'started', unit: 'other' });
    line(child, { work: 'd1', phase: 'started', unit: 'agent', call: 't3' });
    expect(session.shellsRunning).toBe(2);

    line(child, { work: 'b1', phase: 'settled', outcome: 'completed' });
    expect(session.shellsRunning).toBe(1);
  });

  it('names the command lines of the detached commands it is still running', () => {
    // What the session registry tells an agent it stopped when it has to
    // replace the process under them — the line is what restarts a dev server.
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    line(child, { run: 't1', cmd: 'pnpm dev' });
    line(child, { work: 'b1', phase: 'started', unit: 'other', call: 't1' });
    // A delegate's own command, announced BEFORE the call that ran it.
    line(child, {
      work: 'b2',
      phase: 'started',
      unit: 'other',
      call: 't2',
      owned: true,
    });
    line(child, { run: 't2', cmd: 'pnpm test --watch', parent: 'task-1' });
    // Counted, but with no launching call there is no line to name.
    line(child, { work: 'b3', phase: 'started', unit: 'other' });
    expect(session.shellsRunning).toBe(3);
    expect(session.runningCommands).toEqual(['pnpm dev', 'pnpm test --watch']);

    line(child, { work: 'b1', phase: 'settled', outcome: 'completed' });
    expect(session.runningCommands).toEqual(['pnpm test --watch']);

    child.emit('close', 0, null);
    expect(session.runningCommands).toEqual([]);
  });

  it('keeps a running command’s line however many calls come after it', () => {
    // The map of lines is bounded; what it drops must never be a line a
    // running command still needs.
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    line(child, { run: 't0', cmd: 'pnpm dev' });
    line(child, { work: 'b0', phase: 'started', unit: 'other', call: 't0' });
    for (let i = 1; i <= 300; i += 1) {
      line(child, { run: `t${i}`, cmd: `ls ${i}` });
    }
    line(child, { work: 'b1', phase: 'started', unit: 'other', call: 't300' });

    expect(session.runningCommands).toEqual(['pnpm dev', 'ls 300']);
  });

  it('keeps the line of a foreground command, and of a delegate’s, until they detach', () => {
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    line(child, { run: 'tf', cmd: 'pnpm build' });
    line(child, {
      work: 'bf',
      phase: 'started',
      unit: 'other',
      call: 'tf',
      fore: true,
    });
    line(child, { run: 'td', cmd: 'pnpm test --watch', parent: 'task-1' });
    line(child, {
      work: 'bd',
      phase: 'started',
      unit: 'other',
      call: 'td',
      owned: true,
    });
    for (let i = 1; i <= 300; i += 1) {
      line(child, { run: `t${i}`, cmd: `ls ${i}` });
    }
    line(child, { work: 'bf', phase: 'backgrounded', unit: 'other' });

    expect(session.runningCommands).toEqual([
      'pnpm build',
      'pnpm test --watch',
    ]);
  });

  it('counts a delegate’s command as detached only once it is moved to the background', () => {
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    line(child, { run: 't9', cmd: 'cargo test', parent: 'agent-1' });
    line(child, {
      work: 'b9',
      phase: 'started',
      unit: 'other',
      call: 't9',
      owned: true,
      fore: true,
    });

    // Still waited on: it keeps the process from being reaped, but a close
    // stops no command the agent left running.
    expect(session.shellsRunning).toBe(1);
    expect(session.detachedRunning).toBe(0);
    expect(session.runningCommands).toEqual([]);

    line(child, { work: 'b9', phase: 'backgrounded', unit: 'other' });

    expect(session.detachedRunning).toBe(1);
    expect(session.runningCommands).toEqual(['cargo test']);
  });

  describe('a command the CLI never answered when its process died', () => {
    it('is answered as cut off ahead of the turn’s ending, under its delegate', async () => {
      const events: AgentEvent[] = [];
      const { session, child } = openSession();
      const handle = session.startTurn({ onEvent: (e) => events.push(e) });
      line(child, { run: 't1', cmd: 'pnpm test' });
      line(child, { run: 't2', cmd: 'ls' });
      line(child, { tool: 't2' });
      line(child, { run: 't3', cmd: 'cargo build', parent: 'agent-1' });

      // An OOM kill: nobody asked for it.
      child.emit('close', null, 'SIGKILL');
      await handle?.done;

      const cut = events.filter(
        (e) => e.type === 'tool_result' && e.result === CUT_OFF_COMMAND_RESULT,
      );
      expect(cut).toEqual([
        {
          type: 'tool_result',
          id: 't1',
          name: 'Bash',
          result: CUT_OFF_COMMAND_RESULT,
          isError: true,
        },
        {
          type: 'tool_result',
          id: 't3',
          name: 'Bash',
          result: CUT_OFF_COMMAND_RESULT,
          isError: true,
          parentToolUseId: 'agent-1',
        },
      ]);
      expect(events.indexOf(cut[1]!)).toBeLessThan(
        events.findIndex((e) => e.type === 'error'),
      );
    });

    it('is left alone on a Stop, which the transcript already reads as one', async () => {
      const events: AgentEvent[] = [];
      const { session, child } = openSession();
      const handle = session.startTurn({
        onEvent: (e) => events.push(e),
        buildInterruptPayload: () => 'INTERRUPT\n',
      });
      line(child, { run: 't1', cmd: 'pnpm test' });
      handle?.cancel();
      child.emit('close', null, 'SIGTERM');
      await handle?.done;

      expect(
        events.filter(
          (e) =>
            e.type === 'tool_result' && e.result === CUT_OFF_COMMAND_RESULT,
        ),
      ).toEqual([]);
    });
  });

  it('remembers what was running when the process ended', () => {
    // Read by a holder told of the end through `closed`, by which time the
    // live readings are empty.
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });
    expect(session.endedRunning).toBeNull();
    line(child, { run: 't1', cmd: 'pnpm dev' });
    line(child, { work: 'b1', phase: 'started', unit: 'other', call: 't1' });
    line(child, { work: 'b2', phase: 'started', unit: 'other' });

    child.emit('close', null, 'SIGKILL');

    expect(session.shellsRunning).toBe(0);
    expect(session.endedRunning).toEqual({
      running: 2,
      commands: ['pnpm dev'],
      groups: [],
    });
  });

  it('a follow-up delivered after the turn’s own result makes a continuation’s result NOT its ending again', async () => {
    // The follow-up is a new prompt the CLI has not answered, so the probed
    // case is back: a continuation already running finishes first, and its
    // result must not end the turn before the follow-up's answer arrives.
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      buildFollowUpPayload: (message) => `${message.text}\n`,
      onEvent: (event) => events.push(event),
    });
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { work: 'd1', phase: 'started', unit: 'agent', call: 't1' });
    line(child, { done: true, finalText: 'Launched the reviewer.' });
    expect(
      handle?.sendUserMessage({
        text: 'Check the docs too.',
        images: undefined,
      }),
    ).toBe(true);
    line(child, { work: 'd1', phase: 'settled', outcome: 'completed' });
    line(child, { continuationDone: true, finalText: 'Reviewer reported.' });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(betweenTurns).toEqual([
      expect.objectContaining({ type: 'turn_complete', continuation: true }),
    ]);

    line(child, { done: true, finalText: 'Docs checked too.' });
    await handle?.done;

    expect(events.filter((event) => event.type === 'turn_complete')).toEqual([
      expect.objectContaining({ finalText: 'Docs checked too.' }),
    ]);
  });

  it('settles on a continuation’s result once the turn has had its OWN result', async () => {
    // TRACED on run `3e05c90a` (2026-09-14): the turn's own result was held for
    // a sub-agent, the agent carried on by itself as it reported, and the
    // continuation's result was skipped as "not this turn's ending" — so the
    // turn had no ending it would accept, and the silence deadline settled it
    // as `error` thirty minutes later.
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      onEvent: (event) => events.push(event),
    });
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { work: 'd1', phase: 'started', unit: 'agent', call: 't1' });
    line(child, { done: true, finalText: 'Launched the reviewer.' });
    // The main thread speaks again — the continuation has begun — so the held
    // result is dropped and the turn runs on to its next ending.
    line(child, { says: 'The reviewer came back with two findings.' });
    line(child, { work: 'd1', phase: 'settled', outcome: 'completed' });
    line(child, { continuationDone: true, finalText: 'Both are fixed.' });
    await Promise.race([
      handle?.done,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);

    expect(settled).toBe(true);
    expect(events.filter((event) => event.type === 'turn_complete')).toEqual([
      expect.objectContaining({ finalText: 'Both are fixed.' }),
    ]);
    expect(betweenTurns.some((event) => event.type === 'turn_complete')).toBe(
      false,
    );
  });

  it('does NOT settle a turn on the result of a continuation the CLI ran by itself', async () => {
    // Probed on claude 2.1.266: a message written while the CLI was running a
    // continuation of its own was answered only AFTER that continuation's
    // result — so settling on the first result handed this turn the
    // continuation's text and ended it before its real answer arrived.
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      onEvent: (event) => events.push(event),
    });
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, {
      continuationDone: true,
      finalText: 'Background task completed (exit code 0).',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(events.some((event) => event.type === 'turn_complete')).toBe(false);
    // Not lost: the continuation's ending goes the between-turn way — stamped
    // as having ended nothing, which is what keeps its row off the run's badge.
    expect(betweenTurns).toEqual([
      expect.objectContaining({
        type: 'turn_complete',
        continuation: true,
        insideTurn: true,
      }),
    ]);

    line(child, { done: true, finalText: 'BANANA-9' });
    await handle?.done;

    expect(events.filter((event) => event.type === 'turn_complete')).toEqual([
      expect.objectContaining({ finalText: 'BANANA-9' }),
    ]);
  });

  it('does NOT fail a turn on the FAILURE of a continuation the CLI ran by itself', async () => {
    // The error twin of the case above. A continuation that failed says so on
    // its own result line (claude 2.1.280 puts `origin` on error results too);
    // ending the user's turn on it failed a turn whose prompt the CLI had not
    // reached yet, and dropped the answer that followed.
    const betweenTurns: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      onEvent: (event) => events.push(event),
    });
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { continuationFailed: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(betweenTurns).toEqual([
      expect.objectContaining({
        type: 'error',
        continuation: true,
        insideTurn: true,
      }),
    ]);

    line(child, { done: true, finalText: 'BANANA-9' });
    await handle?.done;
    expect(events.filter((event) => event.type === 'turn_complete')).toEqual([
      expect.objectContaining({ finalText: 'BANANA-9' }),
    ]);
  });

  it('still ends the turn when the user STOPPED it and a continuation then failed', async () => {
    // A Stop is exactly what should end this turn, and a failure after it is
    // normalized to the cancellation before any routing is considered.
    const { session, child } = openSession(undefined, undefined, () => {});
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      buildInterruptPayload: () => 'INTERRUPT\n',
      onEvent: (event) => events.push(event),
    });
    handle?.cancel();
    line(child, { continuationFailed: true });
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  describe('a prompt the CLI answered INSIDE a continuation', () => {
    // TRACED on run `a0877ce9` (2026-09-14): a called Engineer's final message
    // and two continuation results landed at 17:01:24 with the CLI announcing
    // `idle` in the same millisecond — and no result of the turn's own ever
    // followed. The turn waited for one until the silence deadline failed it
    // at 17:31:24, and its caller was told CALLEE_FAILED about finished work.
    const openAnsweredTurn = (
      extra: Partial<
        Parameters<ReturnType<typeof openSession>['session']['startTurn']>[0]
      > = {},
    ) => {
      const betweenTurns: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (event) =>
        betweenTurns.push(event),
      );
      const events: AgentEvent[] = [];
      const handle = session.startTurn({
        onEvent: (event) => events.push(event),
        ...extra,
      });
      const state = { settled: false };
      void handle?.done.then(() => {
        state.settled = true;
      });
      return { child, handle, events, betweenTurns, state };
    };

    it('settles on that result the moment the CLI goes idle', async () => {
      const { child, events, betweenTurns, state } = openAnsweredTurn();

      line(child, { continuationDone: true, finalText: 'Opened PR #5673.' });
      await Promise.resolve();
      expect(state.settled).toBe(false);

      line(child, { state: 'idle' });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.settled).toBe(true);
      expect(events.filter((event) => event.type === 'turn_complete')).toEqual([
        {
          type: 'turn_complete',
          usage: null,
          stopReason: null,
          finalText: 'Opened PR #5673.',
          // Says so, because the continuation's row already drew this turn's
          // footer — unflagged, a client drew the turn as finished twice.
          answeredByContinuation: true,
        },
      ]);
      // The continuation's own row — the one carrying the spend — is still the
      // only copy of it; the settle carries the text and no usage.
      expect(
        betweenTurns.filter((event) => event.type === 'turn_complete'),
      ).toHaveLength(1);
    });

    describe('once the CLI has echoed the prompt as TAKEN', () => {
      // PROBED on claude 2.1.284: a prompt written while a continuation the CLI
      // opened by itself ran a foreground command was echoed at the next tool
      // boundary and answered by that continuation's ONE result. Run
      // `74a134dd` is the same order — its session file logs
      // `absorbed_mid_turn` — and it drew `✓ done` twice.
      const PROMPT = 'BrightData fixed, Twingate as well';
      const absorbing = {
        promptText: PROMPT,
        followUpConsumptionReported: true,
      };

      it('ends the turn on the continuation’s result — one ending, nothing routed around', async () => {
        const { child, handle, events, betweenTurns } =
          openAnsweredTurn(absorbing);

        line(child, { taken: PROMPT });
        line(child, {
          continuationDone: true,
          finalText: 'Nine runs started.',
        });
        await handle?.done;

        expect(
          events.filter((event) => event.type === 'turn_complete'),
        ).toEqual([
          expect.objectContaining({
            finalText: 'Nine runs started.',
            continuation: true,
          }),
        ]);
        const [ending] = events.filter(
          (event) => event.type === 'turn_complete',
        );
        expect(ending).not.toHaveProperty('insideTurn');
        expect(ending).not.toHaveProperty('answeredByContinuation');
        expect(
          betweenTurns.filter((event) => event.type === 'turn_complete'),
        ).toEqual([]);
      });

      it('still routes around a continuation whose result came BEFORE the prompt was taken', async () => {
        // The other probed order: the continuation finished, THEN took the
        // prompt, and answered it with a result of its own.
        const { child, handle, events, betweenTurns } =
          openAnsweredTurn(absorbing);

        line(child, { continuationDone: true, finalText: 'Essay.' });
        line(child, { taken: PROMPT });
        line(child, { done: true, finalText: 'BANANA' });
        await handle?.done;

        expect(
          events.filter((event) => event.type === 'turn_complete'),
        ).toEqual([expect.objectContaining({ finalText: 'BANANA' })]);
        expect(betweenTurns).toEqual([
          expect.objectContaining({ continuation: true, insideTurn: true }),
        ]);
      });

      it('fails the turn on a continuation FAILURE after the prompt was taken', async () => {
        const { child, handle, events, betweenTurns } =
          openAnsweredTurn(absorbing);

        line(child, { taken: PROMPT });
        line(child, { continuationFailed: true });
        await handle?.done;

        expect(events.filter((event) => event.type === 'error')).toEqual([
          expect.objectContaining({ continuation: true }),
        ]);
        expect(betweenTurns).toEqual([]);
      });

      it('ignores the echo for a CLI that does not report what it takes', async () => {
        const { child, state, betweenTurns } = openAnsweredTurn({
          promptText: PROMPT,
        });

        line(child, { taken: PROMPT });
        line(child, {
          continuationDone: true,
          finalText: 'Nine runs started.',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(state.settled).toBe(false);
        expect(betweenTurns).toEqual([
          expect.objectContaining({ continuation: true, insideTurn: true }),
        ]);
      });
    });

    it('does not settle on idle while a card is still waiting on the user', async () => {
      const { child, state } = openAnsweredTurn();

      line(child, { continuationDone: true, finalText: 'Need a decision.' });
      line(child, { ask: 'q1' });
      line(child, { state: 'idle' });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.settled).toBe(false);
    });

    it('forgets that result once a follow-up is delivered — it did not answer it', async () => {
      const { child, handle, state } = openAnsweredTurn({
        buildFollowUpPayload: (message) => `${message.text}\n`,
      });

      line(child, { continuationDone: true, finalText: 'First answer.' });
      expect(
        handle?.sendUserMessage({ text: 'And the docs?', images: undefined }),
      ).toBe(true);
      line(child, { state: 'idle' });
      await Promise.resolve();
      await Promise.resolve();

      expect(state.settled).toBe(false);
    });

    it('settles on that result at the silence deadline instead of failing the turn', async () => {
      vi.useFakeTimers();
      const { child, handle, events } = openAnsweredTurn();

      line(child, { continuationDone: true, finalText: 'Shipped.' });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      await handle?.done;

      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.at(-1)).toEqual(
        expect.objectContaining({
          type: 'turn_complete',
          finalText: 'Shipped.',
        }),
      );
    });
  });

  it('kills the group when the CLI has no interrupt to send', () => {
    // The honest fallback: a CLI that cannot be told to stop can only be
    // stopped. Reporting the cancel as delivered without doing anything would
    // leave the turn running with the user told it had stopped.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    handle?.cancel();

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('escalates to killing the group when an accepted interrupt never ends the turn', () => {
    // The branch that keeps Stop truthful. An interrupt the CLI acknowledges
    // but never acts on would otherwise leave the turn running forever with no
    // second attempt — so the deadline exists, and it is worth a test that
    // actually enters it.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();
    expect(child.kills).toBe(0);

    vi.advanceTimersByTime(5_000);

    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');
  });

  it('emits what the driver still held ahead of the cancel when the interrupt fallback kills the process', () => {
    // A follow-up accepted behind an interrupt the CLI never acknowledged has
    // a row that reads as sent; only the driver knows it now never will be.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    const handle = session.startTurn({
      onEvent: (event) => events.push(event),
      buildInterruptPayload: () => 'INTERRUPT\n',
      onProcessEnded: () => [
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      ],
    });

    handle?.cancel();
    vi.advanceTimersByTime(5_000);
    child.emit('close', null, 'SIGTERM');

    expect(events).toEqual([
      { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      { type: 'turn_cancelled' },
    ]);
  });

  it('refuses a follow-up into a turn that has been asked to stop, writing nothing', () => {
    // A message sent right after Stop belongs to the NEXT turn: written into
    // the stopping one, codex refused it ("no active turn to steer") and
    // claude's queue died with the closed session.
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
      buildFollowUpPayload: (message) => `${message.text}\n`,
    });
    expect(
      handle?.sendUserMessage({ text: 'before stop', images: undefined }),
    ).toBe(true);
    handle?.cancel();

    expect(
      handle?.sendUserMessage({ text: 'after stop', images: undefined }),
    ).toBe(false);
    expect(child.stdin.written).toContain('before stop');
    expect(child.stdin.written).not.toContain('after stop');
  });

  describe('closing a session whose turn asks for a grace', () => {
    it('lets the stopped turn end on its own, then signals the group', async () => {
      vi.useFakeTimers();
      const { session, child } = openSession();
      const events: AgentEvent[] = [];
      const handle = session.startTurn({
        onEvent: (event) => events.push(event),
        buildInterruptPayload: () => 'INTERRUPT\n',
        closeGraceMs: () => 1000,
      });

      handle?.cancel();
      session.close();
      expect(child.kills).toBe(0);
      line(child, { failed: true });
      await handle?.done;
      await Promise.resolve();

      expect(events.map((event) => event.type)).toEqual(['turn_cancelled']);
      expect(child.kills).toBe(1);
    });

    it('signals the group at the deadline when the turn never ends', () => {
      vi.useFakeTimers();
      const { session, child } = openSession();
      const handle = session.startTurn({
        onEvent: () => {},
        buildInterruptPayload: () => 'INTERRUPT\n',
        closeGraceMs: () => 1000,
      });

      handle?.cancel();
      session.close();
      vi.advanceTimersByTime(999);
      expect(child.kills).toBe(0);
      vi.advanceTimersByTime(1);

      expect(child.kills).toBe(1);
    });

    it('signals at once when the turn asks for no grace', () => {
      const { session, child } = openSession();
      const handle = session.startTurn({
        onEvent: () => {},
        buildInterruptPayload: () => 'INTERRUPT\n',
        closeGraceMs: () => 0,
      });

      handle?.cancel();
      session.close();

      expect(child.kills).toBe(1);
    });
  });

  describe('a follow-up written into the CLI and not yet taken when the process ends', () => {
    // PROBED on claude 2.1.295 in the app: a message written just before Stop
    // was logged `enqueue` by the CLI, then the chat closed the session and
    // the message died queued — its row still read as sent.
    const consuming = (events: AgentEvent[]) => ({
      onEvent: (event: AgentEvent) => events.push(event),
      buildInterruptPayload: () => 'INTERRUPT\n',
      buildFollowUpPayload: (message: { text: string }) => `${message.text}\n`,
      followUpConsumptionReported: true,
    });

    it('is reported dropped ahead of the cancel', () => {
      const { session, child } = openSession();
      const events: AgentEvent[] = [];
      const handle = session.startTurn(consuming(events));
      expect(
        handle?.sendUserMessage({
          text: 'also the docs',
          images: undefined,
          deliveryId: 'delivery-1',
        }),
      ).toBe(true);

      handle?.cancel();
      child.emit('close', null, 'SIGTERM');

      expect(events).toEqual([
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
        { type: 'turn_cancelled' },
      ]);
    });

    it('is reported ahead of the CLI’s own cancel result when the process was already told to go', () => {
      // The order measured in the app: Stop interrupts AND closes the session
      // in one tick, and claude prints its cancel result before it exits.
      const { session, child } = openSession();
      const events: AgentEvent[] = [];
      const handle = session.startTurn(consuming(events));
      handle?.sendUserMessage({
        text: 'also the docs',
        images: undefined,
        deliveryId: 'delivery-1',
      });

      handle?.cancel();
      session.close();
      line(child, { failed: true });

      expect(events.slice(0, 2)).toEqual([
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
        expect.objectContaining({ type: 'turn_cancelled' }),
      ]);
    });

    it('is not reported for a turn the CLI cancels while its process lives on', () => {
      // claude keeps a queued message across an interrupt and runs it as a
      // turn of its own (probed on 2.1.295) — nothing is lost while it lives.
      const { session, child } = openSession();
      const events: AgentEvent[] = [];
      const handle = session.startTurn(consuming(events));
      handle?.sendUserMessage({
        text: 'also the docs',
        images: undefined,
        deliveryId: 'delivery-1',
      });

      handle?.cancel();
      line(child, { failed: true });

      expect(events.some((event) => event.type === 'follow_up_dropped')).toBe(
        false,
      );
    });

    it('is not reported once the CLI echoed it as taken', () => {
      const { session, child } = openSession();
      const events: AgentEvent[] = [];
      const handle = session.startTurn(consuming(events));
      handle?.sendUserMessage({
        text: 'also the docs',
        images: undefined,
        deliveryId: 'delivery-1',
      });
      line(child, { taken: 'also the docs' });

      handle?.cancel();
      child.emit('close', null, 'SIGTERM');

      expect(events).toEqual([{ type: 'turn_cancelled' }]);
    });
  });

  it('emits what the driver still held ahead of the error when the process errors under the turn', () => {
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    session.startTurn({
      onEvent: (event) => events.push(event),
      onProcessEnded: () => [
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      ],
    });

    child.emit('error', new Error('write EPIPE'));

    expect(events.map((event) => event.type)).toEqual([
      'follow_up_dropped',
      'error',
    ]);
  });

  it('does not let a second Stop skip the interrupt grace', () => {
    // Found by this test: the second press used to fall straight through to
    // the group kill, destroying the MCP servers immediately — the exact
    // outcome the in-protocol path exists to avoid, reachable by an impatient
    // double-click. A stop already under way is idempotent; its deadline is
    // what bounds it.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: () => {},
      buildInterruptPayload: () => 'INTERRUPT\n',
    });

    handle?.cancel();
    handle?.cancel();

    expect(child.stdin.written).toBe('INTERRUPT\n');
    expect(child.kills).toBe(0);

    // The deadline still fires once, and only once.
    vi.advanceTimersByTime(5_000);
    expect(child.kills).toBe(1);
  });

  it('keeps the SIGKILL escalation armed after the turn settles ahead of the process', async () => {
    // The escalation belongs to the PROCESS, not the turn. On a session the two
    // come apart: `close()` sends SIGTERM while a turn is running, the CLI
    // prints an errored result, and the turn settles — with the group still
    // alive. Disarming on the turn's settle (which is where the single-turn
    // code could safely do it) would leave a CLI that ignores SIGTERM running
    // forever, and the whole point of `close()` is that it ends.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    session.close();
    expect(child.killSignal).toBe('SIGTERM');

    line(child, { done: true }); // the turn ends; the process does not
    await handle?.done;

    vi.advanceTimersByTime(2_000);
    expect(child.killSignal).toBe('SIGKILL');
  });

  it('closes the process group on close(), even with a turn in flight', async () => {
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    session.close();
    expect(child.kills).toBe(1);
    expect(child.killSignal).toBe('SIGTERM');

    child.emit('close', null, 'SIGTERM');
    await handle?.done;
    await session.closed;
    expect(session.alive).toBe(false);
  });
});

describe('closing an idle session gracefully', () => {
  /** An idle session over a child whose pid is its own group's id. */
  async function idleSession(): Promise<{
    session: ReturnType<typeof runCliSession>;
    child: FakeChild;
    kill: MockInstance<typeof process.kill>;
  }> {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const { session, child } = openSession(new FakeChild(4242));
    const handle = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await handle?.done;
    return { session, child, kill };
  }

  it('closes stdin first and SIGTERMs only the CLI’s own group once it exits', async () => {
    // A SIGTERM to the CLI alone left an MCP server's inner worker orphaned
    // at ppid 1; the group signal after the exit is what reaches it.
    const { session, child, kill } = await idleSession();
    try {
      session.close(undefined, { graceful: true });
      expect(child.stdin.ended).toBe(true);
      expect(kill).not.toHaveBeenCalled();

      child.emit('exit', 0, null);
      expect(kill.mock.calls).toEqual([[-4242, 'SIGTERM']]);
      vi.advanceTimersByTime(2000);
      // Never the daemon's own process or group — the group is the child's.
      const targets = kill.mock.calls.map(([pid]) => pid);
      expect(targets).not.toContain(process.pid);
      expect(targets).not.toContain(-process.pid);
      expect(targets.every((pid) => pid === -4242)).toBe(true);
      child.emit('close', 0, null);
      await session.closed;
    } finally {
      kill.mockRestore();
    }
  });

  it('SIGTERMs the group 2s on when the CLI ignores EOF', async () => {
    // `cursor-agent acp` does not exit on EOF — the deadline is what ends it.
    const { session, kill } = await idleSession();
    try {
      session.close(undefined, { graceful: true });
      vi.advanceTimersByTime(1999);
      expect(kill).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    } finally {
      kill.mockRestore();
    }
  });

  it('signals at once when a turn is still in flight', () => {
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });

    session.close(undefined, { graceful: true });

    expect(child.killSignal).toBe('SIGTERM');
    expect(child.stdin.ended).toBe(false);
  });

  it('signals an idle process at once when the close is not graceful', async () => {
    // Eviction, a teardown and shutdown want the memory back now.
    const { session, child, kill } = await idleSession();
    try {
      session.close();
      expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(child.stdin.ended).toBe(false);
    } finally {
      kill.mockRestore();
    }
  });

  it('keeps a Stop’s cause for the exit it waits for, so a delegate still out ends stopped', async () => {
    // The exit, not the close, settles the delegates still out — and it reads
    // the cause the close recorded before returning without a signal.
    vi.useFakeTimers();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const events: AgentEvent[] = [];
      const { session, child } = openSession(
        new FakeChild(4242),
        undefined,
        (event) => events.push(event),
      );
      const handle = session.startTurn({ onEvent: () => {} });
      line(child, { done: true });
      await handle?.done;
      // Launched between turns: no turn is in flight, so the close is graceful.
      line(child, {
        work: 'a-delegate',
        phase: 'started',
        unit: 'agent',
        call: 'toolu_launch',
      });
      const last = () =>
        events
          .filter(
            (e): e is Extract<AgentEvent, { type: 'subagent_info' }> =>
              e.type === 'subagent_info' && e.id === 'toolu_launch',
          )
          .at(-1);
      expect(last()?.backgroundOpen).toBe(true);

      session.close('user-stop', { graceful: true });
      expect(child.stdin.ended).toBe(true);
      expect(session.closeCause).toBe('user-stop');

      child.emit('exit', 0, null);
      child.emit('close', 0, null);
      await session.closed;
      expect(last()).toMatchObject({
        backgroundOpen: false,
        backgroundOutcome: 'stopped',
      });
      expect(last()).not.toHaveProperty('trackingLost');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('runHeadlessCli keeps the one-turn contract', () => {
  it('records a clean exit that produced no result as a failure here too', async () => {
    // `settleFromTermination` is SHARED — this façade serves the `payload` and
    // `turn` lifetimes, which is every cursor ACP turn, every non-`ask` claude
    // turn and the probes. The clean-exit branch was pinned only for a
    // `session` lifetime, so a false alarm on this far busier path would have
    // shipped unnoticed, as would its removal.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    // Exit 0, no signal, and no `result` line ever printed.
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('without completing') },
    ]);
  });

  it('stays silent when the turn DID complete before the clean exit', async () => {
    // The other half, and what stops the branch above becoming a false alarm on
    // the ordinary path: a process that printed its result and then exited 0 has
    // completed, and must not also report a failure.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    child.emit('close', 0, null);
    await handle.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('closes a kept-open stdin on the terminal event and settles on the process', async () => {
    // The façade every pre-session caller still uses. Two properties it must
    // not lose: stdin is ended when the turn ends (or a stream-json CLI waits
    // on it forever), and `done` waits for the PROCESS so stdout has drained.
    const { spawn, child } = fakeSpawn();
    let settled = false;
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      keepStdinOpen: true,
      mapper: resultOnDone,
      onEvent: () => {},
      spawn,
    });
    void handle.done.then(() => {
      settled = true;
    });

    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    await Promise.resolve();

    expect(child.stdin.ended).toBe(true);
    // The terminal event alone must NOT settle this shape of turn.
    expect(settled).toBe(false);

    child.emit('close', 0, null);
    await handle.done;
    expect(settled).toBe(true);
  });

  it('ends stdin immediately when the turn was never given a dialogue', () => {
    const { spawn, child } = fakeSpawn();

    runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinPayload: 'PROMPT\n',
      mapper: noopMapper,
      onEvent: () => {},
      spawn,
    });

    expect(child.stdin.written).toBe('PROMPT\n');
    expect(child.stdin.ended).toBe(true);
  });
});

/**
 * The turn-end line is the end of what the agent was SAYING, never of what its
 * process is DOING.
 *
 * Probed on claude 2.1.231: a turn told to launch a delegate and not wait for it
 * printed its `result` while the delegate was still running, and the CLI then
 * ran a FURTHER turn of its own accord as the delegate reported
 * (`origin:{kind:"task-notification"}` on that turn's own result line). Settling
 * on the first `result` therefore ends geniro's turn in the middle of the work.
 *
 * The cost, measured across the author's own daemon log: 11 of 31 settles were
 * followed by off-turn work — up to 33 minutes and 997 events past the settle,
 * 227 whole assistant messages dropped for want of a turn to put them in, 430
 * permission requests answered with no card ever shown — while the run reported
 * `completed` and its delegates rendered as `stopped`.
 */

/**
 * Report a unit and have the CLI announce it is idle.
 *
 * For a CLI that announces its state the report alone does not settle a held
 * turn — its continuation's result or its `idle` does (`onSessionState` in
 * `spawn-cli.ts`). Every case here that expects the turn to END on a report
 * sends both, and the ones that expect it to CONTINUE do not.
 */
async function reportAndGoIdle(child: FakeChild, work: string): Promise<void> {
  line(child, { work, phase: 'settled' });
  line(child, { state: 'idle' });
  await Promise.resolve();
}

describe('which delegate a render card can be credited to', () => {
  // Each case below is one the inference gets wrong without its own condition.
  // The contract and the reasons are on
  // {@link AgentTurnHandle.attributableDelegate}.

  it('names the delegate once the agent has stopped talking', async () => {
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });
    expect(handle).not.toBeNull();

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    line(child, { done: true });
    await Promise.resolve();

    expect(handle!.attributableDelegate()).toBe('toolu_launch');

    await reportAndGoIdle(child, 'task-1');
    await handle?.done;
  });

  it('names nobody while the main thread is still talking', async () => {
    // The window the whole guard exists for: the agent goes on working — and
    // calling these very tools — while a delegate is out, which `spawn-cli`
    // says itself on the release path ("the main thread is talking again with
    // N unit(s) still out"). Attributing here credits the agent's OWN card to
    // the delegate it has just launched.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    await Promise.resolve();

    expect(handle!.attributableDelegate()).toBeNull();

    line(child, { done: true });
    await Promise.resolve();
    await reportAndGoIdle(child, 'task-1');
    await handle?.done;
  });

  it('names nobody while two delegates are out', async () => {
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, {
      work: 'a',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, {
      work: 'b',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_b',
    });
    line(child, { done: true });
    await Promise.resolve();

    expect(handle!.attributableDelegate()).toBeNull();

    line(child, { work: 'a', phase: 'settled' });
    await reportAndGoIdle(child, 'b');
    await handle?.done;
  });

  it('names nobody when the one delegate out has no launching call', async () => {
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, { work: 'nameless', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();

    expect(handle!.attributableDelegate()).toBeNull();

    await reportAndGoIdle(child, 'nameless');
    await handle?.done;
  });

  it('names nobody when a SECOND delegate is out unidentified', async () => {
    // Why the COUNT is taken over the live set rather than over the ids that
    // resolved. A delegate the CLI announced with no `tool_use_id` never
    // reaches the delegate map, so counting what resolved answers 1 while two
    // are out — and credits whichever one happened to carry a call.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, {
      work: 'named',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_named',
    });
    line(child, { work: 'nameless', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();

    expect(handle!.attributableDelegate()).toBeNull();

    line(child, { work: 'named', phase: 'settled' });
    await reportAndGoIdle(child, 'nameless');
    await handle?.done;
  });

  it('names nobody once the delegate has reported', async () => {
    // Why the lookup goes THROUGH the live set: the delegate map deliberately
    // outlives a delegate's end so a late cost report can still be booked, so
    // reading it alone goes on naming a delegate that has finished.
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: () => {} });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    line(child, { done: true });
    await Promise.resolve();
    expect(handle!.attributableDelegate()).toBe('toolu_launch');

    line(child, { work: 'task-1', phase: 'settled' });
    expect(handle!.attributableDelegate()).toBeNull();

    line(child, { state: 'idle' });
    await handle?.done;
  });
});

// claude reports a delegate `completed` each time it ends a TURN, even with a
// command it ran in the background still going, and starts it again when that
// command reports — so that settle is not the delegate's end.
describe('a delegate whose own detached command outlives its turn', () => {
  const SPENT = { tokens: 1234, toolUses: 5, durationMs: 6000 };

  function openDelegateSession() {
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (e) =>
      events.push(e),
    );
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    const last = () =>
      events
        .filter(
          (e): e is Extract<AgentEvent, { type: 'subagent_info' }> =>
            e.type === 'subagent_info' && e.id === 'toolu_launch',
        )
        .at(-1);
    const launch = (...commands: string[]) => {
      line(child, {
        work: 'a-delegate',
        phase: 'started',
        unit: 'agent',
        call: 'toolu_launch',
      });
      for (const command of commands) {
        line(child, { run: `toolu_${command}`, parent: 'toolu_launch' });
        line(child, {
          work: command,
          phase: 'started',
          unit: 'other',
          call: `toolu_${command}`,
          owned: true,
        });
      }
    };
    const finish = async () => {
      line(child, { done: true });
      line(child, { state: 'idle' });
      await handle?.done;
    };
    return { session, child, last, launch, finish };
  }

  it('closes only once the last of its commands has ended', async () => {
    const { session, child, last, launch, finish } = openDelegateSession();
    launch('b-1', 'b-2');
    expect(session.subagentRecoveryBlocked?.('toolu_launch')).toBe(true);
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    line(child, { work: 'b-1', phase: 'settled' });
    expect(last()?.backgroundOpen).toBe(true);
    expect(session.subagentRecoveryBlocked?.('toolu_launch')).toBe(true);

    line(child, { work: 'b-2', phase: 'settled' });
    expect(last()?.backgroundOpen).toBe(false);
    expect(session.subagentRecoveryBlocked?.('toolu_launch')).toBe(false);
    await finish();
  });

  it('stays open when claude starts it again before its command reports', async () => {
    const { child, last, launch, finish } = openDelegateSession();
    launch('b-1');
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    line(child, {
      work: 'a-delegate',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    line(child, { work: 'b-1', phase: 'settled' });
    expect(last()?.backgroundOpen).toBe(true);

    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    expect(last()?.backgroundOpen).toBe(false);
    await finish();
  });

  it.each([
    ['the figure-less channel first', [undefined, SPENT]],
    ['the figures first', [SPENT, undefined]],
  ])(
    'keeps the settle carrying its figures, with %s',
    async (_order, channels) => {
      const { child, last, launch, finish } = openDelegateSession();
      launch('b-1');
      for (const spent of channels) {
        line(child, {
          work: 'a-delegate',
          phase: 'settled',
          outcome: 'completed',
          spent,
        });
      }
      line(child, { work: 'b-1', phase: 'settled' });
      expect(last()).toMatchObject({
        backgroundOpen: false,
        backgroundOutcome: 'completed',
        tokens: 1234,
        toolUses: 5,
        durationMs: 6000,
      });
      await finish();
    },
  );

  it('files a command under its delegate when the call that started it arrives after it', async () => {
    const { child, last, finish } = openDelegateSession();
    line(child, {
      work: 'a-delegate',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    line(child, {
      work: 'b-1',
      phase: 'started',
      unit: 'other',
      call: 'toolu_b-1',
      owned: true,
    });
    line(child, { run: 'toolu_b-1', parent: 'toolu_launch' });
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    expect(last()?.backgroundOpen).toBe(true);

    line(child, { work: 'b-1', phase: 'settled' });
    expect(last()?.backgroundOpen).toBe(false);
    await finish();
  });

  it('lets go of a command that ended before the call that started it arrived', async () => {
    const { session, child, last, finish } = openDelegateSession();
    line(child, {
      work: 'a-delegate',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_launch',
    });
    line(child, {
      work: 'b-1',
      phase: 'started',
      unit: 'other',
      call: 'toolu_b-1',
      owned: true,
    });
    line(child, { work: 'b-1', phase: 'settled' });
    line(child, { run: 'toolu_b-1', parent: 'toolu_launch' });
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    expect(last()?.backgroundOpen).toBe(false);
    expect(session.shellsRunning).toBe(0);
    await finish();
  });

  it('lets a STOPPED end supersede a held completed one', async () => {
    const { child, last, launch, finish } = openDelegateSession();
    launch('b-1');
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'completed' });
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'stopped' });
    expect(last()).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'stopped',
    });

    line(child, { work: 'b-1', phase: 'settled' });
    expect(last()?.backgroundOutcome).toBe('stopped');
    await finish();
  });

  it('closes a delegate that FAILED at once, its command still running', async () => {
    const { child, last, launch, finish } = openDelegateSession();
    launch('b-1');
    line(child, { work: 'a-delegate', phase: 'settled', outcome: 'failed' });
    expect(last()).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'failed',
    });
    await finish();
  });

  it('announces the held settle as stopped, figures kept, when the process ends under its command', () => {
    const { child, last, launch } = openDelegateSession();
    launch('b-1');
    line(child, {
      work: 'a-delegate',
      phase: 'settled',
      outcome: 'completed',
      spent: SPENT,
    });
    expect(last()?.backgroundOpen).toBe(true);

    child.emit('close', 0, null);
    expect(last()).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'stopped',
      tokens: 1234,
    });
    expect(last()).not.toHaveProperty('trackingLost');
  });

  it('closes a delegate still out when the process ends as untracked, saying the process ended', () => {
    const { child, last, launch } = openDelegateSession();
    launch();
    expect(last()?.backgroundOpen).toBe(true);

    child.emit('close', 0, null);
    expect(last()).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'untracked',
      trackingLost: 'process-ended',
    });
  });

  it('closes a delegate still out as stopped when the user’s Stop closed the process', () => {
    const { session, child, last, launch } = openDelegateSession();
    launch();

    session.close('user-stop');
    child.emit('close', null, 'SIGTERM');
    expect(last()).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'stopped',
    });
    expect(last()).not.toHaveProperty('trackingLost');
  });

  it('closes them as stopped when a recorded Stop ends the process by any other way', () => {
    // A team Stop is recorded ahead of the cancel; the process can then
    // end from its own kill after a refused interrupt, with no close() at all.
    const { session, child, last, launch } = openDelegateSession();
    launch();

    session.noteCloseCause?.('user-stop');
    child.emit('close', null, 'SIGKILL');
    expect(last()).toMatchObject({ backgroundOutcome: 'stopped' });
  });

  it('forgets a recorded Stop once it is withdrawn', () => {
    const { session, child, last, launch } = openDelegateSession();
    launch();

    session.noteCloseCause?.('user-stop');
    session.noteCloseCause?.(null);
    child.emit('close', 0, null);
    expect(last()).toMatchObject({
      backgroundOutcome: 'untracked',
      trackingLost: 'process-ended',
    });
  });

  it('counts its command as one the process is still running', async () => {
    // What keeps the session registry from reaping the process — and the
    // command with it — under a delegate shown as working.
    const { session, child, launch, finish } = openDelegateSession();
    launch('b-1');
    // A command whose launching call the CLI never named still runs.
    line(child, { work: 'b-2', phase: 'started', unit: 'other', owned: true });
    expect(session.shellsRunning).toBe(2);

    line(child, { work: 'b-1', phase: 'settled' });
    line(child, { work: 'b-1', phase: 'settled', outcome: 'completed' });
    line(child, { work: 'b-2', phase: 'settled' });
    expect(session.shellsRunning).toBe(0);
    await finish();
  });
});

describe('a turn whose background work outlives its result', () => {
  it('announces nothing for a command a DELEGATE started, at either end', async () => {
    // REPORTED as "we should not show terminals from subagents": claude marks
    // such a command `owned_by_subagent` and names no parent, and its open used
    // to reach the run's shell list and count as the main thread's. claude
    // reports its end on BOTH terminal channels, and the second must be
    // swallowed too.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'b-owned',
      phase: 'started',
      unit: 'other',
      call: 'toolu_bash',
      owned: true,
    });
    line(child, { work: 'b-owned', phase: 'settled' });
    line(child, { work: 'b-owned', phase: 'settled', outcome: 'completed' });
    line(child, { done: true });
    await handle?.done;

    expect(
      events.some((e) => e.type === 'shell_open' || e.type === 'shell_info'),
    ).toBe(false);
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('holds for a DELEGATE and not for a backgrounded command', async () => {
    // The hold buys a turn for the agent's OWN continuation to land in, which
    // is a thing a delegate triggers and a shell does not: a shell's end is a
    // durable row, and anything the CLI says once it lands is carried by the
    // between-turn path. Held for one, the thread reads as working for as long
    // as the command runs — a `pnpm dev` never reports at all — which is the
    // reported "it shows working even though you actually stopped".
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'bash_1', phase: 'started', unit: 'other' });
    line(child, { done: true });

    await expect(handle?.done).resolves.toBeUndefined();
    expect(events.some((e) => e.type === 'turn_held')).toBe(false);
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('holds the turn open while a unit of work has not reported', async () => {
    const events: AgentEvent[] = [];
    let settled = false;
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();

    // The `result` line arrived and was HELD: no terminal event, no settle, and
    // the run therefore never reads `completed` while the work is out. What the
    // turn DOES say is that it is now held, and by how much — the one signal
    // that separates "the agent is working" from "the agent has stopped and we
    // are waiting on its listeners".
    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);
    expect(settled).toBe(false);
    expect(session.idle).toBe(false);

    // …and the delegate's own output still has a turn to land in, which is the
    // whole reason to hold it open rather than merely relabel the badge.
    line(child, { tool: 'toolu_late' });
    expect(events.at(-1)).toEqual({
      type: 'tool_result',
      id: 'toolu_late',
      name: null,
      result: 'ok',
      isError: false,
    });

    await reportAndGoIdle(child, 'task-1');
    await handle?.done;

    expect(events.at(-1)).toEqual(COMPLETE);
    expect(settled).toBe(true);
  });

  it('does not settle on the report itself — the continuation lands first', async () => {
    // THE reported defect. The hold ends when the last delegate reports, and
    // that is exactly the moment the CLI is about to speak again: the way it
    // LEARNS a delegate finished is a task notification, which opens a whole
    // further turn of its own. So the release fired one breath before the
    // continuation and geniro settled, painted `completed` and posted a
    // notification into the gap. REPORTED as "выполняет её, говорит мне «done»,
    // но потом сразу продолжает работать… я получаю фейковую нотификацию".
    // TRACED on run `309e0822`: released 13:02:48, badge `completed` the same
    // second, agent writing again ten seconds later and working for thirteen
    // more minutes.
    const events: AgentEvent[] = [];
    let settled = false;
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { state: 'running' });
    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    line(child, { work: 'task-1', phase: 'settled' });
    await Promise.resolve();
    // Nothing has settled on the report, which is the whole change: before, the
    // terminal went out on it.
    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);

    // …and then the continuation the report triggered begins.
    line(child, { says: 'Explorer returned with substantial findings.' });
    await Promise.resolve();

    // The held result is DROPPED: it describes a turn that has since continued,
    // so the turn now ends on its NEXT terminal.
    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);

    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('settles the moment the CLI goes idle when no continuation follows — no timer', async () => {
    // The genuine ending: the delegate reported and the agent had nothing more
    // to say. A ten-second grace used to stand here, and every such ending's
    // badge and notification arrived that much late. Real timers throughout,
    // so a wait of any length would time this case out.
    const events: AgentEvent[] = [];
    let settled = false;
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { state: 'running' });
    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, finalText: 'LAUNCHED' });
    line(child, { work: 'task-1', phase: 'settled' });
    await Promise.resolve();
    expect(settled).toBe(false);

    line(child, { state: 'idle' });
    await handle?.done;
    expect(settled).toBe(true);
    expect(events.at(-1)).toEqual({ ...COMPLETE, finalText: 'LAUNCHED' });
  });

  it('releases on the report for a CLI that has never announced its state', async () => {
    // Nothing else would ever say that turn is over.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    line(child, { work: 'task-1', phase: 'settled' });

    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('still settles when the agent really has finished', async () => {
    // The other half, and what stops the grace becoming a hang: a turn nothing
    // follows ends on its own, one window later. That is the cost of the fix —
    // a genuine ending waits ten seconds — and it is the right way round: a
    // late "done" is a wait, an early one is a lie.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await reportAndGoIdle(child, 'task-1');
    await handle?.done;

    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('ends the hold when the agent starts producing again', async () => {
    // The hold says TWO things — the turn stays open, and the agent is idle —
    // and only the first was ever taken back. Every consumer acts on the
    // second: the composer sends straight to an idle CLI instead of queueing,
    // and the badge reads the run as idle. Reported as "it sent message not in
    // queue … its always, not just during compaction" — a background task with
    // no end held the turn, and three messages went into a CLI that was
    // demonstrably working, the last of them mid-compaction.
    const events: AgentEvent[] = [];
    let settled = false;
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    void handle?.done.then(() => {
      settled = true;
    });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();
    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);

    // A DELEGATE writing is not the agent resuming — it is the very work the
    // hold is waiting for, and clearing on it would undo the mechanism.
    line(child, { says: 'delegate thinking', parent: 'toolu_launch' });
    expect(events.at(-1)).toEqual({
      type: 'text',
      text: 'delegate thinking',
      parentToolUseId: 'toolu_launch',
    });
    expect(events.filter((e) => e.type === 'turn_held')).toEqual([
      { type: 'turn_held', open: 1 },
    ]);

    // The MAIN thread authoring something is.
    line(child, { says: 'back to work' });

    expect(events.at(-2)).toEqual({ type: 'turn_held', open: 0 });
    expect(settled).toBe(false);

    // …and the stale result is GONE rather than merely unannounced: releasing
    // it when the last unit reports would settle the turn in the middle of the
    // answer the agent is now writing.
    await reportAndGoIdle(child, 'task-1');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);

    // The turn ends on its NEXT terminal, which is the agent's own.
    line(child, { done: true });
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
    expect(settled).toBe(true);
  });

  it('ends the hold the moment a follow-up is DELIVERED, not when the CLI answers', async () => {
    // The window this closes was 8 seconds in the reported case: the follow-up
    // was `/compact`, which the CLI works on for its whole first stretch
    // without authoring anything, so waiting for it to speak left the run
    // reading idle — and the user's NEXT message went straight out too.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildFollowUpPayload: (message) =>
        `${JSON.stringify({ follow: message.text })}\n`,
    });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();
    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);

    expect(handle?.sendUserMessage({ text: '/compact' })).toBe(true);

    expect(events.at(-1)).toEqual({ type: 'turn_held', open: 0 });
  });

  it('keeps what the superseded result cost when the agent resumes — folded into the turn’s own ending', async () => {
    // The held result no longer ENDS the turn, but its segment was still spent
    // in it: dropping it lost that whole segment's bill, since the next result
    // reports only the stretch after it.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, cost: 1.25, finalText: 'first' });
    line(child, { says: 'back to work' });
    await reportAndGoIdle(child, 'task-1');
    line(child, { done: true, cost: 0.5, finalText: 'second' });
    await handle?.done;

    const ending = events.filter((e) => e.type === 'turn_complete');
    expect(ending).toHaveLength(1);
    expect(ending[0]).toMatchObject({
      finalText: 'second',
      usage: { costUsd: 1.75 },
    });
  });

  it('keeps a held segment’s cost on the LIVE plane until the turn that records it settles', async () => {
    // REPORTED as two identical team callees reading $0.18 and $22.34 (run
    // `07d68eea`): the CLI's running figure restarts at each `result`, and the
    // held `turn_complete` carrying that segment is emitted only at the end —
    // so a held turn's card stated what it spent since its latest continuation.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    const live = (): number | undefined =>
      events.findLast((e) => e.type === 'cost_progress')?.costUsd;

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { live: 1.2 });
    expect(live()).toBe(1.2);

    // The result: the CLI's own figure restarts, the segment is held.
    line(child, { live: 0 });
    line(child, { done: true, cost: 1.25 });
    expect(live()).toBe(1.25);

    // The continuation spends more; the live figure is both together.
    line(child, { says: 'back to work' });
    line(child, { live: 0.4 });
    expect(live()).toBeCloseTo(1.65);

    await reportAndGoIdle(child, 'task-1');
    line(child, { live: 0 });
    line(child, { done: true, cost: 0.5 });
    await handle?.done;

    // Down to zero AHEAD of the terminal that records all of it.
    const zeroAt = events.findLastIndex(
      (e) => e.type === 'cost_progress' && e.costUsd === 0,
    );
    const endAt = events.findIndex((e) => e.type === 'turn_complete');
    expect(live()).toBe(0);
    expect(zeroAt).toBeGreaterThan(-1);
    expect(zeroAt).toBeLessThan(endAt);
    expect(events[endAt]).toMatchObject({ usage: { costUsd: 1.75 } });
  });

  it('carries the part of a held segment’s cost geniro priced onto the LIVE plane', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    const live = ():
      Extract<AgentEvent, { type: 'cost_progress' }> | undefined =>
      events.findLast(
        (e): e is Extract<AgentEvent, { type: 'cost_progress' }> =>
          e.type === 'cost_progress',
      );

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, cost: 1.25, estimated: 1.25 });
    // The held segment was list-priced; the continuation's running figure is
    // the CLI's own, so only the held part is an estimate.
    line(child, { says: 'back to work' });
    line(child, { live: 0.4 });
    expect(live()).toMatchObject({ costUsd: 1.65, estimatedCostUsd: 1.25 });
    line(child, { live: 0.5, liveEstimated: 0.5 });
    expect(live()?.estimatedCostUsd).toBeCloseTo(1.75);

    await reportAndGoIdle(child, 'task-1');
    line(child, { live: 0 });
    line(child, { done: true, cost: 0.5 });
    await handle?.done;

    // The zero that takes the figure down carries no estimate of its own.
    expect(live()).toEqual({ type: 'cost_progress', costUsd: 0 });
    expect(events.find((e) => e.type === 'turn_complete')).toMatchObject({
      usage: { costUsd: 1.75, estimatedCostUsd: 1.25 },
    });
  });

  it('keeps what the superseded result cost when the resumed turn then FAILS', async () => {
    // A failure's own figures are the last segment's alone, and here it
    // reported none — so the resumed-past segment is the whole bill.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, cost: 1.25 });
    line(child, { says: 'back to work' });
    line(child, { failed: true });
    await handle?.done;

    const ending = events.at(-1);
    expect(ending).toMatchObject({
      type: 'error',
      usage: { costUsd: 1.25 },
    });
  });

  it('keeps what the superseded result cost when a follow-up is delivered into the hold', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      buildFollowUpPayload: (message) =>
        `${JSON.stringify({ follow: message.text })}\n`,
    });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, cost: 1.25 });
    await Promise.resolve();
    expect(handle?.sendUserMessage({ text: 'and this' })).toBe(true);
    await reportAndGoIdle(child, 'task-1');
    line(child, { done: true, cost: 0.5 });
    await handle?.done;

    const ending = events.filter((e) => e.type === 'turn_complete');
    expect(ending).toHaveLength(1);
    expect(ending[0]).toMatchObject({ usage: { costUsd: 1.75 } });
  });

  it('holds AGAIN when work is still out at the resumed turn’s own end', async () => {
    // `openWork` is untouched by a release, which is what makes the second
    // hold happen — the units were never accounted for, only stopped being
    // the reason to call the agent idle.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'forever', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    line(child, { says: 'resumed' });
    line(child, { done: true });
    await Promise.resolve();

    expect(events.filter((e) => e.type === 'turn_held')).toEqual([
      { type: 'turn_held', open: 1 },
      { type: 'turn_held', open: 0 },
      { type: 'turn_held', open: 1 },
    ]);
    expect(events.some((e) => e.type === 'turn_complete')).toBe(false);

    await reportAndGoIdle(child, 'forever');
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('waits for the LAST unit, not the first to report', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { work: 'task-2', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await reportAndGoIdle(child, 'task-1');
    await Promise.resolve();

    // The first report wakes the agent, so the hold is over for now — though
    // the turn still waits on the other unit before it can end.
    expect(events.filter((e) => e.type === 'turn_held')).toEqual([
      { type: 'turn_held', open: 2 },
      { type: 'turn_held', open: 0 },
    ]);

    await reportAndGoIdle(child, 'task-2');
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('is not released by a report for work it never opened', async () => {
    // The set is keyed by the CLI's own id precisely so this cannot happen: a
    // stray or duplicated `settled` must not stand in for the one still out.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    // A stray closes nothing, so it releases nothing.
    line(child, { work: 'somebody-elses-task', phase: 'settled' });
    await Promise.resolve();

    // Still held — the stray report closed nothing this turn was waiting on,
    // so it woke nobody.
    expect(events.filter((e) => e.type === 'turn_held')).toEqual([
      { type: 'turn_held', open: 1 },
    ]);

    line(child, { work: 'task-1', phase: 'settled' });
    // A second report for the same task must not release a second terminal.
    line(child, { work: 'task-1', phase: 'settled' });
    await handle?.done;

    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('keeps the FIRST result, which is the one that answers the prompt', async () => {
    // claude's later self-initiated turns print their own result lines, whose
    // text is a "Background note (no action needed)…" and whose usage is that
    // turn's, not this one's. Held means held: the answer the user asked for.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true, finalText: 'LAUNCHED' });
    line(child, {
      done: true,
      finalText: 'Background note (no action needed)',
    });
    await Promise.resolve();

    // Neither result ended the turn — the second one least of all. The hold is
    // announced ONCE: the second result did not re-enter the hold.
    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);

    await reportAndGoIdle(child, 'task-1');
    await handle?.done;

    expect(events.at(-1)).toEqual({ ...COMPLETE, finalText: 'LAUNCHED' });
  });

  it('announces a DELEGATE’s background lifecycle, keyed by its launching call', async () => {
    // The one thing forwarded off this channel, and the reason it must be: a
    // delegate the agent does not wait for has its `Task` call answered at once,
    // so the transcript reads it as finished while it runs on. These two rows
    // are what let the block — and the header's counter — say otherwise.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    // The settle names neither the kind nor the call — matched by work id.
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([
      {
        type: 'subagent_info',
        id: 'toolu_a',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        tokens: null,
        toolUses: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        stepsUnavailableReason: null,
        backgroundOpen: true,
        backgroundOutcome: null,
      },
      {
        type: 'subagent_info',
        id: 'toolu_a',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        tokens: null,
        toolUses: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        stepsUnavailableReason: null,
        backgroundOpen: false,
        backgroundOutcome: null,
      },
      COMPLETE,
    ]);
  });

  it('carries HOW a delegate ended onto the announcement that closes it', async () => {
    // The join between the settle and the row the transcript reads. Without it
    // the whole outcome path is revertible with a green suite: every other
    // assertion in this file settles with no outcome, so `backgroundOutcome`
    // could be hard-wired to null and nothing here would notice — while a
    // killed delegate went back to wearing a green check.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, { work: 'task-1', phase: 'settled', outcome: 'stopped' });
    line(child, { done: true });
    await handle?.done;

    const announced = events.filter((e) => e.type === 'subagent_info');
    // The `started` anchor claims nothing about an ending…
    expect(announced[0]).toMatchObject({
      backgroundOpen: true,
      backgroundOutcome: null,
    });
    // …and the settle carries the CLI's own verdict through.
    expect(announced[1]).toMatchObject({
      backgroundOpen: false,
      backgroundOutcome: 'stopped',
    });
  });

  it('does not announce a delegate the agent WAITS on as background work', async () => {
    // A sync sub-agent: the launching call blocks on it. Announced as
    // `backgroundOpen: true`, it raised the run's `subagentsOut`, which the
    // composer reads as "the agent is free" — and a message typed during it
    // went straight into a turn that could not read it for minutes.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-f',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_f',
      fore: true,
    });
    line(child, { work: 'task-f', phase: 'settled', outcome: 'completed' });
    line(child, { done: true });
    await handle?.done;

    const announced = events.filter((e) => e.type === 'subagent_info');
    // No open at all — only the settle, which closes nothing that counted.
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({
      id: 'toolu_f',
      backgroundOpen: false,
      backgroundOutcome: 'completed',
    });
  });

  it('opens a waited-on delegate the moment the CLI moves it to the background', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-f',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_f',
      fore: true,
    });
    line(child, { work: 'task-f', phase: 'backgrounded' });
    // A second move is not news and writes no second row.
    line(child, { work: 'task-f', phase: 'backgrounded' });
    line(child, { work: 'task-f', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    const announced = events.filter((e) => e.type === 'subagent_info');
    expect(announced.map((e) => [e.id, e.backgroundOpen])).toEqual([
      // Keyed by the launching call the `started` recorded — the move names none.
      ['toolu_f', true],
      ['toolu_f', false],
    ]);
  });

  it('ignores a move to the background for a delegate that was background from the start', async () => {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-b',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_b',
    });
    line(child, { work: 'task-b', phase: 'backgrounded' });
    line(child, { work: 'task-b', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    const announced = events.filter((e) => e.type === 'subagent_info');
    expect(announced.map((e) => e.backgroundOpen)).toEqual([true, false]);
  });

  it('keeps a FOREGROUND command out of the shells until it is detached', async () => {
    // claude registers a long foreground command as a task (`is_backgrounded:
    // false`) so it CAN be backgrounded; until it is, it is the agent's current
    // tool call. A `shell_open` for it counted it in `shellsOpen`.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    // One that ends where it started: no row at either end.
    line(child, {
      work: 'bash_f',
      phase: 'started',
      call: 'toolu_f',
      fore: true,
    });
    line(child, { work: 'bash_f', phase: 'settled' });
    // One the CLI detaches: opened by the move, closed by its settle.
    line(child, {
      work: 'bash_d',
      phase: 'started',
      call: 'toolu_d',
      fore: true,
    });
    line(child, { work: 'bash_d', phase: 'backgrounded' });
    line(child, { work: 'bash_d', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(
      events.filter((e) => e.type === 'shell_open' || e.type === 'shell_info'),
    ).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_d', workId: 'bash_d' },
      { type: 'shell_info', toolCallId: 'toolu_d', workId: 'bash_d' },
    ]);
  });

  it('closes a background SHELL with its own announcement', async () => {
    // The row the running-shells list needs and the transcript otherwise never
    // gets: a detached command's launching call is answered the moment the CLI
    // accepts it, so nothing else says the command has actually finished.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'bash_1',
      phase: 'started',
      unit: 'other',
      call: 'toolu_sh',
    });
    // The settle names neither the kind nor the call — matched by work id,
    // exactly as a delegate's is.
    line(child, { work: 'bash_1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    // BOTH halves, in order. The open writes no row — the launching call is
    // already in the transcript — but it is the only thing that says a command
    // is out RIGHT NOW, which is what the run row's `shellsOpen` is counted
    // from; without it the daemon watches every command end and sees none begin.
    expect(events).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_sh', workId: 'bash_1' },
      { type: 'shell_info', toolCallId: 'toolu_sh', workId: 'bash_1' },
      COMPLETE,
    ]);
  });

  it('closes a shell the process died under, since nothing else can', async () => {
    // A detached command is a child of the CLI and dies with the group. The
    // CLI is what reports a shell's end, so a session reaped (or stopped) with
    // one still open leaves a row nothing will ever take down — and the client
    // lists a detached command on the strength of that report rather than on
    // the run's status, so it would stand for the transcript's whole life.
    // Both sinks, because which one carries the row depends on whether the
    // dying process still had a turn open — and the row must arrive either way.
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (e) =>
      events.push(e),
    );
    session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'bash_1',
      phase: 'started',
      unit: 'other',
      call: 'toolu_sh',
    });
    await Promise.resolve();
    expect(events.some((e) => e.type === 'shell_info')).toBe(false);

    child.emit('close', 0, null);
    await session.closed;

    expect(events).toContainEqual({
      type: 'shell_info',
      toolCallId: 'toolu_sh',
      workId: 'bash_1',
    });
  });

  it('announces ONE row however many channels report the end', async () => {
    // Measured on a real background `sleep`: claude reports the same ending on
    // `task_updated` AND `task_notification`, 7ms apart. The row is durable, so
    // a duplicate would be stored for the life of the transcript.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'bash_1',
      phase: 'started',
      unit: 'other',
      call: 'toolu_sh',
    });
    line(child, { work: 'bash_1', phase: 'settled', call: 'toolu_sh' });
    line(child, { work: 'bash_1', phase: 'settled', call: 'toolu_sh' });
    line(child, { done: true });
    await handle?.done;

    expect(events.filter((e) => e.type === 'shell_info')).toEqual([
      { type: 'shell_info', toolCallId: 'toolu_sh', workId: 'bash_1' },
    ]);
  });

  it('announces no shell settle the started of which this process never saw', async () => {
    // A session resumed after the launch: the process that opened the shell
    // closed it as it ended, and claude, resumed after a crash, reports such a
    // task `stopped` once more (measured on 2.1.295). A second close would be
    // a durable duplicate.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'bash_9', phase: 'settled', call: 't-old' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('announces the settle of a shell whose settle channel names no call', async () => {
    // The work id alone still names the command, which is the whole reason
    // both ride every announcement.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { run: 't1', cmd: 'sleep 9' });
    line(child, {
      work: 'bash_9',
      phase: 'started',
      unit: 'other',
      call: 't1',
    });
    line(child, { work: 'bash_9', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events).toContainEqual({
      type: 'shell_info',
      toolCallId: 't1',
      workId: 'bash_9',
    });
  });

  it('never announces a DELEGATE as a shell', async () => {
    // The two twins split one channel, and this is the split: announcing a
    // delegate here would retire a shell row that never existed, while
    // announcing a shell as a delegate would put a phantom sub-agent in the
    // transcript.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events.filter((e) => e.type === 'shell_info')).toEqual([]);
  });

  it('carries the settling unit’s SPEND onto the announcement', async () => {
    // What the block header states in front of each delegate. The figures ride
    // the lifecycle event and are announced HERE rather than by the adapter
    // because this is the only point that knows the settling unit was a
    // delegate — the settle line does not restate it.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, {
      work: 'task-1',
      phase: 'settled',
      spent: { tokens: 26124, toolUses: 0, durationMs: 2029 },
    });
    line(child, { done: true });
    await handle?.done;

    expect(events).toEqual([
      expect.objectContaining({
        type: 'subagent_info',
        backgroundOpen: true,
        backgroundOutcome: null,
        // The launch measures nothing, and must not: a `started` announcing
        // zeros would be a reading, and the merge prefers the last non-null.
        tokens: null,
        toolUses: null,
        durationMs: null,
      }),
      expect.objectContaining({
        type: 'subagent_info',
        backgroundOpen: false,
        backgroundOutcome: null,
        tokens: 26124,
        toolUses: 0,
        durationMs: 2029,
      }),
      COMPLETE,
    ]);
  });

  it('still reports the spend when a figure-less settle arrives FIRST', async () => {
    // The order claude actually sends, measured on 2.1.237: `task_updated`
    // {status:'completed'} and then `task_notification` {usage:{…}}, both for
    // one delegate. Forgetting the delegate on the first settle threw the
    // figures away every time — four rows in the app's own database with
    // `tokens: null` on all of them, which is how this was caught.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, {
      work: 'task-1',
      phase: 'settled',
      spent: { tokens: 26124, toolUses: 0, durationMs: 2029 },
    });
    line(child, { done: true });
    await handle?.done;

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'subagent_info',
        id: 'toolu_a',
        tokens: 26124,
        durationMs: 2029,
      }),
    );
  });

  it('never announces a SHELL as a sub-agent', async () => {
    // The same channel carries a delegate's own shell command. Announcing one
    // as a delegate would put a phantom sub-agent in the transcript, under the
    // id of whatever tool call happened to launch it. It gets the `shell_info`
    // row instead — a different kind, which renders as nothing and exists only
    // to close the command in the running-shells list.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, {
      work: 'task-bash',
      phase: 'started',
      unit: 'other',
      call: 'toolu_bash',
    });
    line(child, { work: 'task-bash', phase: 'settled', call: 'toolu_bash' });
    line(child, { done: true });
    await handle?.done;

    expect(events.filter((e) => e.type === 'subagent_info')).toEqual([]);
    expect(events).toEqual([
      { type: 'shell_open', toolCallId: 'toolu_bash', workId: 'task-bash' },
      { type: 'shell_info', toolCallId: 'toolu_bash', workId: 'task-bash' },
      COMPLETE,
    ]);
  });

  it('never hands a background_work event to the turn', async () => {
    // Turn plumbing, not conversation. `mapEventToItem` answers null for it too,
    // but a consumer must not see the raw event at all — a pair of "work
    // started/settled" rows would say what the delegate's own rows already say.
    // What a consumer DOES see is the derived announcement, which is one row on
    // the settle and never the pair.
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { work: 'task-1', phase: 'settled' });
    line(child, { done: true });
    await handle?.done;

    expect(events.filter((e) => e.type === 'background_work')).toEqual([]);
    expect(events).toEqual([COMPLETE]);
  });

  it('does NOT hold a cancel or a failure back', async () => {
    // A cancel is the user asking to stop now, and an `error` is a turn that
    // failed rather than finished. Holding either would keep a turn open for
    // work the user just abandoned, or hide a failure behind a delegate.
    const cancelled: AgentEvent[] = [];
    const first = openSession();
    const cancelHandle = first.session.startTurn({
      onEvent: (e) => cancelled.push(e),
      buildInterruptPayload: () => 'INTERRUPT\n',
    });
    line(first.child, { work: 'task-1', phase: 'started', unit: 'agent' });
    cancelHandle?.cancel();
    line(first.child, { failed: true });
    await cancelHandle?.done;
    expect(cancelled).toEqual([{ type: 'turn_cancelled' }]);

    const failed: AgentEvent[] = [];
    const second = openSession();
    const failHandle = second.session.startTurn({
      onEvent: (e) => failed.push(e),
    });
    line(second.child, { work: 'task-2', phase: 'started', unit: 'agent' });
    line(second.child, { failed: true });
    await failHandle?.done;
    expect(failed).toEqual([{ type: 'error', message: 'result: is_error' }]);
  });

  it('releases the held result when the process exits cleanly under it', async () => {
    // The work is over one way or another once the process is gone, and the turn
    // DID complete. Falling through to the clean-exit branch would replace a real
    // `turn_complete` with "exited without completing the turn".
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    child.emit('close', 0, null);
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_held', open: 1 }, COMPLETE]);
    expect(session.alive).toBe(false);
  });

  it.each(['idle', 'silence'] as const)(
    'marks missing delegate reports untracked on %s and accepts a late completion',
    async (ending) => {
      vi.useFakeTimers();
      const events: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (event) =>
        events.push(event),
      );
      const handle = session.startTurn({
        onEvent: (event) => events.push(event),
      });
      line(child, {
        work: 'task-1',
        phase: 'started',
        unit: 'agent',
        call: 'toolu_a',
      });
      line(child, { done: true });
      if (ending === 'idle') {
        line(child, { state: 'idle' });
      } else {
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      }
      await handle?.done;
      expect(
        events.filter((event) => event.type === 'subagent_info').at(-1),
      ).toMatchObject({
        id: 'toolu_a',
        backgroundOpen: false,
        backgroundOutcome: 'untracked',
      });
      // The process still runs, so the delegate may too.
      expect(
        events.filter((event) => event.type === 'subagent_info').at(-1),
      ).not.toHaveProperty('trackingLost');
      expect(events.at(-1)?.type).toBe('turn_complete');
      line(child, { work: 'task-1', phase: 'settled', outcome: 'completed' });
      expect(events.at(-1)).toMatchObject({
        type: 'subagent_info',
        id: 'toolu_a',
        backgroundOutcome: 'completed',
      });
    },
  );

  it('releases the held result when the work goes silent too', async () => {
    // The bound, and it is the turn's existing silence deadline rather than a
    // second timer. Its own sentence ("produced nothing… giving up") would be
    // false twice over about this turn — it produced an answer, and what went
    // quiet was the work — so the held result is what gets released.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await handle?.done;

    expect(events).toEqual([{ type: 'turn_held', open: 1 }, COMPLETE]);
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'never reported',
    );
    // And the process is left alive for the next turn, as every other
    // silence-deadline settle leaves it.
    expect(session.alive).toBe(true);
  });

  it('announces a delegate launched BETWEEN turns, so its block does not read done', async () => {
    // The reported defect. The CLI carries on by itself, and a delegate it
    // launches THERE was invisible: no announcement, so the block closed the
    // moment its `Task` call was answered and the transcript said `done` over
    // an agent that had not started working yet.
    const between: AgentEvent[] = [];
    const { child } = openSession(undefined, undefined, (e) => between.push(e));

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });

    expect(between).toEqual([
      {
        type: 'subagent_info',
        id: 'toolu_a',
        label: null,
        kind: null,
        prompt: null,
        model: null,
        durationMs: null,
        tokens: null,
        toolUses: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        costUsd: null,
        stepsUnavailableReason: null,
        backgroundOpen: true,
        backgroundOutcome: null,
      },
    ]);

    // …and its close is announced on the same channel, so the block does not
    // spin for the rest of the conversation either.
    line(child, { work: 'task-1', phase: 'settled' });
    expect(between.at(-1)).toEqual({
      type: 'subagent_info',
      id: 'toolu_a',
      label: null,
      kind: null,
      prompt: null,
      model: null,
      durationMs: null,
      tokens: null,
      toolUses: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      stepsUnavailableReason: null,
      backgroundOpen: false,
      backgroundOutcome: null,
    });
  });

  it('holds the NEXT turn open for work that started between turns', async () => {
    // Background work belongs to the PROCESS, not to whichever turn happened to
    // be open when the CLI announced it. Tracked per turn, work launched
    // off-turn held nothing, and the next turn settled the run `completed` with
    // the delegate still going.
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, () => {});

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    line(child, { done: true });
    await Promise.resolve();

    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);

    await reportAndGoIdle(child, 'task-1');
    await handle?.done;
    expect(events.at(-1)).toEqual(COMPLETE);
  });

  it('does not settle the run on a continuation’s result while its work is out', async () => {
    // The same rule for the path with no turn to hold. The CLI's own
    // continuation prints a `result` line, the owner settles the run on it, and
    // the badge went back to `completed` seconds after a delegate was launched.
    const between: AgentEvent[] = [];
    const { child } = openSession(undefined, undefined, (e) => between.push(e));

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await Promise.resolve();

    expect(between.some((e) => e.type === 'turn_complete')).toBe(false);

    await reportAndGoIdle(child, 'task-1');
    expect(between.at(-1)).toEqual(COMPLETE);
  });

  it('hands a held off-turn result over when a real turn opens', async () => {
    // Held, not dropped: that row carries the continuation's own usage and cost,
    // and it belongs to what happened BEFORE this turn — so it is handed over
    // first rather than filed among this turn's rows.
    const between: AgentEvent[] = [];
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, undefined, (e) =>
      between.push(e),
    );

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    expect(between).toEqual([{ type: 'turn_held', open: 1 }]);

    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    // The stretch ended without ending the turn that just opened.
    expect(between).toEqual([
      { type: 'turn_held', open: 1 },
      { type: 'turn_held', open: 0 },
      { ...COMPLETE, insideTurn: true },
    ]);

    // The turn that just opened is still held by the same outstanding unit.
    line(child, { done: true });
    await Promise.resolve();
    expect(events).toEqual([{ type: 'turn_held', open: 1 }]);
    await reportAndGoIdle(child, 'task-1');
    await handle?.done;
  });

  describe('a stretch the CLI runs by itself, held for its own sub-agents', () => {
    it('announces the hold, and its end when a unit it waits on reports', async () => {
      const between: AgentEvent[] = [];
      const { child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );

      line(child, { says: 'launching two' });
      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { work: 'task-2', phase: 'started', unit: 'agent' });
      line(child, { done: true, cost: 1 });
      line(child, { work: 'task-1', phase: 'settled' });
      line(child, { says: 'one is back' });
      line(child, { done: true, cost: 1 });

      expect(between.filter((e) => e.type === 'turn_held')).toEqual([
        { type: 'turn_held', open: 2 },
        { type: 'turn_held', open: 0 },
        { type: 'turn_held', open: 1 },
      ]);
    });

    it('dates the stretch from the report that woke it, after the CLI went idle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const between: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );
      const handle = session.startTurn({ onEvent: () => {} });
      line(child, {
        work: 'sh-1',
        phase: 'started',
        unit: 'other',
        call: 'c1',
      });
      line(child, { done: true });
      await handle?.done;
      line(child, { state: 'idle' });

      vi.setSystemTime(1_060_000);
      line(child, { work: 'sh-1', phase: 'settled' });
      vi.setSystemTime(1_068_000);
      line(child, { says: 'the build finished' });

      expect(between.find((e) => e.type === 'off_turn_started')).toEqual({
        type: 'off_turn_started',
        at: 1_060_000,
      });
    });

    it('dates the stretch from the result when the report came in while the CLI was still talking', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const between: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );
      const handle = session.startTurn({ onEvent: () => {} });
      line(child, {
        work: 'sh-1',
        phase: 'started',
        unit: 'other',
        call: 'c1',
      });
      vi.setSystemTime(1_005_000);
      line(child, { work: 'sh-1', phase: 'settled' });
      vi.setSystemTime(1_006_000);
      line(child, { done: true });
      await handle?.done;

      vi.setSystemTime(1_012_000);
      line(child, { says: 'the build finished' });

      expect(between.find((e) => e.type === 'off_turn_started')).toEqual({
        type: 'off_turn_started',
        at: 1_006_000,
      });
    });

    it('dates the stretch from its first output when nothing reported since the CLI went idle', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000_000);
      const between: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );
      const handle = session.startTurn({ onEvent: () => {} });
      line(child, {
        work: 'sh-1',
        phase: 'started',
        unit: 'other',
        call: 'c1',
      });
      line(child, { work: 'sh-1', phase: 'settled' });
      line(child, { done: true });
      await handle?.done;
      line(child, { state: 'idle' });

      vi.setSystemTime(2_000_000);
      line(child, { says: 'something else' });

      expect(between.find((e) => e.type === 'off_turn_started')).toEqual({
        type: 'off_turn_started',
        at: 2_000_000,
      });
    });

    it('folds every segment it continued past into the ending, cost and time alike', async () => {
      const between: AgentEvent[] = [];
      const { child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );

      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { done: true, cost: 1.25, ms: 60_000, finalText: 'first' });
      line(child, { says: 'back to work' });
      line(child, { work: 'task-2', phase: 'started', unit: 'agent' });
      line(child, { done: true, cost: 0.5, ms: 30_000, finalText: 'second' });
      line(child, { says: 'and again' });
      await reportAndGoIdle(child, 'task-1');
      line(child, { work: 'task-2', phase: 'settled' });
      line(child, { done: true, cost: 0.25, ms: 10_000, finalText: 'third' });

      const endings = between.filter((e) => e.type === 'turn_complete');
      expect(endings).toHaveLength(1);
      expect(endings[0]).toMatchObject({
        finalText: 'third',
        usage: { costUsd: 2, durationMs: 100_000 },
      });
    });

    it('keeps the held segments on the live cost until the ending records them', async () => {
      const between: AgentEvent[] = [];
      const { child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );
      const live = (): number | undefined =>
        between.findLast((e) => e.type === 'cost_progress')?.costUsd;

      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { live: 1.2 });
      line(child, { done: true, cost: 1.25 });
      expect(live()).toBe(1.25);

      line(child, { says: 'back to work' });
      line(child, { live: 0.4 });
      expect(live()).toBeCloseTo(1.65);

      await reportAndGoIdle(child, 'task-1');
      line(child, { done: true, cost: 0.5 });
      expect(live()).toBe(0);
      expect(
        between.filter((e) => e.type === 'turn_complete').at(-1),
      ).toMatchObject({ usage: { costUsd: 1.75 } });
    });

    it('files what it continued past under the turn of ours that opens while it works', async () => {
      const between: AgentEvent[] = [];
      const events: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );

      // A CLI that announces its state, as claude does: a report alone
      // releases nothing, so the agent talking again continues past the hold.
      line(child, { state: 'running' });
      line(child, { says: 'launching' });
      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { done: true, cost: 1.25, ms: 60_000 });
      line(child, { work: 'task-1', phase: 'settled' });
      line(child, { says: 'back to work' });
      const handle = session.startTurn({ onEvent: (e) => events.push(e) });
      line(child, { done: true, cost: 0.5, ms: 10_000, finalText: 'yours' });
      await handle?.done;

      expect(events.filter((e) => e.type === 'turn_complete')).toEqual([
        expect.objectContaining({
          finalText: 'yours',
          usage: expect.objectContaining({ costUsd: 1.75, durationMs: 70_000 }),
        }),
      ]);
      expect(between.some((e) => e.type === 'turn_complete')).toBe(false);
    });

    it('hands over what it continued past when the process ends before its ending', async () => {
      const between: AgentEvent[] = [];
      const { child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );

      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { done: true, cost: 1.25, ms: 60_000 });
      line(child, { says: 'back to work' });
      child.emit('close', 1, null);
      await Promise.resolve();

      expect(between.filter((e) => e.type === 'turn_complete')).toEqual([
        expect.objectContaining({
          usage: expect.objectContaining({ costUsd: 1.25, durationMs: 60_000 }),
        }),
      ]);
    });

    it('announces nothing while a turn of ours is open', async () => {
      const between: AgentEvent[] = [];
      const { session, child } = openSession(undefined, undefined, (e) =>
        between.push(e),
      );
      const handle = session.startTurn({ onEvent: () => {} });

      line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
      line(child, { continuationDone: true });

      expect(between.filter((e) => e.type === 'turn_held')).toEqual([]);
      await reportAndGoIdle(child, 'task-1');
      line(child, { done: true });
      await handle?.done;
    });
  });

  it('gives up on an off-turn hold whose work never reports', async () => {
    // The bound. Without one, a unit that never reports strands a real result
    // for the life of the session and the run reads `running` for good.
    vi.useFakeTimers();
    const between: AgentEvent[] = [];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { child } = openSession(undefined, logger, (e) => between.push(e));

    line(child, {
      work: 'task-1',
      phase: 'started',
      unit: 'agent',
      call: 'toolu_a',
    });
    line(child, { done: true });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(between.map((event) => event.type)).toEqual([
      'subagent_info',
      'turn_held',
      'subagent_info',
      'turn_held',
      'turn_complete',
    ]);
    expect(between.at(-3)).toMatchObject({
      id: 'toolu_a',
      backgroundOpen: false,
      backgroundOutcome: 'untracked',
    });
    line(child, { work: 'task-1', phase: 'settled', outcome: 'completed' });
    expect(between.at(-1)).toMatchObject({
      type: 'subagent_info',
      id: 'toolu_a',
      backgroundOutcome: 'completed',
    });
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'never reported',
    );
  });

  it('does not give up on an off-turn hold because the machine slept through its window', async () => {
    // Same question as the turn's own deadline, asked with no turn open — and
    // the same answer: a delegate asleep with the machine has not gone quiet.
    vi.useFakeTimers();
    const between: AgentEvent[] = [];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { child } = openSession(undefined, logger, (e) => between.push(e));

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await vi.advanceTimersByTimeAsync(45_000);
    await simulateSleep(4 * 60 * 60 * 1000);
    const held = { type: 'turn_held', open: 1 };
    expect(between).toEqual([held]);

    // A full window from the wake, not the 45s-shortened remainder.
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(between).toEqual([held]);
    await vi.advanceTimersByTimeAsync(1);
    expect(between).toEqual([held, { type: 'turn_held', open: 0 }, COMPLETE]);
  });

  it('does not let a unit the deadline gave up on hold the next turn too', async () => {
    // The cost of moving the set to session scope, paid here: a unit written off
    // by one turn's deadline must not silently hold every turn after it.
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const { session, child } = openSession(undefined, {
      warn: vi.fn(),
      debug: vi.fn(),
    });
    const first = session.startTurn({ onEvent: () => {} });

    line(child, { work: 'task-1', phase: 'started', unit: 'agent' });
    line(child, { done: true });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await first?.done;

    const second = session.startTurn({ onEvent: (e) => events.push(e) });
    line(child, { done: true });
    await second?.done;

    expect(events).toEqual([COMPLETE]);
  });

  it('does not defer on a lifetime whose turn ends with its process', async () => {
    // A one-turn CLI's delegates die with the process, so there is no "after" to
    // wait for — deferring would hold the turn open for work that is over.
    const events: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn();
    const handle = runHeadlessCli({
      command: 'claude',
      args: [],
      cwd: '/proj',
      keepStdinOpen: true,
      mapper: resultOnDone,
      onEvent: (event) => events.push(event),
      spawn,
    });

    child.stdout.emitData(
      `${JSON.stringify({ work: 'task-1', phase: 'started', unit: 'agent' })}\n`,
    );
    child.stdout.emitData(`${JSON.stringify({ done: true })}\n`);
    await Promise.resolve();

    // Emitted at once — and stdin closed with it, which is what asks a
    // stream-json CLI to finish at all.
    expect(events).toEqual([COMPLETE]);
    expect(child.stdin.ended).toBe(true);
    child.emit('close', 0, null);
    await handle.done;
  });
});

/**
 * The D1 state: the process outlives the turn geniro was tracking and keeps
 * working. Measured across the author's own `geniro.db` — 1589 of 4505 tool
 * results arrived with no turn in flight, carrying 165 of the 181
 * `Tool permission request failed: ... Stream closed` failures (10.4% against
 * 0.5% inside an open turn).
 */
describe('an event arriving between turns', () => {
  /** `{ask:<id>}` becomes a permission request; `{done:true}` ends the turn. */
  const askOrDone = (obj: unknown): AgentEvent[] => {
    const row = obj as { done?: boolean; ask?: string };
    if (row.done === true) {
      return [COMPLETE];
    }
    if (typeof row.ask === 'string') {
      return [
        { type: 'approval_request', id: row.ask, toolName: 'Edit', input: {} },
      ];
    }
    return [];
  };

  /** As `askOrDone`, but the request is the CLI's question tool. */
  const questionOrDone = (obj: unknown): AgentEvent[] => {
    const row = obj as { done?: boolean; ask?: string };
    if (row.done === true) {
      return [COMPLETE];
    }
    if (typeof row.ask === 'string') {
      return [
        {
          type: 'approval_request',
          id: row.ask,
          toolName: 'AskUserQuestion',
          input: {},
        },
      ];
    }
    return [];
  };

  // `questionToolName` is declared on every session here even though this
  // mapper emits a PERMISSION tool: that is what makes the refusal tests below
  // prove a discrimination rather than the absence of one. Without it they
  // would pass just as well if the question branch swallowed everything.
  function sessionAskingAfterSettle(
    logger: SessionLogger,
    mapper: (obj: unknown) => AgentEvent[] = askOrDone,
  ) {
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
    });
    return { session, child };
  }

  it('leaves an orphaned QUESTION unanswered instead of denying it in the user’s name', async () => {
    // The refusal beside this encodes `allow: false`, which reaches claude as
    // `{behavior:'deny', message:'Denied by the user in Geniro'}`. An
    // AskUserQuestion rides the SAME `approval_request` channel, so refusing it
    // answers the user's question for them, over their name, and they never see
    // it was asked. Parked it merely stalls — which is the honest state, and
    // what it did before the refusal existed.
    //
    // Keyed on the tool NAME the adapter declares, never on a payload flag: a
    // future interactive tool must not be able to slip past a human gate
    // through version drift.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    // Nothing at all on stdin — not a denial, not anything.
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'held for the next turn to adopt',
    );
    expect(session.alive).toBe(true);
  });

  it('refuses an orphaned permission when the owner supplies NO posture (the default)', async () => {
    // The fallback for a caller with nothing to say about posture — not what
    // the chat service does, which supplies one. It exists because dropping is
    // not neutral: the CLI is blocked on a verdict that, with no turn, nothing
    // will ever send, and a caller that cannot say "allow" at least unblocks
    // it. An owner WITH a posture takes the paths below instead, where a
    // refusal in the user's name is precisely what is avoided.
    // The observable is the verdict ON STDIN.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    // The process is still alive and now asks about work no turn owns.
    line(child, { ask: 'req-1' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT req-1 false\n',
    );
    expect(session.alive).toBe(true);
  });

  it('hands the NEXT turn the held question ITSELF, ahead of the notice, once', async () => {
    // A turn owns `onEvent`, so at the moment the question arrived there was
    // nothing to show it to and it lived only in the daemon log. Replaying the
    // request into the next turn is what gives it a destination at all: it
    // arrives as an ordinary `approval_request` and takes the same card path
    // every in-turn request takes, so the user finally sees what was asked and
    // their verdict reaches a live stdin.
    //
    // Order matters and is asserted, not incidental: the notice says the
    // request is shown above, so a card arriving after its own explanation
    // would make a liar of it.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    const events: AgentEvent[] = [];
    const second = session.startTurn({
      onEvent: (event) => events.push(event),
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: 'approval_request',
        id: 'q-1',
        toolName: 'AskUserQuestion',
      }),
      expect.objectContaining({
        type: 'notice',
        message: expect.stringContaining('between turns'),
        // INFORMATION, not an advisory: the request was kept and handed over
        // exactly as designed. Without this the row renders in the daemon's
        // failure chrome, which got it reported as an error.
        severity: 'info',
      }),
    ]);

    // Drained, not copied — once ANSWERED, no later turn repeats it. (An
    // adopted request the turn never answers is deliberately re-held instead;
    // that is its own case below.)
    second?.respondApproval('q-1', true, undefined);
    line(child, { done: true });
    await second?.done;
    const later: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => later.push(event) });
    expect(later).toEqual([]);
  });

  it('re-holds an adopted request the turn settles without answering', async () => {
    // Adoption empties the hold buffer, so a turn that ends before the user
    // answers the card would otherwise drop the request for good — the CLI
    // stays blocked, the notice is spent, and the chat goes quiet again. That
    // is the same wedge, one turn later.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    // Turn 2 is shown the card and then ends with no verdict.
    const second = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await second?.done;

    // Turn 3 is offered it again, rather than inheriting a silently blocked CLI.
    const third: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => third.push(event) });
    expect(third[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('re-holds a request raised INSIDE a turn that then ended without answering it', async () => {
    // Same wedge, reached through the commoner door. A request the CLI raises
    // while a turn IS open is delivered to that turn and never enters the hold
    // buffer, so `adopted` — which only ever records what a turn ADOPTED — has
    // nothing to give back when the turn settles unanswered.
    //
    // The turn here ends on its own `result` line with the card still open —
    // a sub-agent's question outliving the turn that launched it — and the
    // process is deliberately kept for the next turn: so that turn inherits a
    // CLI still parked on this question, with the request now unreachable from
    // anywhere. The buffer already knows it is outstanding — `approvalSeenAt`
    // holds it right up to the `clear()` on settle — so the information to
    // re-hold it exists and is thrown away.
    //
    // It used to reach that settle through the silence deadline instead, which
    // no longer runs while a card is open (see `TURN_SILENCE_DEADLINE_MS`):
    // waiting on a user is not a wedged CLI. The re-hold this pins is unchanged
    // — only the route into the unanswered settle had to move to one that still
    // exists.
    vi.useFakeTimers();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { ask: 'q-1' });
    // Nothing answers it, and the turn finishes anyway — the process is kept.
    line(child, { done: true });
    await first?.done;
    expect(session.alive).toBe(true);

    const second: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => second.push(event) });

    expect(second).toContainEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('does NOT re-hold a request the turn actually answered', async () => {
    // The other side of the same ledger: re-offering an answered request would
    // show the user a card for a decision they already made, and hand the CLI
    // a second verdict for one request.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });

    const second = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    second?.respondApproval('q-1', true, undefined);
    line(child, { done: true });
    await second?.done;

    const third: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => third.push(event) });
    expect(third).toEqual([]);
  });

  it('answers a between-turn permission with the run’s posture instead of refusing it', async () => {
    // The bug this pins: under the `auto` chip every tool call arriving a
    // moment after its turn settled was refused, and the refusal reached the
    // agent as `{behavior:'deny', message:'Denied by the user in Geniro'}` for
    // a card that was never rendered. The user watched their agent report it
    // had lost write access to a worktree they had granted it.
    //
    // The observable is the verdict ON STDIN, and it must be the ALLOW the
    // posture calls for — asserting merely that something was written would
    // pass just as well with the deny restored.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: askOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: ({ toolName }) =>
        toolName === 'AskUserQuestion' ? null : true,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'req-1' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT req-1 true\n',
    );
    // Answered outright, so there is nothing left for a later turn to adopt.
    const later: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => later.push(event) });
    expect(later).toEqual([]);
  });

  it('hands a non-approval between-turn event to the owner instead of dropping it', async () => {
    // A `tool_result` arriving after its turn settled used to be dropped, so
    // the call it answers stayed unpaired on the transcript forever. The owner
    // files it under the RUN — the events are turn-less, not run-less.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const seen: AgentEvent[] = [];
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; result?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return row.result === undefined
          ? []
          : [
              {
                type: 'tool_result',
                id: row.result,
                name: 'Bash',
                result: 'ok',
                isError: false,
              },
            ];
      },
      spawn,
      logger,
      onBetweenTurnEvent: (event) => seen.push(event),
    });

    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await turn?.done;

    line(child, { result: 't1' });

    expect(seen).toEqual([
      expect.objectContaining({ type: 'tool_result', id: 't1' }),
    ]);
    // Handed over, NOT buffered — replaying it into the next turn would file
    // one turn's output under another's.
    const next: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => next.push(event) });
    expect(next).toEqual([]);
  });

  it('bounds the hold buffer, and says which request it gave up on', async () => {
    // Nothing else bounds this: a CLI asking repeatedly on a chat nobody
    // returns to would hold one blocked tool call per request for the whole
    // 30-minute session life. Dropping the oldest is the concession; doing it
    // SILENTLY is not, because a dropped hold leaves a CLI blocked forever and
    // the log line is the only trace of why.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    // One past the cap of 20.
    for (let i = 0; i < 21; i += 1) {
      line(child, { ask: `q-${i}` });
    }

    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    const adopted = events.filter((event) => event.type === 'approval_request');
    expect(adopted).toHaveLength(20);
    // The OLDEST went, not the newest.
    expect(adopted.map((event) => (event as { id: string }).id)).not.toContain(
      'q-0',
    );
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'dropped held request',
    );
  });

  it('says the between-turns thing ONCE however many requests are held', async () => {
    // The notice explains a state, not each occurrence. Twenty verbatim copies
    // of one sentence would bury the twenty cards it is pointing at.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger, questionOrDone);

    const first = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await first?.done;

    line(child, { ask: 'q-1' });
    line(child, { ask: 'q-2' });
    line(child, { ask: 'q-3' });

    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events.filter((event) => event.type === 'notice')).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'approval_request'),
    ).toHaveLength(3);
  });

  it('will not let an owner posture auto-ANSWER the question tool', async () => {
    // A floor the owner cannot lower. Today's only policy discriminates
    // correctly, so this guards the next one: answering an AskUserQuestion
    // from a posture speaks for the user, in their name, about something they
    // never saw — the one outcome the whole between-turn seam refuses. The
    // previous code could not get this wrong because it refused every question
    // unconditionally; now that an owner decides, the floor has to be explicit.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      // A careless policy: says "approve" for everything, questions included.
      betweenTurnApproval: () => true,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    // Nothing answered on the user's behalf…
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    // …and it is held for them instead.
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-1' }),
    );
  });

  it('holds a between-turn permission the posture will not decide, rather than denying it', async () => {
    // The other half of the same policy: an `ask` chat has no standing answer,
    // so the request must reach a card — never a refusal in the user's name.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: askOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: () => null,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'req-2' });

    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'req-2' }),
    );
  });

  it('raises a between-turn question for the user NOW rather than holding it for a turn that may never come', async () => {
    // The incident: claude asked eight minutes after its turn had settled, the
    // request was held, and nothing said so — the transcript grew the tool row
    // and the badge went on reading "working" while the CLI stood blocked on a
    // person with no control to answer with. An owner that HAS a card surface
    // is offered the request instead, and the verdict it sends needs no turn:
    // the stdin and the encoder both outlive one.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const raised: string[] = [];
    let answer: ((allow: boolean, input?: unknown) => boolean) | null = null;
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      betweenTurnApproval: () => null,
      onHeldApproval: (event, respond) => {
        raised.push(event.id);
        answer = respond;
        return true;
      },
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;
    const writtenBefore = child.stdin.written;

    line(child, { ask: 'q-1' });

    expect(raised).toEqual(['q-1']);
    // Still nothing answered on the user's behalf — the card is up, not filled.
    expect(child.stdin.written.slice(writtenBefore.length)).toBe('');
    // And the process is not "unused": it is standing still on a person.
    expect(session.parked).toBe(true);

    // Their verdict reaches the live stdin with no turn in flight at all.
    expect(answer!(true)).toBe(true);
    expect(child.stdin.written.slice(writtenBefore.length)).toBe(
      'VERDICT q-1 true\n',
    );
    expect(session.parked).toBe(false);

    // …and it is NOT also replayed into the next turn, which would draw the
    // user a second card for a question they have already answered.
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(
      events.filter((event) => event.type === 'approval_request'),
    ).toHaveLength(0);
  });

  it('falls back to holding when the owner will not take the request', async () => {
    // A caller with nowhere to draw a card must lose nothing — only wait
    // longer. The claim is the owner's to decline, so declining puts the
    // request back on the path it was always on.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: questionOrDone,
      spawn,
      logger,
      questionToolName: 'AskUserQuestion',
      onHeldApproval: () => false,
    });

    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    await turn?.done;

    line(child, { ask: 'q-9' });

    expect(session.parked).toBe(true);
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (event) => events.push(event) });
    expect(events[0]).toEqual(
      expect.objectContaining({ type: 'approval_request', id: 'q-9' }),
    );
  });

  it('names the tool and the request id, so the line can be joined to a transcript row', () => {
    // The message this replaces said only `dropped a 'approval_request' event
    // arriving between turns` — no tool, no id, no way to correlate it with
    // anything. That gap is why the 239 real occurrences had to be found by SQL.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);
    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { ask: 'req-7' });

    const message = logger.warn.mock.calls.map(String).join('\n');
    expect(message).toContain('Edit');
    expect(message).toContain('req-7');
    expect(message).toContain('refused');
  });

  it('says so when it CANNOT refuse — the CLI is then genuinely parked', () => {
    // A turn whose CLI has no approval protocol leaves no encoder behind, so
    // there is nothing to answer with. That is worth a different sentence: the
    // silent version of this is a wedged agent with no trace of why.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = sessionAskingAfterSettle(logger);
    const turn = session.startTurn({ onEvent: () => {} }); // no encoder
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { ask: 'req-9' });

    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'could NOT be answered',
    );
    expect(child.stdin.written).toBe('');
  });

  it('still merely DROPS a non-approval event — one turn must not inherit another turn output', () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; text?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return row.text === undefined
          ? []
          : [{ type: 'text_delta', text: row.text }];
      },
      spawn,
      logger,
    });
    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    void turn?.done;
    logger.warn.mockClear();

    line(child, { text: 'stray' });

    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      "dropped a 'text_delta' event",
    );
    expect(child.stdin.written).toBe('');
  });
});

describe('the account the transport keeps of itself', () => {
  it('records a DELIVERED verdict, not only the failures', async () => {
    // Recording only failures is what made the D1 ratio unobtainable from logs:
    // "how often is a verdict actually delivered" has no answer unless the
    // delivered ones are written down too.
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: (obj) => {
        const row = obj as { done?: boolean; ask?: string };
        if (row.done === true) {
          return [COMPLETE];
        }
        return typeof row.ask === 'string'
          ? [
              {
                type: 'approval_request',
                id: row.ask,
                toolName: 'Bash',
                input: {},
              },
            ]
          : [];
      },
      spawn,
      logger,
    });
    const turn = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
    });
    line(child, { ask: 'req-2' });

    expect(turn?.respondApproval('req-2', true, {})).toBe(true);

    const debugged = logger.debug.mock.calls.map(String).join('\n');
    expect(debugged).toContain('req-2');
    expect(debugged).toContain('allowed');
    expect(debugged).toContain('written to stdin');
    // …and the round-trip is timed against when the request was RAISED.
    expect(debugged).toMatch(/\d+ms after it was raised/);
    line(child, { done: true });
    await turn?.done;
  });

  it('names WHY a turn settled, which no record carried before', async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);
    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await turn?.done;

    const debugged = logger.debug.mock.calls.map(String).join('\n');
    expect(debugged).toContain('turn opened');
    expect(debugged).toContain("turn settled (terminal event 'turn_complete')");
  });
});

describe('a turn whose prompt is held back until the CLI is ready', () => {
  /** A gate the spec opens and closes by hand. */
  function heldGate() {
    let release!: () => void;
    let reject!: (err: Error) => void;
    const opened = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    const seen: TurnIo[] = [];
    return {
      release,
      reject,
      seen,
      holdPrompt: (io: TurnIo) => {
        seen.push(io);
        return opened;
      },
    };
  }

  it('writes nothing until the gate resolves, then writes the prompt', async () => {
    // The defect this seam exists for, at the transport level: claude accepts a
    // prompt seconds before its MCP servers finish dialling, and answers it
    // with a tool surface those servers are missing from. Holding the prompt is
    // the fix, so the observable is that stdin stays EMPTY across the hold.
    const gate = heldGate();
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    expect(handle).not.toBeNull();
    // The turn is open — its stdout is already being parsed, which is what lets
    // the gate hold a dialogue of its own — and nothing has been sent.
    expect(child.stdin.written).toBe('');

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).toBe('PROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('refuses a follow-up until the prompt is written, so it cannot go in ahead of it', async () => {
    // MEASURED on claude 2.1.270: a message sent while the gate held the prompt
    // went in first, was answered first, and the turn settled on THAT answer
    // while the CLI went on to run the prompt as a turn nobody owned.
    const gate = heldGate();
    const { session, child } = openSession();
    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
      buildFollowUpPayload: (message) => `FOLLOW ${message.text}\n`,
    });

    expect(handle?.sendUserMessage({ text: 'early' })).toBe(false);
    expect(child.stdin.written).toBe('');

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(handle?.sendUserMessage({ text: 'after' })).toBe(true);
    expect(child.stdin.written).toBe('PROMPT\nFOLLOW after\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('gives the gate a channel of its own, on the same still-open stdin', async () => {
    // The gate's poll and the prompt travel one pipe, so `write` has to be the
    // turn's real one — a gate handed a dead channel could never ask anything.
    const gate = heldGate();
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    expect(gate.seen).toHaveLength(1);
    expect(gate.seen[0]?.write('POLL\n')).toBe(true);
    expect(child.stdin.written).toBe('POLL\n');

    gate.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.stdin.written).toBe('POLL\nPROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('ends a turn stopped DURING the hold at once — no interrupt, no prompt, no kill', async () => {
    // The CLI has been asked nothing yet, so there is no turn on its side to
    // interrupt. Real claude answers an interrupt with no turn running with a
    // bare `control_response` and no result at all, so an interrupt would end
    // nothing — the gate would then release the prompt INTO the stopped turn,
    // or the 5s fallback kill the whole group. So the CLI here says NOTHING
    // after the cancel, as the real one does: a `{failed: true}` line would
    // end the turn on the CLI's behalf and hide exactly that.
    vi.useFakeTimers();
    const gate = heldGate();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      buildInterruptPayload: () => 'INTERRUPT\n',
      onEvent: (e) => events.push(e),
    });
    handle?.cancel();

    // Settled by the Stop itself, without a line from the CLI.
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
    await handle?.done;

    gate.release();
    await Promise.resolve();
    await Promise.resolve();
    // Neither an interrupt the CLI cannot act on, nor the prompt it would.
    expect(child.stdin.written).toBe('');

    // And the process is left exactly as it was: no fallback kill…
    vi.advanceTimersByTime(10_000);
    expect(child.kills).toBe(0);
    // …not retired (nothing it prints belongs to the stopped turn)…
    expect(session.retired).toBe(false);
    // …and ready for the user's next message.
    expect(session.idle).toBe(true);
    expect(
      session.startTurn({ stdinPayload: 'NEXT\n', onEvent: () => {} }),
    ).not.toBeNull();
    expect(child.stdin.written).toBe('NEXT\n');
  });

  it('does not let the gate narrate into the owner once the Stop has ended its turn', async () => {
    // A gate still polling after the Stop may emit its "servers still starting"
    // notice; with no turn open that reached the owner as off-turn output,
    // which a settled run reads as the agent working again.
    const betweenTurns: AgentEvent[] = [];
    const events: AgentEvent[] = [];
    let gateIo: TurnIo | null = null;
    const { session } = openSession(undefined, undefined, (event) =>
      betweenTurns.push(event),
    );
    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: (io) => {
        gateIo = io;
        return new Promise<void>(() => {});
      },
      buildInterruptPayload: () => 'INTERRUPT\n',
      onEvent: (e) => events.push(e),
    });
    handle?.cancel();
    expect(events).toEqual([{ type: 'turn_cancelled' }]);

    gateIo!.emit({ type: 'notice', message: 'servers still starting' });

    expect(betweenTurns).toEqual([]);
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
  });

  it('withdraws a prompt the DRIVER is holding, instead of interrupting a CLI that was asked nothing', async () => {
    // The ACP twin: cursor's prompt waits behind its own config frames. A
    // `session/cancel` then cancels no prompt, the agent says nothing, and the
    // config reply released the prompt into the stopped turn.
    const events: AgentEvent[] = [];
    const withdrawPrompt = vi.fn(() => true);
    const { session, child } = openSession();
    const handle = session.startTurn({
      buildInterruptPayload: () => 'INTERRUPT\n',
      withdrawPrompt,
      onEvent: (e) => events.push(e),
    });

    handle?.cancel();

    expect(withdrawPrompt).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ type: 'turn_cancelled' }]);
    expect(child.stdin.written).toBe('');
    expect(session.retired).toBe(false);
  });

  it('still interrupts in protocol when the driver says the prompt is already out', () => {
    const { session, child } = openSession();
    const handle = session.startTurn({
      buildInterruptPayload: () => 'INTERRUPT\n',
      withdrawPrompt: () => false,
      onEvent: () => {},
    });

    handle?.cancel();

    expect(child.stdin.written).toBe('INTERRUPT\n');
  });

  it('drops the held prompt on a ONE-TURN process stopped before the gate released', async () => {
    // A one-turn process is stopped by killing it, and its turn settles only
    // once that process is gone — so a gate releasing in between found nothing
    // settled and wrote the prompt into a process it had just asked to die.
    const gate = heldGate();
    const { spawn, child } = fakeSpawn();
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'turn',
      mapper: resultOnDone,
      spawn,
    });
    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });

    handle?.cancel();
    expect(child.kills).toBe(1);
    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).toBe('');
    child.emit('close', null, 'SIGTERM');
    await handle?.done;
  });

  it('does NOT settle on a turn_complete that arrives while the prompt is still held', async () => {
    // TRACED in the reporter's own daemon log (2026-08-17 19:14): a fresh
    // claude process printed an empty `result` 2.9s in while the MCP-readiness
    // gate was still holding the prompt (9 servers, ready at 6.5s). geniro
    // settled the turn on it and marked the run completed; the gate then found
    // `turn.settled` and DROPPED the prompt. The user's message was persisted,
    // never sent and never answered — "✓ done · 0s · $0.0000" over silence.
    const gate = heldGate();
    const events: AgentEvent[] = [];
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: (e) => events.push(e),
    });
    // The CLI completes a turn nobody has asked it for.
    line(child, { done: true });
    await Promise.resolve();

    // Nothing settled: there is no answer to a prompt that has not gone out.
    expect(events).toEqual([]);
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      "ignoring a turn_complete that arrived before this turn's prompt was sent",
    );

    // …and the gate can still do its job, which is the whole point.
    gate.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(child.stdin.written).toBe('PROMPT\n');

    // The turn then ends on the CLI's answer to the prompt it was actually sent.
    line(child, { done: true });
    await handle?.done;
    expect(events).toEqual([COMPLETE]);
  });

  it('still settles on an ERROR raised while the prompt is held', async () => {
    // The other direction of the same rule. A CLI that cannot run the turn has
    // nothing to gain from waiting, and swallowing its failure would hang the
    // composer on a turn nothing will ever end — so only `turn_complete` is
    // ignored, never a failure or a cancel.
    const gate = heldGate();
    const events: AgentEvent[] = [];
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: (e) => events.push(e),
    });
    line(child, { failed: true });
    await handle?.done;

    expect(events).toEqual([{ type: 'error', message: 'result: is_error' }]);
  });

  it('sends the prompt anyway when the gate itself fails', async () => {
    // A gate is an optimisation over a turn that used to work. Losing the
    // user's message because a readiness poll threw would be a far worse
    // failure than the one it is fixing.
    const gate = heldGate();
    const logger = { warn: vi.fn(), debug: vi.fn() };
    const { session, child } = openSession(undefined, logger);

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onEvent: () => {},
    });
    gate.reject(new Error('poll exploded'));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(child.stdin.written).toBe('PROMPT\n');
    expect(logger.warn.mock.calls.map(String).join('\n')).toContain(
      'poll exploded',
    );
    line(child, { done: true });
    await handle?.done;
  });

  it('keeps the opening write synchronous for a turn with no gate', async () => {
    // Every existing caller — cursor's ACP handshake included — depends on the
    // payload being on stdin before `startTurn` returns.
    const { session, child } = openSession();

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      onEvent: () => {},
    });

    expect(child.stdin.written).toBe('PROMPT\n');
    line(child, { done: true });
    await handle?.done;
  });

  it('opens a client-initiated protocol AFTER the held prompt, not before', async () => {
    // `onStdinReady` is documented as running once the payload is out, and a
    // driver that both waits and opens a conversation must not have that
    // order inverted by the wait.
    const gate = heldGate();
    const { session, child } = openSession();
    const order: string[] = [];

    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      holdPrompt: gate.holdPrompt,
      onStdinReady: () => order.push(`ready:${child.stdin.written}`),
      onEvent: () => {},
    });
    expect(order).toEqual([]);

    gate.release();
    await Promise.resolve();
    await Promise.resolve();

    expect(order).toEqual(['ready:PROMPT\n']);
    line(child, { done: true });
    await handle?.done;
  });
});

describe('asking a live session something out of band', () => {
  /** A reader matching one control reply by its request id. */
  const readReply =
    (id: string) =>
    (obj: unknown): string | null => {
      const row = obj as { reply?: string; total?: string };
      return row.reply === id ? (row.total ?? null) : null;
    };

  it('writes the question and resolves with the reply that answers it', async () => {
    const { session, child } = openSession();

    const answer = session.ask({
      line: '{"ask":"ctx-1"}\n',
      read: readReply('ctx-1'),
      timeoutMs: 1000,
    });
    expect(child.stdin.written).toContain('{"ask":"ctx-1"}');
    line(child, { reply: 'ctx-1', total: '98598' });

    expect(await answer).toBe('98598');
  });

  it('does not disturb the turn the reply arrived alongside', async () => {
    // The whole safety claim of this seam: the readout can be opened mid-turn,
    // so the control dialogue and the event stream must not consume each
    // other's lines.
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    const answer = session.ask({
      line: '{"ask":"ctx-1"}\n',
      read: readReply('ctx-1'),
      timeoutMs: 1000,
    });
    line(child, { reply: 'ctx-1', total: '5' });
    line(child, { tool: 't1' });
    line(child, { done: true });

    expect(await answer).toBe('5');
    await handle?.done;
    expect(events.map((e) => e.type)).toEqual(['tool_result', 'turn_complete']);
  });

  it('gives each open question its OWN reply rather than the first to arrive', async () => {
    // Two readouts open at once is ordinary. Without per-question matching the
    // second would settle on the first's snapshot — a reading of a different
    // moment, silently.
    const { session, child } = openSession();

    const first = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 1000,
    });
    const second = session.ask({
      line: '{"ask":"b"}\n',
      read: readReply('b'),
      timeoutMs: 1000,
    });
    line(child, { reply: 'b', total: 'B' });
    line(child, { reply: 'a', total: 'A' });

    expect(await first).toBe('A');
    expect(await second).toBe('B');
  });

  it('gives up with null when the deadline passes unanswered', async () => {
    vi.useFakeTimers();
    const { session } = openSession();

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(500);

    expect(await answer).toBeNull();
  });

  it('answers null the moment the process dies, without waiting out the clock', async () => {
    // Nothing would ever call the reader again, so the deadline would be the
    // only way out — and it is deliberately generous.
    vi.useFakeTimers();
    const { session, child } = openSession();

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: readReply('a'),
      timeoutMs: 60_000,
    });
    child.emit('exit', 0, null);
    child.emit('close', 0, null);
    await vi.advanceTimersByTimeAsync(0);

    expect(await answer).toBeNull();
  });

  it('answers null without waiting when stdin will not take the question', async () => {
    const { session, child } = openSession();
    child.stdin.writable = false;

    expect(
      await session.ask({
        line: '{"ask":"a"}\n',
        read: readReply('a'),
        timeoutMs: 60_000,
      }),
    ).toBeNull();
  });

  it('survives a reader that throws, and keeps the turn stream alive', async () => {
    // A reader is adapter code parsing a version-volatile reply; a throw there
    // must not take down the stdout loop every turn depends on.
    const warn = vi.fn();
    const { session, child } = openSession(undefined, { warn });
    const events: AgentEvent[] = [];
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });

    const answer = session.ask({
      line: '{"ask":"a"}\n',
      read: () => {
        throw new Error('bad reply');
      },
      timeoutMs: 1000,
    });
    line(child, { reply: 'a' });

    expect(await answer).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bad reply'));
    line(child, { done: true });
    await handle?.done;
    expect(events.map((e) => e.type)).toEqual(['turn_complete']);
  });
});

describe('runCliSession — a CLI that reports a backgrounded command finished', () => {
  const emit = (child: FakeChild, obj: unknown): void => {
    child.stdout.emitData(`${JSON.stringify(obj)}\n`);
  };

  /**
   * The measured cursor shape: an `execute` tool call, then an answer saying it
   * completed — while the command runs on. See `sweepDetachedShells` for the
   * capture this is built from.
   */
  const shellMapper = (obj: unknown): AgentEvent[] => {
    const row = obj as {
      run?: string;
      id?: string;
      answered?: string;
      done?: boolean;
    };
    if (typeof row.run === 'string') {
      return [
        {
          type: 'tool_call',
          id: row.id ?? 'call-1',
          name: `\`${row.run}\``,
          input: { command: row.run },
          kind: 'execute',
        },
      ];
    }
    if (typeof row.answered === 'string') {
      return [
        {
          type: 'tool_result',
          id: row.answered,
          name: null,
          result: { exitCode: 0, stdout: '', stderr: '' },
          isError: false,
        },
      ];
    }
    return row.done === true ? [COMPLETE] : [];
  };

  function openShellSession(
    processes: () => Promise<{ pid: number; ppid: number; args: string }[]>,
  ) {
    const { spawn, child } = fakeSpawn(new FakeChild(999));
    const events: AgentEvent[] = [];
    const offTurn: AgentEvent[] = [];
    const session = runCliSession({
      command: 'cursor-agent',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: shellMapper,
      spawn,
      detectDetachedShells: true,
      listProcesses: processes,
      listProcessGroups: () => Promise.resolve(null),
      onBetweenTurnEvent: (event) => offTurn.push(event),
    });
    const handle = session.startTurn({ onEvent: (e) => events.push(e) });
    return { session, child, events, offTurn, handle };
  }

  it('opens a shell row for a command the OS says is still running', async () => {
    // The whole defect in one test: the CLI answered `exitCode: 0` and the
    // process is alive, so believing the CLI loses the command entirely — no
    // row, no count, no chip, and a chat that looks idle while it works.
    const { child, events, offTurn } = openShellSession(async () => [
      { pid: 500, ppid: 999, args: '/bin/zsh -c … -- sleep 300' },
      { pid: 501, ppid: 500, args: 'sleep 300' },
    ]);
    emit(child, { run: 'sleep 300', id: 'call-1' });
    emit(child, { answered: 'call-1' });
    emit(child, { done: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const opened = [...events, ...offTurn].filter(
      (e) => e.type === 'shell_open',
    );
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ workId: 'call-1', toolCallId: 'call-1' });
  });

  it('names a command the OS found still running, however many calls came before the sweep', async () => {
    // Until the sweep at the turn's end, the command is only an answered
    // execute call — the bounded map of lines must not drop it meanwhile.
    const { session, child } = openShellSession(async () => [
      { pid: 500, ppid: 999, args: 'pnpm dev' },
    ]);
    emit(child, { run: 'pnpm dev', id: 'call-0' });
    emit(child, { answered: 'call-0' });
    for (let i = 1; i <= 300; i += 1) {
      emit(child, { run: `ls ${i}`, id: `call-${i}` });
      emit(child, { answered: `call-${i}` });
    }
    emit(child, { done: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(session.runningCommands).toEqual(['pnpm dev']);
  });

  it('says nothing about a command that really did finish', async () => {
    // The other half. Without it, "open a row for every execute call" passes
    // the test above just as well — and would list every `ls` a turn ran as a
    // background command that never ends.
    const { child, events, offTurn } = openShellSession(async () => [
      { pid: 500, ppid: 999, args: 'something unrelated' },
    ]);
    emit(child, { run: 'ls -la', id: 'call-1' });
    emit(child, { answered: 'call-1' });
    emit(child, { done: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect([...events, ...offTurn].some((e) => e.type === 'shell_open')).toBe(
      false,
    );
  });

  it('leaves an UNANSWERED call alone', async () => {
    // A call the CLI has not answered is an ordinary foreground command, and
    // the transcript already draws it as running on the strength of that
    // missing answer. Opening a shell row for it too would list it twice.
    const { child, events, offTurn } = openShellSession(async () => [
      { pid: 501, ppid: 999, args: 'sleep 300' },
    ]);
    emit(child, { run: 'sleep 300', id: 'call-1' });
    emit(child, { done: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect([...events, ...offTurn].some((e) => e.type === 'shell_open')).toBe(
      false,
    );
  });

  it('asks nothing at all when the CLI reports its own detachments', async () => {
    // The flag is the adapter's fact, and a CLI that brackets its background
    // work is already served by that bracket — asking the OS as well would open
    // every command a second time. Pinned on the LISTING never being called,
    // which is the only observable that distinguishes "off" from "found
    // nothing".
    const listing = vi.fn(async () => []);
    const { spawn, child } = fakeSpawn(new FakeChild(999));
    const events: AgentEvent[] = [];
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: shellMapper,
      spawn,
      listProcesses: listing,
    });
    session.startTurn({ onEvent: (e) => events.push(e) });
    emit(child, { run: 'sleep 300', id: 'call-1' });
    emit(child, { answered: 'call-1' });
    emit(child, { done: true });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(listing).not.toHaveBeenCalled();
  });
});

describe('runCliSession — a CLI that says nothing while it waits on a command it detached', () => {
  const QUIET_MS = 1000;
  const HEREDOC = "python3 << 'PY'\nimport time\nPY";
  const WRAPPER = { pid: 500, ppid: 999, args: '/bin/zsh -c __cursor_command' };

  const mapper = (obj: unknown): AgentEvent[] => {
    const row = obj as {
      run?: string;
      id?: string;
      answered?: string;
      says?: string;
      done?: boolean;
    };
    if (typeof row.run === 'string') {
      return [
        {
          type: 'tool_call',
          id: row.id ?? 'call-1',
          name: 'shell',
          input: { command: row.run },
          kind: 'execute',
        },
      ];
    }
    if (typeof row.answered === 'string') {
      return [
        {
          type: 'tool_result',
          id: row.answered,
          name: null,
          result: { exitCode: 0, stdout: '', stderr: '' },
          isError: false,
        },
      ];
    }
    if (typeof row.says === 'string') {
      return [{ type: 'text_delta', text: row.says }];
    }
    return row.done === true ? [COMPLETE] : [];
  };

  /** A turn past a backgrounded heredoc: answered, and still running. */
  function waitingTurn(
    options: {
      silent?: boolean;
      running?: boolean;
      onQuiet?: () => AgentEvent[] | null;
      /** Holds each process-table read until the test lets it answer. */
      heldReads?: boolean;
    } = {},
  ) {
    vi.useFakeTimers();
    const machine = {
      running: options.running ?? true,
      release: (): void => {},
    };
    const listProcesses = vi.fn(async () => {
      if (options.heldReads) {
        await new Promise<void>((resolve) => {
          machine.release = resolve;
        });
      }
      return machine.running ? [WRAPPER] : [];
    });
    const { spawn, child } = fakeSpawn(new FakeChild(999));
    const events: AgentEvent[] = [];
    const session = runCliSession({
      command: 'cursor-agent',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper,
      spawn,
      detectDetachedShells: true,
      silentCommandWait: options.silent ?? true,
      commandWaitQuietMs: QUIET_MS,
      listProcesses,
      listProcessGroups: () => Promise.resolve(null),
      readCommandRecords: async () => [
        { pid: 500, command: HEREDOC, running: machine.running },
      ],
      onBetweenTurnEvent: (e) => events.push(e),
    });
    const handle = session.startTurn({
      onEvent: (e) => events.push(e),
      onQuiet: options.onQuiet ?? (() => []),
      sendFollowUp: () => true,
    });
    line(child, { run: HEREDOC });
    line(child, { answered: 'call-1' });
    const holds = () =>
      events.flatMap((e) => (e.type === 'turn_held' ? [e] : []));
    return { session, child, events, handle, holds, machine, listProcesses };
  }

  it('announces the wait once the turn has gone quiet with the command alive', async () => {
    const turn = waitingTurn();
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1);
    expect(turn.holds()).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(turn.holds()).toEqual([
      { type: 'turn_held', open: 1, unit: 'command' },
    ]);
    expect(turn.events.some((e) => e.type === 'shell_open')).toBe(true);
  });

  it('writes what the agent said ahead of the announcement', async () => {
    const turn = waitingTurn({
      onQuiet: () => [{ type: 'reasoning', text: 'I will wait.' }],
    });
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    const kinds = turn.events.map((e) => e.type);
    expect(kinds.indexOf('reasoning')).toBeGreaterThan(-1);
    expect(kinds.indexOf('reasoning')).toBeLessThan(kinds.indexOf('turn_held'));
  });

  it('writes the words and announces no wait with no command alive', async () => {
    const turn = waitingTurn({
      running: false,
      onQuiet: () => [{ type: 'reasoning', text: 'Still thinking.' }],
    });
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(turn.events.some((e) => e.type === 'reasoning')).toBe(true);
    expect(turn.holds()).toEqual([]);
  });

  it('asks the table nothing while the driver says the quiet is explained', async () => {
    const turn = waitingTurn({ onQuiet: () => null });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);

    expect(turn.listProcesses).not.toHaveBeenCalled();
    expect(turn.holds()).toEqual([]);
  });

  it('does nothing for a CLI whose waits are not silent', async () => {
    const turn = waitingTurn({ silent: false });
    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);

    expect(turn.holds()).toEqual([]);
  });

  it('ends the wait when the agent speaks again', async () => {
    const turn = waitingTurn();
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    line(turn.child, { says: 'It finished.' });

    expect(turn.holds().at(-1)).toEqual({ type: 'turn_held', open: 0 });
    const kinds = turn.events.map((e) => e.type);
    expect(kinds.lastIndexOf('turn_held')).toBeLessThan(
      kinds.lastIndexOf('text_delta'),
    );
  });

  it('ends the wait when a message reaches the agent', async () => {
    const turn = waitingTurn();
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(turn.handle?.sendUserMessage({ text: '?' })).toBe(true);

    expect(turn.holds().at(-1)).toEqual({ type: 'turn_held', open: 0 });
  });

  it('ends the wait when the command itself ends', async () => {
    const turn = waitingTurn();
    await vi.advanceTimersByTimeAsync(QUIET_MS);

    turn.machine.running = false;
    await vi.advanceTimersByTimeAsync(5000);

    expect(turn.holds().at(-1)).toEqual({ type: 'turn_held', open: 0 });
    expect(turn.events.some((e) => e.type === 'shell_info')).toBe(true);
  });

  it('lets a wait outlast the silence deadline, past the CLI’s own limit', async () => {
    const turn = waitingTurn();
    const failures = () => turn.events.filter((e) => e.type === 'error');
    await vi.advanceTimersByTimeAsync(149 * 60 * 1000);
    expect(failures()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(failures()).toEqual([
      {
        type: 'error',
        message:
          'cursor-agent produced nothing for 150 minutes — giving up on the turn',
      },
    ]);
  });

  it('gives the agent a full window to answer once its wait ends', async () => {
    const turn = waitingTurn();
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    turn.machine.running = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(turn.holds().at(-1)).toEqual({ type: 'turn_held', open: 0 });

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(turn.events.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('stretches no silence for a command an earlier turn started', async () => {
    const turn = waitingTurn();
    line(turn.child, { done: true });
    await turn.handle?.done;
    const events: AgentEvent[] = [];
    turn.session.startTurn({
      onEvent: (e) => events.push(e),
      onQuiet: () => [],
    });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(events).toContainEqual({
      type: 'turn_held',
      open: 1,
      unit: 'command',
    });

    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(events.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        message:
          'cursor-agent produced nothing for 30 minutes — giving up on the turn',
      },
    ]);
  });

  it('counts down as its commands end', async () => {
    vi.useFakeTimers();
    const live = new Set([500, 600]);
    const { spawn, child } = fakeSpawn(new FakeChild(999));
    const events: AgentEvent[] = [];
    const session = runCliSession({
      command: 'cursor-agent',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper,
      spawn,
      detectDetachedShells: true,
      silentCommandWait: true,
      commandWaitQuietMs: QUIET_MS,
      listProcesses: async () =>
        [...live].map((pid) => ({ pid, ppid: 999, args: 'wrapper' })),
      listProcessGroups: () => Promise.resolve(null),
      readCommandRecords: async () => [
        { pid: 500, command: 'first', running: live.has(500) },
        { pid: 600, command: 'second', running: live.has(600) },
      ],
    });
    session.startTurn({ onEvent: (e) => events.push(e), onQuiet: () => [] });
    line(child, { run: 'first', id: 'a' });
    line(child, { answered: 'a' });
    line(child, { run: 'second', id: 'b' });
    line(child, { answered: 'b' });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    live.delete(500);
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.type === 'turn_held')).toEqual([
      { type: 'turn_held', open: 2, unit: 'command' },
      { type: 'turn_held', open: 1, unit: 'command' },
    ]);
  });

  describe('while the table is being read', () => {
    async function midReading() {
      const turn = waitingTurn({ heldReads: true });
      await vi.advanceTimersByTimeAsync(QUIET_MS);
      expect(turn.listProcesses).toHaveBeenCalledTimes(1);
      return turn;
    }

    it('announces no wait when the agent spoke meanwhile', async () => {
      const turn = await midReading();
      line(turn.child, { says: 'Still going.' });
      turn.machine.release();
      await vi.advanceTimersByTimeAsync(0);

      expect(turn.events.some((e) => e.type === 'shell_open')).toBe(true);
      expect(turn.holds()).toEqual([]);
    });

    it('announces no wait when a message reached the agent meanwhile', async () => {
      const turn = await midReading();
      expect(turn.handle?.sendUserMessage({ text: '?' })).toBe(true);
      turn.machine.release();
      await vi.advanceTimersByTimeAsync(0);

      expect(turn.holds()).toEqual([]);
    });

    it('announces no wait once the user has pressed Stop', async () => {
      const turn = await midReading();
      turn.handle?.cancel();
      turn.machine.release();
      await vi.advanceTimersByTimeAsync(0);

      expect(turn.holds()).toEqual([]);
    });

    it('reads again for an ask that came meanwhile, opening each command once', async () => {
      const turn = await midReading();
      line(turn.child, { done: true });
      turn.machine.release();
      await vi.advanceTimersByTimeAsync(0);
      expect(turn.listProcesses).toHaveBeenCalledTimes(2);
      turn.machine.release();
      await vi.advanceTimersByTimeAsync(0);

      expect(turn.events.filter((e) => e.type === 'shell_open')).toHaveLength(
        1,
      );
    });
  });

  it('still gives up after one window with nothing to wait on', async () => {
    const turn = waitingTurn({ running: false });
    await vi.advanceTimersByTimeAsync(31 * 60 * 1000);

    expect(turn.events.filter((e) => e.type === 'error')).toEqual([
      {
        type: 'error',
        message:
          'cursor-agent produced nothing for 30 minutes — giving up on the turn',
      },
    ]);
  });

  /** A session whose table holds the wrapper and whose CLI records these. */
  function recordedSession(records: readonly CommandRecord[]) {
    vi.useFakeTimers();
    const { spawn, child } = fakeSpawn(new FakeChild(999));
    const events: AgentEvent[] = [];
    const session = runCliSession({
      command: 'cursor-agent',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper,
      spawn,
      detectDetachedShells: true,
      silentCommandWait: true,
      commandWaitQuietMs: QUIET_MS,
      listProcesses: async () => [WRAPPER],
      listProcessGroups: () => Promise.resolve(null),
      readCommandRecords: async () => records,
    });
    session.startTurn({ onEvent: (e) => events.push(e), onQuiet: () => [] });
    return { child, events };
  }

  it('leaves a finished call alone while a call written alike runs unanswered', async () => {
    const { child, events } = recordedSession([
      { pid: 400, command: HEREDOC, running: false },
      { pid: 500, command: HEREDOC, running: true },
    ]);
    line(child, { run: HEREDOC, id: 'done-earlier' });
    line(child, { answered: 'done-earlier' });
    line(child, { run: HEREDOC, id: 'still-open' });

    await vi.advanceTimersByTimeAsync(QUIET_MS);

    expect(events.some((e) => e.type === 'shell_open')).toBe(false);
  });

  it('keeps a running command’s row while a call written alike has yet to start', async () => {
    const { child, events } = recordedSession([
      { pid: 500, command: HEREDOC, running: true },
    ]);
    line(child, { run: HEREDOC, id: 'running' });
    line(child, { answered: 'running' });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(events.filter((e) => e.type === 'shell_open')).toHaveLength(1);

    line(child, { run: HEREDOC, id: 'not-started' });
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.some((e) => e.type === 'shell_info')).toBe(false);
  });

  it('closes a detached command with how the CLI recorded it ending', async () => {
    const records: CommandRecord[] = [
      { pid: 500, command: HEREDOC, running: true },
    ];
    const { child, events } = recordedSession(records);
    line(child, { run: HEREDOC, id: 'probe' });
    line(child, { answered: 'probe' });
    await vi.advanceTimersByTimeAsync(QUIET_MS);
    expect(events.filter((e) => e.type === 'shell_open')).toHaveLength(1);

    records.splice(0, 1, {
      pid: 500,
      command: HEREDOC,
      running: false,
      outputPath: '/cursor/terminals/451147.txt',
      exitCode: 0,
      endedAt: new Date(Date.now()).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(events.filter((e) => e.type === 'shell_info')).toEqual([
      {
        type: 'shell_info',
        toolCallId: 'probe',
        workId: 'probe',
        ending: {
          command: HEREDOC,
          exitCode: 0,
          outputPath: '/cursor/terminals/451147.txt',
          endedAt: expect.any(String),
        },
      },
    ]);
  });

  it('announces no wait once the turn has ended', async () => {
    const turn = waitingTurn();
    line(turn.child, { done: true });
    await turn.handle?.done;

    await vi.advanceTimersByTimeAsync(QUIET_MS * 3);

    expect(turn.holds()).toEqual([]);
  });
});

describe('a follow-up written into a turn the CLI has not taken yet', () => {
  /**
   * A turn whose CLI acknowledges what it takes off stdin, with a follow-up
   * already written into it — the state the reported bug starts from: four
   * queued messages sent in the seconds before the Manager's own `result`.
   */
  function turnWithFollowUp(options: { consumptionReported?: boolean } = {}) {
    const events: AgentEvent[] = [];
    const { session, child } = openSession();
    const handle = session.startTurn({
      stdinPayload: 'PROMPT\n',
      onEvent: (e) => events.push(e),
      buildFollowUpPayload: (message) =>
        `${JSON.stringify({ follow: message.text })}\n`,
      followUpConsumptionReported: options.consumptionReported ?? true,
    });
    let settled = false;
    void handle?.done.then(() => {
      settled = true;
    });
    expect(handle?.sendUserMessage({ text: 'send it one by one' })).toBe(true);
    return {
      events,
      child,
      handle,
      isSettled: () => settled,
      completions: () => events.filter((e) => e.type === 'turn_complete'),
    };
  }

  it('does not settle on a result that arrives before the message is taken', async () => {
    // THE reported defect: the CLI printed a `result` for what it had been
    // doing, then opened a further stretch to answer the message — and the
    // turn settled on the first line, so the run read `completed` for the
    // whole of that answer.
    const turn = turnWithFollowUp();

    line(turn.child, { done: true, finalText: 'answer to the prompt' });
    await Promise.resolve();

    expect(turn.isSettled()).toBe(false);
    expect(turn.completions()).toEqual([]);

    line(turn.child, { taken: 'send it one by one' });
    line(turn.child, { says: 'Switching to one at a time.' });
    line(turn.child, { done: true, finalText: 'answer to the follow-up' });
    await turn.handle?.done;

    expect(turn.completions()).toEqual([
      { ...COMPLETE, finalText: 'answer to the follow-up' },
    ]);
  });

  it('settles at once when the message was taken before the result', async () => {
    // The ordinary case must cost nothing: taken at a tool boundary, the
    // message is answered inside the same result.
    const turn = turnWithFollowUp();

    line(turn.child, { taken: 'send it one by one' });
    line(turn.child, { done: true });
    await turn.handle?.done;

    expect(turn.completions()).toEqual([COMPLETE]);
  });

  it('does not count the echo of the turn’s own prompt as the follow-up', async () => {
    const turn = turnWithFollowUp();

    line(turn.child, { taken: 'PROMPT' });
    line(turn.child, { done: true });
    await Promise.resolve();

    expect(turn.isSettled()).toBe(false);
  });

  it('folds the held result’s bill into the result the turn settles on', async () => {
    const turn = turnWithFollowUp();

    line(turn.child, { done: true, cost: 1.25 });
    line(turn.child, { taken: 'send it one by one' });
    line(turn.child, { done: true, cost: 0.5 });
    await turn.handle?.done;

    const [complete] = turn.completions();
    expect(complete?.type === 'turn_complete' && complete.usage?.costUsd).toBe(
      1.75,
    );
  });

  it('settles on the held result once the CLI says it is idle', async () => {
    // What bounds an acknowledgement that never matches — without it the turn
    // would wait out the half-hour silence deadline. `idle` is the CLI saying
    // nothing more is coming.
    const turn = turnWithFollowUp();

    line(turn.child, { done: true, finalText: 'answer to the prompt' });
    await Promise.resolve();
    expect(turn.isSettled()).toBe(false);

    line(turn.child, { state: 'idle' });
    await turn.handle?.done;

    expect(turn.completions()).toEqual([
      { ...COMPLETE, finalText: 'answer to the prompt' },
    ]);
  });

  it('settles on the held result for a CLI that never says idle, at the silence deadline', async () => {
    // Not `produced nothing` — the turn DID produce that result.
    vi.useFakeTimers();
    const turn = turnWithFollowUp();
    try {
      line(turn.child, { done: true, finalText: 'answer to the prompt' });
      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
    } finally {
      vi.useRealTimers();
    }
    await turn.handle?.done;

    expect(turn.completions()).toEqual([
      { ...COMPLETE, finalText: 'answer to the prompt' },
    ]);
  });

  it('does not count the held result as answering the prompt', async () => {
    // `promptAnswered` decides whether a CONTINUATION's result may end the
    // turn. The held result answered what came before the follow-up, so a
    // continuation arriving now must still be routed around the turn.
    const turn = turnWithFollowUp();

    line(turn.child, { done: true });
    line(turn.child, {
      continuationDone: true,
      finalText: 'a delegate report',
    });
    await Promise.resolve();

    expect(turn.isSettled()).toBe(false);
    expect(turn.completions()).toEqual([]);
  });

  it('settles on the first result for a CLI that reports nothing it takes', async () => {
    // Without an acknowledgement nothing could ever cross the message off, so
    // such a CLI keeps the old behaviour rather than waiting on a grace clock.
    const turn = turnWithFollowUp({ consumptionReported: false });

    line(turn.child, { done: true });
    await turn.handle?.done;

    expect(turn.completions()).toEqual([COMPLETE]);
  });
});

describe('a request the CLI stops waiting on, or that outlives the turn it was raised in', () => {
  /** `{done}` ends a turn, `{ask}` raises a card, `{withdrawn}` retires one. */
  const plumbing = (obj: unknown): AgentEvent[] => {
    const row = obj as { done?: boolean; ask?: string; withdrawn?: string };
    if (row.done === true) {
      return [COMPLETE];
    }
    if (typeof row.ask === 'string') {
      return [
        {
          type: 'approval_request',
          id: row.ask,
          toolName: 'Bash',
          input: { command: 'ls' },
        },
      ];
    }
    if (typeof row.withdrawn === 'string') {
      return [{ type: 'approval_withdrawn', id: row.withdrawn }];
    }
    return [];
  };

  /** A session whose owner puts a between-turn request on screen as a card. */
  function ownedSession(betweenTurns: AgentEvent[] = []) {
    const { spawn, child } = fakeSpawn();
    const cards: { id: string; respond: (allow: boolean) => boolean }[] = [];
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: plumbing,
      spawn,
      betweenTurnApproval: () => null,
      onBetweenTurnEvent: (event) => betweenTurns.push(event),
      onHeldApproval: (event, respond) => {
        cards.push({ id: event.id, respond });
        return true;
      },
    });
    return { session, child, cards };
  }

  const verdicts = (id: string, allow: boolean): string =>
    `VERDICT ${id} ${allow}\n`;

  async function settledFirstTurn(
    session: ReturnType<typeof runCliSession>,
    child: FakeChild,
  ): Promise<void> {
    const first = session.startTurn({
      onEvent: () => {},
      buildApprovalResponse: verdicts,
    });
    line(child, { done: true });
    await first?.done;
  }

  describe('a between-turn card the next turn inherits', () => {
    it('keeps the next turn from timing out while the CLI is still blocked on it', async () => {
      // The CLI is blocked on the card, so the turn opened after it produces
      // nothing until it is answered. The silence deadline exists for silence
      // nobody can account for — this one is accounted for.
      vi.useFakeTimers();
      const { session, child } = ownedSession();
      await settledFirstTurn(session, child);
      line(child, { ask: 'card-1' });

      const events: AgentEvent[] = [];
      session.startTurn({
        onEvent: (e) => events.push(e),
        buildApprovalResponse: verdicts,
      });
      vi.advanceTimersByTime(31 * 60 * 1000);

      expect(events.filter((e) => e.type === 'error')).toEqual([]);
    });

    it('is re-offered to the turn after, and answering it there frees the session', async () => {
      // The next turn's owner writes `unanswerable` over every card still
      // pending when that turn ends — the between-turn card included — without
      // calling its `respond`. Left in the owned set, the request stood for the
      // life of the process: `parked` read true forever and nothing ever put
      // the question back in front of the user.
      const { session, child, cards } = ownedSession();
      await settledFirstTurn(session, child);
      line(child, { ask: 'card-1' });
      expect(cards.map((card) => card.id)).toEqual(['card-1']);

      // Turn 2 ends with the card unanswered (its owner sweeps it).
      const second = session.startTurn({
        onEvent: () => {},
        buildApprovalResponse: verdicts,
      });
      line(child, { done: true });
      await second?.done;

      // Still blocked on it — truthfully so — and now re-offered as a card.
      expect(session.parked).toBe(true);
      const third: AgentEvent[] = [];
      const handle = session.startTurn({
        onEvent: (e) => third.push(e),
        buildApprovalResponse: verdicts,
      });
      expect(third).toContainEqual(
        expect.objectContaining({ type: 'approval_request', id: 'card-1' }),
      );

      expect(handle?.respondApproval('card-1', true)).toBe(true);
      expect(child.stdin.written).toContain('VERDICT card-1 true');
      line(child, { done: true });
      await handle?.done;
      expect(session.parked).toBe(false);
    });

    it('is dropped from the turn when the user answers its ORIGINAL card mid-turn', async () => {
      // The card's own `respond` still reaches the CLI after the move, and must
      // take the request out of the turn it moved into — or that turn would be
      // re-offering, at its settle, a question the user has already answered.
      vi.useFakeTimers();
      const { session, child, cards } = ownedSession();
      await settledFirstTurn(session, child);
      line(child, { ask: 'card-1' });

      const events: AgentEvent[] = [];
      const second = session.startTurn({
        onEvent: (e) => events.push(e),
        buildApprovalResponse: verdicts,
      });
      expect(cards[0]?.respond(true)).toBe(true);
      expect(child.stdin.written).toContain('VERDICT card-1 true');

      // Unblocked, so the deadline runs again from the answer.
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
      await second?.done;

      expect(session.parked).toBe(false);
      const next: AgentEvent[] = [];
      session.startTurn({
        onEvent: (e) => next.push(e),
        buildApprovalResponse: verdicts,
      });
      expect(next.filter((e) => e.type === 'approval_request')).toEqual([]);
    });
  });

  describe('a request the CLI WITHDRAWS', () => {
    it('stops suspending the turn’s silence deadline, and tells the owner to retire the card', () => {
      vi.useFakeTimers();
      const { session, child } = ownedSession();
      const events: AgentEvent[] = [];
      session.startTurn({
        onEvent: (e) => events.push(e),
        buildApprovalResponse: verdicts,
      });
      line(child, { ask: 'req-1' });
      line(child, { withdrawn: 'req-1' });

      expect(events).toContainEqual({
        type: 'approval_withdrawn',
        id: 'req-1',
      });
      // Nobody is blocked on it any more: an unexplained silence is again one.
      vi.advanceTimersByTime(31 * 60 * 1000);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error' }));
    });

    it('is never re-offered to the next turn', async () => {
      // Kept as outstanding, the settle re-held it and every later turn drew a
      // card whose answer could reach nothing.
      const { session, child } = ownedSession();
      const turn = session.startTurn({
        onEvent: () => {},
        buildApprovalResponse: verdicts,
      });
      line(child, { ask: 'req-1' });
      line(child, { withdrawn: 'req-1' });
      line(child, { done: true });
      await turn?.done;

      expect(session.parked).toBe(false);
      const next: AgentEvent[] = [];
      session.startTurn({
        onEvent: (e) => next.push(e),
        buildApprovalResponse: verdicts,
      });
      expect(next.filter((e) => e.type === 'approval_request')).toEqual([]);
    });

    it('retires an off-turn card, freeing the session', async () => {
      const betweenTurns: AgentEvent[] = [];
      const { session, child } = ownedSession(betweenTurns);
      await settledFirstTurn(session, child);
      line(child, { ask: 'card-1' });
      expect(session.parked).toBe(true);

      line(child, { withdrawn: 'card-1' });

      expect(session.parked).toBe(false);
      expect(betweenTurns).toContainEqual({
        type: 'approval_withdrawn',
        id: 'card-1',
      });
    });

    it('says nothing about an id nothing was holding open', () => {
      // An answered request, or a control request that was never an approval —
      // the owner must not be asked to retire a card it already closed.
      const betweenTurns: AgentEvent[] = [];
      const { session, child } = ownedSession(betweenTurns);
      const events: AgentEvent[] = [];
      session.startTurn({
        onEvent: (e) => events.push(e),
        buildApprovalResponse: verdicts,
      });

      line(child, { withdrawn: 'never-raised' });

      expect(events).toEqual([]);
      expect(betweenTurns).toEqual([]);
    });
  });
});

describe('a stdin that breaks under a turn in flight', () => {
  it('emits what the driver still held ahead of the error', () => {
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    session.startTurn({
      onEvent: (e) => events.push(e),
      onProcessEnded: () => [
        { type: 'follow_up_dropped', deliveryIds: ['delivery-1'] },
      ],
    });

    child.stdin.breakPipe();

    expect(events.map((event) => event.type)).toEqual([
      'follow_up_dropped',
      'error',
    ]);
  });

  it('signals the process group and escalates, instead of forgetting a live process', () => {
    // `endProcess` marks the session gone and resolves `closed`, so its owner
    // forgets it. Without a signal, a CLI that had only stopped reading its
    // stdin went on running untracked, holding every MCP server it had dialled.
    vi.useFakeTimers();
    const { session, child } = openSession();
    const events: AgentEvent[] = [];
    session.startTurn({ onEvent: (e) => events.push(e) });

    child.stdin.breakPipe();

    expect(events).toEqual([
      { type: 'error', message: 'claude stdin error: write EPIPE' },
    ]);
    expect(child.killSignal).toBe('SIGTERM');
    // The child never exits here, so the SIGKILL the grace promises is owed.
    vi.advanceTimersByTime(5000);
    expect(child.killSignal).toBe('SIGKILL');
  });

  it('escalates BETWEEN turns too, where the session used to send a lone SIGTERM', async () => {
    vi.useFakeTimers();
    const { session, child } = openSession();
    const turn = session.startTurn({ onEvent: () => {} });
    line(child, { done: true });
    await turn?.done;

    child.stdin.breakPipe();
    expect(child.killSignal).toBe('SIGTERM');
    vi.advanceTimersByTime(5000);
    expect(child.killSignal).toBe('SIGKILL');
  });

  it('owes no SIGKILL once the child is seen to exit', () => {
    vi.useFakeTimers();
    const { session, child } = openSession();
    session.startTurn({ onEvent: () => {} });

    child.stdin.breakPipe();
    child.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(5000);

    expect(child.kills).toBe(1);
  });
});

describe('where a session’s detached commands run', () => {
  const row = (
    pid: number,
    ppid: number,
    pgid: number,
    args: string,
    startedAt = 1_000_000,
  ): PlainProcess => ({
    pid,
    ppid,
    pgid,
    uid: 501,
    tty: null,
    startedAt,
    args,
  });

  /** The CLI (pid 100, its own group) and an MCP server in that group. */
  const CLI_AND_MCP = [
    row(100, 1, 100, 'claude'),
    row(101, 100, 100, 'node mcp.js'),
  ];

  function openRecordingSession(
    table: () => PlainProcess[],
    logger?: SessionLogger,
    readCommandRecords?: () => Promise<readonly CommandRecord[]>,
  ) {
    let reads = 0;
    const { spawn, child } = fakeSpawn(new FakeChild(100));
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: resultOnDone,
      spawn,
      logger,
      commandGroupReadDelayMs: 0,
      readCommandRecords,
      listProcessGroups: () => {
        reads += 1;
        return Promise.resolve().then(table);
      },
    });
    session.startTurn({ onEvent: () => {} });
    return { session, child, reads: () => reads };
  }

  function background(
    child: FakeChild,
    work: string,
    call: string,
    cmd: string,
  ): void {
    line(child, { run: call, cmd });
    line(child, { work, phase: 'started', unit: 'other', call });
  }

  /** Until the session has read the table `n` times and filed what it read. */
  async function afterReading(reads: () => number, n: number): Promise<void> {
    await vi.waitFor(() => expect(reads()).toBeGreaterThanOrEqual(n));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** The groups the session hands over when its process dies right now. */
  function groupsAtDeath(
    session: ReturnType<typeof runCliSession>,
    child: FakeChild,
  ) {
    child.emit('close', null, 'SIGKILL');
    return session.endedRunning?.groups;
  }

  it('records the group a background command runs in, with every member of it', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 200, "/bin/zsh -c eval 'pnpm dev'"),
      row(201, 200, 200, 'node /opt/homebrew/bin/pnpm dev', 2_000_000),
    ]);
    background(child, 'b1', 't1', 'pnpm dev');
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)).toEqual([
      {
        pgid: 200,
        members: [
          { pid: 200, startedAt: 1_000_000 },
          { pid: 201, startedAt: 2_000_000 },
        ],
      },
    ]);
  });

  it('finds a command whose text is not in the table through the CLI’s own record', async () => {
    const heredoc = "python3 << 'PY'\nprint(1)\nPY";
    const { session, child, reads } = openRecordingSession(
      () => [
        ...CLI_AND_MCP,
        row(200, 100, 200, '/bin/zsh -c __cursor_command'),
        row(201, 200, 200, 'Python', 2_000_000),
      ],
      undefined,
      async () => [{ pid: 200, command: heredoc, running: true }],
    );
    background(child, 'b1', 't1', heredoc);
    await afterReading(reads, 1);

    expect(session.recordedGroupsOf('t1')).toEqual([
      {
        pgid: 200,
        members: [
          { pid: 200, startedAt: 1_000_000 },
          { pid: 201, startedAt: 2_000_000 },
        ],
      },
    ]);
  });

  it('answers where the command a call launched runs — nothing before a reading, null for a call running none', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c pnpm dev'),
    ]);
    background(child, 'b1', 't1', 'pnpm dev');
    expect(session.recordedGroupsOf('t1')).toEqual([]);
    await afterReading(reads, 1);

    expect(session.recordedGroupsOf('t1')).toEqual([
      { pgid: 200, members: [{ pid: 200, startedAt: 1_000_000 }] },
    ]);
    expect(session.recordedGroupsOf('t-other')).toBeNull();
  });

  it('never records the CLI’s own group, where its MCP servers run', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 100, "/bin/zsh -c eval 'pnpm dev'"),
    ]);
    background(child, 'b1', 't1', 'pnpm dev');
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  it('hands over the groups of the commands still running when the process ends', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c sleep 600'),
      row(300, 100, 300, '/bin/sh -c tail -f build.log'),
    ]);
    background(child, 'b1', 't1', 'sleep 600');
    background(child, 'b2', 't2', 'tail -f build.log');
    await afterReading(reads, 1);

    line(child, { work: 'b2', phase: 'settled', unit: 'other' });

    expect(groupsAtDeath(session, child)?.map((group) => group.pgid)).toEqual([
      200,
    ]);
  });

  describe('in the child journal', () => {
    let dir: string;
    let journalPath: string;

    afterEach(() => {
      resetChildJournal();
      rmSync(dir, { recursive: true, force: true });
    });

    function openJournaledSession(table: () => PlainProcess[]) {
      dir = mkdtempSync(join(tmpdir(), 'geniro-journal-'));
      journalPath = join(dir, 'children.json');
      configureChildJournal(journalPath);
      let reads = 0;
      const { spawn, child } = fakeSpawn(new FakeChild(100));
      const session = runCliSession({
        command: 'claude',
        args: [],
        cwd: '/proj',
        env: { GENIRO_RUN_ID: 'run-x' },
        stdinLifetime: 'session',
        mapper: resultOnDone,
        spawn,
        commandGroupReadDelayMs: 0,
        listProcessGroups: () => {
          reads += 1;
          return Promise.resolve().then(table);
        },
      });
      session.startTurn({ onEvent: () => {} });
      return { session, child, reads: () => reads };
    }

    const journaled = () =>
      (JSON.parse(readFileSync(journalPath, 'utf8')) as ChildJournalFile)
        .commandGroups;

    const TABLE = () => [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c sleep 600'),
      row(201, 200, 200, 'sleep 600', 2_000_000),
    ];

    it('writes what a reading recorded under the CLI’s pid, with its run', async () => {
      const { child, reads } = openJournaledSession(TABLE);
      background(child, 'b1', 't1', 'sleep 600');
      await afterReading(reads, 1);

      expect(journaled()).toEqual([
        {
          cliPid: 100,
          runId: 'run-x',
          groups: [
            {
              pgid: 200,
              members: [
                { pid: 200, startedAt: 1_000_000 },
                { pid: 201, startedAt: 2_000_000 },
              ],
            },
          ],
        },
      ]);
    });

    it('drops the entry once the CLI reports the command ended', async () => {
      const { child, reads } = openJournaledSession(TABLE);
      background(child, 'b1', 't1', 'sleep 600');
      await afterReading(reads, 1);

      line(child, { work: 'b1', phase: 'settled', unit: 'other' });

      expect(journaled()).toEqual([]);
    });

    it('keeps the entry when the process dies, and names the CLI in the hand-over', async () => {
      const { session, child, reads } = openJournaledSession(TABLE);
      background(child, 'b1', 't1', 'sleep 600');
      await afterReading(reads, 1);

      child.emit('close', null, 'SIGKILL');
      line(child, { work: 'b1', phase: 'settled', unit: 'other' });

      expect(session.endedRunning?.pid).toBe(100);
      expect(journaled()?.map((entry) => entry.cliPid)).toEqual([100]);
    });
  });

  it('keeps a recorded group whose wrapper has exited, with what has joined it since', async () => {
    let table = [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c sleep 600; :'),
      row(201, 200, 200, 'sleep 600', 1_500_000),
    ];
    const { session, child, reads } = openRecordingSession(() => table);
    background(child, 'b1', 't1', 'sleep 600; :');
    await afterReading(reads, 1);

    // The wrapper is gone: its command now hangs off launchd, outside the
    // CLI's tree, and has started a helper in its own group.
    table = [
      ...CLI_AND_MCP,
      row(201, 1, 200, 'sleep 600', 1_500_000),
      row(202, 201, 200, 'sleep-helper', 1_600_000),
    ];
    background(child, 'b2', 't2', 'echo unrelated work');
    await afterReading(reads, 2);

    expect(groupsAtDeath(session, child)).toEqual([
      {
        pgid: 200,
        members: [
          { pid: 201, startedAt: 1_500_000 },
          { pid: 202, startedAt: 1_600_000 },
        ],
      },
    ]);
  });

  /** A session reading the table after the real {@link COMMAND_GROUP_READ_DELAY_MS}. */
  function openDelayedSession() {
    let reads = 0;
    const { spawn, child } = fakeSpawn(new FakeChild(100));
    const session = runCliSession({
      command: 'claude',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: resultOnDone,
      spawn,
      listProcessGroups: () => {
        reads += 1;
        return Promise.resolve([
          ...CLI_AND_MCP,
          row(200, 100, 200, '/bin/sh -c sleep 600'),
        ]);
      },
    });
    session.startTurn({ onEvent: () => {} });
    return { child, reads: () => reads };
  }

  it('reads the table once for a burst, a moment after its first command', async () => {
    vi.useFakeTimers();
    const { child, reads } = openDelayedSession();
    background(child, 'b1', 't1', 'sleep 600');
    background(child, 'b2', 't2', 'tail -f build.log');

    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS - 1);
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS);
    expect(reads()).toBe(1);
  });

  it('reads once more, a full delay later, for a command reported after the burst’s reading was armed', async () => {
    // That reading can come before the later command has spawned.
    vi.useFakeTimers();
    const { child, reads } = openDelayedSession();
    background(child, 'b1', 't1', 'sleep 600');
    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS - 100);
    background(child, 'b2', 't2', 'tail -f build.log');
    await vi.advanceTimersByTimeAsync(100);
    expect(reads()).toBe(1);

    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS - 1);
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
  });

  it.each([
    ['the user', 'held'],
    ['the run’s standing posture', 'posture'],
  ] as const)(
    'reads the table again once %s allows a request between turns',
    async (_who, path) => {
      // The command it asked about runs only once allowed.
      vi.useFakeTimers();
      let reads = 0;
      let answer: ((allow: boolean) => boolean) | null = null;
      const { spawn, child } = fakeSpawn(new FakeChild(100));
      const session = runCliSession({
        command: 'claude',
        args: [],
        cwd: '/proj',
        stdinLifetime: 'session',
        mapper: resultOnDone,
        spawn,
        betweenTurnApproval: () => (path === 'posture' ? true : null),
        onHeldApproval: (_event, respond) => {
          answer = respond;
          return true;
        },
        listProcessGroups: () => {
          reads += 1;
          return Promise.resolve([...CLI_AND_MCP]);
        },
      });
      const turn = session.startTurn({
        onEvent: () => {},
        buildApprovalResponse: (id, allow) => `VERDICT ${id} ${allow}\n`,
      });
      background(child, 'b1', 't1', 'pnpm dev');
      line(child, { done: true });
      await turn?.done;
      await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS);
      expect(reads).toBe(1);

      line(child, { ask: 'card-1' });
      if (path === 'held') {
        expect(answer!(true)).toBe(true);
      }
      await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS);
      expect(reads).toBe(2);
    },
  );

  it('reads the table again while a command runs, and not once none does', async () => {
    vi.useFakeTimers();
    let table = [...CLI_AND_MCP, row(200, 100, 200, '/bin/sh -c sleep 600; :')];
    const { session, child, reads } = openRecordingSession(() => table);
    background(child, 'b1', 't1', 'sleep 600; :');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);

    // Forked into the group after the first reading.
    table = [...table, row(201, 200, 200, 'sleep-helper', 2_000_000)];
    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_REFRESH_MS);
    expect(reads()).toBe(2);
    background(child, 'b2', 't2', 'tail -f build.log');
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(3);

    line(child, { work: 'b1', phase: 'settled', unit: 'other' });
    line(child, { work: 'b2', phase: 'settled', unit: 'other' });
    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_REFRESH_MS * 4);
    expect(reads()).toBe(3);
    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  it('files what a refresh found joined the group since the first reading', async () => {
    vi.useFakeTimers();
    let table = [...CLI_AND_MCP, row(200, 100, 200, '/bin/sh -c sleep 600; :')];
    const { session, child, reads } = openRecordingSession(() => table);
    background(child, 'b1', 't1', 'sleep 600; :');
    await vi.advanceTimersByTimeAsync(0);

    table = [...table, row(201, 200, 200, 'sleep-helper', 2_000_000)];
    await vi.advanceTimersByTimeAsync(COMMAND_GROUP_REFRESH_MS);
    expect(reads()).toBe(2);

    expect(groupsAtDeath(session, child)).toEqual([
      {
        pgid: 200,
        members: [
          { pid: 200, startedAt: 1_000_000 },
          { pid: 201, startedAt: 2_000_000 },
        ],
      },
    ]);
  });

  it('records a delegate’s own command, and drops it when that command ends', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c pnpm test --watch'),
    ]);
    line(child, { run: 'agent-1', cmd: undefined });
    line(child, {
      work: 'd1',
      phase: 'started',
      unit: 'agent',
      call: 'agent-1',
    });
    line(child, { run: 't9', cmd: 'pnpm test --watch', parent: 'agent-1' });
    line(child, {
      work: 'b9',
      phase: 'started',
      unit: 'other',
      call: 't9',
      owned: true,
    });
    await afterReading(reads, 1);
    expect(reads()).toBe(1);

    line(child, { work: 'b9', phase: 'settled', unit: 'other' });

    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  it('hands over a delegate’s own command still running when the process ends', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      row(200, 100, 200, '/bin/sh -c pnpm test --watch'),
    ]);
    line(child, { run: 'agent-1', cmd: undefined });
    line(child, {
      work: 'd1',
      phase: 'started',
      unit: 'agent',
      call: 'agent-1',
    });
    line(child, { run: 't9', cmd: 'pnpm test --watch', parent: 'agent-1' });
    line(child, {
      work: 'b9',
      phase: 'started',
      unit: 'other',
      call: 't9',
      owned: true,
    });
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)).toEqual([
      { pgid: 200, members: [{ pid: 200, startedAt: 1_000_000 }] },
    ]);
  });

  function waitedOn(child: FakeChild): void {
    line(child, { run: 't1', cmd: 'pnpm test' });
    line(child, {
      work: 'f1',
      phase: 'started',
      unit: 'other',
      call: 't1',
      fore: true,
    });
  }
  const TESTING = [...CLI_AND_MCP, row(200, 100, 200, '/bin/sh -c pnpm test')];

  it('records a command the agent waits on, from its start', async () => {
    const { session, child, reads } = openRecordingSession(() => TESTING);
    waitedOn(child);
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)).toEqual([
      { pgid: 200, members: [{ pid: 200, startedAt: 1_000_000 }] },
    ]);
  });

  it('drops a waited-on command once it settles', async () => {
    const { session, child, reads } = openRecordingSession(() => TESTING);
    waitedOn(child);
    await afterReading(reads, 1);

    line(child, { work: 'f1', phase: 'settled', unit: 'other' });

    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  it('opens no shell for a waited-on command whose move to the background arrives after its end', async () => {
    const opened: AgentEvent[] = [];
    const { spawn, child } = fakeSpawn(new FakeChild(100));
    const session = runCliSession({
      command: 'codex',
      args: [],
      cwd: '/proj',
      stdinLifetime: 'session',
      mapper: resultOnDone,
      spawn,
      listProcessGroups: () => Promise.resolve(null),
    });
    session.startTurn({ onEvent: (event) => opened.push(event) });
    line(child, { run: 't1', cmd: 'pnpm dev' });
    line(child, {
      work: 'u1',
      phase: 'started',
      unit: 'other',
      call: 't1',
      fore: true,
    });
    // codex held its turn's ending while a steer went unanswered, and the
    // command completed inside that hold.
    line(child, { work: 'u1', phase: 'settled', unit: 'other' });
    line(child, { work: 'u1', phase: 'backgrounded', unit: 'other' });

    expect(opened.filter((event) => event.type === 'shell_open')).toEqual([]);
    expect(session.shellsRunning).toBe(0);
  });

  it('records a command in the CLI’s own session but not its group leader’s group', async () => {
    // The CLI (pid 100) runs in group 90 — a wrapper leads it — and a command
    // matched in that group shares it with the CLI and its MCP servers.
    const { session, child, reads } = openRecordingSession(() => [
      row(90, 1, 90, 'node /usr/local/bin/claude'),
      row(100, 90, 90, 'claude'),
      row(200, 100, 90, '/bin/sh -c pnpm dev'),
    ]);
    background(child, 'b1', 't1', 'pnpm dev');
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  it('matches a command whose line ps escapes', async () => {
    const { session, child, reads } = openRecordingSession(() => [
      ...CLI_AND_MCP,
      // `ps` writes the em dash's three UTF-8 bytes as `M-bM^@M^T`.
      row(200, 100, 200, 'node ./serveM-bM^@M^Tall.js'),
    ]);
    background(child, 'b1', 't1', 'node ./serve—all.js');
    await afterReading(reads, 1);

    expect(groupsAtDeath(session, child)?.map((group) => group.pgid)).toEqual([
      200,
    ]);
  });

  it('drops a record once a reading finds nothing of the command', async () => {
    let table = [...CLI_AND_MCP, row(200, 100, 200, '/bin/sh -c sleep 600')];
    const { session, child, reads } = openRecordingSession(() => table);
    background(child, 'b1', 't1', 'sleep 600');
    await afterReading(reads, 1);

    table = [...CLI_AND_MCP];
    background(child, 'b2', 't2', 'echo unrelated work');
    await afterReading(reads, 2);

    expect(groupsAtDeath(session, child)).toEqual([]);
  });

  describe('for a CLI that reports no units (cursor)', () => {
    const executeMapper = (obj: unknown): AgentEvent[] => {
      const row = obj as { run?: string; id?: string; answered?: string };
      if (typeof row.run === 'string') {
        return [
          {
            type: 'tool_call',
            id: row.id ?? 'call-1',
            name: 'Shell',
            input: { command: row.run },
            kind: 'execute',
          },
        ];
      }
      if (typeof row.answered === 'string') {
        return [
          {
            type: 'tool_result',
            id: row.answered,
            name: null,
            result: { exitCode: 0, stdout: '', stderr: '' },
            isError: false,
          },
        ];
      }
      return [];
    };

    function openExecuteSession(table: () => PlainProcess[]) {
      let reads = 0;
      const { spawn, child } = fakeSpawn(new FakeChild(100));
      const session = runCliSession({
        command: 'cursor-agent',
        args: [],
        cwd: '/proj',
        stdinLifetime: 'session',
        mapper: executeMapper,
        spawn,
        detectDetachedShells: true,
        listProcesses: () => Promise.resolve([]),
        commandGroupReadDelayMs: 0,
        listProcessGroups: () => {
          reads += 1;
          return Promise.resolve().then(table);
        },
      });
      session.startTurn({ onEvent: () => {} });
      return { session, child, reads: () => reads };
    }

    it('reads the table again once an approval lets the command it asked about run', async () => {
      vi.useFakeTimers();
      let reads = 0;
      const { spawn, child } = fakeSpawn(new FakeChild(100));
      const session = runCliSession({
        command: 'cursor-agent',
        args: [],
        cwd: '/proj',
        stdinLifetime: 'session',
        mapper: (obj) => {
          const ask = (obj as { ask?: string }).ask;
          return typeof ask === 'string'
            ? [
                {
                  type: 'approval_request',
                  id: ask,
                  toolName: 'Shell',
                  input: {},
                },
              ]
            : executeMapper(obj);
        },
        spawn,
        detectDetachedShells: true,
        listProcesses: () => Promise.resolve([]),
        listProcessGroups: () => {
          reads += 1;
          return Promise.resolve([...CLI_AND_MCP]);
        },
      });
      const handle = session.startTurn({
        onEvent: () => {},
        buildApprovalResponse: (id, allow) =>
          `${JSON.stringify({ verdict: id, allow })}\n`,
      });
      line(child, { run: 'sleep 600', id: 'call-1' });
      line(child, { ask: 'card-1' });
      await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS);
      expect(reads).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(handle?.respondApproval('card-1', true, undefined)).toBe(true);
      await vi.advanceTimersByTimeAsync(COMMAND_GROUP_READ_DELAY_MS);
      expect(reads).toBe(2);
    });

    it('records a command from its call, and keeps it once answered while it runs on', async () => {
      const { session, child, reads } = openExecuteSession(() => [
        ...CLI_AND_MCP,
        row(200, 100, 200, '/bin/zsh -c sleep 600'),
      ]);
      line(child, { run: 'sleep 600', id: 'call-1' });
      await afterReading(reads, 1);
      // cursor answers a command it backgrounded as finished, exit code 0.
      line(child, { answered: 'call-1' });
      await afterReading(reads, 2);

      expect(groupsAtDeath(session, child)).toEqual([
        { pgid: 200, members: [{ pid: 200, startedAt: 1_000_000 }] },
      ]);
    });

    it('keeps no leftover the answered call’s group held once it has left the tree', async () => {
      let table = [
        ...CLI_AND_MCP,
        row(200, 100, 200, '/bin/zsh -c make serve'),
        row(201, 200, 200, 'node leftover.js', 2_000_000),
      ];
      const { session, child, reads } = openExecuteSession(() => table);
      line(child, { run: 'make serve', id: 'call-1' });
      await afterReading(reads, 1);

      // The call is answered; its shell is gone and what it left hangs off
      // launchd, still in its group.
      table = [...CLI_AND_MCP, row(201, 1, 200, 'node leftover.js', 2_000_000)];
      line(child, { answered: 'call-1' });
      await afterReading(reads, 2);

      expect(groupsAtDeath(session, child)).toEqual([]);
    });

    it('drops an answered command that no longer runs', async () => {
      let table = [...CLI_AND_MCP, row(200, 100, 200, '/bin/zsh -c make')];
      const { session, child, reads } = openExecuteSession(() => table);
      line(child, { run: 'make', id: 'call-1' });
      await afterReading(reads, 1);

      table = [...CLI_AND_MCP];
      line(child, { answered: 'call-1' });
      await afterReading(reads, 2);

      expect(groupsAtDeath(session, child)).toEqual([]);
    });
  });

  it('keeps the last record, and says so, when a later reading fails', async () => {
    const logger = { warn: vi.fn(), debug: vi.fn() };
    let fail = false;
    const { session, child, reads } = openRecordingSession(() => {
      if (fail) {
        throw new Error('ps exploded');
      }
      return [...CLI_AND_MCP, row(200, 100, 200, '/bin/sh -c sleep 600; :')];
    }, logger);
    background(child, 'b1', 't1', 'sleep 600; :');
    await afterReading(reads, 1);

    fail = true;
    background(child, 'b2', 't2', 'tail -f build.log');
    await afterReading(reads, 2);

    expect(logger.warn).toHaveBeenCalledWith(
      'claude: could not record where its background commands run: ps exploded',
    );
    expect(groupsAtDeath(session, child)).toEqual([
      { pgid: 200, members: [{ pid: 200, startedAt: 1_000_000 }] },
    ]);
  });
});
