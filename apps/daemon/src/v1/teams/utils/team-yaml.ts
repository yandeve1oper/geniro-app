import { BadRequestException } from '@packages/common';
import { Document, isMap, isSeq, parseDocument, type YAMLMap } from 'yaml';

import {
  type InstructionBlock,
  type Team,
  type TeamMember,
  TeamYamlSchema,
} from '../teams.types';
import {
  isLegacyTeamGraph,
  teamFromLegacyDocument,
} from './team-from-workflow';

/**
 * YAML (de)serialization for `*.team.yaml` team files. Serialization is
 * comment-preserving: when the existing file source is supplied, the parsed
 * Document is mutated in place — scalar keys are updated, members and blocks
 * are matched to their existing YAML items by id and patched field by field —
 * so comments and formatting the user wrote by hand survive a save. A full
 * re-dump happens only for brand-new files, unparseable sources and files
 * still written as a node graph.
 */

export interface ReadTeamDocument {
  team: Team;
  /** Set when the source was a node graph: what the conversion dropped. */
  legacyNotes: string[] | null;
}

function invalid(summary: string): never {
  throw new BadRequestException('TEAM_YAML_INVALID', summary);
}

/** Parse one team document (a team, or a node graph converted), validated. */
export function readTeamDocument(value: unknown): ReadTeamDocument {
  if (isLegacyTeamGraph(value)) {
    const legacy = teamFromLegacyDocument(value);
    if (!legacy.success) {
      return invalid(legacy.error);
    }
    return { team: legacy.converted.team, legacyNotes: legacy.converted.notes };
  }
  const parsed = TeamYamlSchema.safeParse(value);
  if (!parsed.success) {
    return invalid(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; '),
    );
  }
  return { team: parsed.data, legacyNotes: null };
}

function documentOf(source: string): unknown {
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    return invalid(`YAML parse error: ${doc.errors[0]!.message}`);
  }
  return doc.toJS();
}

/** Parse + validate one team file's source, converting a node graph. */
export function parseTeamYaml(source: string): Team {
  return readTeamDocument(documentOf(source)).team;
}

/** {@link parseTeamYaml}, also saying whether the file was a node graph. */
export function parseTeamYamlDocument(source: string): ReadTeamDocument {
  return readTeamDocument(documentOf(source));
}

function teamToPlain(team: Team): Record<string, unknown> {
  return JSON.parse(JSON.stringify(team)) as Record<string, unknown>;
}

function setOrDelete(map: YAMLMap, key: string, value: unknown): void {
  if (value === undefined) {
    map.delete(key);
  } else {
    map.set(key, value);
  }
}

/**
 * Every member field the merge path writes back besides `id`. A field
 * missing here is silently dropped on every save of an existing file;
 * `MemberFieldsAreComplete` turns that into a compile error.
 */
const MEMBER_FIELDS = [
  'name',
  'character',
  'avatar',
  'role',
  'instructions',
  'agent',
  'model',
  'effort',
  'contextWindow',
  'modelParameters',
  'autoCompactPercent',
  'approval',
  'configDir',
  'mcpDisabled',
  'pool',
] as const satisfies readonly Exclude<keyof TeamMember, 'id'>[];

const BLOCK_FIELDS = [
  'title',
  'text',
  'audience',
] as const satisfies readonly Exclude<keyof InstructionBlock, 'id'>[];

type MissingField =
  | Exclude<Exclude<keyof TeamMember, 'id'>, (typeof MEMBER_FIELDS)[number]>
  | Exclude<
      Exclude<keyof InstructionBlock, 'id'>,
      (typeof BLOCK_FIELDS)[number]
    >;
type FieldsAreComplete = [MissingField] extends [never] ? true : MissingField;
const _fieldsAreComplete: FieldsAreComplete = true;
void _fieldsAreComplete;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : inner,
  );
}

// An unchanged block is left alone so the user's YAML comments on it survive an autosave.
function patchWhole(
  doc: Document,
  root: YAMLMap,
  key: string,
  value: unknown,
): void {
  if (value === undefined) {
    root.delete(key);
    return;
  }
  const plain = JSON.parse(JSON.stringify(value)) as unknown;
  const existing = root.get(key);
  if (
    (isSeq(existing) || isMap(existing)) &&
    canonicalJson(existing.toJSON()) === canonicalJson(plain)
  ) {
    return;
  }
  root.set(key, doc.createNode(plain));
}

/**
 * Patch a list of id-keyed entries in place: retained items keep their
 * comments and are put in the entries' order (member and block order shape
 * every prompt), removed ones go, new ones are added where they stand. A file
 * carrying one id twice keeps the first.
 */
function patchById<T extends { id: string }>(
  doc: Document,
  root: YAMLMap,
  key: string,
  entries: readonly T[],
  fields: readonly string[],
): void {
  const existing = root.get(key);
  if (!isSeq(existing)) {
    root.set(key, doc.createNode(JSON.parse(JSON.stringify(entries))));
    return;
  }
  const kept = new Map<string, YAMLMap>();
  for (const item of existing.items) {
    if (!isMap(item)) {
      continue;
    }
    const id = item.get('id');
    if (typeof id === 'string' && !kept.has(id)) {
      kept.set(id, item as YAMLMap);
    }
  }
  existing.items = entries.map((entry) => {
    const map = kept.get(entry.id);
    if (map === undefined) {
      return doc.createNode(JSON.parse(JSON.stringify(entry)));
    }
    const fieldsOf = entry as Record<string, unknown>;
    for (const field of fields) {
      const value = fieldsOf[field];
      setOrDelete(
        map,
        field,
        value === undefined ? undefined : JSON.parse(JSON.stringify(value)),
      );
    }
    return map;
  });
}

type TopLevelPatch = (doc: Document, root: YAMLMap, team: Team) => void;

function patchScalar(
  key: 'name' | 'description' | 'maxActiveTurns' | 'mode' | 'lessons',
): TopLevelPatch {
  return (_doc, root, team) => setOrDelete(root, key, team[key]);
}

const MERGED_TOP_LEVEL_PATCHES = {
  name: patchScalar('name'),
  description: patchScalar('description'),
  maxActiveTurns: patchScalar('maxActiveTurns'),
  mode: patchScalar('mode'),
  lessons: patchScalar('lessons'),
  members: (doc, root, team) =>
    patchById(doc, root, 'members', team.members, MEMBER_FIELDS),
  triggers: (doc, root, team) =>
    patchWhole(doc, root, 'triggers', team.triggers),
  instructionBlocks: (doc, root, team) =>
    patchById(
      doc,
      root,
      'instructionBlocks',
      team.instructionBlocks,
      BLOCK_FIELDS,
    ),
  stages: (doc, root, team) => patchWhole(doc, root, 'stages', team.stages),
} as const satisfies Record<keyof Team, TopLevelPatch>;

/**
 * Serialize a team, merging into `existingSource` when provided so user
 * comments/formatting survive. Returns the YAML text to write to disk.
 */
export function serializeTeamYaml(
  team: Team,
  existingSource?: string | null,
): string {
  if (!existingSource) {
    return new Document(teamToPlain(team)).toString();
  }
  const doc = parseDocument(existingSource);
  if (
    doc.errors.length > 0 ||
    !isMap(doc.contents) ||
    isLegacyTeamGraph(doc.toJS())
  ) {
    return new Document(teamToPlain(team)).toString();
  }
  const root = doc.contents as YAMLMap;
  for (const patch of Object.values(MERGED_TOP_LEVEL_PATCHES)) {
    patch(doc, root, team);
  }
  return doc.toString();
}
