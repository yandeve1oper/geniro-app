import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { registerSecret } from '../../diagnostics/utils/redact';
import type { AgentVersionService } from '../services/agent-version.service';
import type { ProcessRegistry } from '../services/process-registry';
import { resolveAgentBinary } from '../utils/agent-binary';
import {
  joinTurnInstructionParts,
  type TurnInstructionPart,
  turnInstructionParts,
} from '../utils/agent-instructions';
import { spawnAgentVersion } from '../utils/agent-version';
import { buildChildEnv, registerIsolatedEnvKeys } from '../utils/child-env';
import { childProcessHandle } from '../utils/child-handle';
import { trackDetachedChild } from '../utils/child-journal';
import { createGroupTerminator } from '../utils/kill-tree';
import type {
  ModelPrice,
  ModelPriceLookup,
  ModelPriceRates,
} from '../utils/model-prices';
import {
  ollamaBaseUrl,
  ollamaModelName,
  qualifyOllamaEvent,
  validateOllamaModel,
} from '../utils/ollama';
import { delegateDeclarationEvent } from '../utils/open-delegates';
import { listProcesses, type ProcessRow } from '../utils/process-descendants';
import { repositoryRootOf } from '../utils/repository-root';
import type { PlainProcess } from '../utils/run-process-scan';
import {
  type BetweenTurnApproval,
  type CliSession,
  type CliSessionOptions,
  runCliSession,
  type SessionLogger,
  type SpawnFn,
} from '../utils/spawn-cli';
import type {
  ACCOUNT_SIGNED_OUT,
  AccountSpendQuery,
  AccountSpendReply,
  AdapterConfig,
  AdapterQuestion,
  AgentApprovalMode,
  AgentApprovalProbeState,
  AgentAskInput,
  AgentCommandOptions,
  AgentContextUsage,
  AgentContextWindowListing,
  AgentEffort,
  AgentEffortListing,
  AgentErrorRecovery,
  AgentEvent,
  AgentGeniroCommand,
  AgentMcpConfigDocument,
  AgentMcpConfigWriteInput,
  AgentMcpConfigWriteResult,
  AgentMcpFolderFacts,
  AgentMcpListingResult,
  AgentMcpPluginCopyInput,
  AgentMcpPluginCopyResult,
  AgentMcpServerAddInput,
  AgentMcpServerHealth,
  AgentMcpServerHealthInput,
  AgentMcpServersInput,
  AgentModel,
  AgentModelParameterListing,
  AgentModelsInput,
  AgentPlanLimits,
  AgentReportedCommand,
  AgentSession,
  AgentSessionHistory,
  AgentSessionImportInput,
  AgentSessionListing,
  AgentSessionReadInput,
  AgentSessionsInput,
  AgentSkillEntry,
  AgentSkillsInput,
  AgentSpawnInfo,
  AgentTitleInput,
  AgentTurnFailure,
  AgentTurnHandle,
  AgentTurnInput,
  ApprovalOption,
  ApprovalResolution,
  CarrySessionInput,
  CarrySessionResult,
  CommandRecord,
  ConfigDirPin,
  DeleteSessionTranscriptInput,
  DeleteSessionTranscriptResult,
  FollowUpMessage,
  HandoffInput,
  HandoffResult,
  InstalledApprovalSupport,
  NativeMemoryReading,
  NO_PLAN_LIMITS,
  RecoveredSubagentOutcome,
  SessionPullRequest,
  SessionPullRequestsInput,
  SubagentRecoveryRef,
  ToolCallMetric,
  TurnDriver,
  TurnInstructionInput,
} from './adapter.types';
import {
  discoverPluginDirs,
  scanCommandFiles,
  scanSkillDirs,
} from './utils/skill-scan.utils';

/** Utility commands (`models`, `--version`) answer fast or not at all. */
const UTILITY_COMMAND_TIMEOUT_MS = 10_000;

/**
 * Stdout retained from a group-spawned utility command, in JS string length
 * — UTF-16 code units, NOT bytes. `execFile` gets a byte cap from node; the
 * `spawn` path collects by hand, and comparing decoded length is both cheaper
 * and the number that actually bounds the string we are holding. The point is
 * a ceiling at all: an unbounded string built from a chatty child is a
 * daemon-wide memory fault, not a failed read.
 */
const UTILITY_COMMAND_MAX_BUFFER_CHARS = 1024 * 1024;

/**
 * How {@link AgentCommandOptions.pty} gets a terminal — the macOS/BSD
 * `script(1)`, which allocates a pty, runs the command under it and forwards
 * both directions.
 *
 * Not a native pty module by choice: the DAEMON has none (the Electron shell's
 * node-pty, behind its terminal panel, is another process), and adding a native
 * dependency here to allocate one terminal for one sign-in is a bad trade.
 * This ships with the OS. `-q` suppresses the wrapper's own start/stop banner,
 * and `/dev/null` is the transcript file it insists on being given (the BSD
 * form takes the file positionally, before the command).
 *
 * Agent-agnostic and stays here: it is a property of the PLATFORM, not of any
 * CLI, so no adapter declares it.
 *
 * Absolute path, not a bare name: a bare `'script'` resolves through the
 * inherited login-shell PATH, which an earlier PATH entry can shadow during a
 * sign-in. Same house rule as `apps/ui/src/main/update-installer.ts`'s
 * `DITTO`/`XATTR` constants.
 */
const PTY_WRAPPER = '/usr/bin/script';
const PTY_WRAPPER_ARGS = ['-q', '/dev/null'] as const;

/**
 * How many times, and how far apart, to look for the CLI `script` started
 * under its pty — see {@link AgentAdapter.ptyChildrenOf}. `script` forks at
 * once, so the first reading nearly always has it; the rest cover a loaded
 * machine, bounded at two seconds because by then the child's pid is only
 * findable through its parent while `script` is still alive.
 */
const PTY_CHILD_LOOKUP_ATTEMPTS = 20;
const PTY_CHILD_LOOKUP_INTERVAL_MS = 100;

/**
 * Constructor options every adapter accepts — test seams, not user config. The
 * option bag is not a DI token, so `agents.module.ts` provides each adapter via
 * a factory.
 */
export interface AgentAdapterOptions {
  /** Replacement spawn for tests; defaults to the group-leader `defaultSpawn`. */
  spawn?: SpawnFn;
  /**
   * Sink for the base class's diagnostics — skipped unparseable lines,
   * unmodelled control subtypes, a failed turn-resource disposer. Defaults to
   * silent, so production wiring MUST pass a real one (`agents.module.ts`).
   *
   * Every base-class diagnostic is a WARNING, so a plain `{ warn }` double
   * still satisfies this. `SessionLogger`'s optional `debug` is what the turn
   * transport writes its per-tool-call account to (the approval round-trip,
   * the turn boundaries) — a Nest `Logger` carries it, a test double need not.
   */
  logger?: SessionLogger;
  /** Replacement execFile for the utility commands in tests; defaults to node's. */
  execFileFn?: typeof execFile;
  /**
   * Replacement spawn for the utility commands that run as their own process
   * group ({@link AgentCommandOptions.processGroup}); defaults to the
   * group-leader `defaultSpawn`.
   *
   * A THIRD seam rather than a reuse of either neighbour, because all three
   * describe different children: `spawn` is the turn, `execFileFn` is a
   * plain utility command, and this is a group-led one. Folding it into
   * `spawn` would make a spec that fakes a turn silently intercept a listing
   * as well, and the two adapter specs that fake both would then cross-wire.
   */
  groupSpawnFn?: typeof spawn;
  /**
   * Root for the throwaway workspace {@link AgentAdapter.listReportedCommands}
   * runs its probe turn in (the daemon passes its own userData tmp dir, never
   * a user folder); falls back to the OS tmpdir for standalone/spec use.
   */
  probeRootDir?: string;
  /**
   * The daemon's memoized `--version` reader, which every per-version cache of
   * a CLI's answers is keyed by. Absent in standalone and spec use, where
   * {@link AgentAdapter.resolveBinaryVersion} forks the binary itself.
   */
  versions?: AgentVersionService;
  /**
   * What geniro tells a CLI it is when that CLI's handshake asks who is
   * calling (`clientInfo.version`) — the daemon's own version.
   */
  clientVersion?: string;
  /**
   * Where a child {@link AgentAdapter.runCommand} starts is registered for
   * shutdown when its caller handed no `onSpawn` of its own: every child the
   * daemon starts must be reapable, the ones an adapter starts on its own
   * account — a title, a transcript read — included. A CLI whose approval
   * modes are probed registers its probe turns here as well, and needs
   * `versions` beside it to probe at all. Absent in standalone and spec use,
   * where nothing is registered.
   */
  processes?: ProcessRegistry;
  /**
   * Replacement process-table reading for tests; defaults to `ps` through
   * `utils/process-descendants`. Read only under a pty, to find the CLI
   * `script` put in a session of its own.
   */
  listProcessesFn?: () => Promise<ProcessRow[]>;
  /**
   * Replacement for the plain process-table reading a session records its
   * running commands' groups from; defaults to `ps`. A test seam.
   */
  listProcessGroupsFn?: () => Promise<PlainProcess[] | null>;
  /**
   * The public model price catalog {@link AgentAdapter.listPriceOf} reads.
   * Absent in standalone and spec use, where every model is unpriced — which
   * reads as "cost not measured", never as $0.
   */
  prices?: ModelPriceLookup;
}

/**
 * Base class for a headless CLI coding-agent adapter. Owns the one shared turn
 * flow — spawn via {@link runHeadlessCli} (which strips `GENIRO_`-prefixed env,
 * reassembles stdout NDJSON, and normalizes terminal outcomes) — while each
 * subclass contributes only what differs per CLI: the command, its argv, the
 * NDJSON→{@link AgentEvent} mapper, and (when the CLI needs it) a stdin payload
 * or extra child env. One instance per agent kind; `start` is called per turn.
 */
export abstract class AgentAdapter {
  /**
   * Everything STATIC about the CLI this adapter drives — the single source of
   * every per-CLI VALUE, which is why the members below are concrete here
   * rather than restated per adapter.
   *
   * A method returning an inline literal, not a field pointing at a const: the
   * adapter class is then the one place that shows what its CLI is, and the
   * annotated return type makes a missing or misspelled field a type error at
   * the adapter instead of at some distant read site. A value belongs wherever
   * its readers are — a named export in `<name>.const.ts` once something
   * BESIDES this literal reads it, so the two cannot drift apart; written
   * inline beside the field it answers when this literal is its only reader.
   */
  abstract getConfig(): AdapterConfig;

  /**
   * The user's own standing-instructions file for a run under `configDir`
   * (null = the CLI's default profile), or why this CLI has none.
   */
  userInstructionsFile(
    configDir: string | null,
  ): { path: string } | { unavailableReason: string } {
    const where = this.getConfig().userInstructions;
    if (where.kind === 'unavailable') {
      return { unavailableReason: where.reason };
    }
    return {
      path: join(configDir ?? join(homedir(), where.homeDir), where.fileName),
    };
  }

  /**
   * The notes this CLI keeps in its own memory under `configDir` (null = its
   * default profile), read only, for the user's import into the shared
   * memory; null for a CLI that keeps none. Never writes, never throws.
   */
  readNativeMemory(
    _configDir: string | null,
  ): Promise<NativeMemoryReading | null> {
    return Promise.resolve(null);
  }

  /**
   * The {@link NativeMemoryNote.projectKey} this CLI files a folder's notes
   * under, or null when it files none by project.
   */
  nativeMemoryProjectKey(_folder: string): string | null {
    return null;
  }

  /**
   * The CLI binary invoked for each turn. Resolved per access so the Settings
   * cliPaths override (`GENIRO_<AGENT>_BIN` on the daemon env) takes effect
   * without reconstructing the adapter.
   */
  protected get command(): string {
    return resolveAgentBinary(this.getConfig().kind);
  }

  /**
   * This installed binary's `--version`, the key a CLI's cached answers are
   * checked against.
   *
   * Read through `AgentVersionService`'s short memo when the daemon handed one
   * over, rather than forked each time: the fork costs half a second and
   * several listings key off it, so a cache HIT would otherwise pay for a
   * process before it could read a cached byte. `onSpawn` is not called on a
   * memo hit — no child, nothing to register.
   */
  protected resolveBinaryVersion(
    options: AgentCommandOptions,
  ): Promise<string | null> {
    const forkOptions = {
      execFileFn: this.options.execFileFn,
      onSpawn: options.onSpawn,
    };
    return (
      this.options.versions?.resolve(this.getConfig().kind, forkOptions) ??
      spawnAgentVersion(this.command, forkOptions)
    );
  }

  /** What this client tells a CLI it is, in a handshake's `clientInfo.version`. */
  protected get clientVersion(): string {
    return this.options.clientVersion ?? '0.0.0';
  }

  /**
   * One of this CLI's models at LIST price, from the public catalog under the
   * provider its config names (`usage.listPrice`) — or null when the CLI
   * declares none, no catalog was handed over, or the catalog does not list
   * the id.
   *
   * The id is matched exactly: a CLI that reports its models under spellings
   * of its own canonicalises them before asking (see `ModelPriceLookup`).
   */
  /**
   * Whose model `model` is under this CLI (`AdapterConfig.modelVendor`), or
   * null when that is not known — a local `ollama/` model, an `auto` pick, a
   * CLI that declares none.
   */
  modelVendorOf(model: string | null): string | null {
    const vendor = this.getConfig().modelVendor;
    if (vendor === undefined || model?.startsWith('ollama/')) {
      return null;
    }
    if (vendor.kind === 'fixed') {
      return vendor.vendor;
    }
    const id = model?.toLowerCase() ?? '';
    return (
      vendor.prefixes.find((entry) => id.startsWith(entry.prefix))?.vendor ??
      null
    );
  }

  protected listPriceOf(model: string | null): ModelPrice | null {
    const listPrice = this.getConfig().usage.listPrice;
    if (model === null || model === '' || listPrice.kind !== 'catalog') {
      return null;
    }
    return this.options.prices?.priceOf(listPrice.provider, model) ?? null;
  }

  /**
   * The rates a turn of `model` is billed at on this CLI, for telling a bill
   * apart by token class; null when the catalog has no list price for it.
   */
  billingRatesOf(model: string | null): ModelPriceRates | null {
    const price = this.listPriceOf(model);
    const listPrice = this.getConfig().usage.listPrice;
    if (price === null || listPrice.kind !== 'catalog') {
      return null;
    }
    return listPrice.cacheWriteInputMultiple === undefined
      ? price
      : {
          ...price,
          cacheWrite: price.input * listPrice.cacheWriteInputMultiple,
        };
  }

  /**
   * The model id a turn spawned with `model` will run as, under that profile —
   * what an alias (`haiku`) or the CLI's default (null) resolves to, asked
   * BEFORE the turn exists. Null when it cannot be known.
   *
   * The default answers with the name itself: a CLI whose model names are its
   * ids. A CLI with aliases of its own resolves them here.
   */
  resolveModel(
    model: string | null,
    _configDir: string | null,
  ): Promise<string | null> {
    return Promise.resolve(model === '' ? null : model);
  }

  /**
   * The catalog's context window for one of this CLI's model ids, or null —
   * only where the config declares the catalog's figure is the one this CLI
   * enforces (`usage.listPrice.catalogWindows`).
   */
  catalogWindow(model: string): number | null {
    const listPrice = this.getConfig().usage.listPrice;
    if (listPrice.kind !== 'catalog' || !listPrice.catalogWindows) {
      return null;
    }
    return this.listPriceOf(model)?.contextTokens ?? null;
  }

  /** Current metadata for a cached vocabulary row; adapters with aliases refresh it here. */
  modelDetails(
    model: AgentModel,
    _configDir: string | null,
  ): Promise<AgentModel> {
    return Promise.resolve(model);
  }

