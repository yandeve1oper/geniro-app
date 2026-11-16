import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { app } from 'electron';

import {
  DEFAULT_KNOWLEDGE,
  DEFAULT_LESSONS,
  DEFAULT_MEMORY,
  DEFAULT_RESOURCE_ALERTS,
  DEFAULT_SETTINGS,
  DEFAULT_SHARING,
  type KnowledgeSettings,
  type LessonsSettings,
  MAX_CONFIG_PROFILES,
  MAX_FAST_ACTIONS,
  MAX_RUN_CONFIGS,
  type MemorySettings,
  type ResourceAlertSettings,
  type Settings,
  type ShareDestination,
  type SharingSettings,
} from '../shared/contracts';
import {
  autoRevokeAfterDaysSchema,
  knowledgeSchema,
  lessonsSchema,
  MAX_SHARE_DESTINATIONS,
  memorySchema,
  resourceAlertsSchema,
  settingsPatchSchema,
  shareDestinationSchema,
  shareSignInSchema,
} from './ipc-schemas';
import {
  SETTINGS_VERSION,
  storedSettingsVersion,
  withPendingMigrations,
} from './settings-migrations';

/**
 * Non-secret app settings, persisted as a plain JSON file in Electron's
 * userData dir. We hand-roll this (atomic temp+rename writes) instead of
 * pulling in electron-store, whose current major is ESM-only and breaks
 * `require` from the CommonJS main process. Secrets never live here — and there
 * are none to live anywhere: see the Secrets section of `shared/contracts.ts`
 * for why the Keychain surface was removed and why the rule still stands.
 */
function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

/**
 * The file's top-level object, or `null` when it is not one. ONE predicate for
 * both sides of the file: what the read falls back to defaults over is exactly
 * what the write preserves before replacing, so neither can come to call a
 * file readable that the other would discard.
 */
function parseSettingsObject(text: string): Record<string, unknown> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

export function readSettings(): Settings {
  const path = settingsPath();
  const defaults = { ...DEFAULT_SETTINGS, settingsVersion: SETTINGS_VERSION };
  if (!existsSync(path)) {
    return defaults;
  }
  try {
    const stored = parseSettingsObject(readFileSync(path, 'utf8'));
    if (stored === null) {
      return defaults;
    }
    const record = withPendingMigrations(stored);
    // Salvage per key. The strict schema keeps renderer WRITES honest (ipc.ts
    // validates every patch), but the on-disk file can be newer than this
    // build — the notify-only brew flow makes version skew normal — so one
    // unknown or invalid key must cost only that key. A wholesale reset would
    // re-onboard the user, and the next updateSettings() write would make the
    // loss permanent. Merging over defaults also completes a file written by
    // an older version as the schema grows.
    const salvaged: Record<string, unknown> = {};
    for (const key of Object.keys(settingsPatchSchema.shape)) {
      if (!(key in record)) {
        continue;
      }
      if (
        key === 'cliPaths' ||
        key === 'configDirs' ||
        key === 'recentConfigDirs' ||
        key === 'agentOptions'
      ) {
        const entries = salvageCliRecord(key, record[key]);
        if (entries !== undefined) {
          salvaged[key] = entries;
        }
        continue;
      }
      if (key === 'runConfigs') {
        const configs = salvageList('runConfigs', record[key], MAX_RUN_CONFIGS);
        if (configs !== undefined) {
          salvaged[key] = configs;
        }
        continue;
      }
      if (key === 'fastActions') {
        const actions = salvageList(
          'fastActions',
          record[key],
          MAX_FAST_ACTIONS,
        );
        if (actions !== undefined) {
          salvaged[key] = actions;
        }
        continue;
      }
      if (key === 'sharing') {
        salvaged[key] = salvageSharing(record[key]);
        continue;
      }
      if (key === 'memory') {
        salvaged[key] = salvageMemory(record[key]);
        continue;
      }
      if (key === 'lessons') {
        salvaged[key] = salvageLessons(record[key]);
        continue;
      }
      if (key === 'knowledge') {
        salvaged[key] = salvageKnowledge(record[key]);
        continue;
      }
      if (key === 'resourceAlerts') {
        salvaged[key] = salvageResourceAlerts(record[key]);
        continue;
      }
      if (key === 'configProfiles') {
        const profiles = salvageList(
          'configProfiles',
          record[key],
          MAX_CONFIG_PROFILES,
        );
        if (profiles !== undefined) {
          salvaged[key] = profiles;
        }
        continue;
      }
      const field = settingsPatchSchema.shape[
        key as keyof typeof settingsPatchSchema.shape
      ].safeParse(record[key]);
      if (field.success && field.data !== undefined) {
        salvaged[key] = field.data;
      }
    }
    return {
      ...DEFAULT_SETTINGS,
      ...salvaged,
      settingsVersion: storedSettingsVersion(stored),
    } as Settings;
  } catch {
    return defaults;
  }
}

