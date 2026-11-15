import { z } from 'zod';

import {
  HOST_KNOWLEDGE_READ_TOOL,
  HOST_KNOWLEDGE_SEARCH_TOOL,
} from '../agents/chat.types';
import type { RunPlace } from '../projects/projects.types';
import { type AgentKind, AgentKindSchema } from '../runs/runs.types';

/**
 * `proposed` is an agent's new document waiting on the user, invisible to every
 * agent; `archived` keeps its handle and text out of every agent's reach.
 */
export const KNOWLEDGE_STATUSES = ['proposed', 'active', 'archived'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

/** What the user's list filters on: `waiting` is anything needing a review. */
export const KNOWLEDGE_LIST_STATUSES = [
  'active',
  'waiting',
  'archived',
] as const;
export type KnowledgeListStatus = (typeof KNOWLEDGE_LIST_STATUSES)[number];

export const KNOWLEDGE_REVISION_STATUSES = [
  'applied',
  'pending',
  'rejected',
] as const;
export type KnowledgeRevisionStatus =
  (typeof KNOWLEDGE_REVISION_STATUSES)[number];

export const KNOWLEDGE_ACTOR_KINDS = ['user', 'agent', 'analysis'] as const;
export type KnowledgeActorKind = (typeof KNOWLEDGE_ACTOR_KINDS)[number];

export const KNOWLEDGE_AGENT_WRITES = ['review', 'direct', 'off'] as const;
export type KnowledgeAgentWrites = (typeof KNOWLEDGE_AGENT_WRITES)[number];

/**
 * A level a run may file under; which project or team is the run's own.
 *
 * TWIN PARSER: `PLACE_LEVELS` in `apps/ui/src/renderer/chats/knowledge-tool-row.tsx`.
 */
export const KNOWLEDGE_PLACE_LEVELS = ['project', 'team', 'global'] as const;
export type KnowledgePlaceLevel = (typeof KNOWLEDGE_PLACE_LEVELS)[number];

export const KNOWLEDGE_BODY_MAX_BYTES = 256 * 1024;
export const KNOWLEDGE_HANDLE_MAX_CHARS = 80;
export const KNOWLEDGE_TITLE_MAX_CHARS = 200;
export const KNOWLEDGE_WHEN_MAX_CHARS = 300;
export const KNOWLEDGE_REASON_MAX_CHARS = 300;
export const KNOWLEDGE_INDEX_MAX_BYTES = 2048;
export const KNOWLEDGE_PENDING_MAX = 20;
export const KNOWLEDGE_REVISIONS_KEPT = 50;
export const KNOWLEDGE_SEARCH_DEFAULT = 10;
export const KNOWLEDGE_SEARCH_MAX = 30;
export const KNOWLEDGE_QUERY_MAX_CHARS = 300;
/** How many rows of a filter the page's search ranks. */
export const KNOWLEDGE_LIST_SEARCH_POOL = 2000;
export const KNOWLEDGE_EDITS_MAX = 50;
export const KNOWLEDGE_LIST_LIMIT_DEFAULT = 50;
export const KNOWLEDGE_LIST_LIMIT_MAX = 200;

/** Lowercase words of any script, digits and single hyphens between them. */
export const KNOWLEDGE_HANDLE_PATTERN =
  /^[\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}]+(?:-[\p{Ll}\p{Lm}\p{Lo}\p{M}\p{N}]+)*$/u;

/** A document's place on the wire: `project:<id>`, `team:<slug>` or `global`. */
const KnowledgePlaceKeySchema = z
  .string()
  .min(1)
  .max(250)
  .regex(/^(global|project:.+|team:.+)$/);

/** The first line of a run's knowledge index, as its agents read it. */
export const KNOWLEDGE_INDEX_PREFACE = `Knowledge index (written or approved by the user — read a body with ${HOST_KNOWLEDGE_READ_TOOL}, find more with ${HOST_KNOWLEDGE_SEARCH_TOOL}):`;

/**
 * The settings Electron main pushes (`PUT /v1/knowledge/config`); replaces
 * whatever the daemon held.
 *
 * TWIN PARSER: `knowledgeSchema` in `apps/ui/src/main/ipc-schemas.ts`.
 */
export const KnowledgeConfigSchema = z
  .object({
    enabled: z.boolean(),
    agentWrites: z.enum(KNOWLEDGE_AGENT_WRITES),
  })
  .meta({ id: 'KnowledgeConfig' });
