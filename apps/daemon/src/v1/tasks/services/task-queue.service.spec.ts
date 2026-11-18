import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectQueueService } from '../../projects/services/project-queue.service';
import { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { TeamOverlayService } from '../../teams/services/team-overlay.service';
import { TeamOverlayStoreService } from '../../teams/services/team-overlay-store.service';
import { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import { RUN_TARGET_PROBLEM_REASON } from '../utils/run-target';
import {
  missingTeamReason,
  PREPARE_FAILURE_RETRY_MS,
  STOPPED_BY_USER_REASON,
  TaskQueueService,
  worktreeUnpreparedReason,
} from './task-queue.service';

/** A minimal, valid single-member team — content is irrelevant to this spec. */
const DEV_TEAM_TEAM: Team = teamOf([member('coder')], { name: 'Dev Team' });

/**
 * Real database, real DAOs, real `TeamStoreService` over a throwaway
 * library directory — the split under test JOINS the two, so faking either
 * side would assert the wiring and prove nothing about the join.
 *
 * This spec owns the eligible/blocked tests that used to live in
 * `ProjectQueueService`'s own spec; that service now answers `readRaw` alone
 * (see its spec for the raw-count coverage).
 */
describe('TaskQueueService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let projectQueue: ProjectQueueService;
  let service: TaskQueueService;
  let teams: TeamStoreService;
  let projectDao: ProjectDao;
  let taskDao: TaskDao;
  let runDao: RunDao;
  let em: EntityManager;
  let folder: string;
  let teamsDir: string;
  let projectId: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-task-queue-'));
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
    projectQueue = new ProjectQueueService(em, projectDao, taskDao, runDao);

    teamsDir = mkdtempSync(join(tmpdir(), 'geniro-task-queue-teams-'));
    teams = new TeamStoreService({ teamsDir });
    // Present in the library for every test unless a test says otherwise — the
    // existing 'BLOCKS a card whose only target is a TEAM' behaviour is
    // about a team that DOES exist (it is simply unattended-incapable),
    // which this fixture has to keep true to stay meaningful.
    await teams.create(DEV_TEAM_TEAM, 'dev-team');

    service = new TaskQueueService(
      projectQueue,
      teams,
      new TeamOverlayService(
        new TeamOverlayStoreService({ teamsDir }),
        teams,
        projectDao,
        em,
      ),
    );

    const project = await projectDao.create({
      name: 'board',
      folder,
      // Names an agent, because the handout asks whether each card COULD be
      // started: a project with no agent and no team blocks every card on
      // its board, which is its own group of cases below rather than the
      // background condition for the ones about capacity and ordering.
      agentKind: 'claude',
      autopilotEnabled: true,
      autopilotIntakeStatus: 'todo',
      autopilotMaxConcurrent: 2,
    });
    await em.flush();
    projectId = project.id;
  });

  afterEach(() => {
    rmSync(teamsDir, { recursive: true, force: true });
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

  it('hands out the intake column, oldest first, when nothing is running', async () => {
    await addTask('second', 'todo', 1);
    await addTask('first', 'todo', 0);
    await addTask('not intake', 'backlog', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual([
      'first',
      'second',
    ]);
    expect(queue.waiting).toBe(2);
    expect(queue.running).toBe(0);
    expect(queue.cap).toBe(2);
  });

  // The handout is what the conductor cuts a worktree from, and it runs in
  // another process with only this reply in hand — so the inheritance is
  // resolved HERE. A card that names no folder takes the project's; one that
  // names its own keeps it, which is the whole point of the column.
  it('leaves a task whose run the user STOPPED to the user — the armed autopilot never restarts it', async () => {
    // REPORTED as "i stopped thread - and i seee my messae was sent second
    // time": the settle returns a stopped card to the intake column so a press
    // can start it again, and the armed autopilot read that as waiting work,
    // restarting the card within seconds and re-sending its brief.
    const stoppedRun = await addRun('cancelled');
    await addTask('stopped by me', 'todo', 0, stoppedRun.id);
    await addTask('waiting', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual(['waiting']);
    expect(queue.blocked).toEqual([
      expect.objectContaining({
        title: 'stopped by me',
        reason: STOPPED_BY_USER_REASON,
        // A Run press answers it, not the run settings — and nothing retries.
        kind: 'stopped',
        retryInMs: null,
      }),
    ]);
  });

  it('does not flag a stopped task on a DISARMED board — nothing unattended would restart it', async () => {
    await arm({ autopilotEnabled: false });
    const stoppedRun = await addRun('cancelled');
    await addTask('stopped by me', 'todo', 0, stoppedRun.id);

    const queue = await service.read(projectId);

    expect(queue.blocked).toEqual([]);
  });

  describe('a card whose worktree main could not prepare', () => {
    const GIT_LINE =
      "fatal: 'geniro/task-x' is already used by worktree at '/tmp/x'";
    // Only `Date` is frozen, so the hold's remainder the service measures is
    // exact; the database and its timers run as usual.
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: ['Date'],
        now: new Date('2026-10-16T12:00:00Z'),
      });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const failedAgo = async (task: Task, ms: number): Promise<void> => {
      await taskDao.setPrepareFailure(
        task.id,
        { at: new Date(Date.now() - ms), reason: GIT_LINE },
        em,
      );
    };

    it('is held in blocked with git’s reason, and does not take the one free slot from the card behind it', async () => {
      // The starvation this exists for: cap 1, the failing card at the head of
      // the column, handed out (and failing) on every tick.
      await arm({ autopilotMaxConcurrent: 1 });
      const head = await addTask('head', 'todo', 0);
      await addTask('behind', 'todo', 1);
      await failedAgo(head, 30_000);

      const queue = await service.read(projectId);

      expect(queue.eligible.map((task) => task.title)).toEqual(['behind']);
      expect(queue.blocked).toEqual([
        {
          id: head.id,
          title: 'head',
          reason: worktreeUnpreparedReason(GIT_LINE),
          kind: 'worktree',
          // What is left of the hold, so an open board can re-read then.
          retryInMs: 5 * 60_000 - 30_000,
        },
      ]);
      expect(queue.blocked[0]?.reason).toContain(GIT_LINE);
    });

    it.each([
      ['exactly', PREPARE_FAILURE_RETRY_MS],
      ['a second past', PREPARE_FAILURE_RETRY_MS + 1_000],
    ])(
      'is handed out again %s the backoff, so a failure that healed does not park it',
      async (_, ago) => {
        await arm({ autopilotMaxConcurrent: 1 });
        const head = await addTask('head', 'todo', 0);
        await addTask('behind', 'todo', 1);
        await failedAgo(head, ago);

        const queue = await service.read(projectId);

        expect(queue.eligible.map((task) => task.title)).toEqual(['head']);
        expect(queue.blocked).toEqual([]);
      },
    );

    it('is handed out when its mark lies in the future — a clock set back must not hold it for hours', async () => {
      await arm({ autopilotMaxConcurrent: 1 });
      const head = await addTask('head', 'todo', 0);
      await failedAgo(head, -60 * 60_000);

      const queue = await service.read(projectId);

      expect(queue.eligible.map((task) => task.title)).toEqual(['head']);
    });

    it('is held on a fresh mark even when no reason was stored with it', async () => {
      const head = await addTask('head', 'todo', 0);
      const at = new Date();
      await em.nativeUpdate(
        Task,
        { id: head.id },
        { prepareFailedAt: at, prepareFailedReason: null },
      );

      const queue = await service.read(projectId);

      expect(queue.blocked).toEqual([
        {
          id: head.id,
          title: 'head',
          reason:
            'its worktree could not be prepared — the autopilot tries again in a few minutes, or press Run once that is fixed',
          kind: 'worktree',
          retryInMs: 5 * 60_000,
        },
      ]);
    });

    it('is reported by its settings problem, not as a timed hold, when it has both', async () => {
      // The run settings are where that one is answered; a worktree kind would
      // hide the button that leads there for the rest of the hold.
      await arm({ agentKind: null, teamSlug: null });
      const head = await addTask('head', 'todo', 0);
      await failedAgo(head, 30_000);

      const queue = await service.read(projectId);

      expect(queue.blocked).toEqual([
        expect.objectContaining({ id: head.id, kind: 'run-target' }),
      ]);
    });

    it('is not flagged on a DISARMED board — only the autopilot is held by it', async () => {
      await arm({ autopilotEnabled: false });
      const head = await addTask('head', 'todo', 0);
      await failedAgo(head, 30_000);

      const queue = await service.read(projectId);

      expect(queue.blocked).toEqual([]);
    });
  });

  it('keeps a stopped task the user’s after they carried its THREAD on themselves', async () => {
    // The same report reached by a second road. Typing into the stopped
    // thread moves its run to `running` and then `completed`, and a run that
    // no longer reads `cancelled` was the end of the only record of the Stop —
    // so the card went back to being waiting work and the autopilot continued
    // it with the whole brief again. The mark is the CARD's now.
    const carriedOn = await addRun('completed');
    const task = await addTask('stopped by me', 'todo', 0, carriedOn.id);
    await taskDao.setStoppedAt(task.id, new Date(), em);
    await addTask('waiting', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((row) => row.title)).toEqual(['waiting']);
    expect(queue.blocked).toEqual([
      expect.objectContaining({
        title: 'stopped by me',
        reason: STOPPED_BY_USER_REASON,
      }),
    ]);
  });

  it.each([
    ['crash', 'the daemon crashed'],
    ['unknown', 'the daemon stopped unexpectedly'],
  ] as const)(
    'holds a card a %s cut off, and says why on the board',
    async (cause, clause) => {
      const run = await addRun('failed');
      const task = await addTask('cut off', 'todo', 0, run.id);
      await taskDao.setStoppedAt(task.id, new Date(), em, cause);
      await addTask('waiting', 'todo', 1);

      const queue = await service.read(projectId);

      expect(queue.eligible.map((row) => row.title)).toEqual(['waiting']);
      expect(queue.blocked).toEqual([
        expect.objectContaining({
          title: 'cut off',
          reason: `${clause} while its agent was working — check the worktree, then press Run to continue`,
        }),
      ]);
    },
  );

  it('never hands out an intake card whose run is still LIVE', async () => {
    // Being worked — in its thread, or after a hand drag out of `in_progress`
    // — is not waiting. The start route refuses it (`TASK_ALREADY_RUNNING`),
    // so handing it out cost a worktree cut and given back on every tick.
    const live = await addRun('running');
    await addTask('being worked', 'todo', 0, live.id);
    await addTask('waiting', 'todo', 1);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((row) => row.title)).toEqual(['waiting']);
    // Drawn as working rather than as refused — nothing about it is broken.
    expect(queue.blocked).toEqual([]);
    expect(queue.active.map((row) => row.runId)).toEqual([live.id]);
  });

  it('hands out the folder each CARD names, else the project one', async () => {
    const own = mkdtempSync(join(tmpdir(), 'geniro-card-'));
    try {
      const inherits = await addTask('inherits', 'todo', 0);
      const names = await addTask('names its own', 'todo', 1);
      names.folder = own;
      await em.flush();

      const queue = await service.read(projectId);

      expect(
        Object.fromEntries(
          queue.eligible.map((task) => [task.id, task.folder]),
        ),
      ).toEqual({ [inherits.id]: folder, [names.id]: own });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  // The conductor cuts a worktree BEFORE it asks the daemon to start the run,
  // so a card the start route would refuse costs a `git worktree add` and a
  // prune every tick, forever — the breaker cannot end it, because a run that
  // never started never failed. Keeping such a card out of `eligible` is what
  // stops that, and naming it is what lets the board explain itself.
  it('blocks a card no rung names an agent or a team for', async () => {
    await arm({ agentKind: null, teamSlug: null });
    const orphan = await addTask('nothing to run me', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      {
        id: orphan.id,
        title: 'nothing to run me',
        reason: expect.any(String),
        kind: 'run-target',
        retryInMs: null,
      },
    ]);
    // Still WAITING: it is in the intake column, which is what that count
    // means. `blocked` is what tells the two apart.
    expect(queue.waiting).toBe(1);
  });

  it('starts a card the CARD itself names an agent for, project silent', async () => {
    await arm({ agentKind: null, teamSlug: null });
    const own = await addTask('names its own agent', 'todo', 0);
    own.agentKind = 'cursor-agent';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.id)).toEqual([own.id]);
    expect(queue.blocked).toEqual([]);
  });

  it('HANDS OUT a card whose team runs every member on auto', async () => {
    // REPORTED as "the automatic taking of tasks doesn't work": every team
    // was refused, including this shape — nothing in it can park on a request.
    await arm({ agentKind: null, teamSlug: 'dev-team' });
    const card = await addTask('run me as a team', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.id)).toEqual([card.id]);
    expect(queue.blocked).toEqual([]);
  });

  it('BLOCKS a card whose TEAM has a member that can ask', async () => {
    // A team carries `approval` per member, so there is no single field the
    // resolver can force the way it forces an agent run's — a member that asks
    // parks an unattended run forever, holding its slot and its worktree while
    // the failure breaker sees nothing wrong, because parked is not failed.
    // The card is answerable: set the member to auto, point it at an agent, or
    // press Run yourself. It EXISTS in the library — this is the unattended
    // refusal, not the missing-team one below.
    await teams.create(
      teamOf([member('coder', { approval: 'ask' })], {
        name: 'Careful Team',
      }),
      'careful-team',
    );
    await arm({ agentKind: null, teamSlug: 'careful-team' });
    const card = await addTask('run me as a team', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a team',
        reason: RUN_TARGET_PROBLEM_REASON['team-unattended'],
        kind: 'run-target',
        retryInMs: null,
      },
    ]);
  });

  it('HANDS OUT a card when its project’s overlay of its default team puts the asking member on auto', async () => {
    await teams.create(
      teamOf([member('coder', { approval: 'ask' })], {
        name: 'Careful Team',
      }),
      'careful-team',
    );
    await arm({ agentKind: null, teamSlug: 'careful-team' });
    await new TeamOverlayStoreService({ teamsDir }).save(
      'careful-team',
      projectId,
      { members: { coder: { settings: { approval: 'auto' } } } },
    );
    const card = await addTask('run me as a team', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.id)).toEqual([card.id]);
    expect(queue.blocked).toEqual([]);
  });

  it('holds a card whose project overlay cannot be applied, without failing the rest of the board', async () => {
    await arm({ agentKind: null, teamSlug: 'dev-team' });
    const overlays = new TeamOverlayStoreService({ teamsDir });
    await overlays.save('dev-team', projectId, {});
    writeFileSync(overlays.pathOf('dev-team', projectId), 'members: [');
    const card = await addTask('run me as a team', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toMatchObject([
      {
        id: card.id,
        reason: expect.stringContaining(
          'overrides of its team cannot be applied',
        ),
        kind: 'overlay',
      },
    ]);
  });

  it('names the two refusals differently', async () => {
    // The queue is where a user reads WHY a card is not being picked up, so a
    // card naming a team must not be told to name an agent or a team —
    // advice it has already followed.
    await arm({ agentKind: null, teamSlug: null });
    const bare = await addTask('names nothing', 'todo', 0);
    // A team with a member that can ASK — one on auto is now handed out.
    await teams.create(
      teamOf([member('coder', { approval: 'ask' })], {
        name: 'Careful Team',
      }),
      'careful-team',
    );
    const viaTeam = await addTask('names a team', 'todo', 1);
    viaTeam.teamSlug = 'careful-team';
    await em.flush();

    const queue = await service.read(projectId);

    const reasons = new Map(
      queue.blocked.map((task) => [task.id, task.reason]),
    );
    expect(reasons.get(bare.id)).toBe(RUN_TARGET_PROBLEM_REASON['no-target']);
    expect(reasons.get(viaTeam.id)).toBe(
      RUN_TARGET_PROBLEM_REASON['team-unattended'],
    );
  });

  // A card naming a team the LIBRARY no longer holds — a team deleted
  // out from under a task (a rename keeps the file, so deletion is the
  // reachable cause; see `TeamStoreService.save`/`delete`). Without this
  // check the card would resolve as any other team target, land in
  // `blocked` under the generic 'team-unattended' reason, and a user
  // reading that would go looking for the wrong fix — pointing it at an
  // agent when the real problem is a dangling slug they could instead swap
  // for a team that still exists.
  it('blocks a card whose team slug is not in the library, with a reason naming it', async () => {
    await arm({ agentKind: null, teamSlug: null });
    const card = await addTask('run me as a ghost team', 'todo', 0);
    card.teamSlug = 'ghost-team';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a ghost team',
        reason: missingTeamReason('ghost-team'),
        kind: 'missing-team',
        retryInMs: null,
      },
    ]);
  });

  // A blocked card must not occupy one of the slots the handout is narrowed
  // to, or one misconfigured card at the head of a cap-1 column would starve
  // every runnable card behind it — the same standstill, reached the other way.
  it('does not let a blocked card consume a free slot', async () => {
    // The project names nothing, so a card is runnable only if it says so
    // itself. `blocked` sits at position 0 — ahead of `runnable` in the very
    // ordering the cap is applied to.
    await arm({
      agentKind: null,
      teamSlug: null,
      autopilotMaxConcurrent: 1,
    });
    await addTask('blocked', 'todo', 0);
    const runnable = await addTask('runnable', 'todo', 1);
    runnable.agentKind = 'claude';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.eligible.map((task) => task.title)).toEqual(['runnable']);
    expect(queue.blocked.map((task) => task.title)).toEqual(['blocked']);
  });

  it('reports blocked cards even while the autopilot is disarmed', async () => {
    // A card naming nothing is broken whether or not the timer is running, and
    // a user who arms the project to find out why nothing happens has been
    // told nothing.
    await arm({ agentKind: null, teamSlug: null, autopilotEnabled: false });
    await addTask('nothing to run me', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.eligible).toEqual([]);
    expect(queue.blocked).toHaveLength(1);
  });

  it('names a MISSING team on a disarmed board too, not just an armed one', async () => {
    // The library check used to sit inside the 'team-unattended' arm, which
    // `resolveRunTarget` only produces under 'autopilot' — so on a disarmed
    // board a card naming a deleted team resolved cleanly to
    // `{kind: 'team'}` and landed in `startable`. Nothing said it was
    // broken, and a hand press cut a worktree before 404ing
    // TEAM_NOT_FOUND: the same dead end the armed board's churn loop is,
    // reached by the one door left open there.
    await arm({
      agentKind: null,
      teamSlug: null,
      autopilotEnabled: false,
    });
    const card = await addTask('run me as a ghost team', 'todo', 0);
    card.teamSlug = 'ghost-team';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.blocked).toEqual([
      {
        id: card.id,
        title: 'run me as a ghost team',
        reason: missingTeamReason('ghost-team'),
        kind: 'missing-team',
        retryInMs: null,
      },
    ]);
  });

  it('prefers the MISSING-team reason over the unattended one', async () => {
    // Both refusals apply to an armed board's team card; the specific one
    // has to win. A user told "cannot run unattended" about a card whose
    // team no longer exists goes looking for the wrong fix — repointing it
    // at an agent, when picking a different, real team is just as
    // available.
    await arm({ agentKind: null, teamSlug: null });
    const card = await addTask('run me as a ghost team', 'todo', 0);
    card.teamSlug = 'ghost-team';
    await em.flush();

    const queue = await service.read(projectId);

    expect(queue.blocked[0]?.reason).toBe(missingTeamReason('ghost-team'));
  });

  it('narrows the handout to the free slots', async () => {
    const run = await addRun('running');
    await addTask('working', 'in_progress', 0, run.id);
    await addTask('a', 'todo', 1);
    await addTask('b', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(1);
    // Two waiting, a cap of two, one slot taken — so one goes out, not two.
    expect(queue.waiting).toBe(2);
    expect(queue.eligible.map((task) => task.title)).toEqual(['a']);
  });

  it('hands out nothing while the project is disarmed, and still reports the column', async () => {
    await arm({ autopilotEnabled: false });
    await addTask('a', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.enabled).toBe(false);
    expect(queue.eligible).toEqual([]);
    expect(queue.waiting).toBe(1);
  });

  it('hands out nothing when every slot is taken', async () => {
    const first = await addRun('running');
    const second = await addRun('pending');
    await addTask('one', 'in_progress', 0, first.id);
    await addTask('two', 'in_progress', 1, second.id);
    await addTask('queued', 'todo', 2);

    const queue = await service.read(projectId);

    expect(queue.running).toBe(2);
    expect(queue.eligible).toEqual([]);
  });

  it('reads the intake column the project names, not a hardcoded one', async () => {
    await arm({ autopilotIntakeStatus: 'backlog' });
    await addTask('in backlog', 'backlog', 0);
    await addTask('in todo', 'todo', 0);

    const queue = await service.read(projectId);

    expect(queue.intakeStatus).toBe('backlog');
    expect(queue.eligible.map((task) => task.title)).toEqual(['in backlog']);
  });
});
