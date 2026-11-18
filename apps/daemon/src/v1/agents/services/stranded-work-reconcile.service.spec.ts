import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import type { ActionOutcomeSweep } from './action-outcome-sweep.service';
import type { ChatService } from './chat.service';
import type { MonitorOutcomeSweep } from './monitor-outcome-sweep.service';
import { StrandedWorkReconcileService } from './stranded-work-reconcile.service';

type Mark = {
  runId: string;
  newestSeq: number;
  reconciledThroughSeq: number | null;
};

function harness(
  before: Mark[],
  after: Mark[],
  unsettled: {
    delegates?: string[];
    shells?: string[];
    actions?: string[];
    monitors?: string[];
  } = {},
) {
  const em = {
    fork: () => em,
    transactional: async (work: (tx: unknown) => Promise<void>) => work(em),
  } as unknown as EntityManager;
  const reconcileMarks = vi
    .fn<(tx?: unknown) => Promise<Mark[]>>()
    .mockResolvedValueOnce(before)
    .mockResolvedValueOnce(after);
  const markReconciledThrough = vi.fn(
    async (_runId: string, _seq: number, _tx?: unknown) => undefined,
  );
  const reconcileStrandedDelegates = vi.fn(
    async (_: readonly string[]) => unsettled.delegates ?? [],
  );
  const reconcileStrandedShells = vi.fn(
    async (_: readonly string[]) => unsettled.shells ?? [],
  );
  const actionSweep = vi.fn(
    async (_: readonly string[]) => unsettled.actions ?? [],
  );
  const monitorSweep = vi.fn(
    async (_cause: string, _: readonly string[]) => unsettled.monitors ?? [],
  );
  const service = new StrandedWorkReconcileService(
    em,
    { reconcileMarks, markReconciledThrough } as unknown as RunDao,
    {
      reconcileStrandedDelegates,
      reconcileStrandedShells,
    } as unknown as ChatService,
    { sweep: actionSweep } as unknown as ActionOutcomeSweep,
    { sweep: monitorSweep } as unknown as MonitorOutcomeSweep,
  );
  return {
    service,
    reconcileMarks,
    markReconciledThrough,
    reconcileStrandedDelegates,
    reconcileStrandedShells,
    actionSweep,
    monitorSweep,
  };
}

