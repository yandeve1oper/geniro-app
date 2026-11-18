import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import { type RunWire } from '../../agents/chat.types';
import { RunDao } from '../../agents/dao/run.dao';
import { RunGroupDao } from '../../agents/dao/run-group.dao';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ChatService } from '../../agents/services/chat.service';
import { RunGroupsService } from '../../agents/services/run-groups.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { PROJECT_FAILURE_BREAKER_THRESHOLD } from '../../projects/projects.types';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { RunTeamService } from '../../teams/services/run-team.service';
import type { TeamExecutorService } from '../../teams/services/team-executor.service';
import type { TeamOverlayService } from '../../teams/services/team-overlay.service';
import type { TeamMember } from '../../teams/teams.types';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { aLabelInstruction } from '../__tests__/fixtures';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { LabelInstructionWire, StartTaskRun } from '../tasks.types';
import {
  AUTOPILOT_APPROVAL,
  RUN_TARGET_PROBLEM_CODE,
} from '../utils/run-target';
import {
  TASK_REPORT_INSTRUCTIONS,
  TASK_REPORT_INSTRUCTIONS_TEAM,
} from '../utils/task-prompt';
import type { LabelInstructionsService } from './label-instructions.service';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TaskRunsService } from './task-runs.service';
import { TasksService } from './tasks.service';

/**
 * Real database and real DAOs, on `tasks.service.spec.ts`'s own reasoning: the
 * behaviour under test writes and re-reads the card, so a faked DAO would
 * answer whatever the test told it and the compare-and-set could never be
 * entered. `ChatService` is the one double — it needs the whole agent
 * substrate, and what this service asks of it is two calls.
 */
/**
 * Where this spec's attachment deletes are aimed.
 *
 * Named explicitly rather than left to the service's default, which resolves
 * `environment.userDataDir` — the one shared resource the specs redirect for
 * themselves. Nothing is written here; the service only ever removes
 * `<root>/<task uuid>`, which cannot exist for a freshly minted id.
 */
const ATTACHMENTS_ROOT = join(tmpdir(), 'geniro-task-attachments-spec');

