import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { simulateSleep } from '../../../__tests__/simulate-sleep';
import type { RunCallSeed } from '../../agents/chat.types';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { readCallSeed } from '../../agents/utils/call-seed';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import type { ItemKind } from '../../runs/runs.types';
import { errorOf } from '../__tests__/call-envelope';
import { member } from '../__tests__/team-builders';
import type {
  CalleePoolPlan,
  CalleeTurnOutcome,
  RunCallCapability,
  TeamMember,
} from '../teams.types';
import { poolMemberNode } from '../utils/agent-pool';
import {
  LEFT_RUNNING_COMMAND_MAX,
  PUBLISHED_ACTIONS_NOTE,
  PUBLISHED_PAGES_NOTE,
} from '../utils/callee-text';
import { callerKey } from '../utils/caller-key';
import { AWAIT_GAP_GRACE_MS, CallBroker } from './call-broker.service';
import { PoolCooldowns } from './pool-cooldowns.store';

const HELPER: TeamMember = member('helper', {
  name: 'Helper',
  instructions: 'You help.',
});

const WRITER: TeamMember = member('writer');

interface RecordedItem {
  memberId: string | null;
  kind: ItemKind;
  payload: Record<string, unknown>;
}

interface Deferred {
  resolve: (outcome: CalleeTurnOutcome) => void;
  reject: (err: Error) => void;
}

function harness(options?: {
  calleesOf?: Map<string, TeamMember[]>;
  cancelled?: boolean;
  /** 'defer' keeps every launch pending until resolved by the test. */
  launch?: 'instant' | 'defer' | 'throw';
  /** Node-liveness override; default: every member has a live turn. */
  isNodeLive?: (memberId: string) => boolean;
  /** Instant turns record no resumable session (thread continuation off). */
  noSession?: boolean;
  /** Whether a caller can be woken; default: never (the pre-wake behaviour). */
  wakeNode?: (memberId: string, prompt: string) => boolean;
  /** Whether a working caller takes a message; default: never. */
  tellLiveNode?: RunCallCapability['tellLiveNode'];
  /** The agents a user's message goes to — `orch` unless named. */
  messageTargets?: string[];
  /** What an earlier daemon's pass of the run left in the transcript. */
  seed?: RunCallSeed;
  /** Whether a running callee takes a message; default: yes, joining its turn. */
  messageCallee?: RunCallCapability['messageCallee'];
  /** Fields an INSTANT turn settles with instead of a clean completion. */
  instantOutcome?: Partial<CalleeTurnOutcome>;
  /** The caller CLI's tool-call deadline; default: none (unbounded waits). */
  toolCallDeadlineMs?: RunCallCapability['toolCallDeadlineMs'];
  /** The run's folder; default: none. */
  cwd?: string;
  /** The daemon-wide record of spent pool members; default: an empty one. */
  poolCooldowns?: PoolCooldowns;
  /** Whether a call conversation's process runs work; default: none does. */
  conversationHoldsWork?: RunCallCapability['conversationHoldsWork'];
  /** Each conversation's unread team notes; default: no team-note tools. */
  unreadTeamNotes?: RunCallCapability['unreadTeamNotes'];
  currentStage?: RunCallCapability['currentStage'];
}): {
  broker: CallBroker;
  capability: RunCallCapability;
  items: RecordedItem[];
  launches: {
    callee: TeamMember;
    message: string;
    callId: string;
    resumeSessionId: string | null;
    conversationId: string;
    pool?: CalleePoolPlan;
  }[];
  deferred: Deferred[];
  /** Call ids launched as WAKES, which skip the active-turn cap's queue. */
  wakes: string[];
  /** Every `turnBlocked` report, in order: [conversation, blocked]. */
  blockedReports: [string, boolean][];
  /** Call ids the broker asked the executor to stop, in order. */
  cancelledTurns: string[];
  /** Every message the broker handed to a running callee, in order. */
  messages: { callId: string; text: string }[];
} {
  const items: RecordedItem[] = [];
  const launches: {
    callee: TeamMember;
    message: string;
    callId: string;
    resumeSessionId: string | null;
    conversationId: string;
    pool?: CalleePoolPlan;
  }[] = [];
  const deferred: Deferred[] = [];
  const wakes: string[] = [];
  const blockedReports: [string, boolean][] = [];
  const cancelledTurns: string[] = [];
  const messages: { callId: string; text: string }[] = [];
  const mode = options?.launch ?? 'instant';
  const capability: RunCallCapability = {
    calleesOf: options?.calleesOf ?? new Map([['orch', [HELPER, WRITER]]]),
    ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
    launchCalleeTurn: (
      callee,
      message,
      callId,
      resumeSessionId,
      conversationId,
      launch,
    ) => {
      if (launch.wake) {
        wakes.push(callId);
      }
      launches.push({
        callee,
        message,
        callId,
        resumeSessionId,
        conversationId,
        ...(launch.pool !== undefined ? { pool: launch.pool } : {}),
      });
      if (mode === 'throw') {
        return Promise.reject(new Error('spawn exploded'));
      }
      if (mode === 'defer') {
        return new Promise<CalleeTurnOutcome>((resolve, reject) => {
          deferred.push({ resolve, reject });
        });
      }
      return Promise.resolve({
        status: 'completed',
        finalText: `done by ${callee.id}`,
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: options?.noSession ? null : `sess-${callId}`,
        ...options?.instantOutcome,
      });
    },
    persistItem: (memberId, kind, _role, payload) => {
      items.push({
        memberId,
        kind,
        payload: payload as Record<string, unknown>,
      });
    },
    isCancelled: () => options?.cancelled ?? false,
    isSuperseded: () => false,
    messageTargets: new Set(options?.messageTargets ?? ['orch']),
    toolCallDeadlineMs: options?.toolCallDeadlineMs ?? (() => null),
    // Modelled on the executor's own: a LIVE turn is cancelled and settles
    // `cancelled`, and the answer says whether one was signalled. A stub merely
    // recording the id would let the broker pass while the call it "cancelled"
    // went on running, which is the whole thing this tool has to do.
    cancelCalleeTurn: (callId) => {
      cancelledTurns.push(callId);
      const index = launches.findIndex((launch) => launch.callId === callId);
      const turn = index >= 0 ? deferred[index] : undefined;
      turn?.resolve({
        status: 'cancelled',
        finalText: null,
        error: 'cancelled by the calling agent',
        failureClass: null,
        resetsAt: null,
        sessionId: null,
      });
      return turn !== undefined;
    },
    // Modelled on the executor's: only a call whose turn has STARTED has a
    // process to write to — a launch that never happened is `not_started`.
    messageCallee:
      options?.messageCallee ??
      ((callId, text) => {
        if (!launches.some((launch) => launch.callId === callId)) {
          return { delivered: false, reason: 'not_started' };
        }
        messages.push({ callId, text });
        return { delivered: true, interrupts: false };
      }),
    isNodeLive: options?.isNodeLive ?? (() => true),
    turnBlocked: (caller, blocked) => {
      blockedReports.push([caller, blocked]);
    },
    wakeNode: options?.wakeNode ?? (() => false),
    tellLiveNode: options?.tellLiveNode ?? (() => false),
    ...(options?.unreadTeamNotes === undefined
      ? {}
      : { unreadTeamNotes: options.unreadTeamNotes }),
    ...(options?.conversationHoldsWork === undefined
      ? {}
      : { conversationHoldsWork: options.conversationHoldsWork }),
    ...(options?.currentStage === undefined
      ? {}
      : { currentStage: options.currentStage }),
  };
  const broker = new CallBroker(undefined, options?.poolCooldowns);
  broker.registerRun('run-1', capability, options?.seed ?? null);
  return {
    broker,
    capability,
    items,
    launches,
    deferred,
    wakes,
    blockedReports,
    cancelledTurns,
    messages,
  };
}

describe('CallBroker', () => {
  it('sync call: launches the callee and returns its text in an ok envelope', async () => {
    const { broker, items, launches } = harness();
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'summarize X',
    });
    expect(envelope).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done by helper' },
    });
    expect(launches).toEqual([
      {
        callee: HELPER,
        message: 'summarize X',
        callId: 'call-1',
        resumeSessionId: null,
        conversationId: 'call-1',
      },
    ]);
    // Transcript: call_started then call_result, both on the CALLER's member.
    expect(items.map((i) => [i.kind, i.memberId])).toEqual([
      ['call_started', 'orch'],
      ['call_result', 'orch'],
    ]);
    expect(items[0]!.payload).toMatchObject({
      callId: 'call-1',
      calleeNodeId: 'helper',
      mode: 'sync',
      message: 'summarize X',
    });
    expect(items[1]!.payload).toMatchObject({
      callId: 'call-1',
      status: 'ok',
      // The settled thread's CLI session rides the call_result item — the
      // UI's handle for opening a terminal on THIS thread.
      sessionId: 'sess-call-1',
    });
  });

  it('carries the caller’s title onto the call_started item', async () => {
    const { broker, items } = harness();
    await broker.callAgent('run-1', 'orch', {
      agent: 'helper',
      message: 'summarize X',
      title: 'Get concrete UAT links from the DB',
    });
    const started = items.find((i) => i.kind === 'call_started')!;
    expect(started.payload.title).toBe('Get concrete UAT links from the DB');
  });

  it('resolves the callee by display name and refuses names off the call wiring', async () => {
    const { broker } = harness();
    const byName = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'Helper',
      message: 'm',
    });
    expect(byName.status).toBe('ok');
    const unknown = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'stranger',
      message: 'm',
    });
    expect(unknown.status).toBe('error');
    expect(errorOf(unknown)).toContain('UNKNOWN_AGENT');
    expect(errorOf(unknown)).toContain('Helper'); // the callable members are named back
  });

  it('an ambiguous display name resolves nothing instead of guessing', async () => {
    const twin: TeamMember = { ...WRITER, id: 'writer-2', name: 'Twin' };
    const twin2: TeamMember = {
      ...WRITER,
      id: 'writer-3',
      name: 'Twin',
    };
    const { broker } = harness({
      calleesOf: new Map([['orch', [twin, twin2]]]),
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'Twin',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('UNKNOWN_AGENT');
    // The exact id still works.
    const byId = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer-2',
      message: 'm',
    });
    expect(byId.status).toBe('ok');
  });

  it('lets any member call any other', async () => {
    const orch = member('orch', { name: 'Manager' });
    const team = [orch, HELPER, WRITER];
    const { broker, launches } = harness({
      calleesOf: new Map(
        team.map((m) => [m.id, team.filter((other) => other.id !== m.id)]),
      ),
    });

    for (const [caller, agent] of [
      ['orch', 'writer'],
      ['helper', 'writer'],
      ['writer', 'helper'],
    ] as const) {
      const envelope = await broker.callAgent('run-1', caller, {
        title: 'ask',
        agent,
        message: 'm',
      });
      expect(envelope.status, `${caller} → ${agent}`).toBe('ok');
    }
    expect(launches.map((l) => l.callee.id)).toEqual([
      'writer',
      'writer',
      'helper',
    ]);
  });

  it('refuses a call to a member already waiting in the caller chain', async () => {
    const orch = member('orch', { name: 'Manager' });
    const team = [orch, HELPER, WRITER];
    const { broker, launches } = harness({
      launch: 'defer',
      calleesOf: new Map(
        team.map((m) => [m.id, team.filter((other) => other.id !== m.id)]),
      ),
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    await broker.callAgent('run-1', callerKey('helper', 'call-1'), {
      title: 'research',
      agent: 'writer',
      message: 'm',
      mode: 'async',
    });

    const toManager = await broker.callAgent(
      'run-1',
      callerKey('writer', 'call-2'),
      { title: 'ask', agent: 'orch', message: 'm' },
    );
    const toHelper = await broker.callAgent(
      'run-1',
      callerKey('writer', 'call-2'),
      { title: 'ask', agent: 'helper', message: 'm' },
    );

    expect(errorOf(toManager)).toBe(
      'CALL_UP_THE_CHAIN: Manager is waiting on your answer (Manager → Helper → you; call-1), so calling it now would wait on itself. Answer by finishing this turn — put what you need from Manager in your reply.',
    );
    expect(errorOf(toHelper)).toContain(
      'CALL_UP_THE_CHAIN: Helper is waiting on your answer',
    );
    expect(launches.map((l) => l.callId)).toEqual(['call-1', 'call-2']);
  });

  it('lets a member briefed fire-and-forget call the one that briefed it, and those above', async () => {
    const orch = member('orch', { name: 'Manager' });
    const team = [orch, HELPER, WRITER];
    const { broker, launches } = harness({
      launch: 'defer',
      calleesOf: new Map(
        team.map((m) => [m.id, team.filter((other) => other.id !== m.id)]),
      ),
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    await broker.callAgent('run-1', callerKey('helper', 'call-1'), {
      title: 'notes',
      agent: 'writer',
      message: 'm',
      mode: 'fire_and_forget',
    });

    const toHelper = await broker.callAgent(
      'run-1',
      callerKey('writer', 'call-2'),
      { title: 'ask', agent: 'helper', message: 'm', mode: 'async' },
    );
    const toManager = await broker.callAgent(
      'run-1',
      callerKey('writer', 'call-2'),
      { title: 'ask', agent: 'orch', message: 'm', mode: 'async' },
    );

    expect(toHelper.status).toBe('ok');
    expect(toManager.status).toBe('ok');
    expect(launches.map((l) => l.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4',
    ]);
  });

  it('lets a member call one that waited on it once that call has settled', async () => {
    const orch = member('orch', { name: 'Manager' });
    const team = [orch, HELPER];
    const { broker } = harness({
      calleesOf: new Map(
        team.map((m) => [m.id, team.filter((other) => other.id !== m.id)]),
      ),
    });
    const first = await broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'm',
    });
    expect(first.status).toBe('ok');

    const back = await broker.callAgent('run-1', 'helper', {
      title: 'ask',
      agent: 'orch',
      message: 'm',
    });

    expect(back.status).toBe('ok');
  });

  it('a caller with no other member to call gets UNKNOWN_AGENT (callable: none)', async () => {
    const { broker } = harness();
    const envelope = await broker.callAgent('run-1', 'lonely', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('callable: none');
  });

  it('async call returns a call_id at once; await_agent collects exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(started).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'started' },
    });
    const awaiting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    const collected = await awaiting;
    expect(collected).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'async done' },
    });
    expect(items.map((i) => i.kind)).toEqual([
      'call_started',
      'call_result',
      'await_collected',
    ]);
    // A second collect finds nothing — the result was consumed.
    const again = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(again)).toContain('UNKNOWN_CALL');
  });

  it('an ABANDONED collection consumes nothing — the retry still gets the result', async () => {
    // MEASURED on the reporter's own run: the claude CLI aborted its own
    // `await_agent` fetch after 338s, the callee finished 28s later ($7.03 of
    // work), the broker consumed the entry into that dead request — writing
    // `await_collected` — and the retry was told UNKNOWN_CALL. The turn was
    // then unreachable for the rest of the run and the caller re-issued the
    // whole call from scratch.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort(); // the request's socket closes while the callee works on
    expect(errorOf(await abandoned)).toContain('AWAIT_ABANDONED');

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing was collected, so nothing was written — the entry is intact.
    expect(items.map((i) => i.kind)).toEqual(['call_started', 'call_result']);
    const retry = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(retry).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'async done' },
    });
    expect(items.map((i) => i.kind)).toContain('await_collected');
  });

  it('a timed-out collection answers pending and consumes nothing — the caller comes back for it', async () => {
    // The whole point of the argument: a caller that does not want to block for
    // the callee's full run can stop waiting and go do something else, and the
    // work is still there when it returns. `pending` rather than an error,
    // because nothing went wrong — an error arm here is what would have a model
    // abandon or re-issue a call that is running perfectly well.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 1,
      }),
    ).toEqual({ status: 'pending', call_id: 'call-1', agent: 'helper' });
    // Nothing consumed: no receipt, and the entry is still the caller's.
    expect(items.map((i) => i.kind)).toEqual(['call_started']);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'the build passed',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'the build passed' },
    });
    expect(items.map((i) => i.kind)).toContain('await_collected');
  });

  it('a window the callee finishes inside returns the RESULT, not pending', async () => {
    // The other half of the same argument, and the one a deadline written as a
    // plain race would break: the timer must not win over an outcome that is
    // already there, or every bounded await would report `pending` about a
    // callee that had answered.
    const { broker } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 60_000,
      }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done by helper' },
    });
  });

  it('an ABANDONED request outranks its own deadline', async () => {
    // Both races can be won in the same tick, and they mean opposite things:
    // `pending` is an answer to somebody, and there is nobody left to give it
    // to. Reporting it into a dead socket would also be the one shape that
    // looks, from the outside, exactly like the abandonment bug being back.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1', timeout_ms: 1 },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await abandoned)).toContain('AWAIT_ABANDONED');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).not.toContain('await_collected');
  });

  it('a collection abandoned AFTER the callee settled still leaves it collectable', async () => {
    // The race the fix is really about: the outcome and the abort land in the
    // same tick, so a check written only at entry would sail past it and
    // consume anyway.
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const abandoned = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort();
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await abandoned;
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).not.toContain('await_collected');
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' })).status,
    ).toBe('ok');
  });

  it('two concurrent await_agent waiters on one async call still collect exactly once', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The caller awaits the same call twice in parallel (a batched pair of
    // await_agent tool calls, or a client-side MCP timeout retry while the
    // first await is still blocked server-side). Collection must stay
    // exactly-once — the same contract the sequential re-await already gets
    // (UNKNOWN_CALL: "no un-collected async call").
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'async done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    const envelopes = await Promise.all([first, second]);
    const okCount = envelopes.filter((e) => e.status === 'ok').length;
    const unknownCount = envelopes.filter(
      (e) => e.status === 'error' && e.error.includes('UNKNOWN_CALL'),
    ).length;
    // One waiter collects the result; the other is told the call is no
    // longer un-collected — never two fresh collections of one result.
    expect(okCount).toBe(1);
    expect(unknownCount).toBe(1);
    // The transcript records the collection once, not once per waiter.
    expect(items.filter((i) => i.kind === 'await_collected')).toHaveLength(1);
  });

  it("await_agent refuses another caller's call id", async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const stolen = await broker.awaitAgent('run-1', 'writer', {
      call_id: 'call-1',
    });
    expect(errorOf(stolen)).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('fire_and_forget detaches: transcript only, never awaitable', async () => {
    const { broker, items } = harness();
    const detached = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'fire_and_forget',
    });
    expect(detached).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'detached' },
    });
    // The instant capability already settled the turn — after the microtask
    // chain drains, the result is on the transcript record.
    await new Promise((resolve) => setImmediate(resolve));
    expect(items.map((i) => i.kind)).toContain('call_result');
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(collected)).toContain('UNKNOWN_CALL');
  });

  it('caps the call chain at depth 3', async () => {
    // a→b→c→d is depth 3 (legal); d calling e would be depth 4.
    const node = (id: string): TeamMember => member(id);
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['a', [node('b')]],
        ['b', [node('c')]],
        ['c', [node('d')]],
        ['d', [node('e')]],
      ]),
    });
    const p1 = broker.callAgent('run-1', 'a', {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    const p2 = broker.callAgent('run-1', 'b', {
      title: 'why',
      agent: 'c',
      message: 'm',
    });
    const p3 = broker.callAgent('run-1', 'c', {
      title: 'why',
      agent: 'd',
      message: 'm',
    });
    const refused = await broker.callAgent('run-1', 'd', {
      title: 'why',
      agent: 'e',
      message: 'm',
    });
    expect(refused.status).toBe('error');
    expect(errorOf(refused)).toContain('DEPTH_LIMIT');
    for (const d of deferred) {
      d.resolve({
        status: 'completed',
        finalText: '',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: null,
      });
    }
    await Promise.all([p1, p2, p3]);
  });

  it('never caps how many calls a run makes in total', async () => {
    // A coordinator works BY calling: a per-pass count cap (50) once refused a
    // Manager's next call mid-task while only a handful were ever live.
    const { broker } = harness();
    for (let i = 0; i < 60; i++) {
      const envelope = await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: `call ${i}`,
        mode: 'fire_and_forget',
      });
      expect(envelope.status).toBe('ok');
    }
  });

  it('maps callee failure and cancellation into error envelopes', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const failing = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'exit 1',
      failureClass: 'crashed',
      resetsAt: null,
      sessionId: null,
    });
    expect(errorOf(await failing)).toContain('CALLEE_FAILED[crashed]: exit 1');

    const cancelled = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    deferred[1]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(errorOf(await cancelled)).toContain('CALLEE_CANCELLED');
  });

  it('wraps a throwing launch in CALL_FAILED instead of rejecting', async () => {
    const { broker } = harness({ launch: 'throw' });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('CALL_FAILED: spawn exploded');
  });

  it('refuses calls for unregistered runs and cancelled runs', async () => {
    const { broker } = harness({ cancelled: true });
    const cancelled = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(errorOf(cancelled)).toContain('RUN_CANCELLED');

    broker.unregisterRun('run-1');
    expect(broker.hasRun('run-1')).toBe(false);
    const gone = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(errorOf(gone)).toContain('RUN_NOT_ACTIVE');
    const goneAwait = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(goneAwait)).toContain('RUN_NOT_ACTIVE');
  });

  it('drops a run\u2019s state when the RUN is destroyed, off the bus', () => {
    // The executor unregisters on its own delete; this covers the purge it
    // never sees — the retention sweep, which destroys an archived team run
    // from the module BELOW this one and can only announce it. Without the
    // subscription a swept run left its capability, its uncollected results and
    // any parked question's timer behind for the life of the daemon.
    const bus = new AgentEventBus();
    const broker = new CallBroker(bus);
    broker.onModuleInit();
    broker.registerRun('run-1', harness().capability);
    expect(broker.hasRun('run-1')).toBe(true);

    bus.publishRunDeleted('run-1');

    expect(broker.hasRun('run-1')).toBe(false);
  });

  it('listCallees exposes the wiring the tool description advertises', () => {
    const { broker } = harness();
    expect(broker.listCallees('run-1', 'orch').map((c) => c.id)).toEqual([
      'helper',
      'writer',
    ]);
    expect(broker.listCallees('run-1', 'nobody')).toEqual([]);
    expect(broker.listCallees('run-9', 'orch')).toEqual([]);
  });
});

