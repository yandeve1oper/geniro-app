import { z } from 'zod';

import { RunWireSchema } from '../agents/chat.types';
import { TaskStatusSchema } from '../tasks/tasks.types';
import { chatChipsSchema } from '../teams/teams.types';

const HOUR_MS = 60 * 60_000;

/** How far back a card's newest contact with the manager is looked for. */
export const CONTACT_LOOKBACK_MS = 24 * HOUR_MS;

/** How long a reply credit lasts after the manager's message. */
export const REPLY_CREDIT_MS = 2 * HOUR_MS;

/** How often roster removals may change the manager's brief with no addition beside them. */
export const ROSTER_REMOVAL_INTERVAL_MS = 6 * HOUR_MS;

/** The status table's caps: the lines a manager turn reads, and their width. */
export const STATUS_SUFFIX_MAX_LINES = 40;
export const STATUS_SUFFIX_LINE_MAX = 160;

/** The board's computed columns; never dragged. */
export const CommandCenterColumnSchema = z
  .enum(['working', 'waiting', 'idle', 'in_review', 'done'])
  .meta({ id: 'CommandCenterColumn' });
export type CommandCenterColumn = z.infer<typeof CommandCenterColumnSchema>;

export const CommandCenterTaskRefSchema = z
  .object({
    id: z.string(),
    identifier: z
      .string()
      .nullable()
      .describe("The card's identifier (GEN-12), or null when none is known"),
    title: z.string(),
    status: TaskStatusSchema,
  })
  .meta({ id: 'CommandCenterTaskRef' });
export type CommandCenterTaskRef = z.infer<typeof CommandCenterTaskRefSchema>;

export const CommandCenterCardSchema = z
  .object({
    run: RunWireSchema,
    task: CommandCenterTaskRefSchema.nullable().describe(
      'The board card this thread works, or null',
    ),
    handle: z
      .string()
      .nullable()
      .describe("The thread's roster handle (t3) on the manager, or null"),
    note: z.string().nullable().describe("The manager's own note on it"),
    column: CommandCenterColumnSchema,
    activity: z
      .string()
      .nullable()
      .describe('What the thread is doing now, one line'),
    contact: z.object({
      lastAt: z
        .string()
        .nullable()
        .describe('The newest message between it and the manager'),
      awaitingReply: z
        .boolean()
        .describe('The manager waits on its reply to a message'),
    }),
  })
  .meta({ id: 'CommandCenterCard' });
export type CommandCenterCard = z.infer<typeof CommandCenterCardSchema>;

// No `.meta({ id })` — a RESPONSE DTO ROOT.
export const CommandCenterBoardSchema = z.object({
  generatedAt: z.string(),
  manager: RunWireSchema.nullable().describe(
    "The manager's own chat, or null while there is none",
  ),
  pendingStarts: z
    .number()
    .int()
    .describe(
      "Threads the manager asked to start that wait on the user's Start",
    ),
  cards: z.array(CommandCenterCardSchema),
});
export type CommandCenterBoard = z.infer<typeof CommandCenterBoardSchema>;

/** The composer settings the manager's chat opens with. */
export const StartCommandCenterChatSchema = chatChipsSchema.meta({
  id: 'StartCommandCenterChat',
});
export type StartCommandCenterChatInput = z.infer<
  typeof StartCommandCenterChatSchema
>;

export const CommandCenterChatsDiscardedSchema = z.object({
  deleted: z.number().int(),
});

/** One approved start Electron main's drain starts. */
export const CommandCenterStartSchema = z
  .object({
    taskId: z.string(),
    projectId: z.string(),
    title: z.string(),
    status: TaskStatusSchema,
    folder: z
      .string()
      .describe(
        "The card's folder, else its project's — where the worktree is cut",
      ),
  })
  .meta({ id: 'CommandCenterStart' });
export type CommandCenterStart = z.infer<typeof CommandCenterStartSchema>;

// No `.meta({ id })` — a RESPONSE DTO ROOT.
export const CommandCenterStartsSchema = z.object({
  starts: z.array(CommandCenterStartSchema),
});

/** The longest failure reason a start drain reports. */
export const START_FAILURE_MAX_CHARS = 1000;

export const TIMELINE_TEXT_MAX_CHARS = 200;
export const TIMELINE_LIMIT_DEFAULT = 100;
export const TIMELINE_LIMIT_MAX = 200;

export const CommandCenterTimelineKindSchema = z
  .enum([
    'user_message',
    'manager_message',
    'thread_message',
    'thread_started',
    'start_requested',
    'pull_request',
    'question',
    'approval',
    'stage',
    'outcome',
    'failed',
  ])
  .meta({ id: 'CommandCenterTimelineKind' });
export type CommandCenterTimelineKind = z.infer<
  typeof CommandCenterTimelineKindSchema
>;

export const CommandCenterTimelineEventSchema = z
  .object({
    id: z.string().describe('`<kind>:<source row id>`, stable across pages'),
    at: z.string().describe('When it happened, ISO 8601'),
    kind: CommandCenterTimelineKindSchema,
    threadRunId: z
      .string()
      .nullable()
      .describe(
        "The thread it is about; null for the manager's own message and a start not yet made",
      ),
    threadTitle: z
      .string()
      .nullable()
      .describe("The thread's title, or null with no thread"),
    text: z.string().nullable().describe('One line, at most 200 characters'),
    detail: z
      .string()
      .nullable()
      .describe('A stage title, an outcome kind, a PR number or a start state'),
    awaitingReply: z
      .boolean()
      .describe('The manager waits on the thread to answer this message'),
  })
  .meta({ id: 'CommandCenterTimelineEvent' });
export type CommandCenterTimelineEvent = z.infer<
  typeof CommandCenterTimelineEventSchema
>;

// No `.meta({ id })` — a RESPONSE DTO ROOT.
export const CommandCenterTimelineSchema = z.object({
  events: z.array(CommandCenterTimelineEventSchema),
  nextBefore: z
    .string()
    .nullable()
    .describe('Pass as `before` for the next, older page; null on the last'),
});
export type CommandCenterTimeline = z.infer<typeof CommandCenterTimelineSchema>;

/** Why the roster holds a thread. */
export const RosterReasonSchema = z.enum(['auto', 'manager', 'user']);
export type RosterReason = z.infer<typeof RosterReasonSchema>;

/**
 * TWIN PARSER: `parseCommandCenterChanged` in
 * `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface CommandCenterChangedEvent {
  runIds: string[];
  reason: 'status' | 'items' | 'roster' | 'task';
}

/**
 * TWIN PARSER: `parseCommandCenterContact` in
 * `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface CommandCenterContactEvent {
  messageId: string;
  fromRunId: string;
  toRunId: string;
  at: string;
  awaitingReply: boolean;
}