  /**
   * What a probe has established about THIS installed binary's approval
   * modes, as it stands right now — never waiting for one to run.
   *
   * The probe belongs to the adapter whose binary it tests, so each adapter
   * answers for its own CLI and no consumer ever holds a verdict keyed by a
   * CLI's name. That is not tidiness: when the verdict travelled as a bag with
   * a CLI-named field, a second CLI declaring any probed mode would have been
   * judged against the first one's binary and silently degraded.
   *
   * The default answers `{ supported: {} }` — absent, never `false` — which is
   * the whole truth for a CLI with nothing to probe (`config.approval.
   * probedModes: []`): a mode nobody asked about is still attempted and any
   * genuine rejection surfaces from the CLI itself. An adapter that probes
   * overrides this and the two methods below it together.
   */
  currentApprovalSupport(): InstalledApprovalSupport {
    return { supported: {} };
  }

  /**
   * {@link currentApprovalSupport}, but WAITING for this CLI's probe to settle
   * when one is still needed — what a turn asking for a probed mode awaits so
   * a degrade is decided on a real verdict rather than on "not probed yet".
   *
   * Never rejects: a probe that cannot run is an unknown verdict, and an
   * unknown verdict keeps the mode the caller asked for. A failed probe must
   * never fail the turn it was meant to inform.
   */
  settledApprovalSupport(): Promise<InstalledApprovalSupport> {
    return Promise.resolve(this.currentApprovalSupport());
  }

  /**
   * This CLI's probe verdict in the shape `GET /v1/capabilities` publishes,
   * or null when it probes nothing. Reading it may START a probe in the
   * background (never awaited here), so a verdict is usually settled by the
   * time a turn needs one.
   */
  approvalProbe(): AgentApprovalProbeState | null {
    return null;
  }

  /**
   * Remove what a prior daemon launch left behind — per-turn files and
   * directories a SIGKILL never let a disposer reach. Called once at boot for
   * every registered adapter, before any turn runs.
   *
   * The default has nothing to sweep, which is the truth for a CLI whose turns
   * materialize nothing on disk. Must not throw: a leftover is hygiene, and a
   * boot is not worth failing over it.
   */
  sweepStaleState(): void {}

  /**
   * The mode a turn actually runs under, given what a probe proved about the
   * installed binary — plus the line the transcript owes the user when that is
   * not the mode they asked for.
   *
   * The ONE answer behind every approval seam (the chat turn and each team
   * member alike), because the two encoding it separately is exactly how a
   * degrade gets fixed on one path and silently missed on the other. Policy
   * lives here, not in the caller: which modes degrade, which ride through to
   * be rejected loudly by the CLI, and what the user is told.
   *
   * The policy itself is per-CLI DATA (`config.approval`), so this is concrete
   * and the order is fixed for everyone:
   *
   * 1. A CLI with exactly ONE honoured mode collapses onto it — that comes
   *    FIRST because a single-mode CLI has nothing to probe, so a probe-table
   *    entry could otherwise route a turn to a mode the CLI does not honour at
   *    all.
   * 2. Otherwise a mode a probe PROVED the installed binary rejects degrades
   *    per `config.approval.degradeOnProbeFail` — only on `false`, never on an
   *    absent verdict.
   * 3. Otherwise the requested mode rides through, so a real rejection comes
   *    from the CLI instead of from a guess made here. A probed mode left OUT
   *    of the table takes this path deliberately (see claude's `plan`).
   */
  resolveApprovalMode(
    requested: AgentApprovalMode,
    installed: InstalledApprovalSupport,
  ): ApprovalResolution {
    const { modes, degradeOnProbeFail, soleModeDegradeReason } =
      this.getConfig().approval;
    const [soleMode] = modes;
    if (modes.length === 1 && soleMode && soleMode !== requested) {
      return {
        mode: soleMode,
        degradeReason: soleModeDegradeReason?.(requested) ?? null,
      };
    }
    const degrade = degradeOnProbeFail[requested];
    if (degrade && installed.supported[requested] === false) {
      return { mode: degrade.to, degradeReason: degrade.reason };
    }
    return { mode: requested, degradeReason: null };
  }

  /**
   * Project one question this CLI asked into the CLI-agnostic
   * {@link AdapterQuestion} a CALLING agent is handed, or null when the payload
   * carries no question at all. Built from the same card the user would see
   * (`adapterQuestionOf` over this CLI's own card projection), so a caller is
   * never offered an option the card would not show.
   *
   * The input is the question tool's own arguments — a shape only this CLI's
   * adapter knows. Consumers hold a payload they must never parse: the team
   * executor bridges a callee's question to its caller without knowing which
   * CLI raised it, which is exactly what this method buys.
   *
   * The base answers null, the whole truth for a CLI whose
   * `config.questionToolName` is null: it has no question channel, so nothing
   * it emits can be a question. Only an adapter whose CLI HAS one overrides
   * this, delegating to a projection in its own `utils/`.
   */
  questionFrom(_input: unknown): AdapterQuestion | null {
    return null;
  }

  /**
   * Fold a free-text answer back into this CLI's question-tool input, so the
   * verdict the CLI receives carries the answer the user (or a calling agent)
   * gave.
   *
   * The counterpart of {@link questionFrom} on the way back, and the only
   * sanctioned mutation of a tool input anywhere: the base echoes the input
   * UNCHANGED, because a CLI with no question channel has no field to fold
   * into and inventing one would hand a tool an argument it never asked for.
   */
  withAnswer(input: unknown, _answer: string): unknown {
    return input;
  }

  /**
   * The env that puts an invocation in ONE config directory — the profile a
   * run belongs to — or `{}` when there is none to state.
   *
   * Shared by every invocation this class hands the user (resume, CLI sign-in,
   * MCP sign-in) because they are all about the same profile: a sign-in run
   * against the default directory cannot fix a run whose session lives in
   * another one, and a resume there would open an unrelated conversation. The
   * var name is the adapter's own fact (`config.configDir.envVar`), so no
   * caller spells it.
   */
  protected configDirEnv(
    configDir: string | null | undefined,
  ): Record<string, string> {
    const trimmed = configDir?.trim();
    const envVar = this.getConfig().configDir.envVar;
    return trimmed && envVar ? { [envVar]: trimmed } : {};
  }

  /**
   * Make one conversation readable from ANOTHER of this CLI's profiles, so a
   * chat repointed at a second account carries on where it left off instead of
   * starting over.
   *
   * Concrete here and driven by config, on the base's own rule: what differs
   * per CLI is whether a conversation can be moved at all
   * (`configDir.sessionCarryUnavailableReason`), and a CLI that can override
   * the MECHANISM. A refusal is data: the caller keeps the previous profile
   * when a supported carry fails, or explains the fresh conversation when
   * carrying is declared unavailable.
   *
   * The default is the refusal, which is right for every CLI that has not
   * measured the move: a copy into another program's store, made on a guess
   * about where it keeps things, is worse than an honest fresh start.
   */
  async carrySessionToConfigDir(
    _input: CarrySessionInput,
  ): Promise<CarrySessionResult> {
    const reason = this.getConfig().configDir.sessionCarryUnavailableReason;
    return {
      carried: false,
      reason: reason ?? 'this CLI cannot move a conversation between profiles',
    };
  }

  /**
   * Remove one conversation a DELETED run held from this CLI's own store, so
   * the user's "delete permanently" reaches the transcript the CLI kept as well
   * as geniro's copy of it.
   *
   * A MECHANISM, so a method: claude's transcript is a file in its profile,
   * cursor's lives in a store geniro owns, and codex deletes a thread itself
   * over its app-server. The default is the refusal, and it is right for every
   * CLI that has not measured how: deleting inside another program's store on
   * a guess about its layout risks the user's own history, which is worse than
   * leaving a transcript behind.
   *
   * Every implementation must keep a conversation that began BEFORE the run
   * (`runCreatedAt`): that one was imported from the user's own CLI and is
   * their terminal history, not something this chat created. Must NEVER throw —
   * a run delete does not fail over a transcript.
   */
  deleteSessionTranscript(
    _input: DeleteSessionTranscriptInput,
  ): Promise<DeleteSessionTranscriptResult> {
    return Promise.resolve({
      deleted: false,
      reason: `${this.getConfig().kind} has no measured way to delete a conversation it holds`,
    });
  }

  /**
   * The pull requests this CLI's own record says one conversation touched, in
   * the order it recorded them; empty for a CLI that keeps no such record.
   * Shown beside the ones the transcript capture saw the thread open
   * (`Run.touchedPullRequests`), never counted as opened, and kept only when
   * the thread names the pull request (`textNamesPullRequest`). Must NEVER throw —
   * an unreadable record costs its chips, not the chat list.
   */
  readSessionPullRequests(
    _input: SessionPullRequestsInput,
  ): Promise<SessionPullRequest[]> {
    return Promise.resolve([]);
  }

  /**
   * How one of this CLI's tool calls is counted in the tool ledger: the tool,
   * and the MCP server its name says it came from, from the `tool_call` row's
   * `name` and `kind`. The default knows no MCP spelling and counts the name.
   */
  toolCallMetric(name: string, _kind: string | null): ToolCallMetric {
    return { tool: name, server: null };
  }

  /**
   * The interactive TUI invocation that mirrors one of this CLI's headless
   * sessions — the same conversation the run produced, reopened in the CLI's
   * own terminal UI.
   *
   * Config-driven and concrete: `config.terminal` carries the resume flag and
   * what a resumable session id looks like for this CLI, so no consumer spells
   * a binary, a flag or an id shape. A CLI with `terminal: null` has no such
   * mode at all and answers `unsupported`, rather than being handed another
   * CLI's argv.
   *
   * It RETURNS the refusal instead of throwing: the two failure arms mean
   * different things to the HTTP caller (a CLI that will never mirror vs a
   * session that does not exist YET), and mapping them to status codes is the
   * consuming module's job — the adapter layer stays free of HTTP exceptions.
   *
   * A missing or foreign-shaped session id is `no-session`, never a bare TUI
   * launch: opening the CLI without a resume target would show an unrelated
   * fresh conversation while claiming to mirror the run.
   */
  handoffTarget(input: HandoffInput): HandoffResult {
    const handoff = this.getConfig().handoff;
    if (handoff.kind === 'unavailable') {
      return { ok: false, reason: 'unsupported' };
    }
    const trimmed = input.sessionId?.trim();
    if (!trimmed || !handoff.sessionIdPattern.test(trimmed)) {
      return { ok: false, reason: 'no-session' };
    }
    // A CLI that lets one process hold a conversation refuses the resume while
    // geniro's kept process has it, so the user is handed a copy instead.
    const verb =
      input.held === true && handoff.heldFlag !== null
        ? handoff.heldFlag
        : handoff.resumeFlag;
    // The run's OWN model, when the CLI can be told. A mirror that opened on
    // the CLI's default was a different model with a different window beside
    // the chat it was supposed to be mirroring.
    const local = this.modelConfiguration(input.model);
    const model = local.model?.trim();
    // The run's OWN config directory, for the same reason and one step
    // further: the session being resumed lives INSIDE that profile, so an
    // invocation without it does not merely open a different account — it
    // opens an unrelated conversation, since the id it resumes is not in the
    // default profile's store. It rides env because that is the only channel
    // the CLI has for it (`config.configDir.envVar`).
    return {
      ok: true,
      kind: 'command',
      command: this.command,
      args: [
        ...local.args,
        ...(model ? [handoff.modelFlag, model] : []),
        verb,
        trimmed,
      ],
      env: { ...this.configDirEnv(input.configDir), ...local.env },
    };
  }

  /**
   * Why this CLI can never reopen one of its conversations, or `null` when it
   * can — the PERMANENT half of {@link handoffTarget}'s two refusals, asked
   * without a session to ask about.
   *
   * Its own method because two consumers need the answer and only one of them
   * has a run: `HandoffService` explains a specific thread, while
   * `CapabilitiesService` reports what each CLI can do at all, before any
   * conversation exists. That one used to fake a session id
   * (`sessionId: 'capability-probe'`) to reach this verdict through
   * `handoffTarget`, then throw the adapter's sentence away and compose
   * `"<agent> has no interactive terminal session"` of its own — so the run
   * route and the capability route gave two different answers to one question,
   * and the invented one was the only one the panel ever showed.
   *
   * A SENTENCE, like the other `unavailableReason` fields, because it is
   * rendered on an inert control: "no button" with no cause is exactly what
   * these fields exist to replace.
   */
  handoffUnavailableReason(): string | null {
    const handoff = this.getConfig().handoff;
    return handoff.kind === 'unavailable' ? handoff.reason : null;
  }

  /**
   * Whether a failed turn's message names a cure the user can apply.
   *
   * Concrete over {@link AdapterConfig.auth}'s markers: what differs per CLI is
   * the wording, not the mechanism. Case-insensitive because a CLI is free to
   * re-case its own message between releases, and a marker that stopped
   * matching would silently take the action off the row.
   *
   * A blank marker is ignored rather than matching every message: an empty
   * substring is contained in every string, so one that reached this list would
   * offer a sign-in for every failure the CLI ever reports.
   */
  errorRecovery(message: string): AgentErrorRecovery | null {
    const haystack = message.toLowerCase();
    const { expiredMarkers } = this.getConfig().auth;
    return expiredMarkers.some(
      (marker) => marker !== '' && haystack.includes(marker.toLowerCase()),
    )
      ? 'cli-login'
      : null;
  }

  /**
   * WHY a turn failed, from the CLI's own message — the answer another AGENT
   * acts on, where {@link errorRecovery} answers for the user.
   *
   * Concrete over config for `errorRecovery`'s reason: what differs per CLI is
   * the wording, never the mechanism. The order is deliberate — a spent usage
   * window outranks an auth marker, because a CLI is free to mention signing in
   * inside a limit message and waiting is the only move that helps there.
   *
   * `crashed` is the floor rather than a null, so every failed turn carries a
   * class and no caller has to branch on its absence.
   */
  failureFrom(message: string): AgentTurnFailure {
    const { rateLimitPatterns, resetsAtPatterns, serviceRefusalMarkers } =
      this.getConfig().auth;
    if (rateLimitPatterns.some((pattern) => pattern.test(message))) {
      return {
        class: 'rate_limited',
        resetsAt: firstCapture(message, resetsAtPatterns),
      };
    }
    if (this.errorRecovery(message) === 'cli-login') {
      return { class: 'auth_expired', resetsAt: null };
    }
    return serviceRefusalMarkers.includes(message.trim())
      ? { class: 'crashed', resetsAt: null, refusedByService: true }
      : { class: 'crashed', resetsAt: null };
  }

  /**
   * RUN this CLI's sign-in, headlessly, as a managed child.
   *
   * The ONLY path now. A `loginTarget` sibling resolved the invocation for the
   * user's own terminal to run, on a block that generalised a probe of `mcp
   * login`, which refuses a non-TTY stdin outright. Re-probed on claude 2.1.228
   * and cursor-agent 2026.08.11: the ACCOUNT login does not refuse. Both print
   * a usable URL, both open the browser themselves, and cursor polls to
   * completion with stdin closed. The resolve-only path outlived that
   * measurement as "the fallback" until its last caller moved in-app, at which
   * point it was a second sign-in mechanism nobody could reach.
   *
   * `processGroup` is forced, not optional. A sign-in spawns a browser opener of
   * its own, so the thing that must die on cancel or shutdown is the GROUP —
   * `runCommand`'s execFile path would leave it behind, and that path also has
   * no writable stdin, which the code prompt needs.
   *
   * Resolves with the child's stdout when it exited cleanly, or `null` on a
   * failure or the deadline. It deliberately does NOT decide whether the user is
   * now signed in: only the CLI's own status probe can answer that, so the
   * caller re-asks rather than trusting an exit code.
   */
  runLogin(options: {
    configDir?: string | null;
    timeoutMs: number;
    onSpawn: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  }): Promise<string | null> {
    const { loginArgs } = this.getConfig().auth;
    if (loginArgs === null) {
      return Promise.resolve(null);
    }
    return this.runCommand([...loginArgs], {
      processGroup: true,
      timeoutMs: options.timeoutMs,
      env: this.configDirEnv(options.configDir),
      onSpawn: options.onSpawn,
    });
  }

