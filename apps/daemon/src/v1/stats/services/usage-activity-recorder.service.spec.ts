import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
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
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageActivityRecorderService } from './usage-activity-recorder.service';

/**
 * The live half of the activity ledger: what the agent plane announces, written as it
 * is announced. The boot sweep covers the history from before this existed. Driven
 * through a real bus and the real DAO, so the subscriptions are the thing under test.
 */
describe('UsageActivityRecorderService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: UsageActivityDao;
  let bus: AgentEventBus;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [UsageActivity],
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
    dao = new UsageActivityDao(orm.em.fork());
    bus = new AgentEventBus();
    new UsageActivityRecorderService(bus, dao).onModuleInit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a thread when its run is created, dated by the creation time and marked measured', async () => {
    bus.publishRunCreated({
      runId: 'run-a',
      createdAt: '2026-08-10T12:00:00.000Z',
    });

    await vi.waitFor(async () => {
      const rows = await dao.getAll(
        { kind: 'thread' },
        { disableIdentityMap: true },
      );
      expect(
        rows.map((row) => [
          row.runId,
          row.occurredAt.toISOString(),
          row.metricsLedger,
        ]),
      ).toEqual([['run-a', '2026-08-10T12:00:00.000Z', true]]);
    });
  });

  it('records each pull request a thread captures, dated by its own transcript time', async () => {
    bus.publishPullRequestsCaptured({
      runId: 'run-a',
      pullRequests: [
        {
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 218,
          url: 'https://github.com/geniro-io/geniro-app/pull/218',
          occurredAt: '2026-08-10T12:05:00.000Z',
        },
        {
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 219,
          url: 'https://github.com/geniro-io/geniro-app/pull/219',
          occurredAt: '2026-08-10T13:05:00.000Z',
        },
      ],
    });

    await vi.waitFor(async () => {
      const rows = await dao.getAll({ kind: 'pull_request' });
      expect(
        rows.map((row) => [row.prNumber, row.occurredAt.toISOString()]),
      ).toEqual([
        [218, '2026-08-10T12:05:00.000Z'],
        [219, '2026-08-10T13:05:00.000Z'],
      ]);
    });
  });

  it('records the other pull requests of a capture when one of them cannot be written', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    vi.spyOn(dao, 'insertPullRequestOnce').mockRejectedValueOnce(
      new Error('disk is full'),
    );

    bus.publishPullRequestsCaptured({
      runId: 'run-a',
      pullRequests: [
        {
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 218,
          url: 'https://github.com/geniro-io/geniro-app/pull/218',
          occurredAt: '2026-08-10T12:05:00.000Z',
        },
        {
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 219,
          url: 'https://github.com/geniro-io/geniro-app/pull/219',
          occurredAt: '2026-08-10T13:05:00.000Z',
        },
      ],
    });

    await vi.waitFor(async () => {
      const rows = await dao.getAll({ kind: 'pull_request' });
      expect(rows.map((row) => row.prNumber)).toEqual([219]);
    });
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      'could not record pull request geniro-io/geniro-app#218 for thread run-a: disk is full',
    ]);
  });

  it('reports a write that fails, and records the next event all the same', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    vi.spyOn(dao, 'insertThreadOnce').mockRejectedValueOnce(
      new Error('disk is full'),
    );

    bus.publishRunCreated({
      runId: 'run-lost',
      createdAt: '2026-08-10T12:00:00.000Z',
    });
    bus.publishRunCreated({
      runId: 'run-kept',
      createdAt: '2026-08-10T13:00:00.000Z',
    });

    await vi.waitFor(async () => {
      const rows = await dao.getAll({ kind: 'thread' });
      expect(rows.map((row) => row.runId)).toEqual(['run-kept']);
    });
    expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
      'could not record thread run-lost: disk is full',
    ]);
  });
});
