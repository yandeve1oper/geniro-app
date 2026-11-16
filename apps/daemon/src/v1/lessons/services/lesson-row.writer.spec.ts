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

import { ItemDao } from '../../agents/dao/item.dao';
import { RunDao } from '../../agents/dao/run.dao';
import type { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { ItemCallIndexService } from '../../agents/services/item-call-index.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { LessonRowWriter } from './lesson-row.writer';

function bus(published: unknown[]): AgentEventBus {
  return {
    publish: (event: unknown) => published.push(event),
    publishRunStatus: vi.fn(),
  } as unknown as AgentEventBus;
}

function calls(): ItemCallIndexService {
  return {
    inCallOf: vi.fn(() => Promise.resolve(null)),
  } as unknown as ItemCallIndexService;
}

function seqs(seq: number): ItemSeqAllocator {
  return {
    reserve: vi.fn(() => Promise.resolve(seq)),
    settle: vi.fn(),
  } as unknown as ItemSeqAllocator;
}

describe('LessonRowWriter (in-memory sqlite)', () => {
  let orm: MikroORM;
  let runDao: RunDao;
  let itemDao: ItemDao;
  let published: unknown[];
  let writer: LessonRowWriter;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
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

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    runDao = new RunDao(em);
    itemDao = new ItemDao(em);
    published = [];
    writer = new LessonRowWriter(
      em,
      runDao,
      itemDao,
      bus(published),
      calls(),
      seqs(42),
    );
  });

  it('writes the row into an existing thread at the seq it reserved, archived threads included', async () => {
    await runDao.create({ id: 'live', archivedAt: null });
    await runDao.create({ id: 'archived', archivedAt: new Date(1_000) });

    await writer.write('live', {
      kind: 'lessons',
      payload: {
        reflectionRunId: 'refl',
        segmentId: 'seg',
        fromSeq: -1,
        toSeq: 4,
        agentKind: 'claude',
        model: 'opus',
        proposals: [],
        places: { project: false, team: false },
      },
    });
    await writer.write('archived', {
      kind: 'lesson_outcome',
      payload: {
        proposalId: 'lp-1',
        status: 'rejected',
        title: 'Rule',
        rule: 'Rule in full.',
        target: { kind: 'memory', scope: 'global', type: 'feedback' },
        memoryHandle: null,
        reason: 'Too narrow.',
      },
    });

    const live = await itemDao.getByRun('live');
    const archived = await itemDao.getByRun('archived');
    expect(live).toMatchObject([
      {
        runId: 'live',
        seq: 42,
        kind: 'lessons',
        memberId: null,
        role: null,
      },
    ]);
    expect(JSON.parse(live[0]!.payload)).toMatchObject({
      segmentId: 'seg',
      proposals: [],
    });
    expect(archived).toMatchObject([
      { runId: 'archived', seq: 42, kind: 'lesson_outcome' },
    ]);
    expect(published).toHaveLength(2);
  });

  it('writes nothing for a thread that is gone, and reserves no seq for it', async () => {
    const reserve = vi.fn(() => Promise.resolve(42));
    const gone = new LessonRowWriter(
      orm.em.fork(),
      runDao,
      itemDao,
      bus(published),
      calls(),
      { reserve, settle: vi.fn() } as unknown as ItemSeqAllocator,
    );

    await gone.write('missing', {
      kind: 'lessons',
      payload: {
        reflectionRunId: 'refl',
        segmentId: 'seg',
        fromSeq: -1,
        toSeq: 4,
        agentKind: 'claude',
        model: 'opus',
        proposals: [],
        places: { project: false, team: false },
      },
    });

    expect(reserve).not.toHaveBeenCalled();
    expect(await itemDao.getByRun('missing')).toEqual([]);
    expect(published).toEqual([]);
  });
});
