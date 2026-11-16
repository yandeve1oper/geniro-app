import type {
  ApprovalOptionScope,
  BackgroundUnitOutcome,
} from '../adapter.types';

// ── `cursor-agent acp` ────────────────────────────────────────────────────

/**
 * Argv for the ACP server. Named because two callers now spell it: the turn
 * path's `buildArgs`, and the model listing, which spawns the same server for
 * a handshake and nothing else.
 */
export const CURSOR_ACP_ARGS: readonly string[] = ['acp'];

/** `clientInfo.name` this client introduces itself with over ACP. */
export const CURSOR_ACP_CLIENT_NAME = 'geniro';

// ── The parameterized model picker ────────────────────────────────────────
//
// WHERE THIS CAME FROM. Read out of the CLI's own bundled source, not any
// published doc — `~/.local/share/cursor-agent/versions/<v>/2996.index.js` on
// 2026.08.11-e8db854:
//
//   clientSupportsParameterizedModelPicker() {
//     return true === this.clientCapabilities?._meta?.parameterizedModelPicker;
//   }
//   getModelPickerMode() {
//     return this.clientSupportsParameterizedModelPicker()
//       ? "parameterized" : "variants";
//   }
//
// Without the flag the agent runs in `variants` mode: it composes ONE opaque id
// per model family out of that family's stored parameters
// (`claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`) and
// accepts only those — which is why "I cannot change the effort of a Cursor
// model" was true, and why it was mis-recorded here as a property of the CLI
// rather than of the handshake geniro happened to send.
//
// With it, `session/new` returns the model as a BARE name plus one config
// option per parameter, each carrying its own vocabulary. Measured on the same
// build, with the account's own models:
//
//   model    [model]         claude-opus-5, claude-sonnet-5, … (33 bare names)
//   effort   [thought_level] low, medium, high, xhigh, max
//   thinking [thought_level] false, true
//   context  [model_config]  300k, 1m
//   fast     [model_config]  false, true
//
//   model=claude-opus-5 -> ACCEPTED, and its parameters appear with defaults
//   effort=xhigh        -> ACCEPTED   (rejected in variants mode)
//   effort=max          -> ACCEPTED
//   effort=bogus        -> -32602     (so the vocabulary is authoritative)
//
// ORDER IS LOAD-BEARING. `buildModelParameterConfigOptions` derives the options
// from the CURRENT model, and a fresh profile opens on `auto-smart`, which has
// no parameters at all — so setting `effort` before `model` is
// `-32602 Unknown model config option: effort`. Model first, then parameters.

/**
 * The `clientCapabilities._meta` this client declares. A vendor extension bag,
 * so it lives here and is injected into the agent-agnostic driver rather than
 * spelled inside it.
 *
 * - `parameterizedModelPicker` unlocks the separate effort control (above).
 * - `subagents` turns on SUB-AGENT SESSIONS — an early draft of ACP's unstable
 *   "Subagent Sessions" RFD, which the driver reads (`acp/acp-subagents.ts`).
 *   It has to ride `_meta`: the ACP SDK this CLI bundles (0.14.1) parses
 *   `initialize` with a zod object that DROPS unknown top-level keys, so a
 *   top-level `clientCapabilities.subagents` never reaches its gate. Measured
 *   on 2026.10.01-e373342 both ways: top-level, the wire was byte-for-byte the
 *   old one; under `_meta`, the agent answered
 *   `sessionCapabilities.subagents: {}` and sent `subagent_spawned` (carrying
 *   the launching call in `_meta.cursor.toolCallId`), every step of each
 *   sub-agent under the sub-agent's own session id, and
 *   `subagent_state_update` the moment one ended. It also HOLDS the parent's
 *   prompt while background sub-agents run and continues the parent on their
 *   results itself — the wakeup its interactive client always ran. An older
 *   CLI ignores the key, and the transcript watch stays the fallback.
 */
export const CURSOR_ACP_CLIENT_META: Readonly<Record<string, unknown>> = {
  parameterizedModelPicker: true,
  subagents: {},
};

/**
 * The parameter whose values ARE the reasoning-effort vocabulary — every
 * spelling of it KNOWN to have been enumerated, weakest-known first.
 *
 * ONE axis, three names, and which one a model uses is the MODEL's business:
 * probed 2026-08-19 on 2026.08.11-e8db854, `claude-opus-5` and `grok-4.6`
 * enumerate `thought_level/effort` while `gpt-5.2` enumerates
 * `thought_level/reasoning` (`low|medium|high|extra-high`). Sending the wrong
 * one is `-32602 Unknown model config option`, which is why the OpenAI-family
 * models had no working effort control at all until this became a list.
 *
 * `reasoning_effort` is the THIRD, and it arrived the way a fourth will —
 * inside a vendor release, on the newest model of a family whose previous one
 * spelled it differently. Swept 2026-09-22 across all 37 models of one account
 * on 2026.09.10-fd3934a: `effort` on 11, `reasoning` on 12, `reasoning_effort`
 * on exactly `grok-4.7` and `gemini-3.8-flash` — whose predecessors `grok-4.6`
 * and `gemini-3.7-flash` both say `effort`. REPORTED as two symptoms of that
 * one miss: an `Effort` row drawn TWICE (geniro's own, from the CLI-wide
 * superset, beside the unrecognised option arriving as a generic model-setting
 * chip the CLI happens to label `Effort` too) and, on the turn,
 * `NOT APPLIED this model has no 'effort' setting`. Confirmed on the wire the
 * same day: `session/set_config_option reasoning_effort=xhigh` on `grok-4.7`
 * is ACCEPTED and reads back `currentValue: "xhigh"`, where `effort=xhigh` on
 * that model is `-32602 Unknown model config option: effort`.
 *
 * So the list is no longer the only mechanism — see
 * {@link CURSOR_THOUGHT_LEVEL_CATEGORY}, which is what recognises the fourth
 * spelling before it is measured. This stays the PREFERRED reading: a name the
 * vendor has actually been seen to use beats an inference from a category.
 *
 * Named rather than inline because three readers spell it — the listing, the
 * selection builder and the driver's alias resolution.
 */
export const CURSOR_EFFORT_PARAMETER_IDS = [
  'effort',
  'reasoning',
  'reasoning_effort',
] as const;

/**
 * The ACP category every spelling of that axis has been enumerated under — and
 * the fallback that keeps an UNKNOWN spelling from reading as two controls.
 *
 * `thought_level` is the protocol's own word (an arm of the ACP schema's
 * `SessionConfigOptionCategory`, alongside `model` and `mode`), not this
 * vendor's, which is what makes it safe to key on — the same argument
 * {@link ACP_MODEL_CONFIG_CATEGORY} already records for the model option.
 *
 * It cannot REPLACE the id list, because the category holds a second axis:
 * measured in the same sweep, 10 of the 37 models enumerate
 * `thought_level/thinking`, a `false|true` toggle geniro deliberately renders
 * as an ordinary model-setting chip, and every one of them enumerates its
 * effort axis beside it. So the fallback takes the sole GRADED option of the
 * category — a boolean pair is a toggle, and an effort axis has levels — which
 * across all 37 models picks exactly the option the id list picks, and nothing
 * on a model that has no such axis (`auto-smart`, `composer-2.5`).
 */
export const CURSOR_THOUGHT_LEVEL_CATEGORY = 'thought_level';

/**
 * The spelling geniro SENDS when it has nothing better to go on.
 *
 * The first of {@link CURSOR_EFFORT_PARAMETER_IDS}, because it is the one every
 * model but the OpenAI family uses. It is only ever the fallback: where the
 * session reply describes the turn's model, the driver picks whichever spelling
 * that model actually offers.
 */
export const CURSOR_EFFORT_PARAMETER_ID = CURSOR_EFFORT_PARAMETER_IDS[0];

/**
 * The parameter that selects which CONTEXT WINDOW a model runs at.
 *
 * ONE spelling, unlike the effort axis, and that is a measurement rather than
 * an assumption: swept across all 34 models on 2026-08-21 (2026.08.11-e8db854),
 * every model that offers the axis at all spells it `context` under the
 * category `model_config` — the twelve that do differ in their VALUES
 * (`300k|1m`, `272k|1m`, `200k|1m`) and not in the key. Re-check by re-running
 * that sweep; a second spelling appearing turns this into a list, exactly as
 * {@link CURSOR_EFFORT_PARAMETER_IDS} already is.
 *
 * RE-CHECKED 2026-08-24 on the same build, prompted by "it didnt load contexts
 * for cursor": still `context`, still `model_config`, and the listing was
 * right. `claude-opus-5` enumerates `context = 300k {300k|1m}`; `kimi-k3` — the
 * model in the report — enumerates `reasoning` and NO `context` at all. That
 * last clause used to end "so it genuinely runs at one fixed window", which was
 * REFUTED on 2026-08-25 — see {@link CURSOR_MAX_MODE_CONFIG_KEY}: a model with no
 * `context` parameter takes its window from the config file's Max Mode flag
 * instead, and `kimi-k3` runs at 1,048,576 tokens under it. Which geniro always
 * sets, so such a model does now run at one fixed window — its largest.
 * Worth knowing for the next reader: without the
 * {@link CURSOR_ACP_CLIENT_META} flag the same probe returns `mode` and `model`
 * ALONE, with every parameter folded into the composed model id
 * (`claude-sonnet-4-5[thinking=true,context=200k]`) — so a hand-run probe that
 * forgets the flag will "reproduce" a broken listing on every model and blame
 * the wrong layer.
 *
 * Named rather than inline because three readers spell it: the listing probe,
 * the turn's selection builder, and the driver that sends it.
 */
export const CURSOR_CONTEXT_WINDOW_PARAMETER_ID = 'context';

/**
 * The config-option ids geniro ALREADY drives through a control of its own —
 * everything `listModelParameters` must subtract before offering the rest.
 *
 * `mode` is on the list and is the one that is easy to miss: it is not a model
 * parameter this app ignores, it is the ACP session mode the driver sets from
 * the run's approval mode (`preferredModeId` → `session/set_mode`). Offering it
 * again as a chip would put two controls on screen for one setting, each able
 * to overwrite the other's answer on the next turn.
 *
 * The model option itself is NOT here, and deliberately: it is excluded by its
 * `category` instead, which is the PROTOCOL's own word for it, while an id is
 * the agent's. cursor happens to spell it `model` today; an agent that spelled
 * it anything else would still be caught.
 */
