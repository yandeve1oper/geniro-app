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
  LessonSegmentCloser,
  LessonSegmentStatus,
} from '../lessons.types';

/**
 * One stretch of a thread a reflection reads: the items after `fromSeq`, up to
 * and including `toSeq`. Queued by an archive, a delete with the box ticked
 * or "Reflect now", and run by `LessonAutoRunner`. Dropped with its run by
 * `LessonReflectionService` on `bus.allDeleted()`.
 */
@Entity({ tableName: 'lesson_segments' })
@Index({ properties: ['runId', 'status'] })
@Index({ properties: ['status', 'closedAt'] })
export class LessonSegment extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  runId!: string;

  /** The watermark the segment starts after (exclusive); -1 for a thread never reflected on. */
  @Property({ type: 'integer' })
  fromSeq!: number;

  @Property({ type: 'integer' })
  toSeq!: number;

  @Property({ type: 'string' })
  closedBy!: LessonSegmentCloser;

  @Property({ type: DateTimeType })
  closedAt: Date = new Date();

  /** `LessonSignal[]` as JSON. */
  @Property({ type: 'text' })
  signals: string = '[]';

  @Property({ type: 'string' })
  status!: LessonSegmentStatus;

  /** Why a stretch was skipped: the user's Skip, or Lessons switched off before it ran. */
  @Property({ type: 'string', nullable: true })
  skipReason: 'user_skipped' | 'off' | null = null;

  /** Until when a running reflection or check holds the stretch; the runner takes it back after. */
  @Property({ type: DateTimeType, nullable: true })
  leaseUntil: Date | null = null;

  @Property({ type: 'string', nullable: true })
  reflectionRunId: string | null = null;

  @Property({ type: 'string', nullable: true })
  checkRunId: string | null = null;

  /** Why the last attempt failed, in the daemon's words. */
  @Property({ type: 'text', nullable: true })
  failReason: string | null = null;

  @Property({ type: 'integer', nullable: true })
  estimateTokens: number | null = null;

  @Property({ type: 'float', nullable: true })
  estimateUsd: number | null = null;

  @Property({ type: 'integer' })
  attempts: number = 0;
}