describe('CallBroker — parked questions (M4)', () => {
  function park(
    broker: CallBroker,
    overrides: {
      callId?: string;
      ttlMs?: number;
      deliver?: (answer: string) => boolean;
      fail?: () => void;
    } = {},
  ): { delivered: string[]; failed: { count: number } } {
    const delivered: string[] = [];
    const failed = { count: 0 };
    const parked = broker.parkQuestion('run-1', overrides.callId ?? 'call-1', {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: { questions: [{ question: 'Which color?' }] },
      ttlMs: overrides.ttlMs,
      deliver:
        overrides.deliver ??
        ((answer) => {
          delivered.push(answer);
          return true;
        }),
      fail:
        overrides.fail ??
        (() => {
          failed.count += 1;
        }),
    });
    expect(parked).toBe(true);
    return { delivered, failed };
  }

  it('a sync call parks: the caller gets the question envelope early, answers, and collects the final result via await_agent', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { delivered } = park(broker);
    expect(await sync).toEqual({
      status: 'question',
      call_id: 'call-1',
      agent: 'helper',
      question: 'Which color?',
      options: ['Red', 'Blue'],
    });
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'Blue',
    });
    expect(answered).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', state: 'answered' },
    });
    expect(delivered).toEqual(['Blue']);
    const awaiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'chose blue',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(await awaiting).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'chose blue' },
    });
    expect(items.map((i) => i.kind)).toEqual([
      'call_started',
      'call_question',
      'call_answer',
      'call_result',
      'await_collected',
    ]);
    expect(items[1]!.payload).toMatchObject({
      callId: 'call-1',
      callerNodeId: 'orch',
      calleeNodeId: 'helper',
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: { questions: [{ question: 'Which color?' }] },
    });
    expect(items[2]!.payload).toMatchObject({
      answer: 'Blue',
      outcome: 'answered',
    });
  });

  it('await_agent diverts to the question envelope WITHOUT consuming the call — a later await collects the final', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The await is already blocking when the question parks — it must divert.
    const awaiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    park(broker);
    const question = await awaiting;
    expect(question.status).toBe('question');
    broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'Red' });
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'ok',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await second).status).toBe('ok');
  });

  it('a question from ANOTHER call reaches a caller blocked awaiting a different call, and both calls stay collectable', async () => {
    // Run 51c646fb: the Manager sat in await_agent(call-5) while call-7's
    // callee asked it something; only an await on call-7 could deliver it, so
    // the question expired five minutes later as QUESTION_TIMEOUT.
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
      mode: 'async',
    });
    const awaitingFirst = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    park(broker, { callId: 'call-2' });
    expect(await awaitingFirst).toEqual({
      status: 'question',
      call_id: 'call-2',
      agent: 'writer',
      question: 'Which color?',
      options: ['Red', 'Blue'],
      still_running: 'call-1',
    });
    expect(
      broker.answerAgent('run-1', 'orch', { call_id: 'call-2', answer: 'Red' })
        .status,
    ).toBe('ok');
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'one',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await first).status).toBe('ok');
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'two',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await second).status).toBe('ok');
  });

  it('a sync call whose wait is diverted by another call’s question becomes await-collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
    });
    park(broker, { callId: 'call-1' });
    expect(await sync).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    const collected = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
    });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(await collected).toEqual({
      status: 'ok',
      result: { call_id: 'call-2', agent: 'writer', text: 'written' },
    });
  });

  it('a working caller waiting on no call is handed the question in its running turn', async () => {
    const prompts: { memberId: string; prompt: string }[] = [];
    const { broker, items } = harness({
      launch: 'defer',
      tellLiveNode: (memberId, prompt) => {
        prompts.push({ memberId, prompt });
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.memberId).toBe('orch');
    expect(prompts[0]!.prompt).toContain('while you work');
    expect(prompts[0]!.prompt).toContain(
      'answer_agent(call_id: "call-1", answer: ...)',
    );
    expect(
      items.some(
        (i) =>
          i.kind === 'system' &&
          String(i.payload.message).includes("Helper's question in call-1"),
      ),
    ).toBe(true);
  });

  it('a question asked BETWEEN two waits is handed to the next wait on another call — once', async () => {
    // Run 51c646fb, again: call-10's callee asked at 16:07:32 while the Manager
    // was between awaits; its next `await_agent(call-11, 300000)` began at
    // 16:10:01 and call-10 expired at 16:12:32, the question never shown.
    const { broker, deferred } = harness({ launch: 'defer' });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    park(broker, { callId: 'call-1' });

    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    // Handed over once: the caller has seen it, so its next wait is a wait.
    const next = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
      timeout_ms: 10,
    });
    expect(await next).toMatchObject({ status: 'pending', call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' })).status,
    ).toBe('ok');
  });

  it('an await that timed out stops listening: a later question from another call still reaches the working caller', async () => {
    // A caller polling with `timeout_ms` left its waiter registered; the next
    // question from ANOTHER call was handed to that dead reply and marked
    // delivered, so nothing else ever showed it.
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 5,
      }),
    ).toMatchObject({ status: 'pending' });

    park(broker, { callId: 'call-2' });

    expect(told).toHaveLength(1);
    expect(told[0]).toContain('call-2');
    // …and, being undelivered as an envelope, the next wait still gets it.
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'question', call_id: 'call-2' });
  });

  it('a SYNC call started after another call’s question parked gets that question and stays collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker, { callId: 'call-1' });
    expect(
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'writer',
        message: 'm',
      }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
    const collected = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await collected).status).toBe('ok');
  });

  it('a SYNC call handed another call’s question restarts that question’s window', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const { failed } = park(broker, { callId: 'call-1', ttlMs: 60 });
      await vi.advanceTimersByTimeAsync(45);
      expect(
        await broker.callAgent('run-1', 'orch', {
          title: 'why',
          agent: 'writer',
          message: 'm',
        }),
      ).toMatchObject({ status: 'question', call_id: 'call-1' });
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.count).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an ABANDONED sync call stops listening and stays collectable', async () => {
    const told: string[] = [];
    const { broker, deferred } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const sync = broker.callAgent(
      'run-1',
      'orch',
      { title: 'why', agent: 'writer', message: 'm' },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await sync)).toContain('AWAIT_ABANDONED');

    park(broker, { callId: 'call-1' });
    expect(told).toHaveLength(1);

    // A message into a running turn is not a seen envelope, so the next wait
    // still hands the question over before it collects.
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
    ).toMatchObject({ status: 'question', call_id: 'call-1' });
    const collected = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'written',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await collected).status).toBe('ok');
  });

  it('an ABANDONED await stops listening too: a later question still reaches the working caller', async () => {
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    const gone = new AbortController();
    const awaiting = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort();
    expect(errorOf(await awaiting)).toContain('AWAIT_ABANDONED');

    park(broker, { callId: 'call-2' });

    expect(told).toHaveLength(1);
  });

  it('writes no "passed" row when the working caller could not take the message', async () => {
    const { broker, items } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    park(broker);
    expect(
      items.some((i) =>
        String(i.payload.message).includes("Helper's question in call-1"),
      ),
    ).toBe(false);
  });

  it('a question handed to a later wait gets its full window from that delivery', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      for (const agent of ['helper', 'writer']) {
        await broker.callAgent('run-1', 'orch', {
          title: 'why',
          agent,
          message: 'm',
          mode: 'async',
        });
      }
      const { failed } = park(broker, { callId: 'call-1', ttlMs: 60 });
      await vi.advanceTimersByTimeAsync(45);
      expect(
        await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
      ).toMatchObject({ status: 'question', call_id: 'call-1' });
      // Past the park's own deadline, still answerable: the window restarted on
      // the question's OWN call, not on the call that was awaited…
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.count).toBe(0);
      // …and it is a real window, which does run out.
      await vi.advanceTimersByTimeAsync(40);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a question the caller only learns about LATE gets its full window from then', async () => {
    // The TTL used to run from the PARK. A caller whose collection had already
    // been abandoned was never told, so the clock timed a caller that could
    // not answer and the call failed with "the caller never answered the
    // question" — reported over a real run whose caller had asked and been cut
    // off by its own client. The window now starts at the delivery that is
    // actually observed.
    // FAKE timers, like the two tests above that pin the same re-arm. On the
    // real clock this slept 45ms against a 60ms window, and a 15ms margin is
    // not one a 228-file parallel suite can hold: under load the TTL fired
    // before the wait, and the call failed with the very error the re-arm
    // exists to prevent — passing alone and failing in `pnpm test:unit`.
    vi.useFakeTimers();
    try {
      const { broker, deferred } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = park(broker, {
        ttlMs: 60,
        fail: () =>
          deferred[0]!.resolve({
            status: 'cancelled',
            finalText: null,
            error: 'run cancelled',
            failureClass: null,
            resetsAt: null,
            sessionId: null,
          }),
      });
      // Most of the original window passes with nobody collecting.
      await vi.advanceTimersByTimeAsync(45);
      const question = await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
      });
      expect(question.status).toBe('question');
      // Past the ORIGINAL deadline, and the question is still answerable —
      // without the re-arm it has already been failed by here.
      await vi.advanceTimersByTimeAsync(30);
      expect(failed.failed.count).toBe(0);
      expect(
        broker.answerAgent('run-1', 'orch', {
          call_id: 'call-1',
          answer: 'Red',
        }).status,
      ).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unanswered question times out: the callee turn is failed and the call settles as QUESTION_TIMEOUT', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // The fail hook mirrors the executor: cancelling the parked turn.
    park(broker, {
      ttlMs: 10,
      fail: () =>
        deferred[0]!.resolve({
          status: 'cancelled',
          finalText: null,
          error: 'run cancelled',
          failureClass: null,
          resetsAt: null,
          sessionId: null,
        }),
    });
    expect((await sync).status).toBe('question');
    // Let the 10ms TTL fire and the failed turn settle through the chain.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(final.status).toBe('error');
    expect(errorOf(final)).toContain('QUESTION_TIMEOUT');
    expect(items.map((i) => i.kind)).toContain('call_answer');
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'timeout',
    });
    // Nothing left to answer once the TTL failed the call — the settled call
    // is gone from the live set, and the refusal says it finished.
    const late = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'too late',
    });
    expect(errorOf(late)).toMatch(/^CALL_FINISHED: /);
  });

  it('answer_agent enforces ownership and exactly-once settlement', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // No question parked yet → NO_QUESTION, not a hang.
    const early = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(early)).toContain('NO_QUESTION');
    park(broker);
    // Another member must not answer a call it does not own.
    const stolen = broker.answerAgent('run-1', 'writer', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(stolen)).toContain('UNKNOWN_CALL');
    expect(
      broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'a' })
        .status,
    ).toBe('ok');
    // Second answer finds no parked question.
    const twice = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'b',
    });
    expect(errorOf(twice)).toContain('NO_QUESTION');
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('reports DELIVERY_FAILED when the callee turn died before the answer — and resolves the question row', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    park(broker, { deliver: () => false });
    const gone = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'a',
    });
    expect(errorOf(gone)).toContain('DELIVERY_FAILED');
    // The transcript's question row must not dangle unresolved.
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'undelivered',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('orphans immediately when the question parks AFTER its owner settled — no 5-minute TTL grind', async () => {
    // A fire-and-forget (or raced) caller can settle before its callee asks;
    // drainCaller already swept and found nothing, so the park itself must
    // detect the dead owner and fail fast instead of holding the run open.
    const { broker, items, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => false,
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'cancelled',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(errorOf(await sync)).toContain('QUESTION_ORPHANED');
  });

  it('a fire-and-forget call that asks is orphaned at once and never becomes awaitable', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const started = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'fire_and_forget',
    });
    expect(started.status).toBe('ok');
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    // The "never awaitable" fire-and-forget pin survives the question path.
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(collected)).toContain('UNKNOWN_CALL');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('drainCaller fails a settling caller’s parked questions as QUESTION_ORPHANED', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect((await sync).status).toBe('question');
    broker.drainCaller('run-1', 'orch');
    expect(failed.count).toBe(1);
    expect(items.find((i) => i.kind === 'call_answer')!.payload).toMatchObject({
      outcome: 'orphaned',
    });
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: 'run cancelled',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    const final = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(final)).toContain('QUESTION_ORPHANED');
  });

  it('says in a wake how many team notes the woken conversation has not read, and nothing at 0', async () => {
    const wakeOf = (unread: number): string => {
      const wakes: string[] = [];
      const { broker } = harness({
        launch: 'defer',
        isNodeLive: () => false,
        wakeNode: (_nodeId, prompt) => {
          wakes.push(prompt);
          return true;
        },
        unreadTeamNotes: (caller) => (caller === 'orch' ? unread : 0),
      });
      void broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      park(broker, { ttlMs: 60_000 });
      return wakes[0]!;
    };

    expect(wakeOf(2)).toContain(
      '2 team notes by other agents of this run are unread — read them with team_notes',
    );
    expect(wakeOf(0)).not.toContain('team note');
  });

  it("says the run's current stage in a wake, and nothing for a run without stages", async () => {
    const wakeOf = (stage: string | null): string => {
      const wakes: string[] = [];
      const { broker } = harness({
        launch: 'defer',
        isNodeLive: () => false,
        wakeNode: (_nodeId, prompt) => {
          wakes.push(prompt);
          return true;
        },
        currentStage: () => stage,
      });
      void broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      park(broker, { ttlMs: 60_000 });
      return wakes[0]!;
    };

    expect(wakeOf('Review (review), 3/4')).toContain(
      '[geniro] Current stage: Review (review), 3/4.',
    );
    expect(wakeOf(null)).not.toContain('Current stage');
  });

  it('answers the unread team-note figure per conversation, and 0 for a run it does not hold', () => {
    const { broker } = harness({
      unreadTeamNotes: (caller) => (caller === 'orch' ? 3 : 0),
    });
    expect(broker.unreadTeamNotes('run-1', 'orch')).toBe(3);
    expect(broker.unreadTeamNotes('run-1', 'helper')).toBe(0);
    expect(broker.unreadTeamNotes('run-x', 'orch')).toBe(0);
  });

  it('WAKES a caller whose turn ended when its callee asks — the callee keeps its question', async () => {
    // REPORTED as "team stopped to work in the middle without any error":
    // a Manager ended its turn, its Engineer asked something, and the park
    // orphaned the question — cancelling the Engineer — while the run closed
    // as completed. With a turn to give, the caller is woken instead.
    const wakes: { memberId: string; prompt: string }[] = [];
    const { broker, items, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => false,
      wakeNode: (memberId, prompt) => {
        wakes.push({ memberId, prompt });
        return true;
      },
    });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const { failed, delivered } = park(broker, { ttlMs: 60_000 });

    expect(failed.count).toBe(0);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.memberId).toBe('orch');
    expect(wakes[0]!.prompt).toContain('"Which color?"');
    expect(wakes[0]!.prompt).toContain('answer_agent(call_id: "call-1"');
    // The transcript says why the caller is talking again — naming the call,
    // so the renderer can draw a divider that opens its card.
    const notice = items.find(
      (i) => i.kind === 'system' && i.memberId === 'orch',
    );
    expect(notice?.payload).toMatchObject({
      severity: 'info',
      message: 'Picked back up — Helper asked a question in call-1.',
      wake: [{ callId: 'call-1', callee: 'Helper', reason: 'asked' }],
    });
    // The woken caller answers exactly as a live one would have.
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'Red',
    });
    expect(answered.status).toBe('ok');
    expect(delivered).toEqual(['Red']);
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'painted',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('wakes a caller only ONCE per question — ending again unanswered orphans it, and says so', async () => {
    const wakes: string[] = [];
    const { broker, items, deferred } = harness({
      launch: 'defer',
      wakeNode: (memberId) => {
        wakes.push(memberId);
        return true;
      },
    });
    const sync = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 60_000 });
    expect((await sync).status).toBe('question');

    // The caller's turn ended with the question unanswered: woken once…
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toEqual(['orch']);
    expect(failed.count).toBe(0);

    // …and its woken turn ended the same way: orphaned now, never re-woken.
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toEqual(['orch']);
    expect(failed.count).toBe(1);
    expect(
      items.filter((i) => i.kind === 'call_answer').at(-1)!.payload,
    ).toMatchObject({ outcome: 'orphaned' });
    // A stop with no error anywhere is the reported defect, so it is said.
    const said = items.filter((i) => i.kind === 'system').at(-1)!.payload;
    expect(String(said.message)).toContain('Helper was stopped');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('wakes a caller whose async result landed after its turn ended — once', async () => {
    const wakes: { memberId: string; prompt: string }[] = [];
    let live = true;
    const { broker, deferred } = harness({
      launch: 'defer',
      isNodeLive: () => live,
      wakeNode: (memberId, prompt) => {
        wakes.push({ memberId, prompt });
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // The caller ends with its callee still working — nothing to report yet.
    live = false;
    broker.drainCaller('run-1', 'orch');
    expect(wakes).toHaveLength(0);

    // The callee lands: THAT is when the caller is owed a turn.
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.memberId).toBe('orch');
    expect(wakes[0]!.prompt).toContain('await_agent(call_id: "call-1")');
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(wakes).toHaveLength(1);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(collected.status).toBe('ok');
  });

  it('tells a WORKING caller its async call finished, inside its running turn', async () => {
    // REPORTED (run `82dd8617`, call-74): the Engineer finished while the
    // Manager sat on its user's question card, nothing told the Manager, and
    // it then steered the finished call as though it still ran.
    const wakeNode = vi.fn(() => true);
    const told: { memberId: string; prompt: string }[] = [];
    const { broker, deferred, items } = harness({
      launch: 'defer',
      wakeNode,
      tellLiveNode: (memberId, prompt) => {
        told.push({ memberId, prompt });
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.noteCalleeSettling('run-1', 'call-1');

    expect(wakeNode).not.toHaveBeenCalled();
    expect(told).toHaveLength(1);
    expect(told[0]!.memberId).toBe('orch');
    expect(told[0]!.prompt).toContain('has finished call-1');
    expect(told[0]!.prompt).toContain('await_agent(call_id: "call-1")');
    expect(items.find((item) => item.kind === 'system')?.payload).toMatchObject(
      { severity: 'info', message: expect.stringContaining('call-1') },
    );

    // Told is not collected: a caller that ends without collecting is still
    // woken once to do it.
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    broker.drainCaller('run-1', 'orch');
    expect(wakeNode).toHaveBeenCalledTimes(1);
  });

  it('does not tell a caller that is already waiting on its calls — the wait hands it the result', async () => {
    const tellLiveNode = vi.fn(() => true);
    const { broker, deferred } = harness({ launch: 'defer', tellLiveNode });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const waiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    broker.noteCalleeSettling('run-1', 'call-1');
    expect(tellLiveNode).not.toHaveBeenCalled();

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect((await waiting).status).toBe('ok');
  });

  it('a caller that ends with a finished result nobody collected is woken to collect it', async () => {
    const prompts: string[] = [];
    const { broker } = harness({
      wakeNode: (_nodeId, prompt) => {
        prompts.push(prompt);
        return true;
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // Let the instant launch's settle chain run: the result is now WAITING.
    await new Promise((resolve) => setTimeout(resolve, 0));
    broker.drainCaller('run-1', 'orch');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Helper has finished call-1');
    broker.drainCaller('run-1', 'orch');
    expect(prompts).toHaveLength(1);
  });

  it('parkQuestion refuses unknown calls and double parking', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    expect(
      broker.parkQuestion('run-1', 'call-9', {
        question: 'q',
        options: [],
        payload: null,
        deliver: () => true,
        fail: () => {},
      }),
    ).toBe(false);
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    park(broker);
    expect(
      broker.parkQuestion('run-1', 'call-1', {
        question: 'second',
        options: [],
        payload: null,
        deliver: () => true,
        fail: () => {},
      }),
    ).toBe(false);
    deferred[0]!.resolve({
      status: 'completed',
      finalText: '',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
  });

  it('unregisterRun defuses parked TTL timers — a dead run’s callee is never failed by a late timer', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const { failed } = park(broker, { ttlMs: 10 });
    broker.unregisterRun('run-1');
    deferred[0]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(failed.count).toBe(0);
  });
});

describe("CallBroker — await_agent over ALL of a caller's calls", () => {
  const done = (text: string): CalleeTurnOutcome => ({
    status: 'completed',
    finalText: text,
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: null,
  });
  const fanOut = async (
    broker: CallBroker,
    agents: string[],
  ): Promise<void> => {
    for (const agent of agents) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
  };
  const parkOn = (broker: CallBroker, callId: string): void => {
    broker.parkQuestion('run-1', callId, {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
  };

  it('returns the FIRST call to finish, naming it, and leaves the others collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    deferred[1]!.resolve(done('second finished first'));
    expect(await any).toEqual({
      status: 'ok',
      result: {
        call_id: 'call-2',
        agent: 'writer',
        text: 'second finished first',
      },
    });
    const next = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve(done('then the first'));
    expect(await next).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
    expect(errorOf(await broker.awaitAgent('run-1', 'orch', {}))).toContain(
      'NO_OPEN_CALLS',
    );
  });

  it('returns a question from ANY call the moment it parks — and does not hand it back on the next wait', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    parkOn(broker, 'call-2');
    expect(await any).toMatchObject({
      status: 'question',
      call_id: 'call-2',
      question: 'Which color?',
    });
    // Seen once: the next wait waits instead of looping on the same question.
    const next = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve(done('one'));
    expect(await next).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
  });

  it('answers at once with a question that parked before the wait, or a result nobody collected', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    parkOn(broker, 'call-1');
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
    deferred[1]!.resolve(done('already done'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-2', text: 'already done' },
    });
  });

  it('shows an already-seen question again when every open call is waiting on an answer, instead of blocking', async () => {
    // The callee waits for the answer while the caller waits for the callee:
    // without this the wait could end only in QUESTION_TIMEOUT.
    const { broker } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper']);
    parkOn(broker, 'call-1');
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
    expect(await broker.awaitAgent('run-1', 'orch', {})).toMatchObject({
      status: 'question',
      call_id: 'call-1',
    });
  });

  it('keeps waiting on its other calls when a concurrent wait collects the result it raced for', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    const specific = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve(done('one'));
    expect(await specific).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1' },
    });
    deferred[1]!.resolve(done('two'));
    expect(await any).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-2' },
    });
  });

  it('names the call a FAILED result came from', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await fanOut(broker, ['helper', 'writer']);
    const any = broker.awaitAgent('run-1', 'orch', {});
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'boom',
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(await any).toMatchObject({ status: 'error', call_id: 'call-1' });
  });

  it('answers pending with every call it is waiting on, and stops listening once it has', async () => {
    const told: string[] = [];
    const { broker } = harness({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    await fanOut(broker, ['helper', 'writer']);
    expect(await broker.awaitAgent('run-1', 'orch', { timeout_ms: 5 })).toEqual(
      {
        status: 'pending',
        call_id: 'call-1',
        agent: 'helper',
        waiting_on: [
          { call_id: 'call-1', agent: 'helper' },
          { call_id: 'call-2', agent: 'writer' },
        ],
      },
    );
    parkOn(broker, 'call-2');
    expect(told).toHaveLength(1);
  });
});

describe('CallBroker — thread continuation', () => {
  it('continuing a thread resumes the recorded callee session', async () => {
    const { broker, launches, items } = harness();
    const first = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'remember the codeword BANANA',
    });
    expect(first.status).toBe('ok');

    const second = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'what was the codeword?',
      thread: 'call-1',
    });
    expect(second).toEqual({
      status: 'ok',
      result: { call_id: 'call-2', agent: 'helper', text: 'done by helper' },
    });
    // The continuation turn resumed call-1's recorded CLI session…
    expect(launches[1]!.resumeSessionId).toBe('sess-call-1');
    // …while the first turn started fresh.
    expect(launches[0]!.resumeSessionId).toBeNull();
    // The transcript's call_started row names the continued thread.
    const started = items.filter((i) => i.kind === 'call_started');
    expect(started[1]!.payload).toMatchObject({
      callId: 'call-2',
      thread: 'call-1',
    });
    expect(started[0]!.payload).not.toHaveProperty('thread');
  });

  it('a continued thread can itself be continued (chained resumes)', async () => {
    const { broker, launches } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'a',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
    });
    expect(launches.map((l) => l.resumeSessionId)).toEqual([
      null,
      'sess-call-1',
      'sess-call-2',
    ]);
  });

  it('refuses an unknown thread and a thread another caller started', async () => {
    const calleesOf = new Map([
      ['orch', [HELPER]],
      ['other', [HELPER]],
    ]);
    const { broker, launches } = harness({ calleesOf });
    const unknown = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-99',
    });
    expect(unknown.status).toBe('error');
    expect(errorOf(unknown)).toContain('UNKNOWN_THREAD');
    expect(launches).toHaveLength(0);

    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const foreign = await broker.callAgent('run-1', 'other', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-1',
    });
    expect(foreign.status).toBe('error');
    expect(errorOf(foreign)).toContain('UNKNOWN_THREAD');
  });

  it('refuses continuing a thread with a different agent', async () => {
    const { broker } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const mismatch = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'writer',
      message: 'm',
      thread: 'call-1',
    });
    expect(mismatch.status).toBe('error');
    expect(errorOf(mismatch)).toContain('THREAD_AGENT_MISMATCH');
  });

  it('refuses a thread whose turn recorded no resumable session', async () => {
    const { broker } = harness({ noSession: true });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      thread: 'call-1',
    });
    expect(envelope.status).toBe('error');
    expect(errorOf(envelope)).toContain('THREAD_UNAVAILABLE');
  });
});

/**
 * F22: `untilAbandoned` and `untilDeadline` (the two private wrappers
 * `awaitAgent` composes around `waitForOutcome`) used to forward only the
 * fulfillment arm of the promise they wrap (`promise.then(onFulfilled)`,
 * no rejection handler). A rejecting inner promise therefore left the
 * wrapper's own returned promise pending FOREVER instead of propagating the
 * failure — `awaitAgent` would hang rather than let the rejection reach the
 * MCP dispatcher's ordinary error mapping.
 *
 * These specs call the two wrappers directly (via a narrow structural cast —
 * neither method reads `this`) rather than staging a call/callee scenario
 * that reaches a rejection: in production `call.settled` always carries a
 * `.catch` (see `callAgent`), so this is a defensive contract the wrappers
 * must honor even though nothing on the ordinary call path exercises it
 * today.
 */
interface UntilWrappers {
  untilAbandoned<T>(
    signal: AbortSignal | undefined,
    promise: Promise<T>,
  ): Promise<T | symbol>;
  untilDeadline<T>(
    timeoutMs: number | undefined,
    promise: Promise<T>,
  ): Promise<T | symbol>;
}

function untilWrappersOf(broker: CallBroker): UntilWrappers {
  return broker as unknown as UntilWrappers;
}

describe('CallBroker — untilAbandoned / untilDeadline reject propagation', () => {
  it('untilAbandoned rejects instead of hanging when the wrapped promise rejects', async () => {
    const { untilAbandoned } = untilWrappersOf(new CallBroker());
    // Never aborts — this exercises the reject arm of the settle race, not
    // the abort arm.
    const controller = new AbortController();
    const failure = new Error('callee turn blew up');
    await expect(
      untilAbandoned(controller.signal, Promise.reject(failure)),
    ).rejects.toBe(failure);
  }, 2000);

  it('untilAbandoned still resolves normally when the wrapped promise resolves', async () => {
    const { untilAbandoned } = untilWrappersOf(new CallBroker());
    const controller = new AbortController();
    const outcome = { status: 'ok' as const };
    await expect(
      untilAbandoned(controller.signal, Promise.resolve(outcome)),
    ).resolves.toBe(outcome);
  });

  it('untilDeadline rejects instead of hanging when the wrapped promise rejects', async () => {
    const { untilDeadline } = untilWrappersOf(new CallBroker());
    const failure = new Error('callee turn blew up');
    // A deadline far outside this test's own timeout: on the unfixed wrapper
    // the promise never settles within that window (no reject arm, and the
    // timer would not fire first either), so the assertion below fails by
    // timing out rather than by resolving to the wrong thing — still a red
    // test either way.
    await expect(untilDeadline(60_000, Promise.reject(failure))).rejects.toBe(
      failure,
    );
  }, 2000);

  it('untilDeadline still resolves normally when the wrapped promise resolves', async () => {
    const { untilDeadline } = untilWrappersOf(new CallBroker());
    const outcome = { status: 'ok' as const };
    await expect(untilDeadline(60_000, Promise.resolve(outcome))).resolves.toBe(
      outcome,
    );
  });
});

