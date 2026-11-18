import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
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
import { Item } from '../../runs/entity/item.entity';
import { Run } from '../../runs/entity/run.entity';
import { AgentKind } from '../../runs/runs.types';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import type { SubagentRecoveryRef } from '../adapters/adapter.types';
import { ClaudeAdapter } from '../adapters/claude/claude.adapter';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { mapEventToItem } from '../utils/event-to-item';
import { itemToWire } from '../utils/item-wire';
import { delegateCloseEvent } from '../utils/open-delegates';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentEventBus } from './agent-events.bus';
import type { AgentSessionRegistry } from './agent-session.registry';
import type { ItemCallIndexService } from './item-call-index.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { SubagentRecoveryService } from './subagent-recovery.service';

describe('SubagentRecoveryService (SQLite)', () => {
  let orm: MikroORM;
  let items: ItemDao;
  let runs: RunDao;
  let seqs: ItemSeqAllocator;
  let service: SubagentRecoveryService;
  let bus: AgentEventBus;
  let adapter: ClaudeAdapter;
  let blocked: boolean;
  const ref: SubagentRecoveryRef = {
    agentKind: AgentKind.Claude,
    sessionId: 'parent',
    configDir: '/profile',
    cwd: '/project',
    toolCallId: 'child',
    launchedAtMs: 1,
    childSessionId: null,
  };

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [Run, Item],
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
  afterEach(async () => {
    await service.onApplicationShutdown();
    vi.useRealTimers();
  });
  beforeEach(async () => {
    if (service) {
      await service.onApplicationShutdown();
    }
    vi.useRealTimers();
    await orm.schema.clear();
    items = new ItemDao(orm.em.fork());
    runs = new RunDao(orm.em.fork());
    seqs = new ItemSeqAllocator(orm.em, items);
    adapter = new ClaudeAdapter();
    bus = new AgentEventBus();
    blocked = false;
    service = new SubagentRecoveryService(
      orm.em,
      runs,
      items,
      new AgentAdapterRegistry([adapter]),
      bus,
      seqs,
      { inCallOf: async () => 'call-a' } as unknown as ItemCallIndexService,
      {
        subagentRecoveryBlocked: () => blocked,
      } as unknown as AgentSessionRegistry,
      kindRowsPassthrough(items),
    );
    await runs.create({ id: 'run', status: 'completed' });
  });

  async function declare(
    seq: number,
    fields: Record<string, unknown> = {},
  ): Promise<Item> {
    const mapped = mapEventToItem(delegateCloseEvent('child'))!;
    return items.create({
      runId: 'run',
      memberId: 'node-a',
      seq,
      kind: 'subagent_info',
      role: null,
      payload: JSON.stringify({
        ...mapped.payload,
        callId: 'call-a',
        ...fields,
      }),
      inCall: 'call-a',
    });
  }
  async function lost(): Promise<void> {
    await declare(1, {
      recovery: ref,
      backgroundOpen: true,
      backgroundOutcome: null,
    });
    await declare(2);
  }

  it('appends an authoritative recovered outcome under the original member and call exactly once', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue('completed');
    const publish = vi.spyOn(bus, 'publish');
    expect(await service.reconcile('run')).toBe(false);
    expect(recover).toHaveBeenCalledWith(ref);
    const rows = await items.rowsOfKinds('run', ['subagent_info']);
    expect(rows).toHaveLength(3);
    expect(rows[2]?.memberId).toBe('node-a');
    expect(JSON.parse(rows[2]!.payload)).toMatchObject({
      id: 'child',
      callId: 'call-a',
      nodeId: 'node-a',
      backgroundOpen: false,
      backgroundOutcome: 'completed',
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run',
        item: expect.objectContaining({ seq: 3 }),
      }),
    );
    await service.reconcile('run');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('keeps missing evidence untracked and accepts an authoritative result on a later retry', async () => {
    await lost();
    vi.spyOn(adapter, 'recoverSubagent')
      .mockResolvedValueOnce(null)
      .mockResolvedValue('failed');
    expect(await service.reconcile('run')).toBe(true);
    expect(await items.maxSeq('run')).toBe(2);
    expect(await service.reconcile('run')).toBe(false);
    expect(
      JSON.parse(
        (await items.rowsOfKinds('run', ['subagent_info']))[2]!.payload,
      ).backgroundOutcome,
    ).toBe('failed');
  });

  it('rediscovers persisted references after restart and retries without a renderer request', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValueOnce(null)
      .mockResolvedValue('completed');
    vi.useFakeTimers();
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(recover).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(async () => expect(await items.maxSeq('run')).toBe(3));
    await service.onApplicationShutdown();
    vi.useRealTimers();
  });

  it('preserves an explicit live ending arriving during a recovery read', async () => {
    await lost();
    vi.spyOn(adapter, 'recoverSubagent').mockImplementation(async () => {
      const seq = await seqs.reserve('run');
      await declare(seq, { backgroundOutcome: 'failed' });
      seqs.settle('run', seq);
      return 'completed';
    });
    expect(await service.reconcile('run')).toBe(false);
    const rows = await items.rowsOfKinds('run', ['subagent_info']);
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[2]!.payload).backgroundOutcome).toBe('failed');
  });

  /** Three attempts that find nothing, as `schedule` spaces them. */
  async function exhaust(recover: ReturnType<typeof vi.spyOn>): Promise<void> {
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledTimes(3);
  }

  it('gives a delegate up after three attempts until a newer row of its own re-arms it', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    await exhaust(recover);
    expect(await items.maxSeq('run')).toBe(2);

    // A reconnecting client, and a turn ending, start no new round.
    recover.mockResolvedValue('completed');
    service.schedule('run');
    service.schedule('run', true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledTimes(3);

    await declare(3, { backgroundOutcome: 'untracked' });
    service.schedule('run', true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => expect(await items.maxSeq('run')).toBe(4));
    expect(recover).toHaveBeenCalledTimes(4);
  });

  it('lets a reopen read a given-up delegate that may still run again once the cooldown passed', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    await exhaust(recover);

    service.schedule('run');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    recover.mockResolvedValue('completed');
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => expect(await items.maxSeq('run')).toBe(3));
    expect(recover).toHaveBeenCalledTimes(4);
  });

  it('keeps a given-up delegate whose process ended given up past the cooldown', async () => {
    await declare(1, { recovery: ref, backgroundOpen: true });
    await declare(2, { trackingLost: 'process-ended' });
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    await exhaust(recover);

    await vi.advanceTimersByTimeAsync(3_600_000);
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledTimes(3);
  });

  it('reads nothing for a delegate the run’s own cancel stopped', async () => {
    await orm.em
      .fork()
      .nativeUpdate(Run, { id: 'run' }, { status: 'cancelled' });
    // A foreground delegate whose turn never wrote an ending row.
    await declare(1, {
      recovery: ref,
      backgroundOpen: null,
      backgroundOutcome: null,
    });
    const recover = vi.spyOn(adapter, 'recoverSubagent');

    expect(await service.reconcile('run')).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it('reads no tool rows for a run whose ref’d delegates the declarations already settle', async () => {
    await declare(1, { recovery: ref, backgroundOpen: true });
    await declare(2, { backgroundOutcome: 'completed' });
    const paired = vi.spyOn(items, 'rowsByPayloadId');
    const recover = vi.spyOn(adapter, 'recoverSubagent');

    expect(await service.reconcile('run')).toBe(false);
    expect(paired).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
  });

  it('reads a settled foreground delegate’s tool rows once, not on every trigger', async () => {
    await declare(1, {
      recovery: ref,
      backgroundOpen: null,
      backgroundOutcome: null,
    });
    await items.create({
      runId: 'run',
      memberId: 'node-a',
      seq: 2,
      kind: 'tool_result',
      role: null,
      payload: JSON.stringify({ id: 'child', result: 'done', isError: false }),
      inCall: 'call-a',
    });
    const paired = vi.spyOn(items, 'rowsByPayloadId');

    expect(await service.reconcile('run')).toBe(false);
    expect(await service.reconcile('run')).toBe(false);
    expect(paired).toHaveBeenCalledTimes(1);
  });

  it('runs one sweep at a time: a retry falling due mid-read waits for it', async () => {
    await lost();
    await runs.create({ id: 'other', status: 'completed' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reading = 0;
    let overlapped = false;
    vi.spyOn(service, 'reconcile').mockImplementation(async (runId) => {
      reading += 1;
      overlapped ||= reading > 1;
      if (runId === 'run') {
        await held;
      }
      reading -= 1;
      return true;
    });
    vi.useFakeTimers();
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    // Due while the first read is still out.
    service.schedule('other');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(service.reconcile).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(
        vi.mocked(service.reconcile).mock.calls.map(([runId]) => runId),
      ).toContain('other'),
    );
    expect(overlapped).toBe(false);
  });

  it('reconciles at boot only the runs that recorded a ref recently', async () => {
    await lost();
    await runs.create({ id: 'old', status: 'completed' });
    await items.create({
      runId: 'old',
      memberId: 'node-a',
      seq: 1,
      kind: 'subagent_info',
      role: null,
      payload: JSON.stringify({ id: 'child', recovery: ref }),
      inCall: null,
    });
    await orm.em
      .fork()
      .nativeUpdate(
        Item,
        { runId: 'old' },
        { createdAt: new Date(Date.now() - 2 * 24 * 60 * 60_000) },
      );
    const scheduled = vi.spyOn(service, 'schedule');
    vi.useFakeTimers();
    service.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(scheduled).toHaveBeenCalledWith('run'));
    expect(scheduled).not.toHaveBeenCalledWith('old');
  });

  it('coalesces duplicate subscriptions without renewing the retry budget', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    service.schedule('run');
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledTimes(3);
  });

  it('does not start another episode from its own recovered terminal row', async () => {
    await lost();
    vi.spyOn(adapter, 'recoverSubagent').mockResolvedValue('completed');
    const reconcile = vi.spyOn(service, 'reconcile');
    vi.useFakeTimers();
    service.onModuleInit();
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => expect(await items.maxSeq('run')).toBe(3));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('ignores metadata-only announcements instead of renewing unknown-child reads', async () => {
    await lost();
    const row = await declare(3, {
      recovery: ref,
      backgroundOpen: null,
      backgroundOutcome: null,
    });
    const reconcile = vi.spyOn(service, 'reconcile');
    vi.useFakeTimers();
    service.onModuleInit();
    bus.publish({ runId: 'run', item: itemToWire(row) });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('gives new loss evidence a check when the previous final attempt is in flight', async () => {
    await lost();
    let release!: (unresolved: boolean) => void;
    const last = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const reconcile = vi
      .spyOn(service, 'reconcile')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockReturnValueOnce(last)
      .mockResolvedValue(false);
    vi.useFakeTimers();
    service.onModuleInit();
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reconcile).toHaveBeenCalledTimes(3);
    const row = (await items.rowsOfKinds('run', ['subagent_info']))[1]!;
    bus.publish({ runId: 'run', item: itemToWire(row) });
    release(false);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });

  it('bounds retries when an adapter read fails', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockRejectedValue(new Error('record unavailable'));
    vi.useFakeTimers();
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(recover).toHaveBeenCalledTimes(3);
    expect(await items.maxSeq('run')).toBe(2);
  });

  it('does not spend an extra read on queued work superseded behind another run', async () => {
    await lost();
    let release!: (unresolved: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    const reconcile = vi
      .spyOn(service, 'reconcile')
      .mockImplementation((runId) =>
        runId === 'slow-run' ? waiting : Promise.resolve(true),
      );
    vi.useFakeTimers();
    service.onModuleInit();
    service.schedule('slow-run');
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    const row = (await items.rowsOfKinds('run', ['subagent_info']))[1]!;
    bus.publish({ runId: 'run', item: itemToWire(row) });
    release(false);
    await vi.advanceTimersByTimeAsync(100);
    const reads = () =>
      reconcile.mock.calls.filter(([runId]) => runId === 'run').length;
    expect(reads()).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads()).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toBe(3);
  });

  it('clears pending retries on shutdown', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue(null);
    vi.useFakeTimers();
    service.schedule('run');
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(recover).toHaveBeenCalledTimes(1));
    await service.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(3_600_000);
    service.schedule('run');
    expect(recover).toHaveBeenCalledTimes(1);
  });

  it('defers while an earlier live row is still being persisted', async () => {
    await lost();
    const pending = await seqs.reserve('run');
    vi.spyOn(adapter, 'recoverSubagent').mockResolvedValue('completed');
    expect(await service.reconcile('run')).toBe(true);
    expect(await items.maxSeq('run')).toBe(2);
    seqs.settle('run', pending);
    expect(await service.reconcile('run')).toBe(false);
  });

  it('does not bypass a live delegate command hold', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue('completed');
    blocked = true;
    expect(await service.reconcile('run')).toBe(true);
    expect(recover).not.toHaveBeenCalled();
    blocked = false;
    expect(await service.reconcile('run')).toBe(false);
  });

  it('rechecks a command hold acquired while the record is being read', async () => {
    await lost();
    vi.spyOn(adapter, 'recoverSubagent').mockImplementation(async () => {
      blocked = true;
      return 'completed';
    });
    expect(await service.reconcile('run')).toBe(true);
    expect(await items.maxSeq('run')).toBe(2);
  });

  it('keeps legacy, invalid and explicitly disabled references unknown', async () => {
    await declare(1);
    await declare(2, {
      id: 'bad',
      recovery: { ...ref, toolCallId: 'bad', agentKind: 'unknown' },
    });
    await declare(3, {
      id: 'disabled',
      recovery: { ...ref, toolCallId: 'disabled' },
    });
    await declare(4, { id: 'disabled', recovery: null });
    const recover = vi.spyOn(adapter, 'recoverSubagent');
    expect(await service.reconcile('run')).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it('allows only the newest launch to recover from a continued child transcript', async () => {
    await declare(1, { recovery: { ...ref, childSessionId: 'continued' } });
    await declare(2, {
      id: 'new-launch',
      recovery: {
        ...ref,
        toolCallId: 'new-launch',
        childSessionId: 'continued',
      },
    });
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue('completed');
    expect(await service.reconcile('run')).toBe(false);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'new-launch' }),
    );
    const rows = await items.rowsOfKinds('run', ['subagent_info']);
    expect(JSON.parse(rows[2]!.payload)).toMatchObject({
      id: 'new-launch',
      backgroundOutcome: 'completed',
    });
    expect(JSON.parse(rows[0]!.payload).backgroundOutcome).toBe('untracked');
  });

  it('does not read records of archived or deleted runs', async () => {
    await lost();
    const recover = vi.spyOn(adapter, 'recoverSubagent');
    await orm.em
      .fork()
      .nativeUpdate(Run, { id: 'run' }, { archivedAt: new Date() });
    expect(await service.reconcile('run')).toBe(false);
    expect(await service.reconcile('missing')).toBe(false);
    expect(recover).not.toHaveBeenCalled();
  });

  it('recovers a missing foreground ending when the parent turn has ended', async () => {
    await declare(1, {
      recovery: ref,
      backgroundOpen: null,
      backgroundOutcome: null,
    });
    vi.spyOn(adapter, 'recoverSubagent').mockResolvedValue('completed');
    expect(await service.reconcile('run')).toBe(false);
    expect(await items.maxSeq('run')).toBe(2);
  });

  it('schedules newly lost children from the persisted event stream', async () => {
    await lost();
    const recover = vi
      .spyOn(adapter, 'recoverSubagent')
      .mockResolvedValue('completed');
    vi.useFakeTimers();
    service.onModuleInit();
    const row = (await items.rowsOfKinds('run', ['subagent_info']))[1]!;
    bus.publish({ runId: 'run', item: itemToWire(row) });
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(async () => expect(await items.maxSeq('run')).toBe(3));
    expect(recover).toHaveBeenCalledTimes(1);
    await service.onApplicationShutdown();
    vi.useRealTimers();
  });
});
