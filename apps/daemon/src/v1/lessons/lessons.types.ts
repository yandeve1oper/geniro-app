import { z } from 'zod';

import type { ChatApprovalMode } from '../agents/chat.types';
import { MEMORY_TITLE_MAX_CHARS, MEMORY_TYPES } from '../memory/memory.types';
import { AgentKindSchema, type ItemKind } from '../runs/runs.types';

export const LESSON_TITLE_MAX_CHARS = MEMORY_TITLE_MAX_CHARS;
export const LESSON_RULE_MAX_CHARS = 300;
export const LESSON_WHY_MAX_CHARS = 300;
export const LESSONS_PER_REFLECTION_MAX = 3;
export const LESSONS_REFLECTION_APPROVAL: ChatApprovalMode = 'ask';
export const LESSON_REJECT_REASON_MAX_CHARS = 300;
/** How many rejected proposals of the same place a reflection is shown. */
export const LESSON_REJECTED_BRIEF_MAX = 20;
/** Memory entries a reflection brief lists as in front of the thread's agents. */
export const LESSON_SEEN_ENTRIES_BRIEF_MAX = 30;
/** Effects one reflection may report. */
export const LESSON_EFFECTS_MAX = 10;
export const LESSON_EFFECT_REASON_MAX_CHARS = 200;
/** What a reflection saw an entry do in the thread, and the mark it becomes. */
export const LESSON_EFFECTS = ['followed', 'misled', 'broken'] as const;
export type LessonEffect = (typeof LESSON_EFFECTS)[number];

/** The rows the lessons machinery writes into a thread: never new activity to reflect on. */
export const LESSON_ROW_KINDS: readonly ItemKind[] = [
  'lessons',
  'lesson_outcome',
];

/** What can tell a reflection that something went wrong in a thread. */
export const LESSON_SIGNAL_KINDS = [
  'user_correction',
  'approval_refused',
  'error_then_success',
  'outcome_failed',
  'stage_reopened',
  'review_finding',
] as const;
export type LessonSignalKind = (typeof LESSON_SIGNAL_KINDS)[number];
export const LessonSignalKindSchema = z
  .enum(LESSON_SIGNAL_KINDS)
  .meta({ id: 'LessonSignalKind' });

/** One learning signal the model-free fold found in a stretch of a thread. */
export interface LessonSignal {
  kind: LessonSignalKind;
  seq: number;
  excerpt: string;
}

export const LESSON_SEGMENT_CLOSERS = ['manual', 'archive', 'delete'] as const;
export type LessonSegmentCloser = (typeof LESSON_SEGMENT_CLOSERS)[number];

export const LESSON_SEGMENT_STATUSES = [
  'queued',
  'reflecting',
  'checking',
  'reflected',
  'failed',
  'empty',
  'skipped',
] as const;
export type LessonSegmentStatus = (typeof LESSON_SEGMENT_STATUSES)[number];

/** How many reflections one stretch gets before it is left `failed`. */
export const LESSON_SEGMENT_MAX_ATTEMPTS = 3;
/** How long one reflection or check may hold its stretch before the runner takes it back. */
export const LESSON_SEGMENT_LEASE_MS = 30 * 60_000;

export const LESSON_PROPOSAL_STATUSES = [
  'proposed',
  'checking',
  'saved',
  'skipped_duplicate',
  'undone',
  'dropped_by_check',
  'check_failed',
  'rejected',
  'failed',
] as const;
export type LessonProposalStatus = (typeof LESSON_PROPOSAL_STATUSES)[number];
export const LessonProposalStatusSchema = z
  .enum(LESSON_PROPOSAL_STATUSES)
  .meta({ id: 'LessonProposalStatus' });

export const LESSON_MEMORY_SCOPES = ['project', 'team', 'global'] as const;
export type LessonMemoryScope = (typeof LESSON_MEMORY_SCOPES)[number];

export const LessonMemoryTargetSchema = z
  .object({
    kind: z.literal('memory'),
    scope: z.enum(LESSON_MEMORY_SCOPES),
    type: z.enum(MEMORY_TYPES),
  })
  .meta({ id: 'LessonMemoryTarget' });
export type LessonMemoryTarget = z.infer<typeof LessonMemoryTargetSchema>;

export const LessonProjectInstructionsTargetSchema = z
  .object({ kind: z.literal('project_instructions') })
  .meta({ id: 'LessonProjectInstructionsTarget' });

