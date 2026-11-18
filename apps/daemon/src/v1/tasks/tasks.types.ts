import { z } from 'zod';

import {
  type ChatApprovalMode,
  ChatApprovalModeSchema,
  RunPullRequestSchema,
  TaskStageLineSchema,
} from '../agents/chat.types';
import type { AgentOptionsSnapshot } from '../agents/utils/agent-options';
import { type AgentKind, AgentKindSchema } from '../runs/runs.types';

/**
 * The board's columns, and the whole vocabulary a task's status may take.
 *
 * Fixed rather than per-project, deliberately: a provider adapter (Linear,
 * Jira) maps ONTO this set and never the reverse, so a column one user
 * invented on one board would be a mapping target that exists nowhere else.
 *
 * `failed` is a status of the TASK, not a reading of its last run. The
 * autopilot's breaker needs somewhere to park a task that keeps failing —
 * left in the intake column it would be picked up again on the next sweep,
 * and again after that.
 */
export const TASK_STATUSES = [
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'failed',
] as const;
export const TaskStatusSchema = z
  .enum(TASK_STATUSES)
  .meta({ id: 'TaskStatus' });
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Where a task came from.
 *
 * Only `geniro` today — one the user typed into this app. The field exists
 * before a second source does because it is what an adapter will stamp, and
 * adding it afterwards would mean deciding retroactively what every row
 * already on disk had been.
 */
export const TASK_SOURCES = ['geniro'] as const;
export const TaskSourceSchema = z.enum(TASK_SOURCES).meta({ id: 'TaskSource' });
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/**
 * One file bound to a card, as it is listed and as the agent is told about it.
 *
 * Every entry is a REFERENCE to a file already on this machine, never a copy,
 * and that is a deliberate answer rather than the easy one. Copying is what
 * `attachment` normally implies, and it is the wrong trade here: a user
 * attaches the archive or the spreadsheet they are working ON, so a copy goes
 * stale the moment they edit it and the agent then reads yesterday's version —
 * and a large one is real disk with nobody who owns collecting it. The cost of
 * a reference is that moving the file breaks the link, which is visible (the
 * row states the path) rather than silent.
 *
 * It follows that REMOVING an attachment removes the reference and never the
 * file: geniro did not put it there.
 *
 * The pictures pasted INTO a description are a different thing and are
 * deliberately not listed here — those arrive as bytes with no path at all,
 * are written by geniro, and are already visible where they belong, inline in
 * the prose.
 */
export const TaskFileSchema = z
  .object({
    id: z.string().describe('Stable within this card, so a row can be removed'),
    name: z.string().describe('The file’s own name, for the list'),
    path: z.string().describe('Where it is on this machine'),
    bytes: z
      .number()
      .int()
      .nullable()
      .describe('Its size when it was attached — null if it could not be read'),
  })
  .meta({ id: 'TaskFile' });
export type TaskFileWire = z.infer<typeof TaskFileSchema>;

/** How many files one card may carry, so a prompt cannot grow without bound. */
export const TASK_FILES_MAX = 20;

/**
 * The largest file a device with no path on this machine may UPLOAD onto a
 * card — a phone over the LAN gateway, whose files exist nowhere the agent
 * could open them. Decoded bytes; base64 on the wire keeps it well inside the
 * daemon's own request ceiling.
 */
export const TASK_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** A task's title — non-blank after trimming, sanely bounded. */
export const TASK_TITLE_MAX = 200;

/**
 * How long a task's free text may be.
 *
 * Bounded here rather than left to Fastify's `bodyLimit`, which is ~54MB and
 * would let one description become a 54MB TEXT column. `description` is
 * heading for an agent's brief, so it is the daemon's to bound independently
 * of whatever the client allows.
 */
export const TASK_DESCRIPTION_MAX = 20_000;

/**
 * The extra words a user may add to ONE press of Run.
 *
 * The description's own bound: it is the same kind of text — a brief for the
 * agent — written in the same box, and a press that could carry more than the
 * card itself would be the odd one out.
 */
export const TASK_RUN_PROMPT_MAX = TASK_DESCRIPTION_MAX;
export const TASK_SOURCE_REF_MAX = 200;

/** How many labels one task may carry, and how long each may be. */
export const TASK_LABELS_MAX = 20;
export const TASK_LABEL_MAX = 40;

