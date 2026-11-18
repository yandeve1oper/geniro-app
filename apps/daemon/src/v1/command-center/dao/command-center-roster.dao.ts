import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable } from '@nestjs/common';
import { BaseDao } from '@packages/mikroorm';

import { KeyedChain } from '../../agents/utils/keyed-chain';
import type { RosterReason } from '../command-center.types';
import { CommandCenterRosterEntry } from '../entity/command-center-roster.entity';

const HANDLE_PATTERN = /^t(\d+)$/;

/** `command_center_roster` — the threads each manager holds. */
@Injectable()
export class CommandCenterRosterDao extends BaseDao<CommandCenterRosterEntry> {
  /** One manager's joins in turn: each reads the handles the last one wrote. */
  private readonly joins = new KeyedChain();

  constructor(em: EntityManager) {
    super(em, CommandCenterRosterEntry);
  }

  /** Every row of one manager, left ones included, in joining order. */
  async listOf(
    managerRunId: string,
    txEm?: EntityManager,
  ): Promise<CommandCenterRosterEntry[]> {
    return this.getRepo(txEm ?? this.em.fork()).find(
      { managerRunId },
      {
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
        disableIdentityMap: true,
      },
    );
  }

  /**
   * Put threads on the roster: a new one under the next handle, one that had
   * left back under its own. Answers whether any row changed.
   */
  async join(
    managerRunId: string,
    threadRunIds: readonly string[],
    reason: RosterReason,
    at: Date,
  ): Promise<boolean> {
    if (threadRunIds.length === 0) {
      return false;
    }
    return this.joins.run(managerRunId, () =>
      this.joinNow(managerRunId, threadRunIds, reason, at),
    );
  }

  private joinNow(
    managerRunId: string,
    threadRunIds: readonly string[],
    reason: RosterReason,
    at: Date,
  ): Promise<boolean> {
    return this.em.fork().transactional(async (tx) => {
      const rows = await this.listOf(managerRunId, tx);
      const byThread = new Map(rows.map((row) => [row.threadRunId, row]));
      let next =
        rows.reduce((max, row) => {
          const n = Number(HANDLE_PATTERN.exec(row.handle)?.[1] ?? 0);
          return Math.max(max, n);
        }, 0) + 1;
      let changed = false;
      for (const threadRunId of new Set(threadRunIds)) {
        const row = byThread.get(threadRunId);
        if (row === undefined) {
          this.getRepo(tx).create(
            {
              managerRunId,
              threadRunId,
              handle: `t${next}`,
              reason,
              note: null,
              joinedAt: at,
              leftAt: null,
            },
            { partial: true },
          );
          next += 1;
          changed = true;
        } else if (row.leftAt !== null) {
          await tx.nativeUpdate(
            CommandCenterRosterEntry,
            { id: row.id },
            { leftAt: null, joinedAt: at, reason },
          );
          changed = true;
        }
      }
      await tx.flush();
      return changed;
    });
  }

  /** Take threads off the roster, keeping their rows and handles. */
  async leave(
    managerRunId: string,
    threadRunIds: readonly string[],
    at: Date,
    txEm?: EntityManager,
  ): Promise<void> {
    if (threadRunIds.length === 0) {
      return;
    }
    await (txEm ?? this.em.fork()).nativeUpdate(
      CommandCenterRosterEntry,
      { managerRunId, threadRunId: { $in: [...threadRunIds] }, leftAt: null },
      { leftAt: at },
    );
  }

  async setNote(
    managerRunId: string,
    threadRunId: string,
    note: string | null,
    txEm?: EntityManager,
  ): Promise<void> {
    await (txEm ?? this.em.fork()).nativeUpdate(
      CommandCenterRosterEntry,
      { managerRunId, threadRunId },
      { note },
    );
  }

  /** Every row of a manager being deleted. */
  async deleteOf(managerRunId: string, txEm?: EntityManager): Promise<void> {
    await (txEm ?? this.em.fork()).nativeDelete(CommandCenterRosterEntry, {
      managerRunId,
    });
  }
}
