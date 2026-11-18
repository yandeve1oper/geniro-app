import { randomUUID } from 'node:crypto';

import { DateTimeType } from '@mikro-orm/core';
import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { TimestampsEntity } from '@packages/mikroorm';

import type { InterruptCause } from '../../../utils/stop-cause';
import type { ChatApprovalMode } from '../../agents/chat.types';
import type { AgentKind } from '../../runs/runs.types';
import type { TaskPriority, TaskSource, TaskStatus } from '../tasks.types';

/**
 * One card on a project's board.
 *
 * A plain `projectId` column rather than a MikroORM relation, the same shape
 * `Run.groupId` uses: nothing in this daemon declares a relation or a cascade,
 * so the owning service removes a project's tasks explicitly and the database
 * is never asked to.
 */
@Entity({ tableName: 'tasks' })
// The board's own query: every card in one project, which is what the screen
// asks for on every open and after every move.
@Index({ properties: ['projectId'] })
// The autopilot's query, and the one that is NOT scoped by project: "is
// anything sitting in an intake column", asked across every project on each
// sweep. Without this it is a full scan of the table on a timer.
@Index({ properties: ['status'] })
export class Task extends TimestampsEntity {
  @PrimaryKey({ type: 'string' })
  id: string = randomUUID();

  @Property({ type: 'string' })
  projectId!: string;

  @Property({ type: 'text' })
  title!: string;

  /**
   * This card's number within its project — the `12` of `GEN-12`.
   *
   * Handed out by the project's own counter at creation and never reused, so
   * an identifier names one card for good.
   */
  @Property({ type: 'integer', nullable: true })
  number: number | null = null;

  @Property({ type: 'text', nullable: true })
  description: string | null = null;

  /**
   * Files bound to this card, as a JSON array — see `TaskAttachmentSchema`.
   *
   * A JSON column rather than a table, on `labels`' own reasoning: this is a
   * short list read and written only with the card it belongs to, and nothing
   * ever queries across cards by attachment.
   *
   * Every entry is a REFERENCE to a file that is already on this machine, and
   * that is the decision the rest follows from — see the route's own doc.
   */
  @Property({ type: 'text' })
  attachments: string = '[]';

  @Property({ type: 'string' })
  status: TaskStatus = 'backlog';

  /**
   * JSON-encoded `string[]`, like `Item.payload` — this daemon stores
   * structured values as text and decodes them at the service boundary, and a
   * label list is not something any query filters on in the database.
   */
  @Property({ type: 'text' })
  labels: string = '[]';

  @Property({ type: 'string' })
  source: TaskSource = 'geniro';

  /**
   * The id this task carries in the system it came from. Null for a task made
   * here: geniro's own primary key is already that id, and a copy of it would
   * be a second name for the same thing.
   */
  @Property({ type: 'string', nullable: true })
  sourceRef: string | null = null;

  /**
   * The folder this card's agent works in — null to take the project's.
   *
   * A project's folder is the DEFAULT and not the law: one board routinely
   * holds work across several checkouts, and before this column a card could
   * only ever run where its project pointed. Null means INHERIT rather than
   * "none", so moving a project's folder moves every card that never named one
   * of its own — which is what makes the project's field a default at all. A
   * snapshot taken at create would freeze it and quietly turn the project's
   * setting into a one-time seed.
   *
   * Canonicalized and checked to exist when it is SET (`TasksService`), on
   * `Project.folder`'s own rule: a card pointing at a folder that is not there
   * could never run, and the failure would surface as a worktree that cannot
   * be cut, minutes later and one process away.
   */
  @Property({ type: 'text', nullable: true })
  folder: string | null = null;

