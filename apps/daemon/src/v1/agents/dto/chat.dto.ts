import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { AgentKindSchema } from '../../runs/runs.types';
import {
  ActionPressWireSchema,
  AgentOptionsSchema,
  AppProcessesWireSchema,
  AttachmentMediaTypeSchema,
  AutoCompactPercentSchema,
  CALL_MESSAGES_MAX,
  CallMessagesWireSchema,
  ChatApprovalModeSchema,
  ChatExportWireSchema,
  ChatHistoryWireSchema,
  ChatListScopeSchema,
  ChatMetricsWireSchema,
  ChatSearchResultSchema,
  ChatTimelineWireSchema,
  ChatTotalsResponseSchema,
  ChatUploadWireSchema,
  commitShaSchema,
  CustomInstructionsSchema,
  DeliveredWaitingMessageSchema,
  FollowUpBackgroundWorkSchema,
  hasControlCharacters,
  ItemWireSchema,
  LocalImageWireSchema,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_RUN_NOTES_LENGTH,
  RecommendationApplySchema,
  ReplyLanguageSchema,
  RunArtifactsWireSchema,
  RunGoalCloseSchema,
  RunGoalCreateSchema,
  RunGoalEditSchema,
  RunGoalsWireSchema,
  RunOutcomesWireSchema,
  RunProcessesWireSchema,
  RunSeenWireSchema,
  RunStateWireSchema,
  RunTeamNotesWireSchema,
  RunWaterfallWireSchema,
  RunWireSchema,
  ShellKillWireSchema,
  ShellOutputWireSchema,
  StopDetachedProcessesSchema,
  StoppedDetachedProcessesSchema,
  THREAD_OVERVIEW_PARTS,
  ThreadAnalysisWireSchema,
  ThreadOverviewWireSchema,
  WaitingMessageSchema,
} from '../chat.types';

/**
 * HTTP DTOs for the chat routes.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; outputs are declared with `@ZodResponse` on the controller, which
 * type-checks the handler's return value, serializes it through the schema, and
 * publishes the schema to the OpenAPI document the renderer's client is
 * generated from.
 *
 * A response DTO's ROOT schema must never carry a zod `.meta({ id })` — the
 * component takes the DTO class name instead, and an id there would leave array
 * responses pointing at a component that does not exist (guarded in
 * `setupSwagger`). Ids belong on the nested/shared schemas in `chat.types.ts`.
 */

