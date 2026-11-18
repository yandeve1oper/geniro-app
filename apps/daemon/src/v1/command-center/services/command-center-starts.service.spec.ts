import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOST_START_THREAD_TOOL,
  type StartThreadAnswer,
  type StartThreadInput,
} from '../../agents/chat.types';
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { ChatService } from '../../agents/services/chat.service';
import type { HostWakeBus } from '../../agents/services/host-wake.bus';
import type { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { TaskEventBus } from '../../tasks/services/task-events.bus';
import type { TasksService } from '../../tasks/services/tasks.service';
import { commandCenterDb } from '../__tests__/command-center-db';
import {
  type RosterReason,
  START_FAILURE_MAX_CHARS,
} from '../command-center.types';
import type {
  CommandCenterChatService,
  RosterThread,
} from './command-center-chat.service';
import { CommandCenterStartsService } from './command-center-starts.service';

const MANAGER = 'manager-1';
const AUTO_MANAGER = 'manager-auto';
const CHAT = 'chat-1';
const THREAD = 'thread-1';
const PROJECT_ID = 'project-1';

type Db = Awaited<ReturnType<typeof commandCenterDb>>;
type Responder = (allow: boolean, answer?: string) => void;
type Wake = Parameters<HostWakeBus['publish']>[0];

function taskIdOf(answer: StartThreadAnswer): string {
  if (answer.status === 'refused') {
    throw new Error(`refused: ${answer.code}`);
  }
  return answer.taskId;
}

function input(over: Partial<StartThreadInput> = {}): StartThreadInput {
  return {
    project: 'Geniro',
    title: 'Billing cache',
    brief: 'Clear the cache',
    ...over,
  };
}

describe('CommandCenterStartsService', () => {
  let db: Db;
  let taskDao: TaskDao;
  let service: CommandCenterStartsService;
  let createdIds: string[];
  let project: Project;

  let raiseOwnedCard: ReturnType<
    typeof vi.fn<
      (
        runId: string,
        requestId: string,
        card: { toolName: string; input: unknown },
        respond: Responder,
      ) => Promise<void>
    >
  >;
  let deliverOwnedCardVerdict: ReturnType<
    typeof vi.fn<
      (
        runId: string,
        requestId: string,
        allow: boolean,
        message: string,
        answer?: string,
      ) => Promise<void>
    >
  >;
  let wakePublish: ReturnType<typeof vi.fn<(wake: Wake) => void>>;
  let addToRoster: ReturnType<
    typeof vi.fn<
      (
        managerRunId: string,
        threadRunIds: readonly string[],
        reason: RosterReason,
      ) => Promise<void>
    >
  >;
  let rosterThreads: ReturnType<
    typeof vi.fn<(managerRunId: string) => Promise<RosterThread[]>>
  >;
  let listAll: ReturnType<typeof vi.fn<() => Promise<Project[]>>>;
  let createTask: ReturnType<
    typeof vi.fn<(input: Partial<Task>) => Promise<Task>>
  >;
  let taskEvents: TaskEventBus;

  async function seedTask(extra: Partial<Task> = {}): Promise<Task> {
    const fork = db.em.fork();
    const task = Object.assign(new Task(), {
      projectId: PROJECT_ID,
      title: 'Billing cache',
      description: 'Clear the cache',
      status: 'backlog',
      number: 7,
      ...extra,
    } as Task);
    fork.persist(task);
    await fork.flush();
    return task;
  }

  async function taskOf(id: string): Promise<Task> {
    const task = await taskDao.getById(id, db.em.fork());
    if (task === null) {
      throw new Error(`task ${id} is missing`);
    }
    return task;
  }

  function startedEvent(taskId: string): void {
    taskEvents.publishTaskChanged({
      taskId,
      projectId: PROJECT_ID,
      status: 'in_progress',
    });
  }

  beforeEach(async () => {
    db = await commandCenterDb();
    await db.seedRun(MANAGER, {
      commandCenter: true,
      approval: 'ask',
      title: 'Manager',
    });
    await db.seedRun(AUTO_MANAGER, {
      commandCenter: true,
      approval: 'auto',
      title: 'Manager (auto)',
    });
    await db.seedRun(CHAT, { approval: 'ask', title: 'Ordinary chat' });
    await db.seedRun(THREAD, { title: 'Billing cache' });
    taskDao = new TaskDao(db.em);
    createdIds = [];
    project = Object.assign(new Project(), {
      id: PROJECT_ID,
      name: 'Geniro',
      folder: '/work/geniro',
      taskKey: 'GEN',
    });

    raiseOwnedCard = vi.fn(() => Promise.resolve());
    deliverOwnedCardVerdict = vi.fn(() => Promise.resolve());
    wakePublish = vi.fn<(wake: Wake) => void>();
    addToRoster = vi.fn(() => Promise.resolve());
    rosterThreads = vi.fn(() => Promise.resolve([]));
    listAll = vi.fn(() => Promise.resolve([project]));
    createTask = vi.fn(async (fields: Partial<Task>) => {
      const task = await seedTask(fields);
      createdIds.push(task.id);
      return task;
    });
    taskEvents = new TaskEventBus();

    service = new CommandCenterStartsService(
      db.em,
      new RunDao(db.em),
      new ItemDao(db.em),
      { raiseOwnedCard, deliverOwnedCardVerdict } as unknown as ChatService,
      { publish: wakePublish } as unknown as HostWakeBus,
      { listAll } as unknown as ProjectDao,
      taskDao,
      { create: createTask } as unknown as TasksService,
      taskEvents,
      { addToRoster, rosterThreads } as unknown as CommandCenterChatService,
    );
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await db.orm.close(true);
  });

  describe('start', () => {
    it('starts an auto-approved card at once, with no Start card to answer', async () => {
      const answer = await service.start(AUTO_MANAGER, input());
      const taskId = taskIdOf(answer);

      expect(answer).toEqual({
        status: 'starting',
        taskId,
        identifier: 'GEN-7',
      });
      expect(raiseOwnedCard).not.toHaveBeenCalled();
      const task = await taskOf(taskId);
      expect(task.startApprovedAt).not.toBeNull();
      expect(task.startRequestedByRunId).toBe(AUTO_MANAGER);
    });

    it('keeps the manager’s note for the thread until the start is reported, then puts it on the roster', async () => {
      rosterThreads.mockResolvedValue([]);
      const answer = await service.start(
        AUTO_MANAGER,
        input({ note: '  watch billing  ' }),
      );
      const taskId = taskIdOf(answer);
      expect((await taskOf(taskId)).startRequestNote).toBe('watch billing');
      await taskDao.settleStartRequest(taskId);
      await taskDao.updateById(taskId, { runId: THREAD });

      startedEvent(taskId);

      await vi.waitFor(() =>
        expect(addToRoster).toHaveBeenCalledWith(
          AUTO_MANAGER,
          [THREAD],
          'manager',
          'watch billing',
        ),
      );
    });

    it('puts the Start card to the user in ask mode and leaves the card unapproved', async () => {
      const answer = await service.start(MANAGER, input());
      const taskId = taskIdOf(answer);

      expect(answer).toEqual({
        status: 'card_shown',
        taskId,
        identifier: 'GEN-7',
      });
      expect(raiseOwnedCard).toHaveBeenCalledTimes(1);
      const [runId, cardId, card] = raiseOwnedCard.mock.calls[0]!;
      expect(runId).toBe(MANAGER);
      expect(cardId).toContain(`command-center-start:${taskId}:`);
      expect(card).toEqual({
        toolName: HOST_START_THREAD_TOOL,
        input: {
          taskId,
          title: 'Billing cache',
          project: 'Geniro',
          brief: 'Clear the cache',
        },
      });
      const task = await taskOf(taskId);
      expect(task.startApprovedAt).toBeNull();
      expect(task.startRequestedByRunId).toBe(MANAGER);
      expect(task.status).toBe('backlog');
    });

    it('refuses CARD_NOT_SHOWN and clears the request when the Start card cannot be shown', async () => {
      raiseOwnedCard.mockRejectedValueOnce(new Error('no window'));

      const answer = await service.start(MANAGER, input());

      expect(answer).toEqual({
        status: 'refused',
        code: 'CARD_NOT_SHOWN',
        reason: expect.stringContaining('GEN-7'),
      });
      const task = await taskOf(createdIds[0]!);
      expect(task.startRequestedAt).toBeNull();
      expect(task.startRequestedByRunId).toBeNull();
      expect(task.status).toBe('backlog');
    });

    it('refuses a run that is not the command center manager, and files no card', async () => {
      expect(await service.start(CHAT, input())).toEqual({
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: expect.any(String),
      });
      expect(await service.start('missing-run', input())).toEqual({
        status: 'refused',
        code: 'NOT_MANAGER',
        reason: expect.any(String),
      });
      expect(createTask).not.toHaveBeenCalled();
    });

    it('refuses an unknown project, and a name that two projects share', async () => {
      expect(
        await service.start(MANAGER, input({ project: 'Nowhere' })),
      ).toEqual({
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: expect.stringContaining('Nowhere'),
      });

      listAll.mockResolvedValueOnce([
        project,
        Object.assign(new Project(), {
          id: 'project-2',
          name: ' geniro ',
          folder: '/work/other',
          taskKey: 'OTH',
        }),
      ]);
      expect(
        await service.start(MANAGER, input({ project: 'GENIRO' })),
      ).toEqual({
        status: 'refused',
        code: 'PROJECT_NOT_FOUND',
        reason: expect.stringContaining('GENIRO'),
      });
      expect(createTask).not.toHaveBeenCalled();
    });
  });

  describe("the user's verdict on the Start card", () => {
    it('approves the start and tells the manager when allowed, with the note', async () => {
      const taskId = taskIdOf(await service.start(MANAGER, input()));
      const cardId = raiseOwnedCard.mock.calls[0]![1];

      raiseOwnedCard.mock.calls[0]![3](true, 'go ahead');

      await vi.waitFor(() =>
        expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
          MANAGER,
          cardId,
          true,
          expect.stringContaining('approved starting "Billing cache"'),
          'go ahead',
        ),
      );
      expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
        MANAGER,
        cardId,
        true,
        expect.stringContaining("The user's note: go ahead"),
        'go ahead',
      );
      expect((await taskOf(taskId)).startApprovedAt).not.toBeNull();
    });

    it('clears the request and the requester, and leaves the card in backlog, when declined', async () => {
      const taskId = taskIdOf(await service.start(MANAGER, input()));
      const cardId = raiseOwnedCard.mock.calls[0]![1];

      raiseOwnedCard.mock.calls[0]![3](false);

      await vi.waitFor(() =>
        expect(deliverOwnedCardVerdict).toHaveBeenCalledWith(
          MANAGER,
          cardId,
          false,
          expect.stringContaining('declined to start "Billing cache"'),
          undefined,
        ),
      );
      const task = await taskOf(taskId);
      expect(task.startRequestedAt).toBeNull();
      expect(task.startRequestedByRunId).toBeNull();
      expect(task.startApprovedAt).toBeNull();
      expect(task.status).toBe('backlog');
    });
  });

  describe('approvedStarts', () => {
    it('lists only approved starts not yet started, each with its folder, and drops one whose project is gone', async () => {
      const queued = await seedTask({
        title: 'First',
        startRequestedAt: new Date(1000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(1000),
      });
      const withFolder = await seedTask({
        title: 'Second',
        folder: '/work/custom',
        startRequestedAt: new Date(2000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(2000),
      });
      await seedTask({
        title: 'Waiting for the user',
        startRequestedAt: new Date(3000),
        startRequestedByRunId: MANAGER,
      });
      const started = await seedTask({
        title: 'Started',
        startRequestedAt: new Date(4000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(4000),
      });
      await taskDao.settleStartRequest(started.id);
      await seedTask({
        title: 'Orphan',
        projectId: 'project-gone',
        startRequestedAt: new Date(5000),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(5000),
      });

      expect(await service.approvedStarts()).toEqual([
        {
          taskId: queued.id,
          projectId: PROJECT_ID,
          title: 'First',
          status: 'backlog',
          folder: '/work/geniro',
        },
        {
          taskId: withFolder.id,
          projectId: PROJECT_ID,
          title: 'Second',
          status: 'backlog',
          folder: '/work/custom',
        },
      ]);
    });
  });

  describe('failed', () => {
    it('clears the request and tells the manager once, with the reason cut to the limit', async () => {
      const task = await seedTask({
        startRequestedAt: new Date(),
        startRequestedByRunId: MANAGER,
        startApprovedAt: new Date(),
      });
      const reason = 'x'.repeat(START_FAILURE_MAX_CHARS + 50);

      await service.failed(task.id, reason);

      expect(wakePublish).toHaveBeenCalledTimes(1);
      expect(wakePublish).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `command-center:start-failed:${task.id}`,
          owner: expect.objectContaining({ runId: MANAGER }),
          prompt: expect.stringContaining(
            `could not be started: ${'x'.repeat(START_FAILURE_MAX_CHARS)}. The card stays`,
          ),
        }),
      );
      expect(wakePublish).not.toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(
            'x'.repeat(START_FAILURE_MAX_CHARS + 1),
          ),
        }),
      );
      const after = await taskOf(task.id);
      expect(after.startRequestedAt).toBeNull();
      expect(after.startRequestedByRunId).toBeNull();
    });

    it('tells no one about a card that no manager is waiting on', async () => {
      const task = await seedTask({});

      await service.failed(task.id, 'boom');

      expect(wakePublish).not.toHaveBeenCalled();
    });
  });

  describe('the report of a started thread', () => {
    it('puts the thread on the manager roster and tells the manager once it has started', async () => {
      rosterThreads.mockResolvedValueOnce([
        {
          entry: { threadRunId: THREAD, handle: 't3' },
          run: null,
        } as unknown as RosterThread,
      ]);
      const task = await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });

      startedEvent(task.id);

      await vi.waitFor(() => expect(wakePublish).toHaveBeenCalledTimes(1));
      expect(addToRoster).toHaveBeenCalledWith(
        MANAGER,
        [THREAD],
        'manager',
        null,
      );
      expect(wakePublish).toHaveBeenCalledWith(
        expect.objectContaining({
          key: `command-center:started:${task.id}`,
          owner: expect.objectContaining({ runId: MANAGER }),
          prompt: expect.stringContaining(
            `has started as t3 (thread ${THREAD}).`,
          ),
        }),
      );
      expect((await taskOf(task.id)).startRequestedByRunId).toBeNull();
    });

    it('tells the manager once when two reports of the same start race', async () => {
      await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });
      const reports = service as unknown as { reportStarted(): Promise<void> };

      await Promise.all([reports.reportStarted(), reports.reportStarted()]);

      expect(addToRoster).toHaveBeenCalledTimes(1);
      expect(wakePublish).toHaveBeenCalledTimes(1);
    });

    it('gives the report back when telling the manager fails, so the next report tells it', async () => {
      const task = await seedTask({
        startRequestedAt: null,
        startRequestedByRunId: MANAGER,
        runId: THREAD,
      });
      addToRoster.mockRejectedValueOnce(new Error('roster locked'));

      startedEvent(task.id);

      await vi.waitFor(() => expect(addToRoster).toHaveBeenCalledTimes(1));
      await vi.waitFor(async () =>
        expect((await taskOf(task.id)).startRequestedByRunId).toBe(MANAGER),
      );
      expect(wakePublish).not.toHaveBeenCalled();

      startedEvent(task.id);

      await vi.waitFor(() => expect(wakePublish).toHaveBeenCalledTimes(1));
      expect(addToRoster).toHaveBeenCalledTimes(2);
      expect(wakePublish).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining(`has started (thread ${THREAD}).`),
        }),
      );
    });
  });
});
