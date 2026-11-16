import { z } from 'zod';

import {
  AGENT_ICON_NAMES,
  type AgentFailureClass,
} from '../agents/adapters/adapter.types';
import {
  type ActionSpec,
  AgentApprovalProbeSchema,
  AgentOptionSpecSchema,
  AutoCompactPercentSchema,
  ChatApprovalModeSchema,
  ChatTotalsWireSchema,
  CustomInstructionsSchema,
  PendingOwnedCardSchema,
  type PersistedResetWake,
  type StageActor,
  type StageChangePayload,
  type StageMoveAction,
  StageMoveActionSchema,
  type StageProgress,
  StageProgressSchema,
} from '../agents/chat.types';
import { createChatSchema } from '../agents/dto/chat.dto';
import { TURN_INSTRUCTION_SOURCES } from '../agents/utils/agent-instructions';
import {
  LessonOverrideSchema,
  ProjectInstructionBlockSchema,
} from '../projects/projects.types';
import type { ProjectBlockInput } from '../projects/utils/project-instruction-blocks';
import {
  AgentKindSchema,
  type ItemKind,
  NodeStatusSchema,
} from '../runs/runs.types';
import type { TeamDiff } from './utils/team-diff';
import type { TeamEdit } from './utils/team-edits';

/**
 * The team domain model. A team is a set of MEMBERS — CLI coding agents, each
 * with a public role every other member sees and private instructions only it
 * reads — plus the stages a run walks, instruction blocks addressed to an
 * audience, the one trigger that starts a run and the coordination mode. Any
 * member may call any other; nothing is wired. YAML files (`*.team.yaml`) are
 * the source of truth for these shapes; SQLite stores runtime/history only.
 *
 * Teams written before this model are node graphs (`LegacyTeamGraphSchema`
 * below); `teamFromLegacyGraph` converts them wherever one is read.
 */

/** Agent kinds a member may run — the runs domain's enum, so a member and a run row never drift. */
export const TEAM_AGENT_KINDS = AgentKindSchema.options;

/** A library team's slug — a plain file-name segment, so no path traversal is possible. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-_]*$/i;

/**
 * Per-member approval mode: `auto` lets the agent run its tools unattended;
 * `ask` routes tool-permission requests to the renderer as elicitation cards
 * and blocks the tool call until a verdict comes back; `acceptEdits`
 * auto-approves file edits on the CLI side and routes everything else to the
 * `ask` card path. `plan` is deliberately absent — it is chat-only
 * (CHAT_APPROVAL_MODES in v1/agents/chat.types.ts). NOTE: widening this enum
 * is a one-way door — narrowing it back silently drops saved YAML teams
 * carrying the removed value from the library listing (team-store skips
 * unparseable files).
 */
export const ApprovalModeSchema = z
  .enum(['auto', 'ask', 'acceptEdits'])
  .meta({ id: 'ApprovalMode' });
export type ApprovalMode = z.infer<typeof ApprovalModeSchema>;

/**
 * The refusal every member string that reaches a spawned CLI carries: a
 * NUL, and only a NUL.
 *
 * A member's text is not inert data: `instructions` and `character` become
 * claude's `--append-system-prompt` argv, `id`/`name`/`role` are written into
 * every other member's roster in that same argv, `model` and `effort` are argv
 * flags, and `configDir` is a child's ENV. Node.js refuses a NUL in any of them
 * SYNCHRONOUSLY at `spawn`, so one such character fails that member on every run
 * — and a team is a file that can be IMPORTED, so the text is not
 * necessarily written by the person who runs it.
 *
 * NUL rather than every C0 character (`CustomInstructionsSchema`'s rule, which
 * the instruction block keeps): this schema also READS what is already stored —
 * the library's YAML and every run's own team copy — so a wider rule turned a
 * role holding a pasted ESC or form-feed, which runs fine, into a team that
 * no longer loads and a run whose team answers 409.
 *
 * TWIN: `ARGV_TEXT_FIELDS` in the renderer's `teams/member-validate.ts`
 * flags the same fields in the editor, because the builder autosaves the whole
 * team in one PUT and a refused field would otherwise stop every later
 * edit from persisting. Add a field here, add it there.
 */
const NO_CONTROL_CHARACTERS = 'must not contain a NUL character';
function argvSafe(value: string): boolean {
  return !value.includes('\u0000');
}

/**
 * How many members a pool may hold BESIDES the member's own configuration.
 *
 * TWIN: `MAX_POOL_EXTRA_MEMBERS` in the renderer's
 * `teams/agent-pool-editor.tsx` stops offering a member past it — the
 * builder saves the whole team in one PUT, so a pool this refuses would
 * stop every later edit from saving. Change one, change the other.
 */
export const MAX_AGENT_POOL_EXTRA_MEMBERS = 7;

/**
 * How many MCP servers one member (or one pool member) may switch off, and how
 * long one server's name may be.
 *
 * TWIN: `MAX_MEMBER_MCP_DISABLED` / `MAX_MCP_SERVER_NAME_LENGTH` in the
 * renderer's `teams/member-validate.ts`, which flags a member past either
 * before the builder's whole-team PUT is refused. Change one, change the
 * other.
 */
export const MAX_MEMBER_MCP_DISABLED = 100;
export const MAX_MCP_SERVER_NAME_LENGTH = 256;

/**
 * A server name refuses EVERY control character, tab and newline included —
 * wider than the NUL-only rule above, because nothing stored predates the
 * field (so the wider rule breaks no existing team) and because each name
 * reaches a CLI as argv (`--disallowedTools mcp__<name>`), a config key
 * (`mcp_servers.<name>.enabled`) or a JSON file the CLI reads. A code-point
 * scan rather than a regex, on `hasControlCharacters`'s reasoning (eslint's
 * `no-control-regex`).
 *
 * TWIN: `mcpServerNameProblem` in the renderer's `teams/member-validate.ts`.
 */
function mcpServerNameIsClean(name: string): boolean {
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/**
 * The MCP servers this member's (or this pool member's) turns run WITHOUT, by the
 * name the CLI lists them under.
 *
 * Applied per TURN by the member's own CLI (`AgentTurnInput.mcpDisabled`) and
 * written into no config file of the CLI's: it changes nothing outside this
 * member's turns. A name the CLI does not load at run time is simply ignored, so
 * a profile that later drops a server leaves the team runnable.
 */
const McpDisabledSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(MAX_MCP_SERVER_NAME_LENGTH)
      .refine(mcpServerNameIsClean, 'must not contain control characters'),
  )
  .max(MAX_MEMBER_MCP_DISABLED);

/**
 * One more configuration a member can run a turn under — a pool member
 * after the member's own (which is member 1).
 *
 * It carries every setting a turn RUNS with, and REPLACES them whole rather
 * than overriding member 1's: an omitted `model` means this member's CLI
 * default, never member 1's model, which another CLI would not recognise, and
 * an omitted `autoCompactPercent` means this member never compacts. The one
 * exception is `approval`, which the member REQUIRES — omitted, the pool member
 * runs the member's own mode. What the member says about itself — `name`,
 * `role`, `instructions`, `character` — is shared by every pool member.
 */
export const TeamAgentPoolMemberSchema = z
  .object({
    agent: AgentKindSchema.describe('CLI agent this member runs'),
    approval: ApprovalModeSchema.optional().describe(
      "Tool-approval mode for this member; omitted = the member's own",
    ),
    autoCompactPercent: AutoCompactPercentSchema.optional().describe(
      'Auto-compact threshold (% of the context window); omitted = never',
    ),
    model: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('Model alias; omitted = CLI default'),
    effort: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('Reasoning-effort level; omitted = CLI default'),
    contextWindow: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe("Context-window size; omitted = the model's own default"),
    modelParameters: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults",
      ),
    configDir: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe(
        'Absolute path to the agent config directory this member runs under',
      ),
    mcpDisabled: McpDisabledSchema.optional().describe(
      'MCP servers this member’s turns run without, by name; omitted = none switched off',
    ),
  })
  .meta({ id: 'TeamAgentPoolMember' });

/**
 * How a team coordinates: `lead` — the trigger's member runs the work and
 * calls the others; `relay` — each stage is run by its responsible member and
 * handed on to the next.
 */
export const TEAM_MODES = ['lead', 'relay'] as const;
export const TeamModeSchema = z.enum(TEAM_MODES).meta({ id: 'TeamMode' });
export type TeamMode = z.infer<typeof TeamModeSchema>;

/** TWIN: the member limits in apps/ui/src/renderer/teams/member-validate.ts. */
export const MAX_MEMBER_NAME_LENGTH = 80;
export const MAX_MEMBER_CHARACTER_LENGTH = 2000;
export const MAX_INSTRUCTION_BLOCK_TITLE_LENGTH = 80;
export const MAX_AVATAR_VALUE_LENGTH = 512;

export const MEMBER_AVATAR_KINDS = ['initials', 'emoji', 'picture'] as const;

/** How a member is drawn — display data only, never part of a prompt. */
export const MemberAvatarSchema = z
  .object({
    kind: z.enum(MEMBER_AVATAR_KINDS),
    value: z
      .string()
      .max(MAX_AVATAR_VALUE_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('The initials, the emoji, or the stored picture’s id'),
    tone: z
      .string()
      .max(40)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('Colour token the avatar is drawn in'),
  })
  .meta({ id: 'MemberAvatar' });
export type MemberAvatar = z.infer<typeof MemberAvatarSchema>;

/** The most a member's uploaded picture may weigh, in bytes. */
export const MAX_AVATAR_BYTES = 1_048_576;

/** How many members a library card's portrait row draws. */
export const TEAM_PORTRAIT_SIZE = 6;

const memberSettingsShape = {
  agent: AgentKindSchema.describe('CLI agent this member runs'),
  model: z
    .string()
    .min(1)
    .refine(argvSafe, NO_CONTROL_CHARACTERS)
    .optional()
    .describe('Model alias; omitted = CLI default'),
  /**
   * How hard this member's CLI is asked to think, in that CLI's own vocabulary
   * (`AgentAdapter.listEfforts`) — never an enum here, for the same reason
   * `model` is a free string: the levels belong to the CLI, and a CLI that
   * gains one must not need an app release to offer it.
   *
   * A level the member's CLI does not list is DROPPED at run start with a
   * system item naming it, exactly as an unusable `configDir` is: the two
   * fail the same way (a team arriving as YAML carries a value the
   * builder never had a chance to refuse) and the cost of passing it through
   * differs per CLI — claude warns and runs on its default, cursor answers
   * `-32602` and the turn is lost.
   */
  effort: z
    .string()
    .min(1)
    .refine(argvSafe, NO_CONTROL_CHARACTERS)
    .optional()
    .describe('Reasoning-effort level; omitted = CLI default'),
  /**
   * Which of the model's context-window sizes this member's turns run at, in
   * the CLI's own vocabulary (`300k`, `1m`); omitted = the model's own
   * default.
   *
   * Beside `effort` because it is the same kind of thing — a per-MODEL
   * parameter the adapter owns the vocabulary of — and it fails the same way:
   * a size the member's model does not offer is answered `-32602` by cursor,
   * so the turn's own driver reports it on the transcript rather than a
   * constant here refusing it at save time. A team runs for months and
   * its model's sizes can change under it, which is exactly why the check
   * belongs against the live agent.
   */
  contextWindow: z
    .string()
    .min(1)
    .refine(argvSafe, NO_CONTROL_CHARACTERS)
    .optional()
    .describe("Context-window size; omitted = the model's own default"),
  /**
   * Compact this member's conversation right after a turn that left its
   * context at or above this percentage of the window; omitted = never.
   * Performed by the executor inside the unit that still owns the member's (or
   * the call's) session, before the turn settles — so a follow-up is refused
   * meanwhile and a caller's result waits for it. See
   * `TeamExecutorService`'s `compactIfDue` and `Run.autoCompactPercent`.
   */
  autoCompactPercent: AutoCompactPercentSchema.optional().describe(
    'Auto-compact threshold (% of the context window); omitted = never',
  ),
  /**
   * Every OTHER model setting this member's turns ask for, keyed by the CLI's
   * own parameter id (`{optimize_for: 'intelligence'}`).
   *
   * Unchecked here for the reason the window above is, taken further: geniro
   * holds no vocabulary for these at all — the model enumerates them and the
   * live agent refuses a value it does not accept, per turn, which is the
   * only check that stays true for a team that runs for months.
   */
  modelParameters: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Other model settings, keyed by the CLI's own parameter id; omitted = the model's own defaults",
    ),
  approval: ApprovalModeSchema.describe('Tool-approval mode for this member'),
  /**
   * The agent config directory this member's turns run under, and no other
   * member's — the folder holding that CLI's credentials, settings, installed
   * plugins and history.
   *
   * A MEMBER field rather than a run-level one because that is what it buys:
   * two members of one team can run as different ACCOUNTS (two subscriptions,
   * two rate limits) with different tools, and neither touches the user's
   * default profile.
   *
   * Absolute path, validated before it reaches the child's env. Existence is
   * checked because the CLI will not check it: claude CREATES whatever
   * directory it is handed and reports "Not logged in" (probe-verified on
   * 2.1.227), so a typo would otherwise fail the member with a login error
   * about a profile nobody meant to name.
   */
  configDir: z
    .string()
    .min(1)
    .refine(argvSafe, NO_CONTROL_CHARACTERS)
    .optional()
    .describe(
      'Absolute path to the agent config directory this member runs under',
    ),
  /**
   * The MCP servers this member's turns run WITHOUT — the member's own switches
   * over the servers its profile loads (see {@link McpDisabledSchema}). A
   * MEMBER field: each pool member carries its own list, since a member is a
   * different profile as often as a different CLI.
   */
  mcpDisabled: McpDisabledSchema.optional().describe(
    'MCP servers this member’s turns run without, by name; omitted = none switched off',
  ),
  /**
   * The member's AGENT POOL: further configurations a turn of this member may run
   * under — another account, another model, another CLI. The fields above are
   * member 1 and these are members 2, 3, … in order.
   *
   * A call that opens a new conversation uses member 1 first, trying later
   * members in priority order when earlier ones are unavailable or fail on a
   * usage limit, a lapsed sign-in, or before doing any work. A caller may
   * also pin a member at the user's request. A continued thread starts on
   * the member holding its latest session; fallback carries its original
   * task and recent conversation into a fresh session. The member's own
   * conversation — including a trigger-fed root — also falls through the pool and continues on the
   * member that answered. A hand-off opens a fresh CLI session with the
   * recent team transcript and keeps the member's outstanding calls.
   * See `utils/agent-pool.ts`.
   */
  pool: z
    .array(TeamAgentPoolMemberSchema)
    .max(MAX_AGENT_POOL_EXTRA_MEMBERS)
    .optional()
    .describe(
      'Further agent configurations a turn of this member can run under (members 2, 3, …); the member’s own settings are member 1',
    ),
};

