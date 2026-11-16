import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { AgentKind } from '../../../runs/runs.types';
import { adapterQuestionOf } from '../../utils/card-questions';
import { asArray, asNumber, asRecord, asString } from '../../utils/json-util';
import {
  ModelVocabularyCache,
  volatile,
} from '../../utils/model-vocabulary-cache';
import type {
  AdapterConfig,
  AdapterDaemonDeps,
  AdapterQuestion,
  AgentAskInput,
  AgentCommandOptions,
  AgentContextUsage,
  AgentContextWindowListing,
  AgentEffortListing,
  AgentMcpConfigDocument,
  AgentMcpConfigWriteInput,
  AgentMcpConfigWriteResult,
  AgentMcpListingResult,
  AgentMcpServerAddInput,
  AgentMcpServerHealth,
  AgentMcpServerHealthInput,
  AgentMcpServersInput,
  AgentModel,
  AgentModelParameterListing,
  AgentModelsInput,
  AgentPlanLimits,
  AgentReportedCommand,
  AgentSessionHistory,
  AgentSessionImportInput,
  AgentSessionListing,
  AgentSessionReadInput,
  AgentSessionsInput,
  AgentTitleInput,
  AgentTurnInput,
  CarrySessionInput,
  CarrySessionResult,
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
  NativeMemoryReading,
  RecoveredSubagentOutcome,
  SubagentRecoveryRef,
  ToolCallMetric,
  TurnDriver,
} from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import {
  MCP_CONFIG_MOVED_REASON,
  mcpServerExistsReason,
} from '../utils/mcp-config.utils';
import { matchSessions } from '../utils/session-search.utils';
import { readTitleAnswer, titlePrompt } from '../utils/title-prompt.utils';
import {
  CODEX_ACCOUNT_ENV_KEYS,
  CODEX_APP_SERVER_ARGS,
  CODEX_ASK_TIMEOUT_MS,
  CODEX_AUTO_COMPACT_KEY,
  CODEX_COMPACT_PROMPT,
  CODEX_CONFIG_FLAG,
  CODEX_CONTEXT_READ_TIMEOUT_MS,
  CODEX_CONTEXT_WINDOW_KEY,
  CODEX_CREDENTIAL_ENV_KEYS,
  CODEX_DEFAULT_HOME_DIR_NAME,
  CODEX_EXEC_ONCE_ARGS,
  CODEX_EXEC_ONCE_EFFORT,
  CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC,
  CODEX_HOME_ENV,
  CODEX_LIGHT_MODEL,
  CODEX_MCP_ADD_ARGS,
  CODEX_MCP_ADD_ENV_FLAG,
  CODEX_MCP_ADD_TIMEOUT_MS,
  CODEX_MCP_ENABLED_FIELD,
  CODEX_MCP_HTTP_HEADERS_FIELD,
  CODEX_MCP_LIST_MAX_OUTPUT_CHARS,
  CODEX_MCP_LIST_TIMEOUT_MS,
  CODEX_MCP_LOGIN_FAILURE_MARKERS,
  CODEX_MCP_REPLACE_STRATEGY,
  CODEX_MCP_SERVERS_KEY,
  CODEX_MCP_UPSERT_STRATEGY,
  CODEX_MEMORIES_FEATURE_KEY,
  CODEX_METHODS,
  CODEX_MODELS_CACHE_FILE,
  CODEX_MODELS_TTL_MS,
  CODEX_OLLAMA_PROVIDER,
  CODEX_ONESHOT_TIMEOUT_MS,
  CODEX_PLAN_LIMITS_TIMEOUT_MS,
  CODEX_PROBE_DIR_NAME,
  CODEX_QUESTION_TOOL_NAME,
  CODEX_REASONING_EFFORT_KEY,
  CODEX_SESSION_SEARCH_PAGE,
  CODEX_SHELL_TOOL_FEATURE_KEY,
  CODEX_THREAD_FACTS_MAX,
  CODEX_THREAD_ID_PATTERN,
  CODEX_TITLE_ARGS,
  CODEX_TITLE_MODEL_FLAG,
  CODEX_TITLE_TIMEOUT_MS,
  CODEX_UNSAFE_SERVER_NAME,
  CODEX_USER_INPUT_TOOLS_KEY,
} from './codex.const';
import type { CodexThreadFacts } from './codex.types';
import { CodexSession } from './codex-session';
import type { CodexTurnOptions } from './codex-turn.driver';
import {
  codexCardQuestions,
  withCodexAnswer,
} from './utils/codex-approval.utils';
import {
  codexContextRequestLine,
  codexContextUsage,
  readCodexContextReply,
} from './utils/codex-context.utils';
import {
  codexContextWindowListing,
  codexWindowTokens,
  readCodexModelWindows,
} from './utils/codex-context-windows.utils';
import { codexToolCallMetric } from './utils/codex-items.utils';
import {
  CodexMcpListing,
  codexMcpServerKey,
  codexMcpToggleRefusal,
  readCodexUserMcpLayer,
} from './utils/codex-mcp.utils';
import {
  codexMemoryHandbookPath,
  readCodexMemoryNotes,
} from './utils/codex-memory.utils';
import {
  type CodexModelEntry,
  readCodexModels,
} from './utils/codex-models.utils';
import {
  codexOneshotFrames,
  codexOneshotReply,
  codexOneshotSettled,
} from './utils/codex-oneshot.utils';
import {
  codexPlanLimitsRequestLine,
  codexPlanLimitsRequestParams,
  readCodexPlanLimits,
  readCodexPlanLimitsReply,
} from './utils/codex-plan-limits.utils';
import {
  CODEX_READ_ONLY_TURN_POLICY,
  codexTurnPolicy,
} from './utils/codex-policy.utils';
import {
  codexModelParameterListing,
  codexServiceTierArgs,
} from './utils/codex-service-tier.utils';
import { carryCodexSession } from './utils/codex-session-carry.utils';
import {
  isCodexSubagentRecoveryRef,
  recoverCodexSubagent,
} from './utils/codex-subagent-recovery.utils';
import {
  codexThreadHistory,
  readCodexThreads,
} from './utils/codex-threads.utils';

/** Options the codex adapter accepts — the base's, plus a home override. */
export interface CodexAdapterOptions extends AgentAdapterOptions {
  /** The user's home, where codex's default `~/.codex` lives; a test seam. */
  homeDir?: string;
}