  /**
   * RUN this CLI's sign-in to ONE MCP server, as a managed child — the sibling
   * of {@link runLogin} one level down.
   *
   * The ONLY path, exactly as for the account login: its resolve-only twin is
   * gone with the last caller that opened a terminal. What made that possible:
   * `mcp login` refuses a piped stdin outright, so for two milestones the
   * only way to run it was to open the user's terminal — which is what got
   * reported ("it opens a shell; it should take us straight to the browser").
   * The refusal is about a TERMINAL, not about being watched, so
   * {@link AgentCommandOptions.pty} is the whole fix; that option's doc block
   * carries the probe.
   *
   * Resolves with the child's output whatever the exit status
   * (`captureDiagnosis`), because under a pty the status belongs to the wrapper
   * and the CLI's own verdict is only ever in what it printed.
   */
  runMcpLogin(options: {
    server: string;
    cwd: string;
    configDir?: string | null;
    timeoutMs: number;
    onSpawn: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  }): Promise<string | null> {
    const { loginArgs } = this.getConfig().mcp;
    if (loginArgs === null) {
      return Promise.resolve(null);
    }
    return this.runCommand([...loginArgs, options.server], {
      pty: true,
      captureDiagnosis: true,
      // The CLI resolves a server NAME against the folder it runs in, so a
      // sign-in started anywhere else authenticates a different server or none.
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      env: this.configDirEnv(options.configDir),
      onSpawn: options.onSpawn,
    });
  }

  /**
   * RUN this CLI's sign-out, headlessly.
   *
   * Unlike its sign-in sibling this needs no browser and no input at all —
   * probe-verified on claude 2.1.228 with stdin closed and no TTY: exit 0,
   * "Successfully logged out from your Anthropic account." So there is nothing a
   * terminal window would add except a window.
   *
   * The plain execFile path, deliberately: clearing stored credentials forks
   * nothing, so there is no group to reap, and node's own deadline is the whole
   * story. Resolves `true` when the CLI exited cleanly.
   */
  async runLogout(options: {
    configDir?: string | null;
    timeoutMs?: number;
    onSpawn?: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  }): Promise<boolean> {
    const { logoutArgs } = this.getConfig().auth;
    if (logoutArgs === null) {
      return false;
    }
    const out = await this.runCommand([...logoutArgs], {
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      env: this.configDirEnv(options.configDir),
      ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
    });
    return out !== null;
  }

  /**
   * Whether this CLI's own words say a server sign-in did NOT complete.
   *
   * Concrete over `mcp.loginFailureMarkers`, so the service driving one never
   * learns which CLI phrases it how. A blank marker is ignored rather than
   * matching everything — an empty substring is contained in every string, so
   * one that reached the list would report every sign-in as failed.
   */
  mcpLoginFailed(output: string): boolean {
    const haystack = output.toLowerCase();
    return this.getConfig().mcp.loginFailureMarkers.some(
      (marker) => marker !== '' && haystack.includes(marker.toLowerCase()),
    );
  }

  /**
   * Whether this CLI's sign-in output is asking for a code on stdin.
   *
   * Concrete over `auth.loginCodePromptMarkers`, so the service driving a login
   * never learns which CLI prompts and which polls — a CLI that needs nothing
   * declares an empty list and this is permanently false for it.
   */
  loginWantsCode(output: string): boolean {
    const haystack = output.toLowerCase();
    return this.getConfig().auth.loginCodePromptMarkers.some(
      (marker) => marker !== '' && haystack.includes(marker.toLowerCase()),
    );
  }

  constructor(protected readonly options: AgentAdapterOptions = {}) {}

  /**
   * Register this CLI's isolated env names with the child-env strip, and the
   * values of the credentials it inherits with the debug log's redaction.
   *
   * Both are process-wide, which is the point: every child — whichever agent it
   * belongs to — is stripped of every CLI's names. `AgentAdapterRegistry` calls
   * this for each adapter when it is built, before anything spawns. Not the
   * constructor: that would run a subclass's `getConfig()` before the subclass
   * had initialized its own fields, and merely building an adapter — in a spec,
   * say — would edit global state.
   */
  registerEnvIsolation(): void {
    const { kind, auth } = this.getConfig();
    registerIsolatedEnvKeys(auth.isolatedEnvKeys);
    for (const key of auth.inheritedEnvKeys) {
      registerSecret(process.env[key], `${kind} ${key}`);
    }
  }

  /** Build the argv for one turn (model/resume flags, prompt when positional). */
  protected abstract buildArgs(input: AgentTurnInput): string[];

  /**
   * The models this CLI will accept for `--model`, newest information first.
   *
   * Every CLI answers this differently — one has a subcommand, another only a
   * documented alias set — so the shape is fixed here and each subclass
   * decides how to obtain it. An implementation must NEVER throw or hang: a
   * CLI that cannot be asked returns its built-in set, so the picker always
   * offers something.
   */
  abstract listModels(
    input: AgentModelsInput,
    options?: AgentCommandOptions,
  ): Promise<AgentModel[]>;