export const CURSOR_OWNED_PARAMETER_IDS: readonly string[] = [
  'mode',
  ...CURSOR_EFFORT_PARAMETER_IDS,
  CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
];

/**
 * The key **Max Mode** rides in `cli-config.json` — a top-level boolean, not a
 * model parameter and not on the protocol at all.
 *
 * REPORTED as "в курсоре там 1 000 000", with a screenshot of Cursor's own agent
 * panel reading `~48.5K / 1.048576M Tokens` on Kimi K3 — against geniro showing
 * 200k for the same model with no way to change it. The answer here used to be
 * that the CLI genuinely had one window for that model and there was nothing to
 * fix. That was wrong, and this is the mechanism it missed.
 *
 * MEASURED 2026-08-25 on 2026.08.11-e8db854, over ACP — the transport geniro
 * drives — with the flag as the ONLY difference between two runs, each under its
 * own throwaway config directory, each figure read back out of that CLI's own
 * session store:
 *
 *     kimi-k3, cli-config.json {"maxMode": false}  →  maxTokens   200,000
 *     kimi-k3, cli-config.json {"maxMode": true}   →  maxTokens 1,048,576
 *
 * geniro writes it on every turn, from the turn's {@link CURSOR_MAX_MODE_OPTION}
 * option; {@link CURSOR_MAX_MODE} carries why that defaults on and what it
 * costs.
 *
 * TWO NEARBY THINGS IT IS NOT. It is not the `context` parameter — a model that
 * has one obeys the parameter and ignores this, measured both ways on
 * `gpt-5.6-sol`. And it is not `maxModeAutoEnabled`, the neighbouring key in the
 * same file, which reads like a global "use Max Mode where you can" and is not:
 * the CLI writes it ITSELF as bookkeeping when it auto-enabled the flag for a
 * model whose catalog entry says `requiresMaxMode`. Setting it by hand changes
 * nothing — measured, `kimi-k3` reports 200,000 with
 * `{"maxMode": false, "maxModeAutoEnabled": true}`.
 *
 * Read from the config file's TOP LEVEL. A `model.maxMode` beside it is NOT the
 * switch — set alone, the same kimi-k3 turn came back at 200,000.
 */
export const CURSOR_MAX_MODE_CONFIG_KEY = 'maxMode';

/**
 * The `cli-config.json` key that decides which tool calls the CLI asks about,
 * and the value that makes it ask: `allowlist` | `auto-review` | `unrestricted`
 * (the CLI's own settings schema, 2026.10.01-e373342).
 *
 * MEASURED over ACP on that build, a throwaway profile with only this key
 * changed and a prompt asking for a shell command off the allowlist:
 * `unrestricted` ran it with NO `session/request_permission`, while
 * `allowlist` sent one. `auto-review` asked on the measured account too, but
 * the bundle lets it decide by itself where the team enables smart auto and a
 * classifier model is available — so outside `auto` the seed writes
 * `allowlist`, the one value that always reaches geniro.
 */
export const CURSOR_APPROVAL_MODE_CONFIG_KEY = 'approvalMode';

/** See {@link CURSOR_APPROVAL_MODE_CONFIG_KEY}. */
export const CURSOR_ASKING_APPROVAL_MODE = 'allowlist';

/**
 * The `cli-config.json` switch that approves every web search without asking,
 * whatever the approval mode. MEASURED over ACP on 2026.10.01-e373342 under
 * `allowlist`: with it `true` a web search ran with no
 * `session/request_permission`, without it the same prompt sent one. So an
 * asking turn writes it `false` beside the approval mode.
 */
export const CURSOR_WEB_SEARCH_AUTO_ACCEPT_CONFIG_KEY = 'autoAcceptWebSearch';

/**
 * The `cli-config.json` permissions a read-only turn (`AgentTurnInput.readOnly`)
 * is seeded with: no allow rule copied from the user's own, and a hard deny on
 * every shell command and every write. MEASURED over ACP on 2026.11.05-86047df
 * in a throwaway profile with `Shell(ls)` allowed: the shell answered
 * "Command blocked by permissions configuration", a patch "Write permission
 * denied … Blocked by permissions configuration", with no
 * `session/request_permission` and no file written. Both tools stay listed;
 * deny is checked before allow, and `*` / `**` match any command and any path.
 */
export const CURSOR_PERMISSIONS_CONFIG_KEY = 'permissions';
export const CURSOR_READ_ONLY_PERMISSIONS = {
  allow: [],
  deny: ['Shell(*)', 'Write(**)'],
} as const;

/**
 * How long cursor keeps an "Allow always" answer as geniro runs it: one
 * SESSION.
 *
 * cursor offers `allow-once` / `allow-always` / `reject-once` on every
 * `session/request_permission` it raises (the CLI's own handlers, 2026.10.19-
 * 6bbf2c4), and `allow-always` adds the call's commands to the `permissions`
 * allowlist of the `cli-config.json` in `CURSOR_CONFIG_DIR`. MEASURED over ACP
 * on that build, under a profile seeded like `seedCursorProfile` and one
 * process asked twice to run `mkdir -p probe-out && touch probe-out/marker.txt`:
 * `allow-once` asked twice; `allow-always` asked ONCE and the profile's list
 * gained `Shell(mkdir)` and `Shell(touch)`, while `~/.cursor/cli-config.json`
 * was untouched.
 *
 * That profile is the conversation process's own — seeded when it spawns and
 * removed when it closes (`prepareTurn`) — so the answer outlives neither, and
 * the card offers it as "for this session" rather than under cursor's word.
 */
export const CURSOR_ALWAYS_ANSWER_SCOPE: ApprovalOptionScope = 'session';

/**
 * The option id behind {@link CURSOR_MAX_MODE_CONFIG_KEY} — declared in
 * `getConfig().options` and read by the turn's profile seed, which is why it is
 * named.
 */
export const CURSOR_MAX_MODE_OPTION = 'maxMode';

/**
 * What a cursor turn runs at when nobody has said — Max Mode ON.
 *
 * It is the DEFAULT of this adapter's {@link CURSOR_MAX_MODE_OPTION} option,
 * which every run snapshots when it is created, and it is still a plain
 * boolean rather than a picker row or a remembered measurement.
 *
 * It began as two rows in the context-window picker (`standard` / `max mode`)
 * whose sizes geniro learned from turns that had run. That was rejected on the
 * two grounds that matter: **Max Mode is not a context window** — it is a mode,
 * and the two are different things — and a learned size is a cache that is
 * wrong for as long as it takes the vendor to change a number and the user to
 * run another turn. Neither objection is answerable by a better cache.
 *
 * On rather than off, because the flag can only ever WIDEN, and that is
 * measured rather than assumed:
 *
 * - a model that HAS the `context` parameter obeys the parameter and ignores
 *   this flag — `gpt-5.6-sol` at `context=272k` reports 272,000 with the flag
 *   on and 272,000 with it off, and `context=1m` reports 1,000,000 either way.
 *   So the per-model picker keeps deciding, exactly as it did;
 * - a model that has NO such parameter obeys the flag — `kimi-k3` reports
 *   200,000 off and 1,048,576 on;
 * - a model that honours neither is unchanged — `composer-2.5` reports 200,000
 *   both ways.
 *
 * So every model runs at the largest window it has, the choice where there IS
 * one stays the CLI's own answer read from its own handshake, and geniro holds
 * no table and no measurement of anybody's context sizes.
 *
 * WHAT IT COSTS, and why there is a switch at all. Cursor bills Max Mode at the
 * model's API rate plus 20% on LEGACY request-based plans; on current
 * token-based plans it is the billing mode several models are already on. A
 * user on a legacy plan is paying a surcharge for a window they may not want,
 * which is not a call this app gets to make for them — hence the setting. The
 * default stays ON because the reported defect was a window that was too SMALL
 * (`kimi-k3` at 200k against cursor's own 1M), and because a user who has not
 * been asked is better served by their model's full window.
 *
 * OFF is written as explicitly as ON. A turn that asks for `false` must not
 * simply leave the key alone: the profile is a copy of the user's own config,
 * so an untouched key means "however their terminal was last left".
 *
 * Written EXPLICITLY, never left to the copied config. The per-turn profile is
 * a copy of the user's own `cli-config.json`, so an untouched key means "however
 * their terminal was last left" — before this, the window of a geniro cursor
 * chat silently followed a switch flipped in another app.
 */
export const CURSOR_MAX_MODE = true;

/**
 * The Cursor credentials the USER may have exported in the shell that launched
 * the app — isolated from every other agent's children and inherited by this
 * CLI's own, so the one list drives both `auth` fields and the two cannot name
 * different credentials.
 *
 * `CURSOR_AUTH_TOKEN` is read on the cursor-agent 2026.09.10 bundle's own login
 * path (`1422.index.js`: `e.authToken ?? process.env.CURSOR_AUTH_TOKEN`, with
 * the refusal "set CURSOR_API_KEY/CURSOR_AUTH_TOKEN" beside it), so it is as
 * much a bearer credential as the key.
 */
export const CURSOR_CREDENTIAL_ENV_KEYS = [
  'CURSOR_API_KEY',
  'CURSOR_AUTH_TOKEN',
] as const;

// ── The per-turn config directory ─────────────────────────────────────────
//
// Applying a model or an effort over ACP PERSISTS into the config directory, so
// a turn gets its own; see `utils/cursor-profile.utils.ts` for the measurements
// behind every part of this (including why `mcp.json` is not copied, and why the
// conversation store is the one thing linked OUT of the throwaway directory).

/** Where the per-turn profiles live, under the daemon's userData dir. */
export const CURSOR_PROFILE_DIR_NAME = 'cursor-profiles';
/** `mkdtemp` prefix inside it, so two concurrent turns cannot share one. */
export const CURSOR_PROFILE_DIR_PREFIX = 'turn-';
/** The user's own CLI config directory, relative to their home. */
export const CURSOR_HOME_DIR_NAME = '.cursor';
/** The one file copied in, so the turn keeps the user's own settings. */
export const CURSOR_SEEDED_CONFIG_FILE = 'cli-config.json';
/** The env var the CLI resolves its config directory from. */
export const CURSOR_CONFIG_DIR_ENV = 'CURSOR_CONFIG_DIR';