export const LessonMemberInstructionsTargetSchema = z
  .object({
    kind: z.literal('member_instructions'),
    memberId: z.string().min(1).max(200),
  })
  .meta({ id: 'LessonMemberInstructionsTarget' });

export const LessonKnowledgeTargetSchema = z
  .object({
    kind: z.literal('knowledge'),
    handle: z
      .string()
      .min(1)
      .max(200)
      .nullable()
      .describe(
        'The project document the lesson is appended to; null files a new one',
      ),
  })
  .meta({ id: 'LessonKnowledgeTarget' });

/**
 * Where a saved lesson is written. Only a memory target is ever written
 * without the user: instructions and knowledge are shared, always-loaded
 * texts, so those lessons wait for Save.
 */
export const LessonTargetSchema = z
  .discriminatedUnion('kind', [
    LessonMemoryTargetSchema,
    LessonProjectInstructionsTargetSchema,
    LessonMemberInstructionsTargetSchema,
    LessonKnowledgeTargetSchema,
  ])
  .meta({ id: 'LessonTarget' });
export type LessonTarget = z.infer<typeof LessonTargetSchema>;

/** One member of the source team run, for the card's member picker. */
export const LessonPlaceMemberSchema = z
  .object({ id: z.string(), name: z.string() })
  .meta({ id: 'LessonPlaceMember' });

/**
 * What the source thread had a place for when the lesson was filed: its
 * project (memory, instructions, knowledge) and its team's members.
 */
export const LessonPlacesSchema = z
  .object({
    project: z.boolean(),
    team: z.boolean(),
    projectId: z.string().nullable(),
    members: z.array(LessonPlaceMemberSchema),
  })
  .meta({ id: 'LessonPlaces' });
export type LessonPlaces = z.infer<typeof LessonPlacesSchema>;

/**
 * Where "Move up" puts a rule broken again: its entry into every chat's memory
 * index (approved), the least-reaching step. The project's instructions stay a
 * target the user picks from the lesson's menu.
 */
export const LESSON_MOVE_UP_PLACES = ['memory_index'] as const;
export type LessonMoveUpPlace = (typeof LESSON_MOVE_UP_PLACES)[number];

/** How a proposal relates to what agents are already told. */
export const LessonDedupSchema = z
  .object({
    verdict: z.enum(['new', 'refines', 'broken_again']),
    handle: z.string().nullable(),
  })
  .meta({ id: 'LessonDedup' });
export type LessonDedup = z.infer<typeof LessonDedupSchema>;

export const LessonEvidenceSchema = z
  .object({
    seq: z.number().int().min(0),
    quote: z.string(),
  })
  .meta({ id: 'LessonEvidence' });

/**
 * One proposed lesson as the card draws it.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/lessons-payload.ts reads the
 * `lessons` item payload {@link LessonsPayloadSchema} carries these in.
 */
export const LessonProposalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  rule: z.string(),
  why: z.string(),
  signalKind: LessonSignalKindSchema,
  evidence: LessonEvidenceSchema,
  target: LessonTargetSchema,
  dedup: LessonDedupSchema,
});
export type LessonProposalCard = z.infer<typeof LessonProposalCardSchema>;

/**
 * The `lessons` item a reflection writes into the thread it read.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/lessons-payload.ts.
 */
