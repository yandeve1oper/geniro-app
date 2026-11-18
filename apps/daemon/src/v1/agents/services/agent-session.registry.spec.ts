import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { simulateSleep } from '../../../__tests__/simulate-sleep';
import { environment } from '../../../environments';
import { FakeChild, fakeSpawn } from '../__tests__/fake-child';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
  SessionCloseCause,
} from '../adapters/adapter.types';
import { AgentAdapter } from '../adapters/agent-adapter';
import type { RecordedGroup } from '../utils/process-descendants';
import {
  RUN_ID_ENV,
  RUN_OWNER_ENV,
  runOwnerOf,
  runTagEnv,
} from '../utils/run-process-scan';
import {
  callSessionKey,
  callSessionKeyPrefix,
  nodeSessionKey,
} from '../utils/session-keys';
import type {
  CliSessionOptions,
  SessionCloseOptions,
  SpawnedProcess,
  SpawnFn,
  StoppedCommands,
} from '../utils/spawn-cli';
import { SessionfulAdapter } from './__tests__/sessionful-adapter';
import {
  AgentSessionRegistry,
  OFF_TURN_ACTIVE_MS,
  RECENTLY_USED_MS,
  SESSION_IDLE_MS,
  SESSION_MEMORY_COST_BYTES,
  sessionCeilingFor,
} from './agent-session.registry';

/**
 * The ceiling every case in this file runs under, PINNED.
 *
 * The production one is derived from the machine's memory, so it is 2 on a
 * 16GB CI box and 16 on the desktop this was written on — and an eviction case
 * that builds `MAX_LIVE_SESSIONS` sessions and then asserts which of the first
 * three went would mean something different on each. The registry takes it as
 * a constructor argument for exactly this, and the derivation is pinned on its
 * own below rather than through these.
 */
const CEILING = 3;

const INPUT: AgentTurnInput = { prompt: 'p', cwd: '/proj' };

/** A session double that records its own lifetime, and can refuse a turn. */
class FakeSession implements AgentSession {
  closes = 0;
  turns = 0;
  refuse = false;
  closeThrows = false;
  /**
   * Alive but unable to serve a turn. Left false here and set by the one case
   * that needs it: `refuse` models a session that declines THIS turn (a changed
   * model, a one-turn CLI), which the registry replaces; `retired` is the
   * stronger state it must close on sight instead of counting as reusable.
   */
  retired = false;
  /**
   * Blocked on a verdict only the user can give. Idle in every other respect,
   * which is the whole point of the flag — the registry must reap an unused
   * session and must not reap this one.
   */
  parked = false;
  /** Commands the process is still running — a dev server, say. */
  shellsRunning = 0;
  /** Of those, the ones a delegate still waits on: not detached yet. */
  waitedOnCommands = 0;
  get detachedRunning(): number {
    return this.shellsRunning - this.waitedOnCommands;
  }
  /** Where each call's command was recorded running, by call id. */
  recorded = new Map<string, RecordedGroup[]>();
  recordedGroupsOf(callId: string): RecordedGroup[] | null {
    return this.recorded.get(callId) ?? null;
  }
  /** The delegate ids whose own command this process is still running. */
  blockedDelegates = new Set<string>();
  /** The command lines of those detached commands. */
  runningCommands: string[] = [];
  /**
   * Accepts its first turn and is dead by the time it returns — the shape a
   * failed spawn takes (`deadSession`).
   */
  spawnDead = false;
  /** Where its detached commands run, as the session recorded it. */
  commandGroups: RecordedGroup[] = [];
  /** What was running when the process ended; set by `die` and `close`. */
  endedRunning: StoppedCommands | null = null;
  pid: number | null = null;
  /** Every input a turn was opened with, in order. */
  inputs: AgentTurnInput[] = [];
  private settle: (() => void) | null = null;

  ask(): Promise<null> {
    return Promise.resolve(null);
  }

  startTurn(input: AgentTurnInput): AgentTurnHandle | null {
    if (this.spawnDead && this.turns === 0) {
      this.turns += 1;
      this.inputs.push(input);
      this.processGone = true;
      return {
        done: Promise.resolve(),
        cancel: () => {},
        respondApproval: () => false,
        sendUserMessage: () => false,
        attributableDelegate: (): string | null => null,
        setApprovalMode: () => false,
      };
    }
    if (this.refuse || !this.idle) {
      return null;
    }
    this.turns += 1;
    this.inputs.push(input);
    const done = new Promise<void>((resolve) => {
      this.settle = resolve;
    });
    return {
      done,
      cancel: () => this.endTurn(),
      respondApproval: () => true,
      sendUserMessage: () => true,
      attributableDelegate: (): string | null => null,
      setApprovalMode: () => true,
    };
  }

  /** Finish the turn in flight, as a `result` line would. */
  async endTurn(): Promise<void> {
    const settle = this.settle;
    this.settle = null;
    settle?.();
    // Let the registry's `done.then` re-arm before the caller asserts.
    await Promise.resolve();
    await Promise.resolve();
  }

  get idle(): boolean {
    // A dead process is not "alive with no turn in flight". This is the shape
    // the real session has, and the reason the registry cannot use `idle` to
    // tell a busy session from a dead one.
    return this.alive && this.settle === null;
  }

  get alive(): boolean {
    return this.closes === 0 && !this.processGone;
  }

  subagentRecoveryBlocked(id: string): boolean {
    return this.blockedDelegates.has(id);
  }

  closeCause: SessionCloseCause | null = null;

  noteCloseCause(cause: SessionCloseCause | null): void {
    this.closeCause = cause;
  }

  /** What each close asked for — a graceful close or an immediate one. */
  closeOptions: (SessionCloseOptions | undefined)[] = [];

  /** Set to keep the process running after a close, until {@link exit}. */
  lingers = false;

  close(cause?: SessionCloseCause, options?: SessionCloseOptions): void {
    this.closes += 1;
    this.closeCause ??= cause ?? null;
    this.closeOptions.push(options);
    if (!this.lingers) {
      this.endedRunning ??= this.stillRunning();
      this.resolveClosed();
    }
    if (this.closeThrows) {
      throw new Error('close boom');
    }
  }

  /**
   * The process died with nobody asking it to — the cancel fallback's group
   * kill, or a crash. `closed` resolves, as the real session's does.
   */
  die(): void {
    this.endedRunning = this.stillRunning();
    this.processGone = true;
    this.resolveClosed();
  }

  /** A lingering process finally exits after its close. */
  exit(): void {
    this.endedRunning ??= this.stillRunning();
    this.resolveClosed();
  }

  private stillRunning(): StoppedCommands {
    return {
      running: this.detachedRunning,
      commands: this.runningCommands,
      groups: this.commandGroups,
    };
  }

  /**
   * Dead, but the settle has not landed yet — the window in which the registry
   * still holds the entry and `closed` has not fired. This is what
   * `evictIfFull` has to cope with on its own.
   */
  dieWithoutSettling(): void {
    this.processGone = true;
  }

  /**
   * The registry's own between-turn sink, captured at spawn — what the CLI
   * calls when it produces a row with no turn of ours open.
   */
  betweenTurn: ((event: AgentEvent) => void) | null = null;

  /** One off-turn row, as a delegate reporting back would produce. */
  emitBetweenTurn(name: string): void {
    this.betweenTurn?.({ type: 'tool_call', id: name, name, input: {} });
  }

  private processGone = false;
  private resolveClosed!: () => void;
  closed = new Promise<void>((resolve) => {
    this.resolveClosed = resolve;
  });
}

/** An adapter double whose only job is to hand out sessions, one per spawn. */
function fakeAdapter(): {
  adapter: AgentAdapter;
  sessions: FakeSession[];
  next: () => FakeSession;
} {
  const sessions: FakeSession[] = [];
  const adapter = {
    startSession: (_input: AgentTurnInput, opts?: CliSessionOptions) => {
      const session = new FakeSession();
      session.betweenTurn = opts?.onBetweenTurnEvent ?? null;
      sessions.push(session);
      return session;
    },
    // The registry records which agent a session belongs to, so `markStale`
    // can find the sessions an MCP change is about. Doubles owe it too.
    getConfig: () => ({ kind: 'claude' }),
  } as unknown as AgentAdapter;
  return { adapter, sessions, next: () => at(sessions, sessions.length - 1) };
}

const noop = (_event: AgentEvent): void => {};

/** One fresh child per spawn, kept in call order for the assertions. */
function recordingSpawn(): { spawn: SpawnFn; children: FakeChild[] } {
  const children: FakeChild[] = [];
  return {
    children,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child as unknown as SpawnedProcess;
    },
  };
}

/** Feed one NDJSON line to a real session's child. */
function feed(child: FakeChild, obj: unknown): void {
  child.stdout.emitData(`${JSON.stringify(obj)}\n`);
}

/** Let the registry's own `done.then` bookkeeping land before asserting. */
async function settleRegistry(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Index into a list the test has just caused to be long enough. `noUncheckedIndexedAccess`
 * makes a bare index `T | undefined`, and a `?.` chain would silently pass an
 * assertion whose subject never existed — the throw is what keeps the test honest.
 */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`no element at index ${index} (length ${items.length})`);
  }
  return item;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentSessionRegistry — reusing a run’s process', () => {
  it('runs the run’s next turn on the process it already has', async () => {
    // The whole point: two messages, ONE spawn. Each extra spawn is a full
    // re-boot of every MCP server the user's CLI loads.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions, next } = fakeAdapter();

    const first = registry.startTurn('run-1', adapter, INPUT, noop);
    expect(first).not.toBeNull();
    await next().endTurn();

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
    expect(at(sessions, 0).turns).toBe(2);
    expect(at(sessions, 0).closes).toBe(0);
  });

  it('keeps one process per run, not one shared between runs', async () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(registry.liveCount).toBe(2);
  });

  it('replaces a session that refuses the turn, closing the old process', async () => {
    // A refusal means the process cannot serve this turn — a changed model or
    // folder, a dead CLI, a one-turn CLI — and none of those un-refuse later.
    // Keeping it would hold a process nothing can ever use again.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).refuse = true;

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).turns).toBe(1);
    expect(registry.liveCount).toBe(1);

    // The REPLACED session's `closed` resolves on a microtask, after its
    // successor is already in the map — so the close subscription must check
    // that the entry it is deleting is still its own. Without that guard it
    // deletes the LIVE successor here, leaving a run holding a process the
    // registry no longer tracks and `onApplicationShutdown` will never close.
    // The assertions above all run before the microtask, which is exactly why
    // deleting the guard used to leave the whole suite green.
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.liveCount).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
  });

  it('throws rather than registering a session that refuses its FIRST turn', () => {
    // A freshly opened session always accepts one — even a spawn failure comes
    // back as a settled handle carrying an error event. A null here is a broken
    // adapter contract, and swallowing it would register a process no turn is
    // attached to.
    const registry = new AgentSessionRegistry();
    const session = new FakeSession();
    session.refuse = true;
    const adapter = {
      startSession: () => session,
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

    expect(() => registry.startTurn('run-1', adapter, INPUT, noop)).toThrow(
      /refused its first turn/,
    );
    expect(session.closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });
});

