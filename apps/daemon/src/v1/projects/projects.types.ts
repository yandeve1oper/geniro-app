import type { EntityManager } from '@mikro-orm/sqlite';
import { z } from 'zod';

import type { InterruptCause } from '../../utils/stop-cause';
import {
  type ChatApprovalMode,
  ChatApprovalModeSchema,
  hasControlCharacters,
} from '../agents/chat.types';
import {
  type AgentKind,
  AgentKindSchema,
  type ProjectSource,
} from '../runs/runs.types';
import type { Task } from '../tasks/entity/task.entity';
import {
  TaskSourceSchema,
  type TaskStatus,
  TaskStatusSchema,
} from '../tasks/tasks.types';
import type { Project } from './entity/project.entity';

/** A project's name — non-blank after trimming, sanely bounded. */
export const PROJECT_NAME_MAX = 120;

/** Bounds on a project's description and instructions; twinned in the renderer's `projects/project-instructions-form.tsx`. */
export const PROJECT_DESCRIPTION_MAX = 2000;
export const PROJECT_INSTRUCTIONS_MAX = 20_000;

/** TWIN: the renderer's `projects/project-instruction-blocks.ts`. */
export const PROJECT_BLOCK_TITLE_MAX = 80;
export const PROJECT_BLOCK_ID_MAX = 64;
export const MAX_PROJECT_INSTRUCTION_BLOCKS = 40;

const noControlCharacters = (value: string): boolean =>
  !hasControlCharacters(value);

/**
 * One block of a project's instructions: a title the editor shows and text
 * every run in the project receives. Blocks are joined in order, titles left
 * out, the way a team's are.
 */
export const ProjectInstructionBlockSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(PROJECT_BLOCK_ID_MAX)
      .refine(noControlCharacters, 'must not contain control characters')
      .describe('Unique block id within the project'),
    title: z
      .string()
      .max(PROJECT_BLOCK_TITLE_MAX)
      .refine(noControlCharacters, 'must not contain control characters')
      .describe('Short name shown in the editor'),
    text: z
      .string()
      .max(PROJECT_INSTRUCTIONS_MAX)
      .refine(noControlCharacters, 'must not contain control characters')
      .describe('Instruction text every run in the project receives'),
  })
  .meta({ id: 'ProjectInstructionBlock' });
export type ProjectInstructionBlock = z.infer<
  typeof ProjectInstructionBlockSchema
>;

/** How many projects one machine may hold — a guard, not a design limit. */
export const MAX_PROJECTS = 200;

/** What a run is known by before its row exists: the facts its project follows from. */
export interface RunProjectFacts {
  taskId: string | null;
  cwd: string | null;
  /**
   * The project the run was started under by choice: an id binds it, null
   * means none even inside a project's folder, and absent leaves it to the
   * card and the folder.
   */
  projectId?: string | null;
}

/** {@link RunProjectFacts} plus the team a team run belongs to; absent for a chat. */
export type RunPlaceFacts = RunProjectFacts & {
  teamSlug?: string | null;
};

/** Where a document or memory entry is filed and what a run reads from: at most one of the two is set on a filed row. */
export interface RunPlace {
  projectId: string | null;
  teamSlug: string | null;
}

/** What a deleted project's or team's knowledge documents become. */
export const KNOWLEDGE_FATES = ['global', 'delete'] as const;
export type KnowledgeFate = (typeof KNOWLEDGE_FATES)[number];

/** A handle a move to Global changed, because Global held it. */
export const KnowledgeRenamedSchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type KnowledgeRenamed = z.infer<typeof KnowledgeRenamedSchema>;

/** What a project's removal did to the documents filed under it. */
export interface ProjectKnowledgeRemoval {
  moved: number;
  deleted: number;
  renamed: KnowledgeRenamed[];
  /** Announce the change; called once the removal has committed. */
  announce: () => void;
}

/**
 * Settles a removed project's knowledge inside the removal's own transaction.
 * Every statement is built on `tx`: a forked one would wait on the connection
 * the transaction holds, for ever.
 */