describe('CallBroker — a call whose callee goes quiet', () => {
  // The gap this milestone's own verification named: every abandonment and
  // deadline case in this file enters through `awaitAgent`, and none drives
  // the SYNC arm — which is the arm a live cursor call was measured taking
  // (`call_started` carrying `mode: 'sync'`), and the one whose wait has
  // neither a deadline nor an abandon race around it.

  it('says so in the caller transcript, and does NOT settle the call', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      let settled = false;
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'take your time',
      });
      void call.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

      const stalls = items.filter((i) => i.payload.stalledCall === true);
      expect(stalls).toHaveLength(1);
      expect(stalls[0]!.kind).toBe('system');
      // On the CALLER's member — it is the caller's transcript that had no way
      // to say anything about a callee that had stopped.
      expect(stalls[0]!.memberId).toBe('orch');
      expect(stalls[0]!.payload).toMatchObject({
        callId: 'call-1',
        calleeNodeId: 'helper',
      });
      // The KEY, not just the presence of a sentence: `transcript-item.tsx`
      // reads a `system` row's `message` and draws nothing without it, so a
      // row whose wording sits under any other key is persisted, folded, and
      // invisible. `severity` matters for the same reason — an absent one
      // resolves to the red failure chrome, and nothing here has failed.
      expect(stalls[0]!.payload.message).toContain('has produced nothing');
      expect(stalls[0]!.payload.severity).toBe('info');

      // The whole of the carve-out: SURFACED, never cancelled — a sync call
      // has no deadline of its own.
      expect(settled).toBe(false);
      expect(items.some((i) => i.kind === 'call_result')).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'late, but fine',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
      // And it settles normally afterwards — the advisory changed nothing
      // about the call's own outcome.
      expect(items.some((i) => i.kind === 'call_result')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down while the callee is blocked on a verdict, and resumes after', async () => {
    // A callee parked on an approval card emits nothing by construction, so a
    // window left running would be timing the PERSON reading the card and
    // would report a callee doing exactly what it should. `spawn-cli.ts`
    // suspends its own silence deadline on the same reasoning.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'ask me something',
      });

      broker.noteCalleeBlocked('run-1', 'call-1');
      // An hour on a card is a long think, not a stall.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      // Answered — and now the silence counts again, from here.
      broker.noteCalleeUnblocked('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down while the call waits under the run’s cap, however much is said to it, and resumes once it leaves the queue', async () => {
    // A call that has not started has produced nothing because it has not
    // begun; "has produced nothing for 10 minutes" would be false.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'wait your turn',
      });

      broker.noteCalleeQueued('run-1', 'call-1', true);
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      broker.noteCalleeQueued('run-1', 'call-1', false);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down while the callee waits on its own tool call, and resumes after it answers', async () => {
    // REPORTED as "'qa' has produced nothing for 10 minutes" over a QA agent
    // that had launched ten reviewer sub-agents as `Task` tool calls: their
    // results arrived eleven minutes apart and nothing reached the wire in
    // between. A callee waiting on its own tool is working.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'review it',
      });

      // The tool call is itself a persisted row, so the executor reports both.
      broker.noteCalleeToolStarted('run-1', 'call-1', 'tool-a');
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      // Answered — and now the silence counts again, from here.
      broker.noteCalleeToolFinished('run-1', 'call-1', 'tool-a');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays suspended even though the card itself is a row', async () => {
    // The trap in the pairing: an `approval_request` is PERSISTED, so the
    // executor's own activity hook fires for the very event that suspended the
    // window. Without the guard in `armSilenceWatch` that row would re-arm it
    // and the carve-out above would do nothing.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'ask me something',
      });

      broker.noteCalleeBlocked('run-1', 'call-1');
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('writes NOTHING once the run is unregistered', async () => {
    // The teardown case, and the one the sibling `parked` timer's own comment
    // already warned about: a wedged callee is both what arms this watchdog
    // AND what makes `RunTeardownService`'s settle wait give up and purge the
    // run anyway. A timer left armed then inserts an `items` row for a run
    // whose rows are gone — and `Item.runId` has no foreign key, so the insert
    // SUCCEEDS and leaves transcript text no route can reach or delete.
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      void broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'wedge',
      });

      broker.unregisterRun('run-1');
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'never collected',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms on every callee row, so a WORKING callee is never called stalled', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'work steadily',
      });

      // Twenty-seven minutes of work, never nine of them silent. A total-
      // duration cap would have fired twice over by here — which is the
      // behaviour the silence bound exists instead of.
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        broker.noteCalleeActivity('run-1', 'call-1');
      }

      expect(items.some((i) => i.payload.stalledCall === true)).toBe(false);

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });

  it('says it ONCE, even after the callee wakes and goes quiet again', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items, deferred } = harness({ launch: 'defer' });
      const call = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'hang',
      });

      // Go quiet, be reported, produce ONE row, then go quiet again. The
      // second silence re-arms the watchdog and fires it a second time — so
      // this drives the `saidStalled` guard rather than the one-shot timer,
      // which would have passed with the guard deleted.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);

      // An advisory per silent stretch would bury the conversation it is
      // warning about.
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );

      deferred[0]!.resolve({
        status: 'completed',
        finalText: 'eventually',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: 'sess-1',
      });
      await call;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallBroker — one process per conversation', () => {
  it('a continuation runs in the conversation of the call it continues, however deep the chain', async () => {
    const { broker, launches } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'a',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
    });
    // A fresh call beside them opens a conversation of its own.
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'd',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'e',
      thread: 'call-4',
    });
    expect(launches.map((l) => [l.callId, l.conversationId])).toEqual([
      ['call-1', 'call-1'],
      ['call-2', 'call-1'],
      ['call-3', 'call-1'],
      ['call-4', 'call-4'],
      ['call-5', 'call-4'],
    ]);
  });

  it('refuses to continue a conversation a call is still running on, and accepts once it has settled', async () => {
    // Two live calls on one conversation is the fork this keying exists to
    // end — or, keyed together, the registry replacing a running process.
    const { broker, launches, deferred } = harness({ launch: 'defer' });
    const first = broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'a',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'a done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
    });
    expect((await first).status).toBe('ok');
    const running = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'b',
      thread: 'call-1',
      mode: 'async',
    });
    expect(running.status).toBe('ok');

    const busy = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-1',
    });
    expect(busy.status).toBe('error');
    expect(errorOf(busy)).toContain('THREAD_BUSY');
    // Names the call to await, so the caller knows what to do next.
    expect(errorOf(busy)).toContain("'call-2'");
    expect(launches).toHaveLength(2);

    // Another conversation is untouched by it.
    const other = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'writer',
      message: 'x',
      mode: 'async',
    });
    expect(other.status).toBe('ok');

    deferred[1]!.resolve({
      status: 'completed',
      finalText: 'b done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
    });
    expect(
      (await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' })).status,
    ).toBe('ok');
    const again = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'c',
      thread: 'call-2',
      mode: 'async',
    });
    expect(again).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-4' },
    });
    expect(launches[3]).toMatchObject({
      callId: 'call-4',
      resumeSessionId: 'sess-1',
      conversationId: 'call-1',
    });
  });
});

describe('CallBroker — a caller blocked on a card of its own', () => {
  function parkOn(
    broker: CallBroker,
    callId: string,
    ttlMs: number,
    failed: { count: number },
  ): void {
    expect(
      broker.parkQuestion('run-1', callId, {
        question: 'Which?',
        options: ['A', 'B'],
        payload: null,
        ttlMs,
        deliver: () => true,
        fail: () => {
          failed.count += 1;
        },
      }),
    ).toBe(true);
  }

  it('a question parked while its caller is blocked does not expire; its window starts when the caller is unblocked', async () => {
    // Both QUESTION_TIMEOUTs on a real run fired inside the caller's own
    // question to the user — the one moment it could not answer_agent.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);

      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(999);
      expect(failed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a card raised after the question parked suspends its running window, and the unblock gives it a full one', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      await vi.advanceTimersByTimeAsync(600);
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);

      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      // A FULL window from the unblock, not the 400ms that were left.
      await vi.advanceTimersByTimeAsync(999);
      expect(failed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('with two cards up, the window resumes only when the last is answered', async () => {
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-a');
      broker.noteCallerBlocked('run-1', 'orch', 'card-b');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-a');
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(failed.count).toBe(0);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-b');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts the run's blocked conversations, and none for a run it does not hold", () => {
    const { broker } = harness();
    expect(broker.blockedConversations('run-1')).toBe(0);

    broker.noteCallerBlocked('run-1', 'orch', 'card-1');
    broker.noteCallerBlocked('run-1', 'orch', 'card-2');
    expect(broker.blockedConversations('run-1')).toBe(1);

    broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
    broker.noteCallerUnblocked('run-1', 'orch', 'card-2');
    expect(broker.blockedConversations('run-1')).toBe(0);
    expect(broker.blockedConversations('run-other')).toBeNull();
  });

  it('the SAME card offered twice is one blocker — its one answer resumes the questions', async () => {
    // REVIEWED: spawn-cli re-offers a request its turn settled without an
    // answer to the next turn of the same process, so one card can reach the
    // seam twice. Counted, it then needed two answers to that one card.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a callee waiting on its own caller cannot answer its callees either: their questions wait with it', async () => {
    // REVIEWED: Manager → Engineer → Researcher. An Engineer parked on a
    // question to its Manager cannot answer_agent its Researcher, so the
    // Researcher's clock must not run until the Manager has answered. The
    // Engineer calls from INSIDE the call it answers, which is its caller key.
    vi.useFakeTimers();
    try {
      const { broker } = harness({
        launch: 'defer',
        calleesOf: new Map([
          ['orch', [HELPER]],
          ['helper', [WRITER]],
        ]),
      });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      await broker.callAgent('run-1', callerKey('helper', 'call-1'), {
        title: 'work',
        agent: 'writer',
        message: 'm',
        mode: 'async',
      });
      const helperFailed = { count: 0 };
      parkOn(broker, 'call-1', 24 * 60 * 60_000, helperFailed);
      const writerFailed = { count: 0 };
      parkOn(broker, 'call-2', 1_000, writerFailed);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(writerFailed.count).toBe(0);

      expect(
        broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'A' })
          .status,
      ).toBe('ok');
      await vi.advanceTimersByTimeAsync(999);
      expect(writerFailed.count).toBe(0);
      await vi.advanceTimersByTimeAsync(2);
      expect(writerFailed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("every way out of the callee's own park releases its callees' questions — a timeout, and its turn settling", async () => {
    // `unpark` is the one exit from a park precisely so no ending can leave a
    // callee blocked with nothing left to release it; pin the two that are not
    // an answer.
    for (const ending of ['timeout', 'settle'] as const) {
      vi.useFakeTimers();
      try {
        const { broker, deferred } = harness({
          launch: 'defer',
          calleesOf: new Map([
            ['orch', [HELPER]],
            ['helper', [WRITER]],
          ]),
        });
        await broker.callAgent('run-1', 'orch', {
          title: 'work',
          agent: 'helper',
          message: 'm',
          mode: 'async',
        });
        await broker.callAgent('run-1', callerKey('helper', 'call-1'), {
          title: 'work',
          agent: 'writer',
          message: 'm',
          mode: 'async',
        });
        const helperFailed = { count: 0 };
        parkOn(
          broker,
          'call-1',
          ending === 'timeout' ? 10_000 : 24 * 60 * 60_000,
          helperFailed,
        );
        const writerFailed = { count: 0 };
        parkOn(broker, 'call-2', 5_000, writerFailed);

        // Twice the writer's own window: held while its caller is parked.
        await vi.advanceTimersByTimeAsync(10_001);
        expect(writerFailed.count, ending).toBe(0);
        if (ending === 'timeout') {
          expect(helperFailed.count).toBe(1);
        } else {
          expect(helperFailed.count).toBe(0);
          deferred[0]!.resolve({
            status: 'cancelled',
            finalText: null,
            error: 'run cancelled',
            failureClass: null,
            resetsAt: null,
            sessionId: null,
          });
          await vi.advanceTimersByTimeAsync(1);
        }
        // A full window from the release, not from the park.
        await vi.advanceTimersByTimeAsync(4_997);
        expect(writerFailed.count, ending).toBe(0);
        await vi.advanceTimersByTimeAsync(3);
        expect(writerFailed.count, ending).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it('a caller that ended its turn with a card open is blocked no more: the question it is woken with runs on its own clock', async () => {
    // Its cards are swept with its turn, so a count left behind here would
    // suspend every question it is woken with for good.
    vi.useFakeTimers();
    try {
      const { broker } = harness({ launch: 'defer', wakeNode: () => true });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCallerBlocked('run-1', 'orch', 'card-1');
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 1_000, failed);
      broker.drainCaller('run-1', 'orch');
      await vi.advanceTimersByTimeAsync(1_001);
      expect(failed.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the silence watchdog stands down while the callee is parked and restarts when the answer lands', async () => {
    // With the TTL suspended a question can outlive the ten-minute silence
    // window, and "has produced nothing" about a callee waiting on its caller
    // would be true and useless — the same carve-out an approval card gets.
    vi.useFakeTimers();
    try {
      const { broker, items } = harness({ launch: 'defer' });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      const failed = { count: 0 };
      parkOn(broker, 'call-1', 60 * 60_000, failed);
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        0,
      );
      expect(
        broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'A' })
          .status,
      ).toBe('ok');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('CallBroker — seeded from an earlier daemon', () => {
  const SEED: RunCallSeed = {
    callSeq: 3,
    records: [
      {
        callId: 'call-1',
        callerMemberId: 'orch',
        calleeMemberId: 'helper',
        thread: null,
        sessionId: 'sess-old',
      },
      {
        callId: 'call-2',
        callerMemberId: 'orch',
        calleeMemberId: 'writer',
        thread: null,
        sessionId: null,
      },
      {
        callId: 'call-3',
        callerMemberId: 'orch',
        calleeMemberId: 'helper',
        thread: 'call-1',
        sessionId: 'sess-old',
      },
    ],
  };

  it('refuses to continue a thread on a pool member the callee no longer has', async () => {
    // The session belongs to member 3's CLI and account; resuming it as the
    // member itself would hand another CLI a session id it has never seen.
    const { broker, launches } = harness({
      seed: {
        callSeq: 1,
        records: [
          {
            callId: 'call-1',
            callerMemberId: 'orch',
            calleeMemberId: 'helper',
            thread: null,
            sessionId: 'sess-codex',
            member: 3,
          },
        ],
      },
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'go on',
      thread: 'call-1',
    });
    expect(envelope).toMatchObject({ status: 'error' });
    expect(envelope.status === 'error' ? envelope.error : '').toContain(
      'THREAD_UNAVAILABLE',
    );
    expect(launches).toHaveLength(0);
  });

  it('call ids continue past the transcript instead of colliding with it', async () => {
    const { broker } = harness({ seed: SEED });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
    });
    expect(envelope).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-4' },
    });
  });

  it('a conversation from before the restart is continued, in the conversation it belonged to', async () => {
    const { broker, launches } = harness({ seed: SEED });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'go on',
      thread: 'call-3',
    });
    expect(envelope.status).toBe('ok');
    // call-3 continued call-1, so its conversation is call-1's — rebuilt
    // through the parent chain rather than named after itself.
    expect(launches[0]).toMatchObject({
      callId: 'call-4',
      resumeSessionId: 'sess-old',
      conversationId: 'call-1',
    });
  });

  it('a later pass continues past every id THIS daemon gave the run, even one its seed never read', async () => {
    // The next pass reads its seed before it registers, while a call the
    // previous pass minted in between still has its row on the write chain. A
    // counter taken from the seed alone handed the next call that same id.
    const { broker, capability } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.registerRun('run-1', capability, { callSeq: 0, records: [] });
    expect(
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      }),
    ).toMatchObject({ status: 'ok', result: { call_id: 'call-2' } });
  });

  it('refuses a call made through a pass a follow-up has already superseded — before minting it', async () => {
    const { broker, capability, launches } = harness();
    capability.isSuperseded = () => true;
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(errorOf(refused)).toContain('RUN_BUSY');
    expect(launches).toHaveLength(0);
  });

  it('a seeded call that recorded no session cannot be continued, and says so', async () => {
    const { broker } = harness({ seed: SEED });
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'writer',
      message: 'm',
      thread: 'call-2',
    });
    expect(errorOf(refused)).toContain('THREAD_UNAVAILABLE');
  });

  it('collecting or answering a call from before the restart says its result is gone, naming the thread that survives', async () => {
    const { broker } = harness({ seed: SEED });
    const awaited = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(awaited)).toContain('UNKNOWN_CALL');
    expect(errorOf(awaited)).toContain('before the daemon restarted');
    expect(errorOf(awaited)).toContain("thread: 'call-1'");
    // One that recorded no session offers no thread to continue.
    const noThread = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-2',
    });
    expect(errorOf(noThread)).toContain('before the daemon restarted');
    expect(errorOf(noThread)).not.toContain('thread:');
    const answered = broker.answerAgent('run-1', 'orch', {
      call_id: 'call-3',
      answer: 'x',
    });
    expect(errorOf(answered)).toContain('before the daemon restarted');
    // An id nobody ever minted keeps the plain refusal.
    const never = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-9',
    });
    expect(errorOf(never)).toBe(
      "UNKNOWN_CALL: no un-collected async call 'call-9' started by you",
    );
  });
});