export const createChatSchema = z.object({
  agentKind: AgentKindSchema,
  cwd: z.string().min(1),
  /**
   * The commit `cwd` has checked out right now, and whether it already carries
   * uncommitted changes — snapshotted onto the run so the diff view has a fixed
   * point to measure against ({@link Run.startSha}).
   *
   * Sent by the client for the reason `configDir` and `customInstructions` are:
   * the reading is the ELECTRON process's, which owns every git call this app
   * makes. Omitted is a real answer — a folder that is not a repository, or one
   * with no commits — and the row stays null rather than being guessed at.
   *
   * The sha's SHAPE is checked here because it later becomes argv to `git`: a
   * value that is not a commit id names nothing, and refusing it at the edge
   * keeps every reader downstream from having to wonder.
   */
  startSha: commitShaSchema.optional(),
  startDirty: z.boolean().optional(),
  model: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  /** Omitted = `CHAT_DEFAULT_APPROVAL` where the CLI honours it, else `auto`. */
  approval: ChatApprovalModeSchema.optional(),
  /**
   * Reasoning effort in the CLI's own vocabulary; omitted = its default. A
   * plain string here and checked by `EffortsService.accepts` in the service —
   * against the adapter's `listEfforts()` for a CLI whose list is complete, and
   * against the NAMED MODEL's own listing otherwise. An enum would pin one
   * CLI's levels into the shared schema.
   */
  effort: z.string().min(1).optional(),
  /**
   * Which of the model's context-window sizes to run at, in the CLI's own
   * vocabulary; omitted = the model's own default.
   *
   * A plain string, like `effort`, and for the identical reason — the sizes are
   * a per-MODEL vocabulary the adapter owns (`300k`, `1m`, `272k`), so an enum
   * would pin one CLI's words into the shared schema. Unlike effort it is NOT
   * checked up front: there is no CLI-wide superset to check against (a size
   * means nothing apart from its model), and the turn's own driver reports on
   * the transcript when a value does not apply — which is per turn, against
   * the live agent, rather than against a constant that goes stale.
   */
  contextWindow: z.string().min(1).optional(),
  /** Auto-compact threshold as a percentage of the window; omitted = never. */
  autoCompactPercent: AutoCompactPercentSchema.optional(),
  /**
   * Every OTHER model setting this chat's turns ask for, keyed by the CLI's
   * own parameter id (`{optimize_for: 'intelligence'}`).
   *
   * Plain strings on both sides, and checked NOWHERE up front, for the reason
   * the window above is not — only more so: geniro holds no vocabulary for
   * these at all (see `AgentModelParameter`), so there is nothing here that
   * could be checked against. The model is asked what it accepts
   * (`modelParameters` of `GET /v1/agents/vocabulary`) and the live agent refuses a value it
   * does not, on the turn, with a sentence.
   *
   * Bounded because the values ride a config option on every turn for the life
   * of the chat — the caps live with the column's own reader
   * (`utils/model-parameters.ts`), which is also what sanitizes this map.
   */
  modelParameters: z.record(z.string(), z.string()).optional(),
  /**
   * The agent config directory this chat's turns run under — the folder
   * holding that CLI's credentials, settings and plugins, so one chat can run
   * on a different ACCOUNT (a different subscription) than the next. Omitted =
   * the CLI's own default profile.
   *
   * Only a shape check here: whether the path EXISTS (and its canonical form),
   * and whether this CLI has such a mechanism at all, are the service's job —
   * `resolveValidConfigDir` and the adapter's own
   * `AdapterConfig.configDir.unavailableReason`.
   */
  configDir: z.string().min(1).optional(),
  /**
   * The user's global custom instructions, snapshotted onto this run at
   * creation — free prose the composer reads out of the app's own settings,
   * not something typed per chat.
   *
   * Sent by the client rather than read daemon-side because settings live in
   * the ELECTRON process (`settings.json`), which the daemon does not open;
   * the same route `configDir` already travels. Bounded here INDEPENDENTLY of
   * the renderer's own bound: this is a separate process validating untrusted
   * input, and the value ends up in a child's argv, so the daemon may not rely
   * on a client having checked it. The ceiling is far under the OS argv limit
   * and far over any plausible prose.
   */
  customInstructions: CustomInstructionsSchema.optional(),
  /**
   * The language the user wants replies in, snapshotted onto this run at
   * creation ({@link Run.replyLanguage}); sent for `customInstructions`' reason.
   */
  replyLanguage: ReplyLanguageSchema.optional(),
  /** The user's per-CLI switches, snapshotted onto the run ({@link Run.agentOptions}). */
  agentOptions: AgentOptionsSchema.optional(),
  /**
   * A conversation this CLI already holds (`GET /v1/agents/sessions`), taken
   * over by the new thread instead of a fresh session being started.
   *
   * Opaque here: only the adapter that listed it may interpret it, so the
   * schema checks nothing but that a value was sent. What it MEANS for `cwd`
   * is worth stating — the folder must be the session's own, which the picker
   * takes from the listing rather than from the composer, since resuming a
   * conversation about one project inside another is how a resumed thread
   * starts reasoning about the wrong tree.
   */
  resumeSessionId: z.string().min(1).optional(),
  /**
   * The project this chat is started under by choice (a run configuration's
   * or the composer's): an id binds it, null means none even inside a
   * project's folder, omitted leaves it to the folder. An unknown id is passed
   * over as omitted.
   */
  projectId: z.string().min(1).nullable().optional(),
});
export class CreateChatDto extends createZodDto(createChatSchema) {}

/**
 * `POST /v1/chats/:runId/analyses` — start a chat that analyses `:runId`.
 *
 * The agent setup mirrors {@link createChatSchema}'s fields of the same name.
 * `cwd` is only sent when the source's own folder is gone (the route answers
 * `ANALYSIS_FOLDER_GONE` until one is); otherwise the analysis runs where the
 * source ran, so its repo recommendations land in that working tree.
 * `approval` omitted is `ANALYSIS_DEFAULT_APPROVAL` (`auto`), not the chat's.
 */
