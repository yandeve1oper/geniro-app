import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { atomicWrite } from '../../../../utils/atomic-file';
import { registerSecret } from '../../../diagnostics/utils/redact';
import { AgentKind } from '../../../runs/runs.types';
import { ModelVocabularyStore } from '../../services/model-vocabulary.store';
import { adapterQuestionOf } from '../../utils/card-questions';
import { asNumber, asRecord, asString } from '../../utils/json-util';
import { ModelVocabularyCache } from '../../utils/model-vocabulary-cache';
import {
  isPlainSessionId,
  SESSION_ID_INVALID_MESSAGE,
} from '../../utils/session-id';
import type { AcpTurnOptions, AutoDecision } from '../acp/acp-driver';
import {
  ACP_MODEL_CONFIG_CATEGORY,
  acpModelProbeFrames,
  acpModelProbeSettled,
  acpProbeEnumeratedConfigOptions,
  readAcpConfigOptionProbe,
  readAcpConfigOptionsProbe,
  readAcpModelProbe,
} from '../acp/acp-models';
import { AcpSession } from '../acp/acp-session';
import {
  acpSessionListFrames,
  acpSessionListSettled,
  acpSessionLoadFrames,
  acpSessionLoadSettled,
  readAcpSessionList,
  readAcpSessionReplay,
} from '../acp/acp-sessions';
import type {
  AccountSpendEvent,
  AccountSpendQuery,
  AccountSpendReply,
  AdapterConfig,
  AdapterDaemonDeps,
  AdapterQuestion,
  AgentCommandOptions,
  AgentContextUsage,
  AgentContextWindowListing,
  AgentEffortListing,
  AgentMcpConfigDocument,
  AgentMcpConfigWriteInput,
  AgentMcpConfigWriteResult,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpPluginCopyInput,
  AgentMcpPluginCopyResult,
  AgentMcpServerAddInput,
  AgentMcpServerDefinitions,
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
  AgentTurnInput,
  CommandRecord,
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
  NO_PLAN_LIMITS,
  RecoveredSubagentOutcome,
  SubagentRecoveryRef,
  ToolCallMetric,
  TurnDriver,
} from '../adapter.types';
import { ACCOUNT_SIGNED_OUT } from '../adapter.types';
import { AgentAdapter, type AgentAdapterOptions } from '../agent-adapter';
import { readFileSafe } from '../utils/fs-safe.utils';
import {
  MCP_CONFIG_MOVED_REASON,
  mcpServerExistsReason,
  mcpServerJsonEntry,
  mcpServersVersion,
  readMcpServersKey,
} from '../utils/mcp-config.utils';
import { matchSessions } from '../utils/session-search.utils';
import { readConfigForRewrite } from '../utils/strict-json.utils';
import {
  CURSOR_ACP_ARGS,
  CURSOR_ACP_CLIENT_META,
  CURSOR_ACP_CLIENT_NAME,
  CURSOR_ACP_SESSIONS_DIR_NAME,
  CURSOR_AGENT_FAILURE_ACTION_SENTENCES,
  CURSOR_ALWAYS_ANSWER_SCOPE,
  CURSOR_API_HOST,
  CURSOR_ASK_QUESTION_METHOD,
  CURSOR_CONFIG_DIR_ENV,
  CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
  CURSOR_CREATE_PLAN_METHOD,
  CURSOR_CREDENTIAL_ENV_KEYS,
  CURSOR_DATA_DIR_ENV,
  CURSOR_HOME_DIR_NAME,
  CURSOR_KEYCHAIN_ACCOUNT,
  CURSOR_KEYCHAIN_ITEM_NOT_FOUND_EXIT,
  CURSOR_KEYCHAIN_SERVICE,
  CURSOR_KEYCHAIN_TIMEOUT_MS,
  CURSOR_MAX_MODE,
  CURSOR_MAX_MODE_OPTION,
  CURSOR_MCP_CONFIG_FALLBACK_MODE,
  CURSOR_MCP_CONFIG_NAME,
  CURSOR_MCP_DISABLE_ARGS,
  CURSOR_MCP_EMPTY_MARKER,
  CURSOR_MCP_ENABLE_ARGS,
  CURSOR_MCP_LIST_ARGS,
  CURSOR_MCP_LIST_FAILED_MESSAGE,
  CURSOR_MCP_LIST_TIMEOUT_MS,
  CURSOR_MCP_LIST_UNREADABLE_MESSAGE,
  CURSOR_MCP_SERVERS_KEY,
  CURSOR_MCP_TOGGLE_FAILED_MESSAGE,
  CURSOR_MCP_TOOLS_ARGS,
  CURSOR_MCP_TOOLS_TIMEOUT_MS,
  CURSOR_MCP_USER_DISABLED_REASON,
  CURSOR_MODEL_PROBE_TIMEOUT_MS,
  CURSOR_OWNED_PARAMETER_IDS,
  CURSOR_PERIOD_USAGE_METHOD,
  CURSOR_PLAN_INFO_METHOD,
  CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS,
  CURSOR_PLAN_LIMITS_REQUEST_TIMEOUT_MS,
  CURSOR_PLUGIN_MANIFEST_PATHS,
  CURSOR_PLUGIN_NOTE,
  CURSOR_PLUGIN_ROOT_VARIABLES,
  CURSOR_PLUGIN_SCAN_TTL_MS,
  CURSOR_PROFILE_DIR_NAME,
  CURSOR_SESSION_LIST_TIMEOUT_MS,
  CURSOR_SESSION_LOAD_TIMEOUT_MS,
  CURSOR_SESSION_META_NAME,
  CURSOR_SESSION_MISSING_MESSAGE,
  CURSOR_SESSION_STORE_DB_NAME,
  CURSOR_SESSION_STORE_DIR_NAME,
  CURSOR_SESSION_STORE_WAL_NAME,
  CURSOR_SILENTLY_DECLINED_METHODS,
  CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON,
  CURSOR_TASK_LAUNCH_MARKER,
  CURSOR_TASK_METHOD,
  CURSOR_TODOS_METHOD,
  CURSOR_TRANSIENT_FAILURE_PATTERN,
  CURSOR_TRANSIENT_RESUME_DELAYS_MS,
  CURSOR_TRANSIENT_RESUME_MAX_PER_TURN,
  CURSOR_USAGE_MAX_PAGES,
  CURSOR_USAGE_METHOD,
  CURSOR_USAGE_REQUEST_TIMEOUT_MS,
} from './cursor-acp.const';
import {
  cursorProfileAccountEnv,
  cursorProfileRunEnv,
  readCursorProfileAuthInfo,
  readCursorProfileToken,
} from './utils/cursor-account.utils';
import { readCursorAgentFailure } from './utils/cursor-agent-failure.utils';
import { readCursorContextUsage } from './utils/cursor-context-store.utils';
import { seedCursorDataDir } from './utils/cursor-data-dir.utils';
import {
  locateCursorDelegateTranscript,
  readCursorDelegateEnding,
} from './utils/cursor-delegate-transcript.utils';
import { cursorDelegateWakePrompt } from './utils/cursor-delegate-wake.utils';
import { parseCursorMcpList } from './utils/cursor-mcp-list.utils';
import {
  cursorProjectRoot,
  mcpOrigins,
  parseMcpServers,
} from './utils/cursor-mcp-scope.utils';
import { parseCursorToolsProbe } from './utils/cursor-mcp-tools.utils';
import {
  cursorBareModel,
  cursorEffortOption,
  cursorModelSelection,
} from './utils/cursor-model.utils';
import { readCursorPlanLimits } from './utils/cursor-plan-limits.utils';
import {
  buildPluginServerEntry,
  pluginVariableValues,
} from './utils/cursor-plugin-entry.utils';
import {
  type CursorPlugin,
  describeCursorPlugins,
  readCursorPlugins,
} from './utils/cursor-plugins.utils';
import {
  removeCursorProfile,
  seedCursorProfile,
  sweepStaleCursorProfiles,
} from './utils/cursor-profile.utils';
import {
  cursorCardQuestions,
  encodeCursorQuestionReply,
  readCursorQuestions,
  withCursorAnswer,
} from './utils/cursor-question.utils';
import { readCursorSessionTitle } from './utils/cursor-session-meta.utils';
import { readSpawnedConversationIds } from './utils/cursor-spawned-conversations.utils';
import {
  readCursorLaunchIsBackground,
  readCursorSubagentToolCallId,
  readCursorTask,
  readCursorTaskInput,
} from './utils/cursor-task.utils';
import {
  type CursorTerminalCache,
  cursorTerminalDirs,
  readCursorTerminalRecords,
} from './utils/cursor-terminals.utils';
import { parseCursorPlan, parseCursorTodos } from './utils/cursor-todos.utils';
import { cursorToolCallMetric } from './utils/cursor-tool-metric.utils';
import { cursorTransientResumePrompt } from './utils/cursor-transient-resume.utils';
import {
  cursorUsagePageLength,
  cursorUsageRequestBody,
  cursorUsageTotalCount,
  readCursorUsageEvents,
} from './utils/cursor-usage.utils';

/** Cursor's read-only planning mode, as `session/new` reports it. */
const CURSOR_PLAN_MODE_ID = 'plan';

/**
 * How long after its last write a conversation's store is still read for
 * delegates — a day past the thirty the account keeps, so a delegate billed at
 * the window's far edge is still found.
 */
const SPAWN_SCAN_MAX_AGE_MS = 31 * 24 * 60 * 60_000;

/** Cursor-specific constructor options (the bag stays a test seam). */
export interface CursorAcpAdapterOptions extends AgentAdapterOptions {
  /**
   * Where per-turn config directories are created; defaults to the OS tmpdir,
   * which is only ever used standalone. Provided by the module as
   * `<userData>/cursor-profiles`.
   */
  profileDir?: string;
  /**
   * Where the CLI's ACP conversations really live, linked into every turn
   * profile as `acp-sessions`. Defaults beside {@link profileDir} in the OS
   * tmpdir; provided by the module as `<userData>/cursor-sessions`.
   *
   * Separate from the profile base because that base is swept wholesale at boot
   * — see `CURSOR_SESSION_STORE_DIR_NAME`.
   */
  sessionStoreDir?: string;
  /** The user's home, for reading their `cli-config.json` (test seam). */
  homeDir?: string;
  /**
   * Where handshake replies survive a daemon restart — see
   * {@link ModelVocabularyStore} and {@link probeModelConfigOptionsShared}.
   *
   * REQUIRED, and deliberately so. It began as an optional field defaulting to
   * a store over `<userData>/model-vocabularies.json`, which made every adapter
   * built without one share a single global file — the specs then leaked
   * probes into each other through the developer's own home directory, and two
   * of them failed for it. A dependency that is wrong when it is implicit
   * should not have a default.
   */
  vocabularyStore: ModelVocabularyStore;
}

/**
 * Decide a permission request without the user, from the turn's approval mode.
 * Exported so a spec can drive the policy directly, without a live agent.
 *
 * - `auto` (and a geniro-internal turn with no mode at all) auto-approves
 *   everything, preserving the unattended semantics the `-p --force` path had.
 * - Every other mode asks for everything that reaches here.
 *
 * There is nothing for an edits-only mode to approve: read out of cursor-agent
 * 2026.09.10's `shouldBlockWrite`, an ordinary write inside the workspace is
 * made with no permission request at all, in every approval mode the CLI has.
 * What it does ask about is a write outside the workspace and a write to one
 * of its protected config files — the repository's git config and hooks, JSON
 * under `.claude`, `mcp.json` under `.cursor`, anything under `.vscode` — each
 * able to make a later command run code, and the request does not say which
 * of the two it is. A delete is asked about too. So every request an edits-only
 * mode could approve is one a person has to see, which is why this adapter
 * does not offer `acceptEdits` (`approval.modes`); a run stored with it rides
 * through and asks.
 */
export function cursorAutoDecision(
  approvalMode: AgentTurnInput['approvalMode'],
): AutoDecision {
  return approvalMode === undefined || approvalMode === 'auto' ? 'allow' : null;
}

/**
 * Whether a turn's permission requests must reach geniro — every mode the
 * driver does not answer by itself. Such a turn's profile overrides the
 * user's own approval mode (`CursorProfileSeed.askForApprovals`).
 */
export function cursorTurnAsks(
  approvalMode: AgentTurnInput['approvalMode'],
): boolean {
  return cursorAutoDecision(approvalMode) === null;
}

/**
 * How long a cached handshake reply stays fresh — the same 10-minute window
 * `EffortsService`/`ContextWindowsService` already give the PARSED vocabulary
 * this feeds, so a cold model pays the ~2s handshake once per that window
 * rather than once per render.
 */
const CURSOR_HANDSHAKE_PROBE_TTL_MS = 10 * 60_000;

/**
 * Drives `cursor-agent acp` — Cursor's first-party Agent Client Protocol
 * server — over JSON-RPC on stdio, in place of the one-shot
 * `cursor-agent -p --output-format stream-json` stream.
 *
 * What this buys over the legacy adapter:
 * - **Real permission prompts.** ACP's `session/request_permission` is a
 *   baseline agent→client request, so what the CLI asks about reaches a person
 *   instead of every mode degrading to `--force`.
 * - **Client-supplied MCP servers.** The call-runtime endpoint travels in
 *   `session/new`, so a cursor caller member no longer needs its token planted
 *   in the run cwd's `.cursor/mcp.json` around the turn — and the token now
 *   rides an HTTP header inside a stdin frame rather than a file on disk.
 * - **A typed event stream.** `session/update` replaces the version-volatile
 *   NDJSON the legacy mapper has to guess its way through.
 *
 * The process is kept for the whole conversation, one turn after another —
 * see {@link CursorAcpAdapter.canHostSession}.
 *
 * `AgentTurnInput.nativeMemoryOff` is not read: the CLI keeps no memory of its
 * own to switch off (checked on 2026.10.19 — its bundle names memories only in
 * server RPC types, Cursor having removed Memories in 2.1).
 */
export class CursorAcpAdapter extends AgentAdapter {
  /** The copies into `~/.cursor/mcp.json`, queued — see `copyPluginMcpServer`. */
  private mcpConfigWrites: Promise<unknown> = Promise.resolve();

