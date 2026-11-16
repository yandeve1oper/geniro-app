import { randomUUID } from 'node:crypto';

import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import type { MemoryMarkSource, MemoryMarkVerdict } from '../memory.types';

/**
 * What one thread said about one shared-memory entry: an agent's
 * `memory_feedback`, or the effect a lessons reflection of that thread saw.
 * A thread's later mark from the same source replaces its earlier one. The
 * thread is the run itself — every member of a team run marks as one thread.
 * Outside run teardown, like the entries it counts.
 */
@Entity({ tableName: 'memory_marks' })
@Unique({ properties: ['memoryId', 'threadId', 'source'] })
@Index({ properties: ['memoryId'] })
export class MemoryMark extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  memoryId!: string;

  @Property({ type: 'string' })
  threadId!: string;

  /** The run that made the mark: the thread itself, or the reflection on it. */
  @Property({ type: 'string' })
  runId!: string;

  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  @Property({ type: 'string' })
  source!: MemoryMarkSource;

  @Property({ type: 'string' })
  verdict!: MemoryMarkVerdict;

  @Property({ type: 'text' })
  reason!: string;

  @Property({ type: 'integer', nullable: true })
  evidenceSeq: number | null = null;

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;
}
