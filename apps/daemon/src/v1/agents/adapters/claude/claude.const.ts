/**
 * Every `claude` value read from anywhere except the config literal.
 *
 * A value needed in more than one spot — an argv flag `buildArgs` pushes and a
 * util searches for, a file name a writer and its sweep both spell — is named
 * here precisely so the readers cannot drift apart. Values with a single
 * reader are named here too: the name is where the doc block lives, and
 * `--dangerously-skip-permissions` sitting bare in an argv array explains
 * nothing.
 *
 * The ONE exception is `ClaudeAdapter.getConfig()`. A static fact that literal
 * alone reads is written inline there, beside the field it answers, because a
 * name nothing else ever says buys nothing — it only puts the value one file
 * away from the shape that gives it meaning.
 */

import type {
  BackgroundUnitOutcome,
  WorkflowAgentState,
} from '../adapter.types';

// ── Turn argv ─────────────────────────────────────────────────────────────

/**
 * Makes the CLI echo each user message back on stdout, as a `user` line
 * carrying `isReplay: true`, at the moment it TAKES that message — which is the
 * only way to learn whether a follow-up written mid-turn has been answered.
 *
 * Probed on 2.1.270: a message written while a tool ran was echoed at the tool
 * boundary and answered inside the same `result`; one written while the model
 * was producing its final words was echoed only after that `result`, under a
 * fresh `system/init`, and answered by a `result` of its own. Without the flag
 * the two are indistinguishable on the wire. See `AdapterConfig`'s
 * `followUp.consumptionReported`.
 */
export const CLAUDE_REPLAY_USER_MESSAGES_FLAG = '--replay-user-messages';

/**
 * The invariant head of every turn's argv: `-p` headless, stream-json out,
 * `--verbose` (required for stream-json output), stream-json IN so the prompt
 * can travel as a structured user message on stdin, and the echo that says
 * when each of those messages was taken.
 */
export const CLAUDE_BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  CLAUDE_REPLAY_USER_MESSAGES_FLAG,
];

/** The argv flag that turns whole-block output into token-level deltas. */
export const CLAUDE_PARTIAL_MESSAGES_FLAG = '--include-partial-messages';

export const CLAUDE_MODEL_FLAG = '--model';
export const CLAUDE_EFFORT_FLAG = '--effort';
export const CLAUDE_RESUME_FLAG = '--resume';

// ── Compacting before the window fills ─────────────────────────────────────
/**
 * The flag that sets the window this CLI compacts itself against —
 * `--autocompact <auto|tokens>`, "Auto-compact window size" in its own `--help`
 * on 2.1.276. The env twin is `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and the user
 * twin is the `autoCompactWindow` setting; the flag is what geniro uses,
 * because it is per TURN and geniro never writes this CLI's settings.
 */
export const CLAUDE_AUTOCOMPACT_FLAG = '--autocompact';
/**
 * How far short of that window it actually compacts — its own `/context` names
 * the reserve "Autocompact buffer", and it read 33k unchanged at every window
 * measured (100k/150k/200k on haiku, 900k on `claude-opus-5[1m]`, 2.1.276,
 * 2026-09-22), so it is a fixed reserve rather than a share.
 */
export const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 33_000;
/**
 * The range it accepts, verbatim from the error it rejects argv with: "It must
 * be 'auto', or between 100k and 1M". Outside it the CLI exits before the turn
 * starts, which is why {@link CLAUDE_AUTOCOMPACT_MIN_TOKENS} is a refusal to
 * pass the flag rather than a figure to clamp blindly.
 */
export const CLAUDE_AUTOCOMPACT_MIN_TOKENS = 100_000;
export const CLAUDE_AUTOCOMPACT_MAX_TOKENS = 1_000_000;

// ── Fast mode ────────────────────────────────────────────────────────────
/**
 * The JSON-settings flag this CLI reads its FLAG layer from, and the one
 * channel that reaches fast mode in headless/SDK mode at all.
 *
 * PROBED on 2.1.280, `claude -p --output-format stream-json --model opus
 * "say hi"`: with no `--settings`, the `result` line carries
 * `fast_mode_disabled_reason: "sdk_opt_in_required"`. With
 * `--settings '{"fastMode":true}'` the SAME turn's reason becomes
 * `"extra_usage_disabled"` — this ACCOUNT's own paid-plan billing gate, which
 * nothing here can read ahead of a turn, rather than a defect in the flag. So
 * the settings key WORKS (unlike `enableArtifact` beside {@link
 * CLAUDE_ARTIFACT_ENV}, which this CLI silently ignores) and the toggle is
 * offered regardless of that account gate.
 *
 * A second `--settings` REPLACES the first rather than merging with it
 * (measured on 2.1.295: `{"language":"russian"}` then `{"env":…}` answered in
 * English, the reverse order in Russian), so the LAST one must carry every
 * key the turn needs: `claudeSettingsArgs` repeats an Ollama model's env,
 * because the base's env-only flag sits ahead of it on the same command line.
 */
export const CLAUDE_SETTINGS_FLAG = '--settings';
/** The id a turn's `modelParameters` carries this axis under — the CLI's own settings key, never translated. */
export const CLAUDE_FAST_MODE_PARAMETER_ID = 'fastMode';
export const CLAUDE_FAST_MODE_ON_VALUE = 'true';
export const CLAUDE_FAST_MODE_OFF_VALUE = 'false';
/**
 * The CLI's own reply-language setting. Set, it adds a `# Language` section to
 * the system prompt ("Always respond in <value>…"); probed on 2.1.295, an
 * English question under `{"language":"russian"}` was answered in Russian.
 */
export const CLAUDE_LANGUAGE_SETTING_KEY = 'language';

// ── The conversations this CLI keeps on disk ───────────────────────────────
/**
 * Where a profile stores them: `<configDir>/projects/<flattened cwd>/<id>.jsonl`.
 * Named because the listing and the transcript read both walk it, and a second
 * spelling is how one of them would come to look in the wrong place.
 */
export const CLAUDE_SESSIONS_DIR_NAME = 'projects';
/**
 * Where this CLI keeps its profile when no `CLAUDE_CONFIG_DIR` names one —
 * `~/.claude`. The same directory `skillRoots` and the settings reader reach
 * into; named here because the session scan needs it as a ROOT rather than as
 * the first segment of a path to one file.
 */
export const CLAUDE_DEFAULT_PROFILE_DIR = '.claude';
/**
 * Where a profile keeps a project's own memory notes:
 * `<configDir>/projects/<flattened git root>/memory/*.md`, each with
 * `name` / `description` (and sometimes `type`, top-level or under
 * `metadata`) frontmatter, beside a `MEMORY.md` index of pointers to them.
 * Read on claude 2.1.295 (`defaultPath` → `memory`, `MEMORY.md`).
 */
export const CLAUDE_MEMORY_DIR_NAME = 'memory';
export const CLAUDE_MEMORY_INDEX_FILE = 'MEMORY.md';

/** One session is one file, and the id is the file name without this. */
export const CLAUDE_SESSION_FILE_SUFFIX = '.jsonl';
/**
 * The transcript line a gracefully ending process appends with the session's
 * running cost totals (`totalCostUSD`, `totalAPIDuration`), which `--resume`
 * restores — so a resumed process's first `result.total_cost_usd` carries every
 * earlier process's spend. Probed on 2.1.284; see
 * `utils/claude-cost-state.utils.ts`.
 */
export const CLAUDE_COST_STATE_LINE_TYPE = 'cost-state';
/**
 * The transcript line the CLI appends when a session creates, pushes to,
 * checks out, comments on or merges a pull request —
 * `{"type":"pr-link","sessionId","prNumber","prUrl","prRepository","timestamp"}`
 * (what `claude --from-pr` resumes by). Read on 2.1.295, headless `-p` sessions
 * included; see `utils/claude-pr-links.utils.ts`.
 */
export const CLAUDE_PR_LINK_LINE_TYPE = 'pr-link';

/** `<userData>/` file the per-session running cost totals survive a restart in. */
export const CLAUDE_COST_TOTALS_FILE = 'claude-session-costs.json';

/** `<userData>/` directory the per-turn `--mcp-config` files are written in. */
export const CLAUDE_USER_DATA_TMP_DIR_NAME = 'tmp';

/** `<userData>/` throwaway workspaces of the command-catalog and mode probes. */
export const CLAUDE_PROBE_DIR_NAME = 'claude-probe';

/** `<userData>/` file the mode probe's verdicts are cached in. */
export const CLAUDE_PROBE_CACHE_FILE = 'claude-probe.json';
/**
 * How far into a session file the listing reads to find its folder and its
 * opening prompt.
 *
 * A budget rather than a line count, because the first lines are not small: a
 * session opens with hook output and system-reminder blocks, and in this
 * profile's own files the first real user message routinely sits 20–40KB in.
 * 256KB clears that with room to spare while keeping a 2,448-session profile to
 * a listing measured in hundreds of milliseconds.
 */
export const CLAUDE_SESSION_HEAD_BUDGET_BYTES = 256 * 1024;
/** How much of that prompt a picker row shows before it is elided. */
export const CLAUDE_SESSION_TITLE_MAX_CHARS = 120;
/**
 * How far into ONE session a content search reads before giving up on it.
 *
 * Searching means opening files the listing would otherwise only stat, so it is
 * bounded twice — here, and by {@link CLAUDE_SESSION_SEARCH_FILE_LIMIT}. A file
 * is abandoned the instant every term has matched, so the budget is only ever
 * paid in full by a session that does NOT match.
 *
 * MEASURED on the profile this was written against (3,029 sessions, 1.96GB;
 * the 600 newest are 561MB, 23 of them over 1MB and one of them 144MB). The
 * budget started at 1MB, which covers 577 of those 600 files whole for 122MB
 * of reading and 220ms — and missed the thing it was built for: the long
 * sessions are exactly the ones worth searching, and 1MB of an 11MB
 * conversation is its opening tenth. 16MB reads 262MB, and it still refuses
 * the 144MB outlier, which is the case a budget has to exist for at all.
 */
export const CLAUDE_SESSION_SEARCH_BUDGET_BYTES = 16 * 1024 * 1024;
/**
 * How many sessions a content search opens at all, newest first.
 *
 * The profile this was written against holds 2,448 sessions over 1.7GB, so
 * "search everything" is a multi-gigabyte read on every keystroke. Newest-first
 * is what makes a cut usable rather than arbitrary — the conversation somebody
 * is trying to find is one they had, not one from two years ago — and the
 * listing SAYS how far it got (`AgentSessionListing.partialReason`) instead of
 * passing a bounded search off as an exhaustive one.
 */
export const CLAUDE_SESSION_SEARCH_FILE_LIMIT = 600;
/** How much of a matching line a picker row shows before it is elided. */
export const CLAUDE_SESSION_SNIPPET_MAX_CHARS = 160;
export const CLAUDE_APPEND_SYSTEM_PROMPT_FLAG = '--append-system-prompt';
/** Effect-probed on claude 2.1.295: the file's instructions reach the model. */
export const CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG =
  '--append-system-prompt-file';
/** Leave argv and the environment ample room under macOS's shared ARG_MAX. */
export const CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES = 64 * 1024;
export const CLAUDE_SYSTEM_PROMPT_FILE_PREFIX = 'system-prompt-';
export const CLAUDE_SYSTEM_PROMPT_FILE_SUFFIX = '.txt';
export const CLAUDE_SYSTEM_PROMPT_FILE_MODE = 0o600;
export const CLAUDE_PERMISSION_MODE_FLAG = '--permission-mode';
export const CLAUDE_PERMISSION_PROMPT_TOOL_FLAG = '--permission-prompt-tool';

/**
 * The CLI's own name for the ask-the-user permission mode.
 *
 * `--help` on 2.1.227 no longer LISTS this value — its choices are
 * `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`, with
 * `manual` in its place. It is kept anyway, and deliberately not renamed:
 * probed on 2.1.227, `--permission-mode default` is still accepted (exit 0),
 * and BOTH spellings make the CLI report `permissionMode: "default"` back on
 * its `system/init` line. So `default` is the canonical internal name and
 * `manual` is the surfaced alias — chasing the alias would swap a name the CLI
 * answers with for one it only accepts.
 */
export const CLAUDE_PERMISSION_MODE_DEFAULT = 'default';

// ── Stdin control protocol (UNDOCUMENTED — probe evidence) ────────────────
//
// WHERE THESE FIELD NAMES CAME FROM. The stdin control protocol these two
// constants switch on is undocumented by the CLI: the `control_request` /
// `control_response` envelope, the `can_use_tool` subtype, and the
// `requires_user_interaction` flag that discriminates a genuine user question
// from a permission check were all established by DRIVING A LIVE CLI and
// reading what came back — never from published docs.
//
// Probed live on 2.1.202 (M4, the question discriminator) and re-probed on
// 2.1.220 (2026-07-29, the approval envelope + `message.usage` shapes). The
// protocol has held across patch releases within the 2.1 series.
//
// That evidence expires. A release can rename a field and every approval in
// the app starts mis-mapping while the turn still looks healthy, so this
// record is what tells the next reader that the names below and in
// `utils/claude-message.utils.ts` (`mapClaudeMessage`'s `control_request`
// arm) / `claude.adapter.ts` (`buildApprovalResponse`) are observations, not
// a contract — RE-PROBE before trusting them on a new claude series.

/** The permission-prompt transport: the stdin control dialogue. */
export const CLAUDE_PERMISSION_PROMPT_TOOL_STDIO = 'stdio';

/**
 * This CLI's own question tool — `AdapterConfig.questionToolName`, and the
 * name the `can_use_tool` mapping projects into a question card.
 */
export const CLAUDE_QUESTION_TOOL_NAME = 'AskUserQuestion';