/**
 * The run configuration a card inherits from its project when its own field is
 * empty (see `resolveRunTarget` for how the levels combine).
 */
export const TASK_RUN_CONFIG_FIELDS = [
  'folder',
  'agentKind',
  'model',
  'effort',
  'approval',
  'configDir',
  'teamSlug',
] as const;

/**
 * How long, at most, before an armed autopilot starts work on a card that
 * landed in its intake column — the Electron conductor's tick.
 *
 * TWIN: `TICK_INTERVAL_MS` in `apps/ui/src/main/autopilot-conductor.ts`, which
 * the daemon cannot import. Change one and change the other.
 */
export const AUTOPILOT_PICKUP_SECONDS = 20;

/** How many cards one `list_tasks` board-tool answer holds, by default and at most. */
export const BOARD_LIST_TASKS_DEFAULT_LIMIT = 50;
export const BOARD_LIST_TASKS_MAX_LIMIT = 200;

/** How long one agent report may be — the description's own ceiling. */
export const TASK_REPORT_MAX = TASK_DESCRIPTION_MAX;

/**
 * The columns an agent may put the card IT IS WORKING in.
 *
 * Not the whole vocabulary: `backlog` and `todo` are the INTAKE, and a card an
 * agent sent back there is one the autopilot hands straight out again — the
 * agent would be re-running itself. Any OTHER card may go to any column.
 */
export const TASK_AGENT_OWN_STATUSES = [
  'in_progress',
  'in_review',
  'done',
  'failed',
] as const satisfies readonly TaskStatus[];

/**
 * Instructions attached to one task LABEL, on the wire.
 *
 * No `.meta({ id })` on this ROOT, on `TaskWireSchema`'s own rule: it backs an
 * array response DTO (`GET /v1/label-instructions`), and an id here would
 * register the component under that name while the array response still
 * points at the DTO class — the dangling `$ref` `setupSwagger` fails the boot
 * on.
 */
