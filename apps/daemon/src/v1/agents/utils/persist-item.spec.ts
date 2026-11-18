import {
  defineConfig,
  type EntityManager,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemWire, RunStatusEvent } from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { persistItemAndEmit, runToWire } from './persist-item';

/**
 * The PRODUCER hop of the run row's wire projection.
 *
 * `archivedAt` crosses the daemon→renderer seam, where the rule is a test at
 * every hop; the reader's own is `Chats.spec.tsx`'s "an archived thread's
 * composer is disabled", which drives the field off the row. Two tests rather
 * than one so reverting either is not masked by the other passing.
 */
describe('runToWire', () => {
  it('reads a stored colour the palette no longer names as untinted', () => {
    const run = new Run();
    // The column is a free string; only the wire enforces the palette.
    (run as { color: unknown }).color = 'magenta';
    expect(runToWire(run).color).toBeNull();
    run.color = 'teal';
    expect(runToWire(run).color).toBe('teal');
  });

  it("projects an archived run's archivedAt as an ISO string", () => {
    const run = new Run();
    run.archivedAt = new Date('2026-08-30T12:34:56.000Z');

    expect(runToWire(run).archivedAt).toBe('2026-08-30T12:34:56.000Z');
  });

  it('projects the pull requests a run opened and those its CLI recorded it touching as one list, in thread order', () => {
    const pr = (number: number, seq: number) => ({
      owner: 'acme',
      repo: 'platform',
      number,
      url: `https://github.com/acme/platform/pull/${number}`,
      seq,
    });
    const run = new Run();
    run.pullRequests = JSON.stringify([pr(87, 9)]);
    run.touchedPullRequests = JSON.stringify([pr(6841, 4), pr(87, 12)]);

    expect(
      runToWire(run).pullRequests.map((row) => `#${row.number}@${row.seq}`),
    ).toEqual(['#6841@4', '#87@9']);
  });

  it("projects each pull request's recorded outcome from the run's outcomes column", () => {
    const outcome = {
      seq: 40,
      draft: false,
      reviewRounds: 2,
      acceptance: 'accepted',
      questionsAsked: 3,
    };
    const run = new Run();
    run.pullRequests = JSON.stringify([
      {
        owner: 'acme',
        repo: 'platform',
        number: 87,
        url: 'https://github.com/acme/platform/pull/87',
        seq: 9,
      },
      {
        owner: 'acme',
        repo: 'platform',
        number: 88,
        url: 'https://github.com/acme/platform/pull/88',
        seq: 10,
      },
    ]);
    run.runOutcomes = JSON.stringify({ 'acme/platform#87': outcome });

    expect(runToWire(run).pullRequests.map((row) => row.outcome)).toEqual([
      outcome,
      null,
    ]);
  });

  it('projects a run that was never archived as null', () => {
    expect(runToWire(new Run()).archivedAt).toBeNull();
  });

  // `notes` is the same kind of seam crossing; its reader hop is
  // `chat-list-item.spec.tsx`'s notes indicator.
  it("projects the thread's notes verbatim", () => {
    const run = new Run();
    run.notes = 'check the flaky upload test\nafter lunch';

    expect(runToWire(run).notes).toBe(
      'check the flaky upload test\nafter lunch',
    );
  });

  it('projects a run without notes as null', () => {
    expect(runToWire(new Run()).notes).toBeNull();
  });

  it("projects the stage progress stored on the run's column", () => {
    const progress = {
      rev: 1,
      current: 'build',
      position: { index: 2, total: 2 },
      stages: [
        {
          id: 'plan',
          title: 'Plan',
          status: 'done',
          next: ['build'],
          by: { kind: 'system' },
          rev: 1,
        },
        { id: 'build', title: 'Build', status: 'current', next: [] },
      ],
    };
    const run = new Run();
    run.stageProgress = JSON.stringify(progress);

    expect(runToWire(run).stages).toEqual(progress);
  });

  it('projects a run without stage progress as null', () => {
    expect(runToWire(new Run()).stages).toBeNull();
  });

  it('projects the run an analysis chat analyses, and the seq it stops at', () => {
    const run = new Run();
    run.analysisSourceRunId = 'source-run';
    run.analysisSourceSeq = 412;

    expect(runToWire(run)).toMatchObject({
      analysisSourceRunId: 'source-run',
      analysisSourceSeq: 412,
    });
    expect(runToWire(new Run())).toMatchObject({
      analysisSourceRunId: null,
      analysisSourceSeq: null,
    });
  });
});

/**
 * The one insert seam every shipping `Item` write goes through.
 *
 * A row is searchable only because the write itself flattens. That makes this
 * the pin the whole feature rests on — drop the field here and search
 * silently misses everything said from then on.
 */
