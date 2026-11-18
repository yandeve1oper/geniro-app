import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { RunDao } from '../../agents/dao/run.dao';
import { Run } from '../../runs/entity/run.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../projects.types';
import { ProjectQueueService } from './project-queue.service';

/**
 * Real database, real DAOs. What is under test is a count taken over rows —
 * how many of a project's cards hold a run that is still live — so faking the
 * DAOs would assert the arrangement and prove nothing about the answer.
 *
 * `readRaw` no longer decides which waiting cards may actually start —
 * `TaskQueueService.read` (`apps/daemon/src/v1/tasks/services/task-queue.service.spec.ts`)
 * does that now, joining this service's raw read against the team
 * library. This spec covers only the counts and rows `readRaw` itself
 * computes.
 */
describe('ProjectQueueService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: ProjectQueueService;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let folder: string;
  let projectId: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-queue-'));
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run],
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
    rmSync(folder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    runDao = new RunDao(em);
    service = new ProjectQueueService(em, projectDao, taskDao, runDao);

    const project = await projectDao.create({
      name: 'board',
      folder,
      agentKind: 'claude',
      autopilotEnabled: true,
      autopilotIntakeStatus: 'todo',
      autopilotMaxConcurrent: 2,
    });
    await em.flush();
    projectId = project.id;
  });

  async function addTask(
    title: string,
    status: Task['status'],
    position: number,
    runId: string | null = null,
  ): Promise<Task> {
    const task = await taskDao.create({
      projectId,
      title,
      status,
      position,
      runId,
    });
    await em.flush();
    return task;
  }

  async function addRun(
    status: Run['status'],
    agentKind: Run['agentKind'] = 'claude',
  ): Promise<Run> {
    const run = await runDao.create({ status, agentKind });
    await em.flush();
    return run;
  }

  async function arm(patch: Partial<Project>): Promise<void> {
    const project = await projectDao.getById(projectId, em);
    Object.assign(project as Project, patch);
    await em.flush();
  }

  it('lists the intake column, unfiltered, and reports its count', async () => {
    await addTask('second', 'todo', 1);
    await addTask('first', 'todo', 0);
    await addTask('not intake', 'backlog', 0);

    const queue = await service.readRaw(projectId);

    // `listForProject`'s own order (status asc, position asc) already puts a
    // single-status subset in position order — `readRaw` does no sort of its
    // own on top of it.
    expect(queue.waitingTasks.map((task) => task.title)).toEqual([
      'first',
      'second',
    ]);
    expect(queue.waiting).toBe(2);
    expect(queue.running).toBe(0);
    expect(queue.cap).toBe(2);
  });

  // The handout is what the conductor cuts a worktree from, and it runs in
  // another process with only the raw read in hand — so the project's own
  // folder rides the raw answer directly (unresolved), and it is
  // `TaskQueueService`'s `toQueued` that resolves the inheritance per card.
  it('carries the project’s own folder, for the splitter to fall back to', async () => {
    const queue = await service.readRaw(projectId);

    expect(queue.folder).toBe(folder);
  });

  // What the splitter needs to resolve a card's run target: the project's own
  // run-configuration defaults, passed through unresolved.
  it('carries the project’s own run-configuration fields', async () => {
    await arm({
      agentKind: null,
      model: null,
      teamSlug: 'dev-team',
    });

    const queue = await service.readRaw(projectId);

    expect(queue.agentKind).toBeNull();
    expect(queue.teamSlug).toBe('dev-team');
  });

  it('narrows the free-slot count to what the cap allows', async () => {
    const run = await addRun('running');
    await addTask('working', 'in_progress', 0, run.id);
    await addTask('a', 'todo', 1);
    await addTask('b', 'todo', 2);

    const queue = await service.readRaw(projectId);

    expect(queue.running).toBe(1);
    // Two waiting, a cap of two, one slot taken — one slot free, not two.
    expect(queue.waiting).toBe(2);
    expect(queue.freeSlots).toBe(1);
    expect(queue.handOutWork).toBe(true);
  });

  describe('the cards that are actually working', () => {
    it('names each one, its run and the CLI running it', async () => {
      const run = await addRun('running', 'cursor-agent');
      const task = await addTask('working', 'in_progress', 0, run.id);
      await addTask('waiting', 'todo', 1);

      const queue = await service.readRaw(projectId);

      expect(queue.active).toEqual([
        { id: task.id, runId: run.id, agentKind: 'cursor-agent' },
      ]);
    });

    it('is the same set the count is taken from', async () => {
      // One query answering both is what stops a card drawn with a spinner
      // while the header counts one fewer.
      const run = await addRun('running');
      await addTask('working', 'in_progress', 0, run.id);
      await addTask('finished', 'in_review', 1, (await addRun('completed')).id);

      const queue = await service.readRaw(projectId);

      expect(queue.running).toBe(queue.active.length);
      expect(queue.active).toHaveLength(1);
    });

    it('leaves out a card whose run is over but still recorded', async () => {
      // `runId !== null` is not liveness — the settled report is read through
      // exactly that id, so it stays put after the agent has gone.
      const run = await addRun('completed');
      await addTask('reported', 'in_review', 0, run.id);

      const queue = await service.readRaw(projectId);

      expect(queue.active).toEqual([]);
    });
  });

  // The reason the count asks the RUNS and not the `in_progress` column: a card
  // dragged back to `todo` by hand still points at the agent working it, and a
  // count that believed the column would hand out a slot that is not free.
  it('counts a live run whose card was dragged out of in_progress', async () => {
    const run = await addRun('running');
    await addTask('dragged back', 'todo', 0, run.id);
    await addTask('waiting', 'todo', 1);

    const queue = await service.readRaw(projectId);

    expect(queue.running).toBe(1);
  });

  // A run the daemon's own shutdown cut off is closed `failed`, never
  // `cancelled`, and its card is put back in the intake column to be picked up
  // again — listed here, the autopilot would leave it alone as one the user
  // stopped. (That such a run is never written `cancelled` is pinned where it
  // is decided, in `ChatService` and `TeamExecutorService`.)
  it('names as stopped only a card whose run was cancelled, not one closed failed', async () => {
    const stopped = await addTask(
      'stopped',
      'todo',
      0,
      (await addRun('cancelled')).id,
    );
    await addTask('interrupted', 'todo', 1, (await addRun('failed')).id);

    const queue = await service.readRaw(projectId);

    expect(queue.stoppedTaskIds).toEqual([stopped.id]);
    expect(queue.waiting).toBe(2);
  });

  it('names as stopped a card the settle MARKED, after its run has moved past `cancelled`', async () => {
    // The user typed into the stopped thread; its run now reads `completed`.
    // The card's own mark is what still says they stopped it — once, however
    // the two sources overlap.
    const carriedOn = await addTask(
      'carried on',
      'todo',
      0,
      (await addRun('completed')).id,
    );
    await taskDao.setStoppedAt(carriedOn.id, new Date(), em);
    const bothSay = await addTask(
      'both say so',
      'todo',
      1,
      (await addRun('cancelled')).id,
    );
    await taskDao.setStoppedAt(bothSay.id, new Date(), em);

    const queue = await service.readRaw(projectId);

    expect([...queue.stoppedTaskIds].sort()).toEqual(
      [carriedOn.id, bothSay.id].sort(),
    );
  });

  it('does not count a settled run — a card that has been through review runs again', async () => {
    const run = await addRun('completed');
    await addTask('reviewed', 'in_review', 0, run.id);
    await addTask('next', 'todo', 1);

    const queue = await service.readRaw(projectId);

    expect(queue.running).toBe(0);
    // Only 'next' sits in the intake column — 'reviewed' moved to in_review.
    expect(queue.waitingTasks.map((task) => task.title)).toEqual(['next']);
  });

  it('hands out nothing while the project is disarmed, and still reports the column', async () => {
    await arm({ autopilotEnabled: false });
    await addTask('a', 'todo', 0);

    const queue = await service.readRaw(projectId);

    expect(queue.enabled).toBe(false);
    expect(queue.handOutWork).toBe(false);
    expect(queue.waiting).toBe(1);
  });

  it('hands out nothing while the breaker is open', async () => {
    await arm({ autopilotFailureStreak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    await addTask('a', 'todo', 0);

    const queue = await service.readRaw(projectId);

    expect(queue.breakerOpen).toBe(true);
    expect(queue.handOutWork).toBe(false);
  });

  it('hands out nothing while a usage limit stands, and works again once it lapses', async () => {
    await addTask('a', 'todo', 0);
    await arm({ autopilotLimitUntil: new Date(Date.now() + 60_000) });

    const held = await service.readRaw(projectId);

    expect(held.limitHoldUntil).not.toBeNull();
    expect(held.handOutWork).toBe(false);

    await arm({ autopilotLimitUntil: new Date(Date.now() - 1) });

    const lapsed = await service.readRaw(projectId);

    expect(lapsed.limitHoldUntil).toBeNull();
    expect(lapsed.handOutWork).toBe(true);
  });

  it('keeps the breaker shut one failure short of the threshold', async () => {
    await arm({
      autopilotFailureStreak: PROJECT_FAILURE_BREAKER_THRESHOLD - 1,
    });
    await addTask('a', 'todo', 0);

    const queue = await service.readRaw(projectId);

    expect(queue.breakerOpen).toBe(false);
    expect(queue.handOutWork).toBe(true);
  });

  it('reports no free slots and no hand-out when every slot is taken', async () => {
    const first = await addRun('running');
    const second = await addRun('pending');
    await addTask('one', 'in_progress', 0, first.id);
    await addTask('two', 'in_progress', 1, second.id);
    await addTask('queued', 'todo', 2);

    const queue = await service.readRaw(projectId);

    expect(queue.running).toBe(2);
    expect(queue.freeSlots).toBe(0);
    expect(queue.handOutWork).toBe(false);
  });

  it('reads the intake column the project names, not a hardcoded one', async () => {
    await arm({ autopilotIntakeStatus: 'backlog' });
    await addTask('in backlog', 'backlog', 0);
    await addTask('in todo', 'todo', 0);

    const queue = await service.readRaw(projectId);

    expect(queue.intakeStatus).toBe('backlog');
    expect(queue.waitingTasks.map((task) => task.title)).toEqual([
      'in backlog',
    ]);
  });

  it('refuses a project that does not exist', async () => {
    await expect(service.readRaw('nope')).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });
});