export const analyzeThreadSchema = z.object({
  agentKind: AgentKindSchema,
  approval: ChatApprovalModeSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  contextWindow: z.string().min(1).optional(),
  autoCompactPercent: AutoCompactPercentSchema.optional(),
  modelParameters: z.record(z.string(), z.string()).optional(),
  configDir: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  focus: z
    .string()
    .max(4000)
    .refine(
      (value) => !hasControlCharacters(value),
      'must not contain control characters',
    )
    .optional()
    .describe("The user's focus or extra instructions for this analysis"),
  customInstructions: CustomInstructionsSchema.optional(),
  replyLanguage: ReplyLanguageSchema.optional(),
  agentOptions: AgentOptionsSchema.optional(),
});
export class AnalyzeThreadDto extends createZodDto(analyzeThreadSchema) {}

/** At most this many of a team's newest runs are read by one analysis. */
export const MAX_ANALYSED_TEAM_RUNS = 30;

/** `POST /v1/teams/:slug/analyses` — "Analyze & improve" on a team. */
export const analyzeTeamSchema = analyzeThreadSchema.extend({
  runs: z
    .number()
    .int()
    .min(1)
    .max(MAX_ANALYSED_TEAM_RUNS)
    .describe("How many of the team's newest runs to read"),
});
export class AnalyzeTeamDto extends createZodDto(analyzeTeamSchema) {}

/** `POST /v1/chats/:runId/recommendations/apply` — the card's Apply. */
export const applyRecommendationsSchema = z.object({
  cardSeq: z.number().int().min(0),
  ids: RecommendationApplySchema.shape.ids,
  note: z.string().max(2000).optional(),
  clientMessageId: z
    .string()
    .min(1)
    .max(128)
    .describe('ID generated once per press and reused for retries'),
});
export class ApplyRecommendationsDto extends createZodDto(
  applyRecommendationsSchema,
) {}

/** `POST /v1/chats/:runId/actions/:seq/press` — one press of an agent's button. */
export const pressActionSchema = z.object({
  clientMessageId: z
    .string()
    .min(1)
    .max(128)
    .describe(
      'ID generated once per press and reused when the press is retried after RUN_BUSY',
    ),
});
export class PressActionDto extends createZodDto(pressActionSchema) {}

/** What a press or a dismissal wrote. */
export class ActionPressDto extends createZodDto(ActionPressWireSchema) {}

export const updateChatSettingsSchema = z
  .object({
    approval: ChatApprovalModeSchema.optional(),
    /**
     * Explicit null clears the run back to the CLI's own default — the one
     * thing an omitted key (= leave unchanged) cannot say.
     */
    model: z.string().min(1).nullable().optional(),
    /** Same null-vs-omitted contract as `model` above. */
    effort: z.string().min(1).nullable().optional(),
    /** Same again — and cleared to null whenever the MODEL changes, since a
     * window size belongs to the model that offered it. */
    contextWindow: z.string().min(1).nullable().optional(),
    /**
     * Same null-vs-omitted contract, and NOT cleared by a model change: a
     * percentage of the window means the same thing on every model.
     */
    autoCompactPercent: AutoCompactPercentSchema.nullable().optional(),
    /**
     * Same again, and cleared by a model change for a sharper version of the
     * same reason: `optimize_for` exists on ONE model of thirty-four, so
     * carrying a pick across a switch sends an option the new model has never
     * heard of. An explicit `{}` clears them; null does the same.
     */
    modelParameters: z.record(z.string(), z.string()).nullable().optional(),
    /**
     * Which ACCOUNT this thread's next turns run as — the agent config
     * directory, or an explicit null for the CLI's own default profile.
     *
     * This route used to refuse the field on the reading that a config
     * directory is part of a run's IDENTITY, like its folder. That was true of
     * everything except what the user actually wanted from it: REPORTED as "I
     * wanna have ability to dynamically change config directory for current
     * claude threads to have an ability continue thread with other account".
     * A folder decides what the conversation is ABOUT; a profile decides who is
     * paying for it and what tools they have, and neither is a fact about the
     * words already said.
     *
     * The switch does more than write a column — the conversation is carried
     * into the new profile and the run's live process is retired — so unlike
     * `model` and `effort` this one is REFUSED while a turn is running. See
     * `ChatService.updateSettings`.
     */
    configDir: z.string().min(1).nullable().optional(),
  })
  .refine(
    (dto) =>
      dto.approval !== undefined ||
      dto.model !== undefined ||
      dto.effort !== undefined ||
      dto.contextWindow !== undefined ||
      dto.autoCompactPercent !== undefined ||
      dto.modelParameters !== undefined ||
      dto.configDir !== undefined,
    'a settings patch must change the approval mode, the model, the effort, the context window, the auto-compact threshold, a model parameter or the config directory',
  );
