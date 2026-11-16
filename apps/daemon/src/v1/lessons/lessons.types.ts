import { z } from 'zod';

import type { ChatApprovalMode } from '../agents/chat.types';
import { MEMORY_TITLE_MAX_CHARS, MEMORY_TYPES } from '../memory/memory.types';
import { AgentKindSchema } from '../runs/runs.types';

export const LESSON_TITLE_MAX_CHARS = MEMORY_TITLE_MAX_CHARS;
export const LESSON_RULE_MAX_CHARS = 300;
export const LESSON_WHY_MAX_CHARS = 300;
export const LESSONS_PER_REFLECTION_MAX = 3;
export const LESSONS_REFLECTION_APPROVAL: ChatApprovalMode = 'ask';
export const LESSON_REJECT_REASON_MAX_CHARS = 300;
/** How many rejected proposals of the same place a reflection is shown. */
export const LESSON_REJECTED_BRIEF_MAX = 20;

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

export const LESSON_SEGMENT_CLOSERS = [
  'manual',
  'archive',
  'done',
  'idle',
  'delete',
] as const;
export type LessonSegmentCloser = (typeof LESSON_SEGMENT_CLOSERS)[number];

export const LESSON_SEGMENT_STATUSES = [
  'offered',
  'dismissed',
  'reflecting',
  'reflected',
  'failed',
  'empty',
] as const;
export type LessonSegmentStatus = (typeof LESSON_SEGMENT_STATUSES)[number];

export const LESSON_PROPOSAL_STATUSES = [
  'proposed',
  'saved',
  'rejected',
  'failed',
] as const;
export type LessonProposalStatus = (typeof LESSON_PROPOSAL_STATUSES)[number];
export const LessonProposalStatusSchema = z
  .enum(LESSON_PROPOSAL_STATUSES)
  .meta({ id: 'LessonProposalStatus' });

export const LESSON_MEMORY_SCOPES = ['project', 'team', 'global'] as const;
export type LessonMemoryScope = (typeof LESSON_MEMORY_SCOPES)[number];

/** Where a saved lesson is written. Only a memory entry is saved today. */
export const LessonMemoryTargetSchema = z
  .object({
    kind: z.literal('memory'),
    scope: z.enum(LESSON_MEMORY_SCOPES),
    type: z.enum(MEMORY_TYPES),
  })
  .meta({ id: 'LessonMemoryTarget' });
export type LessonMemoryTarget = z.infer<typeof LessonMemoryTargetSchema>;

export const LessonTargetSchema = LessonMemoryTargetSchema;
export type LessonTarget = LessonMemoryTarget;

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
  places: z.object({ project: z.boolean(), team: z.boolean() }),
});
export type LessonsPayload = z.infer<typeof LessonsPayloadSchema>;

/**
 * The `lesson_outcome` item the user's save or reject writes beside the card.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/lessons-payload.ts.
 */
export const LessonOutcomePayloadSchema = z.object({
  proposalId: z.string(),
  status: z.enum(['saved', 'rejected']),
  title: z.string(),
  rule: z.string(),
  target: LessonTargetSchema,
  memoryHandle: z.string().nullable(),
  reason: z.string().nullable(),
});
export type LessonOutcomePayload = z.infer<typeof LessonOutcomePayloadSchema>;

export const LESSON_REFLECTION_MODES = ['off', 'offer'] as const;
export type LessonReflectionMode = (typeof LESSON_REFLECTION_MODES)[number];

/**
 * The lessons settings Electron main pushes (`PUT /v1/lessons/config`).
 * A null agent reflects with the thread's own CLI, a null model or effort
 * with that CLI's default.
 *
 * TWIN PARSER: `lessonsSchema` in `apps/ui/src/main/ipc-schemas.ts`.
 */
export const LessonsConfigSchema = z
  .object({
    mode: z.enum(LESSON_REFLECTION_MODES),
    agentKind: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .describe(
        'An agent kind; one this daemon does not know reads as null, the thread’s own CLI',
      ),
    model: z.string().min(1).max(200).nullable(),
    effort: z.string().min(1).max(50).nullable(),
  })
  .meta({ id: 'LessonsConfig' });
export type LessonsConfig = z.infer<typeof LessonsConfigSchema>;

export const DEFAULT_LESSONS_CONFIG: LessonsConfig = {
  mode: 'offer',
  agentKind: null,
  model: null,
  effort: null,
};

/** What "Reflect now" may name for one reflection, over the settings. */
export const ReflectLessonsSchema = z.object({
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(50).optional(),
  configDir: z.string().min(1).max(4096).optional(),
});
export type ReflectLessons = z.infer<typeof ReflectLessonsSchema>;

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
    memoryHandle: z.string().nullable(),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .meta({ id: 'LessonProposal' });
export type LessonProposalWire = z.infer<typeof LessonProposalWireSchema>;

export const LessonProposalListSchema = z.object({
  proposals: z.array(LessonProposalWireSchema),
});

export const LessonProposalListQuerySchema = z.object({
  status: LessonProposalStatusSchema.optional(),
  sourceRunId: z.string().min(1).max(200).optional(),
});
export type LessonProposalListQuery = z.infer<
  typeof LessonProposalListQuerySchema
>;

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
            .object({
              kind: z.literal('memory'),
              scope: z
                .enum(LESSON_MEMORY_SCOPES)
                .describe(
                  'global: how the user wants to work anywhere; project: this project; team: one role of this team',
                ),
              type: z
                .enum(MEMORY_TYPES)
                .describe('feedback for a way of working, project for a fact'),
            })
            .strict(),
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
});
export type ProposeLessonsCall = z.infer<typeof ProposeLessonsCallSchema>;
