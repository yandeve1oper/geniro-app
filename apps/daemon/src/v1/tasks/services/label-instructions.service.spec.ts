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
import { ProjectDao } from '../../projects/dao/project.dao';
import { Project } from '../../projects/entity/project.entity';
import { LabelInstructionDao } from '../dao/label-instruction.dao';
import { LabelInstruction } from '../entity/label-instruction.entity';
import { LabelInstructionsService } from './label-instructions.service';

/**
 * Real database, real DAOs — the behaviour under test is a duplicate check and
 * a scope-narrowed read, both against stored rows, so a faked DAO would
 * answer whatever the test told it and never exercise either.
 */
describe('LabelInstructionsService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: LabelInstructionsService;
  let dao: LabelInstructionDao;
  let projectDao: ProjectDao;
  let em: EntityManager;
  let folder: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    folder = mkdtempSync(join(tmpdir(), 'geniro-label-instructions-'));
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, LabelInstruction],
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
    em = orm.em.fork();
    dao = new LabelInstructionDao(em);
    projectDao = new ProjectDao(em);
    service = new LabelInstructionsService(em, dao, projectDao);
    const project = await projectDao.create({ name: 'Board', folder });
    projectId = project.id;
    const other = await projectDao.create({ name: 'Other Board', folder });
    otherProjectId = other.id;
  });

  it('lists global rows and one project’s own, but never another project’s', async () => {
    const global = await service.create({
      label: 'urgent',
      instructions: 'drop everything',
    });
    const mine = await service.create({
      label: 'bug',
      projectId,
      instructions: 'write a test',
    });
    await service.create({
      label: 'bug',
      projectId: otherProjectId,
      instructions: 'not mine',
    });

    const rows = await service.list(projectId);

    expect(rows.map((row) => row.id).sort()).toEqual(
      [global.id, mine.id].sort(),
    );
  });

  it('lists every row on the machine when no project is named', async () => {
    await service.create({ label: 'urgent', instructions: 'drop everything' });
    await service.create({
      label: 'bug',
      projectId,
      instructions: 'write a test',
    });
    await service.create({
      label: 'bug',
      projectId: otherProjectId,
      instructions: 'not mine',
    });

    const rows = await service.list();

    expect(rows).toHaveLength(3);
  });

  it('orders a scoped listing global-first, then by label', async () => {
    await service.create({ label: 'zzz', projectId, instructions: 'z' });
    await service.create({ label: 'aaa', instructions: 'a global' });
    await service.create({ label: 'bbb', projectId, instructions: 'b' });

    const rows = await service.list(projectId);

    expect(rows.map((row) => row.label)).toEqual(['aaa', 'bbb', 'zzz']);
  });

  it('refuses a create naming a project that does not exist', async () => {
    await expect(
      service.create({
        label: 'bug',
        projectId: 'no-such-project',
        instructions: 'x',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no-such-project'),
    });
  });

  it('refuses a duplicate label within the SAME scope', async () => {
    await service.create({
      label: 'bug',
      projectId,
      instructions: 'first',
    });

    await expect(
      service.create({
        label: 'bug',
        projectId,
        instructions: 'second',
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
    });
  });

  it('allows the SAME label in two different scopes', async () => {
    await service.create({ label: 'bug', instructions: 'global one' });

    await expect(
      service.create({ label: 'bug', projectId, instructions: 'project one' }),
    ).resolves.toMatchObject({ label: 'bug', projectId });
  });

  it('refuses renaming a row onto a label its own scope already holds', async () => {
    await service.create({ label: 'bug', projectId, instructions: 'a' });
    const other = await service.create({
      label: 'frontend',
      projectId,
      instructions: 'b',
    });

    await expect(
      service.update(other.id, { label: 'bug' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
    });
  });

  it('lets a row keep its own label — updating unrelated fields is not a self-collision', async () => {
    const row = await service.create({
      label: 'bug',
      projectId,
      instructions: 'a',
    });

    await expect(
      service.update(row.id, { instructions: 'a, revised' }),
    ).resolves.toMatchObject({ label: 'bug', instructions: 'a, revised' });
    // Read back through a fresh listing: the stored row, not the returned one.
    expect(await service.list(projectId)).toEqual([
      expect.objectContaining({ id: row.id, instructions: 'a, revised' }),
    ]);
  });

  it('moves a row to GLOBAL on an explicit projectId: null', async () => {
    const row = await service.create({
      label: 'bug',
      projectId,
      instructions: 'a',
    });

    await expect(
      service.update(row.id, { projectId: null }),
    ).resolves.toMatchObject({ projectId: null, label: 'bug' });
    expect(await service.list()).toEqual([
      expect.objectContaining({ id: row.id, projectId: null }),
    ]);
  });

  it('refuses moving a row into a scope that already holds its label', async () => {
    await service.create({ label: 'bug', instructions: 'global' });
    const projectRow = await service.create({
      label: 'bug',
      projectId,
      instructions: 'project',
    });

    await expect(
      service.update(projectRow.id, { projectId: null }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
    });
  });

  it('refuses moving a row to a project that does not exist', async () => {
    const row = await service.create({ label: 'bug', instructions: 'x' });

    await expect(
      service.update(row.id, { projectId: 'no-such-project' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no-such-project'),
    });
  });

  it('refuses listing for a project that does not exist', async () => {
    await expect(service.list('missing-project')).rejects.toMatchObject({
      message: expect.stringContaining('missing-project'),
    });
  });

  it('404s updating and deleting an id that names nothing', async () => {
    await expect(
      service.update('missing', { label: 'x' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('missing') });
    await expect(service.remove('missing')).rejects.toMatchObject({
      message: expect.stringContaining('missing'),
    });
  });

  it('deletes a row, which a later listing no longer includes', async () => {
    const row = await service.create({
      label: 'bug',
      projectId,
      instructions: 'a',
    });

    await expect(service.remove(row.id)).resolves.toEqual({ deleted: true });

    expect((await service.list(projectId)).map((r) => r.id)).not.toContain(
      row.id,
    );
  });

  describe('forTask', () => {
    it('answers nothing for a task with no labels', async () => {
      await service.create({ label: 'bug', instructions: 'x' });

      const rows = await service.forTask({
        projectId,
        labels: '[]',
      });

      expect(rows).toEqual([]);
    });

    it('orders rows by the TASK’s own label order, global before project within one label', async () => {
      await service.create({
        label: 'frontend',
        projectId,
        instructions: 'project frontend',
      });
      await service.create({
        label: 'bug',
        instructions: 'global bug',
      });
      await service.create({
        label: 'bug',
        projectId,
        instructions: 'project bug',
      });

      // The task lists "frontend" before "bug" — the fold must follow THIS
      // order, not the labels' own alphabetical or insertion order.
      const rows = await service.forTask({
        projectId,
        labels: JSON.stringify(['frontend', 'bug']),
      });

      expect(rows.map((row) => [row.label, row.projectId])).toEqual([
        ['frontend', projectId],
        ['bug', null],
        ['bug', projectId],
      ]);
    });

    it('ignores a label with no attached instruction, and another project’s row for the same label', async () => {
      await service.create({
        label: 'bug',
        projectId: otherProjectId,
        instructions: 'not this task’s',
      });

      const rows = await service.forTask({
        projectId,
        labels: JSON.stringify(['bug', 'no-instruction-for-this-one']),
      });

      expect(rows).toEqual([]);
    });
  });
});