/** One member of a team — a CLI coding agent and how it presents itself. */
export const TeamMemberSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('Unique member id within the team'),
    name: z
      .string()
      .min(1)
      .max(MAX_MEMBER_NAME_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('Display name, and how other members address it'),
    character: z
      .string()
      .max(MAX_MEMBER_CHARACTER_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('Manner and tone; only this member’s own prompt carries it'),
    avatar: MemberAvatarSchema.optional(),
    /**
     * The member's PUBLIC role: what it does, written for the members that
     * may call it. It is the only thing another member is told about it (see
     * `calleeSummary`).
     */
    role: z
      .string()
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('What this member does — shown to every other member'),
    /**
     * The member's PRIVATE instructions, prepended to its own turns and never
     * shown to another member: how it works is its own business.
     */
    instructions: z
      .string()
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('How this member works — only its own turns carry it'),
    ...memberSettingsShape,
  })
  .meta({ id: 'TeamMember' });

export const TEAM_TRIGGER_KINDS = ['first-message'] as const;

/** What starts a run: the user's first message, handled by `member`. */
export const TeamTriggerSchema = z
  .object({
    kind: z.enum(TEAM_TRIGGER_KINDS),
    member: z
      .string()
      .min(1)
      .describe('Id of the member that handles the first message'),
  })
  .meta({ id: 'TeamTrigger' });

export const INSTRUCTION_BLOCK_EVERYONE = 'everyone';

/**
 * Free text composed into the turns of its audience: every member, or the
 * members it names. It runs nothing and orders nothing.
 */
export const InstructionBlockSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('Unique block id within the team'),
    title: z
      .string()
      .max(MAX_INSTRUCTION_BLOCK_TITLE_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('Short name shown in the editor'),
    /**
     * Control-character-free through the schema the user's own custom
     * instructions use: it reaches the same composed block, and a team is a
     * file that can be imported. The empty string is admitted so a block just
     * added can be saved; the editor flags it.
     */
    text: CustomInstructionsSchema.describe(
      'Instruction text composed into every audience member’s turns',
    ),
    audience: z
      .union([
        z.literal(INSTRUCTION_BLOCK_EVERYONE),
        z.array(z.string().min(1)),
      ])
      .describe("'everyone', or the ids of the members it applies to"),
  })
  .meta({ id: 'InstructionBlock' });

/** TWIN: the stage limits in apps/ui/src/renderer/teams/stage-validate.ts. */
export const MAX_TEAM_STAGES = 20;
export const MAX_STAGE_TITLE_LENGTH = 80;
export const MAX_STAGE_INSTRUCTIONS_LENGTH = 4000;
export const MAX_STAGE_DONE_WHEN_LENGTH = 300;

export const STAGE_ID_PATTERN = /^(?![0-9]+$)[a-z0-9][a-z0-9-]{0,39}$/;

