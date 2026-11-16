import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

import {
  EntityManager,
  type FilterQuery,
  type FindOptions,
} from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';
import type {
  AliasableExpression,
  Expression,
  ExpressionBuilder,
  SqlBool,
} from 'kysely';

import { Item } from '../../runs/entity/item.entity';
import type { ItemKind } from '../../runs/runs.types';
import type {
  ChatTextDatabase,
  HistoryWindow,
  OwnToolCallCount,
  RunPreview,
  SeqRange,
  ToolCallTime,
  WireRow,
} from '../chat.types';
import { idBatches } from '../utils/id-batches';
import { parseJsonColumn, payloadString } from '../utils/json-util';
import { messagePreview, messageText } from '../utils/message-preview';
import {
  PAYLOAD_REF_KEYS,
  PAYLOAD_REFS_VERSION,
  type PayloadRefs,
} from '../utils/payload-refs';
import {
  PULL_REQUEST_NAMING_KINDS,
  pullRequestNamingNeedles,
} from '../utils/pull-request-capture';
import type { ToolUsageGroup } from '../utils/tool-usage';
import { USAGE_ITEM_KINDS } from '../utils/usage-figures';
import {
  CHAT_WALL_CLOCK_ROW_KINDS,
  WALL_CLOCK_CARD_KINDS,
  WALL_CLOCK_ROW_KINDS,
  type WallClockRow,
} from '../utils/wall-worked';

/**
 * The SIDEBAR PREVIEW's one exclusion: a message a DELEGATE wrote.
 *
 * REPORTED as "I see last message in thread card is incorrect - maybe it's from
 * subagent? We sohuld only take last messages from parent thread". A delegate's
 * messages are ordinary `message` rows ON the run — that is what lets the
 * transcript nest them under their block — so the newest message of a fanned-out
 * turn is routinely one of theirs, and the row then previewed a conversation the
 * user cannot see from the sidebar at all.
 *
 * TWIN PARSER of `apps/ui/src/renderer/chats/subagent-payload.ts`
 * `subagentIdOf`: `parentToolUseId` is the key the daemon writes and the
 * renderer reads to place a row under its delegate, and a rename on either side
 * must be a rename on both.
 *
 * Matched against the payload TEXT rather than through `json_extract`, because
 * the column is TEXT holding JSON and every other reader here treats it that
 * way. The cost of the crude match is a message whose own words contain the key
 * name being skipped, which loses that run one preview line and falls back to
 * the message before it — the safe direction, and far cheaper than the failure
 * it prevents.
 */
const NOT_A_DELEGATE = {
  $not: { payload: { $like: '%parentToolUseId%' } },
} as const;

/**
 * The preview's second exclusion: a message written INSIDE an agent-to-agent
 * call. A team run's sidebar line is the conversation the user has with its
 * trigger member; a callee's rows carry the call's id and are that callee's
 * conversation, which the row cannot open either. REPORTED as a Dev Team row
 * previewing the Engineer's "Fixed: 36/36…" over the Manager's own words. The
 * same crude-match trade as {@link NOT_A_DELEGATE}.
 */
const NOT_IN_A_CALL = {
  $not: { payload: { $like: '%"callId":%' } },
} as const;

/**
 * How many ids one {@link ItemDao.rowsByPayloadId} query names at once. MikroORM
 * writes every value into the statement's text, so this bounds a statement's
 * length rather than a bind-parameter limit — and each batch is another pass
 * over the run's rows of those kinds.
 */
const PAYLOAD_ID_BATCH = 1000;

/** The filter for rows on the asked side of a page. */
function seqFilter(range: SeqRange | undefined): {
  $or?: FilterQuery<Item>[];
  seq?: { $lt?: number; $gt?: number };
} {
  if (range === undefined) {
    return {};
  }
  if ('outside' in range) {
    return {
      $or: [
        { seq: { $lt: range.outside.firstSeq } },
        { seq: { $gt: range.outside.lastSeq } },
      ],
    };
  }
  return 'before' in range
    ? { seq: { $lt: range.before } }
    : { seq: { $gt: range.after } };
}

/** {@link seqFilter} for a Kysely read of `items`. */
function seqRangeOf(
  eb: ExpressionBuilder<ChatTextDatabase, 'items'>,
  range: SeqRange,
): Expression<SqlBool> {
  if ('outside' in range) {
    return eb.or([
      eb('seq', '<', range.outside.firstSeq),
      eb('seq', '>', range.outside.lastSeq),
    ]);
  }
  return 'before' in range
    ? eb('seq', '<', range.before)
    : eb('seq', '>', range.after);
}

/**
 * One field of an item's JSON payload, read straight off the column: unlike
 * {@link payloadField}, a row whose payload is not JSON makes SQLite's
 * `json_extract` throw.
 */
function payloadPath<T = string | null>(
  eb: ExpressionBuilder<ChatTextDatabase, 'items'>,
  path: string,
) {
  return eb.fn<T>('json_extract', [eb.ref('payload'), eb.val(path)]);
}

/** A row's `insideTurn` stamp read as 0 or 1 — absent reads as 0. */
function insideTurnOf(eb: ExpressionBuilder<ChatTextDatabase, 'items'>) {
  return eb.fn<number>('coalesce', [
    payloadPath<number | null>(eb, '$.insideTurn'),
    eb.val(0),
  ]);
}

/**
 * One field of an item's JSON payload — null, never a thrown error, for a row
 * whose payload is not JSON: SQLite's `json_extract` throws on malformed text,
 * which would fail the whole read over one row.
 */
function payloadField<T = string | null>(
  eb: ExpressionBuilder<ChatTextDatabase, 'items'>,
  path: string,
) {
  return eb.fn<T>('json_extract', [
    eb
      .case()
      .when(eb.fn('json_valid', [eb.ref('payload')]), '=', 1)
      .then(eb.ref('payload'))
      .else(eb.val('{}'))
      .end(),
    eb.val(path),
  ]);
}

type SpineRow = Pick<
  Item,
  'id' | 'seq' | 'kind' | 'role' | 'memberId' | 'inCall' | 'createdAt'
>;

/** {@link SpineRow} without `inCall`, which sits after the payload's pages. */
type RailRow = Omit<SpineRow, 'inCall'>;

function railRowOf(row: {
  id: string;
  seq: number;
  kind: Item['kind'];
  role: Item['role'];
  member_id: Item['memberId'];
  created_at: number;
}): RailRow {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    memberId: row.member_id,
    createdAt: new Date(row.created_at),
  };
}

const WIRE_COLUMNS = [
  'id',
  'run_id',
  'member_id',
  'seq',
  'kind',
  'role',
  'payload',
  'created_at',
  'in_call',
] as const;

function wireRowOf(row: {
  id: string;
  run_id: string;
  member_id: Item['memberId'];
  seq: number;
  kind: Item['kind'];
  role: Item['role'];
  payload: string;
  created_at: number;
  in_call: Item['inCall'];
}): WireRow {
  return {
    id: row.id,
    runId: row.run_id,
    memberId: row.member_id,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    payload: row.payload,
    createdAt: new Date(row.created_at),
    inCall: row.in_call,
  };
}

/**
 * Ordered on the `(runId, kind, seq)` index's own columns, for a read of one
 * run or of several: ordered by `seq` alone, SQLite (with no `ANALYZE`
 * statistics) walks `(runId, seq)` instead and reads every row of each run or
 * window to keep the few of these kinds. {@link inSeqOrder} puts seq order back.
 */
const KIND_ROWS_ORDER: FindOptions<Item>['orderBy'] = [
  { runId: 'asc' },
  { kind: 'asc' },
  { seq: 'asc' },
];

/**
 * The `IN` list a kind read filters on. SQLite folds a one-value `IN` into an
 * equality and, with a seq window, plans that on `(runId, seq)` again; a value
 * listed twice keeps it a list, answering the same rows.
 */
function kindList(kinds: readonly ItemKind[]): ItemKind[] {
  return kinds.length === 1 ? [kinds[0]!, kinds[0]!] : [...kinds];
}

/** Rows read in {@link KIND_ROWS_ORDER}, back in seq order within each run (a stable sort). */
function inSeqOrder<T extends Pick<Item, 'runId' | 'seq'>>(rows: T[]): T[] {
  return rows.sort((a, b) =>
    a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : a.seq - b.seq,
  );
}

/** Spine rows read per statement; the event loop turns between windows. */
const SPINE_WINDOW_ROWS = 5_000;

/** Segment-end seeks per stretch before the event loop is given a turn. */
const SPINE_SEEKS_PER_TURN = 200;

function spineRowOf(row: {
  id: string;
  seq: number;
  kind: Item['kind'];
  role: Item['role'];
  member_id: Item['memberId'];
  in_call: Item['inCall'];
  created_at: number;
}): SpineRow {
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    role: row.role,
    memberId: row.member_id,
    inCall: row.in_call,
    createdAt: new Date(row.created_at),
  };
}

const PAYLOAD_REF_PATHS = {
  payload_id: `$.${PAYLOAD_REF_KEYS.payloadId}`,
  tool_name_lower: `$.${PAYLOAD_REF_KEYS.toolNameLower}`,
  parent_tool_use_id: `$.${PAYLOAD_REF_KEYS.parentToolUseId}`,
  call_id: `$.${PAYLOAD_REF_KEYS.callId}`,
} as const;

type PayloadRefColumn = keyof typeof PAYLOAD_REF_PATHS;

/**
 * One of the payload fields `utils/payload-refs.ts` copies into a column: the
 * indexed column on a run whose rows are all stamped, the payload itself on one
 * the boot sweep has not reached (`ItemDao.payloadRefsStamped`).
 */
function payloadRef(
  eb: ExpressionBuilder<ChatTextDatabase, 'items'>,
  column: PayloadRefColumn,
  stamped: boolean,
): AliasableExpression<string | null> {
  if (stamped) {
    return eb.ref(column);
  }
  const field = payloadField<string | null>(eb, PAYLOAD_REF_PATHS[column]);
  return column === 'tool_name_lower'
    ? eb.fn<string | null>('lower', [field])
    : field;
}

/** A row as {@link ItemDao.inCallBatch} reads it. */
type InCallRow = Pick<
  Item,
  'id' | 'seq' | 'kind' | 'memberId' | 'inCall' | 'payload'
>;

/** A row as {@link ItemDao.inCallRowsOfKind} reads it, keyed by rowid. */
type InCallIndexRow = Pick<
  Item,
  'seq' | 'kind' | 'memberId' | 'inCall' | 'callId' | 'payloadId'
> & { rowid: number };

@Injectable()
export class ItemDao extends BaseDao<Item> {
  /** Runs seen stamped under the current rule — a stamp never reverts within a build. */
  private readonly stampedRuns = new Set<string>();

  constructor(em: EntityManager) {
    super(em, Item);
  }

  async acknowledgeUserMessage(
    runId: string,
    itemId: string,
    clientMessageId: string,
  ): Promise<Item> {
    const em = this.em.fork();
    await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .updateTable('items')
      .set((eb) => ({
        payload: eb.fn<string>('json_set', [
          eb.ref('payload'),
          eb.val('$.clientMessageId'),
          eb.val(clientMessageId),
        ]),
      }))
      .where('id', '=', itemId)
      .where('run_id', '=', runId)
      .where('kind', '=', 'message')
      .where('role', '=', 'user')
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirstOrThrow();
    return this.getRepo(em).findOneOrFail({ id: itemId, runId });
  }

  /** One acknowledged user send, scoped to its run and excluding deleted rows. */
  async userMessageByClientId(
    runId: string,
    clientMessageId: string,
  ): Promise<Item | null> {
    const em = this.em.fork();
    const row = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', '=', 'message')
      .where('role', '=', 'user')
      .where('deleted_at', 'is', null)
      .where(
        (eb) => payloadField<string>(eb, '$.clientMessageId'),
        '=',
        clientMessageId,
      )
      .orderBy('seq', 'asc')
      .executeTakeFirst();
    return row === undefined
      ? null
      : this.getRepo(em).findOne({ id: row.id, runId });
  }