describe('CallBroker — a caller waiting on its own calls', () => {
  /**
   * The composer reads this to decide whether a message goes straight to the
   * agent or into the send-later queue: a manager parked in `await_agent` is
   * inside a turn by every reading the daemon has and is producing nothing,
   * so holding its messages back costs the user however long its callees take.
   * REPORTED as "если менеджер просто ждет в бэкграунде каких-то своих агентов,
   * он должен принимать сообщения по default".
   */
  function busBroker(harnessOptions?: Parameters<typeof harness>[0]): {
    broker: CallBroker;
    deferred: ReturnType<typeof harness>['deferred'];
    waits: (number | undefined)[];
  } {
    const bus = new AgentEventBus();
    const waits: (number | undefined)[] = [];
    bus.allStatuses().subscribe((event) => {
      if (event.awaitingCalls !== undefined) {
        waits.push(event.awaitingCalls);
      }
    });
    const { capability, deferred } = harness(harnessOptions);
    const broker = new CallBroker(bus);
    broker.registerRun('run-1', capability);
    return { broker, deferred, waits };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A callee's answer. */
  const done = {
    status: 'completed' as const,
    finalText: 'done',
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: null,
  };

  it('announces the wait when a collection starts, and its end once the gap after the answer has passed', async () => {
    const { broker, deferred, waits } = busBroker({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    // An async call with no wait open is a WORKING caller — it went on with
    // its own turn — so nothing has been announced yet and the composer's
    // queue still applies.
    expect(waits).toEqual([]);
    expect(broker.awaitingCalls('run-1')).toBe(0);

    const collecting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(broker.awaitingCalls('run-1')).toBe(1);
    expect(waits).toEqual([1]);

    deferred[0]!.resolve(done);
    await collecting;
    // The gap before a next wait still counts as waiting.
    expect(broker.awaitingCalls('run-1')).toBe(1);
    expect(waits).toEqual([1]);

    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS);
    expect(broker.awaitingCalls('run-1')).toBe(0);
    expect(waits).toEqual([1, 0]);
  });

  it('announces NOTHING when the next wait starts inside the gap', async () => {
    // A manager polling its callees: await, read, await again. Reported as
    // sending "working one time in two" while the gap read as busy.
    const { broker, deferred, waits } = busBroker({ launch: 'defer' });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve(done);
    await first;
    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS - 1);
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS);
    expect(waits).toEqual([1]);

    deferred[1]!.resolve(done);
    await second;
    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS);
    expect(waits).toEqual([1, 0]);
  });

  it('ends the wait AT ONCE when a user message released it, or the agent took one in the gap', async () => {
    const { broker, deferred, waits } = busBroker({ launch: 'defer' });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    // Released for the user's message: the agent has work now.
    const released = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    expect(broker.interruptWaits('run-1', 'orch')).toBe(true);
    await released;
    expect(waits).toEqual([1, 0]);

    // In the gap, the agent took a message (or its turn ended).
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    deferred[1]!.resolve(done);
    await second;
    expect(waits).toEqual([1, 0, 1]);
    broker.forgetUserMessage('run-1', 'orch');
    expect(waits).toEqual([1, 0, 1, 0]);
    expect(broker.awaitingCalls('run-1')).toBe(0);
  });

  it('announces once per RUN, not once per wait a caller opens', async () => {
    // The fact the composer acts on is "is anything in this run merely
    // waiting", which a second wait beside the first does not change — and an
    // announce is a socket emission to every open window.
    const { broker, deferred, waits } = busBroker({ launch: 'defer' });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    const second = broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' });
    expect(waits).toEqual([1]);

    for (const entry of deferred) {
      entry.resolve(done);
    }
    await Promise.all([first, second]);
    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS);

    // And the END is announced only once the LAST of them has returned.
    expect(waits).toEqual([1, 0]);
    expect(broker.awaitingCalls('run-1')).toBe(0);
  });

  it('ends the wait when the collection TIMES OUT rather than settles', async () => {
    // The tool call returns either way, so the caller is no longer parked —
    // and a wait left counted would make every later message bypass the queue
    // for the life of the run.
    const { broker, waits } = busBroker({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const collecting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
      timeout_ms: 1,
    });
    vi.advanceTimersByTime(1);
    const pending = await collecting;
    expect(pending.status).toBe('pending');
    vi.advanceTimersByTime(AWAIT_GAP_GRACE_MS);

    expect(waits).toEqual([1, 0]);
    expect(broker.awaitingCalls('run-1')).toBe(0);
  });

  it('ends the gap when the agent starts writing its reply', async () => {
    const { broker, deferred, waits } = busBroker({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const collecting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    deferred[0]!.resolve(done);
    await collecting;
    expect(waits).toEqual([1]);

    broker.noteOwnerReplying('run-1', 'orch');
    expect(waits).toEqual([1, 0]);
  });

  it('opens no gap after a wait the CLI abandoned', async () => {
    const { broker, waits } = busBroker({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const gone = new AbortController();
    const awaiting = broker.awaitAgent(
      'run-1',
      'orch',
      { call_id: 'call-1' },
      gone.signal,
    );
    gone.abort();
    await awaiting;
    expect(waits).toEqual([1, 0]);
  });

  it('still tells a caller in the GAP that a call finished — the gap is not a wait', async () => {
    const told: string[] = [];
    const { broker, deferred } = busBroker({
      launch: 'defer',
      tellLiveNode: (_nodeId, prompt) => {
        told.push(prompt);
        return true;
      },
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    const first = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve(done);
    await first;
    expect(broker.awaitingCalls('run-1')).toBe(1);

    broker.noteCalleeSettling('run-1', 'call-2');
    expect(told.some((prompt) => prompt.includes('has finished call-2'))).toBe(
      true,
    );
  });

  it('counts only the waits of the agents a message goes to', async () => {
    const { broker, waits } = busBroker({
      launch: 'defer',
      messageTargets: [],
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    void broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    expect(waits).toEqual([]);
    expect(broker.awaitingCalls('run-1')).toBe(0);
  });

  it('answers 0 for a run it has never heard of — every chat', () => {
    const { broker } = busBroker();
    expect(broker.awaitingCalls('some-chat')).toBe(0);
  });
});

describe('CallBroker — message_agent', () => {
  it('keeps failure notices separate for two conversations of the same member', () => {
    const { broker } = harness({
      seed: {
        callSeq: 2,
        records: [],
        messageFailures: [
          {
            deliveryId: 'delivery-1',
            callId: 'call-2',
            callerNodeId: 'worker',
            callerConversationId: 'call-1',
            calleeNodeId: 'helper',
            message: 'correction',
            reason: 'stopped',
          },
        ],
      },
    });
    expect(broker.messageDeliveryNotice('run-1', 'worker')).toBeNull();
    expect(
      broker.messageDeliveryNotice('run-1', callerKey('worker', 'call-other')),
    ).toBeNull();
    const notice = broker.messageDeliveryNotice(
      'run-1',
      callerKey('worker', 'call-1'),
    )!;
    broker.acknowledgeMessageDeliveryNotice(
      'run-1',
      callerKey('worker', 'call-other'),
      notice,
    );
    expect(
      broker.messageDeliveryNotice('run-1', callerKey('worker', 'call-1')),
    ).toEqual(notice);
  });
  it('hands the message to the RUNNING callee and records it as the caller’s', async () => {
    // REPORTED: a Manager held six user corrections "until the engineer
    // finishes", 8–32 minutes each, because nothing could reach a callee mid-call.
    const { broker, messages, items } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });

    const envelope = broker.messageAgent('run-1', 'orch', {
      call_id: 'call-1',
      message: 'the user says: keep the old button labels',
    });

    expect(envelope).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'delivered' },
    });
    expect(messages).toEqual([
      { callId: 'call-1', text: 'the user says: keep the old button labels' },
    ]);
    // Filed as the CALLER's row carrying the call id, which is what puts it
    // inside that call's block rather than in the main flow.
    expect(items.find((item) => item.kind === 'call_answer')).toEqual({
      memberId: 'orch',
      kind: 'call_answer',
      payload: {
        callId: 'call-1',
        callerNodeId: 'orch',
        calleeNodeId: 'helper',
        message: 'the user says: keep the old button labels',
        outcome: 'message',
      },
    });
  });

  it('says what the delivery COST when the callee’s CLI interrupts its step', async () => {
    const { broker } = harness({
      launch: 'defer',
      messageCallee: () => ({ delivered: true, interrupts: true }),
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });

    const envelope = broker.messageAgent('run-1', 'orch', {
      call_id: 'call-1',
      message: 'stop, wrong file',
    }) as { result: { note: string } };

    expect(envelope.result.note).toContain('stopped what it was doing');
  });

  it('refuses a call the asking member does not own, as UNKNOWN_CALL', async () => {
    const { broker, messages } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(
      errorOf(
        broker.messageAgent('run-1', 'writer', {
          call_id: 'call-1',
          message: 'not mine',
        }),
      ),
    ).toContain('UNKNOWN_CALL');
    expect(messages).toEqual([]);
  });

  it('sends a PARKED callee to answer_agent instead of queueing a message behind its question', async () => {
    const { broker, messages, items } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.parkQuestion('run-1', 'call-1', {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: null,
      deliver: () => true,
      fail: () => {},
    });

    expect(
      errorOf(
        broker.messageAgent('run-1', 'orch', {
          call_id: 'call-1',
          message: 'use red',
        }),
      ),
    ).toContain('answer_agent');
    expect(messages).toEqual([]);
    expect(
      items.find((item) => item.kind === 'call_answer')?.payload,
    ).toMatchObject({
      outcome: 'undelivered',
      message: 'use red',
      reason: expect.stringContaining('CALLEE_PARKED'),
    });
    expect(broker.messageDeliveryNotice('run-1', 'orch')?.prompt).toContain(
      'use red',
    );
  });

  it('HOLDS a message the callee cannot take yet and delivers it the moment it can, in order', async () => {
    // MEASURED in the running app: a Manager steering 2s after call_agent was
    // refused, because the worker's turn was still holding its own prompt
    // while its MCP servers dialled — and the worker ran the whole wrong task.
    vi.useFakeTimers();
    try {
      let takeable = false;
      const { broker, messages, items } = harness({
        launch: 'defer',
        messageCallee: (callId, text) => {
          if (!takeable) {
            return { delivered: false, reason: 'refused' };
          }
          messages.push({ callId, text });
          return { delivered: true, interrupts: false };
        },
      });
      void broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });

      const first = broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'first correction',
      });
      // Offered again behind the first even once the callee could take it
      // directly — a later message must never overtake an earlier one.
      takeable = true;
      const second = broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'second correction',
      });

      expect(first).toMatchObject({
        status: 'ok',
        result: { state: 'queued' },
      });
      expect(second).toMatchObject({
        status: 'ok',
        result: { state: 'queued' },
      });
      expect(messages).toEqual([]);
      expect(items.some((item) => item.kind === 'call_answer')).toBe(false);

      await vi.advanceTimersByTimeAsync(600);

      expect(messages.map((m) => m.text)).toEqual([
        'first correction',
        'second correction',
      ]);
      expect(
        items
          .filter((item) => item.kind === 'call_answer')
          .map((item) => (item.payload as { outcome: string }).outcome),
      ).toEqual(['message', 'message']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('holds a message for a call still queued for a slot rather than refusing it', async () => {
    const { broker, items } = harness({
      launch: 'defer',
      messageCallee: () => ({ delivered: false, reason: 'not_started' }),
    });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });

    expect(
      broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'also do X',
      }),
    ).toMatchObject({ status: 'ok', result: { state: 'queued' } });
    expect(items.some((item) => item.kind === 'call_answer')).toBe(false);
  });

  it('says a call that FINISHED while the caller was busy has finished, and how to collect and continue it', async () => {
    // REPORTED (run `82dd8617`, call-74): the Engineer finished while the
    // Manager sat on its user's question card, and steering the call then
    // read "UNKNOWN_CALL: no live call 'call-74' started by you" — about a
    // call the Manager had made and whose result was waiting for it.
    const { broker, messages, deferred, items } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const uncollected = errorOf(
      broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'one more thing',
      }),
    );
    expect(uncollected).toMatch(/^CALL_FINISHED: /);
    expect(uncollected).toContain("await_agent(call_id: 'call-1')");
    expect(uncollected).toContain("call_agent(thread: 'call-1')");
    expect(messages).toEqual([]);

    await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    const collected = errorOf(
      broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'one more thing',
      }),
    );
    expect(collected).toMatch(/^CALL_FINISHED: /);
    expect(collected).toContain('nothing of it is left to collect');
    expect(collected).toContain("call_agent(thread: 'call-1')");
    expect(
      items
        .filter((item) => item.kind === 'call_answer')
        .map((item) => item.payload),
    ).toEqual([
      expect.objectContaining({
        outcome: 'undelivered',
        message: 'one more thing',
      }),
      expect.objectContaining({
        outcome: 'undelivered',
        message: 'one more thing',
      }),
    ]);
    // Ownership still reads as UNKNOWN_CALL: a caller does not learn that a
    // call it does not own exists, finished or not.
    expect(
      errorOf(
        broker.messageAgent('run-1', 'writer', {
          call_id: 'call-1',
          message: 'not mine',
        }),
      ),
    ).toContain('UNKNOWN_CALL');
  });

  it('refuses a message once the callee’s turn has ended rather than holding it to be dropped', async () => {
    // The executor holds a call open after its turn ends; a message queued in
    // that window could only ever be recorded as undelivered.
    const { broker, items } = harness({
      launch: 'defer',
      messageCallee: () => ({ delivered: false, reason: 'refused' }),
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });
    broker.noteCalleeTurnEnded('run-1', 'call-1');

    expect(
      errorOf(
        broker.messageAgent('run-1', 'orch', {
          call_id: 'call-1',
          message: 'too late',
        }),
      ),
    ).toMatch(/^CALL_FINISHED: .*await_agent\(call_id: 'call-1'\)/);
    expect(
      items.find((item) => item.kind === 'call_answer')?.payload,
    ).toMatchObject({
      outcome: 'undelivered',
      message: 'too late',
      reason: expect.stringContaining('CALL_FINISHED'),
    });
  });

  it('never sends to a cancelled handle, and drops its queued messages before settlement', async () => {
    vi.useFakeTimers();
    try {
      const deliver = vi.fn(() => ({
        delivered: false as const,
        reason: 'refused' as const,
      }));
      const { broker, items, capability } = harness({
        launch: 'defer',
        messageCallee: deliver,
      });
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'work',
        mode: 'async',
      });
      broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'queued correction',
      });
      broker.cancelAgent('run-1', 'orch', {
        call_id: 'call-1',
        reason: 'withdrawn',
      });
      expect(
        errorOf(
          broker.messageAgent('run-1', 'orch', {
            call_id: 'call-1',
            message: 'after cancel',
          }),
        ),
      ).toContain('NOT_DELIVERED');
      await vi.advanceTimersByTimeAsync(600);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(
        items
          .filter((item) => item.kind === 'call_answer')
          .map((item) => item.payload),
      ).toEqual([
        expect.objectContaining({
          outcome: 'undelivered',
          message: 'queued correction',
        }),
        expect.objectContaining({
          outcome: 'undelivered',
          message: 'after cancel',
        }),
      ]);
      const notice = broker.messageDeliveryNotice('run-1', 'orch')!;
      expect(notice.prompt).toContain('queued correction');
      expect(notice.prompt).toContain('after cancel');
      expect(notice.prompt).toContain('withdrawn');
      expect(broker.messageDeliveryNotice('run-1', 'writer')).toBeNull();
      broker.registerRun('run-1', capability);
      expect(broker.messageDeliveryNotice('run-1', 'orch')).toEqual(notice);
      broker.acknowledgeMessageDeliveryNotice('run-1', 'orch', notice);
      expect(broker.messageDeliveryNotice('run-1', 'orch')).toBeNull();
      expect(items.at(-1)?.payload).toMatchObject({
        severity: 'info',
        messageDeliveryNotices: notice.ids,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a failed send to an owned call whose launch failed without a thread', async () => {
    const { broker, items } = harness({ launch: 'throw' });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'work',
      mode: 'async',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'too late',
      }).status,
    ).toBe('error');
    expect(
      items.find((item) => item.kind === 'call_answer')?.payload,
    ).toMatchObject({ outcome: 'undelivered', message: 'too late' });
    expect(broker.messageDeliveryNotice('run-1', 'orch')?.prompt).toContain(
      'too late',
    );
  });

  it('records a held message as UNDELIVERED when the call ends before it lands', async () => {
    const { broker, items, deferred } = harness({
      launch: 'defer',
      messageCallee: () => ({ delivered: false, reason: 'refused' }),
    });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.messageAgent('run-1', 'orch', {
      call_id: 'call-1',
      message: 'too late',
    });

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });

    expect(
      items.find((item) => item.kind === 'call_answer')?.payload,
    ).toMatchObject({ message: 'too late', outcome: 'undelivered' });
  });
});

describe('CallBroker — every conversation of a member is a caller of its own', () => {
  // Manager → two async Engineer calls (features A and B), each Engineer
  // delegating to a Researcher. PROBED on the member-keyed broker: conversation
  // A's `await_agent()` returned "RESULT FOR FEATURE B", and B was then told
  // UNKNOWN_CALL for its own call.
  const RESEARCHER: TeamMember = member('res');
  const engineerIn = (call: string): string => callerKey('helper', call);

  async function twoConversations() {
    const h = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
    });
    for (const feature of ['A', 'B']) {
      await h.broker.callAgent('run-1', 'orch', {
        title: 'build',
        agent: 'helper',
        message: `feature ${feature}`,
        mode: 'async',
      });
    }
    // Each Engineer delegates from inside the call it answers.
    for (const call of ['call-1', 'call-2']) {
      await h.broker.callAgent('run-1', engineerIn(call), {
        title: 'research',
        agent: 'res',
        message: `research for ${call}`,
        mode: 'async',
      });
    }
    return h;
  }

  const DONE = (text: string): CalleeTurnOutcome => ({
    status: 'completed',
    finalText: text,
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: null,
  });

  it('hands a conversation only the results of ITS OWN calls', async () => {
    const { broker, deferred } = await twoConversations();
    // Feature B's research lands first.
    deferred[3]!.resolve(DONE('RESULT FOR FEATURE B'));

    const a = await broker.awaitAgent('run-1', engineerIn('call-1'), {
      timeout_ms: 20,
    });
    expect(a).toMatchObject({ status: 'pending', call_id: 'call-3' });
    expect(JSON.stringify(a)).not.toContain('FEATURE B');

    expect(
      await broker.awaitAgent('run-1', engineerIn('call-2'), {
        call_id: 'call-4',
      }),
    ).toMatchObject({ status: 'ok', result: { text: 'RESULT FOR FEATURE B' } });
  });

  it('drains a callee conversation ONCE its call has settled, however many turn-ends asked for it', async () => {
    // The path for a call that SETTLED with its callee's own calls still out —
    // a failed turn, or one past its wake limit; a completed turn is HELD
    // instead (`holdCall`), which this harness's executor double never asks for.
    // A callee conversation's turn IS its call, still settling when the turn
    // ends — so its drain waits for the settle. Two drains waiting at once
    // would each run: the first wakes the conversation for the question, the
    // second then finds it already told and orphans it.
    const h = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', engineerIn('call-1'), {
      title: 'research',
      agent: 'res',
      message: 'look it up',
      mode: 'async',
    });
    h.broker.parkQuestion('run-1', 'call-2', {
      question: 'Which source?',
      options: [],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
    h.broker.drainCaller('run-1', engineerIn('call-1'));
    h.broker.drainCaller('run-1', engineerIn('call-1'));
    h.deferred[0]!.resolve({ ...DONE('dispatched'), sessionId: 'sess-1' });
    await new Promise((resolve) => setImmediate(resolve));

    // Picked back up once — in its own conversation, as a call for its caller.
    expect(h.launches.map((l) => l.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    expect(h.launches[2]).toMatchObject({
      conversationId: 'call-1',
      resumeSessionId: 'sess-1',
    });
    // A wake: it serves a call already running, so it never queues under the
    // active-turn cap — the calls the agent itself made do.
    expect(h.wakes).toEqual(['call-3']);
    h.deferred[2]!.resolve(DONE('looked at it'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      h.items.filter(
        (item) =>
          item.kind === 'call_answer' && item.payload.outcome === 'orphaned',
      ),
    ).toEqual([]);
  });

  it('picks a COLD, large conversation back up anyway — the cost rule binds callers, not geniro', async () => {
    // What geniro owes a conversation (its own callee's answer) is delivered by
    // continuing it, and the cold-resume refusal must not stand in the way:
    // there is no brief anyone could start a fresh instance from.
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.UTC(2026, 9, 11, 9, 0, 0);
    vi.setSystemTime(start);
    try {
      const h = harness({
        launch: 'defer',
        calleesOf: new Map([
          ['orch', [HELPER]],
          ['helper', [RESEARCHER]],
        ]),
      });
      await h.broker.callAgent('run-1', 'orch', {
        title: 'build',
        agent: 'helper',
        message: 'feature A',
        mode: 'async',
      });
      await h.broker.callAgent('run-1', engineerIn('call-1'), {
        title: 'research',
        agent: 'res',
        message: 'look it up',
        mode: 'async',
      });
      h.broker.parkQuestion('run-1', 'call-2', {
        question: 'Which source?',
        options: [],
        payload: {},
        deliver: () => true,
        fail: () => {},
      });
      h.deferred[0]!.resolve({
        ...DONE('dispatched'),
        sessionId: 'sess-1',
        promptCacheTtlMs: 60 * 60_000,
        contextTokens: 900_000,
        contextWindowTokens: 1_000_000,
      });
      await new Promise((resolve) => setImmediate(resolve));
      vi.setSystemTime(start + 3 * 60 * 60_000);
      h.broker.drainCaller('run-1', engineerIn('call-1'));
      await new Promise((resolve) => setImmediate(resolve));

      expect(h.launches[2]).toMatchObject({
        callId: 'call-3',
        conversationId: 'call-1',
        resumeSessionId: 'sess-1',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * Engineer answering the Manager's call-1 (session `sess-1`), which has
   * settled, having delegated call-2 to the Researcher from inside it — the
   * state in which a question or a result owed to that conversation has no
   * live turn to reach.
   */
  async function engineerWhoseCallEnded() {
    const h = harness({
      launch: 'defer',
      isNodeLive: () => false,
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', engineerIn('call-1'), {
      title: 'research',
      agent: 'res',
      message: 'look it up',
      mode: 'async',
    });
    h.deferred[0]!.resolve({ ...DONE('dispatched'), sessionId: 'sess-1' });
    await new Promise((resolve) => setImmediate(resolve));
    return h;
  }

  it('leaves a question for a conversation whose continuation is still QUEUED to that call — never orphans it', async () => {
    // The Manager has continued the Engineer's conversation (call-3), but the
    // call is waiting for a pool slot, so the conversation is not LIVE. The
    // wake read that THREAD_BUSY as "nobody can be reached": QUESTION_ORPHANED,
    // and the Researcher was killed under its own question.
    const h = await engineerWhoseCallEnded();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and feature B',
      thread: 'call-1',
      mode: 'async',
    });
    const failed = { count: 0 };
    h.broker.parkQuestion('run-1', 'call-2', {
      question: 'Which source?',
      options: [],
      payload: {},
      deliver: () => true,
      fail: () => {
        failed.count += 1;
      },
    });
    expect(failed.count).toBe(0);
    expect(
      h.items.filter(
        (item) =>
          item.kind === 'call_answer' && item.payload.outcome === 'orphaned',
      ),
    ).toEqual([]);
    // Nothing continued the conversation beside the call that holds it.
    expect(h.launches).toHaveLength(3);

    // That call's turn ends without answering: now it is picked back up for
    // the question, from the newest point of the conversation.
    h.deferred[2]!.resolve({ ...DONE('feature B done'), sessionId: 'sess-3' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.launches).toHaveLength(4);
    expect(h.launches[3]).toMatchObject({
      conversationId: 'call-1',
      resumeSessionId: 'sess-3',
    });
    expect(h.launches[3]!.message).toContain('Which source?');
    expect(failed.count).toBe(0);
  });

  it('continues from the newest point that HAS a session — not a continuation stopped before it ran', async () => {
    // A continuation cancelled while queued leaves a thread record with no
    // session. Continuing from it is THREAD_UNAVAILABLE, and the finished
    // research was never delivered.
    const h = await engineerWhoseCallEnded();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and feature B',
      thread: 'call-1',
      mode: 'async',
    });
    h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-3',
      reason: 'not needed after all',
    });
    await new Promise((resolve) => setImmediate(resolve));

    // The research lands for a conversation with no turn to take it.
    h.broker.noteCalleeSettling('run-1', 'call-2');
    expect(h.launches).toHaveLength(4);
    expect(h.launches[3]).toMatchObject({
      conversationId: 'call-1',
      resumeSessionId: 'sess-1',
    });
    expect(h.launches[3]!.message).toContain('call-2');
  });

  it('refuses one conversation collecting, cancelling, steering or answering another’s call', async () => {
    const { broker, cancelledTurns, messages } = await twoConversations();
    const other = engineerIn('call-2');
    expect(
      errorOf(await broker.awaitAgent('run-1', other, { call_id: 'call-3' })),
    ).toContain('UNKNOWN_CALL');
    expect(
      errorOf(
        broker.cancelAgent('run-1', other, { call_id: 'call-3', reason: 'no' }),
      ),
    ).toContain('UNKNOWN_CALL');
    expect(
      errorOf(
        broker.messageAgent('run-1', other, {
          call_id: 'call-3',
          message: 'change of plan',
        }),
      ),
    ).toContain('UNKNOWN_CALL');
    broker.parkQuestion('run-1', 'call-3', {
      question: 'Which source?',
      options: [],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
    expect(
      errorOf(
        broker.answerAgent('run-1', other, { call_id: 'call-3', answer: 'X' }),
      ),
    ).toContain('UNKNOWN_CALL');
    expect(cancelledTurns).toEqual([]);
    expect(messages.map((m) => m.text)).not.toContain('change of plan');
    // The member as a whole owns none of them either.
    expect(
      errorOf(
        await broker.awaitAgent('run-1', 'helper', { call_id: 'call-3' }),
      ),
    ).toContain('UNKNOWN_CALL');
    // …while the conversation that made it does — so the refusals above are
    // about ownership, not about a call that was never there.
    expect(
      broker.answerAgent('run-1', engineerIn('call-1'), {
        call_id: 'call-3',
        answer: 'Docs',
      }),
    ).toMatchObject({ status: 'ok', result: { state: 'answered' } });
  });

  it('files the notes told to a WORKING callee conversation inside the call it answers', async () => {
    // REPORTED (run `99ac3def`, seq 5441): the Senior Engineer, answering the
    // Manager's call-10, was told its Middle Engineer finished call-11. The
    // note carried no callId, so call membership put it in the run's own flow,
    // where it was drawn as a stray "Senior Engineer" block of its own.
    const { broker, deferred, items } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
      tellLiveNode: () => true,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    for (const topic of ['sources', 'prior art']) {
      await broker.callAgent('run-1', engineerIn('call-1'), {
        title: 'research',
        agent: 'res',
        message: topic,
        mode: 'async',
      });
    }

    // The question twin: call-3's callee asks while the Engineer works.
    broker.parkQuestion('run-1', 'call-3', {
      question: 'Which source?',
      options: [],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
    // The result twin: call-2 settles while the Engineer works.
    broker.noteCalleeSettling('run-1', 'call-2');
    deferred[1]!.resolve(DONE('found'));

    const notes = items.filter(
      (item) =>
        item.kind === 'system' &&
        String(item.payload.message).includes('while it was working'),
    );
    expect(notes.map((note) => note.payload.message)).toEqual([
      expect.stringContaining('question in call-3'),
      expect.stringContaining('finished call-2'),
    ]);
    for (const note of notes) {
      expect(note.memberId).toBe('helper');
      expect(note.payload.callId).toBe('call-1');
    }
  });

  it('keeps the notes told to a member’s OWN working conversation in the run’s flow', async () => {
    const { broker, items } = harness({
      launch: 'defer',
      tellLiveNode: () => true,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    broker.noteCalleeSettling('run-1', 'call-1');
    const note = items.find((item) => item.kind === 'system');
    expect(note?.payload.message).toContain('finished call-1');
    expect(note?.payload).not.toHaveProperty('callId');
  });
});

describe('CallBroker — a wait never outlives the caller CLI’s own tool-call deadline', () => {
  // cursor-agent gives every MCP tool call a fixed 60s, and on expiry sends
  // `notifications/cancelled` while keeping the POST open. A wait that runs on
  // past that is a waiter nobody reads: a question parked on another call
  // would be handed to it, marked delivered, and fail QUESTION_TIMEOUT unseen.
  afterEach(() => {
    vi.useRealTimers();
  });

  const COMPLETED: CalleeTurnOutcome = {
    status: 'completed',
    finalText: 'the work',
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: 'sess-1',
  };

  it('answers an await `pending` below the deadline, whatever window it asked for — and the next question reaches the NEXT wait', async () => {
    vi.useFakeTimers();
    const { broker } = harness({
      launch: 'defer',
      toolCallDeadlineMs: () => 60_000,
    });
    for (const agent of ['helper', 'writer']) {
      await broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent,
        message: 'm',
        mode: 'async',
      });
    }
    let first: unknown;
    void broker
      .awaitAgent('run-1', 'orch', { call_id: 'call-1', timeout_ms: 240_000 })
      .then((envelope) => {
        first = envelope;
      });
    await vi.advanceTimersByTimeAsync(47_000);
    expect(first).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2_000);
    // Answered before the CLI gives up, not by the CLI giving up.
    expect(first).toMatchObject({ status: 'pending', call_id: 'call-1' });

    // Past the point the CLI would have abandoned that request: a question
    // parked now must not be handed to it.
    await vi.advanceTimersByTimeAsync(15_000);
    broker.parkQuestion('run-1', 'call-2', {
      question: 'Which DB?',
      options: ['pg', 'sqlite'],
      payload: {},
      deliver: () => true,
      fail: () => {},
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { timeout_ms: 240_000 }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-2',
      question: 'Which DB?',
    });
  });

  it('turns a SYNC call that outlasts the deadline into a collectable one, naming its call id', async () => {
    vi.useFakeTimers();
    const { broker, deferred } = harness({
      launch: 'defer',
      toolCallDeadlineMs: () => 60_000,
    });
    let answered: unknown;
    void broker
      .callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'a long job',
      })
      .then((envelope) => {
        answered = envelope;
      });
    await vi.advanceTimersByTimeAsync(49_000);
    expect(answered).toMatchObject({
      status: 'pending',
      call_id: 'call-1',
      agent: 'helper',
    });
    expect(JSON.stringify(answered)).toContain('await_agent');

    deferred[0]!.resolve(COMPLETED);
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'ok', result: { text: 'the work' } });
  });

  it('names the ceiling it applies, and none for a caller no deadline bounds', () => {
    expect(
      harness({ toolCallDeadlineMs: () => 60_000 }).broker.waitCeiling(
        'run-1',
        'orch',
      ),
    ).toBe(48_000);
    expect(harness().broker.waitCeiling('run-1', 'orch')).toBeNull();
  });
});