export const TeamStageSchema = z
  .object({
    id: z
      .string()
      .regex(STAGE_ID_PATTERN)
      .describe(
        "Stable stage id: lowercase letters, digits and '-', at most 40 characters, never all digits (e.g. 'investigation')",
      ),
    title: z
      .string()
      .regex(/\S/)
      .max(MAX_STAGE_TITLE_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('Short stage name shown to members and the user'),
    howToWork: z
      .string()
      .max(MAX_STAGE_INSTRUCTIONS_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('How to work in this stage, in plain language'),
    goal: z
      .string()
      .regex(/\S/)
      .max(MAX_STAGE_DONE_WHEN_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .describe('The condition that makes this stage done'),
    requireGoals: z
      .boolean()
      .optional()
      .describe(
        'When true, the stage cannot be completed until the run has recorded its goals with the goals tool',
      ),
    responsible: z
      .array(z.string().min(1).refine(argvSafe, NO_CONTROL_CHARACTERS))
      .optional()
      .describe(
        'Ids of the members responsible for this stage; the first one leads it',
      ),
    next: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Ids of the stages that may follow; two or more = the run takes ONE of them; omitted = a final stage',
      ),
  })
  .meta({ id: 'TeamStage' });

/**
 * A complete team definition — the `*.team.yaml` shape and the HTTP wire
 * shape alike.
 *
 * Deliberately DEFAULT-FREE: a zod `.default()` makes a field optional on the
 * way in and required on the way out, so the schema would render as two
 * OpenAPI components and the generated client would carry two incompatible
 * `Team` types. Leniency for hand-written YAML lives in {@link TeamYamlSchema}.
 */
export const TeamSchema = z
  .object({
    name: z.string().min(1).describe('Human-readable team name'),
    description: z.string().optional(),
    /**
     * How many callee turns of one run may be working at once, at every call
     * depth. Omitted = the machine's ceiling (`CapabilitiesWire`'s
     * `maxActiveTurnsCeiling`); a value above it runs at the ceiling.
     */
    maxActiveTurns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Cap on callee turns working at once across the run; omitted = the machine ceiling',
      ),
    mode: TeamModeSchema.describe(
      "How the team coordinates: 'lead' (the trigger's member runs the work) or 'relay' (stages pass between their responsible members)",
    ),
    members: z.array(TeamMemberSchema),
    triggers: z
      .array(TeamTriggerSchema)
      .describe('What starts a run — exactly one, the first message'),
    instructionBlocks: z.array(InstructionBlockSchema),
    stages: z
      .array(TeamStageSchema)
      .optional()
      .describe(
        "The team's stage graph: the steps every run walks, in order, e.g. investigation → implementation | fix → review. Every member of a run sees it and moves it with move_stage. Omitted = the team has no stages",
      ),
    lessons: LessonOverrideSchema.optional().describe(
      "Whether this team's runs are offered lessons reflections; omitted = inherit the project's and the app's setting. The app's Off always wins",
    ),
  })
  .meta({ id: 'Team' });

/**
 * {@link TeamSchema} with the omissible-in-YAML fields defaulted — the one
 * schema `parseTeamYaml` reads files through. Derived from the strict schemas,
 * so a field added above is accepted here too.
 */
export const TeamYamlSchema = TeamSchema.extend({
  mode: TeamModeSchema.default('lead'),
  members: z
    .array(
      TeamMemberSchema.extend({
        approval: ApprovalModeSchema.default('auto'),
      }),
    )
    .default([]),
  triggers: z.array(TeamTriggerSchema).default([]),
  instructionBlocks: z
    .array(
      InstructionBlockSchema.extend({
        // `nullish`, not `.default()`: a hand-written `text:` with nothing
        // after it parses as NULL, which a default never fires for.
        text: CustomInstructionsSchema.nullish().transform(
          (value) => value ?? '',
        ),
        audience: InstructionBlockSchema.shape.audience.default(
          INSTRUCTION_BLOCK_EVERYONE,
        ),
      }),
    )
    .default([]),
});

/**
 * What a project may set for every member of one agent kind: the Model group
 * of {@link memberSettingsShape} without `agent`, `mcpDisabled` and `pool`.
 */
export const TeamOverlayAgentDefaultsSchema = z
  .object({
    model: memberSettingsShape.model,
    effort: memberSettingsShape.effort,
    contextWindow: memberSettingsShape.contextWindow,
    modelParameters: memberSettingsShape.modelParameters,
    autoCompactPercent: memberSettingsShape.autoCompactPercent,
    approval: ApprovalModeSchema.optional().describe(
      'Tool-approval mode; omitted = the team’s',
    ),
    configDir: memberSettingsShape.configDir,
  })
  .meta({ id: 'TeamOverlayAgentDefaults' });
export type TeamOverlayAgentDefaults = z.infer<
  typeof TeamOverlayAgentDefaultsSchema
>;

/**
 * One member's Model-group override in a project. Setting `agent` replaces the
 * whole group: a key it leaves unset takes that CLI's default, never the
 * team's value for another CLI.
 */
export const TeamOverlayMemberSettingsSchema =
  TeamOverlayAgentDefaultsSchema.extend({
    agent: AgentKindSchema.optional().describe(
      'CLI agent this member runs in the project; omitted = the team’s',
    ),
  }).meta({ id: 'TeamOverlayMemberSettings' });
export type TeamOverlayMemberSettings = z.infer<
  typeof TeamOverlayMemberSettingsSchema
>;

export const MAX_OVERLAY_EXTRA_INSTRUCTIONS_LENGTH = 20_000;

export const TeamOverlayMemberSchema = z
  .object({
    settings: TeamOverlayMemberSettingsSchema.optional(),
    extraInstructions: z
      .string()
      .max(MAX_OVERLAY_EXTRA_INSTRUCTIONS_LENGTH)
      .refine(argvSafe, NO_CONTROL_CHARACTERS)
      .optional()
      .describe('Appended to the member’s own instructions in this project'),
    pool: z
      .array(TeamAgentPoolMemberSchema)
      .max(MAX_AGENT_POOL_EXTRA_MEMBERS)
      .optional()
      .describe(
        'Replaces the member’s whole pool (members 2, 3, …) in this project; [] = no pool; omitted = the team’s pool',
      ),
    mcpDisabled: McpDisabledSchema.optional().describe(
      'Replaces the member’s own MCP switches in this project: the servers it runs without; [] = none off; omitted = the team’s',
    ),
  })
  .meta({ id: 'TeamOverlayMember' });
export type TeamOverlayMember = z.infer<typeof TeamOverlayMemberSchema>;

/**
 * What one project changes about a shared team it defaults to — the
 * `<userData>/teams/overlays/<slug>/<projectId>.overlay.yaml` shape and its
 * wire shape. Only listed keys override; members, stages' structure,
 * triggers, mode, identity stay the team's.
 */
export const TeamOverlaySchema = z
  .object({
    allMembers: z
      .partialRecord(AgentKindSchema, TeamOverlayAgentDefaultsSchema)
      .optional()
      .describe('Defaults for every member (and pool member) of one CLI'),
    members: z
      .record(z.string().min(1), TeamOverlayMemberSchema)
      .optional()
      .describe('Per-member overrides, keyed by member id'),
    instructionBlocks: z
      .array(InstructionBlockSchema)
      .optional()
      .describe('Team-scoped blocks for this project, after the team’s own'),
  })
  .meta({ id: 'TeamOverlay' });
export type TeamOverlay = z.infer<typeof TeamOverlaySchema>;

/** `Run.teamOverlaySnapshot`: the overlay a run started with, when its project's default team was its team. */
export const TeamOverlaySnapshotSchema = z.object({
  projectId: z.string(),
  hash: z.string(),
  overlay: TeamOverlaySchema,
});
export type TeamOverlaySnapshot = z.infer<typeof TeamOverlaySnapshotSchema>;

/** One project's overlay of one team, as stored. */
export const TeamOverlayWireSchema = z.object({
  slug: z.string(),
  projectId: z.string(),
  overlay: TeamOverlaySchema,
  hash: z
    .string()
    .nullable()
    .describe(
      "The file's version as stored, sent back as a save's `baseHash`; null when the project has no overlay file yet",
    ),
  orphans: z
    .array(z.string())
    .describe(
      'Overlay entries naming a member or stage the team no longer has, e.g. `members.reviewer`',
    ),
});
export type TeamOverlayWire = z.infer<typeof TeamOverlayWireSchema>;

/** A project in a team's scope list: it defaults to the team, or still holds an overlay of it. */
export const TeamOverlayScopeSchema = z
  .object({
    projectId: z.string(),
    projectName: z.string(),
    active: z
      .boolean()
      .describe(
        "True while the project's default team is this team — only then does a run apply the overlay",
      ),
    defaultTeamSlug: z
      .string()
      .nullable()
      .describe('The team the project defaults to now; null for an agent'),
    defaultTeamName: z.string().nullable(),
    hasOverlay: z.boolean(),
    hash: z.string().nullable(),
    overrides: z
      .number()
      .int()
      .describe('Model-group fields and pools the overlay overrides'),
    blocks: z.number().int().describe('Overlay instruction blocks'),
    notes: z.number().int().describe('Members with extra instructions'),
    orphans: z.array(z.string()),
    unreadable: z
      .string()
      .nullable()
      .describe('Why the overlay file could not be read; null when it reads'),
  })
  .meta({ id: 'TeamOverlayScope' });
export type TeamOverlayScope = z.infer<typeof TeamOverlayScopeSchema>;

export const TeamOverlayScopesSchema = z.object({
  scopes: z.array(TeamOverlayScopeSchema),
});

/** One team's overlay a project holds: the project's default team's (active), or another team's it kept (inactive). */
export const ProjectTeamOverlaySchema = TeamOverlayScopeSchema.extend({
  slug: z.string(),
  teamName: z.string(),
}).meta({ id: 'ProjectTeamOverlay' });
export type ProjectTeamOverlay = z.infer<typeof ProjectTeamOverlaySchema>;

export const ProjectTeamOverlaysSchema = z.object({
  overlays: z.array(ProjectTeamOverlaySchema),
});

export const SaveTeamOverlaySchema = z.object({
  overlay: TeamOverlaySchema,
  baseHash: z
    .string()
    .nullable()
    .optional()
    .describe(
      'The hash the overlay was read at (null = there was no file); a newer file refuses the save TEAM_OVERLAY_CHANGED',
    ),
});

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamAgentPoolMember = z.infer<typeof TeamAgentPoolMemberSchema>;
export type TeamTrigger = z.infer<typeof TeamTriggerSchema>;
export type InstructionBlock = z.infer<typeof InstructionBlockSchema>;
export type TeamStage = z.infer<typeof TeamStageSchema>;
export type Team = z.infer<typeof TeamSchema>;

/**
 * The node graph every team was before members (milestone 3 of GEN-248):
 * agent, trigger and instruction nodes joined by `data`, `call` and
 * `instruction` edges. Read only — through `teamFromLegacyGraph` — wherever a
 * team written then is still read: library files before migration 0005, run
 * snapshots, recorded versions, standing proposal cards and imports.
 */
const legacyNodeBase = {
  id: z.string().min(1).refine(argvSafe, NO_CONTROL_CHARACTERS),
  name: z.string().min(1).refine(argvSafe, NO_CONTROL_CHARACTERS).optional(),
};

export const LegacyAgentNodeSchema = z.object({
  ...legacyNodeBase,
  kind: z.literal('agent'),
  ...memberSettingsShape,
  approval: ApprovalModeSchema.default('auto'),
  description: z.string().refine(argvSafe, NO_CONTROL_CHARACTERS).optional(),
  role: z.string().refine(argvSafe, NO_CONTROL_CHARACTERS).optional(),
});

export const LegacyTriggerNodeSchema = z.object({
  ...legacyNodeBase,
  kind: z.literal('trigger'),
  trigger: z.literal('manual').default('manual'),
});

export const LegacyInstructionNodeSchema = z.object({
  ...legacyNodeBase,
  kind: z.literal('instruction'),
  instructions: CustomInstructionsSchema.nullish().transform(
    (value) => value ?? '',
  ),
});

export const LegacyStageSchema = z.object({
  id: z.string().regex(STAGE_ID_PATTERN),
  title: z.string().regex(/\S/).max(MAX_STAGE_TITLE_LENGTH),
  instructions: z.string().max(MAX_STAGE_INSTRUCTIONS_LENGTH).optional(),
  doneWhen: z.string().regex(/\S/).max(MAX_STAGE_DONE_WHEN_LENGTH),
  ownerHint: z.string().min(1).optional(),
  next: z.array(z.string().min(1)).optional(),
});

export const LegacyTeamGraphSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  maxActiveTurns: z.number().int().min(1).optional(),
  nodes: z
    .array(
      z.discriminatedUnion('kind', [
        LegacyAgentNodeSchema,
        LegacyTriggerNodeSchema,
        LegacyInstructionNodeSchema,
      ]),
    )
    .default([]),
  edges: z
    .array(
      z.object({
        from: z.string().min(1),
        to: z.string().min(1),
        kind: z.enum(['data', 'call', 'instruction']),
        label: z.string().optional(),
      }),
    )
    .default([]),
  layout: z.unknown().optional(),
  stages: z.array(LegacyStageSchema).optional(),
});

export type LegacyTeamGraph = z.infer<typeof LegacyTeamGraphSchema>;
export type LegacyAgentNode = z.infer<typeof LegacyAgentNodeSchema>;
export type LegacyStage = z.infer<typeof LegacyStageSchema>;

/**
 * A team as listed over the wire: `slug` is the library file name without
 * the `.team.yaml` suffix and is the stable id the UI runs/edits by. The
 * counts feed the library cards (members, stages and the per-agent-kind
 * breakdown) so the renderer never has to fetch every full definition to draw
 * the list.
 */
export const TeamSummarySchema = z.object({
  slug: z.string().describe('Library file name without the .team.yaml suffix'),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int(),
  stageCount: z.number().int(),
  /**
   * Per-agent-kind member counts — only kinds actually present, ordered by
   * `TEAM_AGENT_KINDS` so the card badges keep a stable order.
   */
  agentCounts: z
    .array(
      z
        .object({ kind: AgentKindSchema, count: z.number().int() })
        .meta({ id: 'AgentCount' }),
    )
    .describe('Per-agent-kind member counts, only kinds present, stable order'),
  portrait: z
    .array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          avatar: MemberAvatarSchema.optional(),
        })
        .meta({ id: 'TeamPortraitMember' }),
    )
    .describe('The first members in team order, drawn on the library card'),
  updatedAt: z.string(),
});
export type TeamSummary = z.infer<typeof TeamSummarySchema>;

export const TeamAvatarUploadSchema = z.object({
  data: z
    .string()
    .min(1)
    .max(Math.ceil(MAX_AVATAR_BYTES / 3) * 4)
    .describe('The picture’s bytes, base64-encoded'),
});

export const TeamAvatarIdSchema = z.object({
  id: z.string().describe('The stored file id, `<sha256>.<ext>`'),
});

export const TeamAvatarDataSchema = z.object({
  dataUri: z.string().describe('`data:<mediaType>;base64,<bytes>`'),
});

/** One team definition addressed by its library slug. */
export const TeamWireSchema = z.object({
  slug: z.string(),
  team: TeamSchema,
  hash: z
    .string()
    .describe(
      "The file's version as stored — send it back as a save's `baseHash` so a save over a newer file is refused",
    ),
});
export type TeamWire = z.infer<typeof TeamWireSchema>;

/** How long an agent's one-line `summary` for a proposal card may be. */
export const TEAM_SUMMARY_MAX = 200;

/** How long an agent's `reason` for a proposal card may be. */
export const TEAM_REASON_MAX = 1000;

/** The overlay half of a builder chat's card: the whole new document, pinned to the file's version. */
export const TeamProposalOverlaySchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  overlay: TeamOverlaySchema,
  /** The overlay file's hash when the card was raised; null = there was no file. */
  baseHash: z.string().nullable(),
  /** Unified diff of the overlay YAML, before → after. */
  diffText: z.string(),
});
export type TeamProposalOverlay = z.infer<typeof TeamProposalOverlaySchema>;

/**
 * The project half of a builder chat's card: a project that runs the team by
 * default, its instruction blocks as the same approval writes them, pinned to
 * the revision they were read at — so text moves between the team and the
 * project in one change, never in two the user approves apart.
 */
export const TeamProposalProjectSchema = z.object({
  projectId: z.string(),
  projectName: z.string(),
  blocks: z.array(ProjectInstructionBlockSchema),
  baseRevision: z.number().int().min(0),
  /** Unified diff of the blocks under their titles, before → after. */
  diffText: z.string(),
});
export type TeamProposalProject = z.infer<typeof TeamProposalProjectSchema>;

const TeamProposalBaseSchema = z.object({
  team: TeamSchema,
  /** The library file the approval writes, fixed when the card was raised. */
  slug: z.string(),
  /** The agent's one line for the card — its own words, never trusted. */
  summary: z.string().optional(),
  /** Why the agent proposes it, for the card — its own words, never trusted. */
  reason: z.string().optional(),
  /** The recommendations an Apply selected that this card carries out, checked when it was raised. */
  recommendationIds: z.array(z.string()).optional(),
  /** The analysis card those ids are on. */
  recommendationCardSeq: z.number().int().min(0).optional(),
  /**
   * Every agent that would run tools without asking — `approval: 'auto'` only,
   * a pool member's own or inherited; an `acceptEdits` agent, which edits files
   * unasked but asks for the rest, is not listed — as the card names it,
   * worked out by the daemon from `team` because the agent's own summary
   * may leave one out.
   */
  autoAgents: z.array(z.string()),
});

/**
 * One `propose_team` card: the `input` of its `approval_request` row and,
 * with the card's id, what `Run.pendingTeamProposal` holds so the card
 * outlives a restart.
 *
 * A replacement quotes the hash the file was read at, so an approval pressed
 * after the file changed is refused rather than written over the newer copy.
 *
 * TWIN PARSER: `readTeamProposal` in
 * `apps/ui/src/renderer/chats/team-proposal-payload.ts`.
 */