  /**
   * Ordered transcript for a run. `afterSeq` is the replay cursor: pass the
   * highest seq the client has already rendered to fetch only newer items
   * (default -1 returns the whole transcript, since seq starts at 0).
   *
   * `window` is the OTHER direction — the newest `limit` items, optionally
   * those before `beforeSeq`, for a client paging backwards through a long
   * conversation; or, with `take: 'oldest'`, the OLDEST `limit` after
   * `afterSeq`, for one reading forward from a point it jumped to. Measured on a real thread: 7,814 items are 18.9MB of payload
   * where its newest 1,000 are 0.63MB, so opening a chat used to move thirty
   * times the bytes anybody was going to look at. The rows still come back in
   * ASCENDING seq whichever way they were selected, because every reader
   * downstream — the fold, the pairing, the turn scan — is written against a
   * transcript in the order it happened.
   */
  async getByRun(
    runId: string,
    afterSeq = -1,
    txEm?: EntityManager,
    window?: HistoryWindow,
    /** Only rows whose `inCall` is one of these — one conversation of a team run. */
    inCalls?: readonly string[],
    /** Only one delegate's rows: those whose `parentToolUseId` is this launching call id. */
    delegateId?: string,
  ): Promise<Item[]> {
    if (delegateId !== undefined) {
      return this.delegateRows(runId, afterSeq, delegateId, window, txEm);
    }
    const conversation =
      inCalls === undefined ? {} : { inCall: { $in: [...inCalls] } };
    if (window) {
      const oldestFirst = window.take === 'oldest';
      const rows = await this.getRepo(txEm).find(
        {
          runId,
          ...conversation,
          seq: {
            $gt: afterSeq,
            ...(window.beforeSeq === undefined
              ? {}
              : { $lt: window.beforeSeq }),
          },
        },
        // Newest FIRST for the selection, so the limit takes the tail of the
        // conversation rather than its beginning, then reversed below — unless
        // the caller asked for the beginning of the range.
        {
          orderBy: { seq: oldestFirst ? 'asc' : 'desc' },
          limit: window.limit,
          disableIdentityMap: true,
        },
      );
      return oldestFirst ? rows : rows.reverse();
    }
    return this.getRepo(txEm).find(
      { runId, ...conversation, seq: { $gt: afterSeq } },
      // Read-only replay path: skip identity-map tracking so a long transcript
      // doesn't accumulate managed entities in the forked EM.
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * One delegate's rows of a run, read as {@link nodePoolContextRows} reads its
   * picks: the ids come from a Kysely read on the copied column or, on a run the
   * boot sweep has not reached, the payload; the rows then load as entities. A
   * window keeps its newest (or oldest) `limit` ids, returned in seq order.
   */
  private async delegateRows(
    runId: string,
    afterSeq: number,
    delegateId: string,
    window: HistoryWindow | undefined,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    let picks = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('deleted_at', 'is', null)
      .where('seq', '>', afterSeq)
      .where(
        (eb) => payloadRef(eb, 'parent_tool_use_id', stamped),
        '=',
        delegateId,
      );
    if (window?.beforeSeq !== undefined) {
      picks = picks.where('seq', '<', window.beforeSeq);
    }
    if (window !== undefined) {
      picks = picks
        .orderBy('seq', window.take === 'oldest' ? 'asc' : 'desc')
        .limit(window.limit);
    }
    const ids = (await picks.execute()).map((row) => row.id);
    return this.rowsWithIds(ids, em);
  }

  /** Recent work of the member's own conversation, not its callees' traffic. */
  async nodePoolContextRows(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    // The newest 200, picked newest first, then read back oldest first.
    const ids = (
      await em
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select('id')
        .where('run_id', '=', runId)
        .where('deleted_at', 'is', null)
        .where((eb) =>
          eb.or([
            eb.and([
              eb('member_id', '=', memberId),
              eb('kind', 'in', ['message', 'tool_call', 'tool_result']),
              eb(payloadRef(eb, 'call_id', stamped), 'is', null),
              eb(payloadRef(eb, 'parent_tool_use_id', stamped), 'is', null),
            ]),
            eb.and([
              eb('member_id', '=', memberId),
              eb('kind', 'in', ['call_started', 'call_result']),
              eb(payloadPath(eb, '$.callerConversationId'), 'is', null),
            ]),
            eb.and([
              eb('member_id', 'is', null),
              eb('kind', '=', 'message'),
              eb('role', '=', 'user'),
            ]),
          ]),
        )
        .orderBy('seq', 'desc')
        .limit(200)
        .execute()
    ).map((head) => head.id);
    return this.rowsWithIds(ids, em);
  }

  /**
   * Every agent-pool hand-off of a run, in seq order — the `system` row the
   * executor writes when a member's conversation moves to another pool member (a
   * call's carries its `callId`). Stops at `maxSeq`, as the waterfall's reads do.
   */
  async poolHandOffRows(
    runId: string,
    txEm?: EntityManager,
    maxSeq?: number,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    let query = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('deleted_at', 'is', null)
      .where('kind', '=', 'system')
      .where((eb) => eb(payloadPath(eb, '$.nodePoolHandOff'), 'is not', null));
    if (maxSeq !== undefined) {
      query = query.where('seq', '<=', maxSeq);
    }
    const ids = (await query.execute()).map((head) => head.id);
    return this.rowsWithIds(ids, em);
  }

  /**
   * The rows a Kysely read picked by id, loaded as entities in seq order — the
   * second half of a read whose filter is a payload path, which only Kysely
   * can say.
   */
  private async rowsWithIds(
    ids: readonly string[],
    em: EntityManager,
  ): Promise<Item[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.getRepo(em).find(
      { id: { $in: [...ids] } },
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * One agent-to-agent call's rows of these kinds — its `call_started` and the
   * callee's turns inside it — by the call id the rows carry.
   */
  async rowsOfCall(
    runId: string,
    callId: string,
    kinds: readonly ItemKind[],
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const heads = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', 'in', [...kinds])
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'call_id', stamped), '=', callId)
      .execute();
    return this.rowsWithIds(
      heads.map((head) => head.id),
      em,
    );
  }

  /**
   * The two halves of ONE tool call of a run, by the CLI's own call id.
   *
   * Looked up by `payload_id` rather than by scanning the transcript, because
   * the row being looked for can be arbitrarily far back: a `pnpm dev` detached
   * at the start of a long session is exactly the command someone opens the
   * output of, and by then its launch sits thousands of items behind.
   */
  async findToolCallPair(
    runId: string,
    callId: string,
    txEm?: EntityManager,
  ): Promise<{ call: Item | null; result: Item | null }> {
    const matched = (
      await this.rowsByPayloadId(
        runId,
        ['tool_call', 'tool_result'],
        [callId],
        undefined,
        txEm,
      )
    ).sort((a, b) => a.seq - b.seq);
    return {
      call: matched.find((row) => row.kind === 'tool_call') ?? null,
      // The LAST result wins: a transcript written before `ItemSeqAllocator`
      // can hold more than one row for a pair, and the later one is the one
      // that describes how the call actually ended.
      result:
        [...matched].reverse().find((row) => row.kind === 'tool_result') ??
        null,
    };
  }

  /**
   * Each run's LATEST message, whoever said it, as the chat list's preview
   * line ({@link messagePreview}: its text, or a label for a message that is
   * pictures alone).
   *
   * TWIN PARSER: `apps/ui/src/renderer/chats/chat-preview.ts` decides the same
   * thing in the renderer (`previewsThread` for the open thread's live items,
   * `previewMessageOf` for a replayed window), and `threadPreviewOf`
   * (`utils/message-preview.ts`) for the live `run_status.preview` push on each
   * message it admits. They take turns writing this one line — the list value
   * on a refetch, the others as messages stream or replay — so a rule held on
   * only one side is a preview whose owner depends on which source spoke last.
   *
   * It used to be the AGENT's latest, falling back to any role while the agent
   * had not spoken, deliberately: "the last message" alternates owner at every
   * turn boundary — the user's sentence echoed back while the agent works, then
   * the reply, then the user's again. REPORTED as "In thread i cant see last
   * user message. I should see there last AI or USER message": what that rule
   * costs is that a thread shows the previous answer for the whole time it is
   * working on what you just asked, so the row is stalest exactly when you go
   * looking for the chat you were last in. Alternation is the price of the
   * asked-for behaviour, and a preview tracks where a conversation has got to.
   *
   * One read per run, walking its `(run_id, kind, seq)` index from the newest
   * message down and stopping at the first that is the run's own: the
   * exclusions are text matches, so a read that collected every run's heads at
   * once had to open the payload of EVERY message of every listed run.
   * Measured on a 5.9 GB profile: 0.6 s of an archive listing's 0.8 s, and one
   * statement of the old shape took 7 s on a cold cache, because a `kind`
   * beside an OR of `(run_id, seq)` pairs sends SQLite to the `kind` index.
   * Runs with no message items (or a head with neither text nor pictures) are
   * simply absent from the map.
   */
  async latestMessageTextPerRun(
    runIds: string[],
    txEm?: EntityManager,
  ): Promise<Map<string, string>> {
    const repo = this.getRepo(txEm);
    const previews = new Map<string, string>();
    for (const runId of runIds) {
      // Newest first, ties broken the same way as the reading below, so the
      // row found is the one that reading would let win.
      const head = await repo.findOne(
        { runId, kind: 'message', $and: [NOT_A_DELEGATE, NOT_IN_A_CALL] },
        {
          orderBy: { seq: 'desc', createdAt: 'desc', id: 'desc' },
          fields: ['seq', 'payload'],
          disableIdentityMap: true,
        },
      );
      if (head === null) {
        continue;
      }
      const preview = messagePreview(head.payload);
      if (preview !== null) {
        previews.set(runId, preview);
        continue;
      }
      // `(runId, seq)` is not a key: a transcript written before
      // `ItemSeqAllocator` can hold two messages on one seq. The newest saying
      // nothing leaves the line to another message on the SAME seq — never to
      // an earlier one — in the order an unordered read once let them take
      // turns in (the sidebar flicking between the user's line and the
      // agent's): `createdAt`, then the primary key so the answer is total.
      const sameSeq = await repo.find(
        {
          runId,
          seq: head.seq,
          kind: 'message',
          $and: [NOT_A_DELEGATE, NOT_IN_A_CALL],
        },
        {
          orderBy: { createdAt: 'asc', id: 'asc' },
          fields: ['payload'],
          disableIdentityMap: true,
        },
      );
      for (const row of sameSeq) {
        const fallback = messagePreview(row.payload);
        if (fallback !== null) {
          previews.set(runId, fallback);
        }
      }
    }
    return previews;
  }

  /**
   * When each run's newest transcript row was written — its last ACTIVITY,
   * which no write to the run row can move (`RunWire.lastActivityAt`).
   *
   * One read per run, each a seek on the `(run_id, seq)` index projected to
   * one column, rather than one aggregate over every row the runs hold: the
   * list asks this for every thread it shows, and the busiest of them run to
   * tens of thousands of rows. A run with no rows is absent from the map.
   */
  async latestItemAtPerRun(
    runIds: string[],
    txEm?: EntityManager,
  ): Promise<Map<string, Date>> {
    const repo = this.getRepo(txEm);
    const out = new Map<string, Date>();
    for (const runId of runIds) {
      const newest = await repo.findOne(
        { runId },
        {
          orderBy: { seq: 'desc' },
          fields: ['createdAt'],
          disableIdentityMap: true,
        },
      );
      if (newest) {
        out.set(runId, newest.createdAt);
      }
    }
    return out;
  }

  /**
   * Everything the list projection reads off a run's transcript: its preview
   * line ({@link latestMessageTextPerRun}) and its last activity
   * ({@link latestItemAtPerRun}), keyed by run. Every run asked about gets an
   * entry, so a caller's `get(id) ?? null` means only "never asked".
   */
  async runPreviews(
    runIds: string[],
    txEm?: EntityManager,
  ): Promise<Map<string, RunPreview>> {
    const [texts, times] = [
      await this.latestMessageTextPerRun(runIds, txEm),
      await this.latestItemAtPerRun(runIds, txEm),
    ];
    return new Map(
      runIds.map((runId) => [
        runId,
        {
          lastMessage: texts.get(runId) ?? null,
          lastActivityAt: times.get(runId) ?? null,
        },
      ]),
    );
  }

  /**
   * Text of the run's FIRST user message — what a chat is named after when its
   * CLI offers no title of its own.
   *
   * The opening message rather than the newest, and the opposite choice from
   * {@link latestMessageTextPerRun} for the opposite reason: a preview line
   * tracks where a conversation has got to, while a title names what it was
   * ever about, and a title that followed the newest message would rewrite the
   * sidebar under the user as they worked.
   *
   * One bounded query — the oldest user-role message row alone, projected to its
   * payload. `null` for a run with no user message yet, or one whose payload
   * carries no text; `ChatTitleService` leaves such a run unnamed rather than
   * titling it with a placeholder.
   */
  firstUserMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.firstMessageText(runId, 'user', txEm);
  }

  /**
   * Text of the run's first ASSISTANT message — the other half of the exchange
   * a generated title is written from.
   *
   * It exists because the opening message is routinely a slash command and a
   * URL (`/geniro:implement https://…`), which names nothing: the agent's first
   * reply is where the subject of the conversation is first stated in words.
   */
  firstAssistantMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.firstMessageText(runId, 'assistant', txEm);
  }

