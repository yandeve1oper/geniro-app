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

import type { CallTokenRegistry } from '../../../auth/call-token.registry';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { freshVocabularyStore } from '../../agents/adapters/__tests__/fresh-vocabulary-store';
import { CursorAcpAdapter } from '../../agents/adapters/cursor-acp/cursor-acp.adapter';
import { CallContextDao } from '../../agents/dao/call-context.dao';
import { GoalDao } from '../../agents/dao/goal.dao';
import { ItemDao } from '../../agents/dao/item.dao';
import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { WallTurnDao } from '../../agents/dao/wall-turn.dao';
import { ActionCommandRegistry } from '../../agents/services/action-command.registry';
import { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import { AgentEventBus } from '../../agents/services/agent-events.bus';
import type { AgentSessionRegistry } from '../../agents/services/agent-session.registry';
import type { ArtifactStoreService } from '../../agents/services/artifact-store.service';
import type { AttachmentStoreService } from '../../agents/services/attachment-store.service';
import type { ChatUploadStoreService } from '../../agents/services/chat-upload-store.service';
import type { ItemSeqAllocator } from '../../agents/services/item-seq.allocator';
import type { PartialStreamService } from '../../agents/services/partial-stream.service';
import type { ProcessRegistry } from '../../agents/services/process-registry';
import type { RunProcessReaper } from '../../agents/services/run-process-reaper.service';
import { RunTeardownService } from '../../agents/services/run-teardown.service';
import { SessionTranscriptsService } from '../../agents/services/session-transcripts.service';
import type { ThreadInboxService } from '../../agents/services/thread-inbox.service';
import { ProjectRootsService } from '../../projects/services/project-roots.service';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { LineBaselineDao } from '../dao/line-baseline.dao';
import { MetricLedgerDao } from '../dao/metric-ledger.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { ToolCallEvent } from '../entity/tool-call-event.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import { StatsService } from './stats.service';
import { UsageEventBus } from './usage-events.bus';
import { UsageRecorderService } from './usage-recorder.service';

/**
 * The one behaviour the whole usage ledger exists for: deleting a chat must NOT
 * take its spend with it.
 *
 * Driven against the REAL `RunTeardownService` — the service that would break
 * it — rather than asserting the stats module's own intent back to itself. It
 * lives here, in the stats module, because this module is what silently loses
 * meaning if the teardown ever starts clearing `usage_events`: the page would
 * go on rendering, with lifetime totals that quietly shrink every time someone
 * tidies up a conversation.
 */
describe('usage ledger retention across a run delete', () => {
  let orm: MikroORM;
  let teardown: RunTeardownService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let callContextDao: CallContextDao;
  let usageDao: UsageEventDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [
          Run,
          Item,
          NodeState,
          CallContext,
          WallTurn,
          UsageActivity,
          UsageEvent,
          ToolCallEvent,
          Goal,
        ],
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
    callContextDao = new CallContextDao(em);
    usageDao = new UsageEventDao(em);
    teardown = new RunTeardownService(
      itemDao,
      nodeStateDao,
      callContextDao,
      runDao,
      new AgentEventBus(),
      // The in-memory planes a delete also clears. Stubbed because none of them
      // touches the database, and what this spec is about is which TABLES the
      // purge reaches.
      { cancel: () => false } as unknown as ProcessRegistry,
      {
        close: () => undefined,
        closeRun: () => undefined,
      } as unknown as AgentSessionRegistry,
      { revokeRun: () => undefined } as unknown as CallTokenRegistry,
      { forgetRun: () => undefined } as unknown as PartialStreamService,
      { removeRun: () => undefined } as unknown as AttachmentStoreService,
      { removeRun: () => undefined } as unknown as ArtifactStoreService,
      { forget: () => undefined } as unknown as ItemSeqAllocator,
      // Archived runs' CLI transcripts are `run-teardown.service.spec.ts`'s
      // subject; this spec's runs keep theirs.
      {
        collect: () => Promise.resolve([]),
        remove: () => Promise.resolve(),
      } as unknown as SessionTranscriptsService,
      {
        removeReferenced: () => Promise.resolve(0),
      } as unknown as ChatUploadStoreService,
      // Never real: a real one would read and signal this machine's process
      // table from a unit test.
      { reapInBackground: () => undefined } as unknown as RunProcessReaper,
      new WallTurnDao(em),
      new ActionCommandRegistry(),
      { cancelFor: async () => undefined } as unknown as ThreadInboxService,
    );
  });

  it('destroys the run’s transcript but leaves its recorded spend standing', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude', cwd: '/work' });
    await itemDao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'turn_complete',
      payload: JSON.stringify({ usage: { costUsd: 2.5 } }),
    });
    await nodeStateDao.create({ runId: 'run-a', memberId: 'main' });
    await usageDao.recordOnce({
      runId: 'run-a',
      memberId: null,
      seq: 0,
      occurredAt: new Date(2026, 7, 10, 9),
      agentKind: 'claude',
      model: 'claude-opus-5',
      cwd: '/work',
      teamName: null,
      costUsd: 2.5,
      estimatedCostUsd: null,
      inputTokens: 900,
      outputTokens: 120,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    // Everything the teardown owns is gone…
    expect(await runDao.getAll({})).toHaveLength(0);
    expect(await itemDao.getAll({})).toHaveLength(0);
    expect(await nodeStateDao.getAll({})).toHaveLength(0);
    // …and the money is still on the books. A `usage_events` line added to
    // `RunTeardownService.purge` — or an FK that made the rows cascade — fails
    // exactly here.
    const ledger = await usageDao.getAll({});
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      runId: 'run-a',
      costUsd: 2.5,
      agentKind: 'claude',
      cwd: '/work',
    });
  });

  it('keeps a deleted cursor run’s POLLED spend in Stats', async () => {
    // cursor-agent prices nothing on its own wire; its bill is the account
    // poll's running total on `Run.polledCostCents`, and Stats read it off the
    // run row — so deleting a cursor chat took its whole bill out of every
    // lifetime figure, the one loss this ledger exists to prevent. Driven the
    // way production reaches it: the poll's own `spendUpdatedAt` announce, the
    // real recorder, the real teardown, the real page.
    const bus = new AgentEventBus();
    const em = orm.em.fork();
    new UsageRecorderService(
      em,
      bus,
      runDao,
      nodeStateDao,
      usageDao,
      new UsageEventBus(),
    ).onModuleInit();
    const when = new Date(2026, 7, 10, 9);
    await runDao.create({
      id: 'run-cursor',
      agentKind: 'cursor-agent',
      cwd: '/work',
      polledCostCents: 250,
      updatedAt: when,
    });
    // The turn itself, as cursor reports it: tokens maybe, a price never.
    await usageDao.recordOnce({
      runId: 'run-cursor',
      memberId: null,
      seq: 0,
      occurredAt: when,
      agentKind: 'cursor-agent',
      model: null,
      cwd: '/work',
      teamName: null,
      costUsd: null,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });

    bus.publishRunStatus({
      runId: 'run-cursor',
      status: null,
      spendUpdatedAt: when.getTime(),
    });
    await vi.waitFor(async () =>
      expect(
        (await usageDao.getAll({ runId: 'run-cursor' })).length,
      ).toBeGreaterThan(1),
    );
    await teardown.purge(orm.em.fork(), 'run-cursor', undefined);

    const stats = await new StatsService(
      orm.em.fork(),
      usageDao,
      // Which CLIs' money is polled is each adapter's own declaration.
      new AgentAdapterRegistry([
        new CursorAcpAdapter({ vocabularyStore: freshVocabularyStore() }),
      ]),
      new ProjectRootsService(orm.em.fork()),
      new RunDao(orm.em.fork()),
      new UsageActivityDao(orm.em.fork()),
      new UsageEventBus(),
      new LineBaselineDao(orm.em.fork()),
      new MetricLedgerDao(orm.em.fork()),
      new GoalDao(orm.em.fork()),
    ).usage(
      new Date(2026, 7, 10).toISOString(),
      new Date(2026, 7, 11).toISOString(),
    );
    expect(stats.totals.costUsd).toBe(2.5);
    // Still ONE turn, now priced — the polled row is money, not a second turn.
    expect(stats.totals.turns).toBe(1);
    expect(stats.totals.costedTurns).toBe(1);
  });

  it('keeps the deleted run’s spend inside the reported period', async () => {
    await runDao.create({ id: 'run-a', agentKind: 'claude' });
    await usageDao.recordOnce({
      runId: 'run-a',
      memberId: null,
      seq: 0,
      occurredAt: new Date(2026, 7, 10, 9),
      agentKind: 'claude',
      model: null,
      cwd: null,
      teamName: null,
      costUsd: 2.5,
      estimatedCostUsd: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    // The range query is what the page actually calls, so the retention has to
    // hold THERE and not merely in the table — a lifetime total that dropped
    // $2.50 the moment a chat was tidied away is the failure being prevented.
    const rows = await usageDao.inRange(
      new Date(2026, 7, 10),
      new Date(2026, 7, 11),
    );
    expect(rows.map((row) => row.costUsd)).toEqual([2.5]);
  });
});