export const TeamProposalSchema = z.discriminatedUnion('mode', [
  TeamProposalBaseSchema.extend({ mode: z.literal('create') }),
  TeamProposalBaseSchema.extend({
    mode: z.literal('replace'),
    replacesName: z.string(),
    baseHash: z.string(),
    diff: z.custom<TeamDiff>(
      (value) => typeof value === 'object' && value !== null,
    ),
    /** The bound project's overlay the same approval writes, before the team. */
    overlay: TeamProposalOverlaySchema.optional(),
    /** A project's instructions the same approval writes, before the team. */
    project: TeamProposalProjectSchema.optional(),
  }),
]);
export type TeamProposal = z.infer<typeof TeamProposalSchema>;

/** What an agent sends `propose_team`. */
export interface TeamProposalRequest {
  team: unknown;
  /** The library slug this proposal replaces; absent for a new team. */
  replaces?: string;
  summary?: string;
  reason?: string;
}

/**
 * A chat's change to a library team on `propose_team`: edits to the file as it
 * stands, never the whole team, with what the same approval writes beside it.
 */
export interface TeamChangeProposalRequest {
  slug: string;
  edits: TeamEdit[];
  /** The whole overlay document of `projectId`, as the agent sends it. */
  overlay?: unknown;
  /** The project `overlay` belongs to, which must default to this team. */
  projectId?: string | null;
  /** A change to the instructions of a project that runs this team by default. */
  project?: {
    projectId: string;
    blocks: ProjectBlockInput[];
    baseRevision: number;
  };
  recommendationIds?: string[];
  summary?: string;
  reason?: string;
}

export type TeamEditsProposalRequest = TeamChangeProposalRequest & {
  summary: string;
  reason: string;
};

/** A chat's change to one project's overlay of its default team, whichever team that is. */
export interface TeamOverlayProposalRequest {
  projectId: string;
  overlay: unknown;
  recommendationIds?: string[];
  summary: string;
  reason: string;
}

/** What `propose_team` tells the agent. */
export type ProposalOutcome =
  | { status: 'shown'; proposal: TeamProposal }
  | { status: 'refused'; code: string; message: string };

/** `Run.pendingTeamProposal`: the standing card and what it proposes. */
export const PendingTeamProposalSchema = PendingOwnedCardSchema.extend({
  proposal: TeamProposalSchema,
});
export type PendingTeamProposal = z.infer<typeof PendingTeamProposalSchema>;

/**
 * Who wrote a change to a library team, as its change log names it: an
 * analysis's applied recommendations, an approved card in the team's
 * builder chat or in another chat, a recorded version written back, the
 * conversion of a node graph into a team (the first version run after it), or
 * a lesson the user saved into a member's instructions.
 */
export const TEAM_CHANGE_SOURCES = [
  'analysis',
  'builder',
  'chat',
  'restore',
  'migration',
  'lesson',
] as const;
export type TeamChangeSource = (typeof TEAM_CHANGE_SOURCES)[number];

/** One write to a team as the change log records it (`TeamChangeLogEntry`). */
export interface TeamChangeLogRecord {
  slug: string;
  projectId: string | null;
  changedAt: Date;
  source: TeamChangeSource;
  fromVersion: string | null;
  toVersion: string;
  summary: string | null;
  reason: string | null;
  userNote: string | null;
  recommendationIds: string[];
  chatRunId: string | null;
  cardSeq: number | null;
  backup: string | null;
}

/** Where one team's file sits on disk (`TeamStoreService.locate`). */
export interface TeamLocation {
  /** The library directory — what an editing agent is given as its cwd. */
  directory: string;
  /** The `*.team.yaml` file itself, absolute. */
  path: string;
}

/**
 * The composer settings a team-editing chat is opened with — every chip
 * the builder's panel offers, and nothing that decides WHERE the agent works.
 *
 * PICKED from the chat-create schema rather than restated: these fields are
 * the same fields, each already carrying its own bound and the reasoning for
 * it, and a second spelling is how the two routes would come to disagree about
 * what a valid effort or config directory is. `cwd` is deliberately not among
 * them — the daemon owns it, because the whole point is that the agent is put
 * where the team library lives.
 */
const chatChipsSchema = createChatSchema.pick({
  agentKind: true,
  model: true,
  approval: true,
  effort: true,
  contextWindow: true,
  autoCompactPercent: true,
  modelParameters: true,
  configDir: true,
  customInstructions: true,
  replyLanguage: true,
  agentOptions: true,
});

export const StartTeamChatSchema = chatChipsSchema.meta({
  id: 'StartTeamChat',
});
export type StartTeamChatInput = z.infer<typeof StartTeamChatSchema>;

/** The composer settings a project page's chat panel opens its conversation with. */
export const StartProjectChatSchema = chatChipsSchema.meta({
  id: 'StartProjectChat',
});
export type StartProjectChatInput = z.infer<typeof StartProjectChatSchema>;

/** How many of a project's own chats a discard destroyed. */
export const ProjectChatsDiscardedSchema = z.object({
  deleted: z.number().int(),
});

/** How many team-editing chats a discard actually destroyed. */
export const TeamChatsDiscardedSchema = z.object({
  deleted: z.number().int(),
});
export type TeamChatsDiscarded = z.infer<typeof TeamChatsDiscardedSchema>;

/**
 * The team ONE RUN runs — the copy it keeps (`Run.teamSnapshot`), never
 * the library's current one, so an edit made after the run started reaches
 * neither its agents panel nor a follow-up message.
 */
export const RunTeamSnapshotWireSchema = z.object({
  team: TeamSchema,
});
export type RunTeamSnapshotWire = z.infer<typeof RunTeamSnapshotWireSchema>;

/**
 * How much of a call's brief the nodes route repeats. The route is re-read on
 * every settled turn and lists up to 500 calls, so a whole brief each is a
 * payload measured in megabytes; a card draws the brief's first lines.
 */
export const CALL_START_BRIEF_MAX = 2_000;

/** One call's clock as the daemon folded it — `CallClock` in `utils/call-clock.ts`. */
export const CallClockWireSchema = z
  .object({
    closedMs: z.number(),
    runningSince: z.number().nullable(),
    parkedMs: z.number(),
    parkedSince: z.number().nullable(),
    openCards: z.array(z.string()),
    throughSeq: z.number().int(),
  })
  .meta({ id: 'CallClock' });

/** Per-member execution state projected to the wire (from `node_state` rows). */
export const NodeStateWireSchema = z.object({
  runId: z.string(),
  memberId: z.string(),
  status: NodeStatusSchema,
  /**
   * The member's last context reading and the window it was measured against —
   * what a client with no live plane draws its ring from. Null while the member
   * has reported none.
   */
  contextTokens: z.number().nullable(),
  contextEstimated: z
    .boolean()
    .describe(
      "Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it",
    ),
  contextWindowTokens: z.number().nullable(),
  /**
   * The model the member's newest turn reported running on (`usage.contextModel`
   * over the whole run) — what its card names when the client's window holds
   * none of its turns. Null while no turn has named one.
   */
  model: z.string().nullable(),
  /**
   * The same reading per agent-to-agent CALL this member ran (from `call_context`
   * rows). The member figures above collapse to whichever call wrote last, so a
   * member called several times needs these to draw one ring per call thread
   * rather than one flickering between windows.
   *
   * CAPPED at the newest `CALL_CONTEXT_SNAPSHOT_LIMIT` calls of the run: it
   * carries the heavy parts (the start brief). A call's FIGURES are never
   * here — they are in the uncapped {@link callFigures}.
   *
   * Nested, so it carries a `.meta({ id })` of its own to land as a named
   * component, exactly as `AgentCount` above does.
   */
  calls: z.array(
    z
      .object({
        callId: z.string(),
        contextTokens: z.number().nullable(),
        contextEstimated: z
          .boolean()
          .describe(
            "Whether contextTokens is geniro's stand-in for an occupancy the CLI did not state; false when the CLI stated it",
          ),
        contextWindowTokens: z.number().nullable(),
        /**
         * What the call's `call_started` row said — who asked, the title, the
         * brief (capped at {@link CALL_START_BRIEF_MAX} characters) and the
         * thread it continued. A client whose loaded window starts after that
         * row rebuilds the call's card from its later rows, and without this
         * the card carried no caller and no title. Null when the run holds no
         * start row for the call.
         */
        start: z
          .object({
            callerMemberId: z.string().nullable(),
            title: z.string().nullable(),
            message: z.string().nullable(),
            mode: z.string().nullable(),
            thread: z.string().nullable(),
            /**
             * When the call STARTED, epoch ms — what a client times a running
             * call from when its start row is older than the loaded window.
             */
            startedAt: z.number().nullable(),
          })
          .meta({ id: 'CallStartReading' })
          .nullable(),
      })
      .meta({ id: 'CallContextReading' }),
  ),
  /**
   * EVERY call this member ran, with what the daemon measured of it over the
   * whole run — never capped, so a card's figures do not depend on how many
   * calls the run has made since.
   */
  callFigures: z.array(
    z
      .object({
        callId: z.string(),
        /** What this call's own turns spent, over the whole run. */
        totals: ChatTotalsWireSchema,
        clock: CallClockWireSchema.nullable().describe(
          'How long this call has been open less its waits on the user, as of throughSeq (utils/call-clock.ts). Null when the run holds no row of its clock',
        ),
        toolCalls: z
          .number()
          .int()
          .describe(
            "The tools the node itself called inside this call, its CLI sub-agents' excluded, counted from the transcript as of toolCallsThroughSeq",
          ),
        toolCallsThroughSeq: z
          .number()
          .int()
          .nullable()
          .describe(
            'The seq of the newest tool call counted in toolCalls; a later tool_call row of this call is not in it. Null when none was counted',
          ),
        /**
         * When this call's prompt cache lapses (ISO): the end of its newest
         * turn plus the lifetime its CLI reported. Null when its CLI reports
         * none — never a guessed expiry.
         */
        promptCacheExpiresAt: z.string().nullable(),
      })
      .meta({ id: 'CallFigures' }),
  ),
  /**
   * What this member has spent over the WHOLE run, summed from every
   * `turn_complete` it wrote — never the client's loaded window, which on a
   * long run leaves the oldest turns out. `totals` is every turn, its calls
   * included; `mainTotals` the turns outside any call (its own conversation).
   */
  totals: ChatTotalsWireSchema,
  mainTotals: ChatTotalsWireSchema,
  /**
   * When the member's OWN conversation's prompt cache lapses (ISO), as each
   * call's `promptCacheExpiresAt` is stated. Null when its CLI reports none.
   */
  promptCacheExpiresAt: z.string().nullable(),
  /**
   * This member's worked milliseconds and tool count, TOTALLED across its turns
   * (see `NodeState` for why these accumulate where the pair above replaces).
   * Null means never measured — separately, since an ACP agent reports no
   * timing while still using tools.
   */
  workedMs: z.number().nullable(),
  toolCalls: z.number().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
  error: z.string().nullable(),
  poolMember: z
    .number()
    .int()
    .nullable()
    .describe(
      "The pool member (1-based) the member's own conversation runs on; null for a member with no agent pool",
    ),
  poolMemberPinned: z
    .boolean()
    .describe(
      'The user pinned that pool member, so the conversation never moves back on its own',
    ),
  poolMemberNext: z
    .number()
    .int()
    .nullable()
    .describe(
      'The pool member the user picked while a turn of that conversation ran — it moves there when its next turn starts',
    ),
});
export type NodeStateWire = z.infer<typeof NodeStateWireSchema>;

export const SetPoolMemberRequestSchema = z.object({
  member: z
    .number()
    .int()
    .min(1)
    .describe(
      "The pool member (1-based) to run the member's own conversation on",
    ),
});
export type SetPoolMemberRequest = z.infer<typeof SetPoolMemberRequestSchema>;