/**
 * Bypasses every permission check — and STRIPS the question tool with them.
 *
 * Re-probed on 2.1.227 by reading `system/init`'s own `tools` list, which
 * sharpens WHY. It is not the bypass that removes `AskUserQuestion`; it is the
 * absence of a permission-prompt CHANNEL. Measured across every mode: with
 * `--permission-prompt-tool stdio` the tool is present under `default`,
 * `manual`, `acceptEdits`, `plan`, `auto` and `dontAsk` alike, and without it
 * the tool is absent under every one of those too — the mode is not the
 * variable. This flag strips it because a turn that asks nobody for permission
 * is given no channel to ask on.
 *
 * That distinction matters for the workaround in `buildArgs`, which is
 * unchanged and still correct: an `auto` turn that must be able to ask spawns
 * on `default` + stdio, and the probe confirms the tool is there. It also rules
 * out the tempting shortcut of keeping the bypass and adding stdio to it —
 * that combination does register the tool, but the same probe measured the
 * turn's whole tool surface collapsing from 207 entries to 91.
 */
export const CLAUDE_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/**
 * The control subtype that re-modes a turn ALREADY RUNNING.
 *
 * The one client-INITIATED control request the daemon sends; every other line
 * on this dialogue answers something the CLI asked first. Probed live on
 * 2.1.222: written mid-turn it was acknowledged in ~2ms, and the CLI re-emitted
 * `system/init` with the new `permissionMode` ~350ms later — so the change
 * lands on the turn in flight rather than on the next one.
 *
 *     --> {"type":"control_request","request_id":"…",
 *          "request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
 *     <-- control_response success {"mode":"acceptEdits"}
 *
 * Same expiry warning as the block above: an observation, not a contract.
 */
export const CLAUDE_SET_PERMISSION_MODE_SUBTYPE = 'set_permission_mode';

/**
 * The client-initiated control request that stops the turn in flight WITHOUT
 * stopping the process — the difference a run-scoped session is built on.
 *
 * Probed live on 2.1.223: acknowledged in ~2ms, the turn then ended with
 * `result subtype=error_during_execution`, and the process kept running with
 * its MCP servers up. Killing the process group instead is what takes those
 * servers — and a browser one of them owns — down with a turn the user only
 * meant to stop.
 *
 *     --> {"type":"control_request","request_id":"…",
 *          "request":{"subtype":"interrupt"}}
 *     <-- control_response success {"still_queued":[]}
 *
 * Same expiry warning as the blocks above: an observation, not a contract —
 * which is why the cancel path keeps a deadline behind it.
 */
export const CLAUDE_INTERRUPT_SUBTYPE = 'interrupt';

/**
 * Prefix for the request ids the DAEMON mints, keeping them out of the id
 * space the CLI mints for its own `can_use_tool` requests. Both travel the one
 * dialogue, and a collision would route the CLI's answer to our request into
 * the approval registry as though a tool had been decided.
 */
export const CLAUDE_CONTROL_REQUEST_ID_PREFIX = 'geniro-';

export const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';

/**
 * Tools the CLI withholds from the model for this process — claude's own
 * tools geniro replaces ({@link CLAUDE_WITHHELD_TOOLS}) and a team member's
 * switched-off MCP servers (`AgentTurnInput.mcpDisabled`). Variadic: one flag
 * followed by every rule. A rule naming a server alone (`mcp__<server>`) is
 * server-level and takes every tool of that server — see
 * `claudeDisallowedToolArgs` for the bundle reading and the measurement.
 */
export const CLAUDE_DISALLOWED_TOOLS_FLAG = '--disallowedTools';

/**
 * claude's own tools withheld from every geniro turn, because geniro serves
 * the same capability on its MCP endpoint for every CLI.
 *
 * `Monitor` — geniro's `monitor` tool. MEASURED on 2.1.295 (2026-10-21),
 * `claude -p --output-format stream-json --verbose`, read to `system/init`:
 * 147 tools with `Monitor` without the flag; `--disallowedTools Monitor` →
 * 146 and no `Monitor`, also with an `mcp__<server>` rule after it.
 *
 * `ListAgents` — geniro's `list_threads`, which reaches every CLI and every
 * state of a thread. MEASURED on 2.1.316 (2026-11-06), read to `system/init`:
 * `--disallowedTools ListAgents`, and its alias `ListPeers`, take the tool
 * away and leave `SendMessage`, and a background sub-agent still resumes
 * through `SendMessage`, so that tool stays.
 */
export const CLAUDE_WITHHELD_TOOLS: readonly string[] = [
  'Monitor',
  'ListAgents',
];

/**
 * The settings key and value that stop another claude session writing into a
 * geniro turn: such a message opens a turn the daemon never sees the text of.
 * MEASURED on 2.1.316 (2026-11-06): with `accept` a peer's `SendMessage` opened
 * a second `system/init` and `result`; with `refuse` in `--settings` none
 * opened, and the sender's `SendMessage` still answered success.
 */
export const CLAUDE_CROSS_SESSION_INBOUND_KEY = 'crossSessionInbound';
export const CLAUDE_CROSS_SESSION_INBOUND_REFUSE = 'refuse';

/** The prefix the CLI names every MCP tool under: `mcp__<server>__<tool>`. */
export const CLAUDE_MCP_TOOL_PREFIX = 'mcp__';

/**
 * Points claude at a different config directory — the folder holding its
 * credentials, settings, installed plugins and session history, i.e. WHICH
 * ACCOUNT the invocation runs as.
 *
 * ENV, not a flag: claude exposes no `--config-dir`, and this is the documented
 * knob its own SDK guidance names. Probe-verified on 2.1.227 — pointed at an
 * empty directory, a headless `claude -p` wrote `.claude.json`, `projects/` and
 * `sessions/` into it and ended "Not logged in · Please run /login", which is
 * the whole mechanism in one observation: a separate directory is a separate
 * signed-in profile.
 *
 * Named here rather than written inline because two call sites spell it — a
 * turn's `buildEnv` and the `mcp list` read, which must be taken under the SAME
 * profile it describes.
 */
export const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

/**
 * The Anthropic credentials a daemon can inherit from the shell that launched
 * it. Both isolated (no other agent's child may see them) and inherited (this
 * CLI's own children get them back), so one list drives both fields and the
 * two cannot name different keys.
 *
 * The bearer-token pair are Claude Code's own documented overrides for the
 * same thing an API key does: `ANTHROPIC_AUTH_TOKEN` becomes an
 * `Authorization: Bearer` header, and `ANTHROPIC_CUSTOM_HEADERS` can carry that
 * header by hand — either one alone is a working credential.
 *
 * The rest are every other credential the 2.1.280 bundle reads from its
 * environment — each name found in its own auth-env registry (the `Uo(M,{…})`
 * block of `AGENT_PROXY_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, …) and in the
 * sentence it prints when that credential fails: a Bedrock bearer token, both
 * Foundry credentials, the Anthropic-on-AWS key, and a long-lived OAuth REFRESH
 * token (the one that mints the access token). Left off this list, each reached
 * every other agent and every tool child a turn spawns.
 */
export const CLAUDE_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
] as const;

export const CLAUDE_PROVIDER_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const;

/**
 * Gives a HEADLESS turn this CLI's own `Artifact` tool — the thing it publishes
 * a page to claude.ai with.
 *
 * Restoring parity, not enabling a feature geniro invented: the account these
 * chats run as already holds published artifacts (`https://claude.ai/code/
 * artifact/<uuid>`), made from that CLI's interactive sessions. It is only the
 * headless mode geniro drives that ships without the tool, so an agent asked
 * for one answered that "this session cannot publish" — with nothing on screen
 * to say why, which is what got reported.
 *
 * Probe-verified on 2.1.234, reading `system/init`'s own tool list under the
 * exact argv a chat turn uses: two runs minutes apart differed by exactly one
 * tool, `Artifact`, present only in the one carrying this variable. Its sibling
 * settings key (`enableArtifact` in a `--settings` file) was probed too and
 * does NOT work — the CLI gates that key behind a per-account flag of its own,
 * so the environment is the only lever geniro has.
 *
 * Undocumented, so treat this as a MEASUREMENT with an expiry: when the CLI
 * ships the tool to headless sessions by itself, this line becomes a no-op and
 * should go. The value is only ever read as "is it set" — `1` is the spelling
 * the CLI's own truthiness check accepts.
 */
export const CLAUDE_ARTIFACT_ENV = 'CLAUDE_CODE_ARTIFACT';

/**
 * Gives a headless turn this CLI's own TASK tools — `TaskCreate`, `TaskUpdate`,
 * `TaskGet`, `TaskList` — the checklist it keeps while working a multi-step job.
 *
 * Same shape of loss as {@link CLAUDE_ARTIFACT_ENV} and a sharper consequence
 * here, because geniro already RENDERS that list: `claude-tasks.utils.ts` reads
 * it off both directions of those very tool calls, and the transcript's task
 * card and the side panel's rows are built from it. Without the tools the CLI
 * never announces a list, so a feature the app ships could not fire on claude
 * at all — a multi-step job showed anonymous tool rows instead.
 *
 * Probe-verified on 2.1.234 the same way as the artifact one: the same argv,
 * with and without, differing by exactly those four names.
 */
export const CLAUDE_TODO_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

/**
 * Makes this CLI announce its session state on stdout
 * (`system/session_state_changed` — see {@link CLAUDE_SESSION_STATE_SUBTYPE}).
 * Off unless set: the 2.1.270 bundle emits the line only
 * `if(a.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS)`.
 */
export const CLAUDE_SESSION_STATE_EVENTS_ENV =
  'CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS';

/**
 * Gives a turn the **Claude in Chrome** tools — the 22
 * `mcp__claude-in-chrome__*` names (navigate, read_page, find, form_input,
 * javascript_tool, tabs, console/network readers, screenshots…) that drive the
 * user's own browser through Anthropic's Chrome extension.
 *
 * Probe-verified on 2.1.234: absent from a headless turn's tool list, and all
 * 22 present with this set.
 *
 * OFF unless the user asks for it, which is the difference from the two above.
 * They restore a handful of tools that work on their own; this one registers a
 * whole toolbelt that does nothing at all without the extension installed and a
 * browser running it — and it is 22 tool schemas in every prompt of every turn,
 * paid for on each. So it is one of this adapter's options
 * ({@link CLAUDE_BROWSER_TOOLS_OPTION}), off unless the user turns it on.
 */
export const CLAUDE_BROWSER_TOOLS_ENV = 'CLAUDE_CODE_ENABLE_CFC';

/**
 * The option id behind {@link CLAUDE_BROWSER_TOOLS_ENV} — declared in
 * `getConfig().options` and read by `buildEnv`, which is why it is named.
 */
export const CLAUDE_BROWSER_TOOLS_OPTION = 'browserTools';

/**
 * Switches off the CLI's own auto memory (`<configDir>/projects/<cwd>/memory/`)
 * for a run that asks for it (`AgentTurnInput.nativeMemoryOff`), so the agent
 * keeps one memory.
 *
 * Probe-verified on 2.1.295: a seeded `MEMORY.md` is recalled without it and
 * not with it, and a folder's `CLAUDE.md` still loads with it. Told outright
 * to "save to your auto memory", the model still writes the file with its
 * ordinary Write tool; the CLI never loads it back.
 */
export const CLAUDE_DISABLE_AUTO_MEMORY_ENV = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/**
 * Restricts a turn to `--mcp-config` servers only.
 *
 * NEVER passed on a turn of the user's: an agent must see the same MCP servers
 * a fresh session in that folder sees, plus geniro's call surface. It is passed
 * on exactly one path — a turn the daemon runs for its own bookkeeping and
 * cancels before the model runs (`AgentTurnInput.isolateMcpServers`), where
 * loading the user's servers only to reap them is pure cost.
 */
export const CLAUDE_STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

/**
 * The `--mcp-config` value that defines no servers at all.
 *
 * Passed WITH {@link CLAUDE_STRICT_MCP_CONFIG_FLAG} rather than relying on the
 * flag alone, so the restriction has an explicit empty set to restrict to
 * rather than depending on how the CLI reads a strict flag with no config
 * beside it. The flag takes inline JSON as readily as a path, so this needs no
 * temp file to be cleaned up.
 *
 * Probe-verified on claude 2.1.223: this argv is accepted, the `init` line
 * comes back with `mcp_servers: []` — no server of the user's was started —
 * and it still reports all 59 `slash_commands`, which is the only thing the
 * probe reading it wants.
 */
export const CLAUDE_EMPTY_MCP_CONFIG = '{"mcpServers":{}}';

// ── The MCP toggle ────────────────────────────────────────────────────────
//
// PROBE EVIDENCE, claude 2.1.220 and 2.1.222, captured on this machine.
// Re-probe before trusting any of it on a new claude series — every line below
// is an observation of one build, not a documented contract.
//
// - `projects[<key>].disabledMcpServers` in the home config takes a server out
//   of a real turn WHATEVER SCOPE DEFINED IT (2.1.222, isolated
//   CLAUDE_CONFIG_DIR, `local`-scope server: `status: 'failed'` without the
//   key, `status: 'disabled'` with it). This is the toggle geniro writes.
// - `<key>` is the CLI's PROJECT key, not the cwd: the repository root, and
//   for a git worktree the MAIN repository (2.1.280, isolated
//   CLAUDE_CONFIG_DIR: from `repo/sub` and from a worktree, the cwd's entry
//   changed nothing and the repository's disabled the server). See
//   `claudeProjectKey`.
// - `disabledMcpjsonServers` is a different list: it REJECTS a project
//   `.mcp.json` server, and every source's copy of it is UNIONed rather than
//   overridden — so nothing geniro writes can put such a server back.
// - `claude mcp list` accepts NO options at all, and reports a disabled server
//   as though it were live, so the LISTING can never reflect the toggle. The
//   daemon merges the config's own disabled set into the rows instead.
// - It is the TURN, not the listing, that auto-approves project servers: the
//   same folder shows them `Pending approval` under `mcp list` while a `-p`
//   turn reports them `connected`.

/**
 * The CLI's OWN per-folder disable list, and the mechanism geniro's toggle
 * uses: `~/.claude.json` → `projects[<key>].disabledMcpServers`, `<key>` being
 * the CLI's own project key for the folder (`claudeProjectKey`).
 *
 * PROBE-VERIFIED on 2.1.222, in an isolated `CLAUDE_CONFIG_DIR` with a
 * `local`-scope server — the scope the old settings-file route could never
 * reach:
 *
 *   without the key   → init `mcp_servers: [{name: 'probe-server', status: 'failed'}]`
 *   with the key      → init `mcp_servers: [{name: 'probe-server', status: 'disabled'}]`
 *
 * It covers servers of EVERY scope, which `disabledMcpjsonServers` (below) does
 * not — that one only rejects a project `.mcp.json` server. This is what the
 * CLI's own `/mcp` panel writes, so a switch flipped here is the same switch
 * the user sees in their terminal, and vice versa.
 */
