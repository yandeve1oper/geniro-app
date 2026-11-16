import { BadRequestException } from '@packages/common';
import { Document, parseDocument } from 'yaml';

import { type TeamOverlay, TeamOverlaySchema } from '../teams.types';

/** `<userData>/teams/` subfolder overlays live in — the library listing reads no subfolder. */
export const TEAM_OVERLAYS_DIR_NAME = 'overlays';

export const TEAM_OVERLAY_SUFFIX = '.overlay.yaml';

function unreadable(summary: string): never {
  throw new BadRequestException('TEAM_OVERLAY_UNREADABLE', summary);
}

/** Parse + validate one overlay file's source; an empty file is an empty overlay. */
export function parseTeamOverlayYaml(source: string): TeamOverlay {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return unreadable(`YAML parse error: ${doc.errors[0]!.message}`);
  }
  const value: unknown = doc.toJS() ?? {};
  const parsed = TeamOverlaySchema.safeParse(value);
  if (!parsed.success) {
    return unreadable(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

/** An overlay with its empty sections dropped, so a cleared override leaves no key behind. */
export function compactTeamOverlay(overlay: TeamOverlay): TeamOverlay {
  const plain = JSON.parse(JSON.stringify(overlay)) as TeamOverlay;
  const out: TeamOverlay = {};
  const allMembers = Object.fromEntries(
    Object.entries(plain.allMembers ?? {}).filter(
      ([, value]) => value !== undefined && Object.keys(value).length > 0,
    ),
  );
  if (Object.keys(allMembers).length > 0) {
    out.allMembers = allMembers;
  }
  const members = Object.fromEntries(
    Object.entries(plain.members ?? {}).flatMap(([id, member]) => {
      const kept: NonNullable<TeamOverlay['members']>[string] = {};
      if (member.settings && Object.keys(member.settings).length > 0) {
        kept.settings = member.settings;
      }
      if (
        member.extraInstructions !== undefined &&
        member.extraInstructions.trim() !== ''
      ) {
        kept.extraInstructions = member.extraInstructions;
      }
      if (member.pool !== undefined) {
        kept.pool = member.pool;
      }
      if (member.mcpDisabled !== undefined) {
        kept.mcpDisabled = member.mcpDisabled;
      }
      return Object.keys(kept).length > 0 ? [[id, kept]] : [];
    }),
  );
  if (Object.keys(members).length > 0) {
    out.members = members;
  }
  if (plain.instructionBlocks && plain.instructionBlocks.length > 0) {
    out.instructionBlocks = plain.instructionBlocks;
  }
  return out;
}

export function serializeTeamOverlayYaml(overlay: TeamOverlay): string {
  return new Document(compactTeamOverlay(overlay)).toString();
}
