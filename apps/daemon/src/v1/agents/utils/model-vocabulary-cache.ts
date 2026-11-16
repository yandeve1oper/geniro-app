import type { AgentKind } from '../../runs/runs.types';

/**
 * The caching a per-(CLI, model) vocabulary listing needs, without any of the
 * vocabularies.
 *
 * Two services ask a CLI the same SHAPE of question — which reasoning-effort
 * levels does this model take, which context-window sizes does it offer — and
 * both answers cost a real handshake against the binary (~2s for cursor), both
 * go stale only when the CLI or the account changes, and both are asked by two
 * screens at once the moment a model is picked. Extracted rather than mirrored
 * (`.claude/rules/daemon-module-structure.md`): the second service copying
 * these thirty lines is how a single-flight fix comes to exist in one of them.
 *
 * Three rules it holds, each of which was a defect the effort listing hit
 * first:
 *
 * - **Keyed by the BINARY's version as well as the model.** A CLI upgraded
 *   under a running daemon answers differently, and a TTL alone would serve
 *   the old vocabulary for its remainder.
 * - **Single-flight, joined AFTER the freshness check** — so a warm answer
 *   still costs nothing, while a cold one asked by the composer and a team
 *   inspector in the same instant spawns ONE process group rather than two.
 * - **A null model is its OWN key**, not a missing one: "what does this CLI
 *   offer at all" is a real question with a real answer, and folding it into
 *   the first model's entry would serve that model's list as the CLI's.
 */
export interface ModelVocabularyCacheOptions {
  /** How long an answer stays fresh. */
  ttlMs: number;
  /** Clock (test seam). */
  now: () => number;
}

/**
 * Brand for {@link VolatileAnswer}. A symbol rather than a string key, so a
 * cached value that happens to carry a `volatile` field of its own cannot be
 * mistaken for the wrapper.
 */
const VOLATILE = Symbol('volatile-answer');

/** An answer the cache must SERVE but must not remember. See {@link volatile}. */
export interface VolatileAnswer<T> {
  readonly [VOLATILE]: true;
  readonly value: T;
}

/**
 * Mark a `fetch` result as un-cacheable.
 *
 * A listing that could not actually be obtained still has to answer with
 * something — a picker with no rows is a dead control — but storing that
 * stand-in is what turns one transient probe failure into a TTL-long outage:
 * the next request reads the fallback as a fresh answer and never re-asks. The
 * fallback is returned to this caller and the entry is left as it was, so the
 * following request retries.
 */
export function volatile<T>(value: T): VolatileAnswer<T> {
  return { [VOLATILE]: true, value };
}

function isVolatile<T>(
  answer: T | VolatileAnswer<T>,
): answer is VolatileAnswer<T> {
  return typeof answer === 'object' && answer !== null && VOLATILE in answer;
}

/**
 * Ceiling on how many distinct `(agent, model)` entries {@link entries} holds
 * before the OLDEST is evicted — insertion-ordered `Map` iteration gives that
 * for free, so eviction costs one `.keys().next()` and one `.delete()`.
 * Without it, `model` is a caller-supplied string on every route this cache
 * backs, not a small enum, so a long-running daemon asked about enough
 * distinct strings would grow this map for its entire lifetime.
 *
 * 200 is a measurement, not a guess: a real cursor account was swept at 34
 * models total (the context-window part of `GET /v1/agents/vocabulary`). Even
 * generously accounting for BOTH shipped CLIs, several accounts/profiles switched across one daemon's lifetime, and
 * the per-CLI null-model entry, the live working set stays well under a
 * hundred keys — nobody works with hundreds of distinct models in one
 * session. Eviction here therefore only ever reaches a key from an abandoned
 * account or CLI version, which a later ask simply re-fetches.
 */
const MAX_ENTRIES = 200;

export class ModelVocabularyCache<T> {
  private readonly entries = new Map<
    string,
    { version: string | null; fetchedAt: number; value: T }
  >();
  private readonly inFlight = new Map<string, Promise<T>>();
  /**
   * Bumped per agent by {@link forget}. A fetch records the generation it
   * STARTED under and files its answer only if that is still current — an ask
   * taken under the account the user just replaced must not land after the
   * forget and put the previous account's vocabulary straight back.
   */
  private readonly generations = new Map<AgentKind, number>();

  constructor(private readonly options: ModelVocabularyCacheOptions) {}