describe('CallBroker — waking a caller when a usage limit resets', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const RATE_LIMITED: Partial<CalleeTurnOutcome> = {
    status: 'failed',
    finalText: null,
    error: "You've hit your session limit · resets 6:10pm (UTC)",
    failureClass: 'rate_limited',
    resetsAt: '6:10pm (UTC)',
  };

  it('starts the caller again once the window reopens, naming the thread to continue', async () => {
    // REPORTED: nothing woke the Manager at the reset, so it ran `sleep 5300`
    // in a shell to do it, and the team sat idle 2h23m.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const woken: { node: string; prompt: string }[] = [];
    const { broker, items } = harness({
      isNodeLive: () => false,
      wakeNode: (node, prompt) => {
        woken.push({ node, prompt });
        return true;
      },
      instantOutcome: RATE_LIMITED,
    });

    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // The caller is told it will be woken, so it does not set a timer itself.
    expect(errorOf(envelope)).toContain(
      'geniro starts you again when it resets',
    );

    // 18:10 UTC plus the minute's grace is 71 minutes away.
    vi.advanceTimersByTime(70 * 60_000 + 59_000);
    expect(woken).toEqual([]);
    vi.advanceTimersByTime(2_000);

    expect(woken).toHaveLength(1);
    expect(woken[0]!.node).toBe('orch');
    expect(woken[0]!.prompt).toContain('thread: "call-1"');
    expect(
      items.some(
        (item) =>
          item.kind === 'system' &&
          String(item.payload.message).includes('usage limit reset'),
      ),
    ).toBe(true);
  });

  it('fires at the wake when the reset came due while the machine slept', async () => {
    // The opposite of a silence deadline: this names an INSTANT, and once it
    // has passed the promised continue is owed — a sleep through it must not
    // push it another window later. Sleeping 17:00 → 21:00 over an 18:11 wake.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const woken: string[] = [];
    const { broker } = harness({
      isNodeLive: () => false,
      wakeNode: (node) => {
        woken.push(node);
        return true;
      },
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    await simulateSleep(4 * 60 * 60_000);

    expect(woken).toEqual(['orch']);
  });

  it('wakes a caller ONCE for every call one reset stopped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const woken: string[] = [];
    const { broker } = harness({
      isNodeLive: () => false,
      wakeNode: (_node, prompt) => {
        woken.push(prompt);
        return true;
      },
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'a',
      agent: 'helper',
      message: 'm',
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'b',
      agent: 'writer',
      message: 'm',
    });

    vi.advanceTimersByTime(72 * 60_000);

    expect(woken).toHaveLength(1);
    expect(woken[0]).toContain('call-1');
    expect(woken[0]).toContain('call-2');
  });

  it('hands the news to a caller that is WORKING instead of starting a turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const told: string[] = [];
    const wakeNode = vi.fn(() => true);
    const { broker } = harness({
      isNodeLive: () => true,
      tellLiveNode: (_node, prompt) => {
        told.push(prompt);
        return true;
      },
      wakeNode,
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    vi.advanceTimersByTime(72 * 60_000);

    expect(told).toHaveLength(1);
    expect(wakeNode).not.toHaveBeenCalled();
  });

  it('wakes the caller with the news once the turn that dropped it has ended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    let live = true;
    let dropped: (() => void) | undefined;
    const wakeNode = vi.fn(() => true);
    const { broker } = harness({
      isNodeLive: () => live,
      tellLiveNode: (_node, _prompt, redeliver) => {
        dropped = redeliver;
        return true;
      },
      wakeNode,
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.advanceTimersByTime(72 * 60_000);
    expect(wakeNode).not.toHaveBeenCalled();

    // The executor runs this once the working turn ended without taking it.
    live = false;
    dropped!();

    expect(wakeNode).toHaveBeenCalledExactlyOnceWith(
      'orch',
      expect.stringContaining('has reset'),
    );
  });

  it('fires nothing into a run that was torn down meanwhile', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const wakeNode = vi.fn(() => true);
    const { broker } = harness({
      isNodeLive: () => false,
      wakeNode,
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    broker.unregisterRun('run-1');
    vi.advanceTimersByTime(72 * 60_000);

    expect(wakeNode).not.toHaveBeenCalled();
  });

  it('still wakes the caller when a later pass of the run registered its call surface meanwhile', async () => {
    // The caller is told to WAIT for the reset rather than set a timer — and
    // any message the user sends in those hours starts a new pass, which
    // registers the run again. A wake kept on the state it was scheduled in,
    // bailing once that state is no longer the run's, would be silently
    // cancelled by the one message most likely to arrive.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const staleWake = vi.fn(() => true);
    const { broker, capability, items, launches } = harness({
      isNodeLive: () => false,
      wakeNode: staleWake,
      instantOutcome: RATE_LIMITED,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    // The next pass: a capability of its own, seeded from the transcript as
    // the executor seeds it.
    const woken: { node: string; prompt: string }[] = [];
    broker.registerRun(
      'run-1',
      {
        ...capability,
        wakeNode: (node, prompt) => {
          woken.push({ node, prompt });
          return true;
        },
      },
      readCallSeed(items),
    );
    vi.advanceTimersByTime(72 * 60_000);

    // Woken through the CURRENT pass — the previous one's walk is over.
    expect(staleWake).not.toHaveBeenCalled();
    expect(woken).toHaveLength(1);
    expect(woken[0]!.node).toBe('orch');
    expect(woken[0]!.prompt).toContain('thread: "call-1"');

    // …and the thread it names is one the new pass can continue.
    await broker.callAgent('run-1', 'orch', {
      title: 'again',
      agent: 'helper',
      message: 'carry on',
      thread: 'call-1',
    });
    expect(launches.at(-1)?.resumeSessionId).toBe('sess-call-1');
  });

  it('tells a callee conversation its reset once the call QUEUED on it is over — never "could not be reached"', async () => {
    // The Engineer's call-1 has ended; its Researcher (call-2) hit the limit;
    // when the window reopens the Manager's continuation of that conversation
    // (call-3) is still waiting for a slot, so the conversation is not live.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const researcher: TeamMember = member('res');
    const { broker, deferred, launches, items } = harness({
      launch: 'defer',
      isNodeLive: () => false,
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [researcher]],
      ]),
    });
    const engineer = callerKey('helper', 'call-1');
    const done = (text: string, sessionId: string): CalleeTurnOutcome => ({
      status: 'completed',
      finalText: text,
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    await broker.callAgent('run-1', engineer, {
      title: 'research',
      agent: 'res',
      message: 'look it up',
      mode: 'async',
    });
    deferred[0]!.resolve(done('dispatched', 'sess-1'));
    await vi.advanceTimersByTimeAsync(0);
    await broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and feature B',
      thread: 'call-1',
      mode: 'async',
    });
    deferred[1]!.resolve({
      ...RATE_LIMITED,
      sessionId: 'sess-2',
    } as CalleeTurnOutcome);
    await vi.advanceTimersByTimeAsync(0);

    // The window reopens while call-3 still waits: nothing is said yet…
    await vi.advanceTimersByTimeAsync(72 * 60_000);
    const resetRows = () =>
      items.filter(
        (item) =>
          item.kind === 'system' &&
          String(item.payload.message).includes('usage limit reset'),
      );
    expect(resetRows()).toEqual([]);
    expect(launches).toHaveLength(3);

    // …and once call-3 is over, the conversation is picked back up with it.
    deferred[2]!.resolve(done('feature B done', 'sess-3'));
    await vi.advanceTimersByTimeAsync(0);
    expect(launches).toHaveLength(4);
    expect(launches[3]).toMatchObject({
      conversationId: 'call-1',
      resumeSessionId: 'sess-3',
    });
    expect(launches[3]!.message).toContain('has reset');
    expect(resetRows().map((row) => row.payload.message)).toEqual([
      expect.stringContaining('told this agent to continue call-2'),
    ]);
  });

  it('leaves a reset it cannot place in time to the caller, and promises nothing', async () => {
    vi.useFakeTimers();
    const wakeNode = vi.fn(() => true);
    const { broker } = harness({
      isNodeLive: () => false,
      wakeNode,
      instantOutcome: { ...RATE_LIMITED, resetsAt: 'soon' },
    });
    const envelope = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(errorOf(envelope)).not.toContain('geniro starts you again');
    vi.advanceTimersByTime(3 * 24 * 60 * 60_000);
    expect(wakeNode).not.toHaveBeenCalled();
  });

  // 18:10 UTC on the day the harness clock is set to, and the minute after it
  // the continue is made.
  const RESET_AT = Date.UTC(2026, 8, 22, 18, 10);
  const CONTINUES_AT = RESET_AT + 60_000;
  const PROMISED = {
    instant: RESET_AT,
    continuesAt: CONTINUES_AT,
    resetsAt: '6:10pm (UTC)',
    owners: [
      { owner: 'orch', calls: [{ callId: 'call-1', callee: 'Helper' }] },
    ],
  };

  /** Every hook the executor lends the broker, as spies. */
  function hooks() {
    return {
      save: vi.fn(),
      wakeRestoredRun: vi.fn(),
      note: vi.fn(),
    };
  }

  it('SAYS the promise in the caller’s transcript, and files it on the run row, the moment it is made', async () => {
    // The agent is told geniro will continue it at the reset, so the screen
    // has to say so, and when.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const lent = hooks();
    const { broker, items } = harness({
      isNodeLive: () => false,
      wakeNode: () => true,
      instantOutcome: RATE_LIMITED,
    });
    broker.useResetWakeHooks(lent);

    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(lent.save).toHaveBeenLastCalledWith('run-1', [PROMISED]);
    const said = items.find(
      (item) =>
        item.kind === 'system' &&
        (item.payload.resetWake as { phase?: string } | undefined)?.phase ===
          'scheduled',
    );
    expect(said?.memberId).toBe('orch');
    expect(said?.payload.message).toContain(
      'call-1 stopped at the usage limit — geniro continues it',
    );
    expect(said?.payload.resetWake).toEqual({
      phase: 'scheduled',
      instant: RESET_AT,
      continuesAt: CONTINUES_AT,
      callIds: ['call-1'],
    });
  });

  it('writes the promise off the row once it is kept', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const lent = hooks();
    const { broker } = harness({
      isNodeLive: () => false,
      wakeNode: () => true,
      instantOutcome: RATE_LIMITED,
    });
    broker.useResetWakeHooks(lent);
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    vi.advanceTimersByTime(72 * 60_000);

    expect(lent.save).toHaveBeenLastCalledWith('run-1', []);
  });

  it('calls a promised continue OFF on the user’s press, and says so', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const lent = hooks();
    const wakeNode = vi.fn(() => true);
    const { broker, items } = harness({
      isNodeLive: () => false,
      wakeNode,
      instantOutcome: RATE_LIMITED,
    });
    broker.useResetWakeHooks(lent);
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(broker.cancelResetWakes('run-1')).toEqual(['call-1']);
    vi.advanceTimersByTime(72 * 60_000);

    expect(wakeNode).not.toHaveBeenCalled();
    expect(lent.save).toHaveBeenLastCalledWith('run-1', []);
    expect(
      items.some(
        (item) =>
          (item.payload.resetWake as { phase?: string } | undefined)?.phase ===
          'cancelled',
      ),
    ).toBe(true);
    // Nothing left to call off.
    expect(broker.cancelResetWakes('run-1')).toEqual([]);
  });

  it('keeps a promise across a daemon RESTART — the run’s next pass makes it', async () => {
    // A brand-new broker is a restarted daemon: nothing in memory, only the row.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const restarted = new CallBroker();
    const lent = hooks();
    restarted.useResetWakeHooks(lent);
    restarted.restoreResetWakes('run-1', [PROMISED]);

    const woken: { node: string; prompt: string }[] = [];
    const { capability, items } = harness({
      isNodeLive: () => false,
      wakeNode: (node, prompt) => {
        woken.push({ node, prompt });
        return true;
      },
    });
    restarted.registerRun('run-1', capability, readCallSeed(items));
    vi.advanceTimersByTime(72 * 60_000);

    expect(woken).toHaveLength(1);
    expect(woken[0]!.node).toBe('orch');
    expect(woken[0]!.prompt).toContain('thread: "call-1"');
    expect(lent.wakeRestoredRun).not.toHaveBeenCalled();
  });

  it('hands a restored promise no pass has picked up to the executor at the reset', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const restarted = new CallBroker();
    const lent = hooks();
    restarted.useResetWakeHooks(lent);
    restarted.restoreResetWakes('run-1', [PROMISED]);

    vi.advanceTimersByTime(70 * 60_000);
    expect(lent.wakeRestoredRun).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * 60_000);

    expect(lent.wakeRestoredRun).toHaveBeenCalledWith('run-1', PROMISED);
    expect(lent.save).toHaveBeenLastCalledWith('run-1', []);
  });

  it('keeps at once a restored promise whose reset passed while the daemon was down', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T19:00:00Z'));
    const restarted = new CallBroker();
    const lent = hooks();
    restarted.useResetWakeHooks(lent);
    restarted.restoreResetWakes('run-1', [PROMISED]);

    vi.advanceTimersByTime(0);

    expect(lent.wakeRestoredRun).toHaveBeenCalledWith('run-1', PROMISED);
  });

  it('calls off a restored promise, noting it on the run it was made to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const restarted = new CallBroker();
    const lent = hooks();
    restarted.useResetWakeHooks(lent);
    restarted.restoreResetWakes('run-1', [PROMISED]);

    expect(restarted.cancelResetWakes('run-1')).toEqual(['call-1']);
    vi.advanceTimersByTime(72 * 60_000);

    expect(lent.wakeRestoredRun).not.toHaveBeenCalled();
    expect(lent.note).toHaveBeenCalledWith(
      'run-1',
      'orch',
      expect.objectContaining({
        resetWake: expect.objectContaining({ phase: 'cancelled' }),
      }),
    );
    expect(lent.save).toHaveBeenLastCalledWith('run-1', []);
  });

  it('drops a restored promise with the run it was made to', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    const restarted = new CallBroker();
    const lent = hooks();
    restarted.useResetWakeHooks(lent);
    restarted.restoreResetWakes('run-1', [PROMISED]);

    restarted.unregisterRun('run-1');
    vi.advanceTimersByTime(72 * 60_000);

    expect(lent.wakeRestoredRun).not.toHaveBeenCalled();
  });
});

describe('CallBroker — cancel_agent', () => {
  it('stops the callee turn and stamps WHO cancelled it and WHY onto the envelope', async () => {
    const { broker, cancelledTurns, items } = harness({ launch: 'defer' });
    const call = broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });
    expect((await call).status).toBe('ok');

    expect(
      broker.cancelAgent('run-1', 'orch', {
        call_id: 'call-1',
        reason: 'its premise was refuted',
      }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', state: 'cancelling' },
    });
    // The executor was really asked to stop that turn.
    expect(cancelledTurns).toEqual(['call-1']);

    // And the reason travels: a cancelled call's record must say who ended it,
    // or a hundred-minute call ending early leaves nothing behind but its cost.
    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(errorOf(collected)).toContain('CALLEE_CANCELLED');
    expect(errorOf(collected)).toContain('stopped by orch');
    expect(errorOf(collected)).toContain('its premise was refuted');
    // The transcript's own row carries it too — `call_result` holds the envelope.
    const result = items.find((item) => item.kind === 'call_result');
    expect(JSON.stringify(result?.payload)).toContain(
      'its premise was refuted',
    );
  });

  it('refuses a call the asking member does not own, as UNKNOWN_CALL', async () => {
    // A callee is handed the same endpoint SHAPE as its caller, so without the
    // broker's own ownership check a nested agent could stop a sibling's work.
    // UNKNOWN_CALL rather than a refusal on `answerAgent`'s rule: a caller has
    // no business learning that a call it does not own exists.
    const { broker, cancelledTurns } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(
      errorOf(
        broker.cancelAgent('run-1', 'writer', {
          call_id: 'call-1',
          reason: 'not mine to stop',
        }),
      ),
    ).toContain('UNKNOWN_CALL');
    expect(cancelledTurns).toEqual([]);
  });

  it('refuses a call that has already settled', async () => {
    // The `instant` harness settles every call as it is made, so there is no
    // live turn left — and saying "cancelled" about one would tell the caller it
    // had stopped work that had already finished and been collected.
    const { broker, cancelledTurns } = harness();
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    expect(
      errorOf(
        broker.cancelAgent('run-1', 'orch', {
          call_id: 'call-1',
          reason: 'too late',
        }),
      ),
    ).toMatch(/^CALL_FINISHED: .*nothing of it is left to collect/);
    expect(cancelledTurns).toEqual([]);
  });

  it('refuses when the run holds no call surface at all', async () => {
    const { broker } = harness();
    expect(
      errorOf(
        broker.cancelAgent('run-9', 'orch', {
          call_id: 'call-1',
          reason: 'no run',
        }),
      ),
    ).toContain('RUN_NOT_ACTIVE');
  });

  it('keeps a COMPLETED result when the stop lost the race to the callee’s own ending', async () => {
    // The stop was asked for, but the callee's turn finished anyway (its
    // result line was already out when the cancel reached it). The reason must
    // not be stamped over the work: the caller would collect CALLEE_CANCELLED
    // for a call whose result exists and was paid for.
    const { broker, capability, deferred } = harness({ launch: 'defer' });
    // A turn that could not be stopped any more — the signal lands, nothing ends.
    capability.cancelCalleeTurn = () => true;
    await broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });
    broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'changed my mind',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'THE FINISHED WORK',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
    });

    const collected = await broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
    });
    expect(collected).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1', text: 'THE FINISHED WORK' },
    });
  });

  it('stops NOTHING once the callee’s turn has ended, and says its result stands', async () => {
    // The executor holds a call open after its turn ends — draining its rows,
    // possibly compacting the conversation. A cancel in that window must not
    // answer `cancelling` and discard the finished result (also driven
    // through the executor in its own spec).
    const { broker, cancelledTurns, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'build it',
      agent: 'helper',
      message: 'build the thing',
      mode: 'async',
    });
    broker.noteCalleeTurnEnded('run-1', 'call-1');

    const answered = broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'changed my mind',
    });
    expect(answered).toMatchObject({
      status: 'ok',
      result: { call_id: 'call-1', state: 'already_finished' },
    });
    expect(JSON.stringify(answered)).toContain('await_agent');
    // The executor was never asked to stop a turn that is over.
    expect(cancelledTurns).toEqual([]);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'THE FINISHED WORK',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'ok', result: { text: 'THE FINISHED WORK' } });
  });

  it('resolves a question parked on the cancelled call instead of leaving its row dangling', async () => {
    // A callee parked on a question dies with the turn, and the transcript's
    // question row is answered by nothing unless this says so — the same
    // obligation `failParked` carries for a timeout.
    const { broker, items } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const failed = { count: 0 };
    expect(
      broker.parkQuestion('run-1', 'call-1', {
        question: 'Which color?',
        options: ['Red', 'Blue'],
        payload: null,
        deliver: () => true,
        fail: () => {
          failed.count += 1;
        },
      }),
    ).toBe(true);

    broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'withdrawn',
    });

    const answer = items.find(
      (item) => item.kind === 'call_answer' && item.payload.outcome,
    );
    expect(answer?.payload.outcome).toBe('cancelled');
  });
});

describe('CallBroker — the user writes to a caller that is waiting', () => {
  // A message delivered mid-turn is read by the CLI at its next tool
  // boundary, and a wait on a callee is ONE tool call — so a Manager in
  // `await_agent` held the user's message unread until its Engineer finished.
  const started = async (broker: CallBroker): Promise<void> => {
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
  };

  it('releases an open await_agent with an interrupted pending, consuming nothing', async () => {
    const { broker, items, deferred } = harness({ launch: 'defer' });
    await started(broker);
    const waiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(broker.interruptWaits('run-1', 'orch')).toBe(true);
    const envelope = await waiting;
    expect(envelope).toMatchObject({
      status: 'pending',
      call_id: 'call-1',
      agent: 'helper',
      interrupted: 'user_message',
    });
    expect(items.map((i) => i.kind)).toEqual(['call_started']);
    // The wait no longer counts the caller as waiting.
    expect(broker.awaitingCalls('run-1')).toBe(0);

    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'built',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'built' },
    });
  });

  it('tells a released caller a message may come from another thread, not only from the user', async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    const waiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    await new Promise((resolve) => setImmediate(resolve));
    broker.interruptWaits('run-1', 'orch');

    const envelope = await waiting;
    expect(envelope).toMatchObject({
      interrupted: 'user_message',
      note: expect.stringContaining('from the user or from another thread'),
    });
    expect(JSON.stringify(envelope)).not.toContain('The user sent you');
  });

  it('releases a wait over ALL calls, naming what it was waiting on', async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    const waiting = broker.awaitAgent('run-1', 'orch', {});
    await new Promise((resolve) => setImmediate(resolve));
    broker.interruptWaits('run-1', 'orch');
    expect(await waiting).toMatchObject({
      status: 'pending',
      interrupted: 'user_message',
      waiting_on: [{ call_id: 'call-1', agent: 'helper' }],
    });
  });

  it('releases a SYNC call_agent and leaves the call await-collectable', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const calling = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    await new Promise((resolve) => setImmediate(resolve));
    broker.interruptWaits('run-1', 'orch');
    expect(await calling).toMatchObject({
      status: 'pending',
      call_id: 'call-1',
      interrupted: 'user_message',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'late',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'ok' });
  });

  it('a message sent before the wait began makes the NEXT wait return at once — once', async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    expect(broker.interruptWaits('run-1', 'orch')).toBe(false);
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'pending', interrupted: 'user_message' });
    // Only once: the wait after it blocks as usual.
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 1,
      }),
    ).toEqual({ status: 'pending', call_id: 'call-1', agent: 'helper' });
  });

  // A message releases a WAIT; it must never stand in front of an answer that
  // already exists. On run `bd1e43ae` the Manager was woken for a finished
  // call in the same second the user wrote to it, and its await was answered
  // "still running" — so it reported the fix as in progress for good.
  it('hands over a call that already FINISHED, and leaves the message for the next real wait', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await started(broker);
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'built',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(broker.interruptWaits('run-1', 'orch')).toBe(false);

    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'built' },
    });
    // Still unread: a wait that genuinely has to block still makes way for it.
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm2',
      mode: 'async',
    });
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-2' }),
    ).toMatchObject({
      status: 'pending',
      call_id: 'call-2',
      interrupted: 'user_message',
    });
  });

  it("hands await_agent the awaited call's parked question over an unread message", async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    broker.parkQuestion('run-1', 'call-1', {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: null,
      deliver: () => true,
      fail: () => {},
    });
    broker.interruptWaits('run-1', 'orch');
    expect(
      await broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      question: 'Which color?',
    });
  });

  it("hands a SYNC call_agent another call's unseen question over an unread message", async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    broker.parkQuestion('run-1', 'call-1', {
      question: 'Which color?',
      options: ['Red', 'Blue'],
      payload: null,
      deliver: () => true,
      fail: () => {},
    });
    broker.interruptWaits('run-1', 'orch');
    expect(
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'm2',
      }),
    ).toMatchObject({
      status: 'question',
      call_id: 'call-1',
      still_running: 'call-2',
    });
  });

  it('a message the CLI already took does not cut the next wait short', async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    broker.interruptWaits('run-1', 'orch');
    broker.forgetUserMessage('run-1', 'orch');
    expect(
      await broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 1,
      }),
    ).toEqual({ status: 'pending', call_id: 'call-1', agent: 'helper' });
  });

  it("releases only the addressed member's waits", async () => {
    const { broker } = harness({ launch: 'defer' });
    await started(broker);
    const waiting = broker.awaitAgent('run-1', 'orch', {
      call_id: 'call-1',
      timeout_ms: 20,
    });
    await new Promise((resolve) => setImmediate(resolve));
    broker.interruptWaits('run-1', 'helper');
    expect(await waiting).toEqual({
      status: 'pending',
      call_id: 'call-1',
      agent: 'helper',
    });
  });
});