export const CLAUDE_HOME_DISABLED_MCP_KEY = 'disabledMcpServers';

/**
 * The `.mcp.json` REJECTION list, in settings and in the home config.
 *
 * Read-only for geniro: a name here is one the user (or the CLI's own trust
 * prompt) turned down, and the CLI unions every source's copy of this list
 * rather than letting a later one override — so nothing geniro writes can put
 * such a server back. It is a different question from
 * {@link CLAUDE_HOME_DISABLED_MCP_KEY}: approval, not loading.
 */
export const CLAUDE_DISABLED_MCP_SERVERS_KEY = 'disabledMcpjsonServers';

/** The folder's own MCP server definitions. */
export const CLAUDE_PROJECT_MCP_FILE = '.mcp.json';

/**
 * The key a server DEFINITION sits under, in every file that carries one — the
 * home config's own (user scope), a project entry inside it (local scope) and
 * {@link CLAUDE_PROJECT_MCP_FILE} (project scope).
 *
 * One name because three readers spell it, and a fourth is a `mcp_servers` away
 * from silently reporting a folder as having none. It is NOT
 * {@link CLAUDE_MCP_STATUS_ROWS_KEY}, which happens to be the same word for the
 * rows of a `mcp_status` REPLY — a wire shape, not a config file.
 */
export const CLAUDE_MCP_SERVERS_KEY = 'mcpServers';

/**
 * The lock geniro takes before editing the CLI's home config.
 *
 * `proper-lockfile`'s default artifact for a path is `<path>.lock`, and the CLI
 * passes exactly that as its own `lockfilePath` — its `ELOCKED` and
 * "Config lock compromised" strings are that package's. Naming the suffix here
 * is what keeps the two processes on the SAME lock: a different path would
 * still lock, and would still let both write at once.
 */
export const CLAUDE_CONFIG_LOCK_SUFFIX = '.lock';

/**
 * Retries while another claude process holds the config lock. Each write is a
 * parse and a rename of a small file, so contention is brief — but a user
 * typing in their own CLI while the panel toggles is entirely ordinary, and
 * failing the toggle at the first collision would surface as a switch that
 * randomly does nothing.
 */
export const CLAUDE_CONFIG_LOCK_RETRIES = 10;

/**
 * The permission bits the CLI's home config is written with when it does not
 * exist yet; an existing file keeps its own.
 *
 * The CLI's own rule, read out of the 2.1.280 bundle: its config writer is
 * called with `mode: 384` (0600) and preserves an existing file's mode
 * (`statMeta(globalConfig).mode ?? 384`). The file holds the user's account
 * record and every project's history, so a copy geniro writes must not be the
 * one that makes it world-readable.
 */
export const CLAUDE_CONFIG_FILE_FALLBACK_MODE = 0o600;

/**
 * The user's own settings files, resolved against a run's cwd. Read ONLY — a
 * name found in one is a server geniro cannot re-enable, because the CLI
 * unions the disabled lists rather than letting ours override.
 */
export const CLAUDE_PROJECT_SETTINGS_FILES = [
  '.claude/settings.json',
  '.claude/settings.local.json',
] as const;

/** The same, in the user's home directory. */
export const CLAUDE_HOME_SETTINGS_FILE = '.claude/settings.json';

/**
 * The same file inside a PROFILE, where it sits one level higher.
 *
 * `CLAUDE_CONFIG_DIR` names the directory that `~/.claude` otherwise is, so the
 * `.claude/` segment is already spent — measured on a real profile, which holds
 * `settings.json` at its root beside its own `.claude.json`, and has no
 * `.claude/` directory at all. Joining {@link CLAUDE_HOME_SETTINGS_FILE} onto a
 * profile therefore reads a path that never exists, which is indistinguishable
 * from a user who has disabled nothing.
 */
export const CLAUDE_PROFILE_SETTINGS_FILE = 'settings.json';

// ── Models ────────────────────────────────────────────────────────────────

/** The CLI's own config file in `~`, which caches the account's model options. */
export const CLAUDE_MODEL_CACHE_FILE = '.claude.json';

/**
 * The key inside it: `[{ value, label, description, disabled? }]`.
 *
 * `disabled` is the field that makes this list more than a model set — the CLI
 * files placeholders here to EXPLAIN a model the install cannot run, whose
 * `value` is a sentinel rather than an id. `readClaudeModelCache` drops them;
 * its doc block carries the measured entry.
 */
export const CLAUDE_MODEL_CACHE_KEY = 'additionalModelOptionsCache';

// ── The permission-mode probe ─────────────────────────────────────────────

/** Never answered: the turn is cancelled the moment the session line lands. */
export const CLAUDE_MODE_PROBE_PROMPT = 'Reply with exactly: ok';

/** A hung probe turn must not wedge the capability read forever. */
export const CLAUDE_MODE_PROBE_TIMEOUT_MS = 30_000;

/**
 * How long a probe round that could not settle (not installed, signed out,
 * timed out) stands for the same binary version before the modes are probed
 * again. The client re-reads capabilities on a short cadence until every row
 * settles, and a claude that never settles would otherwise start a round — two
 * turns and their temp directories — on every one of those reads.
 */
export const CLAUDE_MODE_PROBE_RETRY_MS = 60_000;

/**
 * An argv-level rejection of `--permission-mode <value>` is the one GENUINE
 * fail — every other pre-session exit (auth, network, missing binary) is an
 * environmental `unknown` that must not be disk-cached against this version.
 * Both patterns must match the SAME error line: the flag has to be named, and
 * the CLI has to be complaining about the value it was given.
 */
export const CLAUDE_MODE_REJECTION_FLAG_PATTERN = /permission-mode/i;
export const CLAUDE_MODE_REJECTION_VERDICT_PATTERN =
  /invalid|allowed choices|unknown/i;

// ── Naming a conversation ─────────────────────────────────────────────────

/**
 * How much reasoning the naming turn may spend — see {@link CLAUDE_TITLE_ARGS}.
 *
 * Declared BEFORE that array because the array reads it at module evaluation:
 * `const` is hoisted into the temporal dead zone, not initialized, so the
 * obvious placement beside its sibling below throws on import.
 *
 * Spelled `--max-thinking-tokens` rather than its `--maxThinkingTokens` alias,
 * for the reason every other flag here is: the hyphenated form is the one the
 * CLI's own help prints.
 */
export const CLAUDE_MAX_THINKING_TOKENS_FLAG = '--max-thinking-tokens';

/**
 * The argv of the throwaway turn that names a chat.
 *
 * `--output-format json` rather than the turns' `stream-json`: this is one
 * short answer read at the end, not a stream, and the plain form puts it in a
 * single object's `result`. The MCP pair is the same isolation an internal
 * probe turn takes — a title has no use for the user's servers, and dialling
 * them would cost seconds and launch their processes to write five words.
 *
 * `--max-thinking-tokens 0` is a MEASUREMENT, not tidiness. Naming a chat is a
 * one-line judgement, and the model was spending 400–780 reasoning tokens on
 * it — most of the turn. Measured on 2.1.237 over four runs per arm, same
 * prompt: 7.7–11.0s with thinking, 3.0–6.9s without, every answer valid. It is
 * only safe alongside the transcript framing in `titlePrompt`: with the OLD
 * wording, taking thinking away made the model act on the quoted conversation
 * INSTEAD of pausing to work out what it was, which is a 16s turn answering
 * with prose. The two changes are one change.
 */
export const CLAUDE_TITLE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'json',
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
  CLAUDE_MAX_THINKING_TOKENS_FLAG,
  '0',
];

/**
 * The model that writes the title, named rather than inherited from the chat.
 *
 * Naming a conversation is not the work the user is paying opus for, and the
 * cost is per chat: measured on 2.1.237, one title on this model is ~$0.03,
 * nearly all of it the CLI's own system prompt and tool definitions, which
 * `-p` gives no way to withhold. An alias rather than a dated id, so an
 * account that has moved on to the next haiku is not left with a model it can
 * no longer run.
 */
export const CLAUDE_TITLE_MODEL = 'haiku';

/**
 * How long the naming turn may take before it is written off.
 *
 * Generous against the ~6s measured, because the alternative to waiting is not
 * a faster title but the derived one standing for the life of the chat.
 */
export const CLAUDE_TITLE_TIMEOUT_MS = 60_000;

/**
 * The scratch folder the naming turn runs in.
 *
 * Nowhere in particular ON PURPOSE: this CLI loads a project's `CLAUDE.md` (or,
 * with none, its `AGENTS.md`) from its cwd, and running the naming turn in the
 * user's repository would bill every new chat for that file (40KB in this one)
 * to write five words.
 */
export const CLAUDE_TITLE_DIR_PREFIX = 'geniro-title-';

/**
 * A one-off question (`askOnce`): the naming turn's argv, model and kind of
 * scratch folder, for the same reasons, with a deadline sized for a long
 * prompt answered at length.
 */
export const CLAUDE_ASK_TIMEOUT_MS = 180_000;
export const CLAUDE_ASK_DIR_PREFIX = 'geniro-ask-';

// ── Agent-to-agent calls (MCP) ────────────────────────────────────────────

/**
 * Default `MCP_TOOL_TIMEOUT` for turns that carry the call tools: a sync
 * call_agent legitimately runs for minutes (a full callee turn), far past the
 * CLI's own default MCP client timeout.
 *
 * It is the floor for EVERY server that turn loads, the user's own included,
 * which is both why it is generous and why it is not generous enough for one
 * case: a tool that parks on a PERSON. That case has its own, per-server
 * ceiling — {@link GENIRO_MCP_TOOL_TIMEOUT_MS} — which the CLI lets this app set
 * on its own entry alone, so a genuinely hung server of the user's still gives
 * up after half an hour. The two are not duplicates and must not be merged: one
 * bounds a machine, the other waits for a human.
 */
export const CLAUDE_MCP_TOOL_TIMEOUT_MS = 30 * 60_000;

/** The child env var carrying {@link CLAUDE_MCP_TOOL_TIMEOUT_MS}. */
export const CLAUDE_MCP_TOOL_TIMEOUT_ENV = 'MCP_TOOL_TIMEOUT';

/** Fallback directory name under the OS tmpdir for standalone/spec use. */
export const CLAUDE_MCP_CONFIG_DIR_NAME = 'geniro-mcp';

/** Per-turn config file name: `<prefix><uuid><suffix>`, also the sweep's filter. */
export const CLAUDE_MCP_CONFIG_PREFIX = 'mcp-';
export const CLAUDE_MCP_CONFIG_SUFFIX = '.json';

/** The token rides IN the file, so the file is the user's alone. */
export const CLAUDE_MCP_CONFIG_FILE_MODE = 0o600;

/**
 * How long ONE call to a geniro host tool may take, in milliseconds — the
 * `timeout` field on this app's own entry in the per-turn `--mcp-config`.
 *
 * REPORTED as questions expiring: an agent's own reasoning read "Timed out
 * again. The user seems to step away when the cards fire", over a card that was
 * still on screen waiting to be answered. Nothing in geniro expires one — the
 * turn's silence deadline is already exempt while it is blocked on a verdict —
 * so the deadline was the CLI's, and it belongs to the TOOL CALL rather than to
 * the turn: `ask_user_question`, `propose_patch` and `propose_plan` are all
 * served by holding the HTTP POST open until a human answers, and the client
 * gives up first.
 *
 * The field is read off that CLI's own bundle (2.1.251), whose http server
 * schema is `{type, url, headers, tools, timeout, request_timeout_ms,
 * alwaysLoad}` and describes this one as a "Per-server tool-call timeout in
 * milliseconds… Hard wall-clock limit per call". Two things there decided the
 * shape of this fix. It is PER SERVER, which is why it goes in this file rather
 * than as the `MCP_TOOL_TIMEOUT` env var the same text names: the env var would
 * lift the ceiling for every MCP server the user loads, so a genuinely hung one
 * of theirs would hang forever too. And "progress notifications do not extend
 * it" rules out the other obvious answer — teaching this app's stateless MCP
 * route to stream progress would not have helped.
 *
 * A DAY rather than an attempt at "no timeout", which the schema cannot express
 * (a positive integer is required). A question left overnight is a real thing a
 * user does; a call still open a day later is a leak, and the ceiling is then
 * the only thing that ends it.
 */
export const GENIRO_MCP_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// ── The MCP readiness gate (PROBE EVIDENCE — undocumented control subtype) ──
//
// THE DEFECT THIS EXISTS FOR. "I have playwright in mcp servers list … But
// agent cant use it" — reported with two screenshots: geniro's MCP panel with
// `playwright` green, and the agent in the same folder replying "the Playwright
// MCP server isn't loaded in this session", inventing a config reason for it
// (the server is a `local`-scope entry under two OTHER projects). Both the
// panel and the agent were reporting honestly; the panel is right and the
// agent's session really did not have the tools.
//
// WHAT IS ACTUALLY HAPPENING, measured on 2.1.232 in the author's own folder
// (45 servers). The CLI dials its MCP servers when the PROCESS starts and does
// NOT wait for them before running a turn, so a turn that begins ~3s in is
// given whatever has connected by then:
//
//   prompt written at 0s → init at 3.1s: 8 servers `pending`, 148 tools,
//                                        0 of them playwright's
//   prompt held to 8s    → init at 8.1s: 0 pending, 466 tools, 24 playwright
//
// Nothing is permanently missing — the surface GROWS mid-turn (probed: a server
// `pending` at init answered a tool call 29s later). The damage is that the
// model asks once, at second three, is told the tool does not exist, and
// reasons from that for the rest of the conversation. That is why it presents
// as "the agent can't use it" and why it is intermittent — it is a race with
// however long each server takes to dial.
//
// THE ORACLE. `mcp_status` is a client-initiated control request on the same
// stdin dialogue as `can_use_tool` — undocumented, found by enumerating the
// subtypes in the shipped binary and then DRIVEN LIVE. It answers before any
// prompt has been written, which is what makes a gate possible at all:
//
//     --> {"type":"control_request","request_id":"…",
//          "request":{"subtype":"mcp_status"}}
//     <-- {"type":"control_response","response":{"subtype":"success",
//          "request_id":"…","response":{"mcpServers":[
//            {"name":"playwright","status":"pending","config":{…},"scope":"user"},
//            …]}}}
//
// Observed on 2.1.232, polling every 400ms from spawn: n=6/5 pending at 0.8s,
// n=45/14 at 1.2s, 0 pending at 6.0s, and the turn released at 6.4s reported
// `pending: []` and 466 tools at init. Same expiry warning as the other probe
// blocks in this file: an observation of one build, not a contract. If a later
// release renames the subtype or the reply, the gate degrades to "no oracle,
// send the prompt now" — which is exactly today's behaviour, so a rename costs
// the fix and never the turn.

