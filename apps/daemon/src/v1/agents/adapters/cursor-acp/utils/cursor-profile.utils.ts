import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_APPROVAL_MODE_CONFIG_KEY,
  CURSOR_ASKING_APPROVAL_MODE,
  CURSOR_AUTH_INFO_CONFIG_KEY,
  CURSOR_HOME_DIR_NAME,
  CURSOR_MAX_MODE_CONFIG_KEY,
  CURSOR_PERMISSIONS_CONFIG_KEY,
  CURSOR_PROFILE_DIR_PREFIX,
  CURSOR_READ_ONLY_PERMISSIONS,
  CURSOR_SEEDED_CONFIG_FILE,
  CURSOR_WEB_SEARCH_AUTO_ACCEPT_CONFIG_KEY,
} from '../cursor-acp.const';

/** What one turn's throwaway profile is built from. */
export interface CursorProfileSeed {
  /** Directory the throwaway profiles are created in. */
  baseDir: string;
  /**
   * Where the CLI's `acp-sessions` conversation store should really live, linked
   * into the profile under that name.
   *
   * Omitted for a profile whose sessions must die with it — a `listModels`
   * handshake opens a real session, and those belong nowhere the next turn can
   * find them. A CHAT turn always names one, or its thread cannot be resumed.
   */
  sessionStoreDir?: string;
  /** The user's home, for reading their `cli-config.json` (test seam). */
  homeDir?: string;
  /**
   * Open the handshake ON this model, by writing it into the copied
   * `cli-config.json` rather than switching afterwards.
   *
   * The CLI resolves its selected model from that file, and a `session/new`
   * reply describes THE CURRENT MODEL — its config options, and so its effort
   * vocabulary. Probed 2026-08-19 on 2026.08.11-e8db854: seeding `grok-4.6`
   * makes one handshake report `effort` as `low|medium|high|xhigh`, seeding
   * `claude-opus-5` reports the same plus `max`, and `auto-smart` reports no
   * `effort` option at all. That is the whole mechanism behind the per-model
   * effort listing, and it costs no extra frame — the alternative,
   * `session/set_config_option` after the fact, is a second round trip
   * measured at 2.2–3.0s.
   *
   * Only ever set on a PROBE profile. A turn does not use it: switching the
   * model in-protocol is what the driver already does, and moving that into the
   * profile would change every turn's path for no gain here.
   */
  model?: string;
  /**
   * Cursor's **Max Mode** — the window every model that carries no `context`
   * parameter of its own runs at ({@link CURSOR_MAX_MODE_CONFIG_KEY} holds the
   * measurements, both directions).
   *
   * Seeded rather than sent, because it is not on the protocol at all: it is a
   * key the CLI reads out of its config directory, so the only way a client
   * chooses it is by writing the config that CLI will read — which is what
   * makes it spawn-time rather than a frame.
   *
   * A TURN always names it — the run's own Max Mode option, on unless the user
   * turned it off. Written explicitly rather than inherited: the profile is a COPY of the
   * user's own `cli-config.json`, so leaving the key alone does not mean "off"
   * — it means whatever they last left their terminal on, and the same geniro
   * chat then ran at 200k or at 1M according to a switch flipped in another
   * app.
   *
   * Left `undefined` the key is untouched. That is what the PROBE profiles do:
   * a handshake asks a model which parameters it offers, and the answer does
   * not depend on this flag, so a probe has no reason to state it.
   */
  maxMode?: boolean;
  /**
   * Make the CLI send every permission request to geniro, by writing
   * {@link CURSOR_ASKING_APPROVAL_MODE} over whatever approval mode the copied
   * config carries, and turning off its web-search auto-accept — a user who
   * set either in their own terminal would otherwise have geniro's `ask` and
   * `plan` turns run tools with no card. A profile that cannot be written so
   * throws rather than run the turn without its cards.
   *
   * Left unset the user's own mode is kept: an `auto` turn approves every
   * request in the driver anyway, and a probe profile runs no tools.
   */
  askForApprovals?: boolean;
  /**
   * Replace the copied permissions with {@link CURSOR_READ_ONLY_PERMISSIONS}, so
   * the turn can run no shell command and write no file. A profile that cannot
   * be written so throws rather than run the turn with them.
   */
  readOnly?: boolean;
  /** A named configuration's own identity block; null drops the copied default account's. */
  authInfo?: Record<string, unknown> | null;
}