export const CURSOR_CREDENTIAL_STORE_ENV = 'AGENT_CLI_CREDENTIAL_STORE';
export const CURSOR_AUTH_TOKEN_ENV = 'CURSOR_AUTH_TOKEN';
export const CURSOR_API_KEY_ENV = 'CURSOR_API_KEY';
export const CURSOR_AUTH_FILE_NAME = 'auth.json';
export const CURSOR_AUTH_INFO_CONFIG_KEY = 'authInfo';
export const CURSOR_COMPILE_CACHE_PATH = [
  'Library',
  'Caches',
  'cursor-compile-cache',
] as const;

// ── The per-turn DATA directory (a member's switched-off MCP servers) ───────
//
// `utils/cursor-data-dir.utils.ts` carries the bundle reading and the probe.

/**
 * The env var the CLI resolves its DATA directory from — the parent of
 * `projects/<key>/`, where each workspace's `mcp-disabled.json`, MCP sign-ins
 * (`mcp-auth.json`), approvals, delegate transcripts and terminal output live.
 * `~/.cursor` when unset (`paths.js` `c()` in the 2026.10.01 bundle).
 */
export const CURSOR_DATA_DIR_ENV = 'CURSOR_DATA_DIR';
/** `mkdtemp` prefix for a per-turn data directory, beside the profiles. */
export const CURSOR_DATA_DIR_PREFIX = 'data-';
/** The CLI's per-workspace list of servers it does not load. */
export const CURSOR_MCP_DISABLED_FILE = 'mcp-disabled.json';
/**
 * Names the CLI WRITES under `projects/<key>/` that may not exist yet when a
 * turn starts, linked anyway so a write lands in the user's real store rather
 * than in the throwaway directory. Files are linked dangling (a `writeFile`
 * through the link creates the target); directories are created in the real
 * store first, since a `mkdir -p` cannot pass a dangling link. Read out of
 * cursor-agent 2026.10.01-e373342: `mcp-auth.json` (`saveMcpAuth`, a plain
 * `writeFile` — measured to rewrite through the link), `mcp-approvals.json`,
 * `.workspace-trusted`, and the `agent-transcripts`, `terminals`, `canvases`,
 * `mcps` and `agent-tools` directories.
 */
export const CURSOR_PROJECT_STATE_FILES = [
  'mcp-auth.json',
  'mcp-approvals.json',
  '.workspace-trusted',
] as const;
export const CURSOR_PROJECT_STATE_DIRS = [
  'agent-transcripts',
  'terminals',
  'canvases',
  'mcps',
  'agent-tools',
] as const;
/**
 * Where the CLI keeps each ACP conversation, RELATIVE TO ITS CONFIG DIRECTORY —
 * `acp-sessions/<sessionId>/{meta.json,store.db}`.
 *
 * This is the one thing in a config directory that must NOT be per turn, and
 * missing that shipped a chat whose every message after the first failed: the
 * conversation `session/load` resumes lives here, so a profile removed on settle
 * takes the thread with it. Probed on 2026.08.11-e8db854 — `session/load` under
 * a second, empty profile answers
 * `-32602 Invalid params {"message":"Session \"…\" not found"}` and the turn dies
 * there, while the same load under the profile that created it succeeds.
 *
 * So the turn profile links this name at a store shared by every turn
 * ({@link CURSOR_SESSION_STORE_DIR_NAME}), and the settings the isolation exists
 * for stay per turn. Written by `utils/cursor-profile.utils.ts`; hardcoded in the
 * CLI's own bundle (`join(cursorHome, "acp-sessions")`, `2996.index.js`), so
 * there is no flag that would move it.
 */
export const CURSOR_ACP_SESSIONS_DIR_NAME = 'acp-sessions';
/**
 * Where those conversations actually live, under the daemon's userData dir.
 *
 * Deliberately NOT inside {@link CURSOR_PROFILE_DIR_NAME}: the boot sweep
 * removes that base wholesale, which would delete every thread on every launch.
 */
export const CURSOR_SESSION_STORE_DIR_NAME = 'cursor-sessions';

/**
 * Deadline for the model handshake.
 *
 * Far below the MCP listing's 20s because nothing is dialled: the probe writes
 * two frames and reads one reply, which took under a second against
 * 2026.08.04-aaa8809. What it must still absorb is a cold CLI start and an
 * auth check. The read cannot end on its own — `cursor-agent acp` does NOT
 * exit when its stdin closes (probed on the same build) — so this deadline is
 * the only backstop behind `acpModelProbeSettled`, and a listing that reached
 * it reports an unknown vocabulary rather than an empty one.
 *
 * 15s is HEADROOM over a measured cold read, not an expectation. Measured
 * end-to-end through `GET /v1/agents/models` on 2026.08.04-aaa8809: **7.0s
 * cold** (a fresh daemon, so the `--version` probe and the CLI's own start and
 * auth check are all in it), **0.009s warm**. An earlier revision cut this to
 * 8s to bound the wait and was wrong to: at ~1s of margin over the observed
 * cold path, a slower machine or a slower auth check turns a listing that works
 * into an empty picker, and "no models" is indistinguishable from "this account
 * has none".
 *
 * What actually bounds the user-visible cost is the cache and the
 * single-flight, not this number: 7s is paid once per CLI version per 10-minute
 * TTL, and concurrent asks join one probe instead of spawning their own. Still
 * under the renderer's own 30s request budget, so even the worst case surfaces
 * as "default model only" rather than as a transport error.
 */
export const CURSOR_MODEL_PROBE_TIMEOUT_MS = 15_000;

/**
 * How long `session/list` gets. Shorter than the model probe's budget because
 * it is a strictly smaller question — `initialize` then one lookup, with no
 * `session/new` in between — and because it is asked interactively, when the
 * user opens the picker, where a stall is felt rather than merely logged.
 */
export const CURSOR_SESSION_LIST_TIMEOUT_MS = 12_000;

/**
 * How long a `session/load` gets to replay a conversation. Longer than the
 * listing's: the handshake is the same, but the agent then streams the entire
 * prior transcript before it answers, and a long thread is a lot of frames.
 */
export const CURSOR_SESSION_LOAD_TIMEOUT_MS = 30_000;

/**
 * Refusal when the conversation being imported is not in the profile it was
 * listed under — a session removed, or an id from another profile. Said as the
 * user's own problem, not as a path, because the path is inside a store they
 * did not choose the layout of.
 */
export const CURSOR_SESSION_MISSING_MESSAGE =
  'that cursor-agent session is no longer in this profile — it may have been deleted since the list was taken';

// ── `cursor-agent mcp list` ───────────────────────────────────────────────
//
// This adapter deliberately carried NO const file until now: every static fact
// about the CLI was a value only `getConfig()` read, so it belonged inline
// beside the field it answered. The listing is the first thing here that is
// NOT such a fact — it spans two files, the adapter and its parser, so these
// strings cross a file boundary and have nowhere inline to live. (Each export
// below has exactly one production reader today; what disqualifies the inline
// exception is that the reader is not `getConfig()`.)
//
// Everything below was captured from the real binary, version
// `2026.07.23-e383d2b`, and the verbatim output is kept alongside the
// milestone that added it. The CLI has no machine-readable mode for this
// listing — `mcp list` takes no options at all — so this reads its prose and
// is version-volatile by construction.

/** Argv for the folder-scoped server listing. */
export const CURSOR_MCP_LIST_ARGS: readonly string[] = ['mcp', 'list'];

/**
 * Deadline for that listing. Same budget claude's gets, and for the same
 * reason: the command HEALTH-CHECKS, dialling every configured server, so an
 * unreachable HTTP one costs its own connect timeout before the CLI answers.
 *
 * Three configured servers (two unreachable) took 3.4s when probed, so this is
 * headroom rather than an expectation. Bounded ABOVE by the renderer's own 30s
 * per-request budget (`daemon-api.ts` REQUEST_TIMEOUT_MS) — at 30s here the
 * client would always abort first and the daemon's "could not read" sentence
 * would never reach the panel.
 */
export const CURSOR_MCP_LIST_TIMEOUT_MS = 20_000;

/**
 * Row status markers — the whole vocabulary the CLI printed.
 *
 * A row is `<name>: <status>` and nothing else. Unlike claude, cursor prints no
 * command column and no transport, so there is no structural delimiter inside a
 * row: recognising the status IS the only way to tell a row from a line of
 * prose. That is why these three strings carry more weight here than their
 * claude counterparts do, and why an unrecognised status costs the whole
 * listing rather than one badge — see `parseCursorMcpList`.
 *
 * `Error:` keeps its colon: the reason follows it (`Error: Connection failed`),
 * and both a missing stdio binary and an unreachable HTTP URL produced that
 * identical wording, so the reason is coarse but it is all the CLI gives.
 */
export const CURSOR_MCP_READY_MARKER = 'ready';
export const CURSOR_MCP_FAILED_MARKER = 'Error:';
export const CURSOR_MCP_PENDING_MARKER = 'not loaded';

/**
 * What a server the CLI is still dialling reports.
 *
 * READ FROM THE BUNDLE rather than captured, which is the one marker here that
 * was: `mcp list` renders its status through a chain whose arms are exactly
 * `ready` / `requires_authentication` / `loading` / `disabled` / `unapproved` /
 * `Error: <reason>` (2026.08.11-e8db854, `9917.index.js`), and this is the only
 * one of the six with no marker of its own. Reproducing it on demand means
 * winning a race against the CLI's own dial, so the source is the evidence.
 *
 * It is a MOMENT rather than a state, and that is why the row is worth getting
 * right rather than leaving to `unknown`: the next read answers it, and
 * `unknown` says the opposite — that the CLI's wording is one this parser
 * cannot read.
 */
export const CURSOR_MCP_LOADING_MARKER = 'loading';

/**
 * What a server switched off with `cursor-agent mcp disable <name>` reports.
 *
 * Captured from the same binary:
 *
 * ```
 * $ cursor-agent mcp disable probe-http
 * ✓ Disabled MCP server: probe-http
 * $ cursor-agent mcp list
 * probe-good: ready
 * probe-broken: Error: Connection failed
 * probe-http: disabled
 * ```
 *
 * Reachable by the mechanism {@link CURSOR_MCP_DISABLE_ARGS} drives, which
 * geniro's own switch now writes — so it is a routine state, not an exotic one,
 * and it is what makes the switch POSITION readable without geniro having to
 * locate the CLI's state file: `AgentMcpService.composeListing` already reads a
 * row the CLI itself calls disabled as disabled.
 */