/** The control subtype that reports every MCP server's live connection state. */
export const CLAUDE_MCP_STATUS_SUBTYPE = 'mcp_status';

/** The key its reply carries the rows under — `mcpServers`, not `servers`. */
export const CLAUDE_MCP_STATUS_ROWS_KEY = 'mcpServers';

/** The one row status that means "still dialling"; every other is settled. */
export const CLAUDE_MCP_STATUS_PENDING = 'pending';

/**
 * Gap between readiness polls. Small enough that the gate releases within a
 * poll of the last server settling (measured: the servers went quiet at 6.0s
 * and the prompt went out at 6.4s), large enough not to spin.
 */
export const CLAUDE_MCP_READY_POLL_MS = 400;

/**
 * How long ONE poll waits for its answer before the gate asks again.
 *
 * Silence is not refusal, and conflating the two cost the gate its first
 * observed run: a cold CLI left the opening poll unanswered, and a gate that
 * treated that as "this build has no such subtype" gave up permanently on a
 * CLI that answers every later poll in well under a second. Only an explicit
 * error reply is a refusal.
 *
 * Nor is silence an EMPTY reading, which is what it was read as next — and
 * that let the empty grace below end the wait on two unanswered polls: a CLI
 * too busy starting to answer for two and a half seconds is precisely the one
 * whose servers are still dialling, and the prompt went out on a partial tool
 * surface with nothing said. So an unanswered poll now teaches the gate
 * nothing: it moves neither the grace (which starts at the first ANSWER) nor
 * the stall clock. {@link CLAUDE_MCP_READY_SILENCE_MS} bounds a CLI that never
 * answers — which then says so ({@link CLAUDE_MCP_READINESS_UNCONFIRMED_MESSAGE}).
 */
export const CLAUDE_MCP_READY_REPLY_TIMEOUT_MS = 1_200;

/**
 * How long the gate waits on a CLI that has answered NOTHING yet.
 *
 * A cold CLI was measured silent for about two and a half seconds, so this
 * leaves it room; past it the silence is not a slow start. It is not a renamed
 * subtype either: 2.1.280 answers an unknown one with an error reply
 * (`Unsupported control request subtype`), which releases at once as refused.
 * Bounded by the stall window instead, a CLI that stopped answering held every
 * first message fifteen seconds.
 */
export const CLAUDE_MCP_READY_SILENCE_MS = 5_000;

/**
 * The two `system` lines bracketing one of the CLI's own HOOKS, paired by
 * `hook_id`. They are why a CLI can be silent for longer than
 * {@link CLAUDE_MCP_READY_SILENCE_MS} without having stopped answering.
 *
 * The CLI runs its SessionStart hooks BEFORE it reads its control channel, so
 * every `mcp_status` written meanwhile queues unanswered. Measured on 2.1.x
 * (2026-10-05), polling every 400ms from spawn: in a folder whose only
 * SessionStart hook is `sleep 7`, five polls went unanswered and all five were
 * answered at 7.25s — the instant the hook's `hook_response` landed; in the
 * user's own ManifestOS profile (eight hooks), the first answer came 10ms after
 * the last `hook_response`, at 1.5–1.7s. A hook that takes longer than the
 * silence window therefore made the gate report "the CLI did not say" about a
 * CLI that was telling it exactly why it was quiet — REPORTED on a chat whose
 * profile's hooks ran past 5s. So silence is only timed while no hook is
 * running and none has reported recently; the CLI's own hook timeout and
 * {@link CLAUDE_MCP_READY_MAX_WAIT_MS} still bound a hook that never ends.
 */
export const CLAUDE_HOOK_STARTED_SUBTYPE = 'hook_started';
/** @see CLAUDE_HOOK_STARTED_SUBTYPE */
export const CLAUDE_HOOK_RESPONSE_SUBTYPE = 'hook_response';

/**
 * How long an EMPTY reading is believed before the gate concludes the machine
 * simply has no MCP servers — counted from the first poll the CLI ANSWERED.
 *
 * The list is not empty because nothing is configured — it is empty because
 * discovery has not finished. Measured, the first non-empty reading landed at
 * 0.77–0.8s across runs, so this is generous; a user with no servers at all
 * pays it once per session process and nothing after. From the first answer
 * rather than from the first poll, because a CLI that answered nothing until
 * second three has had no time at all to discover anything.
 */
export const CLAUDE_MCP_READY_EMPTY_GRACE_MS = 2_000;

/**
 * How long the gate waits WITHOUT PROGRESS before giving up — a stall window,
 * not a flat ceiling.
 *
 * A server that never leaves `pending` — a broken command, an unreachable host
 * — must not hold the user's first message forever, so once nothing has
 * CHANGED for this long the prompt goes out with a notice naming what was still
 * starting. Set above the 6s the author's own 45-server folder took, and far
 * below the turn's silence deadline, which is the backstop behind it.
 *
 * It used to be the whole ceiling, measured from the first poll, and that is
 * what put "these MCP servers were still starting" on a real turn: remote
 * servers (claude.ai, Amplitude) had not finished dialling at 15s, so their
 * tools were missing from the message even though discovery was visibly still
 * making progress. Timing the STALL rather than the total keeps the impatience
 * pointed at what it was for — a server that is stuck — while a slow one that
 * is still moving gets to finish.
 */
export const CLAUDE_MCP_READY_STALL_MS = 15_000;

/**
 * The hard ceiling behind the stall window, so a folder whose servers report
 * churn forever still cannot hold the first message indefinitely.
 *
 * Only reachable by a folder that keeps CHANGING its reading for a full minute
 * without ever settling; anything healthy releases the moment two identical
 * readings show nothing pending, which is usually seconds.
 */
export const CLAUDE_MCP_READY_MAX_WAIT_MS = 60_000;

/**
 * Said out loud when the deadline expires with servers still dialling: `%s` is
 * the comma-separated list. Without it the turn would silently be the old
 * broken one, which is the report this whole block exists for.
 */
export const CLAUDE_MCP_NOT_READY_MESSAGE =
  'these MCP servers were still starting when this turn began, so their tools are missing from it: %s. They will be available from your next message.';

/**
 * Said when the CLI never answered a single readiness poll inside the stall
 * window, so nothing is known about its servers — the unnamed twin of
 * {@link CLAUDE_MCP_NOT_READY_MESSAGE}, for the same reason that one exists: a
 * turn that may be running on a partial tool surface must not do so silently.
 */
export const CLAUDE_MCP_READINESS_UNCONFIRMED_MESSAGE =
  'the CLI did not say whether its MCP servers had finished starting, so this turn began without waiting for them. If a tool seems to be missing, it will be available from your next message.';

// ── MCP repair on a LIVE session (PROBE EVIDENCE) ─────────────────────────
//
// A server that is dialled and DEAD is a different failure from one still
// dialling, and it is the one the readiness gate above cannot help with: the
// gate waits for `pending` to clear, and a server that failed has cleared it.
// From then on every tool call on that server answers
// `MCP server "<name>" is not connected` for the rest of the PROCESS, and
// claude keeps one process per chat — so a chat that loses a server loses it
// until something retires that process. REPORTED with a screenshot: four calls
// on `claude.ai Example Google Workspace` over 23 seconds, every one of
// them that sentence, in a chat whose profile had been switched five minutes
// earlier (a switch closes the session, so the failure was that new process's
// opening dial).
//
// WHAT THE PANEL SAID AT THE SAME MOMENT: `✔ Connected`. `claude mcp get
// <name>` reports a claude.ai connector as connected without dialling it, so
// the one command behind geniro's MCP panel cannot see this class of failure
// at all. The live session can, and says why.
//
// THE MECHANISM. `mcp_reconnect` is a client-initiated control request on the
// same stdin dialogue as `mcp_status`, found the same way (enumerating the
// shipped binary's subtypes) and then DRIVEN LIVE against 2.1.247, twice, on
// two profiles of one account:
//
//     --> {"type":"control_request","request_id":"…",
//          "request":{"subtype":"mcp_reconnect","serverName":"…"}}
//     <-- {"type":"control_response","response":{"subtype":"success",
//          "request_id":"…"}}
//
// On the working profile that reply came in 1.8s and the following
// `mcp_status` row went `pending` → `connected` with all 34 of the server's
// tools listed. On the broken one the SAME request answered
// `{"subtype":"error","error":"Error POSTing to endpoint: …
// \"not_found_error\" … \"Server not found\""}` — the connector's own host
// answering 404 for that account's server id. That error text is the whole
// value of asking: it is the difference between "a tool is missing" and "this
// account's connector record points at a server that no longer exists".
//
// It is host-sendable, which had to be checked rather than assumed: the
// binary's own reject list for host-sent subtypes names `can_use_tool`,
// `hook_callback`, `elicitation`, `request_user_dialog`, `oauth_token_refresh`,
// `host_auth_token_refresh` and the three remote-tool subtypes, and
// `mcp_reconnect` is on none of them.
//
// Same expiry warning as every probe block in this file: one build's
// observation, not a contract. A renamed subtype or reply leaves the reply
// unmatched, which costs the repair and the diagnosis and never the turn.

/** The control subtype that re-dials ONE MCP server on a live session. */
export const CLAUDE_MCP_RECONNECT_SUBTYPE = 'mcp_reconnect';

/**
 * The CLI's own sentence for a tool call on a server that is not connected.
 *
 * Transcribed from the 2.1.247 bundle, where it is the literal
 * `` `MCP server "${e.name}" is not connected` `` — so the name is captured
 * from the one place it is stated rather than guessed from the tool prefix,
 * which is MANGLED (`claude.ai X` is exposed to the model as
 * `mcp__claude_ai_X__…`, and that mapping is not invertible).
 *
 * Anchored at both ends and matched against the WHOLE trimmed leaf, never
 * searched within it. `isPermissionChannelFailure` learned this the expensive
 * way — a substring match fired on geniro's own source being read back, three
 * times in one run — and this file now quotes the sentence itself, so a loose
 * matcher would fire on every `Read` of it.
 */
export const CLAUDE_MCP_NOT_CONNECTED_PATTERN =
  /^MCP server "(.+)" is not connected$/;

/**
 * Said when a dead server was re-dialled successfully: `%s` is its name.
 *
 * The turn is told nothing — the CLI's tool surface simply works again — so
 * this row is the only account of why a call that just failed now succeeds.
 */
export const CLAUDE_MCP_RECONNECTED_MESSAGE =
  'MCP server %s had dropped out of this chat and has been reconnected — the agent can use its tools again.';

/**
 * Said when the re-dial FAILED: `%s` is the server, `%r` the CLI's own reason.
 *
 * A `warning`, and the reason is quoted verbatim: it is the CLI's diagnosis of
 * somebody else's server, and paraphrasing the one actionable sentence in it
 * (`Server not found`, a 401, a refused connection) would leave the user with
 * the bare "not connected" this exists to improve on.
 */
export const CLAUDE_MCP_RECONNECT_FAILED_MESSAGE =
  'MCP server %s is not connected to this chat and could not be reconnected: %r';

// ── MCP server listing (PROBE EVIDENCE — human-readable output) ───────────
//
// WHERE THESE MARKERS CAME FROM. `claude mcp list` has no machine-readable
// mode — `--json` is rejected outright ("error: unknown option '--json'") — so
// the only source is its prose, and these are the exact bytes it printed when
// DRIVEN LIVE on 2.1.220 against servers created for the probe and removed
// after. Two of the three glyphs are not the character they look like: the
// connected mark is U+221A SQUARE ROOT, not a check mark, and the failure mark
// is U+00D7 MULTIPLICATION SIGN, not an ASCII `x`. Typing them by eye is how a
// matcher silently matches nothing.
//
// That evidence expires. A release may reword any of this, and the parser is
// built so it degrades to `status: 'unknown'` rather than throwing or dropping
// the row — a listed server with unreadable health beats a server the user
// cannot see at all. Prefer a structured mode over this the moment one exists.

/** Argv for the folder-scoped server listing. */
export const CLAUDE_MCP_LIST_ARGS: readonly string[] = ['mcp', 'list'];

/**
 * Deadline for that listing. Far above the 10s utility default because the
 * command HEALTH-CHECKS: it dials every configured server, which means
 * STARTING it — a `docker run` or a `uvx` server that has to fetch before it
 * can answer takes tens of seconds, and an unreachable HTTP one is only known
 * to be unreachable once its own connect times out. Observed on 2.1.220: a
 * warm 11-server folder took ~9s; a cold one is far slower, and 20s here
 * reported "claude did not answer" for a listing that was merely starting up.
 *
 * 45s was the same mistake one size up, and it is what "the MCP server list
 * very often does not work" turned out to be. Re-measured 2026-08-18 on the
 * author's own machine against their real 11-server configuration: **18.4s
 * WARM** — with a single unreachable HTTP server (`n8n`) spending 5s of that
 * on its own probe timeout before reporting `Failed to connect`. A warm read
 * eating 40% of the budget leaves a cold one — the `docker run` server pulling
 * its image, `npx @playwright/mcp@latest` fetching the package, four remote
 * HTTP servers dialled in sequence — no headroom at all, and the deadline is
 * indistinguishable downstream from a CLI that refused to answer: `runCommand`
 * returns null either way, so the panel discards the whole listing and states
 * {@link CLAUDE_MCP_LIST_FAILED_MESSAGE} about a command that was working.
 *
 * The ceiling this used to be bounded by no longer applies to the read the
 * user is actually watching. The panel's listing is NON-BLOCKING — the service
 * answers it inside a 400ms first-paint budget with `pending: true` and lets
 * the dial finish behind the response — so no HTTP request is held for this
 * duration and no client timeout can arrive in front of it. The one path that
 * still awaits a listing inside a request is the toggle, and the SERVICE caps
 * that one itself (`BLOCKING_LIST_TIMEOUT_MS` in `agent-mcp.service.ts`),
 * which is where a request budget belongs: it is a fact about the HTTP round
 * trip, not about this CLI.
 */
