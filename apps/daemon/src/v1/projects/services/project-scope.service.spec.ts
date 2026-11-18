import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { TaskDao } from '../../tasks/dao/task.dao';
import { LabelInstruction } from '../../tasks/entity/label-instruction.entity';
import { Task } from '../../tasks/entity/task.entity';
import { ProjectDao } from '../dao/project.dao';
import { Project } from '../entity/project.entity';
import type { ProjectRootsService } from './project-roots.service';
import { ProjectScopeService } from './project-scope.service';

const WORKTREES = new Map([['/wt/task-1', '/repo/app']]);

const roots = {
  rootsOf: async (cwds: Iterable<string | null>) =>
    new Map(
      [...cwds]
        .filter((cwd): cwd is string => cwd !== null)
        .map((cwd) => [cwd, WORKTREES.get(cwd) ?? cwd]),
    ),
} as unknown as ProjectRootsService;

describe('ProjectScopeService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let em: EntityManager;
  let service: ProjectScopeService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Task, LabelInstruction, Run, RunGroup],
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
    em = orm.em.fork() as EntityManager;
    service = new ProjectScopeService(
      em,
      new TaskDao(em),
      new ProjectDao(em),
      roots,
    );
    em.persist(
      Object.assign(new Project(), {
        id: 'p-cards',
        name: 'Cards',
        folder: '/elsewhere',
        description: 'The card board.',
        instructions: 'Keep cards small.',
      }),
    );
    em.persist(
      Object.assign(new Project(), {
        id: 'p-app',
        name: 'App',
        folder: '/repo/app',
        instructions: 'Use pnpm.',
      }),
    );
    em.persist(
      Object.assign(new Task(), {
        id: 'task-1',
        projectId: 'p-cards',
        title: 'T',
      }),
    );
    await em.flush();
  });

  describe('projectOf', () => {
    const idOf = async (
      facts: Parameters<ProjectScopeService['projectOf']>[0],
    ) => (await service.projectOf(facts)).project?.id ?? null;

    it('takes the task card’s project over the folder the run works in', async () => {
      expect(
        await service.projectOf({ taskId: 'task-1', cwd: '/repo/app' }),
      ).toMatchObject({
        project: { id: 'p-cards' },
        source: 'card',
      });
    });

    it('falls back to the folder when the card’s project is gone', async () => {
      const row = await em.findOneOrFail(Project, 'p-cards');
      em.remove(row);
      await em.flush();
      expect(
        await service.projectOf({ taskId: 'task-1', cwd: '/repo/app' }),
      ).toMatchObject({
        project: { id: 'p-app' },
        source: 'folder',
      });
    });

    it('takes the project whose folder the run’s worktree resolves to', async () => {
      expect(await idOf({ taskId: null, cwd: '/wt/task-1' })).toBe('p-app');
    });

    it('explicit project wins over the card and the folder project', async () => {
      expect(
        await service.projectOf({
          taskId: 'task-1',
          cwd: '/repo/app',
          projectId: 'p-cards',
        }),
      ).toMatchObject({ project: { id: 'p-cards' }, source: 'explicit' });
      expect(
        await service.projectOf({
          taskId: null,
          cwd: '/repo/app',
          projectId: 'p-cards',
        }),
      ).toMatchObject({ project: { id: 'p-cards' }, source: 'explicit' });
    });

    it('explicit null yields no project even inside a project folder or on a card', async () => {
      expect(
        await service.projectOf({
          taskId: 'task-1',
          cwd: '/repo/app',
          projectId: null,
        }),
      ).toEqual({ project: null, source: 'explicit' });
    });

    it('passes over an explicit project that no longer exists', async () => {
      expect(
        await service.projectOf({
          taskId: null,
          cwd: '/repo/app',
          projectId: 'p-gone',
        }),
      ).toMatchObject({ project: { id: 'p-app' }, source: 'folder' });
    });

    it('a subfolder resolves to the nearest ancestor project; home and / never do', async () => {
      em.persist(
        Object.assign(new Project(), {
          id: 'p-home',
          name: 'Home',
          folder: homedir(),
        }),
      );
      em.persist(
        Object.assign(new Project(), {
          id: 'p-root',
          name: 'Root',
          folder: '/',
        }),
      );
      await em.flush();

      expect(await idOf({ taskId: null, cwd: '/repo/app/packages/x' })).toBe(
        'p-app',
      );
      expect(
        await idOf({ taskId: null, cwd: join(homedir(), 'scratch') }),
      ).toBeNull();
      expect(await idOf({ taskId: null, cwd: '/tmp/scratch' })).toBeNull();
      expect(await idOf({ taskId: null, cwd: homedir() })).toBe('p-home');
    });

    it('is none, not a failure, for no card and no folder', async () => {
      expect(await service.projectOf({ taskId: null, cwd: null })).toEqual({
        project: null,
        source: 'none',
      });
    });
  });

  describe('liveNamesOf', () => {
    it('names the live projects among the ids and leaves out a deleted or unknown one', async () => {
      const row = await em.findOneOrFail(Project, 'p-cards');
      em.remove(row);
      await em.flush();

      const names = await service.liveNamesOf([
        'p-app',
        'p-cards',
        'p-gone',
        null,
        'p-app',
      ]);
      expect([...names]).toEqual([['p-app', 'App']]);
    });
  });

  describe('projectOfRun', () => {
    it('keeps the project settled at creation and reads a deleted one as none', async () => {
      const run = {
        projectId: 'p-cards',
        projectSource: 'folder' as const,
        taskId: null,
        cwd: '/repo/app',
      };
      expect((await service.projectOfRun(run))?.id).toBe('p-cards');

      const row = await em.findOneOrFail(Project, 'p-cards');
      em.remove(row);
      await em.flush();
      expect(await service.projectOfRun(run)).toBeNull();
    });

    it('keeps an explicit none however the folder reads', async () => {
      expect(
        await service.projectOfRun({
          projectId: null,
          projectSource: 'explicit',
          taskId: 'task-1',
          cwd: '/repo/app',
        }),
      ).toBeNull();
    });

    it('reads a run from before the binding by exact folder, so a subfolder matches none', async () => {
      const legacy = { projectId: null, projectSource: null, taskId: null };
      expect(
        (await service.projectOfRun({ ...legacy, cwd: '/repo/app' }))?.id,
      ).toBe('p-app');
      expect(
        await service.projectOfRun({ ...legacy, cwd: '/repo/app/packages/x' }),
      ).toBeNull();
    });
  });

  describe('placeNewRun', () => {
    it('keeps the project, how it was settled and its composed instructions', async () => {
      expect(
        await service.placeNewRun({ taskId: 'task-1', cwd: null }),
      ).toEqual({
        projectId: 'p-cards',
        chosenProjectGroupId: null,
        source: 'card',
        instructions: 'Project: Cards\n\nThe card board.\n\nKeep cards small.',
      });
    });

    it('names the chosen project’s group only for an explicit choice', async () => {
      const row = await em.findOneOrFail(Project, 'p-app');
      row.groupId = 'g-app';
      await em.flush();

      expect(
        (
          await service.placeNewRun({
            taskId: null,
            cwd: '/x',
            projectId: 'p-app',
          })
        ).chosenProjectGroupId,
      ).toBe('g-app');
      expect(
        (await service.placeNewRun({ taskId: null, cwd: '/repo/app' }))
          .chosenProjectGroupId,
      ).toBeNull();
    });

    it('has no instructions for a project with neither text, and none for a run in no project', async () => {
      const row = await em.findOneOrFail(Project, 'p-app');
      row.instructions = null;
      await em.flush();

      expect(
        (await service.placeNewRun({ taskId: null, cwd: '/repo/app' }))
          .instructions,
      ).toBeNull();
      expect(
        await service.placeNewRun({ taskId: null, cwd: '/nowhere' }),
      ).toEqual({
        projectId: null,
        chosenProjectGroupId: null,
        source: 'none',
        instructions: null,
      });
    });

    it('leaves the run unplaced rather than failing when the project cannot be read', async () => {
      const broken = new ProjectScopeService(
        em,
        new TaskDao(em),
        {
          getById: async () => {
            throw new Error('db gone');
          },
          findNearestByFolder: async () => {
            throw new Error('db gone');
          },
        } as unknown as ProjectDao,
        roots,
      );
      expect(
        await broken.placeNewRun({ taskId: null, cwd: '/repo/app' }),
      ).toEqual({
        projectId: null,
        chosenProjectGroupId: null,
        source: null,
        instructions: null,
      });
    });
  });
});
