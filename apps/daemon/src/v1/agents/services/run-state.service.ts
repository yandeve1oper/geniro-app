import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { NotFoundException } from '@packages/common';

import type { Item } from '../../runs/entity/item.entity';
import { isTerminalRunStatus } from '../../runs/runs.types';
import type {
  ItemWire,
  MonitorSnapshot,
  OpenMonitor,
  RunStateWire,
  TurnEnding,
} from '../chat.types';
import { ItemDao } from '../dao/item.dao';
import { RunDao } from '../dao/run.dao';
import { foldActions } from '../utils/action-fold';
import { readDelegateSpend } from '../utils/delegate-spend';
import { rowsWithId, workflowEdgeRows } from '../utils/history-anchors';
import { itemToWire } from '../utils/item-wire';
import { payloadString } from '../utils/json-util';
import {
  foldRunCalls,
  foldRunDelegates,
  turnEndingOf,
} from '../utils/run-state-folds';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { ApprovalRegistry } from './approval-registry';
import { ChatShellsService } from './chat-shells.service';
import { ItemSeqAllocator } from './item-seq.allocator';
import { MonitorRegistry } from './monitor.registry';
import { RunHoldRegistry } from './run-hold.registry';
import { RunKindRowsCache } from './run-kind-rows.cache';

/**
 * What a run holds as a whole, for the readouts that must not depend on how
 * much of the transcript a client has loaded — `GET /v1/chats/:runId/state`.
 *
 * A COMPOSITION of reads the run already answers elsewhere, never a second
 * store: the open cards are the approval registry's, the shells are
 * `ChatShellsService`'s, the monitors `MonitorRegistry`'s, and the rest is folded from the rows each question is
 * about. Kinds a run holds a handful of are read by the `(runId, kind, seq)`
 * index. The tool rows cost JSON-path scans: one over the run's tool calls by
 * NAME, one over its replies by id, a third over its tool calls by id only
 * when it launched a dynamic workflow, and the shell fold's own while a
 * command is open.
 */