export type KnowledgeConfig = z.infer<typeof KnowledgeConfigSchema>;

/** Until Electron's first push: on, and agent writes are saved at once. */
export const DEFAULT_KNOWLEDGE_CONFIG: KnowledgeConfig = {
  enabled: true,
  agentWrites: 'direct',
};

/** Who is writing; provenance comes from here, never from a tool's arguments. */
export type KnowledgeActor =
  | {
      kind: 'agent' | 'analysis';
      runId: string;
      memberId: string;
      agentKind: AgentKind | null;
      model: string | null;
    }
  | { kind: 'user' };

/** One document without its body: what lists, the index and visibility read. */
export interface KnowledgeHead {
  id: string;
  handle: string;
  placeKey: string;
  projectId: string | null;
  teamSlug: string | null;
  title: string;
  whenToRead: string;
  bodyBytes: number;
  status: KnowledgeStatus;
  rev: number;
  approvedAt: Date | null;
  sourceActor: KnowledgeActorKind;
  sourceRunId: string | null;
  sourceAgentKind: AgentKind | null;
  sourceModel: string | null;
  lastReadAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Where a knowledge call stands: the place it acts in and who is calling. */
export interface KnowledgeCallScope {
  place: RunPlace;
  actor: KnowledgeActor;
  /** The call named another place than the run's own. */
  elsewhere?: true;
}

/** The longest project id or team slug a knowledge call may name. */
export const KNOWLEDGE_PLACE_NAME_MAX_CHARS = 200;

const KnowledgeSourceSchema = z.object({
  actor: z.enum(KNOWLEDGE_ACTOR_KINDS),
  runId: z.string().nullable(),
  agentKind: AgentKindSchema.nullable(),
  model: z.string().nullable(),
});

/** One document without its text: what every listing carries. */
export const KnowledgeHeadSchema = z
  .object({
    id: z.string(),
    handle: z.string(),
    place: z.string(),
    projectId: z.string().nullable(),
    teamSlug: z.string().nullable(),
    title: z.string(),
    whenToRead: z.string(),
    bodyBytes: z.number().int(),
    status: z.enum(KNOWLEDGE_STATUSES),
    rev: z.number().int(),
    /** Revisions waiting on the user's review. */
    pending: z.number().int(),
    source: KnowledgeSourceSchema,
    createdAt: z.string(),
    updatedAt: z.string(),
    lastReadAt: z.string().nullable(),
    approvedAt: z.string().nullable(),
  })
  .meta({ id: 'KnowledgeHead' });
export type KnowledgeHeadDto = z.infer<typeof KnowledgeHeadSchema>;

export const KnowledgeDocumentSchema = z
  .object({ ...KnowledgeHeadSchema.shape, body: z.string() })
  .meta({ id: 'KnowledgeDocument' });
export type KnowledgeDocumentDto = z.infer<typeof KnowledgeDocumentSchema>;

/**
 * The user's list (`GET /v1/knowledge`), newest edit first and never the body.
 * Absent `place` lists every place; absent `status` lists `active`.
 */
export const KnowledgeListQuerySchema = z.object({
  place: KnowledgePlaceKeySchema.optional(),
  status: z.enum(KNOWLEDGE_LIST_STATUSES).optional(),
  q: z.string().trim().min(1).max(KNOWLEDGE_QUERY_MAX_CHARS).optional(),
  /** Exactly this handle, in whichever places hold it. */
  handle: z
    .string()
    .trim()
    .min(1)
    .max(KNOWLEDGE_HANDLE_MAX_CHARS * 4)
    .optional(),
  /** Only what this run's places hold, nearest first. */
  runId: z.string().min(1).max(100).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(KNOWLEDGE_LIST_LIMIT_MAX)
    .optional(),
  /** `next` from the previous page. */
  cursor: z.string().min(1).max(300).optional(),
});
export type KnowledgeListQuery = z.infer<typeof KnowledgeListQuerySchema>;

/**
 * What a run's own `knowledge_search` finds now, for a transcript row whose CLI
 * kept no result text. No query lists what the run sees, nearest first.
 */
export const KnowledgeRunSearchQuerySchema = z.object({
  q: z.string().trim().min(1).max(KNOWLEDGE_QUERY_MAX_CHARS).optional(),
});

export const KnowledgeRunSearchSchema = z.object({
  documents: z.array(KnowledgeHeadSchema),
});
export type KnowledgeRunSearch = z.infer<typeof KnowledgeRunSearchSchema>;

export const KnowledgeListSchema = z.object({
  documents: z.array(KnowledgeHeadSchema),
  next: z.string().nullable(),
});
export type KnowledgeList = z.infer<typeof KnowledgeListSchema>;

const KnowledgeTextFieldsSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(KNOWLEDGE_TITLE_MAX_CHARS * 4),
  whenToRead: z
    .string()
    .min(1)
    .max(KNOWLEDGE_WHEN_MAX_CHARS * 4),
  body: z
    .string()
    .min(1)
    .max(KNOWLEDGE_BODY_MAX_BYTES * 4),
  handle: z
    .string()
    .min(1)
    .max(KNOWLEDGE_HANDLE_MAX_CHARS * 4)
    .optional(),
});