  // ── Run configuration ───────────────────────────────────────────────────
  // The project's standing answers overridden for THIS card, on `folder`'s own
  // rule above: null means INHERIT rather than "none", so re-pointing a project
  // moves every card that named nothing of its own. `Project`'s block carries
  // the same six fields and the same null-means-unset reading — the two are
  // resolved together, most specific first, by `TaskRunsService.startClaimed`.
  //
  // A card names an agent OR a team, never both: `teamSlug` wins where
  // a task sets one, and the CLI-only fields beside it are meaningless to a
  // team, whose members carry their own. Nothing here is enforced at the column
  // level, because the inheritance makes "both set" reachable without either
  // row being wrong on its own — a project pinning an agent and a card pinning
  // a team is exactly the override this exists for.

  @Property({ type: 'string', nullable: true })
  agentKind: AgentKind | null = null;

  @Property({ type: 'string', nullable: true })
  model: string | null = null;

  @Property({ type: 'string', nullable: true })
  effort: string | null = null;

  /** JSON `{parameterId: value}`, as `Project.modelParameters` stores it. */
  @Property({ type: 'text', nullable: true })
  modelParameters: string | null = null;

  @Property({ type: 'string', nullable: true })
  approval: ChatApprovalMode | null = null;

  @Property({ type: 'text', nullable: true })
  configDir: string | null = null;

  /** A team to run this card through, instead of a single agent. */
  @Property({ type: 'string', nullable: true })
  teamSlug: string | null = null;

  /** The branch an agent works this task on — null until one runs. */
  @Property({ type: 'string', nullable: true })
  branch: string | null = null;

  /** The worktree that branch is checked out in — null until one runs. */
  @Property({ type: 'text', nullable: true })
  worktreePath: string | null = null;

  /**
   * The chat run currently serving this task. A plain id with no FK, matching
   * `Run.groupId`: a run deleted from the sidebar must not take the task with
   * it, so this is cleared rather than cascaded.
   */
  @Property({ type: 'string', nullable: true })
  runId: string | null = null;

  /**
   * The agent's report on this card, as markdown — written only by the agent
   * itself through the `update_task` board tool, never derived from the
   * transcript. Stored on the card because it is the card's: it outlives the
   * run that wrote it, and a deleted thread must not take the account of the
   * work with it.
   */
  @Property({ type: 'text', nullable: true })
  report: string | null = null;

  /** When {@link report} was last written — null while there is none. */
  @Property({ type: DateTimeType, nullable: true })
  reportedAt: Date | null = null;

  /**
   * When the user STOPPED this card's run, or an interruption the app did not
   * make (a crash, a SIGKILL) cut it off — null once a Run press has started it
   * again, and for a card nobody ever stopped.
   *
   * The autopilot's reason to leave the card alone, kept on the CARD because
   * the run cannot keep it: a Stop sends the card back to the intake column,
   * and the run's own `cancelled` lasts only until the user types into the
   * thread — the run goes `running`, then `completed`, the card reads as
   * waiting work, and the armed autopilot would continue it with the whole
   * brief again.
   *
   * Written by `TaskSettleService` on a cancel, and on an interruption the
   * autopilot must not continue ({@link interruptedBy}); cleared by a
   * successful start (`TaskRunsService.start`) — the one act that says "work
   * this again". Not on the wire: the board says why a card is held through
   * the queue's `blocked` list, which already carries the sentence.
   */
  @Property({ type: DateTimeType, nullable: true })
  stoppedAt: Date | null = null;

  /**
   * What cut the card's run off, when {@link stoppedAt} was set by an
   * interruption rather than by the user's Stop — a crash, or a stop nobody
   * announced. Null for a Stop, and cleared together with `stoppedAt`.
   *
   * The autopilot leaves such a card alone exactly as it leaves a stopped one:
   * the agent may have been halfway through an edit, and continuing it
   * unattended would re-send the brief over whatever it left behind.
   */
  @Property({ type: 'string', nullable: true })
  interruptedBy: InterruptCause | null = null;