export const LabelInstructionWireSchema = z.object({
  id: z.string(),
  projectId: z
    .string()
    .nullable()
    .describe(
      'The project this instruction is scoped to; null means every project',
    ),
  label: z.string(),
  instructions: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LabelInstructionWire = z.infer<typeof LabelInstructionWireSchema>;

/**
 * A task's priority.
 *
 * A NAMED value rather than a number, so a row reads for itself in the database
 * and a client cannot mistake the direction of the scale — the one thing an
 * integer priority reliably gets wrong is which end is urgent.
 *
 * `none` leads the list because it is the DEFAULT: an untriaged task has to be
 * distinguishable from one somebody deliberately marked low. The renderer owns
 * display order; this array is the vocabulary, not a ranking.
 */
export const TASK_PRIORITIES = [
  'none',
  'urgent',
  'high',
  'medium',
  'low',
] as const;
export const TaskPrioritySchema = z
  .enum(TASK_PRIORITIES)
  .meta({ id: 'TaskPriority' });
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/**
 * One task on the wire.
 *
 * No `.meta({ id })` on this ROOT: it backs an array response DTO, and an id
 * here would register the component under that name while the array response
 * still points at the DTO class — the dangling `$ref` `setupSwagger` fails the
 * boot on.
 */
export const TaskWireSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  number: z
    .number()
    .int()
    .nullable()
    .describe('This card’s number within its project — the 12 of GEN-12'),
  description: z.string().nullable(),
  attachments: z
    .array(TaskFileSchema)
    .describe('Files bound to this card, in the order they were attached'),
  status: TaskStatusSchema,
  labels: z.array(z.string()),
  source: TaskSourceSchema,
  sourceRef: z
    .string()
    .nullable()
    .describe(
      "The id this task carries in the system it came from — null for a task made here, since geniro's own id is the one above",
    ),
  folder: z
    .string()
    .nullable()
    .describe(
      "The folder this task's agent works in; null means take the project's, which is the default rather than the law",
    ),
  agentKind: AgentKindSchema.nullable().describe(
    "The agent this card runs on; null means take the project's",
  ),
  model: z.string().nullable(),
  effort: z.string().nullable(),
  modelParameters: z
    .record(z.string(), z.string())
    .describe(
      "Every other model setting this card runs with, keyed by the CLI's own parameter id; {} means take the project's",
    ),
  approval: ChatApprovalModeSchema.nullable(),
  configDir: z.string().nullable(),
  teamSlug: z
    .string()
    .nullable()
    .describe(
      "A team to run this card through instead of a single agent; null means take the project's",
    ),
  branch: z
    .string()
    .nullable()
    .describe('The branch an agent works this task on; null until one runs'),
  worktreePath: z
    .string()
    .nullable()
    .describe(
      'The worktree that branch is checked out in; null until one runs',
    ),
  runId: z
    .string()
    .nullable()
    .describe('The chat run currently serving this task, if any'),
  report: z
    .string()
    .nullable()
    .describe(
      "The agent's report on this card, as markdown — sent by the agent through the update_task board tool; null until it sends one",
    ),
  reportedAt: z.iso
    .datetime()
    .nullable()
    .describe('When the report was last written; null while there is none'),
  /**
   * The pull requests this card's RUN opened — the result of the work, drawn on
   * the card rather than left in the conversation that produced it.
   *
   * Read from the run on every projection instead of stored on the task, and
   * that is the whole design: `PullRequestCaptureService` already keeps this
   * for every run there is, out of the transcript's own `gh pr create` calls,
   * and a second copy on the card would be a stale answer beside a live one
   * the moment a follow-up turn opened another. So a card OWNS no pull request
   * — it owns the run, and the run owns these.
   *
   * Empty when the card has never been run, when its run opened none, and when
   * the run it named has since been deleted. None of the three is worth telling
   * apart here: each of them is a card with nothing to show.
   *
   * Oldest first, as the run stores them; the renderer reverses for display,
   * where the last thing a run did is what its reader is looking for.
   */
  pullRequests: z
    .array(RunPullRequestSchema)
    .describe(
      "Pull requests the task's run opened, oldest first, as captured from the agent output",
    ),
  stage: TaskStageLineSchema.nullable().describe(
    "Where the task's team run stands in its stage graph; null when it has no run or no stages",
  ),
  position: z
    .number()
    .int()
    .describe(
      'Order within the column, ascending and unique — gaps are expected, since a delete or a move leaves one and nothing renumbers',
    ),
  priority: TaskPrioritySchema.describe(
    "How urgent this task is; 'none' until someone triages it",
  ),
  dueDate: z.iso
    .date()
    .nullable()
    .describe(
      'The day this task is due, as a calendar date with no time or zone — a due date is a day in the reader\u0027s own life, and giving it an instant would move it across the date line for nobody\u0027s benefit',
    ),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type TaskWire = z.infer<typeof TaskWireSchema>;

/**
 * What a status move must send: the status the caller believes the task is
 * currently in, alongside the one it should move to.
 *
 * The `from` half is what makes the move CONDITIONAL. Two windows can hold the
 * same board, and a task is a thing an agent may already be running — so a
 * move computed against a stale card must lose rather than overwrite. See
 * `TasksService.moveStatus`.
 */
export interface TaskStatusMove {
  from: TaskStatus;
  to: TaskStatus;
}

/**
 * One card sitting in review with pull requests that could end it.
 *
 * The daemon's half of the merge watch, and the split is the same one
 * `RunPullRequestSchema` already states: this process knows WHICH pull requests
 * belong to a card (its run captured them out of the agent's own output) and
 * can never know what they currently ARE, because that is a live question for
 * GitHub. The Electron main process holds the `gh` login and asks it, then
 * reports a merge back — so neither side stores a state that goes stale.
 *
 * `pullRequests` is never empty: a card with nothing to watch is not awaiting a
 * merge, and listing it would cost the watcher a pass that can decide nothing.
 *
 * `lastDoneAt` is what lets the watcher leave a FINISHED round's merge alone.
 * A card re-opened after Done continues the same thread, whose captures only
 * grow, so the pull request that ended it once is merged still and is listed
 * again. Whether a merge can end the card is a question of when the merge
 * HAPPENED — after the card last reached Done, or not — and only GitHub knows
 * that, so the boundary travels to the process that can ask.
 *
 * TWIN PARSER: read by `readAwaitingMerge` in
 * `apps/ui/src/main/pull-request-merge-watcher.ts`. Electron main imports no
 * daemon source and not the generated client, so it reads this reply as
 * untrusted JSON. Change one and change the other.
 */
export const TaskAwaitingMergeSchema = z.object({
  taskId: z.string(),
  projectId: z.string(),
  title: z.string().describe('For the watcher’s own log lines'),
  pullRequests: z
    .array(RunPullRequestSchema)
    .describe('Every pull request this card’s run opened, oldest first'),
  lastDoneAt: z.iso
    .datetime()
    .nullable()
    .describe(
      'When this card last entered Done; null for a card that never has. Only a merge that happened after this can end the card',
    ),
});
export type TaskAwaitingMergeWire = z.infer<typeof TaskAwaitingMergeSchema>;

/**
 * How many cards one merge sweep may name.
 *
 * A bound rather than a tuning: every card handed out costs the watcher at
 * least a lookup against GitHub, so an unattended tick must not be able to
 * grow with a board somebody left in review for a year. It is applied AFTER
 * the cards with nothing to watch are dropped, and a capped sweep resumes
 * where the last one stopped (`TaskMergeService.resumeAfter`), so every card
 * is reached in turn — including behind a column of pull requests that stay
 * open, or were closed without merging, and so never leave it.
 */
export const TASKS_AWAITING_MERGE_MAX = 100;

/**
 * What starting a run for one task needs to know.
 *
 * `cwd` and `branch` are the caller's because the daemon runs no git: the
 * Electron main process makes the worktree and names the branch, and this
 * module records what it is told. `from` is the status the caller believed the
 * card was in, on {@link TaskStatusMove}'s own terms — starting a run moves
 * the card, so a start computed against a stale one must lose.
 *
 * The run-configuration half is entirely optional and falls back to the
 * project's standing answers, so a board that sends nothing still runs the
 * setup the user chose for that project.
 */
/**
 * Who pressed it.
 *
 * The autopilot's starts are bounded by the project's cap and stopped by its
 * breaker; a person's are not, and neither are the command center
 * manager's, which the user's Start (or a manager chat in `auto`) already
 * approved. The cap protects the machine from a TIMER that
 * would otherwise fan out as fast as the queue allows, and the breaker exists
 * to stop unattended work — a user pressing Run is attending, and refusing
 * them is how they would be prevented from checking whether the thing that
 * broke is fixed before re-arming.
 */
export const TaskRunStarterSchema = z.enum(['user', 'autopilot', 'manager']);
export type TaskRunStarter = z.infer<typeof TaskRunStarterSchema>;

export interface StartTaskRun {
  cwd: string;
  branch: string;
  from: TaskStatus;
  /**
   * What the user added to THIS press, on top of the card's own brief.
   *
   * Absent for a press that said nothing, and for every autopilot start —
   * nobody is there to type it.
   */
  prompt?: string;
  /** Defaults to `user`: only a caller that says otherwise is capped. */
  startedBy?: TaskRunStarter;
  startSha?: string;
  startDirty?: boolean;
  agentKind?: AgentKind;
  model?: string;
  effort?: string;
  approval?: ChatApprovalMode;
  configDir?: string;
  teamSlug?: string;
  customInstructions?: string;
  replyLanguage?: string;
  agentOptions?: AgentOptionsSnapshot;
}

/**
 * What a card will actually be run as, once the card's own choices and the
 * project's defaults have been read together.
 *
 * `teamSlug` non-null is the TEAM arm and `agentKind` non-null the
 * AGENT arm; exactly one is set, which is what makes this a resolved answer
 * rather than a merge of two rows. See `resolveRunTarget`.
 */
export type ResolvedRunTarget =
  | {
      kind: 'team';
      teamSlug: string;
    }
  | {
      kind: 'agent';
      agentKind: AgentKind;
      model: string | null;
      effort: string | null;
      contextWindow: string | null;
      modelParameters: Record<string, string>;
      approval: ChatApprovalMode | null;
      configDir: string | null;
    };

/** The AGENT arm of {@link ResolvedRunTarget}, which alone carries CLI fields. */
export type ResolvedAgentTarget = Extract<ResolvedRunTarget, { kind: 'agent' }>;

/** The TEAM arm of {@link ResolvedRunTarget}. */
export type ResolvedTeamTarget = Extract<ResolvedRunTarget, { kind: 'team' }>;

/**
 * Why a card cannot be started as it stands.
 *
 * `no-target` is the card that names neither an agent nor a team;
 * `team-unattended` is the card that names a team the AUTOPILOT may not
 * run, which is a different sentence to the user and a different fix.
 */
export type RunTargetProblemReason = 'no-target' | 'team-unattended';

/**
 * An OBJECT rather than the bare reason string, so the arm is discriminated the
 * same way {@link ResolvedRunTarget}'s two are.
 *
 * `isRunTargetProblem` used to ask `typeof resolution === 'string'`, which is a
 * fact about the JS type rather than about the domain: it was correct only
 * while every resolved arm happened to be an object, and a future arm that was
 * itself a string would have been silently read as a refusal with no compiler
 * error anywhere. `kind` makes the question the domain's own.
 */
export type RunTargetProblem = {
  kind: 'problem';
  reason: RunTargetProblemReason;
};

/**
 * What {@link resolveRunTarget} answers: the resolved target, or the problem
 * standing in its way.
 *
 * The refusal is a VALUE rather than a null because both callers have to say
 * WHICH problem the card has — a bare null can only ever be reported as the
 * commonest one, which is what would make a card naming a team read to its
 * user as a card naming nothing.
 */
export type RunTargetResolution = ResolvedRunTarget | RunTargetProblem;

/**
 * Where a picture pasted into a description was written, and what to call it.
 *
 * The PATH is the point: it goes into the markdown as `![name](path)`, which
 * both readers of a description can act on — the renderer resolves it through
 * the task image route, and the agent, whose brief this is, simply opens it. An
 * inline `data:` URL would be readable by neither.
 */
export const TaskAttachmentSchema = z
  .object({
    path: z.string().describe('The absolute path this file is referenced by'),
    name: z.string().describe('What to call it — the file’s own name'),
  })
  .meta({ id: 'TaskAttachment' });
export type TaskAttachmentWire = z.infer<typeof TaskAttachmentSchema>;

/**
 * A task write the board needs to hear about, over the WS `task_changed`
 * broadcast — see {@link TaskEventBus}.
 *
 * Deliberately thin: `status` (rather than the whole {@link TaskWire}) is what
 * a board draws a card by, and the renderer already holds the rest from its
 * own fetch — a wider payload would be a second, driftable copy of the row.
 *
 * TWIN PARSER: mirrored by the renderer's `parseTaskChanged`
 * (`apps/ui/src/renderer/daemon-client.ts`). Change one and change the other.
 */
export interface TaskChangedEvent {
  taskId: string;
  projectId: string;
  status: TaskStatus;
  /**
   * Present only when the DAEMON has decided this card's work is FINISHED —
   * the card is Done and no run is working in it (`isWorkFinished`).
   * `TasksService` sets it on a move to Done whose run has already stopped,
   * `TaskSettleService` when a run settles under a card already in Done, and
   * nothing else does.
   *
   * It exists because neither half can be read by a client on its own. The
   * COLUMN cannot say the agent has stopped: the board writes a status
   * optimistically the moment a card is dragged, so keying a destructive act
   * on it removes a live agent's checkout — which an earlier cut of the
   * worktree collection did. And the run SETTLING cannot say the work is over:
   * the run is a chat the user continues after review — the mistake of the
   * `run-settled` reason this replaced, which collected a conversation's cwd
   * the moment its first answer ended.
   */
  reason?: TaskChangeReason;
}

/**
 * What the `board_vocabulary` tool answers: every value a card field can take
 * that belongs to this machine rather than to the schema.
 */
export interface BoardVocabulary {
  labels: {
    label: string;
    /** Live cards carrying it. */
    cards: number;
    /** Keys (or names, for a keyless project) of the projects using it. */
    projects: string[];
    /** Where instructions attached to it apply: `every project`, or keys. */
    instructionsFor: string[];
  }[];
  teams: { slug: string; name: string; description: string | null }[];
  agents: {
    agentKind: AgentKind;
    name: string;
    /** The CLI's `--version`, or null when it did not answer (not installed). */
    version: string | null;
    approvalModes: ChatApprovalMode[];
  }[];
  configDirs: string[];
  /** Present only when `agentKind` was asked for. */
  models?: {
    agentKind: AgentKind;
    models: { id: string; label: string }[];
    efforts: { id: string; label: string }[];
    effortsFor: string | null;
    /** Why there are no efforts, when there are none. */
    effortsUnavailableReason: string | null;
  };
}

/** Why a card changed, where the reason is one a client has to act on. */
export type TaskChangeReason = 'work-finished';