export const CLAUDE_MCP_LIST_TIMEOUT_MS = 120_000;

/**
 * Row status markers — the WORDING only, deliberately WITHOUT the glyph that
 * precedes it.
 *
 * The glyph is not stable. The same 2.1.220 binary printed U+00D7 MULTIPLICATION
 * SIGN for a failure when driven one way and U+2718 HEAVY BALLOT X when driven
 * another (observed in this container: a daemon spawned under Electron's node
 * gave `×`, the same daemon under host node gave `✘` for the identical
 * server). The CLI evidently picks its decoration from the environment, so
 * pinning one glyph silently downgraded every failed row to `status: 'unknown'`
 * — the row still listed, with its reason intact, but wearing the wrong badge.
 *
 * The wording has held across every observation. Matching it and letting the
 * walk-back in `parseMcpList` discard whatever decoration precedes it is both
 * more robust and less of a guess than enumerating glyphs we have not seen.
 */
export const CLAUDE_MCP_CONNECTED_MARKER = 'Connected';
export const CLAUDE_MCP_FAILED_MARKER = 'Failed to connect';
export const CLAUDE_MCP_PENDING_MARKER = 'Pending approval';

/**
 * An OAuth server the CLI holds no credentials for. Probe-verified on 2.1.223,
 * driven live against a `mcp add --transport http` server in a throwaway folder:
 *
 *     probe-linear: https://mcp.linear.app/mcp (HTTP) - ! Needs authentication
 *
 * `claude mcp get` prints the same wording as its `Status:`. The glyph is `!`
 * and is excluded for the same reason the other three are — see the block above.
 *
 * Its absence was a live defect, not a gap: the row parsed, matched no marker,
 * and came out `status: 'unknown'` with the wording as its detail — which the
 * panel then did not render at all, since it shows a detail only for `failed`.
 * A server one command away from working therefore appeared as a row with an
 * unexplained badge and nothing to do about it.
 */
export const CLAUDE_MCP_NEEDS_AUTH_MARKER = 'Needs authentication';

/**
 * The CLI's own record of servers that answered a dial with 401, in the
 * profile root (`CLAUDE_CONFIG_DIR`, else `~/.claude`):
 * `{"<server>": {"timestamp": <ms>, "id"?: "<claude.ai server id>", "ttlMs"?: <ms>}}`.
 *
 * Read out of the 2.1.295 bundle and confirmed on a real profile. At session
 * start a claude.ai connector with an entry younger than `ttlMs ?? 4h` (15 min
 * for other remote servers) gets an auth stub and is NEVER dialled. Any 401 —
 * a session's dial, `claude mcp get`, `claude mcp list` — writes an entry; only
 * a session's own successful connect, or `claude mcp login`, deletes one. So
 * a server signed in to in the browser stays withheld from every new session
 * until the entry expires, while `mcp get` reports it Connected. No flag or env
 * var skips the record. `claude mcp login` deletes the entry and exits before
 * the user has authorized, and a re-check polled during the browser flow
 * writes it back. Each process also keeps its first read of the file and
 * rewrites that whole copy on its next write, so a session or terminal that
 * read it before geniro cleared an entry can put the entry back; geniro
 * clears it again whenever a later dial sees the server connected.
 *
 * RE-CHECK IF: the file moves or is renamed, its value shape changes, or a
 * successful `mcp get` / `mcp list` starts deleting the entry itself.
 */
export const CLAUDE_MCP_NEEDS_AUTH_CACHE_FILE = 'mcp-needs-auth-cache.json';

/**
 * Argv that signs the CLI in to one server, with the server name appended.
 *
 * Named rather than written inline because it has the second reader that earns
 * a name: `getConfig()` spells it, and the adapter's spec asserts on it.
 */
/**
 * Argv for the ONE-server health probe, and the label its status line carries.
 *
 * `claude mcp get <name>` — and this is a health probe by the CLI's own account,
 * not by inference: `claude mcp get --help` says "Unapproved .mcp.json servers
 * are shown as ⏸ Pending approval and not connected to; approved servers are
 * health-checked."
 *
 * Captured on 2.1.228, with the timings that make it worth having — one server
 * against a folder listing that takes 45s worth of budget for all of them:
 *
 * ```
 * $ claude mcp get codegraph                       # exit 0, 1.56s
 * codegraph:
 *   Scope: User config (available in all your projects)
 *   Status: ✔ Connected
 *   Type: stdio
 *
 * $ claude mcp get ticktick                        # exit 0, 8.10s
 *   Status: ! Connected · tools fetch failed
 *
 * $ claude mcp get telegram                        # exit 1
 * No MCP server named "telegram". Configured servers: …
 * ```
 *
 * The status WORDING is the same vocabulary `mcp list` prints, which is why
 * `parseMcpGetHealth` shares this CLI's existing markers instead of adding a
 * second set — see that function.
 *
 * RE-CHECK IF: `mcp get` stops printing a `Status:` line, or starts reporting a
 * state `mcp list` never produces.
 */
export const CLAUDE_MCP_GET_ARGS: readonly string[] = ['mcp', 'get'];
export const CLAUDE_MCP_GET_STATUS_LABEL = 'Status:';

/**
 * Deadline for that probe. One server, so it is bounded by one connect timeout
 * rather than the slowest of forty-five — but a server whose tools fetch hangs
 * still spends its own (8.1s measured), so this keeps real headroom while
 * staying well under the listing's budget.
 */
export const CLAUDE_MCP_GET_TIMEOUT_MS = 20_000;

/**
 * `claude mcp add`, at USER scope — the profile's own `mcpServers` in its
 * `.claude.json`, which is where the "Add MCP" button puts a server (the
 * default scope is `local`, which keys it to whatever folder the command ran
 * in). PROBED on 2.1.284 against a throwaway `CLAUDE_CONFIG_DIR`:
 *
 *   claude mcp add -s user -e A=1 -e B=two -- geniro-probe echo -n hi
 *     → mcpServers["geniro-probe"] = {type:"stdio", command:"echo",
 *       args:["-n","hi"], env:{A:"1",B:"two"}}, exit 0
 *   claude mcp add -s user -t http -H "X-Api-Key: v" -- geniro-http https://…
 *     → {type:"http", url, headers:{"X-Api-Key":"v"}}, exit 0
 *   the same name again → "MCP server geniro-probe already exists in user
 *     config", exit 1
 *
 * and `claude mcp list` under that profile then listed both. Every option goes
 * BEFORE `--` and the name after it: `-e`/`-H` are variadic, so a name written
 * after one would be swallowed as another value, while after `--` commander
 * reads the rest as positionals (name, command-or-url, args) whatever they
 * start with.
 *
 * RE-CHECK IF: a scope stops being `user`, or `-e`/`-H` stop being variadic.
 */
export const CLAUDE_MCP_ADD_ARGS: readonly string[] = [
  'mcp',
  'add',
  '-s',
  'user',
];
export const CLAUDE_MCP_ADD_TRANSPORT_FLAG = '-t';
export const CLAUDE_MCP_ADD_ENV_FLAG = '-e';
export const CLAUDE_MCP_ADD_HEADER_FLAG = '-H';
/** Writes one file and dials nothing — measured well under a second. */
export const CLAUDE_MCP_ADD_TIMEOUT_MS = 20_000;

export const CLAUDE_MCP_LOGIN_ARGS: readonly string[] = ['mcp', 'login'];

/**
 * What this CLI says when a server sign-in did not complete — see
 * `AdapterConfig.mcp.loginFailureMarkers` for why the verdict has to be read
 * out of the words rather than off an exit status.
 *
 * Observed verbatim on 2.1.232: `Couldn't complete authentication for
 * "probe": stdin isn't a terminal…`. The apostrophe is left out of the marker
 * on purpose — this CLI writes typographic punctuation elsewhere, and a marker
 * carrying one would stop matching the day the line is re-quoted.
 */
export const CLAUDE_MCP_LOGIN_FAILURE_MARKERS: readonly string[] = [
  'complete authentication for',
];

/**
 * Argv that signs the CLI ITSELF in — the account, not one of its MCP servers.
 *
 * `claude auth login` ("Sign in to your Anthropic account"), read from the
 * binary's own `claude auth --help` on 2.1.227. Distinct from
 * {@link CLAUDE_MCP_LOGIN_ARGS} above and reached by a different failure: a
 * turn that ended in "OAuth session expired and could not be refreshed" needs
 * THIS one, and `mcp login` would send the user to a command that cannot fix
 * what they hit.
 *
 * Named for the same reason as its MCP sibling: `getConfig()` spells it and the
 * adapter's spec asserts on it.
 */
export const CLAUDE_AUTH_LOGIN_ARGS: readonly string[] = ['auth', 'login'];

/**
 * Argv that signs the CLI ITSELF out — the counterpart to
 * {@link CLAUDE_AUTH_LOGIN_ARGS}.
 *
 * `claude auth logout` ("Log out from your Anthropic account"), read from
 * `claude auth --help` on 2.1.227. It exists so the Settings card can offer the
 * action that matches the state it is reporting: a CLI the probe found SIGNED
 * IN has nothing to sign in to, and offering it anyway reads as an unfinished
 * setup step.
 *
 * Named for the same reason as its login sibling: `getConfig()` spells it and
 * the adapter's spec asserts on it.
 */
export const CLAUDE_AUTH_LOGOUT_ARGS: readonly string[] = ['auth', 'logout'];

/**
 * Output that means `claude auth login` has reached the point where a pasted
 * code would be accepted.
 *
 * Named rather than inline because it has the second reader that earns a name:
 * `getConfig()` spells it and the adapter's spec asserts on it. Matched
 * case-insensitively and as a SUBSTRING, so the trailing `>` and any
 * re-punctuation of the sentence do not break it — the words are the stable part.
 */
export const CLAUDE_LOGIN_CODE_PROMPT_MARKERS: readonly string[] = [
  'paste code here',
];

/**
 * Wording that marks a turn as having failed on the ACCOUNT, not on the work.
 *
 * Observed verbatim in a failed run's own error row:
 *
 * ```
 * Failed to authenticate: OAuth session expired and could not be refreshed
 * ```
 *
 * The matching half of that sentence only. An earlier revision also carried the
 * bare prefix `'Failed to authenticate'`, which reads as the more robust choice
 * and is the opposite: the CLI uses that same prefix for an MCP SERVER it could
 * not authenticate, and the row would then offer `claude auth login` for a
 * failure only `claude mcp login <server>` can fix — the precise misdirection
 * {@link AdapterConfig.auth} warns about, since a wrong cure is worse than none.
 *
 * A list rather than one string because the account can fail in more than one
 * way (a revoked token, a missing key), but each entry must be specific to the
 * ACCOUNT. Add one only from a real failed turn, never from the CLI's `--help`.
 */
export const CLAUDE_AUTH_EXPIRED_MARKERS: readonly string[] = [
  'OAuth session expired',
  /*
   * The other half, and the commoner one: a profile that is not signed in at
   * all, rather than one whose session lapsed. Observed verbatim on 2.1.232 as
   * a run's whole error row, by pointing a chat at an empty `configDir`:
   *
   * ```
   * Not logged in · Please run /login
   * ```
   *
   * The run settled `failed` correctly and offered no cure, which is the case
   * a Sign-in control exists for — it is exactly reachable by mistyping a
   * config directory, since the CLI creates whatever path it is handed rather
   * than refusing an unknown one.
   *
   * `Please run /login` and not the bare `Not logged in`, for the reason the
   * entry above records: `/login` is the CLI's own command for the ACCOUNT,
   * while "not logged in" is wording that could equally describe an MCP server
   * — and pointing the user at `claude auth login` for a server only
   * `claude mcp login <server>` can fix is the misdirection this list must
   * never introduce.
   */
  'Please run /login',
  /*
   * The same failure as the entry above, in the wording a HEADLESS turn gets —
   * which is every turn geniro runs. REPORTED as a chat where every message
   * failed while Settings read "signed in", cured only by signing out and in:
   *
   * ```
   * Failed to authenticate. API Error: 401 OAuth access token has expired.
   * Re-authenticate to continue.
   * ```
   *
   * Read out of the shipped 2.1.270 bundle rather than guessed at: a 401/403
   * from the MODEL API, on a first-party account, is reported as
   * `error:"authentication_failed"` with the content
   * `` Ae() ? `Failed to authenticate. ${tl}: ${C}` : `Please run /login · ${tl}: ${C}` ``,
   * where `tl` is `"API Error"` and `Ae()` is the non-interactive check. So a
   * `-p` turn never carries the `/login` wording and the row offered Retry
   * alone — against a token that no retry could revive. `auth status` cannot
   * catch it either: it reports the credentials it HOLDS (`loggedIn: true`),
   * not whether the server still accepts them.
   *
   * With `API Error` and not the bare `Failed to authenticate`, for the entry
   * above's reason: the bare prefix is also how an MCP SERVER's failure reads,
   * and `claude auth login` is not that failure's cure. `API Error` is the
   * CLI's own label for the model endpoint and nothing else.
   */
  'Failed to authenticate. API Error',
];

/** Separates `Failed to connect` from the reason (U+2014 EM DASH). */
export const CLAUDE_MCP_DETAIL_SEPARATOR = '—';

/**
 * Shown to the user when the listing command could not be run at all — a
 * missing binary, a non-zero exit, or the deadline. Deliberately distinct from
 * an empty listing: only one of the two is a fact about their configuration.
 */
export const CLAUDE_MCP_LIST_FAILED_MESSAGE =
  'could not read MCP servers — claude did not answer';

/**
 * Printed INSTEAD of any rows when the folder has none. It is the only thing
 * that tells an empty folder apart from output this parser could not read at
 * all — without it, a release that reworded the row format would drop every
 * row and be indistinguishable from "you have no servers configured".
 */
