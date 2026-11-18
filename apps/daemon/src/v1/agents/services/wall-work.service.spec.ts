import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  defineConfig,
  EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { Logger } from '@nestjs/common';
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
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import type { ItemKind } from '../../runs/runs.types';
import { tempDir } from '../__tests__/temp-dir';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { WALL_WORK_VERSION, WallWorkService } from './wall-work.service';

describe('WallWorkService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let nodes: NodeStateDao;
  let runs: RunDao;
  let turns: WallTurnDao;
  let marker: string;
  let ledger: WallWorkService;
  let nextSeq = 0;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState, WallTurn],
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
    vi.restoreAllMocks();
    const em = orm.em.fork() as EntityManager;
    items = new ItemDao(em);
    nodes = new NodeStateDao(em);
    runs = new RunDao(em);
    turns = new WallTurnDao(em);
    marker = join(tempDir('wall-work-'), 'marker');
    ledger = new WallWorkService(items, nodes, runs, turns, em, marker);
    nextSeq = 0;
  });

  interface Where {
    runId?: string;
    memberId?: string | null;
    role?: string | null;
    seq?: number;
  }

  async function write(
    kind: ItemKind,
    at: number,
    payload: Record<string, unknown> = {},
    { runId = 'run-1', memberId = 'eng', role = null, seq }: Where = {},
  ): Promise<number> {
    const rowSeq = seq ?? (nextSeq += 1);
    await items.create({
      runId,
      seq: rowSeq,
      kind,
      memberId,
      role,
      payload: JSON.stringify(payload),
      createdAt: new Date(at),
    });
    return rowSeq;
  }

  /** One member turn: running at `from`, settled at `to`, CLI-timed if `durationMs`. */
  async function turn(
    from: number,
    to: number,
    {
      runId = 'run-1',
      memberId = 'eng',
      durationMs,
      seqs,
    }: {
      runId?: string;
      memberId?: string;
      durationMs?: number;
      /** Explicit seqs for the three rows, to write them out of seq order. */
      seqs?: [number, number, number];
    } = {},
  ): Promise<number> {
    await write(
      'status',
      from,
      { status: 'running' },
      { runId, memberId, seq: seqs?.[0] },
    );
    const end = await write(
      'turn_complete',
      to,
      { usage: durationMs === undefined ? null : { durationMs } },
      { runId, memberId, seq: seqs?.[1] },
    );
    await write(
      'status',
      to,
      { status: 'completed' },
      { runId, memberId, seq: seqs?.[2] },
    );
    return end;
  }

  /** One chat turn: the user's message at `from`, settled at `to`. */
  async function chatTurn(
    from: number,
    to: number,
    {
      runId = 'run-1',
      durationMs,
    }: { runId?: string; durationMs?: number } = {},
  ): Promise<number> {
    await write(
      'message',
      from,
      { text: 'go' },
      {
        runId,
        memberId: null,
        role: 'user',
      },
    );
    return write(
      'turn_complete',
      to,
      { usage: durationMs === undefined ? null : { durationMs } },
      { runId, memberId: null },
    );
  }

  /** Every recorded wall turn, as `[runId, seq, nodeId, ms]`. */
  async function recorded(): Promise<
    [string, number, string | null, number][]
  > {
    const rows = await orm.em
      .fork()
      .find(WallTurn, {}, { orderBy: { runId: 'asc', seq: 'asc' } });
    return rows.map((row) => [row.runId, row.seq, row.memberId, row.ms]);
  }

  describe('catchUpNode', () => {
    it('records a turn its CLI did not time once, and a second catch-up records nothing', async () => {
      await nodes.createPending('run-1', 'eng');
      const end = await turn(1_000, 9_000);

      await ledger.catchUpNode('run-1', 'eng');
      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([['run-1', end, 'eng', 8_000]]);
      expect((await turns.nodeSums('run-1')).get('eng')).toBe(8_000);
    });

    it('a later turn adds only itself', async () => {
      const first = await turn(1_000, 9_000);
      await ledger.catchUpNode('run-1', 'eng');
      const second = await turn(20_000, 23_000);

      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([
        ['run-1', first, 'eng', 8_000],
        ['run-1', second, 'eng', 3_000],
      ]);
    });

    it('records a turn whose rows became durable AFTER a later-seq turn was measured', async () => {
      // Two writers reserve seqs from one allocator, so a turn can land below
      // one already measured. A high-water mark had moved past it for good.
      const later = await turn(10_000, 12_000, { seqs: [10, 11, 12] });
      await ledger.catchUpNode('run-1', 'eng');
      const earlier = await turn(0, 5_000, {
        memberId: 'eng',
        seqs: [5, 6, 7],
      });

      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([
        ['run-1', earlier, 'eng', 5_000],
        ['run-1', later, 'eng', 2_000],
      ]);
    });

    it('concurrent catch-ups record each turn once', async () => {
      await turn(0, 5_000);
      await turn(10_000, 17_000);

      await Promise.all([
        ledger.catchUpNode('run-1', 'eng', orm.em.fork()),
        ledger.catchUpNode('run-1', 'eng', orm.em.fork()),
        ledger.catchUpNode('run-1', 'eng', orm.em.fork()),
      ]);

      expect((await turns.nodeSums('run-1')).get('eng')).toBe(12_000);
      expect(await recorded()).toHaveLength(2);
    });

    it('records nothing for a turn its CLI timed, so a claude member keeps its own figure', async () => {
      await nodes.createPending('run-1', 'eng');
      await turn(0, 15_000, { durationMs: 5_000 });
      await nodes.rememberWork('run-1', 'eng', 5_000, 1);

      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([]);
      expect(
        (await new NodeStateDao(orm.em.fork()).getByRunNode('run-1', 'eng'))
          ?.workedMs,
      ).toBe(5_000);
    });

    it("never records another member's turns", async () => {
      await turn(0, 30_000, { memberId: 'qa' });

      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([]);
    });

    it('subtracts a parked card read through its projection', async () => {
      // The card carries a long plan; the DAO projects it to `id`/`callId`,
      // and the verdict (no `callId`) still closes it on the call's clock.
      await write('status', 0, { status: 'running', callId: 'call-1' });
      await write('approval_request', 2_000, {
        id: 'card-1',
        callId: 'call-1',
        input: { plan: 'x'.repeat(5_000) },
      });
      await write('approval_verdict', 6_000, { id: 'card-1', allow: true });
      await write('turn_complete', 10_000, { usage: null, callId: 'call-1' });

      await ledger.catchUpNode('run-1', 'eng');

      expect((await turns.nodeSums('run-1')).get('eng')).toBe(6_000);
    });

    it('writes no row for a turn that measured nothing', async () => {
      await turn(4_000, 4_000);

      await ledger.catchUpNode('run-1', 'eng');

      expect(await recorded()).toEqual([]);
    });

    it('a catch-up whose write fails leaves nothing behind, and the next one records it once', async () => {
      const end = await turn(0, 9_000);
      vi.spyOn(turns, 'record').mockRejectedValueOnce(new Error('SQLITE_BUSY'));

      await expect(ledger.catchUpNode('run-1', 'eng')).rejects.toThrow(
        'SQLITE_BUSY',
      );
      expect(await recorded()).toEqual([]);

      await ledger.catchUpNode('run-1', 'eng');
      expect(await recorded()).toEqual([['run-1', end, 'eng', 9_000]]);
    });
  });

  describe('catchUpChat', () => {
    it("records a chat turn from the user's message to its settle, once", async () => {
      const end = await chatTurn(1_000, 7_000);

      await ledger.catchUpChat('run-1');
      await ledger.catchUpChat('run-1');

      expect(await recorded()).toEqual([['run-1', end, null, 6_000]]);
      expect((await turns.chatSums(['run-1'])).get('run-1')).toBe(6_000);
    });

    it('records nothing for a chat turn its CLI timed', async () => {
      await chatTurn(0, 9_000, { durationMs: 4_000 });

      await ledger.catchUpChat('run-1');

      expect(await recorded()).toEqual([]);
    });
  });

  describe('sweepAllQuietly', () => {
    it("fills older team and chat runs, every member's turns, and retires itself", async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await runs.create({ id: 'chat-1' });
      await nodes.createPending('run-1', 'eng');
      await nodes.createPending('run-1', 'qa');
      await turn(0, 9_000);
      await turn(0, 4_000, { memberId: 'qa' });
      await chatTurn(0, 3_000, { runId: 'chat-1' });

      await ledger.sweepAllQuietly();

      const sums = await turns.nodeSums('run-1');
      expect(sums.get('eng')).toBe(9_000);
      expect(sums.get('qa')).toBe(4_000);
      expect((await turns.chatSums(['chat-1'])).get('chat-1')).toBe(3_000);
      expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
        String(WALL_WORK_VERSION),
      );
    });

    it('records each turn once beside a live catch-up running at the same time', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      await turn(10_000, 12_000);

      await Promise.all([
        ledger.sweepAllQuietly(),
        ledger.catchUpNode('run-1', 'eng', orm.em.fork()),
      ]);

      expect((await turns.nodeSums('run-1')).get('eng')).toBe(11_000);
      expect(await recorded()).toHaveLength(2);
      // Neither writer met a conflict it could not absorb: the sweep finished.
      expect(existsSync(marker)).toBe(true);
    });

    it('stays retired once the marker names the current version', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      writeFileSync(marker, `${WALL_WORK_VERSION}\n`);

      await ledger.sweepAllQuietly();

      expect(await recorded()).toEqual([]);
    });

    it('skips a run that fails, fills the rest, and is not retired', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await runs.create({ id: 'run-2', teamId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await nodes.createPending('run-2', 'eng');
      await turn(0, 9_000);
      await turn(0, 3_000, { runId: 'run-2' });
      const listByRun = nodes.listByRun.bind(nodes);
      vi.spyOn(nodes, 'listByRun').mockImplementation((runId, em) =>
        runId === 'run-1'
          ? Promise.reject(new Error('locked'))
          : listByRun(runId, em),
      );
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(ledger.sweepAllQuietly()).resolves.toBeUndefined();

      expect((await turns.nodeSums('run-2')).get('eng')).toBe(3_000);
      expect((await turns.nodeSums('run-1')).size).toBe(0);
      expect(existsSync(marker)).toBe(false);
    });

    it('resolves when the runs cannot be listed, and is not retired', async () => {
      vi.spyOn(runs, 'listTeamRuns').mockRejectedValue(new Error('locked'));
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});

      await expect(ledger.sweepAllQuietly()).resolves.toBeUndefined();
      expect(existsSync(marker)).toBe(false);
    });

    it('still fills the runs when the marker cannot be written', async () => {
      await runs.create({ id: 'run-1', teamId: 'dev-team' });
      await nodes.createPending('run-1', 'eng');
      await turn(0, 9_000);
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const unwritable = new WallWorkService(
        items,
        nodes,
        runs,
        turns,
        orm.em.fork() as EntityManager,
        join(marker, 'no-such-dir', 'marker'),
      );

      await expect(unwritable.sweepAllQuietly()).resolves.toBeUndefined();

      expect((await turns.nodeSums('run-1')).get('eng')).toBe(9_000);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not record the wall-work sweep'),
      );
    });
  });
});