/**
 * A throwaway `CURSOR_CONFIG_DIR` for ONE turn, seeded from the user's own.
 *
 * **Why a turn needs its own profile at all.** Applying a model or a reasoning
 * effort over ACP is not a per-session call: `setCurrentModelWithParameters`
 * PERSISTS into the config directory's `cli-config.json`. Measured against
 * 2026.08.11-e8db854 — one `session/set_config_option` with a model changed
 * `model`, `selectedModel` and `modelSelectionHistory` in the real
 * `~/.cursor/cli-config.json`. So without this, choosing "Sonnet 5" in a geniro
 * chat silently changes what the user's OWN `cursor-agent` opens with, and a
 * per-chat effort would do the same. That is the one thing this app does not do
 * to a CLI's files (the MCP toggle is a deliberate, documented exception, and it
 * is deliberate precisely because it is the switch the user WANTS shared).
 *
 * **Why a copy of `cli-config.json`, and only that.** The copy is what keeps the
 * turn behaving like the user's own CLI — their `permissions.allow`, their
 * default model, their display settings all come along, so a run that names no
 * model still opens on the model they chose. Their `approvalMode` comes along
 * only for an `auto` turn or a probe; every other turn asks (`askForApprovals`). Nothing
 * else is copied:
 *
 * - `mcp.json` is deliberately NOT copied and NOT symlinked. It is mode 0600 and
 *   holds the user's own server credentials, and duplicating a secret-bearing
 *   file is not something a per-turn temp dir should do. It is also unnecessary,
 *   which is the part that had to be measured rather than hoped: under an
 *   isolated directory holding only `cli-config.json`, an ACP session still
 *   loaded the folder's MCP servers (codegraph / github / playwright visible in
 *   its own tool list) and `cursor-agent mcp list` still reported all eleven.
 *   The CLI resolves that file from the user's home directory either way.
 * - `statsig-cache.json` is left to the CLI to fetch. It writes ~690KB per turn,
 *   which sounded like a latency cost worth avoiding until it was measured: a
 *   handshake under a fresh directory took 5.9s against 6.5–7.7s on the default
 *   profile, so there is nothing to optimise and a shared cache file would only
 *   add a write nobody owns.
 *
 * A missing or unreadable source config is NOT an error: the CLI creates its own
 * defaults, and the turn runs on those rather than failing over a file geniro
 * merely wanted to inherit.
 *
 * **What must NOT be per turn, and the bug that taught it.** The CLI keeps each
 * ACP conversation at `<configDir>/acp-sessions/<sessionId>/` — inside the very
 * directory this removes on settle. So the first shipped version of this deleted
 * every thread as it created it, and a cursor chat's SECOND message died on
 * `-32602 Invalid params {"message":"Session \"…\" not found"}` with no reply
 * written: the turn failed at `session/load`, before the prompt. Measured on
 * 2026.08.11-e8db854, both directions — a load under the profile that created the
 * session succeeds, the same load under a second empty profile does not.
 *
 * So that ONE name is a symlink to a store shared by every turn, and everything
 * this isolation exists for stays per turn. Also measured, because the scheme
 * rests on it: the CLI writes THROUGH the link (the session store appeared in the
 * shared target, not in the profile), a second throwaway profile carrying the
 * same link resumed the session and answered a codeword only turn 1 was told,
 * `node:fs` `rm -r` of the profile unlinks the symlink and leaves the target
 * intact, and the user's own `cli-config.json` stayed byte-identical across a
 * turn that applied a model.
 */