export class UpdateChatSettingsDto extends createZodDto(
  updateChatSettingsSchema,
) {}

/** Pasted images riding one message — shared by the chat and team routes. */
export const messageImagesSchema = z
  .array(
    z.object({
      mediaType: AttachmentMediaTypeSchema,
      data: z.string().min(1).describe('base64-encoded image bytes'),
    }),
  )
  .max(MAX_ATTACHMENTS_PER_MESSAGE);

export const sendMessageSchema = z
  .object({
    // Not `.min(1)`: an image alone is a complete message ("what's wrong with
    // this?" is carried by the screenshot). The refine below keeps the empty
    // message — no text AND no images — refused.
    text: z.string(),
    images: messageImagesSchema.optional(),
    clientMessageId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe('ID generated once per send and reused for retries'),
    backgroundWork: FollowUpBackgroundWorkSchema.optional().describe(
      'What a press does about background sub-agents the message would cancel: ask refuses with FOLLOW_UP_CANCELS_SUBAGENTS, cancel sends anyway. Absent, the message is refused RUN_BUSY and stays queued',
    ),
    waitForAnswer: z
      .boolean()
      .optional()
      .describe(
        'Sent by the queue, not by a press: refused RUN_AWAITS_ANSWER while a card waits for the user, whom a new turn would cut off from it',
      ),
  })
  .refine(
    (dto) => dto.text.trim().length > 0 || (dto.images?.length ?? 0) > 0,
    'a message needs text or at least one image',
  );
export class SendMessageDto extends createZodDto(sendMessageSchema) {}

export const renameRunSchema = z.object({
  /** New sidebar label for the run — non-blank, sanely bounded. */
  title: z.string().trim().min(1).max(200),
});
export class RenameRunDto extends createZodDto(renameRunSchema) {}

export const setRunNotesSchema = z.object({
  /**
   * The thread's notes, whole — blank clears them. Bounded because the field
   * rides every chat-list response and every `runs_changed` broadcast.
   */
  notes: z.string().max(MAX_RUN_NOTES_LENGTH),
});
export class SetRunNotesDto extends createZodDto(setRunNotesSchema) {}

export const historyQuerySchema = z
  .object({
    /** Replay cursor — return only items with seq greater than this. */
    afterSeq: z.coerce.number().int().optional(),
    /**
     * At most this many items, taken from the END of the conversation — the
     * newest ones. Absent means the whole transcript, which is what the reconnect
     * replay wants and what every caller did before paging existed.
     *
     * Bounded here rather than trusted: this is the one query whose cost scales
     * with a number the client picks, and a thread of 7,814 items is 18.9MB.
     *
     * TWIN: `ANCHOR_ASK_MAX_ROWS` in
     * apps/ui/src/renderer/chats/use-live-anchor-asks.ts — a live anchor ask
     * spanning more than this is refused, silently, so lower both together.
     */
    limit: z.coerce.number().int().min(1).max(5000).optional(),
    /**
     * Page BACKWARDS: only items before this seq. Paired with `limit` to walk a
     * long conversation towards its start, one window at a time.
     */
    beforeSeq: z.coerce.number().int().optional(),
    /**
     * Which END of the range `limit` keeps: the `newest` items (the default —
     * a chat opens on its tail) or the `oldest`, which is how a client reading
     * FORWARD from somewhere in the middle asks for the next page after
     * `afterSeq`. Without it the only forward read was "the newest `limit` after
     * this seq", which skips everything in between — so a transcript opened at
     * its first message could never be read on past a few dozen rows.
     *
     * An enum rather than a boolean for the reason `listChatsQuerySchema.scope`
     * is one: `z.coerce.boolean()` reads the string `'false'` as true.
     */
    take: z.enum(['newest', 'oldest']).optional(),
    /**
     * `true` when the client asked for one row MORE than it will keep — only to
     * learn whether anything lies past the page. A full page then anchors every
     * row but that far-end probe, whose structure the client never draws.
     */
    probe: z.enum(['true', 'false']).optional(),
    /**
     * Only the run's OWN flow — its agents' turns, every call's start and the
     * cards a person answers, never a callee's rows. Absent reads the whole run,
     * which is what the reconnect replay wants; a chat, whose agent calls no one,
     * is answered with the whole run either way.
     */
    conversation: z.enum(['root']).optional(),
    /**
     * Only the conversation this call belongs to, its continuations included —
     * what an opened call card reads. Never together with `conversation`.
     */
    call: z.string().min(1).max(200).optional(),
    /**
     * Only one delegate's own rows — those carrying this launching tool call
     * id as `parentToolUseId` — what an opened sub-agent card reads when its
     * steps fall outside the loaded window. Never with `conversation` or
     * `call`.
     */
    delegate: z.string().min(1).max(200).optional(),
  })
  .refine(
    (query) =>
      [query.conversation, query.call, query.delegate].filter(
        (filter) => filter !== undefined,
      ).length <= 1,
    {
      message:
        'conversation, call and delegate each name a different conversation',
    },
  );