/** The user's own new document; no `handle` derives one from the title. */
export const KnowledgeCreateSchema = KnowledgeTextFieldsSchema.extend({
  place: KnowledgePlaceKeySchema,
});
export type KnowledgeCreateInput = z.infer<typeof KnowledgeCreateSchema>;

/** The user's edit of a document at the `rev` it was read at. */
export const KnowledgePatchSchema = KnowledgeTextFieldsSchema.extend({
  rev: z.number().int().min(1),
});
export type KnowledgePatch = z.infer<typeof KnowledgePatchSchema>;

/** One find-and-replace of an agent's change. */
export interface KnowledgeEdit {
  find: string;
  replace: string;
}

/** What `knowledge_save` was asked for, read from the model's arguments. */
export interface KnowledgeSaveInput {
  handle?: string;
  rev?: number;
  title?: string;
  whenToRead?: string;
  body?: string;
  edits?: KnowledgeEdit[];
  place?: KnowledgePlaceLevel;
  reason: string;
}

/** A recommendation the user applied, as the store writes it. */
export interface KnowledgeItemWrite {
  kind: 'add' | 'update' | 'retire';
  /** The place key: `project:<id>`, `team:<slug>` or `global`. */
  place: string;
  handle?: string;
  rev?: number;
  title?: string;
  whenToRead?: string;
  /** The whole text as it should read; a retire's is only why it goes. */
  body: string;
  reason: string;
}

export const KNOWLEDGE_REFUSAL_CODES = [
  'KNOWLEDGE_DISABLED',
  'KNOWLEDGE_READ_ONLY',
  'INVALID_DOCUMENT',
  'INVALID_EDITS',
  'CONTAINS_SECRET',
  'NOT_FOUND',
  'NOT_EDITABLE',
  'HANDLE_TAKEN',
  'NO_PROJECT',
  'NO_TEAM',
  'PROPOSAL_STALE',
  'TOO_MANY_PROPOSALS',
] as const;
export type KnowledgeRefusalCode = (typeof KNOWLEDGE_REFUSAL_CODES)[number];

export interface KnowledgeRefusal {
  kind: 'refused';
  code: KnowledgeRefusalCode;
  reason: string;
}

/**
 * `applied` reached the document; `proposed` waits on the user and left it as
 * it was, so an agent is told nothing changed yet.
 */
export type KnowledgeSaveOutcome =
  | { kind: 'applied'; document: KnowledgeDocumentDto; created: boolean }
  | { kind: 'proposed'; document: KnowledgeHeadDto; created: boolean }
  | { kind: 'stale'; current: KnowledgeDocumentDto }
  | KnowledgeRefusal;

/** What writing a recommendation came to. */
export type KnowledgeItemOutcome =
  KnowledgeSaveOutcome | { kind: 'archived'; document: KnowledgeHeadDto };

export type KnowledgeRead =
  | { kind: 'found'; document: KnowledgeDocumentDto }
  | { kind: 'missing'; similar: string[] };

/** One hit an agent reads: never a body. */
export interface KnowledgeHit {
  handle: string;
  title: string;
  whenToRead: string;
  level: KnowledgePlaceLevel;
  rev: number;
  bodyBytes: number;
  reviewed: boolean;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** How many documents the run sees, or match; more than `hits` when cut. */
  total: number;
}

