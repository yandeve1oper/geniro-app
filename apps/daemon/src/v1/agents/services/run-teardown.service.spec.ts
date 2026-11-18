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
  onTestFinished,
  vi,
} from 'vitest';

import { CallTokenRegistry } from '../../../auth/call-token.registry';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { BrowserBridgeService } from '../../browser/services/browser-bridge.service';
import { BrowserHostApprovals } from '../../browser/services/browser-host-approvals.service';
import { MemoryMarkDao } from '../../memory/dao/memory-mark.dao';
import { MemoryReviewFindingDao } from '../../memory/dao/memory-review-finding.dao';
import { MemoryUsageDao } from '../../memory/dao/memory-usage.dao';
import { MemoryMark } from '../../memory/entity/memory-mark.entity';
import { MemoryReviewFinding } from '../../memory/entity/memory-review-finding.entity';
import { MemoryUsageBackfill } from '../../memory/entity/memory-usage-backfill.entity';
import { MemoryUsageDay } from '../../memory/entity/memory-usage-day.entity';
import { pairKey } from '../../memory/utils/memory-pairs';
import { CallContext } from '../../runs/entity/call-context.entity';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import { AgentKind } from '../../runs/runs.types';
import { ArtifactShareDao } from '../../shares/dao/artifact-share.dao';
import { ArtifactShare } from '../../shares/entity/artifact-share.entity';
import { MetricLedgerDao } from '../../stats/dao/metric-ledger.dao';
import { ToolCallEvent } from '../../stats/entity/tool-call-event.entity';
import { UsageActivity } from '../../stats/entity/usage-activity.entity';
import type {
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
} from '../adapters/adapter.types';
import { CallContextDao } from '../dao/call-context.dao';
import { GoalDao } from '../dao/goal.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import { ActionCommandRegistry } from './action-command.registry';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import { AgentSessionRegistry } from './agent-session.registry';
import { ArtifactStoreService } from './artifact-store.service';
import { AttachmentStoreService } from './attachment-store.service';
import type { ChatUploadStoreService } from './chat-upload-store.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { MonitorRegistry } from './monitor.registry';
import { PartialStreamService } from './partial-stream.service';
import { ProcessRegistry } from './process-registry';
import type { RunProcessReaper } from './run-process-reaper.service';
import { RunTeardownService } from './run-teardown.service';
import { SessionTranscriptsService } from './session-transcripts.service';
import { ThreadInboxService } from './thread-inbox.service';

/**
 * The teardown's own spec, over REAL DAOs on a real in-memory schema.
 *
 * It exists because every table a run owns is enumerated by hand here — nothing
 * cascades — so the only thing standing between a new table and rows that
 * outlive their run is a line in `purge`. A table's rows are exactly what a
 * fake DAO cannot pin: the spies elsewhere assert that a call was MADE, and
 * this asserts that the rows are GONE.
 */
