import type { EntityManager } from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
import { BadRequestException, NotFoundException } from '@packages/common';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { AgentKind } from '../../runs/runs.types';
import { FakeWallTurnDao } from '../__tests__/fake-wall-turn-dao';
import {
  type AgentContextUsage,
  NO_PLAN_LIMITS,
  type UsageReading,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { PlanLimitsWire, RunItemEvent } from '../chat.types';
import { ChatMetricsWireSchema } from '../chat.types';
import type { CallContextDao } from '../dao/call-context.dao';
import type { ItemDao } from '../dao/item.dao';
import type { NodeStateDao } from '../dao/node-state.dao';
import type { RunDao } from '../dao/run.dao';
import type { WallTurnDao } from '../dao/wall-turn.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import type { AgentEventBus } from './agent-events.bus';
import type { AgentSessionRegistry } from './agent-session.registry';
import { ChatMetricsService } from './chat-metrics.service';
import type { ConfigDirPinService } from './config-dir-pin.service';
import type { PolledSpendService } from './polled-spend.service';
import type { RunKindRowsCache } from './run-kind-rows.cache';

/**
 * Every NAMED component of the wire shape populated, not just the top level.
 *
 * `memoryFiles` and `servers` were empty here, and the wire round-trip below
 * reads whatever this fixture produces — so `ContextMemoryFile` and
 * `ContextServer` were never entered, and dropping a field from either passed
 * the whole suite AND the type gate while losing that field on the way to the
 * renderer. A fixture that skips an arm cannot pin the arm.
 */
const BREAKDOWN: AgentContextUsage = {
  categories: [
    { name: 'System prompt', tokens: 3386, deferred: false },
    { name: 'MCP tools', tokens: 273_876, deferred: true },
  ],
  totalTokens: 3386,
  maxTokens: 1_000_000,
  model: 'claude-opus-5[1m]',
  autoCompactAtTokens: 967_000,
  autoCompactEnabled: true,
  memoryFiles: [{ path: '/proj/CLAUDE.md', kind: 'Project', tokens: 45_947 }],
  servers: [
    { name: 'amplitude', tokens: 109_284, toolCount: 33, loadedToolCount: 0 },
  ],
};

const NO_CALL_SESSIONS = {
  sessionsByCall: () => Promise.resolve(new Map<string, string[]>()),
} as unknown as CallContextDao;

/** The run's usage rows and call records, as `RunKindRowsCache` hands them out. */
function usageRowsOf(
  rows: readonly { memberId: string | null; payload: string }[],
  callRecords: readonly unknown[] = [],
  spanRows: (
    runId: string,
    kinds: readonly string[],
    atLeast: unknown,
  ) => Promise<unknown[]> = () => Promise.resolve([]),
): RunKindRowsCache {
  return {
    rowsOf: (runId: string, kinds: readonly string[], atLeast: unknown) =>
      kinds.includes('status')
        ? spanRows(runId, kinds, atLeast)
        : Promise.resolve(rows),
    rowsOfView: () => Promise.resolve(callRecords),
  } as unknown as RunKindRowsCache;
}

/** One stored `turn_complete` payload, as the transcript holds it. */
function turn(usage: Record<string, unknown> | null): string {
  return JSON.stringify({ usage, stopReason: 'end_turn' });
}

function build(opts: {
  agentKind?: AgentKind | null;
  runExists?: boolean;
  payloads?: string[];
  breakdown?: AgentContextUsage | null;
  /**
   * What this CLI says about the breakdown — whether it can be asked at all,
   * and through WHICH channel. Defaults to the on-disk channel, which is the
   * shape every case written before the channel existed assumed: a recorded
   * session id was enough to ask through.
   */
  breakdownReading?: UsageReading;
  readContextUsage?: () => Promise<AgentContextUsage | null>;
  /**
   * What the run holds to be asked THROUGH. Defaults to a recorded session id,
   * which is the shape every existing case was written against; `null` on both
   * is the chat with nothing to ask at all.
   */
  agentSessionId?: string | null;
  liveSession?: unknown;
  /** What the run row holds as its last farewell reading, verbatim JSON. */
  lastMetricsReading?: string | null;
  /** The profile the run is on NOW — what a stored reading is checked against. */
  configDir?: string | null;
  /** Where the transcript stands NOW — what a stored `atSeq` is checked against. */
  maxSeq?: number;
  readPlanLimits?: (input: {
    live: unknown;
    configDir: string | null;
    mayProbe?: boolean;
  }) => Promise<PlanLimitsWire | typeof NO_PLAN_LIMITS | null>;
  planReading?: UsageReading;
  /** Each run's profile — overrides `configDir`. */
  configDirFor?: (runId: string) => string | null;
  /** The config directory each run's FOLDER pins, by the run's id. */
  pinFor?: (runId: string) => string | null;
  /** Which session keys hold a live process — overrides `liveSession`. */
  peek?: (sessionKey: string) => unknown;
  /** Every kept process the registry holds, whichever run it serves. */
  liveSessions?: {
    key: string;
    agent: string;
    cwd: string;
    configDir: string | null;
    session: unknown;
  }[];
  /** A TEAM run: its turns by member, its member kinds, its polled bill. */
  team?: {
    rows: { memberId: string | null; payload: string }[];
    states: { memberId: string; agentKind: AgentKind }[];
    runPolledCents?: number;
  };
}) {
  const remembered = vi.fn().mockResolvedValue(undefined);
  const turnSpanRows = vi.fn().mockResolvedValue([]);
  const turns = new Subject<RunItemEvent>();
  let farewell: ((runId: string) => Promise<void>) | null = null;
  const readContextUsage =
    opts.readContextUsage ??
    vi.fn().mockResolvedValue('breakdown' in opts ? opts.breakdown : BREAKDOWN);
  const service = new ChatMetricsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {
      rememberMetricsReading: remembered,
      getById: (runId: string) =>
        Promise.resolve(
          opts.runExists === false
            ? null
            : {
                agentKind:
                  'agentKind' in opts ? opts.agentKind : AgentKind.Claude,
                lastMetricsReading: opts.lastMetricsReading ?? null,
                // One folder per run, so a pin can be put on one of them.
                cwd: `/proj/${runId}`,
                configDir: opts.configDirFor
                  ? opts.configDirFor(runId)
                  : (opts.configDir ?? null),
                teamId: opts.team === undefined ? null : 'wf',
                polledCostCents: opts.team?.runPolledCents ?? null,
                polledCostEvents:
                  opts.team?.runPolledCents === undefined ? null : 2,
              },
        ),
    } as unknown as RunDao,
    {
      maxSeq: () => Promise.resolve(opts.maxSeq ?? 7),
    } as unknown as ItemDao,
    {
      listByRun: () => Promise.resolve(opts.team?.states ?? []),
      getByRunNode: () =>
        Promise.resolve({
          agentSessionId:
            'agentSessionId' in opts ? opts.agentSessionId : 'sess-1',
        }),
    } as unknown as NodeStateDao,
    {
      peek: (sessionKey: string) =>
        opts.peek ? opts.peek(sessionKey) : (opts.liveSession ?? null),
      liveSessions: () => opts.liveSessions ?? [],
      onIdleFarewell: (listener: (runId: string) => Promise<void>) => {
        farewell = listener;
      },
    } as unknown as AgentSessionRegistry,
    {
      for: () =>
        ({
          getConfig: () => ({
            usage: {
              unavailableReason: null,
              breakdown: opts.breakdownReading ?? {
                kind: 'reads',
                channel: 'session-store',
              },
              // Out of the way of every breakdown case: this fake CLI has no
              // plan channel, so nothing here asks for one.
              planLimits: opts.planReading ?? {
                kind: 'unavailable',
                reason: 'this fake CLI reports no plan limits',
              },
            },
          }),
          readContextUsage,
          readPlanLimits: opts.readPlanLimits ?? (() => Promise.resolve(null)),
        }) as unknown as AgentAdapter,
    } as unknown as AgentAdapterRegistry,
    // The prewarm's own channel. A Subject rather than a stub, so a spec can
    // play a real turn ending and watch what the service does about it.
    { all: () => turns.asObservable() } as unknown as AgentEventBus,
    // The polled spend poll. A no-op double: every spec here is about the
    // BREAKDOWN, and the service only ever fires this without awaiting it, so a
    // real one would put a network read behind assertions about a readout.
    {
      refresh: () => Promise.resolve(),
      runHoldsPolledSpend: () => Promise.resolve(false),
      pollsSpend: (kind: string | null) => kind === AgentKind.CursorAgent,
    } as unknown as PolledSpendService,
    {
      forRun: (_kind: string, cwd: string | null) => {
        const pinned = opts.pinFor?.(String(cwd).replace('/proj/', ''));
        return pinned
          ? { effective: pinned, source: `${cwd}/.claude/settings.local.json` }
          : null;
      },
    } as unknown as ConfigDirPinService,
    wallTurns as unknown as WallTurnDao,
    usageRowsOf(
      opts.team?.rows ??
        (opts.payloads ?? []).map((payload) => ({ memberId: null, payload })),
      [],
      turnSpanRows,
    ),
    NO_CALL_SESSIONS,
  );
  service.onModuleInit();
  return {
    service,
    readContextUsage,
    remembered,
    turnSpanRows,
    /** Fire what the session registry would fire on an idle close. */
    farewell: () => farewell!('run-1'),
    /** Play a settled turn onto the agent bus, as the chat service would. */
    settleTurn: (runId = 'run-1') =>
      turns.next({
        runId,
        item: { kind: 'turn_complete', seq: opts.maxSeq ?? 7 },
      } as unknown as RunItemEvent),
  };
}

