import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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

import { RunDao } from '../../agents/dao/run.dao';
import { RunGroupDao } from '../../agents/dao/run-group.dao';
import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { LabelInstructionDao } from '../../tasks/dao/label-instruction.dao';
import { TaskDao } from '../../tasks/dao/task.dao';
import { LabelInstruction } from '../../tasks/entity/label-instruction.entity';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { ProjectInstructionChangeDao } from '../dao/project-instruction-change.dao';
import { Project } from '../entity/project.entity';
import { ProjectInstructionChange } from '../entity/project-instruction-change.entity';
import { PROJECT_CHANGE_COALESCE_MS } from '../projects.types';
import { ProjectEventBus } from './project-events.bus';
import type { ProjectRootsService } from './project-roots.service';
import { ProjectScopeService } from './project-scope.service';
import { ProjectsService } from './projects.service';

function asBlock(text: string): {
  instructionBlocks: { id: string; title: string; text: string }[];
};
function asBlock(text: null): { instructionBlocks: null };
function asBlock(text: string | null) {
  return {
    instructionBlocks: text === null ? null : [{ id: 'b1', title: '', text }],
  };
}

const sameFolderRoots = {
  rootsOf: async (cwds: Iterable<string | null>) =>
    new Map(
      [...cwds]
        .filter((cwd): cwd is string => cwd !== null)
        .map((cwd) => [cwd, cwd]),
    ),
} as unknown as ProjectRootsService;

/**
 * Real database, real DAOs: the behaviour under test is that deleting a
 * project takes its tasks with it, and nothing in this daemon cascades — so
 * the removal is the service's own two calls, and the soft-delete filter is
 * what makes the tasks unreadable afterwards. A faked DAO would let the
 * service's arrangement pass while proving nothing about either.
 */
