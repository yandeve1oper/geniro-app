import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { BadRequestException } from '@packages/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentCommandOptions } from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentSessionListingWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { closeImportedShells } from '../utils/imported-shells';
import {
  isPlainSessionId,
  SESSION_ID_INVALID_MESSAGE,
} from '../utils/session-id';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { ProcessRegistry } from './process-registry';

/**
 * How many rows a listing returns, newest first.
 *
 * A real bound: the author's own claude profile holds 2,448 sessions, and
 * handing all of them to a renderer would cost more than the feature is worth.
 * It is also the ONLY bound now that the picker asks one unfiltered question
 * and searches what came back — a session past this cut is unreachable by that
 * search rather than merely slow to find, which is why hitting it is SAID (see
 * {@link CliSessionsService.listNow}) instead of quietly showing a short list.
 */
const SESSION_LIST_LIMIT = 400;

/** Said when the cut above bit, so a truncated list cannot pass as the whole. */
const SESSION_LIST_TRUNCATED = `Showing the ${SESSION_LIST_LIMIT} most recent sessions.`;

/**
 * How many transcript events an import brings across, newest kept.
 *
 * A cap rather than the whole file, because "the whole file" here reaches 11MB
 * and tens of thousands of rows: importing one would spend a minute writing
 * SQLite and open a thread nobody can scroll. What is left out is SAID —
 * see the notice in {@link CliSessionsService.importHistory}.
 */
const SESSION_HISTORY_LIMIT = 600;

/**
 * Refuse a session id that is anything other than one path segment, at the seam
 * every import passes through — so the route answers 400 rather than letting an
 * adapter's own refusal surface as a failed import.
 *
 * The adapters check it too, and that is not redundant: `isPlainSessionId`'s
 * doc block owns the reasoning, and each adapter's method is reachable without
 * this service.
 */
function assertPlainSessionId(sessionId: string): void {
  if (!isPlainSessionId(sessionId)) {
    throw new BadRequestException(
      'SESSION_ID_INVALID',
      SESSION_ID_INVALID_MESSAGE,
    );
  }
}

/**
 * The conversations each CLI already holds, and taking one over.
 *
 * Composes only. Every per-CLI fact — where the conversations are, how to ask
 * for them, what has to happen before one can be resumed, how to read its
 * transcript — is behind `AgentAdapter.listSessions` /
 * `prepareSessionImport` / `readSessionHistory`. This decides WHEN to ask, what
 * to do with the answer, and what the user is told.
 */
