import { BadRequestException } from '@packages/common';
import { createTwoFilesPatch } from 'diff';

import {
  INSTRUCTION_BLOCK_EVERYONE,
  type InstructionBlock,
  type Team,
  type TeamAgentPoolMember,
  type TeamMember,
  type TeamOverlay,
  type TeamOverlayAgentDefaults,
  TeamSchema,
} from '../teams.types';
import { serializeTeamOverlayYaml } from './team-overlay-yaml';
import { validateTeam } from './team-validate';

/** The member fields a project's Model-group override may set, `agent` aside. */
export const OVERLAY_MODEL_FIELDS = [
  'model',
  'effort',
  'contextWindow',
  'modelParameters',
  'autoCompactPercent',
  'approval',
  'configDir',
] as const satisfies readonly (keyof TeamOverlayAgentDefaults)[];

/** What an agent switch clears: every Model-group field but the required `approval`. */
const CLI_BOUND_FIELDS = OVERLAY_MODEL_FIELDS.filter(
  (field) => field !== 'approval',
);

export interface AppliedTeamOverlay {
  team: Team;
  /** Overlay entries naming a member the team no longer has, e.g. `members.reviewer`. */
  orphans: string[];
}

/** The id an overlay block runs under, so it never collides with a team block. */
export function overlayBlockId(projectId: string, blockId: string): string {
  return `project:${projectId}:${blockId}`;
}

function invalid(message: string): never {
  throw new BadRequestException('TEAM_OVERLAY_INVALID', message);
}

/** The model's own fields, which another model does not share. */
const MODEL_BOUND_FIELDS = ['contextWindow', 'modelParameters'] as const;

/**
 * `target` with its model-bound fields dropped when an overlay layer picks
 * another model: a window or parameter of the team's model is not the new
 * model's, as choosing a model in the editor clears them too.
 */
function forModel<T extends { model?: string }>(
  target: T,
  layers: readonly (TeamOverlayAgentDefaults | undefined)[],
): T {
  const model = layers.reduce<string | undefined>(
    (picked, layer) => layer?.model ?? picked,
    undefined,
  );
  if (model === undefined || model === target.model) {
    return target;
  }
  const out = { ...target };
  for (const field of MODEL_BOUND_FIELDS) {
    delete (out as Record<string, unknown>)[field];
  }
  return out;
}

function withDefaults<T extends object>(
  target: T,
  values: TeamOverlayAgentDefaults | undefined,
): T {
  if (!values) {
    return target;
  }
  const out = { ...target } as Record<string, unknown>;
  for (const field of OVERLAY_MODEL_FIELDS) {
    if (values[field] !== undefined) {
      out[field] = values[field];
    }
  }
  return out as T;
}

function appended(base: string | undefined, extra: string): string {
  const text = base?.trimEnd() ?? '';
  return text === '' ? extra : `${text}\n\n${extra}`;
}

function effectiveMember(member: TeamMember, overlay: TeamOverlay): TeamMember {
  const own = overlay.members?.[member.id];
  const settings = own?.settings;
  const agent = settings?.agent ?? member.agent;
  let out: TeamMember = { ...member, agent };
  if (agent !== member.agent) {
    for (const field of CLI_BOUND_FIELDS) {
      delete out[field];
    }
  }
  out = forModel(out, [overlay.allMembers?.[agent]]);
  out = withDefaults(out, overlay.allMembers?.[agent]);
  if (settings) {
    out = forModel(out, [settings]);
    out = withDefaults(out, settings);
  }
  if (own?.pool !== undefined) {
    out.pool = own.pool.map((entry) => ({ ...entry }));
  } else if (member.pool !== undefined) {
    out.pool = member.pool.map((entry): TeamAgentPoolMember =>
      withDefaults(
        forModel({ ...entry }, [overlay.allMembers?.[entry.agent]]),
        overlay.allMembers?.[entry.agent],
      ),
    );
  }
  if (own?.mcpDisabled !== undefined) {
    if (own.mcpDisabled.length > 0) {
      out.mcpDisabled = [...own.mcpDisabled];
    } else {
      delete out.mcpDisabled;
    }
  }
  const extra = own?.extraInstructions?.trim();
  if (extra) {
    out.instructions = appended(member.instructions, extra);
  }
  return out;
}