export class HistoryQueryDto extends createZodDto(historyQuerySchema) {}

export const callMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(CALL_MESSAGES_MAX),
});
export class CallMessagesQueryDto extends createZodDto(
  callMessagesQuerySchema,
) {}

export const listChatsQuerySchema = z
  .object({
    /**
     * How much of the archive to list. Absent means `active` — the desk, with
     * everything shelved held back, which is the only reading under which
     * archiving a thread does anything to the list it was filed out of.
     *
     * An ENUM rather than the boolean this started as: a boolean can only ever
     * name two of the three answers, and the one it cannot name (`all`) is the
     * one a user reaches for to find a shelved thread among the live ones. It is
     * also what stops a query string from deciding by truthiness — `?archived=false`
     * under `z.coerce.boolean()` reads as TRUE and hands back the shelf.
     */
    scope: ChatListScopeSchema.optional(),
    /**
     * At most this many runs, newest first. Absent lists the whole scope — the
     * desk, which every client needs whole. The archive grows without bound and
     * is the one listing a client should page.
     *
     * TWIN: `RUN_LIST_MAX` in apps/ui/src/renderer/chats/run-list-pages.ts —
     * the renderer's deepest re-list asks for exactly this many.
     */
    limit: z.coerce.number().int().min(1).max(1000).optional(),
    /**
     * Page BACKWARDS from the last row of the previous page: only runs older
     * than it in `(createdAt, id)` order. Both halves or neither — a time
     * alone would skip or repeat a run created in the same millisecond.
     */
    beforeCreatedAt: z.iso.datetime().optional(),
    beforeId: z.string().min(1).max(200).optional(),
    /**
     * Only this run, projected exactly as the listing projects it — how a
     * client takes in a row it was never handed.
     */
    runId: z.string().min(1).max(200).optional(),
  })
  .refine(
    (query) =>
      (query.beforeCreatedAt === undefined) === (query.beforeId === undefined),
    { message: 'beforeCreatedAt and beforeId name one cursor together' },
  );
export class ListChatsQueryDto extends createZodDto(listChatsQuerySchema) {}