export const LessonsPayloadSchema = z.object({
  reflectionRunId: z.string(),
  segmentId: z.string(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
  agentKind: AgentKindSchema,
  model: z.string().nullable(),
  proposals: z.array(LessonProposalCardSchema),
  places: LessonPlacesSchema,
  check: z
    .object({
      runId: z.string(),
      agentKind: AgentKindSchema,
      model: z.string().nullable(),
    })
    .nullable(),
});
export type LessonsPayload = z.infer<typeof LessonsPayloadSchema>;

/**
 * The `lesson_outcome` item the user's save or reject writes beside the card.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/lessons-payload.ts.
 */
export const LESSON_OUTCOME_STATUSES = [
  'saved',
  'pending',
  'rejected',
  'undone',
  'skipped_duplicate',
  'dropped_by_check',
] as const;
export type LessonOutcomeStatus = (typeof LESSON_OUTCOME_STATUSES)[number];

export const LessonOutcomePayloadSchema = z.object({
  proposalId: z.string(),
  status: z.enum(LESSON_OUTCOME_STATUSES),
  by: z.enum(['user', 'auto']),
  title: z.string(),
  rule: z.string(),
  target: LessonTargetSchema,
  memoryHandle: z.string().nullable(),
  resultRef: z
    .string()
    .nullable()
    .describe(
      'Where a save outside memory landed: the knowledge document handle, the team slug or the project id',
    ),
  reason: z.string().nullable(),
});
export type LessonOutcomePayload = z.infer<typeof LessonOutcomePayloadSchema>;

/** How long a delete that extracts lessons first waits for its reflection before deleting anyway. */
export const LESSON_PENDING_DELETE_MAX_MS = 10 * 60_000;

export const LESSON_REFLECTION_MODES = ['off', 'auto'] as const;
export type LessonReflectionMode = (typeof LESSON_REFLECTION_MODES)[number];

/**
 * One CLI and everything it runs with for a lessons reflection or its check —
 * the shape of a memory check's agent (`MemoryTriageConfig` in the UI).
 */
export const LessonModelChoiceSchema = z
  .object({
    agent: z
      .string()
      .min(1)
      .max(64)
      .describe('An agent kind; one this daemon does not know is ignored'),
    configDir: z.string().min(1).max(4096).nullable(),
    model: z.string().min(1).max(200).nullable(),
    effort: z.string().min(1).max(50).nullable(),
    contextWindow: z.string().min(1).max(50).nullable(),
    modelParameters: z.record(z.string().max(100), z.string().max(200)),
  })
  .meta({ id: 'LessonModelChoice' });
export type LessonModelChoice = z.infer<typeof LessonModelChoiceSchema>;

/**
 * The lessons settings Electron main pushes (`PUT /v1/lessons/config`).
 * A null reflector reflects as the thread ran — its CLI, profile, model,
 * effort, window and model parameters; a null checker runs no check.
 *
 * TWIN PARSER: `lessonsSchema` in `apps/ui/src/main/ipc-schemas.ts`.
 */
export const LessonsConfigSchema = z
  .object({
    mode: z.enum(LESSON_REFLECTION_MODES),
    reflector: LessonModelChoiceSchema.nullable(),
    checker: LessonModelChoiceSchema.nullable(),
  })
  .meta({ id: 'LessonsConfig' });
export type LessonsConfig = z.infer<typeof LessonsConfigSchema>;

export const DEFAULT_LESSONS_CONFIG: LessonsConfig = {
  mode: 'auto',
  reflector: null,
  checker: null,
};

/** What "Reflect now" or a delete may name for one reflection, over the settings. */
export const ReflectLessonsSchema = z.object({
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(50).optional(),
  configDir: z.string().min(1).max(4096).optional(),
});
export type ReflectLessons = z.infer<typeof ReflectLessonsSchema>;

/** What a reflection would cost, priced before it runs. */
export const LessonEstimateSchema = z
  .object({
    agentKind: AgentKindSchema,
    model: z
      .string()
      .nullable()
      .describe(
        'The model the reflection would run as; null when the CLI cannot say before a turn',
      ),
    tokens: z.number().int().min(0),
    usd: z
      .number()
      .nullable()
      .describe(
        'Null when the model has no list price (cursor-agent, an unlisted id) — never 0',
      ),
  })
  .meta({ id: 'LessonEstimate' });
export type LessonEstimate = z.infer<typeof LessonEstimateSchema>;

export const LessonEstimateQuerySchema = z.object({
  runId: z.string().min(1).max(200),
});
export type LessonEstimateQuery = z.infer<typeof LessonEstimateQuerySchema>;

/** One thread's unreflected stretch priced, for the archive notice and the delete dialog. */
export const ThreadLessonEstimateSchema = z
  .object({
    estimate: LessonEstimateSchema,
    check: LessonEstimateSchema.nullable().describe(
      'What the second-model check would cost when it runs; null while the check is off',
    ),
    signals: z
      .number()
      .int()
      .min(0)
      .describe(
        'Learning signals past the last reflection; 0 = nothing worth reflecting on',
      ),
    fromSeq: z.number().int(),
    toSeq: z.number().int(),
  })
  .meta({ id: 'ThreadLessonEstimate' });
export type ThreadLessonEstimate = z.infer<typeof ThreadLessonEstimateSchema>;

export const LessonSignalRefSchema = z
  .object({ kind: LessonSignalKindSchema, seq: z.number().int() })
  .meta({ id: 'LessonSignalRef' });

export const LessonSegmentCloserSchema = z
  .enum(LESSON_SEGMENT_CLOSERS)
  .meta({ id: 'LessonSegmentCloser' });
export const LessonSegmentStatusSchema = z
  .enum(LESSON_SEGMENT_STATUSES)
  .meta({ id: 'LessonSegmentStatus' });

/** One closed stretch, as the archive notice and the Settings readout read it. */
export const LessonSegmentWireSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    sourceTitle: z.string().nullable(),
    fromSeq: z.number().int(),
    toSeq: z.number().int(),
    closedBy: LessonSegmentCloserSchema,
    closedAt: z.string(),
    signals: z.array(LessonSignalRefSchema),
    status: LessonSegmentStatusSchema,
    reflectionRunId: z.string().nullable(),
    checkRunId: z.string().nullable(),
    failReason: z.string().nullable(),
    estimate: LessonEstimateSchema,
    checkEstimate: LessonEstimateSchema.nullable(),
  })
  .meta({ id: 'LessonSegment' });