export const CLAUDE_MCP_EMPTY_MARKER = 'No MCP servers configured';

/** Shown when the CLI answered but nothing in its output looked like a row. */
export const CLAUDE_MCP_LIST_UNREADABLE_MESSAGE =
  'could not read MCP servers — the claude output format may have changed';

// ── Context compaction ────────────────────────────────────────────────────

/**
 * The `system` subtype announcing that the CLI compacted the conversation.
 *
 * It marks the START of the new, compacted segment, so by the time it arrives
 * the work is finished — it is the FINISHED end of the compaction, and it
 * carries the token counts (`compact_metadata`).
 *
 * This block used to say a live "compacting…" state was unobtainable from the
 * headless stream, on 2.1.226 binary evidence that the TUI's internal
 * `compact_start` / `compact_progress` / `compact_end` events are never
 * serialized. That is still true of those three events, and STILL no reason to
 * infer a label from a timer or a silence heuristic — but it is no longer the
 * whole picture: 2.1.227 serializes a plain status line instead. See
 * {@link CLAUDE_COMPACTING_STATUS}.
 */
export const CLAUDE_COMPACT_BOUNDARY_SUBTYPE = 'compact_boundary';

/**
 * The `system` subtype carrying a coarse turn status, of which compaction is
 * the one this daemon reads.
 *
 * Probed on 2.1.227 by driving ONE persistent
 * `-p --output-format stream-json --input-format stream-json` process — the
 * same shape `AgentSessionRegistry` keeps between turns — for 8 turns and then
 * sending `/compact` on its still-open stdin:
 *
 * ```
 * {"type":"system","subtype":"status","status":"compacting","session_id":…}
 * {"type":"system","subtype":"status","status":null,"compact_result":"success"}
 * {"type":"system","subtype":"compact_boundary","compact_metadata":{…,"duration_ms":46594}}
 * ```
 *
 * A FAILED compaction replaces the second line's result with
 * `"compact_result":"failed","compact_error":"Not enough messages to compact."`.
 *
 * Note for anyone re-probing: a ONE-SHOT `claude -p --resume <id> "/compact"`
 * can never succeed — measured refusing at 2 turns, at 10 turns, and on a
 * single 117 000-character turn, always "Not enough messages to compact.". Only
 * the persistent-stdin session compacts, so the one-shot form makes a working
 * feature look broken.
 */
export const CLAUDE_STATUS_SUBTYPE = 'status';

/** The {@link CLAUDE_STATUS_SUBTYPE} value meaning "compacting right now". */
export const CLAUDE_COMPACTING_STATUS = 'compacting';

/** The terminating status line's `compact_result` value meaning it did not happen. */
export const CLAUDE_COMPACT_RESULT_FAILED = 'failed';

/**
 * Said out loud when a compaction the user asked for did not happen. The CLI
 * reports the reason on the same line (`compact_error`), and without this the
 * turn simply carries on at full context with nothing on screen — the user
 * waited for a compaction that silently never occurred.
 */
export const CLAUDE_COMPACT_FAILED_NOTICE =
  'the conversation was not compacted';

// ── Background tasks (delegates that outlive the turn) ────────────────────

/**
 * The `system` subtypes bracketing one background task's life.
 *
 * Probed on 2.1.231 against a turn told to launch a delegate and NOT wait for
 * it (`-p --output-format stream-json --verbose`). One task produces:
 *
 * ```
 * {"type":"system","subtype":"task_started","task_id":"ad83f0a35d8a3dfc9",…}
 * {"type":"system","subtype":"task_progress","task_id":"ad83f0a35d8a3dfc9",…}
 * {"type":"system","subtype":"task_updated","task_id":"…","patch":{"status":"completed",…}}
 * {"type":"system","subtype":"task_notification","task_id":"…","status":"completed",…}
 * ```
 *
 * Why the turn has to care: the SAME probe printed TWO `result` lines. The
 * first is the answer to the user's prompt (`result:"LAUNCHED"`, `num_turns:2`);
 * the second is a turn claude ran ON ITS OWN because a task reported, and it
 * says so — `origin:{kind:"task-notification"}`. So a `result` is the end of
 * what the agent was SAYING, never of what the process is DOING, and a turn
 * settled on it hands the rest to nobody. See `AgentEvent`'s `background_work`
 * for the measured cost of that.
 *
 * Both terminal channels are mapped rather than the tidier one alone: they
 * carry the status in DIFFERENT places (`patch.status` vs `status`) and report
 * different vocabularies for one outcome (`killed` vs `stopped` for the same
 * task, measured in one run), so reading either alone means trusting one
 * spelling of a fact the CLI states twice. The event is keyed by task id and
 * idempotent, so mapping both costs nothing.
 */
export const CLAUDE_TASK_STARTED_SUBTYPE = 'task_started';

/**
 * The `origin.kind` a `result` line carries when it ends a turn the CLI ran by
 * itself because background work reported back — never on a turn answering a
 * prompt geniro wrote. Probed on 2.1.266: `{"type":"result",…,
 * "origin":{"kind":"task-notification"},"result":"Background task completed…"}`,
 * followed by an origin-less result answering the message sent during it.
 *
 * Read on FAILED results too: 2.1.280's query loop builds every result variant
 * (`success`, `error_during_execution`, `error_max_turns`,
 * `error_max_budget_usd`) from one common block that carries `origin`.
 */
export const CLAUDE_CONTINUATION_ORIGIN_KIND = 'task-notification';

/**
 * The line type claude writes when it WITHDRAWS a control request it sent —
 * read out of the 2.1.280 bundle's own schema: `{type:"control_cancel_request",
 * request_id}`, "Tells the other side that the sender no longer needs the
 * answer to one of its own in-flight control_requests". It is written when a
 * `can_use_tool` request's abort fires (the turn it belonged to was torn down,
 * or the tool call it gated was abandoned), so the permission or question card
 * geniro drew for it can no longer be answered into anything.
 */
export const CLAUDE_CONTROL_CANCEL_REQUEST_TYPE = 'control_cancel_request';
/** @see CLAUDE_TASK_STARTED_SUBTYPE */
export const CLAUDE_TASK_UPDATED_SUBTYPE = 'task_updated';
/** @see CLAUDE_TASK_STARTED_SUBTYPE */
export const CLAUDE_TASK_NOTIFICATION_SUBTYPE = 'task_notification';

/** Persisted session-task provenance, measured on Claude Code 2.1.295. */
export const CLAUDE_PERSISTED_TASK_ORIGIN_KIND = 'task-notification';
export const CLAUDE_PERSISTED_TASK_PRODUCER = 'session-task';
export const CLAUDE_PERSISTED_TASK_PROMPT_SOURCE = 'system';
export const CLAUDE_PERSISTED_TASK_TOOL_ID =
  /<tool-use-id>([^<>]+)<\/tool-use-id>/g;
export const CLAUDE_PERSISTED_TASK_ID = /<task-id>([^<>]+)<\/task-id>/g;
export const CLAUDE_PERSISTED_TASK_STATUS = /<status>([^<>]+)<\/status>/g;
export const CLAUDE_PERSISTED_DELEGATE_COMPLETED = 'completed';

/**
 * `system/session_state_changed` — `state: 'idle' | 'running' |
 * 'requires_action'`. The bundle's own schema describes `idle` as firing "after
 * heldBackResult flushes and the bg-agent do-while exits — authoritative
 * turn-over signal", and a probe on 2.1.270 agreed: a turn that launched a
 * background delegate printed its `result` at 6.9s with NO `idle`; the
 * delegate's `task_notification` came at 14.9s, the continuation's own result
 * at 18.8s, and `idle` only then. Emitted only under
 * {@link CLAUDE_SESSION_STATE_EVENTS_ENV}.
 */
export const CLAUDE_SESSION_STATE_SUBTYPE = 'session_state_changed';
/** @see CLAUDE_SESSION_STATE_SUBTYPE */
export const CLAUDE_SESSION_IDLE_STATE = 'idle';

/**
 * This CLI's `task_type` for a unit of background work that IS a delegate.
 *
 * Named because the mapper and its spec both spell it, and because the
 * distinction is the whole point: probed 2026-08-17 on 2.1.232, one Task call
 * produced a `task_started` with `task_type:'local_agent'` (the delegate) and a
 * second with `task_type:'local_bash'` and `owned_by_subagent:true` (the shell
 * command that delegate then ran). Both are background work the turn must
 * outlive; only the first is a sub-agent anything should count or draw.
 */
export const CLAUDE_TASK_TYPE_AGENT = 'local_agent';

// ── Dynamic workflows (one tool call, a fleet of agents) ──────────────────

/**
 * The `system` subtype carrying a background unit's LIVE state, and the two
 * values that say the unit is a dynamic workflow rather than a delegate.
 *
 * `task_progress` is shared: a delegate's progress line names its
 * `subagent_type` and carries no roster, while a workflow's carries
 * `workflow_progress` — which is the discriminator the mapper uses, since
 * nothing else on the line says which kind of work it describes.
 *
 * Probed live on 2.1.251 (`-p --output-format stream-json --verbose`, a
 * two-agent script). One workflow produced, in order:
 *
 * ```
 * {"type":"system","subtype":"task_started","task_id":"w23o3h707",
 *  "tool_use_id":"toolu_01F7…","task_type":"local_workflow",
 *  "workflow_name":"probe-run","description":"Two trivial agents…","prompt":"<script>"}
 * {"type":"system","subtype":"task_progress","task_id":"w23o3h707",
 *  "tool_use_id":"toolu_01F7…","description":"Probe: probe-1",
 *  "usage":{"total_tokens":0,"tool_uses":0,"duration_ms":19},
 *  "last_tool_name":"probe-1","summary":"Two trivial agents…",
 *  "workflow_progress":[{"type":"workflow_phase","index":1,"title":"Probe"},
 *    {"type":"workflow_agent","index":1,"label":"probe-1","phaseIndex":1,
 *     "phaseTitle":"Probe","agentId":"a8e7…","model":"claude-haiku-4-5-20251001",
 *     "state":"start","startedAt":1788074260283,"attempt":1,
 *     "promptPreview":"Reply with exactly…","lastProgressAt":1788074260283}]}
 * …
 * {"type":"system","subtype":"task_progress", … "usage":{"total_tokens":27559,…},
 *  "workflow_progress":[…,{"…","state":"done","tokens":13780,"toolCalls":0,
 *     "durationMs":1560,"resultPreview":"ok2"}]}
 * {"type":"system","subtype":"task_updated","patch":{"status":"completed",…}}
 * {"type":"system","subtype":"task_notification","status":"completed",
 *  "usage":{"total_tokens":27559,"tool_uses":0,"duration_ms":2432}}
 * ```
 *
 * Two facts from that capture the mapper depends on. `usage.total_tokens` is
 * the sum over the ROSTER (13779 + 13780 = 27559), not the turn's spend — so it
 * is the workflow's own bill and nothing else's. And a roster only rides a line
 * when an agent CHANGED STATE, or at most every ten seconds otherwise; since an
 * agent's tokens are reported as it finishes, every line that moves the totals
 * carries the roster with it, which is what makes "persist the lines that carry
 * a roster" lossless rather than a sampling.
 */
export const CLAUDE_TASK_PROGRESS_SUBTYPE = 'task_progress';
/** @see CLAUDE_TASK_PROGRESS_SUBTYPE */
export const CLAUDE_TASK_TYPE_WORKFLOW = 'local_workflow';
/** @see CLAUDE_TASK_PROGRESS_SUBTYPE */
export const CLAUDE_WORKFLOW_AGENT_ENTRY = 'workflow_agent';

/**
 * This CLI's four agent states, in the app's own three-word vocabulary.
 *
 * A map rather than a set for {@link CLAUDE_TASK_TERMINAL_STATUSES}' reason:
 * the vendor's spelling is translated once, here, so no consumer downstream
 * learns that `start` and `progress` are the same thing to a reader. Anything
 * unrecognised reads as `running` — an agent the roster still lists has not
 * been said to be finished, and guessing `done` would show a workflow as
 * complete while it works.
 */
export const CLAUDE_WORKFLOW_AGENT_STATES: ReadonlyMap<
  string,
  WorkflowAgentState
> = new Map([
  ['start', 'running'],
  ['progress', 'running'],
  ['done', 'done'],
  ['error', 'failed'],
]);

/**
 * Task statuses meaning the work is OVER, each mapped to WHAT that ending was.
 *
 * An allowlist, not a "not running" test, and the direction matters: an
 * unrecognised status leaves the task open, so a vocabulary this list has not
 * caught up with delays a settle (bounded by the turn's silence deadline) rather
 * than declaring finished work that is still running — which is the defect the
 * whole mechanism exists to remove. Observed on 2.1.231: `completed`, `killed`
 * (as `task_updated.patch.status`) and `completed`, `stopped` (as
 * `task_notification.status`) for the same two tasks; the rest are the shapes
 * the same field takes elsewhere in the CLI's own vocabulary.
 *
 * The VALUE half is why this is a map and not a set: the two terminal channels
 * spell one outcome two ways (`killed` here, `stopped` there, for the same task
 * in one run), so translating to {@link BackgroundUnitOutcome} at the read site
 * is what keeps a vendor's vocabulary out of every consumer downstream.
 */
export const CLAUDE_TASK_TERMINAL_STATUSES: ReadonlyMap<
  string,
  BackgroundUnitOutcome
> = new Map([
  ['completed', 'completed'],
  ['stopped', 'stopped'],
  ['killed', 'stopped'],
  ['cancelled', 'stopped'],
  ['canceled', 'stopped'],
  ['failed', 'failed'],
  ['error', 'failed'],
  ['timeout', 'failed'],
]);

