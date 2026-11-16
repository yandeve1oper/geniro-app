import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';

import { environment } from '../../../environments';
import { atomicWriteSync } from '../../../utils/atomic-file';

/** `<userData>/` file the model listings of each CLI are cached in. */
export const MODEL_VOCABULARIES_FILE_NAME = 'model-vocabularies.json';

/**
 * How old an entry may get before it is SERVED AND REFRESHED behind the answer
 * — see {@link StoredAnswer.stale}.
 *
 * An hour, and the number is a trade rather than a guess: the refresh is a real
 * CLI handshake that launches the user's own MCP servers, so revalidating on
 * every read would spend seconds of machine per panel open; an hour bounds
 * staleness by an hour of ACTIVE USE, which is the only clock a user
 * experiences. It matches nothing else on purpose — the in-memory TTL beside it
 * answers "may I skip the disk", this answers "is what the disk holds worth
 * re-asking".
 */
const REVALIDATE_AFTER_MS = 60 * 60_000;

/**
 * How old an entry may get before it is not served at all.
 *
 * The backstop under {@link REVALIDATE_AFTER_MS}, for the machine whose refresh
 * keeps failing — a CLI that has been uninstalled, an account that cannot
 * answer. Everything this app can actually DETECT invalidates exactly instead:
 * the CLI's version is compared on every read, and a sign-in or sign-out geniro
 * runs drops that agent's entries outright ({@link forget}).
 */
const FRESH_FOR_MS = 7 * 24 * 60 * 60_000;

/**
 * Defensive bound. One entry per (agent, model) the user has actually picked;
 * a real cursor account was swept at 34 models total, so sixty covers both
 * shipped CLIs and a couple of accounts with room to spare. Refusing to grow
 * past it costs one cold probe on a model this machine has never opened
 * before.
 */
const MAX_ENTRIES = 60;

/**
 * Refuse to read a store larger than this.
 *
 * The entry cap does not bound the WORK: `readFileSync` + `JSON.parse`
 * materialise the whole file before a single entry is validated, and a file of
 * nothing but invalid pairs never reaches the entry cap at all. Measured on a
 * real account, two cursor handshake replies filed 12,655 bytes — ~6.3KB each
 * once JSON-escaped, and a model LISTING is a fraction of that — so a full
 * sixty is around 380KB. The cap is an order of magnitude above that and well
 * below anything that would stall the boot it is read on.
 */
const MAX_STORE_BYTES = 4 * 1024 * 1024;

/**
 * Refuse to STORE a value larger than this.
 *
 * The file cap alone is reached too late — one implausible reply would fill it
 * and evict every model the user actually works with. A handshake reply is a
 * few JSON-RPC frames; anything past a quarter of a megabyte is not one.
 */
const MAX_ENTRY_BYTES = 256 * 1024;

/**
 * The (agent, model) key, NUL-joined — the same shape `ContextWindowStore` and
 * `SkillHarvestStore` use, because no model id a CLI reports contains that
 * byte, so the parts cannot be re-partitioned into different ones.
 *
 * A NULL model is its OWN key rather than a missing one, exactly as
 * `ModelVocabularyCache` states it: "what does this CLI offer at all" is a real
 * question with a real answer, and folding it into the first model's entry
 * would file that model's list as the CLI's.
 *
 * The CONFIG DIRECTORY is in the key for the reason the sibling cache states:
 * it decides the ACCOUNT, and every answer filed here is an account fact. It is
 * also why a row written before this existed is DROPPED rather than migrated —
 * such a row cannot say which account it describes, and guessing is how one
 * subscription's model list comes to be served under another's name. The loader
 * enforces the shape, so the drop is automatic and costs one re-ask.
 *
 * The CLI's VERSION is deliberately NOT in the key: it lives in the entry and
 * is compared on read, so an upgrade REPLACES a row instead of adding a second
 * one beside it. Keyed by version, an install that upgrades weekly would spend
 * its whole entry budget on versions nobody can run any more.
 */
export function modelVocabularyKey(
  agent: string,
  model: string | null,
  configDir: string | null,
): string {
  return `${agent}\u0000${model ?? ''}\u0000${configDir ?? ''}`;
}