export type LessonSegmentWire = z.infer<typeof LessonSegmentWireSchema>;

export const LessonSegmentListSchema = z.object({
  segments: z.array(LessonSegmentWireSchema),
});

export const LessonSegmentListQuerySchema = z.object({
  status: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Comma-separated statuses; omitted = queued, reflecting and checking',
    ),
  runId: z.string().min(1).max(200).optional(),
});
export type LessonSegmentListQuery = z.infer<
  typeof LessonSegmentListQuerySchema
>;

const LessonSpendByStepSchema = z
  .object({ reflect: z.number(), check: z.number() })
  .meta({ id: 'LessonSpendByStep' });

/** What lessons cost today and this month, by step, for the Settings readout. */
export const LessonsSpendSchema = z
  .object({
    todayUsd: z.number(),
    monthUsd: z.number(),
    todayByStep: LessonSpendByStepSchema,
    monthByStep: LessonSpendByStepSchema,
    reflectedToday: z
      .number()
      .int()
      .min(0)
      .describe('Threads reflected on today'),
    savedToday: z
      .number()
      .int()
      .min(0)
      .describe('Lessons saved to memory today'),
    unpricedRuns: z
      .number()
      .int()
      .min(0)
      .describe('Reflections or checks this month whose CLI reported no cost'),
    failed: z.array(
      z.object({
        segmentId: z.string(),
        runId: z.string(),
        sourceTitle: z.string().nullable(),
        reason: z.string().nullable(),
      }),
    ),
  })
  .meta({ id: 'LessonsSpend' });
export type LessonsSpend = z.infer<typeof LessonsSpendSchema>;

/** The user's edit of a lesson already saved to memory; the entry becomes the user's own. */
export const EditLessonSchema = z.object({
  title: z.string().trim().min(1).max(LESSON_TITLE_MAX_CHARS),
  rule: z.string().trim().min(1).max(LESSON_RULE_MAX_CHARS),
});
export type EditLesson = z.infer<typeof EditLessonSchema>;

export interface LessonsFiled {
  saved: number;
  waiting: number;
}

/**
 * The `lessons_changed` broadcast: a segment or proposal of this thread
 * changed. `filed` rides only the write of a reflection's card.
 *
 * TWIN PARSER: `parseLessonsChanged` in `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface LessonsChangedEvent {
  runId: string | null;
  filed?: LessonsFiled;
}

export const LessonsReflectStartedSchema = z.object({
  reflectionRunId: z.string(),
  segmentId: z.string(),
  fromSeq: z.number().int(),
  toSeq: z.number().int(),
});

/** Whether a thread can be reflected on now, for its "Reflect now" control. */
export const ThreadLessonsStateSchema = z
  .object({
    reflectable: z
      .boolean()
      .describe(
        'Something past the last reflection exists and the thread may be reflected on',
      ),
    reflectionRunId: z
      .string()
      .nullable()
      .describe('The reflection still working on this thread, if any'),
    reflectedThroughSeq: z.number().int().nullable(),
  })
  .meta({ id: 'ThreadLessonsState' });
export type ThreadLessonsState = z.infer<typeof ThreadLessonsStateSchema>;

/** One reflection as a lessons card's footer states it, from the daemon's figures. */
export const LessonReflectionFactsSchema = z
  .object({
    reflectionRunId: z.string(),
    agentKind: AgentKindSchema,
    model: z.string().nullable(),
    effort: z.string().nullable(),
    working: z.boolean(),
    startedAt: z.string(),
    durationMs: z.number().int().nullable(),
    costUsd: z
      .number()
      .nullable()
      .describe('Measured spend; null when the CLI reports none'),
    tokens: z.number().int().nullable(),
  })
  .meta({ id: 'LessonReflectionFacts' });
