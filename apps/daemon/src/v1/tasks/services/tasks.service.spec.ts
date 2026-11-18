import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { RunDao } from '../../agents/dao/run.dao';
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { Run } from '../../runs/entity/run.entity';
import { fakeLiveWork } from '../__tests__/fake-live-work';
import { TaskDao } from '../dao/task.dao';
import { Task } from '../entity/task.entity';
import type { TaskChangedEvent } from '../tasks.types';
import { TaskAttachmentService } from './task-attachment.service';
import { TaskEventBus } from './task-events.bus';
import { TasksService } from './tasks.service';

/**
 * Real database, real DAOs. The behaviour under test is a compare-and-set
 * against the stored status, so the stored status has to be real: a faked DAO
 * would return whatever the test told it to and the conflict branch would
 * never be entered.
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

describe('TasksService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TasksService;
  let taskDao: TaskDao;
  let projectDao: ProjectDao;
  let projectId: string;
  // The fork the DAOs and the service share. A test that writes a row directly
  // must flush on THIS one: `orm.em` is a different UnitOfWork and does not
  // manage entities loaded here, so a write flushed there never lands.
  let em: EntityManager;
  /**
   * A real directory, in its CANONICAL form — the shape the service stores.
   *
   * `update` puts `worktreePath` through `resolveValidDirectory`, which both
   * refuses a path that is not on disk AND resolves its symlinks. On macOS
   * `os.tmpdir()` is `/var/folders/…`, itself a symlink to `/private/var/…`,
   * so a raw `mkdtempSync` result and what the service stores differ by that
   * prefix and the round-trip below fails on every Mac while passing on Linux,
   * where `/var` is a real directory. Canonicalizing the fixture at creation
   * is what `resolve-cwd.spec.ts` and `cli-auth.service.spec.ts` already do.
   */
  let worktree: string;
  let events: TaskEventBus;
  let changes: TaskChangedEvent[];
  let live: ReturnType<typeof fakeLiveWork>;

  beforeAll(async () => {
    worktree = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-worktree-')));
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
    rmSync(worktree, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    events = new TaskEventBus();
    changes = [];
    events.allChanges().subscribe((e) => changes.push(e));
    live = fakeLiveWork();
    service = new TasksService(
      em,
      taskDao,
      projectDao,
      events,
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      new RunDao(em),
      live.liveWork,
    );
    service.onModuleInit();
    const project = await projectDao.create({
      name: 'Board',
      folder: '/tmp/geniro-tasks-spec',
    });
    projectId = project.id;
  });

  it('moves a task to the next column when the caller’s `from` still matches', async () => {
    const task = await service.create({ projectId, title: 'ship it' });

    const moved = await service.moveStatus(task.id, {
      from: 'backlog',
      to: 'todo',
    });

    expect(moved.status).toBe('todo');
    expect((await taskDao.getById(task.id))?.status).toBe('todo');
  });

  it('refuses a move whose `from` is stale — the second of two boards loses', async () => {
    const task = await service.create({ projectId, title: 'run me' });
    // The first board wins the race and the card is now in `in_progress`.
    await service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });

    // The second board is still drawing the card in `backlog` and drags it.
    await expect(
      service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('it moved since you last read it'),
    });

    // And the losing move changed nothing — the point of refusing it.
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
  });

  // The test above refuses a move whose `from` was already stale when it was
  // SENT, which a JavaScript comparison catches on its own. This one is the
  // case that comparison cannot catch: both moves are in flight at once, so
  // both read the card in `todo` before either writes. Only a conditional
  // UPDATE separates them — and the autopilot's sweep is exactly this caller,
  // fanning several starts out inside one tick.
  it('lets exactly one of two simultaneous identical moves win', async () => {
    const task = await service.create({ projectId, title: 'contended' });
    await service.moveStatus(task.id, { from: 'backlog', to: 'todo' });
    changes.length = 0;

    const settled = await Promise.allSettled([
      service.moveStatus(task.id, { from: 'todo', to: 'in_progress' }),
      service.moveStatus(task.id, { from: 'todo', to: 'in_progress' }),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = settled.find((r) => r.status === 'rejected');
    // Either refusal is correct and which one fires depends on how the two
    // interleave: the loser may still be reading when the winner's UPDATE
    // lands (the stale-`from` branch) or may reach its own UPDATE and match no
    // row. Both say the card moved; asserting one of them would pin the
    // interleaving rather than the behaviour.
    expect((loser?.reason as Error | undefined)?.message).toMatch(/moved/);
    expect((await taskDao.getById(task.id))?.status).toBe('in_progress');
    // One winner means one redraw. A board told twice that the same card
    // arrived would be the same double-start seen from the client side.
    expect(changes).toHaveLength(1);
  });

  it('drops the card’s pasted images when the card is deleted', async () => {
    // Nothing else can reach them once the row is gone — there is no surface
    // in the app that lists a deleted card's files — so a screenshot of a
    // console or a private repository would sit on disk for good.
    const task = await service.create({ projectId, title: 'has a paste' });
    const dir = join(ATTACHMENTS_ROOT, task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'shot.png'), 'bytes');

    await service.remove(task.id);

    expect(existsSync(dir)).toBe(false);
  });

  // Left naming the deleted card, a chat went on wearing its `GEN-12` label
  // and sent its next message through the task-worktree recovery, which asked
  // for a card that 404s. Every thread that worked the card is let go of — an
  // earlier one included — and nothing else is touched.
  it('lets go of every chat that worked a deleted card, and only those', async () => {
    const task = await service.create({ projectId, title: 'gone soon' });
    const runs = new RunDao(em);
    const thread = (id: string, taskId: string, taskIdentifier: string) =>
      runs.create({
        id,
        teamId: null,
        status: 'completed',
        agentKind: 'claude',
        taskId,
        taskIdentifier,
      });
    await thread('run-now', task.id, 'B-1');
    await thread('run-earlier', task.id, 'B-1');
    await thread('run-other', 'another-card', 'B-2');

    await service.remove(task.id);

    const fresh = orm.em.fork() as EntityManager;
    const edge = async (id: string) => {
      const run = await new RunDao(fresh).getById(id, fresh);
      return { taskId: run?.taskId, taskIdentifier: run?.taskIdentifier };
    };
    expect(await edge('run-now')).toEqual({
      taskId: null,
      taskIdentifier: null,
    });
    expect(await edge('run-earlier')).toEqual({
      taskId: null,
      taskIdentifier: null,
    });
    expect(await edge('run-other')).toEqual({
      taskId: 'another-card',
      taskIdentifier: 'B-2',
    });
  });

  it('emits on the task bus after a create, with the fixed board payload', async () => {
    const task = await service.create({ projectId, title: 'ship it' });

    expect(changes).toEqual([
      { taskId: task.id, projectId, status: 'backlog' },
    ]);
  });

  it('emits on the task bus after a status move, naming the NEW status', async () => {
    const task = await service.create({ projectId, title: 'ship it' });
    changes.length = 0; // the create above emits too; isolate the move

    await service.moveStatus(task.id, { from: 'backlog', to: 'todo' });

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
  });

  it('does not emit on a no-op move — nothing changed for a board to redraw', async () => {
    const task = await service.create({ projectId, title: 'idempotent' });
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'backlog', to: 'backlog' });

    expect(changes).toEqual([]);
  });

  it('does not emit on a refused (stale) move', async () => {
    const task = await service.create({ projectId, title: 'run me' });
    await service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' });
    changes.length = 0;

    await expect(
      service.moveStatus(task.id, { from: 'backlog', to: 'in_progress' }),
    ).rejects.toThrow();

    expect(changes).toEqual([]);
  });

  it('keeps a card’s model parameters and clears them with its model or agent', async () => {
    const fast = { service_tier: 'priority' };
    const task = await service.create({
      projectId,
      title: 'fast',
      modelParameters: fast,
    });
    expect(task.modelParameters).toEqual(fast);

    await expect(
      service.update(task.id, { model: 'gpt-6.1-sol', modelParameters: fast }),
    ).resolves.toMatchObject({ modelParameters: fast });
    await expect(
      service.update(task.id, { model: 'gpt-6.1-sol' }),
    ).resolves.toMatchObject({ modelParameters: fast });
    await expect(
      service.update(task.id, { model: 'gpt-6-sol' }),
    ).resolves.toMatchObject({ modelParameters: {} });

    await service.update(task.id, { modelParameters: fast });
    await expect(
      service.update(task.id, { agentKind: 'codex' }),
    ).resolves.toMatchObject({ modelParameters: {} });

    await service.update(task.id, { modelParameters: fast });
    await expect(
      service.update(task.id, { title: 'renamed' }),
    ).resolves.toMatchObject({ modelParameters: fast });
    await expect(
      service.update(task.id, { modelParameters: null }),
    ).resolves.toMatchObject({ modelParameters: {} });
  });

  it('emits on the task bus after a field update, naming its unchanged status', async () => {
    const task = await service.create({ projectId, title: 'ship it' });
    changes.length = 0;

    await service.update(task.id, { title: 'renamed' });

    expect(changes).toEqual([
      { taskId: task.id, projectId, status: 'backlog' },
    ]);
  });

  it('emits on the task bus after a delete, naming the status it held', async () => {
    const task = await service.create({
      projectId,
      title: 'to delete',
      status: 'todo',
    });
    changes.length = 0;

    await service.remove(task.id);

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
  });

  /** A card in `status` whose run is in `runStatus`. */
  const cardWithRun = async (
    status: 'in_progress' | 'in_review' | 'done',
    runStatus: 'running' | 'completed',
    runId = 'run-1',
  ) => {
    const task = await service.create({ projectId, title: 'card', status });
    await new RunDao(em).create({
      id: runId,
      teamId: null,
      status: runStatus,
      agentKind: 'claude',
      taskId: task.id,
    });
    await service.update(task.id, { runId });
    return task;
  };

  it("carries the stage line of the card's run, and none for a run without stages", async () => {
    const staged = await cardWithRun('in_progress', 'running', 'run-staged');
    const plain = await cardWithRun('in_progress', 'running', 'run-plain');
    await new RunDao(em).updateById('run-staged', {
      stageProgress: JSON.stringify({
        rev: 1,
        current: 'build',
        position: { index: 2, total: 3 },
        stages: [
          { id: 'plan', title: 'Plan', status: 'done', next: ['build'] },
          { id: 'build', title: 'Build', status: 'current', next: ['ship'] },
          { id: 'ship', title: 'Ship', status: 'pending', next: [] },
        ],
      }),
    });

    expect((await service.get(staged.id)).stage).toEqual({
      title: 'Build',
      index: 2,
      total: 3,
    });
    expect((await service.get(plain.id)).stage).toBeNull();
    const board = await service.listForProject(projectId);
    expect(board.find((card) => card.id === staged.id)?.stage).toEqual({
      title: 'Build',
      index: 2,
      total: 3,
    });
    expect(board.find((card) => card.id === plain.id)?.stage).toBeNull();
  });

  it('marks the work FINISHED on a move to Done whose run has stopped', async () => {
    const task = await cardWithRun('in_review', 'completed');
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'in_review', to: 'done' });

    // The one moment the board may collect the card's worktree: Done, with
    // nothing working in it.
    expect(changes).toEqual([
      { taskId: task.id, projectId, status: 'done', reason: 'work-finished' },
    ]);
  });

  it('does NOT mark the work finished on a move to Done while the run still works', async () => {
    const task = await cardWithRun('in_progress', 'running');
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'in_progress', to: 'done' });

    // The column is written the moment a card is dragged; collecting here
    // would remove the checkout of an agent still working in it.
    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'done' }]);
  });

  it('keeps a Done card unfinished while its settled run holds live work, and finishes it once that ends', async () => {
    const task = await cardWithRun('in_review', 'completed', 'run-m');
    live.hold('run-m', 'monitor');
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'in_review', to: 'done' });
    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'done' }]);

    live.release('run-m');
    await vi.waitFor(() =>
      expect(changes).toEqual([
        { taskId: task.id, projectId, status: 'done' },
        { taskId: task.id, projectId, status: 'done', reason: 'work-finished' },
      ]),
    );
  });

  it('withholds the settle of a Done card while live work holds its run', async () => {
    const task = await cardWithRun('done', 'completed', 'run-s');
    live.hold('run-s', 'command action');
    changes.length = 0;

    await service.finishWhenFree({ ...task, runId: 'run-s' });
    await service.recheckFinish('run-s');
    expect(changes).toEqual([]);
  });

  it('marks nothing finished on a move anywhere but Done, however its run ended', async () => {
    const task = await cardWithRun('in_review', 'completed');
    changes.length = 0;

    await service.moveStatus(task.id, { from: 'in_review', to: 'todo' });

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
  });

  it('answers which cards are finished — a card no longer there counting as one', async () => {
    const doneIdle = await service.create({
      projectId,
      title: 'done, nothing ran',
      status: 'done',
    });
    const reviewed = await cardWithRun('in_review', 'completed', 'run-1');
    const doneWorking = await cardWithRun('done', 'running', 'run-2');
    const doneWatching = await cardWithRun('done', 'completed', 'run-3');
    live.hold('run-3', 'monitor');
    const deleted = await service.create({ projectId, title: 'gone' });
    await service.remove(deleted.id);

    await expect(
      service.finishedAmong([
        doneIdle.id,
        reviewed.id,
        doneWorking.id,
        doneWatching.id,
        deleted.id,
        'never-a-card',
      ]),
    ).resolves.toEqual({
      // In review is not finished, whatever its run did; Done with a run still
      // working, or a settled run still holding a monitor, is not finished
      // yet. Nothing will ever run in the worktree of a card that is gone.
      taskIds: [doneIdle.id, deleted.id, 'never-a-card'],
    });
  });

  it('accepts a move to the status the task is already in, as a no-op', async () => {
    const task = await service.create({ projectId, title: 'idempotent' });

    const moved = await service.moveStatus(task.id, {
      from: 'backlog',
      to: 'backlog',
    });

    // A retried request must not read as a lost race.
    expect(moved.status).toBe('backlog');
    // And the early return is what this observes: without it the move falls
    // through to the position allocation and the card is appended past itself,
    // so the status alone would pass on both sides of the branch.
    expect(moved.position).toBe(0);
    expect((await taskDao.getById(task.id))?.position).toBe(0);
  });

  it('gives two SIMULTANEOUS creates different numbers and positions', async () => {
    // The counter is bumped and read back across an await (`nextPositionIn`),
    // on a per-request fork, so without a transaction around the pair both
    // creates read the same counter and write the same absolute value — two
    // cards holding one user-visible `GEN-12`, drawn on the board and, through
    // `Run.taskIdentifier`, in the chat sidebar. Taking the number from the
    // counter rather than from `max(number)` exists to prevent exactly that.
    const [first, second] = await Promise.all([
      service.create({ projectId, title: 'first' }),
      service.create({ projectId, title: 'second' }),
    ]);

    expect(first.number).not.toBe(second.number);
    expect(new Set([first.number, second.number]).size).toBe(2);
    expect(first.position).not.toBe(second.position);
  });

  it('appends each new task to the end of its column', async () => {
    const first = await service.create({ projectId, title: 'first' });
    const second = await service.create({ projectId, title: 'second' });

    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
  });

  it('places a moved task at the end of the column it lands in', async () => {
    await service.create({
      projectId,
      title: 'already in todo',
      status: 'todo',
    });
    const mover = await service.create({ projectId, title: 'arriving' });

    const moved = await service.moveStatus(mover.id, {
      from: 'backlog',
      to: 'todo',
    });

    expect(moved.position).toBe(1);
  });

  it('reorders a column to exactly the order the drag left it in', async () => {
    const a = await service.create({ projectId, title: 'a' });
    const b = await service.create({ projectId, title: 'b' });
    const c = await service.create({ projectId, title: 'c' });
    changes = [];

    const reordered = await service.reorder('backlog', [c.id, a.id, b.id]);

    expect(reordered.map((task) => task.title)).toEqual(['c', 'a', 'b']);
    const board = await service.listForProject(projectId);
    expect(board.map((task) => task.title)).toEqual(['c', 'a', 'b']);
    expect(changes).toEqual([{ taskId: c.id, projectId, status: 'backlog' }]);
  });

  it('skips a card that left the column while it was being dragged', async () => {
    const a = await service.create({ projectId, title: 'a' });
    const b = await service.create({ projectId, title: 'b' });
    await service.moveStatus(a.id, { from: 'backlog', to: 'todo' });

    const reordered = await service.reorder('backlog', [a.id, b.id]);

    expect(reordered.map((task) => task.id)).toEqual([b.id]);
    expect((await service.get(a.id)).status).toBe('todo');
    expect((await service.get(b.id)).position).toBe(0);
  });

  it('lists every project’s cards together, leaving another project’s order alone on a reorder', async () => {
    const other = await projectDao.create({
      name: 'Other',
      folder: '/tmp/geniro-tasks-spec-other',
    });
    const mine1 = await service.create({ projectId, title: 'mine 1' });
    const mine2 = await service.create({ projectId, title: 'mine 2' });
    const theirs = await service.create({
      projectId: other.id,
      title: 'theirs',
    });

    await service.reorder('backlog', [mine2.id, mine1.id]);

    expect((await service.get(theirs.id)).position).toBe(0);
    const all = await service.listAll();
    expect(all.map((task) => task.title).sort()).toEqual([
      'mine 1',
      'mine 2',
      'theirs',
    ]);
    expect(
      all
        .filter((task) => task.projectId === projectId)
        .map((task) => task.title),
    ).toEqual(['mine 2', 'mine 1']);
  });

  it('announces a cross-project reorder once to each project it touched', async () => {
    const other = await projectDao.create({
      name: 'Other',
      folder: '/tmp/geniro-tasks-spec-events',
    });
    const mine = await service.create({ projectId, title: 'mine' });
    const theirs = await service.create({
      projectId: other.id,
      title: 'theirs',
    });
    const mine2 = await service.create({ projectId, title: 'mine 2' });
    changes = [];

    await service.reorder('backlog', [theirs.id, mine2.id, mine.id]);

    expect(changes.map((change) => change.projectId).sort()).toEqual(
      [projectId, other.id].sort(),
    );
  });

  it('ignores duplicate and unknown ids in a reorder', async () => {
    const a = await service.create({ projectId, title: 'a' });
    const b = await service.create({ projectId, title: 'b' });

    const reordered = await service.reorder('backlog', [
      b.id,
      'no-such-card',
      b.id,
      a.id,
    ]);

    expect(reordered.map((task) => task.id)).toEqual([b.id, a.id]);
    expect((await service.get(a.id)).position).toBe(1);
  });

  it('writes a reordered position only while the card is still in that column', async () => {
    const card = await service.create({ projectId, title: 'moving' });
    await service.create({
      projectId,
      title: 'already in todo',
      status: 'todo',
    });
    await service.moveStatus(card.id, { from: 'backlog', to: 'todo' });
    const landed = (await service.get(card.id)).position;

    const written = await taskDao.setPositionIfInStatus(
      card.id,
      'backlog',
      0,
      new Date(),
    );

    expect(written).toBe(false);
    expect((await service.get(card.id)).position).toBe(landed);
    expect(landed).toBe(1);
  });

  it('gives every live card in a column a distinct position, after a delete', async () => {
    // A soft-deleted card keeps its position while leaving the live count, so
    // an allocation that counted would hand this slot out twice.
    const first = await service.create({ projectId, title: 'first' });
    const second = await service.create({ projectId, title: 'second' });
    expect([first.position, second.position]).toEqual([0, 1]);

    await service.remove(first.id);
    const third = await service.create({ projectId, title: 'third' });

    const live = await taskDao.listInStatus(projectId, 'backlog');
    const positions = live.map((task) => task.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(third.position).toBe(2);
  });

  it('gives every live card in a column a distinct position, after a move-out', async () => {
    // The other route into the same collision: a move sets only the mover's
    // own position, so its old column keeps a hole the count cannot see.
    const leaving = await service.create({ projectId, title: 'leaving' });
    const staying = await service.create({ projectId, title: 'staying' });
    await service.moveStatus(leaving.id, { from: 'backlog', to: 'todo' });

    const arriving = await service.create({ projectId, title: 'arriving' });

    const backlog = await taskDao.listInStatus(projectId, 'backlog');
    const positions = backlog.map((task) => task.position);
    expect(new Set(positions).size).toBe(positions.length);
    expect(arriving.position).not.toBe(staying.position);
  });

  it('puts no cap on how many tasks a project holds', async () => {
    // It refused the 1001st card once, and a long-lived board fills with Done.
    const filler = Array.from({ length: 1000 }, (_, i) => ({
      projectId,
      title: `filler ${i}`,
    }));
    await taskDao.createMany(filler, em);

    await expect(
      service.create({ projectId, title: 'the thousand-and-first' }),
    ).resolves.toMatchObject({ title: 'the thousand-and-first' });
  });

  it('refuses a worktree path that is not a directory on disk', async () => {
    // It becomes an agent's spawn cwd, so it is canonicalized at write time
    // like every other caller-supplied path the daemon stores.
    const task = await service.create({ projectId, title: 'needs a tree' });

    await expect(
      service.update(task.id, { worktreePath: '/no/such/worktree/anywhere' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('clears the worktree path on an explicit null', async () => {
    // The other arm of the check above: `null` releases the worktree and must
    // not be handed to `resolveValidDirectory`, which would refuse it as a
    // path that does not exist and leave a released worktree unclearable.
    const task = await service.create({ projectId, title: 'has a tree' });
    const attached = await service.update(task.id, {
      worktreePath: worktree,
    });
    expect(attached.worktreePath).toBe(worktree);

    const released = await service.update(task.id, { worktreePath: null });

    expect(released.worktreePath).toBeNull();
  });

  // A card's folder is the project's DEFAULT overridden, so null is the
  // ordinary state and means INHERIT — never "nowhere". A snapshot of the
  // project's folder taken at create would look identical here and turn the
  // project's setting into a one-time seed the moment it was changed.
  it('leaves a new task inheriting its project folder', async () => {
    const task = await service.create({ projectId, title: 'ordinary' });

    expect(task.folder).toBeNull();
  });

  it('takes a folder of its own, canonicalized like every stored path', async () => {
    const task = await service.create({
      projectId,
      title: 'elsewhere',
      folder: worktree,
    });

    expect(task.folder).toBe(worktree);
  });

  it('refuses a task folder that is not a directory on disk', async () => {
    // The same rule the worktree path follows, and for a sharper reason: this
    // one is what a worktree is CUT FROM, so an unchecked value fails minutes
    // later in another process, as a git error about a path nobody typed here.
    await expect(
      service.create({
        projectId,
        title: 'nowhere',
        folder: '/no/such/folder/anywhere',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('hands a card back to the project folder on an explicit null', async () => {
    // Inheriting AGAIN is a thing a user does to a card that already names a
    // folder, and there is no other way to say it — hence nullable on the
    // patch where create's field is merely optional.
    const task = await service.create({
      projectId,
      title: 'elsewhere',
      folder: worktree,
    });

    const back = await service.update(task.id, { folder: null });

    expect(back.folder).toBeNull();
  });

  it('refuses a task naming a project that does not exist', async () => {
    await expect(
      service.create({ projectId: 'no-such-project', title: 'orphan' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no-such-project'),
    });
    expect(await taskDao.countInProject('no-such-project')).toBe(0);
  });

  it('records a prepare failure on the card, stamped with the daemon’s clock', async () => {
    const task = await service.create({
      projectId,
      title: 'no worktree',
      status: 'todo',
    });
    const before = Date.now();

    await service.recordPrepareFailure(task.id, "fatal: 'b' is already used");
    const after = Date.now();

    const row = await taskDao.getById(task.id, orm.em.fork() as EntityManager);
    expect(row?.prepareFailedReason).toBe("fatal: 'b' is already used");
    expect(row?.prepareFailedAt?.getTime()).toBeGreaterThanOrEqual(before);
    expect(row?.prepareFailedAt?.getTime()).toBeLessThanOrEqual(after);
  });

  it('announces a recorded prepare failure, so an open board re-reads its queue', async () => {
    const task = await service.create({
      projectId,
      title: 'no worktree',
      status: 'todo',
    });
    changes.length = 0;

    await service.recordPrepareFailure(task.id, 'fatal: x');

    expect(changes).toEqual([{ taskId: task.id, projectId, status: 'todo' }]);
  });

  it('ignores a late report for a card another start already took out of the intake column', async () => {
    // A Run press preparing the same worktree wins, moves the card to
    // in_progress and clears the mark; the losing tick's report lands after.
    const task = await service.create({
      projectId,
      title: 'being worked',
      status: 'in_progress',
    });
    changes.length = 0;

    await service.recordPrepareFailure(task.id, 'fatal: x');

    const row = await taskDao.getById(task.id, orm.em.fork() as EntityManager);
    expect(row?.prepareFailedAt).toBeNull();
    expect(changes).toEqual([]);
  });

  it('refuses a prepare failure for a card that does not exist', async () => {
    await expect(
      service.recordPrepareFailure('no-such-task', 'fatal: x'),
    ).rejects.toMatchObject({ errorCode: 'TASK_NOT_FOUND' });
  });

  it('re-stamps the mark on a repeat failure, so a retry that failed again is held again', async () => {
    const task = await service.create({
      projectId,
      title: 'still broken',
      status: 'todo',
    });
    await taskDao.setPrepareFailure(
      task.id,
      { at: new Date(Date.now() - 6 * 60_000), reason: 'fatal: first' },
      em,
    );
    const before = Date.now();

    await service.recordPrepareFailure(task.id, 'fatal: again');

    const row = await taskDao.getById(task.id, orm.em.fork() as EntityManager);
    expect(row?.prepareFailedReason).toBe('fatal: again');
    expect(row?.prepareFailedAt?.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('records a report on a board whose intake column is not the default', async () => {
    await projectDao.updateById(
      projectId,
      { autopilotIntakeStatus: 'backlog' },
      em,
    );
    const task = await service.create({ projectId, title: 'from backlog' });

    await service.recordPrepareFailure(task.id, 'fatal: x');

    const row = await taskDao.getById(task.id, orm.em.fork() as EntityManager);
    expect(row?.prepareFailedReason).toBe('fatal: x');
  });

  it('round-trips labels through the JSON text column', async () => {
    const task = await service.create({
      projectId,
      title: 'labelled',
      labels: ['bug', 'ui'],
    });

    expect(task.labels).toEqual(['bug', 'ui']);
    expect((await service.get(task.id)).labels).toEqual(['bug', 'ui']);
  });

  it('reads a task whose stored labels are unreadable as having none', async () => {
    // The fixture must carry labels: with none, the healthy and the corrupt
    // readings are both `[]` and nothing here observes the guard.
    const task = await service.create({
      projectId,
      title: 'corrupt',
      labels: ['bug'],
    });
    expect(task.labels).toEqual(['bug']);

    const row = await taskDao.getById(task.id);
    if (!row) {
      throw new Error('the task under test disappeared');
    }
    row.labels = 'not json at all';
    // On the fork that OWNS this row. `orm.em` is a separate UnitOfWork which
    // never loaded it, so flushing there writes nothing and the assertion
    // below would be reading the healthy row back.
    await em.flush();

    expect((await service.get(task.id)).labels).toEqual([]);
  });

  it('drops stored labels that are not strings', async () => {
    const task = await service.create({
      projectId,
      title: 'wrong shape',
      labels: ['bug'],
    });
    const row = await taskDao.getById(task.id);
    if (!row) {
      throw new Error('the task under test disappeared');
    }
    // An array holding a non-string is the one malformed shape whose handling
    // is observable: without the type filter these numbers reach
    // `TaskWire.labels`, which is typed `string[]`.
    //
    // The `!Array.isArray` arm beside it cannot be pinned at all, and that is
    // a property of the code rather than a gap here: every non-array throws
    // inside `filter` and lands in the same `catch`, so removing the check
    // returns `[]` exactly as keeping it does. It stays because reaching a
    // result through an exception is not the same as deciding it.
    row.labels = '[1,"ok",2]';
    await em.flush();

    expect((await service.get(task.id)).labels).toEqual(['ok']);
  });
  it('leaves a new task untriaged rather than guessing a priority', async () => {
    // `none` has to be distinguishable from a deliberate `low`, so the default
    // is its own value and not the bottom of the scale.
    const task = await service.create({ projectId, title: 'fresh' });

    expect(task.priority).toBe('none');
    expect(task.dueDate).toBeNull();
  });

  it('round-trips a priority and a due date through create', async () => {
    const task = await service.create({
      projectId,
      title: 'ship the board',
      priority: 'urgent',
      dueDate: '2026-09-30',
    });

    expect(task.priority).toBe('urgent');
    expect(task.dueDate).toBe('2026-09-30');
  });

  it('stores the due date as the calendar day it was given, with no zone shift', async () => {
    // The whole reason it is a string column. Round-tripping through a `Date`
    // would pin the day to whichever zone wrote it and move it for everyone
    // else — a task due the 30th must not read as the 29th somewhere.
    const task = await service.create({
      projectId,
      title: 'day, not instant',
      dueDate: '2026-01-01',
    });

    expect(task.dueDate).toBe('2026-01-01');
    expect(String(task.dueDate)).not.toContain('T');
  });

  it('clears a due date on an explicit null', async () => {
    // The other arm of `!== undefined`: dropping a date has to be possible,
    // and is different from leaving the field out of the patch.
    const task = await service.create({
      projectId,
      title: 'was due',
      dueDate: '2026-09-30',
    });

    const cleared = await service.update(task.id, { dueDate: null });

    expect(cleared.dueDate).toBeNull();
  });

  it('leaves the due date alone when the patch does not mention it', async () => {
    const task = await service.create({
      projectId,
      title: 'still due',
      dueDate: '2026-09-30',
    });

    const renamed = await service.update(task.id, { title: 'renamed' });

    expect(renamed.dueDate).toBe('2026-09-30');
  });
});

/**
 * A card's NUMBER — the `12` of `GEN-12`.
 *
 * ASKED FOR as Linear's scheme, and the property that makes an identifier worth
 * having is that it names one card for good.
 */
describe('TasksService — card numbering (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: TasksService;
  let projectDao: ProjectDao;
  let projectId: string;
  let em: EntityManager;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        // `Run` because a card's delete lets go of the chats that worked it.
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
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork();
    const taskDao = new TaskDao(em);
    projectDao = new ProjectDao(em);
    service = new TasksService(
      em,
      taskDao,
      projectDao,
      new TaskEventBus(),
      new TaskAttachmentService(ATTACHMENTS_ROOT),
      new RunDao(em),
      fakeLiveWork().liveWork,
    );
    const project = await projectDao.create({
      name: 'Geniro',
      taskKey: 'GEN',
      folder: realpathSync(tmpdir()),
    });
    await em.flush();
    projectId = project.id;
  });

  it('numbers cards 1, 2, 3 as they are made', async () => {
    const first = await service.create({ projectId, title: 'one' });
    const second = await service.create({ projectId, title: 'two' });

    expect(first.number).toBe(1);
    expect(second.number).toBe(2);
  });

  it('never REUSES a number, even after the card holding it is deleted', async () => {
    // The reason the counter is on the project rather than `max(number)`: two
    // commits naming different work by one identifier is the failure this
    // whole feature would otherwise introduce.
    const first = await service.create({ projectId, title: 'one' });
    await service.remove(first.id);
    const second = await service.create({ projectId, title: 'two' });

    expect(second.number).toBe(2);
  });

  it('counts per BOARD, so two projects both start at 1', async () => {
    const other = await projectDao.create({
      name: 'Other',
      taskKey: 'OTH',
      folder: realpathSync(tmpdir()),
    });
    await em.flush();

    const mine = await service.create({ projectId, title: 'one' });
    const theirs = await service.create({
      projectId: other.id,
      title: 'one',
    });

    expect(mine.number).toBe(1);
    expect(theirs.number).toBe(1);
  });

  it('leaves the counter alone when the create is refused', async () => {
    // The counter is bumped on the entity and written by the SAME flush that
    // inserts the card, so a refusal further in must not consume a number —
    // otherwise a board develops gaps for cards that never existed.
    await expect(
      service.create({ projectId: 'no-such-project', title: 'x' }),
    ).rejects.toThrow();
    const first = await service.create({ projectId, title: 'one' });

    expect(first.number).toBe(1);
  });
});