/** One stored answer, with what it has to be checked against. */
interface StoredRecord {
  /** The CLI's own `--version` line when this was taken. */
  version: string;
  /** Epoch ms — see {@link REVALIDATE_AFTER_MS} and {@link FRESH_FOR_MS}. */
  fetchedAt: number;
  /** Whatever the caller filed. Its shape is the caller's to assert. */
  value: unknown;
}

/** What {@link ModelVocabularyStore.read} answers with. */
export interface StoredAnswer<T> {
  value: T;
  /** When this was taken, so a caller can seed its own in-memory entry. */
  fetchedAt: number;
  /**
   * Serve this, and re-ask BEHIND the answer. True past
   * {@link REVALIDATE_AFTER_MS}: the value is still the best answer anyone has,
   * and it is old enough that something the version cannot see may have moved
   * under it.
   */
  stale: boolean;
}

/** Constructor options — a test seam, not user config. */
export interface ModelVocabularyStoreOptions {
  /** The store file; defaults to `<userData>/model-vocabularies.json`. */
  file?: string;
  /** Clock (test seam). */
  now?: () => number;
}

/**
 * What each (agent, model) last answered about itself, ACROSS daemon launches.
 *
 * The durable half of `utils/model-vocabulary-cache.ts`, and the split is the
 * point: that cache stops ONE process asking twice, which is not what a user
 * feels. Measured against a cold daemon, a cursor model nobody has probed costs
 * 6.1–8.0s before its Effort, Context window and parameter rows can be drawn,
 * and the model LISTING costs its own handshake on top — and every app restart,
 * plus every ten-minute TTL lapse, paid both again. REPORTED as "это очень
 * долго! Так долго не должно быть. Это должно быть практически мгновенно."
 *
 * Instant is not something geniro can ask the CLI for: those seconds ARE a real
 * `cursor-agent acp` handshake. What it can stop doing is asking AGAIN for an
 * answer it already has.
 *
 * **Staleness is answered by three mechanisms, not by one timer**, because the
 * three causes are genuinely different:
 *
 * - the CLI was UPGRADED — the `version` in every entry, compared on each read.
 *   Exact, and it needs no clock;
 * - the ACCOUNT changed through geniro (a sign-in or sign-out this app ran) —
 *   {@link forget}, called from `CliAuthService`. Also exact;
 * - anything else — a plan change, an entitlement the vendor flipped, a
 *   `cursor-agent login` in the user's own terminal. Nothing here can observe
 *   those, so the answer is SERVE-THEN-REFRESH ({@link StoredAnswer.stale}):
 *   the user waits for nothing and the answer is at most one interaction
 *   behind, with {@link FRESH_FOR_MS} as the backstop for a refresh that never
 *   succeeds.
 *
 * It stays a CACHE of something the CLI will answer again, never a source of
 * truth: an unreadable, absent or expired entry simply means the ask is made,
 * which is exactly what happens today. Reads are SYNCHRONOUS, like
 * `ContextWindowStore`'s, because a caller consults it inside a single-flight
 * check — an await there would let a second caller past.
 */
@Injectable()
export class ModelVocabularyStore {
  private readonly logger = new Logger(ModelVocabularyStore.name);
  private readonly file: string;
  private readonly now: () => number;
  private records: Map<string, StoredRecord> | null = null;
  /**
   * Per agent, how many times {@link forget} has run in this process — see
   * {@link epoch}. In memory only: an ask never outlives the process that
   * started it, so there is nothing to carry across a launch.
   */
  private readonly epochs = new Map<string, number>();

  constructor(options: ModelVocabularyStoreOptions = {}) {
    this.file =
      options.file ??
      join(environment.userDataDir, MODEL_VOCABULARIES_FILE_NAME);
    this.now = options.now ?? Date.now;
  }