export const SET_POOL_MEMBER_APPLIED = [
  'now',
  'next_turn',
  'unchanged',
] as const;

export const SetPoolMemberResultSchema = z.object({
  member: z.number().int(),
  applied: z
    .enum(SET_POOL_MEMBER_APPLIED)
    .describe(
      '`now`: moved (or pinned) at once; `next_turn`: a turn is running, so it moves when the next one starts; `unchanged`: already pinned there',
    ),
});
export type SetPoolMemberResult = z.infer<typeof SetPoolMemberResultSchema>;

// ── Agent-to-agent call runtime ─────────────────────────────────────────────
// The shared contract between the CallBroker (call semantics), the team
// executor (callee-turn mechanics), and the MCP server (the wire surface).

/** How a caller wants its call to behave (the call_agent `mode` argument). */
export const CALL_MODES = ['sync', 'async', 'fire_and_forget'] as const;
export type CallMode = (typeof CALL_MODES)[number];

/**
 * The bounds on `await_agent`'s own `timeout_ms` — a model's argument, so they
 * are enforced where a model's arguments are (the MCP layer, as INVALID_ARGS)
 * rather than inside the broker.
 *
 * The CEILING is the load-bearing one and it is a MEASUREMENT of the transport
 * rather than a policy: the caller's HTTP client gives up on a request that
 * has received no bytes for five minutes, and a window past that could never be
 * observed — the socket closes first, the collection comes back AWAIT_ABANDONED
 * to nobody, and the model is handed the client's own `The operation timed
 * out.` instead of the `pending` it asked for. That sentence is Bun's fetch
 * timeout (claude's runtime; the literal is in its `CommonAbortReason` table),
 * and it is an IDLE timer checked on a coarse tick, so where it lands varies:
 * reconstructed on team run `51c646fb`, 52 unbounded `await_agent` calls
 * were cut between 302s and 359s after their POST reached this daemon. It was
 * recorded here as "~338s" and the ceiling set at 300s, which the 302s cut
 * shows is no margin at all. 240s is.
 *
 * The floor is there so a `0` cannot be read as "block forever", which is the
 * one misreading that would silently reinstate the wait this argument exists
 * to bound.
 */
export const MIN_AWAIT_TIMEOUT_MS = 1_000;
export const MAX_AWAIT_TIMEOUT_MS = 240_000;

/**
 * The window an `await_agent` that names none is given — the ceiling itself.
 *
 * "Omit to block until the callee is done" was the contract, and over this
 * transport it could not be kept: the wait outlived the caller's HTTP client
 * (see {@link MAX_AWAIT_TIMEOUT_MS}), so every callee turn longer than five
 * minutes — most of them — came back to the model as a tool ERROR, `The
 * operation timed out.`, after the whole five minutes. REPORTED as exactly that
 * sentence under a Manager waiting on its Engineer, repeated for an hour. A
 * `pending` answer is what the same wait now ends in: not a failure, the call
 * untouched, and the model awaits again. Applied at the MCP layer, where the
 * transport is; the broker still treats an absent window as unbounded for an
 * in-process caller, which has no client to outlive.
 */
export const DEFAULT_AWAIT_TIMEOUT_MS = MAX_AWAIT_TIMEOUT_MS;

/**
 * The `_meta` a host tool carries to stay LOADED in claude's context rather
 * than deferred behind its tool search.
 *
 * That CLI lists every MCP tool by NAME only and loads a schema when the model
 * searches for it — and a loaded schema does not survive a compaction. On the
 * same run `51c646fb`, the Manager loaded the call tools once at the start and
 * used them correctly for ~10,000 rows; from the first compaction onward it
 * never searched for them again and called them from memory: `agent_id` for
 * `agent`, no `title`, and `timeout_seconds: "180"` for `timeout_ms` — 125
 * times. Read off the 2.1.270 bundle (`alwaysLoad: … || tool._meta?.[
 * "anthropic/alwaysLoad"] === true`, and a deferral check that returns false
 * for such a tool) and PROBED on it: a throwaway MCP server listed two tools,
 * one carrying this `_meta`, and the model named the marked tool's parameter
 * and answered DEFERRED for the other.
 *
 * A vendor key inside `_meta`, which MCP reserves for exactly this and every
 * other client ignores — so it is written once on the tools that need it rather
 * than routed per CLI. Kept to the call tools, which a caller member cannot work
 * without, and `goals`, whose "set them at the start of a task" lives in its own
 * description: deferred, it was loaded in 4 of 36 threads (2026-11-02..04), so
 * the instruction reached almost no agent. Every always-loaded schema is paid
 * for on every turn.
 */
export const ALWAYS_LOADED_TOOL_META = {
  'anthropic/alwaysLoad': true,
} as const;

/** What became of a caller's message into one running call. */
export type CalleeMessageOutcome =
  | {
      delivered: true;
      interrupts: boolean;
      /**
       * The `FollowUpMessage.deliveryId` it rode into the turn with, which a
       * later drop names (`CallBroker.markMessageDropped`).
       */
      deliveryId?: string;
    }
  | { delivered: false; reason: 'not_started' | 'refused' };

/** One command a callee left running, as {@link CalleeTurnOutcome} names it. */
export interface ShellStillOut {
  /** The words its tool call ran it with; null when they were never recorded. */
  command: string | null;
  /** The call it was started in — an earlier one on a continued thread. */
  callId: string;
}

/** How one callee sub-turn ended, as the executor reports it to the broker. */
export interface CalleeTurnOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  finalText: string | null;
  /**
   * WHY it ended that way, in the callee's own words where it had any.
   *
   * This was the constant `'callee turn failed'` for every failure a callee
   * could have, while the very same turn's `error` row in the transcript carried
   * the CLI's real sentence — so the caller was the one participant in the run
   * that could not see what had happened. See {@link AgentFailureClass} for the
   * run this was reconstructed from. Redacted on its way here
   * ({@link readCalleeFailure}), because it crosses to a model whose provider
   * is off this machine.
   */
  error: string | null;
  /**
   * The class of that failure — what the caller should DO about it. Null unless
   * `status` is `'failed'`.
   */
  failureClass: AgentFailureClass | null;
  /**
   * When a spent usage window reopens, verbatim as the CLI stated it. Null
   * unless `failureClass` is `'rate_limited'` and the message named one.
   */
  resetsAt: string | null;
  /**
   * The callee's CLI session id captured during this turn — the resume handle
   * a follow-up call passes as `thread` to CONTINUE the conversation. Null
   * when the adapter emitted no session event (the thread is not resumable).
   */
  sessionId: string | null;
  /**
   * How many sub-agents the callee launched in this call that were still out
   * when its turn ended — its result may then be PARTIAL. Absent means none.
   *
   * A CLI whose delegates do not hold its turn open (cursor) ends that turn
   * the moment it stops speaking, so a callee that fanned out reviewers in the
   * background hands back "the reviewers are looking at it" as its whole
   * result. REPORTED on a Dev Team run: a QA review returned at 15:01:50 with
   * eight reviewers still working, the Manager read it as finished, and the
   * eight reports were only collected by a second call after the user asked
   * why nothing moved.
   */
  delegatesStillOut?: number;
  /**
   * How many calls the callee made through geniro from inside this call were
   * still running when the call settled anyway — only past the wake limit
   * (`MAX_CALL_WAKES`), since below it the call is held until they finish.
   * Absent means none.
   */
  callsStillOut?: number;
  /**
   * The commands the callee's conversation detached that were still running
   * when it settled — a dev server it left up, a test run it answered over —
   * oldest first, an earlier call's on the same thread included. They keep
   * running after the result is handed back, inside the callee's kept
   * process, and what they print arrives in that conversation, so the caller
   * is told rather than left to take the answer as finished. Absent or empty
   * means none.
   */
  shellsStillOut?: ShellStillOut[];
  /**
   * Which pool member (1-based) this outcome is from. Absent for a callee with
   * no pool, where there is nothing to choose between.
   */
  member?: number;
  /**
   * The members the call was handed PAST before this outcome, in the order
   * they were tried — each one's failure, so the caller learns which accounts
   * are spent rather than only that one worked. Absent when none was skipped.
   */
  poolSkipped?: PoolSkip[];
  /**
   * The prompt-cache lifetime the callee's CLI reported for this turn, and its
   * last context reading — what tells the caller later whether resuming this
   * conversation is cheap (cache warm) or re-bills it whole. Null or absent
   * when the CLI reported none.
   */
  promptCacheTtlMs?: number | null;
  contextTokens?: number | null;
  contextWindowTokens?: number | null;
}

/**
 * How a HELD call is let go — see `CallBroker.holdCall`. A callee whose turn
 * ended while calls it made are still running is not finished, so its call
 * waits for them instead of settling:
 *
 * - `wake` — they finished, or one asked a question (or the caller sent a
 *   message): continue the callee's conversation inside the SAME call with
 *   `prompt` followed by `note`, and settle on that turn's answer. `note` —
 *   that the reply is the call's result — is said LAST, after anything the
 *   executor adds to the prompt (a message sent while the turn waits for a
 *   slot).
 * - `settle` — nothing is left to integrate; settle on the answer it has.
 * - `cancelled` — the call, or the run, was stopped while it waited.
 */
export type CallHoldRelease =
  | {
      kind: 'wake';
      prompt: string;
      note: string;
      /** Woken by its monitors' output — counted against their own budget. */
      monitor?: true;
    }
  | { kind: 'settle' }
  | { kind: 'cancelled' };

/** One pool member a call can run under: its 1-based number, resolved. */
export interface CalleePoolAttempt {
  member: number;
  /** The callee with that pool member's CLI settings in place. */
  node: TeamMember;
}

/**
 * How a call to a pooled callee is to be run — handed to
 * `RunCallCapability.launchCalleeTurn` beside the callee's own settings.
 */
export interface CalleePoolPlan {
  /** The member the `callee` argument already is. */
  member: number;
  /**
   * The members to hand the call to, in order, when an attempt fails in a way
   * another account could get past (`fallsThroughPool`). Empty for a call
   * pinned to a member the caller explicitly named.
   */
  fallbacks: readonly CalleePoolAttempt[];
  /**
   * The member whose CLI session the call's `resumeSessionId` is — the one a
   * continued thread was left on — or null for a new conversation. Only an
   * attempt as that member resumes it; any other starts a fresh session
   * carrying the conversation's transcript.
   */
  sessionMember: number | null;
}

/** A {@link PoolSkip} as a caller's envelope states it. */
export interface PoolSkipWire {
  member: number;
  failure: AgentFailureClass | null;
  resets_at?: string;
  error?: string;
}

/**
 * Why a pool member is spent (`PoolCooldowns`). `limit` is its ACCOUNT's — a
 * usage window or a lapsed sign-in, which reopens at a known instant or not
 * soon — and is what moves a conversation off it; `unavailable` is any other
 * failure it was handed past for, which only puts it later for new work.
 */
export type PoolStanding = 'limit' | 'unavailable';

/** A pool member a call was handed past. */
export interface PoolSkip {
  member: number;
  failureClass: AgentFailureClass | null;
  /** The member's own failure sentence, redacted like `CalleeTurnOutcome.error`. */
  error: string | null;
  resetsAt: string | null;
}

/**
 * One page published with `show_artifact` while a call ran — by its callee or
 * by any call made inside it — as the caller's envelope names it: the newest
 * version, and the title it was last published under.
 */
export interface CallPublishedPage {
  artifact_id: string;
  title: string;
  version: number;
}

/**
 * One button (`publish_action`) published inside a call — by its callee, or
 * by any call made inside it — as the caller's envelope names it: its newest
 * publish, and only while it is still live.
 */
export interface CallPublishedAction {
  action_id: string;
  label: string;
  kind: ActionSpec['kind'];
}

