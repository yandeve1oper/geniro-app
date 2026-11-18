import { BadRequestException } from '@packages/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SINGLE_AGENT_NODE,
  type TellThreadsInput,
} from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { CommandCenterOpsBroker } from '../../agents/services/command-center-ops.broker';
import type { ThreadDeliveryService } from '../../teams/services/thread-delivery.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import { REPLY_CREDIT_MS } from '../command-center.types';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';
import type { CommandCenterChatService } from './command-center-chat.service';
import type { CommandCenterEventBus } from './command-center-events.bus';
import { CommandCenterOpsService } from './command-center-ops.service';
import type { CommandCenterStartsService } from './command-center-starts.service';

const MANAGER = 'manager-1';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

function sendOk(title: string) {
  return { outcome: 'joined' as const, title };
}

describe('CommandCenterOpsService', () => {
  let db: Db;
  let delivery: { send: ReturnType<typeof vi.fn> };
  let events: CommandCenterEventBus;
  let publishChanged: ReturnType<typeof vi.fn>;
  let broker: CommandCenterOpsBroker;
  let roster: { rosterThreads: ReturnType<typeof vi.fn> };
  let service: CommandCenterOpsService;

  const threads = [
    { handle: 't1', runId: 'thread-1', title: 'Billing cache' },
    { handle: 't2', runId: 'thread-2', title: 'Docs' },
  ];

  function rosterOf(entries: typeof threads): void {
    roster.rosterThreads.mockResolvedValue(
      entries.map((entry) => ({
        entry: { handle: entry.handle, threadRunId: entry.runId, note: null },
        run: { id: entry.runId, title: entry.title },
      })),
    );
  }

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER, { commandCenter: true, title: 'Manager' });
    await db.seedRun('chat-1', { title: 'Ordinary chat' });
    await db.seedRun('off-roster', { title: 'Not managed' });
    await db.seedRun('thread-1', { title: 'Billing cache' });
    await db.seedRun('thread-2', { title: 'Docs' });

    delivery = {
      send: vi.fn((draft: { toRunId: string }) =>
        Promise.resolve(
          sendOk(threads.find((t) => t.runId === draft.toRunId)?.title ?? 'x'),
        ),
      ),
    };
    publishChanged = vi.fn();
    events = { publishChanged } as unknown as CommandCenterEventBus;
    roster = { rosterThreads: vi.fn() };
    rosterOf(threads);
    broker = new CommandCenterOpsBroker();
    service = new CommandCenterOpsService(
      db.em,
      new RunDao(db.em),
      broker,
      delivery as unknown as ThreadDeliveryService,
      new CommandCenterRosterDao(db.em),
      roster as unknown as CommandCenterChatService,
      {} as CommandCenterStartsService,
      events,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await db.orm.close(true);
  });

  describe('tell', () => {
    const input = (over: Partial<TellThreadsInput> = {}): TellThreadsInput => ({
      to: ['t1', 't2'],
      message: 'rebase on main',
      expect_reply: true,
      ...over,
    });

    it('sends the message once to each named thread, from the manager, and asks for a reply credit', async () => {
      const before = Date.now();

      const answer = await service.tell(MANAGER, input());

      const after = Date.now();
      expect(delivery.send).toHaveBeenCalledTimes(2);
      for (const [index, thread] of threads.entries()) {
        const draft = delivery.send.mock.calls[index]![0] as {
          from: unknown;
          toRunId: string;
          text: string;
          wake: boolean;
          replyCreditUntil: Date | null;
        };
        expect(draft).toMatchObject({
          from: {
            target: 'chat',
            runId: MANAGER,
            memberId: SINGLE_AGENT_NODE,
            conversationId: null,
            caller: SINGLE_AGENT_NODE,
          },
          toRunId: thread.runId,
          text: 'rebase on main',
          wake: true,
        });
        expect(draft.replyCreditUntil!.getTime()).toBeGreaterThanOrEqual(
          before + REPLY_CREDIT_MS,
        );
        expect(draft.replyCreditUntil!.getTime()).toBeLessThanOrEqual(
          after + REPLY_CREDIT_MS,
        );
      }
      expect(answer).toEqual({
        sent: [
          {
            to: 't1',
            runId: 'thread-1',
            title: 'Billing cache',
            outcome: 'joined',
            code: null,
          },
          {
            to: 't2',
            runId: 'thread-2',
            title: 'Docs',
            outcome: 'joined',
            code: null,
          },
        ],
        unresolved: [],
      });
    });

    it('asks for no reply credit when the manager does not expect a reply', async () => {
      await service.tell(MANAGER, input({ expect_reply: false }));

      expect(delivery.send).toHaveBeenCalledTimes(2);
      for (const [draft] of delivery.send.mock.calls as [
        { replyCreditUntil: Date | null },
      ][]) {
        expect(draft.replyCreditUntil).toBeNull();
      }
    });

    it('sends nothing when one of the names is ambiguous, and names both candidates', async () => {
      rosterOf([
        { handle: 't1', runId: 'thread-1', title: 'Billing' },
        { handle: 't2', runId: 'thread-2', title: 'Billing' },
        { handle: 't3', runId: 'thread-3', title: 'Docs' },
      ]);

      const answer = await service.tell(
        MANAGER,
        input({ to: ['t3', 'Billing'] }),
      );

      expect(delivery.send).not.toHaveBeenCalled();
      expect(answer).toEqual({
        sent: [],
        unresolved: [
          {
            to: 'Billing',
            code: 'AMBIGUOUS_TARGET',
            candidates: [
              { handle: 't1', title: 'Billing' },
              { handle: 't2', title: 'Billing' },
            ],
          },
        ],
      });
    });

    it('refuses a thread that exists but is not on the roster as NOT_MANAGED, and sends nothing', async () => {
      const answer = await service.tell(MANAGER, input({ to: ['off-roster'] }));

      expect(delivery.send).not.toHaveBeenCalled();
      expect(answer.unresolved).toEqual([
        { to: 'off-roster', code: 'NOT_MANAGED', candidates: [] },
      ]);
    });

    it('answers an unknown name as THREAD_NOT_FOUND', async () => {
      const answer = await service.tell(MANAGER, input({ to: ['nowhere'] }));

      expect(answer.unresolved).toEqual([
        { to: 'nowhere', code: 'THREAD_NOT_FOUND', candidates: [] },
      ]);
    });

    it('reports a send the delivery refuses as refused, with its code, and still sends the others', async () => {
      delivery.send.mockImplementationOnce(() =>
        Promise.reject(
          new BadRequestException(
            'MESSAGE_TOO_LONG',
            'the message is too long',
          ),
        ),
      );

      const answer = await service.tell(MANAGER, input());

      expect(answer.sent).toEqual([
        {
          to: 't1',
          runId: 'thread-1',
          title: 'Billing cache',
          outcome: 'refused',
          code: 'MESSAGE_TOO_LONG',
        },
        {
          to: 't2',
          runId: 'thread-2',
          title: 'Docs',
          outcome: 'joined',
          code: null,
        },
      ]);
    });

    it('refuses a call from a run that is not the manager', async () => {
      await expect(service.tell('chat-1', input())).rejects.toThrow(
        'only the command center manager may call this tool',
      );
      expect(delivery.send).not.toHaveBeenCalled();
    });

    it('answers a call from a run that is not the manager as an error through the broker', async () => {
      const answer = await broker.tell('chat-1', input());

      expect(answer).toEqual({
        error:
          'The command center could not answer: only the command center manager may call this tool',
      });
      expect(delivery.send).not.toHaveBeenCalled();
    });
  });

  describe('note', () => {
    it('sets the note on the thread’s roster row and publishes a roster change', async () => {
      await db.seedRoster(MANAGER, 'thread-1', 't1');

      const answer = await service.note(MANAGER, {
        thread: 't1',
        note: '  waits for the schema  ',
      });

      expect(answer).toEqual({
        status: 'noted',
        handle: 't1',
        title: 'Billing cache',
      });
      const row = await db.em
        .fork()
        .findOneOrFail(
          CommandCenterRosterEntry,
          { managerRunId: MANAGER, threadRunId: 'thread-1' },
          { disableIdentityMap: true },
        );
      expect(row.note).toBe('waits for the schema');
      expect(publishChanged).toHaveBeenCalledWith(['thread-1'], 'roster');
    });

    it('answers an unknown thread as unresolved and changes nothing', async () => {
      const answer = await service.note(MANAGER, {
        thread: 'nowhere',
        note: 'x',
      });

      expect(answer).toEqual({
        status: 'unresolved',
        code: 'THREAD_NOT_FOUND',
        candidates: [],
      });
      expect(publishChanged).not.toHaveBeenCalled();
    });
  });
});