export const KnowledgeRevisionHeadSchema = z
  .object({
    id: z.string(),
    documentId: z.string(),
    rev: z.number().int().nullable(),
    status: z.enum(KNOWLEDGE_REVISION_STATUSES),
    baseRev: z.number().int(),
    title: z.string(),
    whenToRead: z.string(),
    bodyBytes: z.number().int(),
    reason: z.string().nullable(),
    source: KnowledgeSourceSchema.extend({ memberId: z.string().nullable() }),
    createdAt: z.string(),
    decidedAt: z.string().nullable(),
  })
  .meta({ id: 'KnowledgeRevisionHead' });
export type KnowledgeRevisionHeadDto = z.infer<
  typeof KnowledgeRevisionHeadSchema
>;

export const KnowledgeRevisionListSchema = z.object({
  revisions: z.array(KnowledgeRevisionHeadSchema),
});
export type KnowledgeRevisionList = z.infer<typeof KnowledgeRevisionListSchema>;

/** One revision whole, with the unified diff against what it was made from. */
export const KnowledgeRevisionDetailSchema = z.object({
  ...KnowledgeRevisionHeadSchema.shape,
  body: z.string(),
  diff: z.string(),
  /** A pending change whose base the document has moved past. */
  stale: z.boolean(),
  /** False when the version it was made from is no longer kept, so `diff` is empty. */
  baseKept: z.boolean(),
  document: KnowledgeHeadSchema,
});
export type KnowledgeRevisionDetail = z.infer<
  typeof KnowledgeRevisionDetailSchema
>;

/** Restoring an old version writes it as a new one, at the `rev` read. */
export const KnowledgeRevisionRestoreSchema = z.object({
  rev: z.number().int().min(1),
});

export const KnowledgeCountsSchema = z.object({
  places: z.array(
    z.object({
      place: z.string(),
      active: z.number().int(),
      waiting: z.number().int(),
      /** Every document filed there, whatever its status. */
      documents: z.number().int(),
    }),
  ),
  active: z.number().int(),
  waiting: z.number().int(),
});
export type KnowledgeCounts = z.infer<typeof KnowledgeCountsSchema>;

/** One document, or every active document of one place. */
export const KnowledgeExportQuerySchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    place: KnowledgePlaceKeySchema.optional(),
  })
  .refine((query) => (query.id === undefined) !== (query.place === undefined), {
    message: 'name one document or one place',
  });
export type KnowledgeExportQuery = z.infer<typeof KnowledgeExportQuerySchema>;

export const KnowledgeExportSchema = z.object({
  markdown: z.string(),
  count: z.number().int(),
  /** A file name that says what was exported. */
  name: z.string(),
});
export type KnowledgeExport = z.infer<typeof KnowledgeExportSchema>;

export const KnowledgeRemovedSchema = z.object({ deleted: z.boolean() });

export const KNOWLEDGE_CHANGES = [
  'created',
  'updated',
  'proposed',
  'approved',
  'rejected',
  'archived',
  'restored',
  'deleted',
  'bulk',
] as const;
export type KnowledgeChange = (typeof KNOWLEDGE_CHANGES)[number];

/**
 * One knowledge write, for the gateway's `knowledge_changed` broadcast. Ids and
 * place only: every client re-reads what it shows.
 *
 * TWIN PARSER: `parseKnowledgeChanged` in `apps/ui/src/renderer/daemon-client.ts`.
 */
export interface KnowledgeChangedEvent {
  /** Null for a change to many documents at once (`bulk`). */
  documentId: string | null;
  change: KnowledgeChange;
  place: string | null;
}

/** `knowledge_documents`, its revisions and its FTS table, as Kysely reads them. */
export interface KnowledgeTextDatabase {
  knowledge_documents: {
    rowid: number;
    id: string;
    handle: string;
    place_key: string;
    project_id: string | null;
    team_slug: string | null;
    title: string;
    when_to_read: string;
    body: string;
    body_bytes: number;
    status: KnowledgeStatus;
    rev: number;
    approved_at: number | null;
    source_actor: KnowledgeActorKind;
    source_run_id: string | null;
    source_agent_kind: AgentKind | null;
    source_model: string | null;
    last_read_at: number | null;
    created_at: number;
    updated_at: number;
    deleted_at: number | null;
  };
  knowledge_revisions: {
    id: string;
    document_id: string;
    rev: number | null;
    status: KnowledgeRevisionStatus;
    created_at: number;
  };
  knowledge_fts: {
    rowid: number;
    document_id: string;
    title: string;
    when_to_read: string;
    body: string;
    knowledge_fts: string;
    rank: number;
  };
  sqlite_master: { type: string; name: string };
}