export const CURSOR_MCP_DISABLED_MARKER = 'disabled';

/**
 * What a server the user has not authenticated to reports.
 *
 * OBSERVED on 2026.08.11 against 2026.08.04-aaa8809, on a machine whose
 * `~/.cursor/mcp.json` configures eleven servers:
 *
 * ```
 * $ cursor-agent mcp list
 * playwright: ready
 * linear: requires_authentication
 * github: ready
 * vercel: requires_authentication
 * ```
 *
 * This is the wording the adapter's `mcp.loginArgs` block said it was waiting
 * for. Until it was seen, no marker was invented for it — the note there
 * records why — so the rows it covers parsed as `unknown` and rendered a badge
 * with nothing to do about it. They are the majority of a real listing (eight
 * of the eleven above), and `needs_auth` is the status the panel already draws
 * a sign-in control for, which `cursor-agent mcp login <name>` can act on.
 */
export const CURSOR_MCP_NEEDS_AUTH_MARKER = 'requires_authentication';

/**
 * Printed INSTEAD of any rows when neither `.cursor/mcp.json` nor
 * `~/.cursor/mcp.json` configures a server.
 *
 * It is the only thing that tells an empty folder apart from output the parser
 * could not read at all. Kept to the stable opening words and matched as a
 * SUBSTRING, because the CLI appends the two paths it looked in — the kind of
 * detail a release rewords.
 */
export const CURSOR_MCP_EMPTY_MARKER = 'No MCP servers configured';

/**
 * The config file each scope keeps its servers in, under {@link
 * CURSOR_HOME_DIR_NAME} — one in the user's home, one in the project root.
 *
 * Both spellings come from the same statement in the bundle that decides a
 * row's status (2026.08.11-e8db854, `9917.index.js`): it joins
 * `<projectRoot>/.cursor/mcp.json` and `<home>/.cursor/mcp.json`, merges the
 * second OVER the first, and treats a name present in the PROJECT half as the
 * one needing approval.
 */
export const CURSOR_MCP_CONFIG_NAME = 'mcp.json';

/**
 * The key `mcp.json` keeps its servers under, spelled by three writers — the
 * plugin copy, the JSON editor's save and the Add form, which is a direct
 * write because this CLI has no `mcp add` (its `mcp` subcommands are login,
 * list, list-tools, enable and disable — re-checked on 2026.10.01-e373342).
 */
export const CURSOR_MCP_SERVERS_KEY = 'mcpServers';

/**
 * What marks a directory as the project root — the same walk the CLI does.
 *
 * Read from the bundle rather than assumed: it climbs from `process.cwd()`
 * testing `existsSync(join(dir, '.git'))` and returns the first hit, falling
 * back to the original directory when it reaches the filesystem root. A `.git`
 * FILE counts as much as a directory, which is what makes a linked worktree
 * resolve to itself rather than to its main checkout.
 */
export const CURSOR_PROJECT_ROOT_MARKER = '.git';

/**
 * Where the CLI keeps installed plugins, under {@link CURSOR_HOME_DIR_NAME}.
 *
 * Their MCP servers NEVER reach a geniro turn. Read out of the 2026.10.01-e373342
 * bundle: the ACP server (`3351.index.js`) builds only the mcp.json loader
 * (`aK.init(J,D.projectRoot,D.projectDir,!1,Z,…)`) and contains no plugin code
 * at all — plugin servers are loaded by the chat and TUI paths alone (`8134`,
 * `9969`). Cursor's own ACP page says the same ("ACP supports MCP servers defined
 * in a project-level or user-level `.cursor/mcp.json`"), and a live cursor member
 * found no datadog tool in its catalog with the datadog plugin enabled. Nor can
 * the CLI's subcommands reach them: `mcp list` omits them and `mcp list-tools` /
 * `login` / `enable` answer `MCP client "plugin-datadog-datadog" not found in
 * config`. Re-check all three when the CLI is upgraded.
 */
export const CURSOR_PLUGINS_DIR_NAME = 'plugins';
/**
 * The two places a plugin is installed, under {@link CURSOR_PLUGINS_DIR_NAME}:
 * `cache/<marketplace>/<plugin>/<version>/` for a marketplace install and
 * `local/<plugin>/` for a development copy, which a marketplace plugin of the
 * same name outranks (the CLI's own rule, and Cursor's plugin docs).
 */
export const CURSOR_PLUGIN_CACHE_DIR_NAME = 'cache';
export const CURSOR_PLUGIN_LOCAL_DIR_NAME = 'local';
/**
 * A cached version counts only once this file exists in it — the CLI writes it
 * last (`Aa=".cache-complete"` in `index.js`), so a directory without it is a
 * clone still in progress or one that died part-way.
 */
export const CURSOR_PLUGIN_CACHE_COMPLETE_MARKER = '.cache-complete';
/**
 * The manifest shapes a plugin may carry, in the CLI's own precedence.
 *
 * All THREE, and named here because two readers spell them: the skills walk in
 * `getConfig().skillRoots.plugins`, and the plugin reader in
 * `cursor-plugins.utils.ts`. A plugin matched by one walk and not the other
 * contributes skills while its servers go unlisted. The geniro plugin ships two
 * of the three.
 */
export const CURSOR_PLUGIN_MANIFEST_PATHS: readonly (readonly string[])[] = [
  ['.cursor-plugin', 'plugin.json'],
  ['.claude-plugin', 'plugin.json'],
  ['plugin.json'],
];
/**
 * The MCP files the CLI reads from every plugin's own directory, in its order
 * (`St=[".mcp.json","mcp.json"]` in `index.js`, read by `Tt` before the
 * manifest's `mcpServers`, which override them by name). A Claude-format plugin
 * keeps its servers in `.mcp.json` and names no file in its manifest at all.
 */
export const CURSOR_PLUGIN_DEFAULT_MCP_FILES: readonly string[] = [
  '.mcp.json',
  'mcp.json',
];
/**
 * The project file a plugin installed at PROJECT scope is recorded in, as
 * `{"plugins":{"<name>":{"enabled":true}}}`. The CLI's chat reads it from its
 * working directory (`Bu(t)=join(t,".cursor","settings.json")`, called with
 * `workingDirectory ?? process.cwd()`); a USER-scope install lives on Cursor's
 * servers and no local file says so.
 */
export const CURSOR_SETTINGS_FILE_NAME = 'settings.json';
/** The identifier cursor's own app files a plugin server under: `plugin-<plugin>-<server>`. */
export const CURSOR_PLUGIN_SERVER_ID_PREFIX = 'plugin';
/**
 * How the CLI writes a variable inside an MCP config, transcribed from
 * `index.js`: `${NAME}`, `${NAME:-default}`, or `${env:NAME}`. Kept as the
 * CLI's own definition: geniro matches it with `scanVariables`, a linear scan
 * pinned to this pattern by its spec, since the pattern backtracks
 * quadratically on a run of `${` and plugin text is somebody else's.
 */
export const CURSOR_VARIABLE_PATTERN_SOURCE =
  '\\$\\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\\}';
/**
 * The longest plugin string geniro fills in or matches. A config value is a
 * URL, a command or a header — far shorter — so a longer one is treated as
 * unreadable rather than copied into the user's `mcp.json`.
 */
export const CURSOR_PLUGIN_TEXT_MAX_CHARS = 4096;
/** The largest plugin file read at all — manifests and MCP configs are a few KB. */
export const CURSOR_PLUGIN_FILE_MAX_BYTES = 256 * 1024;
/**
 * How long one folder's plugin scan answers its MCP listings. Every listing —
 * a cache hit included — composes the folder facts, and the scan reads every
 * installed plugin's files, so it is kept briefly rather than repeated per
 * poll. A plugin installed in Cursor's app shows up within this window, or at
 * once after Clear Agent Cache.
 */
export const CURSOR_PLUGIN_SCAN_TTL_MS = 30_000;
/** The variables a plugin's config uses for its own install directory. */
export const CURSOR_PLUGIN_ROOT_VARIABLES: readonly string[] = [
  'CURSOR_PLUGIN_ROOT',
  'CLAUDE_PLUGIN_ROOT',
];
/**
 * A variable geniro never asks for. Matched on the NAME as well as on the
 * manifest's own `writeOnly`, because a plugin need not mark its key as one —
 * datadog's local manifest declares only its domain, while its marketplace
 * listing marks `DD_API_KEY` write-only.
 */
export const CURSOR_SECRET_VARIABLE_NAME =
  /KEY|TOKEN|SECRET|PASS(WORD|PHRASE)|CREDENTIAL|AUTH|BEARER|COOKIE|SESSION|PRIVATE|CERT|(^|_)PAT(_|$)/i;
/**
 * Mode for a `~/.cursor/mcp.json` geniro has to create: it can hold the user's
 * header credentials, so it starts owner-only. An existing file keeps its own.
 */
export const CURSOR_MCP_CONFIG_FALLBACK_MODE = 0o600;
/**
 * Shown above the plugin list — what the user needs to know before pressing Add.
 * Each folder signs in on its own because the CLI keeps MCP sign-ins per
 * project root (`~/.cursor/projects/<root>/mcp-auth.json`).
 */
export const CURSOR_PLUGIN_NOTE =
  "These servers come from Cursor plugins, which only Cursor's own app loads — the sessions geniro runs load servers from mcp.json alone. Add one to ~/.cursor/mcp.json to use it here, then sign in; each folder signs in once.";

