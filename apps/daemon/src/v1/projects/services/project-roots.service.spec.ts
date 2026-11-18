import {
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
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Task } from '../../tasks/entity/task.entity';
import { Project } from '../entity/project.entity';
import { ProjectRootsService } from './project-roots.service';

describe('ProjectRootsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let fixtures: string;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Task, Project],
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
    fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'project-roots-')));
    return () => rmSync(fixtures, { recursive: true, force: true });
  });

  const worktreeOf = (taskId: string): string =>
    join('/Users/me/Library/Application Support/Geniro', 'worktrees', taskId);

  async function seed(task: Partial<Task>, project: Partial<Project>) {
    const em = orm.em.fork();
    em.persist(
      Object.assign(new Project(), { name: 'P', folder: '/repo', ...project }),
    );
    em.persist(Object.assign(new Task(), { title: 'T', ...task }));
    await em.flush();
  }

  it('files a TASK worktree under its card’s project folder — and a deleted card still answers', async () => {
    // REPORTED: every board card runs in a worktree of its own, so one
    // repository's spend was spread over a row per task. The worktree is gone
    // by the time anybody looks (the board collects it once the card is
    // done), and so, often, is the card.
    await seed(
      {
        id: 'task-1',
        projectId: 'proj-1',
        folder: null,
        deletedAt: new Date(),
      },
      { id: 'proj-1', folder: '/work/app' },
    );

    const roots = await new ProjectRootsService(orm.em.fork()).rootsOf([
      worktreeOf('task-1'),
      join(worktreeOf('task-1'), 'apps', 'ui'),
    ]);

    expect(roots.get(worktreeOf('task-1'))).toBe('/work/app');
    expect(roots.get(join(worktreeOf('task-1'), 'apps', 'ui'))).toBe(
      '/work/app',
    );
  });

  it('prefers the card’s OWN folder over its project’s', async () => {
    await seed(
      { id: 'task-2', projectId: 'proj-2', folder: '/work/other' },
      { id: 'proj-2', folder: '/work/app' },
    );

    const roots = await new ProjectRootsService(orm.em.fork()).rootsOf([
      worktreeOf('task-2'),
    ]);

    expect(roots.get(worktreeOf('task-2'))).toBe('/work/other');
  });

  it('leaves a folder under some OTHER worktrees directory as itself — no task by that id', async () => {
    const folder = '/Users/me/stuff/worktrees/not-a-task';

    const roots = await new ProjectRootsService(orm.em.fork()).rootsOf([
      folder,
    ]);

    expect(roots.get(folder)).toBe(folder);
  });

  it('files a live linked worktree under its main repository, and leaves an ordinary folder as itself', async () => {
    const repo = join(fixtures, 'repo');
    mkdirSync(join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    const tree = join(fixtures, 'wt');
    mkdirSync(tree);
    const gitdir = join(repo, '.git', 'worktrees', 'wt');
    writeFileSync(join(tree, '.git'), `gitdir: ${gitdir}\n`);
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    writeFileSync(join(gitdir, 'gitdir'), `${join(tree, '.git')}\n`);
    const sub = join(repo, 'packages');
    mkdirSync(sub);

    const roots = await new ProjectRootsService(orm.em.fork()).rootsOf([
      tree,
      sub,
      null,
    ]);

    expect(roots.get(tree)).toBe(repo);
    expect(roots.get(sub)).toBe(sub);
  });
});