/** Overlay entries naming a member or audience member the team does not have. */
export function overlayOrphans(team: Team, overlay: TeamOverlay): string[] {
  const memberIds = new Set(team.members.map((member) => member.id));
  const orphans: string[] = [];
  for (const id of Object.keys(overlay.members ?? {})) {
    if (!memberIds.has(id)) {
      orphans.push(`members.${id}`);
    }
  }
  for (const block of overlay.instructionBlocks ?? []) {
    if (block.audience === INSTRUCTION_BLOCK_EVERYONE) {
      continue;
    }
    for (const id of block.audience) {
      if (!memberIds.has(id)) {
        orphans.push(`instructionBlocks.${block.id}.audience.${id}`);
      }
    }
  }
  return orphans;
}

/**
 * The team one project runs: the shared `team` with `overlay` applied.
 *
 * TWIN PARSER: `effectiveMemberOf` in
 * `apps/ui/src/renderer/teams/team-overlay-doc.ts` (the member part).
 * Precedence is the member's own override, then `allMembers` for its CLI, then
 * the team's value; an agent override starts that member's Model group over
 * from its new CLI's defaults. A pool override replaces the member's pool whole
 * and `allMembers` leaves its entries alone. Entries naming what the team no
 * longer has are dropped and reported as orphans. Refuses `TEAM_OVERLAY_INVALID`
 * when the result is not a valid team.
 */
export function applyTeamOverlay(
  team: Team,
  overlay: TeamOverlay,
  projectId: string,
): AppliedTeamOverlay {
  const orphans = overlayOrphans(team, overlay);
  const memberIds = new Set(team.members.map((member) => member.id));
  const blocks: InstructionBlock[] = (overlay.instructionBlocks ?? []).map(
    (block) => ({
      ...block,
      id: overlayBlockId(projectId, block.id),
      audience:
        block.audience === INSTRUCTION_BLOCK_EVERYONE
          ? block.audience
          : block.audience.filter((id) => memberIds.has(id)),
    }),
  );
  const candidate: Team = {
    ...team,
    members: team.members.map((member) => effectiveMember(member, overlay)),
    instructionBlocks: [...team.instructionBlocks, ...blocks],
  };
  const parsed = TeamSchema.safeParse(candidate);
  if (!parsed.success) {
    return invalid(
      `This project's overlay makes the team invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const [first] = validateTeam(parsed.data).errors;
  if (first !== undefined) {
    return invalid(
      `This project's overlay makes the team invalid: ${first.message}`,
    );
  }
  return { team: parsed.data, orphans };
}

/** How much one overlay changes, for the scope list and the project page. */
export function overlayCounts(overlay: TeamOverlay): {
  overrides: number;
  blocks: number;
  notes: number;
} {
  let overrides = 0;
  let notes = 0;
  for (const values of Object.values(overlay.allMembers ?? {})) {
    overrides += Object.keys(values ?? {}).length;
  }
  for (const member of Object.values(overlay.members ?? {})) {
    overrides += Object.keys(member.settings ?? {}).length;
    if (member.pool !== undefined) {
      overrides += 1;
    }
    if (member.mcpDisabled !== undefined) {
      overrides += 1;
    }
    if (member.extraInstructions?.trim()) {
      notes += 1;
    }
  }
  return {
    overrides,
    blocks: overlay.instructionBlocks?.length ?? 0,
    notes,
  };
}

/** A unified diff of two overlays as their files would hold them; empty when they read alike. */
export function overlayDiffText(
  projectId: string,
  before: TeamOverlay,
  after: TeamOverlay,
): string {
  const from = serializeTeamOverlayYaml(before);
  const to = serializeTeamOverlayYaml(after);
  if (from === to) {
    return '';
  }
  const file = `${projectId}.overlay.yaml`;
  return createTwoFilesPatch(
    `a/${file}`,
    `b/${file}`,
    from,
    to,
    undefined,
    undefined,
    {
      context: 3,
    },
  );
}