export type ProjectRemovalParticipant = (
  projectId: string,
  fate: KnowledgeFate,
  tx: EntityManager,
) => Promise<ProjectKnowledgeRemoval>;

/** What deleting a project answers. */
export interface ProjectDeleted {
  deleted: boolean;
  tasksRemoved: number;
  knowledgeMoved: number;
  knowledgeDeleted: number;
  knowledgeRenamed: KnowledgeRenamed[];
}

/** Which project a new run belongs to and how that was settled. */
export interface RunProject {
  project: Project | null;
  source: ProjectSource;
}

/** What a new run keeps of its project, written onto its row at creation. */
export interface RunPlacement {
  projectId: string | null;
  /** The project's sidebar group, when the run was started under it by choice. */
  chosenProjectGroupId: string | null;
  /** Null when the project could not be read. */
  source: ProjectSource | null;
  /** The composed name, description and instructions; null for none. */
  instructions: string | null;
}

/**
 * How many tasks one project may run at once, at most.
 *
 * A ceiling on the setting, not the setting: each running task takes its own
 * git worktree, which on a repo with a real `node_modules` is a full working
 * copy on disk. The default is 1 for the same reason.
 */
export const PROJECT_MAX_CONCURRENT_CEILING = 5;
export const PROJECT_DEFAULT_MAX_CONCURRENT = 1;

/**
 * How many autopilot runs may fail in a row before the project stops picking
 * work up.
 *
 * The number answers "how many failures is enough to be a pattern rather than
 * bad luck", and three is the smallest count that can tell the two apart. It
 * is not a setting: a user who wants a longer leash wants the runs to succeed,
 * and a knob here only delays the moment they look at why they do not.
 */
export const PROJECT_FAILURE_BREAKER_THRESHOLD = 3;

/** How long past a named reset the autopilot waits: a start a few seconds early is refused again. */
export const AUTOPILOT_LIMIT_RESET_GRACE_MS = 60_000;

/** How long the autopilot waits on a usage limit that named no reset. */
export const AUTOPILOT_LIMIT_FALLBACK_MS = 30 * 60_000;

/** A project's or a team's own say on lesson offers; null inherits. */
export const LESSON_OVERRIDES = ['on', 'off'] as const;
export type LessonOverride = (typeof LESSON_OVERRIDES)[number];
export const LessonOverrideSchema = z
  .enum(LESSON_OVERRIDES)
  .meta({ id: 'LessonOverride' });

/**
 * One project on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 *
 * The run-configuration half (`agentKind` / `model` / `effort` / `approval` /
 * `configDir`) is nullable throughout and carries the daemon's own vocabulary
 * rather than a second copy of it. Each null means "unset — fall back to
 * whatever the composer would have used", which is why none of them has a
 * default here: a project that has never been configured must not silently
 * pin an agent the user did not choose.
 */