  /**
   * What this (agent, model) last answered UNDER THIS VERSION of the CLI, or
   * null when there is none, it was taken under another version, it has
   * expired, or it no longer has the shape the caller expects.
   *
   * `isValid` is the caller's, because this store holds JSON and cannot know
   * what any of it means. It is not ceremony: the file outlives the build that
   * wrote it, so a value whose shape has since changed is exactly what a
   * long-lived cache serves back, and a guard is the difference between
   * re-asking and handing a picker rows it cannot render.
   *
   * A null `version` — the CLI's `--version` could not be read — answers null
   * rather than serving the newest entry: the version check is the whole reason
   * a stored answer can be trusted, and skipping it on the one path that cannot
   * perform it would serve an upgraded CLI its predecessor's answer.
   */
  read<T>(
    agent: string,
    model: string | null,
    configDir: string | null,
    version: string | null,
    isValid: (value: unknown) => value is T,
  ): StoredAnswer<T> | null {
    if (version === null) {
      return null;
    }
    const record = this.load().get(modelVocabularyKey(agent, model, configDir));
    if (record === undefined || record.version !== version) {
      return null;
    }
    const age = this.now() - record.fetchedAt;
    if (age >= FRESH_FOR_MS || !isValid(record.value)) {
      return null;
    }
    return {
      value: record.value,
      fetchedAt: record.fetchedAt,
      stale: age >= REVALIDATE_AFTER_MS,
    };
  }

  readAnyVersion<T>(
    agent: string,
    model: string | null,
    configDir: string | null,
    isValid: (value: unknown) => value is T,
  ): T | null {
    const record = this.load().get(modelVocabularyKey(agent, model, configDir));
    if (
      record === undefined ||
      this.now() - record.fetchedAt >= FRESH_FOR_MS ||
      !isValid(record.value)
    ) {
      return null;
    }
    return record.value;
  }

  /**
   * File what a CLI just answered.
   *
   * Refuses the two things that must never reach disk: an answer taken under an
   * unknown CLI version (unmatchable, so it would only ever occupy a slot), and
   * one too large to be a vocabulary. Whether an answer is worth storing AT ALL
   * is the caller's judgement — this store cannot tell a real reply from the
   * stand-in an adapter returns when it could not ask.
   */
  remember(
    agent: string,
    model: string | null,
    configDir: string | null,
    version: string | null,
    value: unknown,
    /**
     * The {@link epoch} the ask behind `value` STARTED under. An answer whose
     * ask began before a {@link forget} was taken under the account that was
     * just replaced, and is refused rather than filed — otherwise a refresh
     * already running when the user signed in writes the previous account's
     * vocabulary straight back, for a week. Omitted means "no race to guard".
     */
    askedAt?: number,
  ): void {
    if (version === null) {
      return;
    }
    if (askedAt !== undefined && askedAt !== this.epoch(agent)) {
      return;
    }
    let encoded: string;
    try {
      encoded = JSON.stringify(value);
    } catch {
      // A value that cannot be encoded is a caller bug, not a reason to take
      // the daemon down inside a fire-and-forget cache write.
      return;
    }
    if (encoded === undefined || encoded.length > MAX_ENTRY_BYTES) {
      return;
    }
    const records = this.load();
    const key = modelVocabularyKey(agent, model, configDir);
    if (!records.has(key) && records.size >= MAX_ENTRIES) {
      // DEAD rows first: an entry past the freshness window is one `read`
      // already refuses to serve, so it holds a slot for nothing and every
      // model arriving after it pays a cold handshake on every launch instead
      // of the one cold probe the design intends.
      const now = this.now();
      for (const [existingKey, existingRecord] of records) {
        if (now - existingRecord.fetchedAt >= FRESH_FOR_MS) {
          records.delete(existingKey);
        }
      }
      if (records.size >= MAX_ENTRIES) {
        // Sixty entries all still fresh: refusing is the deliberate answer, not
        // an oversight. Evicting to admit this one would drop a model the user
        // may be working in right now, and the cost of refusing is one cold ask
        // on a model this machine has never opened.
        return;
      }
    }
    records.set(key, { version, fetchedAt: this.now(), value });
    this.save(records);
  }

