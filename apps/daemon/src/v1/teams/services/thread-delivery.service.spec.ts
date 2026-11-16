import { ConflictException, NotFoundException } from '@packages/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  HostRowWire,
  HostWake,
  HostWakeOwner,
  RunStatusEvent,
  ThreadListFilter,
} from '../../agents/chat.types';
import type { ItemDao } from '../../agents/dao/item.dao';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ApprovalRegistry } from '../../agents/services/approval-registry';
import type { ChatService } from '../../agents/services/chat.service';
import type { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import type { ProcessRegistry } from '../../agents/services/process-registry';
import type { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { THREAD_WAKE_PROMPT } from '../../agents/utils/thread-message-text';
import type { ProjectDao } from '../../projects/dao/project.dao';
import type { Run } from '../../runs/entity/run.entity';
import type {
  TeamExecutorService,
  ThreadMessageJoin,
} from './team-executor.service';
import { ThreadDeliveryService } from './thread-delivery.service';

const rows = vi.hoisted(() => ({
  written: [] as {
    runId: string;
    memberId: string | null;
    payload: HostRowWire;
  }[],
}));

vi.mock('../../agents/utils/persist-item', () => ({
  persistItemAndEmit: async (
    _deps: unknown,
    _em: unknown,
    row: { runId: string; memberId: string | null; payload: HostRowWire },
  ) => {
    rows.written.push(row);
  },
}));

const SENDER = 'sender';
const TARGET = 'target';

const from: HostWakeOwner = {
  target: 'chat',
  runId: SENDER,
  memberId: 'agent',
  conversationId: null,
  caller: 'agent',
};

interface Row {
  id: string;
  fromRunId: string;
  fromTitle: string;
  fromMember: string | null;
  text: string;
  wake: boolean;
  wokeAt: Date | null;
  wakes: number;
  reason: string | null;
  status: 'waiting' | 'delivered' | 'cancelled';
  deliveryId: string | null;
}

function runOf(extra: Partial<Run> = {}): Run {
  return {
    id: TARGET,
    title: 'Target',
    status: 'completed',
    teamId: null,
    agentKind: 'claude',
    archivedAt: null,
    projectId: null,
    cwd: '/tmp',
    createdAt: new Date(0),
    updatedAt: new Date(0),
    editsTeamSlug: null,
    editsProjectId: null,
    analysisSourceRunId: null,
    analysisTeamSlug: null,
    promptCacheExpiresAt: null,
    promptCacheTtlMs: null,
    contextTokens: null,
    contextWindowTokens: null,
    ...extra,
  } as Run;
}

function harness(
  target: Partial<Run> = {},
  opts: {
    interrupts?: boolean;
    running?: boolean;
    wakes?: number;
    joins?: number;
  } = {},
) {
  const runs = new Map<string, Run>([
    [TARGET, runOf(target)],
    [SENDER, runOf({ id: SENDER, title: 'Sender' })],
  ]);
  const messages: Row[] = [];
  let nextId = 0;
  const inbox = {
    accept: vi.fn(async (draft: { text: string; wake: boolean }) => {
      const row: Row = {
        id: `m${(nextId += 1)}`,
        fromRunId: SENDER,
        fromTitle: 'Sender',
        fromMember: null,
        text: draft.text,
        wake: draft.wake,
        wokeAt: null,
        wakes: 0,
        reason: null,
        status: 'waiting',
        deliveryId: null,
      };
      messages.push(row);
      return row;
    }),
    listOwed: vi.fn(async () =>
      messages.filter(
        (row) =>
          row.status === 'waiting' &&
          row.wake &&
          (row.reason === null ||
            row.reason === 'running_turn' ||
            row.reason === 'question'),
      ),
    ),
    owedRunIds: vi.fn(async () =>
      messages.some((row) => row.status === 'waiting') ? [TARGET] : [],
    ),
    markDelivered: vi.fn(
      async (_run: string, ids: string[], deliveryId: string | null) => {
        for (const row of messages) {
          if (ids.includes(row.id)) {
            row.status = 'delivered';
            row.deliveryId = deliveryId;
          }
        }
      },
    ),
    returnDropped: vi.fn(async (ids: string[]) => {
      const back = messages.filter(
        (row) => row.deliveryId !== null && ids.includes(row.deliveryId),
      );
      for (const row of back) {
        row.status = 'waiting';
        row.deliveryId = null;
        row.reason = 'running_turn';
      }
      return {
        deliveryIds: ids.filter(() => back.length > 0),
        titles: back.map((row) => row.fromTitle),
      };
    }),
    setReason: vi.fn(
      async (_run: string, ids: string[], reason: string | null) => {
        for (const row of messages) {
          if (ids.includes(row.id)) {
            row.reason = reason;
          }
        }
      },
    ),
    markWoken: vi.fn(async (_run: string, { id }: { id: string }) => {
      const row = messages.find((message) => message.id === id);
      if (row) {
        row.wokeAt = new Date();
        row.wakes += 1;
      }
    }),
    requestWake: vi.fn(async (_run: string, messageId: string) => {
      const row = messages.find(
        (message) => message.id === messageId && message.status === 'waiting',
      );
      if (row === undefined) {
        throw new NotFoundException('THREAD_MESSAGE_NOT_FOUND', 'gone');
      }
      row.wake = true;
      return row;
    }),
    wakesInLastHour: vi.fn(async () => opts.wakes ?? 0),
    joinsInLastHour: vi.fn(async () => opts.joins ?? 0),
  };
  const chats = {
    sendMessage: vi.fn(async () => ({})),
    awaitsCardAnswer: vi.fn(() => false),
  };
  const approvals = {
    awaitingFor: vi.fn((): 'question' | 'approval' | null => null),
  };
  let turnEnded: (runId: string, caller: string) => void = () => undefined;
  const executor = {
    joinThreadMessage: vi.fn(
      async (_run: string, _join: ThreadMessageJoin) =>
        'idle' as 'joined' | 'busy' | 'idle' | 'question' | 'over_budget',
    ),
    wakeLeadForThreadMessage: vi.fn(
      async () => 'woken' as 'woken' | 'busy' | 'refused',
    ),
    threadLeadCaller: vi.fn(async () => 'lead'),
    memberNameOf: vi.fn(async () => 'Lead'),
    leadCacheFacts: vi.fn(async () => null),
    onConversationTurnEnded: (
      listener: (runId: string, caller: string) => void,
    ) => {
      turnEnded = listener;
      return () => undefined;
    },
  };
  const listThreads = vi.fn(async (filter: ThreadListFilter) => ({
    runs: [...runs.values()]
      .filter((run) => run.id !== filter.excludeRunId)
      .map((run) => ({
        run,
        lastActivityAt: run.id === TARGET ? new Date(5_000) : null,
        lastUserMessageAt: null,
      })),
    next: filter.limit < runs.size - 1 ? { rank: 1, sortAt: 7, id: 'x' } : null,
  }));
  const published: HostWake[] = [];
  const statuses = new Subject<RunStatusEvent>();
  const service = new ThreadDeliveryService(
    { fork: () => ({}) } as never,
    {
      getById: async (id: string) => runs.get(id) ?? null,
      listThreads,
    } as unknown as RunDao,
    {
      listAll: async () => [{ id: 'p1', name: 'One' }],
    } as unknown as ProjectDao,
    inbox as unknown as ThreadInboxService,
    chats as unknown as ChatService,
    approvals as unknown as ApprovalRegistry,
    executor as unknown as TeamExecutorService,
    { has: () => opts.running === true } as unknown as ProcessRegistry,
    {
      all: () =>
        new Map([
          [
            'claude',
            {
              getConfig: () => ({
                followUp: {
                  unavailableReason: null,
                  interrupts: opts.interrupts === true,
                },
              }),
            },
          ],
        ]),
    } as unknown as AgentAdapterRegistry,
    {
      publish: (wake: HostWake) => {
        published.push(wake);
      },
    } as unknown as HostWakeBus,
    { allStatuses: () => statuses.asObservable() } as unknown as AgentEventBus,
    {} as ItemDao,
    {} as ItemCallIndexService,
    { reserve: async () => 1 } as unknown as ItemSeqAllocator,
  );
  service.onModuleInit();
  return {
    service,
    runs,
    listThreads,
    messages,
    inbox,
    chats,
    approvals,
    executor,
    published,
    settle: async (status: RunStatusEvent['status'], runId = TARGET) => {
      statuses.next({ runId, status } as RunStatusEvent);
      await new Promise((resolve) => setImmediate(resolve));
    },
    endTurn: async (caller: string) => {
      turnEnded(TARGET, caller);
      await new Promise((resolve) => setImmediate(resolve));
    },
    send: (wake = true, text = 'hello') =>
      service.send({ from, toRunId: TARGET, text, wake }),
  };
}

function sentRow(): HostRowWire['threadMessageSent'] {
  return rows.written.find((row) => row.runId === SENDER)?.payload
    .threadMessageSent;
}

beforeEach(() => {
  rows.written.length = 0;
});

describe('ThreadDeliveryService: an idle chat', () => {
  it('opens a turn on a fixed sentence and leaves the text to the turn’s drain', async () => {
    const h = harness();

    const answer = await h.send();

    expect(answer).toEqual({ outcome: 'woken', title: 'Target' });
    expect(h.published).toHaveLength(1);
    const wake = h.published[0]!;
    expect(wake.prompt).toBe(THREAD_WAKE_PROMPT);
    expect(wake.prompt).not.toContain('hello');
    expect(wake.note).toBeNull();
    expect(wake.row.threadWake).toEqual({
      fromRunId: SENDER,
      fromTitle: 'Sender',
    });
    expect(h.messages[0]).toMatchObject({ status: 'waiting', reason: null });
    expect(h.messages[0]!.wokeAt).not.toBeNull();
    expect(sentRow()).toEqual({
      toRunId: TARGET,
      title: 'Target',
      outcome: 'woken',
      reason: null,
    });
  });

  it.each([
    ['the sender opted out', {}, {}, false, 'sender_opted_out'],
    [
      'the thread was woken six times this hour',
      {},
      { wakes: 6 },
      true,
      'wake_limit',
    ],
    [
      'the thread is cold and large',
      {
        promptCacheExpiresAt: new Date(Date.now() - 60_000),
        promptCacheTtlMs: 300_000,
        contextTokens: 900_000,
        contextWindowTokens: 1_000_000,
      },
      {},
      true,
      'cold_and_large',
    ],
    ['the user stopped it', { status: 'cancelled' }, {}, true, 'stopped'],
    ['its last turn failed', { status: 'failed' }, {}, true, 'failed'],
    ['it never started', { status: 'pending' }, {}, true, 'not_started'],
  ] as const)(
    'starts nothing when %s, and says why',
    async (_label, target, opts, wake, reason) => {
      const h = harness(target as Partial<Run>, opts);

      const answer = await h.send(wake);

      expect(answer).toEqual({ outcome: 'waiting', reason, title: 'Target' });
      expect(h.published).toEqual([]);
      expect(h.messages[0]!.reason).toBe(reason);
      expect(sentRow()).toMatchObject({ outcome: 'waiting', reason });
    },
  );

  it('starts nothing past a question waiting for the user', async () => {
    const h = harness();
    h.chats.awaitsCardAnswer.mockReturnValue(true);

    await expect(h.send()).resolves.toMatchObject({ reason: 'question' });
    expect(h.published).toEqual([]);
  });

  it('allows the sixth wake of an hour', async () => {
    const h = harness({}, { wakes: 5 });

    await expect(h.send()).resolves.toMatchObject({ outcome: 'woken' });
  });

  it('never wakes for a message the inbox refused', async () => {
    const h = harness();
    h.inbox.accept.mockRejectedValue(new Error('REFUSED'));

    await expect(h.send()).rejects.toThrow('REFUSED');
    expect(h.published).toEqual([]);
    expect(sentRow()).toBeUndefined();
  });
});

describe('ThreadDeliveryService: the user’s Deliver now', () => {
  const sentQuietly = async (h: ReturnType<typeof harness>) => {
    await h.send(false);
    h.published.length = 0;
    return h.messages[0]!;
  };

  it('opens a turn for a message its sender sent without waking the thread', async () => {
    const h = harness();
    const message = await sentQuietly(h);
    expect(message.reason).toBe('sender_opted_out');

    const answer = await h.service.deliverNow(TARGET, message.id);

    expect(answer).toEqual({ outcome: 'woken', reason: null });
    expect(h.published).toHaveLength(1);
    expect(h.published[0]!.prompt).toBe(THREAD_WAKE_PROMPT);
    expect(message).toMatchObject({ wake: true, reason: null });
    expect(message.wokeAt).not.toBeNull();
  });

  it.each([
    ['six wakes this hour', {}, { wakes: 6 }],
    [
      'a cold large thread',
      {
        promptCacheExpiresAt: new Date(Date.now() - 60_000),
        promptCacheTtlMs: 300_000,
        contextTokens: 900_000,
        contextWindowTokens: 1_000_000,
      },
      {},
    ],
  ] as const)(
    'is not held back by %s, which only limit an agent’s wake',
    async (_label, target, opts) => {
      const h = harness(target as Partial<Run>, opts);
      const message = await sentQuietly(h);

      await expect(h.service.deliverNow(TARGET, message.id)).resolves.toEqual({
        outcome: 'woken',
        reason: null,
      });
      expect(h.published).toHaveLength(1);
    },
  );

  it.each([
    ['stopped', { status: 'cancelled' }],
    ['failed', { status: 'failed' }],
    ['not_started', { status: 'pending' }],
  ] as const)(
    'starts nothing on a thread that is %s, and says why',
    async (reason, target) => {
      const h = harness(target as Partial<Run>);
      const message = await sentQuietly(h);

      await expect(h.service.deliverNow(TARGET, message.id)).resolves.toEqual({
        outcome: 'waiting',
        reason,
      });
      expect(h.published).toEqual([]);
      expect(message.reason).toBe(reason);
    },
  );

  it('starts nothing past a question waiting for the user', async () => {
    const h = harness();
    const message = await sentQuietly(h);
    h.chats.awaitsCardAnswer.mockReturnValue(true);

    await expect(h.service.deliverNow(TARGET, message.id)).resolves.toEqual({
      outcome: 'waiting',
      reason: 'question',
    });
    expect(h.published).toEqual([]);
  });

  it('joins a running turn, past the hour’s budget of joins', async () => {
    const h = harness({ status: 'running' }, { running: true, joins: 30 });
    h.messages.push({
      id: 'quiet',
      fromRunId: SENDER,
      fromTitle: 'Sender',
      fromMember: null,
      text: 'hello',
      wake: false,
      wokeAt: null,
      wakes: 0,
      reason: 'sender_opted_out',
      status: 'waiting',
      deliveryId: null,
    });

    await expect(h.service.deliverNow(TARGET, 'quiet')).resolves.toEqual({
      outcome: 'joined',
      reason: null,
    });
    expect(h.chats.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.messages[0]!.status).toBe('delivered');
  });

  it('wakes a team’s idle lead', async () => {
    const h = harness({ teamId: 'team' });
    const message = await sentQuietly(h);

    await expect(h.service.deliverNow(TARGET, message.id)).resolves.toEqual({
      outcome: 'woken',
      reason: null,
    });
    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('refuses a message that no longer waits', async () => {
    const h = harness();
    const message = await sentQuietly(h);
    message.status = 'cancelled';

    await expect(
      h.service.deliverNow(TARGET, message.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(h.published).toEqual([]);
  });
});

describe('ThreadDeliveryService: the wake’s staleness', () => {
  it('holds while a message waits, and drops once none does or the thread may not start', async () => {
    const h = harness();
    await h.send();
    const wake = h.published[0]!;

    await expect(wake.stale?.()).resolves.toBe(false);

    h.runs.set(TARGET, runOf({ status: 'cancelled' }));
    await expect(wake.stale?.()).resolves.toBe(true);

    h.runs.set(TARGET, runOf({ status: 'failed' }));
    await expect(wake.stale?.()).resolves.toBe(true);

    h.runs.set(TARGET, runOf());
    h.messages[0]!.status = 'delivered';
    await expect(wake.stale?.()).resolves.toBe(true);
  });
});

describe('ThreadDeliveryService: a running chat', () => {
  it('joins the turn, with its row delivered before the send so a drop finds it', async () => {
    const h = harness({ status: 'running' }, { running: true });
    let statusAtSend: string | undefined;
    h.chats.sendMessage.mockImplementation(async () => {
      statusAtSend = h.messages[0]!.status;
      return {};
    });

    const answer = await h.send();

    expect(answer).toEqual({ outcome: 'joined', title: 'Target' });
    expect(statusAtSend).toBe('delivered');
    const [runId, prompt, images, options] = h.chats.sendMessage.mock
      .calls[0] as unknown as [
      string,
      string,
      unknown[],
      { joinOnly: boolean; hostRow: HostRowWire; deliveryId: string },
    ];
    expect(runId).toBe(TARGET);
    expect(images).toEqual([]);
    expect(prompt).toContain('hello');
    expect(options.joinOnly).toBe(true);
    expect(options.deliveryId).toBe(h.messages[0]!.deliveryId);
    expect(options.hostRow.threadMessages?.[0]?.text).toBe('hello');
    expect(h.published).toEqual([]);
  });

  it('joins even when the sender asked not to wake: a running turn wakes nobody', async () => {
    const h = harness({ status: 'running' }, { running: true });

    await expect(h.send(false)).resolves.toMatchObject({ outcome: 'joined' });
  });

  it('leaves it waiting on a CLI whose follow-up interrupts, then wakes when the turn ends', async () => {
    const h = harness(
      { status: 'running' },
      { running: true, interrupts: true },
    );

    const answer = await h.send();

    expect(answer).toMatchObject({
      outcome: 'waiting',
      reason: 'running_turn',
    });
    expect(h.chats.sendMessage).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);

    h.runs.set(TARGET, runOf({ status: 'completed' }));
    await h.settle('completed');

    expect(h.published).toHaveLength(1);
    expect(h.messages[0]!.reason).toBeNull();
  });

  it('takes the row back on RUN_BUSY', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.chats.sendMessage.mockRejectedValue(
      new ConflictException('RUN_BUSY', 'finishing'),
    );

    const answer = await h.send();

    expect(answer).toMatchObject({
      outcome: 'waiting',
      reason: 'running_turn',
    });
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      deliveryId: null,
    });
  });

  it('falls through to a wake when the turn ended under the join', async () => {
    const h = harness({ status: 'completed' }, { running: true });
    h.chats.sendMessage.mockRejectedValue(
      new ConflictException('RUN_NOT_RUNNING', 'no turn'),
    );

    await expect(h.send()).resolves.toMatchObject({ outcome: 'woken' });
    expect(h.published).toHaveLength(1);
  });
});

describe('ThreadDeliveryService: a turn parked on the user’s question', () => {
  it('sends nothing into it: the message waits with reason question', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('question');

    await expect(h.send()).resolves.toEqual({
      outcome: 'waiting',
      reason: 'question',
      title: 'Target',
    });

    expect(h.chats.sendMessage).not.toHaveBeenCalled();
    expect(h.inbox.markDelivered).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'question',
    });
  });

  it('ignores a card that stands across turns, as a team proposal does', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockImplementation(((
      _runId: string,
      ignore: (card: { standing: boolean }) => boolean,
    ) => (ignore({ standing: true }) ? null : 'question')) as never);

    await expect(h.send()).resolves.toMatchObject({ outcome: 'joined' });
  });

  it('wakes once the turn has ended with the question answered', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('question');
    await h.send();
    h.runs.set(TARGET, runOf({ status: 'completed' }));
    h.approvals.awaitingFor.mockReturnValue(null);

    await h.settle('completed');

    expect(h.published).toHaveLength(1);
    expect(h.messages[0]).toMatchObject({ status: 'waiting', reason: null });
  });

  it('starts nothing while the question still stands after a status', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('question');
    await h.send();
    h.runs.set(TARGET, runOf({ status: 'completed' }));

    await h.settle('completed');

    expect(h.published).toEqual([]);
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'question',
    });
  });

  it('says the sender opted out, not question, for a message that asked not to wake', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('question');

    await expect(h.send(false)).resolves.toMatchObject({
      outcome: 'waiting',
      reason: 'sender_opted_out',
    });
    h.runs.set(TARGET, runOf({ status: 'completed' }));
    h.approvals.awaitingFor.mockReturnValue(null);
    await h.settle('completed');

    expect(h.published).toEqual([]);
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'sender_opted_out',
    });
  });

  it('lists such a thread as needing the user, not as working', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('question');

    const rows = (await h.service.listThreads(SENDER, { limit: 20 })).threads;

    expect(rows.find((row) => row.thread === TARGET)?.status).toBe(
      'needs_user',
    );
  });

  it('leaves a team’s lead parked on its own question waiting too', async () => {
    const h = harness({ teamId: 'team-1', status: 'running' });
    h.approvals.awaitingFor.mockReturnValue('question');
    h.executor.joinThreadMessage.mockResolvedValue('question');

    await expect(h.send()).resolves.toMatchObject({
      outcome: 'waiting',
      reason: 'question',
    });
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      deliveryId: null,
    });
  });
});