@Injectable()
export class RunStateService {
  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly itemDao: ItemDao,
    private readonly approvals: ApprovalRegistry,
    private readonly shells: ChatShellsService,
    private readonly adapters: AgentAdapterRegistry,
    private readonly seqs: ItemSeqAllocator,
    private readonly monitors: MonitorRegistry,
    private readonly kindRows: RunKindRowsCache,
    private readonly holds: RunHoldRegistry,
  ) {}

  async read(runId: string): Promise<RunStateWire> {
    const em = this.em.fork();
    const run = await this.runDao.getById(runId, em);
    if (run === null) {
      throw new NotFoundException('RUN_NOT_FOUND', `run ${runId} not found`);
    }
    const wire = (rows: readonly Item[]): ItemWire[] => rows.map(itemToWire);
    const runSettled = isTerminalRunStatus(run.status);
    // Read FIRST, and never past a seq still being written: every row at or
    // before it is on disk and reflected in what follows, so a client may take
    // this read's "ended" over a page that still says running.
    const throughSeq = this.seqs.writtenThrough(
      runId,
      await this.itemDao.maxSeq(runId, em),
    );

    // The cards the registry still holds, read back as the rows they were
    // persisted as — the client draws a card from its row, and the registry
    // alone is what says the card is still open.
    const pendingIds = this.approvals
      .listByRun(runId)
      .map((entry) => entry.requestId);
    const openRequests =
      pendingIds.length === 0
        ? []
        : wire(
            await this.itemDao.rowsByPayloadId(
              runId,
              ['approval_request'],
              pendingIds,
              undefined,
              em,
            ),
          );

    const queuedCallIds = new Set(
      wire(await this.itemDao.callQueueRows(runId, em))
        .map((row) => payloadString(row.payload, 'callId'))
        .filter((callId): callId is string => callId !== null),
    );
    const calls = foldRunCalls(
      wire(
        await this.kindRows.rowsOf(
          runId,
          ['call_started', 'call_result'],
          throughSeq,
        ),
      ),
      wire(await this.itemDao.callHandOffRows(runId, undefined, em)),
      queuedCallIds,
      await this.itemDao.callIdsWithStatus(runId, [...queuedCallIds], em),
    );

    const declarations = wire(
      await this.kindRows.rowsOf(runId, ['subagent_info'], throughSeq),
    );
    const announcements = wire(
      await this.kindRows.rowsOf(runId, ['workflow_info'], throughSeq),
    );
    const { launchNames, artifactNames } = this.toolNames();
    const named = wire(
      await this.itemDao.toolCallsNamed(
        runId,
        [...launchNames.map((name) => name.toLowerCase()), ...artifactNames],
        em,
      ),
    );
    // The read is case-blind; a delegation is then the CLI's exact spelling,
    // so another CLI's command that happens to be called `task` is not one.
    const delegationCalls = named.filter((row) =>
      launchNames.includes(payloadString(row.payload, 'name') ?? ''),
    );
    const artifactCalls = named.filter((row) =>
      artifactNames.includes(toolNameOf(row)),
    );
    const delegateIds = idsOf([...declarations, ...delegationCalls]);
    const workflowIds = idsOf(announcements);
    const artifactIds = idsOf(artifactCalls);

    const replies = wire(
      await this.itemDao.rowsByPayloadId(
        runId,
        ['tool_result'],
        [...new Set([...delegateIds, ...workflowIds, ...artifactIds])],
        undefined,
        em,
      ),
    );
    const workflowLaunches =
      workflowIds.size === 0
        ? []
        : wire(
            await this.itemDao.rowsByPayloadId(
              runId,
              ['tool_call'],
              [...workflowIds],
              undefined,
              em,
            ),
          );

    const delegateReplies = rowsWithId(replies, delegateIds);
    const lifecycles = foldRunDelegates({
      declarations,
      launches: delegationCalls,
      replies: delegateReplies,
      runSettled,
      runCancelled: run.status === 'cancelled',
      endings: await this.endingsAfterUnanswered(
        runId,
        [...delegationCalls, ...declarations],
        idsOf(delegateReplies),
        em,
      ),
    });
    // Counted over every row through this read: a delegate with none counted
    // made none.
    const [toolCalls, messages] =
      lifecycles.length === 0
        ? [new Map<string, number>(), new Map<string, number>()]
        : await Promise.all([
            this.itemDao.delegateToolCallCounts(runId, throughSeq, em),
            this.itemDao.delegateMessageCounts(runId, throughSeq, em),
          ]);
    const spend = readDelegateSpend(run.delegateSpend);
    const delegates = lifecycles.map((delegate) => {
      const figures = spend.get(delegate.id) ?? null;
      return {
        ...delegate,
        toolCalls: toolCalls.get(delegate.id) ?? 0,
        messages: Math.max(
          messages.get(delegate.id) ?? 0,
          figures?.messages ?? 0,
        ),
        requests: figures?.requests ?? null,
        inputTokens: figures?.inputTokens ?? null,
        outputTokens: figures?.outputTokens ?? null,
        cacheReadTokens: figures?.cacheReadTokens ?? null,
        cacheCreationTokens: figures?.cacheCreationTokens ?? null,
        contextTokens: figures?.contextTokens ?? null,
        costUsd: figures?.costUsd ?? null,
        estimatedCostUsd: figures?.estimatedCostUsd ?? null,
        cumulative: figures !== null,
      };
    });
    const workflowRows = [
      ...workflowEdgeRows(announcements, workflowIds),
      ...workflowLaunches,
      ...rowsWithId(replies, workflowIds),
    ].sort((a, b) => a.seq - b.seq);
    const artifactRows = [
      ...artifactCalls,
      ...rowsWithId(replies, artifactIds),
    ].sort((a, b) => a.seq - b.seq);

    // A team's turns belong to its members, each with a clock of its own on
    // `node_state`; only a chat's turn is the RUN's.
    const chatTurnOpen = run.teamId === null && run.status === 'running';
    const hold = chatTurnOpen ? this.holds.read(runId) : null;
    // A stretch the CLI runs by itself is dated by when it woke, which no row
    // records; the rows answer for a turn of ours and a stretch it missed.
    const turnStartedAt = !chatTurnOpen
      ? null
      : hold?.startedAt != null
        ? new Date(hold.startedAt).toISOString()
        : ((await this.itemDao.openTurnStartedAt(runId, em))?.toISOString() ??
          null);

    return {
      openRequests,
      openToolCalls: wire(await this.openToolCalls(runId, run.teamId, em)),
      throughSeq,
      calls,
      delegates,
      workflowRows,
      artifactRows,
      shells: (await this.shells.read(runId)).shells,
      monitors: this.monitors.list(runId).map(openMonitor),
      actions: foldActions(
        await this.kindRows.rowsOf(
          runId,
          ['action', 'action_outcome'],
          throughSeq,
        ),
      ).live,
      turnStartedAt,
      turnHeldMs: Math.round(hold?.heldMs ?? 0),
      turnHeldSince:
        hold?.heldSince == null ? null : new Date(hold.heldSince).toISOString(),
    };
  }

  /**
   * The foreground commands of every conversation with a turn open: a chat's,
   * and each team conversation whose newest status row says running.
   */
  private async openToolCalls(
    runId: string,
    teamId: string | null,
    em: EntityManager,
  ): Promise<Item[]> {
    if (teamId === null) {
      // A chat's turn is open from its last ending on, whatever the run row
      // says — a cancelled chat still answers off-turn.
      return this.itemDao.openTurnToolCalls(
        runId,
        { memberId: null, inCall: null },
        em,
      );
    }
    const rows: Item[] = [];
    for (const conversation of await this.itemDao.runningConversations(
      runId,
      em,
    )) {
      rows.push(
        ...(await this.itemDao.openTurnToolCalls(runId, conversation, em)),
      );
    }
    return rows.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Every adapter's delegate-launching tool names, as the CLI spells them, and
   * its artifact tool names, lowercased — the run may hold rows of any CLI a
   * team mixed.
   */
  private toolNames(): { launchNames: string[]; artifactNames: string[] } {
    const launchNames = new Set<string>();
    const artifactNames = new Set<string>();
    for (const adapter of this.adapters.all().values()) {
      const config = adapter.getConfig();
      config.subagents.launchToolNames.forEach((name) => launchNames.add(name));
      config.artifactToolNames.forEach((name) =>
        artifactNames.add(name.toLowerCase()),
      );
    }
    return { launchNames: [...launchNames], artifactNames: [...artifactNames] };
  }

  /**
   * The run's turn endings after its oldest unanswered delegate, in one read —
   * none when every delegate was answered.
   */
  private async endingsAfterUnanswered(
    runId: string,
    rows: readonly ItemWire[],
    answered: ReadonlySet<string>,
    em: EntityManager,
  ): Promise<TurnEnding[]> {
    let oldest: number | null = null;
    for (const row of rows) {
      const id = idOf(row);
      if (id !== null && !answered.has(id)) {
        oldest = oldest === null ? row.seq : Math.min(oldest, row.seq);
      }
    }
    if (oldest === null) {
      return [];
    }
    return (await this.itemDao.turnEndingsAfter(runId, oldest, em)).map(
      turnEndingOf,
    );
  }
}

function toolNameOf(row: ItemWire): string {
  return payloadString(row.payload, 'name')?.toLowerCase() ?? '';
}

function idOf(row: ItemWire): string | null {
  return payloadString(row.payload, 'id');
}

function idsOf(rows: readonly ItemWire[]): Set<string> {
  return new Set(rows.map(idOf).filter((id): id is string => id !== null));
}

function openMonitor(monitor: MonitorSnapshot): OpenMonitor {
  return {
    id: monitor.id,
    description: monitor.description,
    command: monitor.command,
    // A chat's own rows carry no member.
    memberId: monitor.owner.target === 'chat' ? null : monitor.owner.memberId,
    callId: monitor.owner.callId,
    startedAt: monitor.startedAt,
    endsAt: monitor.endsAt,
  };
}
