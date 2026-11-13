import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
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
import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { RunTeardownService } from '../../agents/services/run-teardown.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import {
  AUTOPILOT_LIMIT_FALLBACK_MS,
  AUTOPILOT_LIMIT_RESET_GRACE_MS,
  PROJECT_FAILURE_BREAKER_THRESHOLD,
} from '../../projects/projects.types';
import { ProjectEventBus } from '../../projects/services/project-events.bus';
import { isBreakerOpen } from '../../projects/utils/breaker';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import type { RunStatus } from '../../runs/runs.types';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskSettleService } from './task-settle.service';
import { TasksService } from './tasks.service';

/**
 * Real database throughout. What is under test is where a card lands when its
 * run ends by itself — a read of stored state, so faking the store would leave
 * nothing to observe.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-settle-spec');

const limitReadingAdapter = {
  failureFrom: (message: string) =>
    /hit your (?:[a-z0-9'-]+ )*limit/i.test(message)
      ? {
          class: 'rate_limited',
          resetsAt: /resets\s+(.+)$/i.exec(message)?.[1] ?? null,
        }
      : { class: 'crashed', resetsAt: null },
};
const noLimitAdapter = {
  failureFrom: () => ({ class: 'crashed', resetsAt: null }),
};
const adapters = {
  for: (kind: string) =>
    kind === 'claude' ? limitReadingAdapter : noLimitAdapter,
  all: () =>
    new Map<string, unknown>([
      ['cursor-agent', noLimitAdapter],
      ['claude', limitReadingAdapter],
    ]),
} as unknown as AgentAdapterRegistry;

describe('TaskSettleService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskSettleService;
  let tasks: TasksService;
  let live: ReturnType<typeof fakeLiveWork>;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let itemDao: ItemDao;
  let em: EntityManager;
  let bus: AgentEventBus;
  let taskEvents: TaskEventBus;
  let changes: TaskChangedEvent[];
  let projectChanges: string[];
  let projectId: string;
  /** The kept CLI processes: what a finished card's run must end. */
  let sessions: { closeFinishedRun: ReturnType<typeof vi.fn> };
  /** What the run's agents left running detached. */
  let teardown: {
    hasEnded: ReturnType<typeof vi.fn>;
    reapDetached: ReturnType<typeof vi.fn>;
  };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run, Item],
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
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    itemDao = new ItemDao(em);
    taskEvents = new TaskEventBus();
    changes = [];
    taskEvents.allChanges().subscribe((event) => changes.push(event));
    live = fakeLiveWork();
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      taskEvents,
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      runDao,
      live.liveWork,
    );
    tasks.onModuleInit();
    bus = new AgentEventBus();
    const projectEvents = new ProjectEventBus();
    projectChanges = [];
    projectEvents
      .allChanges()
      .subscribe((event) => projectChanges.push(event.projectId));
    sessions = { closeFinishedRun: vi.fn().mockResolvedValue(undefined) };
    teardown = {
      hasEnded: vi.fn().mockReturnValue(false),
      reapDetached: vi.fn(),
    };
    service = new TaskSettleService(
      em,
      bus,
      runDao,
      taskDao,
      projectDao,
      tasks,
      itemDao,
      projectEvents,
      adapters,
      sessions as unknown as AgentSessionRegistry,
      taskEvents,
      teardown as unknown as RunTeardownService,
    );
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-settle-spec',
    });
    projectId = project.id;
  });

  /** Long enough for `endFinishedWork` to have read the card and the run. */
  const flushSettle = async (): Promise<void> => {
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  /** A card already in `in_progress` with a live run working it. */
  const working = async (runId = 'run-1') => {
    const task = await tasks.create({ projectId, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      teamId: null,
      status: 'running',
      agentKind: 'claude',
      taskId: task.id,
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  const settleRun = async (runId: string, status: RunStatus) => {
    const run = await runDao.getById(runId);
    if (run) {
      run.status = status;
      await em.flush();
    }
    await service.settle(runId, status);
  };

  /**
   * The card's status as the DATABASE holds it.
   *
   * Through a fresh fork, never the spec's shared `em`: that one's identity map
   * hands a second `getById` the entity the first one loaded, so a test reading
   * a card twice sees the first answer again.
   */
  const statusOf = async (taskId: string): Promise<string | undefined> =>
    (await taskDao.getById(taskId, orm.em.fork() as EntityManager))?.status;

  it('leaves a card whose run COMPLETED where it is, with no report written for the agent', async () => {
    // The agent moves its own card and writes its own report through
    // `update_task`. A run ending is not the task being finished, and the
    // thread's last message is not a report — it is whatever was said last.
    const task = await working();
    await itemDao.create({
      runId: 'run-1',
      seq: 1,
      kind: 'message',
      role: 'assistant',
      payload: '{"text":"let me check one more thing"}',
    });

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_progress');
    expect(stored?.report).toBeNull();
    expect(
      changes.filter((event) => event.taskId === task.id).at(-1),
    ).toMatchObject({ status: 'in_progress' });
  });

  it('leaves a card the agent already moved to review alone when its run completes', async () => {
    const task = await working();
    await tasks.update(task.id, { report: 'All done.' });
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await settleRun('run-1', 'completed');

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.report).toBe('All done.');
    // A card in review is NOT finished: its run is a chat the user continues.
    expect(changes.at(-1)?.reason).toBeUndefined();
  });

  /**
   * The card's RESULT — the pull requests the work produced.
   *
   * Read from the RUN on every projection rather than stored on the task, so
   * these pin the projection and not a column.
   */
  describe('the card’s pull requests', () => {
    const captured = {
      owner: 'geniro-io',
      repo: 'geniro-app',
      number: 110,
      url: 'https://github.com/geniro-io/geniro-app/pull/110',
      seq: 12,
    };

    it('carries the pull requests its run opened, on both read paths', async () => {
      const task = await working();
      await runDao.updateById('run-1', {
        pullRequests: JSON.stringify([captured]),
      });

      const [listed] = await tasks.listForProject(projectId);
      expect(listed?.pullRequests).toEqual([captured]);
      expect((await tasks.get(task.id)).pullRequests).toEqual([captured]);
    });

    it('answers empty for a card whose run has been deleted', async () => {
      const task = await working();
      await runDao.updateById('run-1', {
        pullRequests: JSON.stringify([captured]),
      });
      await runDao.hardDeleteIncludingSoftDeleted({ id: 'run-1' });

      expect((await tasks.get(task.id)).pullRequests).toEqual([]);
      expect((await tasks.listForProject(projectId))[0]?.pullRequests).toEqual(
        [],
      );
    });
  });

  it('marks the card failed when the run fails', async () => {
    // An agent whose process died cannot call a tool — this one is the board's.
    const task = await working();

    await settleRun('run-1', 'failed');

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('returns the card to todo when the user stops the run themselves', async () => {
    const task = await working();

    await settleRun('run-1', 'cancelled');

    // A cancel is the user stopping their own agent — they did not fail at
    // anything, and the card has to be startable again.
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
  });

  const stoppedAtOf = async (
    taskId: string,
  ): Promise<Date | null | undefined> =>
    (await taskDao.getById(taskId, orm.em.fork() as EntityManager))?.stoppedAt;

  it('marks the CARD as stopped when the user stops the run — the mark outlives the run moving on', async () => {
    // The run's own `cancelled` was the only record of the Stop, and the user
    // typing into the thread moved the run to `running` and then `completed` —
    // at which point the armed autopilot took the card for waiting work and
    // re-sent its whole brief.
    const task = await working();

    await settleRun('run-1', 'cancelled');

    expect(await stoppedAtOf(task.id)).toBeInstanceOf(Date);
  });

  it('marks nothing stopped when the user stops a FOLLOW-UP turn of a card in review', async () => {
    // Stopping one turn of a reviewed card's thread stops no task — marked, the
    // armed autopilot skipped the card long after the thread finished.
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await settleRun('run-1', 'cancelled');

    expect(await stoppedAtOf(task.id)).toBeNull();
  });

  it('marks nothing stopped when the run ends any other way', async () => {
    const failed = await working('run-f');
    const completed = await working('run-c');

    await settleRun('run-f', 'failed');
    await settleRun('run-c', 'completed');

    expect(await stoppedAtOf(failed.id)).toBeNull();
    expect(await stoppedAtOf(completed.id)).toBeNull();
  });

  it('does not mark a reviewed card failed when a follow-up turn fails', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await settleRun('run-1', 'failed');

    expect(await statusOf(task.id)).toBe('in_review');
  });

  it('leaves a card alone when it has moved on to a different run', async () => {
    const task = await working('run-old');
    // The card was re-started; an older run settling must not drag it back.
    await tasks.update(task.id, { runId: 'run-new' });

    await settleRun('run-old', 'failed');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('does nothing on a status the run has not settled into', async () => {
    const task = await working();

    await service.settle('run-1', 'running');

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('reconciles a run that failed while the app was closed', async () => {
    const task = await working();
    // The settle happened with no window open, so nothing was broadcast: the
    // run row is terminal while the card still reads as working.
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }

    const board = await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
    expect(board.find((row) => row.id === task.id)?.status).toBe('failed');
  });

  it('reconciles every project at once when the board names none', async () => {
    const task = await working();
    // FAILED rather than completed, and that is the rule rather than the
    // fixture: a run finishing moves nothing — the agent reports and moves its
    // own card through `update_task` — while a dead process can call no tool,
    // so the reconcile is the only thing that can answer for it.
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }

    const board = await service.reconcileProject(null);

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
    expect(board.find((row) => row.id === task.id)?.status).toBe('failed');
  });

  it('leaves a still-running card alone when a board reconciles', async () => {
    const task = await working();

    await service.reconcileProject(projectId);

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  it('settles from the LIVE bus', async () => {
    const task = await working();
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }
    service.onModuleInit();

    bus.publishRunStatus({
      runId: 'run-1',
      status: 'failed',
      at: new Date().toISOString(),
    });
    // The subscriber detaches its work, so yield a full turn of the event
    // loop — every await under it resolves synchronously (better-sqlite3), so
    // one macrotask is enough for the whole chain.
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.status).toBe('failed');
  });

  it('ignores an activity announce, which asserts nothing about settling', async () => {
    const task = await working();
    service.onModuleInit();

    // A null status says only what the run is DOING.
    bus.publishRunStatus({
      runId: 'run-1',
      status: null,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  /** Announce a status for run-1 and let the detached subscriber finish. */
  const announce = async (status: RunStatus): Promise<void> => {
    bus.publishRunStatus({
      runId: 'run-1',
      status,
      at: new Date().toISOString(),
    });
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('puts a FAILED card back to work when its run works again', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });
    service.onModuleInit();

    // The user carried the conversation on in the chat itself.
    await announce('running');
    expect(await statusOf(task.id)).toBe('in_progress');

    // And a clean finish leaves it to the agent to move on from there.
    await announce('completed');
    expect(await statusOf(task.id)).toBe('in_progress');
  });

  it('leaves a card in review alone when its run works again', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    service.onModuleInit();

    await announce('running');

    expect(await statusOf(task.id)).toBe('in_review');
  });

  it('does not revive a failed card that has moved on to another run', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });
    await tasks.update(task.id, { runId: 'run-2' });
    service.onModuleInit();

    await announce('running');

    expect(await statusOf(task.id)).toBe('failed');
  });

  describe('announcing a card whose own run starts or settles in place', () => {
    const announcedFor = (taskId: string): TaskChangedEvent[] =>
      changes.filter((event) => event.taskId === taskId);

    it('announces a card in review when its run works again and when it settles, with no reason', async () => {
      const task = await working();
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
      service.onModuleInit();
      changes.length = 0;

      await announce('running');
      await announce('completed');

      expect(announcedFor(task.id)).toEqual([
        { taskId: task.id, projectId, status: 'in_review' },
        { taskId: task.id, projectId, status: 'in_review' },
      ]);
      expect(await statusOf(task.id)).toBe('in_review');
    });

    it('announces a worked card whose run completed, though nothing moved it', async () => {
      const task = await working();
      service.onModuleInit();
      changes.length = 0;

      await announce('completed');

      expect(announcedFor(task.id)).toEqual([
        { taskId: task.id, projectId, status: 'in_progress' },
      ]);
    });

    it('lets the move be the one announce when the ending moves the card', async () => {
      const task = await working();
      service.onModuleInit();
      changes.length = 0;

      await announce('failed');

      expect(announcedFor(task.id)).toEqual([
        { taskId: task.id, projectId, status: 'failed' },
      ]);
    });

    it('announces nothing for a run its card has moved on from', async () => {
      const task = await working();
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
      await tasks.update(task.id, { runId: 'run-2' });
      service.onModuleInit();
      changes.length = 0;

      await announce('running');
      await announce('completed');

      expect(announcedFor(task.id)).toEqual([]);
    });

    it('announces nothing from a reconcile, which every board load and task change runs', async () => {
      const task = await working();
      const run = await runDao.getById('run-1');
      if (run) {
        run.status = 'completed';
        await em.flush();
      }
      changes.length = 0;

      await service.settle('run-1', 'completed', 'reconcile');

      expect(announcedFor(task.id)).toEqual([]);
    });
  });

  it('one contested card does not cost the board its whole listing', async () => {
    const task = await working();
    const other = await tasks.create({ projectId, title: 'untouched' });
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = 'failed';
      await em.flush();
    }
    // `settle` ends in a compare-and-set that throws when the row moved since
    // it was read — this is that throw, driven directly. `reconcileTasks` is
    // the board's ONLY listing call, so without the per-card catch this one
    // card takes every other one with it.
    const moved = vi
      .spyOn(tasks, 'moveStatus')
      .mockRejectedValueOnce(new Error('TASK_STATUS_CONFLICT'));

    const board = await service.reconcileProject(projectId);

    expect(moved).toHaveBeenCalledTimes(1);
    expect(board.map((r) => r.id)).toEqual(
      expect.arrayContaining([task.id, other.id]),
    );
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  // ── The failure breaker ────────────────────────────────────────────────────

  /**
   * Read the project back through a FRESH fork — `settle` writes on its own
   * fork, so the shared EM's identity map still holds the old row.
   */
  const freshProject = async (): Promise<Project> => {
    const fork = orm.em.fork() as EntityManager;
    return (await new ProjectDao(fork).getById(projectId, fork)) as Project;
  };

  const streak = async (): Promise<number> =>
    (await freshProject()).autopilotFailureStreak;

  const armProject = async (patch: {
    enabled?: boolean;
    streak?: number;
  }): Promise<void> => {
    const project = await projectDao.getById(projectId, em);
    if (patch.enabled !== undefined) {
      (project as Project).autopilotEnabled = patch.enabled;
    }
    if (patch.streak !== undefined) {
      (project as Project).autopilotFailureStreak = patch.streak;
    }
    await em.flush();
  };

  it('counts a failed run against an armed project, and announces the project changed', async () => {
    await armProject({ enabled: true });
    const task = await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(1);
    expect((await taskDao.getById(task.id))?.status).toBe('failed');
    expect(projectChanges).toEqual([projectId]);
  });

  it('opens the breaker at the threshold, and not one failure sooner', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD - 2,
    });

    await working('run-a');
    await service.settle('run-a', 'failed');
    expect(isBreakerOpen(await freshProject())).toBe(false);

    await working('run-b');
    await service.settle('run-b', 'failed');
    expect(await streak()).toBe(PROJECT_FAILURE_BREAKER_THRESHOLD);
    expect(isBreakerOpen(await freshProject())).toBe(true);
  });

  it('clears the streak on a success, and announces the project changed', async () => {
    await armProject({
      enabled: true,
      streak: PROJECT_FAILURE_BREAKER_THRESHOLD,
    });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
    expect(projectChanges).toEqual([projectId]);
  });

  // The agent routinely moves its card to review BEFORE its turn ends, so a
  // success has to clear the streak whatever column the card reached.
  it('clears the streak on a success after the agent already moved the card', async () => {
    await armProject({ enabled: true, streak: 2 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  // `update_task` lets the agent put its own card in `failed`, and the turn in
  // which it says so then ends cleanly. Read as a completion, that CLEARED the
  // streak, so a board whose every card its agent gave up on never tripped.
  it('counts a card its AGENT moved to failed as a failure, though the run completed', async () => {
    await armProject({ enabled: true, streak: 1 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(2);
    expect(await statusOf(task.id)).toBe('failed');
  });

  it('opens the breaker on agent-declared failures alone', async () => {
    await armProject({ enabled: true, streak: 0 });
    for (let index = 0; index < PROJECT_FAILURE_BREAKER_THRESHOLD; index += 1) {
      const task = await working(`run-${index}`);
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });
      await service.settle(`run-${index}`, 'completed');
    }

    expect(isBreakerOpen(await freshProject())).toBe(true);
  });

  it('neither counts nor clears an agent-declared failure on a disarmed project', async () => {
    await armProject({ enabled: false, streak: 2 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'failed' });

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(2);
  });

  it('clears the streak on a success even while disarmed', async () => {
    await armProject({ enabled: false, streak: 2 });
    await working();

    await service.settle('run-1', 'completed');

    expect(await streak()).toBe(0);
  });

  it('does not count a failure on a disarmed project', async () => {
    await armProject({ enabled: false, streak: 0 });
    await working();

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(0);
  });

  // A follow-up turn failing in a thread already in review is not the task
  // failing, and the streak is a claim about unattended work.
  it('does not count a failure on a card that was no longer being worked', async () => {
    await armProject({ enabled: true, streak: 0 });
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });

    await service.settle('run-1', 'failed');

    expect(await streak()).toBe(0);
  });

  // ── A spent usage limit ────────────────────────────────────────────────────

  const NAMED_RESET = Date.UTC(2099, 11, 1, 16, 0);
  const LIMIT_WITH_RESET =
    "You've hit your weekly limit · resets Dec 1, 2099 at 4pm (UTC)";

  const failWith = async (message: string, seq = 1): Promise<void> => {
    await itemDao.create({
      runId: 'run-1',
      seq,
      kind: 'error',
      role: null,
      payload: JSON.stringify({ message }),
    });
    await service.settle('run-1', 'failed');
  };

  it('holds an armed project until the reset a usage limit names, without counting a failure', async () => {
    await armProject({ enabled: true, streak: 1 });
    await working();

    await failWith(LIMIT_WITH_RESET);

    const project = await freshProject();
    expect(project.autopilotFailureStreak).toBe(1);
    expect(project.autopilotLimitUntil?.getTime()).toBe(
      NAMED_RESET + AUTOPILOT_LIMIT_RESET_GRACE_MS,
    );
    expect(projectChanges).toContain(projectId);
  });

  it('never opens the breaker on a limit met again and again', async () => {
    await armProject({ enabled: true });
    await working();

    for (const seq of [1, 2, 3, 4, 5]) {
      await failWith(LIMIT_WITH_RESET, seq);
    }

    expect(await streak()).toBe(0);
    expect(isBreakerOpen(await freshProject())).toBe(false);
  });

  it('holds for the fallback window when a limit names no reset', async () => {
    await armProject({ enabled: true });
    await working();
    const before = Date.now();

    await failWith("You've hit your usage limit");

    const until = (await freshProject()).autopilotLimitUntil?.getTime() ?? 0;
    expect(until).toBeGreaterThanOrEqual(before + AUTOPILOT_LIMIT_FALLBACK_MS);
    expect(until).toBeLessThanOrEqual(Date.now() + AUTOPILOT_LIMIT_FALLBACK_MS);
  });

  it('keeps the later of two limits', async () => {
    await armProject({ enabled: true });
    await working();
    await failWith(LIMIT_WITH_RESET, 1);

    await failWith("You've hit your usage limit", 2);

    expect((await freshProject()).autopilotLimitUntil?.getTime()).toBe(
      NAMED_RESET + AUTOPILOT_LIMIT_RESET_GRACE_MS,
    );
  });

  it('counts any other failure and holds nothing', async () => {
    await armProject({ enabled: true });
    await working();

    await failWith('the CLI crashed');

    const project = await freshProject();
    expect(project.autopilotFailureStreak).toBe(1);
    expect(project.autopilotLimitUntil).toBeNull();
  });

  it('holds nothing on a disarmed project', async () => {
    await armProject({ enabled: false });
    await working();

    await failWith(LIMIT_WITH_RESET);

    expect((await freshProject()).autopilotLimitUntil).toBeNull();
  });

  it('ends the hold on a completed run', async () => {
    await armProject({ enabled: true });
    const task = await working();
    await failWith(LIMIT_WITH_RESET);
    await tasks.moveStatus(task.id, { from: 'failed', to: 'in_progress' });

    await settleRun('run-1', 'completed');

    expect((await freshProject()).autopilotLimitUntil).toBeNull();
  });

  it('reads a team run by any CLI, and a chat by its own', async () => {
    await armProject({ enabled: true });
    await working();
    const run = await runDao.getById('run-1');
    (run as Run).agentKind = 'cursor-agent';
    await em.flush();

    await failWith(LIMIT_WITH_RESET, 1);
    expect(await streak()).toBe(1);
    expect((await freshProject()).autopilotLimitUntil).toBeNull();

    (run as Run).agentKind = null;
    await em.flush();

    await failWith(LIMIT_WITH_RESET, 2);
    expect(await streak()).toBe(1);
    expect((await freshProject()).autopilotLimitUntil?.getTime()).toBe(
      NAMED_RESET + AUTOPILOT_LIMIT_RESET_GRACE_MS,
    );
  });

  it('holds instead of counting when a reconcile settles the limit', async () => {
    await armProject({ enabled: true });
    const task = await working();
    await itemDao.create({
      runId: 'run-1',
      seq: 1,
      kind: 'error',
      role: null,
      payload: JSON.stringify({ message: LIMIT_WITH_RESET }),
    });

    await service.settle('run-1', 'failed', 'reconcile');

    expect(await statusOf(task.id)).toBe('failed');
    expect(await streak()).toBe(0);
    expect((await freshProject()).autopilotLimitUntil?.getTime()).toBe(
      NAMED_RESET + AUTOPILOT_LIMIT_RESET_GRACE_MS,
    );
  });

  /** Write `status` onto run-1's row, as a settle nobody announced leaves it. */
  const settleRowOnly = async (status: RunStatus): Promise<void> => {
    const run = await runDao.getById('run-1');
    if (run) {
      run.status = status;
      await em.flush();
    }
  };

  // A completed run never moves its card — the agent moves it — so the card
  // stays in `in_progress` and every board load reconciles it again. Counting
  // there zeroed the streak on each load, and an open board kept the breaker
  // from ever tripping while other cards failed.
  it('does not clear the streak each time a board reconciles a completed run', async () => {
    await armProject({ enabled: true, streak: 2 });
    const task = await working();
    await settleRowOnly('completed');

    await service.reconcileProject(projectId);
    await service.reconcileProject(null);

    expect(await streak()).toBe(2);
    expect(await statusOf(task.id)).toBe('in_progress');
  });

  // The ending the reconcile IS the one to act on — a failure no event
  // announced — still counts, once, however often the board loads after it.
  it('counts a failure only the reconcile saw, and counts it once', async () => {
    await armProject({ enabled: true, streak: 0 });
    const task = await working();
    await settleRowOnly('failed');

    await service.reconcileProject(projectId);
    await service.reconcileProject(projectId);

    expect(await streak()).toBe(1);
    expect(await statusOf(task.id)).toBe('failed');
  });

  // A Run press or a Follow up moves the card to `in_progress` BEFORE its run
  // is working, and until then the card names a settled run — the one being
  // continued, or the previous one. The board reconciles on that very move.
  it('leaves a card alone while a run start for it is in flight', async () => {
    await armProject({ enabled: true, streak: 0 });
    const task = await working();
    await settleRowOnly('failed');
    expect(tasks.claimStart(task.id)).toBe(true);

    await service.reconcileProject(projectId);

    expect(await statusOf(task.id)).toBe('in_progress');
    expect(await streak()).toBe(0);

    // And once the start is over, the reconcile answers for it again.
    tasks.releaseStart(task.id);
    await service.reconcileProject(projectId);

    expect(await statusOf(task.id)).toBe('failed');
  });

  // The reconcile the start held off is OWED, not dropped. A press from
  // `in_progress` (a card the board had not caught up on yet) that then fails
  // moves the card from `in_progress` to `in_progress`: no event, so nothing
  // else would settle it until the board reloads — its slot held, its failure
  // uncounted.
  it('settles the card once the start lets go, when a reconcile was held off during it', async () => {
    service.onModuleInit();
    await armProject({ enabled: true, streak: 0 });
    const task = await working();
    await settleRowOnly('failed');
    expect(tasks.claimStart(task.id)).toBe(true);
    await service.reconcileProject(projectId);
    expect(await statusOf(task.id)).toBe('in_progress');

    tasks.releaseStart(task.id);

    await vi.waitFor(async () => {
      expect(await statusOf(task.id)).toBe('failed');
    });
    expect(await streak()).toBe(1);
  });

  // A refused move is someone else having moved the card first — a second
  // board reconciling the same row, or the agent itself — and whoever moved it
  // is the one that counts it. Counting before the move counted it twice.
  it('does not count a failure whose card the reconcile could not move', async () => {
    await armProject({ enabled: true, streak: 0 });
    await working();
    await settleRowOnly('failed');
    const moved = vi
      .spyOn(tasks, 'moveStatus')
      .mockRejectedValueOnce(new Error('TASK_STATUS_CONFLICT'));

    await service.reconcileProject(projectId);

    expect(moved).toHaveBeenCalledTimes(1);
    expect(await streak()).toBe(0);
    moved.mockRestore();
  });

  it('leaves the streak alone when the user cancels', async () => {
    await armProject({ enabled: true, streak: 2 });
    await working();

    await service.settle('run-1', 'cancelled');

    expect(await streak()).toBe(2);
  });

  /**
   * A run the DAEMON stopped under — the app quit mid-turn, or the daemon was
   * killed — is closed at the next boot `failed`, with an `error` row carrying
   * `interrupted: true` (`ChatService.reconcileOrphanedRuns` and its executor
   * twin). The agent failed at nothing and the user stopped nothing, so the
   * card goes back to be picked up again, uncounted.
   */
  describe('a run the daemon interrupted', () => {
    let seq = 0;
    beforeEach(() => {
      seq = 0;
    });
    const row = (kind: string, payload: unknown, role?: string) =>
      itemDao.create({
        runId: 'run-1',
        seq: (seq += 1),
        kind: kind as Item['kind'],
        role: role ?? null,
        payload: JSON.stringify(payload),
      });
    /** What the boot reconcile writes for a chat run it closes. */
    const interruptedAtBoot = async (
      interruptCause: string | null = 'quit',
    ): Promise<void> => {
      await row('message', { text: 'working on it' }, 'assistant');
      await row('error', {
        message: 'run interrupted',
        interrupted: true,
        ...(interruptCause === null ? {} : { interruptCause }),
      });
      await row('unanswerable', { id: 'req-1' });
    };
    const markOf = async (
      taskId: string,
    ): Promise<{ stoppedAt: Date | null; interruptedBy: string | null }> => {
      const task = await taskDao.getById(
        taskId,
        orm.em.fork() as EntityManager,
      );
      return {
        stoppedAt: task?.stoppedAt ?? null,
        interruptedBy: task?.interruptedBy ?? null,
      };
    };

    it.each(['crash', 'unknown'] as const)(
      'holds the card for a person after a %s — back in intake, but stopped',
      async (cause) => {
        // The agent may have been halfway through an edit; the autopilot
        // continuing the card would re-send its brief over what it left.
        await armProject({ enabled: true, streak: 2 });
        const task = await working();
        await interruptedAtBoot(cause);

        await settleRun('run-1', 'failed');

        expect(await statusOf(task.id)).toBe('todo');
        const mark = await markOf(task.id);
        expect(mark.stoppedAt).toBeInstanceOf(Date);
        expect(mark.interruptedBy).toBe(cause);
        // Still not a failure the agent made.
        expect(await streak()).toBe(2);
      },
    );

    it.each(['quit', 'self-update', 'restart'] as const)(
      'leaves the card to the autopilot after a %s — the app stopped on purpose',
      async (cause) => {
        await armProject({ enabled: true, streak: 0 });
        const task = await working();
        await interruptedAtBoot(cause);

        await settleRun('run-1', 'failed');

        expect(await statusOf(task.id)).toBe('todo');
        expect(await markOf(task.id)).toEqual({
          stoppedAt: null,
          interruptedBy: null,
        });
      },
    );

    it('reads a row that names no cause as unknown, and holds the card', async () => {
      await armProject({ enabled: true, streak: 0 });
      const task = await working();
      await interruptedAtBoot(null);

      await settleRun('run-1', 'failed');

      expect((await markOf(task.id)).interruptedBy).toBe('unknown');
    });

    it('holds nothing for a card that was not being worked', async () => {
      // A follow-up turn of a card in review cut off by a crash stops no task.
      const task = await working();
      await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
      await interruptedAtBoot('crash');

      await settleRun('run-1', 'failed');

      expect((await markOf(task.id)).stoppedAt).toBeNull();
    });

    it('goes back to the intake column, uncounted, when the boot reconcile announces it', async () => {
      await armProject({ enabled: true, streak: 2 });
      const task = await working();
      await interruptedAtBoot();

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('todo');
      // Neither a fault to count nor a success to clear one.
      expect(await streak()).toBe(2);
    });

    it('goes back the same way when a board reconciles it later', async () => {
      await armProject({ enabled: true, streak: 2 });
      const task = await working();
      await interruptedAtBoot();
      await settleRowOnly('failed');

      const board = await service.reconcileProject(projectId);

      expect(await statusOf(task.id)).toBe('todo');
      expect(board.find((card) => card.id === task.id)?.status).toBe('todo');
      expect(await streak()).toBe(2);
    });

    it('reads past everything the team reconcile and the boot sweeps write after it', async () => {
      await armProject({ enabled: true, streak: 0 });
      const task = await working();
      await interruptedAtBoot();
      await row('status', { nodeId: 'a', status: 'failed' });
      await row('call_result', { callId: 'call-1', status: 'error' });
      await row('subagent_info', { id: 'toolu_1', backgroundOpen: false });
      await row('shell_info', { toolCallId: 'toolu_2', workId: 'bash_1' });

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('todo');
      expect(await streak()).toBe(0);
    });

    it('is a real failure once the thread has moved on from the interruption', async () => {
      // Continued after the interruption, and the continuation failed — here
      // the way a turn that could not START fails, writing the status and no
      // row of its own. So the newest `error` is still the interruption's, and
      // it is not the question: the run's LAST word is the user's message.
      await armProject({ enabled: true, streak: 0 });
      const task = await working();
      await interruptedAtBoot();
      await row('message', { text: 'carry on' }, 'user');

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('failed');
      expect(await streak()).toBe(1);
    });

    it('is a real failure when the last error is an ordinary one', async () => {
      await armProject({ enabled: true, streak: 0 });
      const task = await working();
      await row('error', { message: 'boom', interrupted: false });

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('failed');
      expect(await streak()).toBe(1);
    });

    it('goes to the column the project’s autopilot picks work up from', async () => {
      const project = await projectDao.getById(projectId, em);
      (project as Project).autopilotIntakeStatus = 'backlog';
      await em.flush();
      const task = await working();
      await interruptedAtBoot();

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('backlog');
    });

    it('goes to To do when the intake column is one a card cannot wait in', async () => {
      // Sent to Done it would be announced FINISHED and its worktree collected.
      const project = await projectDao.getById(projectId, em);
      (project as Project).autopilotIntakeStatus = 'done';
      await em.flush();
      const task = await working();
      await interruptedAtBoot();

      await settleRun('run-1', 'failed');

      expect(await statusOf(task.id)).toBe('todo');
      expect(changes.at(-1)?.reason).toBeUndefined();
    });
  });

  it('gives NO reason for a move to Done while the agent is still working', async () => {
    const task = await working();

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    // Were it to carry the reason, the renderer would remove the worktree of
    // an agent still working in it.
    expect(changes.at(-1)?.reason).toBeUndefined();
  });

  it('marks the work finished once the run settles under a card already in Done', async () => {
    const task = await working();
    // The agent's own `update_task` reaches `moveStatus` exactly as a drag does.
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    await settleRun('run-1', 'completed');

    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      status: 'done',
      reason: 'work-finished',
    });
    expect((await taskDao.getById(task.id))?.status).toBe('done');
  });

  it('waits for a monitor still running when the run settles under a Done card', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    live.hold('run-1', 'monitor');

    await settleRun('run-1', 'completed');
    expect(changes.at(-1)?.reason).toBeUndefined();

    live.release('run-1');
    await vi.waitFor(() =>
      expect(changes.at(-1)).toMatchObject({
        taskId: task.id,
        status: 'done',
        reason: 'work-finished',
      }),
    );
  });

  it('marks the work finished when a settled card is moved to Done', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    await settleRun('run-1', 'completed');

    await tasks.moveStatus(task.id, { from: 'in_review', to: 'done' });

    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      status: 'done',
      reason: 'work-finished',
    });
  });

  it('ends the run’s processes at once when the card’s work is finished', async () => {
    // Its worktree is collected next: nothing may go on running in it.
    const task = await working();
    service.onModuleInit();
    await settleRun('run-1', 'completed');
    expect(sessions.closeFinishedRun).not.toHaveBeenCalled();

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    await vi.waitFor(() =>
      expect(sessions.closeFinishedRun).toHaveBeenCalledWith('run-1'),
    );
  });

  it('reaps what a finished card’s agents left running, once its CLIs have gone', async () => {
    // A dev server or watcher the agent detached is not in the CLI's process
    // group, so the graceful close does not reach it. Run during the close, the
    // reap would signal a CLI still finishing on its own.
    const task = await working();
    let closed = (): void => {};
    sessions.closeFinishedRun.mockReturnValue(
      new Promise<void>((resolve) => {
        closed = resolve;
      }),
    );
    service.onModuleInit();
    await settleRun('run-1', 'completed');

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    await vi.waitFor(() =>
      expect(sessions.closeFinishedRun).toHaveBeenCalled(),
    );
    expect(teardown.reapDetached).not.toHaveBeenCalled();

    closed();
    await vi.waitFor(() =>
      expect(teardown.reapDetached).toHaveBeenCalledWith('run-1'),
    );
  });

  it('leaves live work alone: a monitor holds the card, and its run ends only once it stops', async () => {
    // `RunLiveWork` withholds `work-finished` while a monitor runs, so this
    // card does not stop one at Done; it ends with the finish it held back.
    const task = await working();
    service.onModuleInit();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    live.hold('run-1', 'monitor');

    await settleRun('run-1', 'completed');
    expect(sessions.closeFinishedRun).not.toHaveBeenCalled();
    expect(teardown.reapDetached).not.toHaveBeenCalled();

    live.release('run-1');
    await vi.waitFor(() =>
      expect(teardown.reapDetached).toHaveBeenCalledWith('run-1'),
    );
    expect(changes.at(-1)).toMatchObject({
      taskId: task.id,
      reason: 'work-finished',
    });
  });

  it('leaves a finished card’s run alone once it is archived — its teardown reaps it once', async () => {
    const task = await working();
    service.onModuleInit();
    await settleRun('run-1', 'completed');
    const run = await runDao.getById('run-1');
    run!.archivedAt = new Date();
    await em.flush();

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    await flushSettle();

    expect(sessions.closeFinishedRun).not.toHaveBeenCalled();
    expect(teardown.reapDetached).not.toHaveBeenCalled();
  });

  it('closes nothing when the teardown says an archive or delete already ended the run', async () => {
    const task = await working();
    teardown.hasEnded.mockReturnValue(true);
    service.onModuleInit();
    await settleRun('run-1', 'completed');

    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    await vi.waitFor(() =>
      expect(teardown.hasEnded).toHaveBeenCalledWith('run-1'),
    );
    await flushSettle();

    expect(sessions.closeFinishedRun).not.toHaveBeenCalled();
    expect(teardown.reapDetached).not.toHaveBeenCalled();
  });

  it('ends nothing when the card is picked back up between the event and its handling', async () => {
    // A Run press or a Follow up landing after `work-finished` was announced:
    // the close would land on the turn the user just started, and a close with
    // a turn in flight signals it at once.
    const task = await working();
    await settleRun('run-1', 'completed');
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    service.onModuleInit();
    const announce = async (): Promise<void> => {
      taskEvents.publishTaskChanged({
        taskId: task.id,
        projectId,
        status: 'done',
        reason: 'work-finished',
      });
      await flushSettle();
    };

    // A start in flight for the card.
    expect(tasks.claimStart(task.id)).toBe(true);
    await announce();
    tasks.releaseStart(task.id);
    // Live work started since the event.
    live.hold('run-1', 'monitor');
    await announce();
    live.release('run-1');
    // Its run working again.
    const run = await runDao.getById('run-1');
    run!.status = 'running';
    await em.flush();
    await announce();
    // Its card back in progress (a Follow up's move, before its run is).
    run!.status = 'completed';
    await em.flush();
    await tasks.moveStatus(task.id, { from: 'done', to: 'in_progress' });
    await announce();

    expect(sessions.closeFinishedRun).not.toHaveBeenCalled();
    expect(teardown.reapDetached).not.toHaveBeenCalled();

    // Done again with its run settled: finished after all.
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'done' });
    await vi.waitFor(() =>
      expect(teardown.reapDetached).toHaveBeenCalledWith('run-1'),
    );
    expect(sessions.closeFinishedRun).toHaveBeenCalledTimes(1);
  });

  it('releases a card whose run was deleted, keeping the report that is the card’s own', async () => {
    const task = await working();
    await tasks.update(task.id, { report: 'Half done — see the branch.' });
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    // Left holding the run, the card sits in `in_progress` for good with Run
    // disabled — the button asks the RUN, and a missing run is not a settled
    // one.
    expect(stored?.runId).toBeNull();
    expect(stored?.status).toBe('todo');
    expect(stored?.report).toBe('Half done — see the branch.');
  });

  it('leaves a REVIEWED card in its column when its run is deleted', async () => {
    const task = await working();
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'in_review' });
    service.onModuleInit();

    bus.publishRunDeleted('run-1');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.runId).toBeNull();
  });

  it('ignores a deleted run no card ever held', async () => {
    const task = await working();
    service.onModuleInit();

    bus.publishRunDeleted('some-other-run');
    await new Promise((resolve) => setImmediate(resolve));

    expect((await taskDao.getById(task.id))?.runId).toBe('run-1');
  });
});
