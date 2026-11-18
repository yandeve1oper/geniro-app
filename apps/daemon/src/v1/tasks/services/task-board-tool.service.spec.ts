import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { BadRequestException } from '@packages/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { HOST_BOARD_TOOLS } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import {
  PROJECT_FAILURE_BREAKER_THRESHOLD,
  PROJECT_INSTRUCTIONS_MAX,
} from '../../projects/projects.types';
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { TaskBoardBroker } from '../../teams/services/task-board.broker';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { LabelInstructionDao } from '../dao/label-instruction.dao';
import { TaskDao } from '../dao/task.dao';
import { LabelInstruction } from '../entity/label-instruction.entity';
import { Task } from '../entity/task.entity';
import { TASK_REPORT_MAX, type TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskBoardToolService } from './task-board-tool.service';
import { TaskBoardVocabularyService } from './task-board-vocabulary.service';
import { TaskEventBus } from './task-events.bus';
import { TaskFilesService } from './task-files.service';
import { TasksService } from './tasks.service';

/** Where this spec's copied screenshots land — removed after each case. */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-board-tool-spec');

/** The JSON a board answer carries after its lead sentence. */
const jsonOf = (text: string): unknown =>
  JSON.parse(text.slice(text.indexOf('\n\n') + 2));

