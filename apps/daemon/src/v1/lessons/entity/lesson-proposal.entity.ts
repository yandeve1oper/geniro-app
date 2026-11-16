import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { LessonProposalStatus, LessonSignalKind } from '../lessons.types';

/**
 * One lesson a reflection proposed, and what the user did with it.
 *
 * Exempt from run teardown, like `team_recommendations`: a rejected proposal
 * keeps a later reflection of the same project or team from proposing it
 * again, and the thread it came from may be deleted long before that.
 * `sourceTitle` is a copy for the same reason.
 */
@Entity({ tableName: 'lesson_proposals' })
@Index({ properties: ['sourceRunId'] })
@Index({ properties: ['status', 'projectId'] })
@Index({ properties: ['status', 'teamSlug'] })
export class LessonProposal extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  sourceRunId!: string;

  @Property({ type: 'text', nullable: true })
  sourceTitle: string | null = null;

  @Property({ type: 'string' })
  reflectionRunId!: string;

  @Property({ type: 'string' })
  segmentId!: string;

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  rule!: string;

  @Property({ type: 'text' })
  why!: string;

  @Property({ type: 'string' })
  signalKind!: LessonSignalKind;

  @Property({ type: 'integer' })
  evidenceSeq!: number;

  @Property({ type: 'text' })
  evidenceQuote!: string;

  /** `LessonTarget` as JSON. */
  @Property({ type: 'text' })
  target!: string;

  /** `LessonDedup` as JSON. */
  @Property({ type: 'text' })
  dedup!: string;

  @Property({ type: 'string' })
  status: LessonProposalStatus = 'proposed';

  @Property({ type: 'text', nullable: true })
  rejectReason: string | null = null;

  /** The memory entry's handle (`m12`) a save wrote. */
  @Property({ type: 'string', nullable: true })
  resultRef: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  decidedAt: Date | null = null;
}
