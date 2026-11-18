import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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
import { Run } from '../../runs/entity/run.entity';
import { RunGroup } from '../../runs/entity/run-group.entity';
import { RunDao } from '../dao/run.dao';
import { RunGroupDao } from '../dao/run-group.dao';
import { AgentEventBus } from './agent-events.bus';
import { RunGroupsService } from './run-groups.service';

/** Rows in a list, ordered the way the real DAO orders them. */
class FakeGroupDao {
  readonly rows: RunGroup[] = [];
  private n = 0;
  async listOrdered(): Promise<RunGroup[]> {
    return [...this.rows].sort(
      (a, b) =>
        a.position - b.position ||
        a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }
  async getById(id: string): Promise<RunGroup | null> {
    return this.rows.find((row) => row.id === id) ?? null;
  }
  async create(data: Partial<RunGroup>): Promise<RunGroup> {
    const row = {
      id: `g-${this.n}`,
      name: '',
      color: 'blue',
      position: 0,
      collapsed: false,
      autoCwd: null,
      createdAt: new Date(this.n),
      updatedAt: new Date(this.n),
      ...data,
    } as unknown as RunGroup;
    this.n += 1;
    this.rows.push(row);
    return row;
  }
  async hardDeleteById(id: string): Promise<void> {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index >= 0) {
      this.rows.splice(index, 1);
    }
  }
}

class FakeRunDao {
  readonly runs: Run[] = [];
  async clearGroup(groupId: string): Promise<number> {
    const matches = this.runs.filter((run) => run.groupId === groupId);
    for (const run of matches) {
      run.groupId = null;
    }
    return matches.length;
  }
}

type BoundProject = { id: string; groupId: string | null };

class FakeProjectDao {
  readonly projects: BoundProject[] = [];
  async releaseGroupBinding(groupId: string): Promise<number> {
    const matches = this.projects.filter(
      (project) => project.groupId === groupId,
    );
    for (const project of matches) {
      project.groupId = null;
    }
    return matches.length;
  }
}

function setup(): {
  service: RunGroupsService;
  groupDao: FakeGroupDao;
  runDao: FakeRunDao;
  projectDao: FakeProjectDao;
  bus: AgentEventBus;
} {
  const groupDao = new FakeGroupDao();
  const bus = new AgentEventBus();
  const runDao = new FakeRunDao();
  const projectDao = new FakeProjectDao();
  const em = {
    fork: () => ({
      flush: async () => undefined,
      transactional: async (fn: (tx: EntityManager) => Promise<void>) =>
        fn({} as EntityManager),
    }),
  } as unknown as EntityManager;
  return {
    service: new RunGroupsService(
      em,
      groupDao as unknown as RunGroupDao,
      runDao as unknown as RunDao,
      projectDao as unknown as ProjectDao,
      bus,
    ),
    groupDao,
    runDao,
    projectDao,
    bus,
  };
}

