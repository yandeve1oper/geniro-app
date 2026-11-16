import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import {
  chatTextMatchQuery,
  chatTextQueryTerms,
} from '../../agents/utils/chat-text-query';
import {
  hasHiddenText,
  withoutHiddenText,
} from '../../agents/utils/hidden-text';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { MemoryService } from '../../memory/services/memory.service';
import { ProjectDao } from '../../projects/dao/project.dao';
import type {
  KnowledgeFate,
  KnowledgeRenamed,
  ProjectKnowledgeRemoval,
  RunPlace,
  RunPlaceFacts,
} from '../../projects/projects.types';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { KnowledgeDocumentDao } from '../dao/knowledge-document.dao';
import { KnowledgeRevisionDao } from '../dao/knowledge-revision.dao';
import { KnowledgeDocument } from '../entity/knowledge-document.entity';
import { KnowledgeRevision } from '../entity/knowledge-revision.entity';
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  KNOWLEDGE_BODY_MAX_BYTES,
  KNOWLEDGE_HANDLE_MAX_CHARS,
  KNOWLEDGE_HANDLE_PATTERN,
  KNOWLEDGE_LIST_LIMIT_DEFAULT,
  KNOWLEDGE_LIST_SEARCH_POOL,
  KNOWLEDGE_PENDING_MAX,
  KNOWLEDGE_REASON_MAX_CHARS,
  KNOWLEDGE_REVISIONS_KEPT,
  KNOWLEDGE_SEARCH_DEFAULT,
  KNOWLEDGE_SEARCH_MAX,
  KNOWLEDGE_TITLE_MAX_CHARS,
  KNOWLEDGE_WHEN_MAX_CHARS,
  type KnowledgeActor,
  type KnowledgeCallScope,
  type KnowledgeChange,
  type KnowledgeConfig,
  type KnowledgeCounts,
  type KnowledgeCreateInput,
  type KnowledgeDocumentDto,
  type KnowledgeExport,
  type KnowledgeExportQuery,
  type KnowledgeHead,
  type KnowledgeHeadDto,
  type KnowledgeHit,
  type KnowledgeItemOutcome,
  type KnowledgeItemWrite,
  type KnowledgeList,
  type KnowledgeListQuery,
  type KnowledgePatch,
  type KnowledgeRead,
  type KnowledgeRefusal,
  type KnowledgeRefusalCode,
  type KnowledgeRevisionDetail,
  type KnowledgeRevisionHeadDto,
  type KnowledgeRevisionList,
  type KnowledgeRunSearch,
  type KnowledgeSaveInput,
  type KnowledgeSaveOutcome,
  type KnowledgeSearchResult,
} from '../knowledge.types';
import {
  knowledgeDiff,
  knowledgeExportMarkdown,
} from '../utils/knowledge-export';
import {
  applyEdits,
  firstHiddenLine,
  freeHandle,
  GLOBAL_PLACE_KEY,
  handleFromTitle,
  knowledgeIndexText,
  levelOfKey,
  nearestOf,
  placeKeyOf,
  placeKeysOf,
  placeOfKey,
} from '../utils/knowledge-text';
import { KnowledgeEventBus } from './knowledge-events.bus';

const USER: KnowledgeActor = { kind: 'user' };

/** Similar handles a failed read names. */
const SIMILAR_NAMED = 3;

/** What a write stores, whoever writes it. */
interface KnowledgeText {
  title: string;
  whenToRead: string;
  body: string;
}

/** What settling a removed place did. */
interface PlaceSettled {
  moved: number;
  deleted: number;
  renamed: KnowledgeRenamed[];
}