/**
 * OpenAI's Codex CLI, driven over its own `codex app-server` — stdio JSON-RPC
 * with one process per conversation, the same shape as the ACP transport.
 * codex ships no ACP server (checked on 0.157.1: no such subcommand, and the
 * app-server protocol is what its own IDE extension speaks), so this is its
 * first-party headless protocol; revisit if it grows one.
 */
export class CodexAdapter extends AgentAdapter {
  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.Codex,
      userData: { caches: [CODEX_PROBE_DIR_NAME] },
      ollama: {
        args: [
          CODEX_CONFIG_FLAG,
          `model_provider="${CODEX_OLLAMA_PROVIDER}"`,
          CODEX_CONFIG_FLAG,
          `model_providers.${CODEX_OLLAMA_PROVIDER}.name="Ollama"`,
          CODEX_CONFIG_FLAG,
          `model_providers.${CODEX_OLLAMA_PROVIDER}.wire_api="responses"`,
          CODEX_CONFIG_FLAG,
          `model_providers.${CODEX_OLLAMA_PROVIDER}.requires_openai_auth=false`,
          CODEX_CONFIG_FLAG,
          'web_search="disabled"',
        ],
        env: { OPENAI_API_KEY: '', OPENAI_BASE_URL: '' },
        baseUrlConfig: {
          flag: CODEX_CONFIG_FLAG,
          key: `model_providers.${CODEX_OLLAMA_PROVIDER}.base_url`,
          suffix: '/v1',
        },
      },
      identity: {
        displayName: 'Codex',
        shortName: 'codex',
        summary:
          'OpenAI Codex CLI, driven headlessly through codex app-server.',
        details: [
          'Runs each member as a codex conversation over its app-server protocol.',
          'Tool approvals are per member — auto, ask, accept edits, or plan.',
          'Model and reasoning effort are chosen per member (empty = the CLI default).',
          'Signs itself in with your ChatGPT account or an API key — no key to enter here.',
        ],
        icon: 'code',
      },
      lightModel: CODEX_LIGHT_MODEL,
      autoCompact: {
        kind: 'config-override',
        flag: CODEX_CONFIG_FLAG,
        key: CODEX_AUTO_COMPACT_KEY,
        // Below this there is nothing to compact: a fresh codex thread already
        // holds ~16k tokens of its own instructions (measured on 0.157.1).
        minTokens: 1_000,
      },
      shells: {
        // Every command is an item codex opens and closes itself.
        unreportedDetachReason: null,
        silentWaitReason: null,
        lateEndWakeReason: null,
      },
      questionToolName: CODEX_QUESTION_TOOL_NAME,
      // A question arrives as a server request whatever the approval policy.
      questionsCostAskPosture: false,
      hostQuestionToolReason:
        'geniro switches codex’s own question tools off in every thread (CODEX_USER_INPUT_TOOLS_KEY): request_user_input exists only in plan mode, and request_user_input_async (0.169.0) takes no answer but a later user message (measured on 0.169.0)',
      // geniro sets the tool timeout on its own server entry to a day, so a
      // question can wait on screen until it is answered.
      hostQuestionDeferredReason: null,
      // Every MCP call outside approval policy `never` arrives as an
      // `mcp_tool_call` elicitation (`CODEX_MCP_TOOL_APPROVAL_KIND`).
      hostToolCallUngatedReason: null,
      subagents: {
        reports: true,
        unavailableReason: null,
        // Its ending arrives as that sub-agent thread's own `turn/completed`,
        // on the same app-server stream — also after the parent's turn has
        // ended, which is what lets a delegate that outlives the turn close
        // with its real outcome instead of being closed by the turn.
        stepsUnavailableReason: null,
        // A sub-agent arrives as `subAgentActivity`, which the daemon declares
        // as a `subagent_info` row; nothing admits it by a tool name.
        launchToolNames: [],
      },
      backgroundWork: {
        // Nothing holds a codex turn: `onTurnCompleted` settles it at once.
        // `wait_agent` is the CLI's own blocking wait (0.162.0: "Returns empty
        // status when timed out"), hence "wait again".
        agentNote:
          '## Work you leave running\n\nSub-agents you spawn are NOT waited for when you end your turn: your answer goes back at once, without their results. Before your final answer, wait for every sub-agent still running with wait_agent, giving it a long timeout (minutes); if it times out, wait again — never check on them with sleep, list_agents or shell commands in a loop. Background commands are not waited for either: run a command whose result you need in the foreground.',
      },
      // `CODEX_TOOL_NAMES` is every tool this adapter maps, and none publishes
      // an artifact.
      artifactToolNames: [],
      approval: {
        modes: ['auto', 'ask', 'acceptEdits', 'plan'],
        probedModes: [],
        degradeOnProbeFail: {},
        soleModeDegradeReason: null,
      },
      // The union `model/list` offered across one account's models (0.157.1);
      // each model narrows it — see `listModelEfforts`.
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
        { id: 'ultra', label: 'ultra' },
      ],
      effortsUnavailableReason: null,
      oneShotAskUnavailableReason: null,
      options: [],
      resumeOnlyUnavailableReason: null,
      effortsAreExhaustive: false,
      // Unread: `listModelContextWindows` answers per model from codex's own
      // catalog, with a reason of its own for each empty case.
      contextWindowsUnavailableReason: null,
      builtinModels: [],
      skillRoots: {
        profileAnchor: null,
        skills: [
          ['.codex', 'skills'],
          ['.agents', 'skills'],
        ],
        commands: [],
        plugins: [],
      },
      liveStream: null,
      // Answered by `skills/list` instead of a probe turn — see
      // `listReportedCommands`.
      reportedCommands: null,
      geniroCommands: [
        {
          name: 'compact',
          description:
            'Compact the conversation so far — codex summarises it and carries on in the same thread',
          prompt: CODEX_COMPACT_PROMPT,
          replacesSession: false,
        },
      ],
      mcp: {
        callToolsRequireTrustProbe: false,
        endpointRequiresCwdConfig: false,
        listingUnavailableReason: null,
        toggleUnavailableReason: null,
        // Null: a team member's switched-off servers ride the thread's own
        // config overrides — see `codexTurnMcpOverrides` for the measurement
        // and for the rows it cannot reach (a plugin's server).
        turnToggleUnavailableReason: null,
        interactiveOnlyNote: null,
        userDisabledReason:
          'switched off in codex’s own config (`enabled = false` under its entry)',
        // `codex mcp login <name>` — the CLI's own route. It finds a server of
        // codex's config or of a plugin (measured on 0.161.0), and a row it
        // cannot address says so itself (see `codexMcpRow`).
        loginArgs: ['mcp', 'login'],
        loginFailureMarkers: [...CODEX_MCP_LOGIN_FAILURE_MARKERS],
        loginUnavailableReason: null,
        // Both live in the profile's own `config.toml` and credential store, so
        // they reach every folder of that profile and no other profile.
        changeReach: {
          toggle: { where: 'everywhere', perProfile: true },
          signIn: { where: 'everywhere', perProfile: true },
        },
        approveUnavailableReason:
          'codex loads every configured MCP server without asking for approval first',
        /**
         * The figure geniro SETS rather than one it measured: the thread config
         * carries a day-long `tool_timeout_sec` on geniro's entry alone
         * (`CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC`), so no call wait is cut by this
         * CLI's own client inside a day and the team runtime's own ceiling on a
         * wait is what binds.
         */
        toolCallDeadlineMs: CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC * 1000,
      },
      auth: {
        loginArgs: ['login'],
        loginUnavailableReason: null,
        logoutArgs: ['logout'],
        logoutUnavailableReason: null,
        loginCodePromptMarkers: [],
        // `codex login` prints `Starting local login server on
        // http://localhost:<port>` before the authorization URL (0.157.1).
        loginUrlPattern: /^https:\/\/auth\.openai\.com\//,
        // Read out of the 0.157.1 binary's own messages for a lapsed or missing
        // login; each names signing in again as the cure.
        expiredMarkers: [
          'refresh token has expired',
          'sign in again',
          'codex login',
          'no codex credentials were found',
        ],
        rateLimitPatterns: [/hit your usage limit/i],
        resetsAtPatterns: [/try again at ([^.\n]+)/i],
        serviceRefusalMarkers: [],
        isolatedEnvKeys: [
          ...CODEX_CREDENTIAL_ENV_KEYS,
          ...CODEX_ACCOUNT_ENV_KEYS,
        ],
        inheritedEnvKeys: [...CODEX_CREDENTIAL_ENV_KEYS],
      },
      sessions: {
        listingUnavailableReason: null,
        listingPartialReason: null,
        historyUnavailableReason: null,
        contentSearchUnavailableReason:
          'codex conversations are matched by title and folder — its own search reads at most the opening message, never what was said after it (measured on 0.157.1).',
      },
      configDir: {
        envVar: CODEX_HOME_ENV,
        unavailableReason: null,
        sessionCarryUnavailableReason: null,
      },
      // Probed on 0.162.0 through `thread/start`'s `instructionSources`: the
      // default home lists `~/.codex/AGENTS.md`, a throwaway `CODEX_HOME`
      // holding an `AGENTS.md` lists that file instead.
      userInstructions: {
        kind: 'file',
        homeDir: '.codex',
        fileName: 'AGENTS.md',
      },
      followUp: {
        unavailableReason: null,
        // `turn/steer` adds to the running turn; codex answers it before the
        // turn completes.
        interrupts: false,
        consumptionReported: false,
      },
      modelVendor: { kind: 'fixed', vendor: 'openai' },
      usage: {
        // Every turn reports its tokens; its MONEY is not on the wire (only an
        // Enterprise workspace sees codex's own dollar estimate), so a turn is
        // priced from those tokens at list price — `listPrice` below.
        unavailableReason: null,
        // Asked of the RUNNING process (`mcpServerStatus/list` for its thread),
        // beside what the thread itself reported: the window's size, its last
        // request's split, the instruction files it loaded. codex counts
        // tokens per request and never per kind of content, file or server,
        // so the readout lists those by name with no figure beside them.
        breakdown: { kind: 'reads', channel: 'live-process' },
        planLimits: { kind: 'reads', channel: 'live-process', oneShot: true },
        polledSpend: false,
        // codex's model ids are OpenAI's API ids (`gpt-6-astra`, `gpt-5.6-sol`
        // — measured against `~/.codex/models_cache.json` on 0.157.1), so the
        // public catalog's `openai` entries price them as they stand. A
        // ChatGPT plan is not billed per token, so on one this is what the
        // turn WOULD have cost at API list price; per model, never per
        // profile, so a Plus and an Enterprise profile price the same turn the
        // same. An id the catalog does not list (`codex-auto-review`) is
        // unpriced.
        listPrice: {
          kind: 'catalog',
          provider: 'openai',
          // Measured 2026-10-16: models.dev states gpt-6.1-sol at 1,050,000,
          // while codex enforces 475,000 by default and 828,400 at `872k`.
          catalogWindows: false,
        },
      },
      handoff: {
        kind: 'resume-command',
        resumeFlag: 'resume',
        /**
         * codex lets ONE process hold a thread (measured on 0.157.1): while
         * geniro's kept app-server has it — hours after every turn — a
         * terminal's `codex resume` says "This thread is open elsewhere", and
         * only the holder ending releases it. `codex fork` opens a new thread
         * carrying the whole history even as the holder runs, so a held
         * conversation is handed over as that copy.
         */
        heldFlag: 'fork',
        modelFlag: '-m',
        sessionIdPattern: CODEX_THREAD_ID_PATTERN,
      },
    };
  }

  /** One `model/list` answer per (profile, version), shared by both listings. */
  private readonly modelsCache = new ModelVocabularyCache<CodexModelEntry[]>({
    ttlMs: CODEX_MODELS_TTL_MS,
    now: Date.now,
  });

  constructor(private readonly codexOptions: CodexAdapterOptions = {}) {
    super(codexOptions);
  }

  /** The codex home a run without a `configDir` uses. */
  private defaultHome(): string {
    return join(
      this.codexOptions.homeDir ?? homedir(),
      CODEX_DEFAULT_HOME_DIR_NAME,
    );
  }

  /** The memories handbook's task groups (`codex-memory.utils.ts`). */
  override async readNativeMemory(
    configDir: string | null,
  ): Promise<NativeMemoryReading> {
    const home = configDir ?? this.defaultHome();
    return {
      location: codexMemoryHandbookPath(home),
      notes: await readCodexMemoryNotes(home),
    };
  }

  /** This adapter as the daemon builds it. */
  static forDaemon(deps: AdapterDaemonDeps): CodexAdapter {
    return new CodexAdapter({
      spawn: deps.spawn,
      versions: deps.versions,
      processes: deps.processes,
      logger: deps.logger(CodexAdapter.name),
      clientVersion: deps.clientVersion,
      probeRootDir: join(deps.userDataDir, CODEX_PROBE_DIR_NAME),
      prices: deps.prices,
    });
  }

  // ── The turn ──────────────────────────────────────────────────────────────

  /**
   * Everything per turn rides the protocol (cwd, model, policy, prompt), which
   * also keeps geniro's call token off `ps`. The auto-compaction threshold is
   * the one spawn-time setting — it belongs to the process.
   */
  protected buildArgs(input: AgentTurnInput): string[] {
    return [
      ...CODEX_APP_SERVER_ARGS,
      ...this.contextWindowArgs(input),
      ...this.autoCompactArgs(input),
    ];
  }

  /**
   * The turn's chosen context window as a spawn override — a setting of the
   * PROCESS, like the auto-compaction threshold beside it. codex clamps a
   * value above the model's maximum itself, so nothing is refused here.
   */
  private contextWindowArgs(
    input: Pick<AgentTurnInput, 'contextWindow'>,
  ): string[] {
    const tokens = codexWindowTokens(input.contextWindow);
    return tokens === null
      ? []
      : [CODEX_CONFIG_FLAG, `${CODEX_CONTEXT_WINDOW_KEY}=${tokens}`];
  }

  /**
   * The window is spawn-time argv the base key does not cover, so a kept
   * process started at one size must not serve a turn asking for another.
   */
  protected override sessionKey(input: AgentTurnInput): string {
    return JSON.stringify([
      super.sessionKey(input),
      this.contextWindowArgs(input).join(' '),
    ]);
  }

  /** The protocol is a dialogue: stdin stays open for the whole turn. */
  protected override keepStdinOpen(_input: AgentTurnInput): boolean {
    return true;
  }

  /** One process for the whole conversation — codex threads outlive turns. */
  protected override canHostSession(_input: AgentTurnInput): boolean {
    return true;
  }

  /** The driver writes the handshake itself; there is no one-shot payload. */
  protected override buildStdinPayload(
    _input: AgentTurnInput,
  ): string | undefined {
    return undefined;
  }

  /**
   * The user's own exported codex credential (none by default — codex signs
   * in from `~/.codex`), and the run's config directory as `CODEX_HOME`.
   */
  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    return {
      ...this.inheritedEnv(),
      ...this.configDirEnv(input.configDir),
      ...input.env,
    };
  }

  override toolCallMetric(name: string): ToolCallMetric {
    return codexToolCallMetric(name);
  }

  protected mapMessage(): never {
    throw new Error(
      'CodexAdapter drives codex app-server through its per-turn driver, not mapMessage',
    );
  }

  protected override createTurnDriver(input: AgentTurnInput): TurnDriver {
    return new CodexSession(
      {
        clientVersion: this.clientVersion,
        turnOptions: (turnInput) => this.codexTurnOptions(turnInput),
        logger: this.codexOptions.logger,
        listPriceOf: (model) => this.listPriceOf(model),
        onThreadFacts: (threadId, patch) =>
          this.noteThreadFacts(threadId, patch),
      },
      input,
    );
  }

  /**
   * What each codex thread last reported about itself, by thread id — the
   * figures the context readout serves between turns, which no request to
   * codex can fetch afterwards (codex has no "what is this thread's usage"
   * call). Keyed by THREAD, never per turn, and written by the session that
   * holds it, so concurrent conversations never cross: this is a read cache of
   * what a thread said, not protocol state. Bounded; oldest dropped first.
   */
  private readonly threadFacts = new Map<string, CodexThreadFacts>();

  private noteThreadFacts(
    threadId: string,
    patch: Partial<CodexThreadFacts>,
  ): void {
    const held = this.threadFacts.get(threadId) ?? {
      usage: null,
      instructionSources: [],
      model: null,
      autoCompactTokens: null,
    };
    this.threadFacts.delete(threadId);
    this.threadFacts.set(threadId, { ...held, ...patch });
    while (this.threadFacts.size > CODEX_THREAD_FACTS_MAX) {
      const oldest = this.threadFacts.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.threadFacts.delete(oldest);
    }
  }

  /**
   * What this conversation's window holds, as far as codex reports it: the
   * MCP servers connected to its thread, asked of the RUNNING process (it
   * reuses the thread's own connections), beside what the thread itself last
   * reported (`CodexThreadFacts`). See `codexContextUsage` for what is shown
   * and what codex has no figure for.
   */
  override async readContextUsage(
    input: AgentSessionReadInput,
  ): Promise<AgentContextUsage | null> {
    if (!input.live || !input.sessionId) {
      return null;
    }
    const facts = this.threadFacts.get(input.sessionId) ?? null;
    const requestId = `geniro-context-${randomUUID()}`;
    const reply = await input.live.ask({
      line: codexContextRequestLine(requestId, input.sessionId),
      read: (obj) => readCodexContextReply(obj, requestId),
      timeoutMs: CODEX_CONTEXT_READ_TIMEOUT_MS,
    });
    if (reply === null && facts === null) {
      return null;
    }
    return codexContextUsage(facts, reply?.servers ?? null);
  }

  /**
   * Everything about ONE turn, from THAT turn's input — never captured, so a
   * later message on a kept process cannot inherit an earlier one's posture.
   */
  private codexTurnOptions(input: AgentTurnInput): CodexTurnOptions {
    const endpoint = input.mcpEndpoint ?? null;
    const config = {
      ...(endpoint === null
        ? {}
        : {
            [codexMcpServerKey(endpoint.serverName)]: {
              url: endpoint.url,
              http_headers: { Authorization: `Bearer ${endpoint.token}` },
              tool_timeout_sec: CODEX_GENIRO_MCP_TOOL_TIMEOUT_SEC,
            },
          }),
      // In every thread config, endpoint or not, for a run that switches
      // native memory off.
      ...(input.nativeMemoryOff === true
        ? { [CODEX_MEMORIES_FEATURE_KEY]: false }
        : {}),
      ...(input.readOnly === true
        ? { [CODEX_SHELL_TOOL_FEATURE_KEY]: false }
        : {}),
      [CODEX_USER_INPUT_TOOLS_KEY]: false,
    };
    return {
      input,
      developerInstructions: this.composeSystemPrompt(input, endpoint !== null),
      config,
      policy:
        input.readOnly === true
          ? CODEX_READ_ONLY_TURN_POLICY
          : codexTurnPolicy(input.approvalMode),
      autoCompactTokens: this.autoCompactTokens(input),
      // geniro's own server is never switched off, whatever the member lists:
      // the turn's instructions may tell it to use those tools.
      mcpDisabled: [...new Set(input.mcpDisabled ?? [])].filter(
        (server) => server !== endpoint?.serverName,
      ),
    };
  }

  /**
   * The threshold this turn's argv carries (`-c <key>=<tokens>`), read back out
   * of the one place that builds it, so the readout never restates the rule.
   */
  private autoCompactTokens(input: AgentTurnInput): number | null {
    const [, setting] = this.autoCompactArgs(input);
    const value = setting?.split('=')[1];
    const tokens = value === undefined ? NaN : Number(value);
    return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
  }

  /** The caller's projection of a parked `request_user_input`, off its card. */
  override questionFrom(input: unknown): AdapterQuestion | null {
    return adapterQuestionOf(codexCardQuestions(input));
  }

  /** Carry the card's free text to the reply encoder. */
  override withAnswer(input: unknown, answer: string): unknown {
    return withCodexAnswer(input, answer);
  }

  // ── One-shot questions to a fresh app-server ──────────────────────────────

  /**
   * Ask a fresh `codex app-server` one question and read its answer: the
   * handshake and the request go in together, and the process is ended the
   * moment the reply is out. Null when codex could not be asked or refused.
   */
  private async oneshot(
    method: string,
    params: unknown,
    options: AgentCommandOptions,
  ): Promise<unknown> {
    const reply = await this.oneshotReply(method, params, options);
    return reply?.ok === true ? reply.result : null;
  }

  /**
   * The same ask, answering codex's whole reply — for a caller that must tell
   * a refusal, and codex's own reason for it, from no answer at all.
   */
  private async oneshotReply(
    method: string,
    params: unknown,
    options: AgentCommandOptions,
  ): Promise<ReturnType<typeof codexOneshotReply>> {
    const stdout = await this.runCommand([...CODEX_APP_SERVER_ARGS], {
      ...options,
      stdinWrites: codexOneshotFrames(this.clientVersion, method, params),
      settleWhen: codexOneshotSettled,
      env: { ...options.env, ...this.configDirEnv(options.configDir) },
      timeoutMs: options.timeoutMs ?? CODEX_ONESHOT_TIMEOUT_MS,
    });
    return codexOneshotReply(stdout);
  }

  /**
   * A name for a chat, from a throwaway `codex exec` turn — codex names no
   * conversation it serves over app-server (none of a live thread's frames
   * carried a name on 0.157.1), so it is asked, once, the way claude is.
   */
  override async generateTitle(
    input: AgentTitleInput,
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    let cwd = '';
    try {
      await this.validateModel(input.model);
      const local = this.modelConfiguration(input.model);
      cwd = this.makeProbeRoot('title');
      const stdout = await this.runCommand(
        [
          ...CODEX_TITLE_ARGS,
          ...local.args,
          ...(local.args.length ? [CODEX_TITLE_MODEL_FLAG, local.model!] : []),
          titlePrompt(input),
        ],
        {
          ...options,
          cwd,
          // A turn loads the user's MCP servers, so the deadline reaps a group.
          processGroup: true,
          // `codex exec` reads stdin to EOF even with its prompt in argv.
          endStdin: true,
          env: {
            ...options.env,
            ...this.configDirEnv(input.configDir),
            ...local.env,
          },
          timeoutMs: options.timeoutMs ?? CODEX_TITLE_TIMEOUT_MS,
        },
      );
      return stdout === null ? null : readTitleAnswer(stdout);
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  /** An ephemeral `codex exec` isolated like {@link generateTitle}'s. */
  override async askOnce(
    input: AgentAskInput,
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    let cwd = '';
    try {
      await this.validateModel(input.model);
      const local = this.modelConfiguration(input.model);
      const model = local.args.length ? local.model : input.model;
      cwd = this.makeProbeRoot('ask');
      const stdout = await this.runCommand(
        [
          ...CODEX_EXEC_ONCE_ARGS,
          CODEX_CONFIG_FLAG,
          `${CODEX_REASONING_EFFORT_KEY}=${JSON.stringify(input.effort ?? CODEX_EXEC_ONCE_EFFORT)}`,
          ...this.contextWindowArgs(input),
          ...codexServiceTierArgs(input.modelParameters),
          ...local.args,
          ...(model ? [CODEX_TITLE_MODEL_FLAG, model] : []),
          input.prompt,
        ],
        {
          ...options,
          cwd,
          processGroup: true,
          endStdin: true,
          env: {
            ...options.env,
            ...this.configDirEnv(input.configDir),
            ...local.env,
          },
          timeoutMs: options.timeoutMs ?? CODEX_ASK_TIMEOUT_MS,
        },
      );
      const answer = stdout?.trim() ?? '';
      return answer === '' ? null : answer;
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  /** `model/list` for one profile, cached per `--version`. */
  private async readModels(
    configDir: string | null,
    options: AgentCommandOptions,
  ): Promise<CodexModelEntry[]> {
    const version = await this.resolveBinaryVersion(options);
    return this.modelsCache.read(
      AgentKind.Codex,
      null,
      configDir,
      version,
      async () => {
        const result = await this.oneshot(
          CODEX_METHODS.modelList,
          {},
          { ...options, configDir },
        );
        const models = result === null ? [] : readCodexModels(result);
        // An empty answer is a failure to ask, not "this account has no
        // models" — never cached, so the next listing asks again.
        return models.length === 0 ? volatile(models) : models;
      },
    );
  }

  override async listModels(
    input: AgentModelsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    const models = await this.readModels(input.configDir, options);
    return models.map((model) => ({
      id: model.id,
      label: model.label,
      source: 'cli',
    }));
  }

  /** The efforts ONE model accepts — each model states its own in `model/list`. */
  override async listModelEfforts(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentEffortListing> {
    const superset = await super.listModelEfforts(model, options);
    if (model?.startsWith('ollama/')) {
      return superset;
    }
    if (model === null) {
      return superset;
    }
    const entry = (
      await this.readModels(options.configDir ?? null, options)
    ).find((candidate) => candidate.id === model);
    return entry === undefined || entry.efforts.length === 0
      ? superset
      : { efforts: entry.efforts, unavailableReason: null, exact: true };
  }

  /** The speed tiers ONE model offers, as it states them in `model/list`. */
  override async listModelParameters(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentModelParameterListing> {
    const wanted = model?.trim() ?? '';
    if (wanted.startsWith('ollama/')) {
      return super.listModelParameters(model, options);
    }
    return codexModelParameterListing(
      wanted === '' ? null : wanted,
      await this.readModels(options.configDir ?? null, options),
    );
  }

  /**
   * The windows ONE model runs at, from codex's own catalog in the profile's
   * home (else the default home's — window sizes are a fact about the model,
   * not the account): its default, and the maximum `model_context_window`
   * can raise it to. Never throws; an unreadable catalog costs the picker.
   */
  override listModelContextWindows(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentContextWindowListing> {
    const wanted = model?.trim() ?? '';
    if (wanted.startsWith('ollama/')) {
      return super.listModelContextWindows(model, options);
    }
    if (wanted === '') {
      return Promise.resolve(codexContextWindowListing(null, null));
    }
    const defaultHome = this.defaultHome();
    const homes = [options.configDir ?? null, defaultHome].filter(
      (home): home is string => home !== null,
    );
    for (const home of homes) {
      const windows = readCodexModelWindows(
        this.readModelsCatalog(home),
        wanted,
      );
      if (windows !== null) {
        return Promise.resolve(codexContextWindowListing(wanted, windows));
      }
    }
    return Promise.resolve(codexContextWindowListing(wanted, null));
  }

  /** One home's `models_cache.json`, parsed, or null when it cannot be read. */
  private readModelsCatalog(home: string): unknown {
    try {
      return JSON.parse(
        readFileSync(join(home, CODEX_MODELS_CACHE_FILE), 'utf8'),
      ) as unknown;
    } catch {
      return null;
    }
  }

  override clearCaches(): number {
    return this.modelsCache.clear();
  }

  /**
   * The same memory, on an ACCOUNT change: a `model/list` still running was
   * spawned under the credentials the user just replaced, so it is detached and
   * its reply is not filed (`ModelVocabularyCache.forget`) — {@link
   * clearCaches} alone would let it land afterwards and serve the previous
   * account's models for the rest of the TTL.
   */
  override forgetAccountCaches(): number {
    return this.modelsCache.forget(this.getConfig().kind);
  }

  /**
   * codex's skills, from its own `skills/list` — the ones only the binary
   * knows (plugin skills included), read in a throwaway folder so no project
   * layer leaks in; the disk scan covers the project's own.
   */
  override async listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<AgentReportedCommand[]> {
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('skills');
      const result = await this.oneshot(
        CODEX_METHODS.skillsList,
        { cwds: [cwd] },
        { ...options, cwd },
      );
      const commands: AgentReportedCommand[] = [];
      for (const group of asArray(asRecord(result)?.data)) {
        for (const skill of asArray(asRecord(group)?.skills)) {
          const record = asRecord(skill);
          const name = record ? asString(record.name) : null;
          if (record && name && record.enabled !== false) {
            commands.push({ name, description: asString(record.description) });
          }
        }
      }
      return commands;
    } catch {
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }

  // ── MCP ───────────────────────────────────────────────────────────────────

  /**
   * EVERY server codex loads in this folder, as codex's own app shows them —
   * its config's, its plugins', and the ones it builds in (`codex_apps`, the
   * ChatGPT Apps connector) — with the health the agent's own thread gets.
   *
   * Asked of a fresh `codex app-server` as a short dialogue (see
   * {@link CodexMcpListing}): an ephemeral thread is opened in the folder and
   * `mcpServerStatus/list` asked about it. It replaced `codex mcp list
   * --json`, which reads config.toml alone — measured on 0.161.0 it answered
   * "No MCP servers configured" for a profile whose agent was loading
   * `codex_apps` with 101 tools.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    return this.runMcpListing(input, null, options);
  }

  /** One server's health, by the same dialogue narrowed to its name. */
  override async readMcpServerHealth(
    input: AgentMcpServerHealthInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    const listing = await this.runMcpListing(input, input.server, options);
    if (!listing.ok) {
      return null;
    }
    const row = listing.servers.find((server) => server.name === input.server);
    return row === undefined
      ? null
      : { status: row.status, detail: row.detail };
  }

  /** The listing dialogue, run once — never throws. */
  private async runMcpListing(
    input: AgentMcpServersInput,
    serverName: string | null,
    options: AgentCommandOptions,
  ): Promise<AgentMcpListingResult> {
    const listing = new CodexMcpListing(
      this.clientVersion,
      input.cwd,
      serverName,
    );
    let stdout: string | null;
    try {
      stdout = await this.runCommand([...CODEX_APP_SERVER_ARGS], {
        ...options,
        cwd: input.cwd,
        stdinWrites: listing.frames(),
        converse: (out) => listing.converse(out),
        settleWhen: (out) => listing.settled(out),
        maxOutputChars: CODEX_MCP_LIST_MAX_OUTPUT_CHARS,
        env: { ...options.env, ...this.configDirEnv(input.configDir) },
        timeoutMs: options.timeoutMs ?? CODEX_MCP_LIST_TIMEOUT_MS,
      });
    } catch {
      stdout = null;
    }
    return listing.outcome(stdout);
  }

  /**
   * Switch one server on or off in codex's own config — through codex itself
   * (`config/value/write`), so it owns the write to its `config.toml`. The
   * setting is codex's per-profile one and so covers every folder.
   *
   * Only for a server that file DEFINES: codex's effective config is read
   * first (`config/read`, in the folder), and anything else is refused with
   * the reason — a plugin's server, a project's, or one codex builds in would
   * otherwise gain a stray table in the user's config and go on loading.
   */
  override async setMcpServerEnabled(
    cwd: string,
    server: string,
    enabled: boolean,
    options: AgentCommandOptions = {},
  ): Promise<void> {
    if (CODEX_UNSAFE_SERVER_NAME.test(server)) {
      throw new Error(
        `codex cannot address the MCP server "${server}" by name — its config key would be ambiguous`,
      );
    }
    const config = await this.oneshotReply(
      CODEX_METHODS.configRead,
      { cwd },
      { ...options, cwd },
    );
    if (config === null || !config.ok) {
      throw new Error(
        `codex did not say where "${server}" is defined, so it was left as it is${
          config?.ok === false ? `: ${config.message}` : ''
        }`,
      );
    }
    const refusal = codexMcpToggleRefusal(config.result, server);
    if (refusal !== null) {
      throw new Error(refusal);
    }
    const reply = await this.oneshotReply(
      CODEX_METHODS.configValueWrite,
      {
        keyPath: codexMcpServerKey(server, CODEX_MCP_ENABLED_FIELD),
        value: enabled,
        mergeStrategy: 'upsert',
      },
      options,
    );
    if (reply === null) {
      throw new Error(
        'codex did not answer the request to change its MCP servers',
      );
    }
    if (!reply.ok) {
      throw new Error(
        `codex refused to change its MCP servers: ${reply.message}`,
      );
    }
  }

  /**
   * The profile's own servers — the `[mcp_servers]` table of its base
   * `config.toml`, as codex itself reads it out (`config/read
   * {includeLayers: true}`, the USER layer; see {@link CODEX_USER_LAYER_TYPE}).
   * Never the effective config: that carries a plugin's and a project's
   * servers and codex's own defaults, none of which the editor may write back.
   */
  override async readMcpConfigDocument(
    input: { configDir: string | null },
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigDocument> {
    const reply = await this.oneshotReply(
      CODEX_METHODS.configRead,
      { includeLayers: true },
      { ...options, configDir: input.configDir },
    );
    const unavailable = (reason: string): AgentMcpConfigDocument => ({
      servers: null,
      path: null,
      version: null,
      unavailableReason: reason,
    });
    if (reply === null) {
      return unavailable('codex could not be asked for its config');
    }
    if (!reply.ok) {
      return unavailable(`codex refused to read its config: ${reply.message}`);
    }
    const layer = readCodexUserMcpLayer(reply.result);
    return layer.ok
      ? {
          servers: layer.servers,
          path: layer.file,
          version: layer.version,
          unavailableReason: null,
        }
      : unavailable(layer.reason);
  }

  /**
   * Replace the whole `[mcp_servers]` table through codex's OWN writer
   * (`config/batchWrite`, {@link CODEX_MCP_REPLACE_STRATEGY} for the probe) —
   * geniro never edits TOML by hand, so the comments and every other table in
   * the file stay as codex keeps them, and codex validates its own format.
   * The version is checked twice: here against a fresh read, so a refusal says
   * so in geniro's words, and by codex itself as `expectedVersion`.
   */
  override async writeMcpConfigDocument(
    input: AgentMcpConfigWriteInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigWriteResult> {
    const current = await this.readMcpConfigDocument(
      { configDir: input.configDir },
      options,
    );
    if (current.servers === null) {
      return {
        ok: false,
        reason: current.unavailableReason ?? 'codex did not show its config',
      };
    }
    if (current.version !== input.expectedVersion) {
      return { ok: false, reason: MCP_CONFIG_MOVED_REASON };
    }
    if (isDeepStrictEqual(current.servers, input.servers)) {
      return { ok: true, changed: false };
    }
    return this.batchWriteMcp(
      [
        {
          keyPath: CODEX_MCP_SERVERS_KEY,
          value: input.servers,
          mergeStrategy: CODEX_MCP_REPLACE_STRATEGY,
        },
      ],
      current.version,
      input.configDir,
      options,
    );
  }

  /**
   * A STDIO server through `codex mcp add`, an HTTP one through codex's own
   * config writer — {@link CODEX_MCP_ADD_ARGS} says why the two differ (the
   * CLI's `--url` form starts an OAuth flow nobody is there to finish). A name
   * the profile already defines is refused first, since `codex mcp add`
   * would silently replace it. Success is read off the effect: the table has
   * to be in the user layer afterwards.
   */
  override async addMcpServer(
    input: AgentMcpServerAddInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigWriteResult> {
    const { server } = input;
    if (CODEX_UNSAFE_SERVER_NAME.test(server.name)) {
      return {
        ok: false,
        reason: `codex cannot address an MCP server named "${server.name}" — its config key would be ambiguous; use letters, digits, - and _`,
      };
    }
    const current = await this.readMcpConfigDocument(
      { configDir: input.configDir },
      options,
    );
    if (current.servers === null) {
      return {
        ok: false,
        reason: current.unavailableReason ?? 'codex did not show its config',
      };
    }
    if (Object.hasOwn(current.servers, server.name)) {
      return { ok: false, reason: mcpServerExistsReason(server.name) };
    }
    if (server.transport === 'http') {
      return this.batchWriteMcp(
        [
          {
            keyPath: codexMcpServerKey(server.name),
            value: {
              url: server.url ?? '',
              ...(Object.keys(server.headers).length > 0
                ? { [CODEX_MCP_HTTP_HEADERS_FIELD]: { ...server.headers } }
                : {}),
            },
            mergeStrategy: CODEX_MCP_UPSERT_STRATEGY,
          },
        ],
        current.version,
        input.configDir,
        options,
      );
    }
    const output = await this.runCommand(
      [
        ...CODEX_MCP_ADD_ARGS,
        server.name,
        ...Object.entries(server.env).flatMap(([key, value]) => [
          CODEX_MCP_ADD_ENV_FLAG,
          `${key}=${value}`,
        ]),
        '--',
        server.command ?? '',
        ...server.args,
      ],
      {
        ...options,
        captureDiagnosis: true,
        env: { ...options.env, ...this.configDirEnv(input.configDir) },
        timeoutMs: options.timeoutMs ?? CODEX_MCP_ADD_TIMEOUT_MS,
      },
    );
    const after = await this.readMcpConfigDocument(
      { configDir: input.configDir },
      options,
    );
    if (after.servers !== null && Object.hasOwn(after.servers, server.name)) {
      return { ok: true, changed: true };
    }
    const said = output?.trim() ?? '';
    return {
      ok: false,
      reason:
        said === ''
          ? 'codex did not add the server and said nothing about why'
          : `codex did not add the server: ${said.slice(-500)}`,
    };
  }

  /** One `config/batchWrite`, its refusal in codex's words. */
  private async batchWriteMcp(
    edits: readonly {
      keyPath: string;
      value: unknown;
      mergeStrategy: string;
    }[],
    expectedVersion: string | null,
    configDir: string | null,
    options: AgentCommandOptions,
  ): Promise<AgentMcpConfigWriteResult> {
    const reply = await this.oneshotReply(
      CODEX_METHODS.configBatchWrite,
      { edits, expectedVersion },
      { ...options, configDir },
    );
    if (reply === null) {
      // No answer at all is the write failing, not the request being wrong —
      // thrown, so the caller reports it as the failure it is.
      throw new Error('codex did not answer the request to write its config');
    }
    return reply.ok
      ? { ok: true, changed: true }
      : { ok: false, reason: `codex refused the change: ${reply.message}` };
  }

  // ── Conversations ─────────────────────────────────────────────────────────

  override async listSessions(
    input: AgentSessionsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentSessionListing> {
    const searching = (input.query ?? '').trim() !== '';
    const page = searching
      ? Math.max(input.limit, CODEX_SESSION_SEARCH_PAGE)
      : input.limit;
    let result: unknown;
    try {
      result = await this.oneshot(
        CODEX_METHODS.threadList,
        { limit: page, ...(input.cwd ? { cwd: input.cwd } : {}) },
        { ...options, configDir: input.configDir },
      );
    } catch {
      result = null;
    }
    if (result === null) {
      return {
        sessions: [],
        unavailableReason: 'codex could not be asked for its conversations',
        partialReason: null,
      };
    }
    const all = readCodexThreads(result);
    const matched = matchSessions(all, input.query);
    const hasMore = asString(asRecord(result)?.nextCursor) !== null;
    return {
      sessions: matched.slice(0, input.limit),
      unavailableReason: null,
      partialReason:
        hasMore || matched.length > input.limit
          ? `only the ${page} most recent conversations were read`
          : null,
    };
  }

  /** codex resumes a thread by id from its own home — nothing to bring across. */
  override prepareSessionImport(
    _input: AgentSessionImportInput,
  ): Promise<void> {
    return Promise.resolve();
  }

  override async recoverSubagent(
    ref: SubagentRecoveryRef,
  ): Promise<RecoveredSubagentOutcome | null> {
    if (!isCodexSubagentRecoveryRef(ref)) {
      return null;
    }
    try {
      const result = await this.oneshot(
        CODEX_METHODS.threadRead,
        { threadId: ref.childSessionId, includeTurns: true },
        // Metadata reads must outlive task worktrees that have been collected.
        {
          configDir: ref.configDir,
          cwd: this.codexOptions.homeDir ?? homedir(),
        },
      );
      return recoverCodexSubagent(ref, result);
    } catch {
      return null;
    }
  }

  /** Bring the saved rollout along when the chat switches Codex homes. */
  override async carrySessionToConfigDir(
    input: CarrySessionInput,
  ): Promise<CarrySessionResult> {
    const defaultHome = this.defaultHome();
    const fromHome = input.from ?? defaultHome;
    const toHome = input.to ?? defaultHome;
    if (fromHome === toHome) {
      return { carried: true };
    }
    try {
      const thread = asRecord(
        asRecord(
          await this.oneshot(
            CODEX_METHODS.threadRead,
            { threadId: input.sessionId, includeTurns: false },
            { configDir: fromHome },
          ),
        )?.thread,
      );
      const sourcePath = asString(thread?.path);
      if (thread?.id !== input.sessionId || !sourcePath) {
        return {
          carried: false,
          reason: 'the previous Codex home could not locate this thread',
        };
      }
      const copied = await carryCodexSession({
        sessionId: input.sessionId,
        sourcePath,
        fromHome,
        toHome,
      });
      if (!copied.carried) {
        return copied;
      }
      const verified = asRecord(
        asRecord(
          await this.oneshot(
            CODEX_METHODS.threadRead,
            { threadId: input.sessionId, includeTurns: false },
            { configDir: toHome },
          ),
        )?.thread,
      );
      return verified?.id === input.sessionId
        ? { carried: true }
        : {
            carried: false,
            reason: 'the new Codex home could not reopen the copied thread',
          };
    } catch (error) {
      return {
        carried: false,
        reason: `codex could not carry this thread: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  override async readSessionHistory(
    input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    try {
      const result = await this.oneshot(
        CODEX_METHODS.threadRead,
        { threadId: input.sessionId, includeTurns: true },
        { cwd: input.cwd, configDir: input.configDir },
      );
      return result === null ? null : codexThreadHistory(result, input.limit);
    } catch {
      return null;
    }
  }

  /**
   * Delete one thread through codex's own `thread/delete` — probed on 0.157.1:
   * it answers `{}`, announces `thread/deleted`, and the rollout file under
   * `<CODEX_HOME>/sessions` is gone; a thread already gone answers
   * `-32600 no rollout found`. codex owns its store, so geniro never touches
   * its files.
   *
   * Asked `thread/read` first, for the one fact the delete must not proceed
   * without: when the thread began. A thread older than the run was imported
   * from the user's own codex and is kept. `createdAt` is whole SECONDS, so a
   * thread started within the run's first second reads as up to a second
   * early — the comparison allows that second, and nothing an import can
   * produce is that close, since a picker has to be opened and a row chosen.
   */
  override async deleteSessionTranscript(
    input: DeleteSessionTranscriptInput,
  ): Promise<DeleteSessionTranscriptResult> {
    const options = { configDir: input.configDir };
    let thread: Readonly<Record<string, unknown>> | null;
    try {
      thread = asRecord(
        asRecord(
          await this.oneshot(
            CODEX_METHODS.threadRead,
            { threadId: input.sessionId, includeTurns: false },
            options,
          ),
        )?.thread,
      );
    } catch {
      thread = null;
    }
    const createdAt = thread ? asNumber(thread.createdAt) : null;
    if (createdAt === null) {
      return {
        deleted: false,
        reason: 'codex did not say when the thread began, so it was kept',
      };
    }
    if (createdAt * 1000 + 1000 <= input.runCreatedAt.getTime()) {
      return {
        deleted: false,
        reason:
          'the thread began before this chat — it was imported from codex, so it was kept',
      };
    }
    let reply: ReturnType<typeof codexOneshotReply>;
    try {
      reply = await this.oneshotReply(
        CODEX_METHODS.threadDelete,
        { threadId: input.sessionId },
        options,
      );
    } catch {
      reply = null;
    }
    if (reply === null) {
      return { deleted: false, reason: 'codex did not answer the delete' };
    }
    return reply.ok
      ? { deleted: true }
      : { deleted: false, reason: `codex refused: ${reply.message}` };
  }

  /**
   * The account's plan limits, asked of the RUNNING process — which runs under
   * the run's own `CODEX_HOME`, so the answer is that account's rather than
   * whichever one a fresh process would find — or, when the caller permits
   * it and none runs, of a one-shot app-server under the same `CODEX_HOME`.
   */
  override readPlanLimits(
    input: AgentSessionReadInput,
  ): Promise<AgentPlanLimits | null> {
    if (!input.live) {
      return input.mayProbe
        ? this.probePlanLimits(input.configDir)
        : Promise.resolve(null);
    }
    const requestId = `geniro-limits-${randomUUID()}`;
    return input.live.ask({
      line: codexPlanLimitsRequestLine(requestId),
      read: (obj) => readCodexPlanLimitsReply(obj, requestId),
      timeoutMs: CODEX_PLAN_LIMITS_TIMEOUT_MS,
    });
  }

  private async probePlanLimits(
    configDir: string | null,
  ): Promise<AgentPlanLimits | null> {
    let cwd = '';
    try {
      cwd = this.makeProbeRoot('plan-limits');
      const result = await this.oneshot(
        CODEX_METHODS.rateLimitsRead,
        codexPlanLimitsRequestParams(),
        { cwd, configDir, timeoutMs: CODEX_PLAN_LIMITS_TIMEOUT_MS },
      );
      return result === null ? null : readCodexPlanLimits(result);
    } catch {
      return null;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
  }
}