describe('persistItemAndEmit', () => {
  function fakeDeps(inCall = ''): {
    deps: Parameters<typeof persistItemAndEmit>[0];
    created: Record<string, unknown>[];
    published: string[];
    statuses: RunStatusEvent[];
    wires: ItemWire[];
    /** The seqs the seam said were no longer in flight. */
    settled: number[];
  } {
    const created: Record<string, unknown>[] = [];
    // One ordered log across both channels, so "after the row is durable and
    // published" is an assertion rather than an assumption.
    const published: string[] = [];
    const statuses: RunStatusEvent[] = [];
    const wires: ItemWire[] = [];
    const settled: number[] = [];
    const deps = {
      itemDao: {
        create: (row: Record<string, unknown>) => {
          created.push(row);
          published.push('create');
          return Promise.resolve({ id: 'item-1', createdAt: new Date(0) });
        },
      },
      bus: {
        publish: ({ item }: { item: ItemWire }) => {
          published.push('item');
          wires.push(item);
        },
        publishRunStatus: (event: RunStatusEvent) => {
          published.push('status');
          statuses.push(event);
        },
      },
      calls: { inCallOf: () => Promise.resolve(inCall) },
      seqs: { settle: (_runId: string, seq: number) => settled.push(seq) },
    } as unknown as Parameters<typeof persistItemAndEmit>[0];
    return { deps, created, published, statuses, wires, settled };
  }

  const em = {
    clear: () => undefined,
    fork: () => em,
  } as unknown as EntityManager;

  it("settles the row's reserved seq once it is written, and when the write fails", async () => {
    const { deps, settled } = fakeDeps();
    const row = {
      runId: 'run-1',
      memberId: null,
      seq: 7,
      kind: 'message' as const,
      role: 'assistant',
      payload: { text: 'hi' },
    };

    await persistItemAndEmit(deps, em, row);
    expect(settled).toEqual([7]);

    (deps.itemDao as unknown as { create: () => Promise<never> }).create = () =>
      Promise.reject(new Error('disk full'));
    await expect(
      persistItemAndEmit(deps, em, { ...row, seq: 8 }),
    ).rejects.toThrow('disk full');
    expect(settled).toEqual([7, 8]);
  });

  it("flattens a tool call's name and command into searchText", async () => {
    const { deps, created } = fakeDeps();

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      memberId: null,
      seq: 1,
      kind: 'tool_call',
      role: 'assistant',
      payload: { name: 'Bash', input: { command: 'pnpm full-check' } },
    });

    // Lowercased: the column is an INDEX value, so SQLite's `LIKE` — which
    // folds case for ASCII only — can match a Cyrillic term too.
    expect(created[0]?.searchText).toBe('bash pnpm full-check');
  });

  it('writes an empty string — not null — for a payload with nothing to match', async () => {
    // Null means "never flattened". A row this seam DID write must never read
    // as null.
    const { deps, created } = fakeDeps();

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      memberId: null,
      seq: 2,
      kind: 'turn_complete',
      role: null,
      payload: { usage: { inputTokens: 12 } },
    });

    expect(created[0]?.searchText).toBe('');
  });

  it('stamps the row with the call it is drawn in, and says so on the wire', async () => {
    const { deps, created, wires } = fakeDeps('call-4');

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      memberId: 'engineer',
      seq: 4,
      kind: 'tool_call',
      role: 'assistant',
      payload: { id: 't1', callId: 'call-4' },
    });

    expect(created[0]?.inCall).toBe('call-4');
    expect(wires[0]?.inCall).toBe('call-4');
  });

  it("says the run's own flow as null on the wire", async () => {
    const { deps, created, wires } = fakeDeps('');

    await persistItemAndEmit(deps, em, {
      runId: 'run-1',
      memberId: 'manager',
      seq: 5,
      kind: 'message',
      role: 'assistant',
      payload: { text: 'plan' },
    });

    expect(created[0]?.inCall).toBe('');
    expect(wires[0]?.inCall).toBeNull();
  });

  describe('on a real database', () => {
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

    it("writes its row alone, whatever another writer left pending on the caller's manager", async () => {
      const { deps } = fakeDeps();
      const itemDao = new ItemDao(orm.em.fork());
      deps.itemDao = itemDao;
      const em = orm.em.fork();
      em.create(
        Item,
        {
          runId: 'run-shared',
          seq: 1,
          kind: null as unknown as 'message',
          payload: '{}',
        },
        { partial: true },
      );

      await persistItemAndEmit(deps, em, {
        runId: 'run-shared',
        memberId: 'middle',
        seq: 2,
        kind: 'message',
        role: 'assistant',
        payload: { text: 'ok' },
      });

      const stored = await itemDao.getByRun('run-shared');
      expect(stored.map((item) => item.seq)).toEqual([2]);
    });
  });

  describe('the sidebar preview line', () => {
    // Items reach one run room, so a thread working in the background reaches
    // the sidebar only through this client-wide announce — made at the seam so
    // the chat and team paths cannot differ.
    const message = (payload: Record<string, unknown>) => ({
      runId: 'run-1',
      memberId: 'manager',
      seq: 3,
      kind: 'message' as const,
      role: 'assistant',
      payload,
    });

    it('announces a message’s text on the status channel, after the row is written and published', async () => {
      const { deps, published, statuses } = fakeDeps();

      await persistItemAndEmit(deps, em, message({ text: 'halfway there' }));

      expect(statuses).toEqual([
        { runId: 'run-1', status: null, preview: 'halfway there' },
      ]);
      expect(published).toEqual(['create', 'item', 'status']);
    });

    // A callee's or a delegate's words are another conversation the row cannot
    // open; the DAO's NOT_IN_A_CALL / NOT_A_DELEGATE and the renderer's
    // previewsThread exclude the same rows, or the line flips on every refetch.
    it.each([
      [
        'a message written inside an agent-to-agent call',
        message({ text: 'Fixed: 36/36', callId: 'call-4' }),
      ],
      [
        'a delegate’s message',
        message({ text: 'reviewer notes', parentToolUseId: 'toolu_1' }),
      ],
      [
        'a non-message row',
        { ...message({ text: 'not a message' }), kind: 'reasoning' as const },
      ],
      ['a message with no words', message({ text: '   ' })],
    ])('stays silent for %s', async (_label, row) => {
      const { deps, statuses } = fakeDeps();

      await persistItemAndEmit(deps, em, row);

      expect(statuses).toEqual([]);
    });
  });
});
