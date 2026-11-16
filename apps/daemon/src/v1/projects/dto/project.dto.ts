import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  ChatApprovalModeSchema,
  hasControlCharacters,
} from '../../agents/chat.types';
import { AgentKindSchema } from '../../runs/runs.types';
import { TaskSourceSchema, TaskStatusSchema } from '../../tasks/tasks.types';
import {
  KNOWLEDGE_FATES,
  KnowledgeRenamedSchema,
  LessonOverrideSchema,
  MAX_PROJECT_INSTRUCTION_BLOCKS,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_MAX_CONCURRENT_CEILING,
  PROJECT_NAME_MAX,
  ProjectForFolderSchema,
  ProjectInstructionBlockSchema,
  ProjectQueueSchema,
  ProjectWireSchema,
} from '../projects.types';

/**
 * HTTP DTOs for the project routes.
 *
 * Inputs are validated by the global `ZodValidationPipe` the http-server
 * installs; responses are declared with `@ZodResponse` on the controller,
 * which type-checks the handler's return value, serializes it through the
 * schema, and publishes the schema to the OpenAPI document the renderer's
 * client is generated from. A response DTO's ROOT schema carries no
 * `.meta({ id })` — see `chat.dto.ts` for why.
 */

const noControlCharacters = (value: string) => !hasControlCharacters(value);

/** A project's name — non-blank after trimming, sanely bounded; composed into every run's instructions. */
const projectNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROJECT_NAME_MAX)
  .refine(noControlCharacters, 'must not contain control characters');

const projectDescriptionSchema = z
  .string()
  .max(PROJECT_DESCRIPTION_MAX)
  .refine(noControlCharacters, 'must not contain control characters');

const projectInstructionBlocksSchema = z
  .array(ProjectInstructionBlockSchema)
  .max(MAX_PROJECT_INSTRUCTION_BLOCKS);

/**
 * The autopilot POLICY — what the user decides, and the whole of what a client
 * may write.
 *
 * `autopilotFailureStreak` is deliberately not here. It is the breaker's own
 * running count, written by the daemon as runs settle, and a client that could
 * set it could hold the breaker open or clear it without re-arming — which is
 * the one act the breaker exists to make deliberate. Re-arming has its own
 * route for that reason.
 */
const autopilotPolicy = {
  autopilotEnabled: z.boolean(),
  autopilotIntakeStatus: TaskStatusSchema,
  /**
   * Bounded at the SCHEMA rather than clamped in the service: each concurrent
   * task takes its own git worktree, so a client asking for fifty is refused
   * with the ceiling named instead of quietly getting five and believing it
   * got fifty.
   */
  autopilotMaxConcurrent: z
    .number()
    .int()
    .min(1)
    .max(PROJECT_MAX_CONCURRENT_CEILING),
};

export const createProjectSchema = z.object({
  name: projectNameSchema,
  /**
   * Checked and canonicalized by the service before it is stored: a project
   * pointing at a folder that does not exist could never run a task.
   */
  folder: z.string().min(1),
  groupId: z.string().min(1).optional(),
  description: projectDescriptionSchema.optional(),
  instructionBlocks: projectInstructionBlocksSchema.optional(),
  agentKind: AgentKindSchema.optional(),
  model: z.string().min(1).optional(),
  effort: z.string().min(1).optional(),
  contextWindow: z.string().min(1).optional(),
  modelParameters: z.record(z.string(), z.string()).optional(),
  approval: ChatApprovalModeSchema.optional(),
  configDir: z.string().min(1).optional(),
  teamSlug: z.string().min(1).optional(),
  provider: TaskSourceSchema.optional(),
  autopilotEnabled: autopilotPolicy.autopilotEnabled.optional(),
  autopilotIntakeStatus: autopilotPolicy.autopilotIntakeStatus.optional(),
  autopilotMaxConcurrent: autopilotPolicy.autopilotMaxConcurrent.optional(),
});
export class CreateProjectDto extends createZodDto(createProjectSchema) {}

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    folder: z.string().min(1).optional(),
    /**
     * Explicit null clears the binding — the one thing an omitted key (= leave
     * unchanged) cannot say, the same contract the sidebar group's patch uses
     * for `autoCwd`. Every nullable field below reads the same way.
     */
    groupId: z.string().min(1).nullable().optional(),
    description: projectDescriptionSchema.nullable().optional(),
    instructionBlocks: projectInstructionBlocksSchema.nullable().optional(),
    agentKind: AgentKindSchema.nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),
    contextWindow: z.string().min(1).nullable().optional(),
    modelParameters: z.record(z.string(), z.string()).nullable().optional(),
    approval: ChatApprovalModeSchema.nullable().optional(),
    configDir: z.string().min(1).nullable().optional(),
    teamSlug: z.string().min(1).nullable().optional(),
    lessons: LessonOverrideSchema.nullable().optional(),
    /**
     * The three policy fields break the nullable pattern of every field above
     * them, and the reason is the column: these are NOT NULL with defaults, so
     * there is no "unset" state for a null to mean. Omitting the key is the
     * only way to leave one alone.
     */
    autopilotEnabled: autopilotPolicy.autopilotEnabled.optional(),
    autopilotIntakeStatus: autopilotPolicy.autopilotIntakeStatus.optional(),
    autopilotMaxConcurrent: autopilotPolicy.autopilotMaxConcurrent.optional(),
    /**
     * The `instructionsRevision` the writer read the texts at. A project that
     * has moved past it refuses the patch `409 PROJECT_INSTRUCTIONS_DRIFT`;
     * omitted, nothing is checked.
     */
    expectedInstructionsRevision: z.number().int().min(0).optional(),
  })
  .refine(
    ({ expectedInstructionsRevision: _, ...fields }) =>
      Object.values(fields).some((value) => value !== undefined),
    'a project patch must change at least one field',
  );
export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}

// ── Responses ───────────────────────────────────────────────────────────────

/** One project. */
export class ProjectDto extends createZodDto(ProjectWireSchema) {}

/** `GET /v1/projects/of-folder` — the folder a new chat would start in. */
export const projectForFolderQuerySchema = z.object({
  path: z.string().min(1),
});
export class ProjectForFolderQueryDto extends createZodDto(
  projectForFolderQuerySchema,
) {}

/** The project a folder belongs to, or none. */
export class ProjectForFolderDto extends createZodDto(ProjectForFolderSchema) {}

/** What one project's autopilot may start right now. */
export class ProjectQueueDto extends createZodDto(ProjectQueueSchema) {}

/**
 * Acknowledgement of a project delete. It reports how many tasks went with it,
 * because they DO go with it — unlike a sidebar group, which releases its runs.
 * A board is the project; there is nowhere for its cards to be released to.
 */
export class ProjectDeletedDto extends createZodDto(
  z.object({
    deleted: z.boolean().describe('True when the project row was removed'),
    tasksRemoved: z
      .number()
      .int()
      .describe('How many of its tasks were removed with it'),
    knowledgeMoved: z
      .number()
      .int()
      .describe('How many of its knowledge documents moved to Global'),
    knowledgeDeleted: z
      .number()
      .int()
      .describe('How many of its knowledge documents were deleted'),
    knowledgeRenamed: z
      .array(KnowledgeRenamedSchema)
      .describe('Handles a move to Global changed, because Global held them'),
  }),
) {}

/** What a project's delete does with the documents filed under it. */
export class DeleteProjectQueryDto extends createZodDto(
  z.object({
    knowledge: z
      .enum(KNOWLEDGE_FATES)
      .optional()
      .describe(
        'What happens to the documents filed under the project: move them to Global, or delete them; default global',
      ),
  }),
) {}
