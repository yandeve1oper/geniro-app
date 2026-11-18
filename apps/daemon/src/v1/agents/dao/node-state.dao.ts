import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { NodeState } from '../../runs/entity/node-state.entity';
import type { AgentKind, NodeStatus } from '../../runs/runs.types';
import type { ContextLevel } from '../chat.types';
import { readNodeSessions, withNodeSession } from '../utils/node-sessions';
import { positive } from '../utils/positive-figure';

/**
 * The `node_state` columns the increments below write, as SQLite stores them —
 * the shape their typed Kysely builder is handed. Each column is typed off the
 * entity property it stores, so a renamed or retyped field fails the build.
 */
interface NodeStateDatabase {
  node_state: {
    run_id: NodeState['runId'];
    member_id: NodeState['memberId'];
    worked_ms: NodeState['workedMs'];
    tool_calls: NodeState['toolCalls'];
    /** Epoch milliseconds, since value conversion is off. */
    deleted_at: number | null;
  };
}

@Injectable()
export class NodeStateDao extends BaseDao<NodeState> {
  constructor(em: EntityManager) {
    super(em, NodeState);
  }

  async getByRunNode(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<NodeState | null> {
    return this.getRepo(txEm).findOne({ runId, memberId });
  }

  /**
   * File (or clear) one member's last context and plan reading — the per-member
   * twin of `RunDao.rememberMetricsReading`, and a bare `nativeUpdate` for its
   * reason: a row that no longer exists simply matches nothing.
   */
  async rememberMetricsReading(
    runId: string,
    memberId: string,
    reading: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, memberId },
      { lastMetricsReading: reading },
    );
  }

  async listByRun(runId: string, txEm?: EntityManager): Promise<NodeState[]> {
    // Read-only snapshot path — no identity-map tracking needed (see item.dao).
    return this.getRepo(txEm).find({ runId }, { disableIdentityMap: true });
  }

  /**
   * Which of these CLI sessions some OTHER run still names — as the session
   * one of its members resumes, or anywhere in a member's session history.
   *
   * What keeps a run delete from removing a conversation another thread is
   * still built on. The history is a JSON array in a text column, so it is
   * matched on the quoted id; a LIKE wildcard in an id can only widen the match,
   * which errs toward keeping the conversation.
   */
  async sessionIdsHeldByOtherRuns(
    runId: string,
    sessionIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Set<string>> {
    if (sessionIds.length === 0) {
      return new Set();
    }
    const rows = await this.getRepo(txEm).find(
      {
        runId: { $ne: runId },
        $or: [
          { agentSessionId: { $in: [...sessionIds] } },
          ...sessionIds.map((id) => ({ sessionIds: { $like: `%"${id}"%` } })),
        ],
      },
      { disableIdentityMap: true },
    );
    const held = new Set<string>();
    for (const row of rows) {
      const named = new Set(readNodeSessions(row.sessionIds));
      if (row.agentSessionId) {
        named.add(row.agentSessionId);
      }
      for (const id of sessionIds) {
        if (named.has(id)) {
          held.add(id);
        }
      }
    }
    return held;
  }

  /** Seed one `pending` row per team member when a team run starts. */
  async createPending(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    this.getRepo(txEm).create(
      { runId, memberId, status: 'pending' },
      { partial: true },
    );
    await em.flush();
  }

  /**
   * Transition a member's lifecycle status (composite PK, so `BaseDao.updateById`
   * does not apply). An absent patch field leaves the stored value untouched.
   */
  async setStatus(
    runId: string,
    memberId: string,
    patch: {
      status: NodeStatus;
      startedAt?: number;
      endedAt?: number;
      error?: string | null;
      /** Stamped at turn start so run history survives team YAML edits. */
      agentKind?: AgentKind;
      /** Stamped beside {@link agentKind}, and for the same reason. */
      model?: string | null;
    },
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, memberId });
    if (existing) {
      existing.status = patch.status;
      if (patch.startedAt !== undefined) {
        existing.startedAt = patch.startedAt;
      }
      if (patch.endedAt !== undefined) {
        existing.endedAt = patch.endedAt;
      }
      if (patch.error !== undefined) {
        existing.error = patch.error;
      }
      if (patch.agentKind !== undefined) {
        existing.agentKind = patch.agentKind;
      }
      // Accepted and dropped for a release: the executor passed it on every
      // turn start and no path wrote it, so every team member read back a
      // null model — Stats filed all team spend under "no model" and an
      // export named none. Absent still means untouched, so a status-only
      // transition cannot erase the model a turn stamped.
      if (patch.model !== undefined) {
        existing.model = patch.model;
      }
    } else {
      repo.create(
        {
          runId,
          memberId,
          status: patch.status,
          startedAt: patch.startedAt ?? null,
          endedAt: patch.endedAt ?? null,
          error: patch.error ?? null,
          agentKind: patch.agentKind ?? null,
          model: patch.model ?? null,
        },
        { partial: true },
      );
    }
    await em.flush();
  }

  /**
   * Create or update the per-member state, persisting the CLI session id used for
   * `--resume`. Composite-PK entity, so `BaseDao.getById` (which keys on `id`)
   * does not apply — this upsert keys on (runId, nodeId).
   */
  async saveSessionId(
    runId: string,
    memberId: string,
    agentSessionId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const em = txEm ?? this.em;
    const repo = this.getRepo(txEm);
    const existing = await repo.findOne({ runId, memberId });
    if (existing) {
      existing.agentSessionId = agentSessionId;
    } else {
      repo.create(
        { runId, memberId, status: 'running', agentSessionId },
        { partial: true },
      );
    }
    await em.flush();
    await this.appendSessionHistory(runId, memberId, agentSessionId, txEm);
  }

  /**
   * Add a session to the member's history WITHOUT making it the member's own —
   * for a conversation the member held on another of its pool members, whose
   * session its own (member 1) turns could not resume.
   */
  recordSessionHistory(
    runId: string,
    memberId: string,
    sessionId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    return this.appendSessionHistory(runId, memberId, sessionId, txEm);
  }

  /** The history append in flight per `(runId, nodeId)` — see below. */
  private readonly historyWrites = new Map<string, Promise<void>>();

  /**
   * Add a session to the member's HISTORY, which `saveSessionId` overwrites the
   * current one over. Read past the identity map and written natively, so a
   * cached entity cannot carry an older history back over it — and SERIALIZED
   * per member: parallel calls to one member each save their own session, and two
   * read-then-writes in flight together dropped one (measured: three saves
   * landing together kept one). The daemon is this database's only writer
   * (`instance-lock.ts`), so an in-process chain is the whole of the lock.
   */
  private appendSessionHistory(
    runId: string,
    memberId: string,
    sessionId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    const key = `${runId}\u0000${memberId}`;
    const previous = this.historyWrites.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const repo = this.getRepo(txEm);
        const fresh = await repo.findOne(
          { runId, memberId },
          { disableIdentityMap: true },
        );
        const history = withNodeSession(fresh?.sessionIds ?? null, sessionId);
        if (fresh !== null && history !== null) {
          await repo.nativeUpdate({ runId, memberId }, { sessionIds: history });
        }
      });
    this.historyWrites.set(key, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.historyWrites.get(key) === next) {
          this.historyWrites.delete(key);
        }
      });
    return next;
  }

  /**
   * Record this member's latest context reading — the per-member twin of
   * `RunDao.rememberContext`, and it follows that method's rules exactly.
   *
   * A bare `nativeUpdate` rather than `updateById`/`findOne`+flush: this fires
   * once per main-thread model response, so it must not read the row, hydrate
   * an entity and flush it — nothing here needs the row's other columns, and
   * loading them would put a whole node-state entity through the identity map
   * several times a minute.
   *
   * Neither figure is ever cleared by a reading that OMITS it: a
   * `context_progress` carries a count with no window and a `turn_complete`
   * carries the window, so writing the absent half as null would have each
   * erase what the other had just recorded. A non-positive count is not a
   * measurement and is ignored for the same reason it is on the live plane.
   *
   * It writes nothing when no row exists yet, unlike `saveSessionId` beside it:
   * a reading is about a turn, and a turn always has its `createPending` row by
   * the time one arrives — creating one HERE would invent a member with a status
   * nobody chose. A `nativeUpdate` against a non-existent `(runId, nodeId)`
   * matches nothing and writes nothing, which preserves that guard without a
   * read.
   */
  async rememberContext(
    runId: string,
    memberId: string,
    reading: ContextLevel,
    txEm?: EntityManager,
  ): Promise<void> {
    const { contextTokens, contextWindowTokens, contextEstimated } = reading;
    const data: Partial<NodeState> = {};
    if (positive(contextTokens)) {
      data.contextTokens = contextTokens;
      data.contextEstimated = contextEstimated === true ? true : null;
    }
    if (positive(contextWindowTokens)) {
      data.contextWindowTokens = contextWindowTokens;
    }
    if (Object.keys(data).length === 0) {
      return;
    }
    await this.getRepo(txEm).nativeUpdate({ runId, memberId }, data);
  }

  /**
   * Add one turn's worked milliseconds and tool count to this member's running
   * totals — the ACCUMULATING counterpart of {@link rememberContext}, and the
   * difference between the two is the whole reason it is a separate method.
   *
   * That one records a LEVEL: the newest reading is the entire truth, so it
   * overwrites and a write that never lands costs nothing, because the next one
   * supersedes it. These are TOTALS, where every write is a fraction of the
   * answer — overwriting would report the last turn's work as the member's whole
   * history, and a lost write is a figure that is permanently short.
   *
   * A real increment in ONE statement, not a read-modify-write, so it holds
   * whatever else writes the row: a read-then-write overwrites anything that
   * lands between its two halves, and the figure is then permanently short.
   * CLI-reported time only — a turn its CLI did not time is recorded in
   * `wall_turns` instead (`WallWorkService`), and the served figure is the
   * sum of the two.
   *
   * Neither figure is cleared by a turn that omits it, on that method's rule —
   * a CLI reporting no timing must not erase the time already counted, and the
   * two are independently optional for exactly that case. A row that does not
   * exist is left alone rather than created, since a reading is about a turn and
   * a turn always has its `createPending` row by the time one arrives.
   */
  async rememberWork(
    runId: string,
    memberId: string,
    workedMs: number | null,
    toolCalls: number | null,
    txEm?: EntityManager,
  ): Promise<void> {
    if (!positive(workedMs) && !positive(toolCalls)) {
      return;
    }
    await (txEm ?? this.em.fork())
      .getKysely<NodeStateDatabase>({ convertValues: false })
      .updateTable('node_state')
      .set((eb) => ({
        ...(positive(workedMs)
          ? {
              worked_ms: eb(
                eb.fn.coalesce('worked_ms', eb.val(0)),
                '+',
                workedMs,
              ),
            }
          : {}),
        ...(positive(toolCalls)
          ? {
              tool_calls: eb(
                eb.fn.coalesce('tool_calls', eb.val(0)),
                '+',
                toolCalls,
              ),
            }
          : {}),
      }))
      .where('run_id', '=', runId)
      .where('member_id', '=', memberId)
      .where('deleted_at', 'is', null)
      .execute();
  }

  /**
   * Store one poll's reading of this member's conversations: the ledger they are
   * priced from (`NodeState.polledSpend`) and the totals it sums to.
   *
   * A REPLACEMENT, never an add: the ledger is the whole truth about these
   * conversations, re-read from the account, so writing its sum keeps the
   * figure and its derivation unable to disagree. Native, so a cached entity
   * elsewhere still reads the old figure until it is reloaded — which is why
   * the poll reads rows past the identity map.
   */
  async writePolledSpend(
    runId: string,
    memberId: string,
    spend: { ledger: string | null; cents: number; events: number },
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, memberId },
      {
        polledSpend: spend.ledger,
        polledCostCents: spend.cents,
        polledCostEvents: spend.events,
      },
    );
  }

  /**
   * Every member of these runs carrying a polled price — which CLI spent each
   * share of a team run's polled money, for the Stats page's per-agent row.
   */
  async polledSharesForRuns(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<
    Pick<NodeState, 'runId' | 'memberId' | 'agentKind' | 'polledCostCents'>[]
  > {
    return this.getRepo(txEm).find(
      { runId: { $in: [...runIds] }, polledCostCents: { $ne: null, $gt: 0 } },
      {
        fields: ['runId', 'memberId', 'agentKind', 'polledCostCents'],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * The CLI that ran this run's FIRST member, or null when no member has taken a
   * turn yet.
   *
   * A team run's own `agentKind` is null — it is N conversations, not one —
   * which is why nothing could ask a CLI to name one. Each member stamps the CLI
   * that actually ran it ({@link NodeState.agentKind}), so the run can name one
   * after all, and the FIRST member to start is the right one to ask: the
   * trigger member is the one handed the user's own task, so its CLI is the one
   * that has read the thing the title is supposed to describe.
   *
   * Ordered by `startedAt` and never by member id, which would be alphabetical
   * order dressed up as execution order. Rows that never started are excluded
   * rather than sorted last: SQLite sorts nulls FIRST on `ASC`, so a pending
   * member would otherwise outrank every member that actually ran.
   */
  async firstAgentKind(
    runId: string,
    txEm?: EntityManager,
  ): Promise<AgentKind | null> {
    const row = await this.getRepo(txEm).findOne(
      { runId, agentKind: { $ne: null }, startedAt: { $ne: null } },
      { orderBy: { startedAt: 'ASC' }, disableIdentityMap: true },
    );
    return row?.agentKind ?? null;
  }

  async firstAgentProfile(
    runId: string,
    txEm?: EntityManager,
  ): Promise<{ memberId: string; model: string | null } | null> {
    const row = await this.getRepo(txEm).findOne(
      { runId, agentKind: { $ne: null }, startedAt: { $ne: null } },
      { orderBy: { startedAt: 'ASC' }, disableIdentityMap: true },
    );
    return row ? { memberId: row.memberId, model: row.model } : null;
  }

  /**
   * The runs holding at least one member that ran on `agentKind`.
   *
   * A TEAM run has no agent of its own — `Run.agentKind` is null, because
   * its agents are per member — so a reader that selects runs by that column sees
   * none of them. That is how a polled-spend member inside a team came to be
   * invisible to the usage poll: it holds a real conversation, spends real
   * money, and its run row says nothing about which CLI ran it. Measured on a
   * real profile: a `dev-team` run whose QA member worked an hour on cursor was
   * priced at nothing.
   */
  /** The runs with a member still `running`, each once. */
  async runIdsWithRunningMembers(txEm?: EntityManager): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { status: 'running' },
      { fields: ['runId'], disableIdentityMap: true },
    );
    return [...new Set(rows.map((row) => row.runId))];
  }

  async runIdsForAgent(
    agentKind: AgentKind,
    txEm?: EntityManager,
  ): Promise<string[]> {
    const rows = await this.getRepo(txEm).find(
      { agentKind },
      { fields: ['runId'], disableIdentityMap: true },
    );
    return [...new Set(rows.map((row) => row.runId))];
  }

  /**
   * Drop this member's context COUNT while keeping its window — what a
   * compaction leaves behind. The node twin of `RunDao.forgetContext`.
   */
  async forgetContext(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, memberId },
      { contextTokens: null, contextEstimated: null },
    );
  }

  /**
   * Forget the CLI session this member was resuming, so the next turn starts a
   * fresh one.
   *
   * The mechanism behind a geniro-performed compaction
   * (`AgentGeniroCommand.replacesSession`): the conversation shrinks exactly
   * when the id the CLI resumes stops being recorded. A row that does not exist
   * is already in that state, which is why this writes nothing rather than
   * creating one — there is no session to forget.
   */
  async clearSessionId(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, memberId },
      { agentSessionId: null },
    );
  }

  /** A new account owns a fresh conversation with its own context window. */
  async clearConversation(
    runId: string,
    memberId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { runId, memberId },
      {
        agentSessionId: null,
        contextTokens: null,
        contextEstimated: null,
        contextWindowTokens: null,
        lastMetricsReading: null,
      },
    );
  }
}
