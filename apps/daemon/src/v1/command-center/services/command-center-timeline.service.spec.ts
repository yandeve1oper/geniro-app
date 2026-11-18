import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { ThreadMessage } from '../../runs/entity/thread-message.entity';
import { UsageActivity } from '../../stats/entity/usage-activity.entity';
import { Task } from '../../tasks/entity/task.entity';
import { commandCenterDb } from '../__tests__/command-center-db';
import { CommandCenterRosterDao } from '../dao/command-center-roster.dao';
import { CommandCenterTimelineDao } from '../dao/command-center-timeline.dao';
import type { CommandCenterService } from './command-center.service';
import { CommandCenterTimelineService } from './command-center-timeline.service';

const SECOND = 1000;
const HOUR = 60 * 60_000;
const T0 = Date.parse('2026-11-17T10:00:00.000Z');

function at(seconds: number): Date {
  return new Date(T0 + seconds * SECOND);
}

type Db = Awaited<ReturnType<typeof commandCenterDb>>;

function stagePayload(action: string, stageTitle: string, text: string) {
  return {
    action,
    stageId: 'stage-1',
    stageTitle,
    text,
    rev: 1,
    by: { kind: 'system' },
  };
}

function message(
  fields: Pick<ThreadMessage, 'fromRunId' | 'toRunId' | 'text' | 'createdAt'> &
    Partial<ThreadMessage>,
): ThreadMessage {
  return Object.assign(new ThreadMessage(), {
    fromTitle: 'Manager',
    fromSessionKey: 'session',
    wake: true,
    ...fields,
  });
}