  /**
   * When the autopilot last failed to prepare this card's worktree — reported
   * by Electron main, which makes worktrees (`POST /v1/tasks/:taskId/
   * prepare-failed`); null for a card whose last attempt did not fail there.
   *
   * The daemon never sees that failure otherwise, because no run is started:
   * without the mark the queue hands the same card out on every tick and it
   * holds the slot against every card behind it. Fresh, it puts the card in
   * the queue's `blocked` list; once `PREPARE_FAILURE_RETRY_MS` has passed the
   * card is handed out again, so a failure that healed on its own does not park
   * it for good. Cleared by a successful start, like {@link stoppedAt}. Not on
   * the wire.
   */
  @Property({ type: DateTimeType, nullable: true })
  prepareFailedAt: Date | null = null;

  /** git's own line for the failure at {@link prepareFailedAt}. */
  @Property({ type: 'text', nullable: true })
  prepareFailedReason: string | null = null;

  /**
   * When this card last ENTERED Done — null for a card that never has.
   *
   * The merge watcher's round boundary. A run's captured pull requests only
   * ever grow, and a card re-opened after Done continues the same thread, so
   * without a boundary the pull request that ended the card once is merged
   * still, and ends it again the moment the card is back in review — with the
   * new pull request unreviewed and its worktree collected. So a merge ends the
   * card only if it HAPPENED after this instant — GitHub's merge time, which
   * the merge watcher reads and `TaskMergeService` checks. Never by when a pull
   * request was captured: a card dragged to Done and back while its pull
   * request was still open must still be ended when that pull request merges.
   *
   * Taken on ENTERING Done rather than on the next start, because a start is
   * also how a card in review is sent back for another pass on the SAME, still
   * open pull request — a boundary there would retire the one pull request that
   * round is for. Written in the same conditional UPDATE as the move
   * (`TaskDao.compareAndSetStatus`), so every road to Done — a drag, the
   * agent's `update_task`, the merge watcher — sets it.
   */
  @Property({ type: DateTimeType, nullable: true })
  lastDoneAt: Date | null = null;

  /**
   * Order within the column, ascending. Neither contiguous nor monotonic over
   * time: a delete and a move-out each leave a hole nothing renumbers, and
   * deleting the LAST card frees a number the next one is given again.
   *
   * Unique within a column so long as positions are allocated one at a time,
   * which is what `TaskDao.nextPositionIn` buys by appending past the current
   * maximum instead of counting the live rows. Two allocations in a single
   * tick would still collide — no unique index backs this — so a caller that
   * fans several creates or moves out at once needs a conditional write
   * rather than this contract.
   *
   * `RunGroup.position` is NOT the stronger precedent it looks like: its
   * create is count-based too, and its own contract is that a reorder repairs
   * whatever shared a position, which this module has no route to do.
   */
  @Property({ type: 'integer' })
  position: number = 0;

  @Property({ type: 'string' })
  priority: TaskPriority = 'none';

  /**
   * The day this task is due, `YYYY-MM-DD`, or null.
   *
   * A DATE string and not a `Date` column: a due date is a day in the reader's
   * own life, so an instant would pin it to whichever zone wrote it and move it
   * a day for everyone else. Nothing compares it to a clock — the board
   * compares it to today, which is also a local idea.
   */
  @Property({ type: 'string', nullable: true })
  dueDate: string | null = null;

  /**
   * When the command center's manager asked to start this card
   * (`start_thread`), and which manager run asked. Cleared by a successful
   * start or by the request's Deny or failure. Not on the wire.
   */
  @Property({ type: DateTimeType, nullable: true })
  startRequestedAt: Date | null = null;

  @Property({ type: 'string', nullable: true })
  startRequestedByRunId: string | null = null;

  /** The manager's note for the thread this start makes, put on its roster once it runs. */
  @Property({ type: 'text', nullable: true })
  startRequestNote: string | null = null;

  /**
   * When that request was approved — the user's Start, or at once in a manager
   * chat running in `auto`. Electron main's start drain picks up exactly the
   * cards with this set.
   */
  @Property({ type: DateTimeType, nullable: true })
  startApprovedAt: Date | null = null;
}