export const searchChatQuerySchema = z.object({
  /**
   * What to look for. Split into terms by `searchTerms`, ALL of which a row
   * must answer for.
   *
   * Bounded at the same 200 characters `listAgentSessionsQuerySchema.query`
   * uses, and for its reason: generous enough for a real pasted phrase, while
   * the term cap downstream bounds what splitting one can produce.
   */
  query: z.string().trim().min(1).max(200),
  /**
   * At most this many hits, newest first.
   *
   * Bounded here rather than trusted, on `historyQuerySchema.limit`'s rule —
   * this is a scan over one conversation's rows, and the answer's size is a
   * number the client picks. A hit list nobody scrolls past the first screen of
   * needs far less headroom than a transcript replay, hence the much lower
   * ceiling.
   */
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export class SearchChatQueryDto extends createZodDto(searchChatQuerySchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** A run — a single-agent chat or a team execution. */
export class RunDto extends createZodDto(RunWireSchema) {}

/** A thread's analysis, or null when it has none — see `ThreadAnalysisWireSchema`. */
export class ThreadAnalysisDto extends createZodDto(ThreadAnalysisWireSchema) {}

/**
 * Which of a thread's opening reads to answer, comma-separated
 * (`state,totals,timeline`). One string rather than a repeated key so a single
 * part and several arrive in the same shape. An unknown name or an empty list
 * is refused rather than ignored.
 */
export const threadOverviewQuerySchema = z.object({
  parts: z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(THREAD_OVERVIEW_PARTS)).min(1)),
});
export class ThreadOverviewQueryDto extends createZodDto(
  threadOverviewQuerySchema,
) {}

/** Several of a thread's opening reads at once — see `ThreadOverviewWireSchema`. */
export class ThreadOverviewDto extends createZodDto(ThreadOverviewWireSchema) {}

/** A run's unread moments once a device has opened it. */
export class RunSeenDto extends createZodDto(RunSeenWireSchema) {}

/** One persisted transcript item. */
export class ItemDto extends createZodDto(ItemWireSchema) {}

/** One page of a transcript and the rows outside it the page refers to. */
export class ChatHistoryDto extends createZodDto(ChatHistoryWireSchema) {}

/** A call conversation's newest words. */
export class CallMessagesDto extends createZodDto(CallMessagesWireSchema) {}

/** What a run holds as a whole, for the readouts the transcript window must not decide. */
export class RunStateDto extends createZodDto(RunStateWireSchema) {}

/** The hits a transcript search found, with why the list may be incomplete. */
export class ChatSearchResultDto extends createZodDto(ChatSearchResultSchema) {}

/** One whole conversation as a file — settings, transcript, members, spend. */
export class ChatExportDto extends createZodDto(ChatExportWireSchema) {}

/**
 * One attachment's bytes, base64 in JSON rather than a binary body: the daemon
 * gates every route on the bearer token, and an `<img src>` cannot carry an
 * Authorization header — so the renderer fetches through its generated client
 * and builds a data URL. The root schema carries no `.meta({ id })` (see above).
 */
export class AttachmentDataDto extends createZodDto(
  z.object({
    id: z.string(),
    mediaType: AttachmentMediaTypeSchema,
    data: z.string().describe('base64-encoded image bytes'),
  }),
) {}

/**
 * One file a phone attaches through the composer's paperclip — its own name and
 * its bytes, base64 in JSON like every other body here.
 */
export class UploadChatFileDto extends createZodDto(
  z.object({
    name: z
      .string()
      .min(1)
      .max(200)
      .describe(
        'The file’s own name, which is what the agent sees in the path',
      ),
    data: z.string().min(1).describe('The file’s bytes, base64-encoded'),
  }),
) {}

/** Where an uploaded file was stored. */
export class ChatUploadDto extends createZodDto(ChatUploadWireSchema) {}

/** Which file on disk a markdown image reference names. */
export class LocalImageQueryDto extends createZodDto(
  z.object({
    path: z
      .string()
      .describe(
        'the image reference as the agent wrote it; a relative one is resolved against the run cwd',
      ),
  }),
) {}

/**
 * One agent-referenced local image's bytes — same base64-in-JSON shape as
 * {@link AttachmentDataDto}, and for the same two reasons: every route is
 * bearer-gated and an `<img src>` cannot carry the header, so the renderer
 * fetches through its generated client and builds a data URL. It echoes the
 * PATH rather than an id because that is the only handle the caller has — the
 * daemon minted nothing here.
 */
export class LocalImageDto extends createZodDto(LocalImageWireSchema) {}

/** Which command's terminal to open — the tool call that started it. */
export class ShellOutputQueryDto extends createZodDto(
  z.object({
    callId: z
      .string()
      .describe(
        'the id of the tool call that started the command, as the CLI spelled it',
      ),
  }),
) {}

/**
 * Which agent of the run a context readout is about. Absent means the chat's
 * own agent; a team run names the NODE, since each holds a window of its
 * own — or one agent-to-agent CALL, whose callee holds a window per
 * conversation beside its member's own.
 */
export class ChatMetricsQueryDto extends createZodDto(
  z.object({
    memberId: z
      .string()
      .min(1)
      .optional()
      .describe("a team member's id; absent reads a chat's own agent"),
    callId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "an agent-to-agent call's id; reads the callee's conversation that call belongs to",
      ),
    refresh: z
      .stringbool()
      .optional()
      .describe(
        'true asks the live agent again even when a stored reading would be served — the readout’s own refresh',
      ),
  }),
) {}