/**
 * The per-CLI records are nested, and zod rejects a record WHOLESALE on a
 * single unknown key or invalid value — exactly the blast radius the per-key
 * salvage exists to avoid (a newer build's extra agent kind would wipe the
 * user's still-valid binary paths). Salvage each entry by entry through the
 * same schema, so each bad entry costs only itself.
 */
function salvageCliRecord<
  K extends 'cliPaths' | 'configDirs' | 'recentConfigDirs' | 'agentOptions',
>(key: K, value: unknown): Settings[K] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const salvaged: Record<string, unknown> = {};
  for (const [kind, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const single = settingsPatchSchema.shape[key].safeParse({ [kind]: entry });
    if (single.success && single.data) {
      Object.assign(salvaged, single.data);
    }
  }
  return salvaged as Settings[K];
}

/**
 * Same per-entry salvage as {@link salvageCliPaths}, for the three HAND-MANAGED
 * lists — the saved run configurations, the fast actions, and the named agent
 * configurations. Zod rejects an ARRAY wholesale on one bad element, and the
 * blast radius here is the user's whole set of them, each hand-written and
 * unrecoverable. Order is preserved: it is the order the user arranged, not an
 * MRU this file is free to re-sort.
 *
 * ONE function over all three rather than a copy each. They are different
 * features and must never be folded together in the UI — but this rule is about
 * the FILE, not the feature: entry-by-entry, unique ids, re-apply the cap. A
 * second copy is how one list would quietly acquire a fix the other lacks.
 */
function salvageList<K extends 'runConfigs' | 'fastActions' | 'configProfiles'>(
  key: K,
  value: unknown,
  cap: number,
): Settings[K] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entry = settingsPatchSchema.shape[key].unwrap().element;
  const salvaged: Settings[K][number][] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const parsed = entry.safeParse(candidate);
    if (!parsed.success) {
      continue;
    }
    // Ids must be UNIQUE, and this is the only place that can guarantee it: the
    // schema cannot express it, and every consumer keys on the id across the
    // whole list, so a duplicate in a hand-edited file makes renaming one entry
    // silently rewrite another, and deleting one remove two.
    if (seen.has(parsed.data.id)) {
      continue;
    }
    seen.add(parsed.data.id);
    salvaged.push(parsed.data as Settings[K][number]);
  }
  // Salvaging entry-by-entry skips the array-level cap, so it is re-applied
  // here: an over-long hand-edited file would otherwise load in full and then
  // make every subsequent write fail its own schema.
  return salvaged.slice(0, cap) as Settings[K];
}

/**
 * The sharing settings, kept destination by destination: one destination a
 * newer build wrote, or a hand edit broke, must not cost the user every other
 * one — nor the switch beside them. Ids stay unique, and a default that names
 * a dropped destination falls back to none rather than pointing nowhere.
 */
