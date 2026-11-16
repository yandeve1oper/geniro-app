import { randomUUID } from 'node:crypto';

import { EntityManager } from '@mikro-orm/sqlite';
import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';

import { NodeStateDao } from '../../agents/dao/node-state.dao';
import { RunDao } from '../../agents/dao/run.dao';
import { chatTextMatchQuery } from '../../agents/utils/chat-text-query';
import { hasHiddenText } from '../../agents/utils/hidden-text';
import { redactSecrets } from '../../diagnostics/utils/redact';
import { ProjectDao } from '../../projects/dao/project.dao';
import type { RunPlace, RunPlaceFacts } from '../../projects/projects.types';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { MemoryDao } from '../dao/memory.dao';
import { MemoryReviewFindingDao } from '../dao/memory-review-finding.dao';
import { Memory } from '../entity/memory.entity';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_AUTO_BATCH_PREFIX,
  MEMORY_BODY_MAX_BYTES,
  MEMORY_FORGET_BATCH_MAX,
  MEMORY_FORGET_REASON_MAX_CHARS,
  MEMORY_LIST_LIMIT_DEFAULT,
  MEMORY_READ_MAX,
  MEMORY_SEARCH_MAX,
  MEMORY_STATUSES,
  MEMORY_TITLE_MAX_CHARS,
  type MemoryActor,
  type MemoryChange,
  type MemoryConfig,
  type MemoryCreateInput,
  type MemoryEdit,
  type MemoryEntry,
  type MemoryExport,
  type MemoryForgetAll,
  type MemoryForgetBatchResult,
  type MemoryForgetOutcome,
  memoryHandle,
  type MemoryHit,
  type MemoryImportNote,
  type MemoryImportResult,
  type MemoryIndexPreview,
  type MemoryKeepResult,
  type MemoryLessonSource,
  type MemoryList,
  type MemoryListQuery,
  type MemoryMergeOutcome,
  type MemoryMergeRefusal,
  type MemoryMergeRequest,
  type MemoryPatch,
  type MemoryPurgeResult,
  type MemoryRefusalCode,
  type MemoryRestoreBatchResult,
  type MemoryRunSnapshot,
  type MemorySaveInput,
  type MemorySaveOutcome,
  type MemoryStatusOutcome,
  type MemoryUserStatus,
  parseMemoryHandle,
  type TeamMemoryFate,
} from '../memory.types';
import { autoForgetFilterOf } from '../utils/memory-auto-forget';
import { memoryExportMarkdown } from '../utils/memory-export';
import { markForgotten, markRestored } from '../utils/memory-forget-stamp';
import {
  referencedPathsOf,
  statesRule,
  storedPaths,
} from '../utils/memory-references';
import {
  excerptOf,
  importedText,
  importedTextHash,
  memoryIndexOf,
  similarTitles,
  titleCandidatesQuery,
} from '../utils/memory-text';
import { DAY_MS } from '../utils/memory-usage-day';
import { MemoryEventBus } from './memory-events.bus';
import {
  MEMORY_USAGE_BACKFILL_VERSION,
  MemoryUsageService,
} from './memory-usage.service';

/** Near-duplicate candidates read per write before the title comparison. */
const DUPLICATE_CANDIDATES = 20;

const AUTO_FORGET_FIRST_RUN_MS = 5 * 60 * 1000;
const AUTO_FORGET_EVERY_MS = DAY_MS;

type Refusal = Extract<MemorySaveOutcome, { kind: 'refused' }>;

const MERGE_SOURCE_GONE =
  'an entry to merge was forgotten or removed meanwhile';

/** Rolls a merge's transaction back with the outcome to answer. */
class MergeRefused extends Error {
  constructor(readonly outcome: MemoryMergeRefusal) {
    super(outcome.kind);
  }
}

/** What a write stores, whoever writes it. */
type MemoryText = Pick<
  MemorySaveInput,
  'title' | 'body' | 'type' | 'notDuplicateOf'
>;

const USER: MemoryActor = { kind: 'user' };

/** The writer the import preview checks a note as: never an agent. */
const IMPORT_CHECK: MemoryActor = { kind: 'import', importedFrom: '' };

/**
 * The memory every agent shares, on every CLI. Every write is made here — an
 * agent's {@link save} / {@link forget}, the user's {@link create},
 * {@link edit}, {@link setStatus} and {@link forgetAll}, and
 * {@link importNotes} — and each holds the limits: size, secrets,
 * near-duplicates, stale revisions and the review policy for agent writes.
 *
 * Writes are serialized, so a handle is allocated and a duplicate checked
 * against a table no other write is changing.
 */
