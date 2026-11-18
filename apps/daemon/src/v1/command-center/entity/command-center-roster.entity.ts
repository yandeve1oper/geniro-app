import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { RosterReason } from '../command-center.types';

/**
 * One thread on a command-center manager's roster. A thread that leaves keeps
 * its row with {@link leftAt} set, so its handle is never handed to another
 * thread; only deleting the manager drops its rows.
 */
@Entity({ tableName: 'command_center_roster' })
@Unique({ properties: ['managerRunId', 'threadRunId'] })
@Unique({ properties: ['managerRunId', 'handle'] })
export class CommandCenterRosterEntry extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  managerRunId!: string;

  @Property({ type: 'string' })
  threadRunId!: string;

  /** `t<N>`, numbered per manager in the order threads joined. */
  @Property({ type: 'string' })
  handle!: string;

  @Property({ type: 'string' })
  reason: RosterReason = 'auto';

  /** The manager's own note on the thread (`note_thread`). */
  @Property({ type: 'text', nullable: true })
  note: string | null = null;

  @Property({ type: DateTimeType })
  joinedAt!: Date;

  @Property({ type: DateTimeType, nullable: true })
  leftAt: Date | null = null;
}
