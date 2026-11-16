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
import type { UsagePurpose } from '../stats.types';

/**
 * One finished turn's usage, recorded to OUTLIVE the run that produced it.
 *
 * Every figure here is already in the `turn_complete` item's payload, so this
 * table stores nothing new — what it changes is the LIFETIME. `RunTeardownService`
 * hard-deletes a run's `items` with the soft-delete filter disabled, so a chat
 * the user tidied away takes its whole spend history with it, and a lifetime
 * total computed from `items` silently shrinks every time someone cleans up.
 * Nothing here is written by the teardown, and that omission is the feature.
 *
 * **Dimensions are denormalized on purpose.** `agentKind` / `model` / `cwd` live
 * on `runs` and `node_state`, both of which the same teardown destroys — so a
 * join could only answer for runs that still exist, which is exactly the
 * population this table exists to look past. They are copied at write time and
 * are a record of what that turn actually ran as, not of what the run says now.
 *
 * **One row per run is not a turn.** A run an account poll has priced
 * also holds a POLLED-spend row, keyed by `POLLED_SPEND_SEQ` in place of a
 * transcript seq: the poll's running total (`Run.polledCostCents`), copied here
 * for the same lifetime reason and rewritten in place as the poll moves it.
 * That is the one row this table ever updates, and `isPolledSpend` is how a
 * reader that counts turns keeps it out of the count.
 */
@Entity({ tableName: 'usage_events' })
// The idempotency key, and the reason the backfill can run on every boot: a
// turn is identified by its own transcript row, so re-recording one is refused
// by the database rather than by a caller remembering to check.
@Unique({ properties: ['runId', 'seq'] })
// The page's only range predicate — every query here is "this period".
@Index({ properties: ['occurredAt'] })
export class UsageEvent extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  /**
   * The run this turn belonged to. Deliberately a plain string with no FK, like
   * `Item.runId` — the row must survive its run's deletion, so a constraint
   * that made it cascade would defeat the table.
   */
  @Property({ type: 'string' })
  runId!: string;

  /** Team member that produced the turn; null for a single-agent chat. */
  @Property({ type: 'string', nullable: true })
  memberId: string | null = null;

  /** The source `turn_complete` item's seq — half the idempotency key. */
  @Property({ type: 'integer' })
  seq!: number;

  /**
   * When the turn finished — the source item's own `createdAt`, never this
   * row's. The backfill writes rows long after the fact, so `createdAt` would
   * bucket a year of history into the day the ledger was introduced.
   */
  @Property({ type: DateTimeType })
  occurredAt!: Date;

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  /** The folder the turn ran in — the page's per-project breakdown. */
  @Property({ type: 'text', nullable: true })
  cwd: string | null = null;

  /**
   * The team this turn belonged to, or null for a single-agent chat.
   *
   * The NAME, denormalized like every dimension here, because the run that
   * knows it is destroyed with the chat and the team YAML behind it can be
   * renamed or deleted independently. Rows written before this column existed
   * carry null and are therefore indistinguishable from chats in the breakdown
   * — a name that was never recorded cannot be recovered, and inventing one
   * would be worse than saying nothing.
   */
  @Property({ type: 'text', nullable: true })
  teamName: string | null = null;

  /** `lessons` for a turn of a hidden lessons reflection, null for every other turn. */
  @Property({ type: 'string', nullable: true })
  purpose: UsagePurpose | null = null;

  /**
   * Every figure below is nullable, and null means NOT MEASURED rather than
   * zero. cursor-agent reports no cost unless its currency is USD, and no
   * cache, thinking or timing figures at all, so a column defaulted to 0 would
   * turn "this CLI does not say" into "this cost nothing" — a lie about money
   * that no downstream sum could undo.
   */
  @Property({ type: 'float', nullable: true })
  costUsd: number | null = null;

  /**
   * Of {@link costUsd}, the part geniro priced from token counts rather than
   * read off the CLI's bill. Null on every row written before it was recorded,
   * which therefore reads as the CLI's own figure.
   */
  @Property({ type: 'float', nullable: true })
  estimatedCostUsd: number | null = null;

  @Property({ type: 'integer', nullable: true })
  inputTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  outputTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  cacheReadTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  cacheCreationTokens: number | null = null;

  @Property({ type: 'integer', nullable: true })
  thinkingTokens: number | null = null;

  /** The CLI's own reported working time for the turn. */
  @Property({ type: 'integer', nullable: true })
  durationMs: number | null = null;

  /** Of that, the part spent inside the model API. */
  @Property({ type: 'integer', nullable: true })
  apiMs: number | null = null;

  /** How long the turn waited before its first token came back. */
  @Property({ type: 'integer', nullable: true })
  ttftMs: number | null = null;

  /** How long the turn spent before its first request was even sent. */
  @Property({ type: 'integer', nullable: true })
  timeToRequestMs: number | null = null;

  /** How many model requests the turn made. */
  @Property({ type: 'integer', nullable: true })
  numTurns: number | null = null;
}