export type LessonReflectionFacts = z.infer<typeof LessonReflectionFactsSchema>;

export const LessonProposalWireSchema = z
  .object({
    id: z.string(),
    sourceRunId: z.string(),
    sourceTitle: z.string().nullable(),
    reflectionRunId: z.string(),
    projectId: z.string().nullable(),
    teamSlug: z.string().nullable(),
    title: z.string(),
    rule: z.string(),
    why: z.string(),
    signalKind: LessonSignalKindSchema,
    evidence: LessonEvidenceSchema,
    target: LessonTargetSchema,
    dedup: LessonDedupSchema,
    status: LessonProposalStatusSchema,
    rejectReason: z.string().nullable(),
    checkVerdict: z.enum(['keep', 'rewrite', 'drop']).nullable(),
    checkReason: z.string().nullable(),
    memoryHandle: z.string().nullable(),
    resultRef: z.string().nullable(),
    places: LessonPlacesSchema,
    moveUp: z
      .enum(LESSON_MOVE_UP_PLACES)
      .nullable()
      .describe(
        'Where "Move up" would put a rule that was broken again; null when it does not apply or its entry is already in the index',
      ),
    undoable: z
      .boolean()
      .describe(
        'Saved to memory as an entry of its own, so Undo and Edit apply',
      ),
    memoryPending: z
      .boolean()
      .describe(
        "Its own memory entry still waits for the user's review, so no agent uses it yet",
      ),
    sourceExists: z
      .boolean()
      .describe('False once the thread the lesson came from was deleted'),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .meta({ id: 'LessonProposal' });
export type LessonProposalWire = z.infer<typeof LessonProposalWireSchema>;

export const LessonProposalListSchema = z.object({
  proposals: z.array(LessonProposalWireSchema),
});

export const LessonProposalListQuerySchema = z.object({
  status: z
    .preprocess(
      (value) => (Array.isArray(value) ? value.join(',') : value),
      z.string().max(200).optional(),
    )
    .describe('Comma-separated statuses; omitted = every status'),
  sourceRunId: z.string().min(1).max(200).optional(),
});
export type LessonProposalListQuery = z.infer<
  typeof LessonProposalListQuerySchema
>;

/** "Update rule" on a `refines` lesson: the named entry takes the lesson's text, as the user's edit. */
export const UpdateLessonRuleSchema = z.object({
  title: z.string().trim().min(1).max(LESSON_TITLE_MAX_CHARS).optional(),
  rule: z.string().trim().min(1).max(LESSON_RULE_MAX_CHARS).optional(),
});
export type UpdateLessonRule = z.infer<typeof UpdateLessonRuleSchema>;

/** The user's Save: the text as edited on the card, and where it goes. */
export const SaveLessonSchema = z.object({
  title: z.string().trim().min(1).max(LESSON_TITLE_MAX_CHARS).optional(),
  rule: z.string().trim().min(1).max(LESSON_RULE_MAX_CHARS).optional(),
  target: LessonTargetSchema.optional(),
});
export type SaveLesson = z.infer<typeof SaveLessonSchema>;

export const RejectLessonSchema = z.object({
  reason: z.string().trim().max(LESSON_REJECT_REASON_MAX_CHARS).optional(),
});
export type RejectLesson = z.infer<typeof RejectLessonSchema>;

/** `propose_lessons`'s arguments, as the reflection sends them. */
export const ProposeLessonsCallSchema = z.object({
  lessons: z
    .array(
      z
        .object({
          title: z
            .string()
            .min(1)
            .describe(
              `The rule itself, as later agents see it in their memory index: "WHEN <observable condition> → DO / DON'T <action>", at most ${LESSON_TITLE_MAX_CHARS} characters`,
            ),
          rule: z
            .string()
            .min(1)
            .describe(
              `The rule in full, at most ${LESSON_RULE_MAX_CHARS} characters`,
            ),
          why: z
            .string()
            .min(1)
            .describe(
              `What went wrong in the thread that this rule prevents, at most ${LESSON_WHY_MAX_CHARS} characters`,
            ),
          signalKind: LessonSignalKindSchema.describe(
            'What kind of learning signal the evidence is',
          ),
          evidence: z
            .object({
              seq: z
                .number()
                .int()
                .describe(
                  'The seq of the row holding the signal, inside the stretch your brief names',
                ),
              quote: z
                .string()
                .describe(
                  'A verbatim quote of 8–200 characters from that row (view=item seq=N)',
                ),
            })
            .strict(),
          target: z
            .discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('memory'),
                  scope: z
                    .enum(LESSON_MEMORY_SCOPES)
                    .describe(
                      'global: how the user wants to work anywhere; project: this project; team: one role of this team',
                    ),
                  type: z
                    .enum(MEMORY_TYPES)
                    .describe(
                      'feedback for a way of working, project for a fact',
                    ),
                })
                .strict(),
              z
                .object({
                  kind: z
                    .literal('project_instructions')
                    .describe(
                      "A rule that must hold in every run of this thread's project",
                    ),
                })
                .strict(),
              z
                .object({
                  kind: z
                    .literal('member_instructions')
                    .describe(
                      'How one member of this team run should work, appended to its instructions',
                    ),
                  memberId: z
                    .string()
                    .min(1)
                    .describe('The member id as your brief lists it'),
                })
                .strict(),
              z
                .object({
                  kind: z
                    .literal('knowledge')
                    .describe(
                      "A long procedure, filed in the project's knowledge store",
                    ),
                  handle: z
                    .string()
                    .min(1)
                    .nullable()
                    .describe(
                      'The handle of an existing document of this project to append to; null for a new document',
                    ),
                })
                .strict(),
            ])
            .describe(
              'Where the lesson goes. Only memory is written at once; the others wait for the user',
            ),
          dedup: z
            .object({
              verdict: z
                .enum(['new', 'refines', 'broken_again'])
                .describe(
                  'new; refines: an existing memory entry says it less well; broken_again: the entry existed and was broken anyway',
                ),
              handle: z
                .string()
                .nullable()
                .describe(
                  'The memory entry (m12) refines / broken_again names; null for new',
                ),
            })
            .strict(),
        })
        .strict(),
    )
    .describe(
      `At most ${LESSONS_PER_REFLECTION_MAX}; an empty list when no lesson passes all five gates`,
    ),
  effects: z
    .array(
      z
        .object({
          handle: z
            .string()
            .min(1)
            .describe(
              'A memory entry your brief lists as in front of this thread’s agents (m12)',
            ),
          effect: z
            .enum(LESSON_EFFECTS)
            .describe(
              'followed: the agents relied on it and it helped; misled: following it caused a mistake; broken: the agents had it and acted against it',
            ),
          seq: z
            .number()
            .int()
            .describe('The seq of the row inside your stretch that shows it'),
          reason: z
            .string()
            .min(1)
            .describe(
              `What the entry did here, at most ${LESSON_EFFECT_REASON_MAX_CHARS} characters`,
            ),
        })
        .strict(),
    )
    .optional()
    .describe(
      `At most ${LESSON_EFFECTS_MAX}: what memory entries did in this stretch, only where a row shows it; omit or leave empty when none clearly did anything`,
    ),
});
export type ProposeLessonsCall = z.infer<typeof ProposeLessonsCallSchema>;