/**
 * One shell command's output — the tail of the file a DETACHED command is still
 * writing, or the reply a foreground one already returned.
 *
 * One route for both, because the panel's rows do not distinguish them: a user
 * clicking a running command wants what it has printed, and which of the two
 * mechanisms holds that text is the daemon's problem, not theirs.
 */
export class ShellOutputDto extends createZodDto(ShellOutputWireSchema) {}

/** Which command to stop — the same handle its terminal is opened by. */
export class ShellKillQueryDto extends createZodDto(
  z.object({
    callId: z
      .string()
      .describe(
        'the id of the tool call that started the command, as the CLI spelled it',
      ),
  }),
) {}

/** What became of a kill — see `ShellKillWireSchema`. */
export class ShellKillDto extends createZodDto(ShellKillWireSchema) {}

/**
 * Acknowledgement of a cancel request. Shared with the team routes — the
 * cancel surface is identical for chat and team runs.
 */
export class CancelledDto extends createZodDto(
  z.object({
    cancelled: z
      .boolean()
      .describe('True when a live turn was signalled to stop'),
  }),
) {}

/**
 * Acknowledgement that a failed turn's conversation was reopened.
 *
 * A bare ack rather than the run or the row it wrote: what the caller does next
 * is watch the transcript, which the reopened turn is already streaming into,
 * and a second copy of that state here is one more thing to keep in step.
 */
export class RetriedDto extends createZodDto(
  z.object({
    retried: z
      .boolean()
      .describe('True when the conversation was reopened without re-prompting'),
  }),
) {}

/**
 * How many runs had their snapshotted custom instructions forgotten.
 *
 * A COUNT rather than a bare ack because the action is silent otherwise: the
 * user is told what their press actually reached, which is also the only way
 * "nothing to forget" is distinguishable from "it did not work".
 */
export class ForgottenInstructionsDto extends createZodDto(
  z.object({
    cleared: z
      .number()
      .int()
      .describe('Runs whose snapshotted custom instructions were cleared'),
  }),
) {}

/**
 * How long a chat may sit in the archive before the sweep destroys it.
 *
 * The POLICY is the user's and lives in `settings.json`, which this process
 * never opens — so the window rides the request, exactly as `customInstructions`
 * and `agentOptions` ride chat create. Absence is not expressible here on
 * purpose: "never" is the client not calling the route at all, so a malformed
 * or empty body can never be read as a licence to delete everything.
 *
 * Bounded at BOTH ends, and both bounds are about the same irreversible act. A
 * floor of one day, because below that the window stops describing an archive
 * and starts describing the moment of archiving — and a zero would sweep a
 * thread the user shelved seconds ago, which is indistinguishable from the
 * archive button destroying it. A ceiling of ten years, because a window nobody
 * will live to see reached is a switch that reads as ON and does nothing.
 */
export const sweepArchivedSchema = z.object({
  olderThanDays: z
    .number()
    .int()
    .min(1)
    .max(3650)
    .describe('Delete chats archived at least this many days ago'),
});
export class SweepArchivedDto extends createZodDto(sweepArchivedSchema) {}

/**
 * How many archived chats the sweep destroyed.
 *
 * A COUNT for {@link ForgottenInstructionsDto}'s reason and one of its own: the
 * sweep steps over a run it cannot tear down, so this is what was ACTUALLY
 * destroyed rather than what was eligible, and a caller comparing the two can
 * tell a partial sweep from a complete one.
 */
export class SweptArchivedDto extends createZodDto(
  z.object({
    deleted: z
      .number()
      .int()
      .describe('Archived chats permanently deleted by this sweep'),
  }),
) {}