export const ProjectWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  folder: z
    .string()
    .describe('The absolute project folder every task in it is worked in'),
  groupId: z
    .string()
    .nullable()
    .describe(
      "The chat-sidebar group this project's task runs file themselves into; null until one is bound",
    ),
  taskKey: z
    .string()
    .nullable()
    .describe(
      'The short prefix this board’s cards are numbered under — the GEN of GEN-12',
    ),
  description: z
    .string()
    .nullable()
    .describe('What the project is, in the user’s words; null when unset'),
  instructions: z
    .string()
    .nullable()
    .describe(
      'Standing instructions every run in this project receives, after the user’s custom instructions — the blocks’ texts joined in order; null when unset',
    ),
  instructionBlocks: z
    .array(ProjectInstructionBlockSchema)
    .describe('The instructions as the user wrote them, block by block'),
  instructionsRevision: z
    .number()
    .int()
    .describe(
      'Counts every change to the description or instructions; quote it back as expectedInstructionsRevision so a stale write is refused instead of overwriting a newer one',
    ),
  agentKind: AgentKindSchema.nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  contextWindow: z
    .string()
    .nullable()
    .describe(
      "Which of the model's context-window sizes a run here starts at, in the CLI's own vocabulary; null = the model's own default",
    ),
  modelParameters: z
    .record(z.string(), z.string())
    .describe(
      "Every other model setting a run here starts with, keyed by the CLI's own parameter id; {} when none are set",
    ),
  approval: ChatApprovalModeSchema.nullable(),
  configDir: z.string().nullable(),
  teamSlug: z
    .string()
    .nullable()
    .describe('A team to run a task through instead of a single agent'),
  autopilotEnabled: z.boolean(),
  autopilotIntakeStatus: TaskStatusSchema.describe(
    'The column the autopilot picks work up from',
  ),
  autopilotMaxConcurrent: z.number().int(),
  autopilotFailureStreak: z
    .number()
    .int()
    .describe(
      'Consecutive failed autopilot runs — the breaker reads it, and a success resets it to 0',
    ),
  autopilotLimitUntil: z.iso
    .datetime()
    .nullable()
    .describe(
      'When the autopilot goes on after a spent usage limit; null while it is not waiting on one',
    ),
  provider: TaskSourceSchema.describe(
    "Where this project's tasks come from — the value its tasks carry as their own source",
  ),
  lessons: LessonOverrideSchema.nullable().describe(
    "Whether this project's threads are offered lessons reflections; null inherits the app setting, and a team's own setting wins over it",
  ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProjectWire = z.infer<typeof ProjectWireSchema>;

/** The project a folder belongs to, by the rule a new run follows. */
export const ProjectForFolderSchema = z.object({
  project: ProjectWireSchema.nullable(),
});
export type ProjectForFolder = z.infer<typeof ProjectForFolderSchema>;

/**
 * Announced to every client when a project is created, changed or deleted.
 *
 * TWIN PARSER: read by the renderer's `parseProjectsChanged`
 * (`apps/ui/src/renderer/daemon-client.ts`). Change one and change the other.
 */
export interface ProjectsChangedEvent {
  projectId: string;
  /** True when the change touched only the project's description or instructions. */
  textsOnly?: boolean;
}

/** The two texts a project tells its runs, and whose changes are logged. */
export const PROJECT_INSTRUCTION_FIELDS = [
  'description',
  'instructions',
] as const;
export type ProjectInstructionField =
  (typeof PROJECT_INSTRUCTION_FIELDS)[number];

/** Who changed a project's texts: the user, an analysis applying `P-` items, or a chat the user asked. */
export type ProjectInstructionChangeSource = 'user' | 'analysis' | 'chat';

/** Consecutive user edits of one field this close together are logged as one change. */
export const PROJECT_CHANGE_COALESCE_MS = 10 * 60 * 1000;

/** What an analysis's or the project chat's write carries into the change log. */
export interface ProjectChangeOrigin {
  source: 'analysis' | 'chat';
  recommendationIds: readonly string[];
  chatRunId: string;
  cardSeq: number | null;
}

/** One logged change as the analysis reads it. */
export interface ProjectInstructionChangeRecord {
  id: string;
  projectId: string;
  changedAt: Date;
  field: ProjectInstructionField;
  source: ProjectInstructionChangeSource;
  previous: string | null;
  next: string | null;
  recommendationIds: string[];
  chatRunId: string | null;
  cardSeq: number | null;
}

/**
 * One card the autopilot may pick up, and only what starting it needs.
 *
 * Deliberately not the board's own `TaskWireSchema`: this is a work handout
 * rather than a listing, and the caller is a conductor that starts runs, not a
 * screen that draws cards. `status` rides along because the start route is a
 * compare-and-set — it is the `from` the conductor must send back.
 */
export const QueuedTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: TaskStatusSchema,
    position: z.number().int(),
    folder: z
      .string()
      .describe(
        "The folder to cut this card's worktree from — the card's own if it names one, else the project's. RESOLVED here rather than sent as two fields, because the conductor is a timer in another process and the inheritance rule belongs to whoever owns the two rows",
      ),
  })
  .meta({ id: 'QueuedTask' });