describe('RunTeardownService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let teardown: RunTeardownService;
  let itemDao: ItemDao;
  let runDao: RunDao;
  let nodeStateDao: NodeStateDao;
  let callContextDao: CallContextDao;
  let wallTurnDao: WallTurnDao;
  let referencedTexts: string[][] = [];
  let removedArtifactRuns: string[];
  /** The run's CLIs closing and its detached processes being reaped, in order. */
  let processEnds: string[];
  let inboxCancels: { runId: string; why: string; runStillThere: boolean }[];
  let commands: ActionCommandRegistry;
  let monitors: MonitorRegistry;
  let browserBridge: BrowserBridgeService;
  let browserApprovals: BrowserHostApprovals;
  /** Every CLI transcript the teardown asked an adapter to delete. */
  let deletedTranscripts: (DeleteSessionTranscriptInput & { agent: string })[];
  /**
   * Every statement the ORM ran while {@link recording} was set — how the
   * transcript purge is observed NOT reading the rows it destroys, which no
   * table assertion can see (the rows are gone either way).
   */
  const statements: string[] = [];
  let recording = false;

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
          ArtifactShare,
          Goal,
          ToolCallEvent,
          UsageActivity,
          MemoryMark,
          MemoryUsageDay,
          MemoryUsageBackfill,
          MemoryReviewFinding,
        ],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
        debug: ['query'],
        logger: (message) => {
          if (recording) {
            statements.push(message);
          }
        },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    removedArtifactRuns = [];
    processEnds = [];
    inboxCancels = [];
    commands = new ActionCommandRegistry();
    monitors = new MonitorRegistry(new ProcessRegistry());
    browserBridge = new BrowserBridgeService();
    browserBridge.attachEmitter(() => undefined);
    browserBridge.register('socket-1');
    browserApprovals = new BrowserHostApprovals();
    referencedTexts = [];
    deletedTranscripts = [];
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    runDao = new RunDao(em);
    nodeStateDao = new NodeStateDao(em);
    callContextDao = new CallContextDao(em);
    wallTurnDao = new WallTurnDao(em);
    const threadInbox = {
      cancelFor: async (runId: string, why: string) => {
        inboxCancels.push({
          runId,
          why,
          runStillThere: (await runDao.getById(runId, orm.em.fork())) !== null,
        });
      },
    } as unknown as ThreadInboxService;
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
        closeRun: (runId: string) => processEnds.push(`closeRun ${runId}`),
      } as unknown as AgentSessionRegistry,
      { revokeRun: () => undefined } as unknown as CallTokenRegistry,
      { forgetRun: () => undefined } as unknown as PartialStreamService,
      { removeRun: () => undefined } as unknown as AttachmentStoreService,
      // Recording, unlike the attachment store beside it: the artifact store is
      // a file store nothing else in this spec would notice being skipped, so
      // this is the only thing standing between a purge and a run's pages
      // outliving it on disk.
      {
        removeRun: (runId: string) => removedArtifactRuns.push(runId),
      } as unknown as ArtifactStoreService,
      { forget: () => undefined } as unknown as ItemSeqAllocator,
      // The REAL collector over the real node-state rows, so which sessions a
      // purge reaches is read from the table it is read from in production;
      // only the per-CLI delete is a recording double.
      new SessionTranscriptsService(nodeStateDao, {
        for: (agent: string) => ({
          deleteSessionTranscript: (
            input: DeleteSessionTranscriptInput,
          ): Promise<DeleteSessionTranscriptResult> => {
            deletedTranscripts.push({ ...input, agent });
            return Promise.resolve({ deleted: true });
          },
        }),
      } as unknown as AgentAdapterRegistry),
      {
        removeReferenced: (texts: readonly string[]) => {
          referencedTexts.push([...texts]);
          return Promise.resolve(0);
        },
      } as unknown as ChatUploadStoreService,
      // Recording, never real: a real one would read and signal this machine's
      // process table from a unit test.
      {
        reapInBackground: (runId: string) => processEnds.push(`reap ${runId}`),
      } as unknown as RunProcessReaper,
      wallTurnDao,
      commands,
      threadInbox,
      monitors,
      browserBridge,
      browserApprovals,
    );
  });

  /** A run holding one member, two of its call threads, and a transcript row. */
  const seedRun = async (runId: string): Promise<void> => {
    await runDao.create({ id: runId, agentKind: 'claude', cwd: '/work' });
    await nodeStateDao.createPending(runId, 'node-a');
    await callContextDao.rememberContext(runId, 'call-1', 'node-a', {
      contextTokens: 4200,
      contextWindowTokens: 200000,
    });
    await callContextDao.rememberContext(runId, 'call-2', 'node-a', {
      contextTokens: 91000,
      contextWindowTokens: 200000,
    });
  };

  it('closes the run’s CLIs, then reaps what its agents left running — that run’s only', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(processEnds).toEqual(['closeRun run-a', 'reap run-a']);
  });

  it('cancels what waits for the thread before its rows go', async () => {
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(inboxCancels).toEqual([
      { runId: 'run-a', why: 'deleted', runStillThere: true },
    ]);
  });

  it('says a run is ended once it is archived or deleted', () => {
    expect(teardown.hasEnded('run-a')).toBe(false);
    teardown.endProcesses('run-a');

    expect(teardown.hasEnded('run-a')).toBe(true);
  });

  it('hands a run back when a delete fails before the run is gone', async () => {
    await seedRun('run-a');
    const failing = vi
      .spyOn(wallTurnDao, 'hardDeleteIncludingSoftDeleted')
      .mockRejectedValueOnce(new Error('disk full'));
    onTestFinished(() => failing.mockRestore());

    await expect(
      teardown.purge(orm.em.fork(), 'run-a', undefined),
    ).rejects.toThrow('disk full');
    expect(commands.isEnding('run-a')).toBe(false);
    expect(monitors.isEnding('run-a')).toBe(false);

    expect(teardown.hasEnded('run-a')).toBe(false);
  });

  it('keeps an ARCHIVED run ended when its delete fails before the row is gone', async () => {
    // The delete from the archive: a failure here leaves it archived, not
    // live, so its commands and monitors stay refused.
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      cwd: '/work',
      archivedAt: new Date(),
    });
    const failing = vi
      .spyOn(wallTurnDao, 'hardDeleteIncludingSoftDeleted')
      .mockRejectedValueOnce(new Error('disk full'));
    onTestFinished(() => failing.mockRestore());

    await expect(
      teardown.purge(orm.em.fork(), 'run-a', undefined),
    ).rejects.toThrow('disk full');
    expect(
      (await runDao.getById('run-a', orm.em.fork()))?.archivedAt,
    ).not.toBeNull();
    expect(commands.isEnding('run-a')).toBe(true);
    expect(monitors.isEnding('run-a')).toBe(true);

    expect(teardown.hasEnded('run-a')).toBe(true);
  });

  it('keeps a run ended when a failed delete cannot read whether it is still live', async () => {
    await seedRun('run-a');
    const failing = vi
      .spyOn(runDao, 'getById')
      .mockRejectedValue(new Error('database is locked'));
    onTestFinished(() => failing.mockRestore());

    await expect(
      teardown.purge(orm.em.fork(), 'run-a', undefined),
    ).rejects.toThrow('database is locked');
    // Both reads failed: the purge's own and the hand-back's.
    expect(failing).toHaveBeenCalledTimes(2);

    expect(teardown.hasEnded('run-a')).toBe(true);
  });

  it('keeps a deleted run ended when a step after its row is gone fails', async () => {
    // Archived, so the purge goes on to remove its CLI transcripts: the step
    // after the run row is gone.
    await runDao.create({
      id: 'run-a',
      agentKind: 'claude',
      cwd: '/work',
      archivedAt: new Date(),
    });
    const failing = vi
      .spyOn(SessionTranscriptsService.prototype, 'remove')
      .mockRejectedValueOnce(new Error('transcript store locked'));
    onTestFinished(() => failing.mockRestore());

    await expect(
      teardown.purge(orm.em.fork(), 'run-a', undefined),
    ).rejects.toThrow('transcript store locked');
    expect(await runDao.getById('run-a', orm.em.fork())).toBeNull();

    expect(teardown.hasEnded('run-a')).toBe(true);
  });

  it('says a run back from the archive is no longer ended', () => {
    teardown.endProcesses('run-a');
    teardown.resumeProcesses('run-a');

    expect(teardown.hasEnded('run-a')).toBe(false);
  });

  it('ends the command actions the run has running — that run’s only', () => {
    const ours = commands.start('run-a');
    const theirs = commands.start('run-b');

    teardown.endProcesses('run-a');

    expect(ours.signal.aborted).toBe(true);
    expect(theirs.signal.aborted).toBe(false);
  });

  it('rejects the run’s pending browser requests', async () => {
    const request = (runId: string) =>
      browserBridge.request({
        runId,
        memberName: 'Claude',
        op: { kind: 'tabs' },
        allowedHosts: null,
      });
    const ours = request('run-a');
    const theirs = request('run-b');
    browserApprovals.approve('run-a', 'example.com');
    browserApprovals.approve('run-b', 'example.com');

    teardown.endProcesses('run-a');

    await expect(ours).resolves.toEqual({
      status: 'failed',
      reason: 'The chat was archived or deleted.',
    });
    expect(browserApprovals.allows('run-a', 'example.com')).toBe(false);
    expect(browserApprovals.allows('run-b', 'example.com')).toBe(true);
    browserBridge.rejectRun('run-b', 'done');
    await expect(theirs).resolves.toMatchObject({ status: 'failed' });
  });

  it('a command started right after its run was ended starts already ended', () => {
    teardown.endProcesses('run-a');

    expect(commands.start('run-a').signal.aborted).toBe(true);
    expect(commands.start('run-b').signal.aborted).toBe(false);
  });

  it('stops the run’s monitors as teardown, waking nobody, and starts none until the run is back', async () => {
    const ends: { stoppedBy: string | null; wake: boolean }[] = [];
    monitors.subscribe((event) => {
      if (event.type === 'end') {
        ends.push({ stoppedBy: event.stoppedBy, wake: event.wake });
      }
    });
    const owner = {
      runId: 'run-a',
      memberId: 'agent',
      caller: 'agent',
      conversationId: null,
      callId: null,
      target: 'chat' as const,
    };
    const start = () =>
      monitors.start({
        owner,
        command: 'while true; do sleep 1; done',
        description: 'loop',
        timeoutMs: 60_000,
      });
    expect(start().status).toBe('started');

    teardown.endProcesses('run-a');
    await monitors.settled('run-a', 5000);

    expect(ends).toEqual([{ stoppedBy: 'teardown', wake: false }]);
    expect(start().status).toBe('refused');
    teardown.resumeProcesses('run-a');
    expect(start().status).toBe('started');
    monitors.stopRun('run-a', 'teardown');
    await monitors.settled('run-a', 5000);
  });

  it('a run back from the archive starts its commands normally again', () => {
    teardown.endProcesses('run-a');

    teardown.resumeProcesses('run-a');

    expect(commands.start('run-a').signal.aborted).toBe(false);
  });

  it('starts nothing once the app is stopping', () => {
    commands.beforeApplicationShutdown();

    const slot = commands.start('run-a');

    expect(slot.signal.aborted).toBe(true);
    expect(slot.signal.reason).toBe('shutdown');
  });

  it('stops waiting for a command that never writes its last row', async () => {
    commands.start('run-a');

    await expect(commands.settled('run-a', 20)).resolves.toBeUndefined();
  });

  it('deletes a run’s rows only after its ended command actions have written theirs', async () => {
    await seedRun('run-a');
    const slot = commands.start('run-a');
    let rowWritten = false;
    slot.signal.addEventListener('abort', () => {
      setTimeout(() => {
        void itemDao
          .create({
            runId: 'run-a',
            seq: 50,
            kind: 'action_outcome',
            role: null,
            payload: JSON.stringify({ state: 'interrupted' }),
          })
          .then(() => {
            rowWritten = true;
            slot.release();
          });
      }, 50);
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(rowWritten).toBe(true);
    expect(await itemDao.rowsOfKinds('run-a', ['action_outcome'])).toEqual([]);
  });

  it('destroys the per-call context rows of the run it deletes', async () => {
    await seedRun('run-a');
    expect(await callContextDao.listByRun('run-a')).toHaveLength(2);

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
  });

  it('leaves another run’s per-call context rows standing', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await callContextDao.listByRun('run-a')).toHaveLength(0);
    expect(await callContextDao.listByRun('run-b')).toHaveLength(2);
  });

  it('destroys the run’s node states and the run row alongside them', async () => {
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await nodeStateDao.listByRun('run-a')).toHaveLength(0);
    expect(await runDao.getById('run-a', orm.em.fork())).toBeNull();
  });

  it('destroys the run’s wall-measured turns, and only that run’s', async () => {
    // Run-scoped worked time: left behind, a deleted run's turns would sit in
    // the table for good and be summed into nothing anyone can see.
    await seedRun('run-a');
    await seedRun('run-b');
    await wallTurnDao.record('run-a', [
      { seq: 3, memberId: 'node-a', ms: 900 },
    ]);
    await wallTurnDao.record('run-b', [{ seq: 3, memberId: null, ms: 700 }]);

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect((await wallTurnDao.nodeSums('run-a')).size).toBe(0);
    expect((await wallTurnDao.chatSums(['run-b'])).get('run-b')).toBe(700);
  });

  it('drops the run’s published artifacts, which nothing else would reach', async () => {
    // The pages live as files under the artifacts root, so no table assertion
    // above can see them: without this call a deleted run's artifacts stay on
    // disk for the life of the install, unreachable and unreferenced.
    await seedRun('run-a');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(removedArtifactRuns).toEqual(['run-a']);
  });

  it('keeps what the run’s agents read of the shared memory, which outlives the chat', async () => {
    await seedRun('run-a');
    const usage = new MemoryUsageDao(orm.em.fork());
    await usage.add([
      {
        memoryId: 'mem-1',
        day: '2026-11-03',
        reads: 2,
        searchHits: 1,
        indexShows: 1,
      },
    ]);
    await orm.em
      .fork()
      .transactional((tx) => usage.markBackfilled('run-a', tx));

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await usage.daysOf(['mem-1'])).toEqual([
      {
        memoryId: 'mem-1',
        day: '2026-11-03',
        reads: 2,
        searchHits: 1,
        indexShows: 1,
      },
    ]);
    expect(await usage.backfilledRunIds()).toEqual(new Set(['run-a']));
  });

  it('keeps the memory marks the run’s thread made, which outlive the chat', async () => {
    await seedRun('run-a');
    await new MemoryMarkDao(orm.em.fork()).record(
      {
        memoryId: 'mem-1',
        threadId: 'run-a',
        runId: 'run-a',
        memberId: null,
        source: 'agent',
        verdict: 'not_useful',
        reason: 'the path moved',
        evidenceSeq: null,
        agentKind: AgentKind.Claude,
        model: null,
      },
      new Date(),
      orm.em.fork(),
    );

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(
      await orm.em.fork().find(MemoryMark, { memoryId: 'mem-1' }),
    ).toMatchObject([
      { threadId: 'run-a', verdict: 'not_useful', reason: 'the path moved' },
    ]);
  });

  it('keeps the memory check findings the run’s reads led to, which outlive the chat', async () => {
    await seedRun('run-a');
    const findings = new MemoryReviewFindingDao(orm.em.fork());
    await findings.record(
      [
        {
          memoryAId: 'mem-1',
          memoryBId: 'mem-2',
          hashA: 'hash-1',
          hashB: 'hash-2',
          outcome: 'contradicts',
          quoteA: 'Always run pnpm',
          quoteB: 'Never run pnpm',
          reason: 'opposed',
          agentKind: AgentKind.Claude,
          model: null,
        },
      ],
      new Date(),
    );

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(await findings.checkedTexts()).toEqual(
      new Map([[pairKey('mem-1', 'mem-2'), 'hash-1\nhash-2']]),
    );
  });

  it('keeps the run’s shared-page rows, the only way to revoke a link it handed out', async () => {
    // A shared link keeps working after its chat is deleted, so the row that
    // can revoke it must survive the purge.
    await seedRun('run-a');
    const shares = new ArtifactShareDao(orm.em.fork());
    await shares.create({
      runId: 'run-a',
      artifactId: 'report',
      title: 'Report',
      destination: '{}',
      objectId: 'obj',
      linkBase: 'https://example.com',
      sharedVersion: 1,
      sharedBy: 'user',
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(
      await new ArtifactShareDao(orm.em.fork()).findByArtifact(
        'run-a',
        'report',
      ),
    ).not.toBeNull();
  });

  it('keeps the run’s goals and its metric ledgers, which count every run a team ever had', async () => {
    await seedRun('run-a');
    const em = orm.em.fork();
    em.persist(
      Object.assign(new Goal(), {
        runId: 'run-a',
        number: 1,
        text: 'ship it',
        source: 'agent',
        status: 'achieved',
        evidence: 'merged',
      }),
    );
    await em.flush();
    const ledger = new MetricLedgerDao(orm.em);
    await ledger.insertToolCall({
      runId: 'run-a',
      seq: 3,
      occurredAt: new Date(),
      teamSlug: 'dev-team',
      memberId: 'dev',
      agentKind: 'claude',
      tool: 'Bash',
      mcpServer: null,
      ok: true,
      durationMs: 10,
    });
    await ledger.insertCall({
      runId: 'run-a',
      seq: 4,
      callId: 'call-1',
      occurredAt: new Date(),
      teamSlug: 'dev-team',
      caller: 'lead',
      callee: 'dev',
      durationMs: 1,
      costUsd: null,
      turns: 1,
      ok: true,
    });
    await ledger.insertStage({
      runId: 'run-a',
      seq: 5,
      occurredAt: new Date(),
      teamSlug: 'dev-team',
      memberId: 'dev',
      lead: null,
      stageId: 'plan',
      action: 'complete',
      enteredAt: null,
      durationMs: null,
    });

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(
      await new GoalDao(orm.em).listByRun('run-a', orm.em.fork()),
    ).toHaveLength(1);
    expect(await ledger.toolCalls({})).toHaveLength(1);
    expect(await ledger.calls({})).toHaveLength(1);
    expect(await ledger.stages({})).toHaveLength(1);
  });

  it('hands the run’s own user messages to the upload store, and nothing else', async () => {
    // A phone's uploads are reachable only through the message text naming
    // them, so the purge must read that text BEFORE it destroys the rows.
    await seedRun('run-a');
    await seedRun('run-b');
    const message = (runId: string, seq: number, role: string, text: string) =>
      itemDao.create({
        runId,
        seq,
        kind: 'message',
        role,
        payload: JSON.stringify({ text }),
      });
    await message('run-a', 1, 'user', 'see /uploads/a.zip');
    await message('run-a', 2, 'assistant', 'reading /uploads/a.zip');
    await message('run-b', 1, 'user', 'see /uploads/b.zip');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(referencedTexts).toEqual([
      [JSON.stringify({ text: 'see /uploads/a.zip' })],
    ]);
  });

  describe('the transcript purge', () => {
    /** Seed `count` transcript rows on a run, each carrying a real payload. */
    const seedTranscript = async (
      runId: string,
      count: number,
    ): Promise<void> => {
      for (let seq = 0; seq < count; seq += 1) {
        await itemDao.create({
          runId,
          seq,
          kind: 'tool_result',
          payload: JSON.stringify({ output: 'x'.repeat(2_000) }),
        });
      }
    };

    /** Everything a purge of `runId` said to the `items` table. */
    const itemStatementsOf = async (runId: string): Promise<string[]> => {
      statements.length = 0;
      recording = true;
      try {
        await teardown.purge(orm.em.fork(), runId, undefined);
      } finally {
        recording = false;
      }
      return statements.filter((sql) => sql.includes('`items`'));
    };

    it('destroys the transcript without reading it back first', async () => {
      // The generic hard delete hydrated every row, payload and all, only to
      // hand it to `em.remove` — measured at ~103MB of heap for a 20,000-row
      // run, and the busiest real threads run past 30,000. The observable is
      // the SQL itself: a purge that READS the transcript selects from it.
      await seedRun('run-a');
      await seedTranscript('run-a', 3);

      const sql = await itemStatementsOf('run-a');

      // ONE read is allowed, and it is not the transcript: the user's own
      // messages, payload column only, for the uploads they name.
      // Matched without `\b`: the logged line carries a colour code glued to
      // the keyword, which leaves no word boundary in front of it.
      const selects = sql.filter((line) => /select /i.test(line));
      expect(selects).toHaveLength(1);
      expect(selects[0]).toMatch(
        /select `i0`\.`id`, `i0`\.`payload` from `items`/,
      );
      expect(selects[0]).toMatch(/`i0`\.`kind` = \? and `i0`\.`role` = \?/);
      expect(sql.filter((line) => /delete from/i.test(line))).toHaveLength(1);
      expect(await itemDao.getAll({ runId: 'run-a' })).toHaveLength(0);
    });

    it('reaches a transcript row that was soft-deleted', async () => {
      // A native delete is filtered like a read, so without the `softDelete`
      // filter switched off a soft-deleted row would survive its run as an
      // orphan nothing can reach or remove.
      await seedRun('run-a');
      await seedTranscript('run-a', 2);
      await orm.em
        .fork()
        .nativeUpdate(
          Item,
          { runId: 'run-a', seq: 0 },
          { deletedAt: new Date() },
        );

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(
        await orm.em
          .fork()
          .find(Item, { runId: 'run-a' }, { filters: { softDelete: false } }),
      ).toHaveLength(0);
    });

    it('leaves another run’s transcript standing', async () => {
      await seedRun('run-a');
      await seedRun('run-b');
      await seedTranscript('run-a', 2);
      await seedTranscript('run-b', 2);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(await itemDao.getAll({ runId: 'run-b' })).toHaveLength(2);
    });
  });

  it('drops only the deleted run’s artifacts', async () => {
    await seedRun('run-a');
    await seedRun('run-b');

    await teardown.purge(orm.em.fork(), 'run-a', undefined);

    expect(removedArtifactRuns).not.toContain('run-b');
  });
  describe('the CLI’s own transcripts', () => {
    /** A chat run holding two CLI sessions — a compaction replaced the first. */
    const seedChat = async (
      runId: string,
      archived: boolean,
      sessions: string[],
    ): Promise<Run> => {
      const run = await runDao.create({
        id: runId,
        agentKind: 'claude',
        cwd: '/work',
        configDir: '/profiles/work',
        archivedAt: archived ? new Date() : null,
      });
      for (const sessionId of sessions) {
        await nodeStateDao.saveSessionId(runId, 'agent', sessionId);
      }
      return run;
    };

    it('deletes every session an ARCHIVED chat held, under its own profile', async () => {
      const run = await seedChat('run-a', true, ['s-1', 's-2']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(
        deletedTranscripts.map(({ agent, sessionId, configDir }) => ({
          agent,
          sessionId,
          configDir,
        })),
      ).toEqual([
        { agent: 'claude', sessionId: 's-1', configDir: '/profiles/work' },
        { agent: 'claude', sessionId: 's-2', configDir: '/profiles/work' },
      ]);
      // The moment the run began is what lets each CLI keep a conversation
      // that was imported from the user's own terminal.
      expect(deletedTranscripts[0]?.runCreatedAt.getTime()).toBe(
        run.createdAt.getTime(),
      );
    });

    it('leaves the transcripts of a run that was never archived', async () => {
      // A failed task start and a team builder's chat purge their runs too,
      // and neither is the user deleting a conversation.
      await seedChat('run-a', false, ['s-1']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(deletedTranscripts).toEqual([]);
    });

    it('keeps a session another run still names', async () => {
      await seedChat('run-a', true, ['shared', 'own']);
      await seedChat('run-b', false, ['shared']);

      await teardown.purge(orm.em.fork(), 'run-a', undefined);

      expect(deletedTranscripts.map((entry) => entry.sessionId)).toEqual([
        'own',
      ]);
    });

    it('deletes a team member’s sessions under the profile its snapshot names', async () => {
      await runDao.create({
        id: 'run-w',
        teamId: 'dev-team',
        cwd: '/work',
        archivedAt: new Date(),
        teamSnapshot: JSON.stringify({
          nodes: [
            { id: 'manager', kind: 'agent', configDir: '/profiles/alt' },
            { id: 'qa', kind: 'agent' },
          ],
        }),
      });
      await nodeStateDao.saveSessionId('run-w', 'manager', 'm-1');
      await nodeStateDao.saveSessionId('run-w', 'qa', 'q-1');

      const em = orm.em.fork();
      for (const [memberId, agentKind] of [
        ['manager', 'claude'],
        ['qa', 'cursor-agent'],
      ] as const) {
        await em.nativeUpdate(
          NodeState,
          { runId: 'run-w', memberId },
          { agentKind },
        );
      }

      await teardown.purge(orm.em.fork(), 'run-w', undefined);

      expect(
        deletedTranscripts
          .map(({ agent, sessionId, configDir }) => ({
            agent,
            sessionId,
            configDir,
          }))
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
      ).toEqual([
        { agent: 'claude', sessionId: 'm-1', configDir: '/profiles/alt' },
        { agent: 'cursor-agent', sessionId: 'q-1', configDir: null },
      ]);
    });

    it('looks for a POOLED member’s session under every pool member’s CLI and profile', async () => {
      await runDao.create({
        id: 'run-p',
        teamId: 'dev-team',
        cwd: '/work',
        archivedAt: new Date(),
        teamSnapshot: JSON.stringify({
          nodes: [
            {
              id: 'engineer',
              kind: 'agent',
              agent: 'claude',
              configDir: '/profiles/work',
              pool: [
                { agent: 'claude', configDir: '/profiles/personal' },
                { agent: 'codex' },
              ],
            },
          ],
        }),
      });
      await nodeStateDao.saveSessionId('run-p', 'engineer', 'e-1');
      await orm.em
        .fork()
        .nativeUpdate(
          NodeState,
          { runId: 'run-p', memberId: 'engineer' },
          { agentKind: 'codex' },
        );

      await teardown.purge(orm.em.fork(), 'run-p', undefined);

      expect(
        deletedTranscripts.map(({ agent, sessionId, configDir }) => ({
          agent,
          sessionId,
          configDir,
        })),
      ).toEqual([
        { agent: 'claude', sessionId: 'e-1', configDir: '/profiles/work' },
        { agent: 'claude', sessionId: 'e-1', configDir: '/profiles/personal' },
        { agent: 'codex', sessionId: 'e-1', configDir: null },
      ]);
    });
  });
});