/**
 * Argv for the two halves of the switch.
 *
 * WHERE THE PER-FOLDER CLAIM COMES FROM. This adapter used to declare the
 * toggle unavailable, on the recorded grounds that `mcp enable|disable` "write
 * the user's global `~/.cursor/cli-config.json`" and take effect "in EVERY
 * folder". Both halves of that are wrong on 2026.08.11-e8db854, and the CLI's
 * own bundled source says where it really goes
 * (`~/.local/share/cursor-agent/versions/<v>/index.js`):
 *
 *   "./src/mcp/project-paths.ts": function o(dir) {
 *     return join(dir, "mcp-disabled.json")
 *   }
 *   function C(cwd, root) {
 *     const projectRoot = root ?? gitRoot(cwd) ?? cwd;
 *     const projectDir  = cursorConfig.projectDir(projectRoot);
 *     return { cwd, projectRoot, projectDir,
 *              approvalPath: join(projectDir, "mcp-approvals.json"),
 *              disabledPath: o(projectDir) };
 *   }
 *
 * and `./src/commands/disable.ts` reads `process.cwd()` and writes through
 * that `disabledPath`. Measured against the real binary, and BOTH directions
 * of the old claim fell:
 *
 * - not `cli-config.json` — its md5 was byte-identical across a `disable`, and
 *   no file under `~/.cursor` changed at all except
 *   `~/.cursor/projects/<key>/mcp-disabled.json`, which appeared holding
 *   `["playwright"]`;
 * - not global — `disable codegraph` run in an unrelated directory wrote that
 *   directory's own project key and left `codegraph: ready` in this repo.
 *
 * So the grain is the same one claude's `projects[<cwd>].disabledMcpServers`
 * has, and geniro switches it the way the CLI's OWN toggle does: the TUI's
 * handler (`6260.index.js`) is `addApproval` then `removeDisabledServer` on
 * enable, `addDisabledServer` on disable — which is why enable goes through
 * `mcp enable` rather than merely un-disabling. It also approves, and that is
 * the CLI's own definition of the switch being on.
 *
 * Deliberately NOT reimplemented as a file write, unlike claude's: the path
 * above needs the git root, `CURSOR_DATA_DIR`/`XDG_CONFIG_HOME`, and the right
 * one of the CLI's two project-dir functions — the other bounds the length and
 * falls back to a sha256 of the path past 92 characters. Driving the
 * subcommand leaves all of that where it belongs.
 *
 * WHY THE OLD MEASUREMENT WENT WRONG is worth writing down, because it is the
 * cheap mistake: `projectRoot` is `gitRoot(cwd) ?? cwd`, so two folders inside
 * one repository DO share a single disabled list. "Every folder" is what
 * per-repository looks like if the folders you compare are both in the same
 * repository.
 *
 * RE-CHECK IF: `mcp --help` loses either subcommand, or a `disable` in one
 * repository starts showing up in another.
 */
export const CURSOR_MCP_ENABLE_ARGS: readonly string[] = ['mcp', 'enable'];
export const CURSOR_MCP_DISABLE_ARGS: readonly string[] = ['mcp', 'disable'];

/**
 * Argv for the ONE-server health probe, and the wording it answers with.
 *
 * `cursor-agent mcp list-tools <name>` — "List available tools and their
 * argument names for a specific MCP", from the CLI's own `mcp --help`. It dials
 * that server and nothing else, which is what makes it usable where the folder
 * listing is not: measured on 2026.08.11-e8db854 against this machine's eleven
 * servers, one server takes 1.2–3.7s where the whole folder takes 4–9s.
 *
 * Captured verbatim, and note that only the first is on stdout with exit 0 —
 * the other two exit 1 and write to STDERR, which is why the caller sets
 * `captureDiagnosis`:
 *
 * ```
 * $ cursor-agent mcp list-tools codegraph          # exit 0
 * Tools for codegraph (1):
 * - codegraph_explore (query, maxFiles, projectPath)
 *
 * $ cursor-agent mcp list-tools figma              # exit 1, stderr
 * MCP 'figma' requires authentication.
 * Please run: agent mcp login figma
 *
 * $ cursor-agent mcp list-tools vercel             # exit 1, stderr
 * Failed to list tools: Failed to load MCP 'vercel': Streamable HTTP error: …
 * ```
 *
 * The failed marker also covers a name in no config at all
 * (`Failed to load MCP 'x': MCP client "x" not found in config`), which is the
 * right reading: the panel only ever asks about a server its own listing named,
 * so that answer means the config changed underneath — a real failure, not a
 * state to invent a badge for.
 *
 * The ready marker keeps its trailing space-and-paren shape out of it on
 * purpose: the count varies, and `Tools for ` is the stable part.
 *
 * RE-CHECK IF: `list-tools` leaves `mcp --help`, or a probe starts reporting a
 * server as broken that the folder listing calls fine — the first sign of a
 * reworded message.
 */
export const CURSOR_MCP_TOOLS_ARGS: readonly string[] = ['mcp', 'list-tools'];
export const CURSOR_MCP_TOOLS_READY_MARKER = 'Tools for ';
export const CURSOR_MCP_TOOLS_AUTH_MARKER = 'requires authentication';
export const CURSOR_MCP_TOOLS_FAILED_MARKER = 'Failed to list tools';

/**
 * Deadline for that probe. One server rather than a folder, so it is bounded by
 * one connect timeout instead of the slowest of eleven — but a dead HTTP
 * endpoint still gets to spend its own, so this stays generous. Under the
 * listing's budget, since this is the cheaper question.
 */
export const CURSOR_MCP_TOOLS_TIMEOUT_MS = 15_000;

/**
 * Shown when the switch command itself failed.
 *
 * Only `enable` can reach it. Measured on the same build: `mcp enable` on a
 * name that is in no config exits 1 with "not found in configuration", while
 * `mcp disable` exits 0 and writes the name anyway — it validates nothing. So
 * the off direction cannot refuse, and this sentence is about turning one ON.
 */
export const CURSOR_MCP_TOGGLE_FAILED_MESSAGE =
  'cursor-agent refused to switch that server — it may no longer be in .cursor/mcp.json or ~/.cursor/mcp.json';

/**
 * Why a cursor row's switch is never locked OFF the way a claude row's can be.
 *
 * claude unions a `.mcp.json` REJECTION list out of several settings files, and
 * a name in any of them is one geniro cannot pull back out — that is what its
 * `userDisabledReason` explains. No equivalent has been found for this CLI:
 * `mcp-disabled.json` is the only state its own switch writes, and `mcp enable`
 * undoes it. So `readMcpFolderFacts` reports an empty `lockedOff` and this
 * sentence is unreachable today; it exists because the contract wants a string,
 * and it says what it would mean if one were ever found.
 */
export const CURSOR_MCP_USER_DISABLED_REASON =
  'switched off in cursor-agent’s own configuration, which geniro cannot undo';

/**
 * Shown to the user when the listing command could not be run at all — a
 * missing binary, a non-zero exit, or the deadline. Deliberately distinct from
 * an empty listing: only one of the two is a fact about their configuration.
 */
export const CURSOR_MCP_LIST_FAILED_MESSAGE =
  'could not read MCP servers — cursor-agent did not answer';

/** Shown when the CLI answered but nothing in its output looked like a row. */
export const CURSOR_MCP_LIST_UNREADABLE_MESSAGE =
  'could not read MCP servers — the cursor-agent output format may have changed';

// ── Asking the user a question (`cursor/ask_question`) ────────────────────
//
// WHERE THIS SHAPE CAME FROM. Baseline ACP has no agent→client call for
// asking the user something open-ended — permissions are the only round-trip
// it defines — so Cursor added one as a vendor extension.
//
// Read out of the CLI'S OWN SOURCE, not its docs. cursor-agent ships as plain
// bundled JavaScript, and its handler is legible:
//
//   ~/.local/share/cursor-agent/versions/<v>/8869.index.js
//   → "./src/acp/interaction-handlers/ask-question-handler.ts"
//
// on 2026.08.04-aaa8809, which is where the request fields
// (`toolCallId`/`title`/`questions[].id`/`prompt`/`options[].id`/`label`/
// `allowMultiple`) and the three response outcomes below are transcribed
// from. That is a stronger source than the published docs AND than a wire
// capture: it is what the binary will actually send and accept. It still
// expires — a release can rewrite it — so re-read that handler rather than
// trusting this block on a new cursor series.
//
// It has NOT been seen on the wire. Driving 2026.08.04 into asking a
// multiple-choice question (directly, and through its own
// `/multi-model-review` command, which advertises "structured question or
// inline") produced plain markdown in an `agent_message_chunk` both times.
// So the readers below stay defensive and the driver keeps its `accepts()`
// gate: an unparseable payload is declined exactly as before.
//
// WHAT DECLINING ACTUALLY COST, measured rather than assumed. The same
// handler catches an Unimplemented/-32601 reply and FALLS BACK to one
// `session/request_permission` per single-select question, each option
// becoming an `allow_once` option beside a synthetic `__ask_question_skip__`
// rejection. So the old behaviour did not stall the turn — it was worse than
// that. Replayed against the pre-fix build: geniro rendered a generic
// permission card titled with the ask's `title` and NO arguments, whose
// Approve picks the FIRST allow_once option; and under `auto` the daemon
// auto-approved it, answering the user's question with option #1 and no
// human involved at all. The fallback also drops every `allowMultiple`
// question on the floor, which is why answering one is a capability of this
// channel specifically.

/** The vendor method carrying a question for the user. */
export const CURSOR_ASK_QUESTION_METHOD = 'cursor/ask_question';

/** `CursorAskQuestionResponse.outcome.outcome` — the arm we answer with. */
export const CURSOR_QUESTION_OUTCOME_ANSWERED = 'answered';
/** The arm for a question the user declined to answer, carrying a `reason`. */
export const CURSOR_QUESTION_OUTCOME_SKIPPED = 'skipped';

/**
 * Where {@link CursorAcpAdapter.withAnswer} stashes the card's free text on
 * the request params, for the reply encoder to read back.
 *
 * The seam it has to cross is `AgentAdapter.withAnswer` → `respondApproval` →
 * `TurnDriver.buildApprovalResponse`, which carries ONE opaque `updatedInput`
 * — a shape claude uses to fold an answer into a tool input and cursor has no
 * equivalent of. Both ends of this key are in this adapter, so no other layer
 * sees it; the `geniro` prefix is what keeps it from colliding with a field
 * the vendor might add.
 */
export const CURSOR_ANSWER_KEY = '__geniroAnswer';

