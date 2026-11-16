import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import { Entity, PrimaryKey, Property } from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind } from '../../runs/runs.types';
import type { TaskSource, TaskStatus } from '../../tasks/tasks.types';
import {
  type LessonOverride,
  PROJECT_DEFAULT_MAX_CONCURRENT,
} from '../projects.types';

/**
 * A folder, and the standing answers for every task worked inside it.
 *
 * Deliberately NOT the chat sidebar's {@link RunGroup}, which it links to
 * instead: a group is a disposable arrangement of one user's sidebar, carrying
 * display state (position, collapsed), while a project carries folder identity,
 * run defaults and autopilot policy. Loading that onto every throwaway group
 * was the alternative, and it would make a folder the user made to tidy three
 * chats into a thing that can start agents.
 */
@Entity({ tableName: 'projects' })
export class Project extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'text' })
  name!: string;

  /**
   * Absolute, and canonicalized by the service before it is stored.
   *
   * At most one LIVE project may hold a folder, and that is a safety
   * property rather than tidiness: the autopilot bounds concurrent work per
   * PROJECT while a worktree is created in the FOLDER, so two projects
   * sharing one would give that folder twice the cap it is meant to hold to.
   *
   * Enforced by `ProjectsService.refuseTakenFolder` and NOT by a unique
   * index, because the database cannot express "live": a soft delete leaves
   * the row and its folder behind, so a plain unique index reserves the
   * folder forever and removing a project then adding it back raises
   * `UNIQUE constraint failed: projects.folder` from the driver. The `where`
   * option that would scope such an index to `deleted_at is null` is dropped
   * by MikroORM's sqlite schema generator, so the check lives where the
   * filter does and answers with a named refusal rather than a 500.
   */
  @Property({ type: 'text' })
  folder!: string;

  /**
   * The short prefix every card on this board is numbered under — `GEN-12`.
   *
   * DERIVED from the name at creation (`projectKey`) and then owned by the row:
   * renaming a project must not renumber cards that have already been quoted
   * in a commit message or a chat.
   */
  @Property({ type: 'string', nullable: true })
  taskKey: string | null = null;

  /**
   * The highest card number handed out on this board.
   *
   * On the PROJECT rather than computed from `max(task.number)`, because the
   * cards it counts are deletable: numbering off a live maximum would hand the
   * next card the number of one that was thrown away, and two commits would
   * then name different work by the same identifier.
   */
  @Property({ type: 'integer' })
  taskCounter: number = 0;

  /**
   * The sidebar group this project's task runs file themselves into. A plain
   * id with no FK, matching `Run.groupId`: deleting the group must release the
   * project rather than delete it, so this is nulled and never cascaded.
   */
  @Property({ type: 'string', nullable: true })
  groupId: string | null = null;

  @Property({ type: 'text', nullable: true })
  description: string | null = null;

  /** The blocks' texts joined in order; written with {@link instructionBlocks}. */
  @Property({ type: 'text', nullable: true })
  instructions: string | null = null;

  /**
   * JSON `ProjectInstructionBlock[]`. Null on a project written before blocks,
   * whose {@link instructions} then reads as one block (`projectBlocksOf`).
   */
  @Property({ type: 'text', nullable: true })
  instructionBlocks: string | null = null;

  /**
   * Counts every change to {@link description} or {@link instructions}. A
   * writer that read them quotes it back (`expectedInstructionsRevision`), so
   * the Projects page's autosave and an analysis's write never overwrite each
   * other unseen.
   */
  @Property({ type: 'integer' })
  instructionsRevision: number = 0;

  // ── Run configuration ───────────────────────────────────────────────────
  // Null throughout, and null means "unset — use whatever the composer would
  // have". A project that has never been configured must not pin an agent or a
  // model the user never chose, so none of these carries a default.

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: 'string', nullable: true })
  effort: string | null = null;

  @Property({ type: 'string', nullable: true })
  contextWindow: string | null = null;

  /** JSON `{parameterId: value}`, as `Run.modelParameters` stores it. */
  @Property({ type: 'text', nullable: true })
  modelParameters: string | null = null;

  @Property({ type: 'string', nullable: true })
  approval: ChatApprovalMode | null = null;

  @Property({ type: 'text', nullable: true })
  configDir: string | null = null;

  /** A team to run a task through, instead of a single agent. */
  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  // ── Autopilot policy ────────────────────────────────────────────────────
  // Stored here from the start so the board and the conductor read one row
  // rather than two. Nothing in this milestone acts on any of it.

  @Property({ type: 'boolean' })
  autopilotEnabled: boolean = false;

  /**
   * The column the autopilot picks work up from. `todo` rather than `backlog`
   * so that switching autopilot on claims the work the user has actually
   * queued, not everything they have ever jotted down.
   */
  @Property({ type: 'string' })
  autopilotIntakeStatus: TaskStatus = 'todo';

  /**
   * How many of this project's tasks may run at once. One by default because
   * each running task takes its own git worktree — a second concurrent task is
   * a second working copy on disk, `node_modules` and all.
   */
  @Property({ type: 'integer' })
  autopilotMaxConcurrent: number = PROJECT_DEFAULT_MAX_CONCURRENT;

  /**
   * Consecutive failed autopilot runs. The breaker reads it to stop a project
   * that is failing every task it picks up; a success resets it to 0.
   */
  @Property({ type: 'integer' })
  autopilotFailureStreak: number = 0;

  /**
   * Until when the autopilot waits out a spent usage limit. The moment passing
   * ends the wait, so nothing has to clear this.
   */
  @Property({ type: DateTimeType, nullable: true })
  autopilotLimitUntil: Date | null = null;

  /**
   * Where this project's tasks come from, and the value they carry as their
   * own `source`. One vocabulary rather than two that have to agree.
   */
  @Property({ type: 'string' })
  provider: TaskSource = 'geniro';

  /** Whether this project's threads are offered lessons reflections; null inherits. */
  @Property({ type: 'string', nullable: true })
  lessons: LessonOverride | null = null;
}