/** The wall ledger the totals add to the CLIs' own time. */
const wallTurns = new FakeWallTurnDao();

describe('ChatMetricsService — one team member', () => {
  // A team run keeps a process per member, so its readout names the member:
  // REPORTED as "i cant see full context info for team" while the composer
  // ring of a team run offered a figure and nothing behind it.
  function buildNode(
    state: Record<string, unknown> | null,
    opts: {
      /** What the member's agent answers when asked now. */
      breakdown?: AgentContextUsage | null;
      /** Where the NODE's own transcript stands. */
      maxSeq?: number;
      snapshot?: string;
      nodeRows?: { memberId: string; payload: string }[];
    } = {},
  ) {
    const peek = vi.fn().mockReturnValue(null);
    const getByRunNode = vi.fn().mockResolvedValue(state);
    const usageRows = [
      {
        memberId: 'manager',
        payload: turn({ inputTokens: 10, outputTokens: 5 }),
      },
      {
        memberId: 'engineer',
        payload: turn({ inputTokens: 900, outputTokens: 1 }),
      },
    ];
    const maxSeq = vi.fn().mockResolvedValue(opts.maxSeq ?? 1);
    const readContextUsage = vi
      .fn()
      .mockResolvedValue('breakdown' in opts ? opts.breakdown : BREAKDOWN);
    const runRemember = vi.fn().mockResolvedValue(undefined);
    const nodeRemember = vi.fn().mockResolvedValue(undefined);
    const turns = new Subject<RunItemEvent>();
    let farewell: ((key: string) => Promise<void>) | null = null;
    const service = new ChatMetricsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: () =>
          Promise.resolve({
            agentKind: null,
            lastMetricsReading: null,
            configDir: null,
            teamSnapshot: opts.snapshot,
          }),
        rememberMetricsReading: runRemember,
      } as unknown as RunDao,
      {
        maxSeq,
        poolHandOffRows: () => Promise.resolve(opts.nodeRows ?? []),
      } as unknown as ItemDao,
      {
        getByRunNode,
        listByRun: vi.fn().mockResolvedValue(state === null ? [] : [state]),
        rememberMetricsReading: nodeRemember,
      } as unknown as NodeStateDao,
      {
        peek,
        liveSessions: () => [],
        onIdleFarewell: (listener: (key: string) => Promise<void>) => {
          farewell = listener;
        },
      } as unknown as AgentSessionRegistry,
      {
        for: () =>
          ({
            getConfig: () => ({
              usage: {
                unavailableReason: null,
                breakdown: { kind: 'reads', channel: 'session-store' },
                planLimits: { kind: 'unavailable', reason: 'none here' },
              },
            }),
            readContextUsage,
            readPlanLimits: () => Promise.resolve(null),
          }) as unknown as AgentAdapter,
      } as unknown as AgentAdapterRegistry,
      { all: () => turns.asObservable() } as unknown as AgentEventBus,
      {
        refresh: () => Promise.resolve(),
        runHoldsPolledSpend: () => Promise.resolve(false),
        pollsSpend: (kind: string | null) => kind === AgentKind.CursorAgent,
      } as unknown as PolledSpendService,
      { forRun: () => null } as unknown as ConfigDirPinService,
      wallTurns as unknown as WallTurnDao,
      usageRowsOf(usageRows),
      NO_CALL_SESSIONS,
    );
    service.onModuleInit();
    return {
      service,
      peek,
      getByRunNode,
      maxSeq,
      readContextUsage,
      runRemember,
      nodeRemember,
      /** Fire what the registry fires on an idle close of the process under `key`. */
      farewell: (key: string) => farewell!(key),
      /** Play a settled turn of `nodeId` onto the agent bus. */
      settleTurn: (memberId: string) =>
        turns.next({
          runId: 'run-1',
          item: { kind: 'turn_complete', memberId, seq: 2 },
        } as unknown as RunItemEvent),
    };
  }

  /** A reading as `store` files it, pinned to `atSeq`. */
  const storedNodeReading = (atSeq: number): string =>
    JSON.stringify({
      takenAt: '2026-09-14T10:00:00.000Z',
      atSeq,
      configDir: null,
      context: BREAKDOWN,
      plan: null,
    });

  it('stores a switched root reading under the backup account', async () => {
    const built = buildNode(
      { agentKind: AgentKind.Claude, agentSessionId: 'backup-root' },
      {
        snapshot: JSON.stringify({
          nodes: [
            {
              id: 'manager',
              agent: 'claude',
              configDir: '/profiles/primary',
              pool: [{ agent: 'claude', configDir: '/profiles/backup' }],
            },
          ],
        }),
        nodeRows: [
          {
            memberId: 'manager',
            payload: '{"nodePoolHandOff":true,"member":2}',
          },
        ],
      },
    );
    await built.service.read('run-1', 'manager');
    expect(
      JSON.parse(built.nodeRemember.mock.calls[0]![2] as string),
    ).toMatchObject({ configDir: '/profiles/backup' });
  });

  it('serves the member’s LAST reading once its process is gone, dated when it was taken', async () => {
    // A claude Manager waits idle while its callees work, its process is closed
    // for idleness, and a live-only readout then had nothing — while a claude
    // chat beside it showed its breakdown from the reading it had kept.
    // REPORTED against exactly that Manager.
    const built = buildNode(
      {
        agentKind: AgentKind.Claude,
        agentSessionId: 'sess-manager',
        lastMetricsReading: storedNodeReading(4),
      },
      { breakdown: null, maxSeq: 4 },
    );

    const metrics = await built.service.read('run-1', 'manager');

    // Pinned to the NODE's own newest row, not the run's — the Engineer's work
    // moves the run's on every line.
    expect(built.maxSeq).toHaveBeenCalledWith(
      'run-1',
      expect.anything(),
      'manager',
    );
    expect(metrics.context).toEqual(BREAKDOWN);
    expect(metrics.takenAt).toBe('2026-09-14T10:00:00.000Z');
  });

  it('drops a member’s reading once that member has written a row since', async () => {
    const built = buildNode(
      {
        agentKind: AgentKind.Claude,
        agentSessionId: 'sess-manager',
        lastMetricsReading: storedNodeReading(4),
      },
      { breakdown: null, maxSeq: 9 },
    );

    const metrics = await built.service.read('run-1', 'manager');

    expect(metrics.context).toBeNull();
    expect(metrics.takenAt).toBeNull();
  });

  it('takes a member’s reading on its way out and files it on the MEMBER, never the run', async () => {
    const built = buildNode({
      agentKind: AgentKind.Claude,
      agentSessionId: 'sess-manager',
      lastMetricsReading: null,
    });

    await built.farewell('run-1::node:manager');

    expect(built.nodeRemember).toHaveBeenCalledWith(
      'run-1',
      'manager',
      expect.stringContaining('"atSeq":1'),
      expect.anything(),
    );
    expect(built.runRemember).not.toHaveBeenCalled();
  });

  it('leaves a CALL’s process alone — it has no readout of its own to file under', async () => {
    const built = buildNode({
      agentKind: AgentKind.Claude,
      agentSessionId: 'sess-engineer',
    });

    await built.farewell('run-1::call:call-2');

    expect(built.getByRunNode).not.toHaveBeenCalled();
    expect(built.nodeRemember).not.toHaveBeenCalled();
  });

  it('prewarms a member’s reading when THAT member’s turn settles after its readout was opened', async () => {
    const built = buildNode({
      agentKind: AgentKind.Claude,
      agentSessionId: 'sess-manager',
      lastMetricsReading: null,
    });
    await built.service.read('run-1', 'manager');
    built.nodeRemember.mockClear();
    built.maxSeq.mockResolvedValue(2);

    built.settleTurn('manager');

    await vi.waitFor(() =>
      expect(built.nodeRemember).toHaveBeenCalledWith(
        'run-1',
        'manager',
        expect.stringContaining('"atSeq":2'),
        expect.anything(),
      ),
    );
  });

  it('asks the MEMBER’s own process and session, and totals that member’s turns alone', async () => {
    const built = buildNode({
      agentKind: AgentKind.CursorAgent,
      agentSessionId: 'sess-manager',
    });

    const metrics = await built.service.read('run-1', 'manager');

    // The key the executor keeps that member's process under — not the run's.
    expect(built.peek).toHaveBeenCalledWith('run-1::node:manager');
    expect(built.getByRunNode).toHaveBeenCalledWith(
      'run-1',
      'manager',
      expect.anything(),
    );
    expect(built.readContextUsage).toHaveBeenCalledWith({
      live: null,
      sessionId: 'sess-manager',
      configDir: null,
    });
    expect(metrics.totals.inputTokens).toBe(10);
    expect(metrics.context).toEqual(BREAKDOWN);
    expect(ChatMetricsWireSchema.parse(metrics)).toEqual(metrics);
    // Filed on the NODE for the next open; the run row holds one reading per
    // RUN and a member's must not overwrite it.
    await vi.waitFor(() =>
      expect(built.nodeRemember).toHaveBeenCalledWith(
        'run-1',
        'manager',
        expect.any(String),
        expect.anything(),
      ),
    );
    expect(built.runRemember).not.toHaveBeenCalled();
  });

  it('refuses a member that has never run in this run', async () => {
    const built = buildNode(null);

    await expect(built.service.read('run-1', 'ghost')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(built.readContextUsage).not.toHaveBeenCalled();
  });
});