export type QueuedTask = z.infer<typeof QueuedTaskSchema>;

/**
 * A card sitting in the intake column that the autopilot cannot start, and why.
 *
 * It exists because the alternative is a silent loop. The conductor prepares a
 * worktree BEFORE it asks the daemon to start the run, so a card the start
 * route will refuse costs a `git worktree add` and a prune every tick, for as
 * long as the project stays armed — measured at one pair every 20 seconds,
 * indefinitely, with the only evidence a status code in the debug log. The
 * breaker cannot end it either: `autopilotFailureStreak` counts failed RUNS,
 * and a run that never started never failed.
 *
 * So the daemon answers the question it is already in a position to answer.
 * Keeping such a card out of `eligible` is what stops the churn; naming it here
 * is what lets the board say so, since the board already polls this route and
 * "1 waiting" is otherwise indistinguishable from "1 refused forever".
 */
export const BlockedTaskSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    reason: z
      .string()
      .describe('Why this card cannot start, in words a user can act on'),
    kind: z
      .enum(['run-target', 'missing-team', 'stopped', 'worktree', 'overlay'])
      .meta({ id: 'BlockedTaskKind' })
      .describe(
        "Where the answer lies: the run settings (run-target, missing-team), a Run press on the card itself (stopped, worktree), or the project's overrides on the team's page (overlay)",
      ),
    retryInMs: z
      .number()
      .int()
      .min(0)
      .nullable()
      .describe(
        'How long from this answer until the autopilot tries this card again by itself — relative, so a client on another clock times it right; null for a card it never retries',
      ),
  })
  .meta({ id: 'BlockedTask' });
export type BlockedTask = z.infer<typeof BlockedTaskSchema>;

/**
 * A card whose agent is working right now.
 *
 * The board draws a live card differently from a resting one — a spinner and
 * the glyph of whatever is working it — and neither fact is derivable on the
 * client. `Task.runId` survives the run it names (the settled report is read
 * through it), so a non-null id is not liveness; and the agent a run was
 * STARTED as is the run's own column, not the card's, since a card is free to
 * be re-pointed afterwards.
 *
 * Read off the same query that counts `running`, so a card cannot be in one
 * and absent from the other.
 */
export const ActiveTaskSchema = z
  .object({
    id: z.string().describe('The task'),
    runId: z.string().describe('The live run working it'),
    agentKind: AgentKindSchema.nullable().describe(
      'The CLI actually running it — null for a team run, whose agents are per member',
    ),
  })
  .meta({ id: 'ActiveTask' });
export type ActiveTask = z.infer<typeof ActiveTaskSchema>;

/**
 * What {@link ProjectQueueService.readRaw} answers: every count and row it can
 * compute over the `projects` and `tasks` tables alone, WITHOUT deciding which
 * waiting cards may actually start.
 *
 * The eligible/blocked split cannot live here: the TEAM arm of a card's
 * resolved run target names a slug, and whether that slug still exists is a
 * question only the team LIBRARY can answer — `ProjectsModule` has no way
 * to ask it without importing `TeamsModule`, which would recreate the very
 * cycle `ProjectsModule`'s own module doc warns against (`TasksModule`
 * already imports `ProjectsModule`, so the reverse import would need a
 * `forwardRef`). So this module answers only what it alone can compute, and
 * `TaskQueueService` (in the tasks module, which already imports both
 * `ProjectsModule` and `TeamsModule`) joins it against the library to
 * produce the real `eligible`/`blocked` split.
 *
 * Not a wire schema — nothing outside the daemon ever sees this shape, so it
 * is a plain interface rather than a zod object, on `RunTargetLevel`'s own
 * precedent.
 */
