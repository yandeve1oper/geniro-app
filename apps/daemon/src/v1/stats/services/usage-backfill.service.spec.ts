import {
  defineConfig,
  EntityRepository,
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

import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { teamSnapshotOf } from '../../teams/utils/team-snapshot';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import { POLLED_SPEND_SEQ } from '../stats.types';
import { UsageBackfillService } from './usage-backfill.service';

/**
 * Driven against a real in-memory database with the real DAOs, not fakes: the
 * sweep's whole contract is about how five tables line up — which transcript
 * rows are candidates, which the ledger already holds, and where each turn's
 * dimensions come from — and a fake of any of them would be the spec asserting
 * its own arrangement back to itself.
 */
describe('UsageBackfillService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let service: UsageBackfillService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let usageDao: UsageEventDao;
  let activityDao: UsageActivityDao;

  const USAGE = {
    usage: {
      costUsd: 0.4,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      thinkingTokens: 3,
      durationMs: 2_000,
      apiMs: 1_500,
    },
    stopReason: 'end_turn',
  };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        dbName: ':memory:',
        entities: [Run, Item, NodeState, UsageEvent, UsageActivity],
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
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    usageDao = new UsageEventDao(em);
    activityDao = new UsageActivityDao(em);
    service = new UsageBackfillService(
      em,
      itemDao,
      runDao,
      nodeStateDao,
      usageDao,
      activityDao,
    );
  });

  async function turn(
    runId: string,
    seq: number,
    payload: unknown = USAGE,
    memberId: string | null = null,
  ): Promise<Item> {
    return itemDao.create({
      runId,
      memberId,
      seq,
      kind: 'turn_complete',
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }

  it('recovers finished turns that predate the ledger, with their run’s dimensions', async () => {
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
    });
    await turn('run-a', 1);
    await turn('run-a', 3);

    const result = await service.backfill();

    expect(result).toEqual({ recovered: 2, scanned: 2 });
    const rows = await usageDao.getAll({});
    expect(rows.map((row) => row.seq).sort()).toEqual([1, 3]);
    expect(rows[0]).toMatchObject({
      runId: 'run-a',
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work/project',
      teamName: null,
      costUsd: 0.4,
      inputTokens: 800,
    });
  });

  it('leaves the runs it reads exactly as they were', async () => {
    // The sweep reads every run for its dimensions, and the ledger write used
    // to flush that same EntityManager — which wrote each loaded run back with
    // a fresh `updatedAt`. One recovered turn re-dated every run on the machine.
    const old = new Date('2026-01-01T00:00:00.000Z');
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      createdAt: old,
      updatedAt: old,
    });
    await turn('run-a', 0);

    expect((await service.backfill()).recovered).toBe(1);

    const run = await new RunDao(orm.em.fork()).getById('run-a');
    expect(run!.updatedAt.toISOString()).toBe(old.toISOString());
  });

  it('recovers a lessons reflection’s turn under the lessons purpose, and a thread’s turn under none', async () => {
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      model: 'claude-opus-5',
    });
    await runDao.create({
      id: 'reflection',
      agentKind: 'claude',
      model: 'claude-opus-5',
      analysisSourceRunId: 'run-a',
      analysisPurpose: 'lessons',
    });
    await turn('reflection', 2);
    await turn('run-a', 1);

    await service.backfill();

    const rows = await usageDao.getAll({});
    expect(
      Object.fromEntries(rows.map((row) => [row.runId, row.purpose])),
    ).toEqual({ reflection: 'lessons', 'run-a': null });
  });

  it('dates each turn by its transcript row, not by when the sweep ran', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    const item = await turn('run-a', 0);

    await service.backfill();

    const [row] = await usageDao.getAll({});
    // The recovered row must sit on the day the turn happened — otherwise a
    // year of history collapses onto the day the ledger was introduced.
    expect(row!.occurredAt.getTime()).toBe(item.createdAt.getTime());
  });

  it('is safe to run on every boot — a second sweep recovers nothing', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await turn('run-a', 1);

    expect((await service.backfill()).recovered).toBe(2);
    const second = await service.backfill();

    expect(second).toEqual({ recovered: 0, scanned: 2 });
    expect(await usageDao.getAll({})).toHaveLength(2);
  });

  it('picks up only the turns the live recorder missed', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await turn('run-a', 1);
    // The shape a crash leaves behind: the recorder got the first turn in, then
    // the daemon died between the second turn's item write and its ledger write.
    await usageDao.recordOnce({
      runId: 'run-a',
      memberId: null,
      seq: 0,
      occurredAt: new Date('2026-08-01T00:00:00.000Z'),
      agentKind: 'claude',
      model: null,
      cwd: null,
      teamName: null,
      costUsd: 0.4,
      estimatedCostUsd: null,
      inputTokens: 800,
      outputTokens: 150,
      cacheReadTokens: 40,
      cacheCreationTokens: 5,
      thinkingTokens: 3,
      durationMs: 2_000,
      apiMs: 1_500,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });

    expect((await service.backfill()).recovered).toBe(1);
    expect((await usageDao.getAll({})).map((row) => row.seq).sort()).toEqual([
      0, 1,
    ]);
  });

  it('ignores transcript rows that are not finished turns', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await itemDao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'message',
      payload: JSON.stringify({ text: 'hello' }),
    });
    await itemDao.create({
      runId: 'run-a',
      seq: 1,
      kind: 'tool_call',
      payload: JSON.stringify({ name: 'ls' }),
    });

    expect(await service.backfill()).toEqual({ recovered: 0, scanned: 0 });
    expect(await usageDao.getAll({})).toHaveLength(0);
  });

  it('skips a turn that reported no usage, and one whose payload will not parse', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0, { stopReason: 'end_turn' });
    await turn('run-a', 1, 'not json {');
    await turn('run-a', 2);

    const result = await service.backfill();

    // One bad row costs its own turn's accounting and nothing else — the sweep
    // still recovers the rest of the history around it.
    expect(result.recovered).toBe(1);
    expect((await usageDao.getAll({})).map((row) => row.seq)).toEqual([2]);
  });

  it('attributes a team member’s turn to the member’s own agent and model', async () => {
    // A team run names no single agent; reading the run alone would leave
    // every member's spend unattributed.
    await runDao.create({
      id: 'run-w',
      teamId: 'wf-1',
      agentKind: null,
      model: null,
      cwd: '/work/project',
    });
    await nodeStateDao.create({
      runId: 'run-w',
      memberId: 'node-2',
      agentKind: 'cursor-agent',
      model: 'composer-1',
    });
    await turn('run-w', 0, USAGE, 'node-2');

    await service.backfill();

    expect((await usageDao.getAll({}))[0]).toMatchObject({
      memberId: 'node-2',
      agentKind: 'cursor-agent',
      model: 'composer-1',
      cwd: '/work/project',
    });
  });

  it('files a turn another pool member ran under that member, as the live recorder does', async () => {
    await runDao.create({
      id: 'run-w',
      teamId: 'wf-1',
      agentKind: null,
      model: null,
      cwd: '/work/project',
    });
    await nodeStateDao.create({
      runId: 'run-w',
      memberId: 'node-2',
      agentKind: 'claude',
      model: 'opus',
    });
    await turn('run-w', 0, USAGE, 'node-2');
    await turn(
      'run-w',
      1,
      { ...USAGE, agentKind: 'codex', agentModel: 'gpt-5.5' },
      'node-2',
    );

    await service.backfill();

    const rows = (await usageDao.getAll({})).sort((a, b) => a.seq - b.seq);
    expect(rows.map((row) => [row.agentKind, row.model])).toEqual([
      ['claude', 'opus'],
      ['codex', 'gpt-5.5'],
    ]);
  });

  it('recovers an orphaned turn whose run row is already gone', async () => {
    // `Item.runId` carries no FK, so a straggling write can outlive its run.
    // Losing the money because the dimensions are unknown would be the exact
    // failure this ledger exists to prevent.
    await turn('run-vanished', 0);

    expect((await service.backfill()).recovered).toBe(1);
    expect((await usageDao.getAll({}))[0]).toMatchObject({
      runId: 'run-vanished',
      agentKind: null,
      model: null,
      cwd: null,
      teamName: null,
      costUsd: 0.4,
    });
  });

  it('re-reads only what happened since the ledger’s newest turn', async () => {
    // The bound that stops launch cost growing with total history. The first
    // sweep seeds everything; later ones read back from the newest recorded
    // turn less a day of overlap.
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    const recent = await turn('run-a', 0);
    await service.backfill();

    // A turn far older than the watermark, written straight into the transcript
    // without going through the ledger — the shape the sweep no longer reaches.
    const ancient = await itemDao.create({
      runId: 'run-old',
      seq: 0,
      kind: 'turn_complete',
      payload: JSON.stringify(USAGE),
    });
    // `createdAt` is set by the entity, so back-date it through the DB
    // directly — this is the row a long-idle install would already hold.
    await orm.em
      .fork()
      .nativeUpdate(
        Item,
        { id: ancient.id },
        { createdAt: new Date(recent.createdAt.getTime() - 5 * 86_400_000) },
      );

    const second = await service.backfill();

    // Deliberately NOT recovered: bounding the sweep is the trade, and it is
    // safe because the only turns it can miss are ones a crash left behind
    // MILLISECONDS before a newer turn was recorded — the overlap covers that
    // by a day, not by five.
    expect(second.recovered).toBe(0);
    expect(second.scanned).toBe(1);
    expect(await usageDao.getAll({})).toHaveLength(1);
  });

  it('still recovers a turn the recorder missed within the overlap window', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await turn('run-a', 0);
    await service.backfill();

    // The real crash shape: a turn written to the transcript moments after the
    // last recorded one, with the daemon dying before its ledger write.
    await turn('run-a', 1);

    expect((await service.backfill()).recovered).toBe(1);
    expect(await usageDao.getAll({})).toHaveLength(2);
  });

  it('does nothing on an empty database', async () => {
    expect(await service.backfill()).toEqual({ recovered: 0, scanned: 0 });
  });

  it('lets the daemon boot when the sweep itself fails', async () => {
    // The catch in `onModuleInit` is the difference between a page with gaps
    // and a daemon that refuses to start. Nothing entered it before, so a
    // later "this is unreachable" cleanup would have turned a seeding failure
    // into a launch failure with a green suite.
    const broken = new UsageBackfillService(
      orm.em.fork(),
      {
        allUsageRows: async () => {
          throw new Error('database is locked');
        },
      } as unknown as ItemDao,
      runDao,
      nodeStateDao,
      usageDao,
      activityDao,
    );
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});

    await expect(broken.onModuleInit()).resolves.toBeUndefined();

    expect(String(warn.mock.calls[0]?.[0])).toContain('database is locked');
    warn.mockRestore();
  });
  describe('polled spend', () => {
    it('seeds the polled row of every priced run, and of no other', async () => {
      // Runs the poll priced before the ledger kept their bill — and the repair
      // for a daemon that died between the poll's run write and its ledger
      // write. Without it their cursor spend is on no page at all.
      await runDao.create({
        id: 'run-cursor',
        agentKind: 'cursor-agent',
        cwd: '/work/project',
        polledCostCents: 250,
      });
      await runDao.create({ id: 'run-claude', agentKind: 'claude' });

      expect(await service.backfillPolledSpend()).toBe(1);

      const rows = await usageDao.getAll({});
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: 'run-cursor',
        seq: POLLED_SPEND_SEQ,
        agentKind: 'cursor-agent',
        cwd: '/work/project',
        costUsd: 2.5,
      });
    });

    it('is safe to run on every boot — an unchanged bill writes nothing', async () => {
      await runDao.create({
        id: 'run-cursor',
        agentKind: 'cursor-agent',
        polledCostCents: 250,
      });

      expect(await service.backfillPolledSpend()).toBe(1);
      expect(await service.backfillPolledSpend()).toBe(0);
      expect(await usageDao.getAll({})).toHaveLength(1);
    });

    it('writes the model and the team from the columns it loads', async () => {
      // The sweep loads a projection of each run, so a column left out of it
      // reads as nothing — and the row, rewritten on any difference, would
      // then file the bill under no model and no team on every boot.
      await runDao.create({
        id: 'run-wf',
        agentKind: null,
        model: 'gpt-5.6-sol',
        teamId: 'dev-team',
        teamSnapshot: teamSnapshotOf(
          teamOf([member('dev')], { name: 'Dev Team' }),
        ),
        polledCostCents: 729,
      });

      expect(await service.backfillPolledSpend()).toBe(1);

      const [row] = await usageDao.getAll({ runId: 'run-wf' });
      expect(row).toMatchObject({
        model: 'gpt-5.6-sol',
        teamName: 'Dev Team',
        costUsd: 7.29,
      });
    });

    it('reads what the ledger already holds ONCE, not once per priced run', async () => {
      for (const id of ['run-a', 'run-b', 'run-c']) {
        await runDao.create({
          id,
          agentKind: 'cursor-agent',
          polledCostCents: 250,
        });
      }
      await service.backfillPolledSpend();
      const lookup = vi.spyOn(usageDao, 'polledSpendRows');
      const record = vi.spyOn(usageDao, 'recordPolledSpend');

      // A bill moved on one run: that row alone is rewritten.
      await runDao.updateById('run-b', { polledCostCents: 400 });
      const findOne = vi.spyOn(EntityRepository.prototype, 'findOne');
      expect(await service.backfillPolledSpend()).toBe(1);

      expect(lookup).toHaveBeenCalledTimes(1);
      // Each run is handed its own row from the one read, so none looks
      // itself up.
      expect(
        record.mock.calls.map((call) => [call[0], call[3]?.[0]?.runId]),
      ).toEqual(
        expect.arrayContaining([
          ['run-a', 'run-a'],
          ['run-b', 'run-b'],
          ['run-c', 'run-c'],
        ]),
      );
      expect(record).toHaveBeenCalledTimes(3);
      // …and the DAO takes the rows it is handed rather than reading its own.
      expect(findOne).not.toHaveBeenCalled();
      expect([...lookup.mock.calls[0]![0]].sort()).toEqual([
        'run-a',
        'run-b',
        'run-c',
      ]);
      const rows = await usageDao.getAll({ runId: 'run-b' });
      expect(rows[0]?.costUsd).toBe(4);
    });

    it('still seeds the polled bills when the turn sweep fails', async () => {
      // Two sweeps, isolated: an unreadable transcript is no reason to leave
      // every cursor bill off the page too.
      await runDao.create({
        id: 'run-cursor',
        agentKind: 'cursor-agent',
        polledCostCents: 250,
      });
      const broken = new UsageBackfillService(
        orm.em.fork(),
        {
          allUsageRows: async () => {
            throw new Error('database is locked');
          },
        } as unknown as ItemDao,
        runDao,
        nodeStateDao,
        usageDao,
        activityDao,
      );
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});

      await broken.onModuleInit();

      expect(
        (await usageDao.getAll({})).map((row) => [row.runId, row.costUsd]),
      ).toEqual([['run-cursor', 2.5]]);
      warn.mockRestore();
    });
  });

  describe('activity ledger', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const at = (iso: string): Date => new Date(iso);

    /** A pull request as a run's `pullRequests` column records it. */
    const opened = (number: number, seq: number) => ({
      owner: 'geniro-io',
      repo: 'geniro-app',
      number,
      url: `https://github.com/geniro-io/geniro-app/pull/${number}`,
      seq,
    });

    function startRun(
      id: string,
      createdAt: string,
      pullRequests: readonly ReturnType<typeof opened>[] = [],
    ): Promise<Run> {
      return runDao.create({
        id,
        agentKind: 'claude',
        createdAt: at(createdAt),
        pullRequests:
          pullRequests.length === 0 ? null : JSON.stringify(pullRequests),
      });
    }

    /** The transcript row a pull request was captured at, written at `writtenAt`. */
    function transcriptRow(
      runId: string,
      seq: number,
      writtenAt: string,
      kind: Item['kind'] = 'tool_result',
    ): Promise<Item> {
      return itemDao.create({
        runId,
        seq,
        kind,
        payload: JSON.stringify({ text: 'gh pr create finished' }),
        createdAt: at(writtenAt),
      });
    }

    // Read untracked: a row loaded into the identity map once would be served
    // from it on the next read, hiding a sweep that rewrote it in between.
    async function threadRows(): Promise<
      { runId: string; occurredAt: string }[]
    > {
      const rows = await activityDao.getAll(
        { kind: 'thread' },
        { orderBy: { runId: 'asc' }, disableIdentityMap: true },
      );
      return rows.map((row) => ({
        runId: row.runId,
        occurredAt: row.occurredAt.toISOString(),
      }));
    }

    async function pullRequestRows() {
      const rows = await activityDao.getAll(
        { kind: 'pull_request' },
        {
          orderBy: { runId: 'asc', prNumber: 'asc' },
          disableIdentityMap: true,
        },
      );
      return rows.map((row) => ({
        runId: row.runId,
        owner: row.prOwner,
        repo: row.prRepo,
        number: row.prNumber,
        url: row.prUrl,
        occurredAt: row.occurredAt.toISOString(),
      }));
    }

    /** Every row of the ledger, ids included, so a rewritten row cannot pass as untouched. */
    async function ledger() {
      const rows = await activityDao.getAll(
        {},
        { orderBy: { dedupKey: 'asc' }, disableIdentityMap: true },
      );
      return rows.map((row) => ({
        id: row.id,
        dedupKey: row.dedupKey,
        occurredAt: row.occurredAt.toISOString(),
      }));
    }

    it('records a thread for every run, dated by when the run was created', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z');
      await startRun('run-b', '2026-08-03T17:30:00.000Z');

      const result = await service.backfillActivity();

      expect(result).toEqual({ threads: 2, pullRequests: 0 });
      expect(await threadRows()).toEqual([
        { runId: 'run-a', occurredAt: '2026-08-01T09:00:00.000Z' },
        { runId: 'run-b', occurredAt: '2026-08-03T17:30:00.000Z' },
      ]);
    });

    it('keeps the thread row a run already has instead of writing a second', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z');
      // Dated differently from the run itself, so an overwrite would show.
      await activityDao.insertThreadOnce(
        'run-a',
        at('2026-08-01T09:00:02.000Z'),
      );

      const result = await service.backfillActivity();

      expect(result).toEqual({ threads: 0, pullRequests: 0 });
      expect(await threadRows()).toEqual([
        { runId: 'run-a', occurredAt: '2026-08-01T09:00:02.000Z' },
      ]);
    });

    it('dates a pull request by the transcript row it was captured at, in its own run', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(218, 4)]);
      await startRun('run-b', '2026-08-02T09:00:00.000Z', [opened(7, 4)]);
      // The same seq in both runs: only a run's own row may date its pull request.
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');
      await transcriptRow('run-b', 4, '2026-08-09T18:45:00.000Z');

      const result = await service.backfillActivity();

      expect(result).toEqual({ threads: 2, pullRequests: 2 });
      expect(await pullRequestRows()).toEqual([
        {
          runId: 'run-a',
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 218,
          url: 'https://github.com/geniro-io/geniro-app/pull/218',
          occurredAt: '2026-08-05T12:00:00.000Z',
        },
        {
          runId: 'run-b',
          owner: 'geniro-io',
          repo: 'geniro-app',
          number: 7,
          url: 'https://github.com/geniro-io/geniro-app/pull/7',
          occurredAt: '2026-08-09T18:45:00.000Z',
        },
      ]);
    });

    it('dates a pull request whose transcript row is gone by its run, and its sibling by its own row', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [
        opened(218, 4),
        opened(219, 9),
      ]);
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');
      // Another row of the same run, so seq 9 is missing on its own and not
      // because the whole transcript is.
      await transcriptRow('run-a', 5, '2026-08-06T08:00:00.000Z');

      await service.backfillActivity();

      expect(
        (await pullRequestRows()).map((row) => [row.number, row.occurredAt]),
      ).toEqual([
        [218, '2026-08-05T12:00:00.000Z'],
        [219, '2026-08-01T09:00:00.000Z'],
      ]);
    });

    it('dates a pull request by the earlier of two transcript rows sharing its seq', async () => {
      // A transcript written before the seq allocator existed can hold two rows
      // on one seq; which of them dates the pull request must not depend on the
      // order the database returns them in. One run writes the later row first
      // and the other the earlier, so neither "first returned" nor "last
      // returned" can pass for "earliest".
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(218, 4)]);
      await transcriptRow('run-a', 4, '2026-08-05T12:00:03.000Z');
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');
      await startRun('run-b', '2026-08-02T09:00:00.000Z', [opened(7, 4)]);
      await transcriptRow('run-b', 4, '2026-08-09T18:45:00.000Z');
      await transcriptRow('run-b', 4, '2026-08-09T18:45:05.000Z');

      await service.backfillActivity();

      expect(
        (await pullRequestRows()).map((row) => [row.runId, row.occurredAt]),
      ).toEqual([
        ['run-a', '2026-08-05T12:00:00.000Z'],
        ['run-b', '2026-08-09T18:45:00.000Z'],
      ]);
    });

    it('dates a pull request by its tool result, not by another row that shares its seq', async () => {
      // The live capture dates a pull request by its tool result alone. A row of
      // another kind on the same seq, written earlier, must not date it in the backfill.
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(218, 4)]);
      await transcriptRow('run-a', 4, '2026-08-05T11:00:00.000Z', 'message');
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');

      await service.backfillActivity();

      expect((await pullRequestRows()).map((row) => row.occurredAt)).toEqual([
        '2026-08-05T12:00:00.000Z',
      ]);
    });

    it('is safe to run on every boot — a second sweep writes and logs nothing', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(218, 4)]);
      await startRun('run-b', '2026-08-02T09:00:00.000Z');
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');
      const log = vi
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => {});

      expect(await service.backfillActivity()).toEqual({
        threads: 2,
        pullRequests: 1,
      });
      const afterFirst = await ledger();
      expect(afterFirst).toHaveLength(3);
      expect(log.mock.calls.map((call) => String(call[0]))).toEqual([
        expect.stringContaining('2 thread(s) and 1 pull request(s)'),
      ]);
      log.mockClear();

      expect(await service.backfillActivity()).toEqual({
        threads: 0,
        pullRequests: 0,
      });

      expect(await ledger()).toEqual(afterFirst);
      expect(log).not.toHaveBeenCalled();
    });

    it('dates the pull requests of every run in one transcript read, not one read per run', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(1, 3)]);
      await startRun('run-b', '2026-08-02T09:00:00.000Z', [opened(2, 4)]);
      await startRun('run-c', '2026-08-03T09:00:00.000Z', [opened(3, 5)]);
      await transcriptRow('run-a', 3, '2026-08-05T10:00:00.000Z');
      await transcriptRow('run-b', 4, '2026-08-06T10:00:00.000Z');
      await transcriptRow('run-c', 5, '2026-08-07T10:00:00.000Z');
      const dating = vi.spyOn(itemDao, 'earliestToolResultTimesOf');
      const perRun = vi.spyOn(itemDao, 'earliestToolResultTimes');

      await service.backfillActivity();

      // Three runs opened a pull request each, and all three were dated by a single read.
      expect(dating).toHaveBeenCalledTimes(1);
      expect(dating.mock.calls[0]?.[0]).toHaveLength(3);
      expect(perRun).not.toHaveBeenCalled();
      expect(await pullRequestRows()).toEqual([
        expect.objectContaining({
          runId: 'run-a',
          occurredAt: '2026-08-05T10:00:00.000Z',
        }),
        expect.objectContaining({
          runId: 'run-b',
          occurredAt: '2026-08-06T10:00:00.000Z',
        }),
        expect.objectContaining({
          runId: 'run-c',
          occurredAt: '2026-08-07T10:00:00.000Z',
        }),
      ]);
    });

    it('still records a run whose stored pull requests cannot be read, and the runs after it', async () => {
      await runDao.create({
        id: 'run-a',
        agentKind: 'claude',
        createdAt: at('2026-08-01T09:00:00.000Z'),
        // A write cut short: not JSON, and nothing to take from it.
        pullRequests: '[{"owner":"geniro-io","repo":',
      });
      await startRun('run-b', '2026-08-02T09:00:00.000Z', [opened(218, 4)]);
      await transcriptRow('run-b', 4, '2026-08-05T12:00:00.000Z');

      const result = await service.backfillActivity();

      expect(result).toEqual({ threads: 2, pullRequests: 1 });
      expect(await threadRows()).toEqual([
        { runId: 'run-a', occurredAt: '2026-08-01T09:00:00.000Z' },
        { runId: 'run-b', occurredAt: '2026-08-02T09:00:00.000Z' },
      ]);
    });

    it('seeds the activity ledger at boot even when the turn sweep fails', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z', [opened(218, 4)]);
      await transcriptRow('run-a', 4, '2026-08-05T12:00:00.000Z');
      vi.spyOn(itemDao, 'allUsageRows').mockRejectedValue(
        new Error('database is locked'),
      );
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await service.onModuleInit();

      // The sweep runs behind the boot, so the ledger is seeded once it settles.
      await vi.waitFor(async () => {
        expect(await threadRows()).toEqual([
          { runId: 'run-a', occurredAt: '2026-08-01T09:00:00.000Z' },
        ]);
        expect((await pullRequestRows()).map((row) => row.occurredAt)).toEqual([
          '2026-08-05T12:00:00.000Z',
        ]);
      });
    });

    it('does not hold the boot on the activity sweep, which reads every run', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z');
      // A sweep that never settles, as one over a long history would be while the window waits.
      vi.spyOn(service, 'backfillActivity').mockReturnValue(
        new Promise<{ threads: number; pullRequests: number }>(() => {}),
      );

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('asks the ledger once what it holds, however many runs there are', async () => {
      // A sweep over an unchanged history writes nothing; what it must not do is ask a
      // question per run to learn that.
      async function statementsForASecondSweep(runs: number): Promise<number> {
        await orm.schema.clear();
        for (let index = 0; index < runs; index += 1) {
          // Ids of their own per call: the sweep's entity manager still knows the last call's.
          await startRun(`run-${runs}-${index}`, '2026-08-01T09:00:00.000Z');
        }
        await service.backfillActivity();
        const execute = vi.spyOn(orm.em.getConnection(), 'execute');
        const written = await service.backfillActivity();
        const count = execute.mock.calls.length;
        execute.mockRestore();
        expect(written).toEqual({ threads: 0, pullRequests: 0 });
        return count;
      }

      expect(await statementsForASecondSweep(12)).toBe(
        await statementsForASecondSweep(2),
      );
    });

    it('lets the daemon boot when the activity sweep itself fails, and says so', async () => {
      await startRun('run-a', '2026-08-01T09:00:00.000Z');
      vi.spyOn(activityDao, 'insertMissing').mockRejectedValue(
        new Error('disk is full'),
      );
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});

      await expect(service.onModuleInit()).resolves.toBeUndefined();

      // The failure is reported from behind the boot, not thrown into it.
      await vi.waitFor(() => {
        expect(warn.mock.calls.map((call) => String(call[0]))).toEqual([
          'activity backfill failed: disk is full',
        ]);
      });
    });
  });
});