function salvageSharing(value: unknown): SharingSettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SHARING;
  }
  const record = value as Record<string, unknown>;
  const destinations: ShareDestination[] = [];
  const seen = new Set<string>();
  for (const candidate of Array.isArray(record.destinations)
    ? record.destinations
    : []) {
    const parsed = shareDestinationSchema.safeParse(
      withSalvagedSignIn(candidate),
    );
    if (!parsed.success || seen.has(parsed.data.id)) {
      continue;
    }
    seen.add(parsed.data.id);
    destinations.push(parsed.data);
  }
  const kept = destinations.slice(0, MAX_SHARE_DESTINATIONS);
  const defaultId = record.defaultDestinationId;
  return {
    destinations: kept,
    defaultDestinationId:
      typeof defaultId === 'string' && kept.some((d) => d.id === defaultId)
        ? defaultId
        : null,
    agentsMayShare: record.agentsMayShare === true,
    autoRevokeAfterDays: autoRevokeAfterDaysSchema
      .catch(null)
      .parse(record.autoRevokeAfterDays ?? null),
  };
}

/** The memory settings field by field: one bad value keeps the other. */
function salvageMemory(value: unknown): MemorySettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_MEMORY;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: memorySchema.shape.enabled
      .catch(DEFAULT_MEMORY.enabled)
      .parse(record.enabled),
    agentWrites: memorySchema.shape.agentWrites
      .catch(DEFAULT_MEMORY.agentWrites)
      .parse(record.agentWrites),
    nativeMemoryOff: memorySchema.shape.nativeMemoryOff
      .catch(DEFAULT_MEMORY.nativeMemoryOff)
      .parse(record.nativeMemoryOff),
  };
}

/** The lessons settings field by field: one bad value keeps the others. */
function salvageLessons(value: unknown): LessonsSettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_LESSONS;
  }
  const record = value as Record<string, unknown>;
  return {
    mode: lessonsSchema.shape.mode
      .catch(DEFAULT_LESSONS.mode)
      .parse(record.mode),
    agentKind: lessonsSchema.shape.agentKind
      .catch(DEFAULT_LESSONS.agentKind)
      .parse(record.agentKind ?? null),
    model: lessonsSchema.shape.model
      .catch(DEFAULT_LESSONS.model)
      .parse(record.model ?? null),
    effort: lessonsSchema.shape.effort
      .catch(DEFAULT_LESSONS.effort)
      .parse(record.effort ?? null),
  };
}

/** The knowledge settings field by field: one bad value keeps the other. */
function salvageKnowledge(value: unknown): KnowledgeSettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_KNOWLEDGE;
  }
  const record = value as Record<string, unknown>;
  return {
    enabled: knowledgeSchema.shape.enabled
      .catch(DEFAULT_KNOWLEDGE.enabled)
      .parse(record.enabled),
    agentWrites: knowledgeSchema.shape.agentWrites
      .catch(DEFAULT_KNOWLEDGE.agentWrites)
      .parse(record.agentWrites),
  };
}

/** The resource watch settings field by field: one bad value keeps the rest. */
function salvageResourceAlerts(value: unknown): ResourceAlertSettings {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_RESOURCE_ALERTS;
  }
  const record = value as Record<string, unknown>;
  const shape = resourceAlertsSchema.shape;
  return {
    enabled: shape.enabled
      .catch(DEFAULT_RESOURCE_ALERTS.enabled)
      .parse(record.enabled),
    threadMemoryBytes: shape.threadMemoryBytes
      .catch(DEFAULT_RESOURCE_ALERTS.threadMemoryBytes)
      .parse(record.threadMemoryBytes),
    growthBytesPerMinute: shape.growthBytesPerMinute
      .catch(DEFAULT_RESOURCE_ALERTS.growthBytesPerMinute)
      .parse(record.growthBytesPerMinute),
    minFreeDiskBytes: shape.minFreeDiskBytes
      .catch(DEFAULT_RESOURCE_ALERTS.minFreeDiskBytes)
      .parse(record.minFreeDiskBytes),
  };
}