export interface ProjectQueueRaw {
  projectId: string;
  enabled: boolean;
  intakeStatus: TaskStatus;
  cap: number;
  running: number;
  waiting: number;
  breakerOpen: boolean;
  failureStreak: number;
  /** Set while the autopilot waits out a spent usage limit. */
  limitHoldUntil: Date | null;
  active: ActiveTask[];
  /** What a card inherits when it names no folder of its own. */
  folder: string;
  /**
   * The project's own run-configuration defaults — the fallback level
   * `resolveRunTarget` reads once a task's own fields have been checked. This
   * type is deliberately shaped to satisfy `RunTargetLevel` structurally
   * (same field names, no narrower types) so a caller can pass it straight
   * into `resolveRunTarget([task, raw], …)` with no re-mapping.
   */
  agentKind: AgentKind | null;
  model: string | null;
  effort: string | null;
  approval: ChatApprovalMode | null;
  configDir: string | null;
  teamSlug: string | null;
  /**
   * Every task sitting in the intake column, UNFILTERED — the rows a splitter
   * walks to decide `eligible` vs `blocked`. Full entities rather than a
   * projection: the split needs nearly every column (`agentKind` through
   * `teamSlug` for `resolveRunTarget`, `folder`/`position` for
   * `toQueued`), so a narrower shape would just restate the entity's own
   * fields under a new name.
   */
  waitingTasks: Task[];
  /**
   * The cards whose run the USER stopped — marked on the card by the cancel
   * settle (`Task.stoppedAt`) until a Run press starts it again, or read off a
   * run still standing `cancelled`. The splitter leaves these to the user
   * while armed: the settle returns a stopped card to the intake column, and
   * the autopilot would otherwise restart it at once — or, once the user had
   * carried the thread on, the moment that run settled.
   */
  stoppedTaskIds: string[];
  /**
   * Of those, the ones an INTERRUPTION stopped rather than the user, with its
   * cause (`Task.interruptedBy`) — the board says why such a card waits.
   */
  interruptedTasks: ReadonlyMap<string, InterruptCause>;
  /** How many of the project's autopilot slots are free right now. */
  freeSlots: number;
  /**
   * Whether the autopilot may hand out ANY work at all right now — armed, the
   * breaker shut, and at least one slot free. A splitter must ask this
   * BEFORE applying the cap: a blocked card must never occupy one of the
   * slots the handout is narrowed to, or one misconfigured card at the head
   * of a cap-1 column would starve every runnable card behind it.
   */
  handOutWork: boolean;
}

/**
 * What one project's autopilot may do right now.
 *
 * `eligible` is the answer to "what should I start", already narrowed to the
 * free slots and empty whenever nothing may start at all — autopilot off, the
 * breaker open, or every slot taken. The route refuses to hand out work past
 * the cap rather than reporting a queue and trusting the conductor to count,
 * because the daemon is the only place that can see every window's runs.
 *
 * `waiting` is the whole intake column, so a screen can say how much is queued
 * behind what may start — which makes `blocked` its necessary companion: a
 * card that will never start is counted in `waiting` too, and without the
 * second list the two are indistinguishable. No `.meta({ id })` on this ROOT —
 * it backs a response DTO; see `ProjectWireSchema` above.
 */
export const ProjectQueueSchema = z.object({
  projectId: z.string(),
  enabled: z.boolean().describe('Whether this project is armed'),
  intakeStatus: TaskStatusSchema.describe('The column work is picked up from'),
  cap: z.number().int().describe('How many tasks may run at once'),
  running: z
    .number()
    .int()
    .describe('How many of this project’s tasks hold a run that is still live'),
  waiting: z
    .number()
    .int()
    .describe('How many tasks sit in the intake column in total'),
  breakerOpen: z
    .boolean()
    .describe('True once consecutive failures reached the threshold'),
  failureStreak: z.number().int(),
  eligible: z
    .array(QueuedTaskSchema)
    .describe('The tasks that may be started now, oldest first'),
  blocked: z
    .array(BlockedTaskSchema)
    .describe(
      'Cards in the intake column that cannot start as they stand, with the reason — never handed out as eligible',
    ),
  active: z
    .array(ActiveTaskSchema)
    .describe(
      'The cards whose agent is working right now, in no particular order — `running` is this list’s length',
    ),
});
export type ProjectQueue = z.infer<typeof ProjectQueueSchema>;
