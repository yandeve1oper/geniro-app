import {
  defineConfig,
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
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import type { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import type { LegacyTeamGraph, Team } from '../../teams/teams.types';
import { teamSnapshotOf } from '../../teams/utils/team-snapshot';
import {
  legacyCanonicalJson,
  legacyGraphVersionOf,
  teamVersionOf,
} from '../../teams/utils/team-version';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { TeamVersion } from '../entity/team-version.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { TeamLedgerService } from './team-ledger.service';

const graph: Team = teamOf(
  [member('dev', { name: 'Developer' }), member('qa', { agent: 'codex' })],
  { name: 'Dev Team' },
);

const legacyGraph: LegacyTeamGraph = {
  name: 'Dev Team',
  nodes: [
    { id: 'start', kind: 'trigger', trigger: 'manual' },
    { id: 'dev', kind: 'agent', agent: 'claude', approval: 'auto' },
  ],
  edges: [{ from: 'start', to: 'dev', kind: 'data', label: 'brief' }],
};

/** Real DAOs on an in-memory database: the ledger's contract is how three tables line up. */
describe('TeamLedgerService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let bus: AgentEventBus;
  let runDao: RunDao;
  let activityDao: UsageActivityDao;
  let versionDao: TeamVersionDao;
  let service: TeamLedgerService;
  let changeLog: { recordMigration: ReturnType<typeof vi.fn> };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, UsageActivity, TeamVersion],
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
    bus = new AgentEventBus();
    runDao = new RunDao(em);
    activityDao = new UsageActivityDao(em);
    versionDao = new TeamVersionDao(em);
    changeLog = { recordMigration: vi.fn().mockResolvedValue(undefined) };
    service = new TeamLedgerService(
      em,
      bus,
      runDao,
      activityDao,
      versionDao,
      changeLog as unknown as TeamChangeLogService,
    );
  });

  async function teamRun(
    id: string,
    options: {
      createdAt?: Date;
      snapshot?: string | null;
      baseSnapshot?: string | null;
      teamId?: string | null;
    } = {},
  ): Promise<void> {
    await runDao.create({
      teamBaseSnapshot: options.baseSnapshot ?? null,
      id,
      teamId: options.teamId === undefined ? 'dev-team' : options.teamId,
      status: 'completed',
      createdAt: options.createdAt ?? new Date('2026-10-01T10:00:00.000Z'),
      teamSnapshot:
        options.snapshot === undefined
          ? teamSnapshotOf(graph)
          : options.snapshot,
    });
  }

  async function created(id: string): Promise<void> {
    bus.publishRunCreated({ runId: id, createdAt: '' });
    await service.settled();
  }

  async function row(runId: string) {
    return (await activityDao.threadRowsByRuns([runId])).get(runId);
  }

  describe('live stamping', () => {
    beforeEach(() => {
      service.onModuleInit();
    });

    it('stamps a created run with its team and version, and records the team once', async () => {
      await teamRun('run-1');
      await teamRun('run-2');
      bus.publishRunCreated({ runId: 'run-1', createdAt: '' });
      bus.publishRunCreated({ runId: 'run-2', createdAt: '' });
      await service.settled();

      expect(await row('run-1')).toMatchObject({
        slug: 'dev-team',
        version: teamVersionOf(graph),
        inferred: false,
      });
      expect(
        (await versionDao.graphsOf('dev-team')).map((v) => v.version),
      ).toEqual([teamVersionOf(graph)]);
    });

    it('stamps a project run with its project overlay and a shared run of one team with the same version', async () => {
      const effective = {
        ...graph,
        members: graph.members.map((m) => ({ ...m, effort: 'max' })),
      };
      await teamRun('shared-run');
      await teamRun('project-run', {
        snapshot: teamSnapshotOf(effective),
        baseSnapshot: teamSnapshotOf(graph),
      });
      await created('shared-run');
      await created('project-run');

      expect((await row('project-run'))?.version).toBe(teamVersionOf(graph));
      expect((await row('shared-run'))?.version).toBe(teamVersionOf(graph));
      expect(
        (await versionDao.graphsOf('dev-team')).map((v) => v.version),
      ).toEqual([teamVersionOf(graph)]);
    });

    it('leaves a chat run alone', async () => {
      await teamRun('chat-1', { teamId: null, snapshot: null });
      await created('chat-1');

      expect(await row('chat-1')).toBeUndefined();
    });

    it('writes nothing for a run deleted before its announce was handled', async () => {
      await created('gone');

      expect(await row('gone')).toBeUndefined();
    });

    it('logs a failed stamp instead of throwing it into the bus', async () => {
      await teamRun('run-1');
      vi.spyOn(activityDao, 'stampThreadVersion').mockRejectedValueOnce(
        new Error('disk gone'),
      );

      await created('run-1');

      expect(await row('run-1')).toBeUndefined();
    });
  });

  describe('sweep', () => {
    it('stamps every unversioned run, marking pre-snapshot runs inferred and copy-less runs slug only', async () => {
      await teamRun('fresh');
      await teamRun('old', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
      });
      await teamRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
      });
      await teamRun('unreadable', { snapshot: '{"members":"no"}' });
      await teamRun('chat', { teamId: null, snapshot: null });

      expect(await service.sweep()).toEqual({ versions: 4 });

      expect(await row('fresh')).toMatchObject({
        version: teamVersionOf(graph),
        inferred: false,
      });
      expect(await row('old')).toMatchObject({
        version: teamVersionOf(graph),
        inferred: true,
      });
      expect(await row('copyless')).toMatchObject({
        slug: 'dev-team',
        version: null,
        inferred: null,
      });
      expect(await row('unreadable')).toMatchObject({
        slug: 'dev-team',
        version: null,
      });
      expect(await row('chat')).toBeUndefined();
    });

    it('registers a version first seen by a genuine run, never by an inferred one', async () => {
      const later: Team = {
        ...graph,
        members: [...graph.members, member('qa2')],
      };
      await teamRun('old', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
        snapshot: teamSnapshotOf(later),
      });
      await teamRun('fresh', {
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      });

      await service.sweep();

      expect(await versionDao.graphsOf('dev-team')).toEqual([
        {
          version: teamVersionOf(graph),
          graph: expect.any(String),
          firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
        },
      ]);
      expect(await row('old')).toMatchObject({
        version: teamVersionOf(later),
        inferred: true,
      });
    });

    it('logs a run it cannot stamp and stamps the rest', async () => {
      await teamRun('broken');
      await teamRun('fine');
      const stamp = activityDao.stampThreadVersion.bind(activityDao);
      vi.spyOn(activityDao, 'stampThreadVersion').mockImplementation(
        async (runId, ...rest) => {
          if (runId === 'broken') {
            throw new Error('disk gone');
          }
          return stamp(runId, ...rest);
        },
      );

      await expect(service.sweep()).resolves.toEqual({ versions: 1 });
      expect((await row('fine'))?.version).toBe(teamVersionOf(graph));
      expect((await row('broken'))?.version ?? null).toBeNull();
    });

    it('writes nothing on a second call', async () => {
      await teamRun('fresh');
      await teamRun('copyless', { snapshot: null });
      await service.sweep();

      expect(await service.sweep()).toEqual({ versions: 0 });
    });

    it('keeps a copy-less run slug-only after a later read freezes the library team into it', async () => {
      await teamRun('copyless', {
        createdAt: new Date('2026-09-08T00:00:00.000Z'),
        snapshot: null,
      });
      await service.sweep();
      await runDao.updateById(
        'copyless',
        { teamSnapshot: teamSnapshotOf(graph) },
        orm.em.fork(),
      );

      expect(await service.sweep()).toEqual({ versions: 0 });
      expect((await row('copyless'))?.version).toBeNull();
      expect(await versionDao.graphsOf('dev-team')).toEqual([]);
    });
  });

  describe('a run that started while teams were node graphs', () => {
    const legacySnapshot = JSON.stringify(legacyGraph);
    const OLD = legacyGraphVersionOf(legacyGraph);

    beforeEach(() => {
      service.onModuleInit();
    });

    it('is stamped with the version of its graph as stored, and the graph is recorded in its old canonical form', async () => {
      await teamRun('old-run', { snapshot: legacySnapshot });
      await created('old-run');

      expect(await row('old-run')).toMatchObject({
        slug: 'dev-team',
        version: OLD,
        inferred: false,
      });
      expect(await versionDao.graphsOf('dev-team')).toEqual([
        {
          version: OLD,
          graph: legacyCanonicalJson(legacyGraph),
          firstSeenAt: new Date('2026-10-01T10:00:00.000Z'),
        },
      ]);
      expect(changeLog.recordMigration).not.toHaveBeenCalled();
    });

    it('logs one migration entry at the first team-shaped version after only graph-shaped ones', async () => {
      await teamRun('old-run', {
        snapshot: legacySnapshot,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      await created('old-run');
      await teamRun('new-run', {
        createdAt: new Date('2026-10-02T10:00:00.000Z'),
      });
      await created('new-run');
      await teamRun('newer-run', {
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      });
      await created('newer-run');

      expect(changeLog.recordMigration).toHaveBeenCalledTimes(1);
      expect(changeLog.recordMigration).toHaveBeenCalledWith(
        'dev-team',
        OLD,
        teamVersionOf(graph),
      );
      expect(
        (await versionDao.graphsOf('dev-team')).map((v) => v.version),
      ).toEqual([OLD, teamVersionOf(graph)]);
    });

    it('logs nothing for a team whose first recorded version is team-shaped', async () => {
      await teamRun('new-run');
      await created('new-run');

      expect(changeLog.recordMigration).not.toHaveBeenCalled();
    });

    it('logs nothing once a team-shaped version is already recorded', async () => {
      await teamRun('old-run', {
        snapshot: legacySnapshot,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      await created('old-run');
      await teamRun('new-run', {
        createdAt: new Date('2026-10-02T10:00:00.000Z'),
      });
      await created('new-run');
      changeLog.recordMigration.mockClear();

      const edited: Team = { ...graph, maxActiveTurns: 2 };
      await teamRun('edited-run', {
        snapshot: teamSnapshotOf(edited),
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      });
      await created('edited-run');

      expect(changeLog.recordMigration).not.toHaveBeenCalled();
    });

    it('logs nothing for an inferred team-shaped run, which records no version', async () => {
      await teamRun('old-run', {
        snapshot: legacySnapshot,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      });
      await created('old-run');
      await teamRun('inferred-run', {
        createdAt: new Date('2026-09-11T00:00:00.000Z'),
      });
      await created('inferred-run');

      expect(changeLog.recordMigration).not.toHaveBeenCalled();
    });

    it('is stamped by the sweep the same way', async () => {
      await teamRun('old-run', { snapshot: legacySnapshot });

      await service.sweep();

      expect((await row('old-run'))?.version).toBe(OLD);
    });
  });
});