describe('RunGroupsService', () => {
  let dir: string;
  let nested: string;
  beforeAll(() => {
    // CANONICAL, because that is the only form this service ever compares:
    // both sides are resolved at the moment they are chosen (`autoCwd` here,
    // a run's `cwd` in `ChatService.createChat`), so nothing on a read path
    // touches the filesystem. On macOS the temp dir is a symlink, so a spec
    // that skipped this would be handing the service an input production
    // never produces.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'geniro-groups-')));
    nested = realpathSync(mkdtempSync(join(dir, 'pkg-')));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends new groups and gives each an unnamed colour of its own', async () => {
    const { service } = setup();
    const first = await service.create({ name: 'Work' });
    const second = await service.create({ name: 'Personal' });
    expect([first.position, second.position]).toEqual([0, 1]);
    // Not a shared default: three groups the user never coloured must still be
    // tellable apart, which a fixed 'blue' for every one of them would not be.
    expect(first.color).not.toBe(second.color);
  });

  it('canonicalizes an auto-file folder and refuses one that does not exist', async () => {
    const { service } = setup();
    const group = await service.create({ name: 'App', autoCwd: dir });
    // Compared against a run's own canonical cwd later, so it is stored
    // resolved — never as the caller happened to spell it.
    expect(group.autoCwd).not.toBeNull();
    await expect(
      service.create({ name: 'Ghost', autoCwd: '/definitely/not/here' }),
    ).rejects.toThrow();
  });

  it('files a chat started inside an auto-folder, and one outside it nowhere', async () => {
    const { service } = setup();
    const group = await service.create({ name: 'App', autoCwd: dir });
    // The point of containment over equality: the user pointed the group at a
    // project, and its packages are inside that project.
    expect(await service.resolveAutoGroupId({ cwd: nested })).toBe(group.id);
    expect(
      await service.resolveAutoGroupId({ cwd: realpathSync(tmpdir()) }),
    ).toBeNull();
    expect(await service.resolveAutoGroupId({ cwd: null })).toBeNull();
  });

  it('gives the run to the MOST SPECIFIC folder when two groups claim it', async () => {
    const { service } = setup();
    // Created outer-first, so a "first match wins" reading would answer the
    // wrong one and this test would fail.
    await service.create({ name: 'All work', autoCwd: dir });
    const inner = await service.create({
      name: 'This package',
      autoCwd: nested,
    });
    expect(await service.resolveAutoGroupId({ cwd: nested })).toBe(inner.id);
  });

  it('files a run by its TEAM, whatever folder it runs in', async () => {
    const { service } = setup();
    const group = await service.create({
      name: 'Dev team',
      autoTeamId: 'dev-team',
    });
    // No folder rule anywhere: a team runs over many repositories, so the
    // folder is exactly what cannot identify these runs.
    expect(
      await service.resolveAutoGroupId({
        cwd: realpathSync(tmpdir()),
        teamId: 'dev-team',
      }),
    ).toBe(group.id);
    // Another team, and an ordinary chat, are both unclaimed.
    expect(
      await service.resolveAutoGroupId({ cwd: nested, teamId: 'other' }),
    ).toBeNull();
    expect(await service.resolveAutoGroupId({ cwd: nested })).toBeNull();
  });

  it('lets a TEAM claim outrank a folder claim on the same run', async () => {
    // The ranking is the whole reason both rules can coexist: a team run
    // starts inside the very project whose ordinary chats the user already
    // files elsewhere, so reading it as a folder chat puts it in the wrong
    // group every time.
    const { service } = setup();
    const byFolder = await service.create({ name: 'App', autoCwd: nested });
    const byTeam = await service.create({
      name: 'Dev team',
      autoTeamId: 'dev-team',
    });
    expect(
      await service.resolveAutoGroupId({
        cwd: nested,
        teamId: 'dev-team',
      }),
    ).toBe(byTeam.id);
    // …and the folder rule still answers for a chat in the same folder.
    expect(await service.resolveAutoGroupId({ cwd: nested })).toBe(byFolder.id);
  });

  it('files a run started under a project by choice in that project’s group while the group exists', async () => {
    const { service } = setup();
    const byFolder = await service.create({ name: 'App', autoCwd: nested });
    const projectGroup = await service.create({ name: 'Billing' });

    expect(
      await service.groupForNewRun({
        cwd: nested,
        chosenProjectGroupId: projectGroup.id,
      }),
    ).toBe(projectGroup.id);
    expect(
      await service.groupForNewRun({
        cwd: nested,
        chosenProjectGroupId: 'deleted-group',
      }),
    ).toBe(byFolder.id);
    expect(
      await service.groupForNewRun({ cwd: nested, chosenProjectGroupId: null }),
    ).toBe(byFolder.id);
  });

  it('clears the TEAM rule on an explicit null too', async () => {
    const { service } = setup();
    const group = await service.create({
      name: 'Dev team',
      autoTeamId: 'dev-team',
    });
    const renamed = await service.update(group.id, { name: 'Renamed' });
    expect(renamed.autoTeamId).toBe('dev-team'); // omitting changes nothing
    const cleared = await service.update(group.id, { autoTeamId: null });
    expect(cleared.autoTeamId).toBeNull();
    expect(
      await service.resolveAutoGroupId({ cwd: null, teamId: 'dev-team' }),
    ).toBeNull();
  });

  it('clears the auto-file rule on an explicit null, which omitting cannot say', async () => {
    const { service } = setup();
    const group = await service.create({ name: 'App', autoCwd: dir });
    const renamed = await service.update(group.id, { name: 'Renamed' });
    expect(renamed.autoCwd).not.toBeNull(); // an omitted key changes nothing
    const cleared = await service.update(group.id, { autoCwd: null });
    expect(cleared.autoCwd).toBeNull();
    expect(await service.resolveAutoGroupId({ cwd: nested })).toBeNull();
  });

  it('does not sweep up chats that already exist when a rule is added', async () => {
    // A new rule says where the NEXT chat lands. Retroactively moving the ones
    // the user filed by hand would undo their own arrangement without asking —
    // so nothing about `update` touches a run at all.
    const { service, runDao } = setup();
    runDao.runs.push({ id: 'r1', groupId: null, cwd: nested } as Run);
    const group = await service.create({ name: 'App' });
    await service.update(group.id, { autoCwd: dir });
    expect(runDao.runs[0]!.groupId).toBeNull();
  });

  it('takes the arrangement a drag produced and renumbers it contiguously', async () => {
    const { service } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    const c = await service.create({ name: 'C' });
    const moved = await service.reorder([c.id, a.id, b.id]);
    expect(moved.map((group) => group.name)).toEqual(['C', 'A', 'B']);
    // Contiguous from zero, so "the one above this" is always position - 1.
    expect(moved.map((group) => group.position)).toEqual([0, 1, 2]);
  });

  it('is idempotent — replaying a drag lands on the same rows', async () => {
    // The reason the wire carries the ARRANGEMENT and not a displacement: a
    // relative move replayed moves twice, and a dropped connection is the
    // ordinary reason a write gets replayed.
    const { service } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    await service.reorder([b.id, a.id]);
    expect(
      (await service.reorder([b.id, a.id])).map((group) => group.name),
    ).toEqual(['B', 'A']);
  });

  it('keeps a group the client did not name instead of dropping it', async () => {
    // The list is a snapshot of what ONE window could see. A group created in
    // another (or by a request in flight when the drag started) must not lose
    // its place because a stale client failed to mention it.
    const { service } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    const unseen = await service.create({ name: 'Made elsewhere' });
    const ordered = await service.reorder([b.id, a.id]);
    expect(ordered.map((group) => group.name)).toEqual([
      'B',
      'A',
      'Made elsewhere',
    ]);
    expect(ordered.map((group) => group.id)).toContain(unseen.id);
  });

  it('ignores an id naming no group rather than refusing the arrangement', async () => {
    // A delete that landed mid-drag is not a reason to throw away the gesture.
    const { service } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    expect(
      (await service.reorder([b.id, 'deleted-mid-drag', a.id])).map(
        (group) => group.name,
      ),
    ).toEqual(['B', 'A']);
  });

  it('repairs positions that ever came to collide', async () => {
    // The renumber is unconditional: two rows sharing a position render in an
    // order the daemon does not hold, and the next drag is what fixes it.
    const { service, groupDao } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    groupDao.rows.forEach((row) => {
      row.position = 0;
    });
    const repaired = await service.reorder([a.id, b.id]);
    expect(repaired.map((group) => group.position)).toEqual([0, 1]);
  });

  it('deleting a group RELEASES its runs instead of taking them with it', async () => {
    const { service, runDao, groupDao } = setup();
    const group = await service.create({ name: 'Work' });
    runDao.runs.push(
      { id: 'r1', groupId: group.id } as Run,
      { id: 'r2', groupId: group.id } as Run,
      { id: 'r3', groupId: 'other' } as Run,
    );
    expect(await service.remove(group.id)).toEqual({
      deleted: true,
      released: 2,
    });
    expect(groupDao.rows).toHaveLength(0);
    // Every run still here — the two released, the third untouched.
    expect(runDao.runs.map((run) => run.groupId)).toEqual([
      null,
      null,
      'other',
    ]);
  });

  it('deleting a group RELEASES every project bound to it and leaves the rest alone', async () => {
    const { service, runDao, projectDao } = setup();
    const group = await service.create({ name: 'Boards' });
    const other = await service.create({ name: 'Other' });
    projectDao.projects.push(
      { id: 'p1', groupId: group.id },
      { id: 'p2', groupId: group.id },
      { id: 'p3', groupId: other.id },
    );
    runDao.runs.push({ id: 'r1', groupId: group.id } as Run);

    await service.remove(group.id);

    expect(projectDao.projects.map((project) => project.groupId)).toEqual([
      null,
      null,
      other.id,
    ]);
  });

  it('404s rather than silently succeeding for a group that does not exist', async () => {
    const { service } = setup();
    await expect(service.assertExists('nope')).rejects.toThrow(/not found/);
    await expect(service.update('nope', { name: 'x' })).rejects.toThrow();
    await expect(service.remove('nope')).rejects.toThrow();
  });

  it('announces every write to the group list, so another device re-reads it', async () => {
    const { service, bus } = setup();
    let announced = 0;
    bus.allGroupsChanged().subscribe(() => {
      announced += 1;
    });
    const a = await service.create({ name: 'A' });
    expect(announced).toBe(1);
    await service.update(a.id, { collapsed: true });
    expect(announced).toBe(2);
    const b = await service.create({ name: 'B' });
    await service.reorder([b.id, a.id]);
    expect(announced).toBe(4);
    await service.remove(a.id);
    expect(announced).toBe(5);
    // A read is not a change.
    await service.list();
    expect(announced).toBe(5);
  });

  it('stores a name and a folded state the sidebar can read back', async () => {
    const { service } = setup();
    const group = await service.create({ name: 'Work', color: 'green' });
    expect(await service.update(group.id, { collapsed: true })).toMatchObject({
      name: 'Work',
      color: 'green',
      collapsed: true,
    });
    expect(await service.update(group.id, { name: 'Renamed' })).toMatchObject({
      name: 'Renamed',
      collapsed: true,
    });
  });

  it('lists groups in sidebar order', async () => {
    const { service } = setup();
    const a = await service.create({ name: 'A' });
    const b = await service.create({ name: 'B' });
    await service.reorder([b.id, a.id]);
    expect((await service.list()).map((group) => group.name)).toEqual([
      'B',
      'A',
    ]);
  });

  it('separator handling is the platform’s, not a hardcoded slash', () => {
    // Guards the one assumption every path test above rests on.
    expect(sep).toBe('/');
  });
});