@Injectable()
export class CliSessionsService {
  private readonly logger = new Logger(CliSessionsService.name);
  /**
   * Listings already running, keyed by the whole question — cursor's listing
   * SPAWNS a process, so two callers asking the same thing at once (a dialog
   * reopened while its first ask is still out) must not launch two.
   */
  private readonly inFlight = new Map<
    string,
    Promise<AgentSessionListingWire>
  >();

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
  ) {}

  /**
   * What `agent` can offer in `cwd` (or in every folder it remembers).
   *
   * Deliberately UNCACHED beyond the in-flight join: a user opens this picker
   * having just finished something in their terminal, and a listing served from
   * a TTL is exactly the session they came looking for, missing.
   */
  async list(
    agent: AgentKind,
    cwd: string | null,
    configDir: string | null,
    query: string | null,
  ): Promise<AgentSessionListingWire> {
    // NUL joins the three parts because no path can hold one, so no two
    // different questions can collide into one key. Written as the ESCAPE and
    // never as the byte itself: a raw NUL in the source makes git classify this
    // whole file as binary, which costs every later reader its diff, every
    // review its inline comments, and every concurrent edit its 3-way merge.
    // The QUERY is part of the question rather than a filter over its answer —
    // the adapters search their own stores — so it belongs in the key. Without
    // it, a search typed while the unfiltered listing was still out would be
    // JOINED to that listing and answered with the whole list.
    const key = `${agent}\u0000${cwd ?? ''}\u0000${configDir ?? ''}\u0000${query ?? ''}`;
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const pending = this.listNow(agent, cwd, configDir, query).finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, pending);
    return pending;
  }

  private async listNow(
    agent: AgentKind,
    cwd: string | null,
    configDir: string | null,
    query: string | null,
  ): Promise<AgentSessionListingWire> {
    const adapter = this.adapters.for(agent);
    // One MORE than the cap, so a full page and an overflowing one are
    // distinguishable. Asking for exactly the cap makes them identical, and a
    // profile holding exactly `SESSION_LIST_LIMIT` sessions was then told its
    // list had been cut when the user was looking at all of it.
    const listing = await adapter.listSessions(
      { cwd, configDir, query, limit: SESSION_LIST_LIMIT + 1 },
      this.spawnOptions(`sessions:${agent}`),
    );
    const truncated = listing.sessions.length > SESSION_LIST_LIMIT;
    const sessions = truncated
      ? listing.sessions.slice(0, SESSION_LIST_LIMIT)
      : listing.sessions;
    return {
      sessions: sessions.map((session) => ({
        id: session.id,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
        snippet: session.snippet,
      })),
      unavailableReason: listing.unavailableReason,
      // Two independent halves of "this is not everything": what the CLI
      // itself cannot reach, and what this cap left off. Joined rather than
      // ranked — a cursor listing can be both at once, and dropping either
      // leaves the user reading a partial answer as a complete one.
      partialReason:
        [
          adapter.getConfig().sessions.listingPartialReason,
          // Only while something is being SEARCHED. It is a fact about
          // searching, and stated over an unsearched list it is a limitation of
          // a feature nobody has reached for yet.
          query === null
            ? null
            : adapter.getConfig().sessions.contentSearchUnavailableReason,
          // What THIS call could not reach — a bounded content search — beside
          // the standing fact about the CLI. Both, and in that order: they are
          // independently true, and a search on cursor is both narrow (titles
          // only) and taken over a store that is not all of its history.
          listing.partialReason,
          truncated ? SESSION_LIST_TRUNCATED : null,
        ]
          .filter((reason): reason is string => reason !== null)
          .join(' ') || null,
    };
  }

  /**
   * Make one conversation resumable by this app, BEFORE its run row exists.
   *
   * Ordered that way on purpose: a copy that fails leaves no half-made thread
   * behind, and the user gets the CLI's own sentence about why instead of a
   * chat whose first message dies on a session nobody can find. The adapter's
   * refusal becomes a 400 — it is a statement about the input, not a daemon
   * fault.
   */
  async prepare(
    agent: AgentKind,
    sessionId: string,
    cwd: string,
    configDir: string | null,
  ): Promise<void> {
    assertPlainSessionId(sessionId);
    try {
      await this.adapters
        .for(agent)
        .prepareSessionImport({ sessionId, cwd, configDir });
    } catch (error) {
      // CODE first, then the sentence — the order this exception takes. The
      // sentence is the whole point: it is the CLI's own account of why the
      // session cannot be taken over, and swapping the two showed the user a
      // bare `SESSION_IMPORT_FAILED`.
      throw new BadRequestException(
        'SESSION_IMPORT_FAILED',
        error instanceof Error ? error.message : 'session import failed',
      );
    }
  }

  /**
   * The conversation as the CLI recorded it, ready to be written as transcript
   * rows — plus anything the user has to be TOLD about it.
   *
   * A null notice on the happy path is deliberate. The transcript is its own
   * evidence that the import worked, and a row announcing "this went fine" on
   * top of every imported thread is a line the user has to read past forever
   * to reach the conversation they came for. What earns a row is what the
   * transcript cannot show by itself: history left out, or a record that could
   * not be read at all — because an empty transcript otherwise reads
   * identically to an import that silently did nothing.
   */
  async importHistory(
    agent: AgentKind,
    sessionId: string,
    cwd: string,
    configDir: string | null,
  ): Promise<{ events: ImportedEvent[]; notice: string | null }> {
    assertPlainSessionId(sessionId);
    const adapter = this.adapters.for(agent);
    const reason = adapter.getConfig().sessions.historyUnavailableReason;
    let history: Awaited<ReturnType<AgentAdapter['readSessionHistory']>> = null;
    try {
      history = await adapter.readSessionHistory({
        sessionId,
        cwd,
        configDir,
        limit: SESSION_HISTORY_LIMIT,
      });
    } catch (error) {
      // The contract says implementations do not throw; this is the belt on
      // top, because a failure to read a TRANSCRIPT must never cost the import
      // — the session itself resumes either way.
      this.logger.warn(
        `session history read failed for ${agent} ${sessionId}: ${String(error)}`,
      );
    }
    if (history === null) {
      return {
        events: [],
        notice: `This thread continues a ${agent} session, but its earlier messages are not shown here. ${
          reason ??
          'They could not be read this time — the agent still has them, so carry on where you left off.'
        }`,
      };
    }
    return {
      events: closeImportedShells(history.events),
      notice:
        history.droppedBefore > 0
          ? `Only the most recent part of this conversation was brought across. The agent still has all of it.`
          : null,
    };
  }

  /**
   * Register whatever an adapter spawns, so shutdown and cancel can reap it —
   * the same wrapper `ModelsService` uses, and for the same reason: a listing
   * that launches a CLI must not leave it behind.
   */
  private spawnOptions(label: string): AgentCommandOptions {
    return {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `${label}:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    };
  }
}

/** One event an import will write, in the same vocabulary a live turn emits. */
type ImportedEvent = NonNullable<
  Awaited<ReturnType<AgentAdapter['readSessionHistory']>>
>['events'][number];