  /**
   * The MCP servers this CLI loads in a given folder, with the health it
   * reports for each.
   *
   * CONCRETE over config, like `listSkills` and `listEfforts`: whether a CLI
   * can be listed at all is a per-CLI VALUE
   * (`config.mcp.listingUnavailableReason`), so an adapter that cannot be
   * asked declares that string and writes no code — no override, and so no
   * unreachable branch that could drift from the declaration. A CLI that CAN
   * be listed overrides this with its own mechanism.
   *
   * The default refuses rather than answering `{ ok: true, servers: [] }`,
   * because a future adapter that declares no reason and forgets to override
   * must degrade to a visible "not implemented", never to a confident "this
   * folder has no MCP servers".
   *
   * `input.cwd` is load-bearing: the answer is folder-scoped (project
   * `.mcp.json` servers, and local-scope servers keyed to that directory), so
   * a listing taken from the wrong place is confidently wrong rather than empty.
   *
   * Must NEVER throw or hang — this feeds a panel, so a CLI that is missing,
   * unauthenticated or hung costs the user a list, not the request.
   */
  listMcpServers(
    _input: AgentMcpServersInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpListingResult> {
    const config = this.getConfig();
    return Promise.resolve({
      ok: false,
      reason:
        config.mcp.listingUnavailableReason ??
        `${config.kind} does not implement MCP listing`,
    });
  }

  /**
   * What this CLI's own config files say about one folder's servers — which
   * are project-scope, and which the user has already disabled themselves.
   *
   * A MECHANISM, not a value: each CLI keeps this in different files with
   * different keys, so an adapter that knows those files overrides this. The
   * default is the honest answer for one that does not — nothing is known,
   * which renders every row read-only rather than offering a switch whose
   * effect has never been verified for that CLI.
   *
   * `configDir` is the PROFILE the listing was taken under, and it is not
   * decoration: a profile is a whole separate account with its own config file,
   * so reading the default one describes servers this run never loads. Measured
   * here — a profile's own `.claude.json` declared 6 servers where the home one
   * declared 3, and the panel was composed from the 3.
   *
   * Reads only. The files it consults belong to the user, and nothing in this
   * feature ever writes them.
   */
  readMcpFolderFacts(
    _cwd: string,
    _configDir: string | null,
  ): Promise<AgentMcpFolderFacts> {
    return Promise.resolve({
      // An adapter that cannot read its CLI's files cannot name its servers
      // either, so the panel waits on the dial exactly as it did before this
      // field existed. Empty means "nothing to show yet", never "none".
      configured: [],
      disabled: [],
      lockedOff: [],
      // Empty, not a guess: an adapter that cannot read its CLI's config files
      // cannot know which scope a row came from, and every row then renders
      // with its origin unstated — the same honest degradation the two lists
      // above already take.
      origins: {},
      interactiveOnlyNote: null,
      plugins: [],
    });
  }

  /**
   * Copy one server a plugin declares into the CLI's own user-scope MCP config,
   * so the turns geniro runs load it — for a CLI whose own app loads plugin
   * servers that its headless mode does not. The default is the answer for a
   * CLI with no such gap: there is nothing to copy.
   */
  copyPluginMcpServer(
    _input: AgentMcpPluginCopyInput,
  ): Promise<AgentMcpPluginCopyResult> {
    return Promise.resolve({
      ok: false,
      reason: `${this.getConfig().kind} has no plugin servers to copy`,
    });
  }

  /**
   * The MCP servers this CLI's PROFILE defines at user scope, as the CLI's own
   * document states them — what the "Edit JSON" editor opens.
   *
   * A MECHANISM, one per CLI: claude keeps them as `mcpServers` in the
   * profile's `.claude.json`, cursor as `mcpServers` in `~/.cursor/mcp.json`,
   * codex as the `[mcp_servers]` table of its `config.toml`, read through its
   * own app-server. The default is the answer for a CLI with no such document,
   * and it says so rather than answering an empty map — "this profile defines
   * no servers" and "this CLI cannot be edited here" are different facts.
   *
   * Reads only, and never throws: an unreadable document is a reason.
   */
  readMcpConfigDocument(
    _input: { configDir: string | null },
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigDocument> {
    return Promise.resolve({
      servers: null,
      path: null,
      version: null,
      unavailableReason: `${this.getConfig().kind} cannot have its MCP servers edited from geniro`,
    });
  }

  /**
   * Replace the profile's whole user-scope server map with `input.servers` —
   * the WRITE half of {@link readMcpConfigDocument}, through the same file (or
   * the same app-server) the read used, so the editor and the CLI describe
   * one thing.
   *
   * Every implementation touches ONLY the server map: claude's `.claude.json`
   * holds the user's whole CLI state, cursor's `mcp.json` may hold other keys,
   * codex's `config.toml` holds everything else codex is told. And every one
   * refuses a document whose version moved since it was read, since the user
   * edited a copy and a silent overwrite would undo whatever changed it.
   *
   * The default refuses, for the reason the read's default gives.
   */
  writeMcpConfigDocument(
    _input: AgentMcpConfigWriteInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigWriteResult> {
    return Promise.resolve({
      ok: false,
      reason: `${this.getConfig().kind} cannot have its MCP servers edited from geniro`,
    });
  }

  /**
   * Add ONE server to the profile through the CLI's OWN add mechanism — its
   * `mcp add` subcommand where it has one, so the entry is the shape the CLI
   * writes itself; a direct write only where it has none (cursor), under the
   * discipline {@link writeMcpConfigDocument} follows.
   *
   * A name the profile already defines is REFUSED, never replaced: `codex mcp
   * add` overwrites an existing entry without a word (measured on 0.161.0), and
   * replacing a server the user configured by hand is not what "Add" means.
   *
   * The default refuses, for the reason the read's default gives.
   */
  addMcpServer(
    _input: AgentMcpServerAddInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpConfigWriteResult> {
    return Promise.resolve({
      ok: false,
      reason: `${this.getConfig().kind} cannot have MCP servers added from geniro`,
    });
  }

  /**
   * Dial ONE server and report what the CLI said about it, or null when this
   * CLI has no way to be asked about a single one.
   *
   * The point is cost. A folder listing health-checks EVERY server — 4–9s here,
   * and it launches all of them — so it is the wrong instrument for the one
   * question that arises after a write: the user just switched a server on, and
   * the row has to say something about it. Without this the honest answer is
   * `unknown`, since nothing has dialled it (see
   * `AgentMcpService.patchCachedStatus`), and a green dot would be the panel
   * claiming a server works because a switch moved.
   *
   * The default returns null rather than guessing, on the same rule every
   * declared absence here follows: a CLI with no per-server command costs the
   * user a badge until the next real read, not a wrong one.
   *
   * Must NEVER throw — it feeds a panel, and a CLI that is missing or hung costs
   * one row's health, not the toggle the user just performed.
   */
  readMcpServerHealth(
    _input: AgentMcpServerHealthInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentMcpServerHealth | null> {
    return Promise.resolve(null);
  }

  /**
   * Drop this CLI's own record that these servers need signing in, for one
   * profile — called once a dial has seen them connected — and answer with the
   * names whose record was actually removed.
   *
   * A CLI may remember a sign-in failure and skip the server at every later
   * start until the record expires, so a server the user has just authorized
   * goes on being withheld from every new session. Only the caller has seen
   * the server connect; the CLI's own record never learns it. A non-empty
   * answer means the kept sessions loaded without those servers and must be
   * retired.
   *
   * May reject when the record cannot be rewritten; the caller treats that as
   * nothing removed. The default answers none: this CLI keeps no such record.
   */
  forgetMcpNeedsAuth(_input: {
    servers: readonly string[];
    configDir: string | null;
  }): Promise<readonly string[]> {
    return Promise.resolve([]);
  }

  /**
   * The repository a folder belongs to, as this CLI keys the MCP state that
   * reaches a whole repository (`mcp.changeReach.where: 'repository'`). The
   * default is the nearest `.git`, a worktree followed back to its main
   * repository; a CLI that keys it another way overrides this.
   */
  mcpRepositoryKey(cwd: string): Promise<string> {
    return repositoryRootOf(cwd);
  }

  /**
   * Switch one MCP server on or off for one folder — the WRITE half of
   * {@link readMcpFolderFacts}, and the same kind of thing: a mechanism only
   * that CLI knows, so an adapter that has one overrides this.
   *
   * The default REFUSES, with the config's own sentence saying why. Refusing
   * is the honest answer for a CLI whose disable mechanism is unverified: a
   * switch that moves and changes nothing is the exact failure this feature is
   * written to avoid, and the caller turns the refusal into an HTTP error the
   * panel can show.
   *
   * An adapter that implements it writes the CLI's OWN state, not a private
   * one — claude edits `projects[<key>].disabledMcpServers` in `~/.claude.json`
   * (the CLI's own project key for the folder — see `claudeProjectKey`)
   * under the same `proper-lockfile` lock the CLI itself takes, and cursor
   * drives that CLI's own `mcp enable|disable` subcommands. That is a
   * deliberate exception to "geniro writes only its own files": it is the only
   * mechanism that reaches servers of every scope, and sharing the CLI's list
   * means a switch flipped here is the same switch the user sees in their own
   * terminal.
   *
   * `options` carries both halves of that split. `onSpawn` is for the
   * implementations that reach the CLI rather than a file, so the caller
   * registers the child for shutdown exactly as it does for
   * {@link listMcpServers}; `configDir` is for the implementations that reach a
   * FILE, naming the profile whose state to write — the same profile
   * {@link readMcpFolderFacts} was read under, so a switch lands in the file the
   * panel took its rows from. Each implementation ignores the half its own
   * mechanism has no use for.
   */
  setMcpServerEnabled(
    _cwd: string,
    _server: string,
    _enabled: boolean,
    _options: AgentCommandOptions = {},
  ): Promise<void> {
    return Promise.reject(
      new Error(
        this.getConfig().mcp.toggleUnavailableReason ??
          `${this.getConfig().kind} cannot be told which MCP servers to load`,
      ),
    );
  }

  /**
   * The conversations this CLI already holds on this machine, newest first —
   * what the user can carry on inside geniro instead of only in a terminal.
   *
   * A MECHANISM, not a value: claude keeps a JSONL transcript per session under
   * its profile and is read off disk, cursor answers the ACP `session/list`
   * method. The default is the honest answer for a CLI with neither, and it
   * degrades to a VISIBLE reason rather than to a confident "you have no
   * history" — the same rule {@link listMcpServers} follows, and for the same
   * reason: both look like an empty array from outside.
   *
   * Must NEVER throw or hang. This feeds a picker, so a CLI that is missing,
   * signed out or wedged costs the user a list, not the request.
   */
  listSessions(
    _input: AgentSessionsInput,
    _options: AgentCommandOptions = {},
  ): Promise<AgentSessionListing> {
    const config = this.getConfig();
    return Promise.resolve({
      sessions: [],
      unavailableReason:
        config.sessions.listingUnavailableReason ??
        `${config.kind} cannot list the conversations it holds`,
      partialReason: null,
    });
  }

  /**
   * Make one of those conversations resumable by geniro, or throw saying why
   * it cannot be.
   *
   * Whether this does anything at all is a per-CLI fact, which is why it is a
   * method and not a flag. claude needs nothing — its sessions are keyed by id
   * inside the profile the run already carries, so listing and resuming read
   * the same store. cursor needs a COPY: geniro's turns run under a throwaway
   * profile whose `acp-sessions` is a symlink to geniro's own store, so a
   * session sitting in the user's profile is invisible to `session/load` until
   * it is brought across (probed 2026-08-16 both ways — not found before the
   * copy, loads and replays its whole transcript after).
   *
   * Called ONCE, when the thread is created. Throwing is the way to refuse: the
   * chat is not created, and the user is told rather than handed a thread whose
   * first turn will fail on a session the CLI cannot find.
   */
  prepareSessionImport(_input: AgentSessionImportInput): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The conversation as this CLI recorded it, mapped to geniro's own events —
   * or null when it keeps no record a reader can open.
   *
   * This is what puts the prior messages ON SCREEN. Resuming without it works
   * (the AGENT has its context either way) but shows the user an empty thread,
   * which is indistinguishable from an import that did nothing.
   *
   * Null is not the end of the road: a CLI that replays its conversation when
   * a session is loaded gets its history through `AgentTurnInput`'s
   * `importSessionHistory` on the first turn instead — cursor's whole import.
   * A CLI with neither declares `sessions.historyUnavailableReason`.
   *
   * `limit` bounds the ROWS returned, newest kept: a real claude session here
   * runs to 11MB, and a thread nobody can scroll is its own failure. An
   * implementation that truncates says so through the returned
   * {@link AgentSessionHistory.droppedBefore}.
   *
   * Must NEVER throw — a record that cannot be parsed costs the transcript, not
   * the import.
   */
  readSessionHistory(
    _input: AgentSessionImportInput & { limit: number },
  ): Promise<AgentSessionHistory | null> {
    return Promise.resolve(null);
  }

  /** Null means the CLI's record cannot establish a terminal outcome. */
  recoverSubagent(
    _ref: SubagentRecoveryRef,
  ): Promise<RecoveredSubagentOutcome | null> {
    return Promise.resolve(null);
  }

  /**
   * The reasoning-effort levels this CLI accepts for one turn, weakest first,
   * or `[]` when it has no such control at all.
   *
   * Synchronous because it is a documented constant on every adapter that has
   * one — nothing is asked of the binary. It must NOT be scraped from the
   * CLI's own help output: claude's `--help` under-reports its own vocabulary
   * (probe-verified — see `claude/claude.const.ts`), so a scrape would
   * silently drop a level the CLI accepts.
   *
   * A `config.efforts` of `[]` is the whole signal that the CLI has no effort
   * control: the consumer refuses an effort for it and the UI omits the
   * picker, without anything outside this layer knowing which CLI it is.
   */
  listEfforts(): AgentEffort[] {
    return [...this.getConfig().efforts];
  }

  /**
   * The levels ONE MODEL of this CLI accepts — the narrowing of
   * {@link listEfforts} that a picker should actually offer.
   *
   * Concrete over config, and that default is the right answer for a CLI whose
   * effort vocabulary belongs to the BINARY: claude's `--effort` takes the same
   * words whichever model runs, so its per-model list is its CLI-wide list and
   * asking the binary per model would spend a probe to learn nothing.
   *
   * A CLI whose levels belong to the MODEL overrides this. Cursor does: its
   * levels arrive as a per-model config option in the ACP handshake, so the
   * superset above can only ever be a union that some models refuse.
   *
   * `model` is null when nothing has been chosen yet — answer with the superset
   * then, never with silence: the picker exists before a model does, and a chip
   * that renders nothing until a model is picked reads as a broken control.
   *
   * MUST NOT throw, like every listing on this base: a CLI that cannot be asked
   * degrades to the superset, because hiding a level geniro merely failed to
   * confirm would take away a control that works.
   */
  async listModelEfforts(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentEffortListing> {
    if (model?.startsWith('ollama/')) {
      return {
        efforts: [],
        unavailableReason: 'Ollama controls local model thinking.',
        exact: true,
      };
    }
    void options;
    const config = this.getConfig();
    return {
      efforts: [...config.efforts],
      unavailableReason: config.effortsUnavailableReason,
      // Config, not a model's own answer. For a CLI whose list IS the whole
      // vocabulary this changes nothing — that list is exact by construction and
      // its caller checks `effortsAreExhaustive` instead.
      exact: false,
    };
  }

  /**
   * The context-window sizes ONE MODEL of this CLI can be run at — the twin of
   * {@link listModelEfforts}, and per model for the same measured reason.
   *
   * Concrete over config, and the default is "this CLI has no such control",
   * which is claude's answer: a model's window is a property of the model
   * there, with no flag to change it. A CLI that DOES offer the axis overrides
   * this; cursor does, as one `model_config` option in its ACP handshake.
   *
   * There is no superset fallback, unlike efforts — see
   * {@link AdapterConfig.contextWindowsUnavailableReason} for why a CLI-wide
   * union of window sizes would not mean anything. So `exact` is false here
   * only in the sense that nothing was asked.
   *
   * MUST NOT throw, like every listing on this base: a CLI that cannot be asked
   * costs the user a picker, not the request.
   */
  async listModelContextWindows(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentContextWindowListing> {
    void model;
    void options;
    const config = this.getConfig();
    return {
      windows: [],
      unavailableReason:
        config.contextWindowsUnavailableReason ??
        `${config.kind} does not offer a context-window setting`,
      // The base's answer is for a CLI with no such axis at all.
      unavailableKind: 'no-axis',
      exact: false,
    };
  }

  /**
   * Every OTHER setting the CLI enumerates for one model — see
   * {@link AgentModelParameterListing}.
   *
   * The base answers "none", which is claude's answer: its models take a model
   * name and nothing else. A CLI that enumerates more overrides this, and what
   * it must return is the SUBTRACTION — everything it enumerated, minus the
   * axes geniro already drives (the model itself, its effort, its context
   * window, and any mode this app owns through another control). Returning the
   * whole list instead would put a second control on screen beside every one of
   * those, each able to disagree with it.
   *
   * MUST NOT throw, like every listing on this base.
   */
  async listModelParameters(
    model: string | null,
    options: AgentCommandOptions = {},
  ): Promise<AgentModelParameterListing> {
    void model;
    void options;
    return {
      parameters: [],
      unavailableReason: `${this.getConfig().kind} offers no further model settings`,
      exact: false,
    };
  }

  /**
   * Forget whatever THIS adapter caches about its own CLI, and say how many
   * answers went.
   *
   * The base answers zero, which is the truth for an adapter holding no cache
   * of its own: every listing on this class is computed from `getConfig()` or
   * read fresh. An adapter that memoizes a real ask overrides it — a mechanism,
   * so a method rather than a config field. Reached only from
   * `CacheResetService`, which the user drives from the menu bar.
   *
   * MUST NOT throw and MUST NOT ask the CLI anything: this runs on a request
   * that is trying to make the app forget, not to make it work.
   */
  clearCaches(): number {
    return 0;
  }

  /**
   * Forget what THIS adapter caches about its CLI's ACCOUNT, because geniro
   * just signed that CLI in or out (`CacheResetService.forgetAgent`).
   *
   * Not {@link clearCaches}, which serves the menu bar's reset and deliberately
   * lets an ask already running file its answer (a fresh ask is what a reset
   * wants). Here an ask already running was taken under the credentials just
   * replaced, so an adapter that memoizes one must also stop that answer being
   * filed. The default delegates to {@link clearCaches}, which is right for an
   * adapter whose cache has no asks in flight — the base's, holding none.
   *
   * The same two MUSTs: never throw, never ask the CLI anything.
   */
  forgetAccountCaches(): number {
    return this.clearCaches();
  }

  /**
   * Where this CLI's USER-scope configuration lives for a given run: the run's
   * own profile, or the home dir when it names none.
   *
   * `strip` is what makes one set of declared segments serve both. A CLI states
   * its roots relative to a HOME dir (`.claude/skills`), and a config directory
   * is precisely what those first segments name — so a profile root is the same
   * declaration with that anchor removed (`<configDir>/skills`), and nothing has
   * to be written down twice. A CLI whose account is not a directory declares no
   * anchor and keeps the home root whatever a run asks for.
   */
  private profileRoot(
    configDir: string | null,
    homeDir: string,
  ): { source: 'user'; dir: string; strip: readonly string[] | null } {
    const anchor = this.getConfig().skillRoots.profileAnchor;
    return configDir !== null && anchor !== null
      ? { source: 'user', dir: configDir, strip: anchor }
      : { source: 'user', dir: homeDir, strip: null };
  }

  /**
   * The profile an ACCOUNT-level answer belongs to — or null when this CLI's
   * account is not decided by a directory at all.
   *
   * Every vocabulary this app caches (models, efforts, context windows, model
   * parameters, the reported command list) is a fact about a SUBSCRIPTION, so
   * the config directory belongs in its key. For a CLI where it decides
   * nothing, keying by it would split one answer into a copy per profile and
   * pay that CLI's cold handshake — measured at 6–7s on cursor — for each.
   *
   * Read from `configDir.unavailableReason`, which is that CLI's own
   * declaration, so no caller branches on which agent it is talking to.
   */
  vocabularyProfile(configDir: string | null): string | null {
    return this.getConfig().configDir.unavailableReason === null
      ? configDir
      : null;
  }

  /**
   * The skills / slash commands this CLI can be invoked with in a folder, as
   * found on disk — each CLI keeps them under its own roots
   * (`config.skillRoots`: `.claude/skills`, `.claude/commands`,
   * `.cursor/commands`), scanned in the project folder and then the user's
   * home dir.
   *
   * The ORDER is the contract, and it is the CLI's own shadowing order: root
   * by root, skills before commands, project before user. The caller de-dupes
   * first-occurrence-wins, so this is what makes it keep the entry the CLI
   * would actually run. Never throws — one broken file on disk must not fail
   * the list (the scanners skip unreadable entries).
   */
  async listSkills({
    cwd,
    homeDir,
    configDir,
  }: AgentSkillsInput): Promise<AgentSkillEntry[]> {
    // The USER root is the run's own profile when it has one, and the home dir
    // otherwise — a REPLACEMENT, never an addition, because that is what the
    // mechanism does: a config directory takes the place of the CLI's home
    // configuration rather than sitting beside it, so a chat on a profile does
    // not load `~`'s skills at all. Without this the `/` list was the DEFAULT
    // profile's for every chat, whatever account it ran as; measured on the
    // reporter's machine, `~/.claude` holds 10 plugins and 2 skills while each
    // of their two profiles holds 7 plugins and a command of its own, none of
    // which the composer could offer.
    const user = this.profileRoot(configDir, homeDir);
    const roots = [{ source: 'project' as const, dir: cwd, strip: null }, user];
    const found: AgentSkillEntry[] = [];
    for (const root of roots) {
      for (const segments of this.getConfig().skillRoots.skills) {
        const dir = rootPath(root, segments);
        if (dir !== null) {
          found.push(...(await scanSkillDirs(dir, root.source)));
        }
      }
      for (const segments of this.getConfig().skillRoots.commands) {
        const dir = rootPath(root, segments);
        if (dir !== null) {
          found.push(...(await scanCommandFiles(dir, root.source)));
        }
      }
    }
    // Installed PLUGINS, last: a plugin's skill is the widest-scoped thing a
    // CLI loads, so the folder's own and the user's own both shadow it under
    // the caller's first-occurrence-wins de-dup. `user` source because that is
    // the scope a plugin is installed at — `geniro` is reserved for geniro's
    // OWN commands, which are a different thing wearing a similar name.
    for (const host of this.getConfig().skillRoots.plugins) {
      // Under the SAME user root the skills above took, so a profile's own
      // installed plugins are the ones offered — see that root's own note.
      const cacheDir = rootPath(user, host.cacheDir);
      if (cacheDir === null) {
        continue;
      }
      const pluginDirs = await discoverPluginDirs(cacheDir, host.manifests);
      for (const pluginDir of pluginDirs) {
        for (const segments of host.skillDirs) {
          const rows = await scanSkillDirs(
            join(pluginDir, ...segments),
            'user',
          );
          // First build that yields anything wins for THIS plugin — see
          // `skillDirs`. An empty directory is not a build.
          if (rows.length > 0) {
            found.push(...rows);
            break;
          }
        }
      }
    }
    return found;
  }

  /**
   * The slash commands the CLI ITSELF reports it can run — its built-ins and
   * plugin commands, which exist nowhere on disk to be scanned.
   *
   * Only the binary knows this set, and only some CLIs will say: a CLI that
   * makes no such report (`config.reportedCommands: null`) answers `[]` without
   * spawning anything, and so does one that cannot be asked right now. Never
   * throws, and never hangs. The caller decides how often to ask; this method
   * always does the work when called.
   *
   * The harvest itself is the same for every CLI that HAS such a report,
   * because it rides the normalized `slash_commands` event rather than any
   * CLI's own field: start one headless turn and cancel it the instant the list
   * lands, before the model runs — which is what makes the answer free.
   *
   * The turn runs in a throwaway temp cwd on purpose, on both counts: it fires
   * no project hooks and starts no session in a repo the user did not ask us to
   * touch, and the answer is CWD-INDEPENDENT — verified live against claude, an
   * empty temp dir reports the same built-ins and plugin commands as a real
   * project — so one probe serves every folder. What that necessarily excludes
   * is the per-project layer, which the disk scan (`listSkills`) already covers.
   *
   * Returns `[]` when the CLI never reached its report (missing binary, auth
   * failure, a hang).
   */
  async listReportedCommands(
    options: AgentCommandOptions = {},
  ): Promise<AgentReportedCommand[]> {
    const probe = this.getConfig().reportedCommands;
    if (!probe) {
      return [];
    }
    // INSIDE the try: creating the root can fail (an unusable `probeRootDir`),
    // and that must degrade to the disk scan like every other probe failure
    // rather than throw out of a listing.
    let cwd = '';
    let captured: AgentReportedCommand[] = [];
    try {
      cwd = this.makeProbeRoot('commands');
      let resolveCaptured!: () => void;
      const commandsSeen = new Promise<void>((resolve) => {
        resolveCaptured = resolve;
      });
      // No approvalMode: the turn gets the CLI's own defaults and NO
      // permission-bypass flag. It is cancelled before the model runs, so the
      // least-privileged argv is also the sufficient one.
      //
      // `isolateMcpServers` for the same reason, one step further: the probe
      // reads a list the CLI reports about ITSELF, so no MCP server can
      // contribute to the answer — but without this the CLI still starts every
      // server the folder defines, and cancelling the probe then reaps a group
      // holding the user's own. Nothing to launch is nothing to kill.
      // `internalProbe` for a third reason of the same kind: the reply is
      // parsed into a command list and never rendered, so the host preamble
      // describing the transcript would be both untrue here and argv paid on
      // every capability read.
      const handle = this.start(
        {
          prompt: probe.probePrompt,
          cwd,
          isolateMcpServers: true,
          internalProbe: true,
          // Says what this turn IS, for an adapter whose CLI has to be ASKED
          // for the sentences beside the names — see `commandListProbe`.
          commandListProbe: true,
          // Under the caller's PROFILE: a profile carries its own installed
          // plugins, and their commands are exactly what this probe exists to
          // find. It ran under the default profile unconditionally, so a chat
          // on a profile was offered the default account's plugin commands and
          // none of its own. A CLI whose account is not a directory ignores it.
          configDir: options.configDir ?? null,
        },
        (event) => {
          if (event.type === 'slash_commands' && captured.length === 0) {
            captured = event.commands
              .filter(
                (command) =>
                  probe.internalPrefix === null ||
                  !command.name.startsWith(probe.internalPrefix),
              )
              .slice(0, probe.maxCommands);
            resolveCaptured();
          }
        },
      );
      options.onTurn?.(handle);
      const timer = setTimeout(
        () => handle.cancel(),
        options.timeoutMs ?? probe.probeTimeoutMs,
      );
      timer.unref?.();
      const capturedWon = await Promise.race([
        commandsSeen.then(() => true),
        handle.done.then(() => false),
      ]);
      if (capturedWon) {
        // Proof is in — the rest of the turn is spent without information.
        handle.cancel();
      }
      await handle.done;
      clearTimeout(timer);
    } catch {
      // A turn that fails synchronously (an unusable probe root, a bad argv)
      // leaves the caller with the disk scan.
      return [];
    } finally {
      if (cwd !== '') {
        this.removeProbeRoot(cwd);
      }
    }
    return captured;
  }

  /**
   * The slash commands geniro ITSELF adds to this CLI — see
   * {@link AgentGeniroCommand}. Static, so it costs no spawn and cannot fail.
   */
  listGeniroCommands(): readonly AgentGeniroCommand[] {
    return this.getConfig().geniroCommands;
  }

  /**
   * The geniro command a composer message INVOKES, or null when it is ordinary
   * prose.
   *
   * The whole message must be the bare command. A geniro command rewrites what
   * the agent is asked, so a message that merely BEGINS with one would have the
   * user's own sentence silently discarded — and `/compact do it thoroughly`
   * reads far more like a user talking than like an invocation with arguments.
   * These commands take none.
   */
  geniroCommandFor(text: string): AgentGeniroCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return null;
    }
    const name = trimmed.slice(1);
    return (
      this.listGeniroCommands().find((command) => command.name === name) ?? null
    );
  }

  /**
   * A fresh empty directory to point a probe at.
   *
   * Every probe needs one for the same reason: `resolve-cwd.ts` records that an
   * agent is scoped to the user's CHOSEN folder and "never defaults to the
   * daemon's own cwd, the app repo". A probe has no chosen folder, so it gets a
   * disposable one rather than borrowing whichever directory the daemon happens
   * to be running in — which under `pnpm dev` is this repo, and would root a
   * real agent session there.
   *
   * `probeRootDir` keeps it under the app's own userData when the daemon runs
   * packaged, and falls back to the OS tmpdir for standalone and spec use.
   */
  protected makeProbeRoot(label: string): string {
    const dir = join(
      this.options.probeRootDir ?? tmpdir(),
      `${label}-${randomUUID()}`,
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * Best-effort cleanup only: a straggler of a just-cancelled probe process
   * group writing into the directory can make `rmSync` throw (EBUSY/ENOTEMPTY —
   * `force` suppresses only ENOENT). That must never fail the read; the temp
   * dir is reaped on the next probe/boot.
   */
  protected removeProbeRoot(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // See the doc block above — deliberately swallowed.
    }
  }

  /** Memoized: the binary is asked once per adapter instance, not once per turn. */
  private liveStreamSupport: Promise<boolean> | null = null;

  /**
   * Whether the INSTALLED binary can stream partial assistant text, so a turn
   * may be started with `streamPartials`.
   *
   * Asked rather than assumed because the answer is per-binary, not per-CLI: a
   * flag the current claude accepts is rejected on argv by an older one, which
   * would fail every turn instead of merely not streaming. A CLI with no such
   * mode (`config.liveStream: null`) answers false forever, without spawning
   * anything.
   *
   * `config.liveStream.probeArgs` is `--help`-shaped by design: the cheapest
   * honest source, since it is the same binary that would reject the flag on
   * argv, it needs no account and no network, and it cannot start a turn.
   * Never throws — absent output (a missing binary, a timeout) reads as "no",
   * which degrades to block streaming rather than failing turns.
   */
  supportsLiveStream(options: AgentCommandOptions = {}): Promise<boolean> {
    const liveStream = this.getConfig().liveStream;
    if (!liveStream) {
      return Promise.resolve(false);
    }
    this.liveStreamSupport ??= this.runCommand(
      [...liveStream.probeArgs],
      options,
    ).then((stdout) => (stdout ?? '').includes(liveStream.flag));
    return this.liveStreamSupport;
  }

  /**
   * Run a short-lived utility command for THIS CLI and return its stdout, or
   * null if it failed, timed out, or the binary is missing.
   *
   * The single spawn path for everything that is not a turn — subclasses never
   * reach for `execFile` themselves, exactly as they never reach for
   * `runHeadlessCli`. It strips the daemon's `GENIRO_`-prefixed env like a
   * turn does, and registers the child for shutdown — through the caller's
   * `onSpawn` when it brings one, else itself ({@link AgentAdapterOptions.processes}).
   * Never rejects.
   *
   * `options.processGroup` picks WHICH of the two child shapes below runs —
   * see that option's doc block, which is the canonical statement of why.
   *
   * A CONVERSATIONAL command implies the group path rather than merely being
   * documented to require it. `execFile` gets no writable stdin here, so
   * `stdinWrites` there would drop every frame silently and `settleWhen` would
   * never be consulted — the read would then wait out its whole deadline
   * against a CLI that (for the one caller this exists for) never exits, and
   * report the failure of a read that would have succeeded. Inferring the path
   * from the options makes that combination unreachable instead of a rule a
   * caller has to remember.
   */
  protected runCommand(
    args: string[],
    options: AgentCommandOptions = {},
  ): Promise<string | null> {
    const reapable = this.reapable(args, options);
    const conversational =
      reapable.stdinWrites !== undefined ||
      reapable.converse !== undefined ||
      reapable.settleWhen !== undefined ||
      reapable.endStdin === true;
    // A pty implies the group path for the same reason a conversational
    // command does, and one step harder: the wrapper is a process with the CLI
    // under it and a browser opener under that, so a single-pid reap addresses
    // the wrapper alone. See {@link AgentCommandOptions.pty}.
    return reapable.processGroup === true ||
      conversational ||
      reapable.pty === true
      ? this.runAsProcessGroup(args, reapable)
      : this.runViaExecFile(args, reapable);
  }

  /**
   * `options` with an `onSpawn` that registers the child for shutdown, unless
   * the caller brought its own — see {@link AgentAdapterOptions.processes}.
   */
  private reapable(
    args: readonly string[],
    options: AgentCommandOptions,
  ): AgentCommandOptions {
    const processes = this.options.processes;
    if (options.onSpawn !== undefined || processes === undefined) {
      return options;
    }
    return {
      ...options,
      onSpawn: (child, spawnInfo) =>
        processes.register(
          `${basename(this.command)}-${args[0] ?? 'command'}:${randomUUID()}`,
          childProcessHandle(child, spawnInfo),
        ),
    };
  }

  /**
   * The plain path: node buffers stdout and enforces the deadline itself with
   * a single-PID kill, which is the whole story for a command that forks
   * nothing of its own.
   */
  private runViaExecFile(
    args: string[],
    options: AgentCommandOptions,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const run = this.options.execFileFn ?? execFile;
      let child: ChildProcess;
      try {
        child = run(
          this.command,
          args,
          {
            timeout: options.timeoutMs ?? UTILITY_COMMAND_TIMEOUT_MS,
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
            encoding: 'utf8',
            env: buildChildEnv({ ...this.inheritedEnv(), ...options.env }),
          },
          (err, stdout, stderr) =>
            resolve(
              // `captureDiagnosis` keeps the output on the FAILURE path, where
              // some CLIs put the only reading that matters — see that option.
              // Both streams, because that is where they put it.
              options.captureDiagnosis === true
                ? `${String(stdout)}${String(stderr)}`
                : err
                  ? null
                  : String(stdout),
            ),
        );
      } catch {
        // A missing binary throws synchronously on some platforms.
        resolve(null);
        return;
      }
      options.onSpawn?.(child, { processGroup: false });
    });
  }

  /**
   * The group path: `spawn` with `detached`, stdout collected by hand, and a
   * deadline of our own that reaps the WHOLE group.
   *
   * It cannot be `execFile` carrying `detached: true` in its options bag:
   * node forwards only cwd/env/uid/gid/shell/windows* from `execFile` down to
   * `spawn` and silently drops the rest, so such a child never leads a group
   * and `killProcessGroup(child.pid)` names a pgid that does not exist.
   *
   * Both streams are handled explicitly, because `execFile` did it for us and
   * `spawn` does not: stdout is DECODED AS A STREAM (`setEncoding`, so a
   * multi-byte character split across two reads survives), and stderr is
   * DRAINED. An unread stderr pipe fills at ~64KB and blocks the child
   * mid-write, so a listing whose answer was already on the wire would hang
   * to the deadline and report as a failure.
   *
   * Reaps on EVERY settle, success included, and that is not symmetry for its
   * own sake. A listing command HEALTH-CHECKS — it launches the user's own MCP
   * servers to dial them — and a server that does not exit on stdin EOF
   * outlives the CLI. Probed on cursor-agent 2026.07.23-e383d2b with a
   * deliberately lingering stdio server: `mcp list` exited 0 and left exactly
   * one child running. Once the CLI exits `ProcessRegistry` drops the handle
   * on `done`, so nothing else could ever reach that group again — not
   * shutdown, not cancel — and each refresh stranded another copy.
   */
  private runAsProcessGroup(
    args: string[],
    options: AgentCommandOptions,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const spawnFn = this.options.groupSpawnFn ?? spawn;
      const timeoutMs = options.timeoutMs ?? UTILITY_COMMAND_TIMEOUT_MS;
      const maxChars =
        options.maxOutputChars ?? UTILITY_COMMAND_MAX_BUFFER_CHARS;
      let child: ChildProcess | undefined;
      let settled = false;
      let reaped = false;
      let stdout = '';
      /**
       * Collected only under `captureDiagnosis`, and appended to `stdout` at
       * settle. Kept separate while reading so an interleaved write cannot land
       * in the middle of a stdout line the parser is about to split.
       */
      let stderr = '';
      /**
       * The CLI `script` started under its pty, looked up right after the
       * spawn — see {@link ptyChildrenOf}. Null when there is no pty.
       */
      let ptyChildren: Promise<ProcessRow[]> | null = null;
      const reapGroup = (): void => {
        // Idempotent, and that is the point: `exit`, `close` and the deadline
        // all reap. Without this the second signal would land after node has
        // waitpid'd the child, when the pid may already belong to something
        // else.
        // `child` is assigned before any caller of this can run: the stream
        // and process listeners are attached after the spawn, and the timer
        // cannot fire synchronously. The guard is the type narrowing.
        if (reaped || !child) {
          return;
        }
        reaped = true;
        // SIGTERM first, then SIGKILL. This group exists to have launched the
        // user's OWN MCP servers — that is what a listing command does to
        // health-check them — and a server holding real state (a browser
        // session, an open index) needs the chance to shut down.
        //
        // The escalation runs even once the CLI's own `exit` has been seen,
        // because the wedged case this reap exists for HAS an exit: the CLI is
        // gone while a health-check grandchild still holds the inherited stdout
        // pipe, so `close` never arrives, and it is the SIGKILL that closes the
        // pipe and lets an already-read listing be delivered. Withholding it
        // there trades a working read for the deadline and a null.
        //
        // Safe despite the pid-reuse hazard, by POSIX: a process-GROUP id is
        // not reissued while the group still has members, so `kill(-pgid)`
        // reaches something only when that something is genuinely this group.
        // Once the group is empty the signal finds nothing.
        createGroupTerminator(child).terminate();
        // …and under a pty, the CLI's OWN group too. `script` starts the CLI
        // in a session (and so a process group) of its own, so the kill above
        // reaches only the wrapper — measured: `script` pgid 56120, the CLI
        // 56123, and a CLI ignoring the SIGHUP the wrapper's exit sends lived
        // on reparented to launchd. Every way this group dies ends here
        // (`exit` fires for a `ProcessRegistry` cancel and shutdown too), which
        // is why the CLI's pid is found while `script` is still its parent.
        if (ptyChildren !== null) {
          void this.reapPtyChildren(ptyChildren);
        }
      };
      const settle = (value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // Armed BEFORE the spawn: an injected spawn that emits synchronously
      // (the spec seam) would otherwise leave a live timer no listener can
      // clear, and it would fire `killProcessGroup` on a pid the test invented.
      const timer = setTimeout(() => {
        reapGroup();
        settle(null);
      }, timeoutMs);
      timer.unref?.();
      // Under a pty the CLI is not the child — `script` is, with the CLI under
      // it. Everything downstream (the reap, the journal, the streams) then
      // addresses the wrapper's group, which is exactly the unit that has to
      // die: see {@link AgentCommandOptions.pty}.
      const spawned =
        options.pty === true
          ? {
              command: PTY_WRAPPER,
              args: [...PTY_WRAPPER_ARGS, this.command, ...args],
            }
          : { command: this.command, args };
      try {
        child = spawnFn(spawned.command, spawned.args, {
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          detached: true,
          // The pty wrapper gets /dev/null on stdin, not a pipe, and that is
          // load-bearing rather than tidiness: `script` copies its OWN stdin's
          // terminal settings onto the pty it allocates, so with a pipe there
          // it dies at once with `script: tcgetattr/ioctl: Operation not
          // supported on socket` and exit 1 — measured, and silent from the
          // caller's side, since an empty output past `captureDiagnosis` reads
          // as a command that ran and said nothing. Nothing is lost by it: the
          // CLI's stdin is the pty, and a pty command writes no frames.
          stdio: [options.pty === true ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          env: buildChildEnv({ ...this.inheritedEnv(), ...options.env }),
        });
      } catch {
        // A missing binary throws synchronously on some platforms.
        settle(null);
        return;
      }
      // Journaled like a turn spawn, and for a sharper reason: this path is
      // taken by `mcp list`, which HEALTH-CHECKS by launching the user's own
      // MCP servers (see the doc block above). A SIGKILL between the spawn and
      // the reap strands that whole group with nothing left to name it.
      trackDetachedChild(child, spawned.command);
      if (options.pty === true && typeof child.pid === 'number') {
        ptyChildren = this.ptyChildrenOf(child.pid, () => reaped);
      }
      if (options.stdinWrites !== undefined || options.converse !== undefined) {
        // Attached BEFORE the first write. An `'error'` on a stream with no
        // listener is an uncaught exception in node, and `child.on('error')`
        // below does NOT cover it — that one is the ChildProcess's own error,
        // while this is the stdin socket's. The reachable case is ordinary: a
        // missing binary fails the spawn asynchronously, or the child exits
        // before the buffered frames flush, and either raises EPIPE /
        // ERR_STREAM_DESTROYED here. Without this, opening the model picker on
        // a machine with no working CLI would take the daemon down instead of
        // answering with an empty list.
        child.stdin?.on('error', () => {
          reapGroup();
          settle(null);
        });
        for (const chunk of options.stdinWrites ?? []) {
          child.stdin?.write(chunk);
        }
      }
      if (options.endStdin === true) {
        child.stdin?.on('error', () => undefined);
        child.stdin?.end();
      }
      // Decoded as a STREAM: node's StringDecoder holds a partial multi-byte
      // sequence across reads, so a character split at a 64KB boundary is not
      // turned into two replacement characters.
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        // A settled read still has a live pipe until `close`. Without this the
        // buffer would go on growing past the cap that just gave up on it —
        // for a deadline settle, until the child is reaped.
        if (settled) {
          return;
        }
        stdout += chunk;
        // The caller's answer to what it has read so far goes out BEFORE the
        // settle check, so a dialogue whose last reply also asks the next
        // question is never cut off by a premature settle.
        if (options.converse !== undefined) {
          for (const frame of options.converse(stdout)) {
            child?.stdin?.write(frame);
          }
        }
        // Checked BEFORE the size cap: a conversational command's answer is
        // already complete here, and this path exists because its child will
        // never exit on its own to end the read.
        if (options.settleWhen?.(stdout) === true) {
          reapGroup();
          settle(stdout);
          return;
        }
        if (stdout.length > maxChars) {
          // `execFile`'s own maxBuffer path kills the direct pid only; ours
          // reaps the group, or the grandchildren outlive the read that gave
          // up on them.
          reapGroup();
          settle(null);
        }
      });
      // DRAINED at minimum, and that is not optional: a piped stream with no
      // reader fills at ~64KB and the child blocks mid-write, so `close` never
      // arrives. `mcp list` health-checks the user's own MCP servers and
      // forwards their startup noise down exactly this pipe.
      //
      // Under `captureDiagnosis` it is drained by being COLLECTED, which is the
      // same obligation met a different way — the stream is still consumed on
      // every chunk. Capped like stdout, and by the SAME budget rather than its
      // own: an MCP server's startup noise arrives here, so a chatty one must
      // not be able to push the read past the cap that protects the daemon's
      // memory and then have its own diagnosis truncated instead.
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (settled || options.captureDiagnosis !== true) {
          return;
        }
        stderr += chunk;
        if (stdout.length + stderr.length > maxChars) {
          reapGroup();
          settle(null);
        }
      });
      child.on('error', () => {
        reapGroup();
        settle(null);
      });
      // `exit` fires when the CLI itself is gone; `close` waits for the stdio
      // pipes, which a lingering health-check grandchild holds open. Reaping
      // at `exit` is what lets `close` arrive at all in that case — otherwise
      // the read that DID succeed sits until the deadline and reports null.
      child.on('exit', () => reapGroup());
      child.on('close', (code, signal) => {
        reapGroup();
        if (options.captureDiagnosis === true) {
          // The exit status is deliberately not consulted: the caller asked for
          // the output BECAUSE the reading it wants comes with a non-zero exit.
          settle(`${stdout}${stderr}`);
          return;
        }
        settle(code === 0 && signal === null ? stdout : null);
      });
      options.onSpawn?.(child, { processGroup: true });
    });
  }

