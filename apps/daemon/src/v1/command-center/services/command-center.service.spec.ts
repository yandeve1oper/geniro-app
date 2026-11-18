import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ThreadMessageDao } from '../../agents/dao/thread-message.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import type { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterService } from './command-center.service';

const HOUR = 60 * 60_000;
const MINUTE = 60_000;

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

/** The run as the chat listing states it, with the fields the board reads. */
function wireOf(run: Run, awaiting: ReadonlySet<string>): RunWire {
  return {
    id: run.id,
    status: run.status,
    title: run.title,
    awaiting: awaiting.has(run.id) ? 'approval' : null,
    outcome: null,
    pullRequests: [],
    lastMessage: null,
    lastActivityAt: null,
    createdAt: run.createdAt.toISOString(),
    taskIdentifier: run.taskIdentifier,
  } as unknown as RunWire;
}

describe('CommandCenterService.board', () => {
  let db: Db;
  let now: number;
  let pending: Set<string>;
  let chats: {
    listChats: ReturnType<typeof vi.fn>;
    findCommandCenterChat: ReturnType<typeof vi.fn>;
  };
  let executor: { listRuns: ReturnType<typeof vi.fn> };
  let service: CommandCenterService;

  beforeEach(async () => {
    db = await commandCenterDb();
    now = Date.now();
    pending = new Set();
    const runDao = new RunDao(db.em);
    chats = {
      listChats: vi.fn(
        async (scope: 'active', page: { runIds?: string[] } = {}) =>
          (await runDao.listChats(scope, db.em.fork(), page)).map((run) =>
            wireOf(run, pending),
          ),
      ),
      findCommandCenterChat: vi.fn(async () => {
        const [run] = await runDao.listCommandCenterChats(db.em.fork());
        return run === undefined ? null : wireOf(run, pending);
      }),
    };
    executor = {
      listRuns: vi.fn(
        async (scope: 'active', page: { runIds?: string[] } = {}) =>
          (await runDao.listTeamRuns(scope, db.em.fork(), page)).map((run) =>
            wireOf(run, pending),
          ),
      ),
    };
    const bus = new AgentEventBus();
    const inbox = new ThreadInboxService(
      db.em,
      new ThreadMessageDao(db.em),
      runDao,
      bus,
      { oweKeyNote: () => true } as never,
      { warn: async () => undefined } as never,
    );
    service = new CommandCenterService(
      db.em,
      runDao,
      chats as unknown as ChatService,
      executor as unknown as TeamExecutorService,
      inbox,
      new TaskDao(db.em),
      new CommandCenterRosterDao(db.em),
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  /** A chat whose newest transcript row is `ageMs` old. */
  async function seedChatAged(
    id: string,
    ageMs: number,
    extra: Partial<Run> = {},
  ): Promise<void> {
    await db.seedRun(id, extra);
    await db.seedItem(
      id,
      1,
      new Date(now - ageMs),
      'message',
      { text: 'hi' },
      {
        role: 'user',
      },
    );
  }

  it('shows every active thread however long ago it moved, and none archived or finished', async () => {
    await seedChatAged('recent', HOUR);
    await seedChatAged('two-weeks', 14 * 24 * HOUR);
    await seedChatAged('running-old', 10 * 24 * HOUR, { status: 'running' });
    await seedChatAged('archived', HOUR, { archivedAt: new Date(now) });
    await seedChatAged('finished', HOUR);
    await db.seedTask('finished', 'done');

    const board = await service.board();

    expect(board.cards.map((card) => card.run.id).sort()).toEqual([
      'recent',
      'running-old',
      'two-weeks',
    ]);
  });

  it('never shows the manager or an app-own chat, running or not', async () => {
    await db.seedRun('manager', { commandCenter: true, status: 'running' });
    await db.seedItem(
      'manager',
      1,
      new Date(now - MINUTE),
      'message',
      { text: 'x' },
      { role: 'user' },
    );
    await seedChatAged('project-chat', HOUR, {
      editsProjectId: 'p1',
      status: 'running',
    });
    await seedChatAged('builder-chat', HOUR, { editsTeamSlug: 'team-a' });
    await seedChatAged('analysis', HOUR, { analysisSourceRunId: 'thread-x' });
    await seedChatAged('plain-chat', HOUR);
    await db.seedRoster('manager', 'plain-chat', 't1', {
      note: 'waits for schema',
    });

    const board = await service.board();

    expect(board.manager?.id).toBe('manager');
    expect(board.cards.map((card) => card.run.id)).toEqual(['plain-chat']);
    expect(board.cards[0]).toMatchObject({
      handle: 't1',
      note: 'waits for schema',
    });
  });

  it('places each thread in its column, and leaves a finished one off the board', async () => {
    await seedChatAged('done-card', HOUR);
    await db.seedTask('done-card', 'done');
    await seedChatAged('review-card', HOUR);
    await db.seedTask('review-card', 'in_review');
    await seedChatAged('idle-card', HOUR);

    const board = await service.board();

    expect(
      Object.fromEntries(board.cards.map((card) => [card.run.id, card.column])),
    ).toEqual({
      'review-card': 'in_review',
      'idle-card': 'idle',
    });
  });

  it('names the board card each thread works, and none for a thread no card started', async () => {
    await seedChatAged('card-run', HOUR, { taskIdentifier: 'GEN-12' });
    await db.seedTask('card-run', 'in_progress', { title: 'Fix login' });
    await seedChatAged('loose-run', HOUR);

    const board = await service.board();
    const taskOf = Object.fromEntries(
      board.cards.map((card) => [card.run.id, card.task]),
    );

    expect(taskOf['card-run']).toEqual({
      id: expect.any(String),
      identifier: 'GEN-12',
      title: 'Fix login',
      status: 'in_progress',
    });
    expect(taskOf['loose-run']).toBeNull();
  });

  it('counts the starts the manager asked for that still wait on the user, and no one else’s', async () => {
    await db.seedRun('manager', { commandCenter: true });
    await seedChatAged('thread', HOUR);
    const requested = new Date(now - MINUTE);
    await db.seedTask('a', 'backlog', {
      runId: null,
      startRequestedAt: requested,
      startRequestedByRunId: 'manager',
    });
    await db.seedTask('b', 'backlog', {
      runId: null,
      startRequestedAt: requested,
      startRequestedByRunId: 'manager',
      startApprovedAt: requested,
    });
    await db.seedTask('c', 'backlog', {
      runId: null,
      startRequestedAt: requested,
      startRequestedByRunId: 'someone-else',
    });

    expect((await service.board()).pendingStarts).toBe(1);
  });

  it('answers no manager and no pending starts while there is no manager chat', async () => {
    await seedChatAged('thread', HOUR);

    const board = await service.board();

    expect(board.manager).toBeNull();
    expect(board.pendingStarts).toBe(0);
  });
});