describe('ChatMetricsService — one agent-to-agent call', () => {
  // The call footer's ring is the callee's own window, and hovering it could
  // only restate that one figure: REPORTED as "when hovering to context in
  // footer - i wanna see full details with subscription and so on, same as in
  // main chat".
  const started = (
    callId: string,
    calleeMemberId: string,
    thread?: string,
  ) => ({
    kind: 'call_started',
    payload: JSON.stringify({
      callId,
      callerNodeId: 'manager',
      calleeNodeId: calleeMemberId,
      ...(thread === undefined ? {} : { thread }),
    }),
  });
  const result = (
    callId: string,
    calleeMemberId: string,
    sessionId: string,
    member?: number,
  ) => ({
    kind: 'call_result',
    payload: JSON.stringify({
      callId,
      callerNodeId: 'manager',
      calleeNodeId: calleeMemberId,
      sessionId,
      ...(member === undefined ? {} : { member }),
    }),
  });
  const callTurn = (
    memberId: string,
    callId: string | null,
    input: number,
  ) => ({
    memberId,
    payload: JSON.stringify({
      usage: { inputTokens: input, outputTokens: 1 },
      ...(callId === null ? {} : { callId }),
    }),
  });

  function buildCall(
    opts: {
      live?: unknown;
      plan?: PlanLimitsWire;
      /** The engineer is a pool [claude, codex] and call-3 ran on member 2. */
      pooled?: boolean;
      /** call-3 has not settled yet: no result names its member. */
      inFlight?: boolean;
      /** The CLI the process holding the conversation runs. */
      liveAgent?: string;
      /** The callee's stored bill, per conversation. */
      polledSpend?: string;
      callDao?: CallContextDao;
      /** The CLI's plan reading may come from a one-shot process. */
      oneShotPlan?: boolean;
    } = {},
  ) {
    const peek = vi.fn().mockReturnValue(opts.live ?? null);
    const agentOf = vi.fn().mockReturnValue(opts.liveAgent ?? null);
    const getByRunNode = vi
      .fn()
      .mockImplementation((_run: string, memberId: string) =>
        Promise.resolve(
          memberId === 'engineer'
            ? {
                agentKind: AgentKind.Claude,
                agentSessionId: 'sess-own',
                polledSpend: opts.polledSpend ?? null,
              }
            : null,
        ),
      );
    const readContextUsage = vi.fn().mockResolvedValue(BREAKDOWN);
    const readPlanLimits = vi.fn().mockResolvedValue(opts.plan ?? null);
    const runRemember = vi.fn().mockResolvedValue(undefined);
    const nodeRemember = vi.fn().mockResolvedValue(undefined);
    const adapterFor = vi.fn();
    const service = new ChatMetricsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: () =>
          Promise.resolve({
            agentKind: null,
            lastMetricsReading: null,
            configDir: null,
            polledCostCents: null,
            polledCostEvents: null,
            teamSnapshot: opts.pooled
              ? JSON.stringify({
                  nodes: [
                    {
                      id: 'engineer',
                      kind: 'agent',
                      agent: 'claude',
                      pool: [{ agent: 'codex', configDir: '/profiles/b' }],
                    },
                  ],
                })
              : null,
          }),
        rememberMetricsReading: runRemember,
      } as unknown as RunDao,
      {
        maxSeq: () => Promise.resolve(9),
      } as unknown as ItemDao,
      {
        getByRunNode,
        listByRun: () => Promise.resolve([]),
        rememberMetricsReading: nodeRemember,
      } as unknown as NodeStateDao,
      {
        peek,
        agentOf,
        liveSessions: () => [],
        onIdleFarewell: () => {},
      } as unknown as AgentSessionRegistry,
      {
        for: adapterFor.mockImplementation(
          () =>
            ({
              getConfig: () => ({
                usage: {
                  unavailableReason: null,
                  breakdown: { kind: 'reads', channel: 'live-process' },
                  planLimits: {
                    kind: 'reads',
                    channel: 'live-process',
                    ...(opts.oneShotPlan ? { oneShot: true } : {}),
                  },
                },
              }),
              readContextUsage,
              readPlanLimits,
            }) as unknown as AgentAdapter,
        ),
      } as unknown as AgentAdapterRegistry,
      { all: () => new Subject<RunItemEvent>() } as unknown as AgentEventBus,
      {
        refresh: () => Promise.resolve(),
        runHoldsPolledSpend: () => Promise.resolve(false),
        pollsSpend: (kind: string | null) => kind === AgentKind.CursorAgent,
      } as unknown as PolledSpendService,
      { forRun: () => null } as unknown as ConfigDirPinService,
      wallTurns as unknown as WallTurnDao,
      usageRowsOf(
        [
          callTurn('engineer', 'call-1', 10),
          callTurn('engineer', null, 100),
          callTurn('researcher', 'call-2', 1000),
          callTurn('engineer', 'call-3', 20),
        ],
        [
          started('call-1', 'engineer'),
          result('call-1', 'engineer', 'sess-a'),
          started('call-2', 'researcher'),
          started('call-3', 'engineer', 'call-1'),
          ...(opts.inFlight
            ? []
            : [
                result(
                  'call-3',
                  'engineer',
                  'sess-b',
                  opts.pooled ? 2 : undefined,
                ),
              ]),
        ],
      ),
      opts.callDao ?? NO_CALL_SESSIONS,
    );
    service.onModuleInit();
    return {
      service,
      peek,
      getByRunNode,
      readContextUsage,
      readPlanLimits,
      runRemember,
      nodeRemember,
      adapterFor,
    };
  }

  const PLAN: PlanLimitsWire = { plan: 'max', windows: [], estimated: false };

  it('reads a team member’s plan from a one-shot process on a refresh while its own process is gone', async () => {
    const built = buildCall({ oneShotPlan: true, plan: PLAN });

    const metrics = await built.service.read('run-1', 'engineer', null, true);

    expect(built.readPlanLimits).toHaveBeenCalledTimes(1);
    expect(built.readPlanLimits.mock.calls[0]?.[0]).toMatchObject({
      live: null,
      mayProbe: true,
    });
    expect(metrics.plan).toEqual(PLAN);
    expect(metrics.planTakenAt).not.toBeNull();
  });

  it('spawns no one-shot plan reading on a refresh of a conversation whose account is unknown', async () => {
    const built = buildCall({
      pooled: true,
      inFlight: true,
      liveAgent: AgentKind.Codex,
      oneShotPlan: true,
    });

    await built.service.read('run-1', null, 'call-3', true);

    expect(built.readPlanLimits).not.toHaveBeenCalled();
  });

  const billed = (cents: number, spawnedBy?: string) => ({
    settled: { '2026-11-05|model': [cents, 1] },
    settledThroughMs: 0,
    open: {},
    ...(spawnedBy === undefined ? {} : { spawnedBy }),
  });

  it('states what the conversation’s sessions and their delegates cost, not the member’s whole bill', async () => {
    const built = buildCall({
      polledSpend: JSON.stringify({
        'sess-a': billed(100),
        'sess-b': billed(20),
        'delegate-of-a': billed(5, 'sess-a'),
        'sess-other-call': billed(9_999),
      }),
    });

    const { totals } = await built.service.read('run-1', null, 'call-3');

    expect(totals.costUsd).toBeCloseTo(1.25, 10);
  });

  it('prices a running call by the session it named before any result recorded it', async () => {
    const built = buildCall({
      inFlight: true,
      polledSpend: JSON.stringify({
        'sess-a': billed(100),
        'sess-running': billed(222),
      }),
      callDao: {
        sessionsByCall: () =>
          Promise.resolve(new Map([['call-3', ['sess-running']]])),
      } as unknown as CallContextDao,
    });

    const { totals } = await built.service.read('run-1', null, 'call-3');

    expect(totals.costUsd).toBeCloseTo(3.22, 10);
  });

  it('leaves a conversation no account billed unpriced rather than free', async () => {
    const built = buildCall({
      polledSpend: JSON.stringify({ 'sess-other-call': billed(9_999) }),
    });

    const { totals } = await built.service.read('run-1', null, 'call-3');

    expect(totals.costUsd).toBeNull();
  });

  it('asks a POOLED callee’s conversation of the pool member that held it, not the member’s last stamp', async () => {
    const built = buildCall({ live: {}, pooled: true });

    await built.service.read('run-1', null, 'call-3');

    expect(built.adapterFor).toHaveBeenCalledWith(AgentKind.Codex);
    expect(built.adapterFor).not.toHaveBeenCalledWith(AgentKind.Claude);
  });

  it('asks a call still RUNNING on another member of the CLI its live process runs', async () => {
    // No result names the pool member yet, so the member's stamp — pool member 1, claude —
    // was the only answer, and a claude control request went to codex's stdin.
    const built = buildCall({
      live: {},
      pooled: true,
      inFlight: true,
      liveAgent: AgentKind.Codex,
    });

    await built.service.read('run-1', null, 'call-3');

    expect(built.adapterFor).toHaveBeenCalledWith(AgentKind.Codex);
    expect(built.adapterFor).not.toHaveBeenCalledWith(AgentKind.Claude);
  });

  it('asks the process of the call’s CONVERSATION, with the session its newest result recorded', async () => {
    const live = { id: 'kept-engineer-process' };
    const built = buildCall({ live, plan: PLAN });

    const metrics = await built.service.read('run-1', null, 'call-3');

    // Keyed by the FIRST call of the lineage, as the executor keys the process.
    expect(built.peek).toHaveBeenCalledWith('run-1::call:call-1');
    const input = { live, sessionId: 'sess-b', configDir: null };
    expect(built.readContextUsage).toHaveBeenCalledWith(input);
    expect(built.readPlanLimits).toHaveBeenCalledWith(input);
    expect(metrics.context).toEqual(BREAKDOWN);
    expect(metrics.plan).toEqual(PLAN);
    expect(metrics.planReason).toBeNull();
  });

  it('totals that conversation’s calls alone — not the member’s own turns, not another callee’s', async () => {
    const built = buildCall();

    const metrics = await built.service.read('run-1', null, 'call-1');

    expect(metrics.totals.turns).toBe(2);
    expect(metrics.totals.inputTokens).toBe(30);
  });

  it('files nothing — a conversation has no row of its own to keep a reading on', async () => {
    const built = buildCall({ live: {}, plan: PLAN });

    await built.service.read('run-1', null, 'call-3');
    await new Promise((resolve) => setImmediate(resolve));

    expect(built.nodeRemember).not.toHaveBeenCalled();
    expect(built.runRemember).not.toHaveBeenCalled();
  });

  it('refuses a call the run never made, and one whose callee never ran', async () => {
    const built = buildCall();

    await expect(
      built.service.read('run-1', null, 'call-7'),
    ).rejects.toBeInstanceOf(NotFoundException);
    // call-2's callee has no node_state row.
    await expect(
      built.service.read('run-1', null, 'call-2'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(built.readContextUsage).not.toHaveBeenCalled();
  });

  it('refuses a request naming a member AND a call', async () => {
    const built = buildCall();

    await expect(
      built.service.read('run-1', 'engineer', 'call-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChatMetricsService', () => {
  it('answers with the live breakdown and no reason when one was taken', () => {
    const { service } = build({});

    return expect(service.read('run-1')).resolves.toMatchObject({
      context: BREAKDOWN,
      breakdownReason: null,
    });
  });

  it('answers something the wire schema accepts UNCHANGED', async () => {
    // The route serializes this reply THROUGH `ChatMetricsWireSchema`
    // (`@ZodResponse` → `ChatMetricsDto`), and zod strips what the schema does
    // not name — silently, so a field the service produces and the schema
    // omits vanishes between here and the renderer with nothing failing. The
    // strict parse is what makes that a test failure instead; comparing the
    // parsed value back against the original is what catches a DROPPED field,
    // which a bare `.parse()` would let through.
    //
    // Driven with every named component populated AND with real totals: the
    // check can only reach the arms the fixture reaches, so an empty
    // `memoryFiles` left `ContextMemoryFile` unverified, and all-null totals
    // left every `ChatTotals` field's non-null arm unverified.
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.42,
          inputTokens: 24,
          outputTokens: 1_200,
          cacheReadTokens: 1_300_000,
          cacheCreationTokens: 210_000,
          thinkingTokens: 300,
          durationMs: 252_000,
        }),
      ],
    });

    const metrics = await service.read('run-1');

    // The fixture actually reached the nested arms — otherwise this test
    // certifies the top level alone while reading as though it covered all of
    // it, which is what it did before.
    expect(metrics.context?.memoryFiles).toHaveLength(1);
    expect(metrics.context?.servers).toHaveLength(1);
    expect(metrics.totals.costUsd).not.toBeNull();
    expect(ChatMetricsWireSchema.parse(metrics)).toEqual(metrics);
  });

  it('names the CLI’s OWN reason when it has no such channel', async () => {
    // The whole point of the field: an agent that will never answer must read
    // differently from one whose process has simply been reaped.
    const { service, readContextUsage } = build({
      agentKind: AgentKind.CursorAgent,
      breakdownReading: {
        kind: 'unavailable',
        reason: 'cursor-agent has no channel for one',
      },
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toBe('cursor-agent has no channel for one');
    // Not even asked — the adapter has already said there is nothing to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it('tells the user how to get one back when the chat holds no process', async () => {
    // NOTHING to ask through: no live process and no recorded session id.
    const { service, readContextUsage } = build({
      breakdown: null,
      agentSessionId: null,
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
    // And it was not asked, because there was nobody to ask.
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  describe('the last reading of a process that has since been closed', () => {
    const STORED = JSON.stringify({
      takenAt: '2026-08-26T13:18:49.000Z',
      atSeq: 7,
      configDir: null,
      context: BREAKDOWN,
      plan: null,
    });

    it('shows it when there is no agent left to ask, stamped with when it was taken', async () => {
      // The other half of the reported "wrong popup withoput data": correcting
      // the sentence stopped the panel lying, and left it empty. claude answers
      // both figures from its running process alone, so a chat whose session
      // was reaped had nothing to show until the user spent a turn reviving it.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: STORED,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.context).toEqual(BREAKDOWN);
      expect(metrics.breakdownReason).toBeNull();
      // The stamp is not decoration: these figures are the state a
      // conversation was left in, and undated they read as current.
      expect(metrics.takenAt).toBe('2026-08-26T13:18:49.000Z');
    });

    it('drops it once the transcript has MOVED past what it describes', async () => {
      // A session closed some other way — evicted for the ceiling, or a daemon
      // restart — takes no farewell reading, so the run keeps an older one
      // while its conversation goes on growing. Figures from before those turns
      // describe a window that no longer exists, and a timestamp does not make
      // them true.
      const { service } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: STORED,
        maxSeq: 12,
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toBeNull();
      expect(metrics.takenAt).toBeNull();
      expect(metrics.breakdownReason).toContain('send a message');
    });

    it('drops a reading whose SHAPE it can no longer read', async () => {
      // Stored JSON outlives the code that wrote it. Half a breakdown drawn
      // from a shape that has moved is worse than the sentence saying there is
      // none, so it is discarded rather than coerced.
      const { service } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        lastMetricsReading: JSON.stringify({
          takenAt: '2026-08-26T13:18:49.000Z',
          atSeq: 7,
          context: { categories: 'all of them' },
          plan: null,
        }),
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toBeNull();
      expect(metrics.breakdownReason).toContain('send a message');
    });

    it('never dates a LIVE answer with an older reading’s moment', async () => {
      // `takenAt` says "these figures are from then". A CLI that answered now
      // must not wear it, or the panel reports a current reading as stale.
      const { service } = build({
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
      });

      const metrics = await service.read('run-1');

      expect(metrics.context).toEqual(BREAKDOWN);
      expect(metrics.takenAt).toBeNull();
    });

    it('takes one on the way out, against the transcript position it describes', async () => {
      // The registry's idle close awaits this — the last moment the process can
      // be asked anything at all.
      const { farewell, remembered, readContextUsage } = build({
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        maxSeq: 9,
      });

      await farewell();

      expect(readContextUsage).toHaveBeenCalled();
      const [runId, json] = remembered.mock.calls[0] ?? [];
      expect(runId).toBe('run-1');
      expect(JSON.parse(String(json))).toMatchObject({
        atSeq: 9,
        context: BREAKDOWN,
      });
    });

    it('does NOT ask again when a stored reading still describes this conversation', async () => {
      // REPORTED as "'reading agent context' is too slow when i hover on
      // current context circly. Why it working without delays for claude /
      // cursor in their UI?" — because those UIs ARE the CLI and the figures
      // are already in its memory. geniro has to ask over stdin, measured at
      // 1.84–2.18s against a warm claude, and it paid that on EVERY open: the
      // stored reading was consulted only where the live answer came back
      // empty, so a second hover a minute later, with not a word said in
      // between, asked the whole question again.
      //
      // `atSeq` is what makes reusing it safe, and the next case pins the
      // other side of that.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
        maxSeq: 7,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.context).toEqual(BREAKDOWN);
      // Not dated: nothing has been said since it was taken, so these figures
      // ARE what the agent would answer. The stamp drives the panel's "the
      // agent was closed — send a message" line, which would be false here.
      expect(metrics.takenAt).toBeNull();
      expect(metrics.breakdownReason).toBeNull();
    });

    /**
     * The same stored reading, but carrying an ALLOWANCE — which is the half
     * `atSeq` cannot vouch for.
     */
    const storedWithPlan = (
      takenAt: string,
      configDir: string | null = null,
    ): string =>
      JSON.stringify({
        takenAt,
        atSeq: 7,
        configDir,
        context: BREAKDOWN,
        plan: {
          plan: 'team',
          windows: [
            {
              key: 'weekly_all',
              label: 'Current week',
              percent: 100,
              resetsAt: '2026-08-29T09:00:00.000Z',
            },
          ],
          estimated: false,
        },
      });

    it('asks again for an allowance the transcript cannot vouch for', async () => {
      // REPORTED as "I STILL have team session", against a panel reading
      // `TEAM · Current week 100% · resets in 1d 15h`. `atSeq` is the whole
      // guard on the shortcut, and it is right about the CONTEXT and blind to
      // the ALLOWANCE: a week rolls, an account changes plan, and every turn
      // spent in another chat or another terminal moves the figure without
      // writing a row here. Reconstructed from the reporter's own geniro.db —
      // six runs holding `plan: "team"` at 100%, all still servable, the
      // oldest twelve hours old, while the same profile asked live answered
      // `max` with its week at 1%.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan('2026-08-26T13:18:49.000Z'),
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('asks again when the chat has CHANGED ACCOUNT since the reading', async () => {
      // REPORTED as a panel reading `TEAM · Current week 100%` on a chat whose
      // profile chip said `.claude-work-personal`. Both profiles were
      // on disk — `.claude-work` is `claude_team`, `-personal` is
      // `claude_max` — and the transcript carried the app's own row saying the
      // chat had been switched to the personal one, which brings the
      // conversation across. So `atSeq` was untouched and every account-level
      // figure in the reading belonged to the account the chat had left.
      //
      // Fresh in TIME, deliberately: the age bound cannot see this, which is
      // the whole reason the profile is its own key.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(
          new Date().toISOString(),
          '/Users/x/workspace/.claude-work',
        ),
        configDir: '/Users/x/workspace/.claude-work-personal',
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('serves a reading taken under the profile the chat is STILL on', async () => {
      // The other side of that key: a chat that never switched keeps the
      // shortcut, or the fix would cost every profiled chat the full ask.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(
          new Date().toISOString(),
          '/Users/x/workspace/.claude-work-personal',
        ),
        configDir: '/Users/x/workspace/.claude-work-personal',
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
    });

    it('says the account reports no limits — at once, and without an older reading — when the agent answered with none', async () => {
      // An agent that ANSWERED with no windows has an account with none. The
      // "did not answer in time" sentence sent the user to wait for a reading
      // that does not exist, and an older stored plan would show limits the
      // account no longer has.
      const { service } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        planReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        readPlanLimits: () => Promise.resolve(NO_PLAN_LIMITS),
        lastMetricsReading: storedWithPlan('2026-08-26T13:18:49.000Z'),
        maxSeq: 7,
      });

      const metrics = await service.read('run-1');

      expect(metrics.plan).toBeNull();
      expect(metrics.planReason).toContain('reports no plan limits');
      expect(metrics.planReason).not.toContain('in time');
    });

    it('files the profile it read under, so the next open can check it', async () => {
      // Without the write there is nothing to compare and every stored reading
      // fails the parse forever — the shortcut would simply never fire again.
      const { service, remembered } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: null,
        configDir: '/Users/x/workspace/.claude-work-personal',
        maxSeq: 4,
      });

      await service.read('run-1');
      await Promise.resolve();
      await Promise.resolve();

      const [, json] = remembered.mock.calls[0] ?? [];
      expect(JSON.parse(String(json))).toMatchObject({
        configDir: '/Users/x/workspace/.claude-work-personal',
      });
    });

    it('still serves an allowance taken moments ago, which is what the shortcut is FOR', async () => {
      // The other side of the bound. Without this arm the fix could be "never
      // reuse a plan reading", which puts the reported two-second wait back on
      // every hover.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(new Date().toISOString()),
        maxSeq: 7,
      });

      const metrics = await service.read('run-1');

      expect(readContextUsage).not.toHaveBeenCalled();
      expect(metrics.plan?.plan).toBe('team');
      expect(metrics.takenAt).toBeNull();
    });

    it('asks the agent again on a REFRESH, even where that same stored reading would be served', async () => {
      // The readout's refresh button. Served the stored reading back, the press
      // would change nothing on screen — which is the reported "there is no way
      // to update it by hand".
      const readPlanLimits = vi.fn().mockResolvedValue({
        plan: 'max',
        windows: [
          {
            key: 'session',
            label: 'Current session',
            percent: 3,
            resetsAt: null,
          },
        ],
        estimated: false,
      });
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        planReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan(new Date().toISOString()),
        maxSeq: 7,
        readPlanLimits,
      });

      const metrics = await service.read('run-1', null, null, true);

      expect(readContextUsage).toHaveBeenCalledTimes(1);
      expect(readPlanLimits).toHaveBeenCalledTimes(1);
      expect(metrics.plan?.plan).toBe('max');
    });

    it('asks an ACCOUNT channel with no process and no session, under the run’s profile', async () => {
      const readPlanLimits = vi.fn().mockResolvedValue({
        plan: 'Premium',
        windows: [
          { key: 'included', label: 'Included', percent: 6, resetsAt: null },
        ],
        estimated: false,
      });
      const { service } = build({
        agentKind: AgentKind.CursorAgent,
        planReading: { kind: 'reads', channel: 'account' },
        agentSessionId: null,
        configDir: '/Users/me/.cursor-pf',
        readPlanLimits,
      });

      const metrics = await service.read('run-1');

      expect(readPlanLimits).toHaveBeenCalledWith({
        live: null,
        sessionId: null,
        configDir: '/Users/me/.cursor-pf',
      });
      expect(metrics.plan?.plan).toBe('Premium');
      expect(metrics.planReason).toBeNull();
    });

    it('refuses to date an allowance whose stamp will not parse', async () => {
      // An unparseable stamp is not evidence of freshness — it is the absence
      // of evidence, and the defensive branch this asserts is the one a later
      // "dead code" pass would otherwise delete.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: storedWithPlan('not a timestamp'),
        maxSeq: 7,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('asks again the moment the transcript has moved', async () => {
      // The guard the shortcut rests on. One new row of any kind and the
      // stored figures describe a window that no longer exists — so this is
      // the case that must still pay the two seconds.
      const { service, readContextUsage } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: STORED,
        maxSeq: 8,
      });

      await service.read('run-1');

      expect(readContextUsage).toHaveBeenCalled();
    });

    it('FILES a live answer, so the next open is the fast one', async () => {
      // Without this the shortcut above could never fire on a chat the user is
      // actually in: readings were only ever written on a session's way out,
      // so the first open asked, wrote nothing, and the second open asked
      // again. The write is not awaited — the reader is waiting on the reply
      // and the file is for whoever opens next — so this drains the microtask
      // queue before looking.
      const { service, remembered } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        lastMetricsReading: null,
        maxSeq: 4,
      });

      await service.read('run-1');
      await new Promise((resolve) => setTimeout(resolve, 0));

      const [runId, json] = remembered.mock.calls[0] ?? [];
      expect(runId).toBe('run-1');
      expect(JSON.parse(String(json))).toMatchObject({
        atSeq: 4,
        context: BREAKDOWN,
      });
    });

    it('takes a reading when a WATCHED chat settles a turn, and only then', async () => {
      // The prewarm, and the gate on it. Asking costs a real control write on
      // the user's own agent, so it is spent on chats whose readout they have
      // opened — never as a tax on every turn of every conversation.
      const { service, readContextUsage, settleTurn } = build({
        breakdownReading: { kind: 'reads', channel: 'live-process' },
        liveSession: { ask: () => Promise.resolve(BREAKDOWN) },
        maxSeq: 9,
      });

      // Nobody has opened this chat's readout yet.
      settleTurn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.mocked(readContextUsage)).not.toHaveBeenCalled();

      // Opening it is what marks the chat as watched. That open ASKS (nothing
      // is stored yet), so the prewarm's own ask is the SECOND call — counted
      // rather than cleared, since the default double is not always a spy.
      await service.read('run-1');
      const afterOpen = vi.mocked(readContextUsage).mock.calls.length;

      settleTurn();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(vi.mocked(readContextUsage).mock.calls.length).toBeGreaterThan(
        afterOpen,
      );
    });

    it('files nothing when the agent answered neither question', async () => {
      // A row of nulls would be indistinguishable from a reading that was
      // taken and found the window empty — and it would OVERWRITE a good
      // earlier one with an empty one.
      const { farewell, remembered } = build({
        breakdown: null,
        liveSession: { ask: () => Promise.resolve(null) },
      });

      await farewell();

      expect(remembered).not.toHaveBeenCalled();
    });
  });

  it('says the same when the CLI reads from a PROCESS and the session id is all that is left', async () => {
    // The reported "wrong popup without data", reproduced from the author's own
    // daemon log: claude reads both figures from the running process, that
    // process was reaped as unused at 13:18:49, and the readout opened at
    // 13:37:07 — with no warning in between, because nothing had been asked.
    // A recorded session id is no channel here, and treating "either channel
    // exists" as "there was something to ask" made this chat report that the
    // agent "did not answer in time … the reading is taken again while this
    // stays open" — a promise nothing could keep.
    const { service, readContextUsage } = build({
      breakdownReading: { kind: 'reads', channel: 'live-process' },
      agentSessionId: 'sess-1',
    });

    const metrics = await service.read('run-1');

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).toContain('send a message');
    expect(metrics.breakdownReason).not.toContain('did not answer');
  });

  it('does NOT tell the user to send a message when the agent was there and stayed silent', async () => {
    // The reported shape: an agent mid-turn whose context request did not come
    // back. "Send a message to take a fresh reading" is the cure for the case
    // above and a red herring here — the channel exists, so looking again is
    // what produces a reading, and a message costs the user a turn for nothing.
    const { service, readContextUsage } = build({
      breakdown: null,
      liveSession: { ask: () => Promise.resolve(null) },
    });

    const metrics = await service.read('run-1');

    expect(readContextUsage).toHaveBeenCalled();
    expect(metrics.context).toBeNull();
    expect(metrics.breakdownReason).not.toContain('send a message');
    expect(metrics.breakdownReason).toContain('did not answer');
  });

  it('LOGS a plan-limits ask that came back empty, which the ask itself never reports', async () => {
    // `CliSession.ask` resolves null on its deadline, so without this line a
    // panel stuck on an older allowance left nothing anywhere to say why.
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const { service } = build({
        planReading: { kind: 'reads', channel: 'live-process' },
        liveSession: {},
        readPlanLimits: () => Promise.resolve(null),
      });

      await service.read('run-1');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'plan limits for run-1: the agent gave no answer',
        ),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('reads a THROWN live reading as silence, not as an absent agent', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      liveSession: { ask: () => Promise.reject(new Error('stdin gone')) },
    });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('did not answer');
  });

  it('answers the totals even when the breakdown could not be taken', async () => {
    // The two halves are independent: the spend is persisted history and is
    // always there, and losing it with the live reading would be the readout
    // going blank on every idle chat.
    const { service } = build({
      breakdown: null,
      payloads: [turn({ costUsd: 0.25, inputTokens: 10 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals).toMatchObject({ turns: 1, costUsd: 0.25 });
  });

  it('survives a live reading that threw, rather than failing the request', async () => {
    const { service } = build({
      readContextUsage: () => Promise.reject(new Error('stdin gone')),
      payloads: [turn({ costUsd: 1 })],
    });

    const metrics = await service.read('run-1');

    expect(metrics.context).toBeNull();
    expect(metrics.totals.costUsd).toBe(1);
  });

  it('sums every figure across the thread’s turns', async () => {
    const { service } = build({
      payloads: [
        turn({
          costUsd: 0.2,
          inputTokens: 2,
          outputTokens: 16,
          cacheReadTokens: 100,
          cacheCreationTokens: 20,
          thinkingTokens: 4,
          durationMs: 2531,
        }),
        turn({
          costUsd: 0.3,
          inputTokens: 3,
          outputTokens: 24,
          cacheReadTokens: 900,
          cacheCreationTokens: 80,
          thinkingTokens: 6,
          durationMs: 1000,
        }),
      ],
    });

    expect((await service.read('run-1')).totals).toEqual({
      turns: 2,
      costedTurns: 2,
      costUsd: 0.5,
      estimatedCostUsd: null,
      inputTokens: 5,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheCreationTokens: 100,
      thinkingTokens: 10,
      workedMs: 3531,
    });
  });

  it('leaves a figure NO turn reported null rather than zero', async () => {
    // A chat on a CLI that reports no usage must read as "not measured", never
    // as "cost nothing" — the two are indistinguishable once seeded at 0.
    const { service } = build({
      payloads: [turn({ inputTokens: 5 })],
    });

    const { totals } = await service.read('run-1');

    expect(totals.inputTokens).toBe(5);
    expect(totals.costUsd).toBeNull();
    expect(totals.thinkingTokens).toBeNull();
    expect(totals.workedMs).toBeNull();
  });

  it('counts only the turns that actually reported usage', async () => {
    const { service } = build({
      payloads: [turn({ costUsd: 1 }), turn(null), 'not json at all'],
    });

    expect((await service.read('run-1')).totals).toMatchObject({
      turns: 1,
      costUsd: 1,
    });
  });

  it('refuses a run that does not exist', () => {
    const { service } = build({ runExists: false });

    return expect(service.read('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('says a run naming no single agent has no one window to report', async () => {
    const { service, readContextUsage } = build({ agentKind: null });

    const metrics = await service.read('run-1');

    expect(metrics.breakdownReason).toContain('no single agent');
    expect(readContextUsage).not.toHaveBeenCalled();
  });
});

describe('ChatMetricsService.readTotals', () => {
  it('sums the thread WITHOUT asking the agent — the whole reason it is a second route', async () => {
    // The header carries this figure on every thread the user opens, so it must
    // not cost the CLI round trip `read` pays for the breakdown (measured at
    // 1.2–3.3s). A `readTotals` that fell back to `read` would put that latency
    // on switching chats, and nothing about the answer would look wrong.
    const { service, readContextUsage } = build({
      payloads: [
        turn({ costUsd: 0.25, inputTokens: 10 }),
        turn({ costUsd: 0.5, inputTokens: 4 }),
      ],
    });

    const totals = await service.readTotals('run-1');

    expect(totals.costUsd).toBeCloseTo(0.75, 10);
    expect(totals.turns).toBe(2);
    expect(readContextUsage).not.toHaveBeenCalled();
  });

  it("adds the daemon's wall-clock measure of the turns a CLI timed nothing of to the CLI's own time", async () => {
    // A cursor turn reports no duration; without the ledger the header totals
    // only what the loaded page holds, and moves as the reader pages back.
    wallTurns.rows.clear();
    await wallTurns.record('run-1', [{ seq: 9, memberId: null, ms: 3_000 }]);
    await wallTurns.record('run-other', [
      { seq: 9, memberId: null, ms: 7_000 },
    ]);
    const { service } = build({
      payloads: [turn({ inputTokens: 1, durationMs: 2_000 })],
    });

    expect((await service.readTotals('run-1')).workedMs).toBe(5_000);
    wallTurns.rows.clear();
  });

  it('answers a thread nothing measured with null, never zero', async () => {
    // cursor-agent reports no cost unless its currency is USD, so `$0.00` in
    // the header would be the app inventing a figure the CLI declined to give.
    const { service } = build({ payloads: [turn({ inputTokens: 10 })] });

    expect((await service.readTotals('run-1')).costUsd).toBeNull();
  });

  it('ADDS a team’s polled cursor bill to its claude turns, rather than replacing them', async () => {
    // REPORTED in the real app: a Dev Team run whose claude agents spent $52.41
    // and whose cursor QA spent $7.29 showed $7.29 in the header — the cursor
    // bill overwrote the run's whole cost.
    const { service } = build({
      team: {
        rows: [
          {
            memberId: 'manager',
            payload: turn({ costUsd: 50, inputTokens: 1 }),
          },
          { memberId: 'qa', payload: turn({ costUsd: 9, inputTokens: 1 }) },
        ],
        states: [
          { memberId: 'manager', agentKind: AgentKind.Claude },
          { memberId: 'qa', agentKind: AgentKind.CursorAgent },
        ],
        runPolledCents: 729,
      },
    });

    const totals = await service.readTotals('run-1');

    // The cursor member's own turn cost is left out, so a CLI that starts
    // reporting a price cannot be counted twice beside the polled bill.
    expect(totals.costUsd).toBeCloseTo(57.29, 10);
    expect(totals.turns).toBe(2);
  });

  it('judges a team turn by the pool member that ran it, not by its member’s stamp', async () => {
    // A claude member's call that ran on its cursor pool member is billed through the
    // polled bill, so its own figure is left out; a cursor member's call that
    // ran on its claude member priced itself, so its figure counts.
    const { service } = build({
      team: {
        rows: [
          {
            memberId: 'manager',
            payload: turn({ costUsd: 50, inputTokens: 1 }),
          },
          {
            memberId: 'manager',
            payload: JSON.stringify({
              ...JSON.parse(turn({ costUsd: 9, inputTokens: 1 })),
              agentKind: AgentKind.CursorAgent,
            }),
          },
          {
            memberId: 'qa',
            payload: JSON.stringify({
              ...JSON.parse(turn({ costUsd: 3, inputTokens: 1 })),
              agentKind: AgentKind.Claude,
            }),
          },
        ],
        states: [
          { memberId: 'manager', agentKind: AgentKind.Claude },
          { memberId: 'qa', agentKind: AgentKind.CursorAgent },
        ],
        runPolledCents: 729,
      },
    });

    const totals = await service.readTotals('run-1');

    expect(totals.costUsd).toBeCloseTo(60.29, 10);
    expect(totals.turns).toBe(3);
  });

  it('404s on a run that does not exist, rather than answering an empty sum', async () => {
    // An empty total is what a real, unused thread looks like — so a missing
    // run answering `turns: 0` would render as a genuine reading of nothing.
    const { service } = build({ runExists: false });

    await expect(service.readTotals('nope')).rejects.toThrow(/not found/);
  });
});

describe('ChatMetricsService.readTotalsResponse', () => {
  it('reads no working stretches for a chat, whose header draws its own clock', async () => {
    // The route runs on every thread open and every turn settle, and folding
    // the stretches reads every status and turn row of the run — for a figure
    // only a TEAM header draws.
    const { service, turnSpanRows } = build({
      payloads: [turn({ costUsd: 1 })],
    });

    const response = await service.readTotalsResponse('run-1');

    expect(response.activeSpans).toEqual([]);
    expect(response.totals.costUsd).toBe(1);
    expect(turnSpanRows).not.toHaveBeenCalled();
  });

  it('reads them for a team run', async () => {
    const { service, turnSpanRows } = build({
      team: { rows: [], states: [] },
    });

    await service.readTotalsResponse('run-1');

    // Every kind a stretch is folded from, cards and background units
    // included: a kind left out puts a wait back on the working clock.
    expect(turnSpanRows).toHaveBeenCalledWith(
      'run-1',
      [
        'status',
        'turn_complete',
        'approval_request',
        'approval_verdict',
        'unanswerable',
        'shell_open',
        'shell_info',
        'subagent_info',
      ],
      'fresh',
    );
  });

  it('sends a wait still open as an open-ended paused stretch', async () => {
    // JSON has no Infinity; dropped or nulled-out by accident, the live clock
    // would tick through the question it should be standing still on.
    const { service, turnSpanRows } = build({
      team: { rows: [], states: [] },
    });
    const at = (s: number): Date => new Date(Date.UTC(2026, 9, 13, 10, 0, s));
    turnSpanRows.mockResolvedValue([
      {
        kind: 'status',
        memberId: 'engineer',
        createdAt: at(0),
        payload: JSON.stringify({ status: 'running' }),
      },
      {
        kind: 'approval_request',
        memberId: 'engineer',
        createdAt: at(20),
        payload: JSON.stringify({ id: 'q1' }),
      },
    ]);

    const response = await service.readTotalsResponse('run-1');

    expect(response.pausedSpans).toEqual([
      { startMs: at(20).getTime(), endMs: null },
    ]);
    expect(JSON.parse(JSON.stringify(response)).pausedSpans).toEqual(
      response.pausedSpans,
    );
  });

  it('404s on a run that does not exist', async () => {
    const { service } = build({ runExists: false });

    await expect(service.readTotalsResponse('nope')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('ChatMetricsService — plan limits are the ACCOUNT’s', () => {
  // REPORTED as "на каждом трэде я вижу разные лимиты по подписке" — two
  // threads on one account a minute apart reading 45% and 96% for the same
  // window. Each thread asked its OWN process, and one of them answered with
  // claude's seeded estimate rather than the usage service's figure.
  const reading = (percent: number, estimated: boolean): PlanLimitsWire => ({
    plan: 'team',
    windows: [
      { key: 'session', label: 'Current session', percent, resetsAt: null },
    ],
    estimated,
  });

  it('shows the real reading another chat took over this chat’s own estimate', async () => {
    const readPlanLimits = vi
      .fn()
      .mockResolvedValueOnce(reading(96, false))
      .mockResolvedValueOnce(reading(45, true));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      liveSession: {},
      readPlanLimits,
    });

    const first = await service.read('run-1');
    const second = await service.read('run-2');

    expect(first.plan?.windows[0]?.percent).toBe(96);
    expect(readPlanLimits).toHaveBeenCalledTimes(2);
    expect(second.plan?.windows[0]?.percent).toBe(96);
    expect(second.plan?.estimated).toBe(false);
    // Dated, since it is not this chat's answer from just now.
    expect(second.planTakenAt).toBe(first.planTakenAt);
  });

  it('serves a pressed refresh the agent’s newer estimate over a real reading under five minutes old', async () => {
    // REPORTED as a refresh press that left the panel on "Updated 3m ago": the
    // agent answered with its estimate, and the held real reading outranked
    // it. Ordinary reads keep that ranking (the test above); a press is the
    // user asking for now.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T12:49:07Z'));
      const readPlanLimits = vi
        .fn()
        .mockResolvedValueOnce(reading(9, false))
        .mockResolvedValueOnce(reading(12, true));
      const { service } = build({
        planReading: { kind: 'reads', channel: 'live-process' },
        liveSession: {},
        readPlanLimits,
      });
      await service.read('run-1');

      vi.setSystemTime(new Date('2026-10-19T12:52:07Z'));
      const pressed = await service.read('run-1', null, null, true);

      expect(readPlanLimits).toHaveBeenCalledTimes(2);
      expect(pressed.plan?.windows[0]?.percent).toBe(12);
      expect(pressed.plan?.estimated).toBe(true);
      expect(pressed.planTakenAt).toBe('2026-10-19T12:52:07.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never lets a press put this chat’s STORED reading over a newer one, when the agent gave no answer', async () => {
    // Only the agent's own answer from just now earns the press's preference.
    // The stored reading offered in its place is older than what the account
    // already holds, and serving it would roll every chat on it back.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-19T12:49:00Z'));
      const readPlanLimits = vi
        .fn()
        .mockResolvedValueOnce(reading(70, false))
        .mockResolvedValueOnce(null);
      const { service } = build({
        planReading: { kind: 'reads', channel: 'live-process' },
        liveSession: {},
        readPlanLimits,
        // Taken three minutes before run-2's answer — too old to be served
        // in place of a live ask, still offered when the ask comes back empty.
        lastMetricsReading: JSON.stringify({
          takenAt: '2026-10-19T12:46:00.000Z',
          atSeq: 7,
          configDir: null,
          context: BREAKDOWN,
          plan: reading(100, false),
        }),
      });
      await service.read('run-2');

      vi.setSystemTime(new Date('2026-10-19T12:50:00Z'));
      const pressed = await service.read('run-1', null, null, true);

      expect(readPlanLimits).toHaveBeenCalledTimes(2);
      expect(pressed.plan?.windows[0]?.percent).toBe(70);
      expect(pressed.planTakenAt).toBe('2026-10-19T12:49:00.000Z');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the real reading over the turn-end prewarm’s estimate — the prewarm is no press', async () => {
    const readPlanLimits = vi
      .fn()
      .mockResolvedValueOnce(reading(81, false))
      .mockResolvedValueOnce(reading(40, true));
    const { service, farewell } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits,
    });

    await service.read('run-1');
    await farewell();
    const other = await service.read('run-2');

    expect(readPlanLimits).toHaveBeenCalledTimes(2);
    expect(other.plan?.windows[0]?.percent).toBe(81);
    expect(other.plan?.estimated).toBe(false);
  });

  it('gives a chat whose agent is closed the account’s reading from another chat', async () => {
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      // Only run-1 holds a process; run-2's was reaped.
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits: () => Promise.resolve(reading(70, false)),
    });

    await service.read('run-1');
    const closed = await service.read('run-2');

    expect(closed.plan?.windows[0]?.percent).toBe(70);
    expect(closed.planReason).toBeNull();
    expect(closed.planTakenAt).not.toBeNull();
  });

  it('asks another running agent on the same account when this conversation’s own process was evicted', async () => {
    const otherProcess = { id: 'other-conversation' };
    const readPlanLimits = vi
      .fn<(input: { live: unknown }) => Promise<PlanLimitsWire | null>>()
      .mockResolvedValue(reading(64, false));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      liveSessions: [
        {
          key: 'run-9::call:call-3',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: null,
          session: otherProcess,
        },
      ],
      readPlanLimits,
    });

    const evicted = await service.read('run-1');

    expect(readPlanLimits).toHaveBeenCalledTimes(1);
    expect(readPlanLimits.mock.calls[0]?.[0].live).toBe(otherProcess);
    expect(evicted.plan?.windows[0]?.percent).toBe(64);
    expect(evicted.planReason).toBeNull();
  });

  it('asks the context breakdown only of the conversation’s own process, never of another one on its account', async () => {
    const readContextUsage = vi.fn().mockResolvedValue(BREAKDOWN);
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      breakdownReading: { kind: 'reads', channel: 'live-process' },
      readContextUsage,
      peek: () => null,
      liveSessions: [
        {
          key: 'run-9::call:call-3',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: null,
          session: {},
        },
      ],
      readPlanLimits: () => Promise.resolve(reading(64, false)),
    });

    const evicted = await service.read('run-1');

    expect(readContextUsage).not.toHaveBeenCalled();
    expect(evicted.context).toBeNull();
    expect(evicted.plan?.windows[0]?.percent).toBe(64);
  });

  it('never asks a running agent on another account for this conversation’s limits', async () => {
    const readPlanLimits = vi.fn().mockResolvedValue(reading(64, false));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      liveSessions: [
        {
          key: 'run-9::call:call-3',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: '/Users/x/.claude-work',
          session: {},
        },
      ],
      readPlanLimits,
    });

    const evicted = await service.read('run-1');

    expect(readPlanLimits).not.toHaveBeenCalled();
    expect(evicted.plan).toBeNull();
  });

  it('never asks a default-profile agent in a PINNED folder for an unpinned conversation’s limits', async () => {
    const readPlanLimits = vi.fn().mockResolvedValue(reading(64, false));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      pinFor: (runId) => (runId === 'run-9' ? '/Users/x/.claude-team' : null),
      liveSessions: [
        {
          key: 'run-9',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: null,
          session: {},
        },
      ],
      readPlanLimits,
    });

    const evicted = await service.read('run-1');

    expect(readPlanLimits).not.toHaveBeenCalled();
    expect(evicted.plan).toBeNull();
  });

  it('asks an agent in a pinned folder for a conversation on the pinned profile', async () => {
    const pinned = { id: 'pinned-folder' };
    const readPlanLimits = vi
      .fn<(input: { live: unknown }) => Promise<PlanLimitsWire | null>>()
      .mockResolvedValue(reading(64, false));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      pinFor: (runId) => (runId === 'run-9' ? '/Users/x/.claude-team' : null),
      configDirFor: (runId) =>
        runId === 'run-1' ? '/Users/x/.claude-team' : null,
      liveSessions: [
        {
          key: 'run-9',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: null,
          session: pinned,
        },
      ],
      readPlanLimits,
    });

    const evicted = await service.read('run-1');

    expect(readPlanLimits.mock.calls[0]?.[0].live).toBe(pinned);
    expect(evicted.plan?.windows[0]?.percent).toBe(64);
  });

  it('passes over other CLIs and other accounts, and prefers an idle agent on the account to a busy one', async () => {
    const busy = { idle: false };
    const idle = { idle: true };
    const readPlanLimits = vi
      .fn<(input: { live: unknown }) => Promise<PlanLimitsWire | null>>()
      .mockResolvedValue(reading(64, false));
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      liveSessions: [
        {
          key: 'run-5',
          agent: AgentKind.CursorAgent,
          cwd: '/proj/run-5',
          configDir: null,
          session: { idle: true },
        },
        {
          key: 'run-6',
          agent: AgentKind.Claude,
          cwd: '/proj/run-6',
          configDir: '/Users/x/.claude-work',
          session: { idle: true },
        },
        {
          key: 'run-7',
          agent: AgentKind.Claude,
          cwd: '/proj/run-7',
          configDir: null,
          session: busy,
        },
        {
          key: 'run-8',
          agent: AgentKind.Claude,
          cwd: '/proj/run-8',
          configDir: null,
          session: idle,
        },
      ],
      readPlanLimits,
    });

    await service.read('run-1');

    expect(readPlanLimits).toHaveBeenCalledTimes(1);
    expect(readPlanLimits.mock.calls[0]?.[0].live).toBe(idle);
  });

  it('keeps the stored context breakdown when another agent answers only the plan', async () => {
    const { service, remembered } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      breakdownReading: { kind: 'reads', channel: 'live-process' },
      peek: () => null,
      lastMetricsReading: JSON.stringify({
        takenAt: '2026-11-13T08:00:00.000Z',
        atSeq: 7,
        configDir: null,
        context: BREAKDOWN,
        plan: null,
      }),
      liveSessions: [
        {
          key: 'run-9::call:call-3',
          agent: AgentKind.Claude,
          cwd: '/proj/run-9',
          configDir: null,
          session: {},
        },
      ],
      readPlanLimits: () => Promise.resolve(reading(64, false)),
    });

    const evicted = await service.read('run-1');

    expect(evicted.context).toEqual(BREAKDOWN);
    expect(remembered).toHaveBeenCalledTimes(1);
    const filed = JSON.parse(String(remembered.mock.calls[0]?.[1])) as {
      context: unknown;
      plan: PlanLimitsWire | null;
    };
    expect(filed.context).toEqual(BREAKDOWN);
    expect(filed.plan?.windows[0]?.percent).toBe(64);
  });

  it('keeps accounts apart — another profile’s reading is not this chat’s', async () => {
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits: () => Promise.resolve(reading(70, false)),
      configDirFor: (runId) =>
        runId === 'run-1' ? '/Users/x/.claude-work' : null,
    });

    await service.read('run-1');
    // run-2 is on the default profile and its process is gone: the work
    // account's figures must not appear on it.
    const metrics = await service.read('run-2');
    expect(metrics.plan).toBeNull();
  });

  it('shares a reading the turn-end prewarm took', async () => {
    const readPlanLimits = vi.fn().mockResolvedValue(reading(81, false));
    const { service, farewell } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits,
    });

    await farewell();
    const other = await service.read('run-2');

    expect(other.plan?.windows[0]?.percent).toBe(81);
  });

  it('files a PINNED folder’s readings under the pinned account, not the run’s own profile', async () => {
    // A folder's `.claude/settings.local.json` can set `env.CLAUDE_CONFIG_DIR`,
    // and the CLI then runs the turn on THAT account whatever geniro exported
    // (`readClaudeConfigDirPin`). run-1 is a default-profile chat in such a
    // folder; run-2 is an ordinary default-profile chat elsewhere whose agent
    // is closed. Keyed by `run.configDir` both would be "the default profile",
    // and run-2 would show the pinned team account's allowance.
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits: () => Promise.resolve(reading(100, false)),
      pinFor: (runId) => (runId === 'run-1' ? '/Users/x/.claude-team' : null),
    });

    await service.read('run-1');
    const unpinned = await service.read('run-2');

    expect(unpinned.plan).toBeNull();
  });

  it('shares a pinned folder’s reading with a chat explicitly on that profile', async () => {
    const { service } = build({
      planReading: { kind: 'reads', channel: 'live-process' },
      peek: (key) => (key === 'run-1' ? {} : null),
      readPlanLimits: () => Promise.resolve(reading(100, false)),
      pinFor: (runId) => (runId === 'run-1' ? '/Users/x/.claude-team' : null),
      configDirFor: (runId) =>
        runId === 'run-2' ? '/Users/x/.claude-team' : null,
    });

    await service.read('run-1');
    const sameAccount = await service.read('run-2');

    expect(sameAccount.plan?.windows[0]?.percent).toBe(100);
  });

  describe('a refresh with no live agent on the account', () => {
    type PlanInput = {
      live: unknown;
      configDir: string | null;
      mayProbe?: boolean;
    };
    const ONE_SHOT: UsageReading = {
      kind: 'reads',
      channel: 'live-process',
      oneShot: true,
    };

    it('takes the reading from a one-shot process and dates it now', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date('2026-11-16T05:42:00Z'));
        const readPlanLimits = vi
          .fn<(input: PlanInput) => Promise<PlanLimitsWire | null>>()
          .mockResolvedValue(reading(41, false));
        const { service } = build({
          planReading: ONE_SHOT,
          peek: () => null,
          readPlanLimits,
          lastMetricsReading: JSON.stringify({
            takenAt: '2026-11-16T04:07:13.121Z',
            atSeq: 7,
            configDir: null,
            context: BREAKDOWN,
            plan: reading(63, false),
          }),
        });

        const pressed = await service.read('run-1', null, null, true);

        expect(readPlanLimits).toHaveBeenCalledTimes(1);
        expect(readPlanLimits.mock.calls[0]?.[0]).toMatchObject({
          live: null,
          configDir: null,
          mayProbe: true,
        });
        expect(pressed.plan?.windows[0]?.percent).toBe(41);
        expect(pressed.planTakenAt).toBe('2026-11-16T05:42:00.000Z');
        expect(pressed.planReason).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('shares one one-shot process between refreshes that overlap on an account', async () => {
      let answer: (reading: PlanLimitsWire) => void = () => undefined;
      const readPlanLimits = vi
        .fn<(input: PlanInput) => Promise<PlanLimitsWire | null>>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              answer = resolve;
            }),
        )
        .mockResolvedValue(reading(52, false));
      const { service } = build({
        planReading: ONE_SHOT,
        peek: () => null,
        readPlanLimits,
      });

      const first = service.read('run-1', null, null, true);
      const second = service.read('run-2', null, null, true);
      await vi.waitFor(() => expect(readPlanLimits).toHaveBeenCalledTimes(1));
      answer(reading(41, false));
      const [a, b] = await Promise.all([first, second]);
      const later = await service.read('run-1', null, null, true);

      expect(a.plan?.windows[0]?.percent).toBe(41);
      expect(b.plan?.windows[0]?.percent).toBe(41);
      expect(readPlanLimits).toHaveBeenCalledTimes(2);
      expect(later.plan?.windows[0]?.percent).toBe(52);
    });

    it('runs the one-shot process under the folder’s pinned profile', async () => {
      const readPlanLimits = vi
        .fn<(input: PlanInput) => Promise<PlanLimitsWire | null>>()
        .mockResolvedValue(reading(41, false));
      const { service } = build({
        planReading: ONE_SHOT,
        peek: () => null,
        pinFor: (runId) => (runId === 'run-1' ? '/Users/x/.claude-team' : null),
        readPlanLimits,
      });

      await service.read('run-1', null, null, true);

      expect(readPlanLimits.mock.calls[0]?.[0].configDir).toBe(
        '/Users/x/.claude-team',
      );
    });

    it('asks a live agent on the account rather than spawning one', async () => {
      const otherProcess = { id: 'other-conversation' };
      const readPlanLimits = vi
        .fn<(input: PlanInput) => Promise<PlanLimitsWire | null>>()
        .mockResolvedValue(reading(64, false));
      const { service } = build({
        planReading: ONE_SHOT,
        peek: () => null,
        liveSessions: [
          {
            key: 'run-9',
            agent: AgentKind.Claude,
            cwd: '/proj/run-9',
            configDir: null,
            session: otherProcess,
          },
        ],
        readPlanLimits,
      });

      await service.read('run-1', null, null, true);

      expect(readPlanLimits).toHaveBeenCalledTimes(1);
      expect(readPlanLimits.mock.calls[0]?.[0].live).toBe(otherProcess);
      expect(readPlanLimits.mock.calls[0]?.[0].mayProbe).toBeUndefined();
    });

    it('spawns nothing on the idle farewell', async () => {
      const readPlanLimits = vi.fn().mockResolvedValue(reading(41, false));
      const { farewell } = build({
        planReading: ONE_SHOT,
        peek: () => null,
        lastMetricsReading: null,
        readPlanLimits,
      });

      await farewell();

      expect(readPlanLimits).not.toHaveBeenCalled();
    });

    it('spawns nothing on an ordinary open', async () => {
      const readPlanLimits = vi.fn().mockResolvedValue(reading(41, false));
      const { service } = build({
        planReading: ONE_SHOT,
        peek: () => null,
        readPlanLimits,
      });

      await service.read('run-1');

      expect(readPlanLimits).not.toHaveBeenCalled();
    });

    it('spawns nothing for a CLI whose reading offers no one-shot process', async () => {
      const readPlanLimits = vi.fn().mockResolvedValue(reading(41, false));
      const { service } = build({
        planReading: { kind: 'reads', channel: 'live-process' },
        peek: () => null,
        readPlanLimits,
      });

      await service.read('run-1', null, null, true);

      expect(readPlanLimits).not.toHaveBeenCalled();
    });

    it('logs an empty one-shot answer and keeps the held reading', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      try {
        const { service } = build({
          planReading: ONE_SHOT,
          peek: () => null,
          readPlanLimits: () => Promise.resolve(null),
          lastMetricsReading: JSON.stringify({
            takenAt: '2026-11-16T04:07:13.121Z',
            atSeq: 7,
            configDir: null,
            context: BREAKDOWN,
            plan: reading(63, false),
          }),
        });

        const pressed = await service.read('run-1', null, null, true);

        expect(pressed.plan?.windows[0]?.percent).toBe(63);
        expect(pressed.planTakenAt).toBe('2026-11-16T04:07:13.121Z');
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            'plan limits for run-1: the agent gave no answer',
          ),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });
});