  /**
   * The process(es) `script` started under its pty: its direct children, each
   * a SESSION leader and so the leader of its own process group.
   *
   * Read from the process table while `script` is alive, because that is the
   * only moment the CLI can be named by its parent: once `script` goes, the
   * CLI is reparented to launchd and nothing ties it to this sign-in any more.
   * Polled, briefly, since a reading taken the instant after the spawn can
   * predate `script`'s own fork. Gives up once the group has been reaped (the
   * child could no longer be found by parent) and never rejects.
   */
  private async ptyChildrenOf(
    scriptPid: number,
    reaped: () => boolean,
  ): Promise<ProcessRow[]> {
    const list = this.options.listProcessesFn ?? listProcesses;
    for (let attempt = 0; attempt < PTY_CHILD_LOOKUP_ATTEMPTS; attempt += 1) {
      const rows = await list().catch((): ProcessRow[] => []);
      const children = rows.filter((row) => row.ppid === scriptPid);
      if (children.length > 0 || reaped()) {
        return children;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, PTY_CHILD_LOOKUP_INTERVAL_MS).unref?.();
      });
    }
    return [];
  }

  /**
   * Terminate the pty child's own process group — the half of a pty command's
   * reap the wrapper's group kill cannot reach.
   *
   * Each child is RE-CONFIRMED against a fresh reading first — the same pid
   * still running the same command — because it was recorded minutes ago and
   * is no longer this process's descendant by then: a pid that has since been
   * reissued to something else must not be signalled on the strength of an old
   * row. Never rejects.
   */
  private async reapPtyChildren(found: Promise<ProcessRow[]>): Promise<void> {
    const recorded = await found;
    if (recorded.length === 0) {
      return;
    }
    const list = this.options.listProcessesFn ?? listProcesses;
    const now = await list().catch((): ProcessRow[] => []);
    for (const row of recorded) {
      const still = now.some(
        (current) => current.pid === row.pid && current.args === row.args,
      );
      if (still) {
        // A session leader's pid IS its group id. No direct-kill fallback: the
        // group kill failing means the group is gone, and a bare pid is exactly
        // what must not be guessed at.
        createGroupTerminator({ pid: row.pid, kill: () => false }).terminate();
      }
    }
  }

  /** Map one parsed line of the CLI's stream-json output to normalized events. */
  protected abstract mapMessage(obj: unknown): AgentEvent[];

  /**
   * The full instruction text for one turn: geniro's own preamble about the
   * surface the reply is rendered on, the user's global custom instructions,
   * the member's instructions, then the caller's "May call" block — the last ONLY when
   * this turn actually registered the call tools.
   *
   * This lives on the base because getting it wrong is silent: an agent told
   * to route work through `call_agent` with no such tool registered never runs
   * its callees, and the member still reports success. Each adapter knows its
   * own delivery mechanism, so it passes `granted`; nobody re-derives the
   * join. Adapters deliver the result differently — claude appends it via
   * `--append-system-prompt`, outside the conversation; ACP carries it in the
   * prompt text, and so sends it only when the conversation does not already
   * hold it (`AcpTurnDriver.composePrompt`) — but WHAT the block says is the
   * same for every CLI.
   *
   * That is also why the preamble is added HERE rather than at either call
   * site: this is the one seam both shipped transports already pass through,
   * so a fact about the host reaches every CLI without a per-CLI branch —
   * which `.claude/rules/agent-adapters.md` forbids anyway. The ordering and
   * the reason for it live with the text, in `utils/agent-instructions.ts`.
   *
   * The result is non-empty for every USER-FACING turn, a plain chat included,
   * because the preamble always leads — so an adapter that skips delivery on a
   * blank composition always delivers for those. An `internalProbe` turn is
   * the one case that composes to `''`, which is what keeps the daemon's own
   * capability reads off `--append-system-prompt` entirely.
   */
  protected composeSystemPrompt(
    input: AgentTurnInput,
    granted: boolean,
  ): string {
    return joinTurnInstructionParts(this.turnInstructionParts(input, granted));
  }

  /**
   * The parts {@link composeSystemPrompt} joins, each named by its source —
   * what the team inspector measures, so the sizes it shows are this
   * CLI's real block rather than a copy of the rule.
   */
  turnInstructionParts(
    input: TurnInstructionInput,
    granted: boolean,
  ): TurnInstructionPart[] {
    return turnInstructionParts({
      // An `internalProbe` turn has no transcript for the preamble to describe.
      includePreamble: input.internalProbe !== true,
      backgroundWorkNote: this.getConfig().backgroundWork.agentNote,
      replyLanguage: input.replyLanguage,
      customInstructions: input.customInstructions,
      projectInstructions: input.projectInstructions,
      memoryIndex: granted ? input.memoryIndex : null,
      knowledgeIndex: granted ? input.knowledgeIndex : null,
      taskInstructions: input.taskInstructions,
      teamInstructions: input.teamInstructions,
      instructionBlocks: input.instructionBlocks,
      stageMapPrompt: granted ? input.stageMapPrompt : null,
      systemPrompt: input.systemPrompt,
      characterPrompt: input.characterPrompt,
      answeringACallPrompt: input.answeringACallPrompt,
      callSurfacePrompt: granted ? input.callSurfacePrompt : null,
    });
  }

  /**
   * Payload written to the child's stdin before it is closed. The default —
   * no payload — closes stdin immediately, so a CLI that reads its prompt from
   * argv never blocks waiting on stdin (and an unauthenticated CLI fails fast
   * instead of dropping into an interactive login TTY).
   */
  protected buildStdinPayload(_input: AgentTurnInput): string | undefined {
    return undefined;
  }

  /**
   * How this CLI's own record of the commands it started is read, for the
   * process about to spawn with `env`. Undefined = it keeps none.
   */
  protected commandRecordReader(
    _input: AgentTurnInput,
    _env: Readonly<Record<string, string | undefined>>,
  ): (() => Promise<readonly CommandRecord[]>) | undefined {
    return undefined;
  }

  /**
   * Extra environment merged over the stripped child env. The default passes
   * through the caller's `input.env`; an adapter whose CLI needs a secret
   * re-injects it here for its OWN child only (see `CursorAcpAdapter`).
   */
  protected buildEnv(
    input: AgentTurnInput,
  ): Record<string, string> | undefined {
    return input.env;
  }

  modelConfiguration(model: string | null | undefined): {
    model: string | null;
    args: string[];
    env: Record<string, string>;
  } {
    const name = ollamaModelName(model);
    if (name === null) {
      return { model: model ?? null, args: [], env: {} };
    }
    const config = this.getConfig().ollama;
    if (!config) {
      throw new Error(
        `${this.getConfig().identity.displayName} does not support offline Ollama models.`,
      );
    }
    const url = ollamaBaseUrl();
    const env = { ...config.env };
    for (const key of config.modelEnvKeys ?? []) {
      env[key] = name;
    }
    if (config.baseUrlEnv) {
      env[config.baseUrlEnv] = url;
    }
    const args = [...config.args];
    if (config.baseUrlConfig) {
      const { flag, key, suffix } = config.baseUrlConfig;
      args.push(flag, `${key}=${JSON.stringify(url + suffix)}`);
    }
    if (config.envSettingsFlag) {
      args.push(config.envSettingsFlag, JSON.stringify({ env }));
    }
    return { model: name, args, env };
  }

  async validateModel(model: string | null | undefined): Promise<void> {
    this.modelConfiguration(model);
    await validateOllamaModel(model);
  }

  /**
   * Whichever of this CLI's {@link AdapterConfig.auth.inheritedEnvKeys} the
   * daemon itself actually has — the credentials `buildChildEnv` strips from
   * every child, put back for the one entitled to them.
   *
   * CONCRETE over config, with no overrides, because the entitlement is data and
   * this is the ONE place that reads it. That is what keeps the turn path and the
   * utility path from disagreeing again: they call this, not their own copies.
   * See the field's own doc for the divergence it replaced.
   */
  protected inheritedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of this.getConfig().auth.inheritedEnvKeys) {
      const value = process.env[key];
      if (value) {
        env[key] = value;
      }
    }
    return env;
  }

  /**
   * Every charge this CLI's ACCOUNT reports for the asked-about conversations
   * over a window, AS IT STANDS NOW — the one mechanism behind
   * `AdapterConfig.usage.polledSpend`, called by `PolledSpendService` on its
   * own cadence, never per turn.
   *
   * Events rather than sums, and nothing filtered by what an earlier poll saw:
   * a vendor revises an event's charge after listing it, so deciding what is
   * new is the caller's job, keyed by {@link AccountSpendEvent.key}.
   *
   * Null means the ask failed — a refused or unreadable reply, no network —
   * and {@link ACCOUNT_SIGNED_OUT} that the account has no login to ask with;
   * the caller reads both as "no cost reported", never as an error. Null is
   * also the default: a CLI whose turns price themselves has nothing to poll.
   */
  fetchAccountSpend(
    _query: AccountSpendQuery,
  ): Promise<AccountSpendReply | typeof ACCOUNT_SIGNED_OUT | null> {
    return Promise.resolve(null);
  }

  /**
   * The conversations each of these spawned that the account bills SEPARATELY
   * — keyed by the spawning conversation's id, children in the order found.
   *
   * A polled account files a delegate's charges under the delegate's own
   * conversation, which no turn ever names: without this, every sub-agent a
   * conversation launched was billed to the user and to nobody here. Measured
   * 2026-10-05 on a real Cursor account: $1,855 of $4,017 in thirty days went to
   * 1,013 delegate conversations geniro had never heard of.
   *
   * The default answers nothing: a CLI whose turns price themselves bills its
   * delegates inside the parent's own figure. Never throws — a parent whose
   * record cannot be read simply contributes no children.
   */
  spawnedConversations(
    _conversationIds: readonly string[],
  ): Promise<Map<string, string[]>> {
    return Promise.resolve(new Map());
  }

  /**
   * One of this CLI's own {@link AdapterConfig.options} for a turn: what the
   * run snapshotted, else the option's declared default.
   *
   * Throws on an id this CLI does not declare. That can only be a typo in the
   * adapter, and answering `false` for it would switch a feature off with
   * nothing anywhere saying why.
   */
  protected agentOption(input: AgentTurnInput, id: string): boolean {
    const { kind, options } = this.getConfig();
    const spec = options.find((option) => option.id === id);
    if (spec === undefined) {
      throw new Error(`${kind} declares no option '${id}'`);
    }
    return input.agentOptions?.[id] ?? spec.defaultValue;
  }

  /**
   * Whether the child's stdin stays open past the payload for a mid-turn
   * dialogue. Default false (stdin closes immediately); the Claude adapter
   * returns true for every turn spawned on its permission dialogue. A process
   * spawned without it is never re-moded between turns (`startSession`).
   */
  protected keepStdinOpen(_input: AgentTurnInput): boolean {
    return false;
  }

  /**
   * Encode one approval verdict as the stdin line the CLI expects. Default
   * undefined — no approval protocol; `respondApproval` is then a no-op.
   */
  /**
   * Build this turn's protocol driver. The default is stateless — it forwards
   * each line to {@link mapMessage} and each verdict to
   * {@link buildApprovalResponse}, which is the whole protocol for a one-shot
   * stream-json CLI. Override when the CLI speaks a stateful, bidirectional
   * protocol whose state must be per-turn (see `AcpTurnDriver`): one adapter
   * instance drives N concurrent turns under team fan-out, so that state can
   * never live on the adapter itself.
   */
  protected createTurnDriver(_input: AgentTurnInput): TurnDriver {
    return {
      onMessage: (obj) => this.mapMessage(obj),
      buildApprovalResponse: (id, allow, updatedInput, option) =>
        this.buildApprovalResponse(id, allow, updatedInput, option),
    };
  }

  protected buildApprovalResponse(
    _id: string,
    _allow: boolean,
    _updatedInput?: unknown,
    _option?: ApprovalOption,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode a mid-turn approval-mode change for a turn THIS adapter spawned,
   * or undefined when that turn cannot be re-moded.
   *
   * Takes the turn's own `input` rather than being a per-CLI constant, because
   * the answer is per-TURN: claude can be re-moded on the stdio permission
   * dialogue, but a turn it spawned under `--dangerously-skip-permissions` has
   * no prompt tool wired, and no message can reintroduce a gate the process
   * was started without. Stateless by construction — a pure function of
   * (input, mode) — so it stays on the adapter while genuine protocol state
   * lives on the per-turn driver.
   *
   * The default is the "this CLI cannot be told" answer, which is the honest
   * one for ACP: `session/set_mode` is a session-level call, not something the
   * protocol accepts against a prompt already in flight.
   */
  protected buildApprovalModePayload(
    _input: AgentTurnInput,
    _mode: AgentApprovalMode,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode a user message sent while the turn is STILL RUNNING, as the stdin
   * line this CLI expects. Default undefined — "this CLI cannot be told
   * anything more once its prompt is in", which makes
   * `AgentTurnHandle.sendUserMessage` return false and leaves the caller to
   * queue the message for the next turn.
   *
   * It is a MECHANISM rather than a config value: the payload is this CLI's
   * own wire shape, the same reason `buildApprovalResponse` is a method. An
   * adapter that overrides it must also keep stdin open for the turn
   * (`keepStdinOpen`), or the line has nowhere to go.
   */
  protected buildFollowUpPayload(
    _message: FollowUpMessage,
  ): string | undefined {
    return undefined;
  }

  /**
   * Whether a process spawned for this turn should be KEPT so the run's next
   * turn can use it, instead of dying with the turn.
   *
   * The spawn-time question, asked once; {@link buildNextTurnPayload} is the
   * per-turn mechanism that then opens each subsequent turn. Default false —
   * "this CLI needs a fresh process per turn", which is what every adapter
   * did before run-scoped sessions and remains correct for any CLI whose
   * stdin cannot carry a second prompt.
   *
   * An adapter answering true MUST also keep stdin open for the whole session
   * and implement `buildNextTurnPayload`, or the process is kept alive with no
   * way to ever talk to it again.
   */
  protected canHostSession(_input: AgentTurnInput): boolean {
    return false;
  }

  /**
   * Encode the payload that opens ANOTHER turn on a process that has already
   * finished one. Undefined = there is no such payload and the caller must
   * spawn afresh.
   *
   * Deliberately NOT the same hook as {@link buildFollowUpPayload}, even where
   * one CLI's bytes happen to be identical: that one adds to a prompt already
   * in flight, this one starts the next prompt. The two come apart on the very
   * next transport — ACP HAS a next prompt (`session/prompt` again on the same
   * session) and has no way at all to add to one already accepted — so
   * collapsing them would make that adapter unimplementable without an
   * untangle.
   */
  protected buildNextTurnPayload(
    _message: FollowUpMessage,
  ): string | undefined {
    return undefined;
  }

  /**
   * Encode an in-protocol "stop the current turn" for this CLI. Undefined =
   * this CLI has no such message and can only be stopped by killing it.
   *
   * Only reached on a run-scoped session, where the difference is the whole
   * point: killing the group takes the user's MCP servers — and a browser one
   * of them owns — down with a turn they only meant to stop.
   */
  protected buildInterruptPayload(_input: AgentTurnInput): string | undefined {
    return undefined;
  }

  /**
   * The fingerprint of everything this turn baked into the child's argv and
   * env. Two turns with the same key can share one process; a change means
   * the running process cannot serve the new turn and must be replaced.
   *
   * Concrete on the base rather than per-adapter: it is composed of the INPUT
   * fields a `buildArgs` can read, not of any one CLI's flags, so an adapter
   * that starts reading a new field is the only reason to override it.
   *
   * Four fields are deliberately absent:
   *
   * - `prompt` / `images` — per-turn by definition; they ride stdin, not argv.
   * - `resumeSessionId` — a continued turn must NOT resume, because the
   *   process already holds the session. Keying on it would make every second
   *   turn look like a different process.
   * - `approvalMode` — a live process is RE-MODED rather than respawned, so a
   *   change here is delivered on the way into the next turn (see
   *   `startSession`'s `startTurn`, which is what makes this omission safe);
   *   the session falls back to a respawn only when the running process
   *   refuses, which is the honest signal that it was spawned in a shape no
   *   message can change.
   */
  protected sessionKey(input: AgentTurnInput): string {
    return JSON.stringify([
      this.getConfig().kind,
      this.command,
      input.cwd,
      input.model ?? null,
      this.modelConfiguration(input.model),
      input.effort ?? null,
      input.systemPrompt ?? null,
      input.characterPrompt ?? null,
      // Baked into the same composed block as `systemPrompt`, so it is argv
      // for claude and prompt text for ACP either way — a process spawned
      // under one user's instruction set cannot serve a turn that carries
      // another. Omitting it would let two runs with different instructions
      // share one CLI process, and the second would silently run on the
      // first's.
      input.customInstructions ?? null,
      // The same block again, snapshotted on the run: editing the project
      // restarts nothing.
      input.projectInstructions ?? null,
      // The same block again, and argv on claude besides.
      input.replyLanguage ?? null,
      // The same block again; snapshotted on the run, so a note saved while
      // the run works restarts nothing.
      input.memoryIndex ?? null,
      // Likewise: a document saved while the run works restarts nothing.
      input.knowledgeIndex ?? null,
      // Env on claude and thread config on codex, both fixed at spawn.
      input.nativeMemoryOff === true,
      // The same block again: a card whose label instructions changed since
      // this process was spawned must not be served by it.
      input.taskInstructions ?? null,
      // The same block again, and the same rule: a process spawned to edit one
      // team file must not serve a turn pointed at another.
      input.teamInstructions ?? null,
      // On the same composed block and the same reasoning: two team members
      // given different instruction blocks must not share a process.
      input.instructionBlocks ?? null,
      // Static per run (the snapshot's stages), so it restarts nothing.
      input.stageMapPrompt ?? null,
      input.answeringACallPrompt ?? null,
      input.callSurfacePrompt ?? null,
      // Decides whether the host preamble is composed, so it is argv too. No
      // internal probe uses a kept session today (they all call `start()`),
      // which is exactly why it belongs here now rather than after the first
      // one does — a probe served by a user turn's process would otherwise
      // silently inherit the preamble this flag exists to withhold.
      input.internalProbe === true,
      input.configDir ?? null,
      input.streamPartials === true,
      input.allowUserQuestions === true,
      input.trustWorkspace === true,
      // Read by `buildArgs`, so it is argv, so it belongs here — a turn that
      // isolated its MCP set cannot be served by a process spawned without
      // that restriction, or the reverse.
      input.isolateMcpServers === true,
      input.readOnly === true,
      // Applied at spawn by every CLI that honours it (argv, a thread config,
      // a per-turn data directory), so a process started with one set cannot
      // serve a turn that switched off another. Sorted and de-duplicated: the
      // ORDER a member lists them in is not a different set.
      [...new Set(input.mcpDisabled ?? [])].sort(),
      input.mcpEndpoint?.url ?? null,
      input.env ?? null,
      // Argv too (`autoCompactArgs`), and on a KEPT process it is the one field
      // here that moves on its own: the window is learned from the turn that
      // just settled, so a conversation's first flagged turn asks for something
      // the live process was never spawned with. Omitting it would mean the
      // threshold silently never applied to the chat that had already started.
      this.autoCompactArgs(input).join(' '),
    ]);
  }

  /**
   * The argv that tells this CLI to compact itself at the turn's threshold, or
   * nothing when it has no such control or this turn named no threshold.
   *
   * ONE implementation on the base rather than one per adapter: the rule
   * ("ask for the window whose buffer lands the CLI on our threshold") is
   * geniro's, while the flag, the buffer and the bounds are the CLI's and live
   * in its {@link AdapterConfig.autoCompact}.
   */
  protected autoCompactArgs(input: AgentTurnInput): string[] {
    const config = this.getConfig().autoCompact;
    const wanted = input.autoCompact;
    if (config.kind === 'unavailable' || !wanted) {
      return [];
    }
    const { percent, windowTokens } = wanted;
    if (
      !Number.isFinite(percent) ||
      !Number.isFinite(windowTokens) ||
      percent <= 0 ||
      windowTokens <= 0
    ) {
      return [];
    }
    if (config.kind === 'config-override') {
      const threshold = Math.round((windowTokens * percent) / 100);
      return threshold < config.minTokens
        ? []
        : [config.flag, `${config.key}=${threshold}`];
    }
    // The ceiling is the MODEL's window as well as the CLI's own: a window
    // larger than the model has is clamped by the CLI anyway, and the highest
    // threshold anyone can ask for is one buffer short of it.
    const ceiling = Math.min(config.maxTokens, windowTokens);
    if (ceiling < config.minTokens) {
      // A window smaller than the smallest figure this CLI accepts. The flag
      // would be REFUSED and the turn would fail to spawn over a setting, so
      // the threshold goes unexpressed here and geniro's between-turn rule
      // stays the only one — which is what a CLI with no control at all gets.
      return [];
    }
    const threshold = Math.round((windowTokens * percent) / 100);
    // The floor is the CLI's — below it the flag is refused outright, so a
    // threshold that low is raised to the lowest one this CLI can hold rather
    // than dropped.
    const effective = Math.min(
      Math.max(threshold + config.summaryBufferTokens, config.minTokens),
      ceiling,
    );
    return [config.flag, String(Math.round(effective))];
  }

  /**
   * Materialize turn-scoped resources BEFORE the spawn; the returned disposer
   * runs when the turn settles (any path). Default: nothing. The Claude
   * adapter writes its per-turn MCP config file here so `buildArgs` can
   * reference the path while the call token stays out of argv.
   */
  protected prepareTurn(_input: AgentTurnInput): (() => void) | undefined {
    return undefined;
  }

  /**
   * What this CLI says its context window currently holds, or null when it has
   * no way to say.
   *
   * PUBLIC, and a method with one implementation per adapter — the mechanism is
   * deliberately not presupposed. Two earlier drafts of this seam each baked in
   * one CLI's shape and would have made the other unimplementable: asking the
   * adapter for a request LINE assumed the answer comes back over stdin (it is
   * claude's shape), and hanging it off the live session assumed a process
   * exists to ask (cursor's does not outlive its turn — its figures are on
   * disk). {@link AgentSessionReadInput} therefore offers BOTH channels and
   * each adapter takes what it needs.
   *
   * The VALUE half is `AdapterConfig.usage.breakdown` — its `.reason` when this
   * returns null, its `.channel` when it doesn't. The two must agree, and
   * `agent-adapter.spec.ts` pins that they do.
   */
  readContextUsage(
    _input: AgentSessionReadInput,
  ): Promise<AgentContextUsage | null> {
    return Promise.resolve(null);
  }

  /**
   * The name this CLI gave the conversation itself, or null when it names none.
   *
   * The agent's OWN title, never one geniro composed — that is the whole value,
   * since a model that just read the exchange can say "Fix conflicts worktree"
   * where the host can only trim the user's opening line. A null is therefore an
   * ordinary answer rather than a failure: `ChatTitleService` falls back to the
   * derived title, so nothing about the run depends on a CLI having one.
   *
   * Takes the session ID alone, unlike {@link readContextUsage}'s two channels:
   * a title is written where a conversation is STORED, and neither shipped CLI
   * has a way to be asked for one over a live process — claude does not write a
   * title headlessly at all, and cursor holds no process between turns.
   *
   * Deliberately NOT paired with an `AdapterConfig` reason field: that field
   * exists to give a user-visible absence its sentence, and the derived fallback
   * means this absence never reaches a surface.
   */
  readSessionTitle(_sessionId: string): Promise<string | null> {
    return Promise.resolve(null);
  }

  /**
   * ASK this CLI to name the conversation, for one that writes no title of its
   * own — the other half of {@link readSessionTitle}, and the one that costs
   * something.
   *
   * Two methods rather than one because the two are not the same act: reading
   * is free and can be done on every settled turn, while asking spawns a model
   * call and is billed to the user. So this is not a fallback the base can
   * apply for a CLI: an adapter opts in by overriding, and the caller is
   * responsible for asking at most once per conversation.
   *
   * It exists because the alternative on claude is no LLM title at all —
   * headless claude writes none anywhere on disk (see `ClaudeAdapter`'s class
   * doc), so a chat opened with a pasted URL was named after that URL for good.
   * REPORTED as exactly that.
   *
   * The turn it runs must be SEPARATE from the user's conversation and must not
   * touch it: naming is geniro's business, and a question appended to the
   * user's own session would show up in their transcript and in their context
   * window. Compose the question with `titlePrompt` rather than writing one —
   * the wording is where the quality lives and two copies of it will drift.
   *
   * Never throws. A null is the ordinary answer for "this CLI cannot", "the
   * model refused" and "the reply could not be read" alike, because all three
   * leave the derived title standing and the user sees no difference.
   */
  generateTitle(
    _input: AgentTitleInput,
    _options: AgentCommandOptions = {},
  ): Promise<string | null> {
    return Promise.resolve(null);
  }

  /**
   * Put one question to this CLI on a throwaway turn of its own, apart from
   * every conversation, and answer its reply text; null for a CLI that cannot
   * (`AdapterConfig.oneShotAskUnavailableReason`), a failed turn or an
   * unreadable reply. Billed to the profile asked under. Never throws.
   */
  askOnce(
    _input: AgentAskInput,
    _options: AgentCommandOptions = {},
  ): Promise<string | null> {
    return Promise.resolve(null);
  }

  /**
   * What the ACCOUNT behind this run is allowed — the plan's rate-limit
   * windows and how much of each is spent — or null when this CLI has no way
   * to say.
   *
   * A sibling of {@link readContextUsage} rather than part of it, because the
   * two describe different things: one is this conversation's window, the other
   * is the subscription every conversation on that account shares. They happen
   * to travel the same channels, which is why they take the same input, and
   * they are asked together so a panel cannot show one from a moment the other
   * does not describe.
   *
   * The VALUE half is `AdapterConfig.usage.planLimits` — its `.reason` when
   * this returns null, its `.channel` when it doesn't. The two must agree, and
   * `agent-adapter.spec.ts` pins that they do. {@link NO_PLAN_LIMITS} is an
   * ANSWER — the account has none — and never stands in for an absent channel.
   */
  readPlanLimits(
    _input: AgentSessionReadInput,
  ): Promise<AgentPlanLimits | typeof NO_PLAN_LIMITS | null> {
    return Promise.resolve(null);
  }

  /**
   * Which config directory this FOLDER pins for this CLI, overriding the one
   * geniro hands it — or null when nothing does.
   *
   * The default is null for every folder, which is also the honest answer for a
   * CLI that reads no per-project settings: nothing pins anything, so the
   * profile the run names is the profile the turn runs under. An adapter whose
   * CLI CAN be overridden this way must say so, because the alternative is the
   * app stating an account the agent is not on — see {@link ConfigDirPin} for
   * the report and the measurement.
   *
   * SYNCHRONOUS and never throwing: it is a small file read on a path the
   * caller already holds, consulted while projecting a run row, and an
   * unreadable or malformed settings file means "nothing is pinned" rather than
   * a failed request.
   */
  readConfigDirPin(_cwd: string): ConfigDirPin | null {
    return null;
  }

  /**
   * Open a CLI process for this run and return the session that owns it.
   *
   * The single spawn path. A CLI that answers false to {@link canHostSession}
   * yields a session serving exactly one turn — which is what every caller got
   * before run-scoped sessions existed, reached now through the same code
   * rather than a branch.
   *
   * **The caller owns the process.** Nothing here reaps a run-scoped session;
   * it lives until someone calls `close()`. That is why `runScoped` is the
   * CALLER's opt-in and not the adapter's decision alone: `canHostSession`
   * answers whether this CLI *can* be kept, while only a caller holding a run
   * to keep it for can answer whether it *should* be — and a caller with
   * nowhere to store the session would otherwise leak a process per turn.
   */
  startSession(
    input: AgentTurnInput,
    opts: {
      runScoped?: boolean;
      betweenTurnApproval?: BetweenTurnApproval | undefined;
      onBetweenTurnEvent?: (event: AgentEvent) => void;
      onHeldApproval?: CliSessionOptions['onHeldApproval'];
      /**
       * The run tag (`runTagEnv`) this process is stamped with, so everything
       * it starts — detached or not — can be attributed to its run and stopped
       * when the run is archived or deleted.
       */
      runTag?: Readonly<Record<string, string>>;
    } = {},
  ): AgentSession {
    const runScoped = opts.runScoped === true && this.canHostSession(input);
    // Turn-scoped resources become SESSION-scoped once the process outlives
    // the turn: claude's `--mcp-config` file is named in argv, so it has to
    // outlive every turn that argv serves. For a one-turn session the two are
    // the same moment (the process ends with the turn), so this is not a
    // behaviour change for any existing caller.
    const dispose = this.prepareTurn(input);
    const key = this.sessionKey(input);
    // The mode this process was SPAWNED with, tracked because `sessionKey`
    // deliberately omits it: the mode is baked into argv, so a later turn
    // asking for a different one is served by re-moding the live process
    // rather than replacing it. Without this the key's omission would mean the
    // new mode is simply never applied — the run row and the chip would both
    // read a posture the CLI was never told about.
    let spawnedMode = input.approvalMode;
    // Whether the process holds the stdin permission dialogue at all. One that
    // does not (claude under --dangerously-skip-permissions) has no prompt
    // tool, so no message can re-mode it into asking — a turn wanting another
    // mode has to be served by a fresh spawn.
    const spawnedOnDialogue = this.keepStdinOpen(input);
    // The DIRECTORY this process was spawned in, not its path — see the
    // refusal in `startTurn` below.
    const spawnedCwd = directoryIdentity(input.cwd);
    let session: CliSession;
    let driver: TurnDriver;
    let rememberRecovery = (events: AgentEvent[]): AgentEvent[] => events;
    try {
      // Resolved once, INSIDE the try: `command` re-reads the binary override
      // per access, and a `buildArgs` throw must still reach the disposer
      // below — hoisting either one out would leak the session-scoped resource.
      const command = this.command;
      const local = this.modelConfiguration(input.model);
      // The model's own args FIRST: an adapter's `buildArgs` may emit a flag
      // that supersedes one of them (claude's `--settings` does).
      const args = [...local.args, ...this.buildArgs(input)];
      driver = this.createTurnDriver(input);
      let recoverySessionId = input.resumeSessionId ?? null;
      const recoveryRefs = new Map<string, SubagentRecoveryRef>();
      const recoveryDisabled = new Set<string>();
      rememberRecovery = (events: AgentEvent[]): AgentEvent[] => {
        const mapped: AgentEvent[] = [];
        for (const event of events) {
          if (event.type === 'session') {
            recoverySessionId = event.sessionId;
          }
          if (event.type === 'subagent_info' && event.recovery === null) {
            recoveryDisabled.add(event.id);
          }
          const id =
            event.type === 'subagent_info'
              ? event.id
              : event.type === 'background_work' &&
                  event.phase === 'started' &&
                  event.unit === 'agent'
                ? event.toolCallId
                : null;
          if (
            id === null ||
            recoverySessionId === null ||
            recoveryDisabled.has(id)
          ) {
            mapped.push(event);
            continue;
          }
          const previous = recoveryRefs.get(id);
          const ref: SubagentRecoveryRef = {
            agentKind: this.getConfig().kind,
            sessionId: recoverySessionId,
            cwd: input.cwd,
            configDir: input.configDir ?? null,
            toolCallId: id,
            launchedAtMs:
              event.type === 'background_work'
                ? Date.now()
                : (previous?.launchedAtMs ?? Date.now()),
            childSessionId:
              event.type === 'subagent_info'
                ? (event.subagentSessionId ?? previous?.childSessionId ?? null)
                : (previous?.childSessionId ?? null),
          };
          recoveryRefs.set(id, ref);
          if (event.type === 'subagent_info') {
            mapped.push({ ...event, recovery: ref });
          } else {
            // Foreground work can lose its stream before its launching call returns.
            mapped.push(event, delegateDeclarationEvent(id, { recovery: ref }));
          }
        }
        return mapped;
      };
      // The run tag last: no adapter's `buildEnv` and no caller's `input.env`
      // may replace the id the run's teardown searches for.
      const env = {
        ...this.buildEnv(input),
        ...local.env,
        ...opts.runTag,
      };
      session = runCliSession({
        command,
        args,
        cwd: input.cwd,
        env,
        stdinLifetime: runScoped
          ? 'session'
          : this.keepStdinOpen(input)
            ? 'turn'
            : 'payload',
        mapper: (obj) => rememberRecovery(driver.onMessage(obj)),
        onDroppedLine: driver.onDroppedLine
          ? (prefix, length) =>
              rememberRecovery(driver.onDroppedLine!(prefix, length))
          : undefined,
        spawn: this.options.spawn,
        logger: this.options.logger,
        questionToolName: this.getConfig().questionToolName,
        // A CONFIG fact, read here so no consumer of this base ever asks which
        // CLI it is talking to — the rule every field beside it follows.
        detectDetachedShells:
          this.getConfig().shells.unreportedDetachReason !== null,
        silentCommandWait: this.getConfig().shells.silentWaitReason !== null,
        readCommandRecords: this.commandRecordReader(input, env),
        listProcessGroups: this.options.listProcessGroupsFn,
        // Passed straight through: what to answer between turns depends on the
        // run's approval posture, which the CALLER holds — an adapter deciding
        // it here would be a third copy of approval semantics that already
        // live in the chat service and the team executor.
        betweenTurnApproval: opts.betweenTurnApproval,
        onBetweenTurnEvent: opts.onBetweenTurnEvent
          ? (event) => {
              for (const mapped of rememberRecovery([event])) {
                opts.onBetweenTurnEvent!(
                  qualifyOllamaEvent(mapped, input.model),
                );
              }
            }
          : undefined,
        // Same passthrough and the same reason: whether a request the posture
        // will not decide can be put in front of the user depends on the owner
        // having somewhere to draw a card, which no adapter can know.
        onHeldApproval: opts.onHeldApproval,
      });
    } catch (err) {
      // A synchronous throw between prepareTurn and a live session (a bad
      // argv) would otherwise leak the session-scoped resource — the disposer
      // only rides `closed`, which never arrives here. Its own failure must
      // not mask the original error.
      this.runDisposer(dispose);
      throw err;
    }
    if (dispose) {
      // `closed` never rejects, so one callback covers every exit path. The
      // disposer itself may throw (an rmSync EACCES) — that's cleanup failure
      // to log, not an unhandled rejection.
      void session.closed.then(() => this.runDisposer(dispose));
    }

    let firstTurnTaken = false;
    return {
      // The out-of-band question channel, forwarded as-is: an adapter that
      // answers from its running process reaches it through here.
      ask: (request) => session.ask(request),
      startTurn: (turnInput, onEvent) => {
        // A turn needing different argv cannot run on this process, whatever
        // its stdin can carry. Checked before anything is written, so the
        // caller gets the same null it gets for a dead session.
        if (firstTurnTaken && this.sessionKey(turnInput) !== key) {
          return null;
        }
        // Nor on a process whose working directory was removed under it — a
        // task's worktree, collected once its card is Done and then cut again
        // at the SAME path when the chat is continued. The key above cannot
        // see that (the path is unchanged), but the process still sits in the
        // deleted directory: codex's app-server answered every turn there with
        // `invalid cwd: No such file or directory (os error 2)` in 2ms.
        // REPORTED as a continued task chat that the worktree restore could not
        // rescue. A fresh spawn starts in the directory that exists now, and
        // the conversation survives it the way it survives any respawn.
        if (firstTurnTaken && directoryIdentity(turnInput.cwd) !== spawnedCwd) {
          return null;
        }
        // Nor on a process that holds nothing a turn could run on — a stateful
        // protocol whose handshake failed (`TurnDriver.canOpenTurn`). The same
        // null the caller already reads as "spawn a fresh one"; answered here,
        // before anything is written, rather than by a turn that opens and then
        // sits silent until the deadline.
        if (firstTurnTaken && driver.canOpenTurn?.() === false) {
          return null;
        }
        // The opening payload differs by position, not by content: the FIRST
        // turn's rides the spawn (or is written by a driver that opens its own
        // conversation), while a later one has to say "here is the next
        // prompt" on a stdin that is already mid-conversation.
        const stdinPayload = firstTurnTaken
          ? this.buildNextTurnPayload({
              text: turnInput.prompt,
              images: turnInput.images,
            })
          : this.buildStdinPayload(turnInput);
        // A stateful protocol has no stdin payload at all — its "here is the
        // next prompt" is a frame only the driver can build and record — so it
        // opens the turn itself through `TurnDriver.openTurn`. Without that
        // hook this refusal is what confines such a CLI to one turn per
        // process, which is exactly what killed a cursor turn's backgrounded
        // sub-agents at the exit grace.
        const driverOpensTurn =
          firstTurnTaken &&
          stdinPayload === undefined &&
          driver.openTurn !== undefined;
        if (firstTurnTaken && stdinPayload === undefined && !driverOpensTurn) {
          return null;
        }
        // The approval mode is argv, and argv belongs to the spawn — so a turn
        // wanting a different one has to say so before its prompt, or the CLI
        // runs it under the posture the PREVIOUS turn was started with. That is
        // a safety property, not a preference: a chat switched from
        // `acceptEdits` back to `ask` between turns would go on editing files
        // without raising a single permission request, while both the chip and
        // the persisted run row read `ask`.
        //
        // Returning null when the CLI has no such message is the honest answer
        // and the one the registry already handles — it closes the session and
        // respawns, which puts the mode back in argv where it started.
        let modeLine = '';
        // Skipped entirely for a driver that opens its own turn: on such a
        // protocol the mode is a FRAME rather than argv, so the driver applies
        // it from this turn's own input (`AcpTurnDriver.beginTurn`) and there is
        // no stdin line for the adapter to hand over. Asking for one anyway
        // would refuse the turn — and close and respawn the session — over a
        // change the CLI can be told about without either.
        if (
          !driverOpensTurn &&
          firstTurnTaken &&
          turnInput.approvalMode !== spawnedMode
        ) {
          if (turnInput.approvalMode === undefined || !spawnedOnDialogue) {
            // "No mode at all" is the CLI's own default, which no message can
            // ask a running process to return to; nor can one spawned without
            // the dialogue be given it.
            return null;
          }
          const line = this.buildApprovalModePayload(
            turnInput,
            turnInput.approvalMode,
          );
          if (line === undefined) {
            return null;
          }
          modeLine = line;
        }
        const handle = session.startTurn({
          // Both are newline-delimited lines on the one stdin conversation, so
          // prepending is what puts the mode change strictly ahead of the
          // prompt it has to govern. `stdinPayload` is always defined where a
          // mode line exists — a continued turn with none returned null above.
          stdinPayload: modeLine
            ? `${modeLine}${stdinPayload ?? ''}`
            : stdinPayload,
          buildApprovalResponse: (id, allow, updatedInput, option) =>
            driver.buildApprovalResponse?.(id, allow, updatedInput, option),
          buildFollowUpPayload: (message) => this.buildFollowUpPayload(message),
          followUpConsumptionReported:
            this.getConfig().followUp.consumptionReported,
          promptText: turnInput.prompt,
          // A driver that owns the channel wins over the adapter's payload
          // builder — the two are alternatives, not a pair, and `sendUserMessage`
          // consults this one first. Bound only when the driver defines it, so
          // a CLI without one keeps the stdin-line path untouched.
          sendFollowUp: driver.sendFollowUp
            ? (message) => driver.sendFollowUp!(message)
            : undefined,
          subagentsAFollowUpCancels: () =>
            driver.subagentsAFollowUpCancels?.() ?? 0,
          buildApprovalModePayload: (mode) => {
            const line = this.buildApprovalModePayload(turnInput, mode);
            if (line !== undefined) {
              // The MID-TURN re-mode goes through here (`ChatService`'s live
              // apply), and it changes the same process state the between-turns
              // delivery above compares against. Without this the process is
              // left holding `mode` while `spawnedMode` still reads whatever it
              // was spawned with — so a later turn asking for that older mode
              // sees "no change" and sends nothing, and the CLI keeps the
              // mid-turn one. Switching to `acceptEdits` mid-turn and back to
              // `ask` afterwards would then run the next turn un-gated with
              // the chip and the run row both reading `ask`.
              spawnedMode = mode;
            }
            return line;
          },
          // The driver's own frame wins over the adapter's line, on
          // `sendFollowUp`'s reasoning: a stop that names a session id cannot be
          // built outside the driver. A driver without one, or one that answers
          // undefined, falls back to the adapter exactly as before.
          buildInterruptPayload: driver.buildInterruptPayload
            ? () =>
                driver.buildInterruptPayload!() ??
                this.buildInterruptPayload(turnInput)
            : () => this.buildInterruptPayload(turnInput),
          // Asked ahead of the interrupt: a prompt the DRIVER still holds has
          // reached no CLI, so there is nothing for an interrupt to stop.
          withdrawPrompt: driver.withdrawHeldPrompt
            ? () => driver.withdrawHeldPrompt!()
            : undefined,
          onProcessEnded: driver.onProcessEnded
            ? () => driver.onProcessEnded!()
            : undefined,
          onQuiet: driver.onQuiet ? () => driver.onQuiet!() : undefined,
          closeGraceMs: driver.closeGraceMs
            ? () => driver.closeGraceMs!()
            : undefined,
          // Both are FIRST-turn only, and for the same reason: a handshake and
          // a readiness wait belong to the PROCESS, not to each prompt. By the
          // second turn the CLI has been up for a whole turn's worth of time,
          // so re-asking would be a delay that could never find anything.
          holdPrompt: firstTurnTaken
            ? undefined
            : driver.awaitPromptReady?.bind(driver),
          // Which is also why a LATER turn's opening runs through a different
          // hook: the handshake is done, and what this turn needs is its own
          // settings and its own prompt on the session that handshake made.
          onStdinReady: driverOpensTurn
            ? (io) => driver.openTurn!(io, turnInput)
            : firstTurnTaken
              ? undefined
              : (io) => driver.onStdinReady?.(io),
          // The mappers are pure module-scope functions, so a control message
          // an adapter does not model comes back as data and is logged HERE —
          // the one caller of `mapMessage`, rather than once per consumer. It
          // is diagnostic, so it stops here and never reaches the turn.
          onEvent: (event) => {
            if (event.type === 'unhandled_control') {
              this.options.logger?.warn(
                `${this.getConfig().kind}: unmodelled control_request subtype '${event.subtype}' — dropped`,
              );
              return;
            }
            if (event.type === 'error' && event.recovery === undefined) {
              // Stamped HERE because this is the one seam every error event of
              // every adapter passes through — a mapper, a driver, a non-zero
              // exit and a stderr tail all arrive as one. Classifying at each
              // producer instead would leave whichever one was missed as the
              // only failure with no way out of it.
              onEvent({
                ...event,
                recovery: this.errorRecovery(event.message) ?? undefined,
              });
              return;
            }
            for (const mapped of rememberRecovery([event])) {
              onEvent(qualifyOllamaEvent(mapped, turnInput.model));
            }
          },
        });
        if (handle) {
          firstTurnTaken = true;
          // Only once the write actually went out: a refused turn leaves the
          // process on the mode it still has, and recording the new one here
          // would make the NEXT turn skip a delivery that never happened.
          spawnedMode = turnInput.approvalMode;
        }
        return handle;
      },
      get idle() {
        // A one-turn session is never idle again once its turn has been taken:
        // the process is alive only until that turn ends, and offering it as
        // reusable would have the caller wait for a turn it can never open.
        return session.idle && (runScoped || !firstTurnTaken);
      },
      get alive() {
        return session.alive;
      },
      get retired() {
        // Forwarded, not recomputed: the state lives in the process wrapper
        // (a cancelled turn may still be printing), and the registry's eviction
        // scan is the reader. A wrapper that dropped it would leave that scan
        // treating an unusable process as the freshest reusable one.
        //
        // Plus the one unusable state the wrapper cannot see: an idle process
        // whose driver holds nothing a turn could run on (see `canOpenTurn`
        // above). Idle only — mid-handshake the answer is still being decided —
        // and only past the first turn, which is the turn that learned it.
        return (
          session.retired ||
          (firstTurnTaken && session.idle && driver.canOpenTurn?.() === false)
        );
      },
      get parked() {
        // Forwarded for the same reason `retired` is: the buffers holding the
        // unanswered requests live in the process wrapper, and the reader is
        // the registry's reaper.
        return session.parked;
      },
      get pid() {
        return session.pid;
      },
      subagentRecoveryBlocked: (id) =>
        session.subagentRecoveryBlocked?.(id) ?? false,
      get shellsRunning() {
        // Forwarded for the reapers too: the set of detached commands lives in
        // the process wrapper, and a wrapper that dropped it would read as none
        // — reaping the process that serves a dev server.
        return session.shellsRunning;
      },
      get detachedRunning() {
        return session.detachedRunning;
      },
      recordedGroupsOf: (callId) => session.recordedGroupsOf(callId),
      get runningCommands() {
        return session.runningCommands;
      },
      get endedRunning() {
        return session.endedRunning;
      },
      close: (cause, options) => session.close(cause, options),
      noteCloseCause: (cause) => session.noteCloseCause?.(cause),
      get closeCause() {
        return session.closeCause ?? null;
      },
      closed: session.closed,
    };
  }

  /**
   * Start a turn on its own process — the one-shot form, for a caller with no
   * run to keep a session for. Events are delivered to `onEvent` in stream
   * order; the returned handle settles via `done` and can `cancel` the turn.
   */
  start(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle {
    const handle = this.startSession(input).startTurn(input, onEvent);
    // A fresh session always accepts its first turn; a spawn failure comes
    // back as a settled handle carrying an `error` event, not as null.
    if (!handle) {
      throw new Error(`failed to open a turn on ${this.command}`);
    }
    return handle;
  }

  /** Run a session's cleanup, logging rather than throwing on its failure. */
  private runDisposer(dispose: (() => void) | undefined): void {
    if (!dispose) {
      return;
    }
    try {
      dispose();
    } catch (err) {
      this.options.logger?.warn(
        `turn resource disposer failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * The first capture group the first matching pattern yields, trimmed, or null.
 *
 * A capture that trims to nothing reads as NO answer rather than as an empty
 * one: a `resets ` with nothing after it would otherwise reach a caller as
 * "resets at" followed by a blank, which is worse than not mentioning it.
 */
function firstCapture(
  text: string,
  patterns: readonly RegExp[],
): string | null {
  for (const pattern of patterns) {
    const captured = pattern.exec(text)?.[1]?.trim();
    if (captured !== undefined && captured !== '') {
      return captured;
    }
  }
  return null;
}

/**
 * Which directory a path names right now — its device and inode — or null
 * when there is none to name.
 *
 * Identity rather than existence, because the case that matters is a
 * directory removed and made again at the same path: it exists, and a process
 * started in the old one is still in the old one.
 */
function directoryIdentity(path: string): string | null {
  try {
    const stats = statSync(path, { throwIfNoEntry: false });
    return stats === undefined ? null : `${stats.dev}:${stats.ino}`;
  } catch {
    return null;
  }
}

/**
 * One declared root's path under `root`, or null when it does not apply there.
 *
 * A root that STRIPS an anchor only answers for segment lists that actually
 * begin with it: a CLI reading several homes (cursor scans `.cursor`, `.agents`,
 * `.claude` and `.codex`) has roots that belong to other tools, and joining
 * those onto a config directory would invent a path nothing writes.
 */
function rootPath(
  root: { dir: string; strip: readonly string[] | null },
  segments: readonly string[],
): string | null {
  if (root.strip === null) {
    return join(root.dir, ...segments);
  }
  const anchor = root.strip;
  if (
    segments.length <= anchor.length ||
    anchor.some((part, i) => segments[i] !== part)
  ) {
    return null;
  }
  return join(root.dir, ...segments.slice(anchor.length));
}
