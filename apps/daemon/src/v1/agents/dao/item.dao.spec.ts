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

import { recordSentStatements } from '../../../db/__tests__/sent-statements';
import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import type { ItemKind } from '../../runs/runs.types';
import type {
  ChatTextDatabase,
  HistoryWindow,
  SeqRange,
  WireRow,
} from '../chat.types';
import { PULL_REQUEST_NAMING_KINDS } from '../utils/pull-request-capture';
import { ItemDao } from './item.dao';
import { RunDao } from './run.dao';

/**
 * Real-driver DAO spec: the service specs run in-memory fakes that only MIRROR
 * these queries, so this suite boots MikroORM on an in-memory better-sqlite3
 * database with the real entities and executes the actual SQL — the `$gt`
 * replay cursor, the two-query head reduction, and the run scoping. The config
 * mirrors the daemon's `db/mikro-orm.config.ts` discovery settings, with
 * explicit entity classes in place of the compiled-file glob (so no
 * `dynamicImportProvider` shim is needed).
 */
describe('ItemDao (in-memory sqlite)', () => {
  let orm: MikroORM;
  let dao: ItemDao;

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

  beforeEach(async () => {
    await orm.schema.clear();
    // The module hands each DAO the app-wide EntityManager and per-request work
    // rides a fork (see chat.service) — construct on a fresh fork per test.
    dao = new ItemDao(orm.em.fork());
  });

  /** How many statements `read` sends to SQLite. */
  async function statementsOf(read: () => Promise<unknown>): Promise<number> {
    const { sent, stop } = await recordSentStatements(orm);
    await read();
    stop();
    return sent.length;
  }

  /** Persist one row through the DAO's own create — the production write path. */
  async function insert(
    runId: string,
    seq: number,
    kind: ItemKind = 'message',
    payload = JSON.stringify({ text: `m${seq}` }),
  ): Promise<Item> {
    return dao.create({ runId, seq, kind, payload });
  }

  it('copies the payload fields lookups filter on into their columns when a row is written', async () => {
    await insert(
      'run-a',
      1,
      'tool_call',
      JSON.stringify({
        id: 'toolu_1',
        name: 'Bash',
        parentToolUseId: 'toolu_0',
        callId: 'call-3',
      }),
    );
    await insert(
      'run-a',
      2,
      'tool_result',
      JSON.stringify({ id: 7, name: null }),
    );
    await insert('run-a', 3, 'message', 'not json');

    const rows = await orm.em
      .fork()
      .find(Item, { runId: 'run-a' }, { orderBy: { seq: 'asc' } });

    expect(
      rows.map((r) => [
        r.payloadId,
        r.toolNameLower,
        r.parentToolUseId,
        r.callId,
      ]),
    ).toEqual([
      ['toolu_1', 'bash', 'toolu_0', 'call-3'],
      [null, null, null, null],
      [null, null, null, null],
    ]);
  });

  describe('lookups by a copied payload field', () => {
    /**
     * Columns that disagree with the payload: a read through the column finds
     * the row, a read through the payload does not — so each assertion shows
     * which of the two the lookup used.
     */
    async function columnOnlyRows(runId: string): Promise<void> {
      const at = new Date(Date.UTC(2026, 9, 27));
      const row = (
        seq: number,
        kind: ItemKind,
        columns: Partial<Item>,
        payload = '{}',
      ) => ({
        id: `${runId}-${seq}`,
        runId,
        seq,
        kind,
        payload,
        memberId: 'qa',
        inCall: 'call-1',
        createdAt: at,
        updatedAt: at,
        ...columns,
      });
      await orm.em.fork().insertMany(Item, [
        row(1, 'tool_call', {
          payloadId: 'toolu_1',
          toolNameLower: 'task',
          parentToolUseId: 'toolu_parent',
        }),
        row(2, 'status', { callId: 'call-1' }),
        row(3, 'tool_result', { payloadId: 'toolu_1' }),
        row(4, 'call_started', { callId: 'call-1' }),
        row(
          5,
          'system',
          { callId: 'call-1' },
          '{"queuedCall":true,"member":1}',
        ),
        row(6, 'tool_call', { payloadId: 'toolu_2' }),
      ]);
    }

    async function lookups(runId: string) {
      const seqs = (rows: readonly { seq: number }[]) => rows.map((r) => r.seq);
      return {
        byId: seqs(
          await dao.rowsByPayloadId(runId, ['tool_call'], ['toolu_1']),
        ),
        byIdAfter: seqs(
          await dao.rowsByPayloadId(runId, ['tool_result'], ['toolu_1'], {
            after: 2,
          }),
        ),
        byIdInCall: seqs(
          await dao.rowsInCallsById(
            runId,
            ['tool_result'],
            new Map([['call-1', ['toolu_1']]]),
          ),
        ),
        callsById: (await dao.toolCallsByIds(runId, ['toolu_1'])).length,
        byName: seqs(await dao.toolCallsNamed(runId, ['task'])),
        delegates: [...(await dao.delegateToolCallCounts(runId, 10))],
        delegateSeqs: await dao.delegateToolCallSeqs(runId),
        own: (await dao.ownToolCallsByCall(runId)).map((c) => [
          c.calls,
          c.lastSeq,
        ]),
        ownThread: seqs(
          await dao.newestRowsInCalls(runId, ['call-1'], {
            kinds: ['tool_call'],
            ownThread: true,
            limit: 10,
          }),
        ),
        pool: seqs(await dao.nodePoolContextRows(runId, 'qa')),
        withStatus: [...(await dao.callIdsWithStatus(runId, ['call-1']))],
        callRows: seqs(await dao.callRowsOf(runId, ['call-1'])),
        handOffs: seqs(await dao.callHandOffRows(runId)),
        queued: seqs(await dao.callQueueRows(runId)),
        pair: await dao
          .findToolCallPair(runId, 'toolu_1')
          .then(({ call, result }) => [call?.seq ?? null, result?.seq ?? null]),
      };
    }

    it('reads the columns of a run whose rows are stamped', async () => {
      await new RunDao(orm.em.fork()).create({
        id: 'run-a',
        status: 'running',
        teamId: null,
      });
      await columnOnlyRows('run-a');

      expect(await lookups('run-a')).toEqual({
        byId: [1],
        byIdAfter: [3],
        byIdInCall: [3],
        callsById: 1,
        byName: [1],
        delegates: [['toolu_parent', 1]],
        delegateSeqs: [1],
        own: [[1, 6]],
        ownThread: [6],
        pool: [3, 4, 6],
        withStatus: ['call-1'],
        callRows: [4],
        handOffs: [5],
        queued: [5],
        pair: [1, 3],
      });
    });

    it('reads the payload of a run the sweep has not stamped yet', async () => {
      await new RunDao(orm.em.fork()).create({
        id: 'run-a',
        status: 'running',
        teamId: null,
      });
      await orm.em
        .fork()
        .nativeUpdate(Run, { id: 'run-a' }, { payloadRefsVersion: null });
      await columnOnlyRows('run-a');

      expect(await lookups('run-a')).toEqual({
        byId: [],
        byIdAfter: [],
        byIdInCall: [],
        callsById: 0,
        byName: [],
        delegates: [],
        delegateSeqs: [],
        own: [[2, 6]],
        ownThread: [1, 6],
        pool: [1, 3, 4, 6],
        withStatus: [],
        callRows: [],
        handOffs: [],
        queued: [],
        pair: [null, null],
      });
    });

    it('pairs a tool call by its exact id, the later of two results winning', async () => {
      await new RunDao(orm.em.fork()).create({
        id: 'run-a',
        status: 'running',
        teamId: null,
      });
      await insert('run-a', 1, 'tool_call', JSON.stringify({ id: 'call-50' }));
      await insert('run-a', 2, 'tool_call', JSON.stringify({ id: 'call-5' }));
      await insert(
        'run-a',
        4,
        'tool_result',
        JSON.stringify({ id: 'call-5', n: 2 }),
      );
      await insert(
        'run-a',
        3,
        'tool_result',
        JSON.stringify({ id: 'call-5', n: 1 }),
      );
      await insert(
        'run-a',
        5,
        'tool_result',
        JSON.stringify({ id: 'call-50' }),
      );

      const { call, result } = await dao.findToolCallPair('run-a', 'call-5');

      expect(call?.seq).toBe(2);
      expect(result?.seq).toBe(4);
    });
  });

  it('reads one run’s team notes oldest first, and counts them up to a seq', async () => {
    const note = (text: string): string =>
      JSON.stringify({ kind: 'fact', text, nodeId: 'a', conversationId: null });
    // Written out of seq order, beside rows of other kinds and another run.
    await insert('run-a', 7, 'team_note', note('third'));
    await insert('run-a', 2, 'team_note', note('first'));
    await insert('run-a', 3, 'message');
    await insert('run-b', 4, 'team_note', note('other run'));
    await insert('run-a', 5, 'team_note', note('second'));

    const rows = await dao.teamNoteRows('run-a');
    expect(rows.map((row) => row.seq)).toEqual([2, 5, 7]);
    expect(rows.map((row) => JSON.parse(row.payload).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(await dao.teamNoteCount('run-a')).toBe(3);
    expect(await dao.teamNoteCount('run-a', undefined, 5)).toBe(2);
  });

  it('reads one run’s stage changes oldest first, beside rows of other kinds and another run', async () => {
    const change = (stageId: string): string =>
      JSON.stringify({ action: 'finish', stageId });
    await insert('run-a', 9, 'stage_change', change('review'));
    await insert('run-a', 2, 'stage_change', change('plan'));
    await insert('run-a', 3, 'team_note');
    await insert('run-b', 4, 'stage_change', change('other run'));
    await insert('run-a', 5, 'stage_change', change('build'));
    await insert('run-a', 6, 'message');

    const rows = await dao.stageChangeRows('run-a');

    expect(rows.map((row) => row.seq)).toEqual([2, 5, 9]);
    expect(rows.map((row) => JSON.parse(row.payload).stageId)).toEqual([
      'plan',
      'build',
      'review',
    ]);
    expect(rows.every((row) => row.createdAt instanceof Date)).toBe(true);
    expect(await dao.stageChangeRows('run-none')).toEqual([]);
  });

  it('finds a send id only on a live user message in its own run', async () => {
    const payload = JSON.stringify({
      text: 'hello',
      clientMessageId: 'phone-1',
    });
    const add = (runId: string, seq: number, role: string, body = payload) =>
      dao.create({ runId, seq, kind: 'message', role, payload: body });
    await add('other-run', 0, 'user');
    await add('run-a', 0, 'assistant');
    const deleted = await add('run-a', 1, 'user');
    await orm.em
      .fork()
      .createQueryBuilder(Item)
      .update({ deletedAt: new Date() })
      .where({ id: deleted.id })
      .execute();
    await add('run-a', 2, 'user', 'invalid json');
    const expected = await add(
      'run-a',
      3,
      'user',
      JSON.stringify({ text: 'hello' }),
    );
    expect(await dao.userMessageByClientId('run-a', 'phone-1')).toBeNull();
    const accepted = await dao.acknowledgeUserMessage(
      'run-a',
      expected.id,
      'phone-1',
    );
    expect(JSON.parse(accepted.payload)).toEqual({
      text: 'hello',
      clientMessageId: 'phone-1',
    });
    expect((await dao.userMessageByClientId('run-a', 'phone-1'))?.id).toBe(
      expected.id,
    );
    expect(await dao.userMessageByClientId('run-a', 'missing')).toBeNull();
  });

  describe('getByRun', () => {
    it('selects a root hand-off history before limiting, excluding its callees and incoming calls', async () => {
      const add = (
        seq: number,
        memberId: string | null,
        kind: ItemKind,
        payload: unknown,
        role: 'user' | null = null,
      ) =>
        dao.create({
          runId: 'run-a',
          seq,
          memberId,
          kind,
          role,
          payload: JSON.stringify(payload),
        });
      await add(0, null, 'message', { text: 'original task' }, 'user');
      await add(1, 'root', 'tool_result', { text: 'completed work' });
      await add(2, 'root', 'call_started', {
        callId: 'call-1',
        calleeNodeId: 'helper',
      });
      await add(3, 'root', 'message', {
        callId: 'incoming',
        text: 'incoming call',
      });
      await add(4, 'root', 'tool_result', {
        parentToolUseId: 'delegate',
        text: 'delegate',
      });
      await add(5, 'root', 'call_started', {
        callId: 'nested',
        callerConversationId: 'incoming',
      });
      for (let seq = 6; seq < 216; seq += 1) {
        await add(seq, 'helper', 'message', { text: 'busy callee' });
      }
      await insert('another-run', 1);
      expect(
        (await dao.nodePoolContextRows('run-a', 'root')).map((row) => row.seq),
      ).toEqual([0, 1, 2]);
      for (let seq = 216; seq < 426; seq += 1) {
        await add(seq, 'root', 'message', { text: 'recent root work' });
      }
      const recent = await dao.nodePoolContextRows('run-a', 'root');
      expect(recent).toHaveLength(200);
      expect(recent[0]!.seq).toBe(226);
      expect(recent.at(-1)!.seq).toBe(425);
    });

    it('returns the whole transcript in seq order by default', async () => {
      // Inserted deliberately out of order — the ordering must come from the
      // query, not from insertion (rowid) order.
      await insert('run-a', 2);
      await insert('run-a', 0);
      await insert('run-a', 1);

      const items = await dao.getByRun('run-a');

      expect(items.map((i) => i.seq)).toEqual([0, 1, 2]);
    });

    it('treats afterSeq as a STRICT greater-than replay cursor', async () => {
      await insert('run-a', 0);
      await insert('run-a', 1);
      await insert('run-a', 2);

      // seq 1 already rendered → only seq 2 replays ($gt — a $gte regression
      // would re-send seq 1 here).
      expect((await dao.getByRun('run-a', 1)).map((i) => i.seq)).toEqual([2]);
      expect((await dao.getByRun('run-a', 2)).map((i) => i.seq)).toEqual([]);
      // The -1 default covers seq 0 (seq starts at 0, so 0 > -1).
      expect((await dao.getByRun('run-a', -1)).map((i) => i.seq)).toEqual([
        0, 1, 2,
      ]);
    });

    it('takes the NEWEST items when given a window, still in seq order', async () => {
      // REPORTED as "мы должны максимум загружать где-то 1,000 сообщений …
      // чтобы интерфейс не лагал". Measured on a real thread: 7,814 items are
      // 18.9MB where its newest 1,000 are 0.63MB.
      //
      // Both halves matter and they pull opposite ways: the LIMIT has to take
      // the tail of the conversation (a chat opens on what was last said), and
      // the rows have to come back ASCENDING because every reader downstream —
      // the fold, the call/result pairing, the turn scan — is written against a
      // transcript in the order it happened.
      for (let seq = 0; seq < 6; seq += 1) {
        await insert('run-a', seq);
      }

      expect(
        (await dao.getByRun('run-a', -1, undefined, { limit: 2 })).map(
          (i) => i.seq,
        ),
      ).toEqual([4, 5]);
    });

    it('takes the OLDEST items after afterSeq with take: oldest — the forward page', async () => {
      // A reader who jumped to a conversation's FIRST message must be able to
      // read on from there. The newest-end window cannot express it: asked for
      // two items after seq 1 it answers the last two of the whole run and
      // skips everything in between.
      for (let seq = 0; seq < 6; seq += 1) {
        await insert('run-a', seq);
      }

      expect(
        (
          await dao.getByRun('run-a', 1, undefined, {
            limit: 2,
            take: 'oldest',
          })
        ).map((i) => i.seq),
      ).toEqual([2, 3]);
      expect(
        (await dao.getByRun('run-a', 1, undefined, { limit: 2 })).map(
          (i) => i.seq,
        ),
      ).toEqual([4, 5]);
    });

    it('pages BACKWARDS with beforeSeq, and runs out at the start', async () => {
      for (let seq = 0; seq < 5; seq += 1) {
        await insert('run-a', seq);
      }

      const page = (before: number): Promise<number[]> =>
        dao
          .getByRun('run-a', -1, undefined, { limit: 2, beforeSeq: before })
          .then((rows) => rows.map((i) => i.seq));

      expect(await page(5)).toEqual([3, 4]);
      expect(await page(3)).toEqual([1, 2]);
      // A SHORT page is how the client learns it has reached the beginning —
      // there is no separate "hasMore" on the wire, so this is the signal.
      expect(await page(1)).toEqual([0]);
      expect(await page(0)).toEqual([]);
    });

    it('scopes a window to its own run, like every other read here', async () => {
      await insert('run-a', 0);
      await insert('run-b', 1);
      await insert('run-a', 2);

      expect(
        (await dao.getByRun('run-a', -1, undefined, { limit: 5 })).map(
          (i) => i.seq,
        ),
      ).toEqual([0, 2]);
    });

    it("never leaks another run's items", async () => {
      await insert('run-a', 0);
      await insert('run-b', 0);
      await insert('run-b', 1);

      const items = await dao.getByRun('run-b');

      expect(items.map((i) => i.runId)).toEqual(['run-b', 'run-b']);
      expect(items.map((i) => i.seq)).toEqual([0, 1]);
    });
  });

  describe('one delegate of a run', () => {
    /**
     * A run with two delegates (`toolu_a`, `toolu_b`) and the launching agent's
     * own rows. The copied `parentToolUseId` column is written only on a stamped
     * run; an unstamped one carries the id in its payload alone.
     */
    async function delegateRun(runId: string, stamped: boolean): Promise<void> {
      await new RunDao(orm.em.fork()).create({
        id: runId,
        status: 'running',
        teamId: null,
      });
      if (!stamped) {
        await orm.em
          .fork()
          .nativeUpdate(Run, { id: runId }, { payloadRefsVersion: null });
      }
      const at = new Date(Date.UTC(2026, 9, 27));
      const row = (
        seq: number,
        kind: ItemKind,
        parent: string | null,
        role = 'assistant',
      ) => ({
        id: `${runId}-${seq}`,
        runId,
        seq,
        kind,
        role,
        payload: JSON.stringify(
          parent === null
            ? { text: `m${seq}` }
            : { text: `m${seq}`, parentToolUseId: parent },
        ),
        memberId: 'eng',
        inCall: 'call-1',
        parentToolUseId: stamped ? parent : null,
        createdAt: at,
        updatedAt: at,
      });
      await orm.em
        .fork()
        .insertMany(Item, [
          row(1, 'tool_call', 'toolu_a'),
          row(2, 'message', 'toolu_a'),
          row(3, 'message', 'toolu_b'),
          row(4, 'message', null),
          row(5, 'message', 'toolu_a', 'user'),
          row(6, 'reasoning', 'toolu_a'),
          row(7, 'message', 'toolu_a'),
          row(8, 'tool_result', 'toolu_a'),
          row(9, 'message', 'toolu_b'),
          row(10, 'message', 'toolu_a'),
        ]);
    }

    const seqsOf = (rows: readonly Item[]) => rows.map((row) => row.seq);

    it.each<[string, boolean]>([
      ['stamped', true],
      ['unstamped', false],
    ])(
      'reads only one delegate’s rows of a %s run, the window keeping its newest or oldest rows',
      async (label, stamped) => {
        const runId = `run-${label}`;
        await delegateRun(runId, stamped);
        const delegate = (
          delegateId: string,
          afterSeq = -1,
          window?: HistoryWindow,
        ) =>
          dao
            .getByRun(runId, afterSeq, undefined, window, undefined, delegateId)
            .then(seqsOf);

        expect(await delegate('toolu_a')).toEqual([1, 2, 5, 6, 7, 8, 10]);
        expect(await delegate('toolu_b')).toEqual([3, 9]);
        expect(await delegate('toolu_none')).toEqual([]);
        expect(await delegate('toolu_a', 5)).toEqual([6, 7, 8, 10]);
        expect(await delegate('toolu_a', -1, { limit: 3 })).toEqual([7, 8, 10]);
        expect(
          await delegate('toolu_a', -1, { limit: 2, take: 'oldest' }),
        ).toEqual([1, 2]);
        expect(
          await delegate('toolu_a', 5, { limit: 2, take: 'oldest' }),
        ).toEqual([6, 7]);
        expect(
          await delegate('toolu_a', -1, { limit: 2, beforeSeq: 8 }),
        ).toEqual([6, 7]);
      },
    );

    it.each<[string, boolean]>([
      ['stamped', true],
      ['unstamped', false],
    ])(
      'counts each delegate’s assistant messages of a %s run up to maxSeq, reasoning and user rows aside',
      async (label, stamped) => {
        const runId = `run-${label}`;
        await delegateRun(runId, stamped);
        const counts = async (maxSeq: number) =>
          Object.fromEntries(await dao.delegateMessageCounts(runId, maxSeq));

        expect(await counts(100)).toEqual({ toolu_a: 3, toolu_b: 2 });
        expect(await counts(9)).toEqual({ toolu_a: 2, toolu_b: 2 });
      },
    );
  });

  describe('maxSeq', () => {
    it('returns the highest seq persisted for the run, scoped to that run', async () => {
      await insert('run-a', 0);
      await insert('run-a', 5);
      await insert('run-a', 3);
      await insert('run-b', 9);

      expect(await dao.maxSeq('run-a')).toBe(5);
    });

    it('returns the -1 sentinel for a run with no items yet', async () => {
      await insert('run-b', 0);

      expect(await dao.maxSeq('run-a')).toBe(-1);
    });
  });

  describe('maxSeqExcept', () => {
    const LESSON_KINDS: ItemKind[] = ['lessons', 'lesson_outcome'];

    it('answers the newest row whose kind is not one of those named', async () => {
      await insert('run-a', 1);
      await insert('run-a', 4, 'message');
      await insert('run-a', 6, 'lessons');
      await insert('run-a', 8, 'lesson_outcome');
      await insert('run-b', 9, 'message');

      expect(await dao.maxSeqExcept('run-a', LESSON_KINDS)).toBe(4);
      expect(await dao.maxSeq('run-a')).toBe(8);
    });

    it('answers -1 when every row of the run is of a named kind, or it has none', async () => {
      await insert('run-a', 2, 'lessons');
      await insert('run-b', 3, 'message');

      expect(await dao.maxSeqExcept('run-a', LESSON_KINDS)).toBe(-1);
      expect(await dao.maxSeqExcept('run-c', LESSON_KINDS)).toBe(-1);
    });
  });

  describe('latestMessageTextPerRun', () => {
    it('previews the ROOT conversation of a team run, not a callee inside a call', async () => {
      // REPORTED as a Dev Team row previewing the Engineer's "Fixed: 36/36…"
      // over the Manager's own words.
      await insert(
        'run-a',
        0,
        'message',
        JSON.stringify({ text: 'Manager: launching the Engineer' }),
      );
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({ text: 'Fixed: 36/36', callId: 'call-13' }),
      );

      expect((await dao.latestMessageTextPerRun(['run-a'])).get('run-a')).toBe(
        'Manager: launching the Engineer',
      );
    });

    it('previews the text of the highest-seq message item, per run', async () => {
      // Head row inserted FIRST so a "last row processed wins" reduction would
      // be caught too, not just a min/max mixup.
      await insert('run-a', 2, 'message', JSON.stringify({ text: 'a-latest' }));
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a-first' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b-only' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.get('run-a')).toBe('a-latest');
      expect(previews.get('run-b')).toBe('b-only');
      expect(previews.size).toBe(2);
    });

    it('skips a DELEGATE’s message — the preview is the parent thread’s', async () => {
      // REPORTED as "last message in thread card is incorrect - maybe it's
      // from subagent?". A delegate's messages are ordinary `message` rows on
      // the run, so the newest message of a fanned-out turn is routinely one
      // of theirs — and the sidebar previewed a conversation its row cannot
      // even open. The delegate's row is the HIGHEST seq here, so a dropped
      // filter surfaces as its text winning rather than as a lucky pass.
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'parent' }));
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({ text: 'delegate', parentToolUseId: 'toolu_01' }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('parent');
    });

    it('reduces over MESSAGE items only — trailing non-message items do not hide the preview', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'hello' }));
      // Non-message payloads carry no `text`, so a dropped kind filter would
      // surface as an absent preview here, not a lucky pass.
      await insert('run-a', 1, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ status: 'completed' }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('hello');
    });

    it('omits runs with no message items', async () => {
      await insert('run-a', 0, 'tool_call', JSON.stringify({ name: 'ls' }));
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'b' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('b');
    });

    it('omits a run whose head message has no text — never falls back to an earlier message', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'early' }));
      await insert('run-a', 1, 'message', JSON.stringify({}));

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      // Only the head row (seq 1) is ever fetched; its payload has no `text`,
      // so the run is simply absent — seq 0's 'early' is never consulted.
      expect(previews.has('run-a')).toBe(false);
    });

    it('labels an image-only newest message as images rather than previewing a blank line', async () => {
      // REPORTED as "Thread doesnt have last message, but other have": the
      // user answered with a screenshot alone, the message was stored with
      // `text: ""`, and the list handed that empty string to the row, which
      // drew no preview line until the agent's next message minutes later.
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'Open it' }));
      await insert(
        'run-a',
        1,
        'message',
        JSON.stringify({
          text: '',
          images: [{ id: 'shot.png', mediaType: 'image/png' }],
        }),
      );
      await insert(
        'run-b',
        0,
        'message',
        JSON.stringify({
          text: '',
          images: [
            { id: 'a.png', mediaType: 'image/png' },
            { id: 'b.png', mediaType: 'image/png' },
          ],
        }),
      );

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.get('run-a')).toBe('🖼 Image');
      expect(previews.get('run-b')).toBe('🖼 2 images');
    });

    it('tolerates a malformed head payload — absent, never a throw', async () => {
      await insert('run-a', 0, 'message', 'not json {');
      await insert('run-b', 0, 'message', JSON.stringify({ text: 'fine' }));

      const previews = await dao.latestMessageTextPerRun(['run-a', 'run-b']);

      expect(previews.has('run-a')).toBe(false);
      expect(previews.get('run-b')).toBe('fine');
    });

    it('previews the USER’s message when it is the newest', async () => {
      // REPORTED as "In thread i cant see last user message. I should see there
      // last AI or USER message". This preferred the AGENT's latest, so a
      // thread showed the previous answer for the whole time it was working on
      // what the user had just asked — stalest exactly when somebody goes
      // looking for the chat they were last in. Restore that preference and
      // this reads `agent reply`.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'assistant',
        payload: JSON.stringify({ text: 'agent reply' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'and now do this' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('and now do this');
    });

    it('falls back to the user’s message while the agent has not spoken', async () => {
      // A chat opened moments ago must still preview the question that started
      // it rather than showing an empty line until the first reply lands.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'first question' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('first question');
    });

    it('previews a message under ANY role once it is the newest', async () => {
      // The role no longer decides anything, which is what makes this rule
      // robust where the old one needed care: a CLI is free to spell its own
      // role, and the previous rule had to read every unknown spelling as "the
      // agent" or it would demote a reply to "the user is talking". Nothing has
      // to classify a role now — only order it.
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ text: 'the question' }),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        role: 'model',
        payload: JSON.stringify({ text: 'from the model' }),
      });

      const previews = await dao.latestMessageTextPerRun(['run-a']);

      expect(previews.get('run-a')).toBe('from the model');
    });

    it('answers for a chat list longer than SQLite’s expression-depth limit', async () => {
      // The head read must not put one OR term per run into a single WHERE:
      // SQLite refuses an OR chain deeper than 1,000 terms outright, which
      // reads as a 500 on the chat list and an empty sidebar. 1,201
      // runs cross that limit AND put a slice boundary mid-list, so a head
      // dropped between two reads shows up as a missing preview. Written in
      // one batched insert: a create per row makes this the slowest spec here.
      const runIds = Array.from({ length: 1_201 }, (_, i) => `run-${i}`);
      const at = new Date(1_000);
      await orm.em.fork().insertMany(
        Item,
        runIds.flatMap((runId, i) => [
          {
            id: `${runId}-0`,
            runId,
            seq: 0,
            kind: 'message' as const,
            role: 'user',
            payload: JSON.stringify({ text: `asked ${i}` }),
            createdAt: at,
            updatedAt: at,
          },
          {
            id: `${runId}-1`,
            runId,
            seq: 1,
            kind: 'message' as const,
            role: 'assistant',
            payload: JSON.stringify({ text: `answered ${i}` }),
            createdAt: at,
            updatedAt: at,
          },
        ]),
      );

      const previews = await dao.latestMessageTextPerRun(runIds);

      expect(previews).toEqual(
        new Map(runIds.map((runId, i) => [runId, `answered ${i}`])),
      );
    });

    it('scopes to the requested runIds; an empty request yields an empty map', async () => {
      await insert('run-a', 0, 'message', JSON.stringify({ text: 'a' }));
      await insert('run-c', 0, 'message', JSON.stringify({ text: 'c' }));

      const previews = await dao.latestMessageTextPerRun(['run-a']);
      expect([...previews.keys()]).toEqual(['run-a']);

      expect((await dao.latestMessageTextPerRun([])).size).toBe(0);
    });
  });

  describe('runPreviews', () => {
    async function runs(...ids: string[]): Promise<void> {
      for (const id of ids) {
        await new RunDao(orm.em.fork()).create({
          id,
          status: 'completed',
          teamId: null,
        });
      }
    }

    it('dates each run by its NEWEST row, of any kind, beside its preview line', async () => {
      // The sidebar's last activity. A tool row after the last message is
      // still the conversation doing something, so it is not the message that
      // dates it — and a run with no rows at all has no activity to report.
      await runs('run-a', 'run-empty');
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        payload: JSON.stringify({ text: 'hello' }),
        createdAt: new Date(1_000),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'tool_call',
        payload: JSON.stringify({ id: 't1', name: 'Bash', input: {} }),
        createdAt: new Date(5_000),
      });

      const previews = await dao.runPreviews(['run-a', 'run-empty']);

      expect(previews.get('run-a')).toEqual({
        lastMessage: 'hello',
        lastActivityAt: new Date(5_000),
      });
      expect(previews.get('run-empty')).toEqual({
        lastMessage: null,
        lastActivityAt: null,
      });
    });

    it('dates a run by its highest seq and skips a soft-deleted newest row', async () => {
      await runs('run-a', 'run-b');
      await dao.create({
        runId: 'run-a',
        seq: 2,
        kind: 'message',
        payload: JSON.stringify({ text: 'late seq, early clock' }),
        createdAt: new Date(2_000),
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'message',
        payload: JSON.stringify({ text: 'early seq, late clock' }),
        createdAt: new Date(9_000),
      });
      await dao.create({
        runId: 'run-b',
        seq: 1,
        kind: 'message',
        payload: JSON.stringify({ text: 'kept' }),
        createdAt: new Date(3_000),
      });
      await dao.create({
        runId: 'run-b',
        seq: 2,
        kind: 'message',
        payload: JSON.stringify({ text: 'deleted' }),
        createdAt: new Date(8_000),
        deletedAt: new Date(8_500),
      });

      const latest = await dao.latestItemAtPerRun(['run-a', 'run-b']);

      expect(latest.get('run-a')).toEqual(new Date(2_000));
      expect(latest.get('run-b')).toEqual(new Date(3_000));
    });
  });

  describe('firstUserMessageText', () => {
    /** One message row with an explicit role — what the title read filters on. */
    async function say(
      runId: string,
      seq: number,
      role: string,
      text: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        role,
        payload: JSON.stringify({ text }),
      });
    }

    it('answers with the opening user message, not the newest one', async () => {
      // Out of insertion order on purpose: the ordering must come from the
      // query. A title that tracked the LATEST message would rewrite the
      // sidebar row under the user at every turn, which is the whole reason
      // this is the mirror image of `latestMessageTextPerRun`.
      await say('run-a', 2, 'user', 'and one more thing');
      await say('run-a', 0, 'user', 'add auto chat titles');
      await say('run-a', 1, 'assistant', 'on it');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'add auto chat titles',
      );
    });

    it('ignores an assistant message that precedes the user’s', async () => {
      await say('run-a', 0, 'assistant', 'imported history');
      await say('run-a', 1, 'user', 'carry on from here');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'carry on from here',
      );
    });

    it('ignores non-message rows carrying earlier seqs', async () => {
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'system',
        role: null,
        payload: JSON.stringify({ text: 'session imported' }),
      });
      await say('run-a', 1, 'user', 'the real opening line');

      expect(await dao.firstUserMessageText('run-a')).toBe(
        'the real opening line',
      );
    });

    it('answers null for a run with no user message yet', async () => {
      await say('run-a', 0, 'assistant', 'nothing was asked');

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });

    it('answers null for a payload carrying no text', async () => {
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'message',
        role: 'user',
        payload: JSON.stringify({ images: [{ id: 'i1' }] }),
      });

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });

    it("never reads another run's opening message", async () => {
      await say('run-b', 0, 'user', 'a different conversation');

      expect(await dao.firstUserMessageText('run-a')).toBeNull();
    });
  });

  /**
   * The transcript search, against the real driver.
   *
   * Its service spec runs a hand-written double whose `searchByText` ignores the
   * terms it is handed and returns a fixed slice — so it pins the service's
   * plumbing and asserts nothing whatever about the predicate. Everything below
   * is the part only real SQL can answer.
   */
  describe('searchByText', () => {
    /** A row carrying the lowercased index form the write path stores. */
    async function indexed(
      runId: string,
      seq: number,
      searchText: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        payload: JSON.stringify({ text: searchText }),
        searchText,
      });
    }

    it('AND-s the terms, so more words narrow rather than widen', async () => {
      // The regression this exists for: `$and` widened to `$or` returns both
      // rows, and the service spec's double stays green either way because it
      // never reads the terms at all.
      //
      // The second row carries ONE of the two terms and not the other — which
      // is the whole discriminating power of this case. With two rows that each
      // match both terms or neither, `$or` returns the same set as `$and` and
      // the test passes against the regression it names.
      await indexed('run-a', 0, 'sizing the bloom filter');
      await indexed('run-a', 1, 'a kalman filter, no relation');

      const hits = await dao.searchByText('run-a', ['bloom', 'filter'], 50);

      expect(hits.map((hit) => hit.seq)).toEqual([0]);
    });

    it('answers the NEWEST matches first', async () => {
      await indexed('run-a', 0, 'bloom filter, first mention');
      await indexed('run-a', 1, 'bloom filter, second mention');

      const hits = await dao.searchByText('run-a', ['bloom'], 50);

      expect(hits.map((hit) => hit.seq)).toEqual([1, 0]);
    });

    it('carries the PAYLOAD, which the snippet is cut from', async () => {
      // The projection is a `fields` list; dropping `payload` from it would
      // leave every hit with an empty quote and no test would notice.
      await indexed('run-a', 0, 'sizing the bloom filter');

      expect(await dao.searchByText('run-a', ['bloom'], 50)).toEqual([
        expect.objectContaining({ payload: expect.any(String) }),
      ]);
    });

    it('honours the limit, and never leaves the run', async () => {
      await indexed('run-a', 0, 'bloom one');
      await indexed('run-a', 1, 'bloom two');
      await indexed('run-b', 2, 'bloom elsewhere');

      expect(await dao.searchByText('run-a', ['bloom'], 1)).toHaveLength(1);
      expect(await dao.searchByText('run-a', ['bloom'], 50)).toHaveLength(2);
    });

    it('matches a row the index holds and skips one it does not', async () => {
      // A row written before the column existed carries null, and must simply
      // not match — never throw, and never match everything.
      await indexed('run-a', 0, 'sizing the bloom filter');
      await insert('run-a', 1);

      expect(await dao.searchByText('run-a', ['bloom'], 50)).toHaveLength(1);
    });
  });

  describe('the timeline pair', () => {
    /** A message row with a role — the timeline's whole discriminator. */
    async function say(
      runId: string,
      seq: number,
      role: string,
      text: string,
    ): Promise<void> {
      await dao.create({
        runId,
        seq,
        kind: 'message',
        role,
        payload: JSON.stringify({ text }),
      });
    }

    it('gives the spine every row of the run, and none of their payloads', async () => {
      // The PROJECTION is the whole reason this method exists rather than
      // `getByRun`: `payload` is the TEXT column and a long transcript is most
      // of the database, so a lost `fields` list loads every diff and tool
      // result in the run to answer a question about none of them. The service
      // spec's fake DAO cannot catch that — it hands back whatever it was
      // given.
      await say('run-a', 0, 'user', 'the ask');
      await say('run-a', 1, 'assistant', 'the reply');
      await insert('run-a', 2, 'tool_call', JSON.stringify({ name: 'ls' }));
      await dao.create({
        runId: 'run-a',
        seq: 3,
        kind: 'message',
        role: 'user',
        memberId: 'engineer',
        payload: JSON.stringify({ text: 'to the callee' }),
      });
      await say('run-b', 0, 'user', 'another run');

      const spine = await dao.timelineSpine('run-a');

      // `nodeId` is what tells a message to the thread from one sent straight
      // to a team callee, so the projection has to carry it.
      expect(
        spine.map((row) => [row.seq, row.kind, row.role, row.memberId]),
      ).toEqual([
        [0, 'message', 'user', null],
        [1, 'message', 'assistant', null],
        [2, 'tool_call', null, null],
        [3, 'message', 'user', 'engineer'],
      ]);
      // Loaded, it would be the message text — so this goes red on a widened
      // projection rather than merely on a missing column.
      for (const row of spine) {
        expect((row as Partial<Item>).payload).toBeUndefined();
      }
    });

    it('reads only this run’s USER messages for the markers’ labels', async () => {
      await say('run-a', 0, 'user', 'the ask');
      await say('run-a', 1, 'assistant', 'the reply');
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );
      await insert('run-a', 3, 'tool_result', JSON.stringify({ out: 'x' }));
      await say('run-b', 0, 'user', 'another run');

      const rows = await dao.userMessagePayloadRows('run-a');

      expect(rows.map((row) => [row.seq, row.kind])).toEqual([[0, 'message']]);
      expect(JSON.parse(rows[0]!.payload)).toEqual({ text: 'the ask' });
    });

    it('orders both reads by seq, which is what the fold walks', async () => {
      // Insertion (rowid) order here is deliberately the reverse, so an ordering
      // that came from the table rather than the query fails.
      await insert(
        'run-a',
        4,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.2 } }),
      );
      await say('run-a', 3, 'user', 'second ask');
      await insert(
        'run-a',
        2,
        'turn_complete',
        JSON.stringify({ usage: { costUsd: 0.1 } }),
      );
      await say('run-a', 1, 'user', 'first ask');

      expect((await dao.timelineSpine('run-a')).map((r) => r.seq)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(
        (await dao.userMessagePayloadRows('run-a')).map((r) => r.seq),
      ).toEqual([1, 3]);
    });
  });

  describe('userMessagesInOrder', () => {
    it('reads the live user messages oldest first, whatever order they were written in', async () => {
      const add = (seq: number, role: string) =>
        dao.create({
          runId: 'run-a',
          seq,
          kind: 'message',
          role,
          payload: JSON.stringify({ text: `m${seq}` }),
        });
      await add(7, 'user');
      await add(2, 'user');
      await add(5, 'assistant');
      const deleted = await add(9, 'user');
      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: deleted.id })
        .execute();

      const rows = await dao.userMessagesInOrder('run-a');

      expect(rows.map((row) => row.seq)).toEqual([2, 7]);
    });
  });

  describe('existingSeqs', () => {
    it('answers only the seqs the run holds at or below the snapshot', async () => {
      await insert('run-a', 1);
      await insert('run-a', 4);
      await insert('run-a', 9);
      await insert('run-b', 2);

      const found = await dao.existingSeqs('run-a', [1, 2, 4, 9], 5);

      expect([...found].sort((a, b) => a - b)).toEqual([1, 4]);
    });
  });

  describe('poolHandOffRows', () => {
    it("reads a run's pool hand-offs up to the snapshot, and no other system row", async () => {
      const handOff = JSON.stringify({
        nodePoolHandOff: true,
        member: 2,
        fromMember: 1,
      });
      await insert('run-a', 1, 'system', handOff);
      await insert('run-a', 2, 'system', JSON.stringify({ severity: 'info' }));
      await insert('run-a', 3, 'error', handOff);
      await insert('run-a', 6, 'system', handOff);
      await insert('run-b', 4, 'system', handOff);

      expect((await dao.poolHandOffRows('run-a')).map((r) => r.seq)).toEqual([
        1, 6,
      ]);
      expect(
        (await dao.poolHandOffRows('run-a', undefined, 5)).map((r) => r.seq),
      ).toEqual([1]);
    });
  });

  describe('toolCallTimes', () => {
    it('reads the id and name of each tool row up to the snapshot, and nothing it said', async () => {
      await insert(
        'run-a',
        0,
        'tool_call',
        JSON.stringify({ id: 't1', name: 'Bash', input: { command: 'ls' } }),
      );
      await insert('run-a', 1, 'message');
      await insert(
        'run-a',
        2,
        'tool_result',
        JSON.stringify({ id: 't1', output: 'secret listing' }),
      );
      await insert('run-a', 3, 'tool_call', 'not json');
      await insert('run-a', 4, 'tool_call', JSON.stringify({ id: 't2' }));
      await insert(
        'run-a',
        5,
        'tool_call',
        JSON.stringify({ id: 't3', name: 'Read', parentToolUseId: 'toolu_a' }),
      );
      await insert('run-b', 0, 'tool_call', JSON.stringify({ id: 'x' }));

      const rows = await dao.toolCallTimes('run-a', 3);

      expect(
        rows.map(({ seq, kind, toolId, name, delegate }) => ({
          seq,
          kind,
          toolId,
          name,
          delegate,
        })),
      ).toEqual([
        {
          seq: 0,
          kind: 'tool_call',
          toolId: 't1',
          name: 'Bash',
          delegate: false,
        },
        {
          seq: 2,
          kind: 'tool_result',
          toolId: 't1',
          name: null,
          delegate: false,
        },
        {
          seq: 3,
          kind: 'tool_call',
          toolId: null,
          name: null,
          delegate: false,
        },
      ]);
      expect(
        (await dao.toolCallTimes('run-a', 5)).at(-1)?.delegate,
        'a sub-agent call is marked',
      ).toBe(true);
      expect(typeof rows[0]!.at).toBe('number');
      expect(rows[2]!.at).toBeGreaterThanOrEqual(rows[0]!.at);
    });

    it('reads a result the CLI marked as an error, and only a result', async () => {
      await insert(
        'run-a',
        0,
        'tool_call',
        JSON.stringify({ id: 't1', name: 'Bash', isError: true }),
      );
      await insert(
        'run-a',
        1,
        'tool_result',
        JSON.stringify({ id: 't1', isError: true }),
      );
      await insert(
        'run-a',
        2,
        'tool_result',
        JSON.stringify({ id: 't2', isError: false }),
      );
      await insert('run-a', 3, 'tool_result', JSON.stringify({ id: 't3' }));

      const rows = await dao.toolCallTimes('run-a', 3);

      expect(rows.map((row) => row.isError)).toEqual([
        false,
        true,
        false,
        false,
      ]);
    });
  });

  it('reads the callee and session of each call result in a seq range, and nothing of its reply', async () => {
    await insert(
      'run-a',
      1,
      'call_result',
      JSON.stringify({
        calleeNodeId: 'qa',
        sessionId: 'sess-1',
        answer: 'x'.repeat(10_000),
      }),
    );
    await insert(
      'run-a',
      2,
      'call_result',
      JSON.stringify({ calleeNodeId: 'qa' }),
    );
    await insert(
      'run-a',
      3,
      'call_result',
      JSON.stringify({ calleeNodeId: 'qa', sessionId: 'sess-boundary' }),
    );
    await insert(
      'run-a',
      4,
      'call_result',
      JSON.stringify({ calleeNodeId: 'dev', sessionId: 'sess-2' }),
    );

    expect(await dao.callResultSessions('run-a', 0, 2)).toEqual([
      { calleeMemberId: 'qa', sessionId: 'sess-1' },
      { calleeMemberId: 'qa', sessionId: null },
    ]);
    expect(await dao.callResultSessions('run-a', 3, 4)).toEqual([
      { calleeMemberId: 'dev', sessionId: 'sess-2' },
    ]);
  });

  describe('inCallBatch', () => {
    async function stamped(
      id: string,
      seq: number,
      inCall: string | null,
      runId = 'run-a',
    ): Promise<void> {
      const at = new Date(Date.UTC(2026, 9, 27));
      await orm.em.fork().insertMany(Item, [
        {
          id,
          runId,
          seq,
          kind: 'message' as const,
          payload: '{}',
          inCall,
          createdAt: at,
          updatedAt: at,
        },
      ]);
    }

    it('pages one run’s rows, stamped or not, by seq then id up to the seq it is given', async () => {
      await stamped('r-0', 0, 'call-1');
      await stamped('r-1b', 1, null);
      await stamped('r-1a', 1, '');
      await stamped('r-2', 2, 'call-2');
      await stamped('r-9', 9, 'call-9');
      await stamped('other', 1, 'call-1', 'run-b');

      const first = await dao.inCallBatch('run-a', null, 2, 2);
      const second = await dao.inCallBatch(
        'run-a',
        { seq: first[1]!.seq, id: first[1]!.id },
        2,
        2,
      );

      expect(first.map((row) => [row.id, row.inCall])).toEqual([
        ['r-0', 'call-1'],
        ['r-1a', ''],
      ]);
      expect(second.map((row) => [row.id, row.inCall])).toEqual([
        ['r-1b', null],
        ['r-2', 'call-2'],
      ]);
    });
    it('bounds a later batch’s seq from below, so it starts where the last one ended', async () => {
      const execute = vi.spyOn(orm.em.getConnection(), 'execute');

      await dao.inCallBatch('run-a', { seq: 40, id: 'r-40' }, 90, 10);

      const [sql, params] = execute.mock.calls[0]! as [string, unknown[]];
      execute.mockRestore();
      const bound = sql.indexOf('`seq` >= ?');
      expect(bound).toBeGreaterThan(-1);
      expect(params[sql.slice(0, bound).split('?').length - 1]).toBe(40);
    });

    it('reads each row’s payload', async () => {
      await insert('run-a', 0, 'subagent_info', '{"id":"d1","callId":"c1"}');

      const [row] = await dao.inCallBatch('run-a', null, 0, 10);

      expect(row!.payload).toBe('{"id":"d1","callId":"c1"}');
    });
  });

  describe('inCallRowsOfKind', () => {
    it('reads one kind of one run with its member, stamp and call, and a delegate declaration’s id', async () => {
      await dao.create({
        runId: 'run-a',
        seq: 0,
        kind: 'subagent_info',
        memberId: 'dev',
        inCall: 'call-old',
        payload: '{"id":"d1","callId":"c1"}',
      });
      await dao.create({
        runId: 'run-a',
        seq: 1,
        kind: 'subagent_info',
        memberId: 'dev',
        payload: '{"id":"d2"}',
      });
      await insert('run-a', 2, 'message', '{"text":"hi","callId":"c1"}');
      await insert('run-b', 3, 'subagent_info', '{"id":"d3","callId":"c3"}');

      const rows = await dao.inCallRowsOfKind('run-a', 'subagent_info');

      expect(
        rows
          .map(({ rowid: _rowid, ...row }) => row)
          .sort((a, b) => a.seq - b.seq),
      ).toEqual([
        {
          seq: 0,
          kind: 'subagent_info',
          memberId: 'dev',
          inCall: 'call-old',
          callId: 'c1',
          payloadId: 'd1',
        },
        {
          seq: 1,
          kind: 'subagent_info',
          memberId: 'dev',
          inCall: null,
          callId: null,
          payloadId: 'd2',
        },
      ]);
      expect(
        (await dao.inCallRowsOfKind('run-a', 'message')).map((row) => [
          row.seq,
          row.callId,
          row.payloadId,
        ]),
      ).toEqual([[2, 'c1', null]]);
    });

    it('stamps the rows it read by their rowid, and answers how many it changed', async () => {
      await insert('run-a', 0, 'message', '{"text":"a","callId":"c1"}');
      await insert('run-a', 1, 'message', '{"text":"b"}');
      const [first] = (await dao.inCallRowsOfKind('run-a', 'message')).filter(
        (row) => row.seq === 0,
      );

      const changed = await dao.rememberInCallAt('run-a', 'message', 'c1', [
        { rowid: first!.rowid, seq: 0, was: null },
      ]);

      expect(changed).toBe(1);
      expect(
        (await dao.getByRun('run-a', -1)).map((row) => [row.seq, row.inCall]),
      ).toEqual([
        [0, 'c1'],
        [1, null],
      ]);
    });

    it('leaves a row stamped since it was read, and another row that took a deleted one’s rowid', async () => {
      await insert('run-a', 0, 'message', '{"text":"a","callId":"c1"}');
      await insert('run-a', 1, 'message', '{"text":"b","callId":"c1"}');
      const read = await dao.inCallRowsOfKind('run-a', 'message');
      const [restamped, deleted] = [0, 1].map((seq) =>
        read.find((row) => row.seq === seq)!,
      );
      await orm.em
        .fork()
        .nativeUpdate(Item, { runId: 'run-a', seq: 0 }, { inCall: 'c1' });
      await orm.em.fork().nativeDelete(Item, { runId: 'run-a', seq: 1 });
      const taker = await insert('run-a', 2, 'message', '{"text":"c"}');
      await orm.em
        .fork()
        .getKysely<ChatTextDatabase>()
        .updateTable('items')
        .set({ rowid: deleted!.rowid })
        .where('id', '=', taker.id)
        .execute();

      const changed = await dao.rememberInCallAt(
        'run-a',
        'message',
        'c-wrong',
        [restamped!, deleted!].map(({ rowid, seq }) => ({
          rowid,
          seq,
          was: null,
        })),
      );

      expect(changed).toBe(0);
      expect(
        (await dao.getByRun('run-a', -1)).map((row) => [row.seq, row.inCall]),
      ).toEqual([
        [0, 'c1'],
        [2, null],
      ]);
    });

    it('reads every column from a covering index, never the row, whose later columns sit past its payload', async () => {
      await insert('run-a', 0, 'subagent_info', '{"id":"d1","callId":"c1"}');
      await dao.kindsOfRun('run-a');
      const { sent, stop } = await recordSentStatements(orm);

      await dao.inCallRowsOfKind('run-a', 'subagent_info');
      await dao.kindsOfRun('run-a');
      stop();

      expect(sent).toHaveLength(4);
      for (const { sql, params } of sent) {
        const plan = await orm.em
          .getConnection()
          .execute<{ detail: string }[]>(`explain query plan ${sql}`, params);
        expect(plan.map((step) => step.detail).join(' | ')).toMatch(
          /^SEARCH items USING COVERING INDEX /,
        );
      }
    });
  });

  describe('rowsOfKinds and rowsOfKindsBetween', () => {
    /**
     * Without ANALYZE statistics SQLite breaks a cost tie by the order the
     * indexes were made, so they are made here in a long-used profile's order:
     * `(runId, seq)` before `(runId, kind, seq)`.
     */
    beforeAll(async () => {
      const schema = orm.em.getKysely<ChatTextDatabase>().schema;
      await schema.dropIndex('items_run_id_seq_index').execute();
      await schema.dropIndex('items_run_id_kind_seq_index').execute();
      await schema
        .createIndex('items_run_id_seq_index')
        .on('items')
        .columns(['run_id', 'seq'])
        .execute();
      await schema
        .createIndex('items_run_id_kind_seq_index')
        .on('items')
        .columns(['run_id', 'kind', 'seq'])
        .execute();
    });

    /** The plan SQLite picks for the one statement `read` sends, its values bound as MikroORM runs it. */
    async function planOf(read: () => Promise<unknown>): Promise<string> {
      const connection = orm.em.getConnection();
      const execute = vi.spyOn(connection, 'execute');
      await read();
      const [sql, params] = execute.mock.calls[0]! as [string, unknown[]];
      execute.mockRestore();
      const plan = await connection.execute<{ detail: string }[]>(
        `explain query plan ${sql}`,
        params,
      );
      return plan.map((step) => step.detail).join(' | ');
    }

    it('returns the run’s rows of those kinds in seq order', async () => {
      await insert('run-a', 0, 'call_started', '{"callId":"c1"}');
      await insert('run-a', 1, 'message');
      await insert('run-a', 2, 'call_result', '{"callId":"c1"}');
      await insert('run-a', 3, 'call_started', '{"callId":"c2"}');
      await insert('run-b', 4, 'call_started', '{"callId":"c3"}');

      expect(
        (await dao.rowsOfKinds('run-a', ['call_started', 'call_result'])).map(
          (row) => [row.seq, row.kind],
        ),
      ).toEqual([
        [0, 'call_started'],
        [2, 'call_result'],
        [3, 'call_started'],
      ]);
      expect(
        (
          await dao.rowsOfKindsBetween(
            'run-a',
            ['call_started', 'call_result'],
            0,
            3,
          )
        ).map((row) => [row.seq, row.kind]),
      ).toEqual([
        [2, 'call_result'],
        [3, 'call_started'],
      ]);
    });

    it('reads through the (run, kind, seq) index rather than every row of the run', async () => {
      expect(
        await planOf(() =>
          dao.rowsOfKinds('run-a', ['call_started', 'call_result']),
        ),
      ).toMatch(/^SEARCH i0 USING INDEX items_run_id_kind_seq_index /);
      expect(
        await planOf(() =>
          dao.rowsOfKindsBetween(
            'run-a',
            ['call_started', 'call_result'],
            0,
            2_000,
          ),
        ),
      ).toMatch(/^SEARCH i0 USING INDEX items_run_id_kind_seq_index /);
      expect(
        await planOf(() =>
          dao.rowsOfKindsBetween('run-a', ['subagent_info'], 0, 2_000),
        ),
      ).toMatch(/^SEARCH i0 USING INDEX items_run_id_kind_seq_index /);
      expect(
        await planOf(() =>
          dao.rowsOfKinds('run-a', ['subagent_info'], { after: 3 }),
        ),
      ).toMatch(/^SEARCH i0 USING INDEX items_run_id_kind_seq_index /);
    });

    it('reads the rail’s kinds through the (run, kind, seq) index and answers them in seq order', async () => {
      await insert('run-a', 0, 'message', '{"text":"a"}');
      await insert('run-a', 1, 'reasoning');
      await insert('run-a', 2, 'tool_call');
      await insert('run-a', 3, 'message', '{"text":"b"}');
      const { sent, stop } = await recordSentStatements(orm);

      const rows = await dao.spineRowsOfKinds('run-a', [
        'message',
        'reasoning',
      ]);
      stop();

      const { sql, params } = sent[0]!;
      const plan = await orm.em
        .getConnection()
        .execute<{ detail: string }[]>(`explain query plan ${sql}`, params);
      expect(plan.map((step) => step.detail).join(' | ')).toMatch(
        /^SEARCH items USING INDEX items_run_id_kind_seq_index /,
      );
      expect(rows.map((row) => [row.seq, row.kind])).toEqual([
        [0, 'message'],
        [1, 'reasoning'],
        [3, 'message'],
      ]);
    });

    it('answers a single kind without repeating a row', async () => {
      await insert('run-a', 0, 'subagent_info', '{"id":"d1"}');
      await insert('run-a', 1, 'message');
      await insert('run-a', 2, 'subagent_info', '{"id":"d2"}');

      expect(
        (await dao.rowsOfKindsBetween('run-a', ['subagent_info'], -1, 2)).map(
          (row) => row.seq,
        ),
      ).toEqual([0, 2]);
    });
  });

  describe('timelineSpine', () => {
    it('stops at the snapshot seq it is given', async () => {
      await insert('run-a', 0, 'turn_complete', JSON.stringify({ usage: {} }));
      await insert('run-a', 5, 'turn_complete', JSON.stringify({ usage: {} }));

      expect(
        (await dao.timelineSpine('run-a', undefined, 4)).map((row) => row.seq),
      ).toEqual([0]);
    });

    it('reads a run longer than one window whole, a seq two rows share at the window edge included', async () => {
      const at = new Date(Date.UTC(2026, 9, 27));
      const rows = Array.from({ length: 5_001 }, (_, seq) => ({
        id: `r-${String(seq).padStart(5, '0')}`,
        runId: 'run-a',
        seq,
        kind: 'tool_call' as const,
        role: 'assistant',
        payload: '{}',
        createdAt: at,
        updatedAt: at,
      }));
      rows.push({ ...rows[4_999]!, id: 'r-04999-b' });
      for (let from = 0; from < rows.length; from += 1_000) {
        await orm.em.fork().insertMany(Item, rows.slice(from, from + 1_000));
      }

      const spine = await dao.timelineSpine('run-a');

      expect(spine).toHaveLength(5_002);
      expect(spine.slice(4_998).map((row) => row.id)).toEqual([
        'r-04998',
        'r-04999',
        'r-04999-b',
        'r-05000',
      ]);
    });
  });

  it("reads a run's shell rows in seq order, with the member each was filed under", async () => {
    // What the stranded-command repair folds: the open and the close are both
    // needed, in the order they happened, and the member is where the close has
    // to be filed. Inserted out of order so the ordering has to be the query's.
    await dao.create({
      runId: 'run-a',
      seq: 2,
      kind: 'shell_info',
      memberId: 'manager',
      payload: JSON.stringify({ id: 't1', workId: 'b1' }),
    });
    await dao.create({
      runId: 'run-a',
      seq: 0,
      kind: 'shell_open',
      memberId: 'manager',
      payload: JSON.stringify({ id: 't1', workId: 'b1' }),
    });
    await insert('run-a', 1);
    await dao.create({
      runId: 'run-b',
      seq: 0,
      kind: 'shell_open',
      payload: JSON.stringify({ id: 't9', workId: 'b9' }),
    });

    expect(
      (await dao.shellRows('run-a')).map((row) => [row.kind, row.memberId]),
    ).toEqual([
      ['shell_open', 'manager'],
      ['shell_info', 'manager'],
    ]);
    expect(
      (await dao.shellRowsOfRuns(['run-b', 'run-a'])).map((row) => [
        row.runId,
        row.kind,
      ]),
    ).toEqual([
      ['run-a', 'shell_open'],
      ['run-a', 'shell_info'],
      ['run-b', 'shell_open'],
    ]);
    expect(
      (await dao.shellRowsOfRuns(['run-b'])).map((row) => row.runId),
    ).toEqual(['run-b']);
    expect(await dao.shellRowsOfRuns([])).toEqual([]);
  });

  it("reads only the listed runs' sub-agent and monitor rows for the boot reconcile", async () => {
    await insert('run-a', 0, 'subagent_info', JSON.stringify({ id: 'T1' }));
    await insert('run-a', 1, 'message');
    await insert('run-b', 0, 'subagent_info', JSON.stringify({ id: 'T2' }));
    await insert(
      'run-a',
      2,
      'system',
      JSON.stringify({ monitors: [{ id: 'm1', event: 'start' }] }),
    );
    await insert('run-a', 3, 'system', JSON.stringify({ message: 'hi' }));
    await insert(
      'run-b',
      1,
      'system',
      JSON.stringify({ monitors: [{ id: 'm1', event: 'start' }] }),
    );

    expect(
      (await dao.subagentInfoRowsOfRuns(['run-a'])).map((row) => row.runId),
    ).toEqual(['run-a']);
    expect(
      (await dao.monitorRowsOfRuns(['run-a'])).map((row) => [
        row.runId,
        row.seq,
      ]),
    ).toEqual([['run-a', 2]]);
  });

  it('reads the boot reconcile rows of more runs than one query may name', async () => {
    const runIds = Array.from({ length: 501 }, (_, i) => `run-${i}`);
    for (const runId of runIds) {
      await insert(runId, 0, 'subagent_info', JSON.stringify({ id: runId }));
    }

    const rows = await dao.subagentInfoRowsOfRuns(runIds);

    expect(new Set(rows.map((row) => row.runId))).toEqual(new Set(runIds));
  });

  it('reads the named tool calls of one run, in seq order, and nothing else', async () => {
    // What every listing of open commands reads its words from: a shell row
    // names only its launching call.
    const call = (
      runId: string,
      seq: number,
      id: string,
      kind: ItemKind = 'tool_call',
    ) =>
      dao.create({
        runId,
        seq,
        kind,
        memberId: 'callee',
        payload: JSON.stringify({ id, name: 'Bash', input: { command: id } }),
      });
    await call('run-a', 2, 'toolu_b');
    await call('run-a', 0, 'toolu_a');
    await call('run-a', 1, 'toolu_other');
    await call('run-a', 3, 'toolu_a', 'tool_result');
    await call('run-b', 4, 'toolu_a');
    // A soft-deleted call is gone, though its id is asked for.
    const deleted = await call('run-a', 5, 'toolu_b');
    await orm.em
      .fork()
      .createQueryBuilder(Item)
      .update({ deletedAt: new Date() })
      .where({ id: deleted.id })
      .execute();

    const ids = (rows: { payload: unknown }[]): unknown[] =>
      rows.map((row) => JSON.parse(String(row.payload)).id);
    const found = await dao.toolCallsByIds('run-a', ['toolu_a', 'toolu_b']);
    expect(ids(found)).toEqual(['toolu_a', 'toolu_b']);
    expect(found.map((row) => [row.memberId, row.createdAt])).toEqual([
      ['callee', expect.any(Date)],
      ['callee', expect.any(Date)],
    ]);
    expect(await dao.toolCallsByIds('run-a', [])).toEqual([]);
  });

  describe('toolUsage and delegateToolCallSeqs', () => {
    const call = (
      seq: number,
      memberId: string | null,
      payload: Record<string, unknown> | string,
    ) =>
      dao.create({
        runId: 'run-a',
        seq,
        kind: 'tool_call',
        memberId,
        payload:
          typeof payload === 'string' ? payload : JSON.stringify(payload),
      });

    beforeEach(async () => {
      await call(0, 'eng', { name: 'Bash', toolKind: 'execute' });
      await call(1, 'eng', { name: 'Bash', toolKind: 'execute' });
      await call(2, 'eng', {
        name: 'Bash',
        toolKind: 'execute',
        parentToolUseId: 'toolu_agent',
      });
      await call(3, 'eng', {
        name: 'Read',
        toolKind: 'read',
        parentToolUseId: 'toolu_agent',
      });
      // A call that names no tool, and a payload that is not JSON at all.
      await call(4, 'eng', { toolKind: 'read' });
      await call(5, 'eng', 'not json');
      await dao.create({
        runId: 'other-run',
        seq: 0,
        kind: 'tool_call',
        memberId: 'eng',
        payload: JSON.stringify({ name: 'Bash', parentToolUseId: 'x' }),
      });
    });

    it('groups a run’s tool calls per lane, its own apart from its sub-agents’', async () => {
      const groups = await dao.toolUsage('run-a', 10);

      expect(
        groups.sort(
          (a, b) =>
            a.name.localeCompare(b.name) ||
            Number(a.delegate) - Number(b.delegate),
        ),
      ).toEqual([
        {
          memberId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: false,
          calls: 2,
        },
        {
          memberId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: true,
          calls: 1,
        },
        {
          memberId: 'eng',
          name: 'Read',
          toolKind: 'read',
          delegate: true,
          calls: 1,
        },
      ]);
    });

    it('answers the busiest groups first, up to the limit', async () => {
      const groups = await dao.toolUsage('run-a', 1);
      expect(groups).toEqual([
        {
          memberId: 'eng',
          name: 'Bash',
          toolKind: 'execute',
          delegate: false,
          calls: 2,
        },
      ]);
    });

    it('lists the seqs of the run’s sub-agent calls, up to a snapshot', async () => {
      expect((await dao.delegateToolCallSeqs('run-a')).sort()).toEqual([2, 3]);
      expect(await dao.delegateToolCallSeqs('run-a', undefined, 2)).toEqual([
        2,
      ]);
    });
  });

  it('counts each agent’s own tool calls per call, with the newest counted seq', async () => {
    const call = (
      seq: number,
      memberId: string,
      inCall: string | null,
      payload: Record<string, unknown> | string = { name: 'Bash' },
    ) =>
      dao.create({
        runId: 'run-a',
        seq,
        kind: 'tool_call',
        memberId,
        inCall,
        payload:
          typeof payload === 'string' ? payload : JSON.stringify(payload),
      });
    await call(1, 'qa', 'call-1');
    await call(2, 'qa', 'call-1', 'not json');
    // A sub-agent's call inside the same call is not the agent's own; an empty
    // id names no sub-agent, as the renderer's `subagentIdOf` reads it.
    await call(3, 'qa', 'call-1', { name: 'Bash', parentToolUseId: 'toolu_x' });
    await call(9, 'qa', 'call-1', { name: 'Bash', parentToolUseId: '' });
    // A deleted row, and one no agent owns.
    const deleted = await call(10, 'qa', 'call-1');
    await orm.em
      .fork()
      .createQueryBuilder(Item)
      .update({ deletedAt: new Date() })
      .where({ id: deleted.id })
      .execute();
    await dao.create({
      runId: 'run-a',
      seq: 11,
      kind: 'tool_call',
      memberId: null,
      inCall: 'call-1',
      payload: JSON.stringify({ name: 'Bash' }),
    });
    await call(4, 'qa', 'call-2');
    // Another agent answering a call of the same id is counted apart.
    await call(5, 'eng', 'call-2');
    // The run's own flow, and a row not stamped with its call yet.
    await call(6, 'qa', '');
    await call(7, 'qa', null);
    await dao.create({
      runId: 'other-run',
      seq: 8,
      kind: 'tool_call',
      memberId: 'qa',
      inCall: 'call-1',
      payload: JSON.stringify({ name: 'Bash' }),
    });

    const counts = await dao.ownToolCallsByCall('run-a');

    expect(
      counts.sort(
        (a, b) =>
          a.callId.localeCompare(b.callId) ||
          a.memberId.localeCompare(b.memberId),
      ),
    ).toEqual([
      { memberId: 'qa', callId: 'call-1', calls: 3, lastSeq: 9 },
      { memberId: 'eng', callId: 'call-2', calls: 1, lastSeq: 5 },
      { memberId: 'qa', callId: 'call-2', calls: 1, lastSeq: 4 },
    ]);
  });

  describe('rowsByPayloadId', () => {
    it('reads past a row whose payload is not JSON', async () => {
      await insert('run-ids', 1, 'tool_call', 'not json');
      await insert('run-ids', 2, 'tool_call', JSON.stringify({ id: 'call-1' }));

      const rows = await dao.rowsByPayloadId(
        'run-ids',
        ['tool_call'],
        ['call-1'],
      );

      expect(rows.map((row) => row.seq)).toEqual([2]);
    });

    it('matches the id exactly, among the asked kinds of one run, on the asked side of a page', async () => {
      const row = (
        runId: string,
        seq: number,
        kind: ItemKind,
        id: string,
      ): Promise<Item> => insert(runId, seq, kind, JSON.stringify({ id }));
      await row('run-ids', 4, 'tool_result', 'call-1');
      await row('run-ids', 1, 'tool_call', 'call-1');
      // `call-1` is a prefix of this id, not the id.
      await row('run-ids', 2, 'tool_call', 'call-10');
      await row('run-ids', 3, 'message', 'call-1');
      await row('run-ids', 6, 'tool_call', 'call-2');
      await row('run-other', 5, 'tool_call', 'call-1');

      const seqs = async (range?: SeqRange): Promise<number[]> =>
        (
          await dao.rowsByPayloadId(
            'run-ids',
            ['tool_call', 'tool_result'],
            ['call-1', 'call-2'],
            range,
          )
        ).map((item) => item.seq);

      expect(await seqs()).toEqual([1, 4, 6]);
      expect(await seqs({ before: 4 })).toEqual([1]);
      expect(await seqs({ after: 1 })).toEqual([4, 6]);
      expect(await seqs({ outside: { firstSeq: 2, lastSeq: 5 } })).toEqual([
        1, 6,
      ]);
    });
  });

  describe('newestRowsInCalls and rowsInCallsById', () => {
    interface Column {
      inCall?: string;
      role?: string;
      payloadId?: string;
      deleted?: boolean;
    }

    function rowsAt(
      runId: string,
      seqs: readonly number[],
      kind: ItemKind,
      column: Column = {},
    ) {
      const at = new Date(Date.UTC(2026, 9, 27));
      return seqs.map((seq) => ({
        id: `${runId}-${seq}`,
        runId,
        seq,
        kind,
        role: column.role ?? null,
        inCall: column.inCall ?? null,
        payloadId: column.payloadId ?? null,
        payload: JSON.stringify(
          column.payloadId === undefined ? {} : { id: column.payloadId },
        ),
        deletedAt: column.deleted === true ? at : null,
        createdAt: at,
        updatedAt: at,
      }));
    }

    async function place(rows: ReturnType<typeof rowsAt>): Promise<void> {
      await orm.em.fork().insertMany(Item, rows);
    }

    async function stampedRun(): Promise<void> {
      await new RunDao(orm.em.fork()).create({
        id: 'run-a',
        status: 'running',
        teamId: null,
      });
    }

    const seqsOf = (rows: readonly { seq: number }[]): number[] =>
      rows.map((row) => row.seq);

    it('returns the newest limit rows of each named call in seq order, and no row of an unnamed call or another run', async () => {
      await stampedRun();
      await place([
        ...rowsAt('run-a', [1, 2, 3, 4], 'tool_call', { inCall: 'call-1' }),
        ...rowsAt('run-a', [5, 6, 7, 8], 'tool_call', { inCall: 'call-2' }),
        ...rowsAt('run-a', [9, 10], 'tool_call', { inCall: 'call-3' }),
        ...rowsAt('run-b', [11], 'tool_call', { inCall: 'call-1' }),
      ]);

      const rows = await dao.newestRowsInCalls('run-a', ['call-1', 'call-2'], {
        kinds: ['tool_call'],
        limit: 2,
      });

      expect(seqsOf(rows)).toEqual([3, 4, 7, 8]);
    });

    it('bounds only the call its fromSeq names: a named call absent from the map keeps all its rows', async () => {
      await stampedRun();
      await place([
        ...rowsAt('run-a', [1, 3, 5, 7], 'tool_call', { inCall: 'call-1' }),
        ...rowsAt('run-a', [2, 4, 6], 'tool_call', { inCall: 'call-2' }),
      ]);

      const rows = await dao.newestRowsInCalls('run-a', ['call-1', 'call-2'], {
        kinds: ['tool_call'],
        limit: 10,
        fromSeq: new Map([['call-1', 5]]),
      });

      expect(seqsOf(rows)).toEqual([2, 4, 5, 6, 7]);
    });

    it('never answers a user message or a soft-deleted row, and answers an assistant message', async () => {
      await stampedRun();
      await place([
        ...rowsAt('run-a', [1], 'message', {
          inCall: 'call-1',
          role: 'assistant',
        }),
        ...rowsAt('run-a', [2], 'message', { inCall: 'call-1', role: 'user' }),
        ...rowsAt('run-a', [3], 'message', {
          inCall: 'call-1',
          role: 'assistant',
          deleted: true,
        }),
        ...rowsAt('run-a', [4], 'message', { inCall: 'call-1' }),
        ...rowsAt('run-a', [5], 'message', {
          inCall: 'call-1',
          role: 'user',
          deleted: true,
        }),
      ]);

      const rows = await dao.newestRowsInCalls('run-a', ['call-1'], {
        kinds: ['message'],
        limit: 10,
      });

      expect(seqsOf(rows)).toEqual([1, 4]);
    });

    it('reads more calls and kinds than one statement holds in two statements, with a turn of the event loop between them', async () => {
      await stampedRun();
      const calls = Array.from({ length: 401 }, (_, i) => `call-${i}`);
      await place(
        calls.flatMap((inCall, i) =>
          rowsAt('run-a', [2 * i + 1, 2 * i + 2], 'tool_call', { inCall }),
        ),
      );
      await dao.payloadRefsStamped('run-a');
      let turned = false;
      setImmediate(() => {
        turned = true;
      });

      let rows: WireRow[] = [];
      const statements = await statementsOf(async () => {
        rows = await dao.newestRowsInCalls('run-a', calls, {
          kinds: ['tool_call'],
          limit: 1,
        });
      });

      expect(statements).toBe(2);
      expect(turned).toBe(true);
      expect(seqsOf(rows)).toEqual(
        Array.from({ length: 401 }, (_, i) => 2 * i + 2),
      );
    });

    it('keeps the newest limit rows of each call across every kind it names', async () => {
      await stampedRun();
      await place([
        ...rowsAt('run-a', [1, 4, 5], 'tool_call', { inCall: 'call-1' }),
        ...rowsAt('run-a', [2, 3, 6], 'status', { inCall: 'call-1' }),
        ...rowsAt('run-a', [7, 10], 'tool_call', { inCall: 'call-2' }),
        ...rowsAt('run-a', [8, 9], 'status', { inCall: 'call-2' }),
      ]);

      const rows = await dao.newestRowsInCalls('run-a', ['call-1', 'call-2'], {
        kinds: ['tool_call', 'status'],
        limit: 2,
      });

      expect(seqsOf(rows)).toEqual([5, 6, 9, 10]);
    });

    it('sends one statement however many calls it names', async () => {
      await stampedRun();
      const calls = Array.from({ length: 30 }, (_, i) => `call-${i}`);
      await place(
        calls.flatMap((inCall, i) =>
          rowsAt('run-a', [i + 1], 'tool_call', { inCall }),
        ),
      );
      await dao.payloadRefsStamped('run-a');

      const one = await statementsOf(() =>
        dao.newestRowsInCalls('run-a', ['call-0'], {
          kinds: ['tool_call'],
          limit: 1,
        }),
      );
      const many = await statementsOf(() =>
        dao.newestRowsInCalls('run-a', calls, {
          kinds: ['tool_call'],
          limit: 1,
        }),
      );

      expect(one).toBe(1);
      expect(many).toBe(one);
    });

    it('answers each call only the replies to the ids it asked for, and nothing for an empty id list', async () => {
      await stampedRun();
      await place([
        ...rowsAt('run-a', [1], 'tool_result', {
          inCall: 'call-a',
          payloadId: 'toolu_1',
        }),
        ...rowsAt('run-a', [2], 'tool_result', {
          inCall: 'call-b',
          payloadId: 'toolu_1',
        }),
        ...rowsAt('run-a', [3], 'tool_result', {
          inCall: 'call-b',
          payloadId: 'toolu_2',
        }),
      ]);
      const replies = (idsByCall: [string, string[]][]) =>
        dao
          .rowsInCallsById('run-a', ['tool_result'], new Map(idsByCall))
          .then(seqsOf);

      expect(await replies([['call-a', ['toolu_1']]])).toEqual([1]);
      expect(
        await replies([
          ['call-a', ['toolu_1']],
          ['call-b', ['toolu_2']],
        ]),
      ).toEqual([1, 3]);
      expect(
        await replies([
          ['call-a', []],
          ['call-b', ['toolu_2']],
        ]),
      ).toEqual([3]);
      expect(await replies([['call-a', []]])).toEqual([]);
    });

    it('sends no statement for an empty map of calls', async () => {
      await stampedRun();

      expect(
        await statementsOf(() =>
          dao.rowsInCallsById('run-a', ['tool_result'], new Map()),
        ),
      ).toBe(0);
    });
  });

  describe('callHandOffRows', () => {
    it('reads the system rows that name both a member and a call, on the asked side of a page', async () => {
      const row = (
        runId: string,
        seq: number,
        kind: ItemKind,
        payload: Record<string, unknown>,
      ): Promise<Item> => insert(runId, seq, kind, JSON.stringify(payload));
      await row('run-h', 5, 'system', { member: 'c', callId: 'call-2' });
      await row('run-h', 1, 'system', { member: 'b', callId: 'call-1' });
      await row('run-h', 2, 'system', { member: 'b' });
      await row('run-h', 3, 'system', { callId: 'call-1' });
      await row('run-h', 4, 'message', { member: 'b', callId: 'call-1' });
      await row('run-h', 7, 'system', { member: null, callId: 'call-3' });
      await row('run-other', 6, 'system', { member: 'b', callId: 'call-1' });

      const seqs = async (range?: SeqRange): Promise<number[]> =>
        (await dao.callHandOffRows('run-h', range)).map((item) => item.seq);

      expect(await seqs()).toEqual([1, 5]);
      expect(await seqs({ after: 1 })).toEqual([5]);
      expect(await seqs({ before: 5 })).toEqual([1]);
      expect(await seqs({ outside: { firstSeq: 1, lastSeq: 4 } })).toEqual([5]);
    });
  });

  describe('toolCallsNamed', () => {
    it("reads one run's tool calls whose name, lowercased, is one of the names", async () => {
      const row = (
        runId: string,
        seq: number,
        kind: ItemKind,
        name: string,
      ): Promise<Item> =>
        insert(runId, seq, kind, JSON.stringify({ id: `t${seq}`, name }));
      await row('run-n', 2, 'tool_call', 'Task');
      await row('run-n', 1, 'tool_call', 'mcp__geniro__show_artifact');
      await row('run-n', 3, 'tool_result', 'Task');
      await row('run-n', 4, 'tool_call', 'Bash');
      await row('run-n', 5, 'tool_call', 'TASK');
      await row('run-other', 6, 'tool_call', 'Task');

      expect(
        (
          await dao.toolCallsNamed('run-n', [
            'task',
            'mcp__geniro__show_artifact',
          ])
        ).map((item) => item.seq),
      ).toEqual([1, 2, 5]);
      // The names are compared lowercased only on the row's side.
      expect(
        (await dao.toolCallsNamed('run-n', ['Task'])).map((item) => item.seq),
      ).toEqual([]);
      expect(await dao.toolCallsNamed('run-n', [])).toEqual([]);
    });
  });

  describe('turnEndingsAfter', () => {
    it('reads every live turn ending after the seq, skipping one that finished inside a turn', async () => {
      const ending = (
        runId: string,
        seq: number,
        kind: ItemKind,
        payload: Record<string, unknown>,
        memberId: string | null = null,
      ): Promise<Item> =>
        dao.create({
          runId,
          seq,
          kind,
          memberId,
          payload: JSON.stringify(payload),
        });
      await ending('run-t', 6, 'turn_complete', { usage: {} }, 'n1');
      await ending('run-t', 1, 'turn_complete', {});
      await ending('run-t', 2, 'turn_complete', { insideTurn: true });
      await ending('run-t', 3, 'turn_cancelled', {});
      await ending('run-t', 4, 'error', { insideTurn: false });
      await ending('run-t', 5, 'message', {});
      await ending('run-other', 7, 'turn_complete', {});
      const deleted = await ending('run-t', 8, 'turn_complete', {});
      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: deleted.id })
        .execute();

      const rows = await dao.turnEndingsAfter('run-t', 1);

      expect(
        rows.map((row) => [row.seq, row.memberId, row.kind, row.payload]),
      ).toEqual([
        [3, null, 'turn_cancelled', '{}'],
        [4, null, 'error', '{"insideTurn":false}'],
        [6, 'n1', 'turn_complete', '{"usage":{}}'],
      ]);
    });
  });

  describe('openTurnStartedAt', () => {
    /** One row of a 1:1 chat (no member unless named), written at `ms`. */
    const chatRow = (
      runId: string,
      seq: number,
      kind: ItemKind,
      ms: number,
      payload: Record<string, unknown> = {},
      extra: { role?: string; memberId?: string } = {},
    ): Promise<Item> =>
      dao.create({
        runId,
        seq,
        kind,
        role: extra.role ?? null,
        memberId: extra.memberId ?? null,
        payload: JSON.stringify(payload),
        createdAt: new Date(ms),
      });

    it('is null while nothing has been asked since the last turn ending', async () => {
      await chatRow('run-o', 0, 'message', 1_000, {}, { role: 'user' });
      await chatRow('run-o', 1, 'turn_complete', 2_000);

      expect(await dao.openTurnStartedAt('run-o')).toBeNull();
    });

    it('starts at the first message after the last ending of the chat itself', async () => {
      await chatRow('run-o', 0, 'message', 1_000, {}, { role: 'user' });
      await chatRow('run-o', 1, 'turn_complete', 2_000);
      // The opener: the FIRST user message after the last ending.
      await chatRow('run-o', 2, 'message', 3_000, {}, { role: 'user' });
      await chatRow('run-o', 3, 'message', 4_000, {}, { role: 'user' });
      // Each of these, read as an ending, would leave no message after it
      // and the answer null: a continuation that finished inside the turn, a
      // team member's ending, another run's ending.
      await chatRow('run-o', 4, 'turn_complete', 5_000, { insideTurn: true });
      await chatRow('run-o', 5, 'error', 5_500, {}, { memberId: 'n1' });
      await chatRow('run-other', 6, 'turn_complete', 6_000);
      // Measured inside the turn, but on a clock behind the opener's: the
      // opener's time stands.
      await chatRow('run-o', 7, 'turn_complete', 2_500, {
        insideTurn: true,
        usage: { durationMs: 100 },
      });

      expect(await dao.openTurnStartedAt('run-o')).toEqual(new Date(3_000));
    });

    it.each([
      ['integer', 1_500],
      ['real', 12.5],
    ])(
      'moves the start up to the newest continuation inside the turn whose duration is a JSON %s',
      async (_type, durationMs) => {
        await chatRow('run-o', 1, 'turn_complete', 2_000);
        await chatRow('run-o', 2, 'message', 3_000, {}, { role: 'user' });
        await chatRow('run-o', 3, 'turn_complete', 4_000, {
          insideTurn: true,
          usage: { durationMs: 900 },
        });
        await chatRow('run-o', 4, 'turn_complete', 5_000, {
          insideTurn: true,
          usage: { durationMs },
        });
        // Newer, but its duration is not a number.
        await chatRow('run-o', 5, 'turn_complete', 6_000, {
          insideTurn: true,
          usage: { durationMs: '7' },
        });
        // Newer, but a team member's.
        await chatRow(
          'run-o',
          6,
          'turn_complete',
          7_000,
          { insideTurn: true, usage: { durationMs: 7 } },
          { memberId: 'n1' },
        );

        expect(await dao.openTurnStartedAt('run-o')).toEqual(new Date(5_000));
      },
    );

    it('starts at the first reply the agent made on its own after the last ending', async () => {
      await chatRow('run-o', 0, 'message', 1_000, {}, { role: 'user' });
      await chatRow('run-o', 1, 'turn_complete', 2_000);
      // None of these is the main agent working: a background command's end,
      // a delegate's own call, a team member's reply, another run's reply.
      await chatRow('run-o', 2, 'shell_info', 2_500, { id: 'call-1' });
      await chatRow(
        'run-o',
        3,
        'tool_call',
        2_600,
        { id: 'call-2', parentToolUseId: 'toolu_1' },
        { role: 'assistant' },
      );
      await chatRow(
        'run-o',
        4,
        'message',
        2_700,
        {},
        {
          role: 'assistant',
          memberId: 'n1',
        },
      );
      await chatRow(
        'run-other',
        5,
        'message',
        2_800,
        {},
        {
          role: 'assistant',
        },
      );
      await chatRow('run-o', 6, 'message', 3_000, {}, { role: 'assistant' });
      await chatRow(
        'run-o',
        7,
        'tool_call',
        3_500,
        { id: 'call-3' },
        {
          role: 'assistant',
        },
      );

      expect(await dao.openTurnStartedAt('run-o')).toEqual(new Date(3_000));
    });

    it('gives the turn to a message the user sent after the agent took up work on its own', async () => {
      await chatRow('run-o', 1, 'turn_complete', 2_000);
      await chatRow('run-o', 2, 'reasoning', 3_000, {}, { role: 'assistant' });
      await chatRow('run-o', 3, 'message', 4_000, {}, { role: 'user' });

      expect(await dao.openTurnStartedAt('run-o')).toEqual(new Date(4_000));
    });

    it('opens no work of the agent’s own before any turn has ended', async () => {
      await chatRow('run-o', 0, 'message', 1_000, {}, { role: 'assistant' });

      expect(await dao.openTurnStartedAt('run-o')).toBeNull();
    });
  });

  describe('pullRequestCandidates', () => {
    it('reads only the tool results inside the seq window it is given', async () => {
      const url = JSON.stringify({ result: 'https://github.com/o/r/pull/1' });
      for (const seq of [1, 5, 9]) {
        await insert('run-pr', seq, 'tool_result', url);
      }
      await insert('run-pr', 6, 'tool_result', url);
      await insert('run-pr', 7, 'message', url);

      const window = await dao.pullRequestCandidates('run-pr', 1, undefined, 6);
      const open = await dao.pullRequestCandidates('run-pr', 1);

      // Both edges: the window opens after its first seq and closes on its last.
      expect(window.map((row) => row.seq)).toEqual([5, 6]);
      expect(open.map((row) => row.seq)).toEqual([5, 6, 9]);
    });
  });

  describe('pullRequestNamingCandidates', () => {
    const pr = { owner: 'acme', repo: 'web', number: 7207 };
    const url = JSON.stringify({
      text: 'Review https://github.com/Acme/Web/pull/7207',
    });

    it.each(PULL_REQUEST_NAMING_KINDS)(
      'returns a %s row naming the pull request',
      async (kind) => {
        await insert(`run-${kind}`, 1, kind, url);
        expect(
          await dao.pullRequestNamingCandidates(`run-${kind}`, pr, -1, 9),
        ).toEqual([url]);
      },
    );

    it('returns only rows of this run, inside the seq range, of a kind a thread names pull requests in', async () => {
      await insert('run-named', 3, 'tool_result', url);
      await insert('run-named', 4, 'reasoning', url);
      await insert('run-other', 9, 'message', url);

      // Both edges: the range opens after its first seq and closes on its last.
      expect(
        await dao.pullRequestNamingCandidates('run-named', pr, 2, 3),
      ).toEqual([url]);
      expect(
        await dao.pullRequestNamingCandidates('run-named', pr, 3, 99),
      ).toEqual([]);
      expect(
        await dao.pullRequestNamingCandidates('run-named', pr, 0, 2),
      ).toEqual([]);
    });

    it('returns a gh pr command carrying the number, and no row holding the number alone', async () => {
      const command = JSON.stringify({
        input: { command: 'gh pr comment 7207 --body ok' },
      });
      await insert('run-cmd', 1, 'tool_call', command);
      await insert(
        'run-cmd',
        2,
        'message',
        JSON.stringify({ text: 'PR 7207' }),
      );

      expect(
        await dao.pullRequestNamingCandidates('run-cmd', pr, -1, 9),
      ).toEqual([command]);
    });

    it('skips a row once it is deleted', async () => {
      const row = await insert('run-deleted', 1, 'message', url);
      expect(
        await dao.pullRequestNamingCandidates('run-deleted', pr, -1, 9),
      ).toEqual([url]);

      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: row.id })
        .execute();

      expect(
        await dao.pullRequestNamingCandidates('run-deleted', pr, -1, 9),
      ).toEqual([]);
    });
  });

  describe('toolResultSeqAt', () => {
    it('answers the newest tool result at or before the moment, else the oldest after, else null', async () => {
      const em = orm.em.fork();
      const rows: [string, string, number, Item['kind'], string][] = [
        ['r-1', 'run-at', 2, 'tool_result', '2026-10-13T20:00:00.000Z'],
        ['r-2', 'run-at', 5, 'tool_result', '2026-10-13T20:36:40.000Z'],
        // Newer in time than the moment, so never the "at or before" answer.
        ['r-3', 'run-at', 9, 'tool_result', '2026-10-13T20:40:00.000Z'],
        // A row of another kind between them is not a tool result.
        ['m-1', 'run-at', 6, 'message', '2026-10-13T20:36:45.000Z'],
        ['o-1', 'run-other', 7, 'tool_result', '2026-10-13T20:36:46.000Z'],
      ];
      for (const [id, runId, seq, kind, at] of rows) {
        await em.getRepository(Item).insert({
          id,
          runId,
          seq,
          kind,
          payload: '{}',
          createdAt: new Date(at),
          updatedAt: new Date(at),
        });
      }

      expect(
        await dao.toolResultSeqAt(
          'run-at',
          new Date('2026-10-13T20:36:47.487Z'),
        ),
      ).toBe(5);
      expect(
        await dao.toolResultSeqAt(
          'run-at',
          new Date('2026-10-13T19:00:00.000Z'),
        ),
      ).toBe(2);
      expect(
        await dao.toolResultSeqAt(
          'run-none',
          new Date('2026-10-13T20:36:47.487Z'),
        ),
      ).toBeNull();
    });
  });

  describe('earliestToolResultTimes', () => {
    it('dates each seq by its earliest tool result, whichever row was written first', async () => {
      const em = orm.em.fork();
      // Two tool results share a seq. The LATER one is written first, so insertion order and
      // time order disagree, and only the time order may decide which one a seq is dated by.
      await em.getRepository(Item).insert({
        id: 'result-written-first',
        runId: 'run-a',
        seq: 4,
        kind: 'tool_result',
        payload: '{}',
        createdAt: new Date('2026-08-10T12:00:00.000Z'),
        updatedAt: new Date('2026-08-10T12:00:00.000Z'),
      });
      await em.getRepository(Item).insert({
        id: 'result-written-second',
        runId: 'run-a',
        seq: 4,
        kind: 'tool_result',
        payload: '{}',
        createdAt: new Date('2026-08-09T12:00:00.000Z'),
        updatedAt: new Date('2026-08-09T12:00:00.000Z'),
      });

      const times = await dao.earliestToolResultTimes('run-a', [4, 7]);

      expect(times.get(4)).toEqual(new Date('2026-08-09T12:00:00.000Z'));
      expect(times.has(7)).toBe(false);
    });
  });

  describe('earliestToolResultTimesOf', () => {
    it('dates captures of several runs in one call, each run kept apart and only tool results counted', async () => {
      const em = orm.em.fork();
      const rows: [string, string, number, Item['kind'], string][] = [
        // run-batch-a seq 4: the tool result written second is the earlier one.
        ['a-late', 'run-batch-a', 4, 'tool_result', '2026-08-12T12:00:00.000Z'],
        [
          'a-early',
          'run-batch-a',
          4,
          'tool_result',
          '2026-08-09T12:00:00.000Z',
        ],
        // The same seq in another run is that run's own row, not run-a's.
        ['b-tool', 'run-batch-b', 4, 'tool_result', '2026-08-13T12:00:00.000Z'],
        // A message sharing run-b's seq 5 cannot date a pull request.
        ['b-message', 'run-batch-b', 5, 'message', '2026-08-13T12:00:00.000Z'],
      ];
      for (const [id, runId, seq, kind, at] of rows) {
        await em.getRepository(Item).insert({
          id,
          runId,
          seq,
          kind,
          payload: '{}',
          createdAt: new Date(at),
          updatedAt: new Date(at),
        });
      }

      const times = await dao.earliestToolResultTimesOf([
        { runId: 'run-batch-a', seq: 4 },
        { runId: 'run-batch-b', seq: 4 },
        { runId: 'run-batch-b', seq: 5 },
        { runId: 'run-batch-c', seq: 4 },
      ]);

      expect(times.get('run-batch-a')).toEqual(
        new Map([[4, new Date('2026-08-09T12:00:00.000Z')]]),
      );
      expect(times.get('run-batch-b')).toEqual(
        new Map([[4, new Date('2026-08-13T12:00:00.000Z')]]),
      );
      expect(times.has('run-batch-c')).toBe(false);
    });

    it('answers every capture when they outnumber one lookup, so no capture is dropped at a chunk edge', async () => {
      const em = orm.em.fork();
      const captures: { runId: string; seq: number }[] = [];
      for (let seq = 0; seq < 205; seq += 1) {
        await em.getRepository(Item).insert({
          id: `chunk-${seq}`,
          runId: 'run-chunk',
          seq,
          kind: 'tool_result',
          payload: '{}',
          createdAt: new Date('2026-08-10T12:00:00.000Z'),
          updatedAt: new Date('2026-08-10T12:00:00.000Z'),
        });
        captures.push({ runId: 'run-chunk', seq });
      }

      const times = await dao.earliestToolResultTimesOf(captures);

      expect(times.get('run-chunk')?.size).toBe(205);
      expect(times.get('run-chunk')?.get(204)).toEqual(
        new Date('2026-08-10T12:00:00.000Z'),
      );
    });
  });

  describe('payloadCharsBetween', () => {
    it('sums the stored payload characters strictly after afterSeq, up to and including maxSeq', async () => {
      await insert('run-a', 0, 'message', 'a'.repeat(10));
      await insert('run-a', 1, 'message', 'b'.repeat(20));
      await insert('run-a', 2, 'message', 'c'.repeat(30));
      await insert('run-a', 3, 'message', 'd'.repeat(40));

      expect(await dao.payloadCharsBetween('run-a', 0, 2)).toBe(50);
      expect(await dao.payloadCharsBetween('run-a', 1, 3)).toBe(70);
      expect(await dao.payloadCharsBetween('run-a', -1, 3)).toBe(100);
    });

    it('counts characters of the stored text, not its bytes', async () => {
      const payload = JSON.stringify({ text: 'привет, мир' });
      await insert('run-a', 0, 'message', payload);

      expect(await dao.payloadCharsBetween('run-a', -1, 0)).toBe(
        payload.length,
      );
      expect(Buffer.byteLength(payload)).toBeGreaterThan(payload.length);
    });

    it('counts only the run it is asked about', async () => {
      await insert('run-a', 0, 'message', 'a'.repeat(10));
      await insert('run-b', 0, 'message', 'b'.repeat(500));

      expect(await dao.payloadCharsBetween('run-a', -1, 9)).toBe(10);
    });

    it('leaves a soft-deleted row out of the sum', async () => {
      await insert('run-a', 0, 'message', 'a'.repeat(10));
      const deleted = await insert('run-a', 1, 'message', 'b'.repeat(20));
      await insert('run-a', 2, 'message', 'c'.repeat(40));
      await orm.em
        .fork()
        .createQueryBuilder(Item)
        .update({ deletedAt: new Date() })
        .where({ id: deleted.id })
        .execute();

      expect(await dao.payloadCharsBetween('run-a', -1, 2)).toBe(50);
    });

    it('answers 0 for an empty range, and for a run with no rows', async () => {
      await insert('run-a', 0, 'message', 'a'.repeat(10));

      expect(await dao.payloadCharsBetween('run-a', 0, 0)).toBe(0);
      expect(await dao.payloadCharsBetween('run-a', 5, 3)).toBe(0);
      expect(await dao.payloadCharsBetween('no-such-run', -1, 9)).toBe(0);
    });
  });
});