/** The `result` of a COMPLETED call's ok envelope. */
export interface CallSettledResult {
  call_id: string;
  agent: string;
  /** The callee pool member that ran it; absent without a pool. */
  member?: number;
  pool_skipped?: PoolSkipWire[];
  text: string;
  delegates_still_running?: number;
  calls_still_running?: number;
  /** How many detached commands the callee left running. */
  commands_still_running?: number;
  /** Those commands' words, each on one line — the ones that were recorded. */
  running_commands?: string[];
  /** What the text alone would leave the caller to misread. */
  note?: string;
  artifacts?: CallPublishedPage[];
  actions?: CallPublishedAction[];
}

/**
 * The envelope every call tool returns — NEVER bare text. A discriminated
 * union so an `ok` envelope always carries `result` and an `error` always
 * carries `error` — the illegal mixed shapes are unrepresentable. `result`
 * carries a {@link CallSettledResult} for a settled call and
 * `{ call_id, agent, state }` for an accepted async/fire-and-forget start;
 * `error` is a machine-prefixed one-liner (`DEPTH_LIMIT: …`).
 *
 * The `question` arm (M4, the Q&A bridge): the callee raised a mid-turn
 * AskUserQuestion and is PARKED awaiting the caller — answer with
 * `answer_agent(call_id, answer)`, then collect the final result with
 * `await_agent(call_id)` (a sync call that parks becomes await-collectable).
 * Left unanswered, the call fails with `QUESTION_TIMEOUT`.
 *
 * The `pending` arm: `await_agent` was given a `timeout_ms` and the callee was
 * still working when it elapsed. It is NOT an outcome and NOT a failure — the
 * call is untouched and stays collectable, so the caller may go and do
 * something else and await again. It exists because the alternative shapes are
 * both worse: an `error` reads to a model as the call having gone wrong, and an
 * `ok` with no text reads as a callee that finished having said nothing.
 */
export type CallEnvelope =
  | { status: 'ok'; result: unknown }
  | {
      status: 'error';
      error: string;
      /** Which call failed — set when a wait over several calls returns it. */
      call_id?: string;
      /** Pages the call published before it failed — they stay in the user's chat. */
      artifacts?: CallPublishedPage[];
      /** Buttons the call published before it failed — they stay in the user's chat. */
      actions?: CallPublishedAction[];
      /** The callee pool member the failure came from; absent without a pool. */
      member?: number;
      /** Pool members the call was handed past before failing. */
      pool_skipped?: PoolSkipWire[];
    }
  | {
      status: 'question';
      call_id: string;
      /** The callee member id the question came from. */
      agent: string;
      /** The question text (multi-question inputs join per line). */
      question: string;
      /** Option labels the callee offered (may be empty for free-form). */
      options: string[];
      /**
       * Set when this question interrupted a wait on a DIFFERENT call of the
       * caller's: that call is still running and stays collectable with
       * await_agent once the question is answered.
       */
      still_running?: string;
    }
  | {
      status: 'pending';
      call_id: string;
      /** The callee member id still working on it. */
      agent: string;
      /** Every call a wait over ALL of the caller's calls is still waiting on. */
      waiting_on?: { call_id: string; agent: string }[];
      /**
       * Why the wait ended before its callee did, when it was not the
       * caller's own `timeout_ms`: `user_message` — the user wrote to the
       * caller while it waited. The CLI reads a message delivered mid-turn only
       * at a tool boundary, so a wait left blocking would hold that message
       * unread until the callee finished.
       */
      interrupted?: 'user_message';
      /** The sentence telling the caller what to do about `interrupted`. */
      note?: string;
    };

/**
 * A callee's mid-turn question, handed from the executor's capture seam to
 * the broker's parking lot (broker owns SEMANTICS — TTL, ownership, the
 * question envelope; the executor owns MECHANICS — the two closures below).
 * `deliver` writes the caller's answer into the callee's stdin control
 * channel (allow + `updatedInput.response` — the probe-verified free-text
 * channel); `fail` cancels the parked callee turn (TTL / orphan drain).
 * `payload` is the raw AskUserQuestion input for the transcript row.
 */
export interface ParkQuestionInput {
  question: string;
  options: string[];
  payload: unknown;
  /** Test seam; the executor omits it (broker default applies). */
  ttlMs?: number;
  deliver(answer: string): boolean;
  fail(): void;
}

/**
 * Whether ONE CLI can be pointed at a different config directory — i.e. run an
 * invocation as a different account, under a different profile.
 *
 * The wire home for `AdapterConfig.configDir.unavailableReason`, which was the
 * daemon's single source of truth with no way to reach the renderer — so the
 * builder hardcoded its own `agent === 'claude'` allowlist, the executor
 * silently STRIPPED a `configDir` it could not honour, and the listing service
 * refused one with a 400. Three answers to one question, reachable today by
 * importing a team YAML. Carrying the adapter's own reason here is what
 * collapses them back to one.
 */
export const AgentConfigDirCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI cannot be given one, or null when it can. A SENTENCE rather
     * than a boolean, because the renderer shows it: "cannot" with no reason is
     * the silent refusal this replaced.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentConfigDirCapability' });
export type AgentConfigDirCapability = z.infer<
  typeof AgentConfigDirCapabilitySchema
>;

/**
 * Whether ONE CLI has an INTERACTIVE terminal mirror — a `--resume` session the
 * user can type at.
 *
 * The wire home for `AdapterConfig.terminal`, for exactly the reason the config-dir
 * row above exists: without it the renderer hardcodes `agent === 'claude'` to
 * decide whether to offer the mirror picker, and a second CLI gaining one (or
 * claude losing one) leaves the picker offering a choice the daemon answers
 * with TERMINAL_UNSUPPORTED.
 *
 * Note this says nothing about the LIVE mirror, which every agent has: it is
 * the raw stdio of whichever CLI ran the turn, so there is no per-CLI fact to
 * report.
 */
export const AgentTerminalCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI has no interactive terminal, or null when it has one. A
     * sentence for the same reason as the config-dir row: a bare "cannot" is the
     * silent refusal these capabilities exist to replace.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentTerminalCapability' });
export type AgentTerminalCapability = z.infer<
  typeof AgentTerminalCapabilitySchema
>;

/**
 * The tool-approval modes ONE CLI honours — the wire home for
 * `AdapterConfig.approval.modes`.
 *
 * It exists for the same reason as the two rows above, and after the same
 * failure: with no per-CLI answer on the wire, the composer's approval chip
 * hardcoded `agentKind === 'cursor-agent'` and rendered nothing, on the
 * (once-true, now false) grounds that the CLI had no per-turn approval
 * channel. ACP made `ask` real, so the chip was hiding a
 * control the user genuinely has — every cursor chat sat in `ask`, raising a
 * permission card per tool, with no way to switch it off.
 *
 * A CLI that honours none reports an empty list, which is a fact the renderer
 * can act on rather than a name it has to recognize.
 */
export const AgentApprovalCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    modes: z
      .array(ChatApprovalModeSchema)
      .describe('Approval modes this CLI honours, in no particular order'),
    probe: AgentApprovalProbeSchema.nullable().describe(
      'What a probe proved about the installed binary’s modes, or null when this CLI probes none',
    ),
  })
  .meta({ id: 'AgentApprovalCapability' });
export type AgentApprovalCapability = z.infer<
  typeof AgentApprovalCapabilitySchema
>;

/**
 * Whether ONE CLI can be handed a user message MID-TURN — the wire home for
 * `AdapterConfig.followUp`.
 *
 * It exists for the same reason as the three rows above, and after the same
 * failure in the same place: the composer's queue offers a "send now" that
 * pushes a queued message into the turn already running, and not every CLI has
 * a channel for one. Without this row the strip would have to decide by agent
 * name — or, worse, offer the control to every CLI and let the daemon answer
 * RUN_BUSY, which looks to the user like a button that does nothing.
 */
export const AgentFollowUpCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI cannot take a message into a running turn, or null when it
     * can. A sentence for the same reason as the rows above: the renderer puts
     * it on the disabled control, so the user learns their message is waiting
     * for the turn to end rather than being ignored.
     */
    unavailableReason: z.string().nullable(),
    /**
     * Whether delivering it STOPS what the agent is currently doing.
     *
     * The two shipped CLIs differ, so the control cannot describe itself from
     * one sentence: claude's message joins the turn and is picked up at the
     * next tool boundary, while a second `session/prompt` cancels cursor's
     * current work and answers the new message instead. The renderer says which
     * before the press, not after.
     */
    interrupts: z
      .boolean()
      .describe('Whether a mid-turn message stops what the agent is doing'),
  })
  .meta({ id: 'AgentFollowUpCapability' });
export type AgentFollowUpCapability = z.infer<
  typeof AgentFollowUpCapabilitySchema
>;

/** Whether one CLI reports the background sub-agents it runs. */
export const AgentSubagentCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI's delegates never appear, or null when it reports them.
     *
     * A sentence rather than a boolean because the renderer SHOWS it: a chat
     * that lists no sub-agents is otherwise indistinguishable from a bug, and
     * "cursor-agent reports no sub-agents over ACP" is the difference between
     * a missing feature and a missing signal.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentSubagentCapability' });
export type AgentSubagentCapability = z.infer<
  typeof AgentSubagentCapabilitySchema
>;

/** What ONE CLI is told about work it leaves running when its turn ends. */
export const AgentBackgroundWorkNoteSchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * `AdapterConfig.backgroundWork.agentNote`, verbatim — composed right after
     * {@link CapabilitiesWireSchema}'s `hostPreamble` into every user-facing
     * turn of this CLI. Null when it is told nothing.
     */
    note: z.string().nullable(),
  })
  .meta({ id: 'AgentBackgroundWorkNote' });
export type AgentBackgroundWorkNote = z.infer<
  typeof AgentBackgroundWorkNoteSchema
>;

/**
 * Whether ONE CLI offers a reasoning-effort PICKER — the wire home for
 * `AdapterConfig.effortsUnavailableReason`.
 *
 * The `efforts` part of `GET /v1/agents/vocabulary` already answers `[]` for a CLI with no such control,
 * and `[]` is enough to hide the picker — but not enough to explain the chip
 * that replaces it. That gap is what got "I cannot change the effort of a Cursor
 * model" reported against a surface working exactly as measured: the composer
 * showed an inert `high` and the only cause was a hover tooltip the renderer had
 * written itself, behind an `agentKind === 'cursor-agent'` branch. This row is
 * the same iterate-never-list shape as the six above, and it carries the
 * adapter's own sentence — which names where the effort DOES change, the one
 * thing a refusal has to say to be worth reading.
 */
export const AgentModelEffortCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI offers no effort picker, or null when it does. A sentence for
     * the same reason as every row above: the renderer shows it verbatim.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentModelEffortCapability' });
export type AgentModelEffortCapability = z.infer<
  typeof AgentModelEffortCapabilitySchema
>;

/**
 * How ONE CLI is named and described — the wire form of
 * `AdapterConfig.identity`, so no renderer surface maps an agent kind to a word
 * of its own — plus the one call-runtime fact the team builder states per
 * CLI.
 */
export const AgentIdentityCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    displayName: z.string(),
    shortName: z.string(),
    summary: z.string(),
    details: z.array(z.string()),
    icon: z.enum(AGENT_ICON_NAMES).meta({ id: 'AgentIconName' }),
    /**
     * Whether a member of this CLI can put a callee's question to the USER. It
     * needs a question tool of its own: geniro supplies its own only in chats,
     * so a CLI whose model has none answers a callee's question itself or lets
     * the call time out.
     */
    callerEscalatesQuestions: z.boolean(),
    lightModel: z
      .string()
      .nullable()
      .describe(
        'The model this CLI offers for light background work (a lessons reflection by default); null = none known, the CLI default runs',
      ),
  })
  .meta({ id: 'AgentIdentityCapability' });
export type AgentIdentityCapability = z.infer<
  typeof AgentIdentityCapabilitySchema
>;

/**
 * The switches ONE CLI offers that have no generic axis — cursor's Max Mode,
 * claude's browser tools — so the Settings card draws them from this row with
 * no per-CLI branch in the renderer. An empty list is a real answer.
 */