describe('CallBroker — agent pool', () => {
  // A pool of two on different CLIs, so a launch's `agent` says which member
  // the broker picked.
  const POOLED: TeamMember = {
    ...HELPER,
    pool: [{ agent: 'codex' }],
  };
  const pooledCallees = (
    node: TeamMember = POOLED,
  ): Map<string, TeamMember[]> => new Map([['orch', [node]]]);

  it('defaults to member 1 after an explicit selection and across run passes', async () => {
    const { broker, launches, capability } = harness({
      calleesOf: pooledCallees(),
    });
    const call = (member?: number) =>
      broker.callAgent('run-1', 'orch', {
        title: 'work',
        agent: 'helper',
        message: 'm',
        ...(member !== undefined ? { member } : {}),
      });

    await call();
    await call(2);
    await call();
    broker.registerRun('run-1', capability, null);
    await call();

    expect(launches.map((launch) => launch.callee.agent)).toEqual([
      'claude',
      'codex',
      'claude',
      'claude',
    ]);
  });

  it('starts a call on the member asked for and still plans the rest of the pool as its fallbacks', async () => {
    const { broker, launches } = harness({ calleesOf: pooledCallees() });
    await broker.callAgent('run-1', 'orch', {
      title: 'named',
      agent: 'helper',
      message: 'm',
      member: 1,
    });
    expect(launches[0]!.callee.agent).toBe('claude');
    expect(launches[0]!.pool).toMatchObject({ member: 1, preferred: 1 });
    expect(launches[0]!.pool!.fallbacks.map((f) => f.member)).toEqual([2]);
  });

  it('starts a call on the member asked for while another member is the one a limit spent', async () => {
    const { broker, launches } = harness({ calleesOf: pooledCallees() });
    broker.poolCooldowns.record(
      poolMemberNode(POOLED, 2)!,
      { cwd: null, runId: 'run-1', memberId: 'helper' },
      { status: 'failed', failureClass: 'rate_limited', resetsAt: null },
      true,
    );
    await broker.callAgent('run-1', 'orch', {
      title: 'named',
      agent: 'helper',
      message: 'm',
      member: 1,
    });
    expect(launches[0]!.callee.agent).toBe('claude');
    expect(launches[0]!.pool!.fallbacks.map((f) => f.member)).toEqual([2]);
  });

  it('starts a call past the member asked for while a limit has it spent', async () => {
    const { broker, launches } = harness({ calleesOf: pooledCallees() });
    broker.poolCooldowns.record(
      poolMemberNode(POOLED, 1)!,
      { cwd: null, runId: 'run-1', memberId: 'helper' },
      { status: 'failed', failureClass: 'rate_limited', resetsAt: null },
      true,
    );
    await broker.callAgent('run-1', 'orch', {
      title: 'named',
      agent: 'helper',
      message: 'm',
      member: 1,
    });
    expect(launches[0]!.callee.agent).toBe('codex');
    expect(launches[0]!.pool).toMatchObject({ member: 2, preferred: 1 });
    expect(launches[0]!.pool!.fallbacks.map((f) => f.member)).toEqual([1]);
  });

  it('starts a new call past a member the shared record holds spent, and on member 1 again once it answers', async () => {
    const { broker, launches } = harness({
      calleesOf: pooledCallees({
        ...POOLED,
        pool: [{ agent: 'codex' }, { agent: 'cursor-agent' }],
      }),
    });
    const memberOne = poolMemberNode(POOLED, 1)!;
    const call = (title: string) =>
      broker.callAgent('run-1', 'orch', {
        title,
        agent: 'helper',
        message: title,
      });

    // Any run's attempt may have written it — the record is the daemon's.
    broker.poolCooldowns.record(
      memberOne,
      { cwd: null, runId: 'run-1', memberId: 'helper' },
      { status: 'failed', failureClass: 'auth_expired', resetsAt: null },
      true,
    );
    await call('a');
    broker.poolCooldowns.record(
      memberOne,
      { cwd: null, runId: 'run-1', memberId: 'helper' },
      { status: 'completed', failureClass: null, resetsAt: null },
      false,
    );
    await call('b');
    expect(launches.map((launch) => launch.callee.agent)).toEqual([
      'codex',
      'claude',
    ]);
  });

  describe('a continued thread', () => {
    const SITE = { cwd: null, runId: 'run-1', memberId: 'helper' };
    const spend = (broker: CallBroker, member: number): void => {
      broker.poolCooldowns.record(
        poolMemberNode(POOLED, member)!,
        SITE,
        { status: 'failed', failureClass: 'rate_limited', resetsAt: null },
        true,
      );
    };
    const reopen = (broker: CallBroker, member: number): void => {
      broker.poolCooldowns.record(
        poolMemberNode(POOLED, member)!,
        SITE,
        { status: 'completed', failureClass: null, resetsAt: null },
        false,
      );
    };
    /** call-1, opened while member 1 was spent, so on member 2. */
    async function threadOnMemberTwo(
      options: Parameters<typeof harness>[0] = {},
    ) {
      const h = harness({ calleesOf: pooledCallees(), ...options });
      spend(h.broker, 1);
      await h.broker.callAgent('run-1', 'orch', {
        title: 'open',
        agent: 'helper',
        message: 'm',
      });
      expect(h.launches[0]!.callee.agent).toBe('codex');
      return h;
    }
    const continueThread = (broker: CallBroker) =>
      broker.callAgent('run-1', 'orch', {
        title: 'more',
        agent: 'helper',
        message: 'more',
        thread: 'call-1',
      });

    it('moves back to member 1 once member 1 is available again, handing over member 2’s session', async () => {
      const { broker, launches, items } = await threadOnMemberTwo();
      reopen(broker, 1);
      await continueThread(broker);
      expect(launches[1]!.callee.agent).toBe('claude');
      expect(launches[1]!.resumeSessionId).toBe('sess-call-1');
      expect(launches[1]!.pool).toMatchObject({
        member: 1,
        sessionMember: 2,
      });
      expect(launches[1]!.pool!.fallbacks.map((f) => f.member)).toEqual([2]);
      expect(
        items.find(
          (item) =>
            item.kind === 'call_started' && item.payload.callId === 'call-2',
        )?.payload.member,
      ).toBe(1);
    });

    it('stays on member 2 while member 1 is still spent', async () => {
      const { broker, launches } = await threadOnMemberTwo();
      await continueThread(broker);
      expect(launches[1]!.callee.agent).toBe('codex');
      expect(launches[1]!.pool).toMatchObject({
        member: 2,
        sessionMember: 2,
      });
    });

    it('stays on member 2 while its process still runs work of its own', async () => {
      const asked: string[] = [];
      const { broker, launches } = await threadOnMemberTwo({
        conversationHoldsWork: (conversationId) => {
          asked.push(conversationId);
          return true;
        },
      });
      reopen(broker, 1);
      await continueThread(broker);
      expect(asked).toEqual(['call-1']);
      expect(launches[1]!.callee.agent).toBe('codex');
    });

    it('moves off member 1 when a limit spent it and member 2 is free', async () => {
      const { broker, launches } = harness({ calleesOf: pooledCallees() });
      await broker.callAgent('run-1', 'orch', {
        title: 'open',
        agent: 'helper',
        message: 'm',
      });
      spend(broker, 1);
      await continueThread(broker);
      expect(launches[1]!.callee.agent).toBe('codex');
      expect(launches[1]!.pool).toMatchObject({
        member: 2,
        sessionMember: 1,
      });
    });

    it('takes a member that differs from the thread’s own as its preference, moving there once it is proven', async () => {
      const { broker, launches } = await threadOnMemberTwo();
      const named = await broker.callAgent('run-1', 'orch', {
        title: 'more',
        agent: 'helper',
        message: 'more',
        thread: 'call-1',
        member: 1,
      });
      expect(named.status).toBe('ok');
      expect(launches[1]!.pool).toMatchObject({
        member: 2,
        sessionMember: 2,
        preferred: 1,
      });

      reopen(broker, 1);
      await broker.callAgent('run-1', 'orch', {
        title: 'again',
        agent: 'helper',
        message: 'again',
        thread: 'call-2',
      });
      expect(launches[2]!.callee.agent).toBe('claude');
      expect(launches[2]!.pool).toMatchObject({
        member: 1,
        sessionMember: 2,
        preferred: 1,
      });
    });

    it('goes back to the member asked for once it is available again, across a restart too', async () => {
      const { broker, launches, items, capability } = harness({
        calleesOf: pooledCallees(),
      });
      spend(broker, 2);
      await broker.callAgent('run-1', 'orch', {
        title: 'open',
        agent: 'helper',
        message: 'm',
        member: 2,
      });
      expect(launches[0]!.callee.agent).toBe('claude');
      expect(
        items.find(
          (item) =>
            item.kind === 'call_result' && item.payload.callId === 'call-1',
        )?.payload,
      ).toMatchObject({ member: 1, preferredMember: 2 });

      broker.registerRun(
        'run-1',
        capability,
        readCallSeed(
          items
            .filter(
              (item) =>
                item.kind === 'call_started' || item.kind === 'call_result',
            )
            .map((item) => ({ kind: item.kind, payload: item.payload })),
        ),
      );
      await continueThread(broker);
      expect(launches[1]!.callee.agent).toBe('claude');

      reopen(broker, 2);
      await broker.callAgent('run-1', 'orch', {
        title: 'again',
        agent: 'helper',
        message: 'again',
        thread: 'call-2',
      });
      expect(launches[2]!.callee.agent).toBe('codex');
      expect(launches[2]!.pool).toMatchObject({
        member: 2,
        sessionMember: 1,
        preferred: 2,
      });
    });

    it('reads an older result’s pin as a preference for the member it ran on', async () => {
      const { broker, launches, items, capability } = harness({
        calleesOf: pooledCallees(),
      });
      await broker.callAgent('run-1', 'orch', {
        title: 'open',
        agent: 'helper',
        message: 'm',
        member: 2,
      });
      expect(launches[0]!.callee.agent).toBe('codex');

      broker.registerRun(
        'run-1',
        capability,
        readCallSeed(
          items
            .filter(
              (item) =>
                item.kind === 'call_started' || item.kind === 'call_result',
            )
            .map((item) => {
              const { preferredMember: _preferred, ...payload } =
                item.payload as Record<string, unknown>;
              return {
                kind: item.kind,
                payload:
                  item.kind === 'call_result'
                    ? { ...payload, memberPinned: true }
                    : payload,
              };
            }),
        ),
      );
      reopen(broker, 1);
      await continueThread(broker);
      expect(launches[1]!.callee.agent).toBe('codex');
      expect(launches[1]!.pool).toMatchObject({ member: 2, preferred: 2 });
    });
  });

  it('reads a member as the account its run’s folder pins', async () => {
    const poolCooldowns = new PoolCooldowns((_agent, cwd) =>
      cwd === '/work/pinned' ? '/profiles/pinned' : null,
    );
    const { broker, launches } = harness({
      calleesOf: pooledCallees(),
      cwd: '/work/pinned',
      poolCooldowns,
    });
    // Spent under the pinned profile, as a member naming it outright ran.
    poolCooldowns.record(
      { ...poolMemberNode(POOLED, 1)!, configDir: '/profiles/pinned' },
      { cwd: '/work/elsewhere', runId: 'run-0', memberId: 'helper' },
      { status: 'failed', failureClass: 'rate_limited', resetsAt: null },
      false,
    );
    await broker.callAgent('run-1', 'orch', {
      title: 'a',
      agent: 'helper',
      message: 'a',
    });
    expect(launches[0]!.callee.agent).toBe('codex');
  });

  it('a handed-on call’s silence watchdog is not held off by the failed attempt’s open tool call', async () => {
    vi.useFakeTimers();
    try {
      const { broker, items } = harness({
        calleesOf: pooledCallees(),
        launch: 'defer',
      });
      void broker.callAgent('run-1', 'orch', {
        title: 'w',
        agent: 'helper',
        message: 'm',
        mode: 'async',
      });
      broker.noteCalleeToolStarted('run-1', 'call-1', 'tool-1');
      broker.noteCalleeHandedOn('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(items.filter((i) => i.payload.stalledCall === true)).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('a restart keeps the member a thread ran on', () => {
    const seed = readCallSeed([
      {
        kind: 'call_result',
        payload: {
          callId: 'call-1',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          sessionId: 's',
          member: 2,
        },
      },
      {
        kind: 'call_result',
        payload: {
          callId: 'call-2',
          callerNodeId: 'orch',
          calleeNodeId: 'helper',
          sessionId: 's2',
          member: 1.5,
        },
      },
    ]);
    expect(seed.records.map((record) => record.member)).toEqual([2, undefined]);
  });
});

describe('CallBroker — a call waits for the calls its callee made', () => {
  // Manager (orch) → Engineer (helper, call-1) → Researcher (res). The Engineer
  // delegates from inside call-1 and ends its turn: REPORTED as the Manager
  // being told "Senior Engineer finished call-4" while the Middle Engineers it
  // had started were still working, then woken a second time when they did.
  const RESEARCHER: TeamMember = member('res');
  const ENGINEER = callerKey('helper', 'call-1');
  const DONE = (text: string): CalleeTurnOutcome => ({
    status: 'completed',
    finalText: text,
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: null,
  });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  /** Run queued microtasks — for the fake-timer cases, where `flush` hangs. */
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }
  };
  /** A sub-call stopped by a usage limit that resets at 18:10 UTC. */
  const RATE_LIMITED: CalleeTurnOutcome = {
    status: 'failed',
    finalText: null,
    error: "You've hit your session limit · resets 6:10pm (UTC)",
    failureClass: 'rate_limited',
    resetsAt: '6:10pm (UTC)',
    sessionId: 'sess-r',
  };

  /**
   * call-1 to the Engineer and one async call it made, with a callee whose
   * turn takes no message — so the caller's messages queue on the call.
   */
  async function engineerRefusingMessages() {
    const h = harness({
      launch: 'defer',
      isNodeLive: (caller) => caller === 'orch',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
      messageCallee: () => ({ delivered: false, reason: 'refused' }),
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', ENGINEER, {
      title: 'research',
      agent: 'res',
      message: 'look it up',
      mode: 'async',
    });
    return h;
  }

  /** call-1 to the Engineer, and `modes` calls it made from inside it. */
  async function engineerDelegated(
    modes: ('async' | 'fire_and_forget')[] = ['async'],
    unreadTeamNotes?: RunCallCapability['unreadTeamNotes'],
  ) {
    const h = harness({
      unreadTeamNotes,
      launch: 'defer',
      // Only the Manager's own conversation has a turn: the Engineer's ended.
      isNodeLive: (caller) => caller === 'orch',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
      ]),
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'build',
      agent: 'helper',
      message: 'feature A',
      mode: 'async',
    });
    for (const mode of modes) {
      await h.broker.callAgent('run-1', ENGINEER, {
        title: 'research',
        agent: 'res',
        message: 'look it up',
        mode,
      });
    }
    return h;
  }

  /** Settle a sub-call the way the executor does: settling, then resolved. */
  async function finishSubCall(
    h: Awaited<ReturnType<typeof engineerDelegated>>,
    index: number,
    text: string,
  ) {
    h.broker.noteCalleeSettling('run-1', h.launches[index]!.callId);
    h.deferred[index]!.resolve(DONE(text));
    await flush();
  }

  /** Whether `promise` has settled yet — read without waiting on it. */
  function released<T>(promise: Promise<T>): () => T | undefined {
    let value: T | undefined;
    void promise.then((v) => {
      value = v;
    });
    return () => value;
  }

  it('holds the call while a call its callee made is still running, then wakes it IN THE SAME CALL', async () => {
    const h = await engineerDelegated();
    const hold = h.broker.holdCall('run-1', 'call-1');
    expect(hold).not.toBeNull();
    const release = released(hold!);
    await flush();
    expect(release()).toBeUndefined();
    expect(
      h.items.find((item) => item.payload.heldCall !== undefined)?.payload,
    ).toMatchObject({ callId: 'call-1', heldCall: { waitingOn: 1 } });

    await finishSubCall(h, 1, 'the research');

    expect(release()).toMatchObject({ kind: 'wake' });
    const wake = release() as { kind: 'wake'; prompt: string; note: string };
    expect(wake.prompt).toContain('await_agent(call_id: "call-2")');
    // Said last, after anything added to the prompt before the turn starts.
    expect(wake.note).toContain("still answering your caller's call");
    // Continued inside call-1 — no "Picked back up" call made for the Manager.
    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
    ]);
    expect(
      h.items.find(
        (item) =>
          item.kind === 'system' &&
          Array.isArray(item.payload.wake) &&
          item.payload.callId === 'call-1',
      ),
    ).toBeDefined();
    // And the Manager's call is still open: nothing told it the work was done.
    expect(
      await h.broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 10,
      }),
    ).toMatchObject({ status: 'pending', call_id: 'call-1' });
    // The Engineer collects its research in the woken turn.
    expect(
      await h.broker.awaitAgent('run-1', ENGINEER, { call_id: 'call-2' }),
    ).toMatchObject({ status: 'ok', result: { text: 'the research' } });
  });

  it('tells a held callee, woken inside its call, how many team notes it has not read', async () => {
    // Keyed on the woken CONVERSATION — the Engineer inside call-1 — never the
    // Manager that is waiting on it.
    const h = await engineerDelegated(['async'], (caller) =>
      caller === ENGINEER ? 3 : 0,
    );
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    await finishSubCall(h, 1, 'the research');

    const wake = release() as { kind: 'wake'; prompt: string };
    expect(wake.prompt).toContain(
      '3 team notes by other agents of this run are unread',
    );

    const quiet = await engineerDelegated(['async'], () => 0);
    const quietRelease = released(quiet.broker.holdCall('run-1', 'call-1')!);
    await finishSubCall(quiet, 1, 'the research');
    expect(
      (quietRelease() as { kind: 'wake'; prompt: string }).prompt,
    ).not.toContain('team note');
  });

  it('waits for the LAST of its calls, and tells it about all of them at once', async () => {
    const h = await engineerDelegated(['async', 'async']);
    const release = released(h.broker.holdCall('run-1', 'call-1')!);

    await finishSubCall(h, 1, 'first');
    expect(release()).toBeUndefined();
    // The card's count follows them down: one is left.
    expect(
      h.items
        .filter((item) => item.payload.heldCall !== undefined)
        .map((item) => [item.payload.heldCall, item.payload.message]),
    ).toEqual([
      [{ waitingOn: 2 }, expect.stringContaining('2 call(s)')],
      [{ waitingOn: 1 }, undefined],
    ]);

    await finishSubCall(h, 2, 'second');
    const wake = release() as { kind: 'wake'; prompt: string };
    expect(wake.prompt).toContain('call-2');
    expect(wake.prompt).toContain('call-3');
  });

  it('wakes the held call at once when one of its calls asks a question', async () => {
    const h = await engineerDelegated(['async', 'async']);
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    const failed = { count: 0 };
    h.broker.parkQuestion('run-1', 'call-2', {
      question: 'Which source?',
      options: ['A', 'B'],
      payload: {},
      deliver: () => true,
      fail: () => {
        failed.count += 1;
      },
    });
    await flush();

    const wake = release() as { kind: 'wake'; prompt: string };
    expect(wake.prompt).toContain('Which source?');
    expect(wake.prompt).toContain('1 other call(s) of yours are still running');
    expect(failed.count).toBe(0);
    expect(h.launches).toHaveLength(3);
  });

  it('wakes at once for a result that landed while its turn ran and was never collected', async () => {
    const h = await engineerDelegated();
    await finishSubCall(h, 1, 'early research');
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    await flush();
    expect((release() as { kind: 'wake'; prompt: string }).prompt).toContain(
      'call-2',
    );
  });

  it('holds nothing for a fire-and-forget call, nor for a callee that made no call', async () => {
    const h = await engineerDelegated(['fire_and_forget']);
    expect(h.broker.holdCall('run-1', 'call-1')).toBeNull();
    expect(h.items.some((item) => item.payload.heldCall !== undefined)).toBe(
      false,
    );
    const quiet = await engineerDelegated([]);
    expect(quiet.broker.holdCall('run-1', 'call-1')).toBeNull();
  });

  it('lets every held call go as cancelled when the run stops, or is torn down', async () => {
    const stopped = await engineerDelegated();
    const onStop = released(stopped.broker.holdCall('run-1', 'call-1')!);
    stopped.broker.releaseHolds('run-1');
    await flush();
    expect(onStop()).toEqual({ kind: 'cancelled' });

    const deleted = await engineerDelegated();
    const onDelete = released(deleted.broker.holdCall('run-1', 'call-1')!);
    deleted.broker.unregisterRun('run-1');
    await flush();
    expect(onDelete()).toEqual({ kind: 'cancelled' });
  });

  it('keeps a held call’s silence watchdog quiet — it is waiting on calls of its own', async () => {
    vi.useFakeTimers();
    try {
      const h = await engineerDelegated();
      h.broker.holdCall('run-1', 'call-1');
      // A row straggling in after the turn ended must not restart the window.
      h.broker.noteCalleeActivity('run-1', 'call-1');
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      expect(
        h.items.filter(
          (item) =>
            item.payload.stalledCall === true &&
            item.payload.callId === 'call-1',
        ),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a HELD call instead of calling it finished, and the calls it made with it', async () => {
    const h = await engineerDelegated(['async', 'fire_and_forget']);
    h.broker.noteCalleeTurnEnded('run-1', 'call-1');
    const release = released(h.broker.holdCall('run-1', 'call-1')!);

    const receipt = h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'plan changed',
    });
    await flush();

    expect(receipt).toMatchObject({
      status: 'ok',
      result: { state: 'cancelling' },
    });
    expect(release()).toEqual({ kind: 'cancelled' });
    // Its async call is stopped with it; the fire-and-forget one is not.
    expect(h.cancelledTurns).toContain('call-2');
    expect(h.cancelledTurns).not.toContain('call-3');
    expect(
      h.items.find(
        (item) =>
          item.kind === 'call_result' && item.payload.callId === 'call-2',
      )?.payload.error,
    ).toContain('was cancelled');
  });

  it('cascades a cancel to the calls a RUNNING callee made', async () => {
    const h = await engineerDelegated(['async', 'fire_and_forget']);
    h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'plan changed',
    });
    await flush();
    expect(h.cancelledTurns).toEqual(['call-2', 'call-1']);
  });

  it('does not mark a held wake message delivered when it is cancelled before its prompt is taken', async () => {
    const h = await engineerDelegated();
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    h.broker.messageAgent('run-1', 'orch', {
      call_id: 'call-1',
      message: 'changed requirement',
    });
    await flush();
    expect(release()).toMatchObject({ kind: 'wake' });
    h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'withdrawn before wake',
    });
    expect(
      h.items
        .filter(
          (item) =>
            item.kind === 'call_answer' &&
            item.payload.message === 'changed requirement',
        )
        .map((item) => item.payload.outcome),
    ).toEqual(['undelivered']);
    expect(h.broker.messageDeliveryNotice('run-1', 'orch')?.prompt).toContain(
      'changed requirement',
    );
  });

  it('wakes a HELD call with a message its caller sends it', async () => {
    const h = await engineerDelegated();
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    const receipt = h.broker.messageAgent('run-1', 'orch', {
      call_id: 'call-1',
      message: 'use Postgres, not SQLite',
    });
    await flush();

    expect(receipt).toMatchObject({
      status: 'ok',
      result: { state: 'queued' },
    });
    const wake = release() as { kind: 'wake'; prompt: string };
    expect(wake.prompt).toContain('use Postgres, not SQLite');
    expect(wake.prompt).toContain('1 other call(s) of yours are still running');
    // Through the wake, not into a turn that no longer exists.
    expect(h.messages).toEqual([]);
    expect(h.items.some((item) => item.payload.outcome === 'message')).toBe(
      false,
    );
    h.broker.confirmWakingMessages('run-1', 'call-1');
    expect(
      h.items.find(
        (item) =>
          item.kind === 'call_answer' && item.payload.outcome === 'message',
      )?.payload.message,
    ).toBe('use Postgres, not SQLite');
  });

  it('wakes a call that became HELD with the messages queued while its turn was ending', async () => {
    vi.useFakeTimers();
    try {
      // The callee's turn is ending: it takes no message.
      const h = await engineerRefusingMessages();
      expect(
        h.broker.messageAgent('run-1', 'orch', {
          call_id: 'call-1',
          message: 'one more thing',
        }),
      ).toMatchObject({ result: { state: 'queued' } });
      const release = released(h.broker.holdCall('run-1', 'call-1')!);
      await vi.advanceTimersByTimeAsync(600);
      expect((release() as { kind: 'wake'; prompt: string }).prompt).toContain(
        'one more thing',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops the calls their callees made, at every depth, when a call is cancelled', async () => {
    const LIB: TeamMember = member('lib');
    const h = harness({
      launch: 'defer',
      isNodeLive: (caller) => caller === 'orch',
      calleesOf: new Map([
        ['orch', [HELPER]],
        ['helper', [RESEARCHER]],
        ['res', [LIB]],
      ]),
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'b',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', ENGINEER, {
      title: 'r',
      agent: 'res',
      message: 'm',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', callerKey('res', 'call-2'), {
      title: 'l',
      agent: 'lib',
      message: 'm',
      mode: 'async',
    });
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-1', reason: 'x' });
    await flush();
    expect(h.cancelledTurns).toEqual(['call-3', 'call-2', 'call-1']);
  });

  it('cancels a call whose turn ENDED with work still out but before it was held', async () => {
    // The executor holds only after the turn's bookkeeping; a cancel landing in
    // between must still stop the work it is waiting for.
    const h = await engineerDelegated();
    h.broker.noteCalleeTurnEnded('run-1', 'call-1');

    const receipt = h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'x',
    });

    expect(receipt).toMatchObject({ result: { state: 'cancelling' } });
    expect(h.cancelledTurns).toContain('call-2');
  });

  it('orphans a question it was already woken for when its callee ends again without answering', async () => {
    const h = await engineerDelegated();
    const failed = { count: 0 };
    h.broker.parkQuestion('run-1', 'call-2', {
      question: 'Which source?',
      options: [],
      payload: {},
      deliver: () => true,
      fail: () => {
        failed.count += 1;
      },
    });
    const first = released(h.broker.holdCall('run-1', 'call-1')!);
    await flush();
    expect(first()).toMatchObject({ kind: 'wake' });

    // The woken turn ends without answer_agent.
    h.broker.holdCall('run-1', 'call-1');
    expect(failed.count).toBe(1);
    expect(
      h.items.find(
        (item) =>
          item.kind === 'call_answer' && item.payload.outcome === 'orphaned',
      ),
    ).toBeDefined();
  });

  it('lets a held call SETTLE on its own answer when what it waited for owes it nothing', async () => {
    // A sync call nobody can collect any more: once it ends there is nothing
    // to continue the callee with.
    const h = await engineerDelegated([]);
    void h.broker.callAgent('run-1', ENGINEER, {
      title: 'r',
      agent: 'res',
      message: 'm',
      mode: 'sync',
    });
    await flush();
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    h.deferred[1]!.resolve(DONE('looked'));
    await flush();
    expect(release()).toEqual({ kind: 'settle' });
  });

  it('holds a call while its callee’s monitors run, wakes it with their output inside the call, and settles once they owe nothing', async () => {
    const h = await engineerDelegated([]);
    let owed = true;
    const held: string[] = [];
    h.capability.monitorsOwed = (caller) => caller === ENGINEER && owed;
    h.capability.callHeld = (caller) => {
      held.push(caller);
    };
    const hold = h.broker.holdCall('run-1', 'call-1');
    expect(hold).not.toBeNull();
    expect(held).toEqual([ENGINEER]);
    const release = released(hold!);
    // Its monitor still runs: reviewing the hold does not let it go.
    h.broker.reviewHeldCallee('run-1', ENGINEER);
    await flush();
    expect(release()).toBeUndefined();

    expect(
      h.broker.wakeHeldCallee('run-1', ENGINEER, 'CI output', {
        severity: 'info',
        message: 'CI · monitor m1: 1 line.',
        monitors: [
          {
            id: 'm1',
            description: 'CI',
            event: 'batch',
            lines: ['ok'],
            omitted: 0,
          },
        ],
        woke: true,
      }),
    ).toBe('woken');
    await flush();
    expect(release()).toMatchObject({
      kind: 'wake',
      prompt: 'CI output',
      monitor: true,
      note: expect.stringContaining('while your monitors run'),
    });
    expect(
      h.items.find((item) => Array.isArray(item.payload.monitors))?.payload,
    ).toMatchObject({ callId: 'call-1', monitors: [{ id: 'm1' }] });

    // The woken turn ends with nothing owed: the call settles.
    owed = false;
    const settled = released(
      h.broker.holdCall('run-1', 'call-1') ?? Promise.resolve(null),
    );
    await flush();
    expect(settled()).toBeNull();
  });

  const NO_ROW = {
    severity: 'info' as const,
    message: '',
    monitors: [],
    woke: true,
  };

  it('answers pending for a callee whose call is open but not yet held, and refuses a conversation with no call', async () => {
    const h = await engineerDelegated([]);
    expect(h.broker.wakeHeldCallee('run-1', ENGINEER, 'x', NO_ROW)).toBe(
      'pending',
    );
    expect(
      h.broker.wakeHeldCallee(
        'run-1',
        callerKey('helper', 'call-9'),
        'x',
        NO_ROW,
      ),
    ).toBe('refused');
  });

  it('stops the callee’s monitors with a cancelled call', async () => {
    const h = await engineerDelegated([]);
    const stopped: string[] = [];
    h.capability.stopMonitors = (caller) => {
      stopped.push(caller);
    };
    h.broker.cancelAgent('run-1', 'orch', {
      call_id: 'call-1',
      reason: 'not needed',
    });
    expect(stopped).toEqual([ENGINEER]);
  });

  it('keeps holding for a usage-limit continue, and wakes INSIDE the call when the limit resets', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await engineerDelegated();
      const first = released(h.broker.holdCall('run-1', 'call-1')!);
      h.broker.noteCalleeSettling('run-1', 'call-2');
      h.deferred[1]!.resolve(RATE_LIMITED);
      await settle();
      expect(first()).toMatchObject({ kind: 'wake' });

      // The woken turn ends waiting for the reset: still owed, so still held.
      const hold = h.broker.holdCall('run-1', 'call-1');
      expect(hold).not.toBeNull();
      const second = released(hold!);
      await vi.advanceTimersByTimeAsync(72 * 60_000);

      expect(second()).toMatchObject({ kind: 'wake' });
      // Continued inside call-1 — no call made on the Manager's behalf.
      expect(h.launches).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * call-1 settled (session `sess-1`) with call-2 still out; the Manager then
   * continues the conversation as call-3, whose turn has just ended.
   */
  async function continuedWithLeftover() {
    const h = await engineerDelegated();
    h.deferred[0]!.resolve({ ...DONE('dispatched'), sessionId: 'sess-1' });
    await flush();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and B',
      thread: 'call-1',
      mode: 'async',
    });
    h.broker.noteCalleeTurnEnded('run-1', 'call-3');
    return h;
  }

  it('never reopens a cancelled conversation for what its cancel stopped', async () => {
    const h = await continuedWithLeftover();
    h.broker.holdCall('run-1', 'call-3');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    // The stopped call settles the way the executor reports it.
    h.broker.noteCalleeSettling('run-1', 'call-2');
    h.broker.drainCaller('run-1', ENGINEER);
    await flush();
    await flush();

    expect(h.cancelledTurns).toContain('call-2');
    // No call was made to continue the conversation the caller just stopped.
    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
  });

  it('stops an earlier call’s leftovers when its turn has ENDED, held or not', async () => {
    const h = await continuedWithLeftover();
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    await flush();
    expect(h.cancelledTurns).toContain('call-2');
  });

  it('keeps stopping what its hold took over through the wake turn that follows', async () => {
    const h = await continuedWithLeftover();
    const release = released(h.broker.holdCall('run-1', 'call-3')!);
    // Woken by a message: its turn is running again, its hold is gone — so
    // only `everHeld` still says what the hold took over.
    expect(
      h.broker.messageAgent('run-1', 'orch', {
        call_id: 'call-3',
        message: 'one more thing',
      }),
    ).toMatchObject({ result: { state: 'queued' } });
    await flush();
    expect(release()).toMatchObject({ kind: 'wake' });
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    await flush();
    expect(h.cancelledTurns).toContain('call-2');
  });

  it('never stamps finished work cancelled', async () => {
    // call-2's turn ended and it is owed nothing: only bookkeeping is left.
    const h = await engineerDelegated();
    h.broker.noteCalleeTurnEnded('run-1', 'call-2');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-1', reason: 'x' });
    await flush();
    expect(h.cancelledTurns).not.toContain('call-2');
  });

  it('never reopens a cancelled conversation for work that finished as it was cancelled', async () => {
    // call-2's turn has ended but it has not settled yet when the held call-3
    // is cancelled: the cascade leaves the finished work standing, and its
    // result must not then continue the conversation the caller stopped —
    // which call-1's session could resume.
    const h = await continuedWithLeftover();
    h.broker.holdCall('run-1', 'call-3');
    h.broker.noteCalleeTurnEnded('run-1', 'call-2');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    await finishSubCall(h, 1, 'the research');
    h.broker.drainCaller('run-1', ENGINEER);
    await flush();
    await flush();

    expect(h.cancelledTurns).not.toContain('call-2');
    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    // Still the Engineer's to collect — it is only not news to wake it with.
    expect(
      await h.broker.awaitAgent('run-1', ENGINEER, { call_id: 'call-2' }),
    ).toMatchObject({ status: 'ok', result: { text: 'the research' } });
  });

  it('never reopens a cancelled conversation for a result it was never woken for', async () => {
    // call-2 settled after call-3's turn ended, uncollected; call-3 is
    // cancelled before it is held.
    const h = await continuedWithLeftover();
    await finishSubCall(h, 1, 'early research');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    // What it owed is decided when the cancel is accepted, not re-read after
    // the cancel has silenced it — or its partial answer would pass as done.
    expect(h.broker.owesWork('run-1', 'call-3')).toBe(true);
    await flush();
    h.broker.drainCaller('run-1', ENGINEER);
    await flush();
    await flush();

    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
  });

  it('never reopens a conversation for what the calls made in a RUNNING call it cancelled left behind', async () => {
    // call-1 settled (session sess-1) with call-2 still out; the continuation
    // call-3 is still running when one of its OWN calls (call-4) settles
    // uncollected, and call-3 is cancelled. An earlier call's work (call-2)
    // is not this cancel's, but call-4's result is.
    const h = await engineerDelegated();
    h.deferred[0]!.resolve({ ...DONE('dispatched'), sessionId: 'sess-1' });
    await flush();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and B',
      thread: 'call-1',
      mode: 'async',
    });
    await h.broker.callAgent('run-1', ENGINEER, {
      title: 'check',
      agent: 'res',
      message: 'check it',
      mode: 'async',
    });
    await finishSubCall(h, 3, 'checked');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    await flush();
    h.broker.drainCaller('run-1', ENGINEER);
    await flush();
    await flush();

    expect(h.cancelledTurns).not.toContain('call-2');
    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
      'call-4',
    ]);
  });

  it('continues a call INSIDE its hold when its usage limit reset while its turn was ending', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await engineerDelegated();
      const first = released(h.broker.holdCall('run-1', 'call-1')!);
      h.broker.noteCalleeSettling('run-1', 'call-2');
      h.deferred[1]!.resolve(RATE_LIMITED);
      await settle();
      expect(first()).toMatchObject({ kind: 'wake' });

      // The reset fires while the woken turn is still running: nothing holds
      // the call yet, and the Engineer is not reachable by a turn of its own.
      await vi.advanceTimersByTimeAsync(72 * 60_000);
      const hold = h.broker.holdCall('run-1', 'call-1');

      // The turn's end does not settle the call: the news is delivered inside it.
      expect(hold).not.toBeNull();
      const second = released(hold!);
      await settle();
      expect(
        (second() as { kind: 'wake'; prompt: string } | undefined)?.prompt,
      ).toContain('6:10pm');
      expect(h.launches).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /** Rows saying how a promised continue ended, by phase. */
  const resetRows = (h: Awaited<ReturnType<typeof engineerDelegated>>) =>
    h.items
      .filter((item) => item.payload.resetWake !== undefined)
      .map((item) => ({
        phase: (item.payload.resetWake as { phase: string }).phase,
        message: item.payload.message as string,
      }));

  /**
   * call-2 was stopped by a usage limit while call-1's turn ran, and the
   * limit has just reset — with call-1 not free to be continued yet, so the
   * continue waits for it.
   */
  async function resetWaitingForCall1() {
    const h = await engineerDelegated();
    h.broker.noteCalleeSettling('run-1', 'call-2');
    h.deferred[1]!.resolve(RATE_LIMITED);
    await settle();
    await vi.advanceTimersByTimeAsync(72 * 60_000);
    return h;
  }

  it('keeps a continue that fired while a call waited when a new pass starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await resetWaitingForCall1();
      // A follow-up registers the run's next pass before call-1 settles.
      h.broker.registerRun('run-1', h.capability, null);
      h.broker.noteCalleeSettling('run-1', 'call-1');
      h.deferred[0]!.resolve({ ...DONE('done'), sessionId: 'sess-1' });
      await settle();

      // The promise is kept or said to be broken — never lost without a row.
      // (This pass was seeded with no transcript, so it holds no session to
      // continue the conversation from, and says it could not reach it.)
      expect(resetRows(h).map((row) => row.phase)).toEqual([
        'scheduled',
        'unreachable',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for a conversation whose turn is ENDING rather than calling its continue unreachable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      // The Engineer's turn has ended but its conversation still reads as
      // live (its bookkeeping, a compaction), and takes no message.
      const h = harness({
        launch: 'defer',
        isNodeLive: (caller) => caller === 'orch' || caller === ENGINEER,
        calleesOf: new Map([
          ['orch', [HELPER]],
          ['helper', [RESEARCHER]],
        ]),
      });
      await h.broker.callAgent('run-1', 'orch', {
        title: 'build',
        agent: 'helper',
        message: 'feature A',
        mode: 'async',
      });
      await h.broker.callAgent('run-1', ENGINEER, {
        title: 'research',
        agent: 'res',
        message: 'look it up',
        mode: 'async',
      });
      h.broker.noteCalleeSettling('run-1', 'call-2');
      h.deferred[1]!.resolve(RATE_LIMITED);
      await settle();
      await vi.advanceTimersByTimeAsync(72 * 60_000);

      expect(resetRows(h).map((row) => row.phase)).not.toContain('unreachable');
      // Still owed: the call's turn end holds for it.
      expect(h.broker.owesWork('run-1', 'call-1')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls off a continue that already fired when its call is cancelled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await resetWaitingForCall1();
      h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-1', reason: 'x' });
      await settle();

      expect(resetRows(h)).toEqual([
        expect.objectContaining({ phase: 'scheduled' }),
        {
          phase: 'cancelled',
          message: expect.stringContaining(
            'because the call it was for was cancelled',
          ),
        },
      ]);
      expect(h.launches.map((launch) => launch.callId)).toEqual([
        'call-1',
        'call-2',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('calls off a continue that already fired when the user calls the continues off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await resetWaitingForCall1();
      expect(h.broker.cancelResetWakes('run-1')).toEqual(['call-2']);
      // When call-1 settles, the continue that was called off does not go out.
      h.broker.noteCalleeSettling('run-1', 'call-1');
      h.deferred[0]!.resolve({ ...DONE('done'), sessionId: 'sess-1' });
      await settle();
      expect(resetRows(h).map((row) => row.phase)).toEqual([
        'scheduled',
        'cancelled',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks told a sub-call already stopped by its own caller when the call it was made in is cancelled', async () => {
    const h = await continuedWithLeftover();
    // The Engineer stopped its own research first…
    h.broker.cancelAgent('run-1', ENGINEER, { call_id: 'call-2', reason: 'y' });
    // …then the Manager cancels the conversation's call.
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    h.broker.noteCalleeSettling('run-1', 'call-2');
    await flush();
    h.broker.drainCaller('run-1', ENGINEER);
    await flush();
    await flush();

    expect(h.launches.map((launch) => launch.callId)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
  });

  it('leaves an EARLIER call’s result alone when a running continuation is cancelled', async () => {
    // call-1 settled (session sess-1) with call-2 out; call-2 then settles
    // uncollected while the continuation call-3 runs, and call-3 is
    // cancelled. call-2 is not call-3's work: its result still reaches the
    // conversation.
    const h = await engineerDelegated();
    h.deferred[0]!.resolve({ ...DONE('dispatched'), sessionId: 'sess-1' });
    await flush();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'more',
      agent: 'helper',
      message: 'and B',
      thread: 'call-1',
      mode: 'async',
    });
    await finishSubCall(h, 1, 'earlier research');
    h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-3', reason: 'x' });
    await flush();
    await flush();

    const reopened = h.launches.slice(3);
    expect(reopened).toHaveLength(1);
    expect(reopened[0]!.message).toContain('call-2');
  });

  it('calls off a usage-limit continue promised to a cancelled conversation, and says so', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await engineerDelegated();
      h.broker.noteCalleeTurnEnded('run-1', 'call-1');
      h.broker.noteCalleeSettling('run-1', 'call-2');
      h.deferred[1]!.resolve(RATE_LIMITED);
      await settle();
      h.broker.cancelAgent('run-1', 'orch', { call_id: 'call-1', reason: 'x' });
      await vi.advanceTimersByTimeAsync(72 * 60_000);

      // The promise in the transcript is closed with the reason it will not come…
      expect(
        h.items.find(
          (item) =>
            item.kind === 'system' &&
            (item.payload.resetWake as { phase?: string } | undefined)
              ?.phase === 'cancelled',
        )?.payload.message,
      ).toContain('because the call it was for was cancelled');
      // …and the reset continues nothing.
      expect(h.launches.map((launch) => launch.callId)).toEqual([
        'call-1',
        'call-2',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a call held only for a usage-limit continue go when the continue is called off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-22T17:00:00Z'));
    try {
      const h = await engineerDelegated();
      released(h.broker.holdCall('run-1', 'call-1')!);
      h.broker.noteCalleeSettling('run-1', 'call-2');
      h.deferred[1]!.resolve(RATE_LIMITED);
      await settle();
      const held = released(h.broker.holdCall('run-1', 'call-1')!);

      h.broker.cancelResetWakes('run-1');
      await settle();

      expect(held()).toEqual({ kind: 'settle' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('wakes a held call with the caller’s queued messages before a later one', async () => {
    vi.useFakeTimers();
    try {
      const h = await engineerRefusingMessages();
      h.broker.messageAgent('run-1', 'orch', {
        call_id: 'call-1',
        message: 'QUEUED FIRST',
      });
      const release = released(h.broker.holdCall('run-1', 'call-1')!);
      // The user's own message, before the queue's retry runs.
      h.broker.messageHeldCall('run-1', 'call-1', 'USER SECOND');
      await vi.advanceTimersByTimeAsync(0);

      const prompt = (release() as { kind: 'wake'; prompt: string }).prompt;
      expect(prompt.indexOf('QUEUED FIRST')).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf('QUEUED FIRST')).toBeLessThan(
        prompt.indexOf('USER SECOND'),
      );
      h.broker.confirmWakingMessages('run-1', 'call-1');
      expect(
        h.items.find(
          (item) =>
            item.kind === 'call_answer' &&
            item.payload.message === 'QUEUED FIRST',
        ),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts open async and sync calls, never fire-and-forget ones', async () => {
    const h = await engineerDelegated(['async', 'async', 'fire_and_forget']);
    expect(h.broker.openSubCallCount('run-1', 'call-1')).toBe(2);
  });
});

describe('CallBroker — a callee question asked through a tool call that already returned', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  function released<T>(promise: Promise<T>): () => T | undefined {
    let value: T | undefined;
    void promise.then((v) => {
      value = v;
    });
    return () => value;
  }

  async function askedDeferred(ttlMs?: number) {
    const h = harness({
      launch: 'defer',
      isNodeLive: (caller) => caller === 'orch',
    });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'build it',
      mode: 'async',
    });
    const parked = h.broker.parkQuestion('run-1', 'call-1', {
      question: 'Which branch?',
      options: ['main', 'dev'],
      payload: null,
      deferred: true,
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
    return { h, parked };
  }

  it('keeps the call open past the callee’s turn and continues it there with the answer', async () => {
    const { h, parked } = await askedDeferred();
    expect(parked).toBe(true);
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    await flush();
    expect(release()).toBeUndefined();
    expect(
      await h.broker.awaitAgent('run-1', 'orch', {
        call_id: 'call-1',
        timeout_ms: 10,
      }),
    ).toMatchObject({ status: 'question', call_id: 'call-1' });

    expect(
      h.broker.answerAgent('run-1', 'orch', {
        call_id: 'call-1',
        answer: 'dev',
      }),
    ).toMatchObject({ status: 'ok' });
    await flush();

    const wake = release() as { kind: 'wake'; prompt: string; note: string };
    expect(wake.kind).toBe('wake');
    expect(wake.prompt).toContain('answered your question:\n\ndev');
    expect(wake.note).toContain('stayed open while your question waited');
  });

  it('hands over an answer that landed while the callee was still working the moment its turn ends', async () => {
    const { h } = await askedDeferred();
    h.broker.answerAgent('run-1', 'orch', {
      call_id: 'call-1',
      answer: 'main',
    });
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    await flush();
    expect((release() as { prompt: string }).prompt).toContain('main');
  });

  it('never blocks the asking callee, which is still working', async () => {
    const { h } = await askedDeferred();
    expect(h.blockedReports).toEqual([]);
  });

  it('continues the callee without an answer when its question times out, rather than failing the call', async () => {
    const { h } = await askedDeferred(20);
    const release = released(h.broker.holdCall('run-1', 'call-1')!);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flush();
    expect((release() as { prompt: string }).prompt).toContain(
      'was never answered',
    );
    expect(
      h.items.find((item) => item.kind === 'call_answer')?.payload,
    ).toMatchObject({ callId: 'call-1', outcome: 'timeout' });

    h.deferred[0]!.resolve({
      status: 'completed',
      finalText: 'built it on main',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await flush();
    expect(
      await h.broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'ok', result: { text: 'built it on main' } });
  });

  it('tells the caller a deferred asker goes on, never that it was stopped, when no caller turn is left', async () => {
    const h = harness({ launch: 'defer', isNodeLive: () => false });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'build it',
      mode: 'async',
    });
    h.broker.parkQuestion('run-1', 'call-1', {
      question: 'Which branch?',
      options: [],
      payload: null,
      deferred: true,
    });
    const said = h.items
      .filter((item) => item.kind === 'system')
      .map((item) => String(item.payload.message));
    expect(
      said.some((line) => line.includes('goes on without an answer')),
    ).toBe(true);
    expect(said.some((line) => line.includes('was stopped'))).toBe(false);
  });
});

describe('CallBroker — a callee question whose asker keeps its turn', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('answers the asker on a timeout without failing its call', async () => {
    const h = harness({ launch: 'defer', isNodeLive: (c) => c === 'orch' });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'build it',
      mode: 'async',
    });
    const failed = { count: 0 };
    h.broker.parkQuestion('run-1', 'call-1', {
      question: 'Which branch?',
      options: [],
      payload: null,
      ttlMs: 20,
      keepsTurn: true,
      deliver: () => true,
      fail: () => {
        failed.count += 1;
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(failed.count).toBe(1);

    h.deferred[0]!.resolve({
      status: 'completed',
      finalText: 'went with main',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await flush();
    expect(
      await h.broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' }),
    ).toMatchObject({ status: 'ok', result: { text: 'went with main' } });
  });
});

describe('CallBroker — prompt-cache-aware continuations', () => {
  const HOUR = 60 * 60_000;
  const START = Date.UTC(2026, 9, 11, 9, 0, 0);
  const warmLarge: Partial<CalleeTurnOutcome> = {
    promptCacheTtlMs: HOUR,
    contextTokens: 700_000,
    contextWindowTokens: 1_000_000,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  /** The one entry `list_agent_threads` answers for `owner`, or the list. */
  function listed(broker: CallBroker, owner = 'orch'): unknown[] {
    const envelope = broker.listThreads('run-1', owner);
    if (envelope.status !== 'ok') {
      throw new Error(`listThreads failed: ${JSON.stringify(envelope)}`);
    }
    return (envelope.result as { threads: unknown[] }).threads;
  }

  it('lists the caller’s conversation with its context in tokens and percent of its window, a warm cache, and no one else’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const calleesOf = new Map([
      ['orch', [HELPER]],
      ['other', [HELPER]],
    ]);
    const { broker } = harness({ calleesOf, instantOutcome: warmLarge });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 10 * 60_000);
    expect(listed(broker)).toEqual([
      {
        agent: 'helper',
        thread: 'call-1',
        status: 'idle',
        calls: 1,
        last_turn_ended_at: new Date(START).toISOString(),
        context: { tokens: 700_000, window: 1_000_000, percent: 70 },
        cache: {
          state: 'warm',
          expires_at: new Date(START + HOUR).toISOString(),
          expires_in_s: 50 * 60,
        },
      },
    ]);
    expect(listed(broker, 'other')).toEqual([]);
  });

  it('refuses to continue a cold, over-half-full conversation, and lists it as refused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, launches } = harness({ instantOutcome: warmLarge });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 2 * HOUR);
    expect(listed(broker)).toEqual([
      expect.objectContaining({
        thread: 'call-1',
        cache: expect.objectContaining({
          state: 'expired',
          expired_s_ago: 60 * 60,
        }),
        resume_refused: 'CACHE_EXPIRED',
      }),
    ]);
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'follow-up',
      thread: 'call-1',
    });
    expect(errorOf(refused)).toContain('CACHE_EXPIRED');
    expect(errorOf(refused)).toContain('70% full');
    expect(launches).toHaveLength(1);
  });

  it('continues a cold conversation anyway when the caller passes resumeCold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, launches } = harness({ instantOutcome: warmLarge });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 2 * HOUR);
    const resumed = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'follow-up',
      thread: 'call-1',
      resumeCold: true,
    });
    expect(resumed.status).toBe('ok');
    expect(launches[1]).toMatchObject({
      resumeSessionId: 'sess-call-1',
      conversationId: 'call-1',
    });
  });

  it('continues a cold conversation at or under half its window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, launches } = harness({
      instantOutcome: { ...warmLarge, contextTokens: 500_000 },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 2 * HOUR);
    const resumed = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'follow-up',
      thread: 'call-1',
    });
    expect(resumed.status).toBe('ok');
    expect(launches).toHaveLength(2);
  });

  it('never refuses a conversation whose CLI reported no cache lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, launches } = harness({
      instantOutcome: { ...warmLarge, promptCacheTtlMs: null },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 24 * HOUR);
    const [entry] = listed(broker);
    expect(entry).toMatchObject({ cache: { state: 'unknown' } });
    expect(entry).not.toHaveProperty('resume_refused');
    const resumed = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'follow-up',
      thread: 'call-1',
    });
    expect(resumed.status).toBe('ok');
    expect(launches).toHaveLength(2);
  });

  it('judges a continued conversation by its NEWEST call, numbering call-10 after call-9', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, launches } = harness({ instantOutcome: warmLarge });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // Eight unrelated calls, so the continuation is numbered past call-9.
    for (let i = 0; i < 8; i += 1) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'writer',
        message: 'w',
      });
    }
    // An hour later call-1's cache has lapsed; continuing it was allowed then
    // (resumeCold), and the continuation refreshed the cache.
    vi.setSystemTime(START + 2 * HOUR);
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'follow-up',
      thread: 'call-1',
      resumeCold: true,
    });
    vi.setSystemTime(START + 2 * HOUR + 30 * 60_000);
    const helper = listed(broker).find(
      (thread) => (thread as { agent: string }).agent === 'helper',
    );
    expect(helper).toMatchObject({ thread: 'call-10', calls: 2 });
    // call-1 alone is cold and large; judged by it, this would read refused.
    expect(helper).not.toHaveProperty('resume_refused');
    const again = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'and again',
      thread: 'call-10',
    });
    expect(again.status).toBe('ok');
    expect(launches).toHaveLength(11);
  });

  it('never offers, or judges by, a call that ran no turn', async () => {
    // A call cancelled while it waited for a turn slot records no session — a
    // continue handle nothing can resume, which measured nothing.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, deferred, launches } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
      ...warmLarge,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm2',
      thread: 'call-1',
      mode: 'async',
    });
    deferred[1]!.resolve({
      status: 'cancelled',
      finalText: null,
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    vi.setSystemTime(START + 2 * HOUR);
    expect(listed(broker)).toEqual([
      expect.objectContaining({
        thread: 'call-1',
        resume_refused: 'CACHE_EXPIRED',
      }),
    ]);
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm3',
      thread: 'call-1',
    });
    expect(errorOf(refused)).toContain('CACHE_EXPIRED');
    expect(launches).toHaveLength(2);
  });

  it('falls back to the lifetime the same callee and member stated in another conversation — never another member’s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, deferred } = harness({ launch: 'defer' });
    const settle = (index: number, over: Partial<CalleeTurnOutcome>) => {
      deferred[index]!.resolve({
        status: 'completed',
        finalText: 'done',
        error: null,
        failureClass: null,
        resetsAt: null,
        sessionId: `sess-${index}`,
        ...over,
      });
    };
    for (let i = 0; i < 3; i += 1) {
      await broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: `m${i}`,
        mode: 'async',
      });
    }
    // call-1 states the lifetime; call-2 (same member) and call-3 (member 2)
    // were served wholly from cache and state none.
    settle(0, warmLarge);
    settle(1, { ...warmLarge, promptCacheTtlMs: null });
    settle(2, { ...warmLarge, promptCacheTtlMs: null, member: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    vi.setSystemTime(START + 2 * HOUR);
    const threads = listed(broker) as {
      thread: string;
      cache: { state: string };
    }[];
    // Oldest conversation first.
    expect(threads.map((thread) => thread.thread)).toEqual([
      'call-1',
      'call-2',
      'call-3',
    ]);
    expect(threads[1]).toMatchObject({
      cache: { state: 'expired' },
      resume_refused: 'CACHE_EXPIRED',
    });
    expect(threads[2]).toMatchObject({ cache: { state: 'unknown' } });
    expect(threads[2]).not.toHaveProperty('resume_refused');
  });

  it('moves a conversation’s facts when its kept process runs a turn of its own after the call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker } = harness({ instantOutcome: warmLarge });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    // An hour and a half later a background command reported back and the
    // callee ran a turn on it, refreshing the cache and growing the window.
    broker.noteConversationTurnEnded('run-1', 'call-1', {
      endedAt: START + 90 * 60_000,
      promptCacheTtlMs: null,
      contextTokens: 800_000,
      contextWindowTokens: null,
    });
    vi.setSystemTime(START + 2 * HOUR);
    expect(listed(broker)).toEqual([
      expect.objectContaining({
        context: { tokens: 800_000, window: 1_000_000, percent: 80 },
        cache: expect.objectContaining({ state: 'warm' }),
      }),
    ]);
  });

  it('states the percentage to a tenth, so just over the threshold never reads as exactly at it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker } = harness({
      instantOutcome: { ...warmLarge, contextTokens: 500_400 },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    vi.setSystemTime(START + 2 * HOUR);
    const refused = await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'again',
      thread: 'call-1',
    });
    expect(errorOf(refused)).toContain('50.1% full');
    expect(listed(broker)).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ percent: 50.1 }),
        resume_refused: 'CACHE_EXPIRED',
      }),
    ]);
  });

  it('keeps the window of a zero-token reading, with no percent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker } = harness({
      instantOutcome: { ...warmLarge, contextTokens: 0 },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const [entry] = listed(broker);
    expect((entry as { context: unknown }).context).toStrictEqual({
      tokens: 0,
      window: 1_000_000,
    });
  });

  it('states the context in tokens alone when no window was reported', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker } = harness({
      instantOutcome: { ...warmLarge, contextWindowTokens: null },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const [entry] = listed(broker);
    // Strict: a `window: null` or `percent: null` beside the tokens fails it.
    expect((entry as { context: unknown }).context).toStrictEqual({
      tokens: 700_000,
    });
  });

  it('leaves the context out when nothing measured it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker } = harness({
      instantOutcome: {
        ...warmLarge,
        contextTokens: null,
        contextWindowTokens: null,
      },
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const [entry] = listed(broker);
    expect(entry).toMatchObject({ thread: 'call-1', status: 'idle' });
    expect(entry).not.toHaveProperty('context');
  });

  it('marks a conversation with a call still running as busy', async () => {
    const { broker } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    expect(listed(broker)).toEqual([
      expect.objectContaining({
        thread: null,
        status: 'running',
        running_call: 'call-1',
      }),
    ]);
  });

  it('never lists a conversation as refused while a call runs on it', async () => {
    // A continuation of a busy conversation is refused THREAD_BUSY, not
    // CACHE_EXPIRED — whatever its last settled call measured.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    deferred[0]!.resolve({
      status: 'completed',
      finalText: 'done',
      error: null,
      failureClass: null,
      resetsAt: null,
      sessionId: 'sess-1',
      ...warmLarge,
    });
    await new Promise((resolve) => setImmediate(resolve));
    vi.setSystemTime(START + 2 * HOUR);
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm2',
      thread: 'call-1',
      mode: 'async',
      resumeCold: true,
    });
    const [entry] = listed(broker);
    expect(entry).toMatchObject({
      status: 'running',
      cache: { state: 'expired' },
      context: { percent: 70 },
    });
    expect(entry).not.toHaveProperty('resume_refused');
  });

  it('keeps the cache facts across a daemon restart, read back off the result row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    const { broker, items, capability } = harness({
      instantOutcome: warmLarge,
    });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    const result = items.find((item) => item.kind === 'call_result');
    expect(result?.payload).toMatchObject({
      promptCacheTtlMs: HOUR,
      contextTokens: 700_000,
      contextWindowTokens: 1_000_000,
    });
    const restarted = new CallBroker();
    restarted.registerRun(
      'run-1',
      capability,
      readCallSeed(
        items.map((item) => ({
          kind: item.kind,
          payload: item.payload,
          createdAt: new Date(START),
        })),
      ),
    );
    vi.setSystemTime(START + 2 * HOUR);
    expect(listed(restarted)).toEqual([
      expect.objectContaining({
        thread: 'call-1',
        resume_refused: 'CACHE_EXPIRED',
        context: { tokens: 700_000, window: 1_000_000, percent: 70 },
      }),
    ]);
  });
});

