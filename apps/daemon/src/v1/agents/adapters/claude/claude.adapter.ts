import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { lock } from 'proper-lockfile';

import { atomicWrite } from '../../../../utils/atomic-file';
import { AgentKind } from '../../../runs/runs.types';
import { adapterQuestionOf } from '../../utils/card-questions';
import {
  ModelVocabularyCache,
  volatile,
} from '../../utils/model-vocabulary-cache';
import type {
  AdapterConfig,
  AdapterDaemonDeps,
  AdapterQuestion,
  AgentApprovalMode,
  AgentApprovalProbeState,
  AgentAskInput,
  AgentCommandOptions,
  AgentContextUsage,
  AgentEvent,
  AgentMcpConfigDocument,
  AgentMcpConfigWriteInput,
  AgentMcpConfigWriteResult,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpServerAddInput,
  AgentMcpServerHealth,
  AgentMcpServerHealthInput,
  AgentMcpServersInput,
  AgentModel,
  AgentModelParameterListing,
  AgentModelsInput,
  AgentPlanLimits,
  AgentSessionHistory,
  AgentSessionImportInput,
  AgentSessionListing,
  AgentSessionReadInput,
  AgentSessionsInput,
  AgentTitleInput,
  AgentTurnInput,
  ApprovalOption,
  CarrySessionInput,
  CarrySessionResult,
  ConfigDirPin,
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
  FollowUpMessage,
  InstalledApprovalSupport,
  NativeMemoryReading,
  NO_PLAN_LIMITS,
  RecoveredSubagentOutcome,
  SessionPullRequest,
  SessionPullRequestsInput,
  SubagentRecoveryRef,
  ToolCallMetric,
  TurnDriver,
  TurnImage,
} from '../adapter.types';
import { AgentAdapter } from '../agent-adapter';
import { readFileSafe } from '../utils/fs-safe.utils';
import {
  MCP_CONFIG_MOVED_REASON,
  mcpServerExistsReason,
  mcpServersVersion,
  readMcpServersKey,
} from '../utils/mcp-config.utils';
import { readConfigForRewrite } from '../utils/strict-json.utils';
import { titlePrompt } from '../utils/title-prompt.utils';
import {
  CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG,
  CLAUDE_APPEND_SYSTEM_PROMPT_FLAG,
  CLAUDE_ARTIFACT_ENV,
  CLAUDE_ASK_DIR_PREFIX,
  CLAUDE_ASK_TIMEOUT_MS,
  CLAUDE_AUTH_EXPIRED_MARKERS,
  CLAUDE_AUTH_LOGIN_ARGS,
  CLAUDE_AUTH_LOGOUT_ARGS,
  CLAUDE_AUTOCOMPACT_BUFFER_TOKENS,
  CLAUDE_AUTOCOMPACT_FLAG,
  CLAUDE_AUTOCOMPACT_MAX_TOKENS,
  CLAUDE_AUTOCOMPACT_MIN_TOKENS,
  CLAUDE_BASE_ARGS,
  CLAUDE_BROWSER_TOOLS_ENV,
  CLAUDE_BROWSER_TOOLS_OPTION,
  CLAUDE_BUILT_IN_MCP_SERVERS,
  CLAUDE_CONFIG_DIR_ENV,
  CLAUDE_CONFIG_FILE_FALLBACK_MODE,
  CLAUDE_CONFIG_LOCK_RETRIES,
  CLAUDE_CONFIG_LOCK_SUFFIX,
  CLAUDE_CONTEXT_USAGE_TIMEOUT_MS,
  CLAUDE_CONTROL_PROBE_ARGS,
  CLAUDE_CONTROL_REQUEST_ID_PREFIX,
  CLAUDE_COST_TOTALS_FILE,
  CLAUDE_CREDENTIAL_ENV_KEYS,
  CLAUDE_DEFAULT_MODEL_VALUE,
  CLAUDE_DEFAULT_PROFILE_DIR,
  CLAUDE_DENY_MESSAGE,
  CLAUDE_DISABLE_AUTO_MEMORY_ENV,
  CLAUDE_EFFORT_FLAG,
  CLAUDE_EMPTY_MCP_CONFIG,
  CLAUDE_HOME_SETTINGS_FILE,
  CLAUDE_INTERRUPT_SUBTYPE,
  CLAUDE_LOGIN_CODE_PROMPT_MARKERS,
  CLAUDE_MCP_ADD_ARGS,
  CLAUDE_MCP_ADD_ENV_FLAG,
  CLAUDE_MCP_ADD_HEADER_FLAG,
  CLAUDE_MCP_ADD_TIMEOUT_MS,
  CLAUDE_MCP_ADD_TRANSPORT_FLAG,
  CLAUDE_MCP_CONFIG_DIR_NAME,
  CLAUDE_MCP_CONFIG_FLAG,
  CLAUDE_MCP_EMPTY_MARKER,
  CLAUDE_MCP_GET_ARGS,
  CLAUDE_MCP_GET_TIMEOUT_MS,
  CLAUDE_MCP_LIST_ARGS,
  CLAUDE_MCP_LIST_FAILED_MESSAGE,
  CLAUDE_MCP_LIST_TIMEOUT_MS,
  CLAUDE_MCP_LIST_UNREADABLE_MESSAGE,
  CLAUDE_MCP_LOGIN_ARGS,
  CLAUDE_MCP_LOGIN_FAILURE_MARKERS,
  CLAUDE_MCP_NEEDS_AUTH_CACHE_FILE,
  CLAUDE_MCP_SERVERS_KEY,
  CLAUDE_MCP_TOOL_TIMEOUT_ENV,
  CLAUDE_MCP_TOOL_TIMEOUT_MS,
  CLAUDE_MODEL_CACHE_FILE,
  CLAUDE_MODEL_FLAG,
  CLAUDE_MODEL_RESOLUTION_RETRY_AFTER_MS,
  CLAUDE_MODEL_RESOLUTION_STORE_MODEL,
  CLAUDE_MODEL_RESOLUTION_TIMEOUT_MS,
  CLAUDE_MODEL_RESOLUTION_TTL_MS,
  CLAUDE_PARTIAL_MESSAGES_FLAG,
  CLAUDE_PERMISSION_MODE_DEFAULT,
  CLAUDE_PERMISSION_MODE_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
  CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
  CLAUDE_PLAN_LIMITS_TIMEOUT_MS,
  CLAUDE_PROBE_CACHE_FILE,
  CLAUDE_PROBE_DIR_NAME,
  CLAUDE_PROFILE_SETTINGS_FILE,
  CLAUDE_PROJECT_MCP_FILE,
  CLAUDE_PROJECT_SETTINGS_FILES,
  CLAUDE_PROVIDER_ENV_KEYS,
  CLAUDE_QUESTION_TOOL_NAME,
  CLAUDE_READ_ONLY_TOOLS,
  CLAUDE_RELOAD_COMMANDS_REQUEST_ID,
  CLAUDE_RESUME_FLAG,
  CLAUDE_SESSION_STATE_EVENTS_ENV,
  CLAUDE_SET_PERMISSION_MODE_SUBTYPE,
  CLAUDE_SETTINGS_FLAG,
  CLAUDE_SKIP_PERMISSIONS_FLAG,
  CLAUDE_STRICT_MCP_CONFIG_FLAG,
  CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES,
  CLAUDE_TITLE_ARGS,
  CLAUDE_TITLE_DIR_PREFIX,
  CLAUDE_TITLE_MODEL,
  CLAUDE_TITLE_TIMEOUT_MS,
  CLAUDE_TODO_TOOLS_ENV,
  CLAUDE_TOOLS_FLAG,
  CLAUDE_USER_DATA_TMP_DIR_NAME,
} from './claude.const';
import type { ClaudeAdapterOptions, ClaudeModeProbe } from './claude.types';
import {
  CLAUDE_UNPROBED_VERDICT,
  ClaudeProbeService,
  supportFromVerdict,
} from './claude-probe.service';
import { ClaudeTurnDriver } from './claude-turn.driver';
import { reloadCommandsRequestLine } from './utils/claude-commands.utils';
import { readClaudeConfigDirPin } from './utils/claude-config-dir.utils';
import {
  contextUsageRequestLine,
  readContextUsageReply,
} from './utils/claude-context-usage.utils';
import {
  findClaudeSessionFileSync,
  readLastClaudeCostState,
} from './utils/claude-cost-state.utils';
import { ClaudeCostTotalsFile } from './utils/claude-cost-totals.utils';
import {
  ClaudeDelegateSettler,
  readClaudeDelegateTranscript,
} from './utils/claude-delegate-spend.utils';
import {
  fastModeParameter,
  isFastModeCapable,
} from './utils/claude-fast-mode.utils';
import { buildImageBlocks } from './utils/claude-images.utils';
import {
  sweepStaleTurnMcpConfigs,
  writeTurnMcpConfig,
} from './utils/claude-mcp-config.utils';
import {
  parseDisabledServerNames,
  parseHomeDisabledServerNames,
  parseProjectServerNames,
} from './utils/claude-mcp-folder.utils';
import { parseMcpGetHealth, parseMcpList } from './utils/claude-mcp-list.utils';
import type { ClaudeHomeConfig } from './utils/claude-mcp-toggle.utils';
import {
  parseHomeConfig,
  readConfiguredServers,
  readDisabledServers,
  withDisabledServer,
} from './utils/claude-mcp-toggle.utils';
import {
  claudeDisallowedToolArgs,
  claudeSwitchedOffServers,
} from './utils/claude-mcp-tool-name.utils';
import { claudeToolCallMetric } from './utils/claude-mcp-tool-name.utils';
import { readClaudeMemoryNotes } from './utils/claude-memory.utils';
import { mapClaudeMessage } from './utils/claude-message.utils';
import { ClaudeModelMismatchNotice } from './utils/claude-model-mismatch.utils';
import {
  type ClaudeModelResolutions,
  isModelResolutions,
  modelResolutionRequestLine,
  readModelResolutions,
} from './utils/claude-model-resolution.utils';
import { claudeModels } from './utils/claude-models.utils';
import { claudeUpdatedPermissions } from './utils/claude-permission-options.utils';
import {
  readPlanLimitsReply,
  readPlanLimitsStdout,
  usageRequestLine,
} from './utils/claude-plan-limits.utils';
import { readClaudeSessionPullRequests } from './utils/claude-pr-links.utils';
import { claudeProjectKey } from './utils/claude-project-key.utils';
import {
  claudeCardQuestions,
  withResponse,
} from './utils/claude-question.utils';
import {
  carryClaudeSession,
  claudeProjectDirName,
  deleteClaudeSession,
  listClaudeSessions,
  readClaudeSessionHistory,
} from './utils/claude-sessions.utils';
import { claudeSettingsArgs } from './utils/claude-settings.utils';
import { recoverClaudeSubagent } from './utils/claude-subagent-recovery.utils';
import {
  sweepStaleTurnSystemPrompts,
  writeTurnSystemPrompt,
} from './utils/claude-system-prompt.utils';
import {
  readClaudeResultText,
  readClaudeTitleReply,
} from './utils/claude-title.utils';
import { ClaudeSessionCostLedger } from './utils/claude-usage.utils';

/**
 * Drives `claude` headlessly. The prompt is sent as a stream-json user-message
 * line on stdin (`--input-format stream-json`); `--verbose` is required for
 * stream-json output. Resume passes the prior `session_id` via `--resume`.
 *
 * `--append-system-prompt` carries the whole composed instruction block —
 * host preamble, the user's custom instructions, a team member's `systemPrompt`
 * role, then the call surface — joined by `AgentAdapter.composeSystemPrompt`.
 * It is present on EVERY user-facing turn, plain chat included, because the
 * preamble always leads; only an `internalProbe` turn composes to `''` and so
 * spawns without the flag.
 *
 * Other extras: `approvalMode: 'ask'` switches on the stdin control protocol
 * (`--permission-prompt-tool stdio` — the CLI pauses each permission-gated
 * tool call as a `control_request` and resumes on our `control_response`),
 * while `'auto'` bypasses permission checks for unattended team execution.
 *
 * **No `readSessionTitle` override, and that is measured rather than assumed.**
 * This CLI does name conversations — its TUI writes
 * `{"type":"ai-title","aiTitle":…}` into the session JSONL, with a
 * `custom-title` sibling for a manual rename — but probed on 2.1.237, a
 * headless `-p` turn writes neither: a complete turn produced 15 lines carrying
 * `user`, `assistant`, `attachment`, `message` and `last-prompt`, and no title
 * record of any kind, matching the 147-of-3080 ratio across the local profile.
 * geniro drives this CLI headlessly only, so there is nothing on disk to read.
 * Re-check by running one `-p` turn and grepping its JSONL for `ai-title`.
 *
 * What it has instead is a `generateTitle` override: the title is ASKED for on
 * a throwaway turn rather than read, which is the only route to an LLM-written
 * name for a CLI that writes none. See that method for what the turn costs and
 * why it runs where it does.
 */