export const AgentOptionsCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    options: z.array(AgentOptionSpecSchema),
  })
  .meta({ id: 'AgentOptionsCapability' });
export type AgentOptionsCapability = z.infer<
  typeof AgentOptionsCapabilitySchema
>;

/** Whether one CLI reports what a turn cost it in tokens and money. */
export const AgentUsageCapabilitySchema = z
  .object({
    agent: AgentKindSchema,
    /**
     * Why this CLI's context meter is always empty, or null when it reports
     * usage.
     *
     * A sentence, and shown on the meter's own hover — because an empty spot
     * where a ring sits on the chat beside it is a question the user WILL ask,
     * and did. Unlike the sub-agent note this replaced the shape of, it has no
     * standing footprint: the meter says nothing until it is pointed at.
     */
    unavailableReason: z.string().nullable(),
  })
  .meta({ id: 'AgentUsageCapability' });
export type AgentUsageCapability = z.infer<typeof AgentUsageCapabilitySchema>;

/** GET /v1/capabilities — machine-level feature availability the builder reads. */
export const CapabilitiesWireSchema = z.object({
  agents: z
    .array(AgentIdentityCapabilitySchema)
    .describe(
      'Every registered CLI, in registration order, with how the UI names it',
    ),
  configDirs: z
    .array(AgentConfigDirCapabilitySchema)
    .describe(
      'Per-CLI config-directory (profile / account) support, one entry per known agent',
    ),
  interactiveTerminals: z
    .array(AgentTerminalCapabilitySchema)
    .describe(
      'Per-CLI interactive terminal-mirror support, one entry per known agent',
    ),
  approvals: z
    .array(AgentApprovalCapabilitySchema)
    .describe('Per-CLI tool-approval modes, one entry per known agent'),
  followUps: z
    .array(AgentFollowUpCapabilitySchema)
    .describe('Per-CLI mid-turn follow-up support, one entry per known agent'),
  subagents: z
    .array(AgentSubagentCapabilitySchema)
    .describe(
      'Per-CLI background sub-agent reporting, one entry per known agent',
    ),
  usage: z
    .array(AgentUsageCapabilitySchema)
    .describe('Per-CLI token/cost usage reporting, one entry per known agent'),
  modelEfforts: z
    .array(AgentModelEffortCapabilitySchema)
    .describe(
      'Per-CLI reasoning-effort picker support, one entry per known agent',
    ),
  options: z
    .array(AgentOptionsCapabilitySchema)
    .describe('Per-CLI user switches, one entry per known agent'),
  /**
   * The instruction block geniro prepends to EVERY user-facing turn, verbatim.
   *
   * Sent so the Settings screen can show the user what is already being said
   * on their behalf before their own instructions. It is served rather than
   * restated in the renderer for the usual reason: a second copy is a copy
   * that drifts, and this one would drift silently — nothing renders the text
   * a CLI actually received, so the preview would go on describing an older
   * preamble indefinitely.
   *
   * Not per-agent: both transports carry the same block (claude on
   * `--append-system-prompt`, ACP as leading prompt text), which is the point
   * of composing it at one seam.
   */
  hostPreamble: z
    .string()
    .describe(
      'The instruction block geniro prepends to every user-facing turn, before the user’s own custom instructions',
    ),
  /**
   * The per-CLI half of what is said before the user's instructions, right
   * after {@link hostPreamble} — per agent because geniro holds one CLI's turn
   * for its background sub-agents and not another's. Served for the same
   * reason the preamble is: the Settings preview reads it, never a copy.
   */
  backgroundWorkNotes: z
    .array(AgentBackgroundWorkNoteSchema)
    .describe(
      'Per-CLI note on background work, composed right after the host preamble, one entry per known agent',
    ),
  /**
   * The most callee turns one run works at once on this machine — what an
   * unset `Team.maxActiveTurns` means, and what a higher one is lowered to.
   */
  maxActiveTurnsCeiling: z
    .number()
    .int()
    .min(1)
    .describe(
      'The machine ceiling on callee turns working at once in one run (sized from total memory)',
    ),
});
export type CapabilitiesWire = z.infer<typeof CapabilitiesWireSchema>;

/** One instruction block as composed into a member's turn. */
export interface ComposedInstructionBlock {
  blockId: string;
  text: string;
}

export const InstructionSizeSourceSchema = z
  .enum(TURN_INSTRUCTION_SOURCES)
  .meta({ id: 'InstructionSizeSource' });

/** One part of a member's always-on instruction block, measured. */
export const InstructionSizePartSchema = z
  .object({
    source: InstructionSizeSourceSchema,
    blockId: z
      .string()
      .optional()
      .describe(
        'For an instructionBlocks part: the block whose text it is (one part per block addressed to the member)',
      ),
    chars: z.number().int().nonnegative(),
    approxTokens: z.number().int().nonnegative(),
  })
  .meta({ id: 'InstructionSizePart' });
export type InstructionSizePart = z.infer<typeof InstructionSizePartSchema>;

/** What one member's turns pay for before the prompt, every turn. */
export const MemberInstructionSizeSchema = z
  .object({
    memberId: z.string(),
    agent: AgentKindSchema.describe(
      'The CLI measured — the member’s own, a pool’s first member',
    ),
    turn: z
      .enum(['own', 'call'])
      .describe(
        'Which turn was measured: the member’s own turn, or — for a member only ever called — a turn answering a call',
      ),
    totalChars: z
      .number()
      .int()
      .nonnegative()
      .describe('Length of the composed block, exactly'),
    approxTokens: z.number().int().nonnegative(),
    separatorChars: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'The paragraph breaks between parts — totalChars less the parts',
      ),
    parts: z.array(InstructionSizePartSchema),
  })
  .meta({ id: 'MemberInstructionSize' });
export type MemberInstructionSize = z.infer<typeof MemberInstructionSizeSchema>;

/** One team instruction block's own text, measured once whoever it reaches. */
export const InstructionBlockSizeSchema = z
  .object({
    blockId: z.string(),
    chars: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'Length of the text composed into a turn — 0 for a blank block',
      ),
    approxTokens: z.number().int().nonnegative(),
    reaches: z
      .number()
      .int()
      .nonnegative()
      .describe('How many members’ turns carry it'),
  })
  .meta({ id: 'InstructionBlockSize' });
export type InstructionBlockSize = z.infer<typeof InstructionBlockSizeSchema>;

/** POST /v1/teams/instruction-sizes — one entry per member, one per block. */
export const InstructionSizesWireSchema = z.object({
  members: z.array(MemberInstructionSizeSchema),
  blocks: z.array(InstructionBlockSizeSchema),
});
export type InstructionSizesWire = z.infer<typeof InstructionSizesWireSchema>;

/** What one CLI's every turn in a project carries before the prompt. */
export const AgentInstructionSizeSchema = z
  .object({
    agent: AgentKindSchema,
    totalChars: z
      .number()
      .int()
      .nonnegative()
      .describe('Length of the composed block, exactly'),
    approxTokens: z.number().int().nonnegative(),
    separatorChars: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'The paragraph breaks between parts — totalChars less the parts',
      ),
    parts: z.array(InstructionSizePartSchema),
  })
  .meta({ id: 'AgentInstructionSize' });
export type AgentInstructionSize = z.infer<typeof AgentInstructionSizeSchema>;

/** POST /v1/projects/:projectId/instruction-sizes — one entry per CLI. */
export const ProjectInstructionSizesWireSchema = z.object({
  agents: z.array(AgentInstructionSizeSchema),
  blocks: z
    .array(InstructionBlockSizeSchema)
    .describe(
      'Each instruction block’s own text; every run carries it, so `reaches` is 1',
    ),
});
export type ProjectInstructionSizesWire = z.infer<
  typeof ProjectInstructionSizesWireSchema
>;

export const HEALTH_PROBLEM_KINDS = [
  'cli_missing',
  'cli_unknown',
  'profile_missing',
  'no_trigger',
  'mcp_failed',
  'mcp_needs_auth',
  'mcp_disconnected',
  'model_not_offered',
  'effort_not_offered',
  'stage_member_missing',
] as const;
export type HealthProblemKind = (typeof HEALTH_PROBLEM_KINDS)[number];

/**
 * One thing wrong with how a team or member is set up. `error` blocks a run
 * from starting; `warning` only informs. The renderer picks the fix by `kind`
 * and aims it with the other fields.
 */
export const HealthProblemSchema = z
  .object({
    kind: z.enum(HEALTH_PROBLEM_KINDS),
    level: z.enum(['error', 'warning']),
    message: z.string().describe('One plain sentence naming the setting'),
    agent: AgentKindSchema.nullable().describe(
      'The CLI the problem is about; null for a team-level problem',
    ),
    poolMember: z
      .number()
      .int()
      .nullable()
      .describe('Null = the member itself; 2 and up = its pool position'),
    configDir: z.string().nullable(),
    server: z.string().nullable().describe('MCP server name'),
    model: z.string().nullable(),
  })
  .meta({ id: 'HealthProblem' });
export type HealthProblem = z.infer<typeof HealthProblemSchema>;

export const MEMBER_HEALTH_STATUSES = [
  'ok',
  'warning',
  'error',
  'checking',
] as const;
export type MemberHealthStatus = (typeof MEMBER_HEALTH_STATUSES)[number];

// No `.meta({ id })` on this ROOT (the member route's response); the copy
// nested in `TeamHealthSchema` carries the id.
export const MemberSeatSchema = z
  .object({
    agent: AgentKindSchema,
    configDir: z.string().nullable(),
    poolMember: z
      .number()
      .int()
      .nullable()
      .describe('null for the member itself, 2.. for a pool position'),
  })
  .meta({ id: 'MemberSeat' });
export type MemberSeat = z.infer<typeof MemberSeatSchema>;

export const MemberHealthSchema = z.object({
  memberId: z.string(),
  seats: z
    .array(MemberSeatSchema)
    .describe(
      'Each CLI and profile the member runs on, so a reader can add its own sign-in reading',
    ),
  status: z
    .enum(MEMBER_HEALTH_STATUSES)
    .describe(
      'error if any problem blocks a run, else checking while MCP is still being read, else warning if any problem informs, else ok',
    ),
  checking: z
    .boolean()
    .describe(
      "A read of the member's MCP servers is still running, whatever its status",
    ),
  problems: z.array(HealthProblemSchema),
  mcpCheckedAt: z
    .string()
    .nullable()
    .describe(
      "ISO time of the oldest MCP reading behind this member's servers; null when none is known",
    ),
});
export type MemberHealth = z.infer<typeof MemberHealthSchema>;

export const TeamHealthSchema = z.object({
  slug: z.string(),
  checkedAt: z.string().describe('ISO time the answer was composed'),
  blocking: z
    .boolean()
    .describe('A problem of level error stands, so a run cannot start'),
  team: z.array(HealthProblemSchema).describe('Problems of the team itself'),
  members: z.array(MemberHealthSchema.meta({ id: 'MemberHealth' })),
});
export type TeamHealth = z.infer<typeof TeamHealthSchema>;

/** What calling off a run's promised continues answers. */
export const ResetWakesCancelledSchema = z.object({
  cancelledCallIds: z
    .array(z.string())
    .describe(
      'The calls that will NOT be continued at the usage-limit reset now',
    ),
});
export type ResetWakesCancelled = z.infer<typeof ResetWakesCancelledSchema>;

/**
 * What the executor lends the broker so a promised usage-limit continue
 * survives the daemon — installed once (`CallBroker.useResetWakeHooks`), not
 * per run, because a promise outlives every pass that could carry a capability.
 */
export interface ResetWakeHooks {
  /** Write the run's pending continues to its row — the whole list each time. */
  save(runId: string, wakes: PersistedResetWake[]): void;
  /**
   * The reset has come for a run no pass has registered since the daemon
   * started: start one that makes the continue, or say in the transcript why
   * it cannot be made.
   */
  wakeRestoredRun(runId: string, wake: PersistedResetWake): void;
  /** A transcript row for a run with no capability to write one through. */
  note(runId: string, memberId: string, payload: Record<string, unknown>): void;
}