export const LESSON_CHECK_VERDICTS = ['keep', 'rewrite', 'drop'] as const;
export type LessonCheckVerdict = (typeof LESSON_CHECK_VERDICTS)[number];
export const LESSON_CHECK_REASON_MAX_CHARS = 300;

/** `check_lessons`'s arguments, as the second-model check sends them. */
export const CheckLessonsCallSchema = z.object({
  verdicts: z
    .array(
      z
        .object({
          proposalId: z
            .string()
            .min(1)
            .describe('The id of a lesson your brief lists'),
          verdict: z
            .enum(LESSON_CHECK_VERDICTS)
            .describe(
              'keep: it passes all five gates as written; rewrite: it passes once reworded; drop: it fails a gate',
            ),
          reason: z
            .string()
            .min(1)
            .describe(
              `Which gate it passes or fails and why, at most ${LESSON_CHECK_REASON_MAX_CHARS} characters`,
            ),
          rewrite: z
            .object({
              title: z
                .string()
                .min(1)
                .describe(
                  `The reworded rule for the memory index, at most ${LESSON_TITLE_MAX_CHARS} characters`,
                ),
              rule: z
                .string()
                .min(1)
                .describe(
                  `The reworded rule in full, at most ${LESSON_RULE_MAX_CHARS} characters`,
                ),
            })
            .strict()
            .optional()
            .describe('Only with verdict rewrite'),
        })
        .strict(),
    )
    .describe('One verdict for every lesson your brief lists'),
});
export type CheckLessonsCall = z.infer<typeof CheckLessonsCallSchema>;