export function seedCursorProfile(seed: CursorProfileSeed): string {
  mkdirSync(seed.baseDir, { recursive: true });
  // `mkdtemp` rather than a name built from the run: two turns of one run can be
  // in flight together under team fan-out, and they must not share a profile —
  // that is the same race, moved one level in.
  const dir = mkdtempSync(join(seed.baseDir, CURSOR_PROFILE_DIR_PREFIX));
  const configPath = join(dir, CURSOR_SEEDED_CONFIG_FILE);
  try {
    copyFileSync(
      join(
        seed.homeDir ?? homedir(),
        CURSOR_HOME_DIR_NAME,
        CURSOR_SEEDED_CONFIG_FILE,
      ),
      configPath,
    );
  } catch {
    // Absent, unreadable, or a directory — the CLI writes its own defaults.
  }
  const patch: Record<string, unknown> = {
    ...(seed.model !== undefined && seed.model !== ''
      ? {
          model: { modelId: seed.model },
          selectedModel: { modelId: seed.model, parameters: [] },
        }
      : {}),
    // `!== undefined` rather than a truthiness test: `false` is a REAL choice
    // here (turn Max Mode off over a user whose own config leaves it on), and
    // only an absent seed means "leave the inherited value alone".
    ...(seed.maxMode !== undefined
      ? { [CURSOR_MAX_MODE_CONFIG_KEY]: seed.maxMode }
      : {}),
    ...(seed.askForApprovals === true
      ? {
          [CURSOR_APPROVAL_MODE_CONFIG_KEY]: CURSOR_ASKING_APPROVAL_MODE,
          [CURSOR_WEB_SEARCH_AUTO_ACCEPT_CONFIG_KEY]: false,
        }
      : {}),
    ...(seed.readOnly === true
      ? { [CURSOR_PERMISSIONS_CONFIG_KEY]: CURSOR_READ_ONLY_PERMISSIONS }
      : {}),
    ...(seed.authInfo !== undefined
      ? { [CURSOR_AUTH_INFO_CONFIG_KEY]: seed.authInfo ?? undefined }
      : {}),
  };
  if (
    Object.keys(patch).length > 0 &&
    !patchSeededConfig(configPath, patch) &&
    (seed.askForApprovals === true || seed.readOnly === true)
  ) {
    // The copy may still say "run everything": running the turn would show
    // its user no card at all, so it fails instead.
    removeCursorProfile(dir);
    throw new Error(
      'cursor: could not write the turn profile that makes the agent ask before running tools',
    );
  }
  if (seed.sessionStoreDir !== undefined) {
    // Deliberately NOT swallowed, unlike the config copy above. A missing config
    // costs the user's settings for one turn; a missing link costs the THREAD,
    // silently, and the turn that discovers it is the one that cannot resume.
    // Every way this can fail (an unwritable userData dir) is one where the
    // daemon has already stopped working, so failing the turn here says so.
    mkdirSync(seed.sessionStoreDir, { recursive: true });
    symlinkSync(seed.sessionStoreDir, join(dir, CURSOR_ACP_SESSIONS_DIR_NAME));
  }
  return dir;
}

/**
 * Merge geniro's own keys into a seeded `cli-config.json`.
 *
 * THREE settings arrive here and all are top-level keys of that file. The MODEL
 * is written as the two keys the CLI reads its selection from and no others:
 * `model.modelId` is what it opens with, `selectedModel` is the parameterized
 * form the ACP handshake resolves. `parameters` is emptied deliberately — a
 * probe asks what the model OFFERS, and carrying the user's stored values for a
 * different model would have the CLI resolve an axis this one may not have.
 * MAX MODE is one boolean; see {@link CURSOR_MAX_MODE_CONFIG_KEY}. The APPROVAL
 * MODE is one string plus the web-search auto-accept switch; see
 * {@link CURSOR_APPROVAL_MODE_CONFIG_KEY} and
 * {@link CURSOR_WEB_SEARCH_AUTO_ACCEPT_CONFIG_KEY}.
 *
 * ONE read-modify-write for all of them, rather than one per setting: they are
 * seeded together and a second pass would re-read a file this call just wrote.
 *
 * Best-effort for the model: a failed write leaves the profile exactly as it
 * was, and the handshake then reports the CLI's own default model. The listing
 * above reads that as "we could not narrow it" and falls back to the superset,
 * which is the safe direction — a level wrongly hidden is a control the user
 * cannot reach, while one wrongly offered is refused with a sentence. Answers
 * whether the write landed, because the approval mode is not best-effort.
 *
 * The copy is REPLACED by a rename rather than written through: `copyFileSync`
 * keeps the source's mode, so a read-only user config would otherwise refuse
 * the write — and a failed write still leaves the copy as it was.
 */
function patchSeededConfig(
  configPath: string,
  patch: Record<string, unknown>,
): boolean {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      config = parsed as Record<string, unknown>;
    }
  } catch {
    // No config to merge into — write one carrying only geniro's keys.
  }
  const staged = `${configPath}.tmp`;
  try {
    writeFileSync(staged, JSON.stringify({ ...config, ...patch }));
    renameSync(staged, configPath);
    return true;
  } catch {
    rmSync(staged, { force: true });
    return false;
  }
}

/**
 * Drop one turn's profile. Never throws — a leftover costs disk, not a turn.
 *
 * Takes the `acp-sessions` SYMLINK with it and not the store behind it:
 * `node:fs` removes a directory tree by `lstat`, so a link is unlinked rather
 * than descended into. Measured, because the whole scheme rests on it — the
 * shared store survived removal of two profiles pointing at it.
 */
export function removeCursorProfile(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/**
 * Drop the profiles a previous daemon launch left behind.
 *
 * The disposer runs on every settle path, so this only ever finds directories
 * from a SIGKILLed daemon — where no disposer ran at all. Called once at boot,
 * for the same reason claude sweeps its per-turn MCP configs there.
 *
 * `baseDir` is the profile base and NEVER the conversation store, which is why
 * the two live in separate directories: this removes the base wholesale, so a
 * store nested inside it would be deleted on every launch — every cursor thread
 * unresumable after a restart, which is the same failure the per-turn profile
 * caused, moved to boot.
 */
export function sweepStaleCursorProfiles(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}