/**
 * The `terminal_reason` values that mean the turn was STOPPED, not that it
 * failed — this CLI's own abort family.
 *
 * Read off the 2.1.235 binary rather than guessed. It carries two predicates
 * over `terminal_reason`: one that answers exactly `aborted_streaming ||
 * aborted_tools`, and a second listing the reasons it calls errors
 * (`blocking_limit`, `prompt_too_long`, `api_error`, `budget_exhausted`, …)
 * with both abort values explicitly returning FALSE from it. Its own SDK
 * consumer then acts on that split: a `result` whose `terminal_reason` is in
 * this family is logged at ordinary level rather than as an error, is skipped
 * by the degraded-turn error render, and is re-labelled `terminated` in
 * telemetry — all while the same line still carries `is_error: true`.
 *
 * That flag is why this list exists. geniro reads `is_error` and had no way to
 * tell the two apart, so an interrupted turn arrived as
 * `claude run failed (aborted_streaming)` in the red panel — the reported
 * error, which is a sentence naming neither what happened nor what to do about
 * it. The turn is still recorded as failed (nobody asked for it to stop, and a
 * run that quietly read `completed` would be the worse lie); what changes is
 * that the row now says the stream was interrupted and the conversation
 * survives it.
 *
 * NOT a cause list. `aborted_streaming` is emitted whenever the turn's abort
 * signal fires mid-stream, and the reasons the binary attaches to that signal
 * are `user-cancel` / `remote-cancel` / `shutdown` / `interrupt` / `background`
 * / `recovery-timeout` / a turn teardown — so the row must not name one of
 * them. Two candidates were ruled out by probe rather than by reading: a
 * geniro follow-up written into a live turn does NOT abort it (measured on
 * 2.1.235 — a second `{"type":"user"}` line at 8s of a 132s turn left it
 * finishing `terminal_reason: completed`, the follow-up simply opening its own
 * turn afterwards), and a Stop from geniro kills the process instead, settling
 * through `settleFromTermination` without a `result` line at all.
 */
export const CLAUDE_ABORTED_TERMINAL_REASONS: ReadonlySet<string> = new Set([
  'aborted_streaming',
  'aborted_tools',
]);

// ── Messages ──────────────────────────────────────────────────────────────

/** Fallback for an error `result` line that carries no text of its own. */
export const CLAUDE_RUN_FAILED_MESSAGE = 'claude run failed';

/**
 * What an {@link CLAUDE_ABORTED_TERMINAL_REASONS} turn says instead, when the
 * CLI supplied no sentence of its own.
 *
 * The code itself is not dropped — it rides on the error's `detail.code` and
 * shows in the row's facts table — so nothing a bug report needs is lost by
 * putting a sentence where the raw value used to be.
 */
export const CLAUDE_TURN_ABORTED_MESSAGE =
  'claude stopped this turn before it finished — the stream was interrupted rather than refused. The conversation is intact: send the message again to carry on.';

/** What the CLI is told when the user denies a permission request. */
export const CLAUDE_DENY_MESSAGE = 'Denied by the user in Geniro';

// ── Remembered approvals ──────────────────────────────────────────────────────
//
// A `can_use_tool` request carries `permission_suggestions`: the permission
// updates claude's own terminal offers as "Yes, and don't ask again …". An
// allow answer that echoes them as `updatedPermissions` applies them. MEASURED
// on 2.1.295 (2026-10-21), `claude -p --permission-prompt-tool stdio`, one
// process asked twice to run `touch probe-marker.txt`:
//
// - The request carried three suggestions: `addRules` (`Bash(touch …)`,
//   `destination: "localSettings"`), `addDirectories` (the cwd, `"session"`)
//   and `setMode` (`acceptEdits`, `"session"`).
// - A plain allow asked twice.
// - The rules and directories with `destination` rewritten to `"session"`
//   asked ONCE, and wrote no file.
// - The same two as given asked once and wrote `.claude/settings.local.json`
//   in the cwd (`{"permissions":{"allow":["Bash(touch probe-marker.txt)"]}}`) —
//   claude's own "always", kept in the project past the conversation.
//
// `setMode` is never echoed. It moves the whole session to another permission
// mode behind geniro's back, so the chat's approval chip would say "ask" while
// the CLI stopped asking about every edit — not an answer about THIS tool.

/** The suggestion kinds an option may carry back (see the block above). */
export const CLAUDE_REMEMBERED_SUGGESTION_TYPES: ReadonlySet<string> = new Set([
  'addRules',
  'addDirectories',
]);

/** The `destination` that keeps a permission update for the session only. */
export const CLAUDE_SESSION_PERMISSION_DESTINATION = 'session';

/** The card option ids of claude's two remembered answers. */
export const CLAUDE_APPROVAL_OPTION_IDS = {
  session: 'session',
  always: 'always',
} as const;

/**
 * How the CLI reports that its own permission channel died under it.
 *
 * The failing tool comes back with `Tool permission request failed:
 * AbortError: Stream closed` as its RESULT TEXT — an ordinary tool result, not
 * an error line — which is why nothing in the daemon reacted to it and why 239
 * of them accumulated unremarked in one database.
 *
 * BOTH halves must be present, and only the stable halves are named: the
 * middle varies (the CLI's own issue tracker carries `Error: Stream closed`
 * beside `AbortError: Stream closed`), while the prefix and the closed stream
 * do not. Matching claude's own wording rather than anything stream-shaped is
 * why this is a marker in claude's constants and not a regex somewhere generic.
 */
export const CLAUDE_PERMISSION_CHANNEL_FAILURE_MARKERS: readonly string[] = [
  'Tool permission request failed',
  'Stream closed',
];

/** The `system` item a user sees when the channel above has dropped. */
export const CLAUDE_PERMISSION_CHANNEL_FAILURE_NOTICE =
  'claude could not reach its permission channel for that tool call, so the CLI refused it — this was not your decision, and the turn continues.';

// ── The agent's OWN task list (the todo tools) ─────────────────────────────
//
// NOT the background-task subtypes above: those name units of WORK the CLI runs
// (`CLAUDE_TASK_STARTED_SUBTYPE` and friends, which keep a turn open while a
// delegate runs). These are the tools the model calls to keep a checklist for
// itself while it works through a multi-step job — the thing every coding UI
// shows in a panel and geniro showed as an opaque `TaskUpdate` tool row.
//
// MEASURED on the wire, 2026-08-14, claude 2.1.232, one `-p
// --output-format stream-json` turn told to build a three-item list and move two
// of them. What arrived, in order:
//
//   TaskCreate   input  {subject:"Read the file", description:"Read the file",
//                        activeForm:"Reading the file"}
//                result "Task #1 created successfully: Read the file"
//   TaskUpdate   input  {taskId:"1", status:"completed"}
//                result "Updated task #1 status"
//   TaskList     input  {}
//                result "#1 [completed] Read the file\n#2 [in_progress] Edit the
//                        file\n#3 [pending] Run the tests"
//
// The id therefore lives in the RESULT of a create and in the INPUT of an
// update, which is what shapes `claude-tasks.utils.ts`: half of this is read off
// tool results, and that is not a stylistic choice.
//
// What is NOT available, checked so the next reader need not re-check: there is
// no pull channel for the list. The control-request subtypes of the 2.1.232
// binary were enumerated (the same method that found `mcp_status`), and the two
// task-shaped ones answer other questions — `background_tasks` takes a
// `tool_use_id` and replies `{backgrounded}`, `get_plan` returns the plan-mode
// markdown file. There IS a push channel, `system/background_tasks_changed`,
// carrying the full list — but it is emitted onto the CLI's remote-control
// bridge, and the probe above (which created and updated five tasks) produced no
// such line on stdout. So the tool calls are the whole source.
//
// One consequence, measured through the app on the same version: a SUB-AGENT
// keeps no list here. Told explicitly to build one, a delegate searched its own
// toolset three times (`select:TaskCreate,TaskUpdate`, then `select:TodoWrite,…`),
// found nothing, and did the work untracked — the task tools are not part of what
// this CLI hands a delegate. Nothing in the mapping is conditional on that: an
// announcement carries whatever origin the line it arrived on carried, so a
// delegate that DOES keep a list has it attributed to itself (pinned in
// `claude-tasks.utils.spec.ts`, and the renderer routes it in
// `transcript-groups.spec.ts`). It is written down because it leaves that path
// unproven on the wire for this CLI — re-check this, not the code, if a
// delegate's list ever fails to appear.

/**
 * `TaskUpdate` — `{taskId, status?, subject?, activeForm?}`, the one call that
 * MOVES a task, and the only one of the family named here.
 *
 * `TaskCreate` and `TaskList` are recognised by their results instead, so their
 * names have no reader: a claude `tool_result` block carries `tool_use_id` and
 * no tool name, which is why the two regexes below exist at all.
 */
export const CLAUDE_TASK_UPDATE_TOOL = 'TaskUpdate';

/**
 * The `TaskUpdate` status that REMOVES a task. Read out of the 2.1.270 bundle's
 * own input schema — `status: enum(["pending","in_progress","completed",
 * "deleted"]).optional()` — so it is the tool's vocabulary, not a guess.
 */
export const CLAUDE_TASK_DELETED_STATUS = 'deleted';

/**
 * `TodoWrite` — the older single-call form, whose input IS the whole list.
 *
 * Mapped because it is still a live tool in 2.1.232 (present in the binary's own
 * tool allowlists beside the `Task*` family, with a `todo_reminder` mechanism
 * keyed on its name), and which of the two families a session is offered is not
 * ours to decide — this machine's 2.1.232 `system/init` listed
 * `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate` and no `TodoWrite`, on a
 * different account from the one the app runs by default.
 *
 * Its payload shape here is the tool's PUBLISHED schema, not a wire capture:
 * nothing on this machine could be made to call it. That asymmetry is why it is
 * mapped defensively like every other version-volatile payload — a shape that
 * has drifted yields no tasks, never a wrong list — and why the reason is
 * written down instead of the code implying it was seen.
 */
export const CLAUDE_TODO_WRITE_TOOL = 'TodoWrite';

/**
 * A `TaskCreate` result: `Task #1 created successfully: Read the file`.
 *
 * Anchored at both ends because it is matched against the whole result text of
 * a tool call whose NAME is not on the wire — a claude `tool_result` block
 * carries `tool_use_id` and no name — so the sentence is the only thing that
 * identifies it. An unanchored search would let a `Bash` call that printed this
 * line inject a task.
 */
export const CLAUDE_TASK_CREATED_RESULT =
  /^Task #(\d+) created successfully: (.+)$/;

/** One `TaskList` row: `#2 [in_progress] Edit the file`. @see CLAUDE_TASK_CREATED_RESULT */
export const CLAUDE_TASK_LIST_ROW = /^#(\d+) \[([a-z_]+)\] (.+)$/;

// ── How long the prompt cache lives ─────────────────────────────────────────
//
// Every request's `usage.cache_creation` splits the tokens it WROTE to the
// prompt cache by lifetime, and the `result` line repeats the split for the
// turn and per request under `usage.iterations`. Probed on 2.1.295 with
// `-p --output-format stream-json` on a subscription profile:
//
//     "cache_creation":{"ephemeral_1h_input_tokens":19041,
//                       "ephemeral_5m_input_tokens":0}
//
// Every main-thread request across a month of this machine's session files
// wrote the 1h cache (0 tokens to the 5m one); an API-key profile writes the
// 5m cache by default. The lifetime is what decides when the next message
// stops being a cheap cache read and becomes a full re-write of the whole
// conversation — the fact the composer warns about.

/** The `cache_creation` key for tokens written to the one-hour cache. */
export const CLAUDE_CACHE_1H_KEY = 'ephemeral_1h_input_tokens';

/** The `cache_creation` key for tokens written to the five-minute cache. */
export const CLAUDE_CACHE_5M_KEY = 'ephemeral_5m_input_tokens';

/** The provider's lifetime for each of those caches. */
export const CLAUDE_CACHE_1H_TTL_MS = 60 * 60_000;
export const CLAUDE_CACHE_5M_TTL_MS = 5 * 60_000;

// ── Why a subscription writes the five-minute cache ─────────────────────────
//
// A subscription profile writes the hour-long cache — until the account has
// used up its plan and runs on paid EXTRA USAGE. The 2.1.295 bundle's TTL
// choice (`lfe`) answers `{ttl:"5m"}` first thing when
// `currentLimits.isUsingOverage` is true, and `isUsingOverage` is
// `unified-status === "rejected"` with the overage status `allowed` or
// `allowed_warning`. Measured on this machine 2026-10-10: at 19:01:13Z six
// sessions of one profile switched from `ephemeral_1h_input_tokens` to
// `ephemeral_5m_input_tokens` in the same second, and that profile's account
// has overage enabled (`overageStatus: "allowed"`), while a profile whose
// account has it disabled (`org_level_disabled`) kept writing the hour. The
// composer then said the cache had lapsed minutes after a turn, which read as
// a bug because nothing said why.
//
// The CLI states the account's state on stdout as a `rate_limit_event`:
//
//     {"type":"rate_limit_event","rate_limit_info":{"status":"allowed",
//      "rateLimitType":"five_hour","overageStatus":"allowed",
//      "isUsingOverage":false,…},"session_id":"…"}
//
// emitted when the state CHANGES (deduplicated against the last one sent, and
// once early in every process), not on every request — so the adapter keeps
// the last value per session and reads it when the turn's result arrives.

/** The stdout line type carrying the account's usage-limit state. */
export const CLAUDE_RATE_LIMIT_EVENT_TYPE = 'rate_limit_event';