  getConfig(): AdapterConfig {
    return {
      kind: AgentKind.CursorAgent,
      userData: {
        conversations: [CURSOR_SESSION_STORE_DIR_NAME],
        caches: [CURSOR_PROFILE_DIR_NAME],
        leftovers: ['cursor-probe', 'cursor-probe.json'],
      },
      identity: {
        displayName: 'Cursor',
        // The binary is `cursor-agent`; a row of chrome has room for one word.
        shortName: 'cursor',
        summary: 'cursor-agent CLI — honours per-member tool approvals.',
        details: [
          'Runs one turn per member, headlessly through the cursor-agent CLI.',
          'Tool approvals are per member — set the member to auto, ask, or accept edits.',
          'Model is chosen per member (empty = the CLI default).',
          'Signs itself in — Settings offers the sign-in; no API key to enter.',
        ],
        icon: 'terminal',
      },
      /**
       * MEASURED on 2026-09-22: `cursor-agent --help` names no compaction or
       * context-window control of any kind (its whole flag set is api-key,
       * output-format, stream-partial-output, mode, plan, resume, continue,
       * model, list-models, yolo, auto-review, sandbox, approve-mcps, trust,
       * workspace, add-dir, plugin-dir, worktree-base, skip-worktree-setup),
       * and ACP's `session/new` has no field for one either.
       *
       * So a conversation on this CLI keeps geniro's own between-turn rule as
       * its only threshold, with that rule's known limit: a turn that fills the
       * window on its own is only noticed once it has ended. Re-check the flag
       * list when this CLI is upgraded.
       */
      autoCompact: {
        kind: 'unavailable',
        reason:
          'cursor-agent offers no auto-compaction window control — neither a CLI flag nor an ACP session field (measured 2026-09-22)',
      },
      /**
       * Baseline ACP has permission requests and no question channel, but
       * cursor added one as a vendor extension — so a callee driven over this
       * transport CAN raise a question, and used to have it declined
       * in-protocol. The method name doubles as the tool name because that is
       * the only identity the request carries; nothing outside this adapter
       * cares which it is.
       *
       * Documented rather than observed — see the block above
       * {@link CURSOR_ASK_QUESTION_METHOD} — which is why the driver gates on
       * a payload it can actually read and otherwise declines as before.
       */
      shells: {
        // apps/daemon/AGENTS.md → ACP and cursor transport has the measurements.
        unreportedDetachReason:
          'cursor-agent reports a backgrounded command as finished, so whether ' +
          'it is still running is read from its terminal records and the process table instead',
        silentWaitReason:
          'cursor-agent presents no tool_call for its AwaitShell tool (its ACP layer drops a call it has no title for), so a wait of up to 119 minutes sends no frame at all',
        lateEndWakeReason:
          'cursor-agent hands a finished background command to the model only at the end of a session/prompt and sends nothing between prompts (2026.11.05-86047df, background-completion-drain)',
      },
      questionToolName: CURSOR_ASK_QUESTION_METHOD,
      /**
       * False, unlike claude. The question arrives as a JSON-RPC request the
       * agent sends whatever session mode it is in, so an unattended `auto`
       * member keeps `auto` — where claude has to be moved onto its stdio
       * permission dialogue to keep the tool wired at all.
       */
      questionsCostAskPosture: false,
      /**
       * Non-null — and it reads as a contradiction of the line above until the
       * two questions are separated. `questionToolName` says geniro can ANSWER
       * this CLI's question method, which it can and does; this says the
       * model is never in a position to raise one. Measured in the running app
       * on 2026.08.11-e8db854: asked to list its tools, a real chat answered
       * "I do not have a tool that lets me ask you a multiple-choice question
       * and wait for your answer. I can only communicate with you by
       * outputting text directly in my response here." That is consistent with
       * the note beside `question` in the ACP protocol block — the request has
       * still never been seen on the wire — and with the binary: the tool is a
       * SERVER-side `askQuestionToolCall`, and the only ACP client capability
       * the bundle reads is `_meta.parameterizedModelPicker`, so there is
       * nothing this side can advertise to earn it.
       */
      hostQuestionToolReason:
        'cursor-agent offers its model no tool for asking the user — its own ask-question call is raised by the vendor server, and no ACP client capability requests it',
      /**
       * Measured on 2026.09.10-fd3934a; the contract field carries the full
       * account of what was checked. The short of it: `client.callTool({name,
       * arguments})` with no `RequestOptions`, so the SDK's own `n?.timeout ??
       * 6e4` stands, `resetTimeoutOnProgress ?? !1` rules out progress
       * notifications, and neither the ACP server entry nor `mcp.json` nor the
       * environment carries a timeout geniro could raise.
       */
      hostQuestionDeferredReason:
        'cursor-agent gives every MCP tool call a fixed 60-second deadline it offers no way to raise, so a question left open on screen is abandoned before most people have finished reading it',
      // `ask`, the only other mode, asks about every permission request — an
      // MCP call included (`isHostToolCall`'s measured title form) — and geniro
      // starts cursor with no shell sandbox.
      hostToolCallUngatedReason: null,
      subagents: {
        /**
         * True — and it read `false` here for two milestones on a measurement
         * that never touched the wire.
         *
         * What the old entry proved was that `acp.types.ts` declared no parent
         * id and `acp-driver.ts` read none: it measured GENIRO, and then stated
         * the conclusion as a fact about cursor. It even named `cursor/task` as
         * "the single most suggestive artifact found" — a method this adapter
         * was declining on every delegating turn, one file away — and left it
         * for a later reader, because the payload had "never been captured on
         * the wire". Capturing it took one throwaway session and a prompt asking
         * the agent to delegate.
         *
         * REFUTED 2026-08-13 on 2026.08.11-e8db854. The delegation IS on the
         * wire: an ordinary `tool_call` marked `rawInput:{_toolName:"task"}`,
         * and then a `cursor/task` request carrying the description, the full
         * brief, the type, the model and the duration. Every frame is
         * transcribed in the `Background sub-agents` block of
         * `cursor-acp.const.ts`, with what to re-check next.
         */
        reports: true,
        unavailableReason: null,
        /**
         * What the same probe found is NOT there: nothing the delegate itself
         * did. So a cursor block opens onto the brief and the duration rather
         * than a conversation, and says why instead of reading as a delegate
         * that sat idle for thirteen seconds.
         */
        stepsUnavailableReason: CURSOR_SUBAGENT_STEPS_UNAVAILABLE_REASON,
        // A launch's tool call is titled `Task: Subagent task`, which names no
        // tool; the delegate is admitted by the declaration `cursor/task` yields.
        launchToolNames: [],
      },
      backgroundWork: {
        // The CLI holds the prompt while background sub-agents run and
        // continues the agent on their results (`_meta.subagents`, 2026.09.15
        // on); before that the ACP session's own hold does it
        // (`holdForDelegates`). A backgrounded command holds nothing; its end
        // after the turn starts a turn of its own (`CommandEndWakeService`).
        agentNote:
          '## Work you leave running\n\nSub-agents you start in the background keep running after you end your turn. This conversation — and the call you are answering, if any — stays open until they finish, and you will be prompted with their reports. With nothing else to do, say briefly what you launched and END YOUR TURN instead of waiting: never poll with sleep, date, ls or until/tail loops, never read their transcripts to check on them, and never predict what they will report. Your answer is the reply you give in the turn that has nothing left running. A background COMMAND does not keep your turn open: when one you left running finishes after your turn has ended, you are started again with a message naming it, its exit code and where its output is, so end your turn rather than poll it. When your next step needs its result in this turn, wait for it with AwaitShell.',
      },
      // None of its tool calls publishes an artifact: across a 43k-row run its
      // names were titles (`Read File`, `grep`) or the command it ran.
      artifactToolNames: [],
      approval: {
        /**
         * Real, unlike the `-p` transport this replaces:
         * `session/request_permission` is an ACP baseline, and `ask` parks
         * what reaches geniro on a user verdict. `acceptEdits` is absent
         * because it would be `ask` under another name — the CLI makes an
         * ordinary in-workspace write without asking (see
         * {@link cursorAutoDecision}). `plan` is absent deliberately — it maps
         * to an agent-declared session mode we cannot confirm cursor offers,
         * and a plan turn that quietly ran with write access is the one degrade
         * here that costs something.
         */
        modes: ['auto', 'ask'],
        /** The protocol guarantees them; there is no binary fact to prove. */
        probedModes: [],
        degradeOnProbeFail: {},
        /** Nothing degrades: every mode above runs as the CLI allows it. */
        soleModeDegradeReason: null,
      },
      /**
       * REAL, and every level here was accepted by the CLI itself.
       *
       * This list was `[]` for months, on the recorded grounds that effort was
       * not independently selectable — cursor composes it into an opaque model id
       * (`claude-opus-5[thinking=true,context=300k,effort=high,fast=false]`) and
       * rejects every recomposed one with `-32602`. All of that was true, and the
       * conclusion drawn from it was still wrong: it is a property of the
       * HANDSHAKE, not of the CLI. `clientCapabilities._meta.parameterizedModelPicker`
       * — which geniro never sent — switches the agent to a bare model name plus
       * one config option per parameter, and `effort` is one of them. See
       * {@link CURSOR_ACP_CLIENT_META} for the source it was read out of and the
       * probe transcript.
       *
       * The five values below are the ones the agent ENUMERATED for that option
       * on 2026.08.11-e8db854, and applying them was measured, not assumed:
       * `effort=xhigh` and `effort=max` on `claude-opus-5` are both ACCEPTED
       * (the same values the old note recorded as rejected), and `effort=bogus`
       * is `-32602` — so the vocabulary is closed and this is all of it.
       *
       * Weakest first, per the field's contract.
       *
       * RE-CHECK by re-running that probe when the CLI series moves. Two shapes
       * would matter: a value added or removed here, and the vocabulary becoming
       * genuinely per-MODEL in a way that bites — `buildModelParameterConfigOptions`
       * derives the option from the CURRENT model, and a model with no effort
       * axis (`auto-smart`, `gemini-3.1-pro[]`) offers none at all. A run that
       * names an effort such a model does not take is declined in-protocol and
       * surfaces as a `notice` on that turn, which is the honest outcome: the
       * turn runs, and the user is told the setting did not apply.
       */
      efforts: [
        { id: 'low', label: 'low' },
        { id: 'medium', label: 'medium' },
        { id: 'high', label: 'high' },
        { id: 'xhigh', label: 'xhigh' },
        { id: 'max', label: 'max' },
      ],
      /** Null: the list above is non-empty, so there is nothing to explain. */
      effortsUnavailableReason: null,
      oneShotAskUnavailableReason:
        'geniro drives cursor-agent through ACP sessions only and keeps no one-off print-mode turn for it, as it asks cursor for no chat titles either.',
      options: [
        {
          id: CURSOR_MAX_MODE_OPTION,
          label: 'Max Mode — run models at their largest context window',
          description:
            'On by default: without it a model with no window of its own runs at 200k where Cursor gives it 1M. Billed at the model’s API rate plus 20% on legacy request-based plans. Applies to new chats.',
          defaultValue: CURSOR_MAX_MODE,
        },
      ],
      // The ACP driver reads `AgentTurnInput.resumeOnly`: it branches the
      // prompt away and settles the turn from the `session/load` reply.
      resumeOnlyUnavailableReason: null,
      /**
       * FALSE: the list above is a union of what SOME models offer, and it
       * cannot be complete — `gpt-5.2` enumerates `extra-high` on its own
       * `reasoning` axis (probed 2026-08-19 on 2026.08.11-e8db854), a value no
       * other model has. Checked exhaustively, the daemon refused that level at
       * run creation and the chat could not be started at all, on a level the
       * picker had just offered because the CLI itself listed it.
       *
       * Nothing goes unchecked as a result: `listModelEfforts` asks the CLI per
       * model, and the turn driver refuses a value the model does not offer with
       * a row naming what it does — per turn, against the live agent, rather
       * than against a constant that goes stale with the next model.
       */
      effortsAreExhaustive: false,
      /**
       * Null: this CLI DOES offer the axis, and
       * {@link CursorAcpAdapter.listModelContextWindows} answers per model.
       *
       * Probed 2026-08-21 on 2026.08.11-e8db854 by sweeping all 34 models the
       * account offers: twelve carry a `context` option under the category
       * `model_config`, and the vocabularies differ per model —
       * `claude-opus-5` and `claude-sonnet-5` are `300k|1m`, the `gpt-5.x`
       * family `272k|1m`, `claude-sonnet-4-6` and `claude-opus-4-6` `200k|1m`
       * — while the other twenty-two (including `auto-smart`, `composer-2.5`
       * and every gemini) have no such option at all. The setting has a
       * measured EFFECT rather than merely existing: with the same model and
       * the same prompt, `context=1m` makes this CLI's own accounting report a
       * 1,000,000-token window and `context=300k` a 300,000-token one, which
       * is what the meter's ring then draws.
       */
      contextWindowsUnavailableReason: null,
      /**
       * Empty because {@link CursorAcpAdapter.listModels} answers for real —
       * `builtinModels` is the fallback for a CLI that cannot be asked, and
       * this one can. A hardcoded list would also go stale against an account
       * whose available models change without the binary changing.
       */
      builtinModels: [],
      /**
       * Transcribed from the CLI's own slash-command loader
       * (`src/commands/custom-commands.ts` → `loadCommands` / `loadSkillRoots`
       * in 2026.08.11-e8db854), which is the function that decides what a
       * session can be invoked with. This field read `skills: []` with the
       * note "No skills convention — only claude has one" for two milestones,
       * and that was already false when it was written: cursor reads FIVE
       * skill roots under each of the project and the user's home, and it
       * reads claude's and codex's among them.
       *
       * `.cursor/skills-cursor` is the built-in set the CLI syncs into
       * `~/.cursor` itself, so it is by far the biggest source of rows here —
       * and it is the only one the loader takes at home scope alone. Scanning
       * it under the project root too costs a missing directory's `readdir`
       * and keeps this a flat list; the CLI's own rule discovery does walk it
       * in the workspace, so a project that had one would not be wrong either.
       */
      skillRoots: {
        // A named configuration moves only the account; a run keeps the real
        // home, so the home roots below stand whatever profile it names.
        profileAnchor: null,
        skills: [
          ['.cursor', 'skills'],
          ['.cursor', 'skills-cursor'],
          ['.agents', 'skills'],
          // Third-party extensibility, which the loader defaults to ON.
          ['.claude', 'skills'],
          ['.codex', 'skills'],
        ],
        /** `<root>/.cursor/commands/**.md`, and claude's, which it also loads. */
        commands: [
          ['.cursor', 'commands'],
          ['.claude', 'commands'],
        ],
        /**
         * This CLI has a full plugin system, and it reads BOTH hosts' caches —
         * which is why the composer listed none of them. It reports no command
         * list of its own (its ACP `session/new` reply carries an empty
         * `availableCommands`, measured), so unlike claude the disk scan is the
         * only way a plugin's skills can reach the `/` autocomplete: without
         * this, a skill the agent would happily run could not be offered, and
         * the send was refused as a command this agent does not have.
         *
         * The manifest list and its order are the CLI's own
         * (`[".cursor-plugin/plugin.json", ".claude-plugin/plugin.json",
         * "plugin.json"]`, read out of the shipped 2026.08.11-e8db854 bundle) —
         * which is also what makes reading claude's cache correct rather than
         * opportunistic: this CLI accepts a Claude plugin manifest by design.
         */
        plugins: [
          ['.cursor', 'plugins', 'cache'],
          ['.claude', 'plugins', 'cache'],
        ].map((cacheDir) => ({
          cacheDir,
          manifests: CURSOR_PLUGIN_MANIFEST_PATHS,
          /**
           * A plugin's cursor-specific build first. Verified on the geniro
           * plugin, which ships both: `cursor/skills/` names its skills
           * `geniro-implement` (what this CLI resolves and runs) while
           * `skills/` names the same skill `implement`, so taking both would
           * offer one skill twice under two names.
           */
          skillDirs: [['cursor', 'skills'], ['skills']],
        })),
      },
      /**
       * ACP streams natively: `session/update` carries `agent_message_chunk`
       * increments, with no flag to probe for.
       */
      liveStream: null,
      /**
       * Asked up front, and the reason the earlier `null` was wrong is the
       * whole point of this probe: the harvest it deferred to only exists AFTER
       * a turn has run in that folder, so a chat opened in a folder cursor has
       * never worked in listed the disk scan alone and nothing the CLI reports
       * about itself. Measured 2026-08-19 on 2026.08.11-e8db854 against this
       * repo: the CLI offered 27 commands and the composer showed 21, missing
       * `apply-worktree`, `best-of-n`, `copy-request-id`, `delete-worktree`,
       * `multi-model-review`, `review-agent`, `simplify` and `worktree`.
       *
       * Two facts make the probe cheap, both measured the same day. The
       * `available_commands_update` rides the HANDSHAKE, not the answer: a
       * probe that sent `session/new` and no prompt at all still received it,
       * so the turn is cancelled the moment it lands and the model's reply is
       * never waited on. And an empty probe cwd still gets the
       * home-scope set (22 of the 27; the four worktree entries are project
       * scoped and reach the list through the harvest once a real turn runs
       * there), INCLUDING under a throwaway `CURSOR_CONFIG_DIR` holding only
       * `cli-config.json` — this CLI resolves its skills from the user's home
       * either way, exactly as it does `mcp.json`.
       */
      reportedCommands: {
        /** Never reached by the model: the turn is cancelled on the update. */
        probePrompt: 'Reply with exactly: ok',
        /** A hung handshake must not wedge the caller forever. */
        probeTimeoutMs: 30_000,
        /** Defensive bound — the CLI reports ~27 entries today. */
        maxCommands: 500,
        /**
         * Null: this CLI reports no internal names to strip. Every entry across
         * both readings (27 in a git repo, 22 in an empty directory) was a
         * user-invokable command, so a prefix filter here would be a rule with
         * nothing to match — unlike claude, whose `__remote-workflow` is real.
         */
        internalPrefix: null,
      },
      geniroCommands: [
        {
          name: 'compact',
          description:
            'Summarise the conversation so far and continue from the summary',
          /**
           * geniro's OWN instruction, because this CLI exposes no compaction
           * over the transport geniro drives. Read out of the shipped
           * 2026.08.11-e8db854 bundle: `/summarize` is a TUI command
           * (`{id:"summarize", … run: … onSummarize()}` in `6260.index.js`)
           * whose handler sends that vendor's private
           * `ConversationAction{summarizeAction}`, while the ACP server
           * (`2996.index.js`) advertises `copy-request-id` plus the commands on
           * disk and its `handleSlashCommand` runs exactly that one locally —
           * everything else is forwarded to the model as prose, which is what
           * the reported `/summarize` turn shows happening. The protocol has no
           * compaction method to reach for either (agentclientprotocol
           * discussion #871 is open on precisely this).
           *
           * `-p --output-format stream-json` was checked as the alternative and
           * is not one: a resumed print-mode turn answers `/summarize` with
           * prose exactly as ACP does, and that mode has no stream-json INPUT,
           * no per-tool permission channel and no image blocks — so it would
           * trade this app's approval cards and attachments for nothing.
           */
          prompt:
            'Summarise this entire conversation so far. Write the summary as ' +
            'the handover notes a fresh agent would need to carry the work on ' +
            'with nothing else to go on: what was asked, what was decided and ' +
            'why, what has been done, which files and commands matter, and ' +
            'what is still open. Prefer specifics — names, paths, versions, ' +
            'measurements — over description. Reply with the summary alone.',
          /**
           * True: the summary is only worth writing because the session it
           * summarises is dropped once it lands. This CLI holds no process
           * between turns and resumes each one with `session/load`, so the
           * conversation shrinks exactly when the recorded session id does.
           */
          replacesSession: true,
        },
      ],
      mcp: {
        /**
         * No trust probe: the endpoint travels in `session/new` as a
         * client-supplied server, so there is nothing planted in the user's
         * config for the CLI to have trusted or not.
         */
        callToolsRequireTrustProbe: false,
        /** ACP carries the endpoint in-protocol; no cwd config is written. */
        endpointRequiresCwdConfig: false,
        /**
         * Null: this CLI CAN be asked. `cursor-agent mcp list` exists and
         * works without authentication (verified on 2026.07.23-e383d2b), so
         * {@link CursorAcpAdapter.listMcpServers} below answers for real and
         * there is no reason to state in place of a listing.
         *
         * ACP itself still has no agent-to-client inventory of a session's
         * servers — the listing is a subcommand, not a protocol frame — which
         * is why this is an adapter method rather than anything the shared
         * `adapters/acp/` client could provide.
         */
        listingUnavailableReason: null,
        /**
         * Null: this CLI CAN be told which servers to load, per folder, and
         * {@link CURSOR_MCP_ENABLE_ARGS} carries the bundle source and the
         * measurements. It read non-null for two milestones on the recorded
         * grounds that `mcp enable|disable` were global and wrote
         * `cli-config.json`; both were refuted against 2026.08.11-e8db854,
         * which is why every row in the panel used to render a padlock while
         * the user's own Cursor UI offered live switches for the same servers.
         */
        toggleUnavailableReason: null,
        /**
         * Null: a team member's switched-off servers reach the turn through a
         * per-turn `CURSOR_DATA_DIR` whose project directory carries its own
         * `mcp-disabled.json` (`utils/cursor-data-dir.utils.ts` holds the
         * measurement and what else that directory must link).
         */
        turnToggleUnavailableReason: null,
        /**
         * Null here because the gap is the machine's installed PLUGINS, which
         * only the folder read can name — `readMcpFolderFacts` answers it.
         */
        interactiveOnlyNote: null,
        userDisabledReason: CURSOR_MCP_USER_DISABLED_REASON,
        /**
         * `cursor-agent mcp login <identifier>` — "Authenticate with an MCP
         * server configured in .cursor/mcp.json or ~/.cursor/mcp.json", read
         * from the CLI's own `mcp --help`. Inline rather than named, per this
         * adapter's rule: `getConfig()` is its only reader.
         *
         * The row this serves now exists. When this was written no cursor row
         * could carry `needs_auth` — the parser knew `ready` / `Error:` /
         * `not loaded` / `disabled` and nothing naming authentication, and a
         * marker invented for unobserved wording is how a parser silently
         * matches nothing. On 2026-08-11, against 2026.08.04-aaa8809, a real
         * listing printed `requires_authentication` on eight of eleven servers;
         * {@link CURSOR_MCP_NEEDS_AUTH_MARKER} carries that capture and the
         * parser maps it, so this sign-in is reachable rather than latent.
         */
        loginArgs: ['mcp', 'login'],
        loginUnavailableReason: null,
        // Both are filed under `~/.cursor/projects/<project root>`, outside any
        // `CURSOR_CONFIG_DIR` (`cursorProjectRoot`), so every profile working in
        // that repository shares them.
        changeReach: {
          toggle: { where: 'repository', perProfile: false },
          signIn: { where: 'repository', perProfile: false },
        },
        /**
         * Measured on 2026.10.01-e373342 under a pty, the way geniro runs it:
         * an unapproved server, an approved one that cannot be reached and a
         * name the config does not hold each print `✗ MCP login failed`
         * followed by the reason (`… has not been approved`, `fetch failed`,
         * `… not found in config`). The `✗` is left out of the marker so a
         * re-styled glyph cannot stop it matching.
         */
        loginFailureMarkers: ['MCP login failed'],
        /**
         * Null: `cursor-agent mcp enable <name>` IS the approval, and the CLI
         * says so in both its help ("Add an MCP server to the local approved
         * list") and its own answer. Measured end to end on 2026.08.11-e8db854
         * against a git project whose `.cursor/mcp.json` defined one server:
         *
         * ```
         * $ cursor-agent mcp list
         * probe-echo: not loaded (needs approval)
         * $ cursor-agent mcp enable probe-echo
         * ✓ Enabled and approved MCP server: probe-echo
         * $ cursor-agent mcp list
         * probe-echo: ready
         * ```
         *
         * Its bundle agrees: `mcp list` reports `unapproved` for a server the
         * PROJECT file defines whose key is missing from that project's
         * `mcp-approvals.json`, and the `enable` path calls `addApproval` for
         * exactly that key. So the approval is per project and the cwd is the
         * whole of the scoping, as it is for the toggle beside it.
         */
        approveUnavailableReason: null,
        /**
         * Sixty seconds, fixed: the MCP SDK's default request timeout, which
         * this CLI never overrides. The measurement is the one
         * {@link AdapterConfig.hostQuestionDeferredReason} records for this
         * adapter (2026.09.10-fd3934a: `callTool({name, arguments})` with no
         * `RequestOptions`, `resetTimeoutOnProgress` false, no timeout field on
         * the ACP HTTP server entry), and the wire agrees: on run `4829d8ed` a
         * parked `tools/call` was followed by its `notifications/cancelled`
         * 60.001s later — while the POST itself was kept OPEN, which is why a
         * wait that outlives this is a waiter nobody reads rather than a closed
         * socket geniro would notice.
         */
        toolCallDeadlineMs: 60_000,
      },
      auth: {
        /**
         * `cursor-agent login` — "Authenticate with Cursor. Set NO_OPEN_BROWSER
         * to disable browser opening", from the CLI's own `--help`
         * (2026.08.04-aaa8809). Inline rather than named, per this adapter's
         * rule: `getConfig()` is its only reader.
         *
         * The ACP server names the same flow from the other side: its
         * `initialize` reply advertises
         * `authMethods: [{ id: 'cursor_login', description: "… Run 'agent
         * login' first if not logged in." }]`, so this is the command the agent
         * itself points at.
         */
        loginArgs: ['login'],
        loginUnavailableReason: null,
        /**
         * `cursor-agent logout` — "Sign out and clear stored authentication",
         * read from `cursor-agent logout --help` on 2026.08.04-aaa8809. Inline
         * for the reason `loginArgs` above is: `getConfig()` is its only reader.
         */
        logoutArgs: ['logout'],
        logoutUnavailableReason: null,
        /**
         * EMPTY, and measured rather than assumed. Probed 2026-08-12 on
         * 2026.08.11-e8db854, `NO_OPEN_BROWSER=1 cursor-agent login` with stdin
         * CLOSED:
         *
         * ```
         * Starting login process...
         * Authenticating with Cursor...
         * Waiting for browser authentication...
         * Open a browser and navigate to this link: https://cursor.com/login…
         * ```
         *
         * It then waits on the browser and completes by itself — no code is ever
         * asked for, which is why a daemon-run sign-in needs no input field for
         * this CLI. A marker invented here would fire on nothing and put a dead
         * field in front of the user.
         */
        loginCodePromptMarkers: [],
        // Its authorization URL is the first link it prints.
        loginUrlPattern: null,
        /*
         * There is an ELECTRON-SIDE twin of these facts: this CLI's
         * `loginProbe` in `apps/ui/src/main/agents/cursor-agent.ts`, which asks
         * it whether it is signed in for the readiness chip. It cannot read this
         * block — it runs before any daemon handle exists — so a CLI gaining an
         * entry here needs one there too, or its chip reads ready while signed
         * out.
         */
        /**
         * OBSERVED, on 2026-08-12 against 2026.08.04-aaa8809, by driving a real
         * ACP handshake with the account logged out (`cursor-agent logout`):
         *
         * ```
         * initialize   -> SUCCEEDS, advertises authMethods: [cursor_login]
         * session/new  -> error { code: -32000,
         *                         message: 'Authentication required',
         *                         data: { message: "Authentication required.
         *                           Please run 'agent login' first, then call
         *                           authenticate() with methodId
         *                           'cursor_login'." } }
         * ```
         *
         * Two details a guess would have got wrong. The failure lands on
         * `session/new`, NOT on the prompt — `initialize` completes cleanly — so
         * a signed-out turn dies before a session exists. And the marker is
         * matched against the driver's rendering of that reply,
         * `acp session failed: Authentication required` (see
         * {@link AcpTurnDriver.onErrorReply}), which is why the short `message`
         * field and not the longer `data.message` is the string to carry.
         *
         * This became reachable only when geniro stopped injecting an API key:
         * while it did, the CLI was always authenticated and no lapsed-session
         * wording could occur. That is why the field sat empty for so long.
         *
         * RE-CHECK when a release changes the `session/new` refusal wording, or
         * moves the auth failure onto `session/prompt` (which would make a turn
         * fail after a session exists, a different shape than this).
         */
        expiredMarkers: ['acp session failed: authentication required'],
        /**
         * EMPTY on the same evidence gate its `expiredMarkers` sibling states:
         * no usage-limit failure has been OBSERVED from this CLI here. What has
         * been observed is the shape its failures take — it catches its own
         * transport errors, writes them out as prose and answers `end_turn`
         * regardless (see {@link CURSOR_TRANSIENT_FAILURE_PATTERN} and the
         * `AcpAgentFailureProtocol` block), and the four error CLASSES it names
         * there are transport verdicts rather than account ones.
         *
         * So a caller's failures from this CLI classify as `crashed`, which is
         * the honest answer: retry once, then report. RE-CHECK by driving a
         * cursor account past its own quota and reading what reaches the
         * `agent_message_chunk` — at which point both lists here gain a member.
         */
        rateLimitPatterns: [],
        resetsAtPatterns: [],
        // `Check your settings to continue` OBSERVED on run `2fc7014e`; the
        // other three are the same catch arm's table.
        serviceRefusalMarkers: CURSOR_AGENT_FAILURE_ACTION_SENTENCES,
        // Isolated so no other agent's child inherits the user's Cursor key.
        isolatedEnvKeys: [...CURSOR_CREDENTIAL_ENV_KEYS],
        /**
         * A key the USER exported in their own shell — geniro has none of its
         * own to inject, since the Keychain entry and its `GENIRO_` hop went
         * when `cursor-agent` was confirmed to authenticate from `~/.cursor`
         * (probed 2026-08-12: `status` reports the account with no such variable
         * in the environment).
         *
         * It is declared rather than simply left un-stripped because every other
         * agent's children are stripped of it: un-stripping would hand the user's
         * Cursor credential to the claude agent.
         *
         * The SAME list as the isolation above (`CURSOR_CREDENTIAL_ENV_KEYS`), so
         * the `CURSOR_AUTH_TOKEN` this CLI also authenticates from is re-injected
         * here by construction rather than by a second edit.
         */
        inheritedEnvKeys: CURSOR_CREDENTIAL_ENV_KEYS,
      },
      sessions: {
        /**
         * ACP has a first-class answer for this: `session/list`, which this
         * agent advertises (`sessionCapabilities.list`) and answers with
         * `{sessionId, cwd, title, updatedAt}` — including a GENERATED title,
         * which no disk scan could produce. Probed 2026-08-16 on
         * 2026.08.11-e8db854, with and without a `cwd` filter.
         */
        listingUnavailableReason: null,
        /**
         * The listing is complete for one store and this CLI keeps TWO. Probed
         * the same day: `session/list` returns only what lives in
         * `<configDir>/acp-sessions` (a fresh empty config dir answers with
         * zero rows, so it is profile-scoped, not a global index), while the
         * chats started by the interactive `cursor-agent` TUI live in
         * `~/.cursor/chats/<project>/<chatId>/` — a separate namespace the same
         * server refuses: `session/load` with one of those ids, under its own
         * recorded cwd, answers `-32602 … Session "…" not found`.
         *
         * Said out loud because the alternative is a user with months of
         * terminal history seeing four rows and concluding the import is
         * broken. Their route to those chats is `cursor-agent --resume`, in a
         * terminal, which is the handoff button and not this picker.
         */
        listingPartialReason:
          'only the conversations started in geniro are listed — cursor-agent keeps the ones you started in your terminal separately, and cannot reopen those from here',
        // `session/load` streams the whole prior conversation back before the
        // turn's prompt can be sent, so the history arrives on the first turn
        // via `AgentTurnInput.importSessionHistory` rather than off disk.
        historyUnavailableReason: null,
        /**
         * `session/list` answers with labels — id, cwd, title, timestamp — and
         * takes no search parameter, so the only text this CLI offers about a
         * conversation is the one line the row already shows. The transcript
         * itself is inside the agent's own per-session store, reachable only by
         * `session/load`, which REPLAYS a whole conversation over a spawned
         * process: searching a hundred of them means a hundred spawns.
         */
        contentSearchUnavailableReason:
          'cursor-agent searches conversation titles and folders only — it does not offer what was said inside them.',
      },
      configDir: {
        // No single variable carries the account; `configDirEnv` and
        // `profileRunEnv` below do (`utils/cursor-account.utils.ts`).
        envVar: null,
        unavailableReason: null,
        sessionCarryUnavailableReason:
          'cursor-agent has not been measured continuing a conversation under a second account, so the chat starts a fresh one',
      },
      userInstructions: {
        kind: 'unavailable',
        // Read off the 2026.10.01 bundle: every rule glob it loads is relative
        // to the workspace (`.cursor/rules/**/*.mdc`, `AGENTS.md`, `CLAUDE.md`),
        // and `user_rules` appears only as the name of a prompt section.
        reason:
          "cursor-agent's user rules are a Cursor account setting with no local file — edit them in Cursor's settings",
      },
      followUp: {
        /**
         * This said "ACP has no channel for a message mid-turn" for two
         * milestones, on the strength of the SPEC — `session/prompt` is one
         * request per turn — and it was wrong about the BINARY, which is the
         * distinction `.claude/rules/agent-adapters.md` exists to force.
         * Reported as "instant sending of a queued message doesn't work",
         * and probed on 2026.08.11-e8db854: a second `session/prompt` sent
         * against a live session is ACCEPTED. What it does is interrupt — the
         * first prompt answers `{"stopReason":"cancelled"}`, the second runs to
         * `end_turn`, and the agent plainly still holds the conversation (told
         * "STOP counting, reply BANANA" mid-count, it replied `BANANA`).
         *
         * So the channel exists and the driver owns it (`AcpTurnDriver.
         * sendFollowUp`, since the frame needs the session id and has to be
         * recorded to be understood), and what differs from claude is stated
         * below rather than hidden behind a working button.
         *
         * The driver no longer sends that second prompt straight away: it
         * sends `session/cancel` and waits for the interrupted prompt's reply
         * first. Re-measured on 2026.09.10-fd3934a, a prompt that was itself
         * sent to interrupt another can never be stopped — not by the next
         * prompt, not by `session/cancel` — and runs on to `end_turn` beside
         * the prompt that replaced it (grok-4.7 3/3, gpt-5.6-sol 1/1); cancel
         * first, and every prompt in a chain of four stopped cleanly. Re-probe
         * both on an upgrade before relaxing the wait.
         */
        unavailableReason: null,
        /**
         * True, and the field exists for this: a press drops whatever
         * cursor-agent is doing — a tool call in flight included — and answers
         * the new message instead. Claude's channel adds to the turn.
         */
        interrupts: true,
        /**
         * False, and nothing is lost by it: the follow-up is a `session/prompt`
         * of its own, and the driver already settles the turn only on the reply
         * to the most recent prompt — so no reply can end a turn under a
         * message it has not answered.
         */
        consumptionReported: false,
      },
      // Its model ids name their maker; `auto` names none. Read off
      // `cursor-agent models` on 2026-11-03.
      modelVendor: {
        kind: 'by-model-id',
        prefixes: [
          { prefix: 'claude-', vendor: 'anthropic' },
          { prefix: 'gpt-', vendor: 'openai' },
          { prefix: 'gemini-', vendor: 'google' },
          { prefix: 'grok-', vendor: 'xai' },
          { prefix: 'cursor-grok-', vendor: 'xai' },
          { prefix: 'composer-', vendor: 'cursor' },
        ],
      },
      usage: {
        /**
         * It reports NONE. Measured 2026-08-12 on 2026.08.11-e8db854, from a
         * full raw frame capture of two real turns (a read/edit turn and a
         * command turn) rather than from an empty field in the database:
         *
         * - The `session/update` variants sent across both turns were
         *   `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
         *   `tool_call_update`, `available_commands_update` and
         *   `session_info_update`. There was NO `usage_update` — the ACP
         *   notification this client reads (`AcpTurnDriver`'s `usage_update`
         *   arm, which takes `used` and `cost`).
         * - `session/prompt`'s reply was `{"stopReason":"end_turn"}` and nothing
         *   else — no `usage` object, the other channel the driver reads.
         * - `session_info_update`, the one variant the driver drops unread,
         *   carries a `title` and nothing more.
         * - Zero occurrences of any token/cost-shaped key anywhere in the
         *   captured frames.
         *
         * So the reader is correct and there is nothing to read ON THE WIRE: no
         * context used, no window, no spend. RE-CHECK by capturing a turn's
         * frames again — a `usage_update` appearing is all it would take, since
         * the driver already handles it and the meter would light up with no
         * further change here.
         *
         * The CONTEXT half of that is now answered off-protocol regardless, out
         * of this CLI's own session store (`readContext` in `createTurnDriver`),
         * so the sentence below names only what is still genuinely missing.
         * Saying more than that is what the reported defect was made of: the
         * reason claimed there was "no context figure to show" while the panel
         * three pixels away was showing one.
         */
        unavailableReason:
          'cursor-agent does not report what a conversation costs, so no cost can be shown for this chat',
        // Its real bill is READ from the account (`polledSpend` below), and it
        // carries discounts and fees no list price knows — a catalog figure
        // would be a second, disagreeing answer. Its model ids are also
        // Cursor's own namespace (`auto-smart`, `composer-2.5`), not one
        // provider's API ids.
        listPrice: {
          kind: 'unavailable',
          reason:
            'cursor-agent is billed through your Cursor account, which this app reads directly — a public list price would disagree with it',
        },
        /**
         * No breakdown either — RE-MEASURED 2026-08-15 on 2026.08.11-e8db854,
         * because "the CLI shows a percentage, so it must send one" is a
         * reasonable thing to expect and the old note rested on an older
         * capture.
         *
         * What was actually checked this time:
         *
         * - A full raw frame capture of a real TOOL-USING turn (read a file,
         *   answer, end) through the daemon's own `agent-stdio` channel. The
         *   `sessionUpdate` variants sent were `user_message_chunk`,
         *   `agent_message_chunk`, `available_commands_update`, `tool_call`
         *   and `tool_call_update`. `session/prompt` answered
         *   `{"stopReason":"end_turn"}` and nothing else. Grepping the whole
         *   capture for any key matching token/usage/cost/context found
         *   exactly three, all of them the word "context" inside
         *   `promptCapabilities.embeddedContext`. There is no usage on this
         *   wire, at all.
         * - The shipped bundle: `usage_update` appears ONLY in the ACP schema
         *   module (`8096.index.js`, the protocol's own type definitions) and
         *   in no module that sends anything — the schema knows the shape, the
         *   agent never emits it.
         * - The CLI DOES count tokens, which is why its TUI can show a
         *   percentage: `tokenDelta` carries a running `tokens`, and
         *   `GetEffectiveTokenLimitResponse{token_limit}` is a server call it
         *   makes. Both live on its own internal interaction stream — the one
         *   the TUI renders — and neither is forwarded to an ACP client.
         * - Cursor's CLI docs list no `/context`, `/usage` or `/tokens`
         *   command and no output-format field carrying any of it. The one
         *   related command, `/summarize`, FREES context rather than reporting
         *   it.
         *
         * So the gap is real and structural, not a field this adapter is
         * failing to read. RE-CHECK by re-running that capture — a single
         * `usage_update` frame appearing is all it would take, since
         * `AcpTurnDriver` already reads one; and `readContextUsage` below is
         * where a breakdown would be assembled if the picture changes.
         */
        /**
         * It DOES report a breakdown — just not over ACP. It writes a full
         * per-category accounting into its own session store for every turn,
         * and `readContextUsage` below reads it from there. See that method
         * and `utils/cursor-context-store.utils.ts`.
         */
        breakdown: { kind: 'reads', channel: 'session-store' },
        /**
         * Nothing on the ACP transport says anything about the ACCOUNT, so the
         * limits are asked of the account itself, the way the CLI's own
         * `/usage` asks them — see {@link readPlanLimits}.
         */
        planLimits: { kind: 'reads', channel: 'account' },
        // No cost crosses the ACP wire, so a conversation's price is read from
        // the account — see `utils/cursor-usage.utils.ts` for the evidence.
        polledSpend: true,
      },
      /**
       * Probe-verified on 2026.07.23-e383d2b, and the reason is worse than a
       * plain no: `cursor-agent --resume <id>` ACCEPTS an ACP session id and
       * then opens an EMPTY chat, silently creating one under that id. ACP
       * sessions are not in the CLI's chat store — asked for a codeword set in
       * the ACP session, the resumed CLI answered NOTHING-HERE. Cursor's own
       * IDE is no route either: staff confirm IDE and CLI chats are separate
       * stores that do not sync, and no open-by-id deeplink exists.
       *
       * So the button must be refused rather than wired: it would look like it
       * worked and drop the user into a blank conversation.
       *
       * RE-VERIFIED 2026-08-11 against 2026.08.04-aaa8809, because a user asked
       * for exactly this button and a sibling claim in this same config (that
       * ACP carries no per-session model) had been refuted by a later probe. It
       * held, and now has a mechanism rather than an observation:
       *
       * - THREE stores, built by two path helpers in the shipped bundle:
       *   `chats/<md5(abs cwd)>/<uuid>/store.db` (what `--resume` reads),
       *   `acp-sessions/<uuid>/store.db` (what ACP writes, referenced only by
       *   the ACP module), and the IDE's own `state.vscdb`.
       * - `md5` of this repo's path resolves to a `chats/` directory that
       *   EXISTS AND IS EMPTY while `~/.cursor/acp-sessions/` holds nine
       *   sessions naming that same cwd. That is precisely why `--resume`
       *   opened a blank chat: it looks somewhere ACP never writes.
       * - Cross-store id joins: 23 ACP ids and 2556 CLI chat ids against the
       *   IDE's 708 `composerHeaders` rows — zero matches either way. Ids are
       *   UUIDs in all three, so the separation is the STORE, never the format.
       * - `Cursor.app` declares one URL scheme (`cursor`) and no route targets a
       *   thread by id; `/prompt?text=` opens a NEW chat. A per-agent web URL
       *   (`cursor.com/agents/bc-…`) is minted only for `kind === "cloud"`, and
       *   a local run has no `bc-…` id to put in it.
       * - Cursor staff, 2026-07-13, naming the paths: "no common stable session
       *   id and no IDE to CLI bridge for `--resume`."
       *
       * RE-VERIFIED AGAIN 2026-08-12, against the newer 2026.08.11-e8db854 and
       * Cursor 3.15.6, because a user asked a second time — for "open this
       * session in Cursor web or the Cursor app, the way we do with claude in a
       * terminal". Still no. What is new is that the separation is now read off
       * the SHIPPED SOURCE rather than inferred from directory contents, which
       * is the strongest form this can take short of the vendor changing it:
       *
       * - Both store paths are HARDCODED, with no flag, env var or config key
       *   between them. `join(cursorHome, "acp-sessions")` appears in exactly
       *   one chunk (`2996.index.js`, the ACP module) and
       *   `join(cursorHome, "chats") / md5(resolve(cwd))` in four others. So
       *   there is no setting that would make an ACP session land where
       *   `--resume` looks; it is not a default to override.
       * - `2996.index.js` is the only chunk naming both `acp-sessions` and
       *   `resume`, and its single `resume` mention is not a read of that store.
       * - An ACP session's `meta.json` carries `{schemaVersion, cwd, title}` —
       *   no chat id, and no `bc-…`, so neither re-check trigger below has
       *   fired. Nor is any `bc-…` id present anywhere in a local session's
       *   `store.db-wal`.
       * - The ONLY `cursor://` route in the whole bundle is
       *   `cursor://internal/local-pr-creation-forge`. Cursor.app still
       *   declares the one `cursor` scheme.
       * - The `cursor` IDE CLI's only chat affordance is `--chat` ("Open a
       *   standalone chat window"), which opens a NEW one in the IDE's own
       *   third store.
       *
       * Re-check when either of two specific things changes, not on the general
       * "it's on our radar": a `cli`/`acp` member appearing in the IDE's
       * `conversation-search` `source` union, or a `bc-…` id being minted for a
       * local run — which would make the existing `background-agent?bcId=`
       * deeplink template suddenly applicable.
       *
       * The user is no longer left to guess at the absence: this sentence is
       * what `GET /v1/capabilities` now reports (it used to be replaced with a
       * generic one), so the panel renders the control inert and says this on
       * hover instead of hiding it.
       */
      handoff: {
        kind: 'unavailable',
        reason:
          'cursor-agent cannot reopen a geniro conversation in your terminal — it keeps those separately from its own chats, and would open an empty one instead',
      },
    };
  }