describe('ProjectsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: ProjectsService;
  let projectDao: ProjectDao;
  let em: EntityManager;
  let taskDao: TaskDao;
  let labelInstructionDao: LabelInstructionDao;
  let runDao: RunDao;
  let groupDao: RunGroupDao;
  let changeDao: ProjectInstructionChangeDao;
  let published: string[];
  let folder: string;
  let otherFolder: string;

  beforeAll(async () => {
    // A real directory, because `create` canonicalizes the folder through
    // `resolveValidDirectory` and refuses one that does not exist.
    folder = mkdtempSync(join(tmpdir(), 'geniro-project-'));
    otherFolder = mkdtempSync(join(tmpdir(), 'geniro-project-'));
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [
          Project,
          ProjectInstructionChange,
          Task,
          LabelInstruction,
          Run,
          RunGroup,
        ],
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
    rmSync(otherFolder, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await orm.schema.clear();
    em = orm.em.fork() as EntityManager;
    projectDao = new ProjectDao(em);
    taskDao = new TaskDao(em);
    labelInstructionDao = new LabelInstructionDao(em);
    runDao = new RunDao(em);
    groupDao = new RunGroupDao(em);
    changeDao = new ProjectInstructionChangeDao(em);
    const events = new ProjectEventBus();
    published = [];
    events.allChanges().subscribe(({ projectId }) => published.push(projectId));
    service = new ProjectsService(
      em,
      projectDao,
      taskDao,
      labelInstructionDao,
      runDao,
      groupDao,
      changeDao,
      events,
      new ProjectScopeService(em, taskDao, projectDao, sameFolderRoots),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('run defaults', () => {
    it('keeps the context window and model parameters it was created with', async () => {
      const project = await service.create({
        name: 'Board',
        folder,
        agentKind: 'claude',
        model: 'opus',
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      });

      expect(project).toMatchObject({
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      });
    });

    it('clears them with an explicit null and leaves them alone when omitted', async () => {
      const project = await service.create({
        name: 'Board',
        folder,
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      });

      const untouched = await service.update(project.id, { effort: 'high' });
      expect(untouched).toMatchObject({
        contextWindow: '1m',
        modelParameters: { fast: 'on' },
      });

      const cleared = await service.update(project.id, {
        contextWindow: null,
        modelParameters: null,
      });
      expect(cleared).toMatchObject({
        contextWindow: null,
        modelParameters: {},
      });
    });
  });

  describe('instruction blocks', () => {
    it('reads instructions written before blocks as one block', async () => {
      const project = await service.create({ name: 'Board', folder });
      await orm.em
        .fork()
        .nativeUpdate(
          Project,
          { id: project.id },
          { instructions: 'Use pnpm.', instructionBlocks: null },
        );

      expect((await service.get(project.id)).instructionBlocks).toEqual([
        { id: 'instructions', title: 'Instructions', text: 'Use pnpm.' },
      ]);
    });

    it('gives a run the blocks’ texts in order and logs them under their titles', async () => {
      const project = await service.create({ name: 'Board', folder });
      const saved = await service.update(project.id, {
        instructionBlocks: [
          { id: 'build', title: 'Build', text: 'Use pnpm.' },
          { id: 'empty', title: '', text: '  ' },
          { id: 'tests', title: 'Tests', text: 'Run pnpm test:unit.' },
        ],
      });

      expect(saved.instructions).toBe('Use pnpm.\n\nRun pnpm test:unit.');
      expect(saved.instructionBlocks.map((block) => block.id)).toEqual([
        'build',
        'empty',
        'tests',
      ]);
      const [logged] = await changeDao.recentFor(project.id, 1);
      expect(logged).toMatchObject({
        field: 'instructions',
        previous: null,
        next: '## Build\n\nUse pnpm.\n\n## Tests\n\nRun pnpm test:unit.',
      });
    });

    it('bumps no revision for a block that says nothing yet', async () => {
      const project = await service.create({ name: 'Board', folder });
      const saved = await service.update(project.id, {
        instructionBlocks: [{ id: 'new', title: '', text: '' }],
      });

      expect(saved.instructionsRevision).toBe(0);
      expect(saved.instructionBlocks).toEqual([
        { id: 'new', title: '', text: '' },
      ]);
    });

    it('refuses two blocks with one id, writing nothing', async () => {
      const project = await service.create({ name: 'Board', folder });
      await expect(
        service.update(project.id, {
          instructionBlocks: [
            { id: 'a', title: '', text: 'one' },
            { id: 'a', title: '', text: 'two' },
          ],
        }),
      ).rejects.toMatchObject({ errorCode: 'INVALID_PROJECT_BLOCKS' });
      expect((await service.get(project.id)).instructionBlocks).toEqual([]);
    });
  });

  describe('instructions revision and change log', () => {
    it('refuses a stale expectedInstructionsRevision with 409 and writes nothing', async () => {
      const project = await service.create({ name: 'Board', folder });
      const saved = await service.update(project.id, {
        ...asBlock('Use pnpm.'),
        expectedInstructionsRevision: 0,
      });
      expect(saved.instructionsRevision).toBe(1);

      await expect(
        service.update(project.id, {
          ...asBlock('Stale text.'),
          expectedInstructionsRevision: 0,
        }),
      ).rejects.toMatchObject({
        errorCode: 'PROJECT_INSTRUCTIONS_DRIFT',
        statusCode: 409,
      });
      expect(await service.get(project.id)).toMatchObject({
        instructions: 'Use pnpm.',
        instructionsRevision: 1,
      });
    });

    it('runs two writes quoting the same revision one after the other, refusing the second', async () => {
      const project = await service.create({ name: 'Board', folder });
      const [first, second] = await Promise.allSettled([
        service.update(project.id, {
          ...asBlock('From the page.'),
          expectedInstructionsRevision: 0,
        }),
        service.update(project.id, {
          ...asBlock('From the analysis.'),
          expectedInstructionsRevision: 0,
        }),
      ]);

      expect(first).toMatchObject({ status: 'fulfilled' });
      expect(second).toMatchObject({
        status: 'rejected',
        reason: { errorCode: 'PROJECT_INSTRUCTIONS_DRIFT' },
      });
      expect(await service.get(project.id)).toMatchObject({
        instructions: 'From the page.',
        instructionsRevision: 1,
      });
    });

    it('refuses a text with a control character, from any writer', async () => {
      const project = await service.create({ name: 'Board', folder });
      await expect(
        service.update(
          project.id,
          { ...asBlock('Use pnpm.\u0000') },
          {
            source: 'analysis',
            recommendationIds: ['P-1'],
            chatRunId: 'analysis-run',
            cardSeq: 1,
          },
        ),
      ).rejects.toMatchObject({ errorCode: 'INVALID_PROJECT_BLOCKS' });
      expect(await service.get(project.id)).toMatchObject({
        instructions: null,
        instructionsRevision: 0,
      });
      expect(
        (
          await service.update(project.id, {
            ...asBlock('Line one.\nLine two.'),
          })
        ).instructions,
      ).toBe('Line one.\nLine two.');
    });

    it('bumps the revision only when a text changes', async () => {
      const project = await service.create({ name: 'Board', folder });
      await service.update(project.id, { name: 'Renamed' });
      await service.update(project.id, { description: '  ' });
      expect((await service.get(project.id)).instructionsRevision).toBe(0);
      await service.update(project.id, { description: 'What it is.' });
      expect((await service.get(project.id)).instructionsRevision).toBe(1);
    });

    it('coalesces user edits within 10 minutes into one change row', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
      const project = await service.create({ name: 'Board', folder });
      await service.update(project.id, { ...asBlock('Use') });
      vi.setSystemTime(new Date('2026-11-01T10:05:00Z'));
      await service.update(project.id, { ...asBlock('Use pnpm.') });

      let rows = await changeDao.recentFor(project.id, 20);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        field: 'instructions',
        source: 'user',
        previous: null,
        next: 'Use pnpm.',
      });

      vi.setSystemTime(
        new Date(
          new Date('2026-11-01T10:05:00Z').getTime() +
            PROJECT_CHANGE_COALESCE_MS,
        ),
      );
      await service.update(project.id, { ...asBlock('Use pnpm only.') });
      rows = await changeDao.recentFor(project.id, 20);
      expect(rows.map((row) => [row.previous, row.next])).toEqual([
        ['Use pnpm.', 'Use pnpm only.'],
        [null, 'Use pnpm.'],
      ]);
    });

    it('keeps each field’s edits on that field’s own row', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
      const project = await service.create({ name: 'Board', folder });
      await service.update(project.id, { description: 'What it is.' });
      vi.setSystemTime(new Date('2026-11-01T10:02:00Z'));
      await service.update(project.id, {
        description: 'What it is.',
        ...asBlock('Use pnpm.'),
      });

      const rows = await changeDao.recentFor(project.id, 20);
      expect(
        rows.map((row) => [row.field, row.previous, row.next]).sort(),
      ).toEqual([
        ['description', null, 'What it is.'],
        ['instructions', null, 'Use pnpm.'],
      ]);
    });

    it('drops the row when a user’s edits land back where they started', async () => {
      const project = await service.create({
        name: 'Board',
        folder,
        ...asBlock('Use pnpm.'),
      });
      await service.update(project.id, { ...asBlock('Use yarn.') });
      await service.update(project.id, { ...asBlock('Use pnpm.') });

      expect(await changeDao.recentFor(project.id, 20)).toEqual([]);
      expect((await service.get(project.id)).instructionsRevision).toBe(2);
    });

    it('logs an analysis write on its own row, crediting its recommendations', async () => {
      const project = await service.create({ name: 'Board', folder });
      await service.update(project.id, { ...asBlock('Use pnpm.') });
      await service.update(
        project.id,
        { ...asBlock('Use pnpm. Run full-check.') },
        {
          source: 'analysis',
          recommendationIds: ['P-1'],
          chatRunId: 'analysis-run',
          cardSeq: 42,
        },
      );
      await service.update(project.id, {
        ...asBlock('Use pnpm. Run full-check first.'),
      });

      const rows = await changeDao.recentFor(project.id, 20);
      expect(
        rows.map((row) => [row.source, row.next, row.recommendationIds]),
      ).toEqual([
        ['user', 'Use pnpm. Run full-check first.', []],
        ['analysis', 'Use pnpm. Run full-check.', ['P-1']],
        ['user', 'Use pnpm.', []],
      ]);
      expect(rows[1]).toMatchObject({
        chatRunId: 'analysis-run',
        cardSeq: 42,
      });
    });

    it('marks a projects_changed that touched only the texts', async () => {
      const project = await service.create({ name: 'Board', folder });
      const events: { projectId: string; textsOnly?: boolean }[] = [];
      const bus = new ProjectEventBus();
      bus.allChanges().subscribe((event) => events.push(event));
      const watched = new ProjectsService(
        em,
        projectDao,
        taskDao,
        labelInstructionDao,
        runDao,
        groupDao,
        changeDao,
        bus,
        new ProjectScopeService(em, taskDao, projectDao, sameFolderRoots),
      );

      await watched.update(project.id, {
        ...asBlock('Use pnpm.'),
        expectedInstructionsRevision: 0,
      });
      await watched.update(project.id, { name: 'Renamed' });
      await watched.update(project.id, {
        name: 'Renamed again',
        description: 'What it is.',
      });

      expect(events.map((event) => event.textsOnly === true)).toEqual([
        true,
        false,
        false,
      ]);
    });

    it('announces projects_changed on create, update, rearm and delete', async () => {
      const project = await service.create({ name: 'Board', folder });
      await service.update(project.id, { name: 'Renamed' });
      await service.rearmAutopilot(project.id);
      const tripped = await projectDao.getById(project.id, em);
      tripped!.autopilotFailureStreak = 3;
      await em.flush();
      await service.rearmAutopilot(project.id);
      await service.remove(project.id);

      expect(published).toEqual([
        project.id,
        project.id,
        project.id,
        project.id,
      ]);
    });
  });

  describe('forFolder', () => {
    it('answers the project bound to a folder or to the closest one above it', async () => {
      const project = await service.create({ name: 'Board', folder });
      const nested = join(folder, 'packages');
      mkdirSync(nested);

      expect((await service.forFolder(folder)).project?.id).toBe(project.id);
      expect((await service.forFolder(nested)).project?.id).toBe(project.id);
      expect((await service.forFolder(otherFolder)).project).toBeNull();
      expect((await service.forFolder('/no/such/folder')).project).toBeNull();
    });
  });

  it('refuses a group id that names no sidebar group, on create and on update', async () => {
    await expect(
      service.create({ name: 'Board', folder, groupId: 'ghost' }),
    ).rejects.toMatchObject({ errorCode: 'GROUP_NOT_FOUND' });
    expect(await projectDao.listAll()).toEqual([]);

    const project = await service.create({ name: 'Board', folder });
    await expect(
      service.update(project.id, { groupId: 'ghost' }),
    ).rejects.toMatchObject({ errorCode: 'GROUP_NOT_FOUND' });
    expect((await projectDao.getById(project.id))?.groupId).toBeNull();
  });

  it('stores a group id the sidebar holds, and null clears it', async () => {
    const group = await groupDao.create({ name: 'Boards', position: 0 });
    const project = await service.create({
      name: 'Board',
      folder,
      groupId: group.id,
    });
    expect(project.groupId).toBe(group.id);

    const cleared = await service.update(project.id, { groupId: null });
    expect(cleared.groupId).toBeNull();
  });

  it('settles the project’s knowledge inside the removal, and announces it after the commit', async () => {
    const project = await service.create({ name: 'Doomed', folder });
    const order: string[] = [];
    const seen: unknown[] = [];
    service.useRemovalParticipant(async (projectId, fate, tx) => {
      order.push('settled');
      seen.push({ projectId, fate });
      expect(tx.isInTransaction()).toBe(true);
      return {
        moved: 2,
        deleted: 0,
        renamed: [{ from: 'a', to: 'a-2' }],
        announce: () => order.push('announced'),
      };
    });

    const result = await service.remove(project.id, 'delete');

    expect(seen).toEqual([{ projectId: project.id, fate: 'delete' }]);
    expect(order).toEqual(['settled', 'announced']);
    expect(result).toMatchObject({
      knowledgeMoved: 2,
      knowledgeRenamed: [{ from: 'a', to: 'a-2' }],
    });
  });

  it('rolls the whole removal back when the participant fails', async () => {
    const project = await service.create({ name: 'Kept', folder });
    service.useRemovalParticipant(async () => {
      throw new Error('refused');
    });

    await expect(service.remove(project.id)).rejects.toThrow('refused');

    expect((await service.list()).map((row) => row.id)).toContain(project.id);
  });

  it('removes a project’s tasks along with the project', async () => {
    const project = await service.create({ name: 'Board', folder });
    await taskDao.create({ projectId: project.id, title: 'first' });
    await taskDao.create({ projectId: project.id, title: 'second' });

    const result = await service.remove(project.id);

    expect(result).toEqual({
      deleted: true,
      tasksRemoved: 2,
      knowledgeMoved: 0,
      knowledgeDeleted: 0,
      knowledgeRenamed: [],
    });
    // The real observable: a read after the delete returns nothing. The rows
    // are soft-deleted, so this is the `softDelete` filter hiding them — which
    // is exactly what every other reader of this table will see.
    expect(await taskDao.listForProject(project.id)).toEqual([]);
    expect(await projectDao.getById(project.id)).toBeNull();
  });

  it('removes a project’s own label instructions, and leaves a GLOBAL one alone', async () => {
    const project = await service.create({ name: 'Board', folder });
    const scoped = await labelInstructionDao.create({
      projectId: project.id,
      label: 'bug',
      instructions: 'fix it',
    });
    const global = await labelInstructionDao.create({
      projectId: null,
      label: 'urgent',
      instructions: 'drop everything',
    });

    await service.remove(project.id);

    // The real observable: a read after the delete finds nothing for the
    // project-scoped row (the `softDelete` filter hides it) but still finds
    // the global one, which names no project to be removed with. A FRESH
    // fork, because the row was created on this test's own `em` and the
    // delete ran on a separate transactional fork inside the service — an
    // identity-map read on the original `em` would hand back the stale,
    // pre-delete instance rather than re-querying.
    const readEm = orm.em.fork() as EntityManager;
    expect(await labelInstructionDao.getById(scoped.id, readEm)).toBeNull();
    expect(await labelInstructionDao.getById(global.id, readEm)).not.toBeNull();
  });

  // A board delete takes every card with it, and the chats that worked them
  // go on as ordinary chats rather than naming cards that are gone — the same
  // release a single card's delete makes. A chat of another board is left be.
  it('lets go of the chats that worked the deleted board’s cards', async () => {
    const doomed = await service.create({ name: 'Doomed', folder });
    const kept = await service.create({ name: 'Kept', folder: otherFolder });
    const goes = await taskDao.create({ projectId: doomed.id, title: 'goes' });
    const stays = await taskDao.create({ projectId: kept.id, title: 'stays' });
    const thread = (id: string, taskId: string) =>
      runDao.create({
        id,
        teamId: null,
        status: 'completed',
        agentKind: 'claude',
        taskId,
        taskIdentifier: 'X-1',
      });
    await thread('run-goes', goes.id);
    await thread('run-stays', stays.id);

    await service.remove(doomed.id);

    const fresh = orm.em.fork() as EntityManager;
    const read = (id: string) => new RunDao(fresh).getById(id, fresh);
    expect(await read('run-goes')).toMatchObject({
      taskId: null,
      taskIdentifier: null,
    });
    expect(await read('run-stays')).toMatchObject({
      taskId: stays.id,
      taskIdentifier: 'X-1',
    });
  });

  it('leaves another project’s tasks alone when one is deleted', async () => {
    const doomed = await service.create({ name: 'Doomed', folder });
    const kept = await service.create({ name: 'Kept', folder: otherFolder });
    await taskDao.create({ projectId: doomed.id, title: 'goes' });
    const survivor = await taskDao.create({
      projectId: kept.id,
      title: 'stays',
    });

    await service.remove(doomed.id);

    const remaining = await taskDao.listForProject(kept.id);
    expect(remaining.map((task) => task.id)).toEqual([survivor.id]);
  });

  it('refuses to delete a project that does not exist', async () => {
    await expect(service.remove('no-such-project')).rejects.toMatchObject({
      // The guard exists so a delete cannot silently report success for a id
      // that names nothing — a board the caller thinks it removed.
      message: expect.stringContaining('no-such-project'),
    });
  });

  it('refuses a folder that is not a directory on disk', async () => {
    await expect(
      service.create({ name: 'Bad', folder: join(folder, 'does-not-exist') }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('does not exist'),
    });
  });

  it('refuses a second project on a folder another already holds', async () => {
    // The autopilot bounds concurrent work per PROJECT while the worktree is
    // created in the FOLDER, so two projects on one folder would give that
    // folder twice the cap.
    await service.create({ name: 'First', folder });

    await expect(
      service.create({ name: 'Second', folder }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already uses that folder'),
    });
  });

  it('disambiguates a card key another live project already holds', async () => {
    // `projectKey` takes one initial per word, so two boards collide readily —
    // and every name with no Latin letters in it derives the SAME fallback, so
    // two Cyrillic-named boards on one machine always collide. The chat
    // sidebar draws `Run.taskIdentifier` in one global list, so the collision
    // puts two different cards on screen under one label with nothing to tell
    // them apart and no route to edit either key.
    const first = await service.create({ name: 'Проект', folder });
    const second = await service.create({
      name: 'Другой',
      folder: otherFolder,
    });

    expect(first.taskKey).toBe('TSK');
    expect(second.taskKey).not.toBe(first.taskKey);
    expect(second.taskKey).toBe('TSK2');
  });

  it('does NOT hand a deleted project’s key to the next board', async () => {
    // The invariant is per PROJECT and settled at create: no two projects ever
    // share a key. It has to hold against deleted boards because
    // `Run.taskIdentifier` is denormalized onto the run row and outlives the
    // task — deleting a project deletes its tasks, not the chats those tasks
    // opened — so the removed board's `TSK-12` is still drawn in the one global
    // chat sidebar. Reading only LIVE projects freed `TSK` again and put two
    // unrelated conversations on screen under one label, which is the very
    // defect the disambiguation exists to prevent.
    const first = await service.create({ name: 'Проект', folder });
    expect(first.taskKey).toBe('TSK');
    await service.remove(first.id);

    const second = await service.create({ name: 'Другой', folder });

    expect(second.taskKey).not.toBe('TSK');
  });

  it('never blocks a create over a key the user did not type', async () => {
    // The folder check REFUSES; this one appends. The difference is whose
    // value it is — a folder is chosen, a key is derived and invisible.
    await service.create({ name: 'Проект', folder });

    await expect(
      service.create({ name: 'Ещё один', folder: otherFolder }),
    ).resolves.toMatchObject({ name: 'Ещё один' });
  });

  it('refuses moving a project onto an occupied folder, but lets it keep its own', async () => {
    const first = await service.create({ name: 'First', folder });
    const second = await service.create({
      name: 'Second',
      folder: otherFolder,
    });

    await expect(service.update(second.id, { folder })).rejects.toMatchObject({
      message: expect.stringContaining('already uses that folder'),
    });

    // Its own folder is not "taken" by itself — the guard has to exempt the
    // project being updated, or no patch touching `folder` could ever pass.
    const kept = await service.update(first.id, { folder, name: 'Renamed' });
    expect(kept.folder).toBe(first.folder);
    expect(kept.name).toBe('Renamed');
  });

  it('frees a folder when its project is deleted', async () => {
    // The guard reads through the `softDelete` filter, and it has to: a
    // delete leaves the row and its folder behind, so anything answering
    // from the raw table reserves that folder forever. A unique index does
    // exactly that — this same sequence raised
    // `UNIQUE constraint failed: projects.folder` from the driver while one
    // was on the column, on the ordinary act of removing a project and
    // adding it back.
    const first = await service.create({ name: 'First', folder });
    await service.remove(first.id);

    const second = await service.create({ name: 'Second', folder });

    expect(second.folder).toBe(first.folder);
    expect(second.id).not.toBe(first.id);
  });

  it('removes the project and its tasks in one transaction', async () => {
    const project = await service.create({ name: 'Board', folder });
    await taskDao.create({ projectId: project.id, title: 'a card' });

    await service.remove(project.id);

    expect(await projectDao.getById(project.id)).toBeNull();
    expect(await taskDao.listForProject(project.id)).toEqual([]);
  });

  it('refuses a project past the cap', async () => {
    // Distinct folders, because `Project.folder` is unique — seeded through
    // the DAO, which does not canonicalize, so these need not exist on disk.
    const filler = Array.from({ length: 199 }, (_, i) => ({
      name: `filler ${i}`,
      folder: `${folder}/filler-${i}`,
    }));
    await projectDao.createMany(filler);

    // The boundary accepts, so a cap that fires a row early cannot pass.
    await expect(
      service.create({ name: 'the two hundredth', folder }),
    ).resolves.toMatchObject({ name: 'the two hundredth' });

    await expect(
      service.create({ name: 'one too many', folder }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('at most'),
    });
  });

  it('clears a nullable field on an explicit null and leaves omitted keys alone', async () => {
    const project = await service.create({
      name: 'Board',
      folder,
      model: 'sonnet',
      teamSlug: 'ship-it',
    });

    const updated = await service.update(project.id, { model: null });

    expect(updated.model).toBeNull();
    // The omitted key is the half that is easy to break: a patch that rebuilds
    // the row from its own fields would blank this too.
    expect(updated.teamSlug).toBe('ship-it');
  });

  it('writes the lessons setting on update, returns it on the wire, and null hands it back to inherit', async () => {
    const project = await service.create({ name: 'Board', folder });
    const storedLessons = async (): Promise<unknown> =>
      (await new ProjectDao(orm.em.fork() as EntityManager).getById(project.id))
        ?.lessons;

    const off = await service.update(project.id, { lessons: 'off' });
    expect(off.lessons).toBe('off');
    expect(await storedLessons()).toBe('off');

    const kept = await service.update(project.id, { model: 'sonnet' });
    expect(kept.lessons).toBe('off');

    const on = await service.update(project.id, { lessons: 'on' });
    expect(on.lessons).toBe('on');
    expect(await storedLessons()).toBe('on');

    const inherited = await service.update(project.id, { lessons: null });
    expect(inherited.lessons).toBeNull();
    expect(await storedLessons()).toBeNull();
  });

  it('stores a trimmed description and instructions, and returns them on the wire', async () => {
    const created = await service.create({
      name: 'Board',
      folder,
      description: '  A billing service  ',
      ...asBlock('\nUse pnpm.\n'),
    });
    expect(created.description).toBe('A billing service');
    expect(created.instructions).toBe('Use pnpm.');

    const row = await projectDao.getById(created.id);
    expect(row?.description).toBe('A billing service');
    expect(row?.instructions).toBe('Use pnpm.');
  });

  it('defaults description and instructions to null, and a blank one normalizes to null', async () => {
    const created = await service.create({
      name: 'Board',
      folder,
      description: '   ',
    });
    expect(created.description).toBeNull();
    expect(created.instructions).toBeNull();

    const updated = await service.update(created.id, {
      ...asBlock(' \n '),
    });
    expect(updated.instructions).toBeNull();
  });

  it('leaves them alone when omitted from a patch, and clears them on an explicit null', async () => {
    const created = await service.create({
      name: 'Board',
      folder,
      description: 'desc',
      ...asBlock('rules'),
    });

    const renamed = await service.update(created.id, { name: 'Renamed' });
    expect(renamed.description).toBe('desc');
    expect(renamed.instructions).toBe('rules');

    const cleared = await service.update(created.id, {
      description: null,
      ...asBlock(null),
    });
    expect(cleared.description).toBeNull();
    expect(cleared.instructions).toBeNull();
    expect((await projectDao.getById(created.id))?.instructions).toBeNull();
  });

  it('reads a usage-limit wait while it stands, ends it on a re-arm, and drops a lapsed one', async () => {
    const project = await service.create({ name: 'board', folder });
    const row = (await projectDao.getById(project.id, em)) as Project;
    const until = new Date(Date.now() + 60_000);
    row.autopilotLimitUntil = until;
    await em.flush();

    expect((await service.get(project.id)).autopilotLimitUntil).toBe(
      until.toISOString(),
    );
    expect(
      (await service.rearmAutopilot(project.id)).autopilotLimitUntil,
    ).toBeNull();

    row.autopilotLimitUntil = new Date(Date.now() - 1);
    await em.flush();

    expect((await service.get(project.id)).autopilotLimitUntil).toBeNull();
  });

  // Re-arming is its own press rather than a field on the patch: the breaker
  // opened because runs kept failing, so resuming is presumed deliberate.
  it('clears the failure streak on a re-arm, and a second press is a no-op', async () => {
    const project = await service.create({ name: 'board', folder });
    const row = await projectDao.getById(project.id, em);
    (row as Project).autopilotFailureStreak = 4;
    await em.flush();

    expect(
      (await service.rearmAutopilot(project.id)).autopilotFailureStreak,
    ).toBe(0);
    expect(
      (await service.rearmAutopilot(project.id)).autopilotFailureStreak,
    ).toBe(0);
  });
});