@Injectable()
export class MemoryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MemoryService.name);
  private config: MemoryConfig = DEFAULT_MEMORY_CONFIG;
  private teamExists: ((slug: string) => Promise<boolean>) | null = null;
  private configured = false;
  private writes: Promise<unknown> = Promise.resolve();
  private sweepFirst: ReturnType<typeof setTimeout> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly em: EntityManager,
    private readonly memories: MemoryDao,
    private readonly runs: RunDao,
    private readonly nodeStates: NodeStateDao,
    private readonly projects: ProjectDao,
    private readonly scope: ProjectScopeService,
    private readonly events: MemoryEventBus,
    private readonly usage: MemoryUsageService,
    private readonly findings: MemoryReviewFindingDao,
  ) {}

  /**
   * How the user's own writes learn whether a team exists; registered by the
   * teams module, which this module may not import.
   */
  useTeamLookup(lookup: (slug: string) => Promise<boolean>): void {
    this.teamExists = lookup;
  }

  /**
   * A while after the start, so a Mac that slept through a day still sweeps,
   * then once a day. Never on a settings push: arming the sweep forgets
   * nothing in the same gesture.
   */
  onModuleInit(): void {
    this.sweepFirst = setTimeout(() => {
      void this.sweepColdQuietly();
    }, AUTO_FORGET_FIRST_RUN_MS);
    this.sweepFirst.unref?.();
    this.sweepTimer = setInterval(() => {
      void this.sweepColdQuietly();
    }, AUTO_FORGET_EVERY_MS);
    this.sweepTimer.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.sweepFirst !== null) {
      clearTimeout(this.sweepFirst);
      this.sweepFirst = null;
    }
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /**
   * Forget, as one batch, every cold entry the user's window takes — never a
   * kept, warned or waiting one, nor one filed in a dormant scope. Null when
   * the sweep may not run: memory off, no window armed, the settings not
   * pushed yet, or the usage history still being counted, which would make
   * every entry look unread.
   */
  sweepCold(now = new Date()): Promise<MemoryForgetBatchResult | null> {
    const days = this.config.autoForgetAfterDays;
    const marker = this.usage.backfillMarker;
    if (
      !this.configured ||
      !this.enabled ||
      days === null ||
      marker?.doneVersion !== MEMORY_USAGE_BACKFILL_VERSION
    ) {
      return Promise.resolve(null);
    }
    return this.serialize(async () => {
      const em = this.em.fork();
      const filter = await autoForgetFilterOf(days, now, this.runs, em);
      const ids = await this.memories.autoForgetIds(
        filter,
        MEMORY_FORGET_BATCH_MAX,
        em,
      );
      return this.forgetAsBatch(ids, now, em, MEMORY_AUTO_BATCH_PREFIX);
    });
  }

  /**
   * Delete a forgotten entry for good. Its text, its forget reason and the
   * findings quoting it are erased; the row stays as an empty tombstone, so
   * its handle is never handed out again, and its usage figures stay.
   */
  purge(id: string): Promise<MemoryPurgeResult | 'missing' | 'not-forgotten'> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row) {
        return 'missing';
      }
      const hash =
        row.sourceActor === 'import'
          ? importedTextHash(row.title, row.body)
          : null;
      const purged = await em.transactional(async (tx) => {
        if (!(await this.memories.purge(id, hash, new Date(), tx))) {
          return false;
        }
        await this.findings.deleteNaming(id, tx);
        return true;
      });
      if (!purged) {
        return 'not-forgotten';
      }
      this.events.publish({
        memoryId: null,
        change: 'bulk',
        status: 'forgotten',
        projectId: row.projectId,
        teamSlug: row.teamSlug,
      });
      return { id, handle: memoryHandle(row.handle) };
    });
  }

  /** Apply what the user chose for a deleted team's entries. */
  settleDeletedTeam(slug: string, fate: TeamMemoryFate): Promise<number> {
    return this.serialize(async () => {
      if (fate === 'keep') {
        return 0;
      }
      const now = new Date();
      const em = this.em.fork();
      const changed =
        fate === 'forget'
          ? await this.memories.forgetTeam(slug, now, em)
          : await this.memories.refileTeamAsGlobal(slug, now, em);
      if (changed > 0) {
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: fate === 'forget' ? 'forgotten' : 'active',
          projectId: null,
          teamSlug: null,
        });
      }
      return changed;
    });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  setConfig(config: MemoryConfig): MemoryConfig {
    this.config = { ...config };
    this.configured = true;
    return this.config;
  }

  /** Where a run's memory is filed (`ProjectScopeService.placeOf`). */
  async scopeOf(runId: string): Promise<RunPlace> {
    const run = await this.runs.getById(runId, this.em.fork());
    return run ? this.scope.placeOf(run) : { projectId: null, teamSlug: null };
  }

  /** {@link scopeOf} for a run whose row does not exist yet. */
  scopeFor(facts: RunPlaceFacts): Promise<RunPlace> {
    return this.scope.placeFor(facts);
  }

  /**
   * What a new run keeps of the shared memory for its whole life. Taken once,
   * at creation: both fields reach `AgentAdapter.sessionKey`, so a live read
   * would respawn a kept CLI whenever any agent saved a note or the user
   * flipped the switch. A failed read costs the run its index, never its start.
   *
   * Until Electron's first push the daemon holds only the default, which may
   * not be the user's: a run kept for its whole life is created without
   * memory rather than with a setting nobody chose. Each CLI's own memory is
   * off only while the shared memory is on and the user switched it off (a
   * successful import does), so an agent keeps one memory without the CLIs'
   * notes being hidden before they are brought over.
   */
  async runSnapshot(facts: RunPlaceFacts): Promise<MemoryRunSnapshot> {
    const none: MemoryRunSnapshot = {
      nativeMemoryOff: false,
      memoryIndex: null,
      indexIds: [],
    };
    if (!this.configured || !this.enabled) {
      return none;
    }
    const shared = { ...none, nativeMemoryOff: this.config.nativeMemoryOff };
    try {
      const entries = await this.listVisible(await this.scopeFor(facts));
      const index = memoryIndexOf(
        entries.filter((entry) => entry.indexed),
        new Date(),
      );
      return { ...shared, memoryIndex: index.text, indexIds: index.ids };
    } catch (error) {
      this.logger.warn(
        `memory index not read: ${error instanceof Error ? error.message : String(error)}`,
      );
      return shared;
    }
  }

  /**
   * Count a new run's memory index as shown to it — called by the run builders
   * once the run row exists, never from {@link runSnapshot}, which also
   * measures instruction sizes for no run. Never throws.
   */
  countIndexShows(indexIds: readonly string[]): Promise<void> {
    return this.usage.count(indexIds, 'indexShows');
  }

  /**
   * Who a tool call on this run and member is: the member's own agent in a
   * team, else the chat's. An analysis chat writes as `analysis`, held to
   * the same review rule as any agent.
   */
  async actorOf(runId: string, memberId: string): Promise<MemoryActor> {
    const em = this.em.fork();
    const run = await this.runs.getById(runId, em);
    const state = await this.nodeStates.getByRunNode(runId, memberId, em);
    const kind =
      run?.analysisSourceRunId || run?.analysisTeamSlug ? 'analysis' : 'agent';
    return {
      kind,
      runId,
      agentKind: state?.agentKind ?? run?.agentKind ?? null,
      model: state?.model ?? run?.model ?? null,
    };
  }

  /** Whether the actor is a lessons reflection, which proposes lessons and writes no memory itself. */
  private async isReflection(actor: MemoryActor): Promise<boolean> {
    if (actor.kind !== 'analysis') {
      return false;
    }
    const run = await this.runs.getById(actor.runId, this.em.fork());
    return (
      run?.analysisPurpose === 'lessons' ||
      run?.analysisPurpose === 'lessons_check'
    );
  }

  /** The best active entries a run in `place` may see, best first. */
  async search(
    query: string,
    place: RunPlace,
    limit: number,
  ): Promise<MemoryHit[]> {
    const match = chatTextMatchQuery(query);
    if (match === null) {
      return [];
    }
    const em = this.em.fork();
    const ids = await this.memories.matchIds(
      match,
      { statuses: ['active'], places: { visibleTo: place } },
      Math.min(Math.max(limit, 1), MEMORY_SEARCH_MAX),
      em,
    );
    const rows = new Map(
      (await this.memories.getByIds(ids, em)).map((row) => [row.id, row]),
    );
    const found = ids
      .map((id) => rows.get(id))
      .filter((row): row is Memory => row !== undefined);
    await this.usage.count(
      found.map((row) => row.id),
      'searchHits',
    );
    return found.map(toHit);
  }

  /**
   * Whole entries by handle, each one only if it is active and visible to
   * `place`; the rest come back as `missing`. Reading stamps `lastUsedAt`.
   */
  async read(
    handles: readonly string[],
    place: RunPlace,
  ): Promise<{ entries: MemoryEntry[]; missing: string[] }> {
    const wanted = handles.slice(0, MEMORY_READ_MAX);
    const numbers = wanted
      .map(parseMemoryHandle)
      .filter((n): n is number => n !== null);
    const byHandle = new Map(
      (
        await this.memories.getInScope(
          { statuses: ['active'], places: { visibleTo: place } },
          numbers,
          this.em.fork(),
        )
      ).map((row) => [row.handle, row]),
    );
    const entries: MemoryEntry[] = [];
    const missing: string[] = [];
    for (const handle of wanted) {
      const number = parseMemoryHandle(handle);
      const row = number === null ? undefined : byHandle.get(number);
      if (row) {
        entries.push(toEntry(row));
      } else {
        missing.push(handle);
      }
    }
    const read = entries.map((entry) => entry.id);
    try {
      await this.memories.touch(read, new Date());
    } catch (error) {
      this.logger.warn(
        `memory last use not stamped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await this.usage.count(read, 'reads');
    return { entries, missing };
  }

  /**
   * Create an entry, or update one in place when `input.handle` names it.
   * While the user reviews agent writes, an agent's new entry lands `pending`
   * and its update of an existing one is refused, so reviewed text is never
   * replaced unseen. `place` is the writer's own scope: an agent sees and
   * writes global entries plus its run's project and team.
   */
  save(
    actor: MemoryActor,
    input: MemorySaveInput,
    place: RunPlace,
  ): Promise<MemorySaveOutcome> {
    return this.serialize(() => this.saveNow(actor, input, place));
  }

  /**
   * Hide an entry from every agent, keeping it restorable. Refused to an agent
   * while the user reviews agent writes, like an update.
   */
  forget(
    actor: MemoryActor,
    handle: string,
    reason: string,
    place: RunPlace,
  ): Promise<MemoryForgetOutcome> {
    return this.serialize(() => this.forgetNow(actor, handle, reason, place));
  }

  /**
   * The user's own status change — approve an entry, restore a forgotten one
   * to the status it had, or forget one — on any entry, whatever its scope.
   * Refused to an agent: approving is the review itself.
   */
  setStatus(
    actor: MemoryActor,
    id: string,
    status: MemoryUserStatus,
  ): Promise<MemoryStatusOutcome> {
    return this.serialize(async () => {
      if (isAgent(actor)) {
        return refused('USER_ONLY', 'only the user changes an entry’s status');
      }
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no memory ${id}`);
      }
      const change = applyStatus(row, status, new Date());
      if (change !== null) {
        row.rev += 1;
        await em.flush();
        this.publish(row, change);
      }
      return { kind: 'changed', entry: toEntry(row) };
    });
  }

  /**
   * Move an active entry into every new run's memory index, or keep an agent's
   * one to search only. The user's own and imported entries are always
   * indexed, so they cannot be taken out.
   */
  setIndexed(
    actor: MemoryActor,
    id: string,
    indexed: boolean,
  ): Promise<MemoryStatusOutcome> {
    return this.serialize(async () => {
      if (isAgent(actor)) {
        return refused(
          'USER_ONLY',
          'only the user moves an entry in or out of the index',
        );
      }
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row) {
        return refused('NOT_FOUND', `no memory ${id}`);
      }
      if (row.status !== 'active') {
        return refused(
          'NOT_ACTIVE',
          row.status === 'pending'
            ? 'approve the entry first'
            : 'restore the entry first',
        );
      }
      if (!indexed && alwaysIndexed(row)) {
        return refused(
          'ALWAYS_INDEXED',
          'an entry you wrote or imported is always in the index — forget it to take it out',
        );
      }
      if (indexable(row) === indexed) {
        return { kind: 'changed', entry: toEntry(row) };
      }
      row.approvedAt = indexed ? new Date() : null;
      row.rev += 1;
      await em.flush();
      this.publish(row, indexed ? 'approved' : 'updated');
      return { kind: 'changed', entry: toEntry(row) };
    });
  }

  /**
   * How many of the entries a new run in `place` may list fit in its memory
   * index, cut exactly as {@link runSnapshot} cuts it.
   */
  async indexPreview(place: RunPlace): Promise<MemoryIndexPreview> {
    const eligible = (await this.listVisible(place)).filter(
      (entry) => entry.indexed,
    );
    const { ids } = memoryIndexOf(eligible, new Date());
    return { listed: ids.length, eligible: eligible.length, ids };
  }

  /**
   * Every active entry a run in `place` may see, its team's first, then its
   * project's, then global, each group most recently used first — what a run's
   * memory index is cut from.
   */
  async listVisible(place: RunPlace): Promise<MemoryEntry[]> {
    const rows = await this.memories.getInScope(
      { statuses: ['active'], places: { visibleTo: place } },
      undefined,
      this.em.fork(),
    );
    return rows
      .sort(
        (a, b) =>
          placeRank(a, place) - placeRank(b, place) || usedAt(b) - usedAt(a),
      )
      .map(toEntry);
  }

  /** One page of the user's list, newest edit first. */
  async list(query: MemoryListQuery): Promise<MemoryList> {
    const limit = query.limit ?? MEMORY_LIST_LIMIT_DEFAULT;
    let match: string | undefined;
    if (query.q !== undefined) {
      const ready = chatTextMatchQuery(query.q);
      if (ready === null) {
        return { memories: [], next: null };
      }
      match = ready;
    }
    const rows = await this.memories.page(
      {
        statuses: query.status
          ? [query.status]
          : query.handle !== undefined
            ? MEMORY_STATUSES
            : ['active', 'pending'],
        handle:
          query.handle === undefined
            ? undefined
            : (parseMemoryHandle(query.handle) ?? undefined),
        places:
          query.scope === 'global'
            ? { exactly: { projectId: null, teamSlug: null } }
            : query.scope === 'project' && query.projectId !== undefined
              ? { exactly: { projectId: query.projectId, teamSlug: null } }
              : query.scope === 'team' && query.teamSlug !== undefined
                ? { exactly: { projectId: null, teamSlug: query.teamSlug } }
                : { any: true },
        type: query.type,
        reach: query.reach,
        match,
        before:
          query.beforeUpdatedAt !== undefined && query.beforeId !== undefined
            ? { updatedAt: new Date(query.beforeUpdatedAt), id: query.beforeId }
            : undefined,
        limit,
      },
      this.em.fork(),
    );
    const last = rows.at(-1);
    return {
      memories: rows.map(toEntry),
      next:
        rows.length === limit && last
          ? {
              beforeUpdatedAt: last.updatedAt.toISOString(),
              beforeId: last.id,
            }
          : null,
    };
  }

  /** One entry by id, whatever its status or scope — the user's read. */
  async get(id: string): Promise<MemoryEntry | null> {
    const row = await this.memories.getById(id, this.em.fork());
    return row ? toEntry(row) : null;
  }

  /**
   * The user's own new entry, filed where the user chose. `lesson` names the
   * thread and the lesson proposal a saved lesson came from.
   */
  create(
    input: MemoryCreateInput,
    lesson?: MemoryLessonSource,
  ): Promise<MemorySaveOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(USER, input);
      if (invalid) {
        return invalid;
      }
      const em = this.em.fork();
      const unknown =
        (await this.refuseUnknownProject(input.projectId, em)) ??
        (await this.refuseUnknownTeam(input.teamSlug ?? null, null));
      return (
        unknown ??
        this.writeRow(USER, input, placeOfInput(input), null, em, true, lesson)
      );
    });
  }

  /**
   * A lesson a reflection filed with no human press, written into `place` as
   * an agent write: searchable at once, kept out of the memory index until
   * the user approves it, and pending while the user reviews agent writes. A
   * near duplicate of an active entry writes nothing.
   */
  fileLesson(
    actor: Extract<MemoryActor, { kind: 'lesson' }>,
    input: MemoryText & { type: NonNullable<MemoryText['type']> },
    place: RunPlace,
    lesson: MemoryLessonSource,
  ): Promise<MemorySaveOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(actor, input);
      if (invalid) {
        return invalid;
      }
      return this.writeRow(
        actor,
        input,
        place,
        null,
        this.em.fork(),
        true,
        lesson,
      );
    });
  }

  /**
   * The user's edit of an entry's text, type or scope at the `rev` it was read
   * at. Editing a pending entry makes it the user's own, so it is no longer
   * waiting on review; a forgotten one must be restored before it is edited.
   */
  edit(id: string, input: MemoryEdit): Promise<MemorySaveOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(USER, input);
      if (invalid) {
        return invalid;
      }
      const em = this.em.fork();
      const row = await this.memories.getById(id, em);
      if (!row || row.status === 'forgotten') {
        return refused(
          'NOT_FOUND',
          row ? 'restore the entry before editing it' : `no memory ${id}`,
        );
      }
      if (input.rev !== row.rev) {
        return { kind: 'stale', current: toEntry(row) };
      }
      const unknown =
        (await this.refuseUnknownProject(input.projectId, em)) ??
        (await this.refuseUnknownTeam(input.teamSlug ?? null, row.teamSlug));
      return (
        unknown ?? this.writeRow(USER, input, placeOfInput(input), row, em)
      );
    });
  }

  /** The user's PATCH: a status change, or an edit of text and scope. */
  change(
    id: string,
    patch: MemoryPatch,
  ): Promise<MemorySaveOutcome | MemoryStatusOutcome> {
    if (patch.status !== undefined) {
      return this.setStatus(USER, id, patch.status);
    }
    const { rev, title, body, type, projectId, teamSlug, notDuplicateOf } =
      patch;
    if (
      rev === undefined ||
      title === undefined ||
      body === undefined ||
      type === undefined ||
      projectId === undefined ||
      teamSlug === undefined
    ) {
      return Promise.resolve(
        refused(
          'INVALID_ENTRY',
          'an edit carries rev, title, body, type, projectId and teamSlug',
        ),
      );
    }
    return this.edit(id, {
      rev,
      title,
      body,
      type,
      projectId,
      teamSlug,
      notDuplicateOf,
    });
  }

  /** Forget every active and pending entry, each one restorable. */
  forgetAll(): Promise<MemoryForgetAll> {
    return this.serialize(async () => {
      const forgotten = await this.memories.forgetAll(
        new Date(),
        this.em.fork(),
      );
      if (forgotten > 0) {
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: 'forgotten',
          projectId: null,
          teamSlug: null,
        });
      }
      return { forgotten };
    });
  }

  /**
   * Forget these entries as one cleanup batch, each restorable on its own or
   * with the batch. An entry already forgotten or gone is left as it is and
   * named.
   */
  forgetBatch(ids: readonly string[]): Promise<MemoryForgetBatchResult> {
    return this.serialize(() =>
      this.forgetAsBatch(ids, new Date(), this.em.fork()),
    );
  }

  /**
   * Undo a cleanup: every entry still forgotten by it returns to its own
   * status. Undoing a merge also forgets the entry it wrote, found through the
   * sources it still holds.
   */
  restoreBatch(batchId: string): Promise<MemoryRestoreBatchResult> {
    return this.serialize(async () => {
      const now = new Date();
      const undone: Memory[] = [];
      const restored = await this.em.fork().transactional(async (tx) => {
        const merged = await this.memories.mergedInto(batchId, tx);
        const count = await this.memories.restoreBatch(batchId, now, tx);
        const writtenByMerge =
          merged.length === 0 ? [] : await this.memories.getByIds(merged, tx);
        for (const row of writtenByMerge) {
          if (applyStatus(row, 'forgotten', now) !== null) {
            row.rev += 1;
            undone.push(row);
          }
        }
        await tx.flush();
        return count;
      });
      for (const row of undone) {
        this.publish(row, 'forgotten');
      }
      if (restored > 0) {
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: 'active',
          projectId: null,
          teamSlug: null,
          batchId,
        });
      }
      return { restored };
    });
  }

  /**
   * Write one new entry of the user's in place of several and forget those as
   * one cleanup batch, each linked to the new one. All or nothing: a refusal
   * of the new entry — a near-duplicate of a third entry included — forgets
   * nothing. The user saw and edited the whole text, so the new entry is the
   * user's own and reaches every run's index.
   */
  merge(input: MemoryMergeRequest): Promise<MemoryMergeOutcome> {
    return this.serialize(async () => {
      const invalid = this.refuseInvalid(USER, input);
      if (invalid) {
        return invalid;
      }
      const sourceIds = [...new Set(input.sourceIds)];
      if (sourceIds.length < 2) {
        return refused(
          'INVALID_ENTRY',
          'a merge takes at least two different entries',
        );
      }
      const em = this.em.fork();
      const sources = (await this.memories.getByIds(sourceIds, em)).filter(
        (row) => row.status === 'active' || row.status === 'pending',
      );
      if (sources.length !== sourceIds.length) {
        return refused('NOT_FOUND', MERGE_SOURCE_GONE);
      }
      const unknown =
        (await this.refuseUnknownProject(input.projectId, em)) ??
        (await this.refuseUnknownTeam(input.teamSlug ?? null, null));
      if (unknown) {
        return unknown;
      }
      const batchId = randomUUID();
      const text: MemoryText = {
        title: input.title,
        body: input.body,
        type: input.type,
        notDuplicateOf: sources.map((row) => memoryHandle(row.handle)),
      };
      let written: Memory;
      try {
        written = await em.transactional(async (tx) => {
          const outcome = await this.writeRow(
            USER,
            text,
            placeOfInput(input),
            null,
            tx,
            false,
          );
          if (outcome.kind === 'updated') {
            throw new MergeRefused(
              refused('INVALID_ENTRY', 'a merge writes a new entry'),
            );
          }
          if (outcome.kind !== 'created') {
            throw new MergeRefused(outcome);
          }
          const taken = await this.memories.forgetBatch(
            sourceIds,
            batchId,
            new Date(),
            tx,
            outcome.entry.id,
          );
          if (taken.length !== sourceIds.length) {
            throw new MergeRefused(refused('NOT_FOUND', MERGE_SOURCE_GONE));
          }
          const row = await this.memories.getById(outcome.entry.id, tx);
          if (!row) {
            throw new MergeRefused(
              refused('NOT_FOUND', 'the merged entry was not written'),
            );
          }
          return row;
        });
      } catch (err) {
        if (err instanceof MergeRefused) {
          return err.outcome;
        }
        throw err;
      }
      this.publish(written, 'created');
      this.events.publish({
        memoryId: null,
        change: 'bulk',
        status: 'forgotten',
        projectId: null,
        teamSlug: null,
        batchId,
      });
      return {
        kind: 'merged',
        result: {
          entry: toEntry(written),
          batchId,
          forgotten: sources.map((row) => memoryHandle(row.handle)),
        },
      };
    });
  }

  /** Keep an active or pending entry out of the cleanup list, or stop keeping it. */
  setKept(id: string, kept: boolean): Promise<MemoryKeepResult | null> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const at = kept ? new Date() : null;
      if (!(await this.memories.setKept(id, at, em))) {
        return null;
      }
      const row = await this.memories.getById(id, em);
      if (row) {
        this.publish(row, 'updated');
      }
      return { id, keptAt: at?.toISOString() ?? null };
    });
  }

  /** Every active and pending entry as one Markdown document. */
  async exportMarkdown(now = new Date()): Promise<MemoryExport> {
    const em = this.em.fork();
    const rows = await this.memories.getAll(
      { status: { $in: ['active', 'pending'] } },
      { orderBy: { updatedAt: 'desc' } },
      em,
    );
    const projects = new Map(
      (await this.projects.getAll({}, undefined, em)).map((project) => [
        project.id,
        project.name,
      ]),
    );
    return {
      markdown: memoryExportMarkdown(rows.map(toEntry), projects, now),
      count: rows.length,
    };
  }

  /** Why a note could not be stored as an entry, or null when it could. */
  problemOf(note: Pick<MemorySaveInput, 'title' | 'body'>): string | null {
    return this.refuseInvalid(IMPORT_CHECK, note)?.reason ?? null;
  }

  /** Active and pending entries filed in `place` whose title says the same. */
  async similarTo(title: string, place: RunPlace): Promise<Memory[]> {
    return this.nearDuplicates(
      { title, body: '' },
      place,
      null,
      this.em.fork(),
    );
  }

  /** What the active and pending imported entries say, each as `importedText`. */
  async importedTexts(
    em: EntityManager = this.em.fork(),
  ): Promise<Set<string>> {
    const rows = await this.memories.getAll(
      {
        sourceActor: 'import',
        status: { $in: ['active', 'pending'] },
      },
      { fields: ['title', 'body'] },
      em,
    );
    return new Set(rows.map((row) => importedText(row.title, row.body)));
  }

  /**
   * What the forgotten and the purged imported entries said, each as
   * `importedTextHash` — the preview's mark only: an import still writes a
   * ticked note again.
   */
  async forgottenImportedHashes(
    em: EntityManager = this.em.fork(),
  ): Promise<Set<string>> {
    const rows = await this.memories.getAll(
      { sourceActor: 'import', status: 'forgotten' },
      { fields: ['title', 'body'] },
      em,
    );
    return new Set([
      ...rows.map((row) => importedTextHash(row.title, row.body)),
      ...(await this.memories.purgedImportedHashes(em)),
    ]);
  }

  /**
   * Write the notes the user ticked in the import preview. Ticking one is the
   * user's review: each lands active and approved, past the near-duplicate
   * check the preview already showed, in one write announced as one `bulk`
   * change. A note whose text an active or pending imported entry already
   * holds is skipped, so a retried or repeated import writes it once.
   */
  importNotes(notes: readonly MemoryImportNote[]): Promise<MemoryImportResult> {
    return this.serialize(async () => {
      const em = this.em.fork();
      const projects = new Set(
        (await this.projects.getAll({}, undefined, em)).map((p) => p.id),
      );
      const held = await this.importedTexts(em);
      const skipped: MemoryImportResult['skipped'] = [];
      const now = new Date();
      let handle = await this.memories.nextHandle(em);
      let imported = 0;
      for (const note of notes) {
        const actor: MemoryActor = {
          kind: 'import',
          importedFrom: note.importedFrom,
        };
        const refusal =
          this.refuseInvalid(actor, note) ??
          (note.projectId !== null && !projects.has(note.projectId)
            ? refused('NO_PROJECT', `no project ${note.projectId}`)
            : null);
        if (refusal) {
          skipped.push({ key: note.key, reason: refusal.reason });
          continue;
        }
        const text = importedText(note.title, note.body);
        if (held.has(text)) {
          skipped.push({ key: note.key, reason: 'already imported' });
          continue;
        }
        held.add(text);
        const row = new Memory();
        row.handle = handle++;
        row.title = note.title.trim();
        row.body = note.body.trim();
        markText(row);
        row.type = note.type;
        row.projectId = note.projectId;
        row.status = 'active';
        stampSource(row, actor);
        row.approvedAt = now;
        em.persist(row);
        imported += 1;
      }
      if (imported > 0) {
        await em.flush();
        this.events.publish({
          memoryId: null,
          change: 'bulk',
          status: 'active',
          projectId: null,
          teamSlug: null,
        });
      }
      return { imported, skipped };
    });
  }

  /**
   * Refuse filing an entry under a team the library does not hold. An entry
   * kept under a deleted team's slug can still be edited where it stands.
   */
  private async refuseUnknownTeam(
    teamSlug: string | null,
    current: string | null,
  ): Promise<Refusal | null> {
    if (
      teamSlug === null ||
      teamSlug === current ||
      this.teamExists === null ||
      (await this.teamExists(teamSlug))
    ) {
      return null;
    }
    return refused('NO_TEAM', `no team ${teamSlug}`);
  }

  private async refuseUnknownProject(
    projectId: string | null,
    em: EntityManager,
  ): Promise<Refusal | null> {
    if (projectId === null || (await this.projects.getById(projectId, em))) {
      return null;
    }
    return refused('NO_PROJECT', `no project ${projectId}`);
  }

  private async saveNow(
    actor: MemoryActor,
    input: MemorySaveInput,
    place: RunPlace,
  ): Promise<MemorySaveOutcome> {
    const invalid = this.refuseInvalid(actor, input);
    if (invalid) {
      return invalid;
    }
    if (await this.isReflection(actor)) {
      return refusedForReflection();
    }
    if (input.handle !== undefined && this.underReview(actor)) {
      return refused(
        'UNDER_REVIEW',
        'the user reviews agent writes, so agents can only add new entries — save yours as a new entry, or tell the user what should change',
      );
    }
    const em = this.em.fork();
    const existing =
      input.handle === undefined
        ? null
        : await this.findVisible(input.handle, place, em);
    if (input.handle !== undefined && !existing) {
      return refused(
        'NOT_FOUND',
        `no active memory ${input.handle} this run can see — search again`,
      );
    }
    if (existing && input.rev !== existing.rev) {
      return { kind: 'stale', current: toEntry(existing) };
    }
    const target = targetPlace(input, existing, place);
    if (target === undefined) {
      return input.scope === 'team'
        ? refused(
            'NO_TEAM',
            'this run is not a team run, so the entry cannot be filed under a team — save it with scope: project or global',
          )
        : refused(
            'NO_PROJECT',
            'this run works in no project, so the entry can only be global — save it with scope: global',
          );
    }
    return this.writeRow(actor, input, target, existing, em);
  }

  private async writeRow(
    actor: MemoryActor,
    input: MemoryText,
    target: RunPlace,
    existing: Memory | null,
    em: EntityManager,
    announce = true,
    lesson?: MemoryLessonSource,
  ): Promise<MemorySaveOutcome> {
    const duplicates = await this.nearDuplicates(input, target, existing, em);
    const live = duplicates.filter((row) => row.status === 'active');
    // The user is the reviewer: an entry waiting on them never blocks them.
    const pending = isAgent(actor)
      ? duplicates.filter((row) => row.status === 'pending')
      : [];
    if (live.length > 0 || pending.length > 0) {
      return {
        kind: 'near_duplicate',
        candidates: live.map(toHit),
        pending: pending.map((row) => memoryHandle(row.handle)),
        updatable: !this.underReview(actor),
      };
    }
    const status = this.underReview(actor) ? 'pending' : 'active';
    const row = existing ?? new Memory();
    if (existing) {
      row.rev += 1;
    } else {
      row.handle = await this.memories.nextHandle(em);
    }
    row.title = input.title.trim();
    row.body = input.body.trim();
    markText(row);
    row.type = input.type ?? existing?.type ?? 'project';
    row.projectId = target.projectId;
    row.teamSlug = target.teamSlug;
    row.status = status;
    stampSource(row, actor, lesson);
    em.persist(row);
    await em.flush();
    if (announce) {
      this.publish(row, existing ? 'updated' : 'created');
    }
    return { kind: existing ? 'updated' : 'created', entry: toEntry(row) };
  }

  private async forgetNow(
    actor: MemoryActor,
    handle: string,
    reason: string,
    place: RunPlace,
  ): Promise<MemoryForgetOutcome> {
    if (isAgent(actor) && !this.config.enabled) {
      return refused('MEMORY_DISABLED', 'the user has turned memory off');
    }
    if (await this.isReflection(actor)) {
      return refusedForReflection();
    }
    if (this.underReview(actor)) {
      return refused(
        'UNDER_REVIEW',
        'the user reviews agent writes, so agents cannot forget entries — tell the user which entry is wrong and why',
      );
    }
    const trimmed = reason.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MEMORY_FORGET_REASON_MAX_CHARS ||
      hasHiddenText(trimmed, false)
    ) {
      return refused(
        'INVALID_ENTRY',
        `the reason must be one line of 1–${MEMORY_FORGET_REASON_MAX_CHARS} characters`,
      );
    }
    if (redactSecrets(trimmed) !== trimmed) {
      return refused(
        'CONTAINS_SECRET',
        'the reason contains a secret geniro knows about; write it without one',
      );
    }
    const em = this.em.fork();
    const row = await this.findVisible(handle, place, em);
    if (!row) {
      return refused(
        'NOT_FOUND',
        `no active memory ${handle} this run can see`,
      );
    }
    row.statusBeforeForget = row.status;
    row.status = 'forgotten';
    row.forgetReason = trimmed;
    markForgotten(row, new Date());
    row.rev += 1;
    await em.flush();
    this.publish(row, 'forgotten');
    return { kind: 'forgotten', entry: toEntry(row) };
  }

  private refuseInvalid(
    actor: MemoryActor,
    input: Pick<MemorySaveInput, 'title' | 'body'>,
  ): Refusal | null {
    if (isAgent(actor) && !this.config.enabled) {
      return refused('MEMORY_DISABLED', 'the user has turned memory off');
    }
    const title = input.title.trim();
    const body = input.body.trim();
    if (
      title.length === 0 ||
      [...title].length > MEMORY_TITLE_MAX_CHARS ||
      hasHiddenText(title, false)
    ) {
      return refused(
        'INVALID_ENTRY',
        `the title must be one line of 1–${MEMORY_TITLE_MAX_CHARS} characters`,
      );
    }
    if (body.length === 0 || hasHiddenText(body, true)) {
      return refused(
        'INVALID_ENTRY',
        'the body must be non-empty text without control or invisible characters',
      );
    }
    const bytes = Buffer.byteLength(body, 'utf8');
    if (bytes > MEMORY_BODY_MAX_BYTES) {
      return refused(
        'INVALID_ENTRY',
        `the body is ${bytes} bytes; the limit is ${MEMORY_BODY_MAX_BYTES} — keep one fact per entry`,
      );
    }
    if (redactSecrets(title) !== title || redactSecrets(body) !== body) {
      return refused(
        'CONTAINS_SECRET',
        'the entry contains a secret geniro knows about; never store credentials in memory',
      );
    }
    return null;
  }

  /** Whether this writer's changes wait for the user's review. */
  private underReview(actor: MemoryActor): boolean {
    return isAgent(actor) && this.config.agentWrites === 'pending';
  }

  private publish(row: Memory, change: MemoryChange): void {
    this.events.publish({
      memoryId: row.id,
      change,
      status: row.status,
      projectId: row.projectId,
      teamSlug: row.teamSlug,
    });
  }

  private async findVisible(
    handle: string,
    place: RunPlace,
    em: EntityManager,
  ): Promise<Memory | null> {
    const number = parseMemoryHandle(handle);
    if (number === null) {
      return null;
    }
    const [row] = await this.memories.getInScope(
      { statuses: ['active'], places: { visibleTo: place } },
      [number],
      em,
    );
    return row ?? null;
  }

  /**
   * Live entries in the target scope whose title says the same thing, minus
   * the entry being updated and the ones the writer vouched for.
   */
  private async nearDuplicates(
    input: MemoryText,
    target: RunPlace,
    existing: Memory | null,
    em: EntityManager,
  ): Promise<Memory[]> {
    const query = titleCandidatesQuery(input.title);
    if (query === null) {
      return [];
    }
    const vouched = new Set(
      (input.notDuplicateOf ?? [])
        .map(parseMemoryHandle)
        .filter((n): n is number => n !== null),
    );
    const ids = await this.memories.matchIds(
      query,
      { statuses: ['active', 'pending'], places: { exactly: target } },
      DUPLICATE_CANDIDATES,
      em,
    );
    return (await this.memories.getByIds(ids, em)).filter(
      (row) =>
        row.id !== existing?.id &&
        !vouched.has(row.handle) &&
        similarTitles(row.title, input.title),
    );
  }

  private async forgetAsBatch(
    ids: readonly string[],
    at: Date,
    em: EntityManager,
    batchPrefix = '',
  ): Promise<MemoryForgetBatchResult> {
    const wanted = [...new Set(ids)];
    const batchId = `${batchPrefix}${randomUUID()}`;
    const taken = new Set(
      await this.memories.forgetBatch(wanted, batchId, at, em),
    );
    const left = wanted.filter((id) => !taken.has(id));
    const known = new Map(
      (await this.memories.getByIds(left, em)).map((row) => [row.id, row]),
    );
    const skipped = left.map((id) => {
      const row = known.get(id);
      return {
        id,
        handle: row ? memoryHandle(row.handle) : null,
        reason: row ? `already ${row.status}` : 'no such entry',
      };
    });
    if (taken.size === 0) {
      return { batchId: null, forgotten: 0, skipped };
    }
    this.events.publish({
      memoryId: null,
      change: 'bulk',
      status: 'forgotten',
      projectId: null,
      teamSlug: null,
      batchId,
    });
    return { batchId, forgotten: taken.size, skipped };
  }

  private async sweepColdQuietly(): Promise<void> {
    try {
      const result = await this.sweepCold();
      if (result !== null && result.forgotten > 0) {
        this.logger.log(
          `auto-forgot ${result.forgotten} cold memory entr${result.forgotten === 1 ? 'y' : 'ies'}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `memory auto-forget failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.writes.then(work, work);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

/**
 * Whether an active entry may sit in a run's instructions: the user's own, an
 * import's, or one the user approved. An agent's unreviewed entry is reached
 * only through `memory_search`, a tool result framed as data — one an agent
 * was steered into saving must not speak in every later run's instructions.
 *
 * TWIN: `reachExpression` in `apps/daemon/src/v1/memory/dao/memory.dao.ts`.
 */
function indexable(row: Memory): boolean {
  return (
    row.status === 'active' && (alwaysIndexed(row) || row.approvedAt !== null)
  );
}

function alwaysIndexed(row: Memory): boolean {
  return row.sourceActor === 'user' || row.sourceActor === 'import';
}

/**
 * Move `row` to the user's chosen status and name what that did, or null when
 * it changes nothing. Forgetting keeps what the entry was, so a restore puts
 * it back there — a pending entry waits for review again — and approval stays
 * a press of its own.
 */
function applyStatus(
  row: Memory,
  status: MemoryUserStatus,
  now: Date,
): MemoryChange | null {
  if (status === 'forgotten') {
    if (row.status === 'forgotten') {
      return null;
    }
    row.statusBeforeForget = row.status;
    row.status = 'forgotten';
    markForgotten(row, now);
    return 'forgotten';
  }
  if (row.status === 'forgotten') {
    row.status = row.statusBeforeForget ?? 'active';
    row.statusBeforeForget = null;
    row.forgetReason = null;
    markRestored(row, now);
    return 'restored';
  }
  if (row.status === 'active' && row.approvedAt !== null) {
    return null;
  }
  row.status = 'active';
  row.approvedAt ??= now;
  return 'approved';
}

function isAgent(actor: MemoryActor): boolean {
  return (
    actor.kind === 'agent' ||
    actor.kind === 'analysis' ||
    actor.kind === 'lesson'
  );
}

function placeRank(row: Memory, place: RunPlace): number {
  if (place.teamSlug !== null && row.teamSlug === place.teamSlug) {
    return 0;
  }
  return place.projectId !== null && row.projectId === place.projectId ? 1 : 2;
}

function placeOfInput(input: {
  projectId: string | null;
  teamSlug?: string | null;
}): RunPlace {
  return { projectId: input.projectId, teamSlug: input.teamSlug ?? null };
}

function usedAt(row: Memory): number {
  return (row.lastUsedAt ?? row.updatedAt).getTime();
}

function refused(code: MemoryRefusalCode, reason: string): Refusal {
  return { kind: 'refused', code, reason };
}

/**
 * Where the entry is filed: the scope asked for, else where it already is,
 * else the writer's project when it has one. Undefined when a project scope
 * was asked for by a writer with no project, or a team scope by a writer with
 * no team.
 */
function targetPlace(
  input: MemorySaveInput,
  existing: Memory | null,
  place: RunPlace,
): RunPlace | undefined {
  if (input.scope === 'global') {
    return { projectId: null, teamSlug: null };
  }
  if (input.scope === 'project') {
    return place.projectId === null
      ? undefined
      : { projectId: place.projectId, teamSlug: null };
  }
  if (input.scope === 'team') {
    return place.teamSlug === null
      ? undefined
      : { projectId: null, teamSlug: place.teamSlug };
  }
  return existing
    ? { projectId: existing.projectId, teamSlug: existing.teamSlug }
    : { projectId: place.projectId, teamSlug: null };
}

/** Read the text for a stated limit and the repo paths it names. */
function markText(row: Memory): void {
  row.statesRule = statesRule(row.title, row.body);
  row.referencedPaths = storedPaths(referencedPathsOf(row.title, row.body));
  row.referencesGone = null;
  row.referencesCheckedAt = null;
}

function refusedForReflection(): Refusal {
  return refused(
    'REFLECTION_READ_ONLY',
    'a lessons reflection proposes lessons with propose_lessons; the user saves them',
  );
}

function stampSource(
  row: Memory,
  actor: MemoryActor,
  lesson?: MemoryLessonSource,
): void {
  row.approvedAt = null;
  row.sourceActor = actor.kind;
  row.sourceAgentKind = 'agentKind' in actor ? actor.agentKind : null;
  row.sourceModel = 'model' in actor ? actor.model : null;
  row.sourceRunId =
    lesson?.sourceRunId ?? ('runId' in actor ? actor.runId : null);
  row.sourceImportedFrom = actor.kind === 'import' ? actor.importedFrom : null;
  row.lessonProposalId = lesson?.proposalId ?? null;
}

export function toEntry(row: Memory): MemoryEntry {
  return {
    id: row.id,
    handle: memoryHandle(row.handle),
    title: row.title,
    body: row.body,
    type: row.type,
    projectId: row.projectId,
    teamSlug: row.teamSlug,
    status: row.status,
    rev: row.rev,
    source: {
      actor: row.sourceActor,
      agentKind: row.sourceAgentKind,
      model: row.sourceModel,
      runId: row.sourceRunId,
      importedFrom: row.sourceImportedFrom,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    indexed: indexable(row),
  };
}

/**
 * The excerpt is masked BEFORE it is cut: a secret registered after the entry
 * was saved could otherwise straddle the cut and leave as an unmasked prefix.
 */
function toHit(row: Memory): MemoryHit {
  const { body, ...rest } = toEntry(row);
  return { ...rest, excerpt: excerptOf(redactSecrets(body)) };
}
