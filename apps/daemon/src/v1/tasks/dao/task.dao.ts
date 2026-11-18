import type { EntityData } from '@mikro-orm/core';
import {
  EntityManager,
  type FilterQuery,
  type QueryOrderMap,
} from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import type { InterruptCause } from '../../../utils/stop-cause';
import { Task } from '../entity/task.entity';
import type { TaskStatus } from '../tasks.types';

/** The order a board's columns render in: by status, then position within one. */
const BOARD_ORDER: QueryOrderMap<Task> = {
  status: 'asc',
  position: 'asc',
  createdAt: 'asc',
};

@Injectable()
export class TaskDao extends BaseDao<Task> {
  constructor(em: EntityManager) {
    super(em, Task);
  }

  /** Every card id the table holds, soft-deleted rows included. */
  async allIdsIncludingDeleted(txEm?: EntityManager): Promise<Set<string>> {
    const rows = await this.getRepo(txEm).find(
      {},
      { fields: ['id'], filters: false, disableIdentityMap: true },
    );
    return new Set(rows.map((task) => task.id));
  }

  /**
   * One project's board, in the order the columns render it: by status, then
   * by position within the column.
   */
  async listForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<Task[]> {
    return this.getAll({ projectId }, { orderBy: BOARD_ORDER }, txEm);
  }

  /**
   * Every project's cards as one board. Positions are per project, so two
   * projects' cards can share one; creation order settles that tie the same
   * way on every read.
   */
  async listAll(txEm?: EntityManager): Promise<Task[]> {
    return this.getAll({}, { orderBy: BOARD_ORDER }, txEm);
  }

  /**
   * Set one card's position, but only while it is still in `status` — a
   * conditional UPDATE, on `compareAndSetStatus`'s reasoning: a card moved to
   * another column between a reorder's read and its write must keep the fresh
   * position its move gave it rather than take one meant for the old column.
   */
  async setPositionIfInStatus(
    taskId: string,
    status: TaskStatus,
    position: number,
    at: Date,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const affected = await this.getRepo(txEm).nativeUpdate(
      { id: taskId, status, deletedAt: null } as FilterQuery<Task>,
      { position, updatedAt: at } as EntityData<Task>,
    );
    return affected === 1;
  }

  /**
   * Every card's column, labels and config directory — what the board tools
   * count and list vocabulary from, without loading a single description or
   * report.
   */
  async listBoardFacts(
    txEm?: EntityManager,
  ): Promise<
    Pick<Task, 'id' | 'projectId' | 'status' | 'labels' | 'configDir'>[]
  > {
    return this.getAll(
      {},
      { fields: ['id', 'projectId', 'status', 'labels', 'configDir'] },
      txEm,
    );
  }

  /**
   * The cards numbered `number` in any of these projects — how a key like
   * `GEN-53` is found. Several projects can share a key, so this answers for
   * all of them and the caller decides what an ambiguity means.
   */
  async findByNumber(
    projectIds: readonly string[],
    number: number,
    txEm?: EntityManager,
  ): Promise<Task[]> {
    if (projectIds.length === 0) {
      return [];
    }
    return this.getAll(
      { projectId: { $in: [...projectIds] }, number } as FilterQuery<Task>,
      {},
      txEm,
    );
  }

  async listByIds(
    ids: readonly string[],
    txEm?: EntityManager,
  ): Promise<Task[]> {
    return this.getAll(
      { id: { $in: [...ids] } } as FilterQuery<Task>,
      {},
      txEm,
    );
  }