describe('CallBroker — pages published inside a call', () => {
  const completed = (
    finalText: string,
    extra: Partial<CalleeTurnOutcome> = {},
  ): CalleeTurnOutcome => ({
    status: 'completed',
    finalText,
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: 'sess-call-1',
    ...extra,
  });
  const node = (id: string): TeamMember => member(id);

  it('names every page the callee published in its envelope and its call_result row, each at its newest version', async () => {
    const { broker, deferred, items } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
    });
    const callId = broker.callAnsweredBy(
      'run-1',
      callerKey('helper', 'call-1'),
    );
    expect(callId).toBe('call-1');
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan v1',
      version: 1,
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'diagram',
      title: 'Diagram',
      version: 1,
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 2,
    });
    deferred[0]!.resolve(completed('planned'));
    const envelope = await pending;
    expect(envelope).toEqual({
      status: 'ok',
      result: {
        call_id: 'call-1',
        agent: 'helper',
        text: 'planned',
        // First-publish order, the revised page at its newest version.
        artifacts: [
          { artifact_id: 'plan', title: 'Plan', version: 2 },
          { artifact_id: 'diagram', title: 'Diagram', version: 1 },
        ],
        note: PUBLISHED_PAGES_NOTE,
      },
    });
    const result = items.find((i) => i.kind === 'call_result')!;
    expect(result.payload.result).toEqual(
      (envelope as { result: unknown }).result,
    );
  });

  it('keeps the envelope’s own note beside the pages one', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    deferred[0]!.resolve(completed('partial', { callsStillOut: 1 }));
    const { result } = (await pending) as { result: { note: string } };
    expect(result.note).toContain('This call is NOT finished');
    expect(result.note).toContain("already in the user's chat");
  });

  it('names the commands a callee left running, each cut to one bounded line', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'bring it up',
    });
    const long = `pnpm dev ${'--flag '.repeat(40)}`;
    deferred[0]!.resolve(
      completed('up', {
        shellsStillOut: [
          { command: 'cd api &&\n pnpm dev:api', callId: 'call-1' },
          { command: null, callId: 'call-1' },
          { command: long, callId: 'call-1' },
        ],
      }),
    );
    const { result } = (await pending) as {
      result: {
        note: string;
        commands_still_running: number;
        running_commands: string[];
      };
    };
    const cut = `${long.replaceAll(/\s+/g, ' ').trim().slice(0, LEFT_RUNNING_COMMAND_MAX)}…`;
    // Counted whole; listed only where the words were recorded.
    expect(result.commands_still_running).toBe(3);
    expect(result.running_commands).toEqual(['cd api && pnpm dev:api', cut]);
    expect(result.note).toBe(
      `helper answered while 3 command(s) it started in the background were still running: \`cd api && pnpm dev:api\`; \`${cut}\`. Its work may not be finished: they keep running after this result, and what they print arrives in its conversation (call_agent with thread: 'call-1'), which is also where it can be asked to stop them.`,
    );
  });

  it('says which earlier call on the thread started a command still running', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'hit it',
    });
    deferred[0]!.resolve(
      completed('200', {
        shellsStillOut: [
          { command: 'pnpm dev:api', callId: 'call-0' },
          { command: 'pnpm test', callId: 'call-1' },
        ],
      }),
    );
    const { result } = (await pending) as {
      result: { note: string; running_commands: string[] };
    };
    expect(result.running_commands).toEqual(['pnpm dev:api', 'pnpm test']);
    expect(result.note).toContain(
      ': `pnpm dev:api` (started in call-0); `pnpm test`. Its work',
    );
  });

  it('shows no env assignment’s value in a command left running, wherever it is set', async () => {
    registerSecret('tok-0123456789abcdef', 'test token');
    try {
      const { broker, deferred } = harness({ launch: 'defer' });
      const pending = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'bring it up',
      });
      const commands = [
        `GITHUB_TOKEN=ghp_unregistered PORT="4000 1" pnpm dev:api`,
        'cd api && API_KEY=sk-unregistered pnpm dev',
        'env GH_TOKEN=gh-unregistered pnpm dev',
        'export TOKEN=x-unregistered; pnpm dev',
        'TOKEN=tok-0123456789abcdef pnpm dev',
        'AUTH=$(cat key file) pnpm dev',
        'FOO=bar',
      ];
      deferred[0]!.resolve(
        completed('up', {
          shellsStillOut: commands.map((command) => ({
            command,
            callId: 'call-1',
          })),
        }),
      );
      const { result } = (await pending) as {
        result: { note: string; running_commands: string[] };
      };
      expect(result.running_commands).toEqual([
        'GITHUB_TOKEN=… PORT=… pnpm dev:api',
        'cd api && API_KEY=… pnpm dev',
        'env GH_TOKEN=… pnpm dev',
        'export TOKEN=…; pnpm dev',
        'TOKEN=… pnpm dev',
        'AUTH=… pnpm dev',
        'FOO=…',
      ]);
      expect(result.note).not.toMatch(
        /unregistered|tok-0123|redacted|key file/,
      );
    } finally {
      clearSecrets();
    }
  });

  it('masks a registered secret in a command left running, and fences one carrying backticks', async () => {
    registerSecret('tok-0123456789abcdef', 'test token');
    try {
      const { broker, deferred } = harness({ launch: 'defer' });
      const pending = broker.callAgent('run-1', 'orch', {
        title: 'why',
        agent: 'helper',
        message: 'bring it up',
      });
      deferred[0]!.resolve(
        completed('up', {
          shellsStillOut: [
            {
              command: 'curl -H "Bearer tok-0123456789abcdef" localhost',
              callId: 'call-1',
            },
            {
              command: 'echo `git rev-parse HEAD` && pnpm dev',
              callId: 'call-1',
            },
          ],
        }),
      );
      const { result } = (await pending) as {
        result: { note: string; running_commands: string[] };
      };
      expect(result.running_commands[0]).not.toContain('tok-0123456789abcdef');
      expect(result.note).not.toContain('tok-0123456789abcdef');
      expect(result.note).toContain(
        '; ``echo `git rev-parse HEAD` && pnpm dev``.',
      );
    } finally {
      clearSecrets();
    }
  });

  it('an await_agent collection names the pages too', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
      mode: 'async',
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    const awaiting = broker.awaitAgent('run-1', 'orch', { call_id: 'call-1' });
    deferred[0]!.resolve(completed('planned'));
    expect(await awaiting).toMatchObject({
      status: 'ok',
      result: {
        artifacts: [{ artifact_id: 'plan', title: 'Plan', version: 1 }],
      },
    });
  });

  it('a thread continuation names only what was published in IT', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const first = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'notes',
      title: 'Notes',
      version: 1,
    });
    deferred[0]!.resolve(completed('v1'));
    await first;
    const second = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'revise it',
      thread: 'call-1',
    });
    // The continuation speaks in the SAME conversation as call-1.
    expect(broker.callAnsweredBy('run-1', callerKey('helper', 'call-1'))).toBe(
      'call-2',
    );
    broker.notePublishedArtifact('run-1', 'call-2', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 2,
    });
    deferred[1]!.resolve(completed('v2'));
    const envelope = (await second) as { result: { artifacts: unknown } };
    expect(envelope.result.artifacts).toEqual([
      { artifact_id: 'plan', title: 'Plan', version: 2 },
    ]);
  });

  it('a page a callee of a callee publishes is named to every caller up the chain', async () => {
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['a', [node('b')]],
        ['b', [node('c')]],
      ]),
    });
    const outer = broker.callAgent('run-1', 'a', {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    // b, answering call-1, calls c from inside that call.
    const inner = broker.callAgent('run-1', callerKey('b', 'call-1'), {
      title: 'why',
      agent: 'c',
      message: 'm',
    });
    expect(broker.callAnsweredBy('run-1', callerKey('c', 'call-2'))).toBe(
      'call-2',
    );
    broker.notePublishedArtifact('run-1', 'call-2', {
      artifact_id: 'deep',
      title: 'Deep page',
      version: 1,
    });
    deferred[1]!.resolve(completed('c done'));
    deferred[0]!.resolve(completed('b done'));
    const page = [{ artifact_id: 'deep', title: 'Deep page', version: 1 }];
    expect(await inner).toMatchObject({ result: { artifacts: page } });
    expect(await outer).toMatchObject({ result: { artifacts: page } });
  });

  it('reaches a call still running above one that already settled', async () => {
    // a → b (call-1) → c fire-and-forget (call-2) → d (call-3): b's call does
    // not wait for a fire-and-forget callee, so it settles while c works on.
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['root', [node('a')]],
        ['a', [node('b')]],
        ['b', [node('c')]],
      ]),
    });
    const top = broker.callAgent('run-1', 'root', {
      title: 'why',
      agent: 'a',
      message: 'm',
    });
    const middle = broker.callAgent('run-1', callerKey('a', 'call-1'), {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    await broker.callAgent('run-1', callerKey('b', 'call-2'), {
      title: 'why',
      agent: 'c',
      message: 'm',
      mode: 'fire_and_forget',
    });
    deferred[1]!.resolve(completed('b done'));
    expect(await middle).not.toHaveProperty('result.artifacts');
    broker.notePublishedArtifact('run-1', 'call-3', {
      artifact_id: 'late',
      title: 'Late page',
      version: 1,
    });
    deferred[2]!.resolve(completed('c done'));
    deferred[0]!.resolve(completed('a done'));
    expect(await top).toMatchObject({
      result: {
        artifacts: [{ artifact_id: 'late', title: 'Late page', version: 1 }],
      },
    });
  });

  it('reaches a call still running above one whose launch THREW', async () => {
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['root', [node('a')]],
        ['a', [node('b')]],
        ['b', [node('c')]],
      ]),
    });
    const top = broker.callAgent('run-1', 'root', {
      title: 'why',
      agent: 'a',
      message: 'm',
    });
    const middle = broker.callAgent('run-1', callerKey('a', 'call-1'), {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    await broker.callAgent('run-1', callerKey('b', 'call-2'), {
      title: 'why',
      agent: 'c',
      message: 'm',
      mode: 'fire_and_forget',
    });
    deferred[1]!.reject(new Error('spawn exploded'));
    expect(await middle).toMatchObject({ status: 'error' });
    broker.notePublishedArtifact('run-1', 'call-3', {
      artifact_id: 'late',
      title: 'Late page',
      version: 1,
    });
    deferred[2]!.resolve(completed('c done'));
    deferred[0]!.resolve(completed('a done'));
    expect(await top).toMatchObject({
      result: {
        artifacts: [{ artifact_id: 'late', title: 'Late page', version: 1 }],
      },
    });
  });

  it('a member’s own conversation answers no call', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    expect(broker.callAnsweredBy('run-1', 'orch')).toBeNull();
    expect(broker.callAnsweredBy('run-1', 'helper')).toBeNull();
    deferred[0]!.resolve(completed('done'));
    await pending;
  });

  it('undoing a note puts back what the call named before — and drops a first page entirely', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    // A revision whose row then failed, and a new page whose row failed.
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 2,
    })();
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'lost',
      title: 'Lost',
      version: 1,
    })();
    deferred[0]!.resolve(completed('planned'));
    const { result } = (await pending) as { result: { artifacts: unknown } };
    expect(result.artifacts).toEqual([
      { artifact_id: 'plan', title: 'Plan', version: 1 },
    ]);
  });

  it('an undo leaves alone a newer page that replaced the one it took back', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'plan it',
    });
    const undo = broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 2,
    });
    undo();
    deferred[0]!.resolve(completed('planned'));
    const { result } = (await pending) as { result: { artifacts: unknown } };
    expect(result.artifacts).toEqual([
      { artifact_id: 'plan', title: 'Plan', version: 2 },
    ]);
  });

  it('a failed call still names the pages it left in the user’s chat', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    broker.notePublishedArtifact('run-1', 'call-1', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'exit 1',
      failureClass: 'crashed',
      resetsAt: null,
      sessionId: null,
    });
    expect(await pending).toMatchObject({
      status: 'error',
      artifacts: [{ artifact_id: 'plan', title: 'Plan', version: 1 }],
    });
  });
});