/**
 * What the team executor exposes to the broker for one live run — the
 * capability seam. The broker owns call SEMANTICS (ids, caps, sync/async
 * bookkeeping); the executor owns MECHANICS (spawning the callee turn,
 * transcript persistence, slot accounting, cancellation fan-out).
 */
export interface RunCallCapability {
  /** Callees each caller may invoke: caller member id → every other member. */
  readonly calleesOf: ReadonlyMap<string, readonly TeamMember[]>;
  /**
   * The run's folder, whose account pin decides which account a pool member
   * runs on (`PoolCooldowns`). Absent: no folder, so nothing is pinned.
   */
  readonly cwd?: string;
  /**
   * The agents a user's message goes to (the trigger-fed ones) — the only
   * members whose waits `awaitingCalls` counts.
   */
  readonly messageTargets: ReadonlySet<string>;
  /**
   * Spawn one callee turn; resolves once the turn fully settles. A fresh turn
   * waits for room under the run's active-turn cap (`Team.maxActiveTurns`)
   * at any call depth; `options.wake` — geniro continuing a conversation to
   * deliver what its running calls owe it — starts at once.
   * `resumeSessionId` continues a prior callee CLI session (a thread
   * continuation); null starts a fresh conversation.
   *
   * `conversationId` names the CONVERSATION this turn belongs to: the call id
   * itself for a fresh one, and the FIRST call of the lineage for a thread
   * continuation. The executor keys the callee's kept process by it, so a
   * continuation is handed to the process that already holds the conversation
   * instead of resuming the same CLI session in a second one — which is what
   * put two live `claude --resume <id>` processes on one worktree, both
   * answering one message and editing the same files.
   *
   * `options.pool` is set for a callee with an agent pool: `callee` is then
   * that member's resolved settings, and the plan names it and the members to
   * fall through to. The outcome says which member produced it.
   */
  launchCalleeTurn(
    callee: TeamMember,
    message: string,
    callId: string,
    resumeSessionId: string | null,
    conversationId: string,
    options: { pool?: CalleePoolPlan; wake: boolean },
  ): Promise<CalleeTurnOutcome>;
  /**
   * Stop ONE callee turn — the executor half of `cancel_agent`.
   *
   * It marks the call cancelled and cancels its turn if one is running, and
   * BOTH halves are load-bearing: a call can be queued under the run's
   * active-turn cap, so the commonest thing a caller wants to cancel is a call
   * that has no process yet. Marking reaches that one: it leaves the queue at
   * once and settles `cancelled` without ever spawning.
   *
   * Returns whether a turn was actually signalled, which the broker uses only to
   * word its receipt: a marked-but-unstarted call is cancelled just as
   * effectively, so `false` is never a refusal.
   */
  cancelCalleeTurn(callId: string): boolean;
  /**
   * Hand `text` to the callee of ONE running call, as a message joining its
   * turn — the executor half of `message_agent`. The same channel a user's
   * message into a call block takes (`deliverToCall`), minus the transcript
   * row, which the broker writes as the caller's.
   *
   * `not_started` is a call still queued under the active-turn cap (there is no
   * process to write to), `refused` a CLI that took no message mid-turn.
   * `interrupts` says what a delivery COST: a CLI whose follow-up replaces
   * the prompt in flight dropped the step it was on.
   */
  messageCallee(callId: string, text: string): CalleeMessageOutcome;
  /** Persist one transcript item on the run's serialized write chain. */
  persistItem(
    memberId: string | null,
    kind: ItemKind,
    role: string | null,
    payload: unknown,
  ): void;
  /** True once the run's cancel was requested — refuse new calls. */
  isCancelled(): boolean;
  /**
   * True once a LATER pass of this run has claimed it: a follow-up message is
   * starting the next walk, whose own registration replaces this capability.
   * A call started through this one now would be minted into state nothing
   * will collect from — so it is refused, and the caller makes it again once
   * the next pass serves the surface.
   */
  isSuperseded(): boolean;
  /**
   * How long the CLI behind `caller` holds ONE MCP tool call open — its
   * adapter's `mcp.toolCallDeadlineMs` — or null for a caller with no such
   * wall (not a member). The broker bounds every wait it serves that
   * caller below it (`CallBroker.waitCeiling`).
   *
   * A caller KEY (`utils/caller-key.ts`), not a member id: a pooled callee's
   * conversation runs on whichever member's CLI took it, and that CLI's
   * deadline is the one that cuts the wait.
   */
  toolCallDeadlineMs(caller: string): number | null;
  /**
   * True while the caller's CONVERSATION has a live turn — i.e. it could still
   * call answer_agent. `caller` is a caller key (`utils/caller-key.ts`): a
   * member's own conversation, or one call lineage it answers as a callee, and
   * never the member as a whole — a member's callee turns say nothing about
   * whether its own conversation can answer. A question parking after its
   * owner settled is handed to {@link wakeNode} rather than waiting out the
   * TTL; one owned by a fire-and-forget caller is orphaned at once.
   */
  isNodeLive(caller: string): boolean;
  /**
   * Whether a conversation's monitors still owe it output — one running, or
   * output held until it can be delivered. A callee turn ending while this
   * holds is held in its call, as for a call of its own still running.
   * Absent for a capability with no monitor tools.
   */
  monitorsOwed?(caller: string): boolean;
  /**
   * Whether the kept process of call conversation `conversationId` still runs
   * work of its own (a detached command, a parked card) that moving the
   * conversation to another pool member would stop. Absent: it holds none.
   */
  conversationHoldsWork?(conversationId: string): boolean;
  /**
   * A conversation started or stopped being BLOCKED — inside a wait on its
   * own calls, on its own parked question, or on an approval card. A blocked
   * callee turn does not count against the run's active-turn cap, and is
   * counted again, without waiting, once it is not. Reported on a change only.
   */
  turnBlocked?(caller: string, blocked: boolean): void;
  /** Stop a conversation's monitors — its call is being cancelled. */
  stopMonitors?(caller: string): void;
  /** A callee conversation's call is now held — output waiting for it can go. */
  callHeld?(caller: string): void;
  /**
   * How many of the run's team notes a conversation has not been shown and
   * did not write — said on its call replies and in its wakes. Absent for a
   * capability with no team-note tools.
   */
  unreadTeamNotes?(caller: string): number;
  currentStage?(): string | null;
  /**
   * Start another turn of a member's OWN conversation whose turns have all
   * ended, carrying `prompt` — how a question or a result that arrives after
   * the caller stopped still reaches it. False when the run cannot take a turn
   * (cancelled, finished, not an agent) — and for a callee conversation, which
   * the broker continues as a call instead (`CallBroker.startOwnerTurn`). The
   * broker then falls back to what it did before this existed.
   */
  wakeNode(caller: string, prompt: string): boolean;
  /**
   * Hand `prompt` to a caller's conversation that is WORKING, as a message
   * joining its running turn — for a callee, the turn of the call it is
   * answering. False — and nothing sent — when that conversation has no live
   * turn, the CLI refused the message, or the CLI's follow-up would INTERRUPT
   * the turn (`AdapterConfig.followUp.interrupts`): stopping a caller's tool
   * call to relay a question costs more than letting its next wait deliver it.
   *
   * A turn can still end before it takes a message it accepted
   * (`follow_up_dropped`). `redeliver` then runs once that turn has ended;
   * without one the drop is let go — right for a question or a result, which
   * a tell leaves untold, so the conversation's drain wakes it with them.
   */
  tellLiveNode(caller: string, prompt: string, redeliver?: () => void): boolean;
}

/**
 * One BOARD tool as the MCP host lists it (`HOST_BOARD_TOOLS`).
 *
 * The tasks module writes these — names, descriptions and schemas — because
 * the vocabulary they spell (columns, priorities, the autopilot) is the board's,
 * and `TasksModule` imports this one, never the reverse.
 */
export interface TaskBoardTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What one board tool call answers: the text the agent reads. */
export interface TaskBoardToolAnswer {
  text: string;
  /**
   * True for a call the agent must change before retrying — bad arguments, a
   * card or project that does not exist. A refusal the agent carries on from
   * (the card moved under it) is not an error.
   */
  isError: boolean;
}

/**
 * The tasks module's half of the board tools, installed behind
 * `TaskBoardBroker`. Keyed by the RUN the calling agent belongs to, because a
 * run working a card (`Run.taskId`) targets that card by default.
 */
export interface TaskBoardHandler {
  tools(): readonly TaskBoardTool[];
  call(
    runId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<TaskBoardToolAnswer>;
}

export const StageMoveRequestSchema = z.object({
  action: StageMoveActionSchema,
  stage: z.string().min(1).describe('The id of the stage to move'),
  next: z
    .string()
    .min(1)
    .optional()
    .describe('At a fork: the id of the stage the run takes'),
  text: z.string().describe('What was done, or why'),
  expectedRev: z
    .number()
    .int()
    .min(0)
    .describe(
      'The stage revision the user was looking at; a different one is refused 409 STAGE_PROGRESS_CHANGED',
    ),
});
export type StageMoveRequestWire = z.infer<typeof StageMoveRequestSchema>;

export type StageMoveRequest = Omit<StageMoveRequestWire, 'expectedRev'>;

export interface StageMove {
  action: StageMoveAction;
  stageId: string;
  next?: string;
  text: string;
  by: StageActor;
  at: string;
}

export type StageRefusalCode =
  | 'NO_STAGES'
  | 'STAGE_UNKNOWN'
  | 'STAGE_NOT_CURRENT'
  | 'STAGES_FINISHED'
  | 'NEXT_REQUIRED'
  | 'NEXT_INVALID'
  | 'NOT_REOPENABLE'
  | 'TEXT_REQUIRED'
  | 'TEXT_TOO_LONG'
  | 'STAGE_PROGRESS_CHANGED'
  | 'RUN_ARCHIVED'
  | 'GOALS_REQUIRED';

export type StageMoveResult =
  | {
      ok: true;
      stages: readonly TeamStage[];
      team: Team;
      progress: StageProgress;
      resets: string[];
      payload: StageChangePayload;
      /** Who leads the run after the move, and who led it before. */
      lead: string | null;
      previousLead: string | null;
    }
  | {
      ok: false;
      code: StageRefusalCode;
      message: string;
    };

/** A move that was written, with who made it — what `StageService.onMoved` listeners are told. */
export type StageMoved = Extract<StageMoveResult, { ok: true }> & {
  actor: StageActor;
};

export const StageMoveResultSchema = z.object({
  progress: StageProgressSchema,
  woke: z
    .boolean()
    .describe(
      "Whether the run's lead agent was woken, or will be when its turn ends",
    ),
  hasLead: z
    .boolean()
    .describe(
      'Whether the run has a lead agent to tell at all — false when its trigger starts no agent',
    ),
});
export type StageMoveResultWire = z.infer<typeof StageMoveResultSchema>;

/** The judge an analysis would run as: which agent and model. */
export const AnalysisJudgeQuerySchema = z.object({
  agent: z.string().min(1),
  model: z.string().min(1).optional().describe('omitted for the CLI’s default'),
});

/**
 * Whether a would-be judge runs the same vendor's models as the members it
 * would mark — a judge favours its own vendor's work.
 */
export const AnalysisJudgeCheckSchema = z.object({
  judgeVendor: z
    .string()
    .nullable()
    .describe('whose models the judge runs; null when not known'),
  members: z.number().describe('members of the team'),
  sameVendor: z
    .array(z.string())
    .describe('the members whose own model is the judge’s vendor'),
  alternatives: z
    .array(AgentKindSchema)
    .describe('agents whose every model is another vendor’s'),
});
// No `.meta({ id })`: a response DTO root (see UsageStatsWireSchema).
export type AnalysisJudgeCheckWire = z.infer<typeof AnalysisJudgeCheckSchema>;