  /**
   * The tasks sitting in one project's intake column, oldest first — what the
   * autopilot picks up, and the reason `status` carries its own index.
   */
  async listInStatus(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<Task[]> {
    return this.getAll(
      { projectId, status },
      { orderBy: { position: 'asc' } },
      txEm,
    );
  }

  /**
   * Every card in review that a run is still attached to, across EVERY
   * project — the merge watcher's query, and the second one not scoped by
   * project.
   *
   * UNCAPPED, and that is the fix rather than an oversight: the sweep's cap is
   * applied by `TaskMergeService` AFTER it drops the cards whose run opened no
   * pull request. Capping here came first, so a hundred stale cards in review
   * with nothing to watch filled every window and a card whose pull request
   * had merged sat behind them for good. The column is bounded by the boards
   * themselves, and this reads only the fields the sweep uses — a card's
   * description and report are most of its row.
   *
   * Least-recently-changed first, with the id breaking ties so the order is
   * one the service can resume from (see `TaskMergeService.resumeAfter`).
   *
   * `runId` is required because the run is where the pull requests are: a card
   * moved into review by hand has nothing for a merge to end.
   */
  async listAwaitingMerge(txEm?: EntityManager): Promise<Task[]> {
    return this.getAll(
      { status: 'in_review', runId: { $ne: null } } as FilterQuery<Task>,
      {
        orderBy: { updatedAt: 'asc', id: 'asc' },
        fields: [
          'id',
          'projectId',
          'title',
          'runId',
          'updatedAt',
          'lastDoneAt',
        ],
        disableIdentityMap: true,
      },
      txEm,
    );
  }

  /**
   * The card holding one run, if any still does.
   *
   * The run<->task edge has an end on each row, and this reads it from the RUN
   * side — which is what a `run_deleted` announcement gives you, the run row
   * itself being gone by the time it fires. Null is an ordinary answer: most
   * runs are chats that never belonged to a card.
   */
  async findByRunId(runId: string, txEm?: EntityManager): Promise<Task | null> {
    return this.getOne({ runId }, {}, txEm);
  }

  /**
   * How many tasks a project holds. Read before a project delete, so the
   * acknowledgement can say how many cards went with the board.
   */
  async countInProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<number> {
    return this.count({ projectId }, txEm);
  }

  /**
   * The position to give the next card appended to a column.
   *
   * Counting the column is the wrong answer: a soft-deleted card keeps its
   * position but leaves the count, and a card moved to another column leaves
   * its old slot behind — so a count hands the next card a position a live
   * card still holds, and `orderBy: position` then leaves those two to
   * SQLite's tie-break. Reading the maximum cannot collide, at the price of
   * gaps, since nothing here renumbers.
   *
   * Projected to `position` alone, like `ItemDao.maxSeq`: hydrating the whole
   * newest row — `description` runs to `TASK_DESCRIPTION_MAX` — to read one
   * integer is waste, and attaching it to the caller's UnitOfWork is a side
   * effect this read has no business having.
   */
  async nextPositionIn(
    projectId: string,
    status: TaskStatus,
    txEm?: EntityManager,
  ): Promise<number> {
    const last = await this.getOne(
      { projectId, status },
      {
        orderBy: { position: 'desc' },
        fields: ['position'],
        disableIdentityMap: true,
      },
      txEm,
    );
    return (last?.position ?? -1) + 1;
  }

  /**
   * Move one card between columns in a single conditional UPDATE, reporting
   * whether it landed.
   *
   * The `status` in the WHERE clause is the entire mechanism. Two callers that
   * both read the card in `todo` both send `from: 'todo'`, and the database
   * applies exactly one of them — the loser matches no row and gets `false`.
   * Comparing in JavaScript instead cannot hold that line: the position lookup
   * between the read and the write is an `await`, and the autopilot's sweep is
   * precisely a caller that starts several moves inside one tick.
   *
   * `deletedAt` is named explicitly because a native update runs beneath the
   * `softDelete` filter; without it this would move a card someone deleted.
   * `updatedAt` likewise — the `onUpdate` hook belongs to the UnitOfWork and
   * does not fire here.
   *
   * A move INTO Done also stamps `lastDoneAt`, in this same statement, so the
   * merge watcher's round boundary cannot disagree with the column — see
   * `Task.lastDoneAt`. It is `doneAt` when the caller names one (a merge the
   * card was ended ON), else `at`.
   */
  async compareAndSetStatus(
    taskId: string,
    from: TaskStatus,
    to: TaskStatus,
    position: number,
    at: Date,
    txEm?: EntityManager,
    doneAt: Date = at,
  ): Promise<boolean> {
    const affected = await this.getRepo(txEm).nativeUpdate(
      { id: taskId, status: from, deletedAt: null } as FilterQuery<Task>,
      {
        status: to,
        position,
        updatedAt: at,
        ...(to === 'done' ? { lastDoneAt: doneAt } : {}),
      } as EntityData<Task>,
    );
    return affected === 1;
  }

  /**
   * Record, or forget, that this card's run was stopped — by the user, or by
   * an interruption named in `interruptedBy` — see `Task.stoppedAt`. Clearing
   * clears both.
   *
   * A native update of that one column, and deliberately not of `updatedAt`:
   * this is bookkeeping about the card's run rather than an edit of the card,
   * and `updatedAt` orders the merge watcher's handout.
   */
  async setStoppedAt(
    taskId: string,
    stoppedAt: Date | null,
    txEm?: EntityManager,
    interruptedBy: InterruptCause | null = null,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: taskId, deletedAt: null } as FilterQuery<Task>,
      {
        stoppedAt,
        interruptedBy: stoppedAt === null ? null : interruptedBy,
      } as EntityData<Task>,
    );
  }

  /**
   * Record, or forget (`null`), that the autopilot could not prepare this
   * card's worktree — see `Task.prepareFailedAt`. Not an edit of the card, so
   * `updatedAt` stays, on {@link setStoppedAt}'s reasoning.
   */
  async setPrepareFailure(
    taskId: string,
    failure: { at: Date; reason: string } | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: taskId, deletedAt: null } as FilterQuery<Task>,
      {
        prepareFailedAt: failure?.at ?? null,
        prepareFailedReason: failure?.reason ?? null,
      } as EntityData<Task>,
    );
  }

  /** Record, approve or clear the command center's request to start a card. */
  async setStartRequest(
    taskId: string,
    request: {
      requestedAt: Date;
      byRunId: string;
      approvedAt: Date | null;
      note?: string | null;
    } | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: taskId, deletedAt: null } as FilterQuery<Task>,
      {
        startRequestedAt: request?.requestedAt ?? null,
        startRequestedByRunId: request?.byRunId ?? null,
        startApprovedAt: request?.approvedAt ?? null,
        startRequestNote: request?.note ?? null,
      } as EntityData<Task>,
    );
  }

  /** Approve a pending start request; false when there is none to approve. */
  async approveStartRequest(
    taskId: string,
    at: Date,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const changed = await this.getRepo(txEm).nativeUpdate(
      {
        id: taskId,
        deletedAt: null,
        startRequestedAt: { $ne: null },
        startApprovedAt: null,
      } as FilterQuery<Task>,
      { startApprovedAt: at } as EntityData<Task>,
    );
    return changed > 0;
  }

  /**
   * A start went through: the request is over, but its requester stays
   * named until the command center has told it (`listStartedForManager`).
   */
  async settleStartRequest(
    taskId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      {
        id: taskId,
        deletedAt: null,
        startRequestedAt: { $ne: null },
      } as FilterQuery<Task>,
      { startRequestedAt: null, startApprovedAt: null } as EntityData<Task>,
    );
  }

  /** Cards a manager asked to start that have started and not been reported. */
  async listStartedForManager(txEm?: EntityManager): Promise<Task[]> {
    return this.getRepo(txEm).find(
      {
        startRequestedByRunId: { $ne: null },
        startRequestedAt: null,
        runId: { $ne: null },
        deletedAt: null,
      } as FilterQuery<Task>,
      { disableIdentityMap: true },
    );
  }

  /** Forget which manager asked for a card's start, once it has been told. */
  async clearStartRequester(
    taskId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: taskId } as FilterQuery<Task>,
      { startRequestedByRunId: null } as EntityData<Task>,
    );
  }

  /**
   * Take the report of a started card for `managerRunId`: true for the one
   * caller that cleared the requester, so a start is told once however many
   * task events race to tell it.
   */
  async claimStartReport(
    taskId: string,
    managerRunId: string,
    txEm?: EntityManager,
  ): Promise<boolean> {
    const claimed = await this.getRepo(txEm).nativeUpdate(
      { id: taskId, startRequestedByRunId: managerRunId } as FilterQuery<Task>,
      { startRequestedByRunId: null } as EntityData<Task>,
    );
    return claimed > 0;
  }

  /** Give a claimed report back when telling the manager failed, so it is tried again. */
  async releaseStartReport(
    taskId: string,
    managerRunId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.getRepo(txEm).nativeUpdate(
      { id: taskId, startRequestedByRunId: null } as FilterQuery<Task>,
      { startRequestedByRunId: managerRunId } as EntityData<Task>,
    );
  }

  /** Cards whose start request was approved and not yet started, oldest first. */
  async listApprovedStarts(txEm?: EntityManager): Promise<Task[]> {
    return this.getRepo(txEm).find(
      { startApprovedAt: { $ne: null }, deletedAt: null } as FilterQuery<Task>,
      { orderBy: { startApprovedAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** Cards with a start request still waiting on the user's Start. */
  async listPendingStartRequests(txEm?: EntityManager): Promise<Task[]> {
    return this.getRepo(txEm).find(
      {
        startRequestedAt: { $ne: null },
        startApprovedAt: null,
        deletedAt: null,
      } as FilterQuery<Task>,
      { orderBy: { startRequestedAt: 'asc' }, disableIdentityMap: true },
    );
  }

  /** The cards worked by these runs, live ones only. */
  async listByRunIds(
    runIds: readonly string[],
    txEm?: EntityManager,
  ): Promise<Task[]> {
    if (runIds.length === 0) {
      return [];
    }
    return this.getRepo(txEm).find(
      { runId: { $in: [...runIds] }, deletedAt: null } as FilterQuery<Task>,
      { disableIdentityMap: true },
    );
  }

  /**
   * Remove every task belonging to a project.
   *
   * Soft-delete, like every other default delete path here: `BaseDao.delete`
   * stamps `deletedAt` and the `softDelete` filter hides the rows from every
   * read. Nothing in this daemon declares a cascade, so the project service
   * calls this explicitly rather than leaving the rows behind on a board that
   * no longer exists.
   */
  async deleteForProject(
    projectId: string,
    txEm?: EntityManager,
  ): Promise<void> {
    await this.delete({ projectId }, txEm);
  }
}