  /**
   * The models this account can run, read from an ACP handshake.
   *
   * An earlier revision returned `[]` and said ACP carries no per-session
   * model. The binary disproves it (2026.08.04-aaa8809): `session/new` replies
   * with a `models` block naming `currentModelId` and `availableModels`, and
   * `session/set_model` answers `{}` — which {@link AcpTurnDriver} now sends
   * before the prompt, so a chosen model is applied rather than discarded.
   *
   * Read from the HANDSHAKE and never from `cursor-agent models`, though the
   * subcommand exists and would be one cheap `execFile`: the two print
   * different id namespaces for the same model — `claude-opus-5-thinking-high`
   * there against
   * `claude-opus-5[thinking=true,context=300k,effort=high,fast=false]` here —
   * and `session/set_model` rejects the subcommand form outright with
   * `-32602 Invalid model value`. A picker built from it would refuse every
   * choice the user made.
   *
   * `processGroup` for the reason the MCP listing needs it: this spawns a real
   * CLI that stays alive, so the read owns terminating it. It cannot be an
   * `execFile` either way — the answer requires WRITING two frames first.
   */
  override async listModels(
    input: AgentModelsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentModel[]> {
    // A DISPOSABLE folder, never the daemon's own cwd. A model vocabulary is an
    // ACCOUNT fact — `ModelsService` caches it per CLI version with no cwd in
    // the key — so no caller's folder belongs here; but `session/new` still
    // roots a real agent session at whatever it is given, and `resolve-cwd.ts`
    // records that an agent must never default to the daemon's own directory,
    // which under `pnpm dev` is this repo.
    // Created INSIDE the try for the reason `listReportedCommands` does it:
    // an unusable probe root must degrade to "we could not ask", never throw
    // out of a listing.
    let cwd = '';
    let profile = '';
    try {
      cwd = this.makeProbeRoot('models');
      // Its own profile, like a turn's: a parameterized handshake can migrate a
      // persisted variant selection, which WRITES the config directory — and a
      // listing must never change what the user's own CLI opens with.
      //
      // With NO session store, unlike a turn's: this handshake opens a real
      // `session/new`, and a probe's throwaway conversation has no business in
      // the store a chat resumes from. It dies with the profile below.
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        homeDir: this.cursorOptions.homeDir,
        ...this.profileSeed(input.configDir),
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        cwd,
        stdinWrites: acpModelProbeFrames({
          cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          // The SAME handshake a turn sends. Without it the probe would list the
          // bracketed variant ids while turns speak bare names, and every model
          // the picker offered would be refused.
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpModelProbeSettled,
        env: {
          [CURSOR_CONFIG_DIR_ENV]: profile,
          ...this.profileRunEnv(input.configDir),
        },
        timeoutMs: options.timeoutMs ?? CURSOR_MODEL_PROBE_TIMEOUT_MS,
      });
      return this.readModelProbe(stdout);
    } catch {
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * The effort levels ONE model of this CLI accepts.
   *
   * Overridden because for this CLI the vocabulary belongs to the MODEL, not
   * to the binary — `AdapterConfig.efforts` can only ever be the UNION, and a
   * union is what offered `max` on a model that refuses it. Measured
   * 2026-08-19 on 2026.08.11-e8db854, one seeded handshake per model:
   *
   * - `claude-opus-5` → `low medium high xhigh max`
   * - `grok-4.6`      → the same MINUS `max`
   * - `auto-smart`, `composer-2.5` → no `effort` option at all
   *
   * ONE `session/new` answers it, because the reply describes the model the
   * session opened ON — so the model is seeded into the probe profile's
   * `cli-config.json` rather than switched afterwards, which would cost a
   * second round trip (2.2–3.0s measured) for the same answer.
   *
   * Every failure degrades to the CLI-wide superset rather than to silence: a
   * level wrongly hidden is a control the user cannot reach, while one wrongly
   * offered is refused with a sentence on the turn. Only a reply that
   * enumerated options AND did not enumerate this one narrows anything.
   */
  override async listModelEfforts(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentEffortListing> {
    const config = this.getConfig();
    const superset: AgentEffortListing = {
      efforts: [...config.efforts],
      unavailableReason: config.effortsUnavailableReason,
      // Every `return superset` below is a stand-in for an answer this CLI
      // could not give — no model named, the handshake failed or timed out, or
      // the reply enumerated nothing. None of them may ground a refusal.
      exact: false,
    };
    // No model chosen yet — the picker still needs rows, and the union is the
    // honest answer to "what does this CLI offer at all".
    const wanted = (model ?? '').trim();
    if (wanted === '') {
      return superset;
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'efforts',
      options,
    );
    return stdout === undefined
      ? superset
      : this.readEffortProbe(stdout, wanted, superset);
  }

  /**
   * The window sizes ONE model offers, from the same handshake reply the effort
   * listing reads.
   *
   * SAME probe, different option, and no superset behind it: a window size only
   * means anything against the model it belongs to (see
   * `AdapterConfig.contextWindowsUnavailableReason`), so a probe that could not
   * be taken answers "nothing to offer, and here is why" rather than standing
   * in with a union of other models' sizes.
   *
   * Shares its handshake with the effort listing through
   * {@link handshakeProbeCache} rather than running its own: the two chips are
   * asked at different moments by different screens (`EffortsService` /
   * `ContextWindowsService`, each behind its own `ModelVocabularyCache`), so a
   * cold model used to spawn the ~2s handshake TWICE for the one reply.
   * Caching the RAW reply rather than the parsed answer PAIR is what makes
   * that safe — this method still reads its own option out of whatever came
   * back, so nothing here has to agree with the effort listing about what the
   * reply means.
   */
  override async listModelContextWindows(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentContextWindowListing> {
    const wanted = (model ?? '').trim();
    // No model chosen yet. Unlike the effort chip there is no union to fall
    // back on, so the picker draws nothing and says what would fill it.
    //
    // TWIN PARSER: `NO_MODEL_REASON` in
    if (wanted === '') {
      return {
        windows: [],
        unavailableReason:
          'pick a model to see the context-window sizes it offers',
        // The one kind the chip renders differently: nothing has been asked
        // yet, so it says "pick a model" rather than claiming a fixed window
        // for a model nobody has chosen. Carried as a KIND rather than left
        // for the renderer to recognise in this sentence, so rewording the
        // prose here cannot silently change what the control says.
        unavailableKind: 'no-model',
        exact: false,
      };
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'windows',
      options,
    );
    return this.readContextWindowProbe(stdout ?? null, wanted);
  }

  /**
   * Every OTHER setting this model enumerates — the same handshake reply again,
   * read as a SUBTRACTION instead of a lookup.
   *
   * The two listings above each ask the reply for one id they were written
   * knowing. This one asks for everything and removes what geniro already
   * drives ({@link CURSOR_OWNED_PARAMETER_IDS}, plus the model option by its
   * protocol category), so a setting nobody here has heard of still reaches the
   * user. Measured 2026-08-26 on 2026.08.11-e8db854, one seeded handshake per
   * model — three axes were invisible before this existed: `optimize_for`
   * (`auto-smart` only: intelligence | balanced | cost), `thinking`
   * (`claude-opus-5`) and `fast` (`claude-opus-5`, `gpt-5.6-sol`).
   *
   * An option the reply named with NO values is dropped rather than offered: a
   * picker with nothing to pick is the dead control this app keeps removing.
   */
  override async listModelParameters(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentModelParameterListing> {
    const wanted = (model ?? '').trim();
    // No model chosen yet. Like the context listing and unlike the effort one
    // there is no union to fall back on — these axes exist per model, and
    // `optimize_for` exists on exactly one of the thirty-four.
    if (wanted === '') {
      return {
        parameters: [],
        unavailableReason: 'pick a model to see the settings it offers',
        exact: false,
      };
    }
    const stdout = await this.probeModelConfigOptionsShared(
      wanted,
      'parameters',
      options,
    );
    return this.readModelParameterProbe(stdout ?? null, wanted);
  }

  /**
   * The subtraction itself.
   *
   * Same three-way split the effort reader documents, with one difference that
   * matters: a probe that could not be taken answers EMPTY rather than standing
   * in with anything, because there is nothing to stand in with. It is marked
   * `exact: false` so a caller can tell "this model has no further settings"
   * from "nobody could ask".
   */
  private readModelParameterProbe(
    stdout: string | null,
    model: string,
  ): AgentModelParameterListing {
    if (stdout === null || !acpProbeEnumeratedConfigOptions(stdout)) {
      return {
        parameters: [],
        unavailableReason: `cursor-agent could not be asked which settings ${model} offers`,
        exact: false,
      };
    }
    const enumerated = readAcpConfigOptionsProbe(stdout);
    // The EFFORT axis is subtracted by the option the listing actually adopted,
    // never by the id list alone: a spelling that reaches the effort picker
    // through the category fallback would otherwise ALSO arrive here as a
    // generic chip, which is the duplicate `Effort` row `grok-4.7` was
    // reported for. One reading, so the two cannot disagree.
    const effortId = cursorEffortOption(enumerated)?.id ?? null;
    const parameters = enumerated
      .filter(
        (option) =>
          option.category !== ACP_MODEL_CONFIG_CATEGORY &&
          !CURSOR_OWNED_PARAMETER_IDS.includes(option.id) &&
          option.id !== effortId &&
          option.options.length > 0,
      )
      .map((option) => ({
        id: option.id,
        // The agent's own word, never a prettified id: `Optimize For` is what
        // cursor calls `optimize_for`, and inventing that string here would be
        // this app naming another product's setting.
        label: option.name ?? option.id,
        values: option.options.map(({ value, name }) => ({
          id: value,
          label: name,
        })),
        current: option.currentValue,
      }));
    return {
      parameters,
      unavailableReason:
        parameters.length === 0
          ? `${model} offers no settings beyond the ones already on screen`
          : null,
      exact: true,
    };
  }

  /**
   * {@link probeModelConfigOptions}, joined through {@link handshakeProbeCache}
   * so `listModelEfforts` and `listModelContextWindows` share ONE handshake
   * for the same (model, binary version) instead of each spawning its own.
   *
   * The RAW reply is what is shared rather than a parsed answer: each listing
   * still reads its own axis out of it, which is what lets the two agree on
   * one probe without agreeing on what the probe means. That is also why this
   * sits BELOW the caches `EffortsService` and `ContextWindowsService` hold —
   * those keep each service's own PARSED vocabulary, so a cold model missed in
   * both and spawned the handshake twice, neither able to see the other's
   * in-flight probe.
   *
   * `label` still reaches the underlying probe on a cache MISS, so the
   * throwaway profile root it names is unaffected; a HIT answers with no
   * spawn at all, so which label the joining caller asked under is moot.
   *
   * {@link ModelProbeStore} sits INSIDE that cache's fetch rather than beside
   * it, which is what makes the two one mechanism: the single-flight, the
   * version check and the TTL still decide, and the disk is consulted only on
   * the path that would otherwise spawn. That ordering is also the reason the
   * read is synchronous — an await here would let a second caller past the
   * check the cache just made.
   */
  private async probeModelConfigOptionsShared(
    model: string,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    const version = await this.resolveBinaryVersion(options);
    const kind = this.getConfig().kind;
    // A NULL profile, always: what a model offers is the model's, asked of the
    // default account, and keying by profile would only split it into copies,
    // each paying this CLI's own cold handshake — measured at 6–7s.
    const stored = this.vocabularyStore.read(
      kind,
      model,
      null,
      version,
      isProbeReply,
    );
    if (stored !== null) {
      if (stored.stale) {
        // BEHIND the answer, never in front of it: the stored reply is still
        // the best anyone has, so making the user wait for a re-ask would spend
        // the six seconds this store exists to remove.
        void this.takeModelConfigOptions(kind, model, version, label, options);
      }
      return stored.value;
    }
    return this.takeModelConfigOptions(kind, model, version, label, options);
  }

  /**
   * The ask itself, joined through {@link handshakeProbeCache} so a cold read
   * and a background refresh cannot spawn two process groups for one answer.
   *
   * Never rejects — every caller is either serving a picker or running behind
   * an answer already given, and neither has anywhere to put a rejection.
   */
  private takeModelConfigOptions(
    kind: AgentKind,
    model: string,
    version: string | null,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    return this.handshakeProbeCache
      .read(kind, model, null, version, async () => {
        // Read BEFORE the probe: an answer whose probe straddled a sign-in is
        // the previous account's, and the store refuses it by this.
        const askedAt = this.vocabularyStore.epoch(kind);
        const fresh = await this.probeModelConfigOptions(model, label, options);
        // Only a reply that ENUMERATED options is worth keeping. The two it
        // excludes are the ones that would be served back as a fact: a probe
        // that could not be taken at all is `undefined`, and a reply nothing
        // can read would be re-served as "cursor-agent could not be asked" long
        // after whatever broke it was fixed.
        if (
          typeof fresh === 'string' &&
          acpProbeEnumeratedConfigOptions(fresh)
        ) {
          this.vocabularyStore.remember(
            kind,
            model,
            null,
            version,
            fresh,
            askedAt,
          );
        }
        return fresh;
      })
      .catch(() => undefined);
  }

  /**
   * One model's `session/new` handshake, as raw stdout — or `undefined` when it
   * could not be taken at all.
   *
   * Extracted because two listings read the same reply for different options,
   * and the SEEDED PROFILE is the mechanism both depend on: the reply
   * enumerates the parameters of whatever model the profile currently holds
   * (measured — a fresh profile opens on `composer-2.5`, which has neither an
   * effort nor a context axis), so the model is chosen by seeding rather than
   * by a `session/set_config_option` round trip.
   *
   * Reached directly only on a {@link handshakeProbeCache} miss — both public
   * listings go through {@link probeModelConfigOptionsShared}.
   */
  private async probeModelConfigOptions(
    model: string,
    label: string,
    options: AgentCommandOptions,
  ): Promise<string | null | undefined> {
    let cwd = '';
    let profile = '';
    try {
      cwd = this.makeProbeRoot(label);
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        homeDir: this.cursorOptions.homeDir,
        // The whole mechanism — see the seed's own doc block.
        model,
      });
      return await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        cwd,
        stdinWrites: acpModelProbeFrames({
          cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpModelProbeSettled,
        env: { [CURSOR_CONFIG_DIR_ENV]: profile },
        timeoutMs: options.timeoutMs ?? CURSOR_MODEL_PROBE_TIMEOUT_MS,
      });
    } catch {
      return undefined;
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * What one model's handshake said about its window sizes.
   *
   * Three answers, and every one of them is the CLI's own:
   *
   * - the handshake enumerated a `context` option → its values, in that CLI's
   *   words (`300k`, `1m`), which is the whole picker. Nothing is cached and no
   *   size is stated here — the vocabulary comes from the agent, per model, on
   *   every listing, so it cannot go stale;
   * - it enumerated options and NOT that one → this model has no choice to
   *   offer, and geniro can say what it DOES run at, because Max Mode is on
   *   unless the user turned it off ({@link CURSOR_MAX_MODE}): the model's
   *   largest window;
   * - anything else → the probe could not be taken. Unreadable is not the same
   *   as absent, so the sentence says the CLI could not be asked rather than
   *   naming the model.
   *
   * The middle answer briefly became two rows of geniro's own invention
   * (`standard` / `max mode`) whose sizes were LEARNED from turns that had run.
   * That is gone, on the two objections that killed it: Max Mode is a mode
   * rather than a context window, and a learned size is a cache that is wrong
   * from the moment the vendor changes a number until the user next runs a turn.
   */
  private readContextWindowProbe(
    stdout: string | null,
    model: string,
  ): AgentContextWindowListing {
    if (stdout !== null) {
      const option = readAcpConfigOptionProbe(
        stdout,
        CURSOR_CONTEXT_WINDOW_PARAMETER_ID,
      );
      if (option !== null && option.options.length > 0) {
        return {
          windows: option.options.map(({ value, name }) => ({
            id: value,
            label: name,
          })),
          unavailableReason: null,
          unavailableKind: null,
          exact: true,
        };
      }
      if (acpProbeEnumeratedConfigOptions(stdout)) {
        return {
          windows: [],
          unavailableReason: `${model} offers no context setting — it runs at the full window Max Mode gives it.`,
          unavailableKind: 'fixed-window',
          exact: true,
        };
      }
    }
    return {
      windows: [],
      unavailableReason:
        'cursor-agent could not be asked which context windows this model offers',
      unavailableKind: 'unreadable',
      exact: false,
    };
  }

  /**
   * Narrow the superset to what one model's handshake enumerated.
   *
   * Three answers, and the split is the point:
   * - the reply named this option → its values, in the agent's own order;
   * - the reply enumerated options and NOT this one → genuinely none, with the
   *   model named in the reason, since a picker that silently disappears reads
   *   as broken;
   * - anything else (the probe failed, the agent enumerated nothing) → the
   *   superset. Silence is not a refusal, the rule every reader in this
   *   transport follows.
   */
  private readEffortProbe(
    stdout: string | null,
    model: string,
    superset: AgentEffortListing,
  ): AgentEffortListing {
    if (stdout === null) {
      return superset;
    }
    // Which option IS this axis is `cursorEffortOption`'s to say — every
    // spelling the vendor has been seen to use, then the category — because the
    // subtraction in `readModelParameterProbe` has to reach exactly the option
    // adopted here. Reading only the first name left the OpenAI family with no
    // picker at all; reading only the NAMES left `grok-4.7` with two.
    const option = cursorEffortOption(readAcpConfigOptionsProbe(stdout));
    if (option !== null) {
      return {
        efforts: option.options.map(({ value, name }) => ({
          id: value,
          label: name,
        })),
        unavailableReason: null,
        exact: true,
      };
    }
    if (!acpProbeEnumeratedConfigOptions(stdout)) {
      return superset;
    }
    return {
      efforts: [],
      unavailableReason: `${model} has no reasoning-effort setting — pick a model that does, or run it at its own default.`,
      // The agent enumerated its options and this model's axis was not among
      // them, which is an answer about the model rather than a failure to ask.
      exact: true,
    };
  }

  private readModelProbe(stdout: string | null): AgentModel[] {
    if (stdout === null) {
      // A failed probe is an unknown vocabulary, not an empty one. Returning
      // [] is what the picker renders as "default model only", which is the
      // honest reading of "we could not ask".
      return [];
    }
    // The ids come back BARE now (`claude-opus-5`, not the bracketed form) —
    // the probe speaks the same parameterized handshake a turn does, so what the
    // picker stores is what a turn can apply. That is also why no effort is read
    // out of an id here any more: on this transport the effort is its own control.
    return readAcpModelProbe(stdout).map((model) => ({
      id: model.modelId,
      label: model.name,
      source: 'cli',
    }));
  }

  /**
   * `cursor-agent mcp list` exists, so this shells out rather than declaring an
   * absence — the fork milestone 4 opened, resolved against the real binary.
   *
   * `processGroup` for the same reason claude's listing needs it: the command
   * HEALTH-CHECKS, which means it launches the user's own stdio servers as
   * children, and killing only the CLI would leave them behind.
   *
   * The three-way split mirrors claude's, and carries the same weight:
   * - a null stdout is the command having FAILED (missing binary, non-zero
   *   exit, deadline) and is reported as such;
   * - zero rows WITH the CLI's empty-folder sentence is a real empty listing;
   * - zero rows WITHOUT it means the output could not be read. That third case
   *   is load-bearing here in a way it is not for claude: cursor rows have no
   *   structural marker, so a reworded release can leave NOTHING in the output
   *   shaped like a row, and this is what turns that into a visible "format
   *   may have changed" instead of a cached "no servers". A row whose STATUS
   *   alone is unrecognised is kept and badged `unknown` rather than dropped
   *   — milestone 4 reversed the drop rule, because a listed server with its
   *   health unstated beats one the user cannot see at all.
   */
  override async listMcpServers(
    input: AgentMcpServersInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    const stdout = await this.runCommand([...CURSOR_MCP_LIST_ARGS], {
      ...options,
      cwd: input.cwd,
      processGroup: true,
      timeoutMs: options.timeoutMs ?? CURSOR_MCP_LIST_TIMEOUT_MS,
    });
    if (stdout === null) {
      return { ok: false, reason: CURSOR_MCP_LIST_FAILED_MESSAGE };
    }
    const servers = parseCursorMcpList(stdout);
    // Anchored to the START OF A LINE, not searched across the whole buffer:
    // the sentence is ordinary English, so a server whose status wording merely
    // CONTAINS it ("weird-srv: No MCP servers configured are approved yet")
    // would otherwise satisfy the empty check and turn an unreadable listing
    // into a confident "this folder has none".
    const saidEmpty = stdout
      .split('\n')
      .some((line) => line.trim().startsWith(CURSOR_MCP_EMPTY_MARKER));
    if (servers.length === 0 && !saidEmpty) {
      return { ok: false, reason: CURSOR_MCP_LIST_UNREADABLE_MESSAGE };
    }
    return { ok: true, servers };
  }

  /**
   * The folder this CLI files a workspace's MCP switches and sign-ins under —
   * its own git-root walk, which does not follow a worktree to its main
   * repository (`cursorProjectRoot`).
   */
  override mcpRepositoryKey(cwd: string): Promise<string> {
    return Promise.resolve(cursorProjectRoot(cwd));
  }

  /**
   * Dial ONE server, so a row the user just switched on can say what it found.
   *
   * `mcp list-tools <server>` is the only per-server command this CLI has, and
   * listing a server's tools requires connecting to it — which makes it a health
   * probe with a folder listing's meaning at a fraction of its cost
   * ({@link CURSOR_MCP_TOOLS_ARGS} carries the timings and the captured output).
   *
   * `processGroup` because it DIALS: a stdio server is launched as a grandchild
   * of this command, and a single-PID kill would leave it running. `captureDiagnosis`
   * because the two readings worth telling apart — needs signing in, versus
   * broken — both exit 1 and both write to stderr, so the usual null-on-failure
   * would collapse them into each other.
   *
   * Never throws: an unreadable answer is null, and the caller leaves the row's
   * health unstated rather than inventing one.
   */
  override async readMcpServerHealth(
    input: AgentMcpServerHealthInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    const output = await this.runCommand(
      [...CURSOR_MCP_TOOLS_ARGS, input.server],
      {
        ...options,
        cwd: input.cwd,
        processGroup: true,
        captureDiagnosis: true,
        timeoutMs: options.timeoutMs ?? CURSOR_MCP_TOOLS_TIMEOUT_MS,
      },
    );
    return parseCursorToolsProbe(output);
  }

  /**
   * The folder's installed plugins, read at most once per
   * `CURSOR_PLUGIN_SCAN_TTL_MS` for the listings that keep asking. A copy reads
   * them fresh instead: it writes, and a write acts on what is there now.
   */
  private scanPlugins(cwd: string): Promise<CursorPlugin[]> {
    const now = Date.now();
    const held = this.pluginScans.get(cwd);
    if (held !== undefined && now - held.at < CURSOR_PLUGIN_SCAN_TTL_MS) {
      return held.plugins;
    }
    for (const [key, scan] of this.pluginScans) {
      if (now - scan.at >= CURSOR_PLUGIN_SCAN_TTL_MS) {
        this.pluginScans.delete(key);
      }
    }
    const plugins = readCursorPlugins(this.cursorHome(), cwd);
    this.pluginScans.set(cwd, { at: now, plugins });
    return plugins;
  }

  /**
   * Where this folder's servers were defined, and what cursor's own app loads
   * on top of them.
   *
   * The two lists this method is named for stay EMPTY here, and that is
   * unchanged: cursor reports a switched-off server as `disabled` in the
   * listing itself, and `mcp enable` undoes the only state its switch writes,
   * so there is no disabled set to read and nothing locked off. What the
   * listing genuinely cannot say is which SCOPE a row came from — it merges the
   * two files by name and prints one row each. It also answers which installed
   * plugins declare servers the ACP session never loads
   * (`cursor-plugins.utils.ts`), so every listing scans the plugin cache.
   *
   * Read-only and best-effort throughout: every file here belongs to the user,
   * and an unreadable one costs a label rather than the listing.
   */
  override async readMcpFolderFacts(cwd: string): Promise<AgentMcpFolderFacts> {
    const cursorHome = this.cursorHome();
    const projectRoot = cursorProjectRoot(cwd);
    const [user, workspace, plugins] = await Promise.all([
      readFileSafe(join(cursorHome, CURSOR_MCP_CONFIG_NAME)),
      readFileSafe(
        join(projectRoot, CURSOR_HOME_DIR_NAME, CURSOR_MCP_CONFIG_NAME),
      ),
      this.scanPlugins(cwd),
    ]);
    const userServers = parseMcpServers(user) ?? {};
    const workspaceServers = parseMcpServers(workspace) ?? {};
    const userNames = Object.keys(userServers);
    const workspaceNames = Object.keys(workspaceServers);
    return {
      // The union of the two files this CLI merges, deduped BY NAME because
      // that is how the CLI itself merges them — a name defined at both scopes
      // is one server, which is the same collapse `origins` describes.
      configured: [...new Set([...userNames, ...workspaceNames])],
      disabled: [],
      lockedOff: [],
      origins: mcpOrigins(userNames, workspaceNames),
      interactiveOnlyNote: plugins.length > 0 ? CURSOR_PLUGIN_NOTE : null,
      plugins: describeCursorPlugins(plugins, {
        ...userServers,
        ...workspaceServers,
      }),
    };
  }

  /**
   * Copy one plugin server into `~/.cursor/mcp.json`, the user-scope config an
   * ACP session reads servers from beside the project's own
   * (`CURSOR_PLUGINS_DIR_NAME` says why plugins are not). Written directly
   * because the CLI has no subcommand that adds an entry.
   *
   * The write mirrors claude's toggle: a strict re-read (a missing file is
   * empty, an unparseable one is refused rather than replaced, since it holds
   * every server the user has), no write when the entry is already there, and
   * an atomic, fsynced replace that keeps the file's mode and any symlink.
   * Unlike claude there is no lock to share — the CLI takes none on this file.
   */
  override copyPluginMcpServer(
    input: AgentMcpPluginCopyInput,
  ): Promise<AgentMcpPluginCopyResult> {
    // One read-modify-write at a time: two Adds landing together (two windows,
    // or the desktop and a paired phone) would otherwise each read the file
    // before the other wrote it, and the second write would drop the first
    // server. On the adapter because it guards the user's ONE file, which every
    // request reaches through this one instance.
    return this.serializeMcpConfigWrite(() => this.copyPluginEntry(input));
  }

  /** One read-modify-write of `~/.cursor/mcp.json` at a time — see {@link copyPluginMcpServer}. */
  private serializeMcpConfigWrite<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mcpConfigWrites.then(run);
    this.mcpConfigWrites = next.catch(() => undefined);
    return next;
  }

  /** `~/.cursor/mcp.json` — the user-scope file, whatever the profile (see `readMcpFolderFacts`). */
  private userMcpConfigFile(): string {
    return join(this.cursorHome(), CURSOR_MCP_CONFIG_NAME);
  }

  /**
   * The user-scope servers — `mcpServers` of `~/.cursor/mcp.json`, the file
   * the ACP sessions read beside the project's own. The profile is ignored, as
   * every MCP read of this CLI ignores it: the file is the HOME directory's
   * (measured — a fresh `CURSOR_CONFIG_DIR` still loads it), so ignoring it
   * keeps the editor and the turns describing one file.
   */
  override async readMcpConfigDocument(): Promise<AgentMcpConfigDocument> {
    const file = this.userMcpConfigFile();
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
      CURSOR_MCP_SERVERS_KEY,
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

  /** Replace `mcpServers` and nothing else — the plugin copy's discipline. */
  override writeMcpConfigDocument(
    input: AgentMcpConfigWriteInput,
  ): Promise<AgentMcpConfigWriteResult> {
    return this.serializeMcpConfigWrite(() =>
      this.rewriteUserMcpServers((servers) =>
        mcpServersVersion(servers) !== input.expectedVersion
          ? { refusal: MCP_CONFIG_MOVED_REASON }
          : isDeepStrictEqual(servers, input.servers)
            ? null
            : { servers: input.servers },
      ),
    );
  }

  /**
   * A DIRECT write of one entry, because this CLI has no `mcp add` (see
   * {@link CURSOR_MCP_SERVERS_KEY}) — the shape its `mcp.json` reads
   * (`command`/`args`/`env`, or `url`/`headers`), under the same discipline.
   */
  override addMcpServer(
    input: AgentMcpServerAddInput,
  ): Promise<AgentMcpConfigWriteResult> {
    const { server } = input;
    return this.serializeMcpConfigWrite(() =>
      this.rewriteUserMcpServers((servers) =>
        Object.hasOwn(servers, server.name)
          ? { refusal: mcpServerExistsReason(server.name) }
          : {
              servers: {
                ...servers,
                [server.name]: mcpServerJsonEntry(server),
              },
            },
      ),
    );
  }

  /**
   * The one read-modify-write of `~/.cursor/mcp.json`'s `mcpServers` the
   * editor and the Add form share: a strict re-read (a missing file is empty,
   * an unparseable one is refused rather than replaced, since it holds every
   * server the user has), every other key kept, and an atomic, fsynced replace
   * that keeps the file's mode and any symlink. Callers hold the queue.
   */
  private async rewriteUserMcpServers(
    edit: (
      servers: AgentMcpServerDefinitions,
    ) => { servers: AgentMcpServerDefinitions } | { refusal: string } | null,
  ): Promise<AgentMcpConfigWriteResult> {
    const file = this.userMcpConfigFile();
    const read = await readConfigForRewrite(file);
    if (!read.ok) {
      return read;
    }
    const section = readMcpServersKey(
      read.config,
      CURSOR_MCP_SERVERS_KEY,
      file,
    );
    if (!section.ok) {
      return section;
    }
    const outcome = edit(section.servers);
    if (outcome === null) {
      return { ok: true, changed: false };
    }
    if ('refusal' in outcome) {
      return { ok: false, reason: outcome.refusal };
    }
    const next = { ...read.config, [CURSOR_MCP_SERVERS_KEY]: outcome.servers };
    // `~/.cursor` itself may not exist yet on a machine that has never run
    // the CLI's MCP commands — measured against a fresh home, where the write
    // failed ENOENT on its staging file. Owner-only, like the file.
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`, {
      preserveTarget: { fallbackMode: CURSOR_MCP_CONFIG_FALLBACK_MODE },
      fsync: true,
    });
    return { ok: true, changed: true };
  }

  private async copyPluginEntry(
    input: AgentMcpPluginCopyInput,
  ): Promise<AgentMcpPluginCopyResult> {
    const cursorHome = this.cursorHome();
    const plugin = (await readCursorPlugins(cursorHome, input.cwd)).find(
      (candidate) => candidate.name === input.plugin,
    );
    const server = plugin?.servers.find((s) => s.name === input.server);
    if (plugin === undefined || server === undefined) {
      return {
        ok: false,
        reason: `no installed plugin ${input.plugin} declares a server named ${input.server}`,
      };
    }
    const values = pluginVariableValues(plugin.variables, input.variables);
    if (!values.ok) {
      return values;
    }
    const built = buildPluginServerEntry(server.config, {
      ...values.values,
      ...Object.fromEntries(
        CURSOR_PLUGIN_ROOT_VARIABLES.map((name) => [name, plugin.dir]),
      ),
    });
    if (!built.ok) {
      return built;
    }
    const file = this.userMcpConfigFile();
    const written = await this.rewriteUserMcpServers((servers) => {
      // Own keys only: a server named `constructor` is not already present.
      if (!Object.hasOwn(servers, server.name)) {
        return { servers: { ...servers, [server.name]: built.entry } };
      }
      return isDeepStrictEqual(servers[server.name], built.entry)
        ? null
        : {
            refusal: `${file} already has a server named ${server.name}; remove or rename it first`,
          };
    });
    return written.ok
      ? { ok: true, name: server.name, changed: written.changed }
      : written;
  }

  /**
   * Switch one server for one folder by driving the CLI's own subcommand.
   *
   * `cursor-agent mcp enable|disable <name>`, run IN that folder — the CLI
   * resolves its own per-project state from `process.cwd()` (its git root, else
   * the folder itself), so the cwd is the whole scoping mechanism and geniro
   * never has to name the file. {@link CURSOR_MCP_ENABLE_ARGS} carries the
   * bundle source and the measurements, including why the old "this is global"
   * reading was wrong.
   *
   * NOT `processGroup`, unlike the listing beside it: neither subcommand dials
   * anything — disable is a read-modify-write of one small JSON file, and
   * enable additionally reads the two `mcp.json` files and the approvals list —
   * so there is no grandchild to reap and the plain path's own deadline is the
   * right one.
   *
   * A null stdout is the command having failed, which for the ON direction is a
   * real refusal the panel should show (a server no config defines exits 1). The
   * OFF direction cannot fail that way — measured, `mcp disable` exits 0 on any
   * name at all — so nothing here has to distinguish them.
   */
  override async setMcpServerEnabled(
    cwd: string,
    server: string,
    enabled: boolean,
    options: AgentCommandOptions = {},
  ): Promise<void> {
    const stdout = await this.runCommand(
      [...(enabled ? CURSOR_MCP_ENABLE_ARGS : CURSOR_MCP_DISABLE_ARGS), server],
      { ...options, cwd },
    );
    if (stdout === null) {
      // Thrown, not returned: the contract is a promise that REJECTS on a
      // refusal, and `AgentMcpService` turns the message into the sentence the
      // panel renders instead of moving the switch.
      throw new Error(CURSOR_MCP_TOGGLE_FAILED_MESSAGE);
    }
  }

  /** Raw-handshake cache shared by both model-config listings above. */
  /**
   * The RAW handshake reply behind both model-vocabulary listings, keyed and
   * version-checked by the SHARED cache rather than a private copy of it —
   * `.claude/rules/daemon-module-structure.md`: "Cross-module logic is
   * extracted, never mirrored." The `kind` dimension is a constant here (there
   * is only ever one `cursor-agent` to ask), which costs one argument and buys
   * a single home for the single-flight and freshness rules.
   */
  private readonly handshakeProbeCache = new ModelVocabularyCache<
    string | null | undefined
  >({ ttlMs: CURSOR_HANDSHAKE_PROBE_TTL_MS, now: Date.now });

  /** The durable half of that cache — see {@link probeModelConfigOptionsShared}. */
  private readonly vocabularyStore: ModelVocabularyStore;

  /**
   * The delegates last read off each conversation's store, with the files'
   * size and mtime they were read at — see {@link spawnedConversations}.
   */
  private readonly spawnScans = new Map<
    string,
    { stamp: string; children: string[] }
  >();

  /**
   * Each account's last plan-limits answer and when it was asked, keyed by
   * profile ('' for the default login) — see {@link readPlanLimits}.
   */
  private readonly planLimitReads = new Map<
    string,
    {
      at: number;
      limits: Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null>;
    }
  >();

  /** Each folder's plugin scan and when it began — see {@link scanPlugins}. */
  private readonly pluginScans = new Map<
    string,
    { at: number; plugins: Promise<CursorPlugin[]> }
  >();

  constructor(private readonly cursorOptions: CursorAcpAdapterOptions) {
    super(cursorOptions);
    // Assigned in the BODY rather than as a field initializer: an initializer
    // reading `cursorOptions` depends on when the parameter property is
    // assigned relative to it, which is a compiler detail rather than a
    // guarantee.
    this.vocabularyStore = cursorOptions.vocabularyStore;
  }

  /**
   * This adapter as the daemon builds it.
   *
   * Per-turn config directories live under userData so applying a model or an
   * effort over ACP cannot reach the user's own `~/.cursor/cli-config.json` —
   * that write is real and measured; see `utils/cursor-profile.utils.ts`. The
   * CONVERSATIONS get a directory of their own, because they must outlive the
   * turn profile that opens them (the CLI keeps each thread inside its config
   * directory) and the profile base is swept wholesale at boot.
   */
  static forDaemon(deps: AdapterDaemonDeps): CursorAcpAdapter {
    return new CursorAcpAdapter({
      // The `--version` every cache is keyed by, read through the daemon's 60s
      // memo — without it a cache HIT still forked.
      versions: deps.versions,
      // The handshake replies that survive a restart — the difference between
      // a model's settings appearing in 6s and in the frame the panel opens.
      vocabularyStore: deps.vocabularyStore,
      spawn: deps.spawn,
      processes: deps.processes,
      logger: deps.logger(CursorAcpAdapter.name),
      clientVersion: deps.clientVersion,
      profileDir: join(deps.userDataDir, CURSOR_PROFILE_DIR_NAME),
      sessionStoreDir: join(deps.userDataDir, CURSOR_SESSION_STORE_DIR_NAME),
    });
  }

  protected buildArgs(_input: AgentTurnInput): string[] {
    // Every per-turn parameter that has an ACP home (cwd, MCP servers, the
    // prompt, the resumed session, the mode, the model) travels in the protocol
    // instead of argv — which is also what keeps the call token off `ps`.
    return [...CURSOR_ACP_ARGS];
  }

  /** ACP is a full-duplex dialogue: stdin stays open for the whole turn. */
  protected override keepStdinOpen(_input: AgentTurnInput): boolean {
    return true;
  }

  /**
   * ONE process for the whole conversation, like claude's.
   *
   * It answered false for two milestones, on the honest ground that no
   * multi-turn ACP session had been OBSERVED here — the machine this was built
   * on was not signed in — and that a second prompt on a session the agent
   * considers finished would be answered with the previous turn's context,
   * which is a wrong turn rather than a slow one. Both conditions that note
   * named have since been met, and this is the measurement that met them
   * (cursor-agent, 2026-09-01): turn 1 told the agent to remember `BANANA-7731`
   * and ended `end_turn` at 12676ms; turn 2 on the SAME process answered
   * `BANANA-7731` in 7122ms, with no sign of the feared re-run of turn 1. The
   * second condition — "the turn driver has been checked for state that assumes
   * it dies with its turn" — is what the `AcpSession` / `AcpTurnDriver` split
   * answers: per-turn state now lives on an object built fresh for each turn.
   *
   * What the flip actually FIXES is not latency. `TURN_END_EXIT_GRACE_MS` only
   * arms for a `turn` lifetime, so a one-turn process was terminated ~2s after
   * its terminal event — taking with it every sub-agent the turn had left
   * running in the background. REPORTED against a turn that launched eleven
   * reviewers and said "I'll be notified as they complete"; measured both ways
   * on a delegate given a 20-second shell command, which asked for permission
   * at 28.5s and wrote its file at 49.0s with the process kept, and never wrote
   * it at all under a control run that killed the group 2s after the turn.
   *
   * The cost is the one every kept session pays and claude already pays: a slot
   * in `AgentSessionRegistry`, subject to its ceiling, its LRU eviction and its
   * staleness marking.
   */
  protected override canHostSession(_input: AgentTurnInput): boolean {
    return true;
  }

  /**
   * Whether the CLI asks before a tool runs is spawn-time — it reads its
   * approval mode from the profile `prepareTurn` seeds once per process — so a
   * process spawned for an `auto` turn, under the user's own (possibly
   * "run everything") mode, must not serve an `ask` or `plan` turn. Keyed
   * rather than checked one way, so switching a chat INTO `auto` respawns too.
   */
  protected override sessionKey(input: AgentTurnInput): string {
    return JSON.stringify([
      super.sessionKey(input),
      cursorTurnAsks(input.approvalMode),
    ]);
  }

  /**
   * Every charge of the asked-about cursor conversations over the window, read
   * from the account of the profile they ran under (`query.configDir`) — the
   * only place the figure exists (`utils/cursor-usage.utils.ts` carries the
   * evidence). A named configuration is its own account, and the default
   * account never lists its conversations.
   *
   * Fails closed and silent, exactly as `main/github-prs.ts` does for the same
   * shape of call: a profile with no identity or no login answers
   * {@link ACCOUNT_SIGNED_OUT}, and a denied prompt, a refused request or a
   * reply this build cannot read answer null; the poller reads both as "no cost
   * reported". The token is read per call, used for that call's requests and
   * dropped; nothing here keeps it.
   */
  override async fetchAccountSpend(
    query: AccountSpendQuery,
  ): Promise<AccountSpendReply | typeof ACCOUNT_SIGNED_OUT | null> {
    const configDir = query.configDir?.trim() ?? '';
    const identity = await this.readAccountIdentity(configDir);
    if (identity === null) {
      return ACCOUNT_SIGNED_OUT;
    }
    const token = await this.readSpendLogin(configDir);
    if (token === null || token === ACCOUNT_SIGNED_OUT) {
      return token;
    }
    const events: AccountSpendEvent[] = [];
    let seen = 0;
    for (let page = 1; page <= CURSOR_USAGE_MAX_PAGES; page += 1) {
      const reply = await fetch(`${CURSOR_API_HOST}${CURSOR_USAGE_METHOD}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: cursorUsageRequestBody({
          ...identity,
          startMs: query.startMs,
          endMs: query.endMs,
          page,
        }),
        signal: AbortSignal.timeout(CURSOR_USAGE_REQUEST_TIMEOUT_MS),
      });
      if (!reply.ok) {
        // A 401 is a signed-out account and a 4xx is a shape this build no
        // longer matches; both are "no cost reported" and both stop the walk.
        this.options.logger?.warn(
          `cursor usage request answered ${reply.status}`,
        );
        return null;
      }
      const payload: unknown = await reply.json();
      events.push(...readCursorUsageEvents(payload, query.conversations));
      const total = cursorUsageTotalCount(payload);
      // Counted against the page's OWN length rather than what the reader
      // kept, which drops every other conversation's events.
      const pageLength = cursorUsagePageLength(payload);
      seen += pageLength;
      if (total === null || seen >= total || pageLength === 0) {
        return { events, complete: true };
      }
    }
    this.options.logger?.warn(
      `cursor usage: the window held more than ${CURSOR_USAGE_MAX_PAGES} pages; read ${seen} events of it`,
    );
    return { events, complete: false };
  }

  /**
   * Each conversation's delegates, read off the conversation's own store in
   * geniro's session directory — see {@link CURSOR_SPAWNED_AGENT_ID_MARKER}
   * for the sentence and the measurement.
   *
   * A store is re-read only when its files changed: a poll runs every minute
   * while an agent works, and a long conversation's store is tens of megabytes
   * of which nothing moved since the last read. A conversation not written to in
   * {@link SPAWN_SCAN_MAX_AGE_MS} is not read at all — its delegates' charges
   * are older than the account keeps.
   */
  override async spawnedConversations(
    conversationIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    for (const id of conversationIds) {
      if (!isPlainSessionId(id)) {
        continue;
      }
      try {
        const dir = join(this.sessionStoreDir(), id);
        const files = [
          join(dir, CURSOR_SESSION_STORE_DB_NAME),
          join(dir, CURSOR_SESSION_STORE_WAL_NAME),
        ];
        const stamps: string[] = [];
        let newest = 0;
        for (const file of files) {
          const info = await stat(file).catch(() => null);
          stamps.push(info === null ? '-' : `${info.size}:${info.mtimeMs}`);
          newest = Math.max(newest, info?.mtimeMs ?? 0);
        }
        if (newest === 0 || Date.now() - newest > SPAWN_SCAN_MAX_AGE_MS) {
          continue;
        }
        const stamp = stamps.join('|');
        const known = this.spawnScans.get(id);
        if (known !== undefined && known.stamp === stamp) {
          if (known.children.length > 0) {
            out.set(id, known.children);
          }
          continue;
        }
        const children: string[] = [];
        for (const file of files) {
          const bytes = await readFile(file).catch(() => null);
          if (bytes === null) {
            continue;
          }
          for (const child of readSpawnedConversationIds(bytes, id)) {
            if (!children.includes(child)) {
              children.push(child);
            }
          }
        }
        this.spawnScans.set(id, { stamp, children });
        if (children.length > 0) {
          out.set(id, children);
        }
      } catch (err) {
        this.options.logger?.warn(
          `cursor-agent: could not read the delegates of ${id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return out;
  }

  /**
   * The team and user ids the events are scoped by, from the identity block
   * the CLI keeps for the profile — `~/.cursor` for the default login (`''`),
   * the named configuration's own `.cursor` otherwise. Read rather than
   * invented, and absent identity is a clean decline.
   *
   * `protected`, like {@link readAccessToken}, so a spec can stand in for this
   * MACHINE — a test reaching the real ones would read the author's own
   * Keychain on macOS and decline on CI.
   */
  protected readAccountIdentity(configDir: string): Promise<{
    teamId: number;
    userId: number;
  } | null> {
    const auth = readCursorProfileAuthInfo(
      configDir === '' ? (this.cursorOptions.homeDir ?? homedir()) : configDir,
    );
    const teamId = asNumber(auth?.['teamId']);
    const userId = asNumber(auth?.['userId']);
    return Promise.resolve(
      userId === null ? null : { teamId: teamId ?? 0, userId },
    );
  }

  /**
   * The user's own Cursor login, from the Keychain item that CLI wrote.
   *
   * geniro mints nothing here and keeps nothing: this is the same borrowing the
   * `gh` calls do, one step closer in. A denial, a missing item or a machine
   * that is not macOS all answer null.
   */
  protected async readAccessToken(): Promise<string | null> {
    const login = await this.readKeychainLogin();
    return login === ACCOUNT_SIGNED_OUT ? null : login;
  }

  /**
   * {@link readAccessToken} told apart: {@link ACCOUNT_SIGNED_OUT} only when
   * the Keychain holds no such item (`security` exits
   * {@link CURSOR_KEYCHAIN_ITEM_NOT_FOUND_EXIT}) or the machine is not macOS,
   * and null for a read that failed — a denied prompt, a locked keychain, a
   * timeout — which a later poll may yet read.
   */
  protected readKeychainLogin(): Promise<
    string | typeof ACCOUNT_SIGNED_OUT | null
  > {
    if (process.platform !== 'darwin') {
      return Promise.resolve(ACCOUNT_SIGNED_OUT);
    }
    const run = this.options.execFileFn ?? execFile;
    return new Promise((resolve) => {
      try {
        run(
          'security',
          [
            'find-generic-password',
            '-s',
            CURSOR_KEYCHAIN_SERVICE,
            '-a',
            CURSOR_KEYCHAIN_ACCOUNT,
            '-w',
          ],
          { timeout: CURSOR_KEYCHAIN_TIMEOUT_MS, encoding: 'utf8' },
          (err, stdout) => {
            if (err) {
              resolve(
                err.code === CURSOR_KEYCHAIN_ITEM_NOT_FOUND_EXIT
                  ? ACCOUNT_SIGNED_OUT
                  : null,
              );
              return;
            }
            const token = String(stdout).trim();
            resolve(token === '' ? ACCOUNT_SIGNED_OUT : token);
          },
        );
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * The login the spend poll asks a profile's account with: the Keychain item
   * for the default one ({@link readKeychainLogin}), the named configuration's
   * own file store otherwise, where no token is no login.
   */
  protected async readSpendLogin(
    configDir: string,
  ): Promise<string | typeof ACCOUNT_SIGNED_OUT | null> {
    if (configDir === '') {
      return this.readKeychainLogin();
    }
    return (await this.readProfileAccessToken(configDir)) ?? ACCOUNT_SIGNED_OUT;
  }

  /**
   * What the account behind this run is allowed, asked of Cursor under the
   * run's own profile login with the two requests the CLI's `/usage` makes.
   *
   * An answer is shared for {@link CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS} per
   * account; a failure is not, so the next ask tries again. Fails closed like
   * {@link fetchAccountSpend}: no login, a refused or unreadable reply all
   * answer null, and the token is used for these requests only.
   */
  override readPlanLimits(
    input: AgentSessionReadInput,
  ): Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null> {
    const key = input.configDir?.trim() ?? '';
    const now = Date.now();
    const held = this.planLimitReads.get(key);
    if (
      held !== undefined &&
      now - held.at < CURSOR_PLAN_LIMITS_MIN_INTERVAL_MS
    ) {
      return held.limits;
    }
    const limits = this.fetchPlanLimits(key);
    this.planLimitReads.set(key, { at: now, limits });
    void limits.then((answer) => {
      if (answer === null && this.planLimitReads.get(key)?.limits === limits) {
        this.planLimitReads.delete(key);
      }
    });
    return limits;
  }

  private async fetchPlanLimits(
    configDir: string,
  ): Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null> {
    const token = await this.readProfileAccessToken(configDir);
    if (token === null) {
      return null;
    }
    const ask = async (method: string): Promise<unknown> => {
      const reply = await fetch(`${CURSOR_API_HOST}${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'connect-protocol-version': '1',
        },
        body: '{}',
        signal: AbortSignal.timeout(CURSOR_PLAN_LIMITS_REQUEST_TIMEOUT_MS),
      });
      if (!reply.ok) {
        throw new Error(`${method} answered ${reply.status}`);
      }
      return reply.json();
    };
    const [period, plan] = await Promise.allSettled([
      ask(CURSOR_PERIOD_USAGE_METHOD),
      ask(CURSOR_PLAN_INFO_METHOD),
    ]);
    if (period.status === 'rejected') {
      this.options.logger?.warn(
        `cursor plan limits: ${
          period.reason instanceof Error
            ? period.reason.message
            : String(period.reason)
        }`,
      );
      return null;
    }
    return readCursorPlanLimits(
      period.value,
      plan.status === 'fulfilled' ? plan.value : null,
    );
  }

  /**
   * The login a profile runs under: its own file store for a named
   * configuration, the Keychain item for the default one.
   */
  protected readProfileAccessToken(configDir: string): Promise<string | null> {
    if (configDir === '') {
      return this.readAccessToken();
    }
    const token = readCursorProfileToken(configDir);
    registerSecret(token, 'cursor profile token');
    return Promise.resolve(token);
  }

  /**
   * What this CLI's own accounting says the window holds, read out of the
   * session store it keeps on disk.
   *
   * NOT from the process, and it could not be: a cursor turn is one process
   * ({@link canHostSession}), so by the time anyone opens a readout there is
   * nothing running to ask. That is the whole reason
   * {@link AgentSessionReadInput} carries a session id beside a live session
   * — this adapter uses only the id.
   *
   * The figures are the CLI's OWN, not an estimate: it writes a full
   * per-category breakdown for every turn, which is what its own TUI renders.
   * The parser, the probe evidence and the expiry warning are in
   * `utils/cursor-context-store.utils.ts`.
   *
   * Reading is READ-ONLY and failure-swallowing by construction. This is
   * another program's private store — geniro already owns the directory (the
   * per-turn profile symlinks into it) but not the format — so every way it
   * can go wrong (no session yet, no file, a schema that has moved, a locked
   * database) is one answer: null, and the panel says the breakdown could not
   * be taken.
   */
  override readContextUsage(
    input: AgentSessionReadInput,
  ): Promise<AgentContextUsage | null> {
    return Promise.resolve(
      input.sessionId ? this.readSessionContext(input.sessionId) : null,
    );
  }

  /**
   * One session's breakdown off this CLI's own store — the single place that
   * knows where that file is.
   *
   * TWO readers, which is why it is a method rather than the body of
   * {@link readContextUsage}: the readout asks it on demand, and the turn
   * driver asks it per turn to feed the meter's ring (`readContext` in
   * `createTurnDriver`). Both are the same question about the same file, and a
   * second copy of the path join is a second thing to get wrong.
   */
  private readSessionContext(sessionId: string): AgentContextUsage | null {
    // The same guard its twin below applies, and for the same reason: the id
    // reaches a path as a DIRECTORY component. It is the AGENT's own string —
    // `node_state.agentSessionId` is written from the CLI's `session/new` reply
    // — so a separator in it points this read-only SQLite open outside the
    // store. Both readers of `sessionStoreDir()` now pass through here.
    if (!isPlainSessionId(sessionId)) {
      return null;
    }
    const path = join(
      this.sessionStoreDir(),
      sessionId,
      CURSOR_SESSION_STORE_DB_NAME,
    );
    // A store that does not exist yet is the NORMAL state of a conversation's
    // first turn — the CLI writes it when it first accounts for the window — so
    // it is answered here rather than handed to the reader, which would say so
    // out loud. That warning is worth keeping for a store geniro genuinely
    // failed to read, and worthless once it fires for every new chat: the turn
    // driver now takes a reading per turn, and a channel that warns when
    // nothing is wrong is one people learn to skip.
    return existsSync(path) ? readCursorContextUsage(path, this.warn) : null;
  }

  /**
   * The title this agent gave the conversation, off the same store the
   * breakdown comes from.
   *
   * TRUSTWORTHY BECAUSE THE PROMPT SAYS WHAT IT IS, which it did not always.
   * This CLI names a session from its first prompt, and on ACP that prompt also
   * carries geniro's own host instructions — read as the user speaking, they
   * became what the name described: a chat opened with `Hello!` was called
   * `Geniro Markdown Display`. Wrapping them as host context
   * (`AcpTurnDriver.composePrompt`) fixed that at its source, so this read is
   * worth having again rather than replaced by a spawn. Measured after, on
   * three openings the bare concatenation had ruined: `Bloom Filter Explained`,
   * `Hello Chat`, `Hello There`.
   *
   * Read from geniro's OWN session directory rather than asked over ACP
   * `session/list`: the agent writes the title into `meta.json` as it goes, and
   * the caller already holds the session id, so the protocol route would spawn a
   * `cursor-agent acp` process to re-read a file this app's own turns just
   * wrote.
   *
   * Absent until the agent has named the conversation — a first turn routinely
   * has no title yet, and a very short exchange may never get one — which is an
   * ordinary null the caller answers with the derived title.
   */
  override readSessionTitle(sessionId: string): Promise<string | null> {
    if (!isPlainSessionId(sessionId)) {
      return Promise.resolve(null);
    }
    const path = join(
      this.sessionStoreDir(),
      sessionId,
      CURSOR_SESSION_META_NAME,
    );
    // Same silence as the breakdown's store: absent is the normal state of a
    // new conversation, so it is answered here rather than warned about.
    return Promise.resolve(
      existsSync(path) ? readCursorSessionTitle(path, this.warn) : null,
    );
  }

  /** The adapter's own warn, as a value the readers above can be handed. */
  private readonly warn = (message: string): void =>
    this.options.logger?.warn(message);

  /**
   * No one-shot payload — the driver writes the opening `initialize` frame
   * from `onStdinReady`, and everything after it is a reply to the agent.
   */
  protected override buildStdinPayload(
    _input: AgentTurnInput,
  ): string | undefined {
    return undefined;
  }

  /**
   * Re-inject the USER's own inherited `CURSOR_API_KEY` for this child only.
   *
   * geniro no longer has a key of its own to hand over — the Keychain entry,
   * the `GENIRO_CURSOR_API_KEY` hop and the secret IPC surface were all removed
   * once `cursor-agent` was confirmed to authenticate from its own `~/.cursor`
   * login (probed 2026-08-12 on 2026.08.04-aaa8809: `status` reports the account
   * with no such variable anywhere in the environment). So the ONLY key that can
   * appear here is one the user exported in the shell that launched the app.
   *
   * It still has to be re-injected rather than simply left un-stripped, and that
   * is the whole reason this override survived the removal: `buildChildEnv`
   * strips the name from EVERY child, so leaving it out of the strip set would
   * pass the user's Cursor credential to the claude agent too. Sourcing it here
   * keeps "no spawned agent inherits another agent's credential" true while a
   * user who authenticates by env var keeps working.
   *
   * `input.env` wins, so an explicit per-call override still governs. WHICH
   * names are carried is `auth.inheritedEnvKeys`, read by the base — this
   * override exists only to fold `input.env` over them for a turn.
   *
   * **One honest limit, which no plumbing here fixes.** A PACKAGED app launched
   * from Finder inherits launchd's environment, not the user's shell, so an
   * exported `CURSOR_API_KEY` never reaches this process at all — the daemon is
   * spawned with a spread of `process.env` (`DaemonSupervisor.spawnDaemon`) and
   * only `PATH` is resolved through a login shell. So env-var auth is a
   * `pnpm dev` capability, and `cursor-agent login` is the supported route in a
   * shipped build. Say that rather than implying otherwise.
   */
  protected override buildEnv(input: AgentTurnInput): Record<string, string> {
    const profile = this.turnProfiles.get(input);
    const dataDir = this.turnDataDirs.get(input);
    const account = this.turnAccounts.get(input);
    return {
      ...(account === undefined ? this.inheritedEnv() : account),
      // Runs BEFORE `input.env`, deliberately: a caller that names its own
      // config directory (a member pointed at a profile) must win over the
      // throwaway one, or the feature would be silently disabled by this.
      ...(profile ? { [CURSOR_CONFIG_DIR_ENV]: profile } : {}),
      // A team member's switched-off servers — present only on a turn that
      // switched something off (see `prepareTurn`).
      ...(dataDir ? { [CURSOR_DATA_DIR_ENV]: dataDir } : {}),
      ...input.env,
    };
  }

  protected override commandRecordReader(
    input: AgentTurnInput,
    env: Readonly<Record<string, string | undefined>>,
  ): () => Promise<readonly CommandRecord[]> {
    const spawnedAt = Date.now();
    const dirs = cursorTerminalDirs(input.cwd, env);
    const cache: CursorTerminalCache = new Map();
    return async () => readCursorTerminalRecords(await dirs, spawnedAt, cache);
  }

  /** Per-turn config directory paths, created by `prepareTurn`. */
  private readonly turnProfiles = new WeakMap<AgentTurnInput, string>();
  /** Per-turn data directories, created by `prepareTurn` — see there. */
  private readonly turnDataDirs = new WeakMap<AgentTurnInput, string>();
  /** A named configuration's account env, in place of the inherited one. */
  private readonly turnAccounts = new WeakMap<
    AgentTurnInput,
    Record<string, string>
  >();

  protected override configDirEnv(
    configDir: string | null | undefined,
  ): Record<string, string> {
    const dir = configDir?.trim();
    return dir
      ? cursorProfileAccountEnv(dir, this.cursorOptions.homeDir ?? homedir())
      : {};
  }

  /** MCP servers and their sign-ins stay the real home's, whatever the profile. */
  override runMcpLogin(
    options: Parameters<AgentAdapter['runMcpLogin']>[0],
  ): Promise<string | null> {
    return super.runMcpLogin({ ...options, configDir: null });
  }

  private profileRunEnv(
    configDir: string | null | undefined,
  ): Record<string, string> {
    const dir = configDir?.trim();
    if (!dir) {
      return {};
    }
    const token = readCursorProfileToken(dir);
    registerSecret(token, 'cursor profile token');
    return cursorProfileRunEnv(token);
  }

  private profileSeed(configDir: string | null | undefined): {
    authInfo?: Record<string, unknown> | null;
  } {
    const dir = configDir?.trim();
    return dir ? { authInfo: readCursorProfileAuthInfo(dir) } : {};
  }

  /**
   * Give the turn its own `CURSOR_CONFIG_DIR`, seeded from the user's.
   *
   * This exists because applying a model or an effort over ACP WRITES the config
   * directory — so without it, a chat's model choice changes what the user's own
   * `cursor-agent` opens with. `utils/cursor-profile.utils.ts` carries the
   * measurements, including why only `cli-config.json` is copied.
   *
   * The CONVERSATION is the one thing that must outlive the turn, so the profile
   * links `acp-sessions` at a shared store instead of holding its own: the CLI
   * keeps each thread inside its config directory, and the first version of this
   * therefore deleted every chat as it settled — the next message failed at
   * `session/load`. See the utils doc for both measurements.
   *
   * The base runs the returned disposer on exactly one settle path, so the
   * directory is removed once however the turn ends.
   *
   * It also OPENS the handshake on the turn's own model, and that is a
   * correctness change rather than a saving. A `session/new` reply describes
   * the CURRENT model — its config options, and so which reasoning axis it has
   * and what values that axis takes — so a session opened on the user's default
   * and switched afterwards describes the model being switched AWAY from, and
   * the driver can check nothing about the one the turn will actually run on.
   * Seeded, the reply describes the right model from the first frame, which is
   * what lets `applyModelParameters` refuse a level locally and resolve an axis
   * this model spells differently (`gpt-5.2` calls it `reasoning`).
   *
   * It is also strictly less work: `readAcpCurrentModelId` then matches, so the
   * `session/set_config_option` model frame is skipped — a round trip measured
   * at 2.2–3.0s on every turn that names a model.
   *
   * Safe in BOTH failure directions, probed 2026-08-19 on 2026.08.11-e8db854:
   * a valid model comes back as the reply's `currentValue`, and a name the CLI
   * does not know does NOT fail the handshake — it answers with `auto-smart`
   * as current, so the id does not match, the driver sends the model frame, and
   * the turn behaves exactly as it did before this.
   */
  protected override prepareTurn(
    input: AgentTurnInput,
  ): (() => void) | undefined {
    const dir = seedCursorProfile({
      baseDir: this.profileBaseDir(),
      sessionStoreDir: this.sessionStoreDir(),
      homeDir: this.cursorOptions.homeDir,
      ...(cursorBareModel(input.model) === null
        ? {}
        : { model: cursorBareModel(input.model)! }),
      // Max Mode — the user's own option, snapshotted onto the run and carried
      // here; {@link CURSOR_MAX_MODE_CONFIG_KEY} holds the measurements.
      // Written EXPLICITLY either way, never left to the copied config — an
      // untouched key means "however the user's own terminal was last left",
      // so OFF has to be written as much as ON.
      maxMode: this.agentOption(input, CURSOR_MAX_MODE_OPTION),
      askForApprovals: cursorTurnAsks(input.approvalMode),
      ...(input.readOnly === true ? { readOnly: true } : {}),
      ...this.profileSeed(input.configDir),
    });
    this.turnProfiles.set(input, dir);
    if (input.configDir?.trim()) {
      this.turnAccounts.set(input, this.profileRunEnv(input.configDir));
    }
    // A team member's switched-off MCP servers: this CLI reads which servers
    // to skip from its DATA directory's per-workspace `mcp-disabled.json`, so
    // such a turn gets a throwaway one whose list adds the member's to the user's
    // own and whose every other entry links into the real store (sign-ins,
    // approvals, transcripts). `utils/cursor-data-dir.utils.ts` carries the
    // measurement. Only when something IS switched off, so every other turn
    // runs on the user's real data directory exactly as before — and never over
    // a data directory the caller named itself.
    const disabled = (input.mcpDisabled ?? []).filter(
      (server) => server !== input.mcpEndpoint?.serverName,
    );
    let dataDir: string | null = null;
    if (disabled.length > 0 && input.env?.[CURSOR_DATA_DIR_ENV] === undefined) {
      try {
        dataDir = seedCursorDataDir({
          baseDir: this.profileBaseDir(),
          cwd: input.cwd,
          disabled,
          homeDir: this.cursorOptions.homeDir,
        });
        this.turnDataDirs.set(input, dataDir);
      } catch (err) {
        // The switches are lost for this turn, never the turn: the profile
        // above already exists and the user's own data directory still works.
        this.options.logger?.warn(
          `cursor: could not prepare the turn's MCP switches (${err instanceof Error ? err.message : String(err)}); the member's switched-off servers stay on`,
        );
      }
    }
    return () => {
      this.turnProfiles.delete(input);
      this.turnAccounts.delete(input);
      removeCursorProfile(dir);
      if (dataDir !== null) {
        this.turnDataDirs.delete(input);
        // `rm -r` unlinks the links and never descends into the real store
        // behind them — the acp-sessions link already rests on that.
        removeCursorProfile(dataDir);
      }
    };
  }

  /**
   * The conversations this CLI holds, asked of the CLI over ACP `session/list`.
   *
   * Read under a THROWAWAY profile whose `acp-sessions` is linked at the store
   * being listed — the user's own — for the same reason every other cursor
   * invocation gets one: a handshake writes into its config directory, and a
   * listing must not change what the user's `cursor-agent` opens with.
   *
   * The store it points at is deliberately NOT geniro's own. geniro's store
   * holds the threads this app already created, which are already in the
   * sidebar; what a user means by "resume an old session" is the one their
   * terminal made. An id from there is not resumable until it is brought
   * across, which is exactly what {@link prepareSessionImport} does.
   *
   * Never throws: a missing binary, a signed-out CLI or a `-32601` from an agent
   * that does not implement the method all come back as an empty list. That is
   * safe here in a way it would not be for the MCP panel, because a cursor
   * listing has a second half — `sessions.listingPartialReason` — that already
   * tells the user this list is not everything they have.
   */
  override async listSessions(
    input: AgentSessionsInput,
    options: AgentCommandOptions = {},
  ): Promise<AgentSessionListing> {
    let cwd = '';
    let profile = '';
    try {
      cwd = this.makeProbeRoot('sessions');
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        sessionStoreDir: this.userSessionStoreDir(input.configDir),
        homeDir: this.cursorOptions.homeDir,
        ...this.profileSeed(input.configDir),
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        ...options,
        // The probe root, never `input.cwd`: the FILTER travels in the
        // `session/list` params, and rooting the server at the user's folder
        // would have it trust and scan a directory to answer a question about
        // conversations.
        cwd,
        stdinWrites: acpSessionListFrames({
          cwd: input.cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpSessionListSettled,
        env: {
          [CURSOR_CONFIG_DIR_ENV]: profile,
          ...this.profileRunEnv(input.configDir),
        },
        timeoutMs: options.timeoutMs ?? CURSOR_SESSION_LIST_TIMEOUT_MS,
      });
      return {
        sessions:
          stdout === null
            ? []
            : // Narrowed HERE and not by the caller. Every implementation of
              // this method has to apply the query itself, or a search would
              // silently widen back to the whole list on whichever CLI forgot —
              // and this one can only reach what `session/list` returned, which
              // is why it declares `contentSearchUnavailableReason`.
              matchSessions(readAcpSessionList(stdout), input.query).slice(
                0,
                input.limit,
              ),
        unavailableReason: null,
        partialReason: null,
      };
    } catch {
      return { sessions: [], unavailableReason: null, partialReason: null };
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * Bring one conversation across into the store geniro's turns resume from.
   *
   * A COPY is what this CLI needs and claude does not: geniro's turns run under
   * a throwaway profile whose `acp-sessions` is a symlink to its own store, so a
   * session sitting in the user's profile is simply not there as far as
   * `session/load` is concerned. Probed 2026-08-16 on 2026.08.11-e8db854, both
   * directions — the id answers `-32602 … not found` before the copy, and after
   * it loads and replays its entire transcript.
   *
   * A session already in geniro's store is left ALONE rather than overwritten:
   * the same id can be imported twice, and the second import must not put a
   * stale copy over the turns this app has since added to it.
   *
   * Throws when the source is not there, because the alternative is a thread
   * whose first turn fails on a session the CLI cannot find — a failure the user
   * would meet one message later with nothing connecting it to the import.
   *
   * The copy is STAGED beside the store and renamed into place, mirroring
   * `utils/atomic-file.ts` one level up at directory granularity. A `cp` that
   * dies partway — ENOSPC, EACCES, the daemon SIGKILLed — otherwise leaves a
   * populated directory at the destination, and the `existsSync` guard above
   * then short-circuits onto it for good: every later import of that id returns
   * at once, `session/load` replays a truncated store, and that conversation's
   * history is permanently lost with only a notice to show for it. Staging is
   * what makes the destination appear whole or not at all.
   */
  override async prepareSessionImport(
    input: AgentSessionImportInput,
  ): Promise<void> {
    // BEFORE any join. The id reaches three paths here — the source read from
    // the user's own profile, the destination, and a staging directory the
    // `finally` below removes recursively — so a separator in it walks all
    // three out of the directories they name. Refused here as well as at the
    // service seam because this method is reachable without that service.
    if (!isPlainSessionId(input.sessionId)) {
      throw new Error(SESSION_ID_INVALID_MESSAGE);
    }
    const store = this.sessionStoreDir();
    const from = join(
      this.userSessionStoreDir(input.configDir),
      input.sessionId,
    );
    const to = join(store, input.sessionId);
    if (existsSync(to)) {
      return;
    }
    if (!existsSync(from)) {
      throw new Error(CURSOR_SESSION_MISSING_MESSAGE);
    }
    await mkdir(store, { recursive: true });
    // Beside the destination, because a rename is only atomic within one
    // filesystem — and under a name no concurrent import could pick.
    const staging = join(
      store,
      `.${input.sessionId}.${process.pid}.${process.hrtime.bigint()}.tmp`,
    );
    try {
      // Belt-and-braces on a path that cannot pre-exist: the `pid`+`hrtime`
      // suffix already makes `staging` unique. The flags are kept as the honest
      // spelling of "never merge into an existing directory" — `force: false`
      // alone does not give that, since probed on node v24 it merges per entry
      // with the default `errorOnExist: false`, neither raising nor
      // overwriting. That probe is what the destination guard below rests on.
      await cp(from, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
      });
      // A directory that appeared between the guard above and here makes this
      // fail with ENOTEMPTY rather than replacing a live conversation.
      await rename(staging, to);
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Remove one conversation from the store geniro's turns write — which is
   * GENIRO'S store, not the user's, and that is what makes this safe without
   * the date check the other CLIs need. An imported conversation reached it as
   * a COPY ({@link prepareSessionImport}), so deleting it leaves the original
   * in the user's own `acp-sessions` exactly as their terminal knows it.
   *
   * The id reaches a recursive delete as a directory component, so a separator
   * in it is refused before any join, as in every other reader of this store.
   */
  override async deleteSessionTranscript(
    input: DeleteSessionTranscriptInput,
  ): Promise<DeleteSessionTranscriptResult> {
    if (!isPlainSessionId(input.sessionId)) {
      return { deleted: false, reason: SESSION_ID_INVALID_MESSAGE };
    }
    const dir = join(this.sessionStoreDir(), input.sessionId);
    if (!existsSync(dir)) {
      return { deleted: false, reason: 'the store holds no such conversation' };
    }
    try {
      await rm(dir, { recursive: true, force: true });
      return { deleted: true };
    } catch (error) {
      return {
        deleted: false,
        reason: `the conversation could not be deleted: ${(error as Error).message}`,
      };
    }
  }

  /**
   * The conversation itself, taken from the agent by LOADING it and reading
   * what it replays.
   *
   * This CLI keeps its transcript in a private per-session SQLite store whose
   * blobs are protobuf — geniro reads one block of it for the context meter and
   * has no business reading the rest — but ACP hands the whole conversation
   * back for free: `session/load` streams every message, thought and tool call
   * as `session/update` notifications before it replies. So the record is read
   * through the protocol rather than through the file, which also means a
   * change to that file's encoding costs nothing here.
   *
   * Run under a profile linked at GENIRO's store, deliberately, and therefore
   * only after {@link prepareSessionImport} has brought the session across:
   * loading it under the user's own profile would be the copy's job done twice
   * and would leave the imported thread depending on a store geniro does not
   * own.
   *
   * `cwd` is the session's own, which the caller took from the listing — a load
   * roots the agent somewhere, and rooting a conversation about one project in
   * another is how a resumed thread starts reasoning about the wrong tree.
   */
  override async readSessionHistory(
    input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    let profile = '';
    try {
      profile = seedCursorProfile({
        baseDir: this.profileBaseDir(),
        sessionStoreDir: this.sessionStoreDir(),
        homeDir: this.cursorOptions.homeDir,
        ...this.profileSeed(input.configDir),
      });
      const stdout = await this.runCommand([...CURSOR_ACP_ARGS], {
        cwd: input.cwd,
        stdinWrites: acpSessionLoadFrames({
          sessionId: input.sessionId,
          cwd: input.cwd,
          clientName: CURSOR_ACP_CLIENT_NAME,
          clientVersion: this.clientVersion,
          clientMeta: CURSOR_ACP_CLIENT_META,
        }),
        settleWhen: acpSessionLoadSettled,
        env: {
          [CURSOR_CONFIG_DIR_ENV]: profile,
          ...this.profileRunEnv(input.configDir),
        },
        timeoutMs: CURSOR_SESSION_LOAD_TIMEOUT_MS,
      });
      if (stdout === null) {
        // The load failed or timed out. Null is "no readable record", which the
        // caller turns into a thread that resumes correctly and simply opens
        // empty — never into a failed import, because the SESSION is fine and
        // only its transcript could not be fetched.
        return null;
      }
      const events = readAcpSessionReplay(stdout);
      const droppedBefore = Math.max(0, events.length - input.limit);
      return { events: events.slice(droppedBefore), droppedBefore };
    } catch {
      return null;
    } finally {
      if (profile !== '') {
        removeCursorProfile(profile);
      }
    }
  }

  /**
   * Where the USER's own ACP conversations live — `<home>/.cursor/acp-sessions`,
   * where a named configuration's directory is the home its CLI runs under.
   *
   * Distinct from {@link sessionStoreDir}, which is geniro's, and the two must
   * never be confused: one is read to offer an import, the other is written by
   * every turn.
   */
  private userSessionStoreDir(configDir: string | null): string {
    return join(
      configDir ?? this.cursorOptions.homeDir ?? homedir(),
      CURSOR_HOME_DIR_NAME,
      CURSOR_ACP_SESSIONS_DIR_NAME,
    );
  }

  private profileBaseDir(): string {
    return (
      this.cursorOptions.profileDir ?? join(tmpdir(), CURSOR_PROFILE_DIR_NAME)
    );
  }

  private sessionStoreDir(): string {
    return (
      this.cursorOptions.sessionStoreDir ??
      join(tmpdir(), CURSOR_SESSION_STORE_DIR_NAME)
    );
  }

  /**
   * Drop the per-turn profiles a prior daemon launch left behind — only a
   * SIGKILLed daemon can leave any, since the disposer covers every ordinary
   * settle path, and each leftover is ~700KB of the CLI's own cache.
   */
  override sweepStaleState(): void {
    sweepStaleCursorProfiles(this.profileBaseDir());
  }

  override toolCallMetric(name: string, kind: string | null): ToolCallMetric {
    return cursorToolCallMetric(name, kind);
  }

  /**
   * The legacy adapter's stream-json mapper has no ACP counterpart: the whole
   * protocol is stateful, so it lives in a per-turn {@link AcpTurnDriver}.
   * Reaching this method means the base class's default (stateless) path ran,
   * which `createTurnDriver` below replaces.
   */
  protected mapMessage(): never {
    throw new Error(
      'CursorAcpAdapter drives ACP through its per-turn driver, not mapMessage',
    );
  }

  /** The CLI's own home directory — `~/.cursor`, under the home seam. */
  private cursorHome(): string {
    return join(this.cursorOptions.homeDir ?? homedir(), CURSOR_HOME_DIR_NAME);
  }

  override async recoverSubagent(
    ref: SubagentRecoveryRef,
  ): Promise<RecoveredSubagentOutcome | null> {
    if (
      !isPlainSessionId(ref.sessionId) ||
      !isPlainSessionId(ref.toolCallId) ||
      (ref.childSessionId !== null && !isPlainSessionId(ref.childSessionId))
    ) {
      return null;
    }
    // A brief alone can identify several simultaneous or resumed delegates.
    if (ref.childSessionId === null) {
      return null;
    }
    const ending = await readCursorDelegateEnding(
      {
        conversationId: ref.childSessionId,
        cwd: ref.cwd,
        sessionId: ref.sessionId,
        notBeforeMs: ref.launchedAtMs,
      },
      this.cursorHome(),
    );
    return ending?.state === 'ended' && ending.outcome !== 'untracked'
      ? ending.outcome
      : null;
  }

  protected override createTurnDriver(input: AgentTurnInput): TurnDriver {
    return new AcpSession(
      {
        clientName: CURSOR_ACP_CLIENT_NAME,
        clientVersion: this.clientVersion,
        // What unlocks the separate effort control; see CURSOR_ACP_CLIENT_META.
        clientMeta: CURSOR_ACP_CLIENT_META,
        // This CLI binds a turn's model and every parameter when the PROMPT
        // arrives; a frame still in flight then is accepted, confirmed in its
        // reply, and lost for that turn (it sticks from the next one).
        //
        // - The context window, measured on 2026.08.11-e8db854: pipelined, the
        //   turn ran at the default 300,000; awaited, at the 1,000,000 asked
        //   for. The reply confirmed `context = 1m` either way.
        // - Billing on 2026.10.01-e373342 (`GetFilteredUsageEvents`, by
        //   conversation): pipelined `reasoning=high` on `gpt-5.6-sol` billed
        //   `-medium` (3/3), `fast=false` on `grok-4.7` billed `-high-fast`, and
        //   a model switch to `gpt-5.5` with nothing else set billed
        //   `gpt-5.6-sol-medium` (2/2). Awaited, each billed what was asked.
        //   Re-sending an unchanged value pipelined was harmless.
        //
        // It costs one `set_config_option` round trip per turn that sends a
        // frame, ~1.7–2.0s on that build.
        promptAwaitsConfig: true,
        // Verified against billing on 2026.10.19-6bbf2c4: a load reporting
        // reasoning=high ran at gpt-5.6-sol-high without any config frame.
        // Skipping that frame saved 2.23s. A fresh turn profile seeded with
        // default parameters instead loaded medium and billed medium — trust
        // THIS reply, never the value requested by the preceding turn.
        skipUnchangedParameters: true,
        turnOptions: (turnInput) => this.acpTurnOptions(turnInput),
        declinedWithoutNotice: CURSOR_SILENTLY_DECLINED_METHODS,
        // cursor's "Allow always" lands in the config directory geniro seeds
        // per conversation process — see CURSOR_ALWAYS_ANSWER_SCOPE.
        alwaysAnswerScope: CURSOR_ALWAYS_ANSWER_SCOPE,
        question: {
          method: CURSOR_ASK_QUESTION_METHOD,
          toolName: this.getConfig().questionToolName ?? '',
          accepts: (params) => readCursorQuestions(params).length > 0,
          card: cursorCardQuestions,
          encodeReply: encodeCursorQuestionReply,
        },
        delegate: {
          method: CURSOR_TASK_METHOD,
          launchMarker: CURSOR_TASK_LAUNCH_MARKER,
          read: readCursorTask,
          // The `task` call returns `{durationMs, isBackground}` and nothing the
          // delegate said — see the field's own doc block for what that looked
          // like framed as its answer.
          resultIsBookkeeping: true,
          // The other half of that same `rawOutput`, and the half that says
          // whether the call waited for anything at all.
          readsBackgroundLaunch: readCursorLaunchIsBackground,
          // And how such a delegate is seen to END: nothing on the wire says so,
          // but its own transcript does — see the `Background sub-agents` block
          // in `cursor-acp.const.ts`.
          endings: {
            locate: (query) =>
              locateCursorDelegateTranscript(query, this.cursorHome()),
            read: (ref) => readCursorDelegateEnding(ref, this.cursorHome()),
          },
          // And the parent is TOLD, which its ACP server never does — see the
          // same block.
          wakePrompt: cursorDelegateWakePrompt,
          // The brief of a delegate whose call a failed request cut off, which
          // was never announced — see the field's own doc block.
          readLaunchInput: readCursorTaskInput,
          // Which `task` call a sub-agent SESSION belongs to — see
          // `CURSOR_ACP_CLIENT_META`, which is what turns those sessions on.
          subagentToolCallId: readCursorSubagentToolCallId,
          stepsUnavailableReason:
            this.getConfig().subagents.stepsUnavailableReason,
        },
        todos: {
          method: CURSOR_TODOS_METHOD,
          read: parseCursorTodos,
          // The plan's ids, which its `plan` update lacks and every later
          // `cursor/update_todos` patch keys on — see the task-list block in
          // `cursor-acp.const.ts`.
          plan: { method: CURSOR_CREATE_PLAN_METHOD, read: parseCursorPlan },
        },
        // This CLI catches its own failure, writes the sentence out as an
        // assistant message and answers `end_turn` regardless — so without this
        // a turn that died on `RetriableError: [unavailable] PING timed out`
        // rendered that line as the agent's own prose under a `✓ done · 1m 14s`
        // footer. REPORTED with exactly that screenshot. The reader's doc block
        // carries the catch block it was read out of and why matching it is
        // sound.
        agentFailure: {
          read: readCursorAgentFailure,
          // A dropped connection is resumed, as this CLI's own interactive
          // client does and its ACP server does not — see the pattern's doc.
          resume: {
            isTransient: (message) =>
              CURSOR_TRANSIENT_FAILURE_PATTERN.test(message),
            prompt: cursorTransientResumePrompt,
            delaysMs: CURSOR_TRANSIENT_RESUME_DELAYS_MS,
            maxPerTurn: CURSOR_TRANSIENT_RESUME_MAX_PER_TURN,
          },
        },
        // The SAME store the readout reads, put on the turn's event stream — and,
        // through it, onto the turn's own `turn_complete` — so the meter's ring is
        // drawn from it too. ACP carries no context accounting at all, so before
        // this the ring had no reading and rendered hollow while the panel behind
        // it showed a full breakdown off this very file — the reported "the number
        // says 51% and the circle is not filled at all". Two readings of one
        // source cannot disagree; a reading and a blank can.
        //
        // Reported AGAIN after the first pass, and the second half is why: a
        // reading rides the ephemeral live plane, which the client drops when the
        // run settles, so the ring was fed for the length of a turn and blank
        // between turns — which is when anybody is looking at it. The durable
        // half is `AcpTurnDriver.buildUsage`, which now reads the same reading.
        // Measured end to end on a real turn: `{contextTokens: 42970,
        // contextWindowTokens: 200000}` in the row, against `inputTokens: null`
        // beside it — the row could only have got those from here.
        readContext: (sessionId) => {
          const usage = this.readSessionContext(sessionId);
          return usage === null
            ? null
            : {
                usedTokens: usage.totalTokens,
                windowTokens: usage.maxTokens,
                model: usage.model,
              };
        },
        logger: this.cursorOptions.logger,
      },
      input,
    );
  }

  /**
   * Everything about ONE turn, derived from THAT turn's input.
   *
   * Called once per turn by `AcpSession`, never captured — which is the whole
   * contract: every value here reads the `input` ARGUMENT, so a second message
   * on a kept process cannot inherit the first's approval posture, model
   * settings or instruction block. Closing over the enclosing
   * `createTurnDriver` parameter instead would compile and be wrong in exactly
   * the way the session/turn split exists to prevent.
   */
  private acpTurnOptions(input: AgentTurnInput): AcpTurnOptions {
    return {
      input,
      composeSystemPrompt: (granted) =>
        this.composeSystemPrompt(input, granted),
      // The stored id split into a bare model plus its parameters, with this
      // turn's own effort applied over whatever the id carried. Composed here
      // because the bracket syntax is this CLI's, and the driver must not learn
      // to read one.
      modelSelection: cursorModelSelection(
        input.model,
        input.effort,
        input.contextWindow,
        input.modelParameters,
      ),
      autoDecide: () => cursorAutoDecision(input.approvalMode),
      preferredModeId:
        input.approvalMode === 'plan' ? CURSOR_PLAN_MODE_ID : null,
    };
  }

  /**
   * This adapter's own memory of the handshake — the one cache no service can
   * reach, since three listings share it through
   * {@link probeModelConfigOptionsShared}.
   *
   * The DURABLE half is `ModelVocabularyStore`'s and is cleared by the same
   * service, not from here: this adapter holds one of two references to that
   * store, and clearing it here would leave the models listing's copy standing.
   */
  override clearCaches(): number {
    const scans = this.pluginScans.size;
    this.pluginScans.clear();
    return this.handshakeProbeCache.clear() + scans;
  }

  /**
   * The same memory, on an ACCOUNT change: a handshake still running was
   * spawned under the credentials the user just replaced, so it is detached
   * and its reply is not filed (`ModelVocabularyCache.forget`). Its durable
   * write is refused by the store's own epoch, read at the probe's start.
   */
  override forgetAccountCaches(): number {
    return this.handshakeProbeCache.forget(this.getConfig().kind);
  }

  /**
   * The card projection for a parked `cursor/ask_question`, led by the
   * request's own `title` when it has one — the ask's name, which a
   * multi-question request carries nowhere else. Reached only for a payload
   * `accepts()` already read, so the null arm is the base class's contract
   * rather than a case that happens.
   */
  override questionFrom(input: unknown): AdapterQuestion | null {
    return adapterQuestionOf(
      cursorCardQuestions(input),
      asString(asRecord(input)?.title),
    );
  }

  /**
   * Carry the card's free text to the reply encoder. It cannot be folded into
   * a tool input the way claude's is — the request is a JSON-RPC call, not a
   * tool call — so it rides a key both ends of this adapter own.
   */
  override withAnswer(input: unknown, answer: string): unknown {
    return withCursorAnswer(input, answer);
  }
}

/**
 * What a stored handshake reply has to look like to be served back.
 *
 * `ModelVocabularyStore` holds JSON and cannot know what any of it means, so
 * the shape check belongs to whoever filed the value. Deliberately weak — this
 * is the CLI's raw stdout, so the only thing knowable about it here is that it
 * is text somebody wrote; whether it PARSES is the readers' question, and they
 * each already answer it with their own three-way split.
 */
function isProbeReply(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}
