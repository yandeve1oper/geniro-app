import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind, RunStatus } from '../../runs/runs.types';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import type { MonitorOwner, MonitorSnapshot } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { writeDelegateSpend } from '../utils/delegate-spend';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ApprovalRegistry } from './approval-registry';
import type { ChatShellsService } from './chat-shells.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import type { MonitorRegistry } from './monitor.registry';
import { RunHoldRegistry } from './run-hold.registry';
import type { RunKindRowsCache } from './run-kind-rows.cache';
import { RunStateService } from './run-state.service';

/**
 * Real-driver spec, on `item.dao.spec.ts`'s pattern: the reads here filter on
 * `json_extract`, which only a real SQLite can say is right.
 */
describe('RunStateService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let approvals: ApprovalRegistry;
  let holds: RunHoldRegistry;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    items = new ItemDao(orm.em.fork());
    runs = new RunDao(orm.em.fork());
    approvals = new ApprovalRegistry();
    holds = new RunHoldRegistry();
    seqs = new ItemSeqAllocator(orm.em, items);
  });

  /** The allocator the read asks how far the run is written. */
  let seqs: ItemSeqAllocator;

  /** What the read asked `RunKindRowsCache` for. */
  let cacheReads: { kinds: string[]; atLeast: number | 'fresh' | undefined }[] =
    [];

  function service(running: MonitorSnapshot[] = []): RunStateService {
    const shells = {
      read: () => Promise.resolve({ shells: [] }),
    } as unknown as ChatShellsService;
    // Two CLIs, as a team mixes them: one names its launches, one does not.
    const adapters = {
      all: () =>
        new Map([
          [
            'claude',
            {
              getConfig: () => ({
                subagents: { launchToolNames: ['Task', 'Agent'] },
                artifactToolNames: ['Artifact'],
              }),
            },
          ],
          [
            'cursor-agent',
            {
              getConfig: () => ({
                subagents: { launchToolNames: [] },
                artifactToolNames: [],
              }),
            },
          ],
        ]),
    } as unknown as AgentAdapterRegistry;
    return new RunStateService(
      orm.em,
      runs,
      items,
      approvals,
      shells,
      adapters,
      seqs,
      {
        list: (runId: string) =>
          running.filter((monitor) => monitor.owner.runId === runId),
      } as unknown as MonitorRegistry,
      recordingCache(),
      holds,
    );
  }

  function recordingCache(): RunKindRowsCache {
    cacheReads = [];
    const cache = kindRowsPassthrough(items);
    const rowsOf = cache.rowsOf.bind(cache);
    cache.rowsOf = (runId, kinds, atLeast) => {
      cacheReads.push({ kinds: [...kinds], atLeast });
      return rowsOf(runId, kinds, atLeast);
    };
    return cache;
  }

  async function createRun(
    status: RunStatus,
    teamId: string | null = null,
  ): Promise<void> {
    await runs.create({ id: 'run-a', status, teamId });
  }

  async function insert(
    seq: number,
    kind: ItemKind,
    payload: unknown,
    extra: {
      memberId?: string | null;
      role?: string;
      at?: number;
      inCall?: string;
    } = {},
  ): Promise<void> {
    await items.create({
      runId: 'run-a',
      seq,
      kind,
      memberId: extra.memberId ?? null,
      role: extra.role ?? null,
      ...(extra.inCall === undefined ? {} : { inCall: extra.inCall }),
      payload: JSON.stringify(payload),
      ...(extra.at === undefined ? {} : { createdAt: new Date(extra.at) }),
    });
  }

  describe('what a client takes over the page it holds', () => {
    const seqsOf = (rows: readonly { seq: number }[]): number[] =>
      rows.map((row) => row.seq);

    it("states how far through the run it read — the run's newest seq", async () => {
      await createRun('running');
      await insert(1, 'message', { text: 'hi' }, { role: 'user' });
      await insert(7, 'message', { text: 'ok' }, { role: 'assistant' });

      expect((await service().read('run-a')).throughSeq).toBe(7);
    });

    it("lists a chat's open turn's unanswered commands — never an answered one, one before the turn, or a delegate's", async () => {
      await createRun('running');
      await insert(1, 'tool_call', { id: 'old', name: 'Bash' });
      await insert(2, 'turn_complete', {});
      await insert(3, 'message', { text: 'again' }, { role: 'user' });
      await insert(4, 'tool_call', { id: 'done', name: 'Bash' });
      await insert(5, 'tool_result', { id: 'done' });
      await insert(6, 'tool_call', { id: 'running', name: 'Bash' });
      await insert(7, 'tool_call', {
        id: 'delegate',
        name: 'Bash',
        parentToolUseId: 'task-1',
      });

      expect(seqsOf((await service().read('run-a')).openToolCalls)).toEqual([
        6,
      ]);
    });

    it('lists none for a chat whose turn ended', async () => {
      await createRun('completed');
      await insert(1, 'tool_call', { id: 'cut', name: 'Bash' });
      await insert(2, 'turn_complete', {});

      expect((await service().read('run-a')).openToolCalls).toEqual([]);
    });

    it('lists the commands of every conversation whose newest status says running — a callee carrying on after its call included', async () => {
      await createRun('running', 'dev-team');
      const status = (
        seq: number,
        memberId: string,
        inCall: string,
        value: string,
      ): Promise<void> =>
        insert(seq, 'status', { status: value }, { memberId, inCall });
      const call = (
        seq: number,
        id: string,
        memberId: string,
        inCall: string,
      ): Promise<void> =>
        insert(seq, 'tool_call', { id, name: 'Bash' }, { memberId, inCall });
      await status(1, 'manager', '', 'running');
      await call(2, 'own', 'manager', '');
      await status(3, 'engineer', 'call-1', 'running');
      await call(4, 'callee', 'engineer', 'call-1');
      // Settled, then carrying on by itself under the same call.
      await status(5, 'engineer', 'call-2', 'completed');
      await status(6, 'engineer', 'call-2', 'running');
      await call(7, 'carrying-on', 'engineer', 'call-2');
      // A conversation whose turn is over.
      await status(8, 'qa', '', 'running');
      await call(9, 'idle', 'qa', '');
      await status(10, 'qa', '', 'completed');

      expect(seqsOf((await service().read('run-a')).openToolCalls)).toEqual([
        2, 4, 7,
      ]);
    });

    it('lists a cancelled chat’s off-turn commands — its turn is open from its last ending on', async () => {
      await createRun('cancelled');
      await insert(1, 'turn_cancelled', {});
      await insert(2, 'tool_call', { id: 'off-turn', name: 'Bash' });

      expect(seqsOf((await service().read('run-a')).openToolCalls)).toEqual([
        2,
      ]);
    });
  });

  it('answers a run that does not exist with a 404', async () => {
    await expect(service().read('nope')).rejects.toThrow(/not found/);
  });

  it("lists every conversation's running monitors, a chat's with no member", async () => {
    await createRun('completed');
    const monitor = (
      id: string,
      owner: Partial<MonitorOwner>,
    ): MonitorSnapshot => ({
      id,
      description: `watch ${id}`,
      command: `gh pr checks ${id} --watch`,
      startedAt: '2026-10-27T10:00:00.000Z',
      endsAt: '2026-10-27T10:10:00.000Z',
      timeoutMs: 600_000,
      events: 0,
      pid: 4242,
      owner: {
        runId: 'run-a',
        memberId: 'chat',
        caller: 'chat',
        conversationId: null,
        callId: null,
        target: 'chat',
        ...owner,
      },
    });
    const state = await service([
      monitor('m1', {}),
      monitor('m2', {
        memberId: 'reviewer',
        callId: 'call-3',
        target: 'team',
      }),
      monitor('m1', { runId: 'run-b' }),
    ]).read('run-a');
    expect(state.monitors).toEqual([
      {
        id: 'm1',
        description: 'watch m1',
        command: 'gh pr checks m1 --watch',
        memberId: null,
        callId: null,
        startedAt: '2026-10-27T10:00:00.000Z',
        endsAt: '2026-10-27T10:10:00.000Z',
      },
      {
        id: 'm2',
        description: 'watch m2',
        command: 'gh pr checks m2 --watch',
        memberId: 'reviewer',
        callId: 'call-3',
        startedAt: '2026-10-27T10:00:00.000Z',
        endsAt: '2026-10-27T10:10:00.000Z',
      },
    ]);
  });

  it('returns the cards the registry still holds, as the rows they were persisted as', async () => {
    await createRun('running');
    await insert(1, 'approval_request', { id: 'req-old', toolName: 'Bash' });
    await insert(2, 'approval_request', { id: 'req-open', toolName: 'Bash' });
    approvals.track({
      runId: 'run-a',
      memberId: 'agent',
      requestId: 'req-open',
      toolName: 'Bash',
      input: {},
      question: false,
      respond: vi.fn(() => true),
    });

    const state = await service().read('run-a');

    expect(state.openRequests.map((row) => row.seq)).toEqual([2]);
  });

  it('lists every call with its standing, over the whole run', async () => {
    await createRun('running', 'dev-team');
    await insert(1, 'call_started', { callId: 'call-1', calleeNodeId: 'qa' });
    await insert(2, 'call_started', { callId: 'call-2', calleeNodeId: 'qa' });
    await insert(3, 'call_result', { callId: 'call-1', status: 'ok' });

    const state = await service().read('run-a');

    expect(state.calls.map((call) => [call.callId, call.status])).toEqual([
      ['call-1', 'completed'],
      ['call-2', 'running'],
    ]);
  });

  it('reads calls, delegate declarations and workflow announcements incrementally, never short of the seq it reports', async () => {
    await createRun('running', 'dev-team');
    await insert(1, 'call_started', { callId: 'call-1', calleeNodeId: 'qa' });

    const state = await service().read('run-a');

    expect(cacheReads).toEqual(
      expect.arrayContaining([
        { kinds: ['call_started', 'call_result'], atLeast: state.throughSeq },
        { kinds: ['subagent_info'], atLeast: state.throughSeq },
        { kinds: ['workflow_info'], atLeast: state.throughSeq },
      ]),
    );
  });

  it('says which calls still wait under the run’s active-turn cap, until their turn begins', async () => {
    // Over the whole run: a call queued above the client's page has no card
    // there, and this is the only place it can read "queued" from.
    await createRun('running', 'dev-team');
    await insert(1, 'call_started', { callId: 'call-1', calleeNodeId: 'qa' });
    await insert(2, 'call_started', { callId: 'call-2', calleeNodeId: 'qa' });
    await insert(3, 'call_started', { callId: 'call-3', calleeNodeId: 'qa' });
    for (const [seq, callId] of [
      [4, 'call-1'],
      [5, 'call-2'],
      [6, 'call-3'],
    ] as const) {
      await insert(
        seq,
        'system',
        { callId, severity: 'info', queuedCall: { cap: 1 } },
        { memberId: 'qa', inCall: callId },
      );
    }
    // call-1 started; call-3 was cancelled while it waited.
    await insert(
      7,
      'status',
      { nodeId: 'qa', status: 'running', callId: 'call-1' },
      { memberId: 'qa', inCall: 'call-1' },
    );
    await insert(8, 'call_result', { callId: 'call-3', status: 'error' });

    const state = await service().read('run-a');

    expect(
      state.calls.map((call) => [call.callId, call.status, call.queued]),
    ).toEqual([
      ['call-1', 'running', false],
      ['call-2', 'running', true],
      ['call-3', 'failed', false],
    ]);
  });

  it('counts each delegate’s tool calls over every row of the run', async () => {
    // However few of them a client has loaded: the sub-agent card draws this.
    await createRun('running');
    await insert(1, 'tool_call', {
      id: 'toolu_a',
      name: 'Task',
      input: { description: 'Review bugs' },
    });
    await insert(2, 'tool_call', { id: 'toolu_b', name: 'Task', input: {} });
    for (const seq of [3, 4, 5]) {
      await insert(seq, 'tool_call', {
        id: `a-${seq}`,
        name: 'Read',
        parentToolUseId: 'toolu_a',
      });
    }
    await insert(6, 'tool_call', {
      id: 'b-6',
      name: 'Bash',
      parentToolUseId: 'toolu_b',
    });
    // The launching agent's own call, and one naming no delegate.
    await insert(7, 'tool_call', { id: 'own', name: 'Bash' });
    await insert(8, 'tool_call', {
      id: 'blank',
      name: 'Bash',
      parentToolUseId: '',
    });
    // The delegate's other rows are not tool calls.
    await insert(9, 'tool_result', { id: 'a-3', parentToolUseId: 'toolu_a' });
    await insert(10, 'message', {
      text: 'found it',
      parentToolUseId: 'toolu_a',
    });
    // A seq reserved and not yet written stops the read short, so a tool call
    // written above it is the client's to add, never the count's.
    const reserved = await seqs.reserve('run-a');
    await insert(reserved + 1, 'tool_call', {
      id: 'late',
      name: 'Read',
      parentToolUseId: 'toolu_a',
    });

    const state = await service().read('run-a');

    expect(state.throughSeq).toBe(reserved - 1);

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.toolCalls]),
    ).toEqual([
      ['toolu_a', 3],
      ['toolu_b', 1],
    ]);
  });

  it('carries each delegate’s messages, requests, token split, context and cost from the run’s figures, cumulative', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    await insert(
      2,
      'message',
      { text: 'one', parentToolUseId: 'toolu_a' },
      { role: 'assistant' },
    );
    await insert(
      3,
      'reasoning',
      { text: 'thinking', parentToolUseId: 'toolu_a' },
      { role: 'assistant' },
    );
    await insert(
      4,
      'message',
      { text: 'asked', parentToolUseId: 'toolu_a' },
      { role: 'user' },
    );
    await insert(
      5,
      'message',
      { text: 'two', parentToolUseId: 'toolu_a' },
      { role: 'assistant' },
    );
    await runs.setDelegateSpend(
      'run-a',
      writeDelegateSpend(
        new Map([
          [
            'toolu_a',
            {
              requests: 3,
              inputTokens: 1200,
              outputTokens: 340,
              cacheReadTokens: 9000,
              cacheCreationTokens: 500,
              contextTokens: 9800,
              model: 'claude-haiku-5-5',
              costUsd: 0.5,
              estimatedCostUsd: 0.25,
            },
          ],
        ]),
      ),
    );

    const delegate = (await service().read('run-a')).delegates[0]!;

    expect(delegate).toMatchObject({
      id: 'toolu_a',
      messages: 2,
      requests: 3,
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
      cacheCreationTokens: 500,
      contextTokens: 9800,
      costUsd: 0.5,
      estimatedCostUsd: 0.25,
      cumulative: true,
    });
  });

  it('counts the replies its transcript holds when the rows hold fewer — a foreground delegate’s final reply is no row', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    await runs.setDelegateSpend(
      'run-a',
      writeDelegateSpend(
        new Map([
          [
            'toolu_a',
            {
              requests: 2,
              inputTokens: 4,
              outputTokens: 165,
              cacheReadTokens: 35_605,
              cacheCreationTokens: 39_793,
              contextTokens: 39_883,
              model: 'claude-haiku-5-5',
              costUsd: null,
              estimatedCostUsd: 0.08,
              messages: 1,
            },
          ],
        ]),
      ),
    );

    const delegate = (await service().read('run-a')).delegates[0]!;

    expect(delegate.messages).toBe(1);
  });

  it('reads a delegate the run holds no figures for as not measured, its messages still counted', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    await insert(
      2,
      'message',
      { text: 'one', parentToolUseId: 'toolu_a' },
      { role: 'assistant' },
    );

    const delegate = (await service().read('run-a')).delegates[0]!;

    expect(delegate).toMatchObject({
      id: 'toolu_a',
      messages: 1,
      requests: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      contextTokens: null,
      costUsd: null,
      estimatedCostUsd: null,
      cumulative: false,
    });
  });

  it('lists delegates launched by name AND by declaration, each with its launch reply', async () => {
    await createRun('running');
    await insert(1, 'tool_call', {
      id: 'toolu_a',
      name: 'Task',
      input: { description: 'Review bugs' },
    });
    await insert(2, 'tool_call', { id: 'toolu_b', name: 'Bash', input: {} });
    await insert(3, 'subagent_info', {
      id: 'cursor-1',
      label: 'Review PR',
      backgroundOpen: true,
    });
    await insert(4, 'tool_result', { id: 'toolu_a', result: 'done' });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_a', 'completed'],
      ['cursor-1', 'running'],
    ]);
  });

  it('does not list another CLI’s command row titled `task` as a delegate', async () => {
    // The names are pooled over every adapter; matched case-blind, a cursor
    // `execute` row running go-task would be counted as claude's `Task`.
    await createRun('running');
    await insert(1, 'tool_call', { id: 'exec-1', name: 'task', input: {} });
    await insert(2, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    // An artifact name, by contrast, is read ignoring case on both sides.
    await insert(3, 'tool_call', { id: 'art-1', name: 'ARTIFACT', input: {} });

    const state = await service().read('run-a');

    expect(state.delegates.map((delegate) => delegate.id)).toEqual(['toolu_a']);
    expect(
      state.artifactRows.map((row) => (row.payload as { id?: string }).id),
    ).toEqual(['art-1']);
  });

  it('reads an unanswered delegate as cancelled once the user’s Stop ended its launching turn, but not a backgrounded one', async () => {
    // The run is working again — a later turn — so the run's own status says
    // nothing about a sync delegate the user's Stop cut off.
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_sync', name: 'Task', input: {} });
    await insert(2, 'tool_call', { id: 'toolu_bg', name: 'Task', input: {} });
    await insert(3, 'subagent_info', { id: 'toolu_bg', backgroundOpen: true });
    await insert(4, 'turn_cancelled', {});
    await insert(5, 'message', { text: 'next' }, { role: 'user' });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_sync', 'cancelled'],
      ['toolu_bg', 'running'],
    ]);
  });

  const recoverable = async (seq: number, id: string): Promise<void> => {
    await insert(seq, 'tool_call', { id, name: 'Task', input: {} });
    await insert(seq + 1, 'subagent_info', {
      id,
      recovery: {
        agentKind: 'claude',
        sessionId: 's',
        cwd: '/project',
        configDir: null,
        toolCallId: id,
        launchedAtMs: 1,
        childSessionId: null,
      },
    });
  };

  it('reads a recoverable delegate as untracked when its launching turn finished without its report', async () => {
    await createRun('running');
    await recoverable(1, 'toolu_a');
    await insert(3, 'turn_complete', {});

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'untracked',
    );
  });

  it('reads a recoverable delegate by its OWN turn’s ending once the chat settled again', async () => {
    // A chat settles after every turn, so its status says only what the
    // latest turn did.
    await createRun('cancelled');
    await recoverable(1, 'toolu_done');
    await insert(3, 'turn_complete', {});
    await insert(4, 'message', { text: 'next' }, { role: 'user' });
    await recoverable(5, 'toolu_stopped');
    await insert(7, 'turn_cancelled', {});

    expect(
      (await service().read('run-a')).delegates.map((d) => [d.id, d.status]),
    ).toEqual([
      // Its turn finished without its report; a later Stop ended nothing of it.
      ['toolu_done', 'untracked'],
      ['toolu_stopped', 'cancelled'],
    ]);
  });

  it('keeps a Stop-cut recoverable delegate cancelled after a later turn completes', async () => {
    await createRun('completed');
    await recoverable(1, 'toolu_a');
    await insert(3, 'turn_cancelled', {});
    await insert(4, 'message', { text: 'go on' }, { role: 'user' });
    await insert(5, 'turn_complete', {});

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'cancelled',
    );
  });

  it('ends a delegate only on ITS parent turn’s ending — same member, same call, a real end', async () => {
    await createRun('running', 'dev-team');
    const qa = { memberId: 'qa' };
    await insert(
      1,
      'tool_call',
      { id: 'toolu_a', name: 'Task', input: {}, callId: 'call-3' },
      qa,
    );
    // Not its turn: another member, another call, and a continuation that
    // finished inside the turn.
    await insert(2, 'turn_complete', {}, { memberId: 'manager' });
    await insert(3, 'turn_complete', { callId: 'call-9' }, qa);
    await insert(
      4,
      'turn_complete',
      { callId: 'call-3', insideTurn: true },
      qa,
    );

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'running',
    );

    await insert(5, 'turn_cancelled', { callId: 'call-3' }, qa);

    expect((await service().read('run-a')).delegates[0]!.status).toBe(
      'cancelled',
    );
  });

  it('ends only the delegates launched BEFORE a turn ended — a later turn’s keeps working', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_a', name: 'Task', input: {} });
    await insert(2, 'turn_cancelled', {});
    await insert(3, 'message', { text: 'again' }, { role: 'user' });
    await insert(4, 'tool_call', { id: 'toolu_b', name: 'Task', input: {} });

    const state = await service().read('run-a');

    expect(
      state.delegates.map((delegate) => [delegate.id, delegate.status]),
    ).toEqual([
      ['toolu_a', 'cancelled'],
      ['toolu_b', 'running'],
    ]);
  });

  it('keeps delegates, artifacts and workflows apart in one pass over the tool rows', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'toolu_d', name: 'Task', input: {} });
    await insert(2, 'tool_call', { id: 'art-1', name: 'Artifact', input: {} });
    await insert(3, 'tool_call', { id: 'wf-1', name: 'Workflow' });
    await insert(4, 'workflow_info', { id: 'wf-1', title: 'Audit' });
    await insert(5, 'tool_result', { id: 'toolu_d', result: 'done' });
    await insert(6, 'tool_result', { id: 'art-1', result: 'https://x' });
    await insert(7, 'tool_result', { id: 'wf-1', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.delegates.map((delegate) => delegate.id)).toEqual(['toolu_d']);
    expect(state.artifactRows.map((row) => row.seq)).toEqual([2, 6]);
    expect(state.workflowRows.map((row) => row.seq)).toEqual([3, 4, 7]);
  });

  it("returns a dynamic workflow's launch, its reply and its first and newest announcement", async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'wf-1', name: 'Workflow' });
    await insert(2, 'workflow_info', { id: 'wf-1', title: 'Audit' });
    await insert(3, 'workflow_info', { id: 'wf-1', agents: [] });
    await insert(4, 'workflow_info', { id: 'wf-1', agents: [{}] });
    await insert(5, 'tool_result', { id: 'wf-1', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.workflowRows.map((row) => row.seq)).toEqual([1, 2, 4, 5]);
  });

  it('returns artifact publishes and their replies, and nothing else', async () => {
    await createRun('running');
    await insert(1, 'tool_call', { id: 'art-1', name: 'Artifact', input: {} });
    await insert(2, 'tool_call', { id: 'other', name: 'Write', input: {} });
    await insert(3, 'tool_result', { id: 'art-1', result: 'https://x' });
    await insert(4, 'tool_result', { id: 'other', result: 'ok' });

    const state = await service().read('run-a');

    expect(state.artifactRows.map((row) => row.seq)).toEqual([1, 3]);
  });

  it("dates a running chat's turn from its FIRST user message since the last turn ended", async () => {
    await createRun('running');
    await insert(1, 'message', { text: 'old' }, { role: 'user', at: 1000 });
    await insert(2, 'turn_complete', {}, { at: 2000 });
    await insert(3, 'message', { text: 'now' }, { role: 'user', at: 3000 });
    // A follow-up delivered into the running turn joins it.
    await insert(4, 'message', { text: 'and' }, { role: 'user', at: 4000 });

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(3000).toISOString());
  });

  it('keeps the turn open across a continuation that finished INSIDE it', async () => {
    // An `insideTurn` completion ended nothing; the renderer's turn scan
    // measures the open turn from it when it carries the CLI's own figure.
    await createRun('running');
    await insert(1, 'message', { text: 'go' }, { role: 'user', at: 1000 });
    await insert(
      2,
      'turn_complete',
      { insideTurn: true, usage: { durationMs: 900 } },
      { at: 5000 },
    );

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(5000).toISOString());
  });

  it('keeps the user message as the start when the inside continuation reported no figure', async () => {
    await createRun('running');
    await insert(1, 'message', { text: 'go' }, { role: 'user', at: 1000 });
    await insert(2, 'turn_complete', { insideTurn: true }, { at: 5000 });

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(1000).toISOString());
  });

  it("serves the holds of a running chat's open turn", async () => {
    await createRun('running');
    holds.hold('run-a', 2, 1_000);
    holds.hold('run-a', 0, 4_000);
    holds.hold('run-a', 1, 9_000);

    const state = await service().read('run-a');

    expect(state.turnHeldMs).toBe(3_000);
    expect(state.turnHeldSince).toBe(new Date(9_000).toISOString());
  });

  it('dates a stretch the agent runs by itself from when it woke, ahead of its rows', async () => {
    await createRun('running');
    await insert(1, 'message', { text: 'go' }, { role: 'user', at: 1000 });
    await insert(2, 'turn_complete', {}, { at: 2000 });
    await insert(
      3,
      'message',
      { text: 'back' },
      { role: 'assistant', at: 9000 },
    );
    holds.startStretch('run-a', 4_000);

    const state = await service().read('run-a');

    expect(state.turnStartedAt).toBe(new Date(4_000).toISOString());
  });

  it('serves no holds for a settled chat', async () => {
    await createRun('completed');
    holds.hold('run-a', 1, 1_000);

    const state = await service().read('run-a');

    expect(state.turnHeldMs).toBe(0);
    expect(state.turnHeldSince).toBeNull();
  });

  it('dates no turn for a settled chat', async () => {
    await createRun('completed');
    await insert(1, 'message', { text: 'q' }, { role: 'user', at: 1000 });
    expect((await service().read('run-a')).turnStartedAt).toBeNull();
  });

  it('dates no turn for a running TEAM run — its turns are its members’', async () => {
    await createRun('running', 'dev-team');
    await insert(1, 'message', { text: 'q' }, { role: 'user', at: 1000 });
    expect((await service().read('run-a')).turnStartedAt).toBeNull();
  });
});