// ── What the window currently HOLDS ─────────────────────────────────────────
//
// The second undocumented control request this adapter drives, found the same
// way as `mcp_status` — by enumerating the shipped binary's subtypes — and then
// probed live on 2.1.232. The CLI's own description of it, lifted from the
// bundle's SDK types, is "Requests a breakdown of current context window usage
// by category": it is the wire behind that CLI's own `/context` screen.
//
//     --> {"type":"control_request","request_id":"…",
//          "request":{"subtype":"get_context_usage"}}
//     <-- {"type":"control_response","response":{"subtype":"success",
//          "request_id":"…","response":{
//            "categories":[{"name":"System prompt","tokens":3386,…},
//                          {"name":"Memory files","tokens":59058,…},
//                          {"name":"MCP tools (deferred)","tokens":273876,
//                           "isDeferred":true,…},
//                          {"name":"Free space","tokens":901402,…}],
//            "totalTokens":98598,"maxTokens":1000000,"model":"claude-opus-5[1m]",
//            "memoryFiles":[{"path":"…/CLAUDE.md","type":"Project","tokens":45947}],
//            "mcpTools":[{"name":"mcp__x__y","serverName":"x","tokens":730,
//                         "isLoaded":false}, …371 rows],
//            "autoCompactThreshold":967000,"isAutoCompactEnabled":true,
//            "skills":{…},"agents":[…],"slashCommands":{…},
//            "messageBreakdown":{…},"apiUsage":{…},"gridRows":[…]}}}
//
// Three measured facts the projection depends on, each of which would be a
// defect to guess at:
//
//  - `isDeferred` rows are OUTSIDE `totalTokens`. Verified by arithmetic on a
//    live reading: the non-deferred, non-free rows sum to exactly 98598, and
//    `Free space` is `maxTokens - totalTokens`. Rendering the deferred MCP row
//    in the same bar would have reported a window nearly four times fuller than
//    it was.
//  - It is answerable at ANY point on the stdin dialogue — before the first
//    prompt, mid-turn, and between turns — which is what lets the readout be a
//    live question rather than a per-turn snapshot.
//  - It is NOT instant, and the reply is large. Measured at 1.2s cold, 1.3s
//    mid-turn, and 2.2s/3.3s for two asked back to back (the CLI serialises
//    them); the reply ran 41–84KB, nearly all of it `gridRows` (TUI squares)
//    and 371 per-tool rows. Both numbers are why this is asked ON DEMAND and
//    never on the turn's critical path, and why the projection drops those two
//    fields at the adapter instead of sending them to a renderer that would
//    hide them.
//
// Same expiry warning as the `mcp_status` block above: an observation of one
// build, not a contract. A renamed subtype or a reshaped reply degrades to "no
// breakdown", which is exactly what a CLI without the channel already shows.

/** The control subtype that reports the context window's category breakdown. */
export const CLAUDE_CONTEXT_USAGE_SUBTYPE = 'get_context_usage';

/**
 * How long one breakdown question waits for its answer.
 *
 * Well clear of the 1.2–3.3s measured above, because the cost of waiting is a
 * readout that opens a moment later while the cost of giving up early is a
 * panel that says the CLI cannot answer when it was about to. Nothing is
 * blocked behind it — no turn, no user input — so the ceiling only needs to be
 * short enough that a CLI which will never answer stops being waited for.
 */
export const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 8_000;

// ── What a model name resolves to (probe block) ──────────────────────────────
//
// PROBED 2026-10-16 on 2.1.295: an `initialize` control request alone on the
// stream-json stdin is answered with every model the profile offers and the id
// each one runs as — `{"value":"haiku","resolvedModel":"claude-haiku-5-5"}`,
// `{"value":"default","resolvedModel":"claude-opus-5-5"}` — and the process
// exits once stdin closes: ~4s (the profile's SessionStart hooks included),
// nothing reaching the API. The account's own extra models are in the same
// list. It carries no window; the window is looked up by the resolved id.

/** The argv of the one-shot `initialize` probe: no turn, no MCP servers. */
export const CLAUDE_MODEL_RESOLUTION_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'stream-json',
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
];

/** The control subtype whose reply lists the models. */
export const CLAUDE_INITIALIZE_SUBTYPE = 'initialize';

/** The `value` the reply files the profile's default model under. */
export const CLAUDE_DEFAULT_MODEL_VALUE = 'default';

/** The probe's request id — one question per process, so a constant. */
export const CLAUDE_MODEL_RESOLUTION_REQUEST_ID = 'geniro-model-resolution';

/** The model segment the answer is filed under in `ModelVocabularyStore`. */
export const CLAUDE_MODEL_RESOLUTION_STORE_MODEL = 'initialize:resolved-models';

/** Hooks run first, so the ceiling is the cold start's, not the reply's. */
export const CLAUDE_MODEL_RESOLUTION_TIMEOUT_MS = 30_000;

/** How long one process trusts an answer before asking the store again. */
export const CLAUDE_MODEL_RESOLUTION_TTL_MS = 10 * 60_000;

/** How long a profile whose probe failed is answered "unknown" without asking. */
export const CLAUDE_MODEL_RESOLUTION_RETRY_AFTER_MS = 5 * 60_000;

// ── The account's plan limits (probe block) ─────────────────────────────────
//
// `get_usage` is the THIRD undocumented control request this adapter drives,
// found the same way as `mcp_status` and `get_context_usage` — by enumerating
// the shipped binary's control subtypes — and probed live on 2.1.234 before
// any prompt had been written, which is what makes it answerable at all here.
//
// Finding the name was not enough, and the binary says so: it also carries
// "get_usage is not supported in this context (onGetUsage callback not
// registered)", so appearing in the subtype list proves only that the name
// exists. The measurement is that a headless `-p --output-format stream-json
// --input-format stream-json` process answered it in under a second, on the
// same stdin dialogue the other two ride.
//
// The reply (trimmed to what is projected):
//
//   {"subscription_type":"max","rate_limits_available":true,
//    "rate_limits":{
//      "five_hour":{"utilization":43,"resets_at":"2026-08-18T11:00:00+00:00",…},
//      "seven_day":{"utilization":30,"resets_at":"2026-08-23T11:00:00+00:00",…},
//      "seven_day_opus":null,"seven_day_sonnet":null, …,
//      "limits":[{"kind":"session","group":"session","percent":43,
//                 "severity":"normal","resets_at":"…","scope":null,
//                 "is_active":true},
//                {"kind":"weekly_all","group":"weekly","percent":30,…},
//                {"kind":"weekly_scoped","group":"weekly","percent":0,
//                 "scope":{"model":{"display_name":"Fable"}},…}]},
//    "session":{…},"behaviors":{"day":{…},"week":{…}}}
//
// Three decisions the projection rests on:
//
//  - `limits[]` is read FIRST, and the named `five_hour`/`seven_day` map is the
//    fallback — because the CLI does not always send the list. Its handler
//    strips `limits` from a reply whose usage data is "seeded" (2.1.284:
//    `if (u !== null && a?.status === "seeded") { let {limits, ...v} = u; … }`),
//    measured as four replies in a row with no `limits` key on one `max`
//    profile, minutes before replies carrying it. Its own `/usage` dialog never
//    reads the list at all: it draws `five_hour`, `seven_day`,
//    `seven_day_sonnet` (on max/team/unnamed plans) and `model_scoped[]`, and
//    the fallback reads exactly those (`namedWindows`). Reading the list alone
//    left such a reply with no windows, and the readout waited out its whole
//    deadline to report a timeout about an agent that had answered at once.
//  - A row whose `kind` is not one this adapter can NAME is dropped rather than
//    labelled from its key. `weekly_scoped` is not a phrase to show anyone, and
//    a wrong label on a limit is worse than one row fewer: the two rows that
//    matter are always present, and a vendor's new window simply does not
//    appear until it is read here on purpose.
//  - `behaviors` (a local-transcript attribution scan the CLI itself marks
//    "Approximate, excludes other devices") and `session` (this process's own
//    cost, which the thread totals already report from durable rows) are both
//    dropped. Neither is what "when am I cut off" asks.
//  - So `behaviors` is never ASKED for either: the question is sent with
//    `skip_behaviors` (`usageRequestLine`). It was sent without it once, and the
//    scan — every transcript the profile touched in seven days, awaited beside
//    the endpoint read — was what the reply waited on. Measured on 2.1.284
//    against a profile holding 1.2GB of them: 1.1–2.9s with the scan, 1ms
//    without, the same `rate_limits` both ways. Under a busy multi-agent run it
//    ran past the timeout below often enough that the panel REPORTED "the agent
//    did not answer the usage request in time" as the usual state of a chat
//    whose context half, asked in the same breath, had answered.
//
// Same expiry warning as the two blocks above: an observation of one build, not
// a contract. A renamed subtype or a reshaped reply degrades to "no reading",
// which is exactly what a CLI without the channel already shows.

/** The control subtype that reports the account's plan rate-limit windows. */
export const CLAUDE_PLAN_LIMITS_SUBTYPE = 'get_usage';

/**
 * How long one plan-limits question waits for its answer.
 *
 * The same ceiling as its context sibling, and for the same reasoning — the
 * measured reply was far quicker (under a second, against 1.2–3.3s there),
 * but the two are asked together on one open of the readout, so a tighter
 * bound here would only ever give up on a CLI the other is still waiting for.
 */
export const CLAUDE_PLAN_LIMITS_TIMEOUT_MS = 8_000;

// ── What a running turn has cost so far ─────────────────────────────────────
//
// The SAME `get_usage` request, read for the half the plan-limits projection
// drops: `session.total_cost_usd`. Read out of the 2.1.280 binary rather than
// assumed, because the claim rests on it:
//
//   return{session:{total_cost_usd:tm(), …}, subscription_type:…, …}
//   function tm(){return n().costLedger.totalCostUSD()}
//
// and `tm()` is the very call every `result` line's `total_cost_usd` is built
// from (nine sites, the success and every error arm alike). So a mid-turn
// reading and the turn's closing line are two readings of ONE accumulator —
// which is what makes "this reading minus the last `result` line's" the part
// of the turn no durable row carries yet, to the cent. The same accumulator is
// what the CLI's own status line prints while a turn runs, so it moves with
// each request rather than at the turn's end.
//
// Two further facts from the same build keep the ask cheap and safe:
//
//  - `get_usage` is in the set of control subtypes the CLI answers WHILE a
//    turn runs (`"get_context_usage","get_usage","mcp_status"`), on the stdin
//    dialogue `CliSession.ask` already rides mid-turn without perturbing the
//    turn (measured there).
//  - It takes `skip_behaviors`, described as skipping a scan that "reads every
//    transcript touched in the last seven days". This reader asks with it set,
//    on the very line the plan-limits reader sends (`usageRequestLine`): a cost
//    figure has no use for that scan and must not pay for it every few seconds.
//
// The plan-limits projection still says `session` is dropped there, and it
// is: that readout reports spend from durable rows. This reader exists for the
// part durable rows cannot have yet.

/**
 * How often, at most, a running turn is asked what it has cost so far.
 *
 * Asked only when the CLI has just produced something (an `assistant` line,
 * which is also when the ledger has moved), never on a bare timer — so an idle
 * process is asked nothing. Fifteen seconds is a figure a card can visibly
 * follow on an hours-long call and still under one ask per request for a turn
 * that is busy. The plan-limit half of the same reply is one the CLI caches for
 * about a minute per profile, so the ask adds at most one such request a
 * minute per process on top of the turn's own.
 */
export const CLAUDE_LIVE_COST_ASK_INTERVAL_MS = 15_000;

/**
 * How long an unanswered cost question blocks the next one.
 *
 * Past this the question is written off and the next line may ask again —
 * without it a reply the CLI never sent (a process that ended, a renamed
 * subtype that answers nothing) would silence the live figure for the rest of
 * the session.
 */
export const CLAUDE_LIVE_COST_REPLY_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// The command list, with the sentences beside it
// ---------------------------------------------------------------------------
//
// `system/init` names every invokable command — and NOTHING else: the field is
// an array of plain strings, so the composer's `/` autocomplete listed 64 rows
// with no description at all. Measured against this daemon's own endpoint on a
// real profile: 67 entries, 3 of them described (the three that happen to be
// scannable files with frontmatter), 64 bare. The reported "Autocomplete
// doesn't show tool descriptions" was pointing at two built-ins, `/compact` and
// `/autocompact`, which exist nowhere on disk to be scanned.
//
// The CLI does have a channel that carries them, and it is a PUSH: ask it to
// reload, and it announces the whole list with each entry's own sentence. Found
// in the shipped 2.1.237 bundle —
//
//   km = () => { …; if (p.outputFormat !== "stream-json") return;
//                AE({type:"system", subtype:"commands_changed",
//                    commands: Nbt(No())}) }
//   function fvm(e) { return {name: …, description: Hbt(e),
//                             argumentHint: …, aliases: …} }
//
// — and then driven live, three times, because the grep only proves the name
// exists (`.claude/rules/agent-adapters.md`):
//
//  1. an ordinary `-p` turn emits NO `commands_changed` at all;
//  2. a stream-json-stdin turn that sends nothing emits none either — so the
//     line is not a startup announcement, it is the reload's answer;
//  3. one `reload_skills` control request produces it: 68 commands, 68 of them
//     described, `/compact` reading "Free up context by summarizing the
//     conversation so far".
//
// It also arrives BEFORE `system/init`, so the probe that reads it settles
// sooner than the one it replaces rather than costing a wait.
//
// Expiry warning, as with every probe block here: an observation of one build,
// not a contract. A renamed subtype degrades to the bare names `init` already
// carried — the autocomplete goes back to what it shows today, never to
// nothing.

/** The control request that makes the CLI re-announce its command list. */
export const CLAUDE_RELOAD_COMMANDS_SUBTYPE = 'reload_skills';

/** The `system` subtype that announcement arrives as. */
export const CLAUDE_COMMANDS_CHANGED_SUBTYPE = 'commands_changed';

/** The array of `{name, description, …}` it carries. */
export const CLAUDE_COMMANDS_CHANGED_KEY = 'commands';

/**
 * The request id the probe's reload rides under.
 *
 * A constant rather than a fresh uuid because nothing correlates on it: the
 * answer arrives as a `system` PUSH, not as the `control_response` addressed to
 * this id, and the probe holds exactly one turn. It is named so the line is
 * recognisable in a stdio log.
 */
export const CLAUDE_RELOAD_COMMANDS_REQUEST_ID = 'geniro-reload-commands';

// ── Model notices ──────────────────────────────────────────────────────────

export const CLAUDE_MODEL_MISMATCH_MESSAGE =
  'Claude reported model %served for this turn; requested %requested.';

/**
 * The tools whose stored result names a DETACHED command, each with the
 * `toolUseResult` key that names it (a session JSONL holds no `system/task_*`
 * frames). Measured across 3,000 sessions on CLI 2.1.29x: 2,077 Bash, 423
 * Monitor. Keyed by tool because `TaskUpdate`, the CLI's own checklist, answers
 * with a `taskId` too.
 */
export const CLAUDE_DETACHED_LAUNCH_KEYS: ReadonlyMap<string, string> = new Map(
  [
    ['Bash', 'backgroundTaskId'],
    ['Monitor', 'taskId'],
  ],
);