/**
 * The vendor extensions this client refuses SILENTLY — declined in-protocol
 * like any other, but without spending the turn's single "declined" notice.
 *
 * Each entry is a reading of that method's own handler in the CLI source
 * (same file as {@link CURSOR_ASK_QUESTION_METHOD}), never an assumption:
 *
 * - `update_todos`, `task`, `generate_image` go out through
 *   `sendNonBlockingExtensionNotification`, which is
 *   `connection.extMethod(...).catch(debugLog)`. The agent discards the
 *   outcome entirely, so a refusal changes nothing about the turn. Wire-
 *   confirmed for `update_todos` on 2026.08.04-aaa8809: an ordinary "make a
 *   todo list" turn sends it and then completes normally after a `-32601`.
 * - `create_plan` DOES block, but its handler treats Unimplemented as a cue to
 *   write the plan locally and report success. The work still happens; only
 *   the delivery differs. Its payload IS wanted — the plan's ids, read by the
 *   todo protocol before the refusal (see the task-list block below) — but the
 *   reply is a verdict on the plan, which this client does not give for the
 *   user, so the request itself is still refused.
 *
 * `ask_question` is deliberately ABSENT, and is the reason this list is not
 * simply "every `cursor/*`": its fallback answers the user's question with the
 * first option on their behalf. That is the shape of harm this list must never
 * cover — so an entry is earned by reading the handler, not by sharing a
 * prefix with one that was.
 *
 * `task` was here too, and its removal is a lesson about what this list COSTS.
 * Every word written above it was true — the agent does discard the outcome, a
 * refusal did change nothing about the turn — and being harmless to refuse is
 * not the same as being worthless to accept. It is the only thing on this
 * transport that says what a sub-agent was asked to do, and while it sat here
 * geniro declined it on every delegating turn and the adapter declared, one
 * file away, that this CLI reports no sub-agents at all. An entry earns its
 * place by its handler being harmless to refuse AND its payload carrying
 * nothing geniro wants; the second half is what was skipped.
 */
export const CURSOR_SILENTLY_DECLINED_METHODS: readonly string[] = [
  'cursor/generate_image',
  // `CURSOR_CREATE_PLAN_METHOD`, spelled out because that constant is declared
  // further down, beside the frames it carries.
  'cursor/create_plan',
];

// -- The agent's own task list (`cursor/update_todos`) ----------------------
//
// MEASURED on the wire, 2026-08-14, cursor-agent 2026.08.11-e8db854, against a
// throwaway CURSOR_CONFIG_DIR and a prompt asking for a tracked three-step job.
// Four announcements arrived, each preceded by its own tool call:
//
//   session/update  tool_call  {toolCallId:"toolu_vrtx_01BgZ...", title:"Update TODOs",
//                              kind:"other", rawInput:{_toolName:"updateTodos"}}
//   cursor/update_todos (a REQUEST, id 0)
//     {toolCallId:"toolu_vrtx_01BgZ...", merge:false,
//      todos:[{id:"1", content:"Read alpha.txt",  status:"in_progress"},
//             {id:"2", content:"Read beta.txt",   status:"pending"},
//             {id:"3", content:"Write summary.txt ...", status:"pending"}]}
//   ... then three more with merge:TRUE, each carrying only the rows that moved:
//     {toolCallId:"...", merge:true, todos:[{id:"1", status:"completed"},
//                                           {id:"2", status:"in_progress"}]}
//
// This is the second vendor extension found to be REAL after being declined for
// two milestones, and it was declined the quietest way: the method is on the
// silence list above, so nothing was even said about it. What the user saw was
// the `Update TODOs` tool row — which discloses no arguments at all
// (`rawInput:{_toolName:"updateTodos"}`), so the list existed nowhere in geniro.
//
// ── A PLAN (plan mode's CreatePlan), and why it is read off `create_plan` ──
//
// MEASURED on the wire, 2026-10-21, cursor-agent 2026.10.19-6bbf2c4, against a
// throwaway folder: a plan-mode turn asking for a three-file plan, then an
// agent-mode turn executing it. The plan turn sent, in this order:
//
//   session/update  tool_call  {toolCallId:"call-9d94…", title:"Create Plan",
//                              rawInput:{_toolName:"createPlan"}}   (then refined
//                              with {name, plan:<the plan document>})
//   session/update  plan       {entries:[{content:"Create a.txt containing \"alpha\"",
//                                         priority:"medium", status:"pending"}, …]}
//   cursor/create_plan (a REQUEST)
//     {toolCallId:"call-9d94…", name:"Create three files", overview:"…", plan:"…",
//      todos:[{id:"create-a-txt", content:"Create a.txt containing \"alpha\"",
//              status:"pending"}, …]}
//
// and the execution turn then moved those tasks with `cursor/update_todos`
// patches keyed by the SAME ids:
//
//   {toolCallId:"…", merge:true, todos:[{id:"create-a-txt", status:"completed", …},
//                                       {id:"create-b-txt", status:"in_progress", …}]}
//
// The `plan` update is baseline ACP and carries NO ids (and `priority` is
// hard-coded: `priority:"medium"` for every todo, in the CLI's own CreatePlan
// handler). Drawn from it, the plan's rows get ids from their position, every
// later patch misses them, and the three tasks are drawn twice. `create_plan`
// restates the same todos, in the same order, WITH the ids — so it is the
// plan's announcement, and the `plan` update is held as its fallback (see
// `AcpTodoProtocol.plan`). Its `status` adds `cancelled` to the three, which
// reads as unknown, as it does on `update_todos`.

/** @see CURSOR_SILENTLY_DECLINED_METHODS for the frames this method carries. */
export const CURSOR_TODOS_METHOD = 'cursor/update_todos';

/** Where cursor restates a plan with its ids — see the block above. */
export const CURSOR_CREATE_PLAN_METHOD = 'cursor/create_plan';

// ── Background sub-agents (the `task` tool) ────────────────────────────────
//
// MEASURED on the wire, 2026-08-13, cursor-agent 2026.08.11-e8db854, against a
// throwaway CURSOR_CONFIG_DIR and a prompt asking the agent to delegate. One
// delegation produced, in this order:
//
//   session/update  tool_call        {toolCallId:"toolu_018bc…", title:"Task: Subagent task",
//                                    kind:"other", status:"pending", rawInput:{_toolName:"task"}}
//   session/update  tool_call_update {toolCallId:"toolu_018bc…", status:"in_progress"}
//   session/update  tool_call_update {toolCallId:"toolu_018bc…", status:"completed",
//                                    rawOutput:{durationMs:13075, isBackground:false}}
//   cursor/task     (a REQUEST, id 0) {toolCallId:"toolu_018bc…",
//                                    description:"List files in directory",
//                                    prompt:"Your task is simple and self-contained: …",
//                                    subagentType:{custom:{unspecified:{}}},
//                                    model:"claude-opus-5-thinking-high",
//                                    agentId:"bce43ebb-…", durationMs:13075}
//
// Three things follow, and each is why one constant below exists:
//
// 1. The launch is recognisable ONLY by `rawInput._toolName` — the ACP frame
//    carries no machine tool name, and its title at that point is a placeholder
//    with the description not yet filled in.
// 2. Everything the CLI says about the delegate arrives at the END, on
//    `cursor/task`. So a block can open at launch but stays unlabelled until
//    then, which is why `subagent_info` is emitted twice and merged.
// 3. NOTHING the delegate itself did crosses the wire — no nested tool calls, no
//    second session, no `sessionId` but the parent's. Its transcript is written
//    under the CLI's own project dir instead (`190.index.js` →
//    `getSubagentTranscriptPathIfExists`) — which is where its ENDING is read
//    from; see the block below.
//
// A fourth thing follows from the `rawOutput` above, and it is why the adapter
// declares `resultIsBookkeeping`: `{durationMs, isBackground}` is the CLI's own
// accounting, not the delegate's report — the findings only ever appear in the
// MAIN agent's next message.
//
// `isBackground: true` HAS NOW BEEN SEEN, which is what the RE-CHECK below used
// to be waiting for, and it changes what the two other fields mean. MEASURED
// 2026-08-28 on the same build, asking for a background delegate:
//
//   +18.7s tool_call_update completed  rawOutput {durationMs:203, isBackground:TRUE}
//   +18.7s cursor/task      {…, durationMs:203}
//   +22.7s session/prompt   → {"stopReason":"end_turn"}          ← the TURN ends
//   +26.7s … +89s           session/request_permission from the DELEGATE's shell
//
// So for a backgrounded delegate the launching call measures the LAUNCH (203ms,
// and 198–408ms across the ten on the reported thread) rather than the work, and
// its return says the delegation was accepted rather than that anything
// finished. Both were being published as the delegate's own — `took 0s` under a
// green check while it worked. `isBackground` is therefore read now
// (`readCursorLaunchIsBackground`), and it is read off `rawOutput` because the
// `cursor/task` announcement does not carry it: the CLI's own
// `sendToolExtensionNotification` builds that payload from the args and the
// duration alone.
//
// The line above also corrects §3 in one respect: the delegate's own steps
// still never arrive, but its PERMISSION REQUESTS do, on the parent's session,
// after the parent's turn has ended.
//
// Nothing on the WIRE announces such a delegate's ending — re-confirmed on
// 2026.08.31-4057e58 and again on 2026.09.10-fd3934a. The CLI does record it:
// on completion its sub-agent manager enqueues a wakeup for the parent
// conversation (`8060.index.js` → `registerBackgroundRun`), and its interactive
// client pulls those to start the parent's next turn — but the ACP server
// (`7214.index.js`) creates that registry and never pulls from it. So over ACP
// the parent is never told, and neither is this client.
//
// What IS readable is the delegate's own transcript, which the CLI writes as it
// works and closes with a `turn_ended` line (`7923.index.js`):
//
//   ~/.cursor/projects/<workspace path, non-alphanumerics → "-">/agent-transcripts/
//       <id>/<id>.jsonl                   ← an ACP session's delegates (measured)
//       <parent session>/subagents/<id>.jsonl  ← the interactive client's
//   first line: {"role":"user", … "<user_query>\n{the brief}\n</user_query>"}
//   last line:  {"type":"turn_ended","status":"success"}   (or "error" | "aborted")
//
// `<id>` is NOT the `agentId` `cursor/task` carries — MEASURED 2026-09-30
// through this daemon with the raw frames captured: a delegate announced with
// `agentId: 05df2846-…` wrote `00f805d1-…/00f805d1-….jsonl`, and nothing under
// `~/.cursor` was named after the `agentId`. So the transcript is found by the
// BRIEF, which `cursor/task` does carry and the first line wraps verbatim
// (`locateCursorDelegateTranscript`), and its ending is read off the last line
// (`readCursorDelegateEnding`). Verified end to end in the running app the same
// day: three background delegates each sleeping 75s stayed open past their
// turn's end and closed `completed` three seconds after writing their files.
// That is why the TURN no longer closes a delegate: it used to, with no outcome
// claimed, and the renderer drew nine reviewers still working as nine green
// checks.
//
// A RESUMED delegate writes NO new transcript. MEASURED on run `bd1e43ae`
// (2026.09.10-fd3934a, 2026-10-01): seven reviewers cut off by a dropped
// stream were relaunched with `Task` and cursor CONTINUED them — each new brief
// was appended to the reviewer's existing transcript as a second
// `<user_query>`, in a file born nine minutes earlier and opening with the
// original brief, and the CLI's wakeups for them carried the ORIGINAL agent ids.
// So a transcript born before the launch is matched too, by its LATEST user
// message (`locateCursorDelegateTranscript`); matched on its first line alone,
// none was found and every one was closed as though nothing could watch it.
//
// And since the ACP server never wakes the parent, geniro does
// (`cursorDelegateWakePrompt`, through `AcpDelegateProtocol.wakePrompt`): a turn
// that ends with watched delegates out is HELD until they end, then the session
// is prompted with each one's outcome and its report, read off the same
// transcript's last assistant line, and the turn settles on that answer. On the
// run above, the QA callee ended its turn "finishing now" with seven reviewers
// out and its caller had to send it back.
//
// RE-CHECK IF: a release starts sending `rawInput` with the args populated on the
// opening frame (then the marker can give way to reading them directly); a
// `session/update` variant appears that carries a parent/sub-session id (then the
// delegate's own steps become streamable and
// `CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON` must go); the transcript moves or
// stops ending on `turn_ended` or opening with the brief (the session then logs that a delegate's record
// never turned up, and falls back to closing it with its turn); or the ACP server
// starts pulling its wakeups (then the parent is continued by the CLI itself).