  /**
   * The NEWEST message of one role in a run, or null when it has none.
   *
   * The mirror of {@link firstMessageText}, and it exists for the title ask: a
   * conversation opened with a bare URL has nothing nameable in its first
   * exchange (measured — the naming model answers "I need to see the Slack
   * thread…" rather than a title), while its third turn is about real work.
   * Re-asking with the same two messages would only reproduce the same
   * refusal, so a retry has to be given what the conversation has SINCE said.
   */
  lastUserMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, 'user', 'desc', txEm);
  }

  /** The newest thing the agent said, for the same reason. */
  lastAssistantMessageText(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, 'assistant', 'desc', txEm);
  }

  private firstMessageText(
    runId: string,
    role: 'user' | 'assistant',
    txEm?: EntityManager,
  ): Promise<string | null> {
    return this.edgeMessageText(runId, role, 'asc', txEm);
  }

  /** One end of a run's messages of one role — the oldest or the newest. */
  private async edgeMessageText(
    runId: string,
    role: 'user' | 'assistant',
    direction: 'asc' | 'desc',
    txEm?: EntityManager,
  ): Promise<string | null> {
    const [row] = await this.getRepo(txEm).find(
      { runId, kind: 'message', role },
      {
        // The same total ordering `latestMessageTextPerRun` needs, for the same
        // reason: a transcript written before `ItemSeqAllocator` can hold two
        // rows on one seq, so seq alone does not decide which is first — or,
        // read the other way, which is last.
        orderBy: { seq: direction, createdAt: direction, id: direction },
        fields: ['payload'],
        limit: 1,
        disableIdentityMap: true,
      },
    );
    return row ? messageText(row.payload) : null;
  }

  /**
   * One team member's clock rows — its turn boundaries and approval cards
   * (`WALL_CLOCK_ROW_KINDS`), every conversation of it, in `seq` order — what
   * its wall-measured turns are folded from (`utils/wall-worked`).
   */
  async nodeWallClockRows(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<WallClockRow[]> {
    return this.wallClockRows(runId, memberId, WALL_CLOCK_ROW_KINDS, txEm);
  }

  /**
   * A 1:1 chat's clock rows — its user messages, turn endings and approval
   * cards (`CHAT_WALL_CLOCK_ROW_KINDS`, the rows with no member), in `seq`
   * order. A message is read for its role and time only: only a USER's opens a
   * turn, and its text is never needed.
   */
  async chatWallClockRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<WallClockRow[]> {
    return this.wallClockRows(runId, null, CHAT_WALL_CLOCK_ROW_KINDS, txEm);
  }

  /**
   * The clock rows of one agent (`nodeId`, or null for a chat's), projected:
   * a card down to its `id` and `callId`, the two fields the fold reads (an
   * `approval_request` carries the whole plan, patch or question set), a
   * message down to its role — and only a user's is read.
   */
  private async wallClockRows(
    runId: string,
    memberId: string | null,
    kinds: readonly ItemKind[],
    txEm?: EntityManager,
  ): Promise<WallClockRow[]> {
    const plainKinds = kinds.filter(
      (kind) => kind !== 'message' && !WALL_CLOCK_CARD_KINDS.has(kind),
    );
    const [rows, messages, cards] = await Promise.all([
      this.getRepo(txEm).find(
        { runId, memberId, kind: { $in: plainKinds } },
        {
          orderBy: { seq: 'asc' },
          fields: ['seq', 'kind', 'memberId', 'role', 'createdAt', 'payload'],
          disableIdentityMap: true,
        },
      ),
      kinds.includes('message')
        ? this.getRepo(txEm).find(
            { runId, memberId, kind: 'message', role: 'user' },
            {
              orderBy: { seq: 'asc' },
              fields: ['seq', 'kind', 'memberId', 'role', 'createdAt'],
              disableIdentityMap: true,
            },
          )
        : Promise.resolve([]),
      (txEm ?? this.em.fork())
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select((eb) => {
          return [
            'seq',
            'kind',
            'member_id',
            'created_at',
            payloadField(eb, '$.id').as('card_id'),
            payloadField(eb, '$.callId').as('call_id'),
          ];
        })
        .where('run_id', '=', runId)
        .where('member_id', memberId === null ? 'is' : '=', memberId)
        .where('deleted_at', 'is', null)
        .where(
          'kind',
          'in',
          kinds.filter((kind) => WALL_CLOCK_CARD_KINDS.has(kind)),
        )
        .orderBy('seq', 'asc')
        .execute(),
    ]);
    return [
      ...rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        memberId: row.memberId,
        role: row.role,
        createdAt: row.createdAt,
        payload: row.payload,
      })),
      ...messages.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        memberId: row.memberId,
        role: row.role,
        createdAt: row.createdAt,
        payload: '{}',
      })),
      ...cards.map((card) => ({
        seq: card.seq,
        kind: card.kind,
        memberId: card.member_id,
        role: null,
        createdAt: new Date(card.created_at),
        payload: JSON.stringify({ id: card.card_id, callId: card.call_id }),
      })),
    ].sort((a, b) => a.seq - b.seq);
  }

  /**
   * Every `run_outcome` row of every run, for the stats ledger's boot sweep. Served
   * by the `kind` index; a profile holds a handful per team run.
   */
  async runOutcomeRows(
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'runId' | 'seq' | 'payload' | 'createdAt'>[]> {
    return this.getRepo(txEm).find(
      { kind: 'run_outcome' },
      {
        fields: ['runId', 'seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /** Every mark a run's analysis filed on its cards, oldest first. */
  async recommendationOutcomeRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'recommendation_outcome' },
      {
        fields: ['seq', 'payload'],
        orderBy: { seq: 'ASC' },
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every usage-bearing row in the database (`USAGE_ITEM_KINDS`), across all
   * runs — what the usage ledger's boot backfill sweeps to recover history
   * recorded before it existed.
   *
   * The backfill needs `runId` + `seq` to key each turn idempotently and
   * `createdAt` to date it.
   *
   * Projected to those five fields and filtered to the kinds that carry usage:
   * this runs once per boot, and hydrating full rows would pull every
   * conversation's text through memory to read a handful of integers. The kind
   * filter rides `Item`'s own `kind` index — added FOR this query, since every
   * other read here is scoped by `runId` and rides the composite index instead.
   */
  async allUsageRows(
    since?: Date,
    txEm?: EntityManager,
  ): Promise<
    Pick<Item, 'runId' | 'memberId' | 'seq' | 'payload' | 'createdAt'>[]
  > {
    return this.getRepo(txEm).find(
      {
        kind: { $in: [...USAGE_ITEM_KINDS] },
        // `since` bounds the sweep to turns the ledger cannot already hold.
        // Without it every launch read the user's whole history to learn it had
        // nothing to do, so start-up cost grew forever.
        ...(since === undefined ? {} : { createdAt: { $gte: since } }),
      },
      {
        fields: ['runId', 'memberId', 'seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Tool RESULTS newer than `afterSeq` whose text could name a pull request —
   * the candidate set the capture pass reads (`utils/pull-request-capture.ts`).
   *
   * The `LIKE` is a pre-filter, not the parser: it narrows thousands of rows to
   * the handful worth running a regex over, and everything it lets through is
   * checked properly upstream (a `…/pull/new/<branch>` push hint matches this
   * and is not a pull request). Bounded by `seq` so the pass is INCREMENTAL —
   * the `(run_id, seq)` index serves the range directly, so a settled run whose
   * marker is current reads no payloads at all.
   *
   * Results only. The tool CALL that produced one is fetched by id through
   * {@link findToolCallPair}, because a call and its result can straddle the
   * scanned boundary — the call was persisted on the previous pass and only its
   * result is new.
   *
   * `throughSeq` closes the range, so a caller reading a whole history can cut
   * it into windows: the `LIKE` runs on the event loop.
   */
  async pullRequestCandidates(
    runId: string,
    afterSeq: number,
    txEm?: EntityManager,
    throughSeq?: number,
  ): Promise<Pick<Item, 'seq' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      {
        runId,
        seq: {
          $gt: afterSeq,
          ...(throughSeq === undefined ? {} : { $lte: throughSeq }),
        },
        kind: 'tool_result',
        payload: { $like: '%/pull/%' },
      },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'payload'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * The tool result a moment belongs to: the run's newest `tool_result` written
   * at or before `at`, else its oldest one after — null for a run with none.
   *
   * How a pull request the CLI's own record names (a time, no row of ours) gets
   * a seq, so it is ordered among the captured ones and dated by
   * {@link earliestToolResultTimes} like them.
   */
  async toolResultSeqAt(
    runId: string,
    at: Date,
    txEm?: EntityManager,
  ): Promise<number | null> {
    const repo = this.getRepo(txEm);
    const before = await repo.findOne(
      { runId, kind: 'tool_result', createdAt: { $lte: at } },
      { orderBy: { seq: 'desc' }, fields: ['seq'], disableIdentityMap: true },
    );
    if (before !== null) {
      return before.seq;
    }
    const after = await repo.findOne(
      { runId, kind: 'tool_result', createdAt: { $gt: at } },
      { orderBy: { seq: 'asc' }, fields: ['seq'], disableIdentityMap: true },
    );
    return after?.seq ?? null;
  }

  /**
   * The payloads of the run's rows in `(afterSeq, throughSeq]` that may name
   * this pull request — the prefilter of `textNamesPullRequest`, which decides.
   * Read over a seq range so a caller can window a long history, as with
   * {@link pullRequestCandidates}.
   */
  async pullRequestNamingCandidates(
    runId: string,
    pullRequest: { owner: string; repo: string; number: number },
    afterSeq: number,
    throughSeq: number,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const em = txEm ?? this.em.fork();
    const needles = pullRequestNamingNeedles(pullRequest);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('payload')
      .where('run_id', '=', runId)
      .where('kind', 'in', PULL_REQUEST_NAMING_KINDS)
      .where('deleted_at', 'is', null)
      .where('seq', '>', afterSeq)
      .where('seq', '<=', throughSeq)
      .where((eb) =>
        eb.and([
          eb(
            eb.fn('instr', [eb.ref('payload'), eb.val(needles.number)]),
            '>',
            0,
          ),
          eb.or([
            eb(
              eb.fn('instr', [
                eb.fn('lower', [eb.ref('payload')]),
                eb.val(needles.repoPath),
              ]),
              '>',
              0,
            ),
            eb(
              eb.fn('instr', [eb.ref('payload'), eb.val(needles.command)]),
              '>',
              0,
            ),
          ]),
        ]),
      )
      .execute();
    return rows.map((row) => String(row.payload));
  }

  /**
   * Rows of ONE run whose flattened text answers for EVERY term, newest first.
   *
   * All terms rather than any, matching how `searchTerms` splits a query and
   * how the session picker already reads one: somebody remembers a conversation
   * in fragments — one from the project, one from what was said — and a query
   * that widened with each extra word would be the opposite of what typing more
   * is for.
   *
   * The `$like` cannot use an index (its leading wildcard defeats any B-tree),
   * so what carries the cost is the `runId` equality on the leading column of
   * the `(run_id, seq)` index: the scan is one conversation's rows, ordered,
   * with the match as a residual filter — the same bargain
   * {@link pullRequestCandidates} makes.
   *
   * `%` and `_` inside a term stay live wildcards. That over-matches (a search
   * for `100%` also finds `100` followed by anything) and never under-matches,
   * which is the safe direction for a search box; the query is parameterized,
   * so nothing here is an injection surface.
   */
  async searchByText(
    runId: string,
    terms: readonly string[],
    limit: number,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'kind' | 'role' | 'payload' | 'createdAt'>[]> {
    return this.getRepo(txEm).find(
      {
        runId,
        $and: terms.map((term) => ({
          searchText: { $like: `%${term}%` },
        })),
      },
      {
        orderBy: { seq: 'desc' },
        limit,
        fields: ['seq', 'kind', 'role', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /** The seq of the run's newest `tool_call` row, or 0 when it has none. */
  async lastToolCallSeq(runId: string, txEm?: EntityManager): Promise<number> {
    const em = txEm ?? this.em.fork();
    const row = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select((eb) => eb.fn.max('seq').as('last'))
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    return row?.last == null ? 0 : Number(row.last);
  }

  /**
   * The run's `tool_call` rows in `(afterSeq, throughSeq]` whose stored payload
   * text contains any of `texts`. `instr` rather than `LIKE`: a path holds `_`,
   * which LIKE reads as a wildcard, and LIKE ignores ASCII case where paths do
   * not.
   */
  async toolCallsContainingAny(
    runId: string,
    afterSeq: number,
    throughSeq: number,
    texts: readonly string[],
    txEm?: EntityManager,
  ): Promise<{ seq: number; payload: string }[]> {
    const em = txEm ?? this.em.fork();
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select(['seq', 'payload'])
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .where('seq', '>', afterSeq)
      .where('seq', '<=', throughSeq)
      .where((eb) =>
        eb.or(
          texts.map((text) =>
            eb(eb.fn('instr', [eb.ref('payload'), eb.val(text)]), '>', 0),
          ),
        ),
      )
      .execute();
    return rows.map((row) => ({
      seq: Number(row.seq),
      payload: String(row.payload),
    }));
  }

  /**
   * Every row of one run as (seq, kind, role, nodeId, createdAt) — the
   * conversation's SHAPE, with none of its content — what the waterfall draws
   * its lanes and tool density from.
   *
   * `payload` is the TEXT column and a long transcript is most of the database,
   * so it is never read here. A long run is still tens of thousands of rows, so
   * they are read in windows of {@link SPINE_WINDOW_ROWS}, paged on
   * `(seq, id)`, with the event loop turning between them.
   */
  async timelineSpine(
    runId: string,
    txEm?: EntityManager,
    /** Stop at this seq — an analysis reads its source as it stood when clicked. */
    maxSeq?: number,
  ): Promise<SpineRow[]> {
    const em = txEm ?? this.em.fork();
    const rows: SpineRow[] = [];
    let after: SpineRow | null = null;
    for (;;) {
      let query = this.spineQuery(runId, em);
      if (maxSeq !== undefined) {
        query = query.where('seq', '<=', maxSeq);
      }
      if (after !== null) {
        const last: SpineRow = after;
        query = query.where((eb) =>
          eb.or([
            eb('seq', '>', last.seq),
            eb.and([eb('seq', '=', last.seq), eb('id', '>', last.id)]),
          ]),
        );
      }
      const window = (
        await query
          .orderBy('seq', 'asc')
          .orderBy('id', 'asc')
          .limit(SPINE_WINDOW_ROWS)
          .execute()
      ).map(spineRowOf);
      rows.push(...window);
      if (window.length < SPINE_WINDOW_ROWS) {
        return rows;
      }
      after = window[window.length - 1]!;
      await yieldToEventLoop();
    }
  }

  /**
   * {@link timelineSpine}'s projection, less `inCall`, of one run's rows of
   * `kinds` only, off the `(runId, kind, seq)` index.
   */
  async spineRowsOfKinds(
    runId: string,
    kinds: readonly ItemKind[],
    txEm?: EntityManager,
  ): Promise<RailRow[]> {
    return (
      await this.railQuery(runId, txEm)
        .where('kind', 'in', [...kinds])
        .orderBy('seq', 'asc')
        .execute()
    ).map(railRowOf);
  }

  /**
   * The rail's columns, every one stored ahead of `payload`: reading a column
   * stored after it walks the payload's overflow pages, row by row.
   */
  private railQuery(runId: string, txEm?: EntityManager) {
    return (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select(['id', 'seq', 'kind', 'role', 'member_id', 'created_at'])
      .where('run_id', '=', runId)
      .where('deleted_at', 'is', null);
  }

  /**
   * The spine's columns, read as plain rows: a long run's spine is tens of
   * thousands of rows, and building an entity for each costs several times the
   * read itself.
   */
  private spineQuery(runId: string, txEm?: EntityManager) {
    return (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select([
        'id',
        'seq',
        'kind',
        'role',
        'member_id',
        'in_call',
        'created_at',
      ])
      .where('run_id', '=', runId)
      .where('deleted_at', 'is', null);
  }

  /**
   * For each of `seqs`, the run's newest rows below it (every row sharing that
   * seq), in {@link spineRowsOfKinds}'s projection — a seek on the `(runId, seq)`
   * index each, however long the run is, with the event loop turning every
   * {@link SPINE_SEEKS_PER_TURN} seeks, then one read of the rows found. A seq
   * with no row below it answers nothing.
   */
  async lastSpineRowsBefore(
    runId: string,
    seqs: readonly number[],
    txEm?: EntityManager,
  ): Promise<RailRow[]> {
    const em = txEm ?? this.em.fork();
    const kysely = em.getKysely<ChatTextDatabase>({ convertValues: false });
    const found = new Set<number>();
    for (const [index, seq] of seqs.entries()) {
      if (index > 0 && index % SPINE_SEEKS_PER_TURN === 0) {
        await yieldToEventLoop();
      }
      const row = await kysely
        .selectFrom('items')
        .select('seq')
        .where('run_id', '=', runId)
        .where('seq', '<', seq)
        .where('deleted_at', 'is', null)
        .orderBy('seq', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (row !== undefined) {
        found.add(row.seq);
      }
    }
    if (found.size === 0) {
      return [];
    }
    return (
      await this.railQuery(runId, em)
        .where('seq', 'in', [...found])
        .orderBy('seq', 'asc')
        .execute()
    ).map(railRowOf);
  }

  /**
   * The tool calls behind a set of ids — how an open command gets its WORDS.
   *
   * A `shell_open` row names the call and the CLI's own work id and nothing
   * else, so the command itself has to be read from the call it decorates,
   * matched by id as {@link rowsByPayloadId} matches it.
   */
  async toolCallsByIds(
    runId: string,
    ids: readonly string[],
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'payload' | 'memberId' | 'createdAt'>[]> {
    if (ids.length === 0) {
      return [];
    }
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select(['payload', 'member_id', 'created_at'])
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'payload_id', stamped), 'in', [...ids])
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      payload: row.payload,
      memberId: row.member_id,
      createdAt: new Date(row.created_at),
    }));
  }

  /** A run's user messages' payloads, for the timeline's marker labels. */
  async userMessagePayloadRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'kind' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'kind', 'payload'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * WHICH tools one run called, and how often, grouped per lane.
   *
   * Grouped IN SQLITE and never read into the daemon. `tool_call` is the kind
   * this module's every other projection exists to avoid — measured on this
   * install's busiest run, 14,884 rows and 9.2MB of payload — so folding the
   * histogram here in JS would undo the whole reason the waterfall's payload read
   * leaves tool rows out. `json_extract` does it inside the engine and about
   * twenty rows come back: 237ms on that same run.
   *
   * A row whose payload names no tool is dropped by the `not null` — a call
   * geniro could not read is not a tool anybody can be told about.
   *
   * The KIND rides along because `payload.name` is not always a tool's name:
   * on the ACP transport it is whatever the CLI TITLED the call, which for a
   * shell call is the command. `utils/tool-usage.ts` owns that collapse and
   * states the measurements behind it — which is also why this groups by the
   * raw name and the fold re-aggregates, rather than the engine answering with
   * the final rows.
   *
   * `delegate` splits the agent's OWN calls from its CLI sub-agents' — the rows
   * carrying `parentToolUseId`, filed under the launching agent's lane.
   */
  async toolUsage(
    runId: string,
    limit: number,
    txEm?: EntityManager,
  ): Promise<ToolUsageGroup[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom((db) =>
        db
          .selectFrom('items')
          .select((eb) => {
            return [
              'member_id',
              payloadField(eb, '$.name').as('tool_name'),
              payloadField(eb, '$.toolKind').as('tool_kind'),
              eb(payloadField(eb, '$.parentToolUseId'), 'is not', null).as(
                'delegate',
              ),
            ];
          })
          .where('run_id', '=', runId)
          .where('kind', '=', 'tool_call')
          .where('deleted_at', 'is', null)
          .as('tool_calls'),
      )
      .select((eb) => [
        'member_id',
        'tool_name',
        'tool_kind',
        'delegate',
        eb.fn.countAll<number>().as('calls'),
      ])
      .where('tool_name', 'is not', null)
      .groupBy(['member_id', 'tool_name', 'tool_kind', 'delegate'])
      .orderBy('calls', 'desc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      memberId: row.member_id,
      name: String(row.tool_name),
      toolKind: row.tool_kind === null ? null : String(row.tool_kind),
      delegate: Boolean(row.delegate),
      calls: Number(row.calls),
    }));
  }

  /**
   * How many tools each agent called inside each CALL of one run, its own only
   * (no `parentToolUseId`), with the newest such row's seq — the count is as
   * of that row, so a reader adds only the rows above it. Grouped in SQLite
   * for {@link toolUsage}'s reason. A row not yet stamped with its call
   * (`in_call` NULL) is not counted; callers run `ensureIndexed` first.
   *
   * TWIN PARSER: `ownToolCallSeqsByCall` in
   * apps/ui/src/renderer/chats/call-context.ts picks the rows above that seq
   * by the same rule, so the two must agree on which rows count.
   */
  async ownToolCallsByCall(
    runId: string,
    txEm?: EntityManager,
  ): Promise<OwnToolCallCount[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select((eb) => [
        'member_id',
        'in_call',
        eb.fn.countAll<number>().as('calls'),
        eb.fn.max('seq').as('last_seq'),
      ])
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .where('member_id', 'is not', null)
      .where('in_call', 'is not', null)
      .where('in_call', '!=', '')
      // An empty `parentToolUseId` names no delegate (`subagentIdOf`).
      .where(
        (eb) =>
          eb.fn.coalesce(
            payloadRef(eb, 'parent_tool_use_id', stamped),
            eb.val(''),
          ),
        '=',
        '',
      )
      .groupBy(['member_id', 'in_call'])
      .execute();
    return rows.map((row) => ({
      memberId: String(row.member_id),
      callId: String(row.in_call),
      calls: Number(row.calls),
      lastSeq: Number(row.last_seq),
    }));
  }

  /**
   * How many tool calls each delegate of one run made, up to `maxSeq`: the
   * `tool_call` rows carrying its id as `parentToolUseId`, by that id. Grouped
   * in SQLite for {@link toolUsage}'s reason.
   *
   * TWIN PARSER: `daemonSubagentReadings` in
   * apps/ui/src/renderer/chats/durable-transcript.ts adds the delegate's rows
   * above `maxSeq` by the same rule (`subagentIdOf`).
   */
  async delegateToolCallCounts(
    runId: string,
    maxSeq: number,
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom((db) =>
        db
          .selectFrom('items')
          .select((eb) =>
            payloadRef(eb, 'parent_tool_use_id', stamped).as('delegate_id'),
          )
          .where('run_id', '=', runId)
          .where('kind', '=', 'tool_call')
          .where('deleted_at', 'is', null)
          .where('seq', '<=', maxSeq)
          .as('delegate_calls'),
      )
      .select((eb) => ['delegate_id', eb.fn.countAll<number>().as('calls')])
      .where('delegate_id', 'is not', null)
      .where('delegate_id', '!=', '')
      .groupBy('delegate_id')
      .execute();
    return new Map(
      rows.map((row) => [String(row.delegate_id), Number(row.calls)]),
    );
  }

  /**
   * How many text messages each delegate of one run wrote, up to `maxSeq`: its
   * assistant `message` rows, by `parentToolUseId`. Reasoning rows are a kind
   * of their own and are not counted.
   */
  async delegateMessageCounts(
    runId: string,
    maxSeq: number,
    txEm?: EntityManager,
  ): Promise<Map<string, number>> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom((db) =>
        db
          .selectFrom('items')
          .select((eb) =>
            payloadRef(eb, 'parent_tool_use_id', stamped).as('delegate_id'),
          )
          .where('run_id', '=', runId)
          .where('kind', '=', 'message')
          .where('role', '=', 'assistant')
          .where('deleted_at', 'is', null)
          .where('seq', '<=', maxSeq)
          .as('delegate_messages'),
      )
      .select((eb) => ['delegate_id', eb.fn.countAll<number>().as('messages')])
      .where('delegate_id', 'is not', null)
      .where('delegate_id', '!=', '')
      .groupBy('delegate_id')
      .execute();
    return new Map(
      rows.map((row) => [String(row.delegate_id), Number(row.messages)]),
    );
  }

  /**
   * The seqs of one run's SUB-AGENT tool calls — `tool_call` rows carrying
   * `parentToolUseId` — up to `maxSeq`: what lets the payload-free spine tell
   * an agent's own calls from its delegates'. Only the seq crosses.
   */
  async delegateToolCallSeqs(
    runId: string,
    txEm?: EntityManager,
    maxSeq?: number,
  ): Promise<number[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    let query = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('seq')
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .where(
        (eb) => payloadRef(eb, 'parent_tool_use_id', stamped),
        'is not',
        null,
      );
    if (maxSeq !== undefined) {
      query = query.where('seq', '<=', maxSeq);
    }
    const rows = await query.execute();
    return rows.map((row) => row.seq);
  }

  /**
   * Every `tool_call` and `tool_result` of one run up to `maxSeq`, as the id
   * that pairs them and when each was written — and nothing of what they say.
   *
   * These two kinds are most of a long transcript's bytes, so the payload never
   * leaves the engine: `json_extract` reads the id (and a call's name) in
   * SQLite and only those strings come back. Pairing a call to its result by id
   * is what gives a tool call its duration; `createdAt` is the daemon's persist
   * time for each row, so the figure is the daemon's view of the call.
   */
  async toolCallTimes(
    runId: string,
    maxSeq: number,
    txEm?: EntityManager,
  ): Promise<ToolCallTime[]> {
    const em = txEm ?? this.em.fork();
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select((eb) => [
        'seq',
        'kind',
        'member_id',
        'in_call',
        'created_at',
        payloadField(eb, '$.id').as('tool_id'),
        payloadField(eb, '$.name').as('tool_name'),
        payloadField<number | null>(eb, '$.isError').as('tool_is_error'),
        eb(payloadField(eb, '$.parentToolUseId'), 'is not', null).as(
          'delegate',
        ),
      ])
      .where('run_id', '=', runId)
      .where('kind', 'in', ['tool_call', 'tool_result'])
      .where('seq', '<=', maxSeq)
      .where('deleted_at', 'is', null)
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: row.kind === 'tool_call' ? 'tool_call' : 'tool_result',
      memberId: row.member_id,
      inCall: row.in_call,
      at: Number(row.created_at),
      toolId: row.tool_id === null ? null : String(row.tool_id),
      name: row.tool_name === null ? null : String(row.tool_name),
      delegate: Boolean(row.delegate),
      // SQLite's json_extract answers a JSON `true` as 1.
      isError: row.kind === 'tool_result' && Number(row.tool_is_error) === 1,
    }));
  }

  /**
   * One page of a run's rows for an analysis, oldest first: after `afterSeq`
   * (or from `fromTime`), never past `maxSeq`, optionally one member's and some
   * kinds only. The caller budgets the page by bytes; `limit` bounds the read.
   */
  async analysisPage(
    runId: string,
    page: {
      afterSeq: number;
      maxSeq: number;
      limit: number;
      fromTime?: Date;
      memberId?: string | null;
      kinds?: readonly ItemKind[];
    },
    txEm?: EntityManager,
  ): Promise<Item[]> {
    return this.getRepo(txEm).find(
      {
        runId,
        seq: { $gt: page.afterSeq, $lte: page.maxSeq },
        ...(page.fromTime === undefined
          ? {}
          : { createdAt: { $gte: page.fromTime } }),
        ...(page.memberId === undefined ? {} : { memberId: page.memberId }),
        ...(page.kinds === undefined ? {} : { kind: { $in: [...page.kinds] } }),
      },
      { orderBy: { seq: 'asc' }, limit: page.limit, disableIdentityMap: true },
    );
  }

  /** A run's live user messages as (seq, time, payload), oldest first. */
  async userMessagesInOrder(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'createdAt' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      {
        fields: ['seq', 'createdAt', 'payload'],
        orderBy: { seq: 'asc' },
        disableIdentityMap: true,
      },
    );
  }

  /** One row of a run by seq, or null. */
  async rowAtSeq(
    runId: string,
    seq: number,
    txEm?: EntityManager,
  ): Promise<Item | null> {
    return this.getRepo(txEm).findOne(
      { runId, seq },
      { disableIdentityMap: true },
    );
  }

  /** Which of `seqs` exist in the run at or below `maxSeq`. */
  async existingSeqs(
    runId: string,
    seqs: readonly number[],
    maxSeq: number,
    txEm?: EntityManager,
  ): Promise<Set<number>> {
    if (seqs.length === 0) {
      return new Set();
    }
    const rows = await this.getRepo(txEm).find(
      { runId, seq: { $in: [...seqs], $lte: maxSeq } },
      { fields: ['seq'], disableIdentityMap: true },
    );
    return new Set(rows.map((row) => row.seq));
  }

  /**
   * Every `show_artifact` row of one run, oldest first.
   *
   * A projected read like the timeline's beside it: `payload` is the text
   * column and a long transcript is most of the database, so only the one kind
   * that carries a descriptor pays for it. Oldest first so the fold can take
   * the last entry per artifact without comparing seqs.
   */
  async artifactRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload' | 'createdAt'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'show_artifact' },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every `team_note` row of one run, oldest first, projected on
   * {@link artifactRows}' terms. A supersede can name any earlier note, so a
   * reader folds the whole set rather than a page of it.
   */
  async teamNoteRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload' | 'createdAt'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'team_note' },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * How many team notes one run holds — what the per-run cap counts — or,
   * given `throughSeq`, how many it held at that row.
   */
  async teamNoteCount(
    runId: string,
    txEm?: EntityManager,
    throughSeq?: number,
  ): Promise<number> {
    return this.count(
      {
        runId,
        kind: 'team_note',
        ...(throughSeq === undefined ? {} : { seq: { $lte: throughSeq } }),
      },
      txEm,
    );
  }

  /** The first thing the user said in this run — its request. */
  async firstUserMessage(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload'> | null> {
    const [row] = await this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      {
        orderBy: { seq: 'asc' },
        limit: 1,
        fields: ['seq', 'payload'],
        disableIdentityMap: true,
      },
    );
    return row ?? null;
  }

  /**
   * The newest thing the USER said in this run — what a retry re-sends on a CLI
   * that cannot reopen a conversation without a prompt.
   *
   * `role: 'user'` is the whole filter and needs no delegate exclusion: a
   * delegate's output is written under the agent's role, so no row it produces
   * can be mistaken for something the person typed.
   */
  async latestUserMessage(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload'> | null> {
    const [row] = await this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      {
        orderBy: { seq: 'desc' },
        limit: 1,
        fields: ['seq', 'payload'],
        disableIdentityMap: true,
      },
    );
    return row ?? null;
  }

  /**
   * The newest `limit` rows of ONE call (`inCall`), returned in seq order — of
   * `kinds` when given, with a non-blank `said` field when named, and never a
   * message the user wrote: a person writing to a quiet callee is not the
   * callee producing anything. Read newest first off the
   * `(runId, inCall, kind, seq)` index, so a long call is walked only as far as
   * `limit` matching rows. `fromSeq` keeps only rows at or after that seq, and
   * `snapshot` only task lists that state the whole list (`mode: 'snapshot'`).
   * One statement, read as plain rows: a page anchors hundreds of these.
   */
  async newestRowsInCall(
    runId: string,
    callId: string,
    pick: {
      kinds?: readonly ItemKind[];
      said?: 'name' | 'text';
      fromSeq?: number;
      snapshot?: boolean;
      /** Only the callee's own rows, never a delegate's (`parentToolUseId`). */
      ownThread?: boolean;
      limit: number;
    },
    txEm?: EntityManager,
  ): Promise<WireRow[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    let heads = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select([...WIRE_COLUMNS])
      .where('run_id', '=', runId)
      .where('in_call', '=', callId)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('kind', '!=', 'message'),
          eb('role', 'is', null),
          eb('role', '!=', 'user'),
        ]),
      );
    if (pick.kinds !== undefined) {
      heads = heads.where('kind', 'in', [...pick.kinds]);
    }
    if (pick.fromSeq !== undefined) {
      heads = heads.where('seq', '>=', pick.fromSeq);
    }
    if (pick.ownThread === true) {
      heads = heads.where(
        (eb) => payloadRef(eb, 'parent_tool_use_id', stamped),
        'is',
        null,
      );
    }
    if (pick.snapshot === true) {
      heads = heads.where(
        (eb) => payloadField<string>(eb, '$.mode'),
        '=',
        'snapshot',
      );
    }
    const said = pick.said;
    if (said !== undefined) {
      // Every kind of blank, as the renderer's `String.trim` reads one: SQLite's
      // one-argument `trim` strips spaces only.
      heads = heads.where(
        (eb) =>
          eb.fn<string>('trim', [
            eb.fn<string>('coalesce', [
              said === 'name'
                ? payloadRef(eb, 'tool_name_lower', stamped)
                : payloadField<string>(eb, `$.${said}`),
              eb.val(''),
            ]),
            eb.val(' \t\n\r'),
          ]),
        '!=',
        '',
      );
    }
    return (await heads.orderBy('seq', 'desc').limit(pick.limit).execute())
      .map(wireRowOf)
      .reverse();
  }

  /**
   * ONE call's rows of `kinds` whose payload's top-level `id` is one of `ids` —
   * the replies to tool calls a card anchors, read off the
   * `(runId, inCall, kind, seq)` index rather than over the whole run.
   */
  async rowsInCallById(
    runId: string,
    callId: string,
    kinds: readonly ItemKind[],
    ids: readonly string[],
    txEm?: EntityManager,
  ): Promise<WireRow[]> {
    if (ids.length === 0) {
      return [];
    }
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const found: WireRow[] = [];
    for (let at = 0; at < ids.length; at += PAYLOAD_ID_BATCH) {
      const rows = await em
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select([...WIRE_COLUMNS])
        .where('run_id', '=', runId)
        .where('in_call', '=', callId)
        .where('kind', 'in', [...kinds])
        .where('deleted_at', 'is', null)
        .where(
          (eb) => payloadRef(eb, 'payload_id', stamped),
          'in',
          ids.slice(at, at + PAYLOAD_ID_BATCH),
        )
        .execute();
      found.push(...rows.map(wireRowOf));
    }
    return found.sort((a, b) => a.seq - b.seq);
  }

  /**
   * The start and settle rows of these calls — a conversation's own calls, read
   * by id rather than over every call the run made. A start sits in its
   * caller's flow (`inCall` names no call of its own), so it is matched on its
   * payload, among the run's few rows of that kind.
   */
  async callRowsOf(
    runId: string,
    callIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Item[]> {
    if (callIds.length === 0) {
      return [];
    }
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const starts = (
      await em
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select('id')
        .where('run_id', '=', runId)
        .where('kind', '=', 'call_started')
        .where('deleted_at', 'is', null)
        .where((eb) => payloadRef(eb, 'call_id', stamped), 'in', [...callIds])
        .execute()
    ).map((row) => row.id);
    return this.getRepo(em).find(
      {
        runId,
        $or: [
          ...(starts.length === 0 ? [] : [{ id: { $in: starts } }]),
          { kind: 'call_result', inCall: { $in: [...callIds] } },
        ],
      },
      { orderBy: { seq: 'asc' }, disableIdentityMap: true },
    );
  }

  /**
   * One batch of a run's rows at or below `throughSeq`, stamped or not, in
   * `(seq, id)` order with the stamp and payload each carries now — what a run
   * whose promoted columns were never stamped is stamped again from when the
   * membership rule changed (a stamped one is read by
   * {@link inCallRowsOfKind}). Paged on both, since an older profile holds rows
   * that share a seq.
   */
  async inCallBatch(
    runId: string,
    after: { seq: number; id: string } | null,
    throughSeq: number,
    limit: number,
    txEm?: EntityManager,
  ): Promise<InCallRow[]> {
    return this.getRepo(txEm).find(
      after === null
        ? { runId, seq: { $lte: throughSeq } }
        : {
            runId,
            // The bound outside the `$or` is the index range; the `$or` alone
            // left SQLite walking the run from its first row on every batch.
            seq: { $gte: after.seq, $lte: throughSeq },
            $or: [
              { seq: { $gt: after.seq } },
              { seq: after.seq, id: { $gt: after.id } },
            ],
          },
      {
        limit,
        orderBy: { seq: 'asc', id: 'asc' },
        fields: ['id', 'seq', 'kind', 'memberId', 'inCall', 'payload'],
        disableIdentityMap: true,
      },
    );
  }

  /** Every kind of row one run holds, read off the `(run_id, kind, seq)` index. */
  async kindsOfRun(runId: string, txEm?: EntityManager): Promise<ItemKind[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('kind')
      .distinct()
      .where('run_id', '=', runId)
      .execute();
    return rows.map((row) => row.kind);
  }

  /**
   * One kind of a run's rows with what the membership rule reads of each —
   * member, stamp, `callId`, and a delegate declaration's `payloadId` — keyed
   * by rowid. Read from covering indexes only: those columns sit after
   * `payload` in the row, and reading them off the table walks every payload's
   * overflow pages, seconds per large run on a cold cache. The run's promoted
   * columns must be stamped ({@link payloadRefsStamped}).
   */
  async inCallRowsOfKind(
    runId: string,
    kind: ItemKind,
    txEm?: EntityManager,
  ): Promise<InCallIndexRow[]> {
    const db = (txEm ?? this.em.fork()).getKysely<ChatTextDatabase>({
      convertValues: false,
    });
    const placed = await db
      .selectFrom('items')
      .select(['rowid', 'seq', 'member_id', 'in_call'])
      .where('run_id', '=', runId)
      .where('kind', '=', kind)
      .where('deleted_at', 'is', null)
      .execute();
    const calls = await db
      .selectFrom('items')
      .select(['rowid', 'call_id'])
      .where('run_id', '=', runId)
      .where('kind', '=', kind)
      .where('call_id', 'is not', null)
      .execute();
    const callOf = new Map(calls.map((row) => [row.rowid, row.call_id]));
    const declared =
      kind === 'subagent_info'
        ? await db
            .selectFrom('items')
            .select(['rowid', 'payload_id'])
            .where('run_id', '=', runId)
            .where('kind', '=', kind)
            .where('payload_id', 'is not', null)
            .execute()
        : [];
    const idOf = new Map(declared.map((row) => [row.rowid, row.payload_id]));
    return placed.map((row) => ({
      rowid: row.rowid,
      seq: row.seq,
      kind,
      memberId: row.member_id,
      inCall: row.in_call,
      callId: callOf.get(row.rowid) ?? null,
      payloadId: idOf.get(row.rowid) ?? null,
    }));
  }

  /**
   * {@link rememberInCall} for rows read by {@link inCallRowsOfKind}, by
   * rowid — and only while each is still the row read, of that run, kind and
   * seq, carrying the stamp it carried then: a rowid is reused once its row is
   * deleted, and a row stamped since was stamped by this rule. Answers how many
   * rows it changed.
   */
  async rememberInCallAt(
    runId: string,
    kind: ItemKind,
    inCall: string,
    rows: readonly { rowid: number; seq: number; was: string | null }[],
    txEm?: EntityManager,
  ): Promise<number> {
    const db = (txEm ?? this.em.fork()).getKysely<ChatTextDatabase>({
      convertValues: false,
    });
    const byWas = new Map<string | null, typeof rows>();
    for (const row of rows) {
      byWas.set(row.was, [...(byWas.get(row.was) ?? []), row]);
    }
    let changed = 0;
    for (const [was, group] of byWas) {
      const result = await db
        .updateTable('items')
        .set({ in_call: inCall })
        .where('run_id', '=', runId)
        .where('kind', '=', kind)
        .where('in_call', was === null ? 'is' : '=', was)
        .where(
          'rowid',
          'in',
          group.map((row) => row.rowid),
        )
        .where(
          'seq',
          'in',
          group.map((row) => row.seq),
        )
        .executeTakeFirst();
      changed += Number(result.numUpdatedRows);
    }
    return changed;
  }

  /** Whether one run still holds a row no build stamped with `inCall`. */
  async hasUnstampedRow(runId: string, txEm?: EntityManager): Promise<boolean> {
    const row = await this.getRepo(txEm).findOne(
      { runId, inCall: null },
      { fields: ['id'], disableIdentityMap: true },
    );
    return row !== null;
  }

  /**
   * One batch of a run's rows with no `inCall` yet, in seq order after
   * `afterSeq` — the order the membership rule folds a run in.
   */
  async unstampedRows(
    runId: string,
    afterSeq: number,
    limit: number,
    txEm?: EntityManager,
  ): Promise<
    Pick<Item, 'id' | 'seq' | 'kind' | 'memberId' | 'payload' | 'inCall'>[]
  > {
    return this.getRepo(txEm).find(
      { runId, inCall: null, seq: { $gt: afterSeq } },
      {
        limit,
        orderBy: { seq: 'asc' },
        fields: ['id', 'seq', 'kind', 'memberId', 'payload', 'inCall'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * One batch of a run's rows after `after`, in `(seq, id)` order, with the
   * columns they carry now. Paged on both, since an older profile holds rows
   * that share a seq.
   */
  async payloadRefsBatch(
    runId: string,
    after: { seq: number; id: string } | null,
    limit: number,
    txEm?: EntityManager,
  ): Promise<
    Pick<
      Item,
      | 'id'
      | 'seq'
      | 'payload'
      | 'payloadId'
      | 'toolNameLower'
      | 'parentToolUseId'
      | 'callId'
    >[]
  > {
    return this.getRepo(txEm).find(
      after === null
        ? { runId }
        : {
            runId,
            $or: [
              { seq: { $gt: after.seq } },
              { seq: after.seq, id: { $gt: after.id } },
            ],
          },
      {
        limit,
        orderBy: { seq: 'asc', id: 'asc' },
        fields: [
          'id',
          'seq',
          'payload',
          'payloadId',
          'toolNameLower',
          'parentToolUseId',
          'callId',
        ],
        disableIdentityMap: true,
      },
    );
  }

  async rememberPayloadRefs(
    rows: readonly { id: string; refs: PayloadRefs }[],
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em.fork();
    await em.transactional(async (tx) => {
      for (const { id, refs } of rows) {
        await this.getRepo(tx as EntityManager).nativeUpdate({ id }, refs);
      }
    });
  }

  /**
   * Whether every row of the run carries its payload columns
   * (`Run.payloadRefsVersion`): a lookup reads the column when it does and the
   * payload when it does not, so a run the boot sweep has not reached yet is
   * answered the slow way rather than wrongly.
   */
  async payloadRefsStamped(
    runId: string,
    txEm?: EntityManager,
  ): Promise<boolean> {
    if (this.stampedRuns.has(runId)) {
      return true;
    }
    const em = txEm ?? this.em.fork();
    const run = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('runs')
      .select('payload_refs_version')
      .where('id', '=', runId)
      .executeTakeFirst();
    const stamped = run?.payload_refs_version === PAYLOAD_REFS_VERSION;
    if (stamped) {
      this.stampedRuns.add(runId);
    }
    return stamped;
  }

  async rememberInCall(
    ids: readonly string[],
    inCall: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: { $in: [...ids] } },
      { inCall },
    );
  }

  /**
   * Every `task_list` announcement a run has written, oldest first — the input
   * to `utils/task-list-fold.ts`.
   *
   * The WHOLE set rather than an incremental slice, unlike
   * {@link pullRequestCandidates} beside it, and the difference is what the two
   * scans cost. A pull-request scan reads `tool_result` rows, which are most of
   * a transcript (14,068 items on a real thread here), so it must be marked and
   * resumed. These are the rows an agent wrote ABOUT its own checklist, and
   * there are a few dozen at most — measured on real turns, fifteen for a
   * five-task claude run and six for the same job on cursor — served straight
   * off the `kind` index. Re-folding all of them is what makes the answer
   * correct with no marker to keep in step: a daemon restarted mid-conversation,
   * and every run that predates this column, fold identically to a live one.
   */
  async taskListRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'memberId' | 'payload'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'task_list' },
      {
        orderBy: { seq: 'asc' },
        fields: ['memberId', 'payload'],
        disableIdentityMap: true,
      },
    );
  }

  async stageChangeRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'payload' | 'createdAt'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'stage_change' },
      {
        orderBy: { seq: 'asc' },
        fields: ['seq', 'payload', 'createdAt'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * The last row of one kind a run wrote, or null for a run that wrote none.
   *
   * A board task's closing report is read through this, and reading it from
   * the TRANSCRIPT is what makes the live settle and the app-was-closed
   * reconcile one code path: `writeRunStatus` persists the status column
   * alone, so the closing words the `run_status` event carries exist nowhere
   * once that event has passed. The rows do, and they are written before the
   * terminal status is announced (persist-then-emit).
   *
   * `role` narrows it where a kind is not enough — a `message` row is written
   * for the user's own turn too, and the agent's is the one a report means.
   */
  async latestOfKind(
    runId: string,
    kind: ItemKind,
    role?: string,
    txEm?: EntityManager,
    /**
     * Narrow to rows written by particular NODES of a team run.
     *
     * Absent means every member, which is what a chat run wants — it has one, and
     * its rows carry no member id at all. A team run's transcript is N members
     * interleaved in one stream, so "the latest row" is whichever of them wrote
     * last; the task board passes the run's terminal members here to ask for the
     * conclusion instead. An EMPTY set is not the same as absent and is the
     * caller's to avoid: it would match nothing.
     */
    memberIds?: readonly string[],
  ): Promise<Pick<Item, 'id'> | null> {
    const [row] = await this.getRepo(txEm).find(
      {
        runId,
        kind,
        ...(role === undefined ? {} : { role }),
        ...(memberIds === undefined
          ? {}
          : { memberId: { $in: [...memberIds] } }),
      },
      {
        orderBy: { seq: 'desc' },
        limit: 1,
        // The id alone: `payload` is the TEXT column, and a `report_findings`
        // row can be many KB read for a value no caller looks at.
        fields: ['id'],
        disableIdentityMap: true,
      },
    );
    return row ?? null;
  }

  /**
   * One run's `subagent_info` rows in seq order — the durable record of which
   * delegates it declared out and which it has since closed.
   *
   * Read from the transcript rather than kept in memory, and that is the whole
   * reason this exists as a query: the set has to survive a daemon restart,
   * since a SIGKILLed daemon never wrote the closes and its next boot is the
   * only thing left that can (see `utils/open-delegates.ts`). One durable
   * source then serves both the session-close path and the boot sweep, instead
   * of an in-memory tally that is right for one of them and empty for the other.
   */
  async subagentInfoRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'payload' | 'memberId'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: 'subagent_info' },
      {
        orderBy: { seq: 'asc' },
        // `nodeId` rides along because a delegate belongs to the NODE that
        // launched it, and the close written for a stranded one has to be filed
        // under that same member or it reaches nothing — see
        // `ChatService.closeStrandedDelegates`.
        fields: ['payload', 'memberId'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Every run that recorded a delegate recovery ref since `since`, once each.
   * Every run's `subagent_info` rows are matched against the payload text, so
   * this is a boot-time read, not a per-request one.
   */
  async subagentRecoveryRunIds(
    since: Date,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const em = txEm ?? this.em.fork();
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('run_id')
      .distinct()
      .where('kind', '=', 'subagent_info')
      .where('created_at', '>=', since.getTime())
      .where('deleted_at', 'is', null)
      .where('payload', 'like', '%"recovery":%')
      .execute();
    return rows.map((row) => row.run_id);
  }

  /**
   * One run's rows of `kinds`, optionally only those in `range`, off the
   * `(runId, kind, seq)` index — the structural rows a page of transcript is
   * anchored by (`ChatHistoryService`), the kinds the boot reconciles fold
   * (`ANSWERABILITY_KINDS`, `OPEN_WORK_KINDS`), and what `RunKindRowsCache`
   * reads through. Never the transcript's text kinds.
   */
  async rowsOfKinds(
    runId: string,
    kinds: readonly ItemKind[],
    range?: SeqRange,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    return inSeqOrder(
      await this.getRepo(txEm).find(
        {
          runId,
          kind: { $in: kindList(kinds) },
          ...seqFilter(range),
        },
        { orderBy: KIND_ROWS_ORDER, disableIdentityMap: true },
      ),
    );
  }

  /**
   * The callee and session each of one run's `call_result` rows in
   * `(afterSeq, throughSeq]` names, in seq order — the two fields alone, so a
   * reply's text never reaches the daemon.
   */
  async callResultSessions(
    runId: string,
    afterSeq: number,
    throughSeq: number,
    txEm?: EntityManager,
  ): Promise<{ calleeMemberId: string | null; sessionId: string | null }[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select((eb) => [
        payloadField(eb, '$.calleeNodeId').as('callee_node_id'),
        payloadField(eb, '$.sessionId').as('session_id'),
      ])
      .where('run_id', '=', runId)
      .where('kind', '=', 'call_result')
      .where('deleted_at', 'is', null)
      .where('seq', '>', afterSeq)
      .where('seq', '<=', throughSeq)
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      calleeMemberId:
        typeof row.callee_node_id === 'string' ? row.callee_node_id : null,
      sessionId: typeof row.session_id === 'string' ? row.session_id : null,
    }));
  }

  /** One run's rows of `kinds` with a seq in `(afterSeq, throughSeq]`, in seq order. */
  async rowsOfKindsBetween(
    runId: string,
    kinds: readonly ItemKind[],
    afterSeq: number,
    throughSeq: number,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    return inSeqOrder(
      await this.getRepo(txEm).find(
        {
          runId,
          kind: { $in: kindList(kinds) },
          seq: { $gt: afterSeq, $lte: throughSeq },
        },
        { orderBy: KIND_ROWS_ORDER, disableIdentityMap: true },
      ),
    );
  }

  /**
   * One run's rows of `kinds` whose payload's top-level `id` is one of `ids`,
   * optionally only those in `range` — a seek on the `(runId, kind, payloadId)`
   * index ({@link payloadRef}). The id is compared EXACTLY, never as a pattern
   * on the payload text, which would match `call-5` inside `call-50`.
   */
  async rowsByPayloadId(
    runId: string,
    kinds: readonly ItemKind[],
    ids: readonly string[],
    range?: SeqRange,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows: Item[] = [];
    for (let at = 0; at < ids.length; at += PAYLOAD_ID_BATCH) {
      let heads = em
        .getKysely<ChatTextDatabase>({ convertValues: false })
        .selectFrom('items')
        .select('id')
        .where('run_id', '=', runId)
        .where('kind', 'in', [...kinds])
        .where('deleted_at', 'is', null)
        .where(
          (eb) => payloadRef(eb, 'payload_id', stamped),
          'in',
          ids.slice(at, at + PAYLOAD_ID_BATCH),
        );
      if (range !== undefined) {
        heads = heads.where((eb) => seqRangeOf(eb, range));
      }
      rows.push(
        ...(await this.rowsWithIds(
          (await heads.execute()).map((head) => head.id),
          em,
        )),
      );
    }
    return rows;
  }

  /**
   * One run's pool HAND-OFF rows — the `system` rows on a call that name the
   * member the call moved to — optionally only those in `range`.
   *
   * What a call's card names as its CLI while the call still runs: the start
   * row names the member it began on and only the settle the one that
   * answered. A run holds a handful of them (one per hand-on), and the
   * `(runId, kind, seq)` index narrows the scan to `system` rows before the
   * JSON path is read.
   *
   * TWIN PARSER: `isPoolHandOff` in apps/ui/src/renderer/chats/transcript-groups.ts.
   */
  async callHandOffRows(
    runId: string,
    range?: SeqRange,
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    let heads = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', '=', 'system')
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'call_id', stamped), 'is not', null)
      .where((eb) => payloadPath(eb, '$.member'), 'is not', null);
    if (range !== undefined) {
      heads = heads.where((eb) => seqRangeOf(eb, range));
    }
    return this.rowsWithIds(
      (await heads.execute()).map((head) => head.id),
      em,
    );
  }

  /**
   * One run's QUEUED-call rows — the `system` rows the executor writes for a
   * call that waits under the run's active-turn cap. A run holds one per call
   * that ever waited, read for the run-state route's `RunCallState.queued`.
   *
   * TWIN PARSER: written by `launchCalleeTurn` in
   * apps/daemon/src/v1/teams/services/team-executor.service.ts; read the
   * same way by `isQueuedCall` in apps/ui/src/renderer/chats/transcript-groups.ts.
   */
  async callQueueRows(runId: string, txEm?: EntityManager): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const heads = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', '=', 'system')
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'call_id', stamped), 'is not', null)
      .where((eb) => payloadPath(eb, '$.queuedCall'), 'is not', null)
      .execute();
    return this.rowsWithIds(
      heads.map((head) => head.id),
      em,
    );
  }

  /** Which of `callIds` have a `status` row of their own — their turn began. */
  async callIdsWithStatus(
    runId: string,
    callIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Set<string>> {
    if (callIds.length === 0) {
      return new Set();
    }
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const rows = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select((eb) => payloadRef(eb, 'call_id', stamped).as('callId'))
      .distinct()
      .where('run_id', '=', runId)
      .where('kind', '=', 'status')
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'call_id', stamped), 'in', [...callIds])
      .execute();
    return new Set(
      rows
        .map((row) => row.callId)
        .filter((callId): callId is string => callId !== null),
    );
  }

  /**
   * One run's `tool_call` rows whose tool NAME, lowercased, is one of `names` —
   * the run's delegations and its artifact publishes, which the run-state route
   * lists over the whole conversation. `names` must be lowercase.
   */
  async toolCallsNamed(
    runId: string,
    names: readonly string[],
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    const stamped = await this.payloadRefsStamped(runId, em);
    const heads = await em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('id')
      .where('run_id', '=', runId)
      .where('kind', '=', 'tool_call')
      .where('deleted_at', 'is', null)
      .where((eb) => payloadRef(eb, 'tool_name_lower', stamped), 'in', [
        ...names,
      ])
      .execute();
    return this.rowsWithIds(
      heads.map((head) => head.id),
      em,
    );
  }

  /**
   * Every turn ending of a run after `afterSeq`, ignoring a continuation that
   * finished inside a turn — it ended nothing. Read once per state refresh,
   * and only while a delegate is left unanswered.
   */
  async turnEndingsAfter(
    runId: string,
    afterSeq: number,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'seq' | 'memberId' | 'kind' | 'payload'>[]> {
    const rows = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select(['seq', 'member_id', 'kind', 'payload'])
      .where('run_id', '=', runId)
      .where('kind', 'in', ['turn_complete', 'turn_cancelled', 'error'])
      .where('seq', '>', afterSeq)
      .where('deleted_at', 'is', null)
      .where((eb) => insideTurnOf(eb), '=', 0)
      .orderBy('seq', 'asc')
      .execute();
    return rows.map((row) => ({
      seq: row.seq,
      memberId: row.member_id,
      kind: row.kind,
      payload: row.payload,
    }));
  }

  /**
   * When a 1:1 chat's open turn began: its first user message after the run's
   * last turn ending, else the start of the work the agent took up on its own
   * since ({@link offTurnStartedAt}), or null when there is neither.
   *
   * The FIRST rather than the newest, because a message delivered into a turn
   * already running joins that turn rather than starting one — the clock the
   * header reads must not restart on it.
   *
   * TWIN of the renderer's turn scan (`turn-duration.ts`) on `insideTurn`: a
   * continuation that finished inside the turn ends nothing, and one carrying
   * the CLI's own duration moves the turn's start up to it, since that figure
   * already covers the stretch before it.
   */
  async openTurnStartedAt(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const db = (txEm ?? this.em.fork()).getKysely<ChatTextDatabase>({
      convertValues: false,
    });
    const ending = await db
      .selectFrom('items')
      .select('seq')
      .where('run_id', '=', runId)
      .where('member_id', 'is', null)
      .where('kind', 'in', ['turn_complete', 'turn_cancelled', 'error'])
      .where('deleted_at', 'is', null)
      .where((eb) => insideTurnOf(eb), '=', 0)
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const [opener] = await this.getRepo(txEm).find(
      {
        runId,
        memberId: null,
        kind: 'message',
        role: 'user',
        ...(ending === undefined ? {} : { seq: { $gt: ending.seq } }),
      },
      {
        orderBy: { seq: 'asc' },
        limit: 1,
        fields: ['seq', 'createdAt'],
        disableIdentityMap: true,
      },
    );
    if (opener === undefined) {
      return ending === undefined
        ? null
        : this.offTurnStartedAt(runId, ending.seq, txEm);
    }
    const measured = await db
      .selectFrom('items')
      .select('created_at')
      .where('run_id', '=', runId)
      .where('member_id', 'is', null)
      .where('kind', '=', 'turn_complete')
      .where('seq', '>', opener.seq)
      .where('deleted_at', 'is', null)
      .where((eb) => insideTurnOf(eb), '=', 1)
      .where(
        (eb) =>
          eb.fn<string | null>('json_type', [
            eb.ref('payload'),
            eb.val('$.usage.durationMs'),
          ]),
        'in',
        ['integer', 'real'],
      )
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const measuredAt =
      measured === undefined ? null : new Date(measured.created_at);
    return measuredAt === null ||
      measuredAt.getTime() < opener.createdAt.getTime()
      ? opener.createdAt
      : measuredAt;
  }

  /**
   * When the main agent began working on its own after the turn ending at
   * `endingSeq` — its first reply, reasoning or tool call since, a delegate's
   * excluded — or null when it has produced none.
   *
   * TWIN PARSER: the renderer's turn scan (`turn-duration.ts` →
   * `opensOffTurnStretch`).
   */
  private async offTurnStartedAt(
    runId: string,
    endingSeq: number,
    txEm?: EntityManager,
  ): Promise<Date | null> {
    const stamped = await this.payloadRefsStamped(runId, txEm);
    const row = await (txEm ?? this.em.fork())
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('created_at')
      .where('run_id', '=', runId)
      .where('member_id', 'is', null)
      .where('seq', '>', endingSeq)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb('kind', 'in', ['tool_call', 'reasoning']),
          eb.and([eb('kind', '=', 'message'), eb('role', '=', 'assistant')]),
        ]),
      )
      .where(
        (eb) =>
          eb.fn.coalesce(
            payloadRef(eb, 'parent_tool_use_id', stamped),
            eb.val(''),
          ),
        '=',
        '',
      )
      .orderBy('seq', 'asc')
      .limit(1)
      .executeTakeFirst();
    return row === undefined ? null : new Date(row.created_at);
  }

  /**
   * These runs' `subagent_info` rows, grouped by run and in seq order — the
   * boot sweep's read, over the runs `RunDao.reconcileMarks` says changed since
   * it last found them closed.
   */
  async subagentInfoRowsOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'runId' | 'payload'>[]> {
    return inRunBatches(runIds, (batch) =>
      this.getRepo(txEm).find(
        { runId: { $in: batch }, kind: 'subagent_info' },
        {
          orderBy: { runId: 'asc', seq: 'asc' },
          fields: ['runId', 'payload'],
          disableIdentityMap: true,
        },
      ),
    );
  }

  /**
   * One run's `shell_open` / `shell_info` rows in seq order — which detached
   * commands it started and which it has since seen end. The shell twin of
   * {@link subagentInfoRows}, and durable for the same reason: the question is
   * asked after the process that knew the answer is gone (see
   * `utils/open-shells.ts`).
   */
  async shellRows(
    runId: string,
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'kind' | 'payload' | 'memberId'>[]> {
    return this.getRepo(txEm).find(
      { runId, kind: { $in: ['shell_open', 'shell_info'] } },
      {
        orderBy: { seq: 'asc' },
        fields: ['kind', 'payload', 'memberId'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * These runs' shell rows, grouped by run and in seq order — the boot sweep's
   * read, in {@link KIND_ROWS_ORDER}.
   */
  async shellRowsOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'runId' | 'kind' | 'payload' | 'memberId'>[]> {
    const rows = await inRunBatches(runIds, (batch) =>
      this.getRepo(txEm).find(
        { runId: { $in: batch }, kind: { $in: ['shell_open', 'shell_info'] } },
        {
          orderBy: KIND_ROWS_ORDER,
          fields: ['runId', 'kind', 'seq', 'payload', 'memberId'],
          disableIdentityMap: true,
        },
      ),
    );
    return inSeqOrder(rows);
  }

  /**
   * These runs' `system` rows that record a monitor (`monitors` in their
   * payload), oldest first per run — what the boot sweep reads a monitor's last
   * word from, and what a run's used monitor ids are read from. The payload
   * match is a pre-filter; the reader parses each row.
   */
  async monitorRowsOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'runId' | 'memberId' | 'seq' | 'payload'>[]> {
    return inRunBatches(runIds, (batch) =>
      this.getRepo(txEm).find(
        {
          runId: { $in: batch },
          kind: 'system',
          payload: { $like: '%"monitors":[%' },
        },
        {
          orderBy: { runId: 'asc', seq: 'asc' },
          fields: ['runId', 'memberId', 'seq', 'payload'],
          disableIdentityMap: true,
        },
      ),
    );
  }

  /** These runs' action rows, grouped by run and in seq order — read as {@link shellRowsOfRuns} is. */
  async actionRowsOfRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Pick<Item, 'runId' | 'kind' | 'seq' | 'payload'>[]> {
    const rows = await inRunBatches(runIds, (batch) =>
      this.getRepo(txEm).find(
        { runId: { $in: batch }, kind: { $in: ['action', 'action_outcome'] } },
        {
          orderBy: KIND_ROWS_ORDER,
          fields: ['runId', 'kind', 'seq', 'payload'],
          disableIdentityMap: true,
        },
      ),
    );
    return inSeqOrder(rows);
  }

  /**
   * The tool calls a conversation's OPEN turn has made and not had answered —
   * the commands it is running in the foreground right now, whatever page of
   * the transcript a client holds. A conversation is a member and the call it
   * runs in (`inCall`: `''` for its own flow), or a chat's (`nodeId` null,
   * every row). A delegate's own calls are left out.
   */
  async openTurnToolCalls(
    runId: string,
    conversation: { memberId: string | null; inCall: string | null },
    txEm?: EntityManager,
  ): Promise<Item[]> {
    const em = txEm ?? this.em.fork();
    let endings = em
      .getKysely<ChatTextDatabase>({ convertValues: false })
      .selectFrom('items')
      .select('seq')
      .where('run_id', '=', runId)
      .where('kind', 'in', ['turn_complete', 'turn_cancelled', 'error'])
      .where('deleted_at', 'is', null)
      // A continuation's result inside a turn ends nothing.
      .where(
        (eb) =>
          eb.fn<number>('coalesce', [
            payloadField<number>(eb, '$.insideTurn'),
            eb.val(0),
          ]),
        '=',
        0,
      );
    endings =
      conversation.memberId === null
        ? endings.where('member_id', 'is', null)
        : endings.where('member_id', '=', conversation.memberId);
    if (conversation.inCall !== null) {
      endings = endings.where('in_call', '=', conversation.inCall);
    }
    const ending = await endings
      .orderBy('seq', 'desc')
      .limit(1)
      .executeTakeFirst();
    const scope = {
      runId,
      memberId: conversation.memberId,
      ...(conversation.inCall === null ? {} : { inCall: conversation.inCall }),
    };
    const calls = (
      await this.getRepo(em).find(
        { ...scope, kind: 'tool_call', seq: { $gt: ending?.seq ?? -1 } },
        { orderBy: { seq: 'asc' }, disableIdentityMap: true },
      )
    ).filter(
      (row) =>
        payloadString(parseJsonColumn(row.payload), 'parentToolUseId') === null,
    );
    const ids = calls
      .map((row) => payloadString(parseJsonColumn(row.payload), 'id'))
      .filter((id) => id !== null);
    if (ids.length === 0) {
      return [];
    }
    // Replies after the turn's first call, of this conversation alone — off
    // the `(runId, inCall, kind, seq)` index where the conversation has one.
    const replies =
      conversation.inCall === null
        ? await this.rowsByPayloadId(
            runId,
            ['tool_result'],
            ids,
            { after: calls[0]!.seq },
            em,
          )
        : await this.rowsInCallById(
            runId,
            conversation.inCall,
            ['tool_result'],
            ids,
            em,
          );
    const answered = new Set(
      replies.map((row) => payloadString(parseJsonColumn(row.payload), 'id')),
    );
    return calls.filter(
      (row) => !answered.has(payloadString(parseJsonColumn(row.payload), 'id')),
    );
  }

  /**
   * The conversations whose newest `status` row says `running` — a member's own
   * flow (`inCall` `''`) or a call it runs in, whether the call is still out or
   * the callee carries on after it settled. What has a turn open right now.
   */
  async runningConversations(
    runId: string,
    txEm?: EntityManager,
  ): Promise<{ memberId: string; inCall: string }[]> {
    const db = (txEm ?? this.em.fork()).getKysely<ChatTextDatabase>({
      convertValues: false,
    });
    const newest = await db
      .selectFrom('items')
      .select((eb) => eb.fn.max<number>('seq').as('seq'))
      .where('run_id', '=', runId)
      .where('kind', '=', 'status')
      .where('member_id', 'is not', null)
      .where('deleted_at', 'is', null)
      .groupBy(['member_id', 'in_call'])
      .execute();
    const seqs = newest.map((row) => Number(row.seq));
    if (seqs.length === 0) {
      return [];
    }
    const rows = await db
      .selectFrom('items')
      .select(['member_id', 'in_call', 'payload'])
      .where('run_id', '=', runId)
      .where('seq', 'in', seqs)
      .execute();
    return rows
      .filter(
        (row) =>
          row.member_id !== null &&
          row.in_call !== null &&
          payloadString(parseJsonColumn(row.payload), 'status') === 'running',
      )
      .map((row) => ({ memberId: row.member_id!, inCall: row.in_call! }));
  }

  /** Highest seq persisted for a run, or -1 when the run has no items yet. */
  async maxSeq(
    runId: string,
    txEm?: EntityManager,
    /** One team member's newest row; absent means the run's. */
    memberId?: string,
  ): Promise<number> {
    // Project ONLY `seq` — this runs on every sendMessage; hydrating the full
    // newest Item (incl. its text payload) just to read one integer is wasteful.
    const last = await this.getRepo(txEm).findOne(
      memberId === undefined ? { runId } : { runId, memberId },
      { orderBy: { seq: 'desc' }, fields: ['seq'], disableIdentityMap: true },
    );
    return last ? last.seq : -1;
  }

  /** Highest seq of a run's rows other than `kinds`, or -1 when it has none. */
  async maxSeqExcept(
    runId: string,
    kinds: readonly ItemKind[],
    txEm?: EntityManager,
  ): Promise<number> {
    const last = await this.getRepo(txEm).findOne(
      { runId, kind: { $nin: [...kinds] } },
      { orderBy: { seq: 'desc' }, fields: ['seq'], disableIdentityMap: true },
    );
    return last ? last.seq : -1;
  }

  /**
   * The base contract — every matching row gone, soft-deleted ones included,
   * and how many — WITHOUT reading any of them. What the run teardown purges a
   * transcript through.
   *
   * `BaseDao`'s form hydrates each row, payload and all, only to hand it to
   * `em.remove`. For a transcript that is the whole conversation pulled through
   * memory to be thrown away — measured at ~103MB of heap and ~250ms for a
   * 20,000-row run, against ~0.2MB and ~25ms for this — and the busiest threads
   * here run past 30,000. One `DELETE … WHERE run_id` rides the `(run_id, seq)`
   * index instead and moves no payload at all. Overridden rather than added
   * beside it so no caller can reach the hydrating form for this table.
   *
   * The `softDelete` filter is switched off BY NAME, on the base method's
   * reasoning: the filter applies to a native delete too, so leaving it on
   * would strand every soft-deleted row as an orphan no route can reach, while
   * `filters: false` would disable filters this purge knows nothing about.
   * Going around the unit of work is safe because the EntityManager a purge is
   * handed is a fresh fork holding the run row alone — there is no managed
   * `Item` in it to go stale.
   */
  /**
   * The payloads of a run's USER messages, and only those — what a run's
   * teardown scans for the uploads the user's own words name
   * (`ChatUploadStoreService.removeReferenced`).
   *
   * Its own narrow read rather than `getAll`: the purge beside it exists so a
   * delete never hydrates the transcript, which on a busy thread is tens of
   * thousands of payload-carrying rows. A user writes a handful of messages,
   * and only their `payload` column is selected.
   */
  async userMessagePayloads(
    runId: string,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { runId, kind: 'message', role: 'user' },
      { fields: ['payload'], filters: { softDelete: false } },
    );
    return rows.map((row) => row.payload);
  }

  override async hardDeleteIncludingSoftDeleted(
    where: FilterQuery<Item>,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.getRepo(txEm).nativeDelete(where, {
      filters: { softDelete: false },
    });
  }

  /**
   * The moment each named sequence's EARLIEST `tool_result` row was written. Two rows can share a
   * `(runId, seq)` pair (the index is not unique), so the first one written is the one a result is
   * dated by. Both pull-request dating paths read through here, so the live capture and the boot
   * sweep cannot date one pull request by two different rules.
   */
  async earliestToolResultTimes(
    runId: string,
    seqs: readonly number[],
    txEm?: EntityManager,
  ): Promise<Map<number, Date>> {
    const byRun = await this.earliestToolResultTimesOf(
      seqs.map((seq) => ({ runId, seq })),
      txEm,
    );
    return byRun.get(runId) ?? new Map<number, Date>();
  }

  /**
   * {@link earliestToolResultTimes} for many runs at once: one `(runId, seq)` per capture, answered as
   * one map per run, so the boot sweep dates every pull request a launch knows of in one query per
   * chunk rather than one per run. The captures are read in chunks, so no single statement grows
   * with the whole history.
   */
  async earliestToolResultTimesOf(
    captures: readonly { runId: string; seq: number }[],
    txEm?: EntityManager,
  ): Promise<Map<string, Map<number, Date>>> {
    const CHUNK = 200;
    const unique = new Map<string, { runId: string; seq: number }>();
    for (const capture of captures) {
      unique.set(`${capture.runId}\u0000${capture.seq}`, capture);
    }
    const all = [...unique.values()];
    const times = new Map<string, Map<number, Date>>();
    for (let start = 0; start < all.length; start += CHUNK) {
      // `kind` sits inside EACH branch, never beside the `$or`: with it outside,
      // SQLite answers the `kind` equality from the `kind` index and filters
      // every tool result in history against the branches — measured 1.6-12 s
      // per chunk on a 5.9 GB profile, on the boot path. Inside, each branch is
      // one `(run_id, kind, seq)` index probe (0.03 s for the same chunk).
      const rows = await this.getAll(
        {
          $or: all
            .slice(start, start + CHUNK)
            .map(({ runId, seq }) => ({ runId, kind: 'tool_result', seq })),
        },
        {
          fields: ['runId', 'seq', 'createdAt'],
          orderBy: { createdAt: 'asc' },
          disableIdentityMap: true,
        },
        txEm,
      );
      for (const row of rows) {
        const byRun = times.get(row.runId) ?? new Map<number, Date>();
        if (!byRun.has(row.seq)) {
          byRun.set(row.seq, row.createdAt);
        }
        times.set(row.runId, byRun);
      }
    }
    return times;
  }
}

async function inRunBatches<T>(
  runIds: readonly string[],
  read: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (const batch of idBatches(runIds)) {
    rows.push(...(await read(batch)));
  }
  return rows;
}