/**
 * The knowledge store. Every write is made here — the user's and an agent's —
 * and each is serialized, so a handle is taken and a rev compared against a
 * table no other write is changing. What an agent may read goes through
 * {@link visibleHeads}, the one visibility rule.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private config: KnowledgeConfig = DEFAULT_KNOWLEDGE_CONFIG;
  private configured = false;
  private teamExists: ((slug: string) => Promise<boolean>) | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly em: EntityManager,
    private readonly documents: KnowledgeDocumentDao,
    private readonly revisionRows: KnowledgeRevisionDao,
    private readonly projects: ProjectDao,
    private readonly scope: ProjectScopeService,
    private readonly memory: MemoryService,
    private readonly events: KnowledgeEventBus,
  ) {}

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Whether `knowledge_save` is on the tool list at all. */
  get agentsMayWrite(): boolean {
    return this.config.enabled && this.config.agentWrites !== 'off';
  }

  setConfig(config: KnowledgeConfig): KnowledgeConfig {
    this.config = { ...config };
    this.configured = true;
    return this.config;
  }

  /**
   * How the user's own writes learn whether a team exists; registered by the
   * teams module, which this module may not import.
   */
  useTeamLookup(lookup: (slug: string) => Promise<boolean>): void {
    this.teamExists = lookup;
  }

  /** Where a tool call on this run stands; a run's place is never an argument. */
  async callScope(
    runId: string,
    memberId: string,
  ): Promise<KnowledgeCallScope> {
    const [place, actor] = await Promise.all([
      this.memory.scopeOf(runId),
      this.memory.actorOf(runId, memberId),
    ]);
    if (actor.kind !== 'agent' && actor.kind !== 'analysis') {
      throw new BadRequestException(
        'KNOWLEDGE_ACTOR',
        `a tool call cannot write as ${actor.kind}`,
      );
    }
    return { place, actor: { ...actor, memberId } };
  }

  /** A place a chat named instead of its own, or why there is no such place. */
  async placeNamed(place: RunPlace): Promise<RunPlace | KnowledgeRefusal> {
    return (await this.refuseUnknownPlace(place, this.em.fork())) ?? place;
  }

  /**
   * What a new run keeps of the store for its whole life. Taken once, at
   * creation: it reaches `AgentAdapter.sessionKey`, so a live read would
   * respawn a kept CLI whenever a document changed. Until Electron's first
   * push the daemon holds only the default, which may not be the user's, so a
   * run is created without an index rather than with a setting nobody chose.
   */
  async runSnapshot(
    facts: RunPlaceFacts,
  ): Promise<{ knowledgeIndex: string | null }> {
    if (!this.configured || !this.enabled) {
      return { knowledgeIndex: null };
    }
    try {
      const heads = await this.visibleHeads(await this.scope.placeFor(facts));
      return { knowledgeIndex: knowledgeIndexText(heads) };
    } catch (error) {
      this.logger.warn(
        `knowledge index not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { knowledgeIndex: null };
    }
  }

  /** The active documents a run in `place` sees: per handle, the nearest. */
  async visibleHeads(
    place: RunPlace,
    em: EntityManager = this.em.fork(),
  ): Promise<KnowledgeHead[]> {
    const placeKeys = placeKeysOf(place);
    return nearestOf(
      await this.documents.heads({ placeKeys, statuses: ['active'] }, em),
      placeKeys,
    );
  }

  /**
   * What a run in `place` sees: everything nearest first with no query, else
   * the best matches. When every term together finds nothing, any term will
   * do, since FTS5 has no Russian stemmer and a form may not match as a prefix.
   */
  async search(
    place: RunPlace,
    query: string | undefined,
    limit: number = KNOWLEDGE_SEARCH_DEFAULT,
  ): Promise<KnowledgeSearchResult> {
    const em = this.em.fork();
    const cap = Math.min(Math.max(limit, 1), KNOWLEDGE_SEARCH_MAX);
    const hits = await this.visibleMatches(place, query, em);
    return { hits: hits.slice(0, cap).map(toHit), total: hits.length };
  }

  /** {@link search} for the run itself, as the transcript reads it back. */
  async runSearch(
    runId: string,
    query: string | undefined,
  ): Promise<KnowledgeRunSearch> {
    const em = this.em.fork();
    const hits = await this.visibleMatches(
      await this.memory.scopeOf(runId),
      query,
      em,
    );
    return {
      documents: await this.toHeads(hits.slice(0, KNOWLEDGE_SEARCH_MAX), em),
    };
  }

  private async visibleMatches(
    place: RunPlace,
    query: string | undefined,
    em: EntityManager,
  ): Promise<KnowledgeHead[]> {
    const heads = await this.visibleHeads(place, em);
    const text = query?.trim() ?? '';
    if (text.length === 0) {
      return heads;
    }
    return this.rankedMatches(text, heads, em);
  }

  /** Of `heads`, what `text` finds, best first: see {@link matchingIds}. */
  private async rankedMatches(
    text: string,
    heads: readonly KnowledgeHead[],
    em: EntityManager,
  ): Promise<KnowledgeHead[]> {
    const ids = await this.matchingIds(text, heads, em);
    const byId = new Map(heads.map((head) => [head.id, head]));
    return ids
      .map((id) => byId.get(id))
      .filter((head): head is KnowledgeHead => head !== undefined);
  }

  /**
   * One active document a run in `place` sees, by handle; live, so an edit
   * reaches the next read. Reading stamps `lastReadAt`.
   */
  async read(place: RunPlace, handle: string): Promise<KnowledgeRead> {
    const em = this.em.fork();
    const heads = await this.visibleHeads(place, em);
    const wanted = handle.trim();
    const head = heads.find((row) => row.handle === wanted);
    const row = head ? await this.documents.getById(head.id, em) : null;
    if (!row || row.status !== 'active') {
      return {
        kind: 'missing',
        similar: await this.similar(wanted, heads, em),
      };
    }
    await this.documents.touch([row.id], new Date());
    return { kind: 'found', document: await this.toDocument(row, em) };
  }

  /** An agent's write: see the status rules in `.claude/rules/daemon-knowledge.md`. */
  save(
    actor: KnowledgeActor,
    input: KnowledgeSaveInput,
    place: RunPlace,
  ): Promise<KnowledgeSaveOutcome> {
    return this.serialize(() => this.saveNow(actor, input, place));
  }

  /**
   * Whether a recommendation could be written as it stands: its text, its place
   * and the document it acts on. Asked before a card goes up, so the user never
   * applies what the write would refuse.
   */
  async checkRecommended(
    write: KnowledgeItemWrite,
  ): Promise<KnowledgeRefusal | null> {
    const checked = await this.readyToWrite(write, this.em.fork());
    return 'code' in checked ? checked : null;
  }

  /**
   * A recommendation the user applied. Pressing Apply on the card that showed
   * this text is their review, so it is written whatever `agentWrites` says of an
   * agent's own write, and stands approved; only a read-only store refuses it.
   * Its author stays the agent that filed it.
   */
  applyRecommended(
    actor: KnowledgeActor,
    write: KnowledgeItemWrite,
  ): Promise<KnowledgeItemOutcome> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const ready = await this.readyToWrite(write, em);
      if ('code' in ready) {
        return ready;
      }
      const reason = write.reason.slice(0, KNOWLEDGE_REASON_MAX_CHARS);
      if (write.kind === 'add') {
        const taken = new Set([
          ...(await this.documents.handlesIn(ready.key, em)),
          ...(await this.visibleHeads(ready.place, em)).map(
            (head) => head.handle,
          ),
        ]);
        return this.createRow(
          actor,
          ready.text,
          ready.key,
          freeHandle(handleFromTitle(ready.text.title), taken),
          reason,
          em,
          true,
        );
      }
      if (ready.row === null) {
        return refused('NOT_FOUND', `no document ${write.handle} there`);
      }
      if (write.kind === 'update') {
        return this.applyToRow(
          ready.row,
          actor,
          ready.text,
          reason,
          em,
          null,
          true,
        );
      }
      ready.row.status = 'archived';
      await em.flush();
      this.publish(ready.row, 'archived');
      return {
        kind: 'archived',
        document: await this.toHeadDto(ready.row, em),
      };
    });
  }

  private async readyToWrite(
    write: KnowledgeItemWrite,
    em: EntityManager,
  ): Promise<
    | KnowledgeRefusal
    | {
        key: string;
        place: RunPlace;
        row: KnowledgeDocument | null;
        text: KnowledgeText;
      }
  > {
    if (!this.agentsMayWrite) {
      return refused(
        'KNOWLEDGE_READ_ONLY',
        'the user has knowledge off or read-only for agents',
      );
    }
    const place = placeOfKey(write.place);
    if (place === null) {
      return refused('INVALID_DOCUMENT', `no place ${write.place}`);
    }
    const unknown = await this.refuseUnknownPlace(place, em);
    if (unknown) {
      return unknown;
    }
    if (write.kind === 'add') {
      const text = {
        title: write.title ?? '',
        whenToRead: write.whenToRead ?? '',
        body: write.body,
      };
      return (
        refuseInvalid(text) ?? { key: write.place, place, row: null, text }
      );
    }
    const head = (
      await this.documents.heads(
        { placeKeys: [write.place], statuses: ['active'] },
        em,
      )
    ).find((entry) => entry.handle === write.handle);
    const row = head ? await this.documents.getById(head.id, em) : null;
    if (!row) {
      return refused('NOT_FOUND', `no document ${write.handle} there`);
    }
    if (write.rev !== row.rev) {
      return refused(
        'INVALID_DOCUMENT',
        `${row.handle} is at rev ${row.rev} now, not ${write.rev} — read it again`,
      );
    }
    const text = {
      title: write.title ?? row.title,
      whenToRead: write.whenToRead ?? row.whenToRead,
      body: write.kind === 'update' ? write.body : row.body,
    };
    return refuseInvalid(text) ?? { key: write.place, place, row, text };
  }

  /** One page of the user's list. */
  async list(query: KnowledgeListQuery): Promise<KnowledgeList> {
    const em = this.em.fork();
    const limit = query.limit ?? KNOWLEDGE_LIST_LIMIT_DEFAULT;
    const status = query.status ?? 'active';
    const runKeys =
      query.runId === undefined
        ? undefined
        : placeKeysOf(await this.memory.scopeOf(query.runId));
    const filter = {
      placeKey: query.place,
      placeKeys: runKeys,
      handle: query.handle,
      statuses:
        query.handle !== undefined && query.status === undefined
          ? (['active', 'proposed', 'archived'] as const)
          : status === 'waiting'
            ? []
            : [status],
      waitingIds:
        status === 'waiting'
          ? [...(await this.revisionRows.pendingCounts(null, em)).keys()]
          : undefined,
    };
    if (query.q !== undefined) {
      const pool = await this.documents.page(
        { ...filter, limit: KNOWLEDGE_LIST_SEARCH_POOL },
        em,
      );
      const ranked = await this.rankedMatches(query.q, pool, em);
      return {
        documents: await this.toHeads(ranked.slice(0, limit), em),
        next: null,
      };
    }
    const heads = await this.documents.page(
      { ...filter, before: parseCursor(query.cursor), limit },
      em,
    );
    const last = heads.at(-1);
    const ordered = runKeys
      ? heads.toSorted(
          (a, b) => runKeys.indexOf(a.placeKey) - runKeys.indexOf(b.placeKey),
        )
      : heads;
    return {
      documents: await this.toHeads(ordered, em),
      next:
        heads.length === limit && last
          ? `${last.updatedAt.getTime()}_${last.id}`
          : null,
    };
  }

  /** One document by id, whatever its status or place — the user's read. */
  async get(id: string): Promise<KnowledgeDocumentDto | null> {
    const em = this.em.fork();
    const row = await this.documents.getById(id, em);
    return row ? this.toDocument(row, em) : null;
  }

  async counts(): Promise<KnowledgeCounts> {
    const em = this.em.fork();
    const rows = await this.documents.countsByPlace(em);
    const pending = await this.revisionRows.pendingCounts(null, em);
    const heads =
      pending.size === 0
        ? []
        : await this.documents.heads({ statuses: ['active'] }, em);
    const places = new Map<
      string,
      { active: number; waiting: number; documents: number }
    >();
    const entry = (place: string) => {
      const held = places.get(place) ?? { active: 0, waiting: 0, documents: 0 };
      places.set(place, held);
      return held;
    };
    for (const row of rows) {
      const held = entry(row.placeKey);
      held.documents += row.count;
      if (row.status === 'active') {
        held.active += row.count;
      } else if (row.status === 'proposed') {
        held.waiting += row.count;
      }
    }
    for (const head of heads) {
      if (pending.has(head.id)) {
        entry(head.placeKey).waiting += 1;
      }
    }
    const list = [...places].map(([place, counts]) => ({ place, ...counts }));
    return {
      places: list,
      active: list.reduce((sum, row) => sum + row.active, 0),
      waiting: list.reduce((sum, row) => sum + row.waiting, 0),
    };
  }

  /** The user's own new document, filed where the user chose. */
  create(raw: KnowledgeCreateInput): Promise<KnowledgeSaveOutcome> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const input = withoutHiddenCharacters(raw);
      const invalid = refuseInvalid(input);
      if (invalid) {
        return invalid;
      }
      const place = placeOfKey(input.place);
      if (place === null) {
        return refused('INVALID_DOCUMENT', `no place ${input.place}`);
      }
      const unknown = await this.refuseUnknownPlace(place, em);
      if (unknown) {
        return unknown;
      }
      const taken = await this.documents.handlesIn(input.place, em);
      const handle = input.handle?.trim();
      if (handle !== undefined) {
        const bad = refuseBadHandle(handle, taken);
        if (bad) {
          return bad;
        }
      }
      return this.createRow(
        USER,
        input,
        input.place,
        handle ?? freeHandle(handleFromTitle(input.title), taken),
        null,
        em,
      );
    });
  }

  /**
   * The user's edit at the `rev` it was read at. A proposed document is
   * approved or rejected first, and an archived one restored first.
   */
  edit(id: string, raw: KnowledgePatch): Promise<KnowledgeSaveOutcome> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const patch = withoutHiddenCharacters(raw);
      const row = await this.documents.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no document ${id}`);
      }
      if (row.status !== 'active') {
        return refused(
          'NOT_EDITABLE',
          row.status === 'archived'
            ? 'restore the document before editing it'
            : 'approve or reject the proposal before editing it',
        );
      }
      if (patch.rev !== row.rev) {
        return { kind: 'stale', current: await this.toDocument(row, em) };
      }
      const invalid = refuseInvalid(patch);
      if (invalid) {
        return invalid;
      }
      const handle = patch.handle?.trim();
      if (handle !== undefined && handle !== row.handle) {
        const bad = refuseBadHandle(
          handle,
          await this.documents.handlesIn(row.placeKey, em),
        );
        if (bad) {
          return bad;
        }
        row.handle = handle;
      }
      return this.applyToRow(row, USER, patch, null, em);
    });
  }

  /** Archive or restore; the user's only, and never on a proposed document. */
  setStatus(
    id: string,
    status: 'active' | 'archived',
  ): Promise<{ kind: 'changed'; head: KnowledgeHeadDto } | KnowledgeRefusal> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const row = await this.documents.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no document ${id}`);
      }
      if (row.status === 'proposed') {
        return refused(
          'NOT_EDITABLE',
          'approve or reject the proposal instead',
        );
      }
      if (row.status !== status) {
        row.status = status;
        await em.flush();
        this.publish(row, status === 'archived' ? 'archived' : 'restored');
      }
      return { kind: 'changed', head: await this.toHeadDto(row, em) };
    });
  }

  /**
   * Put an active document into every new run's knowledge index, or keep it
   * to search only. The index lists only documents the user wrote or took in.
   */
  setIndexed(
    id: string,
    indexed: boolean,
  ): Promise<{ kind: 'changed'; head: KnowledgeHeadDto } | KnowledgeRefusal> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const row = await this.documents.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no document ${id}`);
      }
      if (row.status !== 'active') {
        return refused(
          'NOT_EDITABLE',
          row.status === 'proposed'
            ? 'approve or reject the proposal instead'
            : 'restore the document first',
        );
      }
      if ((row.approvedAt !== null) !== indexed) {
        row.approvedAt = indexed ? new Date() : null;
        const current = await this.revisionRows.appliedAt(row.id, row.rev, em);
        if (current) {
          current.approvedAt = row.approvedAt;
        }
        await em.flush();
        this.publish(row, indexed ? 'approved' : 'updated');
      }
      return { kind: 'changed', head: await this.toHeadDto(row, em) };
    });
  }

  /** Permanently delete an archived document and its revisions. */
  remove(id: string): Promise<KnowledgeRefusal | null> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const row = await this.documents.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no document ${id}`);
      }
      if (row.status !== 'archived') {
        return refused(
          'NOT_EDITABLE',
          'only an archived document is deleted for good',
        );
      }
      await this.hardDelete(row.id, em);
      this.publish(row, 'deleted');
      return null;
    });
  }

  /** Newest first, without bodies. */
  async revisions(documentId: string): Promise<KnowledgeRevisionList> {
    const rows = await this.revisionRows.heads(documentId, this.em.fork());
    return { revisions: rows.map(toRevisionHead) };
  }

  /** One revision whole, with the diff from the version it was made against. */
  async revision(id: string): Promise<KnowledgeRevisionDetail | null> {
    const em = this.em.fork();
    const row = await this.revisionRows.getById(id, em);
    const document = row
      ? await this.documents.headById(row.documentId, em)
      : null;
    if (!row || !document) {
      return null;
    }
    const base = await this.revisionRows.appliedAt(
      row.documentId,
      row.baseRev,
      em,
    );
    const baseKept = base !== null || row.baseRev === 0;
    return {
      ...toRevisionHead(row),
      body: row.body,
      diff: baseKept ? knowledgeDiff(document.handle, base, row) : '',
      baseKept,
      stale: row.status === 'pending' && row.baseRev !== document.rev,
      document: toHeadWire(
        document,
        (await this.revisionRows.pendingCounts([document.id], em)).get(
          document.id,
        ) ?? 0,
      ),
    };
  }

  /**
   * Publish a proposal, refused when the document has moved past what it was
   * made against: approving it would overwrite newer text unseen.
   */
  approve(revisionId: string): Promise<KnowledgeSaveOutcome> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const found = await this.pendingRevision(revisionId, em);
      if ('code' in found) {
        return found;
      }
      const { revision, row } = found;
      if (row.status === 'archived') {
        return refused(
          'NOT_EDITABLE',
          'restore the document before approving the change',
        );
      }
      if (revision.baseRev !== row.rev) {
        return refused(
          'PROPOSAL_STALE',
          `the document moved on to rev ${row.rev} after this was proposed against rev ${revision.baseRev}`,
        );
      }
      const now = new Date();
      row.rev += 1;
      row.title = revision.title;
      row.whenToRead = revision.whenToRead;
      row.body = revision.body;
      row.bodyBytes = revision.bodyBytes;
      row.status = 'active';
      row.approvedAt = now;
      stampSource(row, revision);
      revision.status = 'applied';
      revision.rev = row.rev;
      revision.decidedAt = now;
      revision.approvedAt = now;
      await em.flush();
      await this.revisionRows.trim(row.id, KNOWLEDGE_REVISIONS_KEPT, em);
      this.publish(row, 'approved');
      return {
        kind: 'applied',
        document: await this.toDocument(row, em),
        created: false,
      };
    });
  }

  /**
   * Turn a proposal down. A proposed document goes with it, which frees its
   * handle; a change stays on the record, marked rejected.
   */
  reject(
    revisionId: string,
  ): Promise<{ kind: 'rejected'; deleted: boolean } | KnowledgeRefusal> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const found = await this.pendingRevision(revisionId, em);
      if ('code' in found) {
        return found;
      }
      const { revision, row } = found;
      if (row.status === 'proposed') {
        await this.hardDelete(row.id, em);
        this.publish(row, 'rejected');
        return { kind: 'rejected', deleted: true };
      }
      revision.status = 'rejected';
      revision.decidedAt = new Date();
      await em.flush();
      await this.revisionRows.trim(row.id, KNOWLEDGE_REVISIONS_KEPT, em);
      this.publish(row, 'rejected');
      return { kind: 'rejected', deleted: false };
    });
  }

  /** Write an old version as the newest one, at the `rev` the user read. */
  restoreRevision(
    revisionId: string,
    rev: number,
  ): Promise<KnowledgeSaveOutcome> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const old = await this.revisionRows.getById(revisionId, em);
      const row = old ? await this.documents.getById(old.documentId, em) : null;
      if (!old || !row || old.status !== 'applied') {
        return refused('NOT_FOUND', `no version ${revisionId} to restore`);
      }
      if (row.status !== 'active') {
        return refused(
          'NOT_EDITABLE',
          'restore the document before restoring a version of it',
        );
      }
      if (rev !== row.rev) {
        return { kind: 'stale', current: await this.toDocument(row, em) };
      }
      return this.applyToRow(row, USER, old, null, em, old);
    });
  }

  /** Markdown of one document or of a place's active documents. */
  async exportMarkdown(
    query: KnowledgeExportQuery,
  ): Promise<KnowledgeExport | null> {
    const em = this.em.fork();
    if (query.id !== undefined) {
      const row = await this.documents.getById(query.id, em);
      if (!row) {
        return null;
      }
      return {
        markdown: knowledgeExportMarkdown([row]),
        count: 1,
        name: `${row.handle}.md`,
      };
    }
    const place = query.place ?? GLOBAL_PLACE_KEY;
    const heads = await this.documents.heads(
      { placeKeys: [place], statuses: ['active'] },
      em,
    );
    if (heads.length === 0) {
      return null;
    }
    const rows = await this.documents.getAll(
      { id: { $in: heads.map((head) => head.id) } },
      { orderBy: { handle: 'asc' } },
      em,
    );
    return {
      markdown: knowledgeExportMarkdown(rows),
      count: rows.length,
      name: `knowledge-${place.replace(/[^\p{L}\p{N}]+/gu, '-')}.md`,
    };
  }

  /**
   * A removed project's documents, inside the removal's transaction: every
   * statement is on `tx`, and no write queue, because a forked statement or a
   * queued write awaited here would wait on the lock this transaction holds.
   */
  async settleRemovedProject(
    projectId: string,
    fate: KnowledgeFate,
    tx: EntityManager,
  ): Promise<ProjectKnowledgeRemoval> {
    const settled = await this.settlePlace(
      placeKeyOf({ projectId, teamSlug: null }),
      fate,
      tx,
    );
    return {
      ...settled,
      announce: () => {
        if (settled.moved + settled.deleted > 0) {
          this.publishBulk(fate);
        }
      },
    };
  }

  /** What the user chose for a deleted team's documents. */
  settleDeletedTeam(slug: string, fate: KnowledgeFate): Promise<PlaceSettled> {
    return this.serialize(async () => {
      const settled = await this.em
        .fork()
        .transactional((tx) =>
          this.settlePlace(
            placeKeyOf({ projectId: null, teamSlug: slug }),
            fate,
            tx,
          ),
        );
      if (settled.moved + settled.deleted > 0) {
        this.publishBulk(fate);
      }
      return settled;
    });
  }

  private async settlePlace(
    placeKey: string,
    fate: KnowledgeFate,
    tx: EntityManager,
  ): Promise<PlaceSettled> {
    const rows = await this.documents.idsIn(placeKey, tx);
    if (fate === 'delete') {
      const ids = rows.map((row) => row.id);
      await this.revisionRows.deleteForDocuments(ids, tx);
      await this.documents.deleteIds(ids, tx);
      return { moved: 0, deleted: rows.length, renamed: [] };
    }
    const taken = await this.documents.handlesIn(GLOBAL_PLACE_KEY, tx);
    const renamed: KnowledgeRenamed[] = [];
    for (const row of rows) {
      const handle = freeHandle(row.handle, taken);
      taken.add(handle);
      await this.documents.refileAsGlobal(row.id, handle, tx);
      if (handle !== row.handle) {
        renamed.push({ from: row.handle, to: handle });
      }
    }
    return { moved: rows.length, deleted: 0, renamed };
  }

  private async saveNow(
    actor: KnowledgeActor,
    input: KnowledgeSaveInput,
    place: RunPlace,
  ): Promise<KnowledgeSaveOutcome> {
    if (!this.config.enabled) {
      return refused('KNOWLEDGE_DISABLED', 'the user has turned knowledge off');
    }
    if (this.config.agentWrites === 'off') {
      return refused(
        'KNOWLEDGE_READ_ONLY',
        'the user lets agents read knowledge, not write it — tell the user what should change',
      );
    }
    const reason = input.reason.trim();
    if (
      reason.length === 0 ||
      reason.length > KNOWLEDGE_REASON_MAX_CHARS ||
      hasHiddenText(reason, false)
    ) {
      return refused(
        'INVALID_DOCUMENT',
        `the reason must be one line of 1–${KNOWLEDGE_REASON_MAX_CHARS} characters`,
      );
    }
    if (redactSecrets(reason) !== reason) {
      return refused(
        'CONTAINS_SECRET',
        'the reason contains a secret geniro knows about; write it without one',
      );
    }
    const em = this.em.fork();
    return input.handle === undefined
      ? this.proposeNew(actor, input, reason, place, em)
      : this.changeVisible(actor, input, input.handle, reason, place, em);
  }

  private async proposeNew(
    actor: KnowledgeActor,
    input: KnowledgeSaveInput,
    reason: string,
    place: RunPlace,
    em: EntityManager,
  ): Promise<KnowledgeSaveOutcome> {
    const { title, whenToRead, body } = input;
    if (title === undefined || whenToRead === undefined || body === undefined) {
      return refused(
        'INVALID_DOCUMENT',
        'a new document takes title, whenToRead and body',
      );
    }
    const text = { title, whenToRead, body };
    const invalid = refuseInvalid(text);
    if (invalid) {
      return invalid;
    }
    const target = targetKey(input, place);
    if ('code' in target) {
      return target;
    }
    const unknown = await this.refuseUnknownPlace(
      placeOfKey(target.key) ?? place,
      em,
    );
    if (unknown) {
      return unknown;
    }
    // Visible handles too: an agent's nearer document must not take over a
    // handle the run's instructions already cite.
    const taken = new Set([
      ...(await this.documents.handlesIn(target.key, em)),
      ...(await this.visibleHeads(place, em)).map((head) => head.handle),
    ]);
    return this.createRow(
      actor,
      text,
      target.key,
      freeHandle(handleFromTitle(title), taken),
      reason,
      em,
    );
  }

  private async changeVisible(
    actor: KnowledgeActor,
    input: KnowledgeSaveInput,
    handle: string,
    reason: string,
    place: RunPlace,
    em: EntityManager,
  ): Promise<KnowledgeSaveOutcome> {
    if (input.body !== undefined) {
      return refused(
        'INVALID_DOCUMENT',
        'an existing document changes through edits, never a whole body',
      );
    }
    if (input.rev === undefined) {
      return refused(
        'INVALID_DOCUMENT',
        'quote the rev you read, from knowledge_read',
      );
    }
    const head = (await this.visibleHeads(place, em)).find(
      (row) => row.handle === handle.trim(),
    );
    const row = head ? await this.documents.getById(head.id, em) : null;
    if (!row) {
      return refused(
        'NOT_FOUND',
        `no document ${handle} this run can see — search again`,
      );
    }
    if (input.rev !== row.rev) {
      return { kind: 'stale', current: await this.toDocument(row, em) };
    }
    const edits = applyEdits(row.body, input.edits ?? []);
    if (!edits.ok) {
      return refused('INVALID_EDITS', edits.problems.join('; '));
    }
    const text = {
      title: input.title ?? row.title,
      whenToRead: input.whenToRead ?? row.whenToRead,
      body: edits.body,
    };
    if (
      text.title === row.title &&
      text.whenToRead === row.whenToRead &&
      text.body === row.body
    ) {
      return refused('INVALID_DOCUMENT', 'that changes nothing');
    }
    const invalid = refuseInvalid(text);
    if (invalid) {
      return invalid;
    }
    if (this.config.agentWrites === 'direct') {
      return this.applyToRow(row, actor, text, reason, em);
    }
    const waiting = await this.revisionRows.pendingCounts([row.id], em);
    if ((waiting.get(row.id) ?? 0) >= KNOWLEDGE_PENDING_MAX) {
      return refused(
        'TOO_MANY_PROPOSALS',
        `${KNOWLEDGE_PENDING_MAX} changes to this document already wait on the user`,
      );
    }
    em.persist(revisionOf(row, text, actor, reason, 'pending', null));
    await em.flush();
    this.publish(row, 'proposed');
    return {
      kind: 'proposed',
      document: await this.toHeadDto(row, em),
      created: false,
    };
  }

  private async createRow(
    actor: KnowledgeActor,
    text: KnowledgeText,
    placeKey: string,
    handle: string,
    reason: string | null,
    em: EntityManager,
    approved = false,
  ): Promise<KnowledgeSaveOutcome> {
    const place = placeOfKey(placeKey) ?? { projectId: null, teamSlug: null };
    const review =
      !approved &&
      actor.kind !== 'user' &&
      this.config.agentWrites === 'review';
    const row = new KnowledgeDocument();
    row.handle = handle;
    row.placeKey = placeKey;
    row.projectId = place.projectId;
    row.teamSlug = place.teamSlug;
    row.status = review ? 'proposed' : 'active';
    row.rev = review ? 0 : 1;
    row.approvedAt = approved || actor.kind === 'user' ? new Date() : null;
    copyText(row, text);
    stampSource(row, sourceOf(actor));
    em.persist(row);
    em.persist(
      revisionOf(
        { ...text, id: row.id, handle, rev: 0 },
        text,
        actor,
        reason,
        review ? 'pending' : 'applied',
        review ? null : 1,
        approved,
      ),
    );
    await em.flush();
    this.publish(row, review ? 'proposed' : 'created');
    return review
      ? {
          kind: 'proposed',
          document: await this.toHeadDto(row, em),
          created: true,
        }
      : {
          kind: 'applied',
          document: await this.toDocument(row, em),
          created: true,
        };
  }

  /**
   * A new applied revision; only the user's or an approval keeps it reviewed.
   * Restoring text the user never took keeps it unreviewed, and its author's.
   */
  private async applyToRow(
    row: KnowledgeDocument,
    actor: KnowledgeActor,
    text: KnowledgeText,
    reason: string | null,
    em: EntityManager,
    restored: KnowledgeRevision | null = null,
    approved = false,
  ): Promise<KnowledgeSaveOutcome> {
    const nextRev = row.rev + 1;
    const revision = revisionOf(
      row,
      text,
      actor,
      reason,
      'applied',
      nextRev,
      approved,
    );
    if (restored?.approvedAt === null) {
      revision.approvedAt = null;
      revision.sourceMemberId = restored.sourceMemberId;
      stampSource(revision, restored);
    }
    em.persist(revision);
    copyText(row, text);
    row.rev = nextRev;
    row.approvedAt = revision.approvedAt;
    stampSource(row, revision);
    await em.flush();
    await this.revisionRows.trim(row.id, KNOWLEDGE_REVISIONS_KEPT, em);
    this.publish(row, 'updated');
    return {
      kind: 'applied',
      document: await this.toDocument(row, em),
      created: false,
    };
  }

  private async pendingRevision(
    revisionId: string,
    em: EntityManager,
  ): Promise<
    { revision: KnowledgeRevision; row: KnowledgeDocument } | KnowledgeRefusal
  > {
    const revision = await this.revisionRows.getById(revisionId, em);
    const row = revision
      ? await this.documents.getById(revision.documentId, em)
      : null;
    if (!revision || !row || revision.status !== 'pending') {
      return refused('NOT_FOUND', `no proposal ${revisionId} waits on review`);
    }
    return { revision, row };
  }

  private async hardDelete(id: string, em: EntityManager): Promise<void> {
    await em.transactional(async (tx) => {
      await this.revisionRows.deleteForDocuments([id], tx);
      await this.documents.hardDeleteById(id, tx);
    });
  }

  private async matchingIds(
    text: string,
    heads: readonly KnowledgeHead[],
    em: EntityManager,
  ): Promise<string[]> {
    const ids = heads.map((head) => head.id);
    const every = chatTextMatchQuery(text);
    if (every === null) {
      return [];
    }
    const found = await this.documents.matchIds(every, ids, em);
    if (found.length > 0) {
      return found;
    }
    const terms = chatTextQueryTerms(text).filter((term) => term.length > 1);
    const any =
      terms.length > 1 ? chatTextMatchQuery(terms.join(' OR ')) : null;
    return any === null ? [] : this.documents.matchIds(any, ids, em);
  }

  /** Up to three visible handles a mistaken read may have meant. */
  private async similar(
    handle: string,
    heads: readonly KnowledgeHead[],
    em: EntityManager,
  ): Promise<string[]> {
    const byId = new Map(heads.map((head) => [head.id, head.handle]));
    const words = handle.replace(/-/g, ' ');
    const ids = await this.matchingIds(words, heads, em);
    return ids
      .map((id) => byId.get(id))
      .filter((name): name is string => name !== undefined)
      .slice(0, SIMILAR_NAMED);
  }

  private async refuseUnknownPlace(
    place: RunPlace,
    em: EntityManager,
  ): Promise<KnowledgeRefusal | null> {
    if (
      place.projectId !== null &&
      !(await this.projects.getById(place.projectId, em))
    ) {
      return refused('NO_PROJECT', `no project ${place.projectId}`);
    }
    if (
      place.teamSlug !== null &&
      this.teamExists !== null &&
      !(await this.teamExists(place.teamSlug))
    ) {
      return refused('NO_TEAM', `no team ${place.teamSlug}`);
    }
    return null;
  }

  private publish(row: KnowledgeDocument, change: KnowledgeChange): void {
    this.events.publish({
      documentId: row.id,
      change,
      place: row.placeKey,
    });
  }

  private publishBulk(fate: KnowledgeFate): void {
    this.events.publish({
      documentId: null,
      change: fate === 'delete' ? 'deleted' : 'bulk',
      place: null,
    });
  }

  private async toHeads(
    heads: readonly KnowledgeHead[],
    em: EntityManager,
  ): Promise<KnowledgeHeadDto[]> {
    const pending = await this.revisionRows.pendingCounts(
      heads.map((head) => head.id),
      em,
    );
    return heads.map((head) => toHeadWire(head, pending.get(head.id) ?? 0));
  }

  private async toHeadDto(
    row: KnowledgeDocument,
    em: EntityManager,
  ): Promise<KnowledgeHeadDto> {
    const pending = await this.revisionRows.pendingCounts([row.id], em);
    return toHeadWire(headOf(row), pending.get(row.id) ?? 0);
  }

  private async toDocument(
    row: KnowledgeDocument,
    em: EntityManager,
  ): Promise<KnowledgeDocumentDto> {
    return { ...(await this.toHeadDto(row, em)), body: row.body };
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function refused(code: KnowledgeRefusalCode, reason: string): KnowledgeRefusal {
  return { kind: 'refused', code, reason };
}

/** A person's text keeps its words; an agent's is refused, so the agent hears why. */
function withoutHiddenCharacters<T extends KnowledgeText>(text: T): T {
  return {
    ...text,
    title: withoutHiddenText(text.title, false),
    whenToRead: withoutHiddenText(text.whenToRead, false),
    body: withoutHiddenText(text.body, true),
  };
}

function refuseBadLine(
  label: string,
  value: string,
  maxChars: number,
): KnowledgeRefusal | null {
  if (value.length === 0) {
    return refused('INVALID_DOCUMENT', `${label} must not be empty`);
  }
  const chars = [...value].length;
  if (chars > maxChars) {
    return refused(
      'INVALID_DOCUMENT',
      `${label} is ${chars} characters; the limit is ${maxChars}`,
    );
  }
  if (hasHiddenText(value, false)) {
    return refused(
      'INVALID_DOCUMENT',
      `${label} holds a line break, a control or an invisible character`,
    );
  }
  return null;
}

function refuseInvalid(text: KnowledgeText): KnowledgeRefusal | null {
  const title = text.title.trim();
  const whenToRead = text.whenToRead.trim();
  const body = text.body.trim();
  const badLine =
    refuseBadLine('the title', title, KNOWLEDGE_TITLE_MAX_CHARS) ??
    refuseBadLine('when to read', whenToRead, KNOWLEDGE_WHEN_MAX_CHARS);
  if (badLine) {
    return badLine;
  }
  if (body.length === 0) {
    return refused('INVALID_DOCUMENT', 'the text must not be empty');
  }
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > KNOWLEDGE_BODY_MAX_BYTES) {
    return refused(
      'INVALID_DOCUMENT',
      `the text is ${bytes} bytes; the limit is ${KNOWLEDGE_BODY_MAX_BYTES}`,
    );
  }
  const hidden = firstHiddenLine(body, (line) => hasHiddenText(line, true));
  if (hidden !== null) {
    return refused(
      'INVALID_DOCUMENT',
      `line ${hidden} of the text holds a control or invisible character`,
    );
  }
  if (
    redactSecrets(title) !== title ||
    redactSecrets(whenToRead) !== whenToRead ||
    redactSecrets(body) !== body
  ) {
    return refused(
      'CONTAINS_SECRET',
      'the document contains a secret geniro knows about; never store credentials in it',
    );
  }
  return null;
}

function refuseBadHandle(
  handle: string,
  taken: ReadonlySet<string>,
): KnowledgeRefusal | null {
  if (
    [...handle].length > KNOWLEDGE_HANDLE_MAX_CHARS ||
    !KNOWLEDGE_HANDLE_PATTERN.test(handle)
  ) {
    return refused(
      'INVALID_DOCUMENT',
      `a handle is lowercase letters, digits and hyphens, at most ${KNOWLEDGE_HANDLE_MAX_CHARS} characters`,
    );
  }
  return taken.has(handle)
    ? refused('HANDLE_TAKEN', `${handle} is taken in this place`)
    : null;
}

/** Where a new document is filed: the level asked for, else the nearest the run has. */
function targetKey(
  input: KnowledgeSaveInput,
  place: RunPlace,
): { key: string } | KnowledgeRefusal {
  const level =
    input.place ??
    (place.projectId !== null
      ? 'project'
      : place.teamSlug !== null
        ? 'team'
        : 'global');
  if (level === 'project') {
    return place.projectId === null
      ? refused(
          'NO_PROJECT',
          'this run works in no project — save it with place: global',
        )
      : { key: placeKeyOf({ projectId: place.projectId, teamSlug: null }) };
  }
  if (level === 'team') {
    return place.teamSlug === null
      ? refused(
          'NO_TEAM',
          'this run is not a team run — save it with place: project or global',
        )
      : { key: placeKeyOf({ projectId: null, teamSlug: place.teamSlug }) };
  }
  return { key: GLOBAL_PLACE_KEY };
}

function parseCursor(
  cursor: string | undefined,
): { updatedAt: number; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const split = cursor.indexOf('_');
  const updatedAt = Number(cursor.slice(0, split));
  return split > 0 && Number.isFinite(updatedAt)
    ? { updatedAt, id: cursor.slice(split + 1) }
    : undefined;
}

function copyText(row: KnowledgeDocument, text: KnowledgeText): void {
  row.title = text.title.trim();
  row.whenToRead = text.whenToRead.trim();
  row.body = text.body.trim();
  row.bodyBytes = Buffer.byteLength(row.body, 'utf8');
}

/** Provenance as both rows carry it. */
interface KnowledgeSourceColumns {
  sourceActor: KnowledgeDocument['sourceActor'];
  sourceRunId: string | null;
  sourceAgentKind: KnowledgeDocument['sourceAgentKind'];
  sourceModel: string | null;
}

function sourceOf(actor: KnowledgeActor): KnowledgeSourceColumns {
  return actor.kind === 'user'
    ? {
        sourceActor: 'user',
        sourceRunId: null,
        sourceAgentKind: null,
        sourceModel: null,
      }
    : {
        sourceActor: actor.kind,
        sourceRunId: actor.runId,
        sourceAgentKind: actor.agentKind,
        sourceModel: actor.model,
      };
}

function stampSource(
  row: KnowledgeSourceColumns,
  source: KnowledgeSourceColumns,
): void {
  row.sourceActor = source.sourceActor;
  row.sourceRunId = source.sourceRunId;
  row.sourceAgentKind = source.sourceAgentKind;
  row.sourceModel = source.sourceModel;
}

function revisionOf(
  base: { id: string; handle: string; rev: number },
  text: KnowledgeText,
  actor: KnowledgeActor,
  reason: string | null,
  status: KnowledgeRevision['status'],
  rev: number | null,
  approved = false,
): KnowledgeRevision {
  const body = text.body.trim();
  const revision = new KnowledgeRevision();
  revision.documentId = base.id;
  revision.handle = base.handle;
  revision.baseRev = base.rev;
  revision.status = status;
  revision.rev = rev;
  revision.title = text.title.trim();
  revision.whenToRead = text.whenToRead.trim();
  revision.body = body;
  revision.bodyBytes = Buffer.byteLength(body, 'utf8');
  revision.reason = reason;
  revision.sourceMemberId = 'memberId' in actor ? actor.memberId : null;
  revision.decidedAt = status === 'applied' ? new Date() : null;
  revision.approvedAt = approved || actor.kind === 'user' ? new Date() : null;
  Object.assign(revision, sourceOf(actor));
  return revision;
}

function headOf(row: KnowledgeDocument): KnowledgeHead {
  return {
    id: row.id,
    handle: row.handle,
    placeKey: row.placeKey,
    projectId: row.projectId,
    teamSlug: row.teamSlug,
    title: row.title,
    whenToRead: row.whenToRead,
    bodyBytes: row.bodyBytes,
    status: row.status,
    rev: row.rev,
    approvedAt: row.approvedAt,
    sourceActor: row.sourceActor,
    sourceRunId: row.sourceRunId,
    sourceAgentKind: row.sourceAgentKind,
    sourceModel: row.sourceModel,
    lastReadAt: row.lastReadAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHeadWire(head: KnowledgeHead, pending: number): KnowledgeHeadDto {
  return {
    id: head.id,
    handle: head.handle,
    place: head.placeKey,
    projectId: head.projectId,
    teamSlug: head.teamSlug,
    title: head.title,
    whenToRead: head.whenToRead,
    bodyBytes: head.bodyBytes,
    status: head.status,
    rev: head.rev,
    pending,
    source: {
      actor: head.sourceActor,
      runId: head.sourceRunId,
      agentKind: head.sourceAgentKind,
      model: head.sourceModel,
    },
    createdAt: head.createdAt.toISOString(),
    updatedAt: head.updatedAt.toISOString(),
    lastReadAt: head.lastReadAt?.toISOString() ?? null,
    approvedAt: head.approvedAt?.toISOString() ?? null,
  };
}

function toRevisionHead(row: KnowledgeRevision): KnowledgeRevisionHeadDto {
  return {
    id: row.id,
    documentId: row.documentId,
    rev: row.rev,
    status: row.status,
    baseRev: row.baseRev,
    title: row.title,
    whenToRead: row.whenToRead,
    bodyBytes: row.bodyBytes,
    reason: row.reason,
    source: {
      actor: row.sourceActor,
      runId: row.sourceRunId,
      memberId: row.sourceMemberId,
      agentKind: row.sourceAgentKind,
      model: row.sourceModel,
    },
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
  };
}

function toHit(head: KnowledgeHead): KnowledgeHit {
  return {
    handle: head.handle,
    title: head.title,
    whenToRead: head.whenToRead,
    level: levelOfKey(head.placeKey),
    rev: head.rev,
    bodyBytes: head.bodyBytes,
    reviewed: head.approvedAt !== null,
  };
}
