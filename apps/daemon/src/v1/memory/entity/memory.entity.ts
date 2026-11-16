import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { AgentKind } from '../../runs/runs.types';
import type {
  MemoryActorKind,
  MemoryStatus,
  MemoryType,
} from '../memory.types';

/**
 * One entry of the memory every agent shares, whichever CLI it runs on.
 *
 * Exactly one scope: `projectId` set is a project's, `teamSlug` set is a
 * team's, both null is GLOBAL (every run sees it). Provenance is a plain copy,
 * never a foreign key: a deleted chat leaves its memories behind, and run
 * teardown never touches this table.
 */
@Entity({ tableName: 'memories' })
@Index({ properties: ['projectId', 'status'] })
@Index({ properties: ['teamSlug', 'status'] })
@Unique({ properties: ['handle'] })
export class Memory extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /** Shown as `m<handle>`; allocated one past the highest, never reused. */
  @Property({ type: 'integer' })
  handle!: number;

  @Property({ type: 'text' })
  title!: string;

  @Property({ type: 'text' })
  body!: string;

  @Property({ type: 'string' })
  type!: MemoryType;

  @Property({ type: 'string', nullable: true })
  projectId: string | null = null;

  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  @Property({ type: 'string' })
  status!: MemoryStatus;

  /** Bumped by every write; a writer quoting an older one is refused. */
  @Property({ type: 'integer' })
  rev: number = 1;

  @Property({ type: 'string' })
  sourceActor!: MemoryActorKind;

  @Property({ type: 'string', nullable: true })
  sourceAgentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  sourceModel: string | null = null;

  @Property({ type: 'string', nullable: true })
  sourceRunId: string | null = null;

  @Property({ type: 'text', nullable: true })
  sourceImportedFrom: string | null = null;

  /** The lesson proposal a user's save of a lesson wrote this entry from. */
  @Property({ type: 'string', nullable: true })
  lessonProposalId: string | null = null;

  @Property({ type: 'text', nullable: true })
  forgetReason: string | null = null;

  /** What a forgotten entry was before it was forgotten; a restore returns it there. */
  @Property({ type: 'string', nullable: true })
  statusBeforeForget: MemoryStatus | null = null;

  @Property({ type: DateTimeType, nullable: true })
  lastUsedAt: Date | null = null;

  /**
   * When the user approved this entry by hand; any save since clears it, and
   * forgetting and restoring keep it. With a user's or an import's own entries, it is
   * what admits an entry to a run's memory index.
   */
  @Property({ type: DateTimeType, nullable: true })
  approvedAt: Date | null = null;

  /** Set while the user keeps the entry out of the cleanup list. */
  @Property({ type: DateTimeType, nullable: true })
  keptAt: Date | null = null;

  /** When the entry was last forgotten; null on rows forgotten before it existed. */
  @Property({ type: DateTimeType, nullable: true })
  forgottenAt: Date | null = null;

  @Property({ type: DateTimeType, nullable: true })
  restoredAt: Date | null = null;

  /** The cleanup that forgot it; a batch undo restores only rows still carrying it. */
  @Property({ type: 'string', nullable: true })
  forgetBatchId: string | null = null;

  /** Whether the text opens with a stated limit; null until the sweep has read it. */
  @Property({ type: 'boolean', nullable: true })
  statesRule: boolean | null = null;

  /** Repo-relative paths the text names, as a JSON array of strings. */
  @Property({ type: 'text', nullable: true })
  referencedPaths: string | null = null;

  /**
   * The referenced paths missing from the project folder at the last check,
   * as a JSON array; null when none is missing or none could be judged.
   */
  @Property({ type: 'text', nullable: true })
  referencesGone: string | null = null;

  @Property({ type: DateTimeType, nullable: true })
  referencesCheckedAt: Date | null = null;

  /** The entry a merge wrote in this one's place, while this one stays forgotten by it. */
  @Property({ type: 'string', nullable: true })
  mergedIntoId: string | null = null;
  /**
   * Set when the user deleted an imported entry for good: the row stays,
   * emptied, so its handle is never handed out again, and this hash of its
   * `importedText` lets a later import preview leave the same note unticked.
   */
  @Property({ type: 'string', nullable: true })
  purgedTextHash: string | null = null;
}