/**
 * A destination with its optional `signIn` cut down to the fields that still
 * parse, so a broken login command or pattern list costs only that field —
 * never the destination agents share to.
 */
function withSalvagedSignIn(candidate: unknown): unknown {
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('signIn' in candidate)
  ) {
    return candidate;
  }
  const { signIn, ...rest } = candidate as Record<string, unknown>;
  if (typeof signIn !== 'object' || signIn === null) {
    return rest;
  }
  const fields = signIn as Record<string, unknown>;
  const kept: Record<string, unknown> = {};
  for (const field of ['login', 'patterns'] as const) {
    if (
      fields[field] !== undefined &&
      shareSignInSchema.safeParse({ [field]: fields[field] }).success
    ) {
      kept[field] = fields[field];
    }
  }
  return Object.keys(kept).length === 0 ? rest : { ...rest, signIn: kept };
}

/**
 * Copies a settings.json that does not parse as an object to
 * `settings.json.corrupt-<timestamp>` beside it, before a write replaces it.
 *
 * The read answers such a file with DEFAULTS, so the first write after it —
 * `{...readSettings(), ...patch}` — is defaults plus one field, renamed over
 * the only copy of the user's run configurations, fast actions, named
 * profiles and custom instructions. Those are hand-written and nothing else
 * holds them. A file this build cannot parse may still be one a person (or a
 * newer build) can, so its bytes are kept verbatim.
 *
 * Here rather than at the read, because reads are frequent and a backup per
 * read would pile up; the write is the moment the loss would become
 * permanent, and after it the file parses, so this fires once per corruption.
 * A parseable file is never copied. One that cannot even be READ throws, and
 * the write with it: replacing bytes nobody could look at is the loss this
 * exists to prevent.
 */
function preserveUnparseableSettings(path: string): void {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw err;
  }
  if (parseSettingsObject(bytes.toString('utf8')) !== null) {
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // 0600 at CREATION (and `wx`, never over an existing file), as the device
  // registry writes: this may be the user's only copy of what it holds.
  writeFileSync(`${path}.corrupt-${stamp}`, bytes, {
    mode: 0o600,
    flag: 'wx',
  });
}

type SettingsListener = (settings: Settings) => void;
const settingsListeners = new Set<SettingsListener>();

/**
 * Told after every write that reached the file — the one seam every write
 * passes through, so a listener cannot miss a writer added later. A listener
 * must not throw: the write has already happened.
 */
export function onSettingsWritten(listener: SettingsListener): () => void {
  settingsListeners.add(listener);
  return () => settingsListeners.delete(listener);
}

/**
 * What a write puts in a file still below {@link SETTINGS_VERSION}: the raw file
 * with only the keys this write changes replaced. A migration that failed at
 * launch is tried again at the next one, and it needs every value it reshapes
 * or carries over still in its old form, not the salvaged default.
 */
function unmigratedFile(
  path: string,
  next: Settings,
  written: ReadonlySet<string>,
): Record<string, unknown> | null {
  let record: Record<string, unknown> | null;
  try {
    record = parseSettingsObject(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  if (record === null || storedSettingsVersion(record) >= SETTINGS_VERSION) {
    return null;
  }
  const current: Record<string, unknown> = { ...readSettings() };
  const changed = Object.entries(next).filter(
    ([key, value]) =>
      written.has(key) || !isDeepStrictEqual(value, current[key]),
  );
  return { ...record, ...Object.fromEntries(changed) };
}

/** `written`: the keys the caller set on purpose, kept even where they equal what was read. */
export function writeSettings(
  next: Settings,
  written: ReadonlySet<string> = new Set(),
): Settings {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify(unmigratedFile(path, next, written) ?? next, null, 2),
    'utf8',
  );
  preserveUnparseableSettings(path);
  renameSync(tmp, path);
  for (const listener of settingsListeners) {
    listener(next);
  }
  return next;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return writeSettings(
    { ...readSettings(), ...patch },
    new Set(Object.keys(patch)),
  );
}