describe('TaskBoardToolService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let broker: TaskBoardBroker;
  let service: TaskBoardToolService;
  let changes: TaskChangedEvent[];
  let project: Project;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run, Item, LabelInstruction],
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
    rmSync(ATTACHMENTS_ROOT, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    const labelInstructions = new LabelInstructionDao(em);
    const events = new TaskEventBus();
    changes = [];
    events.allChanges().subscribe((event) => changes.push(event));
    const attachments = new TaskAttachmentService(ATTACHMENTS_ROOT);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      events,
      attachments,
      runDao,
      fakeLiveWork().liveWork,
    );
    const teams = {
      list: async () => [
        { slug: 'dev-team', name: 'Dev Team', description: 'A team' },
      ],
    } as unknown as TeamStoreService;
    const vocabulary = new TaskBoardVocabularyService(
      em,
      taskDao,
      projectDao,
      labelInstructions,
      teams,
      {
        all: () =>
          new Map([
            [
              'claude',
              {
                getConfig: () => ({
                  identity: { displayName: 'Claude Code' },
                  approval: { modes: ['auto', 'ask', 'plan'] },
                }),
              },
            ],
          ]),
      } as never,
      { resolve: async () => '2.1.300' } as never,
      { register: () => undefined } as never,
      {
        list: async () => [{ id: 'opus', label: 'Opus', source: 'cli' }],
      } as never,
      {
        list: async (_agent: string, model: string | null) => ({
          efforts:
            model === 'opus'
              ? [{ id: 'max', label: 'Max' }]
              : [{ id: 'high', label: 'High' }],
          unavailableReason: null,
          exact: true,
        }),
      } as never,
    );
    broker = new TaskBoardBroker();
    service = new TaskBoardToolService(
      em,
      broker,
      runDao,
      taskDao,
      projectDao,
      tasks,
      attachments,
      new TaskFilesService(em, taskDao, tasks),
      teams,
      vocabulary,
    );
    service.onModuleInit();
    project = await projectDao.create({
      name: 'Geniro',
      folder: '/tmp/geniro-task-board-tool-spec',
      taskKey: 'GEN',
      configDir: '/tmp/profiles/work',
    });
    // The conversations the tools are called from: a plain chat in `auto`,
    // and one in `ask`.
    for (const [id, approval] of [
      ['chat', 'auto'],
      ['ask-chat', 'ask'],
    ] as const) {
      await runDao.create({
        id,
        teamId: null,
        status: 'completed',
        agentKind: 'claude',
        approval,
      });
    }
    await labelInstructions.create({
      projectId: null,
      label: 'implementation',
      instructions: 'Use the implement skill.',
    });
  });

  const call = (name: string, args: Record<string, unknown>, runId = 'chat') =>
    broker.call(runId, name, args);

  /** A card in `in_progress`, worked by `runId`. */
  const working = async (
    runId = 'run-1',
    approval: 'auto' | 'ask' | null = null,
  ) => {
    const task = await tasks.create({
      projectId: project.id,
      title: 'ship it',
    });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    await runDao.create({
      id: runId,
      teamId: null,
      status: 'running',
      agentKind: 'claude',
      taskId: task.id,
      taskIdentifier: 'GEN-1',
      approval,
    });
    await tasks.update(task.id, { runId });
    return task;
  };

  const fresh = async (taskId: string) =>
    taskDao.getById(taskId, orm.em.fork() as EntityManager);

  const arm = async () => {
    const row = await projectDao.getById(project.id, em);
    row!.autopilotEnabled = true;
    row!.autopilotIntakeStatus = 'todo';
    await em.flush();
  };

  it('lists every board tool once the board is installed, and none after it is destroyed', async () => {
    expect(broker.tools().map((tool) => tool.name)).toEqual([
      ...HOST_BOARD_TOOLS,
    ]);

    service.onModuleDestroy();

    expect(broker.tools()).toEqual([]);
    expect(await call('list_projects', {})).toEqual({
      text: 'The task board is not available.',
      isError: true,
    });
  });

  it('says when an armed project waits for its usage limit', async () => {
    await arm();
    const row = await projectDao.getById(project.id, em);
    const until = new Date(Date.now() + 60_000);
    row!.autopilotLimitUntil = until;
    await em.flush();

    const listed = await call('list_projects', {});

    expect(listed.text).toContain('waiting for its usage limit to reset');
    expect(listed.text).toContain(
      `"waitingForUsageLimitUntil": "${until.toISOString()}"`,
    );

    const filed = await call('create_task', {
      project: 'GEN',
      title: 'x',
      status: 'todo',
      agentKind: 'claude',
    });

    expect(filed.text).toContain(
      `usage limit to reset at ${until.toISOString()}`,
    );
  });

  it('files a card from a plain chat with its own fields set, through the service the board uses', async () => {
    const answer = await call('create_task', {
      project: 'gen',
      title: '  Board tools for every agent  ',
      description: 'So a chat can file a ticket.',
      priority: 'high',
      labels: ['implementation'],
      dueDate: '2026-10-31',
      agentKind: 'claude',
      sourceRef: 'LIN-7',
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).toMatch(
      /^Created GEN-1 "Board tools for every agent" in `backlog` on project GEN \(Geniro\)\./,
    );
    // What it will run as, and what of that is the project's, so the agent
    // can report it.
    expect(answer.text).toContain(
      'It runs on claude, in folder /tmp/geniro-task-board-tool-spec (from the project), with model=(not set), effort=(not set), approval=(not set), configDir=/tmp/profiles/work (from the project).',
    );
    const [stored] = await taskDao.listForProject(
      project.id,
      orm.em.fork() as EntityManager,
    );
    expect(stored).toMatchObject({
      title: 'Board tools for every agent',
      description: 'So a chat can file a ticket.',
      status: 'backlog',
      priority: 'high',
      labels: '["implementation"]',
      dueDate: '2026-10-31',
      agentKind: 'claude',
      sourceRef: 'LIN-7',
      number: 1,
    });
    expect(changes.at(-1)).toMatchObject({
      taskId: stored!.id,
      status: 'backlog',
    });
    expect(jsonOf(answer.text)).toMatchObject({
      key: 'GEN-1',
      labels: ['implementation'],
    });
  });

  it('says so when a card lands in an ARMED project’s intake column, and not otherwise', async () => {
    await arm();

    const intake = await call('create_task', {
      project: 'GEN',
      title: 'Start me',
      status: 'todo',
      agentKind: 'claude',
    });
    const parked = await call('create_task', {
      project: 'GEN',
      title: 'Leave me',
      agentKind: 'claude',
    });

    expect(intake.text).toContain('AUTOPILOT: project GEN (Geniro) is ARMED');
    expect(intake.text).toContain('20 seconds');
    expect(parked.text).not.toContain('AUTOPILOT');

    const moved = await call('update_task', {
      task: 'GEN-2',
      status: 'todo',
    });
    expect(moved.text).toContain('moved `backlog` → `todo`');
    expect(moved.text).toContain('AUTOPILOT');
  });

  it('names only what the card really inherits — a project pinned to another agent lends it no model', async () => {
    const row = await projectDao.getById(project.id, em);
    row!.agentKind = 'cursor-agent';
    row!.model = 'kimi-k3';
    await em.flush();

    const own = await call('create_task', {
      project: 'GEN',
      title: 'x',
      agentKind: 'claude',
    });
    const inherited = await call('create_task', { project: 'GEN', title: 'y' });

    // The lead sentence; the card's JSON still lists the project's value
    // beside its own under `runConfiguration`, which is accurate.
    const lead = own.text.split('\n\n')[0];
    expect(lead).toContain('It runs on claude,');
    expect(lead).not.toContain('kimi-k3');
    expect(inherited.text).toContain(
      'It runs on cursor-agent (from the project),',
    );
    expect(inherited.text).toContain('model=kimi-k3 (from the project)');
  });

  it('refuses an `ask` chat a card in an ARMED intake — the autopilot would run it unattended — and changes nothing', async () => {
    await arm();
    await call('create_task', {
      project: 'GEN',
      title: 'parked',
      agentKind: 'claude',
    });

    const filed = await call(
      'create_task',
      {
        project: 'GEN',
        title: 'start me',
        status: 'todo',
        agentKind: 'claude',
      },
      'ask-chat',
    );
    const moved = await call(
      'update_task',
      { task: 'GEN-1', title: 'renamed', status: 'todo' },
      'ask-chat',
    );
    const backlog = await call(
      'create_task',
      { project: 'GEN', title: 'fine', agentKind: 'claude' },
      'ask-chat',
    );

    for (const answer of [filed, moved]) {
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(
        'runs in `ask` approval, so it may not put a card in that intake or change existing cards on this board',
      );
    }
    expect(backlog.isError).toBe(false);
    const rows = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(rows.map((row) => [row.title, row.status]).sort()).toEqual([
      ['fine', 'backlog'],
      ['parked', 'backlog'],
    ]);
  });

  it.each([
    ['a field', { description: 'rm -rf the world' }],
    ['the report', { report: 'Done.' }],
  ] as const)(
    'refuses an `ask` chat a change to %s of a card already WAITING in an armed intake',
    async (_what, change) => {
      await call('create_task', {
        project: 'GEN',
        title: 'waiting',
        status: 'todo',
        agentKind: 'claude',
      });
      await arm();

      const answer = await call(
        'update_task',
        { task: 'GEN-1', ...change },
        'ask-chat',
      );

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(
        'may not put a card in that intake or change existing cards on this board',
      );
      const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
      expect(stored).toMatchObject({ description: null, report: null });
    },
  );

  it('refuses an `ask` chat setting a card’s approval to `auto`, and allows the rest', async () => {
    const auto = await call(
      'create_task',
      { project: 'GEN', title: 'x', approval: 'auto' },
      'ask-chat',
    );
    const ask = await call(
      'create_task',
      { project: 'GEN', title: 'y', approval: 'ask' },
      'ask-chat',
    );

    expect(auto.isError).toBe(true);
    expect(auto.text).toContain("may not set a card's approval to `auto`");
    expect(ask.isError).toBe(false);
    const rows = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(rows.map((row) => row.title)).toEqual(['y']);

    const raised = await call(
      'update_task',
      { task: 'GEN-1', approval: 'auto' },
      'ask-chat',
    );
    expect(raised.isError).toBe(true);
    expect(raised.text).toContain("may not set a card's approval to `auto`");
    const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(stored?.approval).toBe('ask');
  });

  it.each([
    ['agentKind', { agentKind: 'cursor-agent' }],
    ['approval', { approval: null }],
    ['teamSlug', { teamSlug: 'dev-team' }],
    ['folder', { folder: null }],
  ] as const)(
    'refuses an `ask` chat a change to an existing card’s run configuration (%s)',
    async (_field, change) => {
      await call('create_task', {
        project: 'GEN',
        title: 'x',
        agentKind: 'claude',
        approval: 'ask',
      });

      const answer = await call(
        'update_task',
        { task: 'GEN-1', ...change },
        'ask-chat',
      );

      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(
        "may not change an existing card's run configuration",
      );
      const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
      expect(stored).toMatchObject({
        agentKind: 'claude',
        approval: 'ask',
        teamSlug: null,
      });
    },
  );

  it('lets an `ask` chat file a card that inherits an `auto` project’s approval — the user’s own policy', async () => {
    const row = await projectDao.getById(project.id, em);
    row!.agentKind = 'claude';
    row!.approval = 'auto';
    await em.flush();

    const answer = await call(
      'create_task',
      { project: 'GEN', title: 'x' },
      'ask-chat',
    );

    expect(answer.isError).toBe(false);
  });

  it.each([
    ['a disarmed project', true, 'ask-chat', false, false],
    ['an armed project paused by its breaker', false, 'ask-chat', true, true],
    ['a team run', true, 'team-run', true, false],
    ['an unknown run', false, 'no-such-run', true, false],
  ] as const)(
    'into the intake from %s: allowed=%s',
    async (_case, allowed, runId, armed, breaker) => {
      await runDao.create({
        id: 'team-run',
        teamId: 'dev-team',
        status: 'running',
        agentKind: 'claude',
      });
      if (armed) {
        await arm();
      }
      if (breaker) {
        const row = await projectDao.getById(project.id, em);
        row!.autopilotFailureStreak = PROJECT_FAILURE_BREAKER_THRESHOLD;
        await em.flush();
      }

      const answer = await call(
        'create_task',
        { project: 'GEN', title: 'x', status: 'todo', agentKind: 'claude' },
        runId,
      );

      expect(answer.isError).toBe(!allowed);
      expect(
        (await taskDao.listAll(orm.em.fork() as EntityManager)).length,
      ).toBe(allowed ? 1 : 0);
      if (runId === 'no-such-run') {
        expect(answer.text).toContain('is not running in `auto` approval');
      }
    },
  );

  it('names `todo` as the quiet column where `backlog` itself is the armed intake', async () => {
    const row = await projectDao.getById(project.id, em);
    row!.autopilotEnabled = true;
    row!.autopilotIntakeStatus = 'backlog';
    await em.flush();

    const answer = await call(
      'create_task',
      { project: 'GEN', title: 'x', agentKind: 'claude' },
      'ask-chat',
    );

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('File new cards in `todo`');
  });

  it('warns that a card naming no agent or team cannot be started', async () => {
    const answer = await call('create_task', { project: 'GEN', title: 'x' });

    expect(answer.text).toContain('cannot be started until one is set');
  });

  it('refuses a bad enum by naming the values it allows, and writes nothing', async () => {
    const answer = await call('create_task', {
      project: 'GEN',
      title: 'x',
      priority: 'critical',
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^INVALID_ARGS: 'priority':/);
    expect(answer.text).toContain('urgent');
    expect(await taskDao.listAll(orm.em.fork() as EntityManager)).toEqual([]);
  });

  it('names the projects when the one asked for does not exist', async () => {
    const answer = await call('create_task', { project: 'NOPE', title: 'x' });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('UNKNOWN_PROJECT');
    expect(answer.text).toContain(`GEN (Geniro) (id ${project.id})`);
  });

  it('refuses a team the library does not hold, naming the ones it does', async () => {
    const answer = await call('create_task', {
      project: 'GEN',
      title: 'x',
      teamSlug: 'ghost',
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('dev-team');
  });

  it('changes any card by key — fields and column together', async () => {
    await call('create_task', { project: 'GEN', title: 'old' });

    const answer = await call('update_task', {
      task: 'gen-1',
      title: 'new',
      labels: ['bug'],
      priority: 'low',
      model: null,
      status: 'in_review',
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).toMatch(
      /^Updated GEN-1: changed title, priority, labels, model; moved `backlog` → `in_review`\./,
    );
    const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(stored).toMatchObject({
      title: 'new',
      labels: '["bug"]',
      priority: 'low',
      status: 'in_review',
    });
  });

  it('refuses the run-owned fields and leaves the card alone', async () => {
    await call('create_task', { project: 'GEN', title: 'x' });

    const answer = await call('update_task', {
      task: 'GEN-1',
      title: 'y',
      runId: 'stolen',
    });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("'runId' cannot be set by a tool");
    const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(stored).toMatchObject({ title: 'x', runId: null });
  });

  it('changes nothing when the card moved since the agent read it', async () => {
    await call('create_task', { project: 'GEN', title: 'x' });

    const answer = await call('update_task', {
      task: 'GEN-1',
      title: 'y',
      status: 'done',
      fromStatus: 'todo',
    });

    expect(answer.isError).toBe(false);
    expect(answer.text).toContain('is in `backlog`, not `todo`');
    const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
    expect(stored).toMatchObject({ title: 'x', status: 'backlog' });
  });

  it('refuses a blank or oversized report and leaves the card’s report alone', async () => {
    const task = await working();

    for (const report of ['   ', 'x'.repeat(TASK_REPORT_MAX + 1)]) {
      const answer = await call('update_task', { report }, 'run-1');
      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/^INVALID_ARGS: 'report'/);
    }
    expect((await fresh(task.id))?.report).toBeNull();
  });

  it('answers a refusal from the board’s own service with its code — and copies no screenshot first', async () => {
    const task = await working('run-1', 'auto');
    const scratch = mkdtempSync(join(tmpdir(), 'geniro-board-shots-'));
    const shot = join(scratch, 'panel.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const answer = await call(
        'update_task',
        { folder: '/nope/not/a/folder', report: `Done ![p](${shot})` },
        'run-1',
      );

      expect(answer.isError).toBe(true);
      expect(answer.text).toMatch(/^[A-Z_]+: /);
      expect(answer.text).toContain('/nope/not/a/folder');
      expect((await tasks.get(task.id)).attachments).toEqual([]);
      expect((await fresh(task.id))?.report).toBeNull();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('says what was saved when the move then loses its compare-and-set', async () => {
    await call('create_task', { project: 'GEN', title: 'x' });
    const moveStatus = tasks.moveStatus.bind(tasks);
    tasks.moveStatus = async () => {
      throw new BadRequestException(
        'TASK_STATUS_CONFLICT',
        'it moved meanwhile',
      );
    };
    try {
      const answer = await call('update_task', {
        task: 'GEN-1',
        title: 'y',
        status: 'done',
      });

      expect(answer.isError).toBe(false);
      expect(answer.text).toBe(
        'Saved title, but did not move GEN-1: it moved meanwhile.',
      );
      const [stored] = await taskDao.listAll(orm.em.fork() as EntityManager);
      expect(stored).toMatchObject({ title: 'y', status: 'backlog' });
    } finally {
      tasks.moveStatus = moveStatus;
    }
  });

  it('refuses a key two projects share, changing neither card', async () => {
    const twin = await projectDao.create({
      name: 'Twin',
      folder: '/tmp/geniro-task-board-tool-spec-twin',
      taskKey: 'GEN',
    });
    await call('create_task', { project: project.id, title: 'mine' });
    await call('create_task', { project: twin.id, title: 'theirs' });

    const answer = await call('update_task', { task: 'GEN-1', title: 'z' });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('names a card in 2 projects');
    const titles = (await taskDao.listAll(orm.em.fork() as EntityManager))
      .map((row) => row.title)
      .sort();
    expect(titles).toEqual(['mine', 'theirs']);
  });

  it('finds a card whose project key starts with a digit', async () => {
    const digits = await projectDao.create({
      name: '2048 Game',
      folder: '/tmp/geniro-task-board-tool-spec-2g',
      taskKey: '2G',
    });
    await call('create_task', { project: digits.id, title: 'tile' });

    const answer = await call('get_task', { task: '2g-1' });

    expect(answer.isError).toBe(false);
    expect(jsonOf(answer.text)).toMatchObject({ key: '2G-1', title: 'tile' });
  });

  it('refuses a call that changes nothing', async () => {
    await call('create_task', { project: 'GEN', title: 'x' });

    const answer = await call('update_task', { task: 'GEN-1' });

    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/^INVALID_ARGS: nothing to change/);
  });

  it('reads the card its run works when no card is named', async () => {
    await working();

    const answer = await call('get_task', {}, 'run-1');

    expect(answer.text).toContain(
      'it is the card this conversation is working',
    );
    expect(jsonOf(answer.text)).toMatchObject({
      key: 'GEN-1',
      title: 'ship it',
      status: 'in_progress',
      workedByThisConversation: true,
    });
  });

  it('asks a conversation that works no card to name one', async () => {
    const answer = await call('get_task', {});

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("pass 'task'");
  });

  it('writes its own card’s report and moves it, in that order', async () => {
    const task = await working();

    const answer = await call(
      'update_task',
      { report: '## Done\n\nShipped it.', status: 'in_review' },
      'run-1',
    );

    expect(answer.isError).toBe(false);
    const stored = await fresh(task.id);
    expect(stored?.status).toBe('in_review');
    expect(stored?.report).toBe('## Done\n\nShipped it.');
    expect(stored?.reportedAt).toBeInstanceOf(Date);
    // The card lands in its new column already carrying the report.
    expect(changes.slice(-2).map((event) => event.status)).toEqual([
      'in_progress',
      'in_review',
    ]);
  });

  it('keeps its own card out of the intake the autopilot hands out', async () => {
    const task = await working();

    const answer = await call('update_task', { status: 'todo' }, 'run-1');

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(
      'may only move to in_progress, in_review, done, failed',
    );
    expect((await fresh(task.id))?.status).toBe('in_progress');
  });

  it('lets a run in `ask` finish its OWN card while that card sits in an armed intake', async () => {
    const task = await working('run-1', 'ask');
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'todo' });
    await arm();

    const report = await call('update_task', { report: 'Done.' }, 'run-1');
    const edit = await call('update_task', { title: 'renamed' }, 'run-1');

    expect(report.isError).toBe(false);
    expect((await fresh(task.id))?.report).toBe('Done.');
    expect(edit.isError).toBe(true);
    expect((await fresh(task.id))?.title).toBe('ship it');
  });

  it('refuses a run in `ask` moving its OWN card into an armed intake, even a finishing column', async () => {
    const task = await working('run-1', 'ask');
    const row = await projectDao.getById(project.id, em);
    row!.autopilotEnabled = true;
    row!.autopilotIntakeStatus = 'in_review';
    await em.flush();

    const answer = await call(
      'update_task',
      { report: 'Done.', status: 'in_review' },
      'run-1',
    );

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(
      'may not put a card in that intake or change existing cards on this board',
    );
    expect((await fresh(task.id))?.status).toBe('in_progress');
  });

  it('refuses an `ask` chat any change to a WORKING card on an armed board — an interrupted run sends it back to the intake', async () => {
    const task = await working();
    await arm();

    const answer = await call(
      'update_task',
      { task: 'GEN-1', description: 'agent-written brief' },
      'ask-chat',
    );

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain(
      'returns there by itself if its run is interrupted',
    );
    expect((await fresh(task.id))?.description).toBeNull();
  });

  it('lets a run in `ask` finish its OWN card on an armed board — report and a column that is not the intake', async () => {
    const task = await working('run-1', 'ask');
    await arm();

    const answer = await call(
      'update_task',
      { report: 'Done.', status: 'in_review' },
      'run-1',
    );

    expect(answer.isError).toBe(false);
    expect(await fresh(task.id)).toMatchObject({
      status: 'in_review',
      report: 'Done.',
    });
  });

  it('keeps its own card out of the intake when it names the card by key, too', async () => {
    const task = await working();

    const answer = await call(
      'update_task',
      { task: 'GEN-1', status: 'todo' },
      'run-1',
    );

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('may only move to in_progress');
    expect((await fresh(task.id))?.status).toBe('in_progress');
  });

  it('copies referenced screenshots onto the card and points the report at the copies', async () => {
    const task = await working();
    const scratch = mkdtempSync(join(tmpdir(), 'geniro-board-shots-'));
    const shot = join(scratch, 'panel.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(shot, bytes);
    try {
      const report = `Done.\n\n![the panel](${shot})\n![gone](/nope/missing.png)`;

      const answer = await call('update_task', { report }, 'run-1');

      expect(answer.text).toContain('1 image copied onto the card.');
      expect(answer.text).toContain('Could not copy: /nope/missing.png');
      const files = (await tasks.get(task.id)).attachments;
      expect(files.map((file) => file.name)).toEqual(['panel.png']);
      const copy = files[0]!.path;
      expect(copy.startsWith(join(ATTACHMENTS_ROOT, task.id))).toBe(true);
      expect(readFileSync(copy)).toEqual(bytes);
      const stored = (await fresh(task.id))?.report ?? '';
      expect(stored).toContain(`![the panel](${copy})`);
      expect(stored).not.toContain(shot);
      expect(stored).toContain('![gone](/nope/missing.png)');

      // Every report replaces the last, so the same screenshot sent again must
      // not be listed on the card twice.
      await call('update_task', { report }, 'run-1');
      expect((await tasks.get(task.id)).attachments).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('keeps a report that already names the CARD’s own copy as it is, attaching nothing again', async () => {
    const task = await working();
    const scratch = mkdtempSync(join(tmpdir(), 'geniro-board-shots-'));
    const shot = join(scratch, 'panel.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      await call(
        'update_task',
        { report: `Done.\n\n![panel](${shot})` },
        'run-1',
      );
      const firstReport = (await fresh(task.id))?.report ?? '';
      const copy = (await tasks.get(task.id)).attachments[0]!.path;

      await call('update_task', { report: firstReport }, 'run-1');

      const files = (await tasks.get(task.id)).attachments;
      expect(files.map((file) => file.path)).toEqual([copy]);
      expect((await fresh(task.id))?.report).toBe(firstReport);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('does not treat a card restarted on another run as the old run’s own', async () => {
    const task = await working('run-old');
    await tasks.update(task.id, { runId: 'run-new' });

    const answer = await call('update_task', { status: 'done' }, 'run-old');

    expect(answer.isError).toBe(true);
    expect((await fresh(task.id))?.status).toBe('in_progress');
  });

  it('finds cards by column, label and words', async () => {
    await call('create_task', {
      project: 'GEN',
      title: 'Fix the parser',
      labels: ['bug'],
    });
    await call('create_task', {
      project: 'GEN',
      title: 'Write docs',
      status: 'todo',
    });
    await call('create_task', {
      project: 'GEN',
      title: 'Parser docs',
      labels: ['Bug'],
    });

    const byLabel = await call('list_tasks', { label: 'BUG', query: 'parser' });
    const byStatus = await call('list_tasks', {
      project: 'GEN',
      status: ['todo'],
    });

    expect(
      (jsonOf(byLabel.text) as { key: string }[]).map((row) => row.key),
    ).toEqual(['GEN-1', 'GEN-3']);
    expect(
      (jsonOf(byStatus.text) as { title: string }[]).map((row) => row.title),
    ).toEqual(['Write docs']);
  });

  it('reads one project with its instruction blocks, their revision and the size limit when asked for it', async () => {
    const row = await projectDao.getById(project.id, em);
    row!.description = 'The desktop app';
    row!.instructionBlocks = JSON.stringify([
      { id: 'repo', title: 'Repo', text: 'Use pnpm.' },
      { id: 'stand', title: 'Stand', text: 'Boot it.' },
    ]);
    row!.instructionsRevision = 7;
    await em.flush();

    const answer = await call('list_projects', { project: 'gen' });

    expect(answer.isError).toBe(false);
    expect(answer.text).toMatch(
      /^Project GEN \(Geniro\), at instructions revision 7\./,
    );
    expect(jsonOf(answer.text)).toMatchObject({
      id: project.id,
      key: 'GEN',
      description: 'The desktop app',
      instructionBlocks: [
        { id: 'repo', title: 'Repo', text: 'Use pnpm.' },
        { id: 'stand', title: 'Stand', text: 'Boot it.' },
      ],
      instructionsRevision: 7,
      instructionsChars: 'Use pnpm.\n\nBoot it.'.length,
      instructionsMaxChars: PROJECT_INSTRUCTIONS_MAX,
    });
    expect(await call('list_projects', { project: 'nope' })).toMatchObject({
      isError: true,
    });
  });

  it('lists the projects with their armed autopilot and card counts', async () => {
    await arm();
    await call('create_task', { project: 'GEN', title: 'x' });

    const answer = await call('list_projects', {});

    expect(answer.text).toContain(
      'Autopilot ARMED on: GEN (Geniro) (starts an agent on cards in `todo`)',
    );
    expect(jsonOf(answer.text)).toEqual([
      expect.objectContaining({
        key: 'GEN',
        autopilot: expect.objectContaining({
          armed: true,
          intakeColumn: 'todo',
        }),
        cards: expect.objectContaining({ backlog: 1, todo: 0 }),
      }),
    ]);
  });

  it('lists the machine’s vocabulary, and a CLI’s models when asked', async () => {
    await call('create_task', {
      project: 'GEN',
      title: 'x',
      labels: ['implementation', 'ui'],
    });

    const answer = await call('board_vocabulary', { agentKind: 'claude' });
    const forModel = await call('board_vocabulary', {
      agentKind: 'claude',
      model: 'opus',
    });

    expect(jsonOf(forModel.text)).toMatchObject({
      models: { effortsFor: 'opus', efforts: [{ id: 'max', label: 'Max' }] },
    });
    expect(jsonOf(answer.text)).toMatchObject({
      configDirs: ['/tmp/profiles/work'],
      labels: expect.arrayContaining([
        {
          label: 'implementation',
          cards: 1,
          projects: ['GEN'],
          instructionsFor: ['every project'],
        },
        { label: 'ui', cards: 1, projects: ['GEN'], instructionsFor: [] },
      ]),
      teams: [{ slug: 'dev-team', name: 'Dev Team', description: 'A team' }],
      agents: [
        {
          agentKind: 'claude',
          name: 'Claude Code',
          version: '2.1.300',
          approvalModes: ['auto', 'ask', 'plan'],
        },
      ],
      models: {
        agentKind: 'claude',
        models: [{ id: 'opus', label: 'Opus' }],
        efforts: [{ id: 'high', label: 'High' }],
      },
    });
  });

  it('refuses arguments a tool does not take, naming the ones it does', async () => {
    const answer = await call('list_tasks', { columns: ['todo'] });

    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("unknown argument 'columns'");
    expect(answer.text).toContain('project, status, label, query, limit');
  });
});
