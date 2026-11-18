import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';

import type { ItemKind } from '../../runs/runs.types';
import type {
  CallMessagesWire,
  ChatHistoryWire,
  HistoryConversation,
  HistoryWindow,
  ItemWire,
  SeqRange,
  WireRow,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { OUTSIDE_ANY_CALL } from '../utils/call-membership';
import { collapseImageBlocks } from '../utils/collapse-image-blocks';
import { eventLoopSlicer } from '../utils/event-loop-slices';
import {
  anchorNeedsOf,
  callRowsIn,
  callSpansFrom,
  callStartOf,
  conversationCallIds,
  isOutside,
  pageBoundsOf,
  rowsOfCalls,
  rowsWithId,
  workflowEdgeRows,
} from '../utils/history-anchors';
import { itemToWire } from '../utils/item-wire';
import { parseJsonColumn, payloadString } from '../utils/json-util';
import { ChatService } from './chat.service';
import { ItemCallIndexService } from './item-call-index.service';
import { RunKindRowsCache } from './run-kind-rows.cache';

/**
 * The kinds of a call's rows a folded card and the readings beside it (each
 * agent's turns and clock, `turn-duration.ts`) read whole — see `cardRowsFor` —
 * each kind with its own cap, so a call that writes hundreds of one kind cannot
 * crowd out another. A turn's ending is any of `TERMINAL_KINDS`: without its
 * `error` or `turn_cancelled` row a failed turn reads as still running.
 *
 * TWIN PARSER: `buildCallBlock` and the stalled / held / queued folds of
 * `groupTranscript` in apps/ui/src/renderer/chats/transcript-groups.ts, with
 * `callBlockSummary` / `callBlockActivity` / `callBlockTasks` / `callBlockUsage`,
 * `scanTurns` in apps/ui/src/renderer/chats/turn-duration.ts, and the pairing
 * readers `shellRuns` (shell-activity.ts) and `subagentBlockStatus` — a reading
 * a folded card or a panel starts taking from another kind of row goes empty
 * on a page of the run's own flow until that kind is read in `cardRowsFor`.
 */
const CARD_READS: readonly { kinds: readonly ItemKind[]; limit: number }[] = [
  { kinds: ['status'], limit: 200 },
  // Every turn's spend is summed into the card's footer.
  { kinds: ['turn_complete'], limit: 1000 },
  { kinds: ['error', 'turn_cancelled'], limit: 200 },
  { kinds: ['system'], limit: 50 },
];

/**
 * The task lists a call's card folds: every one of the callee's own since its
 * newest that states the whole list, which is where the fold restarts. A
 * sub-agent's list is its own, so its rows neither restart the fold nor spend
 * this cap.
 */
const TASK_LISTS_PER_CALL = 300;

/**
 * A call's background shells and delegates, as their open, report and close
 * rows — what says a command or a delegate is still out, or has ended.
 */
const BACKGROUND_ROWS_PER_CALL = 300;

/**
 * Tool calls of a call's turn in flight, which each agent's tool count adds to
 * the daemon's settled total.
 */
const OPEN_TURN_TOOLS_PER_CALL = 300;

/**
 * A call's newest NAMED tool calls a page anchors. More than one, because the
 * card's activity line is the newest one it does not hide — a task-list tool,
 * one of geniro's own — and which those are is the renderer's to decide.
 */
const NAMED_TOOLS_PER_CALL = 8;

/**
 * One page of a run's transcript together with its ANCHORS — the rows outside
 * the page its rows refer to (`GET /v1/chats/:runId/items`).
 *
 * The page itself is `ChatService.getHistory`'s, unchanged; this only decides
 * what else the page needs and reads it. Every read is either scoped to a kind
 * a run holds a handful of (calls, workflow announcements) or matched by id on
 * the side of the page the row can be on — a tool call before the rows that
 * name it, a reply after its call. A by-id read is a JSON-path pass over the
 * run's rows of that kind on that side: cheap after the newest page, a walk of
 * the history before it, taken only when the page names something it lacks.
 */
@Injectable()
export class ChatHistoryService {
  constructor(
    private readonly em: EntityManager,
    private readonly itemDao: ItemDao,
    private readonly chats: ChatService,
    private readonly calls: ItemCallIndexService,
    private readonly kindRows: RunKindRowsCache,
  ) {}

  /**
   * Every `call_started` and `call_result` row of the run, as they stand now —
   * read at most once for one page, however many of its reads ask.
   */
  private callRowsOnce(runId: string): () => Promise<ItemWire[]> {
    let rows: Promise<ItemWire[]> | undefined;
    return () =>
      (rows ??= this.kindRows
        .rowsOf(runId, ['call_started', 'call_result'], 'fresh')
        .then((cached) => cached.map(itemToWire)));
  }

  /**
   * One page and its anchors, with every base64 image block collapsed to a
   * line naming it (`collapseImageBlocks`): the transcript draws a tool result's
   * image block as its JSON, and a page of a long run carries megabytes of them.
   */
  async read(
    runId: string,
    afterSeq = -1,
    window?: HistoryWindow,
    conversation?: HistoryConversation,
  ): Promise<ChatHistoryWire> {
    const { items, anchors } = await this.readRows(
      runId,
      afterSeq,
      window,
      conversation,
    );
    return { items: servedRows(items), anchors: servedRows(anchors) };
  }

  /**
   * The newest words a callee wrote in one conversation, its continuations
   * included: never a page of the conversation, whose rows are mostly tools, and
   * read per call off the `(runId, inCall, kind, seq)` index, so a long call is
   * walked only as far as `limit`. One row past `limit` says whether more exist.
   *
   * TWIN PARSER: `isCalleeMessage` in
   * apps/ui/src/renderer/chats/use-recent-call-messages.ts takes the same rows
   * off the socket.
   */
  async callMessages(
    runId: string,
    callId: string,
    limit: number,
  ): Promise<CallMessagesWire> {
    const keys = await this.conversationKeys(runId, { call: callId });
    if (keys === undefined) {
      return { messages: [], hasOlder: false };
    }
    const rows = await this.itemDao.newestRowsInCalls(runId, keys, {
      kinds: ['message'],
      said: 'text',
      ownThread: true,
      limit: limit + 1,
    });
    const newest = rows.sort((a, b) => a.seq - b.seq).slice(-(limit + 1));
    return {
      messages: servedRows(newest.slice(-limit).map(itemToWire)),
      hasOlder: newest.length > limit,
    };
  }

  private async readRows(
    runId: string,
    afterSeq: number,
    window: HistoryWindow | undefined,
    conversation: HistoryConversation | undefined,
  ): Promise<ChatHistoryWire> {
    const inCalls =
      conversation === undefined || 'delegate' in conversation
        ? undefined
        : await this.conversationKeys(runId, conversation);
    const delegate =
      conversation !== undefined && 'delegate' in conversation
        ? conversation.delegate
        : undefined;
    const items = await this.chats.getHistory(
      runId,
      afterSeq,
      window,
      inCalls,
      delegate,
    );
    // A full page asked with a probe carries one row the client will drop; its
    // anchors would draw a card with no row of the window behind it.
    const kept =
      window?.probe === true && items.length === window.limit
        ? window.take === 'oldest'
          ? items.slice(0, -1)
          : items.slice(1)
        : items;
    const callRows = this.callRowsOnce(runId);
    const anchors = await this.anchorsFor(
      runId,
      kept,
      inCalls !== undefined,
      callRows,
    );
    if (inCalls === undefined || conversation === undefined) {
      return { items, anchors };
    }
    const byId = new Map(anchors.map((row) => [row.id, row] as const));
    const held = new Set(kept.map((row) => row.id));
    const add = (rows: readonly ItemWire[]): void => {
      for (const row of rows) {
        if (!held.has(row.id)) {
          byId.set(row.id, row);
        }
      }
    };
    if ('root' in conversation) {
      add(await this.callsAcross(runId, kept, callRows));
      add(await this.cardRowsFor(runId, [...kept, ...byId.values()]));
      add(await this.deadCardsOf(runId, kept));
    } else {
      const nested = kept.flatMap((row) => {
        const start = callStartOf(row);
        return start === null || inCalls.includes(start.callId)
          ? []
          : [start.callId];
      });
      add(await this.cardRowsOfCalls(runId, [...inCalls, ...nested]));
    }
    return {
      items,
      anchors: [...byId.values()].sort((a, b) => a.seq - b.seq),
    };
  }

  /**
   * The start and settle rows of the calls that were running while a page of
   * the run's own flow was written but began above it — still open, or settled
   * on or below it — with the rest of their conversations. The run's whole
   * window drew their cards because it held their callees' rows; a page of the
   * run's own flow holds none, and nothing on it names them: a call's settle is
   * filed under the call itself.
   */
  private async callsAcross(
    runId: string,
    page: readonly ItemWire[],
    callRows: () => Promise<ItemWire[]>,
  ): Promise<ItemWire[]> {
    const bounds = pageBoundsOf(page);
    if (bounds === null) {
      return [];
    }
    const rows = await callRows();
    const startedInRunFlow = new Set(
      rows
        .filter((row) => typeof row.inCall !== 'string')
        .map(callStartOf)
        .filter((start) => start !== null)
        .map((start) => start.callId),
    );
    const across = callSpansFrom(rows)
      .filter(
        (span) =>
          startedInRunFlow.has(span.callId) &&
          span.startSeq < bounds.firstSeq &&
          (span.settleSeq === null || span.settleSeq >= bounds.firstSeq),
      )
      .map((span) => span.callId);
    if (across.length === 0) {
      return [];
    }
    const conversations = conversationCallIds(
      await this.calls.callStartsOf(runId),
      new Set(across),
    );
    return callRowsIn(rows, conversations);
  }

  /**
   * The `unanswerable` rows of the page's approval cards. A callee's card sits
   * in the run's own flow, but the row that says its turn took it down is the
   * callee's, filed under its call — and without it a dead card reads as one
   * still waiting for an answer.
   */
  private async deadCardsOf(
    runId: string,
    page: readonly ItemWire[],
  ): Promise<ItemWire[]> {
    const requests = page.filter((row) => row.kind === 'approval_request');
    const ids = new Set(
      requests
        .map((row) => payloadString(row.payload, 'id'))
        .filter((id) => id !== null),
    );
    if (ids.size === 0) {
      return [];
    }
    const rows = await this.itemDao.rowsByPayloadId(
      runId,
      ['unanswerable'],
      [...ids],
      { after: Math.min(...requests.map((row) => row.seq)) },
    );
    return rows.map(itemToWire);
  }

  /**
   * What the call cards a page of the run's own flow draws are folded from,
   * when the page holds none of their conversations: each call's
   * {@link CARD_READS}, its task lists since the newest whole one, the tool
   * calls of a turn still running, and its newest row, newest words and
   * newest named tool calls — the readings a folded card and each agent's
   * figures show. The rest of a call's conversation is read when its card is
   * opened. Bounded reads per call, newest first off the
   * `(runId, inCall, kind, seq)` index.
   */
  private async cardRowsFor(
    runId: string,
    held: readonly ItemWire[],
  ): Promise<ItemWire[]> {
    return this.cardRowsOfCalls(runId, [
      ...new Set(
        held
          .map(callStartOf)
          .filter((start) => start !== null)
          .map((start) => start.callId),
      ),
    ]);
  }

  /**
   * {@link cardRowsFor} over calls named outright — a page of one call's
   * conversation, whose newest rows hold no status row of a long turn, so the
   * card drawn from it would read as never started.
   */
  private async cardRowsOfCalls(
    runId: string,
    callIds: readonly string[],
  ): Promise<ItemWire[]> {
    if (callIds.length === 0) {
      return [];
    }
    const em = this.em.fork();
    // Each read is a whole synchronous statement, and a cold page of a long
    // run reads seconds of them.
    const slice = eventLoopSlicer();
    const newest = async (
      pick: Parameters<ItemDao['newestRowsInCalls']>[2],
      calls: readonly string[] = callIds,
    ): Promise<WireRow[]> => {
      if (calls.length === 0) {
        return [];
      }
      await slice();
      return this.itemDao.newestRowsInCalls(runId, calls, pick, em);
    };
    const rows: WireRow[] = [];
    for (const read of CARD_READS) {
      rows.push(...(await newest(read)));
    }
    const wholeLists = new Map(
      (
        await newest({
          kinds: ['task_list'],
          snapshot: true,
          ownThread: true,
          limit: 1,
        })
      ).flatMap((row) =>
        row.inCall === null ? [] : [[row.inCall, row.seq] as const],
      ),
    );
    rows.push(
      ...(await newest({
        kinds: ['task_list'],
        fromSeq: wholeLists,
        ownThread: true,
        limit: TASK_LISTS_PER_CALL,
      })),
    );
    const openTurns = new Map(
      (await newest({ kinds: ['status'], limit: 1 })).flatMap((status) =>
        status.inCall !== null &&
        payloadString(parseJsonColumn(status.payload), 'status') === 'running'
          ? [[status.inCall, status.seq] as const]
          : [],
      ),
    );
    const running = [...openTurns.keys()];
    rows.push(
      ...(await newest(
        {
          kinds: ['tool_call'],
          fromSeq: openTurns,
          limit: OPEN_TURN_TOOLS_PER_CALL,
        },
        running,
      )),
      ...(await newest(
        {
          kinds: ['tool_call'],
          fromSeq: openTurns,
          ownThread: true,
          limit: OPEN_TURN_TOOLS_PER_CALL,
        },
        running,
      )),
      ...(await newest({ limit: 1 })),
      // The newest words and NAMED tools: the folded card's readings walk
      // back past a blank message and an ACP tool call naming nothing.
      ...(await newest({
        kinds: ['message'],
        said: 'text',
        ownThread: true,
        limit: 1,
      })),
      ...(await newest({
        kinds: ['tool_call'],
        said: 'name',
        ownThread: true,
        limit: NAMED_TOOLS_PER_CALL,
      })),
    );
    const unique = new Map(rows.map((row) => [row.id, row] as const));
    // What CLOSES the rows above: a tool call's reply (a command, a delegate's
    // launch), and the call's background shells and delegates, opened and
    // ended — without them a finished command or delegate reads as running.
    const toolIds = new Map<string, string[]>();
    for (const row of unique.values()) {
      const id =
        row.kind === 'tool_call' && row.inCall !== null
          ? payloadString(parseJsonColumn(row.payload), 'id')
          : null;
      if (row.inCall !== null && id !== null) {
        toolIds.set(row.inCall, [...(toolIds.get(row.inCall) ?? []), id]);
      }
    }
    await slice();
    for (const row of [
      ...(await this.itemDao.rowsInCallsById(
        runId,
        ['tool_result'],
        toolIds,
        em,
      )),
      ...(await newest({
        kinds: ['shell_open', 'shell_info', 'subagent_info'],
        limit: BACKGROUND_ROWS_PER_CALL,
      })),
    ]) {
      unique.set(row.id, row);
    }
    return [...unique.values()].map(itemToWire);
  }

  /** The `inCall` values one conversation's rows carry; undefined for every row of the run. */
  private async conversationKeys(
    runId: string,
    conversation: Exclude<HistoryConversation, { delegate: string }>,
  ): Promise<string[] | undefined> {
    if (!(await this.calls.holdsCalls(runId))) {
      return undefined;
    }
    await this.calls.ensureIndexed(runId);
    if ('root' in conversation) {
      return [OUTSIDE_ANY_CALL];
    }
    return [
      ...conversationCallIds(
        await this.calls.callStartsOf(runId),
        new Set([conversation.call]),
      ),
    ];
  }

  async anchorsFor(
    runId: string,
    page: readonly ItemWire[],
    /**
     * The page is ONE conversation of the run, so rows of the others lie
     * between its bounds without being in it: a call's settle sits among the
     * caller's rows. Its call rows are then read by the calls' ids, and a row
     * is outside the page when the page does not hold it.
     */
    scoped = false,
    callRows = this.callRowsOnce(runId),
  ): Promise<ItemWire[]> {
    const bounds = pageBoundsOf(page);
    if (bounds === null) {
      return [];
    }
    const needs = anchorNeedsOf(page);
    const em = this.em.fork();
    const anchors = new Map<string, ItemWire>();
    const held = new Set(page.map((row) => row.id));
    const add = (rows: readonly ItemWire[]): void => {
      for (const row of rows) {
        if (scoped ? !held.has(row.id) : isOutside(row.seq, bounds)) {
          anchors.set(row.id, row);
        }
      }
    };
    const callRange: SeqRange | undefined = scoped
      ? undefined
      : { outside: bounds };
    const addById = async (
      kinds: readonly ItemKind[],
      ids: ReadonlySet<string>,
      range: SeqRange,
    ): Promise<void> => {
      if (ids.size === 0) {
        return;
      }
      const rows = await this.itemDao.rowsByPayloadId(
        runId,
        kinds,
        [...ids],
        range,
        em,
      );
      add(rowsWithId(rows.map(itemToWire), ids));
    };

    if (needs.callIds.size > 0) {
      let conversations: Set<string>;
      if (scoped) {
        // The run's starts as the call index keeps them, so a page reads only
        // its own conversations' rows rather than every call the run made.
        conversations = conversationCallIds(
          await this.calls.callStartsOf(runId),
          needs.callIds,
        );
        add(callRowsIn(await callRows(), conversations));
      } else {
        const outside = (await callRows()).filter((row) =>
          isOutside(row.seq, bounds),
        );
        // The chains are read over EVERY start row the run has — the page's
        // own included — since a conversation can run through the page and
        // out of it on both sides.
        const starts = [...page, ...outside]
          .map(callStartOf)
          .filter((start) => start !== null);
        conversations = conversationCallIds(starts, needs.callIds);
        add(rowsOfCalls(outside, conversations));
      }
      // A call's pool hand-off names the member it now runs on, and a long
      // call's hand-off is routinely above the page.
      add(
        rowsOfCalls(
          (await this.itemDao.callHandOffRows(runId, callRange, em)).map(
            itemToWire,
          ),
          conversations,
        ),
      );
    }

    // Every declaration, not only the newest: the client merges them field by
    // field, last non-null winning, so a brief stated once early on would be
    // lost if only the latest row came along.
    await addById(['subagent_info'], needs.delegateIds, { outside: bounds });

    if (needs.workflowIds.size > 0) {
      // Over the page's announcements too: "the newest" is the newest of all of
      // them, and one above the page is never newer than the page's own.
      const outside = (
        await this.itemDao.rowsOfKinds(
          runId,
          ['workflow_info'],
          { outside: bounds },
          em,
        )
      ).map(itemToWire);
      add(workflowEdgeRows([...page, ...outside], needs.workflowIds));
    }

    await addById(['tool_call'], needs.toolCallIds, {
      before: bounds.firstSeq,
    });
    await addById(['tool_result'], needs.pendingResultIds, {
      after: bounds.lastSeq,
    });
    await addById(['tool_result'], needs.launchResultIds, { outside: bounds });

    return [...anchors.values()].sort((a, b) => a.seq - b.seq);
  }
}

function servedRows(rows: readonly ItemWire[]): ItemWire[] {
  return rows.map((row) => {
    const payload = collapseImageBlocks(row.payload);
    return payload === row.payload ? row : { ...row, payload };
  });
}
