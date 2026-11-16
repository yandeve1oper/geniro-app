import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

import type { AgentKind } from '../../runs/runs.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import type { AgentModelWire } from '../chat.types';
import { childProcessHandle } from '../utils/child-handle';
import { AgentAdapterRegistry } from './agent-adapter.registry';
import { AgentVersionService } from './agent-version.service';
import type { ContextWindowStore } from './context-window.store';
import { ModelVocabularyStore } from './model-vocabulary.store';
import type { OllamaService } from './ollama.service';
import { ProcessRegistry } from './process-registry';

/** Constructor options — test seams, not user config. */
export interface ModelsServiceOptions {
  /** How long a cached answer stays fresh. */
  ttlMs?: number;
  /** Clock (test seam). */
  now?: () => number;
  ollama?: OllamaService;
  windows?: ContextWindowStore;
}

interface CacheEntry {
  version: string | null;
  fetchedAt: number;
  models: AgentModelWire[];
  ttlMs?: number;
}

/**
 * `(agent, profile)` — the memory cache's key.
 *
 * The PROFILE is in it because a model vocabulary is an ACCOUNT fact and the
 * account is the config directory: without it, the first chat to ask filed its
 * subscription's list under the CLI's name and every other account was served
 * that. The version cannot stand in for it — measured, one login's two profiles
 * report `max` and `team` from the same binary.
 *
 * Joined on a NUL written as its escape, the same rule and the same reason as
 * `ModelVocabularyCache`'s own key.
 */
function cacheKey(kind: AgentKind, profile: string | null): string {
  return `${kind}\u0000${profile ?? ''}`;
}

/**
 * Re-ask no more than this often. The list only moves when the CLI or the
 * account changes, and asking cursor costs a process spawn.
 */
const DEFAULT_TTL_MS = 10 * 60_000;

const UNANSWERED_LISTING_RETRY_MS = 30_000;

/**
 * The composer's model list, per agent kind.
 *
 * Every CLI-specific detail lives in that CLI's adapter (`listModels`) — this
 * service only decides WHEN to ask and remembers the answer. It is keyed by
 * `<binary> --version` on top of a TTL, the same key the probe services use,
 * so upgrading a CLI surfaces its new models without a daemon restart.
 *
 * The memory cache above is joined by a DURABLE one
 * ({@link ModelVocabularyStore}), because the two answer different questions:
 * a TTL stops this process asking twice, and cursor's listing is a real ACP
 * handshake — so switching the composer to that CLI on a cold daemon sat on it,
 * every launch, for a list that had not changed in weeks. The store's own doc
 * block carries the three invalidation mechanisms; what this service adds is
 * the refresh BEHIND the answer, joined through the same `inFlight` map that
 * already stops two panes spawning two process groups.
 */