describe('StrandedWorkReconcileService', () => {
  it('hands every reconcile only the runs written to since their mark, or never marked', async () => {
    const h = harness(
      [
        { runId: 'quiet', newestSeq: 9, reconciledThroughSeq: 9 },
        { runId: 'written', newestSeq: 12, reconciledThroughSeq: 9 },
        { runId: 'new', newestSeq: 3, reconciledThroughSeq: null },
        { runId: 'empty', newestSeq: -1, reconciledThroughSeq: -1 },
        { runId: 'shrunk', newestSeq: 5, reconciledThroughSeq: 8 },
      ],
      [],
    );

    await h.service.reconcile('quit');

    const due = ['written', 'new', 'shrunk'];
    expect(h.reconcileStrandedDelegates).toHaveBeenCalledWith(due);
    expect(h.reconcileStrandedShells).toHaveBeenCalledWith(due);
    expect(h.actionSweep).toHaveBeenCalledWith(due);
    expect(h.monitorSweep).toHaveBeenCalledWith('quit', due);
    const order = [
      h.reconcileStrandedDelegates,
      h.reconcileStrandedShells,
      h.actionSweep,
      h.monitorSweep,
    ].map((spy) => spy.mock.invocationCallOrder[0]!);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('marks each run it read through its newest seq after the reconciles, except one any of them left open', async () => {
    const h = harness(
      [
        { runId: 'a', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'b', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'c', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'd', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'e', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 },
      ],
      [
        { runId: 'a', newestSeq: 6, reconciledThroughSeq: null },
        { runId: 'b', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'c', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'd', newestSeq: 4, reconciledThroughSeq: null },
        { runId: 'e', newestSeq: 5, reconciledThroughSeq: null },
        { runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 },
      ],
      {
        delegates: ['b'],
        shells: ['c'],
        actions: ['d'],
        monitors: [],
      },
    );

    await h.service.reconcile('quit');

    expect(
      h.markReconciledThrough.mock.calls.map(([id, seq]) => [id, seq]),
    ).toEqual([
      ['a', 6],
      ['e', 5],
    ]);
  });

  it('leaves a chat whose monitor end waits on a delivery unmarked', async () => {
    const h = harness(
      [{ runId: 'chat', newestSeq: 4, reconciledThroughSeq: 1 }],
      [{ runId: 'chat', newestSeq: 4, reconciledThroughSeq: 1 }],
      { monitors: ['chat'] },
    );

    await h.service.reconcile('quit');

    expect(h.markReconciledThrough).not.toHaveBeenCalled();
  });

  it('runs no reconcile when no run changed', async () => {
    const h = harness(
      [{ runId: 'quiet', newestSeq: 2, reconciledThroughSeq: 2 }],
      [],
    );

    await h.service.reconcile('quit');

    expect(h.reconcileStrandedDelegates).not.toHaveBeenCalled();
    expect(h.monitorSweep).not.toHaveBeenCalled();
    expect(h.markReconciledThrough).not.toHaveBeenCalled();
  });

  it('runs no reconcile and still lets the boot go on when the runs cannot be listed', async () => {
    const h = harness([], []);
    h.reconcileMarks.mockReset();
    h.reconcileMarks.mockRejectedValueOnce(new Error('disk I/O error'));

    await expect(h.service.reconcile('quit')).resolves.toBeUndefined();

    expect(h.reconcileStrandedDelegates).not.toHaveBeenCalled();
    expect(h.markReconciledThrough).not.toHaveBeenCalled();
  });

  it('still lets the boot go on when the marks cannot be recorded', async () => {
    const h = harness(
      [{ runId: 'a', newestSeq: 4, reconciledThroughSeq: null }],
      [{ runId: 'a', newestSeq: 4, reconciledThroughSeq: null }],
    );
    h.markReconciledThrough.mockRejectedValueOnce(new Error('disk I/O error'));

    await expect(h.service.reconcile('quit')).resolves.toBeUndefined();

    expect(h.markReconciledThrough).toHaveBeenCalledTimes(1);
  });
});

describe('StrandedWorkReconcileService over the real tables (in-memory sqlite)', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item, NodeState],
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

  it('reads a closed run again only once a row lands in it', async () => {
    const runs = new RunDao(orm.em.fork());
    const items = new ItemDao(orm.em.fork());
    await runs.create({ id: 'r1' });
    await items.create({
      runId: 'r1',
      seq: 0,
      kind: 'subagent_info',
      payload: JSON.stringify({ id: 'T1', backgroundOpen: true }),
    });
    // Closes what it is handed by writing one row after the newest, as the
    // real reconcile writes its close rows.
    const reconcileStrandedDelegates = vi.fn(
      async (runIds: readonly string[]) => {
        for (const runId of runIds) {
          await items.create({
            runId,
            seq: (await items.maxSeq(runId, orm.em.fork())) + 1,
            kind: 'subagent_info',
            payload: JSON.stringify({
              id: 'T1',
              backgroundOutcome: 'untracked',
            }),
          });
        }
        return [];
      },
    );
    const service = new StrandedWorkReconcileService(
      orm.em,
      runs,
      {
        reconcileStrandedDelegates,
        reconcileStrandedShells: async () => [],
      } as unknown as ChatService,
      { sweep: async () => [] } as unknown as ActionOutcomeSweep,
      { sweep: async () => [] } as unknown as MonitorOutcomeSweep,
    );

    await service.reconcile('quit');
    expect(
      (await new RunDao(orm.em.fork()).getById('r1'))!.reconciledThroughSeq,
    ).toBe(1);

    await service.reconcile('quit');
    expect(reconcileStrandedDelegates).toHaveBeenCalledTimes(1);

    await items.create({ runId: 'r1', seq: 2, kind: 'message', payload: '{}' });
    await service.reconcile('quit');
    expect(reconcileStrandedDelegates).toHaveBeenLastCalledWith(['r1']);
    expect(
      (await new RunDao(orm.em.fork()).getById('r1'))!.reconciledThroughSeq,
    ).toBe(3);
  });
});