describe('CommandCenterTimelineService', () => {
  let db: Db;
  let managerRunId: string | null;
  let activeRunIds: string[];
  let service: CommandCenterTimelineService;

  beforeEach(async () => {
    db = await commandCenterDb();
    managerRunId = 'manager';
    activeRunIds = [];
    const board = {
      managerRunId: vi.fn(async () => managerRunId),
      activeThreads: vi.fn(async () => ({
        managerRunId,
        runs: activeRunIds.map((id) => ({ id }) as unknown as RunWire),
      })),
    };
    service = new CommandCenterTimelineService(
      board as unknown as CommandCenterService,
      new CommandCenterRosterDao(db.em),
      new ItemDao(db.em),
      new CommandCenterTimelineDao(db.em),
    );
  });

  afterEach(async () => {
    await db.orm.close(true);
  });

  async function persist(...rows: object[]): Promise<void> {
    const fork = db.em.fork();
    for (const row of rows) {
      fork.persist(row);
    }
    await fork.flush();
  }

  async function seedWorld(): Promise<void> {
    await db.seedRun('manager', {
      commandCenter: true,
      title: 'Manager',
      status: 'running',
      createdAt: at(0),
    });
    await db.seedItem(
      'manager',
      1,
      at(10),
      'message',
      { text: '  ship   the\nfix ' },
      { role: 'user' },
    );
    await db.seedItem(
      'manager',
      2,
      at(5),
      'message',
      { text: 'x'.repeat(300) },
      { role: 'user' },
    );

    await db.seedRun('thread-a', {
      title: 'Build A',
      status: 'running',
      createdAt: at(100),
    });
    await db.seedRun('thread-b', {
      title: 'Build B',
      status: 'failed',
      createdAt: at(200),
    });
    await db.seedRun('stranger', {
      title: 'Stranger',
      status: 'running',
      createdAt: at(300),
    });
    await db.seedRoster('manager', 'thread-a', 't1', { joinedAt: at(100) });
    await db.seedRoster('manager', 'thread-b', 't2', {
      joinedAt: at(200),
      leftAt: at(9000),
    });
    activeRunIds = ['thread-a'];

    await db.seedItem('thread-a', 1, at(150), 'approval_request', {
      id: 'a1',
      toolName: 'Bash',
      input: { command: 'ls' },
    });
    await db.seedItem('thread-a', 2, at(160), 'approval_request', {
      id: 'q1',
      toolName: 'ask_user_question',
      input: {},
      questions: [
        {
          question: 'Which database?',
          header: null,
          options: [],
          multiSelect: false,
        },
      ],
    });
    await db.seedItem(
      'thread-a',
      3,
      at(170),
      'stage_change',
      stagePayload('complete', 'Build', 'built it'),
    );
    await db.seedItem(
      'thread-a',
      4,
      at(175),
      'stage_change',
      stagePayload('nudge', 'Build', 'hurry'),
    );
    await db.seedItem('thread-a', 5, at(180), 'thread_outcome', {
      kind: 'success',
      summary: 'shipped',
      teamSlug: null,
      nodeId: 'n1',
      conversationId: null,
    });
    await db.seedItem('thread-b', 1, at(7800), 'message', { text: 'working' });
    await db.seedItem('thread-b', 2, at(8000), 'error', {
      message: 'Process exited\nwith code 1',
    });
    await db.seedItem('stranger', 1, at(310), 'message', { text: 'private' });

    await persist(
      message({
        fromRunId: 'thread-a',
        fromTitle: 'Build A',
        toRunId: 'manager',
        text: 'done?',
        createdAt: at(190),
      }),
      message({
        fromRunId: 'manager',
        toRunId: 'thread-a',
        text: 'status?',
        createdAt: at(140),
        replyCreditUntil: new Date(Date.now() + HOUR),
      }),
      message({
        fromRunId: 'manager',
        toRunId: 'thread-b',
        text: 'retry',
        createdAt: at(250),
        replyCreditUntil: new Date(Date.now() - HOUR),
      }),
      message({
        fromRunId: 'manager',
        toRunId: 'thread-b',
        text: 'again',
        createdAt: at(260),
        replyCreditUntil: new Date(Date.now() + HOUR),
        replyCreditSpentAt: at(255),
      }),
      message({
        fromRunId: 'manager',
        toRunId: 'stranger',
        text: 'hello',
        createdAt: at(320),
      }),
      Object.assign(new Task(), {
        projectId: 'project-1',
        title: 'Card X',
        status: 'backlog',
        startRequestedByRunId: 'manager',
        startRequestedAt: at(8500),
        startApprovedAt: null,
      }),
      Object.assign(new Task(), {
        projectId: 'project-1',
        title: 'Card Y',
        status: 'backlog',
        startRequestedByRunId: 'manager',
        startRequestedAt: at(8600),
        startApprovedAt: at(8650),
      }),
      Object.assign(new Task(), {
        projectId: 'project-1',
        title: 'Card Z',
        status: 'backlog',
        startRequestedByRunId: 'stranger',
        startRequestedAt: at(8700),
        startApprovedAt: null,
      }),
      Object.assign(new UsageActivity(), {
        kind: 'pull_request',
        runId: 'thread-a',
        occurredAt: at(7500),
        dedupKey: 'pr:thread-a:geniro-io/geniro-app#532',
        prOwner: 'geniro-io',
        prRepo: 'geniro-app',
        prNumber: 532,
        prUrl: 'https://github.com/geniro-io/geniro-app/pull/532',
      }),
    );
  }

  async function allEvents() {
    return (await service.page(null, 200)).events;
  }

  it('shows each kind with its thread, title, text and detail', async () => {
    await seedWorld();

    const events = await allEvents();
    const ofKind = (kind: string) =>
      events.filter((event) => event.kind === kind);

    expect(ofKind('user_message')).toEqual([
      expect.objectContaining({
        at: at(10).toISOString(),
        text: 'ship the fix',
        threadRunId: null,
        threadTitle: null,
      }),
      expect.objectContaining({
        at: at(5).toISOString(),
        text: `${'x'.repeat(199)}…`,
      }),
    ]);
    expect(ofKind('thread_started')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-b',
        threadTitle: 'Build B',
        at: at(200).toISOString(),
      }),
      expect.objectContaining({
        threadRunId: 'thread-a',
        threadTitle: 'Build A',
        at: at(100).toISOString(),
      }),
    ]);
    expect(
      ofKind('manager_message').map((event) => [
        event.threadRunId,
        event.awaitingReply,
      ]),
    ).toEqual([
      ['thread-b', false],
      ['thread-b', false],
      ['thread-a', true],
    ]);
    expect(ofKind('thread_message')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-a',
        threadTitle: 'Build A',
        text: 'done?',
        awaitingReply: false,
      }),
    ]);
    expect(ofKind('start_requested')).toEqual([
      expect.objectContaining({
        threadRunId: null,
        threadTitle: null,
        text: 'Card Y',
        detail: 'approved',
      }),
      expect.objectContaining({
        threadRunId: null,
        text: 'Card X',
        detail: 'waiting for Start',
      }),
    ]);
    expect(ofKind('pull_request')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-a',
        threadTitle: 'Build A',
        text: 'geniro-io/geniro-app',
        detail: '532',
      }),
    ]);
    expect(ofKind('question')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-a',
        text: 'Which database?',
      }),
    ]);
    expect(ofKind('approval')).toEqual([
      expect.objectContaining({ threadRunId: 'thread-a', text: 'Bash' }),
    ]);
    expect(ofKind('stage')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-a',
        text: 'built it',
        detail: 'Build',
      }),
    ]);
    expect(ofKind('outcome')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-a',
        text: 'shipped',
        detail: 'success',
      }),
    ]);
    expect(ofKind('failed')).toEqual([
      expect.objectContaining({
        threadRunId: 'thread-b',
        threadTitle: 'Build B',
        at: at(8000).toISOString(),
        text: 'Process exited with code 1',
      }),
    ]);
  });

  it('lists every source newest first', async () => {
    await seedWorld();

    const times = (await allEvents()).map((event) => Date.parse(event.at));

    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('pages with before and limit, with no duplicate and no gap', async () => {
    await seedWorld();
    const everything = (await allEvents()).map((event) => event.id);

    const seen: string[] = [];
    let before: Date | null = null;
    let pages = 0;
    for (;;) {
      const page = await service.page(before, 3);
      seen.push(...page.events.map((event) => event.id));
      pages += 1;
      if (page.nextBefore === null) {
        break;
      }
      before = new Date(page.nextBefore);
    }

    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(everything);
  });

  it('keeps every event that shares the cut instant on the page, so none is lost', async () => {
    await db.seedRun('manager', {
      commandCenter: true,
      title: 'Manager',
      status: 'running',
    });
    await db.seedRun('thread-a', {
      title: 'Build A',
      status: 'running',
      createdAt: at(100),
    });
    await db.seedRoster('manager', 'thread-a', 't1', { joinedAt: at(100) });
    await db.seedItem(
      'thread-a',
      1,
      at(500),
      'stage_change',
      stagePayload('complete', 'Review', 'one'),
    );
    await db.seedItem(
      'thread-a',
      2,
      at(500),
      'stage_change',
      stagePayload('complete', 'Review', 'two'),
    );
    await db.seedItem('thread-a', 3, at(500), 'thread_outcome', {
      kind: 'partial',
      summary: 'half',
      teamSlug: null,
      nodeId: 'n1',
      conversationId: null,
    });

    const first = await service.page(null, 2);
    const second = await service.page(
      first.nextBefore === null ? null : new Date(first.nextBefore),
      2,
    );

    expect(first.events.map((event) => event.at)).toEqual([
      at(500).toISOString(),
      at(500).toISOString(),
      at(500).toISOString(),
    ]);
    expect(first.nextBefore).toBe(at(500).toISOString());
    expect(second.events).toEqual([
      expect.objectContaining({
        kind: 'thread_started',
        at: at(100).toISOString(),
      }),
    ]);
    expect(second.nextBefore).toBeNull();
  });

  it('shows no event of a thread that is neither on the roster nor on the board', async () => {
    await seedWorld();

    const events = await allEvents();

    expect(events.some((event) => event.threadRunId === 'stranger')).toBe(
      false,
    );
    expect(
      events.some(
        (event) => event.text === 'hello' || event.text === 'private',
      ),
    ).toBe(false);
    expect(events.some((event) => event.text === 'Card Z')).toBe(false);
  });

  it('marks awaitingReply only while the reply credit is still open', async () => {
    await seedWorld();

    const replies = (await allEvents())
      .filter((event) => event.kind === 'manager_message')
      .map((event) => event.awaitingReply);

    expect(replies).toEqual([false, false, true]);
  });

  it('answers an empty timeline when there is no manager', async () => {
    await seedWorld();
    managerRunId = null;

    expect(await service.page(null, 100)).toEqual({
      events: [],
      nextBefore: null,
    });
  });
});