describe('RunGroupsService.remove (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: RunGroupsService;
  let projectDao: ProjectDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Project, Run, RunGroup],
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
    const em = orm.em.fork();
    projectDao = new ProjectDao(em);
    service = new RunGroupsService(
      em,
      new RunGroupDao(em),
      new RunDao(em),
      projectDao,
      new AgentEventBus(),
    );
  });

  it('nulls every project.groupId when its sidebar group is deleted and leaves other bindings', async () => {
    const bound = await service.create({ name: 'Board group' });
    const other = await service.create({ name: 'Other' });
    const project = await projectDao.create({
      name: 'Geniro',
      folder: '/tmp/geniro-run-groups-remove-spec',
      taskKey: 'GEN',
      groupId: bound.id,
    });
    const kept = await projectDao.create({
      name: 'Other board',
      folder: '/tmp/geniro-run-groups-remove-spec-other',
      taskKey: 'OTH',
      groupId: other.id,
    });
    const softBound = await projectDao.create({
      name: 'Gone board',
      folder: '/tmp/geniro-run-groups-remove-spec-gone',
      taskKey: 'GON',
      groupId: bound.id,
    });
    const em = orm.em.fork();
    await em
      .createQueryBuilder(Project)
      .update({ deletedAt: new Date() })
      .where({ id: softBound.id })
      .execute();

    await service.remove(bound.id);

    const read = new ProjectDao(orm.em.fork());
    expect((await read.getById(project.id))?.groupId).toBeNull();
    expect((await read.getById(kept.id))?.groupId).toBe(other.id);
    const softRow = await orm.em
      .fork()
      .findOne(
        Project,
        { id: softBound.id },
        { filters: { softDelete: false } },
      );
    expect(softRow?.groupId).toBeNull();
  });
});