export class ClaudeAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.Claude,
      userData: {
        caches: [
          CLAUDE_USER_DATA_TMP_DIR_NAME,
          CLAUDE_PROBE_DIR_NAME,
          CLAUDE_PROBE_CACHE_FILE,
        ],
        state: [CLAUDE_COST_TOTALS_FILE],
        leftovers: ['claude-skills.json'],
      },
      ollama: {
        args: [],
        env: {
          ...Object.fromEntries(
            CLAUDE_CREDENTIAL_ENV_KEYS.map((key) => [key, '']),
          ),
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: 'ollama',
          ANTHROPIC_CUSTOM_HEADERS: '',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          CLAUDE_CODE_USE_BEDROCK: '0',
          CLAUDE_CODE_USE_VERTEX: '0',
          CLAUDE_CODE_USE_FOUNDRY: '0',
        },
        baseUrlEnv: 'ANTHROPIC_BASE_URL',
        envSettingsFlag: CLAUDE_SETTINGS_FLAG,
        modelEnvKeys: [
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_SMALL_FAST_MODEL',
          'CLAUDE_CODE_SUBAGENT_MODEL',
        ],
      },
      identity: {
        displayName: 'Claude',
        shortName: 'claude',
        summary: 'Anthropic Claude, driven headlessly via the claude CLI.',
        details: [
          'Runs one turn per member, headlessly through the claude CLI.',
          'Tool approvals are per member — set the member to auto or ask.',
          'Model is configurable per member (empty = the CLI default).',
        ],
        icon: 'bot',
      },
      lightModel: CLAUDE_TITLE_MODEL,
      /**
       * This CLI compacts ITSELF, inside the agent loop — which is the only
       * place a threshold can be held, and it was already visible in geniro's
       * own transcripts before the flag was wired: a team run on 2026-09-22
       * shows three `context_compacted` rows reading `967,557 → 42,401` tokens,
       * every one of them in the MIDDLE of a call.
       *
       * Proved to take EFFECT rather than merely to exist, which the adapter
       * rules require and which an earlier attempt at this feature did not have
       * — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` was measured being READ into the
       * threshold function and changing nothing a driven session did. So the
       * probe here is the compaction itself, not the setting: a haiku session
       * (real window 200,000, default threshold ~167k) driven under
       * `--autocompact 100k` emitted two `compact_boundary` events carrying
       * `trigger: "auto"`, at `pre_tokens 68,657 → post 10,008` and
       * `74,598 → 22,900` — the 67k this flag asks for, not the 167k the model
       * would otherwise compact at. Both fired INSIDE one `-p` invocation,
       * which is the whole reason the flag is worth having.
       *
       * Two facts about the surroundings, measured with it. `/context` under
       * the flag reads `30.4k / 100k` where an unflagged run reads
       * `30.4k / 200k`, with `Autocompact buffer 33k` in both. And the result
       * event's `modelUsage.contextWindow` still reports the MODEL's real
       * window (200,000), so geniro's own meter and its between-turn threshold
       * arithmetic are untouched by the flag.
       */
      autoCompact: {
        kind: 'window-flag',
        flag: CLAUDE_AUTOCOMPACT_FLAG,
        summaryBufferTokens: CLAUDE_AUTOCOMPACT_BUFFER_TOKENS,
        minTokens: CLAUDE_AUTOCOMPACT_MIN_TOKENS,
        maxTokens: CLAUDE_AUTOCOMPACT_MAX_TOKENS,
      },
      /**
       * Probe-verified: a plain chat turn under `--permission-mode default
       * --permission-prompt-tool stdio` offers this tool, and its request
       * arrives as `can_use_tool` with `requires_user_interaction: true`.
       */
      shells: {
        // Null because this CLI REPORTS its detachments: a backgrounded command
        // arrives as a `background_work` bracket and its ending arrives on the
        // same channel (`task_updated` / `task_notification`, measured 2026-08-24
        // on 2.1.237 against a 45-second `sleep`). Asking the OS as well would
        // open every one of them a second time.
        unreportedDetachReason: null,
        silentWaitReason: null,
        lateEndWakeReason: null,
      },
      questionToolName: CLAUDE_QUESTION_TOOL_NAME,
      /**
       * True: the tool is wired only when the turn HAS a permission-prompt
       * channel. Re-probed on 2.1.227 by reading `system/init`'s own tool
       * list — with `--permission-prompt-tool stdio` it is present under every
       * mode, and without it absent under every mode — so an unattended turn
       * that must be able to ask has to be moved off the bypass.
       */
      questionsCostAskPosture: true,
      /**
       * Null: this CLI hands its model AskUserQuestion itself wherever a
       * permission-prompt channel is wired, which every user-facing turn has
       * (`spawnsOnPermissionDialogue`). Supplying a second question tool would
       * put two of them in front of the model with nothing to choose between.
       */
      hostQuestionToolReason: null,
      /**
       * Null: this client's per-server deadline is geniro's own to set, and it
       * is set to a day in the turn's `--mcp-config`
       * (`GENIRO_MCP_TOOL_TIMEOUT_MS`) — so a host-tool call may be left
       * blocked on a person. The field is answered rather than left meaningless
       * beside a null `hostQuestionToolReason`, because it governs every
       * PARKING host tool this CLI is handed, not only the question one.
       */
      hostQuestionDeferredReason: null,
      // MEASURED on 2.1.295 (2026-10-21) against a stub MCP server: a call
      // under `default` and `acceptEdits` is held for permission (answered on
      // the stdio permission channel), and `plan` refuses it outright.
      hostToolCallUngatedReason: null,
      subagents: {
        /**
         * The Task tool's delegates ride the SAME stream-json stream as the
         * main thread, each line carrying `parent_tool_use_id` — read in
         * `utils/claude-message.utils.ts` and stamped onto the item payload by
         * `utils/event-to-item.ts`. It is the id of the launching tool call,
         * which is what lets the renderer nest a delegate's work under the row
         * that started it rather than beside the conversation.
         */
        reports: true,
        unavailableReason: null,
        /**
         * Null: the delegate's own steps ARE the same stream, so its block opens
         * onto a real thread and there is nothing to excuse. This is the shape
         * `stepsUnavailableReason` exists to be contrasted with — cursor
         * announces the delegation and streams none of the work.
         */
        stepsUnavailableReason: null,
        // The Task tool, and the Agent name the CLI also launches one under.
        launchToolNames: ['Task', 'Agent'],
      },
      backgroundWork: {
        // spawn-cli holds the turn (and so the call it answers) while a
        // delegate is out, and the CLI itself starts the next turn with the
        // `task-notification` continuation — on every user-facing turn, since
        // each runs on a kept process (`canHostSession`). A backgrounded
        // command holds nothing.
        agentNote:
          '## Work you leave running\n\nSub-agents you start in the background keep running after you end your turn. This conversation — and the call you are answering, if any — stays open until they report, and you are started again automatically with their results. With nothing else to do, say briefly what you launched and END YOUR TURN instead of waiting: never poll with sleep, date, ls or until/tail loops, never start a background timer to check on them, never read their output files, and never predict what they will report. Your answer is the reply you give in the turn that has nothing left running. Background COMMANDS are different: they are not waited for — run a command whose result you need in the foreground.',
      },
      // The Artifact tool, whose reply carries the published page's URL.
      artifactToolNames: ['Artifact'],
      approval: {
        /** Every `--permission-mode` value the CLI exposes, plus the `auto` bypass. */
        modes: ['auto', 'ask', 'acceptEdits', 'plan'],
        /**
         * The two modes headless claude has been seen to reject on some builds
         * — so a run requesting either waits out the mode probe, and a run that
         * never does pays nothing.
         */
        probedModes: ['acceptEdits', 'plan'],
        /**
         * `acceptEdits` degrades to `ask` on a probed FAIL — the turn still
         * runs, every edit just asks first.
         *
         * `plan` is deliberately ABSENT, even though it is probed the same
         * way: turning a no-execute mode into an executing `ask` would invert
         * the whole promise the user selected it for. An unsupported `plan`
         * rides through and the CLI rejects it loudly, which is the honest
         * failure. Do not add it here "for completeness".
         *
         * An UNPROBED mode keeps what was asked for, so a real rejection
         * surfaces from the CLI rather than from a guess made here.
         */
        degradeOnProbeFail: {
          acceptEdits: {
            to: 'ask',
            /** `acceptEdits` still runs on a probed FAIL — every edit just asks first. */
            reason:
              "installed claude does not support acceptEdits — this turn runs as 'ask'",
          },
        },
        /** Four honoured modes — the sole-mode collapse never applies to claude. */
        soleModeDegradeReason: null,
      },
      /**
       * The values `claude --effort` accepts, weakest first.
       *
       * WRITTEN DOWN RATHER THAN SCRAPED, because the CLI under-reports itself.
       * Its own `--help` says "Valid values: low, medium, high, xhigh, max" and
       * its warning line repeats that set — but `ultracode` is accepted just as
       * silently as the five it names.
       *
       * Probe-verified on claude 2.1.220 (2026-07-29) by feeding each candidate
       * and testing for the `Unknown --effort value` warning:
       * - accepted, no warning: low, medium, high, xhigh, max, `ultracode`
       * - rejected with the warning: `ultrathink`, and the control
       *   `zzz-not-a-level`
       *
       * So a `--help` scrape would drop `ultracode` (a level the user asked for
       * by name), and guessing would never have found it. Re-probe the same way
       * when this list is revised; do not copy it out of help output.
       */
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
        { id: 'ultracode', label: 'ultracode' },
      ],
      /** Null: the list above is non-empty, so there is nothing to explain. */
      effortsUnavailableReason: null,
      oneShotAskUnavailableReason: null,
      options: [
        {
          id: CLAUDE_BROWSER_TOOLS_OPTION,
          label: 'Let claude drive your browser (Claude in Chrome)',
          description:
            'Needs Anthropic’s Chrome extension and a browser running it. Off by default: 22 extra tools in every prompt, paid for on each. Applies to new chats.',
          defaultValue: false,
        },
      ],
      // This CLI has no reopen-without-prompting mechanism wired here: the
      // resume-only turn is an ACP frame (`session/load` with the prompt
      // branched away), and a stream-json turn has no equivalent — its prompt
      // IS how a turn opens. Left unhandled it would send the retry's empty
      // string as an ordinary user message and bill a turn for it.
      resumeOnlyUnavailableReason:
        'claude cannot reopen a conversation without sending a message — send your next message and it continues from where it left off',
      /**
       * True: this vocabulary belongs to the BINARY, not to a model — the same
       * words work under every `--model`. So a level outside it is one the CLI
       * ignores with a warning nobody reads, and refusing it at run creation is
       * what makes the mistake visible.
       */
      effortsAreExhaustive: true,
      /**
       * A model's window is a property OF THE MODEL here, with no flag to
       * change it: `--help` on 2.1.237 offers nothing of the kind, and the
       * window this CLI reports back per turn (`modelUsage[].contextWindow`)
       * is the one the model has. So the sentence names where the size
       * actually comes from rather than saying only "claude cannot" — the rule
       * every `unavailableReason` on this config follows.
       */
      contextWindowsUnavailableReason:
        'claude runs each model at its own context window — pick a different model to change it',
      /**
       * The aliases `claude --model` documents: each resolves to the latest
       * model of its tier, so they stay correct across releases without an app
       * update. This is the floor of the list, never the whole of it.
       */
      builtinModels: [
        { id: 'opus', label: 'opus', source: 'builtin' },
        { id: 'sonnet', label: 'sonnet', source: 'builtin' },
        { id: 'haiku', label: 'haiku', source: 'builtin' },
      ],
      skillRoots: {
        /**
         * What `CLAUDE_CONFIG_DIR` replaces: this CLI's home configuration
         * lives at `~/.claude`, and a profile IS that directory somewhere
         * else — so a run's own skills and commands are `<configDir>/skills`
         * and `<configDir>/commands`, derived from the two roots below rather
         * than spelled a second time.
         */
        profileAnchor: ['.claude'],
        /** `<root>/.claude/skills/<name>/SKILL.md`. */
        skills: [['.claude', 'skills']],
        /** `<root>/.claude/commands/**.md`. */
        commands: [['.claude', 'commands']],
        /**
         * None — not for want of a plugin mechanism (this CLI owns the cache
         * the OTHER one reads), but because it already ANSWERS for its
         * plugins: `listReportedCommands` returns them as the CLI's own slash
         * commands, under the `<plugin>:<skill>` names it actually accepts.
         * Scanning the same directories would file a second row per skill
         * named after the FILE (`implement` beside `geniro:implement`), and
         * only one of the two spellings can be sent.
         */
        plugins: [],
      },
      liveStream: {
        /** Utility argv whose stdout is searched for {@link CLAUDE_PARTIAL_MESSAGES_FLAG}. */
        probeArgs: ['--help'],
        flag: CLAUDE_PARTIAL_MESSAGES_FLAG,
      },
      reportedCommands: {
        /** Never reached by the model: the turn is cancelled the moment init lands. */
        probePrompt: 'Reply with exactly: ok',
        /** A hung probe must not wedge the caller forever. */
        probeTimeoutMs: 30_000,
        /** Defensive bound — init reports ~60 entries today. */
        maxCommands: 500,
        /**
         * `_`-prefixed names are claude's INTERNAL commands
         * (`__remote-workflow`) — reported, but not things a user invokes.
         * SkillHarvestStore drops them from the other report path too.
         */
        internalPrefix: '_',
      },
      geniroCommands: [
        {
          name: 'compact',
          description:
            'Summarise the conversation so far and continue from the summary',
          /**
           * This CLI's OWN command, sent verbatim. It is a local command rather
           * than a prompt, and it runs on the stream-json stdin geniro already
           * drives — measured on 2.1.237 through this daemon's own transport:
           * the turn answers `system/compact_boundary` followed by the injected
           * summary, which `mapClaudeMessage` already maps to
           * `context_compacted` and the transcript already collapses behind one
           * housekeeping line.
           *
           * Declared here anyway, rather than left to the CLI's own reported
           * list, so that `/compact` is ONE command across every agent geniro
           * drives instead of a name that happens to exist on this one.
           */
          prompt: '/compact',
          /**
           * False: the CLI rewrites its own history in place and keeps the
           * session. Dropping it here would discard the very conversation the
           * summary was just distilled from.
           */
          replacesSession: false,
        },
      ],
      mcp: {
        /**
         * The endpoint is handed to claude per turn, so nothing about the
         * machine has to be trusted in advance.
         */
        callToolsRequireTrustProbe: false,
        /** `--mcp-config` carries the endpoint for one turn; no cwd file is touched. */
        endpointRequiresCwdConfig: false,
        /**
         * Null: `claude mcp list` reports them, so this adapter overrides
         * `listMcpServers` and an empty answer really does mean an empty folder.
         */
        listingUnavailableReason: null,
        /**
         * Every scope can be switched off, through the CLI's own per-folder
         * `disabledMcpServers` list — probe-verified on 2.1.222, including the
         * `local` scope the old settings-file route could not reach.
         */
        toggleUnavailableReason: null,
        /**
         * Null: a team member's switched-off servers are named in the turn's
         * `--settings` `deniedMcpServers` (`CLAUDE_DENIED_MCP_SERVERS_KEY`), so
         * the CLI never starts them, and withheld as tools too
         * (`claudeDisallowedToolArgs`). MEASURED on 2.1.325: the deny list keeps
         * a server from starting. MEASURED on 2.1.284: `--disallowedTools` alone
         * took the tool list from 125 to 96 while both servers still reported
         * `connected`, so the CLI dialled them. A server-level tool rule is the
         * CLI's own shape (`jHe`'s `isServerLevelDisallowed` in the 2.1.284
         * bundle).
         */
        turnToggleUnavailableReason: null,
        /**
         * Probe-verified on 2.1.226, and the reason it is a NOTE rather than
         * extra rows: the CLI's own `/mcp` panel carries a
         * "Built-in MCPs (always available)" group — `claude-in-chrome` and
         * `computer-use` — that a headless turn does not load at all. A
         * headless `system/init` advertises 210 tools, 177 of them `mcp__`,
         * and NONE matching either name; `claude mcp list` says "List
         * CONFIGURED MCP servers" and reports neither. There is no channel
         * that would let geniro list them honestly, and no reason to want one:
         * both are interactive-session integrations, so a row here would
         * promise the agent tools it will not have.
         */
        interactiveOnlyNote:
          'claude also loads claude-in-chrome and computer-use in its own interactive session. They are not loaded in the headless turns geniro runs, so they are not listed here.',
        userDisabledReason:
          'switched off in your own claude settings, which geniro cannot re-enable',
        /** `claude mcp login <name>` — probe-verified on 2.1.223. */
        loginArgs: CLAUDE_MCP_LOGIN_ARGS,
        loginUnavailableReason: null,
        // The switch is `projects[<repository>]` in the profile's own
        // `.claude.json` (`claudeProjectKey`); a server's sign-in belongs to the
        // profile, whatever folder it was made in.
        changeReach: {
          toggle: { where: 'repository', perProfile: true },
          signIn: { where: 'everywhere', perProfile: true },
        },
        /**
         * The CLI's own failure line, observed verbatim on 2.1.232:
         * `Couldn't complete authentication for "probe": stdin isn't a
         * terminal…`. The marker deliberately starts AFTER the apostrophe —
         * the CLI spells other messages with typographic punctuation, and a
         * marker containing one would silently stop matching the day this line
         * is re-cased or re-quoted. The opener it must not collide with is
         * "Starting authentication for", which shares no substring with this.
         */
        loginFailureMarkers: CLAUDE_MCP_LOGIN_FAILURE_MARKERS,
        /**
         * Non-null: this CLI has no approve command, so there is nothing for a
         * button to run. Read from `claude mcp --help` on 2.1.237, whose whole
         * command list is add / add-from-claude-desktop / add-json / get /
         * list / login / logout / remove / reset-project-choices / serve. The
         * near miss is the last one — `reset-project-choices` "Reset all
         * approved and rejected project-scoped (.mcp.json) servers within this
         * project", which CLEARS the choices rather than granting one, and
         * would take every other server's approval with it.
         *
         * The toggle beside it is deliberately not read as an answer here: it
         * writes `disabledMcpServers`, which decides whether an APPROVED server
         * is loaded and never approves anything, so enabling an unapproved row
         * would move a switch and leave it exactly as `⏸ Pending approval` —
         * the silent no-op {@link AdapterConfig.mcp.approveUnavailableReason}
         * exists to prevent.
         */
        approveUnavailableReason:
          'claude approves a project server in its own /mcp screen, which a headless turn cannot open',
        /**
         * Five minutes, and it is the TRANSPORT's figure rather than the tool
         * timeout geniro writes into the per-turn `--mcp-config`
         * (`GENIRO_MCP_TOOL_TIMEOUT_MS`, a day) — that one bounds the SDK's own
         * call timer and does not reach the HTTP request under it. The client's
         * fetch gives up on a request that has received no bytes for ~300s:
         * reconstructed on run `51c646fb`, 52 unbounded `await_agent` calls were
         * cut between 302s and 359s with the runtime's own `The operation timed
         * out.` (see `MAX_AWAIT_TIMEOUT_MS`, whose 240s ceiling this bound
         * reproduces). The 2.1.280 bundle caps the http server entry's
         * `request_timeout_ms` hint at the same 300000 (`Math.min(e, ql)`).
         */
        toolCallDeadlineMs: 300_000,
      },
      auth: {
        /** `claude auth login` — read from `claude auth --help` on 2.1.227. */
        loginArgs: CLAUDE_AUTH_LOGIN_ARGS,
        loginUnavailableReason: null,
        /** `claude auth logout` — read from `claude auth --help` on 2.1.227. */
        logoutArgs: CLAUDE_AUTH_LOGOUT_ARGS,
        logoutUnavailableReason: null,
        /**
         * OBSERVED verbatim on 2.1.228, running `claude auth login` with stdin
         * closed and no TTY:
         *
         * ```
         * Opening browser to sign in…
         * If the browser didn't open, visit: https://claude.com/cai/oauth/…
         * Paste code here if prompted >
         * ```
         *
         * Note what this does NOT assume. The same run also opened a listener on
         * 127.0.0.1 (observed via lsof), so the browser round-trip may well
         * complete without any paste — the prompt says "if prompted" for that
         * reason. So this marker is not "claude needs a code", it is "claude has
         * reached the point where a code WOULD be accepted", which is exactly
         * when a field for one becomes useful and never before.
         */
        loginCodePromptMarkers: CLAUDE_LOGIN_CODE_PROMPT_MARKERS,
        // Its authorization URL is the first link it prints.
        loginUrlPattern: null,
        expiredMarkers: CLAUDE_AUTH_EXPIRED_MARKERS,
        /**
         * MEASURED twice, and the two readings are why this is a pattern rather
         * than a list of nouns.
         *
         * Verbatim out of a real run's own transcript (`09d69570`, daemon
         * 1.103.0, claude ~2.1.270): `You've hit your session limit · resets
         * 2:30pm (Asia/Almaty)` — the whole of the `error` event's message.
         * Then out of the installed 2.1.276 binary's string table, which spells
         * the same sentence for `hit your limit`, `hit your usage limit`, `hit
         * your monthly limit`, `hit your monthly spend limit` and `hit your fast
         * limit` — none of them `session`. So the noun in the middle changes
         * with the vendor's plan vocabulary and the frame does not. 2.1.312
         * fills it from the window's label (`hit your ${c} limit`, `c` being
         * `5-hour` among others) and also says `hit your channel's monthly
         * spend limit`, so a word may carry digits, a hyphen or an apostrophe.
         *
         * `Usage limit reached` is the second family in that table (`… ·
         * continuing automatically`, `… — grace window active`), matched on its
         * own because it shares no words with the first.
         *
         * RE-CHECK when a release changes either frame. A miss costs a caller
         * the one class that tells it to wait rather than retry — which is the
         * incident this exists for, not a cosmetic loss.
         */
        rateLimitPatterns: [
          /hit your (?:[a-z0-9'-]+ )*limit/i,
          /usage limit reached/i,
        ],
        /**
         * The same table renders the reset as `resets ${…}` in nine separate
         * templates, and the measured message ends `· resets 2:30pm
         * (Asia/Almaty)` — so the time is whatever follows the word, to the end
         * of the line, and is repeated back to the caller unparsed.
         */
        resetsAtPatterns: [/resets\s+(.+)$/i],
        serviceRefusalMarkers: [],
        isolatedEnvKeys: [
          ...CLAUDE_PROVIDER_ENV_KEYS,
          // Present when the APP was launched from inside a Claude Code session
          // (`pnpm dev` in its terminal). It names that OUTER session, which no
          // spawned conversation ever is — an agent or its tools binding to it
          // would cross-wire resume and session capture onto one session file.
          'CLAUDE_CODE_SESSION_ID',
          // A profile the launching shell chose for ITSELF. A chat's profile is
          // part of the run's identity and `buildEnv` passes it explicitly, so
          // inheriting this ran every chat that named none under a different
          // account, resuming session ids that profile does not hold.
          CLAUDE_CONFIG_DIR_ENV,
          // A feature switch, not a credential: `buildEnv` sets it only when the
          // user turned the browser tools on, and Claude Code's own terminal
          // exports `=1` — inherited, it put 22 tool schemas into every prompt
          // with the setting off and nothing on screen saying so.
          CLAUDE_BROWSER_TOOLS_ENV,
          ...CLAUDE_CREDENTIAL_ENV_KEYS,
        ],
        /**
         * The Anthropic credentials the strip removes from every child, so they
         * never reach another agent. Declaring them here re-injects them for
         * claude's own children — turns AND the `runCommand` listings.
         *
         * The listings are the part that was missing, and it was an assumption
         * rather than a measurement: this adapter's `buildEnv` re-injected them
         * on the turn path only, and the claim that its utility reads need
         * nothing rested on the local machine authenticating by OAuth, where
         * these variables are unset either way. For an account whose ONLY
         * credential is an exported `ANTHROPIC_API_KEY`, `claude mcp list` ran
         * with it stripped — the symmetric shape of the cursor bug this change
         * was written to fix. Same list as the strip, so neither can drift.
         */
        inheritedEnvKeys: [
          ...CLAUDE_CREDENTIAL_ENV_KEYS,
          ...CLAUDE_PROVIDER_ENV_KEYS,
        ],
      },
      sessions: {
        // Every conversation this CLI has ever held sits in the profile as one
        // JSONL file per session, under a directory named after its cwd — so
        // both halves of the picker (which folder, and what it was about) are
        // readable without asking the binary anything.
        listingUnavailableReason: null,
        // The scan covers the whole profile, so there is no second store the
        // way there is for cursor.
        listingPartialReason: null,
        // That same JSONL IS the transcript, in the very envelope this CLI's
        // stream-json output uses — see `readSessionHistory`.
        historyUnavailableReason: null,
        // The transcript is a plain JSONL file in the profile, so a search can
        // read what was actually said rather than only the row's own label.
        contentSearchUnavailableReason: null,
      },
      configDir: {
        /**
         * `CLAUDE_CONFIG_DIR` — probe-verified on 2.1.227: a headless turn
         * pointed at an empty directory wrote its whole profile there and
         * reported "Not logged in", which is what makes a second directory a
         * second account.
         *
         * This var is ALSO named in `utils/child-env.ts`'s stripped set, so an
         * ambient one cannot select a profile for a run that named none; that
         * set has to be the union over every CLI, which is why the name appears
         * in both places. Keep them in step.
         */
        envVar: CLAUDE_CONFIG_DIR_ENV,
        unavailableReason: null,
        /**
         * A conversation FOLLOWS the run to the other account, and that is a
         * measurement rather than a hope — the null here promises
         * {@link ClaudeAdapter.carrySessionToConfigDir} does something.
         *
         * Probed on 2.1.237 across this machine's two real profiles: a turn
         * under profile A was told a codeword; `--resume <id>` under profile B
         * answered `No conversation found with session ID: …`; the session's
         * own `.jsonl` was copied into B's `projects/<same dir>/`; the same
         * resume under B then answered the codeword. So the store is the whole
         * of what makes a conversation resumable here, and moving the file is
         * moving the conversation.
         */
        sessionCarryUnavailableReason: null,
      },
      /**
       * Probed on 2.1.295 through `get_context_usage`'s `memoryFiles`: with no
       * `CLAUDE_CONFIG_DIR` the `User` file is `~/.claude/CLAUDE.md`; pointed at
       * a throwaway directory holding a `CLAUDE.md`, it is that file instead,
       * and a real profile without one loads no user file at all.
       */
      userInstructions: {
        kind: 'file',
        homeDir: '.claude',
        fileName: 'CLAUDE.md',
      },
      followUp: {
        /**
         * A stream-json stdin is a CONVERSATION: a second `{"type":"user"}`
         * line on a still-open pipe is acted on at the next tool boundary
         * (probe-verified on 2.1.222). `buildFollowUpPayload` is the override
         * this null promises — the two are pinned together by spec.
         */
        unavailableReason: null,
        /**
         * False: the message JOINS the running turn and is acted on at the next
         * tool boundary, so nothing in flight is lost. The opposite of cursor's
         * answer, which is why this is a field rather than one shared sentence.
         */
        interrupts: false,
        /**
         * True — every turn runs with `CLAUDE_REPLAY_USER_MESSAGES_FLAG`, and
         * `mapClaudeMessage` turns each echo into `user_message_consumed`.
         * Joining the turn is not the same as being answered in it: a message
         * that arrives as the model writes its last words gets a further
         * `result` of its own (probed on 2.1.270), and the echo is what tells
         * the two apart.
         */
        consumptionReported: true,
      },
      modelVendor: { kind: 'fixed', vendor: 'anthropic' },
      usage: {
        /**
         * Reports it in full. Every `result` line carries `usage` (input/output
         * tokens, cache reads) and `total_cost_usd`, which `claude-usage.utils`
         * maps — so the meter has a numerator, a denominator and a spend.
         */
        unavailableReason: null,
        /**
         * Answers the breakdown too, over `get_context_usage` — see
         * {@link ClaudeAdapter.buildContextUsageAsk} and the probe block at
         * `CLAUDE_CONTEXT_USAGE_SUBTYPE` in `claude.const.ts`.
         *
         * From the LIVE process and from nothing else: the request is a
         * question on the running CLI's stdin dialogue, and this CLI publishes
         * no reading of its own conversation anywhere on disk. So a chat whose
         * session has been reaped for idleness has nobody to ask — which is a
         * different sentence from one that was asked and stayed silent.
         */
        breakdown: { kind: 'reads', channel: 'live-process' },
        /**
         * Answers the account's plan limits too, over `get_usage` — see
         * {@link ClaudeAdapter.readPlanLimits} and the probe block at
         * `CLAUDE_PLAN_LIMITS_SUBTYPE` in `claude.const.ts`. Same channel as
         * the breakdown above, for the same reason: the account is not a
         * property of the conversation, but the only way to ask about it here
         * is through the conversation's own process — or, on a refresh with
         * none, a one-shot process under the account's profile.
         */
        planLimits: { kind: 'reads', channel: 'live-process', oneShot: true },
        // Every `result` line carries `total_cost_usd`, so a turn prices itself.
        polledSpend: false,
        // claude's model ids are Anthropic's API ids once its `[1m]` variant
        // suffix is dropped (`canonicalClaudeModel`). The turn's own price
        // stays the CLI's; the catalog prices only what the CLI will not —
        // one DELEGATE — and is calibrated against the turn it ran in (see
        // `ClaudeDelegateCostLedger`).
        listPrice: {
          kind: 'catalog',
          provider: 'anthropic',
          // Measured 2026-10-16 on 2.1.295: models.dev's `limit.context` for
          // claude-haiku/opus/sonnet-5-5 and claude-fable-5-1 (1,000,000) is
          // the `maxTokens` the CLI's own `get_context_usage` reports.
          catalogWindows: true,
          // Measured 2026-11-09 on a real ledger: 81% of claude-opus-5-5 turns with
          // cache writes match the bill at 2x input, 14% at the catalog's rate.
          cacheWriteInputMultiple: 2,
        },
      },
      handoff: {
        kind: 'resume-command',
        resumeFlag: CLAUDE_RESUME_FLAG,
        // claude opens a session another of its processes has open — two
        // interactive processes on one session both run, neither seeing the
        // other — so a held conversation is resumed like any other.
        heldFlag: null,
        modelFlag: CLAUDE_MODEL_FLAG,
        /**
         * What a resumable claude session id looks like. A missing or
         * foreign-shaped id is not a mirror target — opening the TUI without
         * one would start an unrelated fresh conversation instead of showing
         * the run's own.
         */
        sessionIdPattern: /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
      },
    };
  }

  /**
   * The permission-mode probe's verdict as it stands, in the adapter-agnostic
   * tri-state — the probe is this adapter's own (`claude-probe.service.ts`),
   * so no consumer ever holds claude's verdict shape.
   *
   * `unknown` maps to ABSENT, never to `false`. The distinction is the whole
   * point: an unprobed mode keeps what the caller asked for, so a genuine
   * rejection surfaces loudly from the CLI itself instead of being pre-empted
   * by a degrade nobody proved was needed.
   */
  override currentApprovalSupport(): InstalledApprovalSupport {
    return supportFromVerdict(
      this.modeProbe?.capability() ?? CLAUDE_UNPROBED_VERDICT,
    );
  }

  /**
   * The verdict once the probe has settled for the installed binary.
   *
   * A probe INFRASTRUCTURE failure (a temp-dir cleanup throw bubbling up, a
   * spawn that could not start) degrades to the current verdict — normally
   * all-`unknown` — rather than rejecting, because an unknown verdict keeps
   * the requested mode and a probe error must never fail the send it was
   * asked to inform.
   */
  override async settledApprovalSupport(): Promise<InstalledApprovalSupport> {
    if (this.modeProbe === null) {
      return this.currentApprovalSupport();
    }
    try {
      return supportFromVerdict(await this.modeProbe.ensureVerdict());
    } catch {
      return this.currentApprovalSupport();
    }
  }

  /**
   * The verdict `GET /v1/capabilities` publishes. Reading it pre-warms an
   * unprobed verdict in the background (`wireCapability`), so the probe has
   * usually settled by the time a turn asks for a probed mode.
   */
  override approvalProbe(): AgentApprovalProbeState {
    const verdict = this.modeProbe?.wireCapability() ?? CLAUDE_UNPROBED_VERDICT;
    const degrades = this.getConfig().approval.degradeOnProbeFail;
    return {
      modes: [
        {
          mode: 'acceptEdits',
          status: verdict.acceptEdits,
          requiresPass: !('acceptEdits' in degrades),
        },
        {
          mode: 'plan',
          status: verdict.plan,
          requiresPass: !('plan' in degrades),
        },
      ],
      version: verdict.version,
      probedAt: verdict.probedAt,
      reason: verdict.reason,
    };
  }

  /**
   * claude's question channel is the AskUserQuestion tool
   * (`config.questionToolName`), whose input carries the questions, their
   * headers and their option labels. Projecting it is the adapter's job, so
   * the team executor can bridge a callee's question to its caller without
   * ever holding claude's payload shape.
   *
   * Null for a payload that carries no readable question, as for every other
   * CLI: the executor denies such a request rather than parking a blank one a
   * caller could not answer, and the callee carries on.
   */
  override questionFrom(input: unknown): AdapterQuestion | null {
    return adapterQuestionOf(claudeCardQuestions(input));
  }

  /**
   * The answer rides back on ONE of AskUserQuestion's two channels, chosen by
   * how many questions the card carried: `answers` (a map keyed by question
   * text) for a lone question, `response` (one free-text reply, which REPLACES
   * the structured list) for several. `withResponse` owns that choice and the
   * probe behind it.
   */
  override withAnswer(input: unknown, answer: string): unknown {
    return withResponse(input, answer);
  }

  /** Per-turn `--mcp-config` file paths, written by prepareTurn. */
  private readonly mcpConfigPaths = new WeakMap<AgentTurnInput, string>();
  private readonly systemPromptPaths = new WeakMap<AgentTurnInput, string>();

  /**
   * The `--permission-mode` probe for the installed binary, or null when this
   * adapter was built without the services a probe needs (standalone and spec
   * use) — every probed mode then reads `unknown`, which keeps what a caller
   * asked for.
   */
  private readonly modeProbe: ClaudeModeProbe | null;

  /** One process's memory of {@link resolveModel}'s probe, per profile. */
  private readonly modelResolutionCache =
    new ModelVocabularyCache<ClaudeModelResolutions | null>({
      ttlMs: CLAUDE_MODEL_RESOLUTION_TTL_MS,
      now: Date.now,
    });
  /**
   * When each profile's probe last failed. A turn waits on this probe, so a
   * CLI that cannot answer must not cost every first turn the whole timeout.
   */
  private readonly modelResolutionFailedAt = new Map<string, number>();

  constructor(private readonly claudeOptions: ClaudeAdapterOptions = {}) {
    super(claudeOptions);
    // In the BODY rather than as a field initializer, which would read the
    // parameter property at a moment that is a compiler detail.
    this.costLedger = new ClaudeSessionCostLedger(
      (model) => this.listPriceOf(model),
      claudeOptions.costTotalsPath === undefined
        ? null
        : new ClaudeCostTotalsFile(claudeOptions.costTotalsPath),
    );
    this.modeProbe =
      claudeOptions.modeProbe ??
      (claudeOptions.processes && claudeOptions.versions
        ? new ClaudeProbeService(
            this,
            claudeOptions.processes,
            claudeOptions.versions,
            {
              ...(claudeOptions.probeRootDir === undefined
                ? {}
                : { probeRootDir: claudeOptions.probeRootDir }),
              ...(claudeOptions.modeProbeCachePath === undefined
                ? {}
                : { cachePath: claudeOptions.modeProbeCachePath }),
            },
          )
        : null);
  }

  /**
   * This adapter as the daemon builds it: every file it writes under the
   * daemon's own userData, never the OS-shared tmpdir — the per-turn
   * `--mcp-config` files carry the per-run call token.
   */
  static forDaemon(deps: AdapterDaemonDeps): ClaudeAdapter {
    return new ClaudeAdapter({
      spawn: deps.spawn,
      mcpConfigDir: join(deps.userDataDir, CLAUDE_USER_DATA_TMP_DIR_NAME),
      // The command-catalog probe's and the mode probe's throwaway
      // workspaces — daemon-owned, never a user folder.
      probeRootDir: join(deps.userDataDir, CLAUDE_PROBE_DIR_NAME),
      modeProbeCachePath: join(deps.userDataDir, CLAUDE_PROBE_CACHE_FILE),
      costTotalsPath: join(deps.userDataDir, CLAUDE_COST_TOTALS_FILE),
      processes: deps.processes,
      versions: deps.versions,
      logger: deps.logger(ClaudeAdapter.name),
      prices: deps.prices,
      vocabularyStore: deps.vocabularyStore,
    });
  }

  /**
   * What `model` runs as under this profile — the CLI's own answer, from a
   * one-shot `initialize` (see `CLAUDE_CONTROL_PROBE_ARGS`), kept per
   * profile and binary version in memory and in the vocabulary store, so it
   * is asked about once per version rather than per turn. A name the reply
   * does not list (an id such as `claude-opus-5[1m]`) is its own answer.
   */
  override async resolveModel(
    model: string | null,
    configDir: string | null,
  ): Promise<string | null> {
    const asked = model === '' ? null : model;
    const resolutions = await this.modelResolutions(configDir);
    return (
      resolutions?.[asked ?? CLAUDE_DEFAULT_MODEL_VALUE]?.resolvedModel ?? asked
    );
  }

  override async modelDetails(
    model: AgentModel,
    configDir: string | null,
  ): Promise<AgentModel> {
    const resolutions = await this.modelResolutions(configDir);
    return resolutions?.[model.id] ?? model;
  }

  /**
   * {@link resolveModel}'s memory, on the menu bar's reset. The DURABLE half is
   * `ModelVocabularyStore`'s and is cleared by the same service.
   */
  override clearCaches(): number {
    this.modelResolutionFailedAt.clear();
    return this.modelResolutionCache.clear();
  }

  /**
   * The same memory on an ACCOUNT change: the default model is the account's,
   * and a probe still running was asked under the replaced credentials, so it
   * is detached and its reply not filed (`ModelVocabularyCache.forget`).
   */
  override forgetAccountCaches(): number {
    this.modelResolutionFailedAt.clear();
    return this.modelResolutionCache.forget(this.getConfig().kind);
  }

  private async modelResolutions(
    configDir: string | null,
  ): Promise<ClaudeModelResolutions | null> {
    try {
      const kind = this.getConfig().kind;
      const profile = this.vocabularyProfile(configDir);
      const version = await this.resolveBinaryVersion({});
      const stored = this.claudeOptions.vocabularyStore?.read(
        kind,
        CLAUDE_MODEL_RESOLUTION_STORE_MODEL,
        profile,
        version,
        isModelResolutions,
      );
      if (stored) {
        if (stored.stale) {
          void this.takeModelResolutions(kind, profile, version);
        }
        return stored.value;
      }
      return await this.takeModelResolutions(kind, profile, version);
    } catch {
      return null;
    }
  }

  /** The probe, joined through the memory cache; never rejects. */
  private takeModelResolutions(
    kind: AgentKind,
    profile: string | null,
    version: string | null,
  ): Promise<ClaudeModelResolutions | null> {
    const failedAt = this.modelResolutionFailedAt.get(profile ?? '');
    if (
      failedAt !== undefined &&
      Date.now() - failedAt < CLAUDE_MODEL_RESOLUTION_RETRY_AFTER_MS
    ) {
      return Promise.resolve(null);
    }
    const store = this.claudeOptions.vocabularyStore;
    return this.modelResolutionCache
      .read(
        kind,
        CLAUDE_MODEL_RESOLUTION_STORE_MODEL,
        profile,
        version,
        async () => {
          // Read BEFORE the probe: an answer whose probe straddled a sign-in
          // is the previous account's, and the store refuses it by this.
          const askedAt = store?.epoch(kind);
          const fresh = await this.probeModelResolutions(profile);
          if (fresh === null) {
            // Served, never kept: one failed probe must not answer for the TTL.
            this.modelResolutionFailedAt.set(profile ?? '', Date.now());
            return volatile(null);
          }
          this.modelResolutionFailedAt.delete(profile ?? '');
          store?.remember(
            kind,
            CLAUDE_MODEL_RESOLUTION_STORE_MODEL,
            profile,
            version,
            fresh,
            askedAt,
          );
          return fresh;
        },
      )
      .catch(() => null);
  }

  private async probeModelResolutions(
    configDir: string | null,
  ): Promise<ClaudeModelResolutions | null> {
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('models');
      const stdout = await this.runCommand([...CLAUDE_CONTROL_PROBE_ARGS], {
        cwd,
        stdinWrites: [modelResolutionRequestLine()],
        endStdin: true,
        settleWhen: (out) => readModelResolutions(out) !== null,
        timeoutMs: CLAUDE_MODEL_RESOLUTION_TIMEOUT_MS,
        ...(configDir ? { env: { [CLAUDE_CONFIG_DIR_ENV]: configDir } } : {}),
      });
      return stdout === null ? null : readModelResolutions(stdout);
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  /**
   * Drop the per-turn config files a prior daemon launch left behind — a
   * no-op when the daemon named no config dir, since the OS tmpdir fallback is
   * only ever used standalone. The tokens in them are already dead; this is
   * hygiene for `<userData>/tmp`.
   */
  override sweepStaleState(): void {
    const dir = this.claudeOptions.mcpConfigDir;
    if (dir) {
      sweepStaleTurnMcpConfigs(dir);
      sweepStaleTurnSystemPrompts(dir);
    }
  }

  /**
   * Ask this CLI what its window currently holds, over the undocumented
   * `get_context_usage` control request — see the probe block at
   * `CLAUDE_CONTEXT_USAGE_SUBTYPE` in `claude.const.ts`.
   *
   * A fresh id per question, which the base's doc block requires and this is
   * the reason for: the reader matches on it, so two readouts opened together
   * would otherwise both take the first reply — and the CLI serialises them,
   * so the second answer describes a later moment than the first.
   */
  override readContextUsage(
    input: AgentSessionReadInput,
  ): Promise<AgentContextUsage | null> {
    // This CLI answers from its RUNNING process — the control request is a
    // question on the live stdin dialogue — so with no process there is
    // nothing to ask. Its session id is no help here: claude keeps its
    // conversation in its own store and publishes no reading of it.
    if (!input.live) {
      return Promise.resolve(null);
    }
    // A fresh id per question, which matters because the reader matches on it:
    // two readouts opened together would otherwise both take the first reply,
    // and the CLI serialises them, so the second answer describes a later
    // moment than the first.
    const requestId = randomUUID();
    return input.live.ask({
      line: contextUsageRequestLine(requestId),
      read: (obj) => readContextUsageReply(obj, requestId),
      timeoutMs: CLAUDE_CONTEXT_USAGE_TIMEOUT_MS,
    });
  }

  override readPlanLimits(
    input: AgentSessionReadInput,
  ): Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null> {
    // Same channel and same constraint as the breakdown above: this CLI
    // answers on its live stdin dialogue, so with no process there is nothing
    // to ask. The account's plan is not a property of the conversation, but
    // the only way to ASK about it here is through the conversation's process.
    if (!input.live) {
      return input.mayProbe
        ? this.probePlanLimits(input.configDir)
        : Promise.resolve(null);
    }
    const requestId = randomUUID();
    return input.live.ask({
      line: usageRequestLine(requestId),
      read: (obj) => readPlanLimitsReply(obj, requestId),
      timeoutMs: CLAUDE_PLAN_LIMITS_TIMEOUT_MS,
    });
  }

  private async probePlanLimits(
    configDir: string | null,
  ): Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null> {
    const requestId = randomUUID();
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('plan-limits');
      const stdout = await this.runCommand([...CLAUDE_CONTROL_PROBE_ARGS], {
        cwd,
        stdinWrites: [usageRequestLine(requestId)],
        endStdin: true,
        settleWhen: (out) => readPlanLimitsStdout(out, requestId) !== null,
        timeoutMs: CLAUDE_PLAN_LIMITS_TIMEOUT_MS,
        ...(configDir ? { env: { [CLAUDE_CONFIG_DIR_ENV]: configDir } } : {}),
      });
      return stdout === null ? null : readPlanLimitsStdout(stdout, requestId);
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  /**
   * Materialize a caller turn's MCP config, and hand back a disposer for it.
   *
   * It is a 0600 file because the call token must never ride argv (visible in
   * `ps`), so argv carries only the path.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    const dir =
      this.claudeOptions.mcpConfigDir ??
      join(tmpdir(), CLAUDE_MCP_CONFIG_DIR_NAME);
    const written: string[] = [];
    const discard = (): void => {
      this.mcpConfigPaths.delete(input);
      this.systemPromptPaths.delete(input);
      for (const path of written) {
        rmSync(path, { force: true });
      }
    };
    try {
      if (input.mcpEndpoint) {
        // No collision check: the endpoint's name carries this run's id, so it
        // cannot be a name the user has already given one of their own servers
        // — which is what the check that used to stand here was protecting
        // them from, `--strict-mcp-config` not being passed.
        const path = writeTurnMcpConfig(dir, input.mcpEndpoint);
        this.mcpConfigPaths.set(input, path);
        written.push(path);
      }
      const granted = Boolean(input.mcpEndpoint) && !input.isolateMcpServers;
      const systemPrompt = this.composeSystemPrompt(input, granted);
      if (
        Buffer.byteLength(systemPrompt, 'utf8') >
        CLAUDE_SYSTEM_PROMPT_INLINE_MAX_BYTES
      ) {
        const path = writeTurnSystemPrompt(dir, systemPrompt);
        this.systemPromptPaths.set(input, path);
        written.push(path);
      }
    } catch (err) {
      // Nothing may be stranded by a throw: the file carries the run's call
      // token at mode 0600, and no disposer has been handed out to remove it.
      discard();
      throw err;
    }
    return written.length === 0 ? undefined : discard;
  }

  /** The initialize reply supplies account models, display names and alias ids. */
  override async listModels({
    configDir,
  }: AgentModelsInput): Promise<AgentModel[]> {
    // Both sources belong to the run's profile: one binary can serve accounts
    // with different model access.
    const resolutions = await this.modelResolutions(configDir);
    return resolutions !== null
      ? Object.values(resolutions)
      : claudeModels(
          this.getConfig().builtinModels,
          this.modelCacheDir(configDir),
        );
  }

  /**
   * FAST MODE, this CLI's one further model setting — see
   * {@link claudeSettingsArgs} for the argv it turns into.
   *
   * Support is per MODEL, not per CLI ({@link isFastModeCapable}), so an
   * unsupported model gets no row rather than a control the CLI would
   * silently ignore. No handshake is spawned for this answer, unlike
   * cursor's: the fact lives in the model's NAME, measured once against the
   * shipped binary rather than asked of it per turn.
   *
   * The row is offered whatever this ACCOUNT's own billing state is — see
   * {@link CLAUDE_SETTINGS_FLAG}'s doc block — because nothing here can read
   * that state ahead of a turn, and withholding the control over a gate
   * nobody can check would look identical to a bug.
   */
  override async listModelParameters(
    model: string | null,
    _options: AgentCommandOptions = {},
  ): Promise<AgentModelParameterListing> {
    if (model === null) {
      return {
        parameters: [],
        unavailableReason: 'pick a model to see the settings it offers',
        exact: false,
      };
    }
    if (!isFastModeCapable(model)) {
      return {
        parameters: [],
        unavailableReason: `${model} does not support fast mode — only Opus models do`,
        exact: true,
      };
    }
    return {
      parameters: [fastModeParameter()],
      unavailableReason: null,
      exact: true,
    };
  }

  /**
   * Where {@link CLAUDE_MODEL_CACHE_FILE} sits for a profile.
   *
   * NOT {@link profileDir}, and the difference is measured: a config directory
   * holds `.claude.json` at its ROOT (`<configDir>/.claude.json`) while the
   * home copy sits beside the `.claude` directory rather than inside it
   * (`~/.claude.json`) — the same split `CLAUDE_PROFILE_SETTINGS_FILE` records
   * for the settings file. So the home case wants the home dir itself, and the
   * profile case wants the profile.
   */
  private modelCacheDir(configDir: string | null): string {
    return configDir ?? this.claudeOptions.homeDir ?? homedir();
  }

  /**
   * The conversations this profile holds, read straight off disk — no binary is
   * spawned, so a signed-out or missing CLI still lists a user's history.
   *
   * Never throws: a profile that cannot be read is an empty list, which the
   * base's `unavailableReason` contract already covers as "nothing to resume"
   * only when this adapter says so. It cannot say so falsely here — the scan
   * treats an unreadable directory as absent, which is the same answer the user
   * would get from the CLI.
   */
  override async listSessions(
    input: AgentSessionsInput,
  ): Promise<AgentSessionListing> {
    const { sessions, searchTruncated, searchFileLimit } =
      await listClaudeSessions({
        profileDir: this.profileDir(input.configDir),
        cwd: input.cwd,
        limit: input.limit,
        query: input.query,
      });
    return {
      sessions,
      unavailableReason: null,
      // A bounded search that says nothing is indistinguishable from one that
      // read every conversation and found these — see the file cap's own note.
      partialReason: searchTruncated
        ? `Searched what was said in the ${searchFileLimit} most recent conversations.`
        : null,
    };
  }

  /**
   * Nothing to do, and the reason is worth stating: this CLI resumes by id out
   * of the same profile the listing read, and the run carries that profile as
   * its own `configDir`. So the session is already where the turn will look for
   * it — unlike cursor, whose turns run under a profile of geniro's own making.
   */
  override prepareSessionImport(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Bring the conversation with the run when it is repointed at another
   * account, so the next turn resumes it rather than starting over.
   *
   * The mechanism is a file copy inside this CLI's own store, which is the
   * whole of what a resume needs here — see `carryClaudeSession` for the probe
   * that established it and for why the target directory is the source's own
   * name rather than one composed from the cwd.
   */
  override carrySessionToConfigDir(
    input: CarrySessionInput,
  ): Promise<CarrySessionResult> {
    return carryClaudeSession({
      sessionId: input.sessionId,
      fromProfileDir: this.profileDir(input.from),
      toProfileDir: this.profileDir(input.to),
    });
  }

  /**
   * The transcript is a file in the profile, so deleting it is a file delete —
   * kept, by `deleteClaudeSession`, when it began before the run, i.e. was
   * imported from the user's own terminal.
   */
  override deleteSessionTranscript(
    input: DeleteSessionTranscriptInput,
  ): Promise<DeleteSessionTranscriptResult> {
    return deleteClaudeSession({
      profileDir: this.profileDir(input.configDir),
      sessionId: input.sessionId,
      notBefore: input.runCreatedAt,
    });
  }

  /**
   * This CLI's per-project settings can name a config directory of their own,
   * and the CLI applies it to itself — so geniro's env var is not the last
   * word. The whole measurement is in `readClaudeConfigDirPin`'s doc block.
   */
  override readConfigDirPin(cwd: string): ConfigDirPin | null {
    return readClaudeConfigDirPin(cwd);
  }

  /**
   * The stored transcript, mapped by the same function that maps a live turn's
   * stdout — the session JSONL is that stream, appended to a file.
   */
  override readSessionHistory(
    input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    return readClaudeSessionHistory({
      profileDir: this.profileDir(input.configDir),
      sessionId: input.sessionId,
      limit: input.limit,
    });
  }

  override recoverSubagent(
    ref: SubagentRecoveryRef,
  ): Promise<RecoveredSubagentOutcome | null> {
    return recoverClaudeSubagent(this.profileDir(ref.configDir), ref);
  }

  /** The `pr-link` lines the session's transcript carries. */
  override readSessionPullRequests(
    input: SessionPullRequestsInput,
  ): Promise<SessionPullRequest[]> {
    return readClaudeSessionPullRequests(
      this.profileDir(input.configDir),
      input.sessionId,
    );
  }

  /**
   * The profile a session lives in: the run's own config directory, or this
   * CLI's default `~/.claude` when it names none.
   *
   * The default is spelled here rather than taken from `configDir.envVar`,
   * which only says how a directory is HANDED to the CLI and not where the CLI
   * keeps one when nobody does.
   */
  private profileDir(configDir: string | null): string {
    return (
      configDir ??
      join(this.claudeOptions.homeDir ?? homedir(), CLAUDE_DEFAULT_PROFILE_DIR)
    );
  }

  /**
   * claude DOES have a listing subcommand, so this shells out — and it is the
   * one utility command that needs `processGroup`
   * ({@link AgentCommandOptions.processGroup} says why).
   *
   * A null stdout is the command having FAILED — missing binary, non-zero
   * exit, or the deadline — and is reported as such rather than as an empty
   * listing. The distinction is load-bearing downstream: an empty listing is
   * cached and shown as "no servers", which would be a lie about the user's
   * configuration for as long as the entry lives.
   *
   * Output is prose (the CLI rejects `--json`), so the parse is deliberately
   * forgiving and lives in its own pure function.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    // Taken under the SAME profile the turn will run as: a config directory is
    // where claude keeps its configured MCP servers, so a listing read from
    // the default profile would describe servers this run never loads. It
    // rides the env for the same reason the turn's does — the CLI has no flag
    // for it.
    const stdout = await this.runCommand([...CLAUDE_MCP_LIST_ARGS], {
      ...options,
      cwd: input.cwd,
      processGroup: true,
      timeoutMs: options.timeoutMs ?? CLAUDE_MCP_LIST_TIMEOUT_MS,
      ...(input.configDir
        ? { env: { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } }
        : {}),
    });
    if (stdout === null) {
      return { ok: false, reason: CLAUDE_MCP_LIST_FAILED_MESSAGE };
    }
    const servers = parseMcpList(stdout);
    if (servers.length === 0 && !stdout.includes(CLAUDE_MCP_EMPTY_MARKER)) {
      // The CLI answered, but nothing in what it said looked like a row and it
      // did not say the folder was empty either. Reporting that as an empty
      // listing would let it be cached and shown as "no servers" — the
      // confident lie the whole ok/err split exists to prevent, and the one a
      // reworded row format would otherwise produce silently.
      return { ok: false, reason: CLAUDE_MCP_LIST_UNREADABLE_MESSAGE };
    }
    return { ok: true, servers };
  }

  /**
   * What claude's own files say about a folder, which is what decides whether
   * a row may carry a switch at all. Both reads are best-effort and neither
   * writes anything — see `utils/claude-mcp-folder.utils.ts` for the probe
   * evidence behind the two questions.
   */
  override async readMcpFolderFacts(
    cwd: string,
    configDir: string | null,
  ): Promise<AgentMcpFolderFacts> {
    // The PROFILE's own root when the run names one: a profile is a separate
    // ACCOUNT with its own config, so reading the home one describes servers
    // this run never loads (measured on a real pair — 6 declared in the profile
    // against 3 at home, and the panel was composed from the 3).
    //
    // The two files do NOT move together, which is why this is two expressions
    // rather than one root. `.claude.json` sits at the root of either, while
    // the settings file is `~/.claude/settings.json` at home and
    // `<profile>/settings.json` in a profile — `CLAUDE_CONFIG_DIR` names the
    // directory `~/.claude` otherwise IS, so the segment is already spent.
    const home = this.claudeOptions.homeDir ?? homedir();
    const configRoot = configDir ?? home;
    const homeSettingsPath =
      configDir === null
        ? join(home, CLAUDE_HOME_SETTINGS_FILE)
        : join(configDir, CLAUDE_PROFILE_SETTINGS_FILE);
    const settingsSources = await Promise.all([
      ...CLAUDE_PROJECT_SETTINGS_FILES.map((rel) =>
        readFileSafe(join(cwd, rel)),
      ),
      readFileSafe(homeSettingsPath),
    ]);
    // Where answering "No" to the CLI's own trust prompt lands — a different
    // file and a different shape from the settings ones, but the same
    // question, and the ordinary way a user switches a project server off.
    const homeConfig = await readFileSafe(
      join(configRoot, CLAUDE_MODEL_CACHE_FILE),
    );
    // The third scope's own file. Read HERE rather than folded into the
    // settings batch above because it answers a different question: those
    // carry rejection lists, this carries definitions.
    const projectMcp = await readFileSafe(join(cwd, CLAUDE_PROJECT_MCP_FILE));
    const parsedHome = homeConfig === null ? null : parseHomeConfig(homeConfig);
    // The key the CLI files this folder's `projects` entry under — the
    // REPOSITORY (the main one, for a worktree), not the cwd. See
    // `claudeProjectKey`; reading the cwd's entry described a list the CLI
    // never consults, so the panel and the turn disagreed about which servers
    // were off.
    const projectKey = await claudeProjectKey(cwd);
    // Union, because that is how the CLI itself combines them: a name in ANY
    // of these is one geniro cannot pull back out.
    const userDisabled = new Set<string>();
    for (const source of settingsSources) {
      if (source !== null) {
        for (const name of parseDisabledServerNames(source)) {
          userDisabled.add(name);
        }
      }
    }
    if (homeConfig !== null) {
      for (const name of parseHomeDisabledServerNames(homeConfig, projectKey)) {
        userDisabled.add(name);
      }
    }
    return {
      // All three scopes, deduped BY NAME because that is how the CLI merges
      // them: `claude mcp list` prints one row per name whichever scope won,
      // so a name defined twice must not become two rows here either.
      configured: [
        ...new Set([
          ...(parsedHome === null
            ? []
            : readConfiguredServers(parsedHome, projectKey)),
          ...(projectMcp === null ? [] : parseProjectServerNames(projectMcp)),
        ]),
      ],
      // The CLI's OWN per-folder list — the state its `/mcp` panel shows and
      // the one `setMcpServerEnabled` writes. Servers of every scope.
      disabled:
        parsedHome === null ? [] : readDisabledServers(parsedHome, projectKey),
      // A `.mcp.json` REJECTION, which is a different question and one geniro
      // cannot undo: the CLI unions every source's copy of that list.
      lockedOff: [...userDisabled],
      // UNSTATED for this CLI, and that is a gap rather than a claim — worth
      // recording what was and was not checked. claude has FOUR scopes (user,
      // project, local, dynamic) against cursor's two, and `claude mcp list`
      // prints none of them (probe-verified on 2.1.220, which is why this
      // method exists at all). Placing a row would mean re-deriving the CLI's
      // own precedence across four sources, and a wrong answer here is worse
      // than none: the label's whole job is to explain a surprise, so one that
      // named the wrong scope would manufacture a new one. Cursor's two-file
      // merge was measured end to end, so it answers; this waits for the same
      // treatment.
      origins: {},
      // The static sentence in `getConfig()` stands: claude's own-app-only
      // servers are two fixed built-ins, not a set that varies per machine.
      interactiveOnlyNote: null,
      plugins: [],
    };
  }

  /**
   * Dial ONE server, so a row the user just switched on can say what it found.
   *
   * `claude mcp get <name>` health-checks by the CLI's own documentation, and
   * costs one server's dial where the folder listing costs all of them
   * ({@link CLAUDE_MCP_GET_ARGS} carries the captures and the timings).
   *
   * Taken under the run's own profile for the same reason the listing is: a
   * config directory is where this CLI keeps its configured servers, so a probe
   * read from the default profile would report on a server this run never loads.
   *
   * `processGroup` because it DIALS — a stdio server is launched as a grandchild
   * — and no `captureDiagnosis`, unlike cursor's twin: this CLI prints the status
   * line on stdout and exits 0 for every configured server, so the one exit-1
   * case is a server that is not there at all, and its message carries nothing a
   * row could say.
   *
   * Never throws: an unreadable answer is null, and the row's health stays
   * unstated rather than guessed.
   */
  override async readMcpServerHealth(
    input: AgentMcpServerHealthInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    const stdout = await this.runCommand(
      [...CLAUDE_MCP_GET_ARGS, input.server],
      {
        ...options,
        cwd: input.cwd,
        processGroup: true,
        timeoutMs: options.timeoutMs ?? CLAUDE_MCP_GET_TIMEOUT_MS,
        ...(input.configDir
          ? { env: { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } }
          : {}),
      },
    );
    return parseMcpGetHealth(stdout);
  }

  /** Every `memory/*.md` note of the profile's projects (`claude-memory.utils.ts`). */
  override async readNativeMemory(
    configDir: string | null,
  ): Promise<NativeMemoryReading> {
    const profile = this.profileDir(configDir);
    return { location: profile, notes: await readClaudeMemoryNotes(profile) };
  }

  /**
   * A folder's notes sit under its flattened path, as its sessions do; claude
   * files a repository's notes under its git root, so a project in a
   * subfolder matches nothing and its notes are offered as global.
   */
  override nativeMemoryProjectKey(folder: string): string {
    return claudeProjectDirName(folder);
  }

  /** The key this CLI files a folder's MCP switches under (`claudeProjectKey`). */
  override mcpRepositoryKey(cwd: string): Promise<string> {
    return claudeProjectKey(cwd);
  }

  /**
   * Delete these servers' entries from the profile's needs-auth record
   * ({@link CLAUDE_MCP_NEEDS_AUTH_CACHE_FILE}), the one thing that keeps a
   * connector the user has signed in to out of every new session.
   *
   * Only those keys go; every other entry stays, since each still describes a
   * server that really answered 401. A file that cannot be read or parsed is
   * left alone and answers none — this is a cache, so a wrong guess about its
   * shape must not replace it. No lock: the CLI serializes its own writes to
   * this file in-process only, and it is a cache it rebuilds on the next 401.
   * The fallback mode never applies: a file must exist to hold an entry, and
   * `preserveTarget` keeps the mode it already has.
   */
  override forgetMcpNeedsAuth(input: {
    servers: readonly string[];
    configDir: string | null;
  }): Promise<readonly string[]> {
    const next = this.needsAuthWrites.then(() =>
      this.rewriteNeedsAuthRecord(input.servers, input.configDir),
    );
    this.needsAuthWrites = next.catch(() => undefined);
    return next;
  }

  private async rewriteNeedsAuthRecord(
    servers: readonly string[],
    configDir: string | null,
  ): Promise<readonly string[]> {
    const file = join(
      this.profileDir(configDir),
      CLAUDE_MCP_NEEDS_AUTH_CACHE_FILE,
    );
    const read = await readConfigForRewrite(file);
    if (!read.ok) {
      return [];
    }
    const forgotten = servers.filter((server) =>
      Object.hasOwn(read.config, server),
    );
    if (forgotten.length === 0) {
      return [];
    }
    const rest = { ...read.config };
    for (const server of forgotten) {
      delete rest[server];
    }
    await atomicWrite(file, JSON.stringify(rest), {
      preserveTarget: { fallbackMode: CLAUDE_CONFIG_FILE_FALLBACK_MODE },
    });
    return forgotten;
  }

  /**
   * Name the conversation by asking the CLI, since it writes no title itself.
   *
   * A throwaway `-p` turn, in its own temporary folder and with the user's MCP
   * servers withheld. The folder matters as much as the flags: a project's
   * `CLAUDE.md` — or, where it has none, its `AGENTS.md` — is loaded from the
   * cwd, and this repository's is 40KB that would be billed to every chat that
   * gets named — so the naming turn is
   * rooted nowhere in particular, which is also why it can be told nothing
   * about the run beyond the words it is titling.
   *
   * On the run's OWN profile (`configDir`), because that is which account is
   * billed and which one is signed in.
   *
   * Never throws: `runCommand` answers null for a missing binary, a timeout and
   * a non-zero exit alike, and an unreadable reply is null too.
   */
  override async generateTitle(
    input: AgentTitleInput,
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    const dir = await mkdtemp(join(tmpdir(), CLAUDE_TITLE_DIR_PREFIX));
    try {
      await this.validateModel(input.model);
      const local = this.modelConfiguration(input.model);
      const stdout = await this.runCommand(
        [
          ...CLAUDE_TITLE_ARGS,
          CLAUDE_MODEL_FLAG,
          local.args.length ? local.model! : CLAUDE_TITLE_MODEL,
          ...local.args,
          titlePrompt(input),
        ],
        {
          ...options,
          cwd: dir,
          timeoutMs: options.timeoutMs ?? CLAUDE_TITLE_TIMEOUT_MS,
          endStdin: true,
          env: {
            ...options.env,
            ...this.configDirEnv(input.configDir),
            ...local.env,
          },
        },
      );
      return readClaudeTitleReply(stdout);
    } catch {
      return null;
    } finally {
      // Best-effort, like every other scratch removal here: a directory left
      // behind costs a few bytes in the system temp dir, and a throw would turn
      // a title that WORKED into a logged failure.
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** A throwaway `-p` turn isolated like {@link generateTitle}'s. */
  override async askOnce(
    input: AgentAskInput,
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    const dir = await mkdtemp(join(tmpdir(), CLAUDE_ASK_DIR_PREFIX));
    try {
      await this.validateModel(input.model);
      const local = this.modelConfiguration(input.model);
      const stdout = await this.runCommand(
        [
          ...CLAUDE_TITLE_ARGS,
          CLAUDE_MODEL_FLAG,
          local.args.length
            ? local.model!
            : (input.model ?? CLAUDE_TITLE_MODEL),
          ...(input.effort ? [CLAUDE_EFFORT_FLAG, input.effort] : []),
          ...local.args,
          ...claudeSettingsArgs({
            modelParameters: input.modelParameters,
            env: local.env,
          }),
          input.prompt,
        ],
        {
          ...options,
          cwd: dir,
          timeoutMs: options.timeoutMs ?? CLAUDE_ASK_TIMEOUT_MS,
          endStdin: true,
          env: {
            ...options.env,
            ...this.configDirEnv(input.configDir),
            ...local.env,
          },
        },
      );
      return readClaudeResultText(stdout);
    } catch {
      return null;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Switch one server for one folder by editing the CLI's own config.
   *
   * `projects[<key>].disabledMcpServers` in `~/.claude.json` — probe-verified
   * on 2.1.222 (see `claude.const.ts`): a name there makes the next turn report
   * that server `disabled` instead of dialling it, whatever scope defined it.
   * The key is the CLI's own project key for the folder
   * ({@link claudeProjectKey}) — the repository root, and for a worktree the
   * MAIN repository — never the cwd itself, which the CLI does not read.
   *
   * Taken under `proper-lockfile` at `<config>.lock`, which is the SAME lock
   * the CLI takes for its own writes (its `ELOCKED` / `Config lock compromised`
   * strings are that package's). Without it a concurrent `claude` write and
   * this one would be a read-modify-write race over a file holding the user's
   * whole CLI state — a lost update there is real data loss, not a lost toggle.
   *
   * Written the way the CLI writes it (`atomicWrite`'s `preserveTarget`): the
   * file keeps its own permission bits (0600 when it is new), a symlinked
   * config is written through rather than replaced, and the bytes are synced
   * before the rename.
   */
  override async setMcpServerEnabled(
    cwd: string,
    server: string,
    enabled: boolean,
    options: AgentCommandOptions = {},
  ): Promise<void> {
    // The PROFILE's own root when the caller names one — `modelCacheDir`, the
    // same resolver `readMcpFolderFacts` reads this file through, so the write
    // lands in the file the panel's rows came from. It was the home dir
    // unconditionally, which made the toggle a silent no-op under a custom
    // config directory: the panel listed the profile's servers and the switch
    // edited `~/.claude.json`, so the profile was unchanged and the DEFAULT
    // account's disabled list was rewritten instead.
    const file = this.homeConfigFile(options.configDir ?? null);
    const projectKey = await claudeProjectKey(cwd);
    await this.rewriteHomeConfig(file, `switching ${server}`, (config) => {
      const next = withDisabledServer(
        config as ClaudeHomeConfig,
        projectKey,
        server,
        enabled,
      );
      // Already in that state — never rewrite the user's config.
      return next === config ? null : (next as Record<string, unknown>);
    });
  }

  /** The profile's `.claude.json` — `modelCacheDir`, the one resolver for it. */
  private homeConfigFile(configDir: string | null): string {
    return join(this.modelCacheDir(configDir), CLAUDE_MODEL_CACHE_FILE);
  }

  /**
   * The profile's user-scope servers — `mcpServers` at the TOP of its
   * `.claude.json`, and nothing else from that file, which holds the user's
   * whole CLI state (their history, their account record, every project's
   * settings). Read strictly, like a rewrite: the editor is about to offer a
   * Save, and a document that cannot be written back is a reason now rather
   * than a refusal after the user has typed.
   */
  override async readMcpConfigDocument(input: {
    configDir: string | null;
  }): Promise<AgentMcpConfigDocument> {
    const file = this.homeConfigFile(input.configDir);
    const read = await readConfigForRewrite(file);
    if (!read.ok) {
      return {
        servers: null,
        path: file,
        version: null,
        unavailableReason: read.reason,
      };
    }
    const section = readMcpServersKey(
      read.config,
      CLAUDE_MCP_SERVERS_KEY,
      file,
    );
    return section.ok
      ? {
          servers: section.servers,
          path: file,
          version: mcpServersVersion(section.servers),
          unavailableReason: null,
        }
      : {
          servers: null,
          path: file,
          version: null,
          unavailableReason: section.reason,
        };
  }

  /**
   * Replace the profile's `mcpServers` and nothing else, under the lock the
   * CLI takes and with the write discipline {@link setMcpServerEnabled}
   * follows. The version is re-checked INSIDE the lock: the editor's copy may
   * be minutes old, and a `claude mcp add` in the user's terminal since then is
   * refused rather than undone.
   */
  override async writeMcpConfigDocument(
    input: AgentMcpConfigWriteInput,
  ): Promise<AgentMcpConfigWriteResult> {
    const file = this.homeConfigFile(input.configDir);
    let refusal: string | null = null;
    const changed = await this.rewriteHomeConfig(
      file,
      'editing its MCP servers',
      (config) => {
        const section = readMcpServersKey(config, CLAUDE_MCP_SERVERS_KEY, file);
        if (!section.ok) {
          refusal = section.reason;
          return null;
        }
        if (mcpServersVersion(section.servers) !== input.expectedVersion) {
          refusal = MCP_CONFIG_MOVED_REASON;
          return null;
        }
        if (isDeepStrictEqual(section.servers, input.servers)) {
          return null;
        }
        return { ...config, [CLAUDE_MCP_SERVERS_KEY]: input.servers };
      },
    );
    return refusal === null
      ? { ok: true, changed }
      : { ok: false, reason: refusal };
  }

  /**
   * `claude mcp add -s user` under the profile's `CLAUDE_CONFIG_DIR` —
   * {@link CLAUDE_MCP_ADD_ARGS} carries the probe. A name the profile already
   * defines is refused here first, in geniro's words; the CLI would refuse it
   * too, but in a sentence that does not say what to do instead.
   *
   * Success is read off the EFFECT, not the exit: the entry has to be in the
   * file afterwards. A failure carries the CLI's own output (it is the only
   * reason there is), which is why every env and header VALUE was registered
   * for redaction by the caller before this ran.
   */
  override async addMcpServer(
    input: AgentMcpServerAddInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigWriteResult> {
    const { server } = input;
    const before = await this.readMcpConfigDocument({
      configDir: input.configDir,
    });
    if (before.servers === null) {
      return {
        ok: false,
        reason: before.unavailableReason ?? 'the profile could not be read',
      };
    }
    if (Object.hasOwn(before.servers, server.name)) {
      return { ok: false, reason: mcpServerExistsReason(server.name) };
    }
    const args = [
      ...CLAUDE_MCP_ADD_ARGS,
      ...(server.transport === 'http'
        ? [CLAUDE_MCP_ADD_TRANSPORT_FLAG, 'http']
        : []),
      ...Object.entries(server.env).flatMap(([key, value]) => [
        CLAUDE_MCP_ADD_ENV_FLAG,
        `${key}=${value}`,
      ]),
      ...Object.entries(server.headers).flatMap(([key, value]) => [
        CLAUDE_MCP_ADD_HEADER_FLAG,
        `${key}: ${value}`,
      ]),
      '--',
      server.name,
      ...(server.transport === 'http'
        ? [server.url ?? '']
        : [server.command ?? '', ...server.args]),
    ];
    const output = await this.runCommand(args, {
      ...options,
      captureDiagnosis: true,
      timeoutMs: options.timeoutMs ?? CLAUDE_MCP_ADD_TIMEOUT_MS,
      ...(input.configDir
        ? { env: { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } }
        : {}),
    });
    const after = await this.readMcpConfigDocument({
      configDir: input.configDir,
    });
    if (after.servers !== null && Object.hasOwn(after.servers, server.name)) {
      return { ok: true, changed: true };
    }
    const said = output?.trim() ?? '';
    return {
      ok: false,
      reason:
        said === ''
          ? 'claude did not add the server and said nothing about why'
          : `claude did not add the server: ${said.slice(-500)}`,
    };
  }

  /**
   * One read-modify-write of the profile's `.claude.json`, under the lock the
   * CLI takes and written the way the CLI writes it — the discipline every
   * geniro edit of that file shares, so a second editor cannot come to skip
   * half of it. `edit` answers the next config, or null for "write nothing";
   * the answer is whether a write happened.
   *
   * Taken under `proper-lockfile` at `<config>.lock`, which is the SAME lock
   * the CLI takes for its own writes (its `ELOCKED` / `Config lock compromised`
   * strings are that package's). Without it a concurrent `claude` write and
   * this one would be a read-modify-write race over a file holding the user's
   * whole CLI state — a lost update there is real data loss, not a lost toggle.
   *
   * Written the way the CLI writes it (`atomicWrite`'s `preserveTarget`): the
   * file keeps its own permission bits (0600 when it is new), a symlinked
   * config is written through rather than replaced, and the bytes are synced
   * before the rename.
   */
  private async rewriteHomeConfig(
    file: string,
    what: string,
    edit: (config: Record<string, unknown>) => Record<string, unknown> | null,
  ): Promise<boolean> {
    const release = await lock(file, {
      lockfilePath: `${file}${CLAUDE_CONFIG_LOCK_SUFFIX}`,
      retries: CLAUDE_CONFIG_LOCK_RETRIES,
      // The lock path is named outright, so resolving `file` buys nothing —
      // and the package's default `realpath: true` REJECTS with ENOENT for a
      // profile that has no `.claude.json` yet, which is exactly the file this
      // write is about to create.
      realpath: false,
      // The package's default THROWS from a timer, which is an uncaught
      // exception and takes the whole daemon down (`crash-guards.ts` SIGTERMs
      // it) over a lock another claude process merely held too long. The CLI
      // passes its own handler for the same reason and logs it.
      onCompromised: (err: Error) => {
        this.options.logger?.warn(
          `claude config lock compromised while ${what}: ${err.message}`,
        );
      },
    });
    try {
      // Re-read INSIDE the lock: whatever the panel last listed may be minutes
      // old, and the CLI may have written since. STRICT, unlike the reader:
      // this file holds the user's entire CLI state — their history, their
      // account record, every project's settings — so one that cannot be read
      // is refused rather than rewritten as `{projects: {...}}`.
      const read = await readConfigForRewrite(file);
      if (!read.ok) {
        throw new Error(read.reason);
      }
      const next = edit(read.config);
      if (next === null) {
        return false;
      }
      // tmp+rename, so a crash mid-write cannot truncate the file holding the
      // user's whole CLI state. The lock covers concurrent WRITERS; this
      // covers the process dying between them.
      await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, {
        preserveTarget: { fallbackMode: CLAUDE_CONFIG_FILE_FALLBACK_MODE },
        fsync: true,
      });
      return true;
    } finally {
      // A compromised lock rejects its release; the write above has already
      // landed or thrown on its own, so this is logged rather than allowed to
      // turn a toggle that took into a failure the user would undo.
      await release().catch((err: unknown) => {
        this.options.logger?.warn(
          `releasing the claude config lock failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  protected buildArgs(input: AgentTurnInput): string[] {
    const args = [...CLAUDE_BASE_ARGS];
    if (input.streamPartials) {
      args.push(CLAUDE_PARTIAL_MESSAGES_FLAG);
    }
    if (input.model) {
      args.push(CLAUDE_MODEL_FLAG, this.modelConfiguration(input.model).model!);
    }
    if (input.effort) {
      // An unknown value here is not fatal — the CLI warns and runs on its own
      // default — but the caller has already refused anything outside
      // `listEfforts()`, so the flag only carries a level claude accepts.
      args.push(CLAUDE_EFFORT_FLAG, input.effort);
    }
    // Fast mode, the reply language and an Ollama model's env, in the one
    // object `claudeSettingsArgs` builds. Fast mode is checked against nothing
    // here for the same reason `listEfforts` guards effort:
    // `listModelParameters` already withholds the row from a model that cannot
    // use it, so a value reaching this field is one the caller offered honestly.
    args.push(...this.settingsArgs(input));
    // Before the resume flag deliberately: the window this asks for governs the
    // conversation being resumed, not just what is said this turn.
    args.push(...this.autoCompactArgs(input));
    if (input.resumeSessionId) {
      args.push(CLAUDE_RESUME_FLAG, input.resumeSessionId);
      // argv is built only for a process about to START, so this is the one
      // moment the restored totals are known to apply: the process resumes the
      // session from its transcript's last `cost-state`, and its first result
      // is that figure plus the turn. Registered here, read at its `init`.
      this.seedRestoredCost(input);
    }
    // Claude's endpoint is a per-turn config file `prepareTurn` writes from
    // this same field, so having it IS the grant.
    // `isolateMcpServers` WITHHOLDS the config below, geniro's own call server
    // included — so a turn carrying both would be told to route work through
    // `call_agent` with no such tool registered, which the adapter rules call
    // out by name as silent by construction. Nothing sets the two together
    // today; saying so here is what keeps that true if something ever does.
    const granted = Boolean(input.mcpEndpoint) && !input.isolateMcpServers;
    const systemPromptPath = this.systemPromptPaths.get(input);
    if (systemPromptPath) {
      args.push(CLAUDE_APPEND_SYSTEM_PROMPT_FILE_FLAG, systemPromptPath);
    } else {
      const systemPrompt = this.composeSystemPrompt(input, granted);
      if (systemPrompt) {
        args.push(CLAUDE_APPEND_SYSTEM_PROMPT_FLAG, systemPrompt);
      }
    }
    if (this.spawnsOnPermissionDialogue(input)) {
      // acceptEdits/plan map by name. `ask` is the CLI's `default`, and so is
      // an auto turn that must be able to ask: `--dangerously-skip-permissions`
      // strips AskUserQuestion (it leaves the turn no channel to ask on), so
      // that turn spawns on the dialogue instead. Unattended semantics are not
      // lost — the DAEMON becomes the bypass, auto-approving every plain
      // permission request at its approval seam and reserving the human card
      // for genuine questions.
      args.push(
        CLAUDE_PERMISSION_MODE_FLAG,
        input.approvalMode === 'ask' || input.approvalMode === 'auto'
          ? CLAUDE_PERMISSION_MODE_DEFAULT
          : (input.approvalMode ?? CLAUDE_PERMISSION_MODE_DEFAULT),
      );
      args.push(
        CLAUDE_PERMISSION_PROMPT_TOOL_FLAG,
        CLAUDE_PERMISSION_PROMPT_TOOL_STDIO,
      );
    } else if (input.approvalMode === 'auto') {
      args.push(CLAUDE_SKIP_PERMISSIONS_FLAG);
    }
    // claude's own tools geniro replaces, and a team member's switched-off
    // servers, ride one variadic `--disallowedTools`; geniro's own server is
    // filtered out inside. The settings deny list (`settingsArgs`) keeps a
    // switched-off server from starting; these rules are the second fence.
    if (input.readOnly === true) {
      args.push(CLAUDE_TOOLS_FLAG, CLAUDE_READ_ONLY_TOOLS.join(','));
    }
    args.push(
      ...claudeDisallowedToolArgs(
        this.switchedOffServers(input),
        input.mcpEndpoint?.serverName ?? null,
      ),
    );
    if (input.isolateMcpServers) {
      // The one path that passes the strict flag. Without it the probe loads
      // every server the folder defines just to have them reaped a moment
      // later, and the reap reaches the user's OWN running servers.
      args.push(CLAUDE_MCP_CONFIG_FLAG, CLAUDE_EMPTY_MCP_CONFIG);
      args.push(CLAUDE_STRICT_MCP_CONFIG_FLAG);
      return args;
    }
    const mcpConfigPath = this.mcpConfigPaths.get(input);
    if (mcpConfigPath) {
      // Deliberately WITHOUT `--strict-mcp-config`. An agent must see the same
      // MCP servers a fresh claude session in that folder sees, PLUS geniro's
      // call surface — they combine. Restricting the turn to our config alone
      // would also make the MCP switch meaningless for a caller member, since
      // there would be no project servers loaded to switch off. What keeps the
      // two unambiguous is the NAME: geniro's server carries this run's id, so
      // it cannot be one the user has already given a server of their own.
      args.push(CLAUDE_MCP_CONFIG_FLAG, mcpConfigPath);
      if (input.readOnly === true) {
        args.push(CLAUDE_STRICT_MCP_CONFIG_FLAG);
      }
    }
    return args;
  }

  protected override buildEnv(
    input: AgentTurnInput,
  ): Record<string, string> | undefined {
    // The strip removes the daemon's inherited Anthropic credentials from every
    // child; re-inject them for THIS child only (another agent and its tool
    // grandchildren never see them). An explicit input.env wins.
    //
    // The run's config directory rides here too, and ONLY here: it is what
    // decides which account (which subscription) the turn runs as, plus the
    // settings, plugins and history it sees. Set BEFORE `input.env` for the
    // same reason the credentials are — an explicit per-call env stays the
    // last word.
    const env = {
      ...this.inheritedEnv(),
      // Two tool families this CLI's headless mode drops and its interactive
      // one keeps — its artifact publisher and its own task list, the latter
      // feeding a transcript card geniro already renders. See their constants.
      // Before `input.env` like everything else here, so a caller can still
      // take either back off.
      [CLAUDE_ARTIFACT_ENV]: '1',
      [CLAUDE_TODO_TOOLS_ENV]: '1',
      // The CLI's own "this turn is over" (`system/session_state_changed`),
      // which is what ends a turn held for a background delegate without a
      // timer — see `CLAUDE_SESSION_STATE_SUBTYPE`.
      [CLAUDE_SESSION_STATE_EVENTS_ENV]: '1',
      // Claude in Chrome, only when the user switched it on: 22 tool schemas
      // in every prompt, useless without their browser extension.
      ...(this.agentOption(input, CLAUDE_BROWSER_TOOLS_OPTION)
        ? { [CLAUDE_BROWSER_TOOLS_ENV]: '1' }
        : {}),
      // A run that switches native memory off keeps one memory, geniro's,
      // rather than two that disagree.
      ...(input.nativeMemoryOff === true
        ? { [CLAUDE_DISABLE_AUTO_MEMORY_ENV]: '1' }
        : {}),
      ...(input.configDir ? { [CLAUDE_CONFIG_DIR_ENV]: input.configDir } : {}),
      ...input.env,
    };
    if (!input.mcpEndpoint) {
      return env;
    }
    return {
      ...env,
      [CLAUDE_MCP_TOOL_TIMEOUT_ENV]: String(
        input.mcpEndpoint.toolTimeoutMs ?? CLAUDE_MCP_TOOL_TIMEOUT_MS,
      ),
    };
  }

  protected override buildStdinPayload(input: AgentTurnInput): string {
    return this.userMessageLine(input.prompt, input.images);
  }

  /**
   * A message typed while this turn was already running, delivered INTO it.
   *
   * The same line the turn opened with, which is the whole trick: the CLI's
   * stream-json stdin is a conversation, not a one-shot argument, so a second
   * `{"type":"user"}` on a still-open stdin is picked up at the next tool
   * boundary of the turn in flight. Probe-verified on 2.1.222 — a message sent
   * 8 seconds into a 20-second command was acted on at 29 seconds, in the same
   * process. Holding it until the process exits instead (which is what a queue
   * draining on settle does) turns "as soon as possible" into "after
   * everything finishes", and the CLI itself does not behave that way.
   *
   * Reachable only while stdin is open — `keepStdinOpen` is true for every
   * chat turn, since `allowUserQuestions` is set there. A turn spawned without
   * it writes into a closed pipe and `sendUserMessage` reports false, which is
   * exactly the answer the caller needs to keep the message queued.
   */
  protected override buildFollowUpPayload(message: FollowUpMessage): string {
    return this.userMessageLine(message.text, message.images);
  }

  /**
   * One process can serve a whole run's worth of turns — probe-verified on
   * 2.1.223: two user messages written to one still-open stdin produced two
   * `result` lines under ONE `session_id`, and the process exited only when
   * stdin was closed. `system/init` is re-emitted at the head of each turn, so
   * the session saver and the MCP harvest keep seeing what they read today.
   *
   * Every turn that carries the dialogue, and every `auto` turn without it:
   * a kept process is what holds a turn — and the call it answers — while its
   * background sub-agents run, which is what the background-work note tells
   * the agent to rely on. An `auto` team member spawned one-shot with its
   * stdin closed got none of that: it settled on its launching result and
   * passed "the reviewers are running" downstream. Its stdin carries no
   * dialogue, so the base serves a later turn in another mode on a fresh
   * spawn rather than re-moding it.
   */
  protected override canHostSession(input: AgentTurnInput): boolean {
    return this.keepStdinOpen(input) || input.approvalMode === 'auto';
  }

  /**
   * The turn's settings object rides {@link CLAUDE_SETTINGS_FLAG} — argv, like
   * everything else the base key already covers — so a kept process spawned without it cannot
   * serve a turn that just asked for it, and the reverse: a flip must
   * respawn rather than silently keep running on the value the process
   * started with.
   */
  protected override sessionKey(input: AgentTurnInput): string {
    return JSON.stringify([
      super.sessionKey(input),
      this.settingsArgs(input).join(' '),
    ]);
  }

  private settingsArgs(input: AgentTurnInput): string[] {
    return claudeSettingsArgs({
      modelParameters: input.modelParameters,
      replyLanguage: input.replyLanguage,
      env: this.modelConfiguration(input.model).env,
      // Sorted, so a reordered list reads as the same settings (`sessionKey`).
      deniedMcpServers: claudeSwitchedOffServers(
        this.switchedOffServers(input),
        input.mcpEndpoint?.serverName ?? null,
      ).sort(),
    });
  }

  /**
   * The servers this turn runs without: a team member's own switches, plus
   * claude's built-in server on a read-only turn, which the turn withholds.
   */
  private switchedOffServers(
    input: AgentTurnInput,
  ): readonly string[] | undefined {
    return input.readOnly === true
      ? [...(input.mcpDisabled ?? []), ...CLAUDE_BUILT_IN_MCP_SERVERS]
      : input.mcpDisabled;
  }

  /**
   * The next turn opens with the SAME user line the first one did — a
   * stream-json stdin is a conversation, so the CLI reads a `{"type":"user"}`
   * arriving after a `result` as the next prompt rather than as an addition to
   * the last one. Third caller of the one encoder, so the three cannot drift.
   */
  protected override buildNextTurnPayload(message: FollowUpMessage): string {
    return this.userMessageLine(message.text, message.images);
  }

  /**
   * Stop the turn without stopping the process.
   *
   * Probe-verified on 2.1.223: `control_request`/`interrupt` was acknowledged
   * in 2ms and the turn ended with `result subtype=error_during_execution`,
   * the process still alive. That is what lets Stop leave the run's MCP
   * servers — and a browser one of them owns — running.
   *
   * Offered wherever stdin can still be open — a kept `auto` process
   * included: on 2.1.295 one spawned under `--dangerously-skip-permissions`
   * answered this request `success` and went on to serve the next prompt. A
   * one-shot turn's stdin is already closed, so the write fails and the turn
   * is stopped by killing its group, as before.
   */
  protected override buildInterruptPayload(
    input: AgentTurnInput,
  ): string | undefined {
    if (!this.canHostSession(input)) {
      return undefined;
    }
    return `${JSON.stringify({
      type: 'control_request',
      // Namespaced away from the CLI's own request ids, like the mode change
      // below: both id spaces share this one dialogue, and nothing here
      // correlates a reply.
      request_id: `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}${CLAUDE_INTERRUPT_SUBTYPE}`,
      request: { subtype: CLAUDE_INTERRUPT_SUBTYPE },
    })}\n`;
  }

  /** The CLI's stream-json user line — one encoder, so the two cannot drift. */
  private userMessageLine(
    text: string,
    images: TurnImage[] | undefined,
  ): string {
    return `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        // Attached images ride as real base64 content blocks — the CLI's
        // stream-json input accepts the Messages-API block shape, so the model
        // SEES the image directly (probe-verified on claude 2.1.220, in either
        // block order). Handing over a path instead would cost a Read
        // round-trip and put an image behind the permission gate.
        content: [...buildImageBlocks(images), { type: 'text', text }],
      },
    })}\n`;
  }

  /**
   * Whether this turn spawns holding the stdio permission dialogue —
   * `--permission-prompt-tool stdio`, which is what lets the CLI raise a
   * `can_use_tool` control_request mid-turn.
   *
   * ONE predicate, read by `buildArgs` (which decides the argv) and by
   * `keepStdinOpen` (which decides whether a verdict has a way back in). They
   * are the same question and must never be answered differently: a turn given
   * the dialogue with stdin already closed parks on a request nobody can
   * answer, and a turn denied the dialogue with stdin held open leaks a
   * process per turn.
   *
   * Two turns are outside it: an `auto` turn that will not ask (it spawns
   * under `--dangerously-skip-permissions`, which wires no prompt tool at
   * all), and a turn that named no mode at all — a geniro-INTERNAL turn,
   * never a user's chat (`ChatService` gives every chat turn a mode). Those probes read one `system/init` line and are cancelled;
   * handing them a permission dialogue and an open stdin buys nothing.
   */
  private spawnsOnPermissionDialogue(input: AgentTurnInput): boolean {
    if (input.approvalMode === undefined) {
      return false;
    }
    return input.approvalMode !== 'auto' || input.allowUserQuestions === true;
  }

  protected override keepStdinOpen(input: AgentTurnInput): boolean {
    // The command probe needs stdin for ONE request and nothing else: this CLI
    // names its commands on `system/init` and describes none of them, and the
    // sentences only come back when it is asked to reload. It carries no
    // approval mode, so without this arm it spawns with a closed stdin and has
    // no way to ask. See `createTurnDriver`.
    return input.commandListProbe === true
      ? true
      : this.spawnsOnPermissionDialogue(input);
  }

  protected override buildApprovalResponse(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string {
    // A picked "this session" / "always" option carries the permission updates
    // claude suggested on the request; a one-time allow carries none, so an
    // auto-approval (which never passes an option) teaches the CLI nothing.
    const updatedPermissions = allow ? claudeUpdatedPermissions(option) : null;
    return `${JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? {
              behavior: 'allow',
              updatedInput: updatedInput ?? {},
              ...(updatedPermissions === null ? {} : { updatedPermissions }),
            }
          : { behavior: 'deny', message: CLAUDE_DENY_MESSAGE },
      },
    })}\n`;
  }

  protected override buildApprovalModePayload(
    input: AgentTurnInput,
    mode: AgentApprovalMode,
  ): string | undefined {
    // The predicate is `keepStdinOpen`'s, deliberately reused rather than
    // restated: "can this turn be re-moded into" and "does this turn hold the
    // stdin dialogue" are the SAME question, and a second copy of the
    // condition is how the two would come to disagree after a change to
    // buildArgs. A process spawned under --dangerously-skip-permissions has no
    // prompt tool, so a gate cannot be reintroduced into it by any message —
    // the base refuses that switch itself (`spawnedOnDialogue`).
    if (!this.keepStdinOpen(input)) {
      return undefined;
    }
    return `${JSON.stringify({
      type: 'control_request',
      // Namespaced away from the CLI's own request ids — both id spaces share
      // this one dialogue. Not unique per call by design: the CLI answers with
      // the id it was given and nothing correlates a reply here, so a counter
      // would be state on the adapter serving N concurrent turns.
      request_id: `${CLAUDE_CONTROL_REQUEST_ID_PREFIX}${CLAUDE_SET_PERMISSION_MODE_SUBTYPE}`,
      request: {
        subtype: CLAUDE_SET_PERMISSION_MODE_SUBTYPE,
        // geniro's `auto` is NOT the CLI's. It is the DAEMON auto-approving at
        // its own seam, so the CLI must keep prompting — which is `default`,
        // exactly what `buildArgs` spawns an auto question-capable turn with.
        //
        // The collision is real and recent: 2.1.227 added a `--permission-mode
        // auto` of its own, so passing the string through would now be
        // ACCEPTED and would hand the turn to the CLI's auto-approval instead
        // of the daemon's — silently, since an accepted control request says
        // nothing. It used to be merely rejected. Do not "simplify" this to
        // pass the mode straight through.
        mode:
          mode === 'auto' || mode === 'ask'
            ? CLAUDE_PERMISSION_MODE_DEFAULT
            : mode,
      },
    })}\n`;
  }

  /**
   * This CLI's per-SESSION cost roll-up, so a turn is billed for what IT spent.
   *
   * On the adapter rather than on the per-turn driver, and that is the one
   * place in this class where shared mutable state is correct: the totals it
   * subtracts span TURNS (they live as long as the CLI process, which
   * `AgentSessionRegistry` now keeps between messages), so per-turn state could
   * not hold them — the second turn would see an empty ledger and re-report the
   * running total, which is the defect. It stays safe under team fan-out
   * because every entry is keyed by claude's own `session_id`, and a session id
   * belongs to exactly one process; see {@link ClaudeSessionCostLedger}.
   */
  private readonly costLedger: ClaudeSessionCostLedger;

  /**
   * Orders this daemon's own rewrites of the needs-auth record: a re-check, a
   * switch-on probe and an unawaited listing can each clear one, and two
   * overlapping read-modify-writes would put back a key the other removed.
   */
  private needsAuthWrites: Promise<unknown> = Promise.resolve();

  override toolCallMetric(name: string): ToolCallMetric {
    return claudeToolCallMetric(name);
  }

  protected mapMessage(obj: unknown): AgentEvent[] {
    return mapClaudeMessage(obj, this.costLedger);
  }

  /**
   * See {@link ClaudeSessionCostLedger.expectResume}: the read runs when the
   * new process reports `init`, and the ledger owns its failure.
   */
  private seedRestoredCost(input: AgentTurnInput): void {
    const sessionId = input.resumeSessionId;
    if (!sessionId) {
      return;
    }
    const profileDir = this.profileDir(input.configDir ?? null);
    this.costLedger.expectResume(sessionId, () => {
      const file = findClaudeSessionFileSync(profileDir, sessionId);
      // A transcript that cannot be found says nothing about what the CLI
      // restores — leave the base alone rather than reading it as zero.
      return file === null
        ? undefined
        : readLastClaudeCostState(file, sessionId);
    });
  }

  /**
   * Claude's driver adds ONE thing to the stateless default: it holds the
   * session's first prompt until the CLI's MCP servers have finished dialling
   * (`ClaudeTurnDriver.awaitPromptReady`). The reason, the measurements and the
   * cost are recorded at `CLAUDE_MCP_STATUS_SUBTYPE` in `claude.const.ts`.
   *
   * Per turn, not per adapter, because the gate holds the poll in flight, and
   * one adapter instance drives N concurrent turns under team fan-out.
   */
  protected override createTurnDriver(input: AgentTurnInput): TurnDriver {
    if (input.commandListProbe === true) {
      // The command probe, and ONLY it. One `reload_skills` request makes the
      // CLI announce its whole command list with each entry's own sentence —
      // the 64 descriptionless rows in the composer's `/` autocomplete are
      // built-ins and plugin commands that exist nowhere on disk to be
      // scanned. See `CLAUDE_RELOAD_COMMANDS_SUBTYPE` in `claude.const.ts`.
      //
      // Not on a user's turn, and the reason is the word `reload`: it re-reads
      // the user's own skills and plugins on a live session. The probe is a
      // throwaway process in a temp directory that is cancelled the moment the
      // list lands, so there is nothing there to disturb.
      return {
        onStdinReady: (io) => {
          // Written straight away rather than after `init`, which was measured
          // rather than assumed: the announcement comes back BEFORE that line,
          // so the probe settles sooner than it did on `init` alone.
          io.write(
            reloadCommandsRequestLine(CLAUDE_RELOAD_COMMANDS_REQUEST_ID),
          );
        },
        onMessage: (obj) => this.mapMessage(obj),
      };
    }
    const delegateSettler = this.delegateSettlerFor(input);
    if (!this.waitsForMcpServers(input)) {
      // The base's stateless literal, which has no `awaitPromptReady` at all —
      // absence is what keeps the opening write SYNCHRONOUS for a turn with
      // nothing to wait for, rather than a gate that resolves instantly.
      const driver = super.createTurnDriver(input);
      const modelMismatch = new ClaudeModelMismatchNotice(input.model);
      return {
        ...driver,
        onStdinReady: (io) => {
          delegateSettler.attach(io);
          driver.onStdinReady?.(io);
        },
        onMessage: (obj) => {
          delegateSettler.observe(obj);
          return modelMismatch.onMessage(obj, driver.onMessage(obj));
        },
      };
    }
    return new ClaudeTurnDriver({
      requestedModel: input.model,
      mapMessage: (obj) => this.mapMessage(obj),
      buildApprovalResponse: (id, allow, updatedInput, option) =>
        this.buildApprovalResponse(id, allow, updatedInput, option),
      logger: this.options.logger,
      delegateSettler,
    });
  }

  /** One process's delegate settler, reading transcripts under its profile. */
  private delegateSettlerFor(input: AgentTurnInput): ClaudeDelegateSettler {
    const profileDir = this.profileDir(input.configDir ?? null);
    return new ClaudeDelegateSettler({
      tracker: this.costLedger.delegateSpend,
      launchOfTask: (taskId, toolCallId) =>
        this.costLedger.launchOfTask(taskId, toolCallId),
      priceNow: (sessionId, spend) =>
        this.costLedger.delegates.priceNow(sessionId, spend),
      record: (sessionId, delegateId, spend) =>
        this.costLedger.delegates.record(sessionId, delegateId, spend),
      readTranscript: (sessionId, agentId) =>
        readClaudeDelegateTranscript(
          profileDir,
          sessionId,
          input.cwd ?? null,
          agentId,
        ),
    });
  }

  /**
   * Whether THIS turn has anything to wait for.
   *
   * Three turns are outside the gate. A turn carrying `isolateMcpServers` runs
   * under `--strict-mcp-config` with an empty config, so by construction it
   * loads no server and every poll would return the same empty list until the
   * grace ran out. An `internalProbe` turn reads one `system/init` line and is
   * cancelled; it never reaches a tool, so a tool surface is nothing to it.
   * And a turn naming NO approval mode keeps its own exemption: it is a
   * geniro-internal turn (the command-list probe), whose opening write has
   * always been synchronous.
   *
   * `internalProbe` is listed SEPARATELY rather than replacing the unset-mode
   * arm: the permission-mode probe names a mode, so the mode alone cannot tell
   * it from a user's turn.
   */
  private waitsForMcpServers(input: AgentTurnInput): boolean {
    if (this.claudeOptions.waitForMcpServers === false) {
      return false;
    }
    return (
      input.isolateMcpServers !== true &&
      input.internalProbe !== true &&
      input.approvalMode !== undefined
    );
  }
}