/** The vendor method announcing one background sub-agent, with its brief. */
export const CURSOR_TASK_METHOD = 'cursor/task';

/**
 * The `rawInput` entry marking a tool call as a delegation. Its key is the
 * machine tool name this CLI stamps on every call's arguments (`_toolName`),
 * which is the only name on the frame — the title is prose.
 */
export const CURSOR_TASK_LAUNCH_MARKER = { key: '_toolName', value: 'task' };

/**
 * `subagentType` values that name no type at all, so the row says nothing
 * rather than labelling a delegate `unspecified` — or, since `readSubagentType`
 * unwraps the oneof down to its bare key, `custom`.
 *
 * Three spellings observed: the enum's own zero value, the `{custom:{…}}`
 * wrapper the oneof puts an unrecognised value in — which is what a plain
 * delegation with no declared type actually arrives as
 * (`subagentType:{custom:{unspecified:{}}}` above) — and `custom` itself, the
 * oneof ARM NAME rather than a real type, which an untyped delegation reads
 * as once the wrapper is unwrapped to its own key.
 */
export const CURSOR_SUBAGENT_TYPE_UNSPECIFIED: readonly string[] = [
  'unspecified',
  'default',
  'custom',
];

/** Why a cursor delegate's block opens onto no conversation. See §3 above. */
export const CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON =
  'cursor-agent reports the delegation but not the work inside it — the ' +
  'sub-agent runs as its own conversation and none of its steps reach this ' +
  'client, so there is nothing to show but what it was asked';

/** Where the CLI keeps each workspace's state, inside its home directory. */
export const CURSOR_PROJECTS_DIR_NAME = 'projects';

/** The directory, inside one workspace's state, holding agent transcripts. */
export const CURSOR_AGENT_TRANSCRIPTS_DIR = 'agent-transcripts';

/** Where a parent conversation's delegates are filed, when they are nested. */
export const CURSOR_SUBAGENT_TRANSCRIPTS_DIR = 'subagents';

/** The `type` of the line the CLI closes a transcript with. */
export const CURSOR_TRANSCRIPT_TURN_ENDED = 'turn_ended';

/**
 * That line's `status`, as an outcome. The three the CLI's own writer spells
 * (`7923.index.js`); anything else ends the delegate with no outcome claimed.
 */
export const CURSOR_TRANSCRIPT_OUTCOMES: ReadonlyMap<
  string,
  BackgroundUnitOutcome
> = new Map([
  ['success', 'completed'],
  ['error', 'failed'],
  ['aborted', 'stopped'],
]);

/**
 * The flat JSON header beside that database, carrying the conversation's `cwd`
 * and the title the AGENT generated for it. Named here for the same reason its
 * neighbour is — the adapter spells the path and its spec spells it back.
 */
export const CURSOR_SESSION_META_NAME = 'meta.json';

/**
 * The SQLite file the CLI keeps one conversation's state in, inside that
 * session's directory under the store — see
 * `utils/cursor-context-store.utils.ts` for what is in it and how it was
 * probed. Named here rather than inline because the adapter spells the path
 * and its spec spells it back.
 */
export const CURSOR_SESSION_STORE_DB_NAME = 'store.db';

// ---------------------------------------------------------------------------
// This CLI reporting its OWN failure — as an assistant message, under end_turn
// ---------------------------------------------------------------------------

/**
 * What every failure arm of this CLI's ACP layer opens its message chunk with.
 *
 * A LITERAL in the shipped bundle, not a wording: `2996.index.js` writes
 * `` `\n\nError: ${String(e)}` `` for the general case and a hardcoded
 * `"\n\nError: [unauthenticated] …"` for the auth one. Named here rather than
 * inline because `utils/cursor-agent-failure.utils.ts` matches it and that
 * file's spec spells it back — the two must not drift.
 */
export const CURSOR_AGENT_FAILURE_PREFIX = 'Error: ';

/**
 * The four names `String(e)` can put after that prefix — this CLI's own error
 * CLASSES, read off `index.js`, where each is a `get kind()` getter:
 * `class R extends B{get kind(){return"RetriableError"}}`, and the same shape
 * for the other three.
 *
 * A class name rather than a phrase is the whole reason this match is sound:
 * an agent writing about an error writes prose, not `RetriableError:` directly
 * after a chunk-opening `Error: `.
 */
export const CURSOR_AGENT_FAILURE_ERROR_KINDS: readonly string[] = [
  'RetriableError',
  'NonRetriableError',
  'ActionRequiredError',
  'CancelledError',
];

/**
 * The one failure arm that carries no class name — the CLI substitutes its own
 * sentence for a `connect` `Unauthenticated` code, so this is matched on the
 * bracketed code that opens it instead.
 */
export const CURSOR_AGENT_FAILURE_UNAUTHENTICATED = '[unauthenticated]';

/**
 * The four sentences an `ActionRequiredError` is REPLACED by — this arm drops
 * the class name entirely and sends the sentence alone, with no `Error: `
 * prefix, so these are the anchor.
 *
 * Read off the same catch block:
 *   {login:"Please sign in to continue", upgrade:"Upgrade your plan to continue",
 *    payment:"Add a payment method to continue", config:"Check your settings to continue"}
 *
 * The arm's own fallback for an action with no sentence (`e.message`) is
 * deliberately absent: it is unanchored text, and matching it would risk
 * putting the agent's own words in the failure chrome.
 */
/**
 * The failures that are only a DROPPED CONNECTION between cursor-agent and
 * Cursor's servers, which geniro resumes rather than reporting.
 *
 * Measured 2026-09-16 on 2026.08.31-4057e58. The CLI's interactive and print
 * modes run a turn with `enableAgentRetries` for a user message (`2336.index.js`
 * `retry-helpers.ts` → `w5`), so a drop is reconnected and the turn resumed from
 * its last checkpoint; its ACP server (`6863.index.js`) calls the same
 * `agentClient.run` WITHOUT that option, and the drop is thrown out as the
 * turn's failure (`[AGENT_ERROR_DIAGNOSTICS] … enableAgentRetries:false`). Five
 * turns in the author's database died this way, after 15–30 minutes each.
 * Reproduced by routing the CLI through a local CONNECT proxy and aborting its
 * tunnels mid-turn: `acp` answered `Error: RetriableError: [canceled] http/2
 * stream closed with error code CANCEL (0x8)` and ended the turn, `-p` opened a
 * new tunnel and finished; the same session given a continuation prompt re-ran
 * the interrupted command and finished too.
 *
 * Only what a retry can fix: a `RetriableError` also carries server answers such
 * as `[internal] Input token limit exceeded`, which it cannot.
 *
 * ## The three shapes, and why each is here
 *
 * The first cut listed the four bracketed transport codes and
 * `Stream ended without turnEnded`, from the one proxy reproduction above. That
 * is a SAMPLE, not the vocabulary, and the three QA reviews that died in run
 * `ce63c362` — 23min, 17min and 2min of work, none of it recoverable — were all
 * outside it. Re-read off the shipped 2026.09.10-fd3934a bundle, this CLI's
 * retry classifier (`index.js`, the `classify` closure) is:
 *
 *     const p = (exhausted, bare) => retriesOn
 *       ? (attempt >= limit ? {action:"throw", error: exhausted()}
 *                           : {action:"retry", …})
 *       : {action:"throw", error: bare()};
 *
 * so each family has TWO spellings and which one arrives says how hard the CLI
 * already tried. `retriesOn` is `enableAgentRetries`, which its ACP server
 * leaves false — so on this transport the BARE arm is the one that fires, and
 * it fires having retried nothing at all.
 *
 * - **`Connection stalled`** — its own stall detector, thrown on the FIRST
 *   stall here (`new Q("Connection stalled", … isRetryable: true)`). Its
 *   interactive client would have reconnected up to ten times before giving up.
 *   Two of the three dead reviews were this, and it cannot be matched by the
 *   bracketed arm because it carries no connect code at all.
 * - **`Connection stalled repeatedly` / `Connection failed repeatedly`** — the
 *   exhausted arm of the same two families, after ten CLI-side attempts. Weaker
 *   ground than the bare arm and still `isRetryable: true` in the CLI's own
 *   `displayInfo`: geniro's resume opens a NEW request, where those ten were one
 *   connection being retried.
 * - **`[resource_exhausted]`** — HTTP 429 (its own status map: `429:
 *   "resource_exhausted"`), and NOT the spent account window it reads like. The
 *   CLI's own policy retries a server error three times, which is not what a
 *   vendor does to a quota that is gone until tomorrow. It is the Cursor backend
 *   failing to reach the model provider, seen every few minutes on gemini-4-argon
 *   with only the parent request open. It is deliberately NOT routed to
 *   `AgentFailureClass.rate_limited`, whose contract is "wait, never retry"
 *   and whose `resetsAt` this message never carries — a caller told to wait for
 *   a reset nobody named waits forever. Should the
 *   resume budget run out it falls through to `crashed`, whose arm is "retry
 *   once, then report", which is the honest answer for a capacity error.
 *
 * - **`[internal] HTTP/2 keepalive ping timed out`** — the ONE `[internal]`
 *   admitted, and admitted by its message rather than by its code, because that
 *   code is overloaded: `[internal] Input token limit exceeded` is a server
 *   answer no retry can fix and must stay out. This one is the http/2 agent's
 *   own keepalive giving up and destroying the session — a literal template in
 *   the bundle (`HTTP/2 keepalive ping timed out after ${this.pingTimeoutMs}ms`)
 *   with ONE construction site shared by both agents, so it reaches a direct
 *   connection too, at that agent's `pingTimeoutMs: 2e4`. OBSERVED rather than
 *   reasoned: reproducing a stall against a real turn produced this and not
 *   `Connection stalled`, because the keepalive's timeout is shorter than the
 *   30s stall threshold and wins the race whenever the wire goes quiet.
 *
 * - **`[unknown] Premature close`** — the socket reset under an http/2 stream
 *   (`ERR_STREAM_PREMATURE_CLOSE`, `transportFailureKind: socket_reset` in its
 *   debug log), admitted by its message because `[unknown]` alone names
 *   nothing. MEASURED on 2026.10.19-6bbf2c4 (run `0d6b2220`): every stream of
 *   one process dropped at once, twice, 15 minutes apart, and the sub-agents'
 *   streams resumed on their own while the parent's died.
 * - **`WritableIterable is closed`** — its request writer closed under the
 *   request. Cursor staff call it transient and say a re-sent `session/prompt`
 *   on the same session usually carries on
 *   (forum.cursor.com/t/169334, 2026.08.11-e8db854).
 *
 * Each shape arrives under one of two prefixes. `Error: RetriableError:` is
 * the chunk its prompt handler writes from its catch block. `Internal error:`
 * is the `-32603` reply (category plus `data.details`) when the failure
 * escapes that block — the background-task completion drain runs after it, so
 * a drop there carries no class name, and the message is the only anchor.
 *
 * RE-CHECK by driving a cursor account into a 429 and reading whether a
 * resumed prompt is served. The resume now waits between attempts for a
 * different reason — see `CURSOR_TRANSIENT_RESUME_DELAYS_MS`.
 */
