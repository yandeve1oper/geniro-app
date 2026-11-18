import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type {
  ThreadMessageReason,
  ThreadMessageStatus,
} from '../../agents/chat.types';

/**
 * One message an agent sent to another thread. The durable mailbox: written
 * before anything is delivered, so a message survives a restart, and flipped
 * to `delivered` once a turn took it. `fromRunId` is a plain string and the
 * sender's title is copied, so a message outlives a deleted sender; the rows
 * addressed to a deleted thread go with it (`RunTeardownService`).
 */
@Entity({ tableName: 'thread_messages' })
@Index({ properties: ['toRunId', 'status'] })
@Index({ properties: ['fromRunId', 'toRunId', 'createdAt'] })
@Index({ properties: ['toRunId', 'createdAt'] })
export class ThreadMessage extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  fromRunId!: string;

  @Property({ type: 'text' })
  fromTitle!: string;

  /** The sending member's name; null for a chat's agent. */
  @Property({ type: 'text', nullable: true })
  fromMember: string | null = null;

  /** The sender's conversation, owed a note when this message is not delivered. */
  @Property({ type: 'string' })
  fromSessionKey!: string;

  @Index()
  @Property({ type: 'string' })
  toRunId!: string;

  @Property({ type: 'text' })
  text!: string;

  /** False when the sender asked not to wake an idle thread. */
  @Property({ type: 'boolean' })
  wake!: boolean;

  @Property({ type: 'string' })
  status: ThreadMessageStatus = 'waiting';

  /** Why it still waits; null while a wake carrying it is under way. */
  @Property({ type: 'string', nullable: true })
  reason: ThreadMessageReason | null = null;

  /** Names the message to the running turn it was joined into. */
  @Property({ type: 'string', nullable: true })
  deliveryId: string | null = null;

  /** When a wake was last spent on it. */
  @Property({ type: DateTimeType, nullable: true })
  wokeAt: Date | null = null;

  /** How many wakes were spent on it — what the per-thread wake limit sums. */
  @Property({ type: 'integer' })
  wakes: number = 0;

  @Property({ type: DateTimeType, nullable: true })
  deliveredAt: Date | null = null;

  /**
   * Set on a command-center manager's message that expects a reply: until
   * then, the first reply from the receiver wakes the manager past its wake
   * and join budgets, once (`ThreadDeliveryService`).
   */
  @Property({ type: DateTimeType, nullable: true })
  replyCreditUntil: Date | null = null;

  /** When a reply spent {@link replyCreditUntil}; a credit is used at most once. */
  @Property({ type: DateTimeType, nullable: true })
  replyCreditSpentAt: Date | null = null;
}