describe('AgentSessionRegistry — ending a process', () => {
  it('closes a session that went unused for the idle window', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('lets the idle farewell ask the process something before closing it', async () => {
    // The reading claude can only give while it is RUNNING — the context
    // breakdown and the plan limits — is wanted long after it stops running,
    // and this close is the last moment anything can ask for it. The session
    // must still be reachable while the question is in flight, which is what
    // the `peek` here pins.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    let release = (): void => {};
    const asked: (unknown | null)[] = [];
    registry.onIdleFarewell(async (runId) => {
      asked.push(registry.peek(runId));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    // Still alive while the question is outstanding — closing first would
    // leave nothing to ask.
    expect(asked).toEqual([at(sessions, 0)]);
    expect(at(sessions, 0).closes).toBe(0);

    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('abandons that close when a turn arrives while the farewell is in flight', async () => {
    // The window measures a chat going unused, and one the user has just
    // written to is not that — closing it here would take down the process the
    // turn is running on, for a question asked about the idle state it left.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    let release = (): void => {};
    registry.onIdleFarewell(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(SESSION_IDLE_MS);
    registry.startTurn('run-1', adapter, INPUT, noop);
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);
  });

  it('does not close a session parked on a card the user has not answered', async () => {
    // The run this was written for: claude asked a question eight minutes after
    // its turn had settled, the idle window closed the process under it, the
    // CLI read the close as a refusal, and the chat was marked failed with a
    // bare "claude run failed" for a question nobody had answered. The window
    // measures a chat going UNUSED, and one waiting on a person is not that.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).parked = true;

    vi.advanceTimersByTime(SESSION_IDLE_MS * 3);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);

    // And the clock resumes once they answer — the re-arm is what stops a
    // once-parked session living forever.
    at(sessions, 0).parked = false;
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('does not close a session still running a detached command, however quiet it is', async () => {
    // Reported as "This site can't be reached": an agent started `web` and
    // `api` in the background, and a dev server writes nothing while it works —
    // so the idle window read the process serving both as unused.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).shellsRunning = 2;

    vi.advanceTimersByTime(SESSION_IDLE_MS * 3);

    expect(at(sessions, 0).closes).toBe(0);

    // Once the last one ends, the window resumes and an unused process goes.
    at(sessions, 0).shellsRunning = 0;
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('closes EVERY process one run holds — its own key and each member and conversation key — and no other run’s', () => {
    // A team run keeps one process per member and per conversation, and they
    // outlive its passes; a delete or archive closing only the bare run key
    // would leave them, and every server they started, running for good. The
    // keys come from the executor's own builders, so a builder that stopped
    // starting with the run's prefix fails here rather than in production.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(
      nodeSessionKey('run-1', 'manager'),
      adapter,
      INPUT,
      noop,
    );
    registry.startTurn(callSessionKey('run-1', 'call-1'), adapter, INPUT, noop);
    registry.startTurn(
      nodeSessionKey('run-10', 'manager'),
      adapter,
      INPUT,
      noop,
    );

    registry.closeRun('run-1');

    expect(sessions.map((session) => session.closes)).toEqual([1, 1, 1, 0]);
    expect(registry.liveCount).toBe(1);
  });

  it('names every live process one run holds, with the pid it was spawned as', () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'qa'), adapter, INPUT, noop);
    registry.startTurn(callSessionKey('run-1', 'call-2'), adapter, INPUT, noop);
    registry.startTurn('run-10', adapter, INPUT, noop);
    sessions.forEach((session, index) => {
      session.pid = 500 + index;
    });
    // A process whose CLI has already gone has no pid to attribute from.
    at(sessions, 2).pid = null;

    expect(registry.processRoots('run-1')).toEqual([
      { key: 'run-1', agent: 'claude', cwd: INPUT.cwd, pid: 500 },
      {
        key: nodeSessionKey('run-1', 'qa'),
        agent: 'claude',
        cwd: INPUT.cwd,
        pid: 501,
      },
    ]);
    // With no run named, every live process the daemon holds.
    expect(registry.processRoots().map((root) => root.pid)).toEqual([
      500, 501, 503,
    ]);
    registry.closeRun('run-1');
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('says whether a live process is kept under a key family, and not once it has closed', () => {
    const registry = new AgentSessionRegistry();
    const { adapter } = fakeAdapter();
    registry.startTurn(callSessionKey('run-1', 'call-4'), adapter, INPUT, noop);

    expect(registry.holdsAnyUnder(callSessionKeyPrefix('run-1'))).toBe(true);
    expect(registry.holdsAnyUnder(callSessionKeyPrefix('run-10'))).toBe(false);
    registry.closeRun('run-1');
    expect(registry.holdsAnyUnder(callSessionKeyPrefix('run-1'))).toBe(false);
  });

  it('does not close a session whose CLI is still producing rows between turns', async () => {
    // MEASURED on the author's own machine, run 1fb3a9f5 on 2026-08-22: a turn
    // settled at 11:03:55 and armed this window; the CLI then worked off-turn
    // for the whole thirty minutes — delegates reporting back, continuation
    // turns of its own, rows landing in the transcript the entire time — and
    // the window fired at 11:33:55, three seconds after the last row, reaping
    // a process that had been busy without pause.
    //
    // `session.idle` is why: it means "alive with no turn of OURS in flight",
    // which is true of a CLI running flat out between turns. The window
    // measures a chat going UNUSED, and one whose agent is writing rows is not
    // that — the same reading the `parked` case above already applies.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    // The between-turn sink is what the registry watches, so the caller has to
    // have one — `ChatService` always does, and a caller with none keeps
    // `spawn-cli`'s "dropped an event arriving between turns" warning instead.
    registry.startTurn('run-1', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();

    // Four half-windows of off-turn work — twice the window in total, so a
    // clock that is not re-armed has fired twice over by the end.
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(SESSION_IDLE_MS / 2);
      at(sessions, 0).emitBetweenTurn(`Bash-${i}`);
    }

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);

    // And the clock still runs out once it really does go quiet — the re-arm
    // must not turn into a session that lives for ever.
    vi.advanceTimersByTime(SESSION_IDLE_MS);

    expect(at(sessions, 0).closes).toBe(1);
  });

  it('does not reap off-turn work for time the machine spent asleep', async () => {
    // The window above was refreshed by the last off-turn row, then the Mac
    // slept for longer than the window. Those hours are not silence: at the
    // wake the process is still there, and the window runs again from then
    // rather than closing the CLI with no note.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');

    await simulateSleep(4 * 60 * 60_000);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);

    // A full window from the wake, so a timer that never fires does not pass.
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS - 1);
    expect(at(sessions, 0).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('does not close a session whose turn is still running', async () => {
    // The window is armed when a turn ENDS, so a long turn can outlive it.
    // Closing then would SIGKILL work the user is watching.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.startTurn('run-1', adapter, INPUT, noop); // running again

    vi.advanceTimersByTime(SESSION_IDLE_MS * 2);

    expect(at(sessions, 0).closes).toBe(0);
  });

  it('closes the run’s process on teardown, and says nothing on a second call', () => {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);

    registry.close('run-1', 'closed');
    registry.close('run-1', 'closed');
    registry.close('never-existed', 'closed');

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('closes every process on shutdown', () => {
    // `ProcessRegistry` drains the TURNS; nothing but this ends the processes
    // they ran on, and a detached group left behind survives until reboot.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    registry.onApplicationShutdown();

    expect(sessions.map((s) => s.closes)).toEqual([1, 1]);
    expect(registry.liveCount).toBe(0);
  });

  it('keeps closing the rest when one session throws on close', () => {
    // The defensive branch, entered deliberately: this runs in a loop on
    // shutdown, so giving up on the first failure would orphan every later
    // process — the exact leak the loop exists to prevent.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);
    at(sessions, 0).closeThrows = true;

    registry.onApplicationShutdown();

    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(0);
  });

  it('spawns a one-shot session once shutdown has begun', () => {
    // After the shutdown hook there is nobody left to call `close()`, so a
    // process kept alive then would outlive the daemon. A turn crossing that
    // window still runs — it just does not get kept.
    const registry = new AgentSessionRegistry();
    const startSession = vi.fn(() => new FakeSession());
    const adapter = {
      startSession,
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

    registry.onApplicationShutdown();
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(startSession).toHaveBeenCalledWith(INPUT, {
      runScoped: false,
      runTag: runTagEnv('run-1', runOwnerOf(environment.userDataDir)),
    });
  });

  it('judges a between-turn request by the LATEST turn’s posture, not the spawn’s', async () => {
    // The session is opened once and kept for the whole run, but the approval
    // posture is a per-turn fact. Handing the spawn a bare closure froze it at
    // turn 1: a chat started in `auto` and switched to `ask` went on
    // auto-approving between-turn tool calls for the rest of the session, with
    // no card ever shown — the same silent wrong verdict the between-turn work
    // exists to end, only inverted. Every later turn reaches the session
    // through the REUSE path, which never spawns, so that path is where this
    // has to hold.
    const registry = new AgentSessionRegistry();
    const session = new FakeSession();
    let installed: ((r: { toolName: string }) => boolean | null) | undefined;
    const adapter = {
      startSession: (
        _input: AgentTurnInput,
        opts: {
          betweenTurnApproval?: (r: { toolName: string }) => boolean | null;
        },
      ) => {
        installed = opts.betweenTurnApproval;
        return session;
      },
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

    // Turn 1 — the run is unattended, so a between-turn permission is answered.
    registry.startTurn('run-1', adapter, INPUT, noop, () => true);
    expect(installed?.({ toolName: 'Bash' })).toBe(true);
    await session.endTurn();

    // Turn 2 — the user has taken the chip off auto. Same session, reuse path.
    registry.startTurn('run-1', adapter, INPUT, noop, () => null);
    expect(session.turns).toBe(2);
    // Read through the ORIGINAL installed callback: that is the one the live
    // process still calls, so asserting on anything else would prove nothing.
    expect(installed?.({ toolName: 'Bash' })).toBeNull();
  });

  it('leaves a caller that supplies no posture on the session’s own default', async () => {
    // `spawn-cli` still has a default for callers with no posture to offer
    // (hold a question, refuse a permission). An indirection installed
    // unconditionally would erase it by answering `null` for everything, so
    // the option must stay genuinely absent.
    const registry = new AgentSessionRegistry();
    let seen: { betweenTurnApproval?: unknown } | undefined;
    const adapter = {
      startSession: (
        _input: AgentTurnInput,
        opts: { betweenTurnApproval?: unknown },
      ) => {
        seen = opts;
        return new FakeSession();
      },
      // The registry records which agent a session belongs to, so `markStale`
      // can find the sessions an MCP change is about. Doubles owe it too.
      getConfig: () => ({ kind: 'claude' }),
    } as unknown as AgentAdapter;

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(seen).toBeDefined();
    expect(seen?.betweenTurnApproval).toBeUndefined();
  });
});

describe('AgentSessionRegistry — the user’s idle window', () => {
  const MINUTE = 60_000;

  it('keeps a process for an hour until Electron main pushes a window', async () => {
    // A subscription's prompt cache lives an hour, and a fresh `--resume`
    // misses it once `git status` changed: closing earlier pays a full cache
    // rewrite and a cold MCP start.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(SESSION_IDLE_MS).toBe(60 * MINUTE);
    expect(registry.idleMinutes).toBe(60);
    await vi.advanceTimersByTimeAsync(60 * MINUTE - 1);
    expect(at(sessions, 0).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('arms the next window with the value pushed', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.setIdleMinutes(15);
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.idleMinutes).toBe(15);
    await vi.advanceTimersByTimeAsync(15 * MINUTE - 1);
    expect(at(sessions, 0).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('re-times a waiting process to its last use plus a longer window', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);

    registry.setIdleMinutes(120);

    await vi.advanceTimersByTimeAsync(110 * MINUTE - 1);
    expect(at(sessions, 0).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('closes, through the idle close, a process already past a lowered window, and re-times the rest', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const farewells: string[] = [];
    registry.onIdleFarewell(async (runId) => {
      farewells.push(runId);
    });
    registry.startTurn('old', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await vi.advanceTimersByTimeAsync(40 * MINUTE);
    registry.startTurn('recent', adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    registry.setIdleMinutes(30);
    await vi.advanceTimersByTimeAsync(0);

    expect(farewells).toEqual(['old']);
    expect(sessions.map((session) => session.closes)).toEqual([1, 0]);
    await vi.advanceTimersByTimeAsync(25 * MINUTE - 1);
    expect(at(sessions, 1).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.map((session) => session.closes)).toEqual([1, 1]);
  });

  it('still keeps a parked question, a detached command, off-turn work and a turn in flight when the window is lowered', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(5);
    const { adapter, sessions } = fakeAdapter();
    for (const run of ['parked', 'shell', 'off-turn', 'turn']) {
      registry.startTurn(run, adapter, INPUT, noop, undefined, noop);
      await at(sessions, sessions.length - 1).endTurn();
    }
    const [parked, shell, offTurn, turn] = sessions as [
      FakeSession,
      FakeSession,
      FakeSession,
      FakeSession,
    ];
    parked.parked = true;
    shell.shellsRunning = 1;
    registry.startTurn('turn', adapter, INPUT, noop);
    // A delegate the settled turn left working, writing a row every 4 minutes.
    for (let i = 0; i < 10; i += 1) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      offTurn.emitBetweenTurn(`Bash-${i}`);
    }

    registry.setIdleMinutes(5);
    await vi.advanceTimersByTimeAsync(0);

    expect(sessions.map((session) => session.closes)).toEqual([0, 0, 0, 0]);
    // Each one goes once its work ends, on the new window.
    parked.parked = false;
    shell.shellsRunning = 0;
    await turn.endTurn();
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(sessions.map((session) => session.closes)).toEqual([1, 1, 1, 1]);
  });

  it('does not count time asleep toward a window changed after the wake', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    await simulateSleep(4 * 60 * MINUTE);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    registry.setIdleMinutes(30);

    await vi.advanceTimersByTimeAsync(25 * MINUTE - 1);
    expect(at(sessions, 0).closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('gives a card’s run the same window as a chat’s', async () => {
    // A card in Done can still be written to: its run is an ordinary chat run
    // (or a team run), and how long its process lives does not depend on
    // the card's column. Nothing here knows which run is a card's.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.setIdleMinutes(20);
    registry.startTurn('chat-run', adapter, INPUT, noop);
    registry.startTurn('card-run', adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('card-flow', 'qa'), adapter, INPUT, noop);
    for (const session of sessions) {
      await session.endTurn();
    }

    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(sessions.map((session) => session.closes)).toEqual([0, 0, 0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sessions.map((session) => session.closes)).toEqual([1, 1, 1]);
  });
});

describe('AgentSessionRegistry — closing an idle process gracefully', () => {
  it('lets a process that went unused finish on its own', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    expect(at(sessions, 0).closeOptions).toEqual([{ graceful: true }]);
    expect(registry.liveCount).toBe(0);
  });

  it('closes at once for an eviction, a teardown and shutdown', async () => {
    const registry = new AgentSessionRegistry(2);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('evicted', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.startTurn('torn-down', adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    registry.startTurn('third', adapter, INPUT, noop);
    registry.closeRun('torn-down');
    await at(sessions, 2).endTurn();

    registry.closeAll();

    expect(sessions.map((session) => session.closeOptions)).toEqual([
      [undefined],
      [undefined],
      [undefined],
    ]);
  });

  it('still reports a process in a graceful close as the run’s until it exits', async () => {
    // What `RunProcessSweep` and `RunProcessReaper.held` read: the reap must
    // not find the run unheld and signal a CLI that is finishing on its own.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    cli.pid = 4242;
    await cli.endTurn();
    cli.lingers = true;

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    expect(cli.closeOptions).toEqual([{ graceful: true }]);
    expect(registry.liveCount).toBe(0);
    expect(registry.processRoots('run-1').map((root) => root.pid)).toEqual([
      4242,
    ]);
    expect(registry.processRoots().map((root) => root.pid)).toEqual([4242]);
    cli.exit();
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('escalates a graceful close still under way when the run is torn down', async () => {
    // An archive or delete wants the processes gone now.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn(nodeSessionKey('run-1', 'qa'), adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);
    for (const session of sessions) {
      await session.endTurn();
      session.lingers = true;
    }
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    registry.closeRun('run-1');

    expect(sessions.map((session) => session.closeOptions)).toEqual([
      [{ graceful: true }, undefined],
      [{ graceful: true }],
    ]);
    // Escalated, so no longer held as finishing; the other run's still is.
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('escalates a graceful close still under way when the daemon shuts down', async () => {
    // `cursor-agent acp` ignores EOF and its deadline is a timer in the
    // daemon: left alone, it and its MCP servers outlive the shutdown.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).lingers = true;
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    registry.closeAll();

    expect(at(sessions, 0).closeOptions).toEqual([
      { graceful: true },
      undefined,
    ]);
  });
});

describe('AgentSessionRegistry — a finished card’s close', () => {
  it('closes every process of the run gracefully and resolves only once each is gone', async () => {
    // What lets the caller reap the run's detached processes AFTER the CLIs
    // have finished, rather than signalling one mid-exit.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'qa'), adapter, INPUT, noop);
    for (const session of sessions) {
      await session.endTurn();
      session.lingers = true;
    }
    let gone = false;

    const finished = registry.closeFinishedRun('run-1').then(() => {
      gone = true;
    });
    expect(sessions.map((session) => session.closeOptions)).toEqual([
      [{ graceful: true }],
      [{ graceful: true }],
    ]);
    at(sessions, 0).exit();
    await Promise.resolve();
    await Promise.resolve();
    expect(gone).toBe(false);

    at(sessions, 1).exit();
    await finished;
    expect(gone).toBe(true);
  });

  it('waits for an idle close already under way, and still reports that process as the run’s', async () => {
    // The idle window ran out and the CLI is finishing on its own when the
    // card goes to Done: the reap after `closeFinishedRun` must not find the
    // run unheld and signal that CLI mid-exit.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    cli.pid = 4242;
    await cli.endTurn();
    cli.lingers = true;
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
    expect(cli.closeOptions).toEqual([{ graceful: true }]);
    let gone = false;

    const finished = registry.closeFinishedRun('run-1').then(() => {
      gone = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(registry.processRoots('run-1').map((root) => root.pid)).toEqual([
      4242,
    ]);
    expect(gone).toBe(false);
    expect(cli.closes).toBe(1);
    cli.exit();
    await finished;
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('takes over an idle close under way: the run is not told it went unused', async () => {
    // The finished card reaps the run itself once the close resolves
    // (`TaskSettleService.endFinishedWork`); the idle reap would be a second
    // reap of the same run, with a "processes stopped" row on a finished card.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const told: string[] = [];
    registry.onIdleClosed((runId) => told.push(runId));
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    await cli.endTurn();
    cli.lingers = true;
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
    expect(cli.closeOptions).toEqual([{ graceful: true }]);

    const finished = registry.closeFinishedRun('run-1');
    cli.exit();
    await finished;
    await vi.advanceTimersByTimeAsync(0);

    expect(told).toEqual([]);
  });

  it('does not wait on a process whose close threw, and leaves it to the reap', async () => {
    // A close that threw may never settle `closed`: waiting on it would hold
    // `TaskSettleService.endFinishedWork` before its reap forever. The
    // process is no longer reported as the run's, so the reap can end it.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    cli.pid = 4242;
    await cli.endTurn();
    cli.lingers = true;
    cli.closeThrows = true;

    await registry.closeFinishedRun('run-1');

    expect(cli.closeOptions).toEqual([{ graceful: true }]);
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('does not wait on an idle close that threw before the card was finished', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    cli.pid = 4242;
    await cli.endTurn();
    cli.lingers = true;
    cli.closeThrows = true;
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
    expect(cli.closeOptions).toEqual([{ graceful: true }]);

    await registry.closeFinishedRun('run-1');

    expect(cli.closes).toBe(1);
    expect(registry.processRoots('run-1')).toEqual([]);
  });

  it('closes nothing and resolves false while a turn of the run is in flight', async () => {
    // A follow-up or a button press that landed after the card was found
    // finished: its turn must not be cut, and the caller must not reap.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'qa'), adapter, INPUT, noop);
    const [settled, working] = sessions as [FakeSession, FakeSession];
    await settled.endTurn();
    settled.lingers = true;

    expect(await registry.closeFinishedRun('run-1')).toBe(false);

    expect(settled.closes).toBe(0);
    expect(working.closes).toBe(0);

    await working.endTurn();
    working.lingers = true;
    const finished = registry.closeFinishedRun('run-1');
    settled.exit();
    working.exit();
    expect(await finished).toBe(true);
  });

  it('never reads the close as cutting the agent off, even right after off-turn rows', async () => {
    // A finished card's close is housekeeping: off-turn output shortly before
    // it must not leave "the agent was still working when geniro closed its
    // process" in the transcript.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: [string, boolean][] = [];
    registry.onClosed((runId, interrupted) =>
      closed.push([runId, interrupted]),
    );
    registry.startTurn('run-1', adapter, INPUT, noop, undefined, noop);
    const cli = at(sessions, 0);
    await cli.endTurn();
    cli.emitBetweenTurn('Bash-1');

    const finished = registry.closeFinishedRun('run-1');
    await finished;

    expect(closed).toEqual([['run-1', false]]);
  });

  it('is escalated by an archive that lands during it', async () => {
    // An archive wants the processes gone now: the graceful close in progress
    // becomes an immediate one, and the finished card's close still resolves
    // only once the process has exited.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).lingers = true;
    let gone = false;

    const finished = registry.closeFinishedRun('run-1').then(() => {
      gone = true;
    });
    registry.closeRun('run-1');
    await Promise.resolve();

    expect(at(sessions, 0).closeOptions).toEqual([
      { graceful: true },
      undefined,
    ]);
    expect(gone).toBe(false);
    at(sessions, 0).exit();
    await finished;
    expect(gone).toBe(true);
  });
});

describe('AgentSessionRegistry — telling that a run went unused', () => {
  it.each([
    ['a chat or card run', 'run-1'],
    ['a team member', nodeSessionKey('run-1', 'qa')],
    ['a team callee conversation', callSessionKey('run-1', 'call-1')],
  ])(
    'tells the run once %s closed for going unused has exited',
    async (_what, key) => {
      vi.useFakeTimers();
      const registry = new AgentSessionRegistry(CEILING);
      const told: string[] = [];
      registry.onIdleClosed((runId) => told.push(runId));
      const { adapter, sessions } = fakeAdapter();
      registry.startTurn(key, adapter, INPUT, noop);
      const cli = at(sessions, 0);
      cli.pid = 4242;
      await cli.endTurn();
      cli.lingers = true;

      await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);
      // Still finishing: the reaper would refuse the run as held.
      expect(told).toEqual([]);

      cli.exit();
      await vi.advanceTimersByTimeAsync(0);
      expect(told).toEqual(['run-1']);
      expect(registry.processRoots('run-1')).toEqual([]);
    },
  );

  it('tells nothing for an eviction, a stale replacement, a teardown or shutdown', async () => {
    const registry = new AgentSessionRegistry(2);
    const told: string[] = [];
    registry.onIdleClosed((runId) => told.push(runId));
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('evicted', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.startTurn('stale', adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    registry.startTurn('third', adapter, INPUT, noop);
    registry.retire('stale', 'its conversation was compacted');
    registry.startTurn('stale', adapter, INPUT, noop);
    registry.closeRun('third');
    registry.closeAll();
    await settleRegistry();

    expect(sessions.slice(0, 3).map((session) => session.closes)).toEqual([
      1, 1, 1,
    ]);
    expect(told).toEqual([]);
  });

  it('tells nothing when a teardown escalates the idle close still under way', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const told: string[] = [];
    registry.onIdleClosed((runId) => told.push(runId));
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const cli = at(sessions, 0);
    await cli.endTurn();
    cli.lingers = true;
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    registry.closeRun('run-1');
    cli.exit();
    await vi.advanceTimersByTimeAsync(0);

    expect(cli.closeOptions).toEqual([{ graceful: true }, undefined]);
    expect(told).toEqual([]);
  });

  it('tells nothing while another conversation of the run was used within the window', async () => {
    // Node b's CLI died a minute after its turn: nothing holds the run, yet it
    // is in use, and what its agent started is not a leftover.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const told: string[] = [];
    registry.onIdleClosed((runId) => told.push(runId));
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn(nodeSessionKey('run-1', 'a'), adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS - 60_000);
    registry.startTurn(nodeSessionKey('run-1', 'b'), adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    at(sessions, 1).die();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(at(sessions, 0).closeOptions).toEqual([{ graceful: true }]);
    expect(told).toEqual([]);
  });

  it('tells the other listeners when one throws', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const told: string[] = [];
    registry.onIdleClosed(() => {
      throw new Error('listener boom');
    });
    registry.onIdleClosed((runId) => told.push(runId));
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    await vi.advanceTimersByTimeAsync(SESSION_IDLE_MS);

    expect(told).toEqual(['run-1']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('an idle-close listener for run run-1 threw'),
    );
    warn.mockRestore();
  });
});

describe('AgentSessionRegistry.oweRunNote', () => {
  it('carries a run’s note on the next turn of its chat, once', async () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.oweRunNote('run-1', 'geniro stopped `pnpm dev`');

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.startTurn('run-1', adapter, INPUT, noop);

    const prompts = at(sessions, 0).inputs.map((input) => input.prompt);
    expect(at(prompts, 0)).toContain('geniro stopped `pnpm dev`');
    expect(at(prompts, 1)).toBe('p');
  });

  it('carries a team run’s note on the first conversation’s next turn only', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.oweRunNote('run-1', 'geniro stopped `pnpm dev`');

    registry.startTurn(nodeSessionKey('run-1', 'a'), adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'b'), adapter, INPUT, noop);

    expect(at(at(sessions, 0).inputs, 0).prompt).toContain(
      'geniro stopped `pnpm dev`',
    );
    expect(at(at(sessions, 1).inputs, 0).prompt).toBe('p');
  });

  it('owes nothing once the daemon is shutting down', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.closeAll();
    registry.oweRunNote('run-1', 'geniro stopped `pnpm dev`');

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(at(at(sessions, 0).inputs, 0).prompt).toBe('p');
  });

  it('keeps the note for a turn that carries no prompt', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.oweRunNote('run-1', 'geniro stopped `pnpm dev`');

    registry.startTurn(
      nodeSessionKey('run-1', 'a'),
      adapter,
      { ...INPUT, resumeOnly: true },
      noop,
    );
    registry.startTurn(nodeSessionKey('run-1', 'b'), adapter, INPUT, noop);

    expect(at(at(sessions, 0).inputs, 0).prompt).toBe('p');
    expect(at(at(sessions, 1).inputs, 0).prompt).toContain(
      'geniro stopped `pnpm dev`',
    );
  });
});

describe('AgentSessionRegistry — work between turns', () => {
  // What `IdleShutdownLifecycle` reads, since `ProcessRegistry` counts only
  // TURNS: a process that settled its turn and carried on is working, and the
  // daemon exiting under it kills that work.
  it('counts a process writing rows off-turn, and one serving a detached command — not an idle one', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    for (const run of ['run-quiet', 'run-rows', 'run-shell']) {
      registry.startTurn(run, adapter, INPUT, noop, undefined, noop);
    }
    for (const session of sessions) {
      await session.endTurn();
    }
    expect(registry.workingOffTurn).toBe(0);

    at(sessions, 1).emitBetweenTurn('Bash-1');
    at(sessions, 2).shellsRunning = 1;

    expect(registry.workingOffTurn).toBe(2);
  });

  it('stops counting off-turn rows once they have gone quiet for the window, and never counts a dead process', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-rows', adapter, INPUT, noop, undefined, noop);
    registry.startTurn('run-shell', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    await at(sessions, 1).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');
    at(sessions, 1).shellsRunning = 1;

    vi.advanceTimersByTime(OFF_TURN_ACTIVE_MS + 1_000);
    expect(registry.workingOffTurn).toBe(1);

    // A process that died still reports the shells it last knew about; it is
    // not doing any of that work any more.
    at(sessions, 1).dieWithoutSettling();
    expect(registry.workingOffTurn).toBe(0);
  });

  it('counts a detached command as work between turns only within the window after its last turn', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-shell', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    expect(registry.worksBetweenTurns(60_000)).toBe(false);

    at(sessions, 0).shellsRunning = 1;
    expect(registry.worksBetweenTurns(60_000)).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(registry.worksBetweenTurns(60_000)).toBe(false);
    expect(registry.workingOffTurn).toBe(1);

    at(sessions, 0).emitBetweenTurn('Bash-1');
    expect(registry.worksBetweenTurns(60_000)).toBe(true);
  });

  it("times a member's detached command from the run's last turn, not that member's own", async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn(nodeSessionKey('run-1', 'a'), adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).shellsRunning = 1;

    vi.advanceTimersByTime(50_000);
    registry.startTurn(nodeSessionKey('run-1', 'b'), adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(20_000);

    expect(registry.worksBetweenTurns(60_000)).toBe(true);
  });

  it("counts the run's processes with a turn in flight", async () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn(nodeSessionKey('run-1', 'a'), adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'b'), adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    expect(registry.turnsInFlight('run-1')).toBe(2);

    await at(sessions, 0).endTurn();
    expect(registry.turnsInFlight('run-1')).toBe(1);
    expect(registry.turnsInFlight('run-2')).toBe(1);
  });
});

describe('AgentSessionRegistry — why a session closed', () => {
  function opened(key: string) {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const heard: (string | null)[] = [];
    registry.onClosed((_key, _interrupted, _exited, cause) => {
      heard.push(cause);
    });
    registry.startTurn(key, adapter, INPUT, noop);
    return { registry, adapter, sessions, heard };
  }

  it('hands a close’s cause to the session and to every listener', () => {
    const { registry, sessions, heard } = opened('run-1');

    registry.close('run-1', 'its turn was stopped', 'user-stop');

    expect(at(sessions, 0).closeCause).toBe('user-stop');
    expect(heard).toEqual(['user-stop']);
  });

  it('makes a later close of a stopped run the Stop’s, until it is asked to work again', () => {
    const { registry, adapter, sessions, heard } = opened(
      nodeSessionKey('run-1', 'manager'),
    );
    registry.noteUserStop('run-1');
    registry.closeRun('run-1');
    expect(at(sessions, 0).closeCause).toBe('user-stop');
    expect(heard).toEqual(['user-stop']);

    // A new turn on a stopped run's process clears it.
    const key = nodeSessionKey('run-2', 'manager');
    registry.startTurn(key, adapter, INPUT, noop);
    registry.noteUserStop('run-2');
    registry.startTurn(key, adapter, INPUT, noop);
    registry.closeRun('run-2');
    expect(at(sessions, 1).closeCause).toBeNull();
    expect(heard.at(-1)).toBeNull();
  });
});

describe('AgentSessionRegistry.recordedGroupsOf', () => {
  it('asks every live process of the run, and no other run’s', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(nodeSessionKey('run-1', 'qa'), adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);
    const group = (pgid: number) => ({
      pgid,
      members: [{ pid: pgid, startedAt: 1 }],
    });
    at(sessions, 1).recorded.set('call-1', [group(200)]);
    at(sessions, 2).recorded.set('call-1', [group(300)]);

    expect(registry.recordedGroupsOf('run-1', 'call-1')).toEqual([group(200)]);
  });

  it('answers null when no live process of the run reports the command running', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    at(sessions, 0).recorded.set('call-1', []);

    // Running with nothing recorded is not running nowhere.
    expect(registry.recordedGroupsOf('run-1', 'call-1')).toEqual([]);
    expect(registry.recordedGroupsOf('run-1', 'call-2')).toBeNull();
  });
});

describe('AgentSessionRegistry — what a process left running', () => {
  const GROUPS: RecordedGroup[] = [
    { pgid: 200, members: [{ pid: 200, startedAt: 2000 }] },
  ];
  const LEFT: StoppedCommands = {
    running: 1,
    commands: ['pnpm dev'],
    groups: GROUPS,
  };

  async function opened() {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const heard: [string, StoppedCommands][] = [];
    registry.onLeftCommands((runId, left) => heard.push([runId, left]));
    registry.startTurn('run-1', adapter, INPUT, noop);
    const session = at(sessions, 0);
    await session.endTurn();
    session.shellsRunning = 1;
    session.runningCommands = ['pnpm dev'];
    session.commandGroups = GROUPS;
    return { registry, session, heard };
  }

  it('hands on where a process that ended on its own had commands running', async () => {
    const { session, heard } = await opened();

    session.die();
    await settleRegistry();

    expect(heard).toEqual([['run-1', LEFT]]);
  });

  it('hands them on after a close it made, once that process has ended', async () => {
    const { registry, heard } = await opened();

    registry.close('run-1', 'its turn was retried');
    expect(heard).toEqual([]);
    await settleRegistry();

    expect(heard).toEqual([['run-1', LEFT]]);
  });

  it('hands them on after a teardown too, once its process has ended', async () => {
    // The teardown's own reap reads the run tag, which a system binary whose
    // parent is gone no longer shows; the recorded groups still find it.
    const { registry, heard } = await opened();

    registry.closeRun('run-1');
    await settleRegistry();

    expect(heard).toEqual([['run-1', LEFT]]);
  });

  it('says nothing on shutdown, where the daemon is going too', async () => {
    const { registry, heard } = await opened();

    registry.closeAll();
    await settleRegistry();

    expect(heard).toEqual([]);
  });

  it('tells every listener even when one throws, and says which run it was', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    try {
      const { registry, session, heard } = await opened();
      const later: string[] = [];
      registry.onLeftCommands(() => {
        throw new Error('listener boom');
      });
      registry.onLeftCommands((runId) => later.push(runId));

      session.die();
      await settleRegistry();

      expect(heard).toEqual([['run-1', LEFT]]);
      expect(later).toEqual(['run-1']);
      expect(warn).toHaveBeenCalledWith(
        'a left-commands listener for run run-1 threw: listener boom',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('says nothing when no command was recorded running', async () => {
    const { session, heard } = await opened();
    session.commandGroups = [];

    session.die();
    await settleRegistry();

    expect(heard).toEqual([]);
  });
});

describe('AgentSessionRegistry.subagentRecoveryBlocked', () => {
  // The subagent recovery service skips writing a terminal row for a delegate
  // while this answers true, so a false negative here ends a delegate whose
  // command is still running.
  const DELEGATE = 'toolu_delegate';

  function blockedSession(key: string): {
    registry: AgentSessionRegistry;
    session: FakeSession;
  } {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn(key, adapter, INPUT, noop);
    const session = at(sessions, 0);
    session.blockedDelegates.add(DELEGATE);
    return { registry, session };
  }

  it.each([
    ['the run’s own session', 'run-1'],
    ['only a call session of the same run', callSessionKey('run-1', 'call-1')],
    ['only a node session of the same run', nodeSessionKey('run-1', 'manager')],
  ])('is true when %s is running that delegate’s command', (_where, key) => {
    const { registry } = blockedSession(key);

    expect(registry.subagentRecoveryBlocked('run-1', DELEGATE)).toBe(true);
  });

  it('asks the run’s other sessions too when the first one is not running it', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn(callSessionKey('run-1', 'call-1'), adapter, INPUT, noop);
    at(sessions, 1).blockedDelegates.add(DELEGATE);

    expect(registry.subagentRecoveryBlocked('run-1', DELEGATE)).toBe(true);
  });

  it('is false when the session answers false for that delegate', () => {
    const { registry, session } = blockedSession('run-1');

    expect(session.subagentRecoveryBlocked('toolu_other')).toBe(false);
    expect(registry.subagentRecoveryBlocked('run-1', 'toolu_other')).toBe(
      false,
    );
  });

  it('is false when the delegate’s command is held by another run’s session', () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    // `run-10` shares the characters of `run-1` up to the separator: a prefix
    // test without it would claim this session for `run-1`.
    registry.startTurn('run-10', adapter, INPUT, noop);
    registry.startTurn(
      nodeSessionKey('run-10', 'manager'),
      adapter,
      INPUT,
      noop,
    );
    registry.startTurn('run-2', adapter, INPUT, noop);
    for (const session of sessions) {
      session.blockedDelegates.add(DELEGATE);
    }

    expect(registry.subagentRecoveryBlocked('run-1', DELEGATE)).toBe(false);
    // The control: the sessions do answer true for the runs they belong to.
    expect(registry.subagentRecoveryBlocked('run-10', DELEGATE)).toBe(true);
    expect(registry.subagentRecoveryBlocked('run-2', DELEGATE)).toBe(true);
  });

  it('is false when the session that held the command is no longer alive', () => {
    const { registry, session } = blockedSession('run-1');
    // Dead but still filed: the window before the registry's settle removes
    // the entry, and a dead process still reports the commands it last knew.
    session.dieWithoutSettling();

    expect(session.subagentRecoveryBlocked(DELEGATE)).toBe(true);
    expect(registry.subagentRecoveryBlocked('run-1', DELEGATE)).toBe(false);
  });

  it('is false for a run with no session', () => {
    const registry = new AgentSessionRegistry(CEILING);

    expect(registry.subagentRecoveryBlocked('run-1', DELEGATE)).toBe(false);
  });
});

describe('sessionCeilingFor', () => {
  const GB = SESSION_MEMORY_COST_BYTES;

  it('scales the ceiling with the machine, an eighth of memory at a time', () => {
    // The whole reason this stopped being a constant. REPORTED as "что за max
    // live session… это очень мало!" against a flat 3 on a 128GB machine,
    // where the fourth chat paid a ~6.5s cold start and a full MCP reboot with
    // 110GB sitting free. Pinned at sizes rather than as a formula, because a
    // test that recomputes the arithmetic under test passes whatever the
    // arithmetic is.
    expect(sessionCeilingFor(32 * GB)).toBe(4);
    expect(sessionCeilingFor(64 * GB)).toBe(8);
    expect(sessionCeilingFor(128 * GB)).toBe(16);
  });

  it('keeps two on a small machine rather than falling to one or none', () => {
    // At one there is nothing to keep: the benefit is a chat staying warm
    // while you work in another, and one slot means the second chat evicts the
    // first on every switch — worse than the per-turn spawn this replaced,
    // which at least did not pretend to cache anything.
    expect(sessionCeilingFor(8 * GB)).toBe(2);
    expect(sessionCeilingFor(4 * GB)).toBe(2);
    // Absurd inputs land on the floor rather than on 0 or a negative.
    expect(sessionCeilingFor(0)).toBe(2);
  });

  it('caps a very large machine instead of scaling without bound', () => {
    // Past a dozen the constraint is the person, not the hardware — these are
    // conversations somebody is meant to be following. Without the cap a 1TB
    // box would hold 128 CLI processes it was never going to use.
    expect(sessionCeilingFor(512 * GB)).toBe(16);
    expect(sessionCeilingFor(1024 * GB)).toBe(16);
  });
});

describe('AgentSessionRegistry — the ceiling', () => {
  it('evicts the least-recently-used idle session to make room', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      // Distinct `lastUsedAt` values, so "least recently used" is a real order
      // rather than map-insertion luck.
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);

    registry.startTurn('run-new', adapter, INPUT, noop);

    // run-0 was the oldest, and it is the one that went.
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('evicts a newer idle session rather than the oldest one holding a card', async () => {
    // `parked` is idle in the only sense `idle` claims — no turn in flight — so
    // the age scan would pick it first, being the oldest. Evicting it kills the
    // question rather than the process: the CLI takes the close as a refusal
    // and the verdict the user is about to give arrives at nothing.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    at(sessions, 0).parked = true;

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(0);
    // The next-oldest went instead, so the ceiling is still enforced.
    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('evicts a newer idle callee rather than an older one still working off-turn', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const heldCallee = callSessionKey('run-caller', 'call-held');
    const idleCallee = callSessionKey('run-caller', 'call-idle');

    registry.startTurn(heldCallee, adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');
    vi.advanceTimersByTime(1_000);
    registry.startTurn(idleCallee, adapter, INPUT, noop, undefined, noop);
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-busy', adapter, INPUT, noop, undefined, noop);

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    expect(at(sessions, 0).closes).toBe(0);
    expect(at(sessions, 1).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('goes over the ceiling rather than evicting any callee that is working off-turn', async () => {
    // The exemption cannot become a refusal: with every session working, the
    // scan finds no candidate and the existing all-busy arm takes over. Going
    // over is the lesser harm — the alternative is killing live work to make
    // room for work the user just asked for.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      const callee = callSessionKey('run-caller', `call-${i}`);
      registry.startTurn(callee, adapter, INPUT, noop, undefined, noop);
      await at(sessions, i).endTurn();
      at(sessions, i).emitBetweenTurn(`Bash-${i}`);
    }

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    for (let i = 0; i < CEILING; i += 1) {
      expect(at(sessions, i).closes).toBe(0);
    }
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('evicts a session whose off-turn work went quiet long ago', async () => {
    // The other half of the same rule, and what stops the exemption becoming
    // permanent: one off-turn row must not make a session un-evictable for the
    // rest of the day. Past the window it is an ordinary candidate again.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop, undefined, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    at(sessions, 0).emitBetweenTurn('Bash-1');
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    // The one that worked is now the LEAST attractive candidate by age — an
    // off-turn row refreshes `lastUsedAt` as a settling turn does — so the
    // other two are parked to leave it as the only one the scan can reach.
    // Without the expiry there is no candidate at all and the registry goes
    // over the ceiling instead, which is what this separates.
    at(sessions, 1).parked = true;
    at(sessions, 2).parked = true;

    registry.startTurn('run-new', adapter, INPUT, noop, undefined, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('tells a close listener whether the close INTERRUPTED work', async () => {
    // What the listener cannot see for itself, and what decides whether the
    // transcript owes the user a sentence: `ChatService` writes a row naming
    // the cut-off only for the first of these, because a row on every reap
    // would be one per chat and say nothing.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: [string, boolean][] = [];
    registry.onClosed((runId, interrupted) =>
      closed.push([runId, interrupted]),
    );

    registry.startTurn('run-working', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');
    registry.close('run-working', 'closed');

    registry.startTurn('run-quiet', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 1).endTurn();
    registry.close('run-quiet', 'closed');

    expect(closed).toEqual([
      ['run-working', true],
      ['run-quiet', false],
    ]);
  });

  it('drops a dead session rather than evicting a live one to make room for it', async () => {
    // The inverted consequence this fixes. A dead session reports `idle` false
    // — it is not "alive with no turn in flight" — so the eviction scan used to
    // skip it as though it were BUSY while still counting it against the
    // ceiling. The slot it occupied forever was paid for by a genuinely live
    // idle session being closed instead, respawning that run's CLI and
    // re-booting the user's MCP servers.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    // The NEWEST session dies behind the registry's back, with its settle not
    // yet landed — so `closed` has not fired and only the eviction scan can
    // notice. It is also the least attractive eviction candidate by age, which
    // is what makes this discriminating.
    at(sessions, CEILING - 1).dieWithoutSettling();

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, CEILING - 1).closes).toBe(1);
    // The oldest LIVE session survived — under the old scan it was the one
    // that went.
    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('forgets a session the moment its process dies, without waiting to be asked', async () => {
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    expect(registry.liveCount).toBe(1);

    at(sessions, 0).die();
    await Promise.resolve();
    await Promise.resolve();

    // Gone from the map, so it occupies no slot and no later turn is handed it.
    expect(registry.liveCount).toBe(0);
  });

  it('tells the close listeners when a process dies ON ITS OWN, and whether it was working', async () => {
    // A crash, an OOM kill, a `pkill`: the process that owed an off-turn
    // `running` its terminal event is gone exactly as if it had been closed,
    // and only this registry sees it go. Dropping the entry in silence would
    // leave a chat carrying on between turns whose CLI died reading `running ·
    // still working` for good, with its delegates declared out and no row
    // saying why.
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: [string, boolean, boolean][] = [];
    registry.onClosed((runId, interrupted, exited) =>
      closed.push([runId, interrupted, exited]),
    );

    registry.startTurn('run-working', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).emitBetweenTurn('Bash-1');
    registry.startTurn('run-quiet', adapter, INPUT, noop, undefined, noop);
    await at(sessions, 1).endTurn();

    at(sessions, 0).die();
    at(sessions, 1).die();
    await settleRegistry();

    expect(closed).toEqual([
      ['run-working', true, true],
      ['run-quiet', false, true],
    ]);
    expect(registry.liveCount).toBe(0);
  });

  it('announces a close it made ITSELF once, not again when that process’s exit lands', async () => {
    // The other half of the same subscription. `close()` ends the process, and
    // the exit then resolves `closed` — which is exactly what the crash path
    // listens to. Only the identity check (the entry is already gone) keeps
    // that exit from being announced as a second, contradicting close.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: [string, boolean, boolean][] = [];
    registry.onClosed((runId, interrupted, exited) =>
      closed.push([runId, interrupted, exited]),
    );

    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    registry.close('run-1', 'closed');
    // FakeSession.close resolves `closed`, as the real process's exit does.
    await settleRegistry();

    expect(closed).toEqual([['run-1', false, false]]);
  });

  it('says nothing about a process that ends during shutdown', async () => {
    // A turn crossing the shutdown window gets a one-shot process, which exits
    // by design when its turn ends — and the daemon is seconds from exiting,
    // so a listener writing rows then can only lose. The next boot's reconcile
    // owns those runs, as it does every close made on the way out.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const closed: string[] = [];
    registry.onClosed((runId) => closed.push(runId));

    registry.onApplicationShutdown();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).die();
    await settleRegistry();

    expect(registry.liveCount).toBe(0);
    expect(closed).toEqual([]);
  });

  it('reuses a stopped chat’s process for its next message — Stop costs no respawn', async () => {
    // REPORTED as "я его остановил. У него был открыт браузер Playwright.
    // Потом он написал новое сообщение, и Playwright сразу закрылся". Driven
    // through the REAL session state machine, because whether a stopped turn
    // leaves its process usable is decided inside `spawn-cli`: the CLI ends a
    // stopped turn on its own line, which leaves no tail (measured on claude
    // 2.1.266), so the chat's next message is answered by the SAME process.
    const registry = new AgentSessionRegistry(CEILING);
    const { spawn, children } = recordingSpawn();
    const adapter = new SessionfulAdapter(spawn);

    const stopped = registry.startTurn('run-stopped', adapter, INPUT, noop);
    stopped.cancel();
    feed(at(children, 0), { failed: true });
    await stopped.done;
    await settleRegistry();

    registry.startTurn('run-stopped', adapter, INPUT, noop);

    // Nothing was signalled and nothing new was spawned, so the MCP servers
    // that CLI holds up — a logged-in browser included — are still there.
    expect(at(children, 0).kills).toBe(0);
    expect(children).toHaveLength(1);
  });

  it.each([
    ['a chat', 'run-tagged'],
    ['a team member', nodeSessionKey('run-tagged', 'dev')],
    ['a callee conversation', callSessionKey('run-tagged', 'call-1')],
  ])(
    'spawns %s tagged with its RUN and this geniro, whatever the caller put there',
    (_kind, key) => {
      // Every descendant inherits it, a dev server the agent detached
      // included — which is what the run's teardown finds them by.
      const registry = new AgentSessionRegistry(CEILING);
      const { spawn, captured } = fakeSpawn();
      registry.startTurn(
        key,
        new SessionfulAdapter(spawn),
        {
          ...INPUT,
          env: { [RUN_ID_ENV]: 'spoofed', [RUN_OWNER_ENV]: 'spoofed' },
        },
        noop,
      );
      expect(captured.env?.[RUN_ID_ENV]).toBe('run-tagged');
      expect(captured.env?.[RUN_OWNER_ENV]).toBe(
        runOwnerOf(environment.userDataDir),
      );
    },
  );

  it('reclaims a session that reports itself RETIRED before a warm one the user is still using', async () => {
    // The contract state `retired` names — alive and idle, yet refusing every
    // turn — is invisible to the eviction scan unless the session reports it,
    // and such an entry is the LAST thing a least-recently-used scan gives up,
    // having been used most recently. Closing it on sight is what keeps a
    // different chat's warm CLI, and the MCP servers it holds up, off the block.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    for (const runId of ['run-warm', 'run-other', 'run-retired']) {
      registry.startTurn(runId, adapter, INPUT, noop);
      await at(sessions, sessions.length - 1).endTurn();
    }
    at(sessions, 2).retired = true;

    // A fourth chat's first message: one slot has to be given back.
    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 2).closes).toBe(1);
    expect(at(sessions, 0).closes).toBe(0);
    expect(at(sessions, 1).closes).toBe(0);
  });

  it('goes over the ceiling rather than killing a running turn', () => {
    // The alternative is evicting work the user is watching to make room for
    // work they just asked for — a worse trade than briefly holding one extra
    // process.
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop); // all still busy
    }

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(sessions.every((s) => s.closes === 0)).toBe(true);
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('starts over the ceiling rather than closing a chat that settled seconds ago', async () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-settled', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(5_000);
    registry.startTurn('run-busy-1', adapter, INPUT, noop);
    registry.startTurn('run-busy-2', adapter, INPUT, noop);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING + 1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`over the ${CEILING} ceiling`),
    );
    warn.mockRestore();
  });

  it('goes over the ceiling rather than closing a callee still working off-turn', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const callee = callSessionKey('run-caller', 'call-1');

    registry.startTurn('run-chat', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn(callee, adapter, INPUT, noop, undefined, noop);
    await at(sessions, 1).endTurn();
    at(sessions, 1).emitBetweenTurn('Bash-1');
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-other', adapter, INPUT, noop);
    await at(sessions, 2).endTurn();

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('closes a recently used callee conversation ahead of a recently used chat', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-chat', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-other', adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn(
      callSessionKey('run-caller', 'call-1'),
      adapter,
      INPUT,
      noop,
    );
    await at(sessions, 2).endTurn();
    vi.advanceTimersByTime(1_000);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 2).closes).toBe(1);
    expect(at(sessions, 0).closes).toBe(0);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('closes a chat past the window before a callee still inside it', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-chat', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    registry.startTurn(
      callSessionKey('run-caller', 'call-1'),
      adapter,
      INPUT,
      noop,
    );
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-other', adapter, INPUT, noop);
    await at(sessions, 2).endTurn();

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(at(sessions, 2).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('closes an idle callee past the window before an older chat past it', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-chat', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn(
      callSessionKey('run-caller', 'call-1'),
      adapter,
      INPUT,
      noop,
    );
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-other', adapter, INPUT, noop);
    await at(sessions, 2).endTurn();
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 1).closes).toBe(1);
    expect(at(sessions, 0).closes).toBe(0);
    expect(at(sessions, 2).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('starts over the ceiling while every session is recent, and evicts back to it once the window passes', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    registry.startTurn('run-over', adapter, INPUT, noop);
    await at(sessions, CEILING).endTurn();

    expect(sessions.every((s) => s.closes === 0)).toBe(true);
    expect(registry.liveCount).toBe(CEILING + 1);

    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    registry.startTurn('run-next', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(1);
    expect(at(sessions, 2).closes).toBe(0);
    expect(at(sessions, CEILING).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('goes over the ceiling rather than closing a callee parked on a question', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const callee = callSessionKey('run-caller', 'call-parked');

    registry.startTurn(callee, adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).parked = true;
    registry.startTurn('run-busy-1', adapter, INPUT, noop);
    registry.startTurn('run-busy-2', adapter, INPUT, noop);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('goes over the ceiling rather than closing a callee with a command still running', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const callee = callSessionKey('run-caller', 'call-command');

    registry.startTurn(callee, adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    at(sessions, 0).shellsRunning = 1;
    registry.startTurn('run-busy-1', adapter, INPUT, noop);
    registry.startTurn('run-busy-2', adapter, INPUT, noop);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('closes the less recently used of two recent callees before the newer one', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    const olderCallee = callSessionKey('run-caller', 'call-older');
    const newerCallee = callSessionKey('run-caller', 'call-newer');

    registry.startTurn(olderCallee, adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn(newerCallee, adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-busy', adapter, INPUT, noop);

    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });
});

describe('AgentSessionRegistry — the user’s session limit', () => {
  async function fourSessions(): Promise<{
    registry: AgentSessionRegistry;
    sessions: FakeSession[];
  }> {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    registry.setLimit(4);
    const { adapter, sessions } = fakeAdapter();

    registry.startTurn('run-old', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    vi.advanceTimersByTime(1_000);
    registry.startTurn('run-mid', adapter, INPUT, noop);
    await at(sessions, 1).endTurn();
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    registry.startTurn('run-recent', adapter, INPUT, noop);
    await at(sessions, 2).endTurn();
    registry.startTurn('run-busy', adapter, INPUT, noop);

    expect(registry.liveCount).toBe(4);
    return { registry, sessions };
  }

  it('closes idle sessions past the window when the limit is lowered, and keeps a recent chat and a busy one above it', async () => {
    const { registry, sessions } = await fourSessions();

    registry.setLimit(1);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(1);
    expect(at(sessions, 2).closes).toBe(0);
    expect(at(sessions, 3).closes).toBe(0);
    expect(registry.liveCount).toBe(2);
  });

  it('stops closing once the lowered limit is reached', async () => {
    const { registry, sessions } = await fourSessions();

    registry.setLimit(3);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(3);
  });

  it('lets a raised limit keep more sessions live than the constructor ceiling', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    registry.setLimit(CEILING + 1);
    const { adapter, sessions } = fakeAdapter();

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(sessions.every((s) => s.closes === 0)).toBe(true);
    expect(registry.liveCount).toBe(CEILING + 1);
  });

  it('hands the ceiling back to the constructor value on setLimit(null)', async () => {
    vi.useFakeTimers();
    const registry = new AgentSessionRegistry(CEILING);
    const { adapter, sessions } = fakeAdapter();
    registry.setLimit(2);
    registry.setLimit(null);

    for (let i = 0; i < CEILING; i += 1) {
      registry.startTurn(`run-${i}`, adapter, INPUT, noop);
      await at(sessions, i).endTurn();
      vi.advanceTimersByTime(1_000);
    }
    vi.advanceTimersByTime(RECENTLY_USED_MS + 1_000);
    registry.startTurn('run-new', adapter, INPUT, noop);

    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.liveCount).toBe(CEILING);
  });

  it('reports the automatic ceiling until a limit is set, then the user’s limit', () => {
    const registry = new AgentSessionRegistry(CEILING);

    expect(registry.config).toMatchObject({
      limit: null,
      automaticLimit: CEILING,
    });
    registry.setLimit(5);
    expect(registry.config).toMatchObject({
      limit: 5,
      automaticLimit: CEILING,
    });
    registry.setLimit(null);
    expect(registry.config).toMatchObject({
      limit: null,
      automaticLimit: CEILING,
    });
  });
});

describe('AgentSessionRegistry — a folder whose MCP servers changed', () => {
  it('runs the next turn on a NEW process, not the one that read the old config', async () => {
    // THE REPORTED DEFECT: "usually when I update MCP they are available from
    // the very next turn; here it did not see they were updated". A CLI reads
    // its MCP configuration once, at spawn, and this registry keeps that
    // process across a chat's turns — so a server switched on or signed in to
    // reached the config and never reached the running agent. The agent said so
    // itself in the transcript: "the connector may need the session restarted".
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const first = at(sessions, 0);
    await first.endTurn();

    expect(
      registry.markStale('claude', '/proj', 'its MCP servers changed', 'mcp'),
    ).toBe(1);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
  });

  it('marks rather than closes, so a running turn is never killed for it', async () => {
    // The whole reason this is a flag and not a `close`. A change can land
    // while a turn is in flight, and closing there destroys work the user
    // asked for — while a folder holding a dozen idle chats would cost a dozen
    // respawns, each re-launching the user's own MCP servers, for turns nobody
    // sent. The next turn is both the correct moment and the only one that
    // costs anything.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);

    registry.markStale('claude', '/proj', 'its MCP servers changed', 'mcp');

    expect(at(sessions, 0).closes).toBe(0);
    expect(registry.liveCount).toBe(1);
  });

  it('leaves another folder’s sessions alone', async () => {
    // A change is about ONE folder: a CLI resolves project servers relative to
    // the directory it runs in, so retiring every session would respawn chats
    // whose configuration did not move.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(
      registry.markStale('claude', '/somewhere-else', 'changed', 'mcp'),
    ).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
  });

  it('leaves another AGENT’s sessions alone in the same folder', async () => {
    // One folder is routinely used by both CLIs, and they read different
    // configuration files — the same rule `SkillHarvestStore` keys by.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.markStale('cursor-agent', '/proj', 'changed', 'mcp')).toBe(
      0,
    );
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
  });

  it('retires a session ONCE, however many changes land before its next turn', async () => {
    // Toggling three servers before typing is one respawn, not three — and the
    // count each caller logs must not claim sessions it did not newly retire.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();

    expect(registry.markStale('claude', '/proj', 'first', 'mcp')).toBe(1);
    expect(registry.markStale('claude', '/proj', 'second', 'mcp')).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
  });

  it('lists every live kept process with the agent, folder and profile it was spawned for, and drops a dead one at once', async () => {
    const registry = new AgentSessionRegistry(8);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, { ...INPUT, configDir: '/p/a' }, noop);
    registry.startTurn('run-2::call:call-3', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await at(sessions, 1).endTurn();

    expect(
      registry
        .liveSessions()
        .map(({ key, agent, cwd, configDir, session }) => ({
          key,
          agent,
          cwd,
          configDir,
          same: session === at(sessions, key === 'run-1' ? 0 : 1),
        })),
    ).toEqual([
      {
        key: 'run-1',
        agent: 'claude',
        cwd: '/proj',
        configDir: '/p/a',
        same: true,
      },
      {
        key: 'run-2::call:call-3',
        agent: 'claude',
        cwd: '/proj',
        configDir: null,
        same: true,
      },
    ]);

    at(sessions, 0).die();

    expect(registry.liveSessions().map((kept) => kept.key)).toEqual([
      'run-2::call:call-3',
    ]);
  });

  it('retires exactly the sessions a reach predicate names, by folder and profile', async () => {
    // A pinned ceiling above the three sessions: the default is derived from
    // the machine's memory, and a CI runner's evicts one and spawns a fifth.
    const registry = new AgentSessionRegistry(8);
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, { ...INPUT, configDir: '/p/a' }, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);
    registry.startTurn('run-3', adapter, { ...INPUT, cwd: '/other' }, noop);
    await at(sessions, 0).endTurn();
    await at(sessions, 1).endTurn();
    await at(sessions, 2).endTurn();

    expect(registry.cwdsOf('claude').sort()).toEqual(['/other', '/proj']);
    expect(
      registry.markStaleWhere(
        'claude',
        (session) => session.cwd === '/proj' && session.configDir === '/p/a',
        'signed in',
        'mcp',
      ),
    ).toBe(1);
    registry.startTurn('run-1', adapter, { ...INPUT, configDir: '/p/a' }, noop);
    registry.startTurn('run-2', adapter, INPUT, noop);

    expect(sessions).toHaveLength(4);
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
  });

  it('retires an AGENT’s sessions in every folder when its account changes', async () => {
    // A sign-in or sign-out changes the credentials every process of that CLI
    // started under, whatever folder it runs in.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    registry.startTurn('run-2', adapter, { ...INPUT, cwd: '/other' }, noop);
    await at(sessions, 0).endTurn();
    await at(sessions, 1).endTurn();

    expect(
      registry.markAgentStale('cursor-agent', 'signed in', 'account'),
    ).toBe(0);
    expect(registry.markAgentStale('claude', 'signed in', 'account')).toBe(2);
    expect(
      registry.markAgentStale('claude', 'signed in again', 'account'),
    ).toBe(0);
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(3);
    expect(at(sessions, 0).closes).toBe(1);
  });

  it('retires ONE key: its next turn runs on a new process, every other key keeps its own', async () => {
    // A carried compaction replaces a conversation, and the kept process still
    // holds the session it replaced — a later turn would be opened on it.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1::node:a', adapter, INPUT, noop);
    registry.startTurn('run-1::node:b', adapter, INPUT, noop);
    await at(sessions, 0).endTurn();
    await at(sessions, 1).endTurn();

    expect(
      registry.retire('run-1::node:a', 'its conversation was compacted'),
    ).toBe(true);
    // A mark, not a close: nothing the process started is killed until then.
    expect(at(sessions, 0).closes).toBe(0);
    registry.startTurn('run-1::node:a', adapter, INPUT, noop);
    registry.startTurn('run-1::node:b', adapter, INPUT, noop);

    expect(sessions).toHaveLength(3);
    expect(at(sessions, 0).closes).toBe(1);
    expect(at(sessions, 1).closes).toBe(0);
    expect(registry.retire('run-1::node:none', 'nothing here')).toBe(false);
  });
});

describe('AgentSessionRegistry — a stale process still running background work', () => {
  const FIGMA = 'claude.ai Figma is connected now';

  /** One run whose first turn has settled, and a sink that keeps its events. */
  async function settledRun(): Promise<{
    registry: AgentSessionRegistry;
    adapter: AgentAdapter;
    sessions: FakeSession[];
    first: FakeSession;
    events: AgentEvent[];
    onEvent: (event: AgentEvent) => void;
  }> {
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const first = at(sessions, 0);
    await first.endTurn();
    const events: AgentEvent[] = [];
    return {
      registry,
      adapter,
      sessions,
      first,
      events,
      onEvent: (event) => events.push(event),
    };
  }

  const notices = (events: AgentEvent[]) =>
    events.filter(
      (e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice',
    );

  it('serves the turn on the process running a command, keeps it stale, and replaces it once the command ends', async () => {
    // REPORTED as dev servers dying at the start of a turn: an MCP sign-in had
    // marked the session stale, and the replacement SIGTERMed the commands the
    // agent left running in the background — with nothing telling it so.
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.shellsRunning = 1;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(1);
    expect(first.closes).toBe(0);
    expect(first.turns).toBe(2);
    // Told, in the transcript and in the agent's own prompt, what waits.
    expect(notices(events)).toEqual([
      expect.objectContaining({ severity: 'info' }),
    ]);
    expect(notices(events)[0]!.message).toContain(FIGMA);
    const prompt = at(first.inputs, 1).prompt;
    expect(prompt).toMatch(/^p\n\n<geniro-note>\n/);
    expect(prompt).toContain(FIGMA);
    expect(prompt).toContain('still loaded');

    // Still stale: the first turn that starts with nothing running replaces it.
    await first.endTurn();
    first.shellsRunning = 0;
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
    expect(at(at(sessions, 1).inputs, 0).prompt).toBe('p');
  });

  it('also waits while the process is parked on a question', async () => {
    const { registry, adapter, sessions, first } = await settledRun();
    first.parked = true;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
    expect(first.closes).toBe(0);
  });

  it('does not wait for an account change, and tells the agent which commands that stopped', async () => {
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.shellsRunning = 2;
    first.runningCommands = ['pnpm dev', 'pnpm test --watch'];
    registry.markAgentStale('claude', 'you signed in', 'account');

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
    expect(notices(events)).toEqual([
      expect.objectContaining({ severity: 'warning' }),
    ]);
    const notice = notices(events)[0]!.message;
    expect(notice).toContain('- pnpm dev');
    expect(notice).toContain('- pnpm test --watch');
    const prompt = at(at(sessions, 1).inputs, 0).prompt;
    expect(prompt).toContain('- pnpm dev');
    expect(prompt).toContain('- pnpm test --watch');
  });

  it('lets a compaction after an MCP change replace the process even with a command running', async () => {
    // The MCP mark may wait; the conversation the old process holds was just
    // replaced, so a turn on it would continue the wrong one.
    const { registry, adapter, sessions, first } = await settledRun();
    first.shellsRunning = 1;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');
    registry.retire('run-1', 'its conversation was compacted');

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
  });

  it('says nothing of a command a delegate still waits on when it replaces the process', async () => {
    // It keeps the process from being reaped, but the agent did not leave it
    // running: telling it to start the command again would be wrong.
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.refuse = true;
    first.shellsRunning = 1;
    first.waitedOnCommands = 1;

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(2);
    expect(notices(events)).toEqual([]);
    expect(at(at(sessions, 1).inputs, 0).prompt).not.toContain('<geniro-note>');
  });

  it('names the stopped commands when a process that cannot serve the turn is replaced', async () => {
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.refuse = true;
    first.shellsRunning = 2;
    first.runningCommands = ['pnpm dev'];

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
    const notice = notices(events)[0]!.message;
    expect(notice).toContain('it could not serve the next turn');
    expect(notice).toContain('- pnpm dev');
    expect(notice).toContain('- and 1 whose command line was not reported');
    expect(at(at(sessions, 1).inputs, 0).prompt).toContain('- pnpm dev');
  });

  it('says nothing when the replaced process was running nothing', async () => {
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.refuse = true;

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(2);
    expect(notices(events)).toEqual([]);
    expect(at(at(sessions, 1).inputs, 0).prompt).toBe('p');
  });

  it('keeps a slash command intact rather than appending the note to it', async () => {
    const { registry, adapter, first } = await settledRun();
    first.shellsRunning = 1;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    const events: AgentEvent[] = [];
    const onEvent = (event: AgentEvent) => events.push(event);
    registry.startTurn(
      'run-1',
      adapter,
      { ...INPUT, prompt: '/compact' },
      onEvent,
    );

    expect(at(first.inputs, 1).prompt).toBe('/compact');

    // The agent was not told yet, so the next turn with words tells it — and
    // the row, already written, is not written twice.
    await first.endTurn();
    registry.startTurn('run-1', adapter, INPUT, onEvent);
    expect(at(first.inputs, 2).prompt).toContain(FIGMA);
    expect(events.filter((e) => e.type === 'notice')).toHaveLength(1);
  });

  it('also waits while the process is still producing rows between turns', async () => {
    // Off-turn work with no detached command: a delegate reporting back, a
    // continuation the agent opened for itself.
    // Its own run: the off-turn sink is only wired for a turn that names one.
    const registry = new AgentSessionRegistry();
    const { adapter, sessions } = fakeAdapter();
    registry.startTurn('run-1', adapter, INPUT, noop, undefined, noop);
    const first = at(sessions, 0);
    await first.endTurn();
    first.emitBetweenTurn('d1');
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(1);
    expect(first.closes).toBe(0);
  });

  it('names every MCP change that waited, and counts an account change landing on one', async () => {
    const { registry, adapter, first } = await settledRun();
    first.shellsRunning = 1;
    expect(registry.markStale('claude', '/proj', FIGMA, 'mcp')).toBe(1);
    expect(
      registry.markStale('claude', '/proj', 'you signed in to Linear', 'mcp'),
    ).toBe(0);

    registry.startTurn('run-1', adapter, INPUT, noop);
    const prompt = at(first.inputs, 1).prompt;
    expect(prompt).toContain(FIGMA);
    expect(prompt).toContain('you signed in to Linear');

    await first.endTurn();
    expect(registry.markAgentStale('claude', 'you signed out', 'account')).toBe(
      1,
    );
  });

  it('tells the next turn what a Retry close stopped, holding the line past a turn with no prompt', async () => {
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];

    registry.close('run-1', 'its turn was retried');
    registry.startTurn(
      'run-1',
      adapter,
      { ...INPUT, prompt: '', resumeOnly: true },
      onEvent,
    );

    // The row is written with the first turn; the agent hears nothing yet.
    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]!.message).toContain('its turn was retried');
    const resumed = at(sessions, 1);
    expect(at(resumed.inputs, 0).prompt).toBe('');

    await resumed.endTurn();
    registry.startTurn('run-1', adapter, INPUT, onEvent);
    expect(at(resumed.inputs, 1).prompt).toContain('- pnpm dev');
    expect(notices(events)).toHaveLength(1);

    await resumed.endTurn();
    registry.startTurn('run-1', adapter, INPUT, onEvent);
    expect(at(resumed.inputs, 2).prompt).toBe('p');
  });

  it('owes nothing after a teardown closes the run', async () => {
    const { registry, adapter, first, events, onEvent } = await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];

    registry.closeRun('run-1');
    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(notices(events)).toEqual([]);
  });

  it('owes nothing for a finished card’s own close, and keeps what an earlier close owed', async () => {
    // A card in Done whose run the user presses Run on again starts a turn on
    // this key: the commands its finished work left running were ended on
    // purpose, and the turn must not read them as cut off — but a watcher an
    // eviction stopped while the card was in review is still news to it.
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm test --watch'];
    registry.close('run-1', 'the session ceiling was reached');
    registry.startTurn(
      'run-1',
      adapter,
      { ...INPUT, prompt: '', resumeOnly: true },
      onEvent,
    );
    const resumed = at(sessions, 1);
    await resumed.endTurn();
    resumed.shellsRunning = 1;
    resumed.runningCommands = ['pnpm dev'];
    const written = notices(events).length;

    await registry.closeFinishedRun('run-1');
    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(resumed.closeOptions).toEqual([{ graceful: true }]);
    expect(notices(events)).toHaveLength(written);
    const prompt = at(at(sessions, 2).inputs, 0).prompt;
    expect(prompt).toContain('- pnpm test --watch');
    expect(prompt).not.toContain('- pnpm dev');
  });

  it('reads the stopped commands through the real session wrapper', async () => {
    // The fakes above set `runningCommands` directly; this is the adapter's
    // own wrapper over `runCliSession`, so a getter it failed to forward
    // would read as no commands at all.
    const { spawn, children } = recordingSpawn();
    const adapter = new SessionfulAdapter(spawn);
    const registry = new AgentSessionRegistry();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const child = at(children, 0);
    feed(child, { run: 't1', cmd: 'pnpm dev' });
    feed(child, { work: 'b1', call: 't1' });
    feed(child, { done: true });
    await settleRegistry();

    const events: AgentEvent[] = [];
    registry.close('run-1', 'its turn was retried');
    registry.startTurn('run-1', adapter, INPUT, (event) => events.push(event));

    expect(notices(events)).toHaveLength(1);
    expect(notices(events)[0]!.message).toContain('- pnpm dev');
  });

  it('keeps replacing after a compaction, whatever MCP change lands next', async () => {
    const { registry, adapter, sessions, first } = await settledRun();
    first.shellsRunning = 1;
    registry.retire('run-1', 'its conversation was compacted');
    expect(registry.markStale('claude', '/proj', FIGMA, 'mcp')).toBe(0);

    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(sessions).toHaveLength(2);
    expect(first.closes).toBe(1);
  });

  it('tells the agent about a waiting change once, and again when another change joins it', async () => {
    const { registry, adapter, first, events, onEvent } = await settledRun();
    first.shellsRunning = 1;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    registry.startTurn('run-1', adapter, INPUT, onEvent);
    await first.endTurn();
    registry.startTurn('run-1', adapter, INPUT, onEvent);
    await first.endTurn();

    expect(notices(events)).toHaveLength(1);
    expect(at(first.inputs, 2).prompt).toBe('p');

    registry.markStale('claude', '/proj', 'you signed in to Linear', 'mcp');
    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(notices(events)).toHaveLength(2);
    expect(at(first.inputs, 3).prompt).toContain('you signed in to Linear');
  });

  it('puts a stopped-commands line and a waiting change in ONE note', async () => {
    const { registry, adapter, sessions, first, onEvent } = await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];
    registry.close('run-1', 'its turn was retried');
    registry.startTurn(
      'run-1',
      adapter,
      { ...INPUT, prompt: '', resumeOnly: true },
      onEvent,
    );
    const resumed = at(sessions, 1);
    await resumed.endTurn();
    resumed.shellsRunning = 1;
    registry.markStale('claude', '/proj', FIGMA, 'mcp');

    registry.startTurn('run-1', adapter, INPUT, onEvent);

    const prompt = at(resumed.inputs, 1).prompt;
    expect(prompt.match(/<geniro-note>/g)).toHaveLength(1);
    expect(prompt).toContain('- pnpm dev');
    expect(prompt).toContain(FIGMA);
  });

  it('discards a note an earlier close owed once the run is torn down', async () => {
    const { registry, adapter, sessions, first, onEvent } = await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];
    registry.close('run-1', 'its turn was retried');
    registry.startTurn(
      'run-1',
      adapter,
      { ...INPUT, prompt: '', resumeOnly: true },
      onEvent,
    );
    await at(sessions, 1).endTurn();

    registry.closeRun('run-1');
    registry.startTurn('run-1', adapter, INPUT, noop);

    expect(at(at(sessions, 2).inputs, 0).prompt).toBe('p');
  });

  it('tells the next turn what died with a process that ended on its own', async () => {
    const { registry, adapter, sessions, first, events, onEvent } =
      await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];

    first.die();
    await first.closed;
    await settleRegistry();
    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(2);
    expect(notices(events)[0]!.message).toContain('ended on its own');
    expect(at(at(sessions, 1).inputs, 0).prompt).toContain('- pnpm dev');
  });

  it('keeps the owed line for the turn after a spawn that came up dead', async () => {
    const { registry, adapter, sessions, first, onEvent } = await settledRun();
    first.shellsRunning = 1;
    first.runningCommands = ['pnpm dev'];
    registry.close('run-1', 'its turn was retried');
    const dying = {
      ...adapter,
      startSession: (...args: Parameters<AgentAdapter['startSession']>) => {
        const session = adapter.startSession(...args) as FakeSession;
        session.spawnDead = true;
        return session;
      },
    } as unknown as AgentAdapter;

    registry.startTurn('run-1', dying, INPUT, onEvent);
    registry.startTurn('run-1', adapter, INPUT, onEvent);

    expect(sessions).toHaveLength(3);
    expect(at(at(sessions, 2).inputs, 0).prompt).toContain('- pnpm dev');
  });

  it('reads what died with a process that ended on its own through the real wrapper', async () => {
    const { spawn, children } = recordingSpawn();
    const adapter = new SessionfulAdapter(spawn);
    const registry = new AgentSessionRegistry();
    registry.startTurn('run-1', adapter, INPUT, noop);
    const child = at(children, 0);
    feed(child, { run: 't1', cmd: 'pnpm dev' });
    feed(child, { work: 'b1', call: 't1' });
    feed(child, { done: true });
    await settleRegistry();

    child.emit('close', null, 'SIGKILL');
    await settleRegistry();
    const events: AgentEvent[] = [];
    registry.startTurn('run-1', adapter, INPUT, (event) => events.push(event));

    const notice = notices(events)[0]!.message;
    expect(notice).toContain('ended on its own');
    expect(notice).toContain('- pnpm dev');
  });
});