/**
 * Acknowledgement of a delete. Mirrors the team route's own
 * `TeamDeletedDto` rather than sharing it: they belong to different
 * modules' contracts, and the generated client names one class per tag.
 *
 * Prefixed because the OpenAPI component namespace is GLOBAL — two classes both
 * called `DeletedDto` land on one component name with two different bodies,
 * which @nestjs/swagger reports as a duplicate DTO today and will throw on in
 * its next major.
 */
export class ChatDeletedDto extends createZodDto(
  z.object({
    deleted: z
      .boolean()
      .describe('True when the chat and everything it owned were removed'),
  }),
) {}

/**
 * What one chat's window holds and what the thread has cost.
 *
 * The schema itself lives in `chat.types.ts` beside the type it derives, like
 * every other wire shape in this module. Re-stating it here is what the
 * metrics types used to do — a hand-written `ChatMetricsWire` interface on one
 * side and an independent schema on the other — and a field added to only one
 * of them type-checks, serializes away, and never reaches this client: the
 * compile-time half constrains the handler's return to the schema's INPUT
 * type, and excess-property checks do not apply to a value that is not an
 * object literal.
 */
export class ChatMetricsDto extends createZodDto(ChatMetricsWireSchema) {}

/** The thread's spend alone — see `ChatTotalsResponseSchema` for why wrapped. */
export class ChatTotalsDto extends createZodDto(ChatTotalsResponseSchema) {}

/** The conversation as a rail of user messages — see `ChatTimelineWireSchema`. */
export class ChatTimelineDto extends createZodDto(ChatTimelineWireSchema) {}

/** The pages this run published — see `RunArtifactsWireSchema`. */
export class RunArtifactsDto extends createZodDto(RunArtifactsWireSchema) {}

/** Every team note of one run — see `RunTeamNotesWireSchema`. */
export class RunTeamNotesDto extends createZodDto(RunTeamNotesWireSchema) {}

/** Every recorded pull request outcome of one run — see `RunOutcomesWireSchema`. */
export class RunOutcomesDto extends createZodDto(RunOutcomesWireSchema) {}

/** One run as money, order and timing — see `RunWaterfallWireSchema`. */
export class RunWaterfallDto extends createZodDto(RunWaterfallWireSchema) {}

/** What a run has running right now — see `RunProcessesWireSchema`. */
export class RunProcessesDto extends createZodDto(RunProcessesWireSchema) {}

export class StopDetachedProcessesDto extends createZodDto(
  StopDetachedProcessesSchema,
) {}
export class StoppedDetachedProcessesDto extends createZodDto(
  StoppedDetachedProcessesSchema,
) {}

/** What the whole app is running, by thread — see `AppProcessesWireSchema`. */
export class AppProcessesDto extends createZodDto(AppProcessesWireSchema) {}

/**
 * How many folders one named-paths ask may carry. TWIN: the renderer's
 * `CANDIDATES_PER_ASK` (`chats/use-run-work-folders.ts`) batches by it; the
 * generated client does not carry the bound.
 */
export const MAX_NAMED_PATHS_PER_ASK = 64;

/**
 * Folders the client wants checked against this run's own tool calls — the
 * repository's other working trees, as git names them.
 */
export const namedPathsSchema = z.object({
  paths: z
    .array(
      z
        .string()
        .min(2)
        .max(4096)
        .startsWith('/')
        .describe('An absolute folder path'),
    )
    .max(MAX_NAMED_PATHS_PER_ASK)
    .describe('Candidate folders, absolute'),
});
export class NamedPathsDto extends createZodDto(namedPathsSchema) {}

/** The subset of the asked-for paths this run's tool calls name. */
export class NamedPathsResultDto extends createZodDto(
  z.object({
    named: z
      .array(z.string())
      .describe('The asked-for paths a tool call of this run names'),
  }),
) {}

export class RunGoalsDto extends createZodDto(RunGoalsWireSchema) {}
export class WaitingMessageDto extends createZodDto(WaitingMessageSchema) {}
export class DeliveredWaitingMessageDto extends createZodDto(
  DeliveredWaitingMessageSchema,
) {}

export class CreateRunGoalDto extends createZodDto(RunGoalCreateSchema) {}

export class EditRunGoalDto extends createZodDto(RunGoalEditSchema) {}

export class CloseRunGoalDto extends createZodDto(RunGoalCloseSchema) {}