describe('ThreadDeliveryService: a turn parked on a tool approval', () => {
  it('lists it as needing the user, and the message still joins', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockReturnValue('approval');

    const rows = (await h.service.listThreads(SENDER, { limit: 20 })).threads;

    expect(rows.find((row) => row.thread === TARGET)?.status).toBe(
      'needs_user',
    );
    await expect(h.send()).resolves.toMatchObject({ outcome: 'joined' });
    expect(h.chats.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('lists it as working again once the card is answered', async () => {
    const h = harness({ status: 'running' }, { running: true });

    const rows = (await h.service.listThreads(SENDER, { limit: 20 })).threads;

    expect(rows.find((row) => row.thread === TARGET)?.status).toBe('working');
  });

  it('does not count a card that stands across turns', async () => {
    const h = harness({ status: 'running' }, { running: true });
    h.approvals.awaitingFor.mockImplementation(((
      _runId: string,
      ignore: (card: { standing: boolean }) => boolean,
    ) => (ignore({ standing: true }) ? null : 'approval')) as never);

    const rows = (await h.service.listThreads(SENDER, { limit: 20 })).threads;

    expect(rows.find((row) => row.thread === TARGET)?.status).toBe('working');
  });
});

describe('ThreadDeliveryService: the budget of joins', () => {
  it('still joins the thirtieth message of the hour', async () => {
    const h = harness({ status: 'running' }, { running: true, joins: 29 });

    await expect(h.send()).resolves.toMatchObject({ outcome: 'joined' });
    expect(h.chats.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('leaves the thirty-first waiting with wake_limit, sends nothing into the turn and says so', async () => {
    const h = harness({ status: 'running' }, { running: true, joins: 30 });

    const answer = await h.send();

    expect(answer).toEqual({
      outcome: 'waiting',
      reason: 'wake_limit',
      title: 'Target',
    });
    expect(h.chats.sendMessage).not.toHaveBeenCalled();
    expect(h.inbox.markDelivered).not.toHaveBeenCalled();
    expect(h.published).toEqual([]);
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'wake_limit',
    });
    expect(sentRow()).toMatchObject({
      outcome: 'waiting',
      reason: 'wake_limit',
    });
  });

  it('wakes nobody when that turn ends, so a loop between two threads dies out', async () => {
    const h = harness({ status: 'running' }, { running: true, joins: 30 });
    await h.send();

    await h.settle('completed');

    expect(h.published).toEqual([]);
    expect(h.chats.sendMessage).not.toHaveBeenCalled();
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'wake_limit',
    });
  });

  it('counts only a join: an idle thread past the budget is still woken', async () => {
    const h = harness({}, { joins: 30 });

    await expect(h.send()).resolves.toMatchObject({ outcome: 'woken' });
    expect(h.published).toHaveLength(1);
  });

  it('counts only a join: a CLI whose follow-up interrupts still waits for the turn to end', async () => {
    const h = harness(
      { status: 'running' },
      { running: true, interrupts: true, joins: 30 },
    );

    await expect(h.send()).resolves.toMatchObject({
      outcome: 'waiting',
      reason: 'running_turn',
    });
  });

  it('tells a team’s executor, flips nothing, and leaves it waiting with wake_limit', async () => {
    const h = harness({ teamId: 'team', status: 'running' }, { joins: 30 });
    h.executor.joinThreadMessage.mockResolvedValue('over_budget');

    await expect(h.send()).resolves.toMatchObject({
      outcome: 'waiting',
      reason: 'wake_limit',
    });

    expect(h.executor.joinThreadMessage.mock.calls[0]![1].overBudget).toBe(
      true,
    );
    expect(h.inbox.markDelivered).not.toHaveBeenCalled();
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      reason: 'wake_limit',
    });
  });

  it('asks a team’s executor to join under the budget', async () => {
    const h = harness({ teamId: 'team', status: 'running' }, { joins: 29 });
    h.executor.joinThreadMessage.mockResolvedValue('joined');

    await expect(h.send()).resolves.toMatchObject({ outcome: 'joined' });
    expect(h.executor.joinThreadMessage.mock.calls[0]![1].overBudget).toBe(
      false,
    );
    expect(h.inbox.markDelivered).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadDeliveryService: a settling status', () => {
  it('stamps a stopped thread’s owed message and starts nothing', async () => {
    const h = harness(
      { status: 'running' },
      { running: true, interrupts: true },
    );
    await h.send();

    h.runs.set(TARGET, runOf({ status: 'cancelled' }));
    await h.settle('cancelled');

    expect(h.published).toEqual([]);
    expect(h.messages[0]!.reason).toBe('stopped');
  });

  it('counts no new wake for a message already woken, after a restart', async () => {
    const h = harness();
    await h.send();
    h.published.length = 0;
    h.inbox.markWoken.mockClear();

    await h.service.republishOwed();

    expect(h.published).toHaveLength(1);
    expect(h.inbox.markWoken).not.toHaveBeenCalled();
    expect(h.inbox.wakesInLastHour).toHaveBeenCalledTimes(1);
  });

  it('counts another wake for a message a finished turn left waiting, and stops at the limit', async () => {
    const h = harness();
    await h.send();
    h.published.length = 0;
    h.inbox.markWoken.mockClear();

    await h.settle('completed');

    expect(h.published).toHaveLength(1);
    expect(h.inbox.markWoken).toHaveBeenCalledTimes(1);

    h.published.length = 0;
    h.inbox.wakesInLastHour.mockResolvedValue(6);
    await h.settle('completed');

    expect(h.published).toEqual([]);
    expect(h.messages[0]!.reason).toBe('wake_limit');
  });

  it('holds a cold large thread back from a re-wake too', async () => {
    const h = harness();
    await h.send();
    h.published.length = 0;
    h.runs.set(
      TARGET,
      runOf({
        promptCacheExpiresAt: new Date(Date.now() - 60_000),
        promptCacheTtlMs: 300_000,
        contextTokens: 900_000,
        contextWindowTokens: 1_000_000,
      }),
    );

    await h.settle('completed');

    expect(h.published).toEqual([]);
    expect(h.messages[0]!.reason).toBe('cold_and_large');
  });

  it('ignores a run going live', async () => {
    const h = harness(
      { status: 'running' },
      { running: true, interrupts: true },
    );
    await h.send();

    await h.settle('running');

    expect(h.published).toEqual([]);
  });
});

describe('ThreadDeliveryService: a team', () => {
  const team = { teamId: 'team-1', status: 'running' } as const;

  it('joins the lead’s running turn', async () => {
    const h = harness(team);
    h.executor.joinThreadMessage.mockResolvedValue('joined');

    await expect(h.send()).resolves.toMatchObject({ outcome: 'joined' });
    expect(h.messages[0]!.status).toBe('delivered');
    expect(h.executor.wakeLeadForThreadMessage).not.toHaveBeenCalled();
  });

  it('waits for a lead that cannot take it now', async () => {
    const h = harness(team);
    h.executor.joinThreadMessage.mockResolvedValue('busy');

    await expect(h.send()).resolves.toMatchObject({
      outcome: 'waiting',
      reason: 'running_turn',
    });
    expect(h.messages[0]).toMatchObject({
      status: 'waiting',
      deliveryId: null,
    });
  });

  it('starts nothing while any member’s question waits for the user', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    h.approvals.awaitingFor.mockReturnValue('question');

    await expect(h.send()).resolves.toMatchObject({ reason: 'question' });
    expect(h.executor.wakeLeadForThreadMessage).not.toHaveBeenCalled();
  });

  it('is not held back by a permission card', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    h.approvals.awaitingFor.mockReturnValue('approval');

    await expect(h.send()).resolves.toMatchObject({ outcome: 'woken' });
  });

  it('asks the woken lead once: a second send before its turn ended joins that wake', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    await h.send();

    await expect(h.send(true, 'again')).resolves.toMatchObject({
      outcome: 'woken',
    });
    await h.settle('completed');
    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('starts nothing more when the woken lead’s turn ended with the message unread', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    await h.send();

    await h.endTurn('lead');

    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(1);
    expect(h.messages[0]!.reason).toBe('failed');
  });

  it('goes on to the rest when the woken turn read the message it was woken for', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    await h.send();
    h.messages[0]!.status = 'delivered';
    await h.send(true, 'past the turn’s budget');

    await h.endTurn('lead');

    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(2);
  });

  it('wakes again once a dropped wake came back', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    await h.send();
    const dropped = h.executor.wakeLeadForThreadMessage.mock
      .calls[0] as unknown as [string, string, HostRowWire, () => void];

    dropped[3]();
    await h.settle('completed');

    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(2);
  });

  it('leaves a wake refused during a Stop for the status to stamp', async () => {
    const h = harness({ teamId: 'team-1', status: 'running' });
    h.executor.wakeLeadForThreadMessage.mockResolvedValue('refused');

    await h.send();
    h.runs.set(TARGET, runOf({ teamId: 'team-1', status: 'cancelled' }));
    await h.settle('cancelled');

    expect(h.messages[0]!.reason).toBe('stopped');
  });

  it('wakes an idle lead on the fixed sentence', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });

    await expect(h.send()).resolves.toMatchObject({ outcome: 'woken' });
    const call = h.executor.wakeLeadForThreadMessage.mock
      .calls[0] as unknown as [string, string, HostRowWire];
    expect(call[1]).toBe(THREAD_WAKE_PROMPT);
    expect(call[2].threadWake?.fromTitle).toBe('Sender');
    expect(h.messages[0]!.wokeAt).not.toBeNull();
  });

  it('starts nothing on a stopped run', async () => {
    const h = harness({ teamId: 'team-1', status: 'cancelled' });

    await expect(h.send()).resolves.toMatchObject({ reason: 'stopped' });
    expect(h.executor.wakeLeadForThreadMessage).not.toHaveBeenCalled();
  });

  it('spends no wake when the lead was busy after all', async () => {
    const h = harness({ teamId: 'team-1', status: 'completed' });
    h.executor.wakeLeadForThreadMessage.mockResolvedValue('busy');

    await expect(h.send()).resolves.toMatchObject({ reason: 'running_turn' });
    expect(h.messages[0]!.wokeAt).toBeNull();
  });

  it('takes a dropped join back under one row, then wakes the lead', async () => {
    const h = harness(team);
    h.executor.joinThreadMessage.mockResolvedValue('joined');
    await h.send();
    const join = h.executor.joinThreadMessage.mock.calls[0]![1];
    rows.written.length = 0;
    h.runs.set(TARGET, runOf({ teamId: 'team-1', status: 'completed' }));

    join.onDropped();
    await new Promise((resolve) => setImmediate(resolve));

    expect(rows.written.filter((row) => row.runId === TARGET)).toHaveLength(1);
    expect(rows.written[0]?.payload.message).toContain('did not reach');
    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('releases on the lead’s turn end, never on another conversation’s', async () => {
    const h = harness(team);
    h.executor.joinThreadMessage.mockResolvedValue('busy');
    await h.send();

    await h.endTurn('someone-else');
    expect(h.executor.wakeLeadForThreadMessage).not.toHaveBeenCalled();

    await h.endTurn('lead');
    expect(h.executor.wakeLeadForThreadMessage).toHaveBeenCalledTimes(1);
  });

  it('names the sending member', async () => {
    const h = harness();

    await h.service.send({
      from: { ...from, target: 'team', memberId: 'lead' },
      toRunId: TARGET,
      text: 'hi',
      wake: true,
    });

    expect(h.inbox.accept).toHaveBeenCalledWith(
      expect.objectContaining({ fromMember: 'Lead' }),
    );
    expect(rows.written.find((row) => row.runId === SENDER)?.memberId).toBe(
      'lead',
    );
  });
});