describe('TaskRunsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TaskRunsService;
  let tasks: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let runDao: RunDao;
  let em: EntityManager;
  let projectId: string;
  /**
   * Canonical, because `TasksService.update` puts `worktreePath` through
   * `resolveValidDirectory` — see the note in `tasks.service.spec.ts` for why
   * a raw `mkdtempSync` result fails this round-trip on macOS only.
   */
  let worktree: string;
  let createChat: ReturnType<typeof vi.fn>;
  let sendMessage: ReturnType<typeof vi.fn>;
  let updateSettings: ReturnType<typeof vi.fn>;
  let offeredApproval: ReturnType<typeof vi.fn>;
  let startTeamRun: ReturnType<typeof vi.fn>;
  let deleteTeamRun: ReturnType<typeof vi.fn>;
  let sendTeamMessage: ReturnType<typeof vi.fn>;
  /** What each team run's own SNAPSHOT says its members approve with. */
  let snapshotApprovals: Record<string, string>;
  let deleteChat: ReturnType<typeof vi.fn>;
  let resolveAutoGroupId: ReturnType<typeof vi.fn>;
  let forTask: ReturnType<typeof vi.fn>;
  /** What the library says each team's members approve with. */
  let teamApprovals: Record<string, string>;

  /**
   * A complete run row on the wire.
   *
   * Annotated rather than cast, so a field the schema requires cannot go
   * missing here and still compile.
   */
  const runWire = (id: string): RunWire => ({
    id,
    status: 'pending',
    taskIdentifier: null,
    project: null,
    analysisSourceRunId: null,
    analysisSourceSeq: null,
    analysisTeamSlug: null,
    awaiting: null,
    holdingFor: 0,
    awaitingCalls: 0,
    rootsWorking: 0,
    shellsOpen: 0,
    subagentsOut: 0,
    monitorsOpen: 0,
    title: null,
    agentKind: 'claude',
    teamId: null,
    cwd: worktree,
    startSha: null,
    startDirty: null,
    model: null,
    approval: null,
    effort: null,
    contextWindow: null,
    autoCompactPercent: null,
    modelParameters: {},
    contextTokens: null,
    contextEstimated: false,
    contextWindowTokens: null,
    workedMs: null,
    toolCalls: null,
    promptCacheExpiresAt: null,
    promptCacheTtlMs: null,
    promptCacheTtlReason: null,
    configDir: null,
    configDirPin: null,
    groupId: null,
    taskId: null,
    pinnedPosition: null,
    color: null,
    createdAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
    archivedAt: null,
    attentionAt: null,
    seenAt: null,
    notes: null,
    lastMessage: null,
    lastActivityAt: null,
    pullRequests: [],
    taskList: [],
    resetWakes: [],
    stages: null,
    currentLead: null,
    goals: [],
    outcome: null,
  });

  const start = (over: Partial<StartTaskRun> = {}): StartTaskRun => ({
    cwd: worktree,
    branch: 'geniro/task-1',
    from: 'todo',
    ...over,
  });

  beforeAll(async () => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-task-run-')));
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, Run, RunGroup],
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
    rmSync(worktree, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    runDao = new RunDao(em);
    tasks = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      runDao,
      fakeLiveWork().liveWork,
    );
    // The fake writes a REAL run row, because the double-start guard asks the
    // run whether it has settled — against a stub it would find nothing and
    // wave every second start through. It stores both instruction fields the
    // way `ChatService.createChat` does, so a continued thread's refresh is
    // observed against the row it replaces.
    let runSeq = 0;
    createChat = vi.fn(
      async (input: {
        taskId?: string;
        customInstructions?: string;
        taskInstructions?: string;
      }) => {
        const id = `run-${(runSeq += 1)}`;
        await runDao.create({
          id,
          teamId: null,
          status: 'running',
          agentKind: 'claude',
          cwd: worktree,
          taskId: input.taskId ?? null,
          customInstructions: input.customInstructions ?? null,
          taskInstructions: input.taskInstructions ?? null,
        });
        return runWire(id);
      },
    );
    sendMessage = vi.fn(async () => undefined);
    // A REAL purge, not a stub answering `{ deleted: true }` about nothing —
    // the "does NOT delete the run" spec below asserts the row SURVIVES, and
    // that assertion means nothing against a double that removes no row.
    deleteChat = vi.fn(async (id: string) => {
      await runDao.hardDeleteIncludingSoftDeleted({ id }, em);
      return { deleted: true };
    });
    // Stores the task instructions the way `ChatService.updateSettings` does,
    // so a continued thread's refresh is read back off the row at send time.
    updateSettings = vi.fn(
      async (runId: string, patch: { taskInstructions?: string | null }) => {
        if (patch.taskInstructions !== undefined) {
          await runDao.updateById(
            runId,
            { taskInstructions: patch.taskInstructions },
            em,
          );
        }
      },
    );
    offeredApproval = vi.fn(
      (_kind: string, approval: string | null | undefined) =>
        approval ?? undefined,
    );
    const chats = {
      createChat,
      sendMessage,
      updateSettings,
      offeredApproval,
      delete: deleteChat,
    } as unknown as ChatService;
    // The team engine's double writes a real run row for `createChat`'s own
    // reason: the double-start guard asks the RUN whether it has settled, and
    // a team-targeted card must be refused a second start exactly as an
    // agent-targeted one is.
    startTeamRun = vi.fn(
      async (
        slug: string,
        input: { taskId?: string; title?: string; groupId?: string | null },
      ) => {
        const id = `wf-run-${(runSeq += 1)}`;
        await runDao.create({
          id,
          teamId: slug,
          status: 'running',
          agentKind: null,
          cwd: worktree,
          taskId: input.taskId ?? null,
          groupId: input.groupId ?? null,
          title: input.title ?? null,
        });
        return runWire(id);
      },
    );
    deleteTeamRun = vi.fn(async () => ({ deleted: true }));
    sendTeamMessage = vi.fn(async () => undefined);
    const executor = {
      startRunBySlug: startTeamRun,
      deleteRun: deleteTeamRun,
      sendMessage: sendTeamMessage,
    } as unknown as TeamExecutorService;
    // The team each existing team run was STARTED with, which a continued
    // run uses — told apart from the library's copy above by its own field.
    snapshotApprovals = {};
    const runTeams = {
      teamOf: vi.fn(async (run: { teamId: string }) => {
        const approval = snapshotApprovals[run.teamId];
        if (approval === undefined) {
          throw new Error(`no snapshot for ${run.teamId}`);
        }
        return teamOf(
          [
            member('coder', {
              approval: approval as TeamMember['approval'],
            }),
          ],
          { name: run.teamId },
        );
      }),
    } as unknown as RunTeamService;
    // No sidebar rule claims anything by default; a test that needs one says so.
    resolveAutoGroupId = vi.fn(async () => null);
    // Only the project's own group exists in the sidebar by default.
    const groups = {
      resolveAutoGroupId,
      exists: vi.fn(async (id: string) => id === 'group-7'),
    } as unknown as RunGroupsService;
    // No label attaches anything by default; a test that needs one says so.
    forTask = vi.fn(async () => [] as LabelInstructionWire[]);
    const labelInstructions = {
      forTask,
    } as unknown as LabelInstructionsService;
    service = new TaskRunsService(
      em,
      taskDao,
      projectDao,
      runDao,
      tasks,
      chats,
      new ProjectQueueService(em, projectDao, taskDao, runDao),
      executor,
      groups,
      labelInstructions,
      {
        effectiveBySlug: vi.fn(
          async (slug: string, projectId: string | null) => {
            const approval =
              teamApprovals[`${slug}@${projectId}`] ?? teamApprovals[slug];
            if (approval === undefined) {
              throw new Error(`no team ${slug}`);
            }
            return {
              overlay: null,
              team: teamOf(
                [
                  member('coder', {
                    approval: approval as TeamMember['approval'],
                  }),
                ],
                { name: slug },
              ),
            };
          },
        ),
      } as unknown as TeamOverlayService,
      runTeams,
    );
    // Asks by default, so a team card is unattended-incapable unless a test
    // says otherwise.
    teamApprovals = { 'dev-team': 'ask' };
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-task-runs-spec',
      agentKind: 'claude',
      groupId: 'group-7',
    });
    projectId = project.id;
  });

  const seed = async (over: { title?: string; description?: string } = {}) => {
    const task = await tasks.create({
      projectId,
      title: over.title ?? 'ship it',
      description: over.description,
    });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    return task;
  };

  describe('the team arm', () => {
    /** Point the CARD at a team, leaving the project's agent in place. */
    const seedTeamCard = async (slug = 'dev-team') => {
      const task = await seed();
      const row = await taskDao.getById(task.id);
      (row as Task).teamSlug = slug;
      await em.flush();
      return task;
    };

    it('starts a team run instead of a chat when the card names a team', async () => {
      const task = await seedTeamCard();

      const started = await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledTimes(1);
      expect(createChat).not.toHaveBeenCalled();
      expect(started).toMatchObject({
        status: 'in_progress',
        runId: 'wf-run-1',
        worktreePath: worktree,
      });
    });

    it('hands the executor the card id, its title and the project’s group', async () => {
      const task = await seedTeamCard();

      await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledWith(
        'dev-team',
        expect.objectContaining({
          taskId: task.id,
          title: 'ship it',
          groupId: 'group-7',
          cwd: worktree,
        }),
      );
    });

    it('hands the executor the folder’s start commit, so the team’s lines can be measured', async () => {
      const task = await seedTeamCard();

      await service.start(task.id, {
        ...start(),
        startSha: 'd'.repeat(40),
        startDirty: true,
      });

      expect(startTeamRun.mock.calls[0]?.[1]).toMatchObject({
        startSha: 'd'.repeat(40),
        startDirty: true,
      });
    });

    it('seeds the team run with the card’s brief and sends no second message', async () => {
      const task = await seedTeamCard();

      await service.start(task.id, start());

      // A team's seed prompt IS its opening message, so a NEW run is sent
      // nothing after it — a later press continues it instead (below).
      expect(startTeamRun.mock.calls[0]?.[1]).toMatchObject({
        prompt: 'ship it',
      });
      expect(sendMessage).not.toHaveBeenCalled();
      void task;
    });

    it('asks a team to report through the board tool, from the member that concludes', async () => {
      const task = await seedTeamCard();

      await service.start(task.id, start());

      // Every member of a task team is handed the board tools, while
      // the render family is registered by `ChatService` alone — so the ask
      // names `update_task`, never `report_findings`, and says which member
      // is the one to use it.
      const instructions = String(
        startTeamRun.mock.calls[0]?.[1]?.taskInstructions ?? '',
      );
      expect(instructions).not.toContain('report_findings');
      expect(instructions).toContain('`update_task`');
      expect(instructions).toContain('leaves the card alone');
      void task;
    });

    it('deletes the GRAPH run when the start fails, not through the chat path', async () => {
      const task = await seedTeamCard();
      // Fail after the run exists, which is the window `abandon` is for. The
      // real method is captured BEFORE the spy replaces it: binding
      // `tasks.update` afterwards binds the SPY, so every later call re-enters
      // it and the recursion is swallowed by `abandon`'s own catch — the test
      // then passes while reverting nothing.
      const real = tasks.update.bind(tasks);
      const boom = new Error('worktree vanished');
      const update = vi
        .spyOn(tasks, 'update')
        .mockRejectedValueOnce(boom)
        .mockImplementation(real);

      await expect(service.start(task.id, start())).rejects.toThrow(boom);

      // `chats.delete` asserts a CHAT run, so sending a team run there throws
      // `NOT_A_CHAT_RUN` into a catch that swallows it — leaving the orphaned
      // run row this routing exists to prevent, and leaving it silently.
      expect(deleteTeamRun).toHaveBeenCalledWith('wf-run-1');
      expect(deleteChat).not.toHaveBeenCalled();
      // The card really did come back, which is what proves `abandon` ran to
      // completion rather than dying partway and being swallowed.
      expect((await taskDao.getById(task.id))?.status).toBe('todo');
      update.mockRestore();
    });

    it('lets the PROJECT name the team for every card on its board', async () => {
      const project = await projectDao.getById(projectId);
      (project as Project).agentKind = null;
      (project as Project).teamSlug = 'board-wide';
      await em.flush();
      const task = await seed();

      await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledWith(
        'board-wide',
        expect.anything(),
      );
    });

    it('lets a CARD’s agent override a project pinned to a team', async () => {
      const project = await projectDao.getById(projectId);
      (project as Project).agentKind = null;
      (project as Project).teamSlug = 'board-wide';
      await em.flush();
      const task = await seed();
      const row = await taskDao.getById(task.id);
      (row as Task).agentKind = 'cursor-agent';
      await em.flush();

      await service.start(task.id, start());

      expect(startTeamRun).not.toHaveBeenCalled();
      expect(createChat).toHaveBeenCalledWith(
        expect.objectContaining({ agentKind: 'cursor-agent' }),
      );
    });

    it('hands the TEAM run the user’s per-CLI switches', async () => {
      // Snapshotted at run creation, so a press that dropped them would run
      // every member with each option at its default.
      const task = await seedTeamCard();
      const agentOptions = { claude: { browserTools: true } };

      await service.start(task.id, start({ agentOptions }));

      const passed = startTeamRun.mock.calls[0]?.[1] as {
        agentOptions?: unknown;
      };
      expect(passed.agentOptions).toEqual(agentOptions);
    });

    it('hands the TEAM run the user’s own text and the card’s instructions as separate fields', async () => {
      // The compose specs below exercise the chat (agent) arm;
      // `startTeamRun` builds its own fields off the identical
      // `labelInstructions` value, and this is what proves that path reads it
      // — and keeps the label block out of the user's purgeable text.
      forTask.mockResolvedValueOnce([aLabelInstruction()]);
      const task = await seedTeamCard();

      await service.start(
        task.id,
        start({ customInstructions: 'Always use pnpm.' }),
      );

      const passed = startTeamRun.mock.calls[0]?.[1] as {
        customInstructions?: string;
        taskInstructions?: string;
      };
      expect(passed.customInstructions).toBe('Always use pnpm.');
      expect(passed.taskInstructions).toBe(
        [
          "Instructions attached to this task's labels:",
          '',
          '## Label "bug"',
          'Write a regression test.',
          '',
          TASK_REPORT_INSTRUCTIONS_TEAM,
        ].join('\n'),
      );
    });

    it('hands a team-targeted card’s run the user’s reply language', async () => {
      const task = await seedTeamCard();

      await service.start(task.id, start({ replyLanguage: 'Russian' }));

      const passed = startTeamRun.mock.calls[0]?.[1] as {
        replyLanguage?: string;
      };
      expect(passed.replyLanguage).toBe('Russian');
    });

    it('starts a team-targeted card unattended when every member is on auto', async () => {
      teamApprovals = { 'dev-team': 'auto' };
      const task = await seedTeamCard();

      await service.start(task.id, { ...start(), startedBy: 'autopilot' });

      expect(startTeamRun).toHaveBeenCalledTimes(1);
    });

    it('reads the team as the card’s project runs it: an ask member overridden to auto there passes only there', async () => {
      teamApprovals = { 'dev-team': 'ask', 'dev-team@other-project': 'auto' };
      const elsewhere = await seedTeamCard();

      await expect(
        service.start(elsewhere.id, { ...start(), startedBy: 'autopilot' }),
      ).rejects.toMatchObject({
        errorCode: RUN_TARGET_PROBLEM_CODE['team-unattended'],
      });

      teamApprovals = { 'dev-team': 'ask', [`dev-team@${projectId}`]: 'auto' };
      const here = await seedTeamCard();
      await service.start(here.id, { ...start(), startedBy: 'autopilot' });

      expect(startTeamRun).toHaveBeenCalledTimes(1);
    });

    it('refuses to start a team-targeted card unattended when a member can ask', async () => {
      // The resolver's own refusal is pinned in `run-target.spec.ts` and the
      // queue's handout keeps such a card out of `eligible` in
      // `task-queue.service.spec.ts` — but neither reaches this throw, which is
      // the line: a team's members each carry their own approval mode, so
      // there is no single field to force the way an agent run's is, and an
      // autopilot start against one must never reach the executor at all.
      const task = await seedTeamCard();

      await expect(
        service.start(task.id, { ...start(), startedBy: 'autopilot' }),
      ).rejects.toMatchObject({
        errorCode: RUN_TARGET_PROBLEM_CODE['team-unattended'],
      });
      expect(startTeamRun).not.toHaveBeenCalled();
    });
  });

  it('records the run, its branch and its worktree on the card', async () => {
    const task = await seed();

    const started = await service.start(task.id, start());

    expect(started).toMatchObject({
      status: 'in_progress',
      runId: 'run-1',
      branch: 'geniro/task-1',
      worktreePath: worktree,
    });
    const stored = await taskDao.getById(task.id);
    expect(stored?.runId).toBe('run-1');
  });

  it('starts the chat at the project’s context window and model parameters', async () => {
    await projectDao.updateById(projectId, {
      model: 'opus',
      contextWindow: '1m',
      modelParameters: JSON.stringify({ fast: 'on' }),
    });
    const task = await seed();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'opus',
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      }),
    );
  });

  it('hands the chat the task id and the PROJECT’s group, not the folder rule', async () => {
    const task = await seed();

    await service.start(task.id, start());

    // The run works in a worktree — a path no sidebar group has ever claimed —
    // so resolving the group from the cwd would file every task run loose.
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'group-7' }),
    );
    // The project's group is a deliberate answer, so no rule is consulted.
    expect(resolveAutoGroupId).not.toHaveBeenCalled();
  });

  it('files the run under the group claiming the card’s REAL folder when the project names none', async () => {
    // REPORTED against the autopilot: "tasks have no folder of their own …
    // they land in UNGROUPED although they belong to the geniro folder". With
    // no project group the rule is asked about the folder the card works in —
    // never the worktree the run is given, which no rule has ever claimed.
    const loose = await projectDao.create({
      name: 'Loose',
      folder: '/tmp/geniro-task-runs-loose',
      agentKind: 'claude',
    });
    const task = await tasks.create({ projectId: loose.id, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    resolveAutoGroupId.mockResolvedValueOnce('folder-group');

    await service.start(task.id, start());

    expect(resolveAutoGroupId).toHaveBeenCalledWith({
      cwd: '/tmp/geniro-task-runs-loose',
      teamId: null,
    });
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'folder-group' }),
    );
  });

  it('consults the folder rule when the project still names a group that no longer exists', async () => {
    // A binding left by a group deleted before the delete released projects.
    await projectDao.updateById(projectId, { groupId: 'ghost-group' });
    const task = await seed();
    resolveAutoGroupId.mockResolvedValueOnce('folder-group');

    await service.start(task.id, start());

    expect(resolveAutoGroupId).toHaveBeenCalledWith({
      cwd: '/tmp/geniro-task-runs-spec',
      teamId: null,
    });
    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'folder-group' }),
    );
  });

  it('consults the folder rule once deleting the project’s group released it', async () => {
    const sidebar = new RunGroupsService(
      em,
      new RunGroupDao(em),
      runDao,
      projectDao,
      new AgentEventBus(),
    );
    const bound = await sidebar.create({ name: 'Boards' });
    await projectDao.updateById(projectId, { groupId: bound.id });
    await sidebar.remove(bound.id);
    expect(
      (await new ProjectDao(orm.em.fork()).getById(projectId))?.groupId,
    ).toBeNull();
    const task = await seed();
    resolveAutoGroupId.mockResolvedValueOnce('folder-group');

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, groupId: 'folder-group' }),
    );
  });

  it('hands the chat the card’s IDENTIFIER as well as its id', async () => {
    // The sidebar labels a task thread `GEN-12`, and it holds run rows and no
    // board — so the run has to carry the name. It is two rows away (the
    // card's number, the project's key) and `v1/agents` may not read either,
    // which is why this service is what writes it down.
    const named = await projectDao.create({
      name: 'Geniro',
      folder: '/tmp/geniro-task-runs-named',
      agentKind: 'claude',
      taskKey: 'GEN',
    });
    const task = await tasks.create({ projectId: named.id, title: 'ship it' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ taskIdentifier: `GEN-${task.number}` }),
    );
  });

  it('says NOTHING for a board that has no key', async () => {
    // Absent rather than null: the create input spells it `taskIdentifier?:
    // string`, exactly as `taskId` is spelled, so a board from before
    // identifiers existed sends no field at all and the thread simply draws no
    // label — the same answer as a chat nobody started from a card.
    const task = await seed();

    await service.start(task.id, start());

    const sent = createChat.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('taskIdentifier' in sent).toBe(false);
  });

  it('falls back to the project’s standing run configuration', async () => {
    const task = await seed();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledWith(
      expect.objectContaining({ agentKind: 'claude' }),
    );
  });

  it('sends the task’s title and description as the opening message', async () => {
    const task = await seed({
      title: 'Fix the cap',
      description: 'It is off by one.',
    });

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith(
      'run-1',
      'Fix the cap\n\nIt is off by one.',
    );
  });

  it('keeps the user’s own instructions apart from the report ask', async () => {
    // The user's text is theirs to purge (`forget-custom-instructions`); the
    // ask is geniro's, so it travels in the card's own field.
    const task = await seed();

    await service.start(
      task.id,
      start({ customInstructions: 'Always use pnpm.' }),
    );

    const [passed] = createChat.mock.calls[0] as [
      { customInstructions?: string; taskInstructions?: string },
    ];
    expect(passed.customInstructions).toBe('Always use pnpm.');
    expect(passed.taskInstructions).toBe(TASK_REPORT_INSTRUCTIONS);
  });

  it('hands the chat a press creates the user’s reply language', async () => {
    const task = await seed();

    await service.start(task.id, start({ replyLanguage: 'Russian' }));

    const [passed] = createChat.mock.calls[0] as [{ replyLanguage?: string }];
    expect(passed.replyLanguage).toBe('Russian');
  });

  it('hands the chat a press creates the user’s per-CLI switches', async () => {
    // Snapshotted at run creation, so a press that dropped them would run the
    // card with every option at its default — claude's browser tools off for a
    // user who turned them on.
    const task = await seed();
    const agentOptions = { claude: { browserTools: true } };

    await service.start(task.id, start({ agentOptions }));

    const [passed] = createChat.mock.calls[0] as [{ agentOptions?: unknown }];
    expect(passed.agentOptions).toEqual(agentOptions);
  });

  it('composes the LABEL block, then the report ask, into the card’s own field and never into the user’s', async () => {
    forTask.mockResolvedValueOnce([aLabelInstruction()]);
    const task = await seed();

    await service.start(
      task.id,
      start({ customInstructions: 'Always use pnpm.' }),
    );

    expect(forTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: task.id }),
    );
    const [passed] = createChat.mock.calls[0] as [
      { customInstructions?: string; taskInstructions: string },
    ];
    expect(passed.customInstructions).toBe('Always use pnpm.');
    const labelIndex = passed.taskInstructions.indexOf(
      'Write a regression test.',
    );
    const reportIndex = passed.taskInstructions.indexOf(
      TASK_REPORT_INSTRUCTIONS,
    );
    expect(labelIndex).toBeGreaterThan(0);
    expect(reportIndex).toBeGreaterThan(labelIndex);
  });

  it('composes a label block alone when the user left no instructions of their own', async () => {
    forTask.mockResolvedValueOnce([aLabelInstruction()]);
    const task = await seed();

    await service.start(task.id, start());

    const [passed] = createChat.mock.calls[0] as [
      { customInstructions?: string; taskInstructions: string },
    ];
    expect(passed.customInstructions).toBeUndefined();
    expect(passed.taskInstructions).toBe(
      [
        "Instructions attached to this task's labels:",
        '',
        '## Label "bug"',
        'Write a regression test.',
        '',
        TASK_REPORT_INSTRUCTIONS,
      ].join('\n'),
    );
  });

  it('hands the AGENT every label instruction whole, however long', async () => {
    // Past the old 16,000-character cap, which used to leave this row out.
    const huge = 'x'.repeat(20_000);
    forTask.mockResolvedValueOnce([
      aLabelInstruction({ id: 'li-1', label: 'huge', instructions: huge }),
      aLabelInstruction({
        id: 'li-2',
        label: 'short',
        instructions: 'fits fine',
      }),
    ]);
    const task = await seed();

    await service.start(task.id, start());

    const [passed] = createChat.mock.calls[0] as [{ taskInstructions: string }];
    expect(passed.taskInstructions).toContain(`## Label "huge"\n${huge}\n\n`);
    expect(passed.taskInstructions).toContain('## Label "short"\nfits fine');
  });

  it('refuses a second start while the first run is still working', async () => {
    const task = await seed();
    await service.start(task.id, start());

    await expect(
      service.start(task.id, start({ from: 'in_progress' })),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already being worked'),
    });
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('refuses a card dragged out of in_progress while its agent works on', async () => {
    const task = await seed();
    await service.start(task.id, start());
    // Someone drags the card back by hand; the run it started is still live,
    // so the status alone can no longer answer whether a start is safe.
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'todo' });

    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('already being worked'),
    });
  });

  /** Work the card, settle its run, and send it back to `todo` for a re-run. */
  const settleAndReturn = async (taskId: string): Promise<void> => {
    const finished = await runDao.getById('run-1');
    if (finished) {
      finished.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(taskId, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();
    sendMessage.mockClear();
  };

  it('re-runs a settled card in the thread it already has', async () => {
    // REPORTED as "now i can run already completed task - and it will create
    // new thread", and settled as "let's always continue in existing one". The
    // conversation is the card's history; a second thread discards it and
    // leaves two rows in the sidebar under one card's identifier.
    //
    // Continuity is the point here, and a matching agent must not be read as a
    // change just because the target is now consulted on every start.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);

    await expect(service.start(task.id, start())).resolves.toMatchObject({
      status: 'in_progress',
      runId: 'run-1',
    });
    expect(createChat).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
  });

  it('sends a continued thread the user’s OWN words, not the brief again', async () => {
    // The brief is already in this conversation. Repeating it buries the one
    // new sentence under a paragraph the agent has read before.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);

    await service.start(task.id, start({ prompt: 'The tests still fail.' }));

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'The tests still fail.');
  });

  it('refreshes a continued thread’s task instructions from the CURRENT label rows before sending', async () => {
    // The thread was created under one label instruction; the user then edited
    // it and added a label. Read off the row AT the moment of the send, since
    // that is what `ChatService.sendMessage` builds the turn from — and read
    // through a fresh fork, so the row is asserted rather than a cached entity.
    forTask.mockResolvedValueOnce([
      aLabelInstruction({ instructions: 'Old wording.' }),
    ]);
    const task = await seed();
    await service.start(
      task.id,
      start({ customInstructions: 'Always use pnpm.' }),
    );
    await settleAndReturn(task.id);
    forTask.mockResolvedValueOnce([
      aLabelInstruction({ instructions: 'New wording.' }),
      aLabelInstruction({
        id: 'li-2',
        label: 'frontend',
        instructions: 'Added after the first run.',
      }),
    ]);
    let atSend: Run | null = null;
    sendMessage.mockImplementationOnce(async (runId: string) => {
      atSend = await new RunDao(orm.em.fork()).getById(runId);
    });

    await service.start(task.id, start());

    expect(createChat).not.toHaveBeenCalled();
    const seen = atSend as Run | null;
    expect(seen?.taskInstructions).toContain('New wording.');
    expect(seen?.taskInstructions).toContain('Added after the first run.');
    expect(seen?.taskInstructions).not.toContain('Old wording.');
    expect(seen?.taskInstructions).toContain(TASK_REPORT_INSTRUCTIONS);
    // The user's own snapshot is not the card's to rewrite.
    expect(seen?.customInstructions).toBe('Always use pnpm.');
  });

  it('drops the label block from a continued thread whose labels were ALL removed', async () => {
    // The refresh must also SHRINK: a card that lost every label goes back to
    // the report ask alone, not to the block it was started with.
    forTask.mockResolvedValueOnce([aLabelInstruction()]);
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    forTask.mockResolvedValueOnce([]);
    let atSend: Run | null = null;
    sendMessage.mockImplementationOnce(async (runId: string) => {
      atSend = await new RunDao(orm.em.fork()).getById(runId);
    });

    await service.start(task.id, start());

    expect(createChat).not.toHaveBeenCalled();
    expect((atSend as Run | null)?.taskInstructions).toBe(
      TASK_REPORT_INSTRUCTIONS,
    );
  });

  it('leaves the card where it was when a continued thread’s label lookup fails', async () => {
    // The lookup comes before the move to `in_progress`, so a failure has no
    // reservation to undo and no turn is sent on stale instructions. The spy
    // is what proves the card never MOVED: a lookup placed after the move
    // would still end in `todo`, via the failure branch's move back.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    forTask.mockRejectedValueOnce(new Error('database locked'));
    const moveStatus = vi.spyOn(tasks, 'moveStatus');

    await expect(service.start(task.id, start())).rejects.toThrow(
      'database locked',
    );

    expect(moveStatus).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
    moveStatus.mockRestore();
  });

  it('opens a NEW thread when the old one was deleted', async () => {
    // A card whose conversation the user threw away has nothing to continue,
    // and that is not an error — it is the ordinary way back to a fresh start.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    await runDao.hardDeleteIncludingSoftDeleted({ id: 'run-1' }, em);

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW thread when the old one is ARCHIVED', async () => {
    // An archived chat is inert by design — `sendMessage` refuses it with
    // `RUN_ARCHIVED` — so continuing into one would turn a press of Run into a
    // failure the user cannot act on from the board.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const shelved = await runDao.getById('run-1');
    if (shelved) {
      shelved.archivedAt = new Date();
      await em.flush();
    }

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
  });

  it('opens a NEW thread when the card has been re-pointed at another agent', async () => {
    // The Agent control is settable per card, and a card that has run once
    // would otherwise keep running the CLI it was first started on — panel
    // showing the new one, every press continuing the old thread, and no way
    // out short of deleting the run.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).agentKind = 'cursor-agent';
    await em.flush();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(createChat.mock.calls[0]?.[0]).toMatchObject({
      agentKind: 'cursor-agent',
    });
    expect(sendMessage).not.toHaveBeenCalledWith('run-1', expect.anything());
  });

  it('starts a chat with only the approval its CLI offers', async () => {
    // A card saved with a mode its CLI no longer offers must still run.
    const task = await seed();
    offeredApproval.mockReturnValue(undefined);

    await service.start(task.id, start());

    expect(offeredApproval).toHaveBeenCalled();
    expect(createChat.mock.calls[0]?.[0]).toMatchObject({
      approval: undefined,
    });
  });

  it('forces the autopilot approval onto a thread it CONTINUES', async () => {
    // The deadlock the design calls non-negotiable, reached by the re-run path:
    // `ChatService` reads the mode off the RUN row and falls back to `ask`, so
    // an unattended turn resumed into a thread opened under any other mode
    // parks on a permission card forever — holding its slot and its worktree,
    // and invisible to the failure breaker, because parked is not failed.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    updateSettings.mockClear();

    await service.start(task.id, { ...start(), startedBy: 'autopilot' });

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    // EXACTLY that key and no other — not `objectContaining`, which is what let
    // the defect below through review. `updateSettings` branches on a key being
    // PRESENT, so an unresolved rung carried as an explicit null is an
    // instruction rather than silence.
    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      approval: AUTOPILOT_APPROVAL,
      taskInstructions: TASK_REPORT_INSTRUCTIONS,
    });
  });

  it('patches ONLY the task instructions when the card resolves no settings', async () => {
    // `configDir: null` is not "leave it alone": it reaches `moveToConfigDir`,
    // which refuses outright for a CLI that reads no config directory, so every
    // re-press on a cursor-agent card answered 400 — and `model: null` is a
    // CLEAR that takes the run's context window and model parameters with it.
    // This project names an agent and nothing else, so the patch carries the
    // card's own instructions and no settings key at all.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      taskInstructions: TASK_REPORT_INSTRUCTIONS,
    });
  });

  it('sends ONLY the rungs that resolved, never the ones that did not', async () => {
    // The mixed case the two specs above cannot reach on their own: one field
    // set on the card leaves the other three unresolved, and each of those is
    // destructive if carried through as a null.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).effort = 'high';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      effort: 'high',
      taskInstructions: TASK_REPORT_INSTRUCTIONS,
    });
  });

  it('sends the two DESTRUCTIVE rungs when they resolve, and nothing else', async () => {
    // `model` and `configDir` are the pair whose presence carries a side
    // effect, so each needs a positive case of its own: with only the
    // absent-case and `effort` covered, a mistyped arm (`configDir:
    // target.model`) or a dropped `model` line would pass every other spec
    // here.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).model = 'opus';
    (row as Task).configDir = '/tmp/geniro-profile';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      model: 'opus',
      configDir: '/tmp/geniro-profile',
      taskInstructions: TASK_REPORT_INSTRUCTIONS,
    });
  });

  it('omits a model the run is ALREADY on', async () => {
    // `updateSettings` reads a present `model` as a CHANGE and clears the
    // run's context window and model parameters with it, so re-pressing Run on
    // an unchanged card would silently drop a `1m` window the user set inside
    // that thread. Sending the value is as destructive as sending a null here;
    // only leaving the key out is safe.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    const row = await taskDao.getById(task.id);
    (row as Task).model = 'opus';
    const runRow = await runDao.getById('run-1');
    (runRow as Run).model = 'opus';
    await em.flush();
    updateSettings.mockClear();

    await service.start(task.id, start());

    expect(sendMessage).toHaveBeenCalledWith('run-1', 'ship it');
    expect(updateSettings).toHaveBeenCalledWith('run-1', {
      taskInstructions: TASK_REPORT_INSTRUCTIONS,
    });
  });

  it('does NOT delete the run when continuing it fails', async () => {
    // The whole difference between `resume`'s failure branch and `abandon`:
    // this thread is the card's history, and a transient send failure is not a
    // reason to destroy the conversation, its items and its attachments.
    const task = await seed();
    await service.start(task.id, start());
    await settleAndReturn(task.id);
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    expect(deleteChat).not.toHaveBeenCalled();
    expect(await runDao.getById('run-1')).not.toBeNull();
    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
  });

  /** Run a team-targeted card once, settle it, and return it to `todo`. */
  const runTeamAndReturn = async (taskId: string): Promise<void> => {
    const row = await taskDao.getById(taskId);
    (row as Task).teamSlug = 'dev-team';
    await em.flush();
    await service.start(taskId, start());
    const finished = await runDao.getById('wf-run-1');
    if (finished) {
      finished.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(taskId, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();
    sendMessage.mockClear();
    startTeamRun.mockClear();
  };

  describe('a team card run again', () => {
    it('continues the run it already has, with the user’s own words, and makes no second run', async () => {
      // Follow up and a second Run press both say they continue the card's
      // thread. A fresh run would make a second thread for one card and a team
      // with no memory of the first pass; the executor's own follow-up path
      // starts the settled run's trigger member again, every member resuming
      // its session.
      const task = await seed();
      await runTeamAndReturn(task.id);

      const continued = await service.start(
        task.id,
        start({ prompt: 'Now add the tests.', branch: 'geniro/task-1b' }),
      );

      expect(sendTeamMessage).toHaveBeenCalledTimes(1);
      expect(sendTeamMessage).toHaveBeenCalledWith(
        'wf-run-1',
        'Now add the tests.',
      );
      expect(startTeamRun).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(await runDao.count({ taskId: task.id })).toBe(1);
      // Everything else a start does still happens: the card is worked again
      // and names the run, with the worktree and branch this press prepared.
      expect(continued).toMatchObject({
        status: 'in_progress',
        runId: 'wf-run-1',
        branch: 'geniro/task-1b',
        worktreePath: worktree,
      });
      // Read on a fresh fork: this spec's own `em` still holds the card as the
      // helper above loaded it.
      const stored = await taskDao.getById(task.id, orm.em.fork());
      expect(stored?.status).toBe('in_progress');
      expect(stored?.runId).toBe('wf-run-1');
    });

    it('sends the brief again when the press says nothing, as the agent arm does', async () => {
      const task = await seed({
        title: 'Fix the cap',
        description: 'Off by one.',
      });
      await runTeamAndReturn(task.id);

      await service.start(task.id, start());

      expect(sendTeamMessage).toHaveBeenCalledWith(
        'wf-run-1',
        'Fix the cap\n\nOff by one.',
      );
    });

    it('starts a new run when the card has been re-pointed at ANOTHER team', async () => {
      // Continuing would run the old team for good, with the panel showing
      // the new one and no way out short of deleting the run.
      const task = await seed();
      await runTeamAndReturn(task.id);
      const row = await taskDao.getById(task.id);
      (row as Task).teamSlug = 'review-team';
      await em.flush();

      const started = await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledTimes(1);
      expect(startTeamRun.mock.calls[0]?.[0]).toBe('review-team');
      expect(sendTeamMessage).not.toHaveBeenCalled();
      expect(started.runId).not.toBe('wf-run-1');
    });

    it('starts a new run when the card held a CHAT and now names a team', async () => {
      const task = await seed();
      await service.start(task.id, start());
      await settleAndReturn(task.id);
      const row = await taskDao.getById(task.id);
      (row as Task).teamSlug = 'dev-team';
      await em.flush();

      await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledTimes(1);
      expect(sendTeamMessage).not.toHaveBeenCalled();
    });

    it('starts a new run when the old one is ARCHIVED', async () => {
      // `assertRunTakesMessage` refuses an archived run with `RUN_ARCHIVED`,
      // which the board could do nothing about.
      const task = await seed();
      await runTeamAndReturn(task.id);
      const shelved = await runDao.getById('wf-run-1');
      (shelved as Run).archivedAt = new Date();
      await em.flush();

      await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledTimes(1);
      expect(sendTeamMessage).not.toHaveBeenCalled();
    });

    it('starts a new run when the old one was DELETED', async () => {
      const task = await seed();
      await runTeamAndReturn(task.id);
      await runDao.hardDeleteIncludingSoftDeleted({ id: 'wf-run-1' }, em);

      await service.start(task.id, start());

      expect(startTeamRun).toHaveBeenCalledTimes(1);
      expect(sendTeamMessage).not.toHaveBeenCalled();
    });

    it('returns the card and keeps the run when the send is refused', async () => {
      // `resume`'s rule: the run is the card's history, and a send that
      // failed (a pass still tearing down answers RUN_BUSY) destroys nothing.
      const task = await seed();
      await runTeamAndReturn(task.id);
      sendTeamMessage.mockRejectedValueOnce(new Error('RUN_BUSY'));

      await expect(service.start(task.id, start())).rejects.toThrow('RUN_BUSY');

      expect(deleteTeamRun).not.toHaveBeenCalled();
      expect(await runDao.getById('wf-run-1')).not.toBeNull();
      const stored = await taskDao.getById(task.id, orm.em.fork());
      expect(stored?.status).toBe('todo');
      expect(stored?.runId).toBe('wf-run-1');
    });

    it('lets the AUTOPILOT continue a run whose own team never asks', async () => {
      teamApprovals = { 'dev-team': 'auto' };
      snapshotApprovals = { 'dev-team': 'auto' };
      const task = await seed();
      await runTeamAndReturn(task.id);

      await service.start(task.id, start({ startedBy: 'autopilot' }));

      expect(sendTeamMessage).toHaveBeenCalledWith('wf-run-1', 'ship it');
      expect(startTeamRun).not.toHaveBeenCalled();
    });

    it('starts the AUTOPILOT a new run when the run’s own team can still ask', async () => {
      // The library copy was vetted as unattended; the run uses its SNAPSHOT,
      // started before the team was edited, whose member would park on a
      // permission card nobody is there to answer.
      teamApprovals = { 'dev-team': 'auto' };
      snapshotApprovals = { 'dev-team': 'ask' };
      const task = await seed();
      await runTeamAndReturn(task.id);

      await service.start(task.id, start({ startedBy: 'autopilot' }));

      expect(sendTeamMessage).not.toHaveBeenCalled();
      expect(startTeamRun).toHaveBeenCalledTimes(1);
    });

    it('starts the AUTOPILOT a new run when the run’s own team cannot be read', async () => {
      teamApprovals = { 'dev-team': 'auto' };
      const task = await seed();
      await runTeamAndReturn(task.id);

      await service.start(task.id, start({ startedBy: 'autopilot' }));

      expect(sendTeamMessage).not.toHaveBeenCalled();
      expect(startTeamRun).toHaveBeenCalledTimes(1);
    });
  });

  it('refuses to send a chat message into a TEAM run', async () => {
    // The card is re-pointed at an agent AFTER a team run, so the press now
    // resolves to the agent arm while the run it holds is still a team
    // run. `sendMessage` is guarded by `assertChatRun` and would answer
    // `NOT_A_CHAT_RUN`, leaving the card permanently un-runnable.
    //
    // The row carries an `agentKind` as well, which a team run does not
    // normally have: without it the agent-match disqualifier one line below
    // already refuses this run, and the `teamId` clause — the one this
    // test exists for — is never reached.
    const task = await seed();
    await runTeamAndReturn(task.id);
    const graphRun = await runDao.getById('wf-run-1');
    if (graphRun) {
      graphRun.agentKind = 'claude';
      await em.flush();
    }
    const row = await taskDao.getById(task.id);
    (row as Task).teamSlug = null;
    await em.flush();

    await service.start(task.id, start());

    expect(createChat).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalledWith('wf-run-1', expect.anything());
  });

  it('carries the press’s own words into a NEW thread’s brief', async () => {
    const task = await seed({
      title: 'Fix the cap',
      description: 'Off by one.',
    });

    await service.start(task.id, start({ prompt: 'Start with the parser.' }));

    expect(sendMessage).toHaveBeenCalledWith(
      'run-1',
      'Fix the cap\n\nOff by one.\n\nStart with the parser.',
    );
  });

  it('returns the card to where it was when the chat cannot be created', async () => {
    const task = await seed();
    createChat.mockRejectedValueOnce(new Error('no such agent'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'no such agent',
    );

    // The move is the reservation, so a start that fails must undo it — a card
    // left in `in_progress` with no run is one no board can start again.
    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
    expect(stored?.runId).toBeNull();
    expect(stored?.worktreePath).toBeNull();
  });

  it('returns the card when the opening message fails, keeping nothing half-started', async () => {
    const task = await seed();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    const stored = await taskDao.getById(task.id);
    expect(stored?.status).toBe('todo');
    expect(stored?.runId).toBeNull();
  });

  /**
   * A card that has already been worked in `run-1`, settled and back in To
   * do — the state a card is routinely in when its target is changed.
   */
  const workedOnce = async () => {
    const task = await seed();
    await service.start(task.id, start());
    const earlier = await runDao.getById('run-1');
    if (earlier) {
      earlier.status = 'completed';
      await em.flush();
    }
    await tasks.moveStatus(task.id, { from: 'in_progress', to: 'todo' });
    createChat.mockClear();
    sendMessage.mockClear();
    return task;
  };

  /** The card's edge, read through a FRESH fork — the spec's own `em` caches. */
  const edgeOf = async (taskId: string) => {
    const stored = await taskDao.getById(
      taskId,
      orm.em.fork() as EntityManager,
    );
    return {
      status: stored?.status,
      runId: stored?.runId,
      branch: stored?.branch,
      worktreePath: stored?.worktreePath,
    };
  };

  // `run-1` still names the card through `Run.taskId`, so nulling the card's
  // end left a conversation claiming a card that had forgotten it — and the
  // next press opened a second thread beside it.
  it('keeps the card’s earlier thread when a start fails before making a run', async () => {
    const task = await workedOnce();
    const row = await taskDao.getById(task.id);
    (row as Task).teamSlug = 'deleted-from-the-library';
    await em.flush();
    startTeamRun.mockRejectedValueOnce(new Error('TEAM_NOT_FOUND'));

    await expect(
      service.start(task.id, start({ branch: 'geniro/other' })),
    ).rejects.toThrow('TEAM_NOT_FOUND');

    expect(await edgeOf(task.id)).toEqual({
      status: 'todo',
      runId: 'run-1',
      branch: 'geniro/task-1',
      worktreePath: worktree,
    });
  });

  it('puts the earlier thread back when a start fails after writing its own', async () => {
    const task = await workedOnce();
    // Another agent, so the press opens a NEW thread rather than continuing
    // `run-1` — and records it on the card before the send that fails.
    const row = await taskDao.getById(task.id);
    (row as Task).agentKind = 'cursor-agent';
    await em.flush();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(
      service.start(task.id, start({ branch: 'geniro/other' })),
    ).rejects.toThrow('agent refused');

    expect(deleteChat).toHaveBeenCalledWith('run-2');
    expect(await edgeOf(task.id)).toEqual({
      status: 'todo',
      runId: 'run-1',
      branch: 'geniro/task-1',
      worktreePath: worktree,
    });
  });

  // The restore re-checks `worktreePath` exists, so it can throw on its own —
  // and a card left in `in_progress` is refused by the very guard that
  // protects a live run, which is worse than a lost link.
  it('still returns the card to its column when putting the thread back fails', async () => {
    const task = await workedOnce();
    const row = await taskDao.getById(task.id);
    (row as Task).agentKind = 'cursor-agent';
    await em.flush();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));
    const real = tasks.update.bind(tasks);
    const update = vi
      .spyOn(tasks, 'update')
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('INVALID_WORKTREE_PATH'))
      .mockImplementation(real);

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    expect(update).toHaveBeenCalledTimes(2);
    expect((await edgeOf(task.id)).status).toBe('todo');
    update.mockRestore();
  });

  it('refuses when neither the request nor the project names an agent', async () => {
    const bare = await projectDao.create({
      name: 'No agent',
      folder: '/tmp/geniro-task-runs-bare',
    });
    const task = await tasks.create({ projectId: bare.id, title: 'orphan' });
    await tasks.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('no agent or team'),
    });
    expect(createChat).not.toHaveBeenCalled();
  });

  it('refuses a SECOND start that arrives while the first is still in flight', async () => {
    const task = await seed();
    // `moveStatus` reads and then writes across an await, so two requests
    // arriving together can both find the card in `todo` and both pass it.
    // The synchronous claim is what closes that window, and losing the race
    // means two agents in two worktrees on one card.
    let release: (() => void) | undefined;
    createChat.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          release = () => {
            resolve(runWire('run-1'));
          };
        }),
    );

    const first = service.start(task.id, start());
    await expect(service.start(task.id, start())).rejects.toMatchObject({
      message: expect.stringContaining('already starting a run'),
    });

    // Release only once the first start has actually reached `createChat` —
    // it awaits the card read and the status move before it gets there.
    while (createChat.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release?.();
    await first.catch(() => undefined);
    expect(createChat).toHaveBeenCalledTimes(1);
  });

  // ── The autopilot's own bounds ─────────────────────────────────────────────
  //
  // The queue route narrows its handout to the free slots, and that is a
  // convenience: nothing obliges a conductor to ask. These pin the refusal at
  // the place the run is actually made.

  const arm = async (patch: {
    cap?: number;
    streak?: number;
  }): Promise<void> => {
    const project = await projectDao.getById(projectId, em);
    if (patch.cap !== undefined) {
      (project as Project).autopilotMaxConcurrent = patch.cap;
    }
    if (patch.streak !== undefined) {
      (project as Project).autopilotFailureStreak = patch.streak;
    }
    await em.flush();
  };

  it('refuses an autopilot start once the project is at its cap', async () => {
    await arm({ cap: 1 });
    const working = await seed({ title: 'working' });
    await service.start(working.id, start());
    const next = await seed({ title: 'next' });

    await expect(
      service.start(next.id, { ...start(), startedBy: 'autopilot' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('is already running 1 of 1'),
    });
  });

  // The cap bounds a TIMER, not the person. Refusing them here would also mean
  // they could not run anything while the autopilot held every slot.
  it('lets a person start past the cap the autopilot is held to', async () => {
    await arm({ cap: 1 });
    const working = await seed({ title: 'working' });
    await service.start(working.id, start());
    const next = await seed({ title: 'next' });

    const started = await service.start(next.id, start());

    expect(started.status).toBe('in_progress');
  });

  it('refuses an autopilot start while the breaker is open', async () => {
    await arm({ streak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    const task = await seed();

    await expect(
      service.start(task.id, { ...start(), startedBy: 'autopilot' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('re-arm it'),
    });
  });

  it('refuses an autopilot start while a usage limit stands, and lets a person start', async () => {
    const row = await projectDao.getById(projectId, em);
    (row as Project).autopilotLimitUntil = new Date(Date.now() + 60_000);
    await em.flush();
    const task = await seed();

    await expect(
      service.start(task.id, { ...start(), startedBy: 'autopilot' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('usage limit'),
    });

    const started = await service.start(task.id, start());

    expect(started.status).toBe('in_progress');
  });

  // How a user checks that whatever broke is fixed, before re-arming.
  it('lets a person start while the breaker is open', async () => {
    await arm({ streak: PROJECT_FAILURE_BREAKER_THRESHOLD });
    const task = await seed();

    const started = await service.start(task.id, start());

    expect(started.status).toBe('in_progress');
  });

  // The race neither the per-card claim nor the status compare-and-set can
  // see: two conductors picking two DIFFERENT cards, both counting a free
  // slot, both starting. Only serializing a project's starts closes it.
  it('keeps two simultaneous autopilot starts inside a cap of one', async () => {
    await arm({ cap: 1 });
    const first = await seed({ title: 'first' });
    const second = await seed({ title: 'second' });

    const settled = await Promise.allSettled([
      service.start(first.id, { ...start(), startedBy: 'autopilot' }),
      service.start(second.id, { ...start(), startedBy: 'autopilot' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(createChat).toHaveBeenCalledTimes(1);
    const inProgress = (await taskDao.listForProject(projectId)).filter(
      (task) => task.status === 'in_progress',
    );
    expect(inProgress).toHaveLength(1);
  });

  describe('a card its user STOPPED', () => {
    const stop = async (taskId: string): Promise<void> => {
      await taskDao.setStoppedAt(taskId, new Date(), em);
    };
    const stoppedAtOf = async (taskId: string): Promise<Date | null> =>
      (await taskDao.getById(taskId, orm.em.fork() as EntityManager))
        ?.stoppedAt ?? null;

    it('refuses an AUTOPILOT start — the queue’s hold is the fast answer, this is the line', async () => {
      const task = await seed();
      await stop(task.id);

      await expect(
        service.start(task.id, { ...start(), startedBy: 'autopilot' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining('stopped by its user'),
      });
      expect(createChat).not.toHaveBeenCalled();
      expect(await stoppedAtOf(task.id)).toBeInstanceOf(Date);
    });

    it('is the autopilot’s again once a Run press has actually started it', async () => {
      const task = await seed();
      await stop(task.id);

      await service.start(task.id, start());

      expect(await stoppedAtOf(task.id)).toBeNull();
    });

    it('holds a card a crash cut off the same way, until a Run press clears it', async () => {
      const task = await seed();
      await taskDao.setStoppedAt(task.id, new Date(), em, 'crash');

      await expect(
        service.start(task.id, { ...start(), startedBy: 'autopilot' }),
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          'the daemon crashed while its agent was working',
        ),
      });
      expect(createChat).not.toHaveBeenCalled();

      await service.start(task.id, start());

      const after = await taskDao.getById(
        task.id,
        orm.em.fork() as EntityManager,
      );
      expect(after?.stoppedAt).toBeNull();
      expect(after?.interruptedBy).toBeNull();
    });

    it('stays stopped when the press that would have restarted it failed', async () => {
      // Nothing the user asked for has happened yet, so the card is not the
      // autopilot's to take.
      const task = await seed();
      await stop(task.id);
      sendMessage.mockRejectedValueOnce(new Error('agent refused'));

      await expect(service.start(task.id, start())).rejects.toThrow(
        'agent refused',
      );

      expect(await stoppedAtOf(task.id)).toBeInstanceOf(Date);
    });
  });

  describe('a card whose worktree the autopilot could not prepare', () => {
    const failureOf = async (
      taskId: string,
    ): Promise<{ at: Date | null; reason: string | null }> => {
      const task = await taskDao.getById(
        taskId,
        orm.em.fork() as EntityManager,
      );
      return {
        at: task?.prepareFailedAt ?? null,
        reason: task?.prepareFailedReason ?? null,
      };
    };

    it.each([
      ['a Run press', {}],
      ['a later autopilot start', { startedBy: 'autopilot' as const }],
    ])('forgets the failure once %s has started it', async (_, by) => {
      const task = await seed();
      await taskDao.setPrepareFailure(
        task.id,
        { at: new Date(), reason: "fatal: 'x' is already used by worktree" },
        em,
      );

      await service.start(task.id, { ...start(), ...by });

      expect(await failureOf(task.id)).toEqual({ at: null, reason: null });
    });

    it('keeps the failure when the start that would have cleared it failed', async () => {
      const task = await seed();
      await taskDao.setPrepareFailure(
        task.id,
        { at: new Date(), reason: 'fatal: nope' },
        em,
      );
      sendMessage.mockRejectedValueOnce(new Error('agent refused'));

      await expect(service.start(task.id, start())).rejects.toThrow(
        'agent refused',
      );

      expect((await failureOf(task.id)).reason).toBe('fatal: nope');
    });
  });

  it('takes the run down with the card when a start fails after creating it', async () => {
    const task = await seed();
    sendMessage.mockRejectedValueOnce(new Error('agent refused'));

    await expect(service.start(task.id, start())).rejects.toThrow(
      'agent refused',
    );

    // Otherwise the chat survives naming a card that no longer names it back,
    // with its working directory already pruned by the caller.
    expect(deleteChat).toHaveBeenCalledWith('run-1');
  });
});