  /**
   * The cached answer, or the one `fetch` produces — asked at most once per
   * (kind, model) at a time.
   *
   * `fetch` receives whatever was cached before, so a listing that fails can
   * keep serving the last good answer instead of a dead picker. It must not
   * throw; a rejection is the caller's to model. A stand-in it produces because
   * the real answer could not be obtained is wrapped in {@link volatile}, which
   * serves it without storing it — otherwise one failed probe answers for the
   * whole TTL.
   */
  async read(
    kind: AgentKind,
    model: string | null,
    configDir: string | null,
    version: string | null,
    fetch: (previous: T | undefined) => Promise<T | VolatileAnswer<T>>,
  ): Promise<T> {
    const key = keyFor(kind, model, configDir);
    const cached = this.entries.get(key);
    if (
      cached &&
      cached.version === version &&
      this.options.now() - cached.fetchedAt < this.options.ttlMs
    ) {
      return cached.value;
    }
    const running = this.inFlight.get(key);
    if (running) {
      return running;
    }
    const generation = this.generations.get(kind) ?? 0;
    const pending = fetch(cached?.value).then((answer) => {
      if (isVolatile(answer)) {
        return answer.value;
      }
      if ((this.generations.get(kind) ?? 0) !== generation) {
        // Served to the callers that asked before the account changed, and
        // never filed — see `generations`.
        return answer;
      }
      this.entries.set(key, {
        version,
        fetchedAt: this.options.now(),
        value: answer,
      });
      // A re-set of an already-present key leaves the map's size (and its
      // insertion-ordered iteration) unchanged, so this only ever fires the
      // read after a genuinely NEW key pushed the cache past its cap.
      if (this.entries.size > MAX_ENTRIES) {
        const oldestKey = this.entries.keys().next().value;
        if (oldestKey !== undefined) {
          this.entries.delete(oldestKey);
        }
      }
      return answer;
    });
    this.inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      // Only its OWN entry: after a `forget` a newer ask may hold the key.
      if (this.inFlight.get(key) === pending) {
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * The cached answer if it is still fresh, WITHOUT asking anything — the
   * synchronous read a request path can afford.
   *
   * The version is deliberately not consulted: resolving it spawns, and this
   * exists precisely so a caller need not. A CLI upgraded inside the TTL is the
   * one case that answers from the previous binary's vocabulary.
   */
  fresh(
    kind: AgentKind,
    model: string | null,
    configDir: string | null,
  ): T | undefined {
    const entry = this.entries.get(keyFor(kind, model, configDir));
    if (!entry || this.options.now() - entry.fetchedAt >= this.options.ttlMs) {
      return undefined;
    }
    return entry.value;
  }

  /**
   * Forget every answer, and say how many went — the user pressed "Clear Agent
   * Cache" (`CacheResetService`).
   *
   * `inFlight` is deliberately NOT cleared. An ask already running is a FRESH
   * ask, so its answer is exactly what the reset wants; dropping the entry
   * would only make a joined caller spawn a second process group for the same
   * question.
   */
  clear(): number {
    const dropped = this.entries.size;
    this.entries.clear();
    return dropped;
  }

  /**
   * Forget every answer ONE agent gave, because it is now a different account
   * — a sign-in or sign-out geniro ran (`CacheResetService.forgetAgent`).
   *
   * Stricter than {@link clear}, and deliberately: an ask already running was
   * taken under the credentials just replaced, which is the one case where an
   * in-flight answer is NOT fresh. So it is detached (a caller arriving now
   * starts its own ask rather than joining it) and its answer is served to the
   * callers already waiting but never filed.
   */
  forget(kind: AgentKind): number {
    const prefix = `${kind}\u0000`;
    let dropped = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
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
}

/**
 * `(agent, model, configDir)` — a null model is its own key, not a missing one,
 * and so is a null config directory.
 *
 * THE CONFIG DIRECTORY IS THE ACCOUNT, and everything cached here is an ACCOUNT
 * fact: which models exist, what efforts one takes, what context windows it
 * offers. A key without it served one subscription's vocabulary to a chat
 * running on another — silently, since a model list looks equally plausible
 * either way. Measured on the reporter's own machine: the two profiles of one
 * login report different subscriptions (`max` against `team`) from the same CLI
 * binary, so the version already in the entry cannot stand in for it.
 *
 * A CLI whose account is NOT decided by a config directory — one whose
 * `configDir.unavailableReason` says exactly that — passes null and keeps the
 * key it always had.
 *
 * Joined on a character no model id can contain, written as the ESCAPE and
 * never as the raw byte: a NUL inside a `.ts` file makes git classify the blob
 * as binary — no diff, no inline review, no three-way merge — and the repo's
 * own pre-commit hook refuses one for exactly that reason. The two are the
 * same code unit at runtime, so nothing about the key changes.
 */
function keyFor(
  kind: AgentKind,
  model: string | null,
  configDir: string | null,
): string {
  return `${kind}\u0000${model ?? ''}\u0000${configDir ?? ''}`;
}