export const CURSOR_TRANSIENT_FAILURE_PATTERN =
  /^(Error: RetriableError|Internal error): (\[(canceled|unavailable|aborted|deadline_exceeded|resource_exhausted)\]|\[unknown\] Premature close|WritableIterable is closed|\[internal\] HTTP\/2 keepalive ping timed out|Stream ended without turnEnded|Connection (stalled|failed)\b)/;

/**
 * What geniro sends when a turn died on one of those — see
 * `CURSOR_TRANSIENT_FAILURE_PATTERN`.
 *
 * It names the interruption without naming its CAUSE, because the pattern
 * matches three families and only one of them is a dropped connection: telling
 * an agent its connection dropped when the service refused the request would
 * have it reason from a fact geniro invented, and the instruction that follows
 * is the same either way.
 *
 * What the interruption did to SUB-AGENTS is said by the prompt built around
 * this sentence (`cursorTransientResumePrompt`), because the agent cannot see
 * it and gets it wrong in the expensive direction. This used to say that every
 * unreturned `task` call "was stopped with the request: launch those again",
 * on the strength of run `bd1e43ae`, where seven reviewers' transcripts never
 * reached `turn_ended`. That was a sub-agent whose OWN stream died, not the
 * parent's. Read out of 2026.10.01-e373342 (`9577.index.js`): a sub-agent's
 * context is cancelled only by an abort or a user cancel, never by the parent's
 * stream failing, and it retries its own stream (`enableAgentRetries` is on for
 * sub-agents, off only for the ACP parent). MEASURED on run `a8f5fb5f`: the
 * parent's stream closed at 08:28:45Z, the two verifiers still running finished
 * `success` at 08:35 and 08:36 with nowhere to send their results, and the
 * agent — told to relaunch — ran all seven again, including five that had
 * finished before the drop and whose results the server never checkpointed.
 *
 * The last sentence is for a conversation that does not hold the request at
 * all. The driver re-sends the prompt when the turn had produced nothing
 * (`AcpSession.sendResume`), but a checkpoint can still lag the agent's steps;
 * on run `1b0f91aa` an agent with nothing to continue searched other sessions'
 * transcripts, found another conversation's unfinished work and carried it out.
 */
export const CURSOR_TRANSIENT_RESUME_PROMPT =
  'Your last response was cut off before it finished — the model service interrupted the request. Continue exactly where you left off. Do not repeat steps that already completed; re-run a step only if its result never came back. If you cannot see the request you were working on, say so and end your turn — never look for it in other conversations, their transcripts or their files.';

/**
 * The pause before each resume — three attempts per run of failures with no
 * progress between them, and then the failure is reported as the turn's own.
 *
 * Paced to outlast an outage rather than a blip. An attempt that meets the
 * same outage dies on the CLI's own 30s stall threshold (`Connection
 * stalled`), so the three attempts once sent back to back covered 90 seconds.
 * MEASURED on run `f1fa241c` (2026-09-28): Cursor answered no byte from
 * 13:12:00 to about 13:14:00 — geniro's separate usage poll to Cursor's API
 * failed with `fetch failed` at 13:13:40 while claude turns on the same
 * machine ran normally — and all three attempts fell inside it, losing a
 * review turn that a re-send 49 seconds later carried fine. These pauses plus
 * the attempts' own stall cover roughly five and a half minutes.
 */
export const CURSOR_TRANSIENT_RESUME_DELAYS_MS: readonly number[] = [
  15_000, 60_000, 180_000,
];

/**
 * The most resumes one turn gets in all, whatever progress came between them.
 * A long review meets this outage every few minutes, so each run of failures
 * gets the pauses above; the ceiling stops a provider that stays down from
 * looping the turn.
 */
export const CURSOR_TRANSIENT_RESUME_MAX_PER_TURN = 10;

export const CURSOR_AGENT_FAILURE_ACTION_SENTENCES: readonly string[] = [
  'Please sign in to continue',
  'Upgrade your plan to continue',
  'Add a payment method to continue',
  'Check your settings to continue',
];

// ── What a conversation cost (the account poll) ───────────────────────────
//
// cursor-agent reports no cost on the wire, so a conversation's price is read
// from the ACCOUNT instead — `utils/cursor-usage.utils.ts` carries the evidence
// that no local source exists, and `PolledSpendService` owns the cadence.

/** The Connect-RPC host the CLI itself talks to (`api3` does not route). */
export const CURSOR_API_HOST = 'https://api2.cursor.sh';

/** The one method the poll calls. Connect accepts JSON over a plain POST. */
export const CURSOR_USAGE_METHOD =
  '/aiserver.v1.DashboardService/GetFilteredUsageEvents';

/**
 * How many events one page asks for — large on purpose: few, fat requests
 * rather than many small ones, and a page is a plain array of small objects.
 */
export const CURSOR_USAGE_PAGE_SIZE = 250;

/**
 * How many pages one poll walks before giving up — 10,000 events. A bound
 * rather than a target: a steady-state poll reads one day (one page on a heavy
 * account), and only the first poll after a conversation appears reaches back
 * further, at most the account's thirty days — measured at 1,860 events on an
 * account spending ~$4,000 a month. A walk cut short is reported as incomplete,
 * so nothing it missed is ever settled.
 */
export const CURSOR_USAGE_MAX_PAGES = 40;

/**
 * The sentence the CLI ends a `task` tool result with, naming the delegate's
 * conversation: `Agent ID: <uuid> (can be used with the \`resume\` parameter …`.
 *
 * The ONLY local record tying a delegate's conversation to the one that
 * launched it, and the delegate's charges are billed under its OWN
 * conversation id. Measured 2026-10-05 on 2026.10.01-e373342: the parent's
 * `store.db` held this sentence for 922 of the 1,013 delegate conversations a
 * real account billed in thirty days, every one naming the id the account
 * reports. When it stops matching, delegates go back to unpriced — the parent's
 * own figure is untouched.
 */
export const CURSOR_SPAWNED_AGENT_ID_MARKER = 'Agent ID: ';

/** The write-ahead log beside {@link CURSOR_SESSION_STORE_DB_NAME}. */
export const CURSOR_SESSION_STORE_WAL_NAME = 'store.db-wal';

/** How long each page of the poll may take. */
export const CURSOR_USAGE_REQUEST_TIMEOUT_MS = 20_000;

// ── What the account is allowed (plan limits) ─────────────────────────────
//
// The two methods the CLI's own `/usage` asks (2026.10.22-27dcf5f), on the
// same host, under the same login; `utils/cursor-plan-limits.utils.ts` reads
// the replies.

export const CURSOR_PERIOD_USAGE_METHOD =
  '/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
export const CURSOR_PLAN_INFO_METHOD =
  '/aiserver.v1.DashboardService/GetPlanInfo';

/** How long one plan-limits request may take; the readout waits on it. */
export const CURSOR_PLAN_LIMITS_REQUEST_TIMEOUT_MS = 8_000;

/**
 * How long one account's answer is served before the account is asked again.
 * Every turn's prewarm and every readout open ask, so a busy team would
 * otherwise put two requests per turn to the user's account.
 */
export const CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS = 30_000;

/**
 * The Keychain item cursor-agent stores its own login under. Read, never
 * written and never kept: the value goes straight into one request header and
 * is not held, logged or persisted anywhere.
 */
export const CURSOR_KEYCHAIN_SERVICE = 'cursor-access-token';
export const CURSOR_KEYCHAIN_ACCOUNT = 'cursor-user';

/** How long the `security` read of that item may take. */
export const CURSOR_KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * The exit code of `security find-generic-password` when the Keychain holds no
 * such item (`errSecItemNotFound`) — measured 2026-11-05 on macOS 27.2; any
 * other failure (a denied prompt, a locked or unreadable keychain) exits
 * otherwise, and a timeout kills it.
 */
export const CURSOR_KEYCHAIN_ITEM_NOT_FOUND_EXIT = 44;