@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * Cold reads already running, keyed by agent — the same single-flight
   * `AgentMcpService` keeps, needed here now for the same reason: listing
   * cursor's models SPAWNS a CLI process group, so two chat panes mounting
   * their model chip at once would otherwise launch two of them for one
   * account-level answer. Omitting it was safe only while every adapter
   * answered from memory or a file.
   */
  private readonly inFlight = new Map<string, Promise<AgentModelWire[]>>();
  /**
   * Bumped per agent by {@link forgetAgent}: a listing whose ask STARTED before
   * the account changed is served to whoever was waiting and never filed —
   * neither here nor in the durable store.
   */
  private readonly generations = new Map<AgentKind, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly ollama: OllamaService | undefined;

  constructor(
    private readonly adapters: AgentAdapterRegistry,
    private readonly processes: ProcessRegistry,
    private readonly versions: AgentVersionService,
    private readonly store: ModelVocabularyStore,
    private readonly options: ModelsServiceOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.ollama = options.ollama;
  }

  /**
   * The model list already filed for this CLI and profile at `version` (null
   * when the version could not be read, as `listNative` files it), from memory
   * or the durable cache, or null. Never spawns, never revalidates.
   */
  cachedModels(
    kind: AgentKind,
    configDir: string | null,
    version: string | null,
  ): AgentModelWire[] | null {
    const profile = this.adapters.for(kind).vocabularyProfile(configDir);
    const cached = this.cache.get(cacheKey(kind, profile));
    if (cached && cached.version === version) {
      return cached.models;
    }
    return (
      this.store.read(kind, null, profile, version, isModelList)?.value ?? null
    );
  }

  async list(
    kind: AgentKind,
    configDir: string | null = null,
  ): Promise<AgentModelWire[]> {
    const adapter = this.adapters.for(kind);
    const config = adapter.getConfig();
    const [native, local] = await Promise.all([
      this.listNative(kind, configDir),
      this.ollama
        ? config.ollama
          ? this.ollama.list()
          : Promise.resolve([
              {
                id: 'ollama/',
                label: 'Ollama is unsupported',
                source: 'ollama' as const,
                unavailableReason: `${config.identity.displayName} does not expose offline local model routing.`,
              },
            ])
        : Promise.resolve([]),
    ]);
    // Enrich after the vocabulary cache: a completed turn can teach us a window
    // while the list of models stays unchanged.
    const described = await Promise.all(
      native.map((model) => adapter.modelDetails(model, configDir)),
    );
    const models: AgentModelWire[] = [...described, ...local];
    return models.map((model) => {
      const resolved = model.resolvedModel ?? model.id;
      const contextTokens =
        model.contextTokens ??
        this.options.windows?.get(kind, resolved) ??
        adapter.catalogWindow(resolved);
      return contextTokens == null
        ? model
        : {
            ...model,
            contextTokens,
            contextWindowSelectable:
              config.contextWindowsUnavailableReason === null,
          };
    });
  }

  private async listNative(
    kind: AgentKind,
    configDir: string | null,
  ): Promise<AgentModelWire[]> {
    const version = await this.versions.resolve(kind, {
      onSpawn: (child, spawnInfo) =>
        this.processes.register(
          `models:version:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    });
    // The adapter says whether its own account is a directory at all, so a CLI
    // where it decides nothing keeps ONE entry instead of a copy per profile.
    const profile = this.adapters.for(kind).vocabularyProfile(configDir);
    const key = cacheKey(kind, profile);
    const cached = this.cache.get(key);
    if (
      cached &&
      cached.version === version &&
      this.now() - cached.fetchedAt < (cached.ttlMs ?? this.ttlMs)
    ) {
      return cached.models;
    }
    // The DURABLE cache, consulted before anything is spawned. Its answer also
    // seeds the memory entry above, so the reads inside the next TTL cost
    // neither a disk map lookup nor a version compare.
    const stored = this.store.read(kind, null, profile, version, isModelList);
    if (stored !== null) {
      // Seeded with the CURRENT time, not `stored.fetchedAt`: this is a fresh
      // memory reading of an answer that was already judged fresh enough to
      // serve (the store's own staleness check, below), so the TTL clock
      // starts now. Seeding it with the disk timestamp had every entry older
      // than the TTL but younger than the store's own revalidate window fail
      // the memory check on EVERY call — the disk read and shape walk re-ran
      // per request instead of the intended one-per-TTL-window.
      this.cache.set(key, {
        version,
        fetchedAt: this.now(),
        models: stored.value,
      });
      if (stored.stale) {
        this.revalidate(kind, key, profile, version, cached);
      }
      return stored.value;
    }
    // Joined AFTER the cache check, so a fresh answer still costs nothing.
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const pending = this.fetch(kind, key, profile, version, cached);
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      // Only its OWN entry: after a `forgetAgent` a newer ask may hold the key.
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Forget every cached listing, and say how many went — see
   * `CacheResetService`. The DURABLE half is cleared by that service too, and
   * separately: this map is one process's memory of the same answers.
   */
  clearCache(): number {
    const dropped = this.cache.size;
    this.cache.clear();
    return dropped;
  }

  /**
   * Forget ONE agent's listings, because it is now a different account
   * (`CacheResetService.forgetAgent`, from a sign-in or sign-out geniro ran).
   *
   * The memory half was never cleared on an account change — only the store
   * was — and this map is consulted FIRST, so the composer went on offering the
   * previous account's models for the rest of the ten-minute TTL. An ask
   * already running is detached rather than joined, and its answer is not
   * filed when it lands: it was taken under the credentials just replaced.
   */
  forgetAgent(kind: AgentKind): number {
    const prefix = cacheKey(kind, null);
    let dropped = 0;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
        dropped += 1;
      }
    }
    for (const key of [...this.inFlight.keys()]) {
      if (key.startsWith(prefix)) {
        this.inFlight.delete(key);
      }
    }
    this.generations.set(kind, (this.generations.get(kind) ?? 0) + 1);
    return dropped;
  }

  /**
   * Re-ask behind an answer already given.
   *
   * Through the SAME `inFlight` map a cold read uses, which is the whole
   * concurrency argument: a refresh cannot race a cold ask, and a second read
   * arriving while one is running joins it instead of spawning a second CLI.
   * `fetch` never rejects, so nothing here can surface as an unhandled
   * rejection from a promise nobody awaits.
   */
  private revalidate(
    kind: AgentKind,
    key: string,
    profile: string | null,
    version: string | null,
    cached: CacheEntry | undefined,
  ): void {
    if (this.inFlight.has(key)) {
      return;
    }
    const pending = this.fetch(kind, key, profile, version, cached);
    this.inFlight.set(key, pending);
    void pending.finally(() => {
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    });
  }

  private async fetch(
    kind: AgentKind,
    key: string,
    profile: string | null,
    version: string | null,
    cached: CacheEntry | undefined,
  ): Promise<AgentModelWire[]> {
    const adapter: AgentAdapter = this.adapters.for(kind);
    // Both halves' account generation, read BEFORE the ask — see
    // `generations` and `ModelVocabularyStore.epoch`.
    const generation = this.generations.get(kind) ?? 0;
    const askedAt = this.store.epoch(kind);
    let models: AgentModelWire[] = [];
    try {
      models = await adapter.listModels(
        { configDir: profile },
        {
          onSpawn: (child, spawnInfo) =>
            this.processes.register(
              `models:list:${randomUUID()}`,
              // Taken from the spawn, not restated: this is the one converted
              // site that IS handed the real value, so hand-writing `false`
              // here is the exact drift the required parameter prevents.
              childProcessHandle(child, spawnInfo),
            ),
        },
      );
    } catch (err) {
      this.logger.warn(
        `listing ${kind} models failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((this.generations.get(kind) ?? 0) !== generation) {
      // The account changed while this ask ran: whoever was waiting gets the
      // answer they asked for, and nothing of it is kept.
      return models;
    }
    if (models.length === 0) {
      const lastGood = this.lastGoodModels(kind, key, profile, cached);
      this.cache.set(key, {
        version,
        fetchedAt: this.now(),
        models: lastGood,
        ttlMs: UNANSWERED_LISTING_RETRY_MS,
      });
      return lastGood;
    }
    this.cache.set(key, { version, fetchedAt: this.now(), models });
    this.store.remember(kind, null, profile, version, models, askedAt);
    return models;
  }

  private lastGoodModels(
    kind: AgentKind,
    key: string,
    profile: string | null,
    cached: CacheEntry | undefined,
  ): AgentModelWire[] {
    const remembered = [this.cache.get(key), cached].find(
      (entry) => entry !== undefined && entry.models.length > 0,
    );
    return (
      remembered?.models ??
      this.store.readAnyVersion(kind, null, profile, isModelList) ??
      []
    );
  }
}

/**
 * What a stored listing has to look like to be served back.
 *
 * The store holds JSON, and this file outlives the build that wrote it — so a
 * row whose shape has since changed is exactly what a durable cache hands back,
 * and this is the difference between re-asking and giving the picker rows it
 * cannot render.
 */
function isModelList(value: unknown): value is AgentModelWire[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AgentModelWire).id === 'string' &&
        typeof (entry as AgentModelWire).label === 'string',
    )
  );
}