describe('CallBroker — buttons published inside a call', () => {
  const completed = (finalText: string): CalleeTurnOutcome => ({
    status: 'completed',
    finalText,
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: 'sess-call-1',
  });
  const node = (id: string): TeamMember => member(id);
  const merged = {
    action_id: 'pr-merged',
    label: 'PR merged',
    kind: 'message',
  } as const;

  it('names each live button a callee published, at its newest publish, in its envelope and its call_result row', async () => {
    const { broker, deferred, items } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'open the PR',
    });
    expect(broker.callAnsweredBy('run-1', callerKey('helper', 'call-1'))).toBe(
      'call-1',
    );
    broker.notePublishedAction('run-1', 'call-1', 'helper|call-1|pr-merged', {
      ...merged,
      label: 'Merged?',
    });
    broker.notePublishedAction(
      'run-1',
      'call-1',
      'helper|call-1|pr-merged',
      merged,
    );
    broker.notePublishedAction('run-1', 'call-1', 'helper|call-1|stop', {
      action_id: 'stop',
      label: 'Stop preview',
      kind: 'message',
    });
    broker.forgetPublishedAction('run-1', 'helper|call-1|stop');
    deferred[0]!.resolve(completed('opened'));
    const envelope = await pending;
    expect(envelope).toEqual({
      status: 'ok',
      result: {
        call_id: 'call-1',
        agent: 'helper',
        text: 'opened',
        // The newest publish of a key; a removed button is not named.
        actions: [merged],
        note: PUBLISHED_ACTIONS_NOTE,
      },
    });
    const result = items.find((i) => i.kind === 'call_result')!;
    expect(result.payload.result).toEqual(
      (envelope as { result: unknown }).result,
    );
  });

  it('names a button published deep in a chain on every call above it, beside the pages', async () => {
    const { broker, deferred } = harness({
      launch: 'defer',
      calleesOf: new Map([
        ['a', [node('b')]],
        ['b', [node('c')]],
      ]),
    });
    const outer = broker.callAgent('run-1', 'a', {
      title: 'why',
      agent: 'b',
      message: 'm',
    });
    const inner = broker.callAgent('run-1', callerKey('b', 'call-1'), {
      title: 'why',
      agent: 'c',
      message: 'm',
    });
    broker.notePublishedAction('run-1', 'call-2', 'c|call-2|pr-merged', merged);
    broker.notePublishedArtifact('run-1', 'call-2', {
      artifact_id: 'plan',
      title: 'Plan',
      version: 1,
    });
    deferred[1]!.resolve(completed('c done'));
    deferred[0]!.resolve(completed('b done'));
    expect(await inner).toMatchObject({ result: { actions: [merged] } });
    const { result } = (await outer) as {
      result: { actions: unknown; note: string };
    };
    expect(result.actions).toEqual([merged]);
    expect(result.note).toBe(
      `${PUBLISHED_PAGES_NOTE} ${PUBLISHED_ACTIONS_NOTE}`,
    );
  });

  it('an undone note drops a button whose row failed, and leaves a newer publish alone', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    broker.notePublishedAction('run-1', 'call-1', 'k|lost', {
      ...merged,
      action_id: 'lost',
    })();
    const undo = broker.notePublishedAction('run-1', 'call-1', 'k|pr', {
      ...merged,
      label: 'old',
    });
    broker.notePublishedAction('run-1', 'call-1', 'k|pr', merged);
    undo();
    deferred[0]!.resolve(completed('done'));
    expect(await pending).toMatchObject({ result: { actions: [merged] } });
  });

  it('a failed call still names the buttons it left in the user’s chat', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    broker.notePublishedAction('run-1', 'call-1', 'k|pr', merged);
    deferred[0]!.resolve({
      status: 'failed',
      finalText: null,
      error: 'exit 1',
      failureClass: 'crashed',
      resetsAt: null,
      sessionId: null,
    });
    const envelope = await pending;
    expect(envelope).toMatchObject({ status: 'error', actions: [merged] });
    expect(envelope).not.toHaveProperty('artifacts');
  });

  it('names no button in the envelope of a call that published none', async () => {
    const { broker, deferred } = harness({ launch: 'defer' });
    const pending = broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });
    deferred[0]!.resolve(completed('done'));
    expect(await pending).toEqual({
      status: 'ok',
      result: { call_id: 'call-1', agent: 'helper', text: 'done' },
    });
  });
});

describe('CallBroker — the machine sleeping through a deadline', () => {
  // node's timers count through a macOS sleep, so every window that ran out
  // while the lid was shut fired the instant it opened (2026-10-10). Time
  // asleep is not a callee going quiet, nor a caller failing to answer.
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  afterEach(() => {
    vi.useRealTimers();
  });

  const stalls = (items: { payload: Record<string, unknown> }[]) =>
    items.filter((i) => i.payload.stalledCall === true);

  it('does not report a callee as stalled at the wake, and gives it a full window from there', async () => {
    vi.useFakeTimers();
    const { broker, items } = harness({ launch: 'defer' });
    void broker.callAgent('run-1', 'orch', {
      title: 'why',
      agent: 'helper',
      message: 'm',
    });

    await vi.advanceTimersByTimeAsync(45_000);
    await simulateSleep(4 * HOUR);
    expect(stalls(items)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1_000);
    expect(stalls(items)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(stalls(items)).toHaveLength(1);
  });

  it('does not time a parked question out at the wake; its TTL starts again from there', async () => {
    vi.useFakeTimers();
    const { broker } = harness({ launch: 'defer' });
    await broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    const fail = vi.fn();
    expect(
      broker.parkQuestion('run-1', 'call-1', {
        question: 'Which color?',
        options: ['Red', 'Blue'],
        payload: { questions: [{ question: 'Which color?' }] },
        ttlMs: 30 * MINUTE,
        deliver: () => true,
        fail,
      }),
    ).toBe(true);

    await vi.advanceTimersByTimeAsync(45_000);
    await simulateSleep(4 * HOUR);
    expect(fail).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1_000);
    expect(fail).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fail).toHaveBeenCalledTimes(1);
  });
});

describe('CallBroker — tells the executor when a conversation is blocked', () => {
  // What the active-turn cap reads: a blocked turn stops counting, so a turn
  // waiting on calls that are themselves queued for a slot can never hold the
  // slot they need.
  const helperIn = (call: string): string => callerKey('helper', call);
  const DONE: CalleeTurnOutcome = {
    status: 'completed',
    finalText: 'done',
    error: null,
    failureClass: null,
    resetsAt: null,
    sessionId: 'sess-x',
  };

  it('a sync call_agent blocks its caller for exactly the wait', async () => {
    const h = harness({ launch: 'defer' });
    const call = h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.blockedReports).toEqual([['orch', true]]);
    h.deferred[0]!.resolve(DONE);
    await call;
    expect(h.blockedReports).toEqual([
      ['orch', true],
      ['orch', false],
    ]);
  });

  it('a parked question blocks the asking callee until it is answered', async () => {
    const h = harness({ launch: 'defer' });
    await h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
      mode: 'async',
    });
    h.broker.parkQuestion('run-1', 'call-1', {
      question: 'Which?',
      options: [],
      payload: null,
      deliver: () => true,
      fail: () => {},
    });
    expect(h.blockedReports).toEqual([[helperIn('call-1'), true]]);
    h.broker.answerAgent('run-1', 'orch', { call_id: 'call-1', answer: 'A' });
    expect(h.blockedReports).toEqual([
      [helperIn('call-1'), true],
      [helperIn('call-1'), false],
    ]);
  });

  it('reports a change only: a card and a wait together are one block, lifted by the last', async () => {
    const h = harness({ launch: 'defer' });
    h.broker.noteCallerBlocked('run-1', 'orch', 'card-1');
    const call = h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
    });
    await new Promise((resolve) => setImmediate(resolve));
    h.broker.noteCallerUnblocked('run-1', 'orch', 'card-1');
    expect(h.blockedReports).toEqual([['orch', true]]);
    h.deferred[0]!.resolve(DONE);
    await call;
    expect(h.blockedReports).toEqual([
      ['orch', true],
      ['orch', false],
    ]);
  });

  it('a conversation whose turn ended is no longer blocked by the cards it left', () => {
    const h = harness();
    h.broker.noteCallerBlocked('run-1', 'orch', 'card-1');
    h.broker.drainCaller('run-1', 'orch');
    expect(h.blockedReports).toEqual([
      ['orch', true],
      ['orch', false],
    ]);
  });

  it('a caller’s own call_agent is a fresh turn, never a wake', async () => {
    const h = harness();
    await h.broker.callAgent('run-1', 'orch', {
      title: 'work',
      agent: 'helper',
      message: 'm',
    });
    expect(h.launches.map((launch) => launch.callId)).toEqual(['call-1']);
    expect(h.wakes).toEqual([]);
  });
});