describe('ThreadDeliveryService: who may reach whom', () => {
  it.each([
    ['a chat', {}, 'chat'],
    ['a team run', { teamId: 'team-1' }, 'team'],
    ['a builder chat', { editsTeamSlug: 'x' }, null],
    ['a project chat', { editsProjectId: 'p' }, null],
    ['a thread’s analysis', { analysisSourceRunId: 'r' }, null],
    ['a team’s analysis', { analysisTeamSlug: 'x' }, null],
  ] as const)('%s', async (_label, extra, expected) => {
    const h = harness(extra as Partial<Run>);

    await expect(h.service.senderTarget(TARGET)).resolves.toBe(expected);
  });

  it('lists other threads with a truthful status, asking the listing to rank the caller’s project and hide the caller', async () => {
    const h = harness({ status: 'failed', projectId: 'p2' });
    const caller = runOf({ id: SENDER, projectId: 'p1', title: 'Sender' });
    h.runs.set(SENDER, caller);
    h.runs.set(
      'same-project',
      runOf({
        id: 'same-project',
        title: 'Same',
        projectId: 'p1',
        status: 'running',
        archivedAt: new Date(9_000),
      }),
    );

    const listed = await h.service.listThreads(SENDER, { limit: 20 });

    expect(h.listThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        excludeRunId: SENDER,
        callerProjectId: 'p1',
        includeArchived: false,
        projectId: null,
        window: undefined,
        after: null,
        limit: 20,
      }),
      expect.anything(),
    );
    expect(listed.threads.map((row) => row.thread)).toEqual([
      TARGET,
      'same-project',
    ]);
    expect(listed.threads.map((row) => row.status)).toEqual([
      'failed',
      'working',
    ]);
    expect(listed.threads[1]).toMatchObject({
      project: 'One',
      archived: true,
      createdAt: new Date(0).toISOString(),
      lastActivityAt: null,
    });
    expect(listed.threads[0]?.lastActivityAt).toBe(
      new Date(5_000).toISOString(),
    );
    expect(listed.nextPage).toBeNull();
  });

  it('passes the window, the archive switch and a project named by its name or id', async () => {
    const h = harness();

    await h.service.listThreads(SENDER, {
      limit: 20,
      activeSince: '2026-11-16T00:00:00+03:00',
      activeUntil: '2026-11-17T00:00:00+03:00',
      includeArchived: true,
      project: ' one ',
    });
    await h.service.listThreads(SENDER, { limit: 20, project: 'p1' });

    expect(h.listThreads.mock.calls[0]?.[0]).toMatchObject({
      includeArchived: true,
      projectId: 'p1',
      window: {
        since: new Date('2026-11-15T21:00:00.000Z'),
        until: new Date('2026-11-16T21:00:00.000Z'),
      },
    });
    expect(h.listThreads.mock.calls[1]?.[0]).toMatchObject({
      projectId: 'p1',
    });
  });

  it('refuses a project no id or name matches, and a page it never handed out', async () => {
    const h = harness();

    await expect(
      h.service.listThreads(SENDER, { limit: 20, project: 'Two' }),
    ).rejects.toThrow('No project has the id or name "Two".');
    await expect(
      h.service.listThreads(SENDER, { limit: 20, page: 'not-a-page' }),
    ).rejects.toThrow('The page is not one list_threads handed out.');
    expect(h.listThreads).not.toHaveBeenCalled();
  });

  it('hands back the next page, which reads back as where this one ended', async () => {
    const h = harness();
    h.runs.set('other', runOf({ id: 'other' }));
    h.runs.set(SENDER, runOf({ id: SENDER }));

    const first = await h.service.listThreads(SENDER, { limit: 1 });
    await h.service.listThreads(SENDER, {
      limit: 1,
      page: first.nextPage ?? undefined,
    });

    expect(first.nextPage).not.toBeNull();
    expect(h.listThreads.mock.calls[1]?.[0].after).toEqual({
      rank: 1,
      sortAt: 7,
      id: 'x',
    });
  });

  it('lists a thread waiting on the user, chat or team, and a stopped one', async () => {
    const h = harness({ status: 'cancelled' });
    h.runs.set(
      'team',
      runOf({ id: 'team', teamId: 'team-1', status: 'running' }),
    );
    h.runs.set('chat', runOf({ id: 'chat', status: 'running' }));
    h.approvals.awaitingFor.mockImplementation(((runId: string) =>
      runId === 'team' ? 'question' : null) as never);
    h.chats.awaitsCardAnswer.mockImplementation(
      ((runId: string) => runId === 'chat') as unknown as () => boolean,
    );

    const listed = (await h.service.listThreads(SENDER, { limit: 20 })).threads;

    expect(
      Object.fromEntries(listed.map((row) => [row.thread, row.status])),
    ).toEqual({ [TARGET]: 'stopped', team: 'needs_user', chat: 'needs_user' });
  });
});