  /**
   * Drop everything this agent answered, and say how many rows went.
   *
   * The EXACT half of the invalidation story, for the one account change geniro
   * can actually observe: it ran the sign-in itself. A new account is a
   * different subscription, so its models and the settings each of them offers
   * are a different set — and none of that moves the CLI's `--version`, which
   * is the only other check a read makes. Without this the user would sign in
   * and go on being shown the previous account's vocabulary until the refresh
   * window lapsed.
   */
  forget(agent: string): number {
    this.epochs.set(agent, this.epoch(agent) + 1);
    const records = this.load();
    const prefix = `${agent}\u0000`;
    let dropped = 0;
    for (const key of [...records.keys()]) {
      if (key.startsWith(prefix)) {
        records.delete(key);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.save(records);
    }
    return dropped;
  }

  /**
   * Which account generation of this agent an ask is being taken under.
   *
   * Read it BEFORE asking the CLI and hand it back to {@link remember} with the
   * answer: {@link forget} moves it on, so an answer whose ask straddled a
   * sign-in is recognizably from the previous account.
   */
  epoch(agent: string): number {
    return this.epochs.get(agent) ?? 0;
  }

  /**
   * Forget everything, and say how many rows went.
   *
   * The MANUAL half of the invalidation story, for the case none of the three
   * automatic ones covers: the user has reason to believe what is on screen is
   * wrong, and would rather pay the handshakes than argue with a cache. It is a
   * separate method from {@link forget} because they answer different
   * questions — that one is "this agent is now a different account", this one
   * is "start over" — and folding them together would have the sign-in path
   * throw away the other CLI's answers too.
   */
  clear(): number {
    const dropped = this.load().size;
    if (dropped > 0) {
      this.save(new Map());
    }
    return dropped;
  }

  private load(): Map<string, StoredRecord> {
    if (this.records !== null) {
      return this.records;
    }
    const records = new Map<string, StoredRecord>();
    try {
      if (statSync(this.file).size > MAX_STORE_BYTES) {
        throw new Error('model-vocabulary cache is implausibly large');
      }
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        let seen = 0;
        for (const [key, value] of Object.entries(parsed)) {
          // Counted per ITERATION, not per accepted entry: a file of nothing
          // but invalid rows would otherwise never reach the cap at all.
          if (++seen > MAX_ENTRIES) {
            break;
          }
          // Validated per entry rather than per file: one corrupted row must
          // not discard every other model's answer.
          if (isStoredRecord(value) && key.split('\u0000').length === 3) {
            records.set(key, value);
          }
        }
      }
    } catch {
      // Missing or malformed — nothing is known, which is the state a fresh
      // install is in. The next write replaces the file wholesale, so a corrupt
      // one repairs itself rather than needing a migration.
    }
    this.records = records;
    return records;
  }

  /**
   * Write the map out, SYNCHRONOUSLY — the file is consistent with what
   * {@link remember} just recorded by the time it returns.
   *
   * It was a floating promise, and nothing could then know when it landed.
   * Two consequences, both real: two `remember` calls in the same tick raced
   * each other's rename, so the OLDER snapshot could win and the file end up
   * behind the map it mirrors; and a caller that needs the write to be over —
   * a spec tearing its temp directory down — had only a fixed delay to wait,
   * which is what made `model-vocabulary.store.spec.ts` fail on CI with
   * `ENOTEMPTY` while a straggler staged its tmp file inside the `rmSync`.
   *
   * Blocking is affordable HERE and is not a licence to write this way
   * elsewhere: `remember` is called once per cold CLI probe — a handshake that
   * has just cost seconds — and the file is bounded by {@link MAX_ENTRIES}.
   */
  private save(records: Map<string, StoredRecord>): void {
    // The in-memory map is updated before the write, so a disk failure leaves
    // THIS daemon serving the answer while warning that it will not survive a
    // restart.
    this.records = records;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      atomicWriteSync(this.file, JSON.stringify(Object.fromEntries(records)));
    } catch (err) {
      this.logger.warn(
        `model-vocabulary cache write failed (this session only, lost on restart): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<StoredRecord>;
  return (
    typeof record.version === 'string' &&
    record.version !== '' &&
    typeof record.fetchedAt === 'number' &&
    Number.isFinite(record.fetchedAt) &&
    'value' in record
  );
}
