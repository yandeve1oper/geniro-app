import type { ChildProcess } from 'node:child_process';

import type { z } from 'zod';

import type { AgentKind } from '../../runs/runs.types';
import type {
  AgentApprovalProbeSchema,
  AgentOptionSpecSchema,
  DelegateFigures,
  ProbeStatusSchema,
  PromptCacheTtlReason,
} from '../chat.types';
import type { AgentVersionService } from '../services/agent-version.service';
import type { ModelVocabularyStore } from '../services/model-vocabulary.store';
import type { ProcessRegistry } from '../services/process-registry';
import type {
  ModelPriceLookup,
  ModelPriceProvider,
} from '../utils/model-prices';
import type { RecordedGroup } from '../utils/process-descendants';
import type {
  SessionAsk,
  SessionCloseOptions,
  SessionLogger,
  SpawnFn,
  StoppedCommands,
} from '../utils/spawn-cli';
import type { SubagentRecoveryRefSchema } from '../utils/subagent-recovery-ref';

// ── Geniro's own MCP server (agent-to-agent calls) ──────────────────────────
// The two names that identify OUR server and OUR tools inside a CLI's config
// file. They live in the adapter contract because WRITING that file is an
// adapter's job — claude's per-turn `--mcp-config` and cursor's
// `.cursor/mcp.json` merge both spell them — and a name two adapters must
// agree on cannot be owned by a module that imports this one.

/**
 * The tool names the per-run MCP endpoint serves. The cursor entry
 * auto-approves exactly these (never `--approve-mcps`, which would
 * blanket-approve the user's other servers too), so the trust expansion stays
 * bounded to what geniro itself publishes.
 */
export const GENIRO_MCP_CALL_TOOLS = [
  'call_agent',
  'await_agent',
  'answer_agent',
  'cancel_agent',
  'message_agent',
  'list_agent_threads',
] as const;

/**
 * What ONE unit of background work consumed, as its CLI reported it when the
 * unit settled.
 *
 * Deliberately not {@link AgentUsage}, which is a TURN's accounting: this is a
 * flat total for a piece of work that ran inside a turn, and the two overlap in
 * one field only. Filling out the turn shape here would mean publishing a dozen
 * nulls no CLI has ever answered for a delegate — and the one figure it would
 * imply is available, `costUsd`, is exactly the one that is not (see
 * `subagent_info.tokens`).
 *
 * Every field nullable on the usual terms: a CLI reports what it reports.
 */
/**
 * How a unit of background work ENDED, in this app's own vocabulary rather than
 * any CLI's.
 *
 * The words are the transcript block's own (`chats/transcript-groups.ts`
 * `subagentBlockStatus`), so a CLI's spelling is translated once, in its
 * adapter, and no consumer downstream has to learn another vendor's list.
 * Claude alone spells the same outcome two ways on its two terminal channels
 * (`killed` on one, `stopped` on the other, measured for one task in one run),
 * which is why translating at the read site is the only place it can be done
 * once.
 */
export type BackgroundUnitOutcome =
  'completed' | 'failed' | 'stopped' | 'untracked';

export interface BackgroundUnitUsage {
  /** Every token the unit spent, prompt and completion together. */
  tokens: number | null;
  /** How many tool calls it made. */
  toolUses: number | null;
  /** How long it ran, as the CLI measured it. */
  durationMs: number | null;
}

export type { DelegateFigures } from '../chat.types';

/**
 * How ONE agent inside a dynamic workflow is doing, in this app's own words.
 *
 * Three states where the CLI reports four: its `start` and `progress` both mean
 * the agent is out working and differ only in whether a first tool call has
 * come back, which is a distinction the card has nothing to draw and no reader
 * asked for. `done` and `error` map straight across. Translated in the adapter,
 * on the rule {@link BackgroundUnitOutcome} follows.
 */
export type WorkflowAgentState = 'running' | 'done' | 'failed';

/**
 * One row of a workflow's agent roster, as of the snapshot carrying it.
 *
 * A SNAPSHOT, never a delta: the CLI re-sends the whole roster keyed by
 * {@link index} (it merges by that key itself before emitting), so a consumer
 * takes the newest array wholesale rather than folding — which is what lets a
 * client replaying a transcript from a cursor read only the last row and still
 * be right.
 */
export interface WorkflowAgentSnapshot {
  /** The agent's 1-based position in the workflow's own numbering. */
  index: number;
  /** The label the script gave it (`opts.label`), or its prompt's opening. */
  label: string | null;
  /** The phase it belongs to, when the script declared phases. */
  phase: string | null;
  state: WorkflowAgentState;
  /** The model it ran, once the workflow has resolved one. */
  model: string | null;
  /** What it spent — reported as it finishes, null while it is out. */
  tokens: number | null;
  toolCalls: number | null;
  durationMs: number | null;
  /** Why it failed, when it did. */
  error: string | null;
}

/**
 * Token/cost accounting for a completed turn. Fields are nullable because not
 * every CLI version reports every figure — the defensive mappers fill what the
 * stream provides and leave the rest null.
 */
export interface AgentUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  /**
   * Of the turn's billed input, how much was READ from the prompt cache and
   * how much was WRITTEN to it.
   *
   * The pair is the whole point and neither half is useful alone: on a
   * conversation past its first turn nearly the entire prompt is a cache read
   * (billed at a tenth), so `inputTokens` on its own — 2, on a turn that sent
   * 37,000 — reads as though almost nothing was sent. Together they are what
   * makes the cost figure explicable, which is the question a session-metrics
   * readout is opened to answer.
   *
   * Cumulative across the turn's requests, like {@link inputTokens} beside
   * them, and NOT a measure of context — that is {@link contextTokens}, and
   * the distinction is the one `claude-usage.utils.ts` exists to keep.
   */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /**
   * Of {@link outputTokens}, how many were spent thinking rather than on the
   * answer. Null for a CLI that does not break its output down — never 0,
   * which is a real reading meaning "this turn did not think".
   */
  thinkingTokens: number | null;
  /**
   * How full the window is NOW — the prompt of the turn's LAST request, which
   * is the whole conversation as the model last saw it.
   *
   * Per-request, never a turn total: a turn re-sends the conversation once per
   * tool call, so adding those up measures work done, not context held (see
   * `claude/utils/claude-usage.utils.ts`). Cache traffic counts — on a resumed session it
   * IS the context — so a CLI that breaks it out reports input + cache-creation
   * + cache-read, and one that doesn't reports its plain input count.
   */
  contextTokens: number | null;
  /**
   * The window that context is measured against, as the CLI reports it for the
   * model it actually ran (claude: 1M for `claude-opus-5[1m]`, 200k for the
   * rest). Null when the CLI says nothing — the consumer then shows the count
   * with no denominator rather than claiming a window nobody confirmed.
   */
  contextWindowTokens: number | null;
  /**
   * WHICH model {@link contextWindowTokens} describes, when the CLI named one.
   *
   * A turn can touch more than one model — a small one runs side errands, and a
   * turn can fall back — so the window belongs to a specific model rather than
   * to the turn. Reported so a consumer caching windows per model can tell that
   * the figure describes the model the turn announced, and decline to file a
   * fallback model's window under the requested one.
   */
  contextModel: string | null;
  /**
   * Whether {@link contextTokens} is geniro's stand-in rather than an
   * occupancy the CLI stated — a different figure put on the meter because no
   * occupancy was reported. Travels with the reading it describes. Optional and
   * false alike mean the CLI stated it.
   */
  contextEstimated?: boolean;
  costUsd: number | null;
  /**
   * Of {@link costUsd}, the part geniro PRICED itself — token counts at the
   * public list price (`ModelPriceCatalog`) — rather than read off the CLI's
   * own bill. Equal to `costUsd` when all of it was priced here, and a part of
   * it once segments fold. Optional and null alike mean none of it was: the
   * cost is the CLI's, or there is no cost at all.
   */
  estimatedCostUsd?: number | null;
  /**
   * How long the turn took, as the CLI ITSELF measured it.
   *
   * The CLI's own figure and not a wall clock, which is the whole reason it is
   * an adapter fact rather than something the daemon times: it measures the
   * agent WORKING, and so excludes both of the waits geniro puts around a turn
   * — the first-prompt MCP-readiness hold (up to 15s, see
   * `claude-mcp-ready.utils.ts`) and any stretch parked on an approval card,
   * which is a human being timed. A turn blocked half an hour on a question
   * reports the seconds of work here, not the half hour.
   *
   * Null for a CLI that reports none, and the consumer then measures the wall
   * clock itself rather than showing nothing — the fallback is deliberately
   * NOT computed here, because a daemon-side timer would silently displace the
   * better number for every CLI that does report one.
   *
   * Probed live on claude 2.1.x (2026-08-14): the `result` line carries
   * `duration_ms` 7618 beside `duration_api_ms` 7176, `ttft_ms`,
   * `time_to_request_ms` and `num_turns` — see {@link ttftMs},
   * {@link timeToRequestMs} and {@link numTurns} for the other three.
   */
  durationMs: number | null;
  /**
   * Of {@link durationMs}, how much was spent waiting on the model's API.
   *
   * The remainder is the CLI's own work — running tools, reading files, its own
   * scaffolding — so the pair is what separates "the model was slow" from "the
   * agent did a lot". Null whenever the CLI reports no such split; ACP reports
   * neither figure (see `AcpTurnDriver.buildUsage`).
   *
   * **It can EXCEED {@link durationMs}, and a consumer must expect that.**
   * Measured 2026-08-14 on a two-turn chat over one kept session: turn 1 came
   * back `duration_ms` 3007 / `duration_api_ms` 2504, and turn 2 `duration_ms`
   * 2562 / `duration_api_ms` 4633. The CLI is not reporting a subdivision of one
   * interval on a resumed process, so the subtraction is only meaningful when it
   * lands non-negative — the renderer's tooltip withholds the split entirely
   * rather than printing a negative "own work" figure.
   */
  apiMs: number | null;
  /**
   * How long the turn waited before its first token came back — the CLI's own
   * `ttft_ms`. Null for a CLI that reports none, ACP included (see
   * `AcpTurnDriver.buildUsage`): never a wall-clock substitute, on
   * {@link durationMs}'s own reasoning.
   */
  ttftMs: number | null;
  /**
   * How long the turn spent BEFORE the first request was even sent — the CLI's
   * own `time_to_request_ms`. Distinct from {@link ttftMs}, which starts once
   * the request is in flight; this is everything before it (queueing,
   * local setup).
   */
  timeToRequestMs: number | null;
  /**
   * How many model requests the turn made — the CLI's own `num_turns`. A
   * COUNT, unlike every other field here: a turn that called five tools made
   * five requests, each one re-sending the conversation.
   */
  numTurns: number | null;
  /**
   * How long the provider keeps this conversation's prompt CACHE alive after
   * the turn's last request, as the CLI reported the cache it wrote — the
   * window in which the next message is billed as a cache READ rather than a
   * full re-write of everything the conversation holds.
   *
   * claude states it per request: `usage.cache_creation` splits the write into
   * `ephemeral_1h_input_tokens` and `ephemeral_5m_input_tokens` (probed on
   * 2.1.295 under `-p --output-format stream-json`; a subscription profile
   * writes the 1h cache, an API key the 5m one by default).
   *
   * Optional and null alike mean "not reported": a CLI with no such figure
   * leaves it out, and a turn that wrote nothing to the cache cannot say which
   * lifetime it would have had.
   */
  promptCacheTtlMs?: number | null;
  /**
   * Why {@link promptCacheTtlMs} is what it is, when the CLI said so — reported
   * beside a lifetime and never without one. claude writes the five-minute
   * cache instead of the hour while the account runs on paid extra usage
   * (`isUsingOverage` → `ttl:"5m"` in the 2.1.295 bundle), and says it is on
   * extra usage in its `rate_limit_event`. Optional and null alike mean no
   * reason was given, the ordinary case.
   */
  promptCacheTtlReason?: PromptCacheTtlReason | null;
  /**
   * {@link costUsd} split by the model that spent it — the turn's own model
   * beside every model its sub-agents and side calls ran on — costliest first.
   *
   * The split exists because a turn's TOKEN fields can be its main thread's
   * alone (claude's `usage`) while its cost covers everything, so tokens times
   * price does not reproduce the cost without it. Reported only when the parts
   * sum to {@link costUsd}; optional and null alike mean no CLI-stated split.
   */
  modelCosts?: AgentModelCost[] | null;
}

/** One model's share of a turn's cost — see {@link AgentUsage.modelCosts}. */
export interface AgentModelCost {
  /** The model id as the CLI keyed it. */
  model: string;
  costUsd: number;
}

// ── What the window currently HOLDS ─────────────────────────────────────────
//
// {@link AgentUsage} answers "what did that turn cost"; everything below
// answers "what is in the window right now, and what put it there". They are
// different questions with different sources: usage is read off a turn's own
// result line, while this is ASKED of a live process (see
// `AgentSession.readContextUsage`) and so has no turn attached to it at all.

/**
 * Which of {@link AgentSessionReadInput}'s channels a CLI's reading comes
 * from.
 *
 * `live-process` is a question put to a RUNNING agent over its own stdin
 * dialogue, so the reading exists only while the run holds a session (claude).
 * `session-store` is read off what the CLI wrote to disk, so it survives the
 * process (cursor). `account` is asked of the vendor under the run's own
 * profile login, so it needs neither (cursor's plan limits). The distinction is
 * not decoration: it is what separates "there was nobody to ask" from "we asked
 * and got nothing", which are the two sentences the readout has to choose
 * between.
 */
export type UsageReadChannel = 'live-process' | 'session-store' | 'account';

/**
 * Whether one of the two window/plan questions can be put to this CLI at all,
 * and if so where the answer comes from.
 *
 * The `unavailable` arm's reason is a SENTENCE rendered verbatim where the
 * figures would have been, matching `handoff`'s own shape — and the two facts
 * ride ONE field so a CLI cannot declare a reason beside a channel that
 * contradicts it.
 */
export type UsageReading =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'reads'; readonly channel: UsageReadChannel };

/**
 * One line item of the context window, as the CLI itself accounts for it.
 *
 * The names are the CLI's OWN and are deliberately not normalized into a
 * geniro vocabulary: they are what that CLI's own `/context` prints, so a user
 * comparing the two surfaces sees the same words, and a CLI that invents a new
 * category next month shows it rather than dropping it into "other".
 */
export interface AgentContextCategory {
  name: string;
  tokens: number;
  /**
   * This category is AVAILABLE but not loaded — claude's deferred tool
   * surface, which costs nothing until something searches for a tool in it.
   *
   * Excluded from {@link AgentContextUsage.totalTokens} by the CLI (verified
   * by arithmetic on a live reading: the non-deferred rows sum exactly to the
   * total, and free space is the window minus it). A consumer that renders
   * these in the same bar as the rest reports a window several times fuller
   * than it is — measured, 273,876 deferred MCP tokens against a 98,598 total.
   */
  deferred: boolean;
}

/** Where a CLI keeps the user's own standing instructions — see `AdapterConfig.userInstructions`. */
export type AgentUserInstructions =
  | {
      readonly kind: 'file';
      /** The config directory's name under the user's home (`.claude`). */
      readonly homeDir: string;
      /** The file's name inside that directory (`CLAUDE.md`). */
      readonly fileName: string;
    }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** One file the agent loaded as standing instructions, and what it costs. */
export interface AgentContextMemoryFile {
  path: string;
  /** The CLI's own word for where it came from (`Project`, `AutoMem`, …). */
  kind: string | null;
  /**
   * What it costs in the window, or null when the CLI names the file without
   * pricing it — codex lists the instruction files a thread loaded
   * (`instructionSources`) and reports no per-file figure.
   */
  tokens: number | null;
}

/**
 * One MCP server's whole tool surface, summed.
 *
 * Per SERVER and never per tool, which is the difference between a readout and
 * a data dump: a live reading here carried 371 tools across 46 servers, and
 * the actionable fact in it — one server accounting for 109k of the 274k — is
 * visible only once they are summed. The per-tool rows are dropped at the
 * adapter rather than sent and hidden, because the wire cost is the point (the
 * raw reply is ~80KB, most of it tool descriptions the user cannot act on).
 */
export interface AgentContextServer {
  name: string;
  /**
   * The server's whole tool surface in tokens, or null when the CLI lists the
   * server's tools without pricing them (codex, which reports no per-server
   * figure).
   */
  tokens: number | null;
  toolCount: number;
  /** How many of those tools are actually loaded into the window right now. */
  loadedToolCount: number;
}

/**
 * What one agent's context window holds at the moment it was asked.
 *
 * A SNAPSHOT and not an accumulation: it is read from a live process, so it
 * describes that conversation as it stands, including work done inside a turn
 * that has not finished. Every field is nullable because a CLI reports what it
 * reports — a reading missing `maxTokens` still has categories worth showing,
 * and inventing a denominator is the defect `ContextMeter` already documents.
 */
export interface AgentContextUsage {
  /** In the CLI's own order, which is the order its own readout uses. */
  categories: AgentContextCategory[];
  /** What the non-deferred categories sum to, as the CLI itself totals them. */
  totalTokens: number | null;
  /** The window {@link totalTokens} is measured against. */
  maxTokens: number | null;
  /** Which model that window belongs to, when the CLI named one. */
  model: string | null;
  /**
   * The token count at which this CLI would compact the conversation by
   * itself, and whether it is switched on — null when the CLI says nothing.
   *
   * Worth surfacing because it is the number that actually bounds a
   * conversation: `maxTokens` is where the model stops, but this is where the
   * agent's own history gets rewritten, and it is what a user watching a long
   * session is really counting down to.
   */
  autoCompactAtTokens: number | null;
  autoCompactEnabled: boolean | null;
  memoryFiles: AgentContextMemoryFile[];
  servers: AgentContextServer[];
  /**
   * How the window's LAST request split, for a CLI that reports per-request
   * token counts instead of content categories (codex). It is what one request
   * SENT and got back — new input, cache reads, output, reasoning — never what
   * the window holds by kind, which is why it is its own field rather than
   * more {@link categories}. Absent/null when the CLI reports no such split.
   */
  lastRequest?: AgentContextLastRequest | null;
}

/** One request's token split — see {@link AgentContextUsage.lastRequest}. */
export interface AgentContextLastRequest {
  /** Input sent fresh — cache reads and writes excluded. */
  inputTokens: number;
  /** Input served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Input newly written to that cache. */
  cacheWriteInputTokens: number;
  /** What the model produced, reasoning included. */
  outputTokens: number;
  /** The share of {@link outputTokens} spent reasoning. */
  reasoningOutputTokens: number;
}

/**
 * What a caller can offer an adapter that is being asked something about a
 * run's agent — its context window, the plan limits behind its account.
 *
 * BOTH channels, because the two shipped CLIs answer from different places and
 * neither shape covers the other: claude answers from its RUNNING process, and
 * cursor answers from the session store it wrote to DISK — which is readable
 * with no process at all, and is its only route, since a cursor process does
 * not outlive its turn. An input carrying only a live session would make the
 * second unimplementable; one carrying only an id would make the first.
 *
 * Named for the CHANNELS rather than for one question, because it now serves
 * two and neither owns it.
 */
export interface AgentSessionReadInput {
  /**
   * The run's live CLI process, or null when it holds none — idle, reaped, or
   * a CLI that never keeps one.
   */
  live: AgentSession | null;
  /** That conversation's CLI session id, or null before the CLI names one. */
  sessionId: string | null;
  /** The profile the run's agent runs under, null for the CLI's default. */
  configDir: string | null;
}

/** Durable identity used only to read a lost delegate's existing CLI record. */
export type SubagentRecoveryRef = z.infer<typeof SubagentRecoveryRefSchema>;

export type SubagentTrackingLost = 'process-ended';

/**
 * Why a session is closed, when it decides how the work still out ended:
 * `user-stop` — the user's Stop, so every delegate it cuts off is `stopped`.
 * Any other close leaves them `untracked`, its process having ended.
 */
export type SessionCloseCause = 'user-stop';

export type RecoveredSubagentOutcome = Exclude<
  BackgroundUnitOutcome,
  'untracked'
>;

/**
 * One rate-limit window an account's plan enforces — the thing that actually
 * stops a conversation, and the thing the app could not previously say anything
 * about.
 *
 * A LIST of windows rather than one figure, because a plan enforces several at
 * once and the binding one changes through the week: a five-hour session window
 * refills over lunch while a seven-day one does not, so a readout showing only
 * the first tells a user they have room on the day they are about to be cut off.
 * Which windows exist is the CLI's business, never this app's.
 */
export interface AgentPlanWindow {
  /**
   * The CLI's own key for this window, opaque here — carried so a reader can
   * tell two rows apart without parsing the label a human sees.
   */
  key: string;
  /** What to call it on screen, in the CLI's own vocabulary. */
  label: string;
  /** How much of it is used, 0-100. */
  percent: number;
  /** When it refills (ISO 8601), or null when the CLI named no moment. */
  resetsAt: string | null;
}

/**
 * What the account behind one chat is allowed, as its CLI reports it.
 *
 * Per CHAT and not per app, which is the whole reason it rides the chat metrics
 * route: a run carries its own `configDir`, so two threads open side by side can
 * be signed in to different accounts on different plans, and one figure in a
 * global header would be describing whichever of them the app happened to ask.
 *
 * Null from an adapter means "no reading", never "no limits" — an unlimited
 * account and a CLI that cannot be asked must not render the same.
 */
export interface AgentPlanLimits {
  /** The subscription in the CLI's own word ('pro', 'max', …), or null. */
  plan: string | null;
  /** In the CLI's own order, which is the order its own readout uses. */
  windows: AgentPlanWindow[];
  /**
   * True when the CLI did NOT get this answer from its plan's usage service
   * and filled it in from what it had to hand instead — claude's "seeded"
   * reading, built from the rate-limit headers of the process's own last
   * request or from a snapshot persisted earlier.
   *
   * Kept apart because the two disagree, and by a lot: measured 2026-10-07 on
   * one account, two live claude processes answered 45% and 96% for the same
   * five-hour window within the same minute — the 45% being the seeded one,
   * the one with no model-scoped row. A reading that says which kind it is
   * lets the account-wide ledger prefer the real one
   * (`utils/plan-limits-ledger.ts`).
   */
  estimated: boolean;
}

/**
 * The account ANSWERED and has no plan windows to report — an API-key account,
 * or a reply carrying none — as opposed to `null`, nothing came back.
 *
 * Kept apart because the two need opposite sentences: "did not answer in time"
 * about a CLI that did answer sends the user to wait for a reading that will
 * never exist, and an ask that cannot say which it got waits out its whole
 * deadline before saying anything at all.
 */
export const NO_PLAN_LIMITS = 'no-plan-limits';

/**
 * Where one task on an agent's own list stands.
 *
 * The three every shipped CLI uses, measured on both: claude's `TaskUpdate`
 * takes `pending`/`in_progress`/`completed`, and cursor's `cursor/update_todos`
 * rows carry the same three words. A status outside them reads as null rather
 * than being coerced into one of these — a wrong reading of "where is this
 * task" is worse than an honest "the CLI said something we do not know".
 */
export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed';

/** One task on the agent's own list, as {@link AgentEvent} `task_list` carries it. */
export interface AgentTask {
  /**
   * The CLI's own id for the task — the join key across announcements, which is
   * what makes a patch applicable at all. Both shipped CLIs number them (`"1"`,
   * `"2"`, …); the value is opaque here and never parsed.
   */
  id: string;
  /**
   * What the task IS. Null in a patch that only moves a status and repeats no
   * text (claude's `TaskUpdate` sends `{taskId, status}` and nothing else), in
   * which case the consumer keeps the title it already had for that id.
   */
  title: string | null;
  /** Null when the CLI named a status this daemon does not recognise. */
  status: AgentTaskStatus | null;
  /**
   * The present-continuous label a CLI shows while the task runs ("Reading the
   * file"). Null for a CLI that has none, and null for claude's `TaskCreate`
   * even though the tool takes one — see `claude-tasks.utils.ts` for why the
   * two halves cannot be paired without state the mapper deliberately lacks.
   */
  activeForm: string | null;
  /**
   * The CLI REMOVED this task — set on a PATCH row only. claude's `TaskUpdate`
   * takes `status: "deleted"` (its own input schema, read out of the 2.1.270
   * bundle), and reading that as an unrecognised status left the row on screen
   * under the unknown glyph, still counted in the total.
   */
  deleted?: true;
  /**
   * A PATCH row that states no status at all — `TaskUpdate`'s `status` is
   * optional, and a call that only renames a task omits it. The consumer keeps
   * the status it had; without this the patch's null read as "moved somewhere
   * unknown" and a finished task lost its tick.
   */
  keepsStatus?: true;
}

/**
 * Normalized streaming event emitted by an agent adapter during one turn. This
 * is the shared model every adapter converges its CLI's divergent output onto
 * (the spec's TextChunk/ReasoningChunk/ToolCallRequest/ToolCallComplete/
 * TurnComplete/TurnCancelled/Error), plus a `session` event carrying the CLI
 * session id for resume.
 */
export type AgentEvent = AgentEventOrigin & AgentEventBody;

/**
 * What the USER can do about a failed turn, when the failure has a known cure.
 *
 * Stamped by the adapter layer, because recognising the failure is a fact about
 * one CLI's wording; acted on by the renderer, which only ever reads the verdict
 * and so never learns a CLI's name. `cli-login` is the only member today: an
 * expired account session, cured by signing the CLI back in.
 *
 * Absent means "no known recovery" — the row renders as an ordinary error. That
 * is the honest default: a wrong action offered on an unrelated failure sends
 * the user to a command that cannot fix what they hit.
 */
export type AgentErrorRecovery = 'cli-login';

/**
 * WHY a turn failed, in the one vocabulary another AGENT can act on.
 *
 * {@link AgentErrorRecovery} answers the same question for the USER and has one
 * member, because a person is only ever offered an action they can take. A
 * CALLER agent needs more: a Manager told only "the callee turn failed"
 * re-dispatched five times in four minutes into a session limit that had eleven
 * hours left on it, and diagnosed the message length, then the thread, then the
 * agent — because those were the only variables it could see. Reconstructed from
 * run `09d69570`, whose own transcript carried `You've hit your session limit ·
 * resets 7:30pm (Asia/Almaty)` while the caller was handed the hardcoded
 * sentence.
 *
 * The four are the four different things a caller should DO:
 *
 * - `rate_limited` — the account's usage window is spent. Nothing else will run
 *   until it resets, so the right move is to wait (see
 *   {@link AgentTurnFailure.resetsAt}), never to retry.
 * - `auth_expired` — the CLI's account session lapsed. Only the user can cure
 *   it, so the right move is to ask them and stop.
 * - `daemon_restart` — geniro's OWN side failed or went away under the turn: the
 *   daemon restarting beneath a run is the case this exists for, and a turn that
 *   could not be started, or whose bookkeeping write failed, reads the same way
 *   to a caller — nothing about the work was wrong, so retrying once is right.
 *   NOTE it is not directly observable as a turn outcome: a daemon that dies
 *   takes the whole run with it (there is no auto-resume), so what actually
 *   reaches this class is the geniro-side bucket above.
 * - `crashed` — the CLI reported a failure this layer does not recognise. The
 *   honest default, and deliberately the one with no special handling: retry
 *   once, then report.
 *
 * Kept as a CLOSED union rather than a free string so a caller-facing message
 * cannot grow a fifth word nothing downstream was written for.
 */
export type AgentFailureClass =
  'rate_limited' | 'auth_expired' | 'daemon_restart' | 'crashed';

/** How a turn failed, as much of it as the CLI's own message can say. */
export interface AgentTurnFailure {
  readonly class: AgentFailureClass;
  /**
   * When the spent window reopens, VERBATIM as the CLI wrote it — never parsed
   * into a timestamp here.
   *
   * The CLI states it in the user's own words and timezone (`2:30pm
   * (Asia/Almaty)`), which is exactly what a caller should repeat back; turning
   * that into an instant means guessing a date, a zone and an am/pm the message
   * never gave, and a wrong instant is worse than the sentence it replaced.
   *
   * Null unless {@link class} is `rate_limited` AND the message named one.
   */
  readonly resetsAt: string | null;
  /**
   * Present when the message is the CLI's own sentence for its vendor's service
   * refusing the request (`AdapterConfig.auth.serviceRefusalMarkers`) —
   * a fact a caller cannot read off the sentence, so it blames its own messages.
   */
  readonly refusedByService?: true;
}

/**
 * What was known about a failure BESIDES the sentence it was reported with.
 *
 * A failed turn used to reach the transcript as one line of prose and nothing
 * else — "API Error: Connection lost mid-response. The response above may be
 * incomplete." — which says what happened and nothing anyone could act on or
 * hand to whoever runs the model. Every field here is something the CLI already
 * put on the wire and geniro was dropping, measured on claude 2.1.234 by
 * forcing a failure (`--model definitely-not-a-model`):
 *
 *   {"type":"assistant", … ,"error":"model_not_found",
 *    "request_id":"req_011CeAL4KP2RkG9YEPGrdi2n","is_api_error_message":true}
 *   {"type":"result","is_error":true,"terminal_reason":"api_error",
 *    "api_error_status":404,"session_id":"…","duration_ms":986,
 *    "subtype":"success", …}
 *
 * Note `subtype` on that line: it says `success` on a failure, which is why it
 * is not the code and why appending it to the message was actively misleading.
 *
 * EVERY field is optional and none is invented: a CLI that reports none of this
 * produces an error row byte-identical to the one it produced before. The
 * renderer reads them back through a twin parser (`chats/error-payload.ts`).
 */
export interface AgentErrorDetail {
  /**
   * The CLI's own machine-readable name for what failed — `model_not_found`,
   * `api_error`. Searchable in the vendor's vocabulary in a way prose is not.
   */
  code?: string;
  /** The HTTP status the model's endpoint answered with. */
  httpStatus?: number;
  /**
   * The provider's own id for the failed request.
   *
   * The single most useful field here and the one nothing else can substitute:
   * it is what a provider can look up, and it exists nowhere in the app unless
   * it is carried across from the line that reported it.
   */
  requestId?: string;
  /** The CLI session the failure happened in. */
  sessionId?: string;
  /** How long the turn had been running when it failed. */
  durationMs?: number;
  /** The process's exit code, when it died rather than reported. */
  exitCode?: number;
  /** The signal that killed the process, when one did. */
  signal?: string;
}

/**
 * WHICH thread of one turn produced an event.
 *
 * A CLI that runs sub-agents emits their output on the SAME stream as the main
 * thread's, so without this every consumer reads one interleaved sequence and
 * cannot tell the two apart. That is not a cosmetic gap: a sub-agent's own
 * assistant line carries its own small, fresh context usage, so attributing it
 * to the turn made the context meter jump backwards and snap forward again,
 * and its tool calls landed in the transcript as top-level rows beside the main
 * thread's.
 *
 * ABSENT means the main thread — the overwhelmingly common case, and the
 * reading for any CLI that does not report this at all (no ACP agent sets it).
 * Deliberately not `string | null`: one state deserves one representation, and
 * a nullable form invites an adapter to write `=== null` at a read site that
 * would then miss every main-thread event. A present value is the id of the
 * tool call that started the sub-agent, so it doubles as the key joining a
 * sub-agent's rows to the parent row they belong under.
 */
interface AgentEventOrigin {
  parentToolUseId?: string;
}

type AgentEventBody =
  | { type: 'text'; text: string }
  | {
      /**
       * A message the USER wrote, as the CLI reports it back.
       *
       * Produced ONLY while replaying a conversation geniro does not already
       * hold — the import of an existing CLI session. In an ordinary turn the
       * daemon wrote the prompt itself and persisted it before the CLI ever saw
       * it, so a CLI echoing it back is a duplicate and every adapter drops it
       * (ACP's `user_message_chunk`, which is exactly this line arriving during
       * a normal `session/load`).
       *
       * It exists because a transcript with the user's half missing is not the
       * conversation: an imported thread would open on a column of answers to
       * questions nobody can see. That could not be expressed with `text`,
       * whose row is `role: 'assistant'` by definition.
       */
      type: 'user_message';
      text: string;
    }
  | {
      /**
       * The CLI has TAKEN a user message geniro wrote to it — read it off stdin
       * and put it in front of the model. Turn plumbing, like
       * `background_work`: `runCliSession` consumes it and never forwards it.
       *
       * It exists because a follow-up written into a running turn is not
       * answered on any fixed schedule. Probed on claude 2.1.270 with
       * `--replay-user-messages`: one written while a tool ran was echoed at
       * the tool boundary and answered inside the same `result`, while one
       * written as the model was producing its final words was echoed only
       * AFTER that `result`, and got a whole `result` of its own. Settling on
       * the first line in the second case marked the run `completed` while the
       * agent went on answering — REPORTED as a queued message that "he will
       * take, but status will not change from completed to working". Only a
       * CLI declaring {@link AdapterConfig} `followUp.consumptionReported`
       * produces it.
       *
       * `text` is the message's text as the CLI echoed it, which is how the
       * echo is matched to the follow-up it acknowledges — the turn's own
       * prompt is echoed too, and must not count as one.
       */
      type: 'user_message_consumed';
      text: string;
    }
  | {
      /**
       * An INCREMENT of assistant text, as the CLI generates it — the live
       * plane behind a growing bubble.
       *
       * EPHEMERAL BY CONTRACT: a delta is never persisted, never allocated a
       * `seq`, and never replayed. The completed `text` event that follows is
       * the durable record of the same words, so a client that missed deltas
       * (a reconnect mid-block) loses nothing. `mapEventToItem` returns null
       * for it, and that switch is deliberately default-less so a new arm
       * cannot silently become a database row.
       */
      type: 'text_delta';
      text: string;
    }
  | {
      /**
       * An INCREMENT of the model's REASONING text — the live plane behind a
       * thinking stretch, for a CLI that discloses what it is thinking.
       *
       * The twin of `text_delta`, and separate from it for the reason the
       * durable `reasoning` event is separate from `text`: these words are the
       * agent working something out, not the answer, and merging them would
       * put its scratch notes in the assistant's own bubble.
       *
       * It exists because {@link AgentEvent} `thinking_progress` cannot carry
       * them. That event answers the same question for a CLI whose thinking is
       * REDACTED (headless claude), where a running token total is all there
       * is — so a CLI that does disclose the text had no channel at all, and
       * its reasoning reached the transcript only when the block closed. On
       * cursor that is measured at up to several minutes of a screen showing
       * nothing but `Working…` while thought chunks were arriving the whole
       * time.
       *
       * EPHEMERAL, exactly like `text_delta`: never persisted, never allocated
       * a `seq`, never replayed. The `reasoning` event that follows is the
       * durable record of the same words.
       */
      type: 'reasoning_delta';
      text: string;
    }
  | {
      /**
       * The model is WRITING A TOOL CALL right now — which tool, and how much
       * of its arguments has arrived.
       *
       * The third member of the live plane, and it answers the stretch the
       * other two cannot see. `text_delta` covers the agent TALKING and
       * `thinking_progress`/`reasoning_delta` cover it THINKING; between them
       * sits a stretch where the model is doing neither — it is serializing a
       * tool's arguments, and nothing reaches the transcript until the whole
       * call has been written. For an ordinary `Bash` that is milliseconds. For
       * a host tool whose argument IS the deliverable — `show_artifact` carries
       * a whole HTML document — it is the longest silence in the turn, and the
       * only thing on screen for it was `Working… · 1m 12s`.
       *
       * PROBE-VERIFIED on claude 2.1.x with `--include-partial-messages`: one
       * `content_block_start` carrying `{type:'tool_use', name}` followed by
       * `input_json_delta` frames (measured: 64 frames / 503 bytes for a small
       * `Write`), then `content_block_stop`. The NAME is the load-bearing half —
       * it is what lets a client tell "the model is writing an artifact" from
       * "the model is writing a shell command", which is the difference between
       * a card skeleton and no change at all.
       *
       * The ARGUMENTS themselves deliberately never cross this wire, only their
       * BYTE COUNT: a large `Write` would otherwise send the whole file twice,
       * which is exactly why `mapClaudeStreamEvent` drops `input_json_delta`
       * text. A count is enough to show progress and cannot leak a payload.
       *
       * EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never allocated a `seq`, never replayed. The durable
       * `tool_call` event that follows is the record of the same call.
       */
      type: 'tool_compose';
      /**
       * The tool whose arguments the model has just BEGUN writing, or null for
       * a frame about the call already open.
       *
       * Non-null is what OPENS a composition; the byte frames after it carry no
       * name of their own (the CLI's delta frames identify their block by index
       * alone), so a null here means "more of the one you already know about".
       */
      tool: string | null;
      /** Argument bytes in THIS frame — 0 on the opening and closing frames. */
      bytes: number;
      /** The model has finished writing this call's arguments. */
      done: boolean;
    }
  | {
      /**
       * The model is REASONING, with the tokens it has spent so far.
       *
       * For a CLI that REDACTS its thinking: headless claude ships the block
       * with an encrypted `signature` and an empty body (probe-verified —
       * `--include-partial-messages` does not reveal it), so a running total is
       * the only honest signal that the agent is working during an otherwise
       * silent stretch. A CLI that discloses the words sends `reasoning_delta`
       * instead. EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never replayed.
       */
      type: 'thinking_progress';
      tokens: number;
    }
  | {
      /**
       * How full the model's context window is as of the request that just
       * produced output — the live counterpart of the `turn_complete` usage.
       *
       * Every claude `assistant` line carries its own request's prompt-side
       * usage (probe-verified on 2.1.220), so the meter can move DURING a turn
       * instead of jumping once at the end, which is what made it read stale.
       * EPHEMERAL, exactly like {@link AgentEvent} `text_delta`: never
       * persisted, never replayed.
       */
      type: 'context_progress';
      contextTokens: number;
      /**
       * The window those tokens are measured against, and which model it
       * belongs to — when THIS reading knows them.
       *
       * Absent for a CLI whose two halves arrive on different lines: claude
       * reports the used side on every `assistant` line and the window only on
       * `result`, which is why the window used to ride nowhere but
       * `turn_complete`. Present for one answering off its OWN accounting,
       * where used and window are a single reading — and splitting them there
       * would leave the meter a numerator with no denominator, which is
       * precisely what a cursor chat showed: a full breakdown in the panel
       * behind a ring that had never been given a window to be a fraction of.
       */
      contextWindowTokens?: number | null;
      contextModel?: string | null;
    }
  | {
      /**
       * What ONE request SPENT, as soon as it lands — the live counterpart of
       * the `turn_complete` usage's token halves.
       *
       * A SIBLING of `context_progress` rather than more fields on it, because
       * the two are different facts about the same line: that one reports a
       * LEVEL (how full the window is now, which does not accumulate), this
       * one reports a COST (what this request added, which does). Folding them
       * together would leave a reader unable to tell a window that grew by
       * 12k from a turn that spent 12k, and the accumulator downstream would
       * have to guess which of the two it was handed.
       *
       * Claude carries all of it on every `assistant` line and geniro was
       * dropping everything but the prompt-side sum. Cursor carries NONE of it:
       * measured 2026-09-06 on 2026.08.31-4057e58 — no `usage_update` emitter
       * on its ACP wire (the name appears once, inside the schema union), no
       * token field anywhere in its session store, `afterAgentResponse` and
       * `stop` hooks that do not fire, and a `sessionEnd` hook plus JSONL
       * transcript carrying neither. So this event is claude-only today, and
       * the shape is the ACP `usage_update` one so that adopting theirs, when
       * they ship it, is a mapping rather than a redesign.
       *
       * EPHEMERAL like `context_progress`: never persisted, never replayed —
       * the durable copy is the turn's own `turn_complete` usage.
       */
      type: 'usage_progress';
      /** Fresh input tokens for this request — cache traffic excluded. */
      inputTokens?: number | null;
      /** What the model produced on this request. */
      outputTokens?: number | null;
      /** Cache reads, kept apart because they are priced apart. */
      cacheReadTokens?: number | null;
      /** Newly written cache, likewise. */
      cacheCreationTokens?: number | null;
    }
  | {
      /**
       * One delegate's figures over every model request it has made so far — a
       * LEVEL the consumer replaces, never adds.
       *
       * EPHEMERAL on the item plane: the live channel carries it, the run row
       * keeps the latest copy (`Run.delegateSpend`), and the delegate's closing
       * `subagent_info` writes the final figures durably. Never part of the
       * owner's own spend, which the CLI already reports with its delegates in
       * it.
       */
      type: 'delegate_progress';
      /** The launching tool call's id — the delegate's card id. */
      delegateId: string;
      figures: DelegateFigures;
      /** The delegate's end was seen, so these are its final figures. */
      final: boolean;
    }
  | {
      /**
       * What the process has spent since its last `result` line, in dollars,
       * as the CLI's own cost ledger states it: the part of a running turn no
       * durable row carries yet.
       *
       * A LEVEL the consumer replaces, not a part it adds, unlike
       * `usage_progress` beside it: the CLI answers with a running total, and
       * summing two readings of it would bill the first one twice. It drops to 0
       * at every `result` line, because that line's `turn_complete` (or failed
       * turn's `error`) is where the same money becomes durable — so a reader
       * adding this to the recorded totals never counts a dollar twice.
       *
       * It exists because without it a running call's card shows only the
       * turns that have FINISHED, as if that were the whole bill — a small
       * fraction of a call hours into its turn. The tokens are already live
       * (`usage_progress`), but pricing them here is not possible for a model
       * the price table has no row for — so where the CLI prices its own
       * requests, the figure is ASKED of it.
       *
       * claude answers over the `get_usage` control request (see
       * `CLAUDE_LIVE_COST_ASK_INTERVAL_MS` in `claude.const.ts`); codex states
       * no price, so its figure is its tokens at list price and all of it is
       * `estimatedCostUsd`. A CLI with neither never emits it, and its running
       * figure stays what the finished turns add up to.
       *
       * EPHEMERAL like its siblings: never persisted, never replayed.
       */
      type: 'cost_progress';
      costUsd: number;
      /** Of `costUsd`, the part geniro priced itself — see `AgentUsage`. */
      estimatedCostUsd?: number;
    }
  | { type: 'reasoning'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      input: unknown;
      /**
       * WHAT KIND of work this call is, in one vocabulary shared by every agent:
       * ACP's own `ToolKind` (`read` | `edit` | `delete` | `move` | `search` |
       * `execute` | `think` | `fetch` | `switch_mode` | `other`). Absent when the
       * CLI does not classify its calls.
       *
       * It exists because the alternative is a reader recognising one CLI's tool
       * NAMES, which is what the transcript did: the group summary bucketed on
       * `Read`/`Edit`/`Bash` and on an `input.file_path`, so a cursor turn — whose
       * calls are titled "Read File", "Edit File", "grep" and disclose no
       * arguments at all — fell through to "Used 2 tools" and named nothing it had
       * done. The vocabulary is ACP's rather than geniro's own because one agent
       * already speaks it on the wire, so only the other side needs a mapping.
       */
      kind?: string;
      /**
       * WHICH FILES this call touches, when the agent named them — ACP's
       * `ToolCallLocation[]`, carried in the same shared vocabulary as
       * {@link kind} and for the same reason: one agent already speaks it on
       * the wire, so only the other side would need a mapping.
       *
       * Absent when the agent named none, and deliberately NOT an empty array —
       * the two are distinguishable on the wire, and what each means is on
       * `AcpToolCall.locations` (`acp/acp.types.ts`) with the measurement behind
       * it. A `line` rides only where the agent set one.
       */
      locations?: { path: string; line: number | null }[];
    }
  | {
      type: 'tool_result';
      id: string;
      name: string | null;
      result: unknown;
      isError: boolean;
      /**
       * This result reports the END of a command that ran on in the background
       * after its turn ended — codex completes such a command's item whenever
       * the command exits, usually with no turn open. Set by the adapter that
       * knows it. A command ending is no agent working again, so it never
       * restates a settled run (`restatesRunAsWorking`). Absent otherwise.
       */
      endsBackgroundWork?: true;
    }
  | {
      /**
       * Every tool call the CLI started, or left open, after its turn ended has
       * ended or gone to the background, and nothing of that turn follows. It
       * ends the off-turn stretch those calls opened the way a terminal event
       * does (`endsOffTurnStretch`): no turn ending will ever arrive for it.
       * Set by the adapter that knows its turn ended. No row.
       */
      type: 'late_work_ended';
    }
  | {
      type: 'turn_complete';
      usage: AgentUsage | null;
      stopReason: string | null;
      /**
       * The agent's final answer text as the CLI's result line reports it —
       * what a caller receives as the call's result. Null when
       * the CLI's result carries no text (callers fall back to concatenating
       * the turn's `text` events).
       */
      finalText: string | null;
      /**
       * True when this ends a turn the CLI opened BY ITSELF — a continuation it
       * ran because background work reported back — rather than a turn geniro
       * started with a prompt. Absent otherwise.
       *
       * A turn geniro starts must not settle on one. PROBED on claude 2.1.266:
       * a message written while the CLI was mid-continuation was answered only
       * AFTER the continuation's own `result` line (which carries
       * `origin:{kind:"task-notification"}`), so settling on the first result
       * handed the new turn the continuation's text and ended it before its
       * real answer arrived.
       */
      continuation?: boolean;
      /**
       * True when this continuation's result arrived while a turn geniro
       * started was still owed its own answer, so it ended NOTHING. Set by
       * `spawn-cli` alone, never by an adapter — only the session knows a turn
       * is open.
       *
       * Persisted on the row, because a client reading the row cannot tell
       * otherwise: the renderer mirrors a live `turn_complete` onto the run's
       * badge, and REPORTED as a sidebar reading `completed · 32m` over a thread
       * still visibly working, the daemon's own status having never moved.
       */
      insideTurn?: boolean;
      /**
       * True when this ends a turn whose prompt was answered INSIDE a
       * continuation — the CLI emitted no result of its own for it, so the turn
       * settles on the continuation's (see `spawn-cli`'s
       * `answeredByContinuation`). Set by `spawn-cli` alone.
       *
       * Persisted on the row, because the row is not the turn's only record:
       * the continuation's own `insideTurn` row, written a moment earlier,
       * already carries the turn's duration and cost. Without the flag a client
       * draws BOTH as finished turns — REPORTED as a doubled footer,
       * `✓ done · 9m 44s · $5.08` directly over `✓ done · 0s`, on run
       * `74a134dd` (rows 4810 and 4811, 4ms apart).
       */
      answeredByContinuation?: boolean;
    }
  | {
      type: 'turn_cancelled';
      /**
       * What the stopped turn spent, when the CLI said — carried over from the
       * failure its interrupt produced (`spawn-cli`'s cancel normalization).
       * The CLI's ledger has moved past it by then, so this is the only record.
       */
      usage?: AgentUsage;
    }
  | {
      /**
       * The CLI no longer needs the answer to a request it raised — it has
       * WITHDRAWN it, so a verdict can no longer reach anything.
       *
       * Turn plumbing first: `spawn-cli` retires the request from every place
       * it holds one (the turn's outstanding map, the between-turn hold, the
       * owner's off-turn cards), so the silence deadline stops being suspended
       * for a request nobody is blocked on and nothing re-offers it to the next
       * turn. It is FORWARDED only when a card for it could be on screen — the
       * owner's to retire — and never for an id nothing here was holding (a
       * request already answered, or a control request that was never an
       * approval at all).
       *
       * claude's is the `control_cancel_request` envelope,
       * `{type, request_id}`, which 2.1.280 writes when a `can_use_tool`
       * request's abort fires ("the sender no longer needs the answer to one of
       * its own in-flight control_requests", from its own schema).
       */
      type: 'approval_withdrawn';
      id: string;
    }
  | {
      /**
       * Follow-ups the driver accepted (`sendFollowUp` answered true, so the
       * owner already wrote their rows) that will now never reach the agent —
       * the turn they were addressed to ended first, typically by a Stop.
       * Carries the `FollowUpMessage.deliveryId`s it was given, oldest first.
       */
      type: 'follow_up_dropped';
      deliveryIds: string[];
      /**
       * What the CLI said when it REFUSED the messages (a codex `turn/steer`
       * error), quoted to the user. Absent when the turn simply ended first.
       */
      reason?: string;
    }
  | {
      type: 'error';
      message: string;
      recovery?: AgentErrorRecovery;
      /**
       * What the FAILED turn spent, when its CLI reported it. A turn that ends
       * in an error has still done its work — claude's result line carries
       * `total_cost_usd` and `usage` whatever `is_error` says, and a session
       * limit hit after 400 tool calls is tens of dollars — so dropping it left
       * that money out of every total and out of Stats. Absent when nothing was
       * measured; readers take it from the row exactly as `turn_complete`'s.
       */
      usage?: AgentUsage;
      /** See {@link AgentErrorDetail} — absent when the CLI reported nothing. */
      detail?: AgentErrorDetail;
      /**
       * True when this FAILS a turn the CLI opened by itself — the error twin
       * of `turn_complete.continuation`, and routed around a turn geniro
       * started on the same terms. Claude 2.1.280 stamps `origin` on every
       * result variant (its query loop spreads one common block carrying
       * `origin` into the success, `error_during_execution`,
       * `error_max_turns` and `error_max_budget_usd` results alike), so a
       * continuation that FAILS says so as plainly as one that succeeds —
       * and ending the user's turn on it failed a turn that had not run yet.
       */
      continuation?: boolean;
      /**
       * `turn_complete.insideTurn`'s twin: stamped by `spawn-cli` alone when a
       * continuation's failure arrived while a turn geniro started was still
       * owed its answer, so the row ended nothing. The renderer reads it for
       * every terminal kind (`endsRunTurn` in `settled-status.ts`).
       */
      insideTurn?: boolean;
    }
  | { type: 'session'; sessionId: string }
  | {
      /**
       * A notice about THIS turn, persisted as a `system` transcript item so it
       * is visible to the user rather than silent. NOT terminal: the turn
       * continues after one.
       *
       * Two kinds of text arrive here, and {@link origin} is what tells them
       * apart. The default is an ADAPTER-level advisory the daemon itself wrote
       * — a capability the CLI did not grant, a request that degraded — which
       * the renderer is right to surface like an error. The other is text the
       * CLI produced, which is not an advisory at all and must not be dressed as
       * one.
       */
      type: 'notice';
      message: string;
      /**
       * Who wrote {@link message}. Absent means the daemon did, which is the
       * historical case and the one every existing producer means.
       *
       * `cli` marks text the AGENT produced and geniro is only relaying —
       * claude's own compaction summary is the first. It matters for two
       * reasons. Presentationally, that text is informational prose, and
       * rendering it in the daemon's failure chrome told the user geniro was
       * reporting a problem when it was relaying a summary. And as a trust
       * boundary: the summary describes a conversation that can contain file
       * contents, command output and web pages, so it is UNTRUSTED content
       * which must not be able to impersonate an application-level advisory.
       */
      origin?: 'cli';
      /**
       * How loud the daemon's own notice should be. Absent means the failure
       * chrome, which is the historical case for every producer that names no
       * severity.
       *
       * `info` exists for the daemon notices that are not advisories about
       * something going wrong — the one that says a request the CLI raised
       * between turns was KEPT for the user rather than answered on their
       * behalf. That is the machinery working, and rendering it in the failure
       * chrome got it reported as an error the user "still sees sometimes":
       * red, capitalised SYSTEM, two lines of explanation, directly above the
       * card it is pointing at. Nothing was wrong, so nothing should look it.
       *
       * `warning` is the middle the same report asked for from the other side:
       * a setting the user CHOSE did not apply, so it cannot be quiet — but the
       * turn ran, so red is a lie about what happened ("a strange error … and
       * then it carried on working"). It is the level for a DEGRADE the user
       * can act on: a model that has no `max` effort, a mode the agent does not
       * offer. Keeping it distinct from the absent case is the point — a
       * producer that has not thought about volume still gets the loud one.
       *
       * Meaningless beside `origin: 'cli'` and ignored there — relayed agent
       * text is never an advisory at any volume, and letting it choose its own
       * severity is exactly the impersonation `origin` exists to prevent.
       */
      severity?: 'info' | 'warning';
      /**
       * What KIND of notice this is, in two or three words — the row's caption,
       * where the reader learns what they are looking at before reading the
       * sentence.
       *
       * Absent takes the renderer's default for the severity, which is what
       * every historical producer means. It exists because that default is a
       * SENTENCE about one case: a `warning` is captioned `not applied`, which
       * is true of the degrades the level was added for (an effort the model
       * does not offer) and false of the other thing that is loud-but-not-fatal
       * — a request that FAILED and was retried. One default phrase for a whole
       * severity is how the second producer comes to file its row under the
       * first's explanation.
       *
       * Meaningless beside `origin: 'cli'` and dropped there, by the same rule
       * as {@link severity}: relayed agent text is not an advisory, so it does
       * not get to caption itself as one.
       */
      caption?: string;
    }
  | {
      /**
       * WHAT a background sub-agent of this turn IS, announced by the CLI apart
       * from the tool call that launched it.
       *
       * For a CLI whose delegates stream their own work (claude), the launching
       * tool call's arguments already carry the description, the prompt and the
       * type, and no adapter needs this. It exists for the other shape, measured
       * on `cursor-agent acp`: the `task` tool call opens with `rawInput` holding
       * nothing but the tool's own name, and the delegate's brief arrives later
       * on a separate channel (`cursor/task`) — so without a row of its own,
       * everything the CLI says about its delegate is discarded.
       *
       * {@link id} is the LAUNCHING TOOL CALL's id, which is what joins this
       * announcement to the row that started the delegate. Deliberately in the
       * body rather than as {@link AgentEventOrigin.parentToolUseId}: that field
       * means "the delegate PRODUCED this row", and this row is one ABOUT the
       * delegate, written by the main thread. Conflating them would fold the
       * announcement into the delegate's own thread as an invisible entry, which
       * is precisely what makes "did this delegate do anything?" unanswerable.
       *
       * Emitted more than once per delegate BY DESIGN — once when the launch is
       * recognised (anchor only, so the block can open while the delegate is
       * still working) and again when the facts arrive. Every field is nullable
       * for that reason, and the consumer merges by preferring the last non-null
       * value it saw.
       */
      type: 'subagent_info';
      /** The launching tool call's id. */
      id: string;
      /** One-line description of the delegated task, as the CLI named it. */
      label: string | null;
      /** What the delegate was asked to BE — the CLI's own type/role name. */
      kind: string | null;
      /** The full brief the delegate was given. */
      prompt: string | null;
      /** The model it ran, when the CLI names one. */
      model: string | null;
      /** How long it took, when the CLI reports it. */
      durationMs: number | null;
      /**
       * How many tokens the delegate spent, and how many tools it called, when
       * the CLI reports them — {@link BackgroundUnitUsage}.
       *
       * No CLI states a delegate's cost, and {@link costUsd} is derived rather
       * than read. Re-probed on claude 2.1.251 across every channel that says
       * anything about a delegate: `task_started`, `task_updated` and
       * `task_notification` carry no money, the delegate's own sidechain JSONL
       * holds none, and the turn's `result` line prices the whole turn — its
       * `modelUsage[model].costUSD` covers the main thread and every delegate
       * together, with no way to split it.
       */
      tokens: number | null;
      toolUses: number | null;
      /**
       * The four token kinds BILLING distinguishes, when the CLI breaks the
       * delegate's spend down that far — the launching call's `tool_use_result`
       * does (`resolvedModel` plus an `input`/`output`/`cache_read`/
       * `cache_creation` split), while `task_notification` reports only the
       * {@link tokens} roll-up.
       *
       * They are separate from {@link tokens} rather than replacing it because
       * the two arrive on different channels at different moments, and the
       * merge rule (last non-null per field) is what lets a delegate be
       * described by both without either blanking the other.
       */
      inputTokens: number | null;
      outputTokens: number | null;
      cacheReadTokens: number | null;
      cacheCreationTokens: number | null;
      /**
       * What this delegate cost, in dollars — DERIVED, and the only figure on
       * this event that no CLI ever stated.
       *
       * Priced from {@link inputTokens} and its three siblings at the list rate
       * for {@link model}, then multiplied by a factor solved from the same
       * turn's `result` line — what the CLI actually charged for that model over
       * what this app's table says it should have. See
       * `utils/claude-delegate-cost.utils.ts` for why the split cannot be done
       * by token share (the four kinds price 12.5x apart) and why the list table
       * alone is not enough (a model's rate doubles above the 200k boundary and
       * nothing on the wire says where a turn fell).
       *
       * Null whenever any leg of that is missing — no breakdown, an unpriced
       * model, or a calibration factor outside its believable band. A consumer
       * must render the absence as "not shown", never as a free delegate.
       */
      costUsd: number | null;
      /**
       * {@link costUsd} at the list rate alone, for a delegate no `result` line
       * has calibrated yet. Absent on rows written before it existed.
       */
      estimatedCostUsd?: number | null;
      /**
       * Model requests the delegate made — one per response, however many
       * stream lines a response was split into.
       */
      requests?: number | null;
      /** The four token kinds of the delegate's LATEST request, summed. */
      contextTokens?: number | null;
      /**
       * Present when {@link tokens} and the four kinds sum EVERY request the
       * delegate made. Rows written before it describe the last request only,
       * which is what the renderer tells them apart by.
       */
      cumulative?: true;
      /**
       * {@link AdapterConfig.subagents.stepsUnavailableReason} — why this
       * delegate's own conversation is absent. Null for a CLI that streams it.
       */
      stepsUnavailableReason: string | null;
      /**
       * HOW this delegate ended, when the CLI said — {@link
       * BackgroundUnitOutcome}, `null` while it is still out or when the CLI
       * reports only THAT the work is over.
       *
       * A settle on its own says only that the work is no longer open, which
       * is not the same as success — so absent must read as "nothing was
       * said", never as `completed`.
       */
      backgroundOutcome: BackgroundUnitOutcome | null;
      /**
       * Whether this delegate is still working in the BACKGROUND — `true` while
       * it is out, `false` once the CLI reports it done, `null` when nothing has
       * been said either way.
       *
       * The three states are load-bearing, because the usual end-of-delegate
       * signal is the launching tool call RETURNING, and a fire-and-forget
       * delegate returns at once: measured on claude 2.1.232, a turn told not to
       * wait got its `Task` result back in under a second while the delegate ran
       * on for a further 50, so the transcript closed its block and the app
       * reported no delegates working while three were. `null` therefore has to
       * mean "no claim" rather than "not running" — every other producer emits
       * nothing here and keeps the old reading, where the tool result is the end.
       */
      backgroundOpen: boolean | null;
      /** The child conversation identity, when this CLI exposes one. */
      subagentSessionId?: string;
      /** Internal recovery metadata; the renderer does not interpret it. */
      recovery?: SubagentRecoveryRef | null;
      /**
       * On an `untracked` close the daemon wrote: `process-ended` when the
       * process hosting the delegate is gone, so its work is over and only its
       * outcome is unknown. Absent when tracking was lost while it may still run.
       */
      trackingLost?: SubagentTrackingLost;
    }
  | {
      /**
       * A background SHELL the CLI started or finished — the delegate
       * announcement's twin, for the units on that same channel that are not
       * delegates.
       *
       * It exists because a detached command's launching tool call returns
       * INSTANTLY (`Command running in background with ID: …`) and the command
       * then runs for minutes. That leaves the transcript with no end signal at
       * all: measured on claude 2.1.237, a 45-second `sleep` reported its
       * completion to the MODEL as a `system/task_notification` frame and to
       * the conversation as an ordinary sentence the agent wrote — so a client
       * folding "what is running" out of tool calls alone lists it forever, and
       * the count climbs all session. The frames were already parsed here (see
       * `background_work`) and thrown away for want of anywhere to put them.
       *
       * A ROW rather than a live signal, on the same rule as `task_list`: a
       * reopened chat replays the transcript, so an ephemeral end would leave
       * every past background command listed as running again.
       *
       * Announced only on the SETTLE. The start is already in the transcript as
       * the tool call itself, and a second row saying so would double every
       * background command for nothing.
       */
      type: 'shell_info';
      /**
       * The tool call that launched it, when the CLI ties one to the unit —
       * which is what joins this to the shell already in the transcript.
       *
       * Null when only the CLI's own work id is known: a settle names the call
       * on one of the two channels and not the other, and a session that
       * resumed after the launch never saw the `started` that would have paired
       * them. The consumer then matches on {@link workId} instead, which is why
       * both ride every announcement.
       */
      toolCallId: string | null;
      /** The CLI's own id for the unit (claude's `task_id`, e.g. `bash_1`). */
      workId: string;
      /** How it ended, for a command the daemon itself found ended. */
      ending?: CommandEnding;
    }
  | {
      /**
       * WHAT a dynamic workflow launched from this turn is doing — how many
       * agents it has out, what they are spending, and how far through its
       * phases it is.
       *
       * A workflow is one tool call that fans out into dozens of agents the
       * main stream never sees: they run inside the CLI's own orchestrator with
       * their own transcripts, so nothing about them reaches the conversation.
       * Without this the transcript can only say `running Workflow · 20m 34s` —
       * an opaque row for what is usually the most expensive thing in the chat.
       *
       * Probed live on claude 2.1.251 (`-p --output-format stream-json
       * --verbose`, a two-agent script). The launch announces itself as
       * `system/task_started` with `task_type:'local_workflow'` and carries the
       * workflow's NAME; progress arrives as `system/task_progress` on the same
       * `tool_use_id`, carrying the running totals every time and the full agent
       * roster whenever one of them changes state (and at most every 10s
       * otherwise — the CLI's own throttle).
       *
       * {@link id} is the LAUNCHING TOOL CALL's id, on exactly the rule
       * `subagent_info` follows: this is a row ABOUT the workflow written by the
       * main thread, never one the workflow produced, so it must not travel as
       * {@link AgentEventOrigin.parentToolUseId}.
       *
       * Emitted many times per workflow BY DESIGN — an anchor at launch and a
       * row per roster change after it — so every field is nullable and the
       * consumer prefers the last non-null value it saw. {@link agents} is the
       * one exception to the merge and is taken WHOLESALE when present: the CLI
       * re-sends the entire roster, so folding two snapshots would resurrect an
       * agent a later one had dropped.
       */
      type: 'workflow_info';
      /** The launching tool call's id. */
      id: string;
      /** The workflow's own name — its script's `meta.name`. */
      name: string | null;
      /** Its one-line description — the script's `meta.description`. */
      title: string | null;
      /** What it is doing right now, as the CLI phrases it: `Phase: label`. */
      activity: string | null;
      /** Every token its agents have spent so far, summed by the CLI. */
      tokens: number | null;
      /** Every tool call they have made. */
      toolUses: number | null;
      /** How long the workflow has been running. */
      durationMs: number | null;
      /** The whole roster as of this line, or null when it carried none. */
      agents: WorkflowAgentSnapshot[] | null;
    }
  | {
      /**
       * A detached command has STARTED — the opening half of `shell_info`.
       *
       * It is written as a durable `shell_open` row (`event-to-item.ts`), which
       * marks the launch as detached for the renderer and opens the background
       * stretch the workflow clock folds (`utils/active-spans.ts`). It also tells
       * the daemon that this run has a command out RIGHT NOW, so it can publish a
       * live count per run (`BackgroundWorkCounts`).
       *
       * That count exists because the renderer used to fold the same question
       * out of the OPEN thread's transcript, which is answerable for one run and
       * for no other: a settled chat with a `sleep` still out badged itself
       * `working` while it was selected and `completed` the moment it was not.
       *
       * It is announced from the same `background_work` bracket its close is
       * (`spawn-cli`'s `announceShellWork`), because that event is NOT forwarded
       * to the owner — the bracket is turn plumbing, and this is the projection
       * of it the owner is allowed to see.
       *
       * NOT part of `closesWork`, and the opposite of it: a launch is evidence
       * the agent is working, never that it has stopped.
       */
      type: 'shell_open';
      /** The tool call that launched it, when the CLI ties one to the unit. */
      toolCallId: string | null;
      /** The CLI's own id for the unit — what its {@link workId} close names. */
      workId: string;
    }
  | {
      /**
       * The agent's OWN task list moved — the todo list a coding CLI keeps for
       * itself while it works through a multi-step job.
       *
       * Every shipped CLI has one and each reports it differently, so this is
       * the normalized form all of them collapse to. What made it worth a
       * dedicated event rather than leaving it as the tool call it rides on:
       * the tool call says only that a tool NAMED something was invoked, and
       * cursor's carries no arguments at all (`rawInput:{_toolName:
       * "updateTodos"}`), so the list itself never reached the transcript.
       *
       * {@link mode} is the whole subtlety. Two of the three shapes measured
       * are PATCHES — they name only the rows that moved — so a consumer that
       * treats every announcement as the complete list shows one task where
       * there are seven. It is not inferred from the contents (a patch that
       * happens to name every row is indistinguishable from a snapshot); the
       * CLI says which it sent, and cursor says so literally (`merge`).
       */
      type: 'task_list';
      /**
       * `snapshot` — {@link tasks} IS the list now, and anything absent from it
       * is gone. `patch` — only the named rows moved; every other task stands
       * as it was.
       */
      mode: 'snapshot' | 'patch';
      tasks: AgentTask[];
      /**
       * The tool call this announcement belongs to, when the CLI ties one to
       * it — so the consumer can render the list INSTEAD of the opaque tool row
       * that produced it rather than beside it. Null when the CLI reports the
       * list without one.
       */
      toolCallId: string | null;
    }
  | {
      /**
       * A unit of BACKGROUND work this turn started, which the turn must
       * outlive — opened by `started`, closed by `settled`.
       *
       * Turn plumbing, not conversation: `runCliSession` consumes it and never
       * forwards it, so it is not an item and no consumer sees it.
       *
       * It exists because a CLI's turn-end line is not the end of its WORK.
       * Measured on claude 2.1.231: a `result` line arrives while a delegate the
       * turn launched is still running, and the CLI then runs FURTHER turns of
       * its own accord as each reports back (that continuation's own `result`
       * carries `origin: {kind:'task-notification'}`). Settling on the first
       * `result` therefore ends geniro's turn in the middle of the work — and
       * everything after it becomes a between-turn orphan: measured across the
       * author's own daemon log, 11 of 31 settles were followed by off-turn
       * work, up to 33 minutes and 997 events past the settle, including 227
       * whole assistant messages dropped and 430 permission requests answered
       * with no card ever shown. The run reported `completed` throughout.
       *
       * {@link id} is the CLI's own handle for that work, and only identity
       * matters: the set is keyed by it so a `settled` for something never
       * opened is a no-op and a duplicate `settled` cannot close a second one.
       * A CLI reporting the same unit on two channels (claude reports each of
       * its tasks on both `task_updated` and `task_notification`) is therefore
       * safe to map from both, which is what keeps a version that drops one of
       * them working.
       *
       * A CLI that reports no such lifecycle simply never emits this, and its
       * turns settle exactly as before — this is not a capability an adapter
       * has to declare, because the absence is indistinguishable from having no
       * background work.
       */
      type: 'background_work';
      /** The CLI's own id for this unit of work. */
      id: string;
      /**
       * `backgrounded` is a unit that started in the FOREGROUND (see
       * {@link foreground}) and has since been moved to the background — the
       * launching tool call returned and the work runs on without it. It
       * carries no kind (claude's `task_updated` patch restates none), so
       * `runCliSession` matches it against what the `started` recorded, the
       * same way a settle is matched. It is never a settle.
       */
      phase: 'started' | 'settled' | 'backgrounded';
      /**
       * The launching tool call is BLOCKING on this unit — a sub-agent the
       * agent waits for, or a long command it runs in the foreground. Only ever
       * on a `started`, and only when the CLI says so (claude's
       * `task_started.is_backgrounded === false`, read out of the 2.1.280
       * bundle's own schema: "in the foreground with the spawning tool call
       * blocking on it"). Absent reads as background, which is what every such
       * unit was taken to be before the CLI stated it.
       *
       * It exists because "out" means two different things to a user. A unit
       * the agent is WAITING on is the agent being busy — a message typed now
       * reaches it only when that tool call returns, so the composer queues it.
       * A unit it is NOT waiting on leaves the agent free, so the composer sends
       * straight in. Counting both as background work sent every message typed
       * during a sync sub-agent straight into a turn that could not read it for
       * minutes. So a foreground unit is announced to nobody as background work
       * (no `backgroundOpen: true`, no `shell_open`) until a `backgrounded`
       * says it has become some.
       */
      foreground?: true;
      /**
       * HOW it ended, on a `settled` — {@link BackgroundUnitOutcome}.
       *
       * Absent on a `started`, and absent on a settle from a CLI that reports
       * only that the work is over. The three states matter for the same reason
       * {@link AgentEvent} `subagent_info`'s `backgroundOpen` has three: absent
       * must read as "nothing was said", never as success, or a CLI with no
       * outcome vocabulary would have every delegate reported as having
       * completed.
       */
      outcome?: BackgroundUnitOutcome;
      /**
       * WHAT this unit is, when the CLI says — a delegate (`agent`) or anything
       * else it runs in the background (a shell command, an indexing pass).
       *
       * It exists because the two need different treatment downstream and only
       * the adapter can tell them apart: measured on claude 2.1.232, one turn's
       * `task_started` lines carried `task_type: 'local_agent'` for the delegate
       * AND `task_type: 'local_bash'` for the `sleep` that delegate then ran, on
       * the same channel. Counting the second as a sub-agent would report two
       * delegates where the user launched one.
       *
       * `'other'` is the safe default for a CLI that says nothing, and what it
       * is safe ABOUT is the transcript: no phantom sub-agent is announced for
       * it. It no longer keeps the turn open either — only an `agent` unit does
       * (see `runCliSession`'s `trackBackgroundWork`) — so a CLI that starts
       * naming its delegates gains the hold along with the block, and one that
       * names nothing gets neither.
       */
      unit: 'agent' | 'other';
      /**
       * The unit was started BY a delegate rather than by the agent itself —
       * claude's `owned_by_subagent`, the only owner fact its `task_started`
       * line carries (read out of the 2.1.270 bundle: no parent id), or a
       * command a codex sub-agent runs. A delegate's own command belongs to
       * that delegate's block, not to the main thread's terminals, so
       * `runCliSession` announces nothing for it — but while it runs, it keeps
       * a bracketed delegate's `completed` settle from being announced.
       */
      ownedByDelegate?: true;
      /**
       * The tool call that launched it, when the CLI ties one to it — which is
       * what joins this unit to the sub-agent block already in the transcript,
       * since that block is keyed by exactly that id.
       *
       * Null on a settle whose channel omits it; the correlation is then done by
       * {@link id}, which is why `runCliSession` remembers the pair from the
       * `started` rather than expecting both ends to carry it.
       */
      toolCallId: string | null;
      /**
       * What this unit CONSUMED, when the CLI states it as the unit settles.
       *
       * Only ever on a `settled` phase — nothing is consumed before the work
       * runs — and only from a CLI whose settle channel carries it. Undefined
       * everywhere else, which reads the same as every field being null.
       *
       * It rides the lifecycle event rather than being read straight into a
       * `subagent_info` by the adapter for one reason: this channel carries
       * shell commands and a delegate's own sub-work alongside the delegates,
       * and only `runCliSession` knows which is which — it recorded the unit
       * kind from the `started`, and the settle line does not restate it. An
       * adapter announcing the figures itself would put a phantom sub-agent in
       * the transcript for every backgrounded `sleep`.
       */
      usage?: BackgroundUnitUsage;
      /** On a settle the daemon found itself: how the command ended. */
      ending?: CommandEnding;
    }
  | {
      /**
       * The turn is being HELD open: the CLI has finished talking, and geniro
       * is keeping the turn alive only until the background work it started
       * reports back.
       *
       * NOT produced by any adapter — `runCliSession` raises it, because it is
       * the only thing that knows the difference between "the agent is working"
       * and "the agent has stopped and we are waiting on its listeners". That
       * distinction is invisible from outside: `background_work` alone does not
       * imply the main thread has gone quiet (a delegate runs happily while its
       * parent keeps editing files), and the CLI's own turn-end line is
       * swallowed by the hold, so nothing downstream can see it arrive.
       *
       * It exists for two consumers that were both getting the state wrong.
       * The badge said "running Read" about a turn whose read had returned
       * minutes earlier; and the composer refused to send, holding the message
       * in the queue on the grounds that "the agent is working" — reported as
       * "if claude is running agents in background it's like it stopped to work
       * until it gets a notification from them… we should not send the message
       * to the queue while it's just waiting for listeners".
       */
      type: 'turn_held';
      /** How many units of background work are still outstanding. */
      open: number;
      /** What it waits on when that is a command rather than a sub-agent. */
      unit?: 'command';
    }
  | {
      /**
       * The CLI has begun a stretch of work of its own, with no turn of ours
       * open — woken by a background unit's report, at `at`: the later of that
       * report and the CLI's last result, or the stretch's first output when
       * nothing reported since it last went idle.
       *
       * NOT produced by any adapter — `runCliSession` raises it ahead of the
       * stretch's first output, because the CLI starts working on the report
       * well before it says anything, and its own duration counts from there.
       */
      type: 'off_turn_started';
      /** Epoch ms. */
      at: number;
    }
  | {
      /**
       * The CLI reported the session's invokable slash commands (claude's
       * `system/init` `slash_commands`: built-ins + plugin skills + user and
       * project skills/commands, shadowing already resolved — verified live
       * on 2.1.211; cursor's ACP `available_commands_update`, which carries a
       * description per entry). Captured into the skill-harvest store keyed by
       * the turn's cwd — never a transcript item.
       */
      type: 'slash_commands';
      commands: AgentReportedCommand[];
    }
  | {
      /**
       * The MCP servers the CLI had loaded for this turn, with the connection
       * status each was in when the turn began (claude's `system/init`
       * `mcp_servers` — verified live on 2.1.222). Captured into the
       * MCP-harvest store keyed by the turn's cwd and config directory — never
       * a transcript item.
       *
       * Reported because the ALTERNATIVE is a cold re-dial: asking a CLI for
       * its servers out of band starts every one of them to health-check it,
       * which is what made the panel take seconds. A turn already knows.
       *
       * A CLI with no such report simply never emits this — there is nothing
       * for an adapter to declare, because the harvest is an optimisation over
       * `listMcpServers`, never the only source.
       */
      type: 'mcp_servers';
      servers: AgentMcpServer[];
    }
  | {
      /**
       * The model this turn is actually running as, named by the CLI at
       * session start (claude's `system/init` `model` — verified live on
       * 2.1.220, where it reads `claude-opus-5[1m]`).
       *
       * Reported because the WINDOW is not: no line before the turn's `result`
       * carries one, so a run's first turn had nothing to scale its live
       * context figure against and fell back to an assumed 200k — which is
       * how a 1M-window model came to be shown measuring against a fifth of
       * its context. Naming the model is enough: the window learned when a
       * turn of that same model finished can be applied from the start.
       *
       * EPHEMERAL — never a transcript row. The durable record of what a turn
       * ran as is the run row itself.
       */
      type: 'turn_model';
      model: string;
    }
  | {
      /**
       * The CLI's own statement of whether it is working, for a CLI that makes
       * one (claude, under `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`). `idle` is
       * its authoritative turn-over: probed on claude 2.1.270, it is NOT sent
       * while a background agent the turn launched is still due to report, and
       * it is sent only after the continuation that report triggers has ended.
       * Consumed by `spawn-cli` to end a held turn without a timer.
       *
       * EPHEMERAL — never a transcript row.
       */
      type: 'session_state';
      idle: boolean;
    }
  | {
      /**
       * The CLI is compacting the conversation, or has finished doing so — it
       * summarises the history and carries on with a much smaller context.
       *
       * REPORTS BOTH ENDS, which it did not always. This arm used to say "the
       * past, never the present", on 2.1.226 evidence that only the
       * post-compaction boundary is serialised. On 2.1.227 that is no longer
       * true: the CLI emits `{"type":"system","subtype":"status",
       * "status":"compacting"}` when the work STARTS (see
       * `CLAUDE_COMPACTING_STATUS`). A compaction measured 46s in that probe,
       * so the interval this now names is exactly the one a user spent watching
       * an unexplained "Working…".
       *
       * Worth reporting at both ends because the alternative is a mystery: a
       * long unexplained pause, and then the context meter dropping by most of
       * the window between one request and the next.
       *
       * EPHEMERAL — never a transcript row, at either phase. A `system` item
       * saying "compacted" is housekeeping the user did not ask for in the
       * middle of the conversation they did. What DOES earn a row is the CLI's
       * own summary text and a compaction that FAILED, and both arrive as their
       * own lines rather than on this arm — except that a FINISHED compaction
       * no summary follows (every automatic one, on claude 2.1.266) gets a row
       * of its own from `CompactionRows`, since an agent silently forgetting
       * most of the conversation is not housekeeping the user can do without.
       */
      type: 'context_compacted';
      /**
       * Which end of the compaction this is, and how it ended.
       *
       * `started` and `failed` carry no token counts — nothing was dropped in
       * either case — so a consumer that renders numbers must read this first.
       * Required rather than optional: a consumer that ignored it would announce
       * a finished compaction the moment one began.
       *
       * `failed` exists because `started` puts up a PRESENT-TENSE state that
       * something has to take down. Only the success path emits a boundary, so
       * without a failure arm the phrase "compacting the conversation" outlived
       * a compaction the CLI had already declined — and a refusal is the common
       * case, since a short conversation answers `/compact` with "Not enough
       * messages to compact.".
       */
      phase: 'started' | 'finished' | 'failed';
      /** `auto` (the window filled) or `manual` (`/compact`); null if unstated. */
      trigger: string | null;
      /** Context size before the compaction, when the CLI reports it. */
      preTokens: number | null;
      /** Context size after it, when the CLI reports it. */
      postTokens: number | null;
    }
  | {
      /**
       * The CLI sent a control message on the stdin dialogue that this adapter
       * does not model, carrying the subtype it was.
       *
       * DIAGNOSTIC ONLY — never a transcript item, never delivered to a turn's
       * consumer: {@link AgentAdapter.start} logs it and drops it. It exists
       * because the mappers are pure module-scope functions that cannot log,
       * so an unmodelled subtype has to travel back to the caller AS DATA to
       * be visible at all. Before it, a control subtype we did not recognize
       * vanished into a bare `return []`.
       */
      type: 'unhandled_control';
      subtype: string;
    }
  | {
      /**
       * The CLI paused mid-turn asking permission for a tool call (`ask`
       * approval mode). The turn stays blocked until the verdict goes back via
       * `AgentTurnHandle.respondApproval(id, …)`.
       */
      type: 'approval_request';
      id: string;
      toolName: string;
      input: unknown;
      /**
       * The CLI flagged this request as a genuine USER QUESTION (claude sets
       * `requires_user_interaction` on AskUserQuestion), not a permission
       * check. The team executor routes flagged requests from call-initiated
       * turns to the caller (the M4 Q&A bridge) instead of auto-approving.
       */
      requiresUserInteraction?: boolean;
      /**
       * The request as the user's question CARD, set by the adapter when the
       * request is its own CLI's question tool — so nothing downstream reads a
       * CLI's question payload. Absent for a permission request, and for a
       * question whose payload read as none, which is then offered as one.
       */
      questions?: CardQuestion[];
      /**
       * The answers this CLI offers BESIDE a one-time Approve and Deny — "allow
       * for this session", "always allow" — each built by the adapter from
       * what its CLI put on THIS request, so the card offers only what the CLI
       * would honour. Absent or empty: the card is Approve/Deny alone.
       */
      options?: ApprovalOption[];
    };

/**
 * How long a CLI remembers an {@link ApprovalOption} once picked: for the rest
 * of this conversation's process (`session`), or past it, in the CLI's own
 * settings (`always`). A one-time answer is Approve/Deny and has no option.
 */
export type ApprovalOptionScope = 'session' | 'always';

/**
 * One remembering answer to a permission request, as the user's card draws it
 * and as the verdict names it back (`id`).
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx
 * `readApprovalOptions` reads `id`, `label`, `allow` and `scope` off the
 * `approval_request` row (`publicApprovalOptions` writes them there).
 */
export interface ApprovalOption {
  /** Unique within its request; what the card's verdict names. */
  id: string;
  /** The button's words — the adapter's, describing the option's real reach. */
  label: string;
  /** Whether picking it lets the tool call run. */
  allow: boolean;
  scope: ApprovalOptionScope;
  /**
   * What this adapter's encoder needs to answer with the option and cannot
   * re-read at verdict time (claude's permission rules ride the request, not
   * the reply). Adapter-private: never persisted, never sent to a client.
   */
  reply?: unknown;
}

/**
 * One option of a {@link CardQuestion}. `description` and `preview` are for
 * display alone — a verdict answers with labels.
 */
export interface CardQuestionOption {
  label: string;
  description: string | null;
  preview: string | null;
}

/**
 * One question as the user's card draws it: the ONE shape every CLI's question
 * payload is projected into by its own adapter (and geniro's own
 * `ask_user_question` into by the chat service), persisted on the
 * `approval_request` row as `questions`.
 *
 * TWIN PARSER: apps/ui/src/renderer/chats/approval-card.tsx `readQuestions`.
 */
export interface CardQuestion {
  question: string;
  header: string | null;
  options: CardQuestionOption[];
  multiSelect: boolean;
  /**
   * Present on a question whose answer is a SECRET — a password, a token. The
   * card masks the field and the verdict row records none of the answer, which
   * reaches the agent alone. Absent on every other question; set only where a
   * CLI marks one (codex's `isSecret`).
   */
  secret?: true;
}

/**
 * One image attached to a turn, as the adapters receive it: a path on disk
 * plus the media type the CLI must be told. Adapter-agnostic — how it reaches
 * the child (content block vs path in the prompt) is each adapter's business.
 */
export interface TurnImage {
  path: string;
  mediaType: string;
}

/**
 * A message the user sent while a turn was ALREADY running, for delivery into
 * that running turn rather than the next one.
 *
 * The same two fields a turn starts with, and deliberately no more: a follow-up
 * changes what the agent is asked, never how it runs. Model, approval mode,
 * cwd and the call surface all belong to the turn that is already in flight.
 */
export interface FollowUpMessage {
  text: string;
  images?: TurnImage[];
  /**
   * The owner's id for the row it wrote for this message, echoed back in
   * `follow_up_dropped` when the message never reaches the agent: an ACP turn
   * that ends before it went out, or a codex `turn/steer` codex refused. Not
   * `MessageDeliveryFailure.deliveryId`, which names a broker failure record.
   */
  deliveryId?: string;
  /**
   * The user confirmed giving up the sub-agents this message would cancel
   * ({@link TurnDriver.subagentsAFollowUpCancels}). Absent, a driver refuses
   * such a message and it stays queued.
   */
  cancelBackgroundWork?: boolean;
}

/**
 * Native model IDs retain the CLI's spelling. Local models carry an `ollama/`
 * prefix so the adapter can select their provider before passing the bare name.
 */
export interface AgentModel {
  id: string;
  label: string;
  resolvedModel?: string;
  /** Numeric window reported by the CLI; never inferred from a choice label. */
  contextTokens?: number;
  /** How this entry was obtained — the UI says so when it is not live. */
  source: 'cli' | 'builtin' | 'ollama';
  unavailableReason?: string;
}

/**
 * One reasoning-effort level a CLI accepts for a turn, as that CLI names it.
 *
 * `id` is passed through verbatim — the flag's vocabulary belongs to the CLI,
 * and only its adapter knows which spellings it honours. `label` is what the
 * picker shows.
 */
export interface AgentEffort {
  id: string;
  label: string;
}

/**
 * The effort levels available for ONE model, and the reason when there are none.
 *
 * Per model rather than per CLI, because that is what the CLIs turned out to
 * be — measured on cursor-agent 2026.08.11-e8db854, `claude-opus-5` takes
 * `max` and `grok-4.6` does not, while `auto-smart` and `composer-2.5` have no
 * effort axis whatever. A CLI-wide list therefore OFFERS values a given model
 * refuses, which is exactly what got reported: a chat on Grok, its effort chip
 * remembering `max` from an Opus run, opening every turn with a declined
 * setting.
 *
 * `unavailableReason` is a SENTENCE and must be non-null whenever `efforts` is
 * empty — the same contract `AdapterConfig.effortsUnavailableReason` carries,
 * for the same reason: a picker that simply disappears is indistinguishable
 * from one that is broken.
 */
export interface AgentEffortListing {
  efforts: AgentEffort[];
  unavailableReason: string | null;
  /**
   * True when this is the NAMED MODEL's own answer; false when it is the
   * CLI-wide superset standing in for one.
   *
   * A picker treats the two alike — rows are rows, and the union is a decent
   * stand-in. A REFUSAL cannot: the union omits levels a given model really
   * offers (`gpt-5.2`'s `extra-high` is absent from cursor's), so refusing on
   * it rejects a level the picker had just shown. The distinction is only
   * visible here, because every fallback in this contract RESOLVES with the
   * superset rather than throwing — a caller watching for a rejection sees a
   * successful listing and cannot tell the two apart.
   */
  exact: boolean;
}

/**
 * One context-window size a model can be run at, as that CLI names it.
 *
 * The same shape as {@link AgentEffort} and for the same reason: `id` is the
 * CLI's own vocabulary, passed through verbatim (`300k`, `1m`, `272k`), and
 * `label` is what the picker shows. Deliberately NOT a token count — geniro
 * does not translate the CLI's word into a number, because the number that
 * matters is the one the agent then reports about its own window, and a table
 * here would be a second answer to that question with nothing keeping it true.
 */
export interface AgentContextWindow {
  id: string;
  label: string;
}

/**
 * The window sizes available for ONE model, and the reason when there are none.
 *
 * Per model, necessarily: probed 2026-08-21 on cursor-agent 2026.08.11-e8db854
 * across all 34 models the account offers, twelve carry the setting and their
 * vocabularies differ — `claude-opus-5` is `300k|1m`, `gpt-5.5` is `272k|1m`,
 * `claude-sonnet-4-6` is `200k|1m` — while the other twenty-two have no such
 * axis at all. So a CLI-wide list would offer sizes a given model refuses,
 * which is the defect `AgentEffortListing` already carries the scars of.
 *
 * `unavailableReason` obeys the same contract as the effort listing's: a
 * SENTENCE whenever the list is empty, because a picker that silently
 * disappears is indistinguishable from a broken one.
 */
/**
 * Which kind of "no sizes to choose from" a listing is reporting.
 *
 * `no-model` is the one that behaves differently downstream: nothing has been
 * asked yet, so a control claiming anything about the model's window would be
 * stating a fact about a model nobody has picked. The other three all mean the
 * turn really does run at exactly one window — this CLI has no such axis, this
 * MODEL offers no choice of its own, or the CLI could not be asked and its own
 * answer is unknown.
 *
 * `fixed-window` was briefly deleted, on the reading that cursor's models
 * without a `context` parameter had a second window after all. They do, and it
 * is not a CHOICE: cursor's Max Mode option is on unless the user turned it
 * off, so such a model runs at its largest window with nothing to pick
 * between. The kind is back, and its sentence now names which window
 * that is instead of leaving it unstated.
 *
 * An ENUM rather than the sentence: the reason prose is what a user reads, and
 * a consumer that has to recognise a specific case by matching those words
 * silently changes behaviour the moment the wording is improved.
 */
export type AgentContextWindowUnavailableKind =
  'no-model' | 'no-axis' | 'fixed-window' | 'unreadable';

export interface AgentContextWindowListing {
  windows: AgentContextWindow[];
  unavailableReason: string | null;
  /** Which case {@link unavailableReason} describes; null when sizes are offered. */
  unavailableKind: AgentContextWindowUnavailableKind | null;
  /** True when this is the NAMED MODEL's own answer — see {@link AgentEffortListing.exact}. */
  exact: boolean;
}

/**
 * One setting of a model that geniro has NO dedicated control for, carried
 * exactly as the CLI enumerated it.
 *
 * The two axes above are the ones geniro gave a control of its own, because
 * both mean something in every CLI's vocabulary. They are not the only ones a
 * CLI has. Probed 2026-08-26 on cursor-agent 2026.08.11-e8db854, one seeded
 * handshake per model, reading every `configOptions` entry rather than the two
 * this app knew to look for:
 *
 * - `auto-smart`    → `optimize_for` = intelligence | balanced | cost
 * - `claude-opus-5` → `thinking` = false | true, `fast` = false | true
 * - `gpt-5.6-sol`   → `fast` = false | true
 * - `kimi-k3`, `gemini-3.1-pro` → none beyond what is already surfaced
 *
 * Three axes invisible in the app, and `optimize_for` is the one that was
 * REPORTED ("у курсора есть дефолтный модуль, и мы можем выбрать тип этого
 * дефолтного модуля"). Giving each its own end-to-end stack — service, route,
 * wire type, run column, chip — would have been the third and fourth copies of
 * one mechanism, and the next parameter the CLI adds would need a fifth. So
 * nothing here interprets: an id, a label, its values and whatever the CLI says
 * is current, passed through to a chip that renders whatever it is handed.
 *
 * Which parameters reach this list is the ADAPTER's decision, and it is a
 * subtraction rather than an allowlist — everything the CLI enumerated, minus
 * what geniro already drives through a control of its own. An allowlist would
 * mean a parameter Cursor ships next month stays invisible until someone here
 * notices it, which is the failure this shape exists to end.
 */
export interface AgentModelParameter {
  /** The CLI's own id — what a turn sets, never translated. */
  id: string;
  /** The CLI's own display name; falls back to {@link id} when it names none. */
  label: string;
  /** The values it accepts, in the CLI's own order. */
  values: AgentModelParameterValue[];
  /**
   * The value the CLI reports the model is currently on, when it says.
   *
   * Shown as the chip's own default, so a run that has chosen nothing still
   * reads as what will actually happen. Null when the reply named none.
   */
  current: string | null;
}

/** One accepted value of an {@link AgentModelParameter}. */
export interface AgentModelParameterValue {
  id: string;
  label: string;
  /** What picking it does, in the CLI's own words. */
  description?: string;
}

/**
 * Every {@link AgentModelParameter} of ONE model, and the reason when there are
 * none.
 *
 * `unavailableReason` obeys the contract the two listings above already do — a
 * SENTENCE whenever the list is empty. The difference is what the consumer does
 * with it: there is no chip to hang it on, because with no parameters there is
 * nothing to draw at all, so it exists for the log and for a caller that wants
 * to say why rather than for a control.
 */
export interface AgentModelParameterListing {
  parameters: AgentModelParameter[];
  unavailableReason: string | null;
  /** True when this is the NAMED MODEL's own answer — see {@link AgentEffortListing.exact}. */
  exact: boolean;
}

/**
 * One skill / slash command a CLI can be invoked with (`/name …`).
 *
 * `kind` separates a skill directory from a plain command file; `source` says
 * where it was found — the project folder, the user's home dir, `cli` when the
 * CLI itself reported it rather than the disk scan finding it, or `geniro` for
 * one this application adds (see {@link AgentGeniroCommand}).
 */
export interface AgentSkillEntry {
  name: string;
  description: string | null;
  kind: 'skill' | 'command';
  source: 'geniro' | 'project' | 'user' | 'cli';
}

/**
 * One slash command a CLI reports it can run in a session — the normalized
 * shape behind the `slash_commands` event and the skill harvest.
 *
 * A pair rather than a bare name, because a CLI that has no on-disk convention
 * geniro can scan may still SAY what each command does, and that sentence is
 * the whole value of an autocomplete row: cursor-agent's ACP
 * `available_commands_update` carries `{name, description}` for every entry it
 * reports (27 of them here on 2026.08.11-e8db854), and reading only the name
 * left every cursor row in the composer's `/` popup a bare word — reported as
 * having no hints for that CLI's skills at all.
 *
 * `description` is null for a CLI that names its commands and nothing more —
 * claude's `system/init` `slash_commands` is an array of plain strings — and
 * for that CLI the sentence comes from the disk scan instead, which is why the
 * two sources are merged rather than one chosen.
 */
export interface AgentReportedCommand {
  name: string;
  description: string | null;
}

/**
 * One slash command **geniro itself** provides for a CLI — a command that
 * exists only inside this application, offered beside that CLI's own.
 *
 * It exists because a capability can be real in a CLI's interactive shell and
 * absent from the transport geniro drives. Compaction is the case that forced
 * it: cursor-agent's `/summarize` is a command of its TUI, which sends its own
 * `summarizeAction` over that vendor's private stream — its ACP server
 * advertises only `copy-request-id` plus the commands on disk, and
 * `handleSlashCommand` runs exactly one of them locally. So `/summarize` typed
 * into a geniro chat reached the model as prose and was answered as prose,
 * which is what got reported. The Agent Client Protocol has no compaction
 * method at all (agentclientprotocol discussion #871 is open on exactly this),
 * so there is nothing to wait for on the wire.
 *
 * Declared HERE, per CLI, rather than as a list somewhere central: whether a
 * geniro command is offered at all — and what it costs when it runs — is a fact
 * about that CLI, which is the one rule of `.claude/rules/agent-adapters.md`.
 * The same `/compact` therefore means "the CLI compacts its own history" on
 * claude and "geniro compacts it for you" on cursor, with neither consumer
 * branching on which.
 *
 * The name is RESERVED: `SkillsService` lists these first and the chat service
 * dispatches by name, so a scanned skill of the same name cannot shadow one
 * here — the popup and the behaviour would otherwise disagree.
 */
export interface AgentGeniroCommand {
  /** What the user types after `/`. */
  readonly name: string;
  /** The sentence beside the name in the composer's popup. */
  readonly description: string;
  /**
   * The text this CLI actually receives for the turn — its own slash command
   * verbatim where it has one, geniro's own instruction where it does not.
   *
   * The transcript still records what the USER typed: the rewrite is what the
   * agent is asked, not what the conversation says was asked.
   */
  readonly prompt: string;
  /**
   * Whether the turn's answer REPLACES the CLI's own conversation: its session
   * is dropped once the turn settles and the answer is carried into the next
   * one as context.
   *
   * False for a CLI that compacts its own history and keeps its session, where
   * geniro must change nothing — dropping claude's session after its `/compact`
   * would throw away the very history the CLI had just summarised for itself.
   */
  readonly replacesSession: boolean;
}

/**
 * Where one MCP change reaches — see `AdapterConfig.mcp.changeReach`.
 *
 * `where`: only the folder it was made in, every folder of the same repository
 * (`AgentAdapter.mcpRepositoryKey` says which repository a folder belongs to),
 * or every folder. `perProfile`: whether only sessions under the same config
 * directory are reached — false for a CLI that keeps the state outside any
 * profile.
 */
export interface McpChangeReach {
  readonly where: 'folder' | 'repository' | 'everywhere';
  readonly perProfile: boolean;
}

/**
 * Health of one MCP server as the CLI itself reports it.
 *
 * `unknown` is for a row that IS recognisably a row but whose health wording
 * this parser does not know — these rows come out of human-readable CLI
 * output, so a reworded release must not throw.
 *
 * An unrecognised status must cost the BADGE, never the row, in every parser:
 * a server the user cannot see is worse than one whose health is unreadable,
 * and a parser that drops what it cannot read can only announce that when
 * EVERY row drops — a partly unfamiliar listing would otherwise return the
 * rows it understood and silently deny the rest. The CALLER still has to turn
 * "nothing parsed, and no empty-folder sentence" into a stated failure; a
 * listing may never degrade into a confident "this folder has none".
 *
 * `pending` is a server that is configured but deliberately not connected to —
 * claude's unapproved `.mcp.json`, cursor's `not loaded (needs approval)`. Read
 * out of cursor's own bundle on 2026.08.11-e8db854, its condition is exact: the
 * server is defined in the PROJECT's `.cursor/mcp.json` and its approval key is
 * not yet in that project's `mcp-approvals.json`, so a user-scope server can
 * never be `pending` there. It is the second status with an ACTION attached —
 * see `AdapterConfig.mcp.approveUnavailableReason` — because approving is a
 * command on one CLI and an interactive screen on the other.
 *
 * `loading` is a server the CLI is still connecting to at the moment it
 * answered. It is a MOMENT, not a state of the configuration: ask again and it
 * becomes `connected` or `failed`. It has its own arm because without one it
 * degraded to `unknown`, which reads as "this row's health is unreadable" — a
 * claim about the parser — where the truth is that the CLI told us plainly and
 * the answer simply is not in yet.
 *
 * `disabled` is one the user switched off in the CLI's own configuration, which
 * geniro cannot undo (cursor's `mcp disable`); it is distinct from the wire's
 * `disabled` flag, which also covers servers geniro itself suppressed.
 *
 * `needs_auth` is an OAuth server the CLI has no stored credentials for. It is
 * NOT a failure and must not read as one: nothing is broken, the user has
 * simply never signed in, and the fix is one command rather than a
 * configuration hunt. It earned its own arm because it is the only status with
 * an ACTION attached — see `AdapterConfig.mcp.loginArgs`. Folded into `failed`
 * it would have been listed among things to debug; left as `unknown` (where the
 * missing marker put it, probe-verified on claude 2.1.223) the row said nothing
 * at all and offered nothing to do.
 */
export type AgentMcpServerStatus =
  | 'connected'
  | 'failed'
  | 'pending'
  | 'loading'
  | 'disabled'
  | 'needs_auth'
  | 'unknown';

/**
 * One MCP server a CLI agent loads in a given working directory.
 *
 * The set is per-CLI AND per-folder: a CLI resolves project-scoped servers
 * relative to the directory it runs in, so the same agent answers differently
 * in two folders and two agents answer differently in one.
 */
export interface AgentMcpServer {
  name: string;
  /**
   * The command line or URL the CLI reaches the server through, or null when
   * the CLI does not say.
   *
   * Nullable because not every CLI reports it: claude prints
   * `sentry: node s.js - √ Connected`, cursor prints `sentry: ready` and
   * nothing more (probe-verified on 2026.07.23-e383d2b). Reading the CLI's own
   * config file to fill the gap is out of scope — the CLI is the source of
   * truth here, for both agents alike — so null is the honest answer. An empty
   * string would have asserted a command that was never reported, which is the
   * empty-vs-unknown collapse the discriminated result below exists to prevent.
   */
  target: string | null;
  /** Null for the same reason as {@link AgentMcpServer.target}. */
  transport: 'stdio' | 'http' | 'sse' | null;
  status: AgentMcpServerStatus;
  /**
   * The failure reason, or what the server is waiting for — whatever the CLI
   * printed after the status. Null when the status says everything.
   */
  detail: string | null;
  /**
   * How many tools the server offers the agent, when the CLI reported its
   * catalog for a CONNECTED server; null (or absent) when it did not — a server
   * that is switched off or never started reports no tools, which is not the
   * same as having none. Only codex reports it today.
   */
  toolCount?: number | null;
  /**
   * The CLI plugin this server comes with, in the CLI's own spelling
   * (`browser@openai-bundled`), when it is a plugin's rather than the user's
   * own configuration. Absent/null for a server the user configured.
   */
  plugin?: string | null;
  /**
   * Why THIS row carries no switch, when the reason belongs to the row rather
   * than to the CLI — a server the CLI loads that is not in the config file
   * its switch writes (codex's built-in Apps server, a plugin's server). Wins
   * over `AdapterConfig.mcp.toggleUnavailableReason`'s null; absent leaves the
   * CLI-wide answer standing.
   */
  toggleUnavailableReason?: string | null;
  /**
   * Why THIS row cannot be signed in to from here, on the same terms as
   * {@link toggleUnavailableReason}: codex's Apps server authenticates with the
   * account codex itself is signed in to, and `codex mcp login` does not know
   * it by name.
   */
  signInUnavailableReason?: string | null;
  /**
   * Why THIS row cannot be switched off for one team member's turns
   * (`AgentTurnInput.mcpDisabled`), when the reason belongs to the row rather
   * than to the CLI — codex's plugin servers, which only the whole plugin
   * turns off. `AdapterConfig.mcp.turnToggleUnavailableReason` wins over it.
   */
  turnToggleUnavailableReason?: string | null;
}

/**
 * The outcome of asking one CLI for its MCP servers.
 *
 * Discriminated rather than a bare array because an empty array cannot say
 * WHY it is empty, and the three reasons need different words in front of the
 * user: the folder genuinely has none, this CLI has no listing at all, or the
 * CLI could not be reached just now. Collapsing them loses the only
 * distinction the panel exists to make — and, worse, lets a transient failure
 * be cached and shown as "no servers configured".
 *
 * Same shape as {@link TerminalCommandResult}, for the same reason: an adapter
 * reports its refusal as data and the owning module decides how to say it.
 */
export type AgentMcpListingResult =
  { ok: true; servers: AgentMcpServer[] } | { ok: false; reason: string };

/** Everything an adapter needs to list the MCP servers it would load. */
export interface AgentMcpServersInput {
  /**
   * The folder to list in, already validated and canonicalized.
   *
   * Which servers a folder contributes is the CLI's own business: for claude,
   * a project `.mcp.json` is visible ONLY from its own folder (probe-verified
   * on 2.1.220), so listing from a folder that has none yields the
   * folder-INDEPENDENT set — exactly what the team editor wants, since a
   * team has no folder until it runs.
   */
  cwd: string;
  /**
   * The agent config directory this listing is about, already validated and
   * canonicalized. Absent: list under the CLI's default profile.
   *
   * Part of the question, not a decoration: a CLI keeps its configured MCP
   * servers in that directory, so two profiles in one folder genuinely load
   * different sets — and a listing taken under the wrong one describes servers
   * the turn will never start.
   */
  configDir?: string | null;
}

/** Which ONE server's health is being asked about, and where. */
export interface AgentMcpServerHealthInput extends AgentMcpServersInput {
  /** The server's name, as the CLI's own listing spells it. */
  server: string;
}

/**
 * One conversation this CLI already holds on this machine, offered so the user
 * can carry it on inside geniro instead of only in their terminal.
 *
 * Deliberately four fields and no more: everything here has to be answerable by
 * BOTH a disk scan and a protocol call, since that is how the two shipped CLIs
 * differ (claude keeps a JSONL transcript per session; cursor answers ACP
 * `session/list`). A field only one of them can fill would render as a blank
 * column for the other rather than as a fact.
 */
export interface AgentSessionRecord {
  /**
   * The id this CLI resumes by — `claude --resume <id>`, ACP `session/load`.
   * Opaque here on purpose: only the adapter that produced it may interpret it.
   */
  id: string;
  /**
   * The folder the conversation ran in, or null when the CLI records none.
   *
   * Load-bearing rather than decorative: a resumed turn runs SOMEWHERE, and
   * running an agent's continuation in a different project than the one it was
   * reasoning about is how a resume produces confident nonsense. The importer
   * opens the new chat in this folder, so a session with none cannot be offered.
   */
  cwd: string | null;
  /**
   * One line naming the conversation, or null when nothing names it.
   *
   * The CLI's own title where it has one (cursor generates them), else the
   * opening prompt — which is why this is a plain string and not a "title"
   * with a separate "preview": a picker row can only show one line, and the
   * adapter is what knows which line its CLI can produce.
   */
  title: string | null;
  /** When it was last written, epoch ms; null when the CLI records none. */
  updatedAt: number | null;
  /**
   * The line of the conversation that answered the search, or null.
   *
   * Only ever set for a match found in the BODY rather than in the title or the
   * folder, and it exists because without it a content search is unreadable:
   * the row still shows the conversation's opening prompt, which has nothing to
   * do with the words that were typed, so a list of correct matches looks like
   * a list of irrelevant ones. Null when a query named nothing this session's
   * body had to answer for — the title or the path already says why it is here.
   */
  snippet: string | null;
}

/**
 * The answer to {@link AgentAdapter.listSessions} — the rows, and the reason
 * there are none.
 *
 * Same shape and same rule as the MCP listing: "this CLI holds no sessions" and
 * "this CLI cannot be asked" are both an empty array, and a reader that cannot
 * tell them apart either invents an explanation or branches on which CLI it is
 * holding. Only `sessions: []` with a NULL reason asserts that there is nothing
 * to resume.
 */
export interface AgentSessionListing {
  sessions: AgentSessionRecord[];
  unavailableReason: string | null;
  /**
   * What THIS listing did not reach, or null when it reached everything.
   *
   * The dynamic twin of `AdapterConfig.sessions.listingPartialReason`, which is
   * a standing fact about the CLI. This one is a fact about the call: a content
   * search is bounded in files and in bytes per file, so on a large profile it
   * genuinely stops short — and a search that quietly gives up looks exactly
   * like a search that found everything there was.
   */
  partialReason: string | null;
}

/** Everything an adapter needs to list the conversations it holds. */
export interface AgentSessionsInput {
  /**
   * Only sessions from this folder, or null for every folder the CLI
   * remembers. Canonicalized by the caller when present.
   */
  cwd: string | null;
  /**
   * The config directory to read, or null for the CLI's own default profile.
   *
   * Part of the question, exactly as it is for MCP servers: a CLI keeps its
   * conversations inside its profile, so a second account holds a different set
   * — and an id listed under one profile is not resumable under another.
   */
  configDir: string | null;
  /** Most rows to return, newest first. */
  limit: number;
  /**
   * What the user typed into the picker's search box, or null for none.
   *
   * Answered HERE rather than filtered by the caller, and that is the whole
   * point of it being on the input: only the adapter can reach what its CLI
   * actually stores, so only the adapter can match on what was SAID in a
   * conversation rather than on the one line the row happens to show. An
   * adapter that cannot reach the body still honours the query against the
   * title and the folder — every implementation must apply it, or a search
   * would silently widen back to everything on that CLI — and declares the
   * shortfall in `AdapterConfig.sessions.contentSearchUnavailableReason`.
   *
   * Whitespace-separated terms, ALL of which must match, each anywhere in the
   * session: that is how somebody actually remembers a thread from last week —
   * in fragments, one from the project and one from what was said.
   */
  query: string | null;
}

/** Which conversation is being taken over, and from where. */
/**
 * The exchange a conversation is to be NAMED from.
 *
 * The text rather than the run, because an adapter must not read this app's
 * database — and rather than a session id, because a CLI that has to be ASKED
 * for a title is one whose own store holds none.
 */
export interface AgentTitleInput {
  model?: string | null;
  /** What the user opened the conversation with. */
  opening: string;
  /** What the agent answered, when it has answered. */
  reply: string | null;
  /**
   * The conversation as it stands NOW — the newest exchange — or null on the
   * first ask, when it would only repeat {@link opening} and {@link reply}.
   *
   * The opening is not always nameable: measured on 2.1.237, a chat opened
   * with a bare Slack link is answered "I need to see the Slack thread to
   * understand what work you're asking about…", because there genuinely is
   * nothing in it to name. Re-asking with the same two messages reproduces the
   * same refusal, so a retry is worth making only if it carries what the
   * conversation has said since.
   */
  latest: string | null;
  /** The profile the run belongs to; null = the CLI's default. */
  configDir: string | null;
}

/**
 * A one-off question put to a CLI outside any conversation, answered in plain
 * text. `model` null takes the adapter's own cheap default.
 */
export interface AgentAskInput {
  prompt: string;
  model: string | null;
  /** The profile to ask under; null = the CLI's default. */
  configDir: string | null;
  /** As on {@link AgentTurnInput}; absent = the ask's own default. */
  effort?: string | null;
  contextWindow?: string | null;
  modelParameters?: Record<string, string> | null;
}

export interface AgentSessionImportInput {
  /** The id, as {@link AgentSessionRecord.id} spelled it. */
  sessionId: string;
  /** The profile it was listed under; null = the CLI's default. */
  configDir: string | null;
  /**
   * The folder the conversation ran in, as the listing reported it.
   *
   * Here rather than derived, because an adapter that reaches the CLI to do
   * this has to ROOT it somewhere: ACP's `session/load` takes a cwd, and
   * reading a conversation about one project while rooted in another is how a
   * resumed thread starts reasoning about the wrong tree.
   */
  cwd: string;
}

/**
 * A conversation read back out of a CLI's own record — the answer to
 * {@link AgentAdapter.readSessionHistory}.
 */
export interface AgentSessionHistory {
  /**
   * The events, OLDEST FIRST, in the same vocabulary a live turn produces — so
   * an imported transcript goes through the one `mapEventToItem` every other
   * row in the app already passes through, rather than a second row builder
   * that could render the same message differently.
   */
  events: AgentEvent[];
  /**
   * How many earlier rows were left out to honour the caller's limit; 0 when
   * the whole conversation is here.
   *
   * Stated rather than silent, on the rule the team executor's dropped
   * settings follow: a transcript that begins mid-conversation with nothing
   * saying so is a transcript that lies about what the agent was told.
   */
  droppedBefore: number;
}

/**
 * One server's health as the CLI just reported it — the answer to
 * `AgentAdapter.readMcpServerHealth`.
 *
 * Deliberately the same two fields a listed row carries, so a caller can drop
 * it straight onto a row rather than translating; `detail` is the CLI's own
 * sentence about the state, or null when it gave none.
 */
export interface AgentMcpServerHealth {
  status: AgentMcpServerStatus;
  detail: string | null;
}

/**
 * What a CLI's own config files say about a folder, beyond the health listing.
 *
 * They exist because the LISTING cannot answer either question: `claude mcp
 * list` reports a disabled server as though it were live, and prints no scope
 * at all (probe-verified on 2.1.220/2.1.222).
 */
export interface AgentMcpFolderFacts {
  /**
   * Every server name this folder's config DEFINES, across every scope — read
   * from the CLI's own files, so it costs no dial.
   *
   * It is what the panel shows while the dial is still running. Listing a
   * server means STARTING it (`claude mcp list` boots each one), measured here
   * at ~1.1s per server — 17s for a 15-server profile, 27s for a 47-server
   * one — and until this existed the panel had nothing to draw for that whole
   * stretch: a spinner over an empty box, which is indistinguishable from a
   * folder with no servers and from a read that died.
   *
   * Names ONLY, and that limit is the point: a name is knowable without
   * running anything, health is not. A row built from this carries `loading`
   * until the dial answers, which is the one honest thing to say about a
   * server nobody has dialled yet.
   */
  readonly configured: readonly string[];
  /**
   * Server names this folder currently has switched OFF, as the CLI's OWN
   * config records it — the state a `/mcp` panel in the user's terminal shows.
   *
   * The toggle geniro offers writes that same list, so this is not "what
   * geniro turned off" but "what is off", however it got that way.
   */
  readonly disabled: readonly string[];
  /**
   * Server names that are off in a way geniro CANNOT undo — a rejection the
   * user (or the CLI's own trust prompt) recorded, whose every source copy is
   * UNIONed rather than overridden (probe-verified on claude 2.1.220).
   *
   * A row listed here gets no switch: offering one would be a control that
   * silently does nothing, which is exactly what the design forbids.
   */
  readonly lockedOff: readonly string[];
  /**
   * Where each server the folder resolves was DEFINED, keyed by name. A name
   * this CLI cannot place is simply absent, which reads as `unknown`.
   *
   * Its whole reason for existing is that a CLI merges its scopes BY NAME, so
   * a listing is one row per name and cannot say which definition won.
   * Measured on cursor 2026.08.11-e8db854 in a folder defining `codegraph` at
   * both scopes: `mcp list` prints one `codegraph` row, the workspace file's
   * definition is the one in force, and `mcp list-tools codegraph` answers
   * `MCP server "codegraph" has not been approved` — while the user-scope
   * server of that name works everywhere else on the machine. With no origin
   * on the row, the panel showed a server the reader knows to be working and
   * called it unapproved, with nothing on screen to explain the contradiction.
   */
  readonly origins: Readonly<Record<string, AgentMcpOrigin>>;
  /**
   * This folder's answer to `AdapterConfig.mcp.interactiveOnlyNote`, when the
   * CLI's own-app-only servers can only be known by looking at the machine;
   * null leaves the config's static sentence standing.
   *
   * It exists because cursor's are its PLUGINS — a set the user installs and
   * changes — so whether the gap exists at all is the machine's answer; the
   * plugins themselves ride {@link plugins}. claude's are two fixed built-ins
   * and stay in the config.
   */
  readonly interactiveOnlyNote: string | null;
  /** The plugins behind that note, each with the servers a copy could add. */
  readonly plugins: AgentMcpPlugin[];
}

/** Which of a CLI's configuration scopes a server was defined in. */
export type AgentMcpScope = 'user' | 'workspace' | 'unknown';

/** Where one server came from, and what it displaced getting there. */
export interface AgentMcpOrigin {
  readonly scope: AgentMcpScope;
  /**
   * True when a WORKSPACE definition overrides a same-named user one.
   *
   * Reported separately from the scope because the two answer different
   * questions, and only this one explains a surprise: the user's own server is
   * fine, and is simply not what this folder loads under that name.
   */
  readonly shadowsUser: boolean;
}

/**
 * A plugin the CLI's own app loads MCP servers from, which a geniro turn does
 * not load — listed so the user can see what is missing and copy a server into
 * the config the turns DO read (`AgentAdapter.copyPluginMcpServer`).
 */
export interface AgentMcpPlugin {
  readonly name: string;
  /**
   * True when this folder's own config enables the plugin, false when it turns
   * it off, null when no file here says — an install the CLI's servers record
   * rather than its files (cursor's user scope).
   */
  readonly enabledHere: boolean | null;
  readonly servers: AgentMcpPluginServer[];
  /**
   * What a copy needs filled in, as the plugin's manifest declares it — never a
   * credential. A variable the manifest marks write-only, or whose name says it
   * holds a key, is left out, and a header that needs one is dropped from the
   * copy so the server falls back to signing in.
   */
  readonly variables: AgentMcpPluginVariable[];
}

export interface AgentMcpPluginServer {
  /** The key under the plugin's `mcpServers` — also the name a copy is filed under. */
  readonly name: string;
  /** What the CLI's own app calls it, which is not a name its subcommands accept. */
  readonly id: string;
  readonly transport: 'stdio' | 'http' | 'sse' | null;
  /** The URL or command as the plugin writes it, variables unexpanded. */
  readonly target: string | null;
  /** The config entry already carrying this server, or null when none does. */
  readonly copiedAs: string | null;
}

export interface AgentMcpPluginVariable {
  readonly name: string;
  readonly title: string | null;
  readonly description: string | null;
  /** The values the manifest allows, or null when any text will do. */
  readonly options: string[] | null;
  readonly required: boolean;
  readonly defaultValue: string | null;
}

/** One plugin server to copy into the CLI's own user-scope MCP config. */
export interface AgentMcpPluginCopyInput {
  /** The folder whose plugins were listed, already validated. */
  readonly cwd: string;
  /**
   * The profile the listing was taken under, so a CLI whose config is per
   * profile writes the file the panel read. Cursor's `mcp.json` is the home
   * directory's whatever the profile, and ignores it.
   */
  readonly configDir: string | null;
  readonly plugin: string;
  readonly server: string;
  /** Values for the plugin's declared variables, by name. */
  readonly variables: Readonly<Record<string, string>>;
}

/**
 * `changed: false` is an entry already there and identical, which is success:
 * the user asked for the server to be in the config, and it is.
 */
export type AgentMcpPluginCopyResult =
  { ok: true; name: string; changed: boolean } | { ok: false; reason: string };

/**
 * A profile's MCP server DEFINITIONS, by name, in the CLI's own JSON shape —
 * `{command, args, env}` / `{url, headers}` for claude and cursor, codex's
 * `[mcp_servers]` table read as JSON (`http_headers`, `bearer_token_env_var`).
 * Passed through rather than normalized: the editor shows the user their own
 * file, and a normalizing round trip would rewrite fields geniro does not know.
 */
export type AgentMcpServerDefinitions = Record<string, Record<string, unknown>>;

/**
 * The editable MCP document of one profile — the servers it defines at USER
 * scope, never a project's — or why there is none.
 *
 * `version` is an opaque token the write must present back, so an edit made
 * against a document the CLI has since rewritten (a `mcp add` in the user's
 * own terminal) is refused rather than silently undone: codex's own config
 * version, or a hash of the servers for a CLI whose file has none.
 */
export interface AgentMcpConfigDocument {
  servers: AgentMcpServerDefinitions | null;
  /** Where the document lives, for the editor to name; null when unknown. */
  path: string | null;
  version: string | null;
  /** Why this CLI's document cannot be read or edited; null when it can. */
  unavailableReason: string | null;
}

/** A whole-document write: the servers the profile should define afterwards. */
export interface AgentMcpConfigWriteInput {
  /** The profile, already validated; null for the CLI's own default. */
  readonly configDir: string | null;
  readonly servers: AgentMcpServerDefinitions;
  /** The version the document was read at — see {@link AgentMcpConfigDocument}. */
  readonly expectedVersion: string | null;
}

/** One server to add, as the "Add" form states it — CLI-agnostic. */
export interface AgentMcpServerSpec {
  readonly name: string;
  readonly transport: 'stdio' | 'http';
  /** The program to launch; set for `stdio` alone. */
  readonly command: string | null;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** The streamable-HTTP endpoint; set for `http` alone. */
  readonly url: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export interface AgentMcpServerAddInput {
  /** The profile, already validated; null for the CLI's own default. */
  readonly configDir: string | null;
  readonly server: AgentMcpServerSpec;
}

/**
 * A refusal is a result, never a throw — the request can be fixed (a name
 * already in use, a document that moved on). A THROW is the write itself
 * failing (a permission, a full disk), which nothing in the request can fix.
 * `changed: false` is a write that found the document already as asked.
 */
export type AgentMcpConfigWriteResult =
  { ok: true; changed: boolean } | { ok: false; reason: string };

/** Everything an adapter needs to list what it can be invoked with. */
/**
 * Which account a model listing is ABOUT.
 *
 * A model vocabulary is an account fact — the subscription decides which models
 * exist — and the account is the config directory, so the listing cannot be
 * asked without one. A CLI whose account is not a directory ignores it and says
 * so in its own `configDir.unavailableReason`.
 */
export interface AgentModelsInput {
  /** The run's config directory (its ACCOUNT), or null for the CLI's own. */
  configDir: string | null;
}

export interface AgentSkillsInput {
  /** The user's project folder, already validated and canonicalized. */
  cwd: string;
  /** The "user" scan root — the real home dir outside tests. */
  homeDir: string;
  /**
   * The run's config directory (its ACCOUNT), or null for the CLI's own.
   *
   * It REPLACES {@link homeDir} as the user-scope root rather than adding to
   * it, because that is what the mechanism does — see `AgentAdapter.listSkills`.
   */
  configDir: string | null;
}

/**
 * How a utility child was spawned, handed to the registration site so it can
 * reap exactly what exists. Produced by `runCommand`, consumed by
 * `childProcessHandle` — the two halves of the process-group pairing, which is
 * why neither is stated by hand at a call site.
 */
export interface AgentSpawnInfo {
  /** The child leads its own process group (see {@link AgentCommandOptions.processGroup}). */
  processGroup: boolean;
}

/** Options for a short-lived utility command a CLI is asked to run. */
export interface AgentCommandOptions {
  /**
   * Handed the spawned child so the caller can register it with
   * `ProcessRegistry` — every child the daemon spawns must be reapable on
   * shutdown, including these one-shot utility ones.
   *
   * `spawnInfo` describes what was ACTUALLY spawned, so the registration site
   * never has to restate it: `childProcessHandle(child, spawnInfo)` is always
   * correct, whereas a hand-written `{ processGroup: true }` at the call site
   * could disagree with the spawn and silently reap nothing.
   */
  onSpawn?: (child: ChildProcess, spawnInfo: AgentSpawnInfo) => void;
  /**
   * Handed a full TURN a utility method started (a probe), for the same
   * reason as `onSpawn` — `start()` hands back a handle, not a child, so the
   * two registration seams are separate.
   */
  onTurn?: (handle: AgentTurnHandle) => void;
  timeoutMs?: number;
  /**
   * The folder to run the command in. Absent means the daemon's own cwd, which
   * is what every caller wanted until a command's ANSWER became folder-scoped:
   * `claude mcp list` reports the project's `.mcp.json` servers and the
   * local-scope servers keyed to that directory, so asked from the wrong place
   * it confidently returns a different machine-true list.
   */
  cwd?: string;
  /**
   * The agent config directory this command is about — the profile whose state
   * it should read or write. Absent means the CLI's own default profile.
   *
   * Only meaningful to a command whose ANSWER or EFFECT is profile-scoped, and
   * the honest reading of "ignored" differs per CLI rather than per caller:
   * claude keeps its disabled-server list inside the config directory, so its
   * toggle resolves the file from this; cursor's toggle is a subcommand run in
   * the folder, and its `readMcpFolderFacts` likewise takes no profile — so
   * ignoring it there leaves that CLI's read and write describing the same
   * state, which is the property that matters. An adapter that ignores it while
   * its READ honours it is the silent no-op {@link AgentMcpService.setEnabled}
   * exists to refuse.
   */
  configDir?: string | null;
  /**
   * Run the child as its own process-group leader, and reap the whole group on
   * every abnormal exit.
   *
   * THE canonical statement of this option; the other sites that touch it point
   * here rather than restating it. Off by default because it is only worth its
   * cost for a command that FORKS: `claude mcp list` health-checks, so it
   * launches the user's own MCP servers as grandchildren, and `kill-tree.ts`
   * names the failure this closes — "a single-PID kill would orphan them".
   *
   * Setting it moves the command off `execFile` entirely, onto `spawn` with
   * `detached` plus a group-killing deadline of our own. That is not an
   * implementation detail worth hiding: `execFile` forwards only
   * cwd/env/uid/gid/shell/windows* to `spawn` and silently drops `detached`,
   * so an `execFile` child can never lead a group no matter what its options
   * bag says, and the reap addresses nobody.
   *
   * `runCommand` owns both halves: it passes the same flag to `onSpawn` as
   * `spawnInfo.processGroup`, so a registration site cannot pair them wrongly.
   */
  processGroup?: boolean;
  /**
   * Resolve with the command's OUTPUT — stdout AND stderr — whatever its exit
   * status, instead of the usual `null`-on-failure.
   *
   * THE canonical statement of this option. Off by default, because for almost
   * every utility command a non-zero exit means the answer is worthless. It
   * exists for the commands where the answer IS the failure: `cursor-agent mcp
   * list-tools <server>` exits 1 and writes `MCP 'figma' requires
   * authentication.` to STDERR — measured on 2026.08.11-e8db854 — so the one
   * reading that distinguishes "needs signing in" from "broken" is invisible to
   * a caller that only sees stdout on success.
   *
   * Both halves are needed together and neither is useful alone here, which is
   * why this is one flag and not two: the diagnosis is on the failure path and
   * it is on stderr.
   *
   * With it set, `null` narrows to "could not be run at all" — a spawn that
   * threw, a deadline, or output past the buffer cap. Parsing therefore has to
   * be marker-based rather than exit-code-based, which is what the CLIs'
   * prose-only output forces anyway.
   */
  captureDiagnosis?: boolean;
  /**
   * Extra env for THIS command's child, merged over `buildChildEnv()`.
   *
   * A utility command can be as profile-scoped as a turn is: `claude mcp list`
   * reads the servers configured in whatever config directory it runs under,
   * so asked without the run's own it confidently answers about a different
   * account. The same stripping applies either way — this only ADDS, it never
   * reinstates a key `buildChildEnv` removed on purpose.
   */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin verbatim, in order, immediately after the
   * spawn — framing included, so a JSON-RPC caller passes `encodeRequest`
   * output straight through rather than having this option guess at delimiters.
   *
   * For a utility command that must be TALKED to rather than merely read — an
   * ACP handshake, whose answer only exists once two JSON-RPC frames have gone
   * in. Setting it IMPLIES {@link AgentCommandOptions.processGroup}: `runCommand`
   * routes to the group path whenever this or `settleWhen` is present, because
   * that is the only path spawning a writable stdin pipe, and an `execFile`
   * child would drop every frame silently.
   *
   * Written without awaiting a reply between them, because a JSON-RPC server
   * reads one ordered stream — see {@link AgentCommandOptions.settleWhen} for
   * what ends the read.
   */
  stdinWrites?: readonly string[];
  /**
   * Stop reading as soon as the accumulated stdout answers the question, and
   * settle with it.
   *
   * Without it a conversational command never finishes: probed on cursor-agent
   * 2026.08.04-aaa8809, `cursor-agent acp` does NOT exit when its stdin closes,
   * so waiting for `close` spends the whole deadline and then reports the
   * failure of a read that had succeeded in under a second.
   *
   * Absent means the existing behaviour, unchanged: read to `close` and settle
   * on the exit status. Setting it implies `processGroup`, exactly as
   * {@link AgentCommandOptions.stdinWrites} does and for the same reason.
   */
  settleWhen?: (stdout: string) => boolean;
  /**
   * Frames to write IN ANSWER to what the child has printed so far — called
   * with the accumulated stdout after every chunk, BEFORE
   * {@link AgentCommandOptions.settleWhen}, and whatever it returns is written
   * to stdin in order.
   *
   * For a conversational command whose next question depends on the last
   * answer: codex's MCP listing has to open a thread and then ask about THAT
   * thread by the id its reply carried, which {@link stdinWrites} — written all
   * at once at the spawn — cannot express. The caller's closure keeps its own
   * state (what it has already sent); returning `[]` writes nothing. Implies the
   * group path, like {@link stdinWrites}.
   */
  converse?: (stdout: string) => readonly string[];
  /**
   * The most stdout (plus captured stderr) this read may accumulate before it
   * gives up, in characters. Default 1M — enough for every listing but one:
   * codex's MCP status reply carries each server's whole tool catalog, measured
   * at ~580KB for eight servers on one profile, so a bigger account would be
   * cut off by the default and read as a CLI that could not answer.
   */
  maxOutputChars?: number;
  /**
   * Close the child's stdin once {@link stdinWrites} are written (at once when
   * there are none), for a command that reads stdin until EOF. `codex exec`
   * does, even with its prompt in argv — measured on 0.157.1: with stdin an
   * open pipe it prints `Reading additional input from stdin...` and waits for
   * good. Implies the group path, like `stdinWrites`, since that is the only
   * one spawning a stdin this code holds.
   */
  endStdin?: boolean;
  /**
   * Give the child a real TERMINAL on stdin, so a CLI that refuses a pipe will
   * run at all.
   *
   * For exactly one shape of command: an interactive flow the daemon can
   * otherwise only hand to the user's terminal. `claude mcp login <server>`
   * is the case — probe-verified on 2.1.232 that with stdin a pipe it answers
   * `stdin isn't a terminal, so authentication can't be completed here` and
   * exits BEFORE printing anything, while under a pty it prints the
   * authorization URL, opens the browser and serves its own
   * `http://localhost:<port>/callback`. So the terminal window geniro used to
   * open for it was never the mechanism, only the way to get a TTY.
   *
   * Implemented with `script(1)` (macOS/BSD: `script -q /dev/null <cmd> …`),
   * NOT a native pty module: the daemon carries none (the Electron shell's
   * node-pty belongs to its terminal panel, in another process), and adding a
   * native dependency here to allocate one terminal for one sign-in is a poor
   * trade.
   * `script` ships with macOS and was measured to give the child
   * `process.stdin.isTTY === true`.
   *
   * Implies {@link AgentCommandOptions.processGroup}: the wrapper is a process
   * of its own with the CLI under it, and a browser opener under THAT, so the
   * only reapable unit is the group.
   *
   * Two consequences the caller owns. The child's stdout is TERMINAL output —
   * it carries ANSI escapes and CR line endings, so anything parsing it must
   * tolerate them. And an exit status is the WRAPPER's, so a caller that needs
   * the CLI's own verdict must read it out of the output.
   */
  pty?: boolean;
}

/**
 * The tool-approval modes a caller may ask for. The vocabulary is shared, but
 * which of them a given CLI honours is not — see
 * {@link AdapterConfig.approval}.modes.
 */
export type AgentApprovalMode = 'auto' | 'ask' | 'acceptEdits' | 'plan';

/**
 * Where one probed approval mode stands on the INSTALLED binary. `unknown` is a
 * probe that has not settled (not run yet, timed out, could not spawn) and must
 * be read as "nobody knows", never as `fail`.
 */
export type ApprovalProbeStatus = z.infer<typeof ProbeStatusSchema>;

/**
 * What a per-binary probe has established about one CLI's approval modes — the
 * very shape `GET /v1/capabilities` publishes for it, derived from that schema
 * so the two cannot drift.
 *
 * Owned by the adapter whose binary was probed, and only by it — each adapter
 * answers for its own CLI (`AgentAdapter.approvalProbe`), so no consumer holds
 * a bag keyed by CLI name and no CLI can be judged by another's verdict. A
 * mode's `requiresPass` is false when the daemon degrades a failed probe to
 * another mode on its own (`approval.degradeOnProbeFail`), true when it has no
 * fallback and a run on that mode would simply not work.
 */
export type AgentApprovalProbeState = z.infer<typeof AgentApprovalProbeSchema>;

/**
 * What a per-binary probe established about the INSTALLED CLI's approval
 * modes, in terms no consumer has to know a CLI to build.
 *
 * Tri-state per mode, and the distinction is load-bearing: `false` means a
 * probe PROVED this binary rejects the mode (degrade it), while absent means
 * nobody asked (keep the requested mode, so a genuine rejection still surfaces
 * loudly from the CLI itself instead of being pre-empted by a guess).
 */
export interface InstalledApprovalSupport {
  supported: Partial<Record<AgentApprovalMode, boolean>>;
}

/** The mode a turn actually runs under, and what the transcript owes the user. */
export interface ApprovalResolution {
  mode: AgentApprovalMode;
  /**
   * Null when the requested mode survived; otherwise the one line explaining
   * what the turn runs as instead, and why. The caller persists it as a system
   * item — a degrade the user cannot see reads as enforced permissions that
   * never were.
   */
  degradeReason: string | null;
}

/** Everything an adapter needs to drive one turn. */
/**
 * One conversation's auto-compaction threshold, as a turn carries it.
 *
 * A percent and a window rather than the token figure they produce, because the
 * arithmetic is the CLI's own: what geniro asks for is "compact at 80% of this
 * conversation's window", and only the adapter knows what argv expresses that
 * (see {@link AdapterConfig.autoCompact}).
 */
export interface TurnAutoCompact {
  /** Whole percent of the window, 10–95 — `AutoCompactPercentSchema`'s range. */
  percent: number;
  /**
   * The MODEL's own window in tokens: as this conversation last measured it,
   * or before its first reading, as that model was last measured anywhere.
   */
  windowTokens: number;
}

export interface AgentTurnInput {
  /** The user's message text for this turn. */
  prompt: string;
  /**
   * Images the user attached to this turn's message, already on disk under the
   * daemon's attachments dir. Delivery is adapter-specific: claude gets real
   * base64 image content blocks in its stream-json stdin payload (probe-verified
   * on 2.1.220 — the model describes the image without touching a tool), while
   * a CLI whose stdin is plain text can only be told the paths and left to open
   * them itself. Empty/absent for a text-only turn.
   */
  images?: TurnImage[];
  /**
   * Working directory the CLI runs in — the user's project folder. The chat
   * service validates this exists and is a directory before the adapter spawns,
   * so the agent is scoped to the user's project, never the daemon's own cwd.
   */
  cwd: string;
  /** Model alias/name (adapter-specific); null/undefined = the CLI default. */
  model?: string | null;
  /**
   * How hard the model should think this turn, spelled as the CLI spells it
   * (one of {@link AgentAdapter.listEfforts}); null/undefined = the CLI's own
   * default, no flag.
   *
   * A plain string rather than a union, for the same reason as `model`: the
   * vocabulary is per-CLI, so a fixed enum here would put one CLI's facts in
   * the shared contract. The caller validates against the adapter's list; an
   * adapter whose CLI has no such control ignores the field entirely.
   */
  effort?: string | null;
  /**
   * Which of the model's context-window sizes to run at, spelled as the CLI
   * spells it (one of {@link AgentAdapter.listModelContextWindows});
   * null/undefined = whatever the model's own default is.
   *
   * A per-model PARAMETER rather than a property of the conversation, exactly
   * like `effort` and carried the same way for the same reason — the vocabulary
   * belongs to the CLI, and an adapter whose CLI has no such control ignores
   * the field.
   */
  contextWindow?: string | null;
  /**
   * Every OTHER model setting this turn asks for, keyed by the CLI's own
   * parameter id (`{optimize_for: 'intelligence'}`).
   *
   * A pass-through in the strictest sense: geniro holds no vocabulary for these
   * (see `AgentModelParameter`), so an adapter either knows how to set a config
   * option on its CLI or ignores the field entirely — which is what the base
   * and the claude adapter both do.
   */
  modelParameters?: Record<string, string> | null;
  /**
   * The threshold this conversation should compact at, and the window it is a
   * share of — handed to the CLI so it compacts ITSELF mid-turn (see
   * {@link AdapterConfig.autoCompact}). Absent when the user set no threshold,
   * or when nothing has measured this conversation's window yet: the window is
   * read from what the LAST turn reported, so the first turn of a brand-new
   * conversation runs unflagged and geniro's between-turn rule covers it until
   * a figure exists. An adapter whose CLI has no such control ignores it.
   */
  autoCompact?: TurnAutoCompact | null;
  /** Prior CLI session id to resume; null/undefined starts a fresh session. */
  resumeSessionId?: string | null;
  /**
   * A team member's private instructions for this turn. Claude appends it to the
   * CLI system prompt (`--append-system-prompt`); ACP has no such parameter,
   * so its driver prepends it to the prompt text. Undefined for plain chat.
   */
  systemPrompt?: string | null;
  /** A team member's character — its manner and tone, for its own turns only. */
  characterPrompt?: string | null;
  /**
   * The user's own global custom instructions, as snapshotted onto the run.
   *
   * Kept SEPARATE from {@link systemPrompt} for the same reason
   * {@link callSurfacePrompt} is: the two answer different questions and rank
   * differently. `systemPrompt` is what THIS turn is for — a team member's
   * instructions — while this is a standing preference the user set once for
   * every agent, so the member's instructions have to outrank it. Folding them
   * into one field would make that ordering the caller's problem, and the team
   * path would have to hand-join a string it did not author.
   *
   * Reaches the CLI through `AgentAdapter.composeSystemPrompt` like every other
   * part, so it needs no per-CLI delivery of its own — both shipped adapters
   * already route that one composed block to their own channel.
   *
   * Undefined for a run created before the setting existed, and for one whose
   * user has typed nothing.
   */
  customInstructions?: string | null;
  /**
   * The language the user wants replies in (`Settings.replyLanguage`), as
   * snapshotted onto the run; null/undefined when none is set.
   *
   * Composed into the instruction block like {@link customInstructions}, and
   * an adapter whose CLI has a language setting of its own may hand it that
   * too (claude's `--settings {"language"}`).
   */
  replyLanguage?: string | null;
  /**
   * What the run's project says to its agents, as snapshotted onto
   * `Run.projectInstructions`; composed right after {@link customInstructions}.
   * Not gated on the MCP tools: it names none.
   */
  projectInstructions?: string | null;
  /**
   * The shared memory's title index, as snapshotted onto `Run.memoryIndex`;
   * composed right after {@link projectInstructions}, and only where the turn's
   * MCP tools were delivered, since it sends the agent to `memory_read`.
   */
  memoryIndex?: string | null;
  /**
   * The knowledge store's index, as snapshotted onto `Run.knowledgeIndex`;
   * composed right after {@link memoryIndex} and on the same terms, since it
   * sends the agent to `knowledge_read`.
   */
  knowledgeIndex?: string | null;
  /**
   * Whether this run switches its CLI's own memory off (`Run.nativeMemoryOff`),
   * so an agent keeps one memory rather than two that disagree; each adapter
   * owns how.
   */
  nativeMemoryOff?: boolean;
  /**
   * What the board card this run works asks of it — its label instructions and
   * geniro's report ask, as stored on `Run.taskInstructions`. Undefined for
   * every run no card started.
   *
   * A peer of {@link customInstructions} rather than joined into it, for the
   * reason the two are separate columns: the user can purge their own text,
   * and that purge must not reach this. `turnInstructionParts` ranks it
   * directly after the user's own text.
   */
  taskInstructions?: string | null;
  /**
   * What geniro tells a team-editing chat about the file it owns — where
   * it is, and what a team document may contain — as stored on
   * `Run.teamInstructions`. Undefined for every run outside the team builder's
   * chat panel.
   *
   * A peer of {@link taskInstructions} for that field's own reason, and the
   * two are mutually exclusive in practice: a run is either working a card or
   * editing a team.
   */
  teamInstructions?: string | null;
  /**
   * The instruction blocks addressed to this team member, already joined by
   * the executor. Undefined for plain chat and for a member no block is
   * addressed to.
   *
   * A THIRD peer beside {@link systemPrompt} and {@link customInstructions};
   * `turnInstructionParts` owns where it ranks between them.
   *
   * Joined by the executor rather than sent as a list, because the ORDER of
   * several blocks is a team fact that no adapter can recover.
   */
  instructionBlocks?: string | null;
  stageMapPrompt?: string | null;
  /**
   * The run's snapshot of the user's switches for THIS turn's CLI, keyed by
   * {@link AgentOptionSpec.id}. An id that is absent means the caller did not
   * say, and the adapter reads its declared default — never `false`, which is
   * what keeps a run created before an option existed on the behaviour it has
   * always had.
   */
  agentOptions?: Readonly<Record<string, boolean>>;
  /**
   * This turn is geniro's OWN bookkeeping — its output is parsed by the daemon
   * and never rendered in a transcript anybody reads.
   *
   * What it withholds is the host preamble
   * ({@link GENIRO_UI_PREAMBLE}, added by `AgentAdapter.composeSystemPrompt`):
   * that text describes the surface a REPLY lands on, and for a probe there is
   * no such surface, so sending it states something untrue and pays argv for
   * it on every capability read. Adapter-agnostic like {@link trustWorkspace}
   * and {@link isolateMcpServers} — the caller states what the turn IS, and
   * the composition decides what that costs.
   *
   * Deliberately NOT folded into `isolateMcpServers`, which every internal
   * probe happens to set today: that field is about which MCP servers load,
   * and a later internal turn that legitimately wants the user's servers would
   * silently regain the preamble if the two were one flag.
   *
   * A user-project turn NEVER sets it.
   */
  internalProbe?: boolean;
  /**
   * This turn IS the command-list probe (`AgentAdapter.listReportedCommands`).
   *
   * Says what the turn is, never what a CLI should do about it: an adapter
   * whose CLI announces its commands unasked ignores this, and one that has to
   * ASK reads it as its cue. Claude is the second kind — its `system/init`
   * names every command and describes none, and only a `reload_skills` control
   * request gets the sentences — so a flag was needed that the probe can set
   * without knowing why any particular CLI wants it.
   *
   * Deliberately NOT folded into {@link internalProbe}, which several probes
   * set: reading it as "the command probe" would have the permission-mode
   * probe reload the user's skills as a side effect of asking about modes.
   */
  commandListProbe?: boolean;
  /**
   * This turn REOPENS the conversation and sends no prompt.
   *
   * What the user pressed is Retry on a failed turn: the conversation is intact
   * and the work is not, so the turn re-establishes the session and stops —
   * without paying for the prompt a second time, and without asking the agent
   * to answer a question it may already have answered.
   *
   * Says what the turn IS, never what a CLI should do about it, on
   * {@link commandListProbe}'s rule. An adapter whose CLI reopens a
   * conversation by resuming a session id reads it as its cue to withhold the
   * prompt; one whose reopen is the prompt has nothing to withhold and ignores
   * it. Meaningless without {@link resumeSessionId} — there is no conversation
   * to reopen — and a caller that sets it alone gets a turn that opens a fresh
   * session and ends, which is why the chat service refuses that pairing rather
   * than leaving it to each adapter.
   *
   * NOT a probe: {@link internalProbe} withholds the host preamble because a
   * probe's output reaches no transcript, while this turn's whole purpose is
   * the surface the NEXT message lands on.
   */
  resumeOnly?: boolean;
  /**
   * The caller's "May call" awareness block, naming each callee reachable
   * through `mcpEndpoint`'s tools. Kept SEPARATE from `systemPrompt` because
   * it is only true while the call tools are actually registered: an adapter
   * that ends up withholding the endpoint (an ACP agent that does not
   * advertise HTTP MCP support) must drop this block too, or the agent is
   * instructed to route work through tools it does not have. Join the two
   * with `AgentAdapter.composeSystemPrompt`, never by hand — it composes every
   * instruction part (the host preamble, {@link customInstructions},
   * {@link taskInstructions} and {@link instructionBlocks} ahead of these two),
   * and their order is the precedence rule.
   */
  callSurfacePrompt?: string | null;
  /**
   * Set on every turn that answers a call: where that answer goes. Its own
   * field rather than part of {@link callSurfacePrompt}: a callee with no
   * callees gets no "May call" block, and that block is dropped when the call
   * tools are not delivered, while this text names no tool.
   */
  answeringACallPrompt?: string | null;
  /**
   * Tool-approval mode. `ask` blocks each permission-gated tool call on a
   * user verdict (elicitation card); `acceptEdits` auto-approves file edits
   * and asks for everything else; `plan` (chat-only) has the agent plan
   * without executing; `auto` runs unattended with permission checks
   * bypassed. Undefined (a geniro-internal turn) keeps the CLI's own
   * defaults — no extra permission flags.
   */
  approvalMode?: AgentApprovalMode;
  /**
   * Extra environment merged over `process.env` for the child process — e.g. a
   * per-run `CLAUDE_CONFIG_DIR`, or the `CURSOR_API_KEY` that
   * `CursorAcpAdapter.buildEnv` re-injects for its own child.
   *
   * Nothing here is sourced from a geniro-held secret any more: the app stores
   * no credentials at all now that both CLIs authenticate from their own login
   * state. A value that IS a credential is one the user exported in their own
   * shell, and it reaches exactly the one child entitled to it — never SQLite.
   */
  env?: Record<string, string>;
  /**
   * Stream this turn's assistant text as it is generated, if the CLI can.
   *
   * Adapter-agnostic intent, like {@link allowUserQuestions}: the caller says
   * "someone is watching", each CLI decides what that costs. A CLI with no
   * partial-output mode ignores it and streams whole blocks as before.
   */
  streamPartials?: boolean;
  /**
   * This turn may stop and ASK THE USER a question.
   *
   * Adapter-agnostic on purpose: the caller states the intent, and each CLI
   * decides what (if anything) it costs. For claude it is load-bearing —
   * `--dangerously-skip-permissions` strips the AskUserQuestion tool entirely
   * (probe-verified), so an `auto` turn that wants the question channel must
   * spawn on the stdio permission dialogue instead and have the DAEMON stand
   * in for the bypass, auto-approving plain permission requests. A CLI with no
   * question channel ignores this and spawns exactly as before.
   */
  allowUserQuestions?: boolean;
  /**
   * Trust the turn's cwd without prompting (cursor `--trust`, headless-only).
   * Needed when the cwd is a daemon-created directory the user never opened —
   * the MCP-trust probe's temp workspace. User-project turns never set it:
   * trusting the user's own worktree is the user's decision, not the daemon's.
   */
  trustWorkspace?: boolean;
  /**
   * This turn must load NO MCP servers of the user's.
   *
   * Adapter-agnostic intent, like {@link trustWorkspace}: the caller states
   * that nothing about this turn depends on the user's servers, and each CLI
   * decides how to arrange that. Set only by probes the daemon runs for its
   * own bookkeeping — the reported-commands probe is cancelled before the
   * model runs, so a server it launched could never have been used, yet
   * launching one costs a real process and reaping it costs the user's own
   * server on that folder.
   *
   * A user-project turn NEVER sets it: an agent must see the same MCP servers
   * a fresh session in that folder sees. A CLI with no way to restrict the set
   * ignores the field.
   */
  isolateMcpServers?: boolean;
  /**
   * This turn may read but neither run a command nor change a file: each CLI
   * takes its own shell and write tools away from the model, as strongly as it
   * allows, and loads no MCP server of the user's where it can. geniro's own
   * server stays. Set only for a lessons reflection, which reads its thread
   * through geniro's tools. Part of `AgentAdapter.sessionKey`.
   */
  readOnly?: boolean;
  /**
   * MCP servers this turn runs WITHOUT, by the name the CLI lists them under —
   * a team member's own switches (`TeamMember.mcpDisabled`). Absent
   * or empty switches nothing off; chats never set it.
   *
   * Adapter-agnostic like {@link isolateMcpServers}: the caller says which
   * servers, each CLI decides how (claude `--disallowedTools`, codex a thread
   * config override, cursor a per-turn copy of its disabled list), and a CLI
   * with no per-turn mechanism declares that in
   * `AdapterConfig.mcp.turnToggleUnavailableReason` and ignores the field.
   * It writes into no config of the CLI's: it changes nothing outside this
   * turn's process. geniro's OWN server is never switched off by it, and a
   * name the CLI does not load is ignored. Part of `AgentAdapter.sessionKey`,
   * so a kept process is never reused with a different set.
   */
  mcpDisabled?: readonly string[];
  /**
   * The directory this turn's CLI keeps its OWN state in — credentials,
   * settings, installed plugins, session history. Absent: the CLI's default
   * profile (`~/.claude`).
   *
   * This is how one run talks to a different ACCOUNT (a different
   * subscription) with a different toolbelt, without touching the user's
   * default profile: it is one directory, and everything the CLI reads about
   * itself is inside it.
   *
   * Already validated and canonicalized by the caller — an adapter hands it
   * straight to its CLI and must never be the thing that first checks it. It
   * travels as ENV, not argv (claude reads `CLAUDE_CONFIG_DIR`), which is why
   * an adapter maps it in `buildEnv` rather than in `buildArgs`.
   *
   * A CLI with no such mechanism declares that in
   * `AdapterConfig.configDir.unavailableReason` and simply ignores the field.
   */
  configDir?: string | null;
  /**
   * Loopback MCP endpoint carrying geniro's OWN tools for this turn — whichever
   * of them the turn registered. The listing is composed per request at the
   * endpoint, so holding this grants nothing by itself: a member with callees
   * sees the agent-call tools, a turn that can put a card on screen sees
   * `ask_user_question`, a chat sees `report_findings`. Delivery is
   * adapter-specific — claude gets a per-turn config file referenced by
   * `--mcp-config` (the token travels IN the 0600 file, never argv); the ACP
   * adapter sends it as an HTTP header inside a `session/new` stdin frame.
   * Absent or null: the daemon has no bound port to publish.
   */
  mcpEndpoint?: {
    url: string;
    token: string;
    /**
     * The name geniro's own MCP server is published under for this turn.
     *
     * Per RUN, and both transports now use it verbatim. The run id in it is
     * what makes it unforgeable: `--strict-mcp-config` is not passed, so the
     * user's own servers load beside this one, and a shared name would let ours
     * silently shadow one of theirs. It is also what the permission gate
     * matches a call BACK to geniro's tools on (`isHostToolCall`), so a user's
     * own server can never reach that branch.
     */
    serverName: string;
    /** Override for the CLI's MCP tool timeout (sync calls run minutes). */
    toolTimeoutMs?: number;
  } | null;
}

/** The fields of a turn its instruction block is composed from. */
export type TurnInstructionInput = Pick<
  AgentTurnInput,
  | 'internalProbe'
  | 'replyLanguage'
  | 'customInstructions'
  | 'projectInstructions'
  | 'memoryIndex'
  | 'knowledgeIndex'
  | 'taskInstructions'
  | 'teamInstructions'
  | 'instructionBlocks'
  | 'stageMapPrompt'
  | 'systemPrompt'
  | 'characterPrompt'
  | 'answeringACallPrompt'
  | 'callSurfacePrompt'
>;

/**
 * One CLI process, and the turns an adapter runs on it.
 *
 * Every turn goes through a session — including the ordinary one-turn kind, so
 * there is a single code path rather than a branch on which CLI is being
 * talked to. A CLI that cannot host more than one turn per process simply
 * yields a session whose SECOND {@link AgentSession.startTurn} answers null,
 * which is the same answer a caller gets for a session that has died or whose
 * argv no longer fits — and it means exactly one thing everywhere: spawn a
 * fresh one.
 *
 * Why a session exists at all: a CLI boots the user's MCP servers when it
 * starts, and an MCP server can own something expensive — a browser the user
 * is logged into. A process per turn tears that down on every message.
 */
export interface AgentSession {
  /** A live subordinate command still holds this delegate's terminal report. */
  subagentRecoveryBlocked?(id: string): boolean;
  /**
   * Open a turn on this process. Null when this session cannot serve it: the
   * process is gone, a turn is already in flight, this CLI hosts one turn per
   * process, or the input would need different argv than the process was
   * spawned with (a changed model, folder or config directory).
   */
  startTurn(
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
  ): AgentTurnHandle | null;
  /**
   * Put a question to this live process on its own stdin control channel,
   * outside any turn — the session-level half of `CliSession.ask`, exposed
   * because an adapter may need it to answer about the PROCESS rather than
   * about a turn.
   */
  ask<T>(request: SessionAsk<T>): Promise<T | null>;
  /** Alive, with no turn in flight — ready to take another one. */
  readonly idle: boolean;
  /** The process has not been observed to end. */
  readonly alive: boolean;
  /**
   * Alive and idle, but `startTurn` will refuse every further turn — the last
   * turn was ended for the CLI rather than by it, so this process may still be
   * printing that turn's tail and nothing can tell it apart from a new turn's
   * output.
   *
   * Deliberately NOT folded into `idle`: every reader treats a non-idle session
   * as BUSY, which would stop the idle reaper from ever closing this one while
   * still counting it against the session ceiling. A holder must instead close a
   * retired session on sight, the way it closes a dead one.
   */
  readonly retired: boolean;
  /**
   * How many commands this process has started and not yet ended that no turn
   * waits on, a delegate's included — see `CliSession.shellsRunning`. A holder
   * must not reap a process holding
   * them for going quiet, or evict it to make room: a dev server writes nothing
   * for as long as it works, and it dies with this process.
   */
  readonly shellsRunning: number;
  /** Of {@link shellsRunning}, the detached ones — see `CliSession.detachedRunning`. */
  readonly detachedRunning: number;
  /** Where a call's command runs, as recorded — see `CliSession.recordedGroupsOf`. */
  recordedGroupsOf(callId: string): readonly RecordedGroup[] | null;
  /**
   * The command lines of those detached commands — see
   * `CliSession.runningCommands`. Read by a holder that is about to close the
   * process anyway, so it can tell the agent what that stopped.
   */
  readonly runningCommands: readonly string[];
  /**
   * What was still running when the process ended — see
   * `CliSession.endedRunning`. Null while it runs.
   */
  readonly endedRunning: StoppedCommands | null;
  /**
   * The CLI's own pid — see `CliSession.pid`. Null once the process has ended.
   */
  readonly pid: number | null;
  /**
   * Alive and idle, and yet not free: the CLI is standing still on a verdict
   * only the user can give, raised (or held) between turns.
   *
   * The one reader is whoever REAPS an unused session. A person taking twenty
   * minutes over a question is not a chat going unused, and closing the process
   * under them reaches the CLI as a refusal of that question — which is how a
   * run came to be marked failed, with a bare "claude run failed" for a question
   * that had never been put on screen.
   */
  readonly parked: boolean;
  /**
   * Terminate the process group — the CLI plus every tool/MCP grandchild.
   *
   * This is the ONLY thing that stops a run-scoped process, so whoever holds
   * the session owns that obligation: nothing else will reap it.
   *
   * `cause` says why, when that decides how the work still out ended — see
   * {@link SessionCloseCause}. `graceful` closes an idle process's stdin
   * first — see `SessionCloseOptions`.
   */
  close(cause?: SessionCloseCause, options?: SessionCloseOptions): void;
  /** See `CliSession.noteCloseCause` — the one place a close's cause is kept. */
  noteCloseCause?(cause: SessionCloseCause | null): void;
  readonly closeCause?: SessionCloseCause | null;
  /** Resolves once the process is gone. Never rejects. */
  readonly closed: Promise<void>;
}

export type TurnStdin = (payload: string) => boolean;

/** The two channels a {@link TurnDriver} owns for the turn it is driving. */
export interface TurnIo {
  write: TurnStdin;
  emit: (event: AgentEvent) => void;
  /**
   * Why a {@link write} cannot land right now — null while stdin is writable.
   *
   * A driver that logs a dropped write must ASK rather than assert. `write`
   * answers a bare boolean, and four genuinely different things produce that
   * false: the process group was terminated, the child exited by itself, geniro
   * closed stdin at the turn's end, or the CHILD closed its read end while
   * still running. Only the writer knows which, so a driver naming a cause of
   * its own is guessing — and one did, printing `stdin is closed` for all four.
   * That cost a live investigation: `acp: dropped a reply to request 183 —
   * stdin is closed` was read as geniro having closed the pipe, and telling it
   * from the truth (cursor-agent closed its own read end, still running) meant
   * reading `sessionWrite` to see that `endStdin` had not been called yet.
   *
   * Optional so a caller that builds a `TurnIo` for a test need not model the
   * process at all; a driver with no obstacle to quote says only what it knows.
   */
  writeObstacle?: () => string | null;
  /**
   * Whether the CLI process is still running — false once its group was
   * terminated or it exited by itself.
   *
   * Not the same question as {@link writeObstacle}: a CLI can close its read end
   * of stdin while it goes on working (measured on cursor-agent), and work it
   * runs on its own — a background delegate — is exactly what outlives that.
   * A driver watching such work stops when this answers false, since the work
   * died with the process. Optional on {@link writeObstacle}'s terms.
   */
  processAlive?: () => boolean;
}

/** One command as the CLI itself recorded it. */
export interface CommandRecord {
  pid: number;
  command: string;
  running: boolean;
  /** The file the CLI writes the command's output to. */
  outputPath?: string;
  /** Once it has ended, when the CLI recorded one. */
  exitCode?: number | null;
  endedAt?: string | null;
}

/** How a detached command ended, as far as the CLI's own record says. */
export interface CommandEnding {
  command: string;
  exitCode: number | null;
  outputPath: string | null;
  endedAt: string | null;
}

/**
 * Per-turn protocol state for ONE turn of one CLI.
 *
 * The default driver (built by `AgentAdapter.createTurnDriver`) is stateless:
 * it just forwards each parsed stdout line to the adapter's `mapMessage`, which
 * is all a one-shot stream-json CLI needs. An adapter whose CLI speaks a
 * STATEFUL, bidirectional protocol — ACP's JSON-RPC handshake, where the next
 * message to send depends on the last one received — overrides
 * `createTurnDriver` to return an instance holding that turn's own state.
 *
 * A per-turn object (rather than more adapter methods) is what makes this safe
 * under team fan-out: one adapter instance drives N concurrent turns, so
 * protocol state must never live on the adapter.
 */
export interface TurnDriver {
  /**
   * Awaited between the child's stdin being wired and the turn's PROMPT being
   * written — the driver's chance to hold a message back until the CLI can
   * actually answer it. Only ever called for the first turn on a process, since
   * whatever it waits for belongs to the process rather than to each prompt.
   *
   * It exists because a CLI can accept a prompt before it is ready to serve
   * one: claude dials its MCP servers at process start and runs a turn without
   * waiting for them, so a prompt sent three seconds in gets a tool surface
   * with the slower servers missing — and a model told once that a tool does
   * not exist keeps believing it. See `ClaudeTurnDriver.awaitPromptReady`.
   *
   * **It must resolve, and it must be bounded by its own deadline.** The turn's
   * silence deadline is the only thing behind it, and settling a turn 30
   * minutes later because a readiness poll hung would cost the user the message
   * this hook exists to protect. It must not reject either — a gate that
   * cannot decide releases; the caller logs and sends the prompt anyway.
   *
   * A cancel during the hold is honoured: the caller drops the prompt rather
   * than writing it into a turn the user has already stopped.
   */
  awaitPromptReady?(io: TurnIo): Promise<void>;
  /**
   * Called once the child's stdin is wired, before any stdout is parsed — the
   * driver's chance to open a conversation the CLI expects the client to start.
   * Runs AFTER the turn's prompt, and so after {@link awaitPromptReady} when a
   * driver defines both.
   *
   * FIRST turn only. A handshake belongs to the PROCESS; {@link openTurn} is
   * how every turn after it opens.
   */
  onStdinReady?(io: TurnIo): void;
  /**
   * Open a SECOND (or later) turn on a process that is already running, for a
   * CLI whose "here is the next prompt" is a protocol FRAME rather than a stdin
   * payload.
   *
   * `AgentAdapter.buildNextTurnPayload` covers the stdin-line case and answers
   * undefined for a stateful protocol — the frame names a session id and a
   * request id that only the driver holds, and building one without recording
   * it would leave the turn waiting on a reply nothing can match. Without this
   * hook `startTurn` refuses such a turn outright, which is what confined ACP
   * to one turn per process.
   *
   * **A driver that defines this owns the turn's SETTINGS as well as its
   * prompt** — the approval mode, the model and anything else that is protocol
   * rather than argv — because `startTurn` skips its own mode delivery for it.
   * That is not a shortcut: on ACP the mode is a `session/set_mode` frame, so
   * the adapter has no stdin line to hand over and the turn would otherwise be
   * refused for wanting a mode the CLI can in fact be told about.
   *
   * It must be TOTAL. It is called from inside `startTurn`, after the turn is
   * registered as the session's current one, so a throw would unwind past a
   * turn nothing can now settle — an unreadable attachment must become an
   * `error` event, not an exception.
   */
  openTurn?(io: TurnIo, input: AgentTurnInput): void;
  /**
   * Whether this driver's PROCESS can serve another turn at all — asked before
   * {@link openTurn}, and answered false when the process is alive but holds
   * nothing a turn could run on (a stateful protocol whose handshake failed).
   *
   * False makes the session refuse the turn, which its owner reads as "spawn a
   * fresh process" — the same answer it gets for a dead one. Undefined means
   * the question does not arise for this CLI.
   */
  canOpenTurn?(): boolean;
  /**
   * Withdraw the turn's prompt if THIS DRIVER is still holding it — asked when
   * the user stops a turn, before any interrupt is built.
   *
   * True means the prompt never reached the CLI and now never will, so there
   * is nothing running for an interrupt to stop: the turn settles as cancelled
   * at once, no interrupt is written and nothing is killed. False (or no
   * method) means the prompt is out, or was never the driver's to hold, and the
   * ordinary stop proceeds. The twin of the prompt `spawn-cli` itself holds for
   * {@link awaitPromptReady}, for a driver whose own frames the prompt waits
   * behind.
   */
  withdrawHeldPrompt?(): boolean;
  /**
   * The process ended under this turn before the turn's own reply — answered
   * with what the driver held that will now never be delivered, emitted ahead
   * of the terminal `spawn-cli` writes. Undefined = nothing to report.
   */
  onProcessEnded?(): AgentEvent[];
  /**
   * The CLI has said nothing for a while. Null when that is explained (a call
   * it reported is open), else the rows of what it has written so far.
   */
  onQuiet?(): AgentEvent[] | null;
  /**
   * How long closing the session should let a STOPPED turn finish before the
   * process is signalled — for a driver that will only learn a delivered
   * message's fate from the turn's own end (codex's steer). 0 or undefined =
   * signal at once.
   */
  closeGraceMs?(): number;
  /** Map one parsed stdout line to zero or more normalized events. */
  onMessage(obj: unknown): AgentEvent[];
  /**
   * A stdout line too long to read was skipped (`MAX_BUFFERED_LINE_CHARS`):
   * its first characters and its length. For a protocol whose lost reply would
   * leave a request waiting for good — answer it here instead. Undefined = the
   * line is only logged.
   */
  onDroppedLine?(prefix: string, length: number): AgentEvent[];
  /**
   * Encode one approval verdict as the payload the CLI expects. Undefined =
   * this CLI has no approval protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): string | undefined;
  /**
   * Deliver a user message into the turn this driver is running, answering
   * whether the CLI actually got it.
   *
   * The counterpart of `AgentAdapter.buildFollowUpPayload` for a CLI whose
   * delivery is not one stdin LINE but a request in a stateful protocol: the
   * driver holds the session id and the request-id counter, so only it can
   * build the frame, and it must record the frame it sent to understand the
   * reply. That is also why this writes for itself rather than returning a
   * payload — the existing send path already unregisters a frame whose write
   * failed, and a builder that registered one before an unwritten write would
   * leave the turn waiting on a reply that can never come.
   *
   * Undefined = this driver has no such channel, and the adapter's own
   * `buildFollowUpPayload` is used instead (the default of which is "this CLI
   * cannot be told anything more once its prompt is in").
   *
   * **Honest in both directions**, exactly like the payload builder it stands
   * beside: a `true` for a message the agent never received has the chat commit
   * a user row nobody will answer, and a `false` leaves it queued, which is
   * always safe.
   */
  sendFollowUp?(message: FollowUpMessage): boolean;
  /**
   * How many running background sub-agents a message delivered now would
   * cancel. Undefined = a message on this CLI cancels none.
   */
  subagentsAFollowUpCancels?(): number;
  /**
   * Encode an in-protocol "stop what you are doing", for a CLI whose stop is a
   * frame only the driver can build — the same reason {@link sendFollowUp}
   * exists beside `AgentAdapter.buildFollowUpPayload`, and here it is the
   * session id that makes the frame unbuildable from outside.
   *
   * Takes precedence over `AgentAdapter.buildInterruptPayload`. Undefined, or a
   * driver answering undefined, falls back to that — and past both, to killing
   * the process group, which on a kept session destroys the conversation and
   * every delegate still out. That is why a CLI whose process now outlives its
   * turn needs one of the two.
   */
  buildInterruptPayload?(): string | undefined;
}

/** Handle to an in-flight turn. */
export interface AgentTurnHandle {
  /**
   * Resolves when the turn finishes by any path (the CLI exits, errors, or is
   * cancelled). Never rejects — terminal outcomes arrive as `error` /
   * `turn_cancelled` events first, so callers await a single settle point.
   */
  readonly done: Promise<void>;
  /** Terminate the underlying CLI process for this turn. */
  cancel(): void;
  /**
   * Answer an `approval_request` event: allow unblocks the tool call (echoing
   * `updatedInput` — the input the request carried); deny rejects it and the
   * agent continues without the tool. Returns whether the verdict was actually
   * delivered — false once the turn has settled/ended (a late verdict must not
   * be recorded as applied) and for adapters whose CLI has no approval
   * protocol.
   *
   * `option` is one of the request's own `options`, when the user picked one
   * of those rather than plain Approve/Deny. Absent is a ONE-TIME answer, and
   * every auto-approval sends it absent, so nothing the daemon decides on its
   * own is remembered by the CLI.
   */
  respondApproval(
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ): boolean;
  /**
   * Hand the RUNNING turn another user message. Returns whether it was
   * actually delivered — false once the turn has settled, and false for a CLI
   * with no such channel, so a caller can fall back to queueing it for the
   * next turn without asking the adapter what kind it is.
   *
   * Probe-verified on claude 2.1.222: a second `{"type":"user"}` line written
   * to a still-open stream-json stdin is picked up at the next tool boundary
   * of the turn already in flight — a message sent 8s into a 20s command was
   * answered at 29s, in the same process and under the same `result` line.
   * That is what the CLI itself does with a follow-up typed mid-turn, and it
   * is why "queued" here means seconds rather than "after everything finishes".
   *
   * ACP has no equivalent: `session/prompt` is one request per turn, and the
   * protocol gives a client no way to add to a prompt already accepted. Its
   * adapter therefore answers false and the caller keeps the message queued.
   */
  sendUserMessage(message: FollowUpMessage): boolean;
  /** {@link TurnDriver.subagentsAFollowUpCancels}, for this turn. */
  subagentsAFollowUpCancels?(): number;
  /**
   * The delegate a render card drawn RIGHT NOW can be credited to, or null.
   *
   * A host render tool (`report_findings`, `show_chart`, …) arrives over the
   * MCP endpoint, which is addressed `(runId, nodeId)` alone — a delegate runs
   * inside the same CLI process and calls the same endpoint, so the request
   * names nobody. Only the live turn can answer, and it answers by INFERENCE.
   * The whole judgment therefore lives behind this one method rather than in
   * the caller: a card filed under the wrong delegate reads exactly like a
   * correct attribution, so there must be no second place to get it wrong.
   *
   * Three conditions, each a case that was wrong without it. The main thread
   * must have stopped talking, since it goes on working — and calling these
   * tools — while a delegate is out. Exactly one delegate must be open,
   * counted over the LIVE set rather than over the ids that resolved, because
   * one the CLI announced with no launching call is still a second delegate.
   * And that delegate's own launching call must be known.
   */
  attributableDelegate(): string | null;
  /**
   * Re-mode the tool-approval posture of the turn ALREADY RUNNING, returning
   * whether the CLI was actually told.
   *
   * Honest in both directions, like {@link AgentTurnHandle.sendUserMessage} —
   * and here the cost of a dishonest true is higher than a dropped message.
   * This is the permission surface: ACKing a change the running turn will not
   * honour tells the user a safety posture they do not have, which is exactly
   * what the caller's refusal exists to prevent.
   *
   * False is the honest answer for a turn with no way to be told, and that is
   * not hypothetical: a claude turn spawned under
   * `--dangerously-skip-permissions` has no permission prompt tool wired at
   * all, so no message could reintroduce a gate it was started without.
   */
  setApprovalMode(mode: AgentApprovalMode): boolean;
}

/**
 * One question a CLI asked, as a CALLING agent is told it — built from the card
 * the user would see (`adapterQuestionOf`), never read out of the payload twice.
 */
export interface AdapterQuestion {
  /** The question text, one line per question, headers included. */
  text: string;
  /** Every option label offered, flat across questions; [] when free-text only. */
  options: string[];
}

/** What the mirror is being opened ON — one run's one thread. */
export interface HandoffInput {
  /** The session to open, or null when the thread has produced none yet. */
  sessionId: string | null;
  /** The model the run is chatting as, or null for the CLI's own default. */
  model: string | null;
  /**
   * The agent config directory the run's turns use, or null/omitted for the
   * CLI's default profile.
   *
   * Optional because most askers have none to give: the capability probe asks
   * only whether this CLI can resume AT ALL, and a run that never chose a
   * profile has nothing to pass.
   */
  configDir?: string | null;
  /**
   * Whether geniro's own kept process may still hold this conversation — what
   * picks the resume or the copy for a CLI declaring `handoff.heldFlag`.
   * Omitted means it does not: the capability probe has no run to ask about.
   */
  held?: boolean;
}

/**
 * How the user is handed THIS conversation, so they can carry it on themselves.
 *
 * A `command` is a shell invocation that opens the conversation in the CLI's
 * own TUI. The union has one arm today because that is what any CLI here can
 * actually do; the shape exists so a second delivery — a deeplink or a web
 * session URL, once an agent offers one — is a new arm rather than a new
 * subsystem. Nothing outside the adapter layer branches on which it is.
 *
 * A refusal is DATA, not an exception: the adapter layer knows nothing about
 * HTTP, and the owning module decides how to say it.
 */
/**
 * Which conversation is being moved to which profile, for
 * {@link AgentAdapter.carrySessionToConfigDir}.
 *
 * The FOLDER is deliberately absent. A CLI that stores conversations per
 * working directory already records which one this session belongs to, and
 * asking the caller would let the two disagree — claude's own doc block says
 * the directory name it uses is lossy and must never be re-derived, so the
 * only safe answer is the one the store itself gives.
 */
export interface CarrySessionInput {
  /** The conversation, in the CLI's own id namespace. */
  readonly sessionId: string;
  /** The profile that holds it now — null for the CLI's own default. */
  readonly from: string | null;
  /** The profile it should also be readable from — null for the default. */
  readonly to: string | null;
}

/**
 * Whether the conversation followed the run to its new profile.
 *
 * A refusal is DATA on the same rule {@link HandoffResult} follows, and here it
 * is a failure to switch when the adapter supports carrying sessions. For a
 * CLI that declares carrying unavailable, the switch still proceeds and the
 * transcript prints `reason` to explain the fresh conversation.
 */
export type CarrySessionResult =
  { carried: true } | { carried: false; reason: string };

/**
 * One conversation a DELETED run held, to be removed from the CLI's own store
 * — see {@link AgentAdapter.deleteSessionTranscript}.
 */
export interface DeleteSessionTranscriptInput {
  /** The conversation, in the CLI's own id namespace. */
  readonly sessionId: string;
  /** The profile that holds it — null for the CLI's own default. */
  readonly configDir: string | null;
  /**
   * When the geniro run was created. A conversation that BEGAN before it was
   * not started by geniro: it was imported from the user's own CLI, so it is
   * the user's terminal history and is never deleted with the chat.
   */
  readonly runCreatedAt: Date;
}

/** One conversation a run held, for {@link AgentAdapter.readSessionPullRequests}. */
export interface SessionPullRequestsInput {
  /** The conversation, in the CLI's own id namespace. */
  readonly sessionId: string;
  /** The profile that holds it — null for the CLI's own default. */
  readonly configDir: string | null;
}

/**
 * A github.com pull request the CLI's own record says one of its sessions
 * touched — created, pushed to, checked out, commented on or merged.
 */
export interface SessionPullRequest {
  owner: string;
  repo: string;
  number: number;
  url: string;
  /** When the CLI recorded it, or null when the record carries no readable time. */
  at: Date | null;
}

/**
 * Whether the conversation is gone. A refusal is DATA, as for
 * {@link CarrySessionResult}: deleting a run never fails over a transcript the
 * CLI kept, and `reason` is what the log line says about it.
 */
export type DeleteSessionTranscriptResult =
  { deleted: true } | { deleted: false; reason: string };

/**
 * A config directory the FOLDER pins, overriding the one geniro hands the CLI.
 *
 * geniro passes the run's profile as an environment variable, and an env var is
 * not the last word: a CLI that reads per-project settings can carry its own
 * `env` block, apply it to ITSELF, and run under a different account than the
 * one the chat says it is on. That is not hypothetical — measured 2026-08-27 on
 * claude 2.1.247, a folder whose `.claude/settings.local.json` sets
 * `env.CLAUDE_CONFIG_DIR` makes the CLI answer `get_usage` for the PINNED
 * profile's account while `CLAUDE_CONFIG_DIR` in its own environment still
 * names the one geniro chose.
 *
 * REPORTED as "I'm running my claude session in different config directory with
 * different account - but now its showing my limits for another account". The
 * limits were right and the PROFILE was wrong, which is the reading this type
 * exists to let the app state: the panel reports whichever account the CLI is
 * actually on, so the two must be able to disagree out loud rather than one of
 * them quietly winning.
 *
 * A null from {@link AgentAdapter.readConfigDirPin} means "nothing pins this
 * folder" — never "this CLI has no such mechanism", which the base's own
 * default already answers by returning null for every folder.
 */
export interface ConfigDirPin {
  /**
   * The directory the CLI will actually use, as the settings file spells it.
   *
   * NOT canonicalized: it is quoted back to the user beside the path they
   * picked, and resolving it would make the two look different for reasons
   * that have nothing to do with the override.
   */
  readonly effective: string;
  /** The file that pinned it — a path the user can open and edit. */
  readonly source: string;
}

export type HandoffResult =
  | {
      ok: true;
      kind: 'command';
      command: string;
      args: string[];
      /**
       * Environment the invocation needs, when a fact about the run cannot be
       * expressed in argv. Empty for most handoffs.
       *
       * It exists because the run's config directory — which ACCOUNT the
       * conversation belongs to — travels only as env (`CLAUDE_CONFIG_DIR`).
       * Dropping it would hand the user a `--resume` against their DEFAULT
       * profile, where that session id does not exist, and the CLI would open
       * an unrelated conversation rather than say so.
       */
      env: Record<string, string>;
    }
  | { ok: false; reason: 'unsupported' | 'no-session' };

/** The glyphs an agent CLI may be drawn with — see `AdapterConfig.identity`. */
export const AGENT_ICON_NAMES = ['bot', 'terminal', 'code'] as const;
export type AgentIconName = (typeof AGENT_ICON_NAMES)[number];

/**
 * One charge as the ACCOUNT behind a CLI reports it NOW — an element of what
 * `AgentAdapter.fetchAccountSpend` answers.
 *
 * An event, not a per-conversation sum, because a vendor REVISES an event's
 * charge after first listing it: measured 2026-10-05 against a real Cursor
 * account, a member whose ten events had all been seen was recorded at $8.44
 * while the same ten events summed to $134.86 — a long agent request is listed
 * early and its cost grows as it runs. Only a caller holding each event under a
 * stable {@link key} can replace a stale figure instead of freezing it.
 */
export interface AccountSpendEvent {
  /** The conversation it was billed to (for cursor, the ACP session id). */
  readonly conversationId: string;
  /**
   * What identifies this event across polls, unique within its conversation.
   * The vendor's own fields, never a position in a page.
   */
  readonly key: string;
  /** When the vendor dates the event, epoch millis. */
  readonly atMs: number;
  /** The model the vendor billed it under, or null when it names none. */
  readonly model: string | null;
  /**
   * What the account was charged for it, in cents — 0 for an event the vendor
   * marks as not chargeable, which is genuinely free rather than unmeasured.
   */
  readonly cents: number;
}

/** What one account poll read. */
export interface AccountSpendReply {
  /** Every event of the asked-about conversations inside the window. */
  readonly events: readonly AccountSpendEvent[];
  /**
   * Whether the window was read to its END. A walk cut short by its page bound
   * has seen only part of the window, so its absences prove nothing and the
   * caller must not treat anything inside it as final.
   */
  readonly complete: boolean;
}

/**
 * What `AgentAdapter.fetchAccountSpend` answers for an account that has no
 * login to ask with — no identity, no token — as against null, an ask that
 * failed. Nothing can read that account, so the poll lets a conversation
 * another of its accounts read whole settle without it.
 */
export const ACCOUNT_SIGNED_OUT = 'signed-out';

/** The window one account poll asks about, and the account it asks. */
export interface AccountSpendQuery {
  readonly startMs: number;
  readonly endMs: number;
  /** The conversations whose events are wanted; every other one is skipped. */
  readonly conversations: ReadonlySet<string>;
  /**
   * The config directory whose account is asked — the profile those
   * conversations ran under — or null for the CLI's default login.
   */
  readonly configDir: string | null;
}

/**
 * One switch a CLI offers that has no generic axis of its own — a boolean the
 * user sets once in Settings and every run of that CLI snapshots when it is
 * created, so flipping it changes the next run rather than one already open.
 * Derived from the wire schema its capabilities row publishes it through.
 */
export type AgentOptionSpec = Readonly<z.infer<typeof AgentOptionSpecSchema>>;

/**
 * Everything about ONE CLI that is STATIC — true of the binary before any turn
 * runs, and knowable without asking it anything.
 *
 * One object per adapter, declared in that adapter's `<name>.const.ts` and
 * returned by `AgentAdapter.getConfig()`, so every question whose only per-CLI input
 * is a VALUE is answered once, concretely, on the base class. A field here is
 * the reason a `listEfforts` / `listSkills` / `resolveApprovalMode` override no
 * longer exists on either adapter.
 *
 * What deliberately does NOT belong here:
 * - anything env-dependent (`command` is derived from `kind` through
 *   `resolveAgentBinary`, so a Settings cliPaths override still takes effect
 *   per access);
 * - anything the INSTALLED binary has to be asked (its model list, its reported
 *   commands, whether it streams partials) — config carries only how to ask and
 *   what to fall back to;
 * - anything with per-turn branching (argv assembly, stdin payload, child env)
 *   — those stay `buildArgs` / `buildStdinPayload` / `buildEnv`.
 */
export interface AdapterConfig {
  // ── Identity ────────────────────────────────────────────────────────────
  /**
   * The agent this adapter drives. Also the key `resolveAgentBinary` looks up,
   * so the binary name is never spelled a second time.
   */
  readonly kind: AgentKind;
  /**
   * The top-level names this adapter writes under the data folder, by what
   * they hold — read by Settings → Storage. `conversations` is what a live
   * chat resumes from; `caches` are rebuilt when missing; `state` must stay;
   * `leftovers` are names an older build of this adapter wrote and nothing
   * reads any more, the only ones Storage may delete. Absent: none.
   */
  readonly userData?: {
    readonly conversations?: readonly string[];
    readonly caches?: readonly string[];
    readonly state?: readonly string[];
    readonly leftovers?: readonly string[];
  };
  readonly ollama?: {
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly modelEnvKeys?: readonly string[];
    readonly baseUrlEnv?: string;
    readonly baseUrlConfig?: { flag: string; key: string; suffix: string };
    readonly envSettingsFlag?: string;
  };
  /**
   * How the UI NAMES this CLI — published on `GET /v1/capabilities`, so no
   * surface in the renderer maps an agent kind to a word or a description of
   * its own.
   */
  readonly identity: {
    /** The name on a card or a palette tile (`Cursor`). */
    readonly displayName: string;
    /** The one word a row of chrome has room for (`cursor`). */
    readonly shortName: string;
    /** One sentence on what this agent is, for the team palette. */
    readonly summary: string;
    /** The palette's detail lines — how a member of this CLI behaves. */
    readonly details: readonly string[];
    /**
     * Which glyph the UI draws for it — a NAME from a closed set the renderer
     * maps to its own icons, so no surface keeps a per-CLI icon table.
     */
    readonly icon: AgentIconName;
  };

  // ── Asking the user ─────────────────────────────────────────────────────
  /**
   * The tool this CLI uses to ask the USER a question, or null when it has no
   * question channel at all. The ONE discriminator between a genuine question
   * and a permission check — no service, executor or util may spell a tool name
   * itself.
   */
  /**
   * What this CLI does with a command it puts in the BACKGROUND.
   *
   * `unreportedDetachReason` is null when the CLI says so itself — claude
   * brackets such a command on its own `background_work` channel and reports
   * its ending there, which is the whole mechanism `announceShellWork` is built
   * on. A NON-null reason says the opposite and names what was measured: the
   * CLI backgrounds the command and then reports it FINISHED, so believing it
   * loses the command entirely, and the daemon falls back to asking the
   * operating system (`utils/process-descendants.ts`, driven by
   * `sweepDetachedShells`).
   *
   * A REASON rather than a boolean, on the rule every capability here follows:
   * the next reader has to be able to tell "this CLI is honest" from "we
   * measured it lying, here is what we saw", and a bare `true` says neither.
   */
  readonly shells: {
    readonly unreportedDetachReason: string | null;
    /**
     * Non-null when this CLI sends nothing at all while it waits on a command
     * it detached, so that wait reads as a hung turn. The daemon then treats a
     * quiet turn with such a command alive as waiting on it.
     */
    readonly silentWaitReason: string | null;
    /**
     * Non-null when nothing tells this CLI's agent that a command it left
     * running has ended once its turn is over, so the daemon starts a turn
     * for it (`CommandEndWakeService`). Null for a CLI that starts one itself.
     */
    readonly lateEndWakeReason: string | null;
  };
  readonly questionToolName: string | null;
  /**
   * Whether keeping this CLI's question channel open forces an unattended turn
   * onto the ask posture.
   *
   * True for claude, where it is load-bearing: `--dangerously-skip-permissions`
   * leaves the turn no permission-prompt channel and the AskUserQuestion tool
   * is not wired without one (probe-verified on 2.1.227 across every mode), so
   * a question-capable `auto` member has to spawn on the stdio dialogue with the
   * DAEMON standing in for the bypass. False for a CLI whose questions arrive
   * out-of-band — an ACP vendor request reaches the client whatever session
   * mode the agent is in — where forcing `ask` would park every ordinary
   * permission on a human verdict in a team run nobody is watching.
   *
   * Meaningless when `questionToolName` is null; declare it false there.
   */
  readonly questionsCostAskPosture: boolean;
  /**
   * Why geniro must SUPPLY this CLI's agent a question tool of its own, or
   * null when the CLI already gives its model one.
   *
   * {@link questionToolName} answers a different question — whether geniro can
   * RECEIVE a question this CLI raises — and the two came apart the moment one
   * was measured against the other. cursor-agent declares a question method
   * geniro answers in full, and its model has no tool with which to raise one:
   * asked to list its tools in a real chat, it answered "I do not have a tool
   * that lets me ask you a multiple-choice question and wait for your answer."
   * Its `askQuestionToolCall` is decided by that vendor's SERVER, and nothing
   * on this side can ask for it — the shipped 2026.08.11-e8db854 bundle reads
   * exactly one ACP client capability, `_meta.parameterizedModelPicker`, so
   * there is no flag to set and no capability to advertise.
   *
   * Non-null therefore means: register geniro's own `ask_user_question` over
   * the run's MCP endpoint, so the agent has a tool to reach the user with.
   * Null means the CLI's own tool is already there and a second one would be a
   * duplicate the model has to choose between.
   */
  readonly hostQuestionToolReason: string | null;
  /**
   * Why this CLI's MCP client will NOT hold ONE `tools/call` open for as long
   * as a PERSON takes to answer it — or null when it will.
   *
   * Non-null means `ask_user_question`, `propose_plan` and `propose_patch` must
   * answer IMMEDIATELY and let the user's answer arrive as the run's next
   * message instead (see `ChatService`'s deferred cards), because the
   * alternative is not a slow answer but a LOST one: the client gives up, the
   * model is handed a tool error, and the person is still reading the card.
   * The deadline is on `tools/call`, not on one tool, which is why the same
   * field covers all three.
   *
   * A REASON rather than a boolean, on the rule every capability here follows.
   * cursor-agent's is a MEASUREMENT of its shipped bundle
   * (2026.09.10-fd3934a), and every route out of it was checked before this
   * field was added: it calls the MCP SDK's `callTool({name, arguments})` with
   * no `RequestOptions`, so the SDK default of 60s stands; the same call site
   * leaves `resetTimeoutOnProgress` false, so progress notifications cannot
   * extend it; the ACP `session/new` HTTP server entry is
   * `{_meta?, headers, name, url, type}` with no timeout field, so geniro has
   * nothing to pass; `~/.cursor/mcp.json`'s own server schema
   * (`url, headers, cwd, envFile, auth, enabledTools`) has none either; and
   * the bundle carries no `MCP_*TIMEOUT*` environment variable at all. On
   * expiry the SDK sends `notifications/cancelled`, which is what reaches
   * `whileCancellable`.
   *
   * claude declares null, and that is not merely "unmeasured": geniro SETS its
   * ceiling itself, per server, in the turn's own `--mcp-config`
   * (`GENIRO_MCP_TOOL_TIMEOUT_MS`, a day).
   */
  readonly hostQuestionDeferredReason: string | null;
  /**
   * Why a call of one of geniro's own MCP tools could run outside `auto`
   * without the user being asked first, or null when it cannot: every such
   * call is put to the user, or refused, before it runs.
   *
   * `monitor` runs a shell command under no sandbox of its own, so a turn is
   * offered it only where this is null or its mode is `auto` (whose own shell
   * is unsandboxed on every CLI). A non-null reason keeps the tool from a mode
   * that sandboxes the agent's shell.
   */
  readonly hostToolCallUngatedReason: string | null;

  // ── Background sub-agents ───────────────────────────────────────────────
  /**
   * Whether this CLI reports the background sub-agents it runs, so the
   * renderer can enclose their work instead of spilling it into the
   * conversation.
   *
   * The mechanism is already CLI-agnostic — an adapter reports one by setting
   * {@link AgentEventOrigin.parentToolUseId} to the id of the tool call that
   * started the delegate — so this field says only whether a given CLI HAS
   * such a signal. Everything downstream (the transcript's sub-agent block,
   * the agents panel's sub-agent rows, the run badge that reads `running`
   * while one is out) keys on that id and never on which CLI produced it.
   *
   * A CLI that does not report one declares WHY, and the reason is a
   * MEASUREMENT with its date and its bounds — not a permanent property. See
   * `.claude/rules/agent-adapters.md`: write down what was checked, so the
   * next reader knows what to re-check rather than trusting the absence.
   * `cursor-acp` is the standing example of why that matters: it declared
   * `reports: false` on the strength of geniro's OWN ACP types carrying no
   * parent id — which measured this codebase, not the wire — and a probe of the
   * real CLI then found the signal (`cursor/task`) it had been discarding.
   *
   * Read by {@link stepsUnavailableReason}'s consumers and by
   * `GET /v1/capabilities` → `subagents[]`, so a chat on a CLI that reports
   * nothing can say so rather than showing an empty list.
   */
  readonly subagents: {
    /** This CLI reports its delegates on the stream. */
    readonly reports: boolean;
    /**
     * Why it does not, when it does not — the CLI's own sentence, naming what
     * was checked. Null when {@link reports} is true.
     */
    readonly unavailableReason: string | null;
    /**
     * Why a reported delegate's own CONVERSATION is not shown, when the CLI
     * announces the delegation but streams nothing the delegate did. Null when
     * its steps ride the same stream as the main thread's (claude), which is
     * what lets the block open into a real thread.
     *
     * A second, sharper fact than {@link reports} rather than a shade of it:
     * "geniro never saw a delegate" and "geniro saw the delegate and this CLI
     * does not stream its work" are different answers, and collapsing them left
     * a cursor delegate's card reading "this sub-agent has not done anything
     * yet" about one that had done thirteen seconds of it.
     *
     * Travels on the delegate's own row (the `subagent_info` item) rather than
     * through a capability lookup, so the row that declares a delegate also
     * carries the reason its thread is empty — one fetch, and the two can never
     * describe different CLIs.
     */
    readonly stepsUnavailableReason: string | null;
    /**
     * The tool NAMES whose call launches a delegate, as this CLI writes them on
     * a `tool_call` row. The run's state lists a delegate launched under one of
     * them even when no `subagent_info` declaration names it. `[]` for a CLI
     * whose launch carries no usable name — its delegates are admitted by the
     * declaration the daemon writes. Matched EXACTLY: the run state reads the
     * names of every CLI a team mixed, and another CLI's command row that
     * happens to be titled `task` is not a delegation.
     *
     * TWIN PARSER: `isAgentToolName` in apps/ui/src/renderer/chats/tool-kind.ts
     * is the client's own list of the same names, matched exactly too.
     */
    readonly launchToolNames: readonly string[];
  };

  /**
   * What the agent is told about work it leaves running when its turn ends.
   */
  readonly backgroundWork: {
    /**
     * Composed into every user-facing turn right after the host preamble, and
     * served on `GET /v1/capabilities` → `backgroundWorkNotes[]`. Null for a
     * CLI with nothing to say.
     *
     * Per CLI because the truth differs: geniro holds a claude or cursor turn —
     * and the call it answers — open while its background sub-agents run and
     * starts it again with their reports, while a codex turn settles the moment
     * it ends. An agent told nothing assumes the terminal it was built for and
     * polls with `sleep` for results that would have woken it. Every sentence
     * must hold for its CLI; re-check them against the hold whenever it moves.
     *
     * Static text only: nothing keys a kept process on it, so a process keeps
     * the text it started with — on claude's argv, and on ACP the block sent
     * once per session.
     */
    readonly agentNote: string | null;
  };

  /**
   * The tool NAMES whose call publishes a claude.ai-style artifact (a URL the
   * reply carries), as this CLI writes them on a `tool_call` row. `[]` for a
   * CLI with no such tool. Matched case-insensitively.
   *
   * TWIN PARSER: `isArtifactToolName` in
   * apps/ui/src/renderer/chats/artifact-payload.ts.
   */
  readonly artifactToolNames: readonly string[];

  // ── Approval policy ─────────────────────────────────────────────────────
  readonly approval: {
    /**
     * Every mode this CLI honours as a user-visible choice. A mode outside this
     * list is refused where the choice is MADE (chat create/patch).
     */
    readonly modes: readonly AgentApprovalMode[];
    /**
     * The subset of `modes` whose support cannot be known from the CLI's name
     * alone and must be PROVED against the installed binary. It decides whether
     * a run pays for a probe turn at all; `[]` means every claimed mode is real.
     */
    readonly probedModes: readonly AgentApprovalMode[];
    /**
     * What a mode degrades to once a probe PROVED the installed binary rejects
     * it, plus the line the transcript owes the user.
     *
     * A probed mode deliberately ABSENT from this table rides through and is
     * rejected loudly by the CLI. That absence is policy, not an oversight —
     * see claude's `plan`, where degrading a no-execute mode into an executing
     * one would invert the intent the user selected it for.
     */
    readonly degradeOnProbeFail: Readonly<
      Partial<
        Record<
          AgentApprovalMode,
          { readonly to: AgentApprovalMode; readonly reason: string }
        >
      >
    >;
    /**
     * The line owed to the user when a CLI with exactly ONE honoured mode is
     * asked for a different one — evaluated only when `modes.length === 1`, and
     * checked BEFORE `degradeOnProbeFail` (a single-mode CLI has nothing to
     * probe). Null when `modes` has more than one entry.
     */
    readonly soleModeDegradeReason:
      ((requested: AgentApprovalMode) => string) | null;
  };

  // ── Reasoning effort ────────────────────────────────────────────────────
  /**
   * The `--effort` vocabulary this CLI accepts, weakest first, or `[]` when it
   * has no such control at all. WRITTEN DOWN, never scraped from `--help`: a
   * CLI can accept a level its own help omits.
   */
  readonly efforts: readonly AgentEffort[];
  /**
   * Why this CLI offers no effort PICKER, or `null` when {@link efforts} has
   * entries. MUST agree with it — `[]` here with a null reason would render an
   * inert chip with nothing to explain it, which is the state this replaces
   * (pinned in `agent-adapter.spec.ts`).
   *
   * A SENTENCE, like the reasons on `usage` / `subagents` / `followUp`, because
   * the renderer shows it: an effort readout the user cannot change reads as
   * broken unless it names what DOES change it. "cursor cannot" is not enough —
   * the answer that helps is where the value actually lives.
   */
  readonly effortsUnavailableReason: string | null;
  /**
   * Why `AgentAdapter.askOnce` cannot put a one-off question to this CLI, or
   * null when it can. MUST agree with the method: null here means the adapter
   * overrides it.
   */
  readonly oneShotAskUnavailableReason: string | null;
  /**
   * The switches this CLI offers that geniro has no generic axis for, in the
   * order the Settings card draws them. Published on `GET /v1/capabilities`,
   * so a switch added here reaches the UI with no per-CLI code there; read per
   * turn through `AgentAdapter.agentOption`. Empty is a real answer.
   */
  readonly options: readonly AgentOptionSpec[];
  /**
   * Why this CLI cannot REOPEN a failed turn's conversation without replaying
   * its prompt, or `null` when it can.
   *
   * A per-CLI fact, declared here rather than inferred, because the mechanism
   * is one: `AgentTurnInput.resumeOnly` is read by the ACP driver alone, so an
   * adapter that does not read it runs the turn as an ordinary one — and a
   * retry's prompt is the EMPTY string, which every other path refuses
   * (`SendMessageDto`) and which this one would spend a real turn on while the
   * transcript said nothing was sent again.
   *
   * A SENTENCE for the reason its neighbours are: `ChatService.retry` refuses
   * with it and the row shows it, so it has to say what the user CAN do rather
   * than only that this cannot.
   */
  readonly resumeOnlyUnavailableReason: string | null;
  /**
   * Whether {@link efforts} is the WHOLE vocabulary, or only the part of it a
   * static list can hold.
   *
   * It decides one thing: whether the daemon refuses an unknown level UP FRONT,
   * at run creation, or lets the turn report what the agent said about it.
   *
   * True for a CLI whose levels belong to the BINARY — claude's `--effort` takes
   * the same words whichever model runs, so a word outside the list is one the
   * CLI will silently ignore, and refusing it is the only way the user learns.
   *
   * False for a CLI whose levels belong to the MODEL, where the list is a UNION
   * of the ones seen and cannot be complete: cursor's `gpt-5.2` offers
   * `extra-high`, which no other model has, so an exhaustive check refused a
   * level the CLI genuinely accepts and the run could not be created at all.
   * Such a CLI is not left unguarded — its driver checks the value against the
   * model's own options and says on the transcript when one does not apply,
   * which is both more accurate and available per turn rather than per app
   * release.
   */
  readonly effortsAreExhaustive: boolean;

  // ── Context window ──────────────────────────────────────────────────────
  /**
   * Why this CLI offers no context-window PICKER, or `null` when it does and
   * {@link AgentAdapter.listModelContextWindows} answers for real.
   *
   * There is no static superset beside it, unlike {@link efforts}, and that
   * asymmetry is deliberate: a window size is meaningless without the model it
   * belongs to (`1m` on a model that has no such axis is not a weaker version
   * of anything), so there is nothing a CLI-wide union could usefully stand in
   * for. A CLI answers per model or it declares this sentence and offers
   * nothing.
   */
  readonly contextWindowsUnavailableReason: string | null;

  // ── Models ──────────────────────────────────────────────────────────────
  /**
   * The documented alias / fallback set — the FLOOR of `listModels`, never the
   * whole of it, and what a CLI that cannot be asked answers with so the picker
   * is never empty. How the live list is obtained stays `listModels`, which is
   * the one member config cannot express (a home-file read vs a subcommand).
   */
  readonly builtinModels: readonly AgentModel[];

  // ── Skills / commands on disk ───────────────────────────────────────────
  /**
   * Where this CLI keeps what it can be invoked with, as path SEGMENTS joined
   * under each root (the project cwd first, then the user's home dir). Within
   * one root, `skills` are scanned before `commands` — the two arrays' order IS
   * the shadowing order the CLI itself applies, which the caller's
   * first-occurrence-wins de-dup relies on.
   */
  readonly skillRoots: {
    /**
     * The segments a CONFIG DIRECTORY stands in for, under a home root — so
     * `['.claude']` for a CLI whose home configuration lives at
     * `~/.claude` and whose `CLAUDE_CONFIG_DIR` replaces exactly that.
     *
     * It exists so the roots below are declared ONCE: a profile's own copy of
     * each is the same list with this prefix removed. `null` for a CLI whose
     * account is not decided by a directory (cursor says so in
     * `configDir.unavailableReason`), which then keeps the home root whatever
     * a run asks for.
     */
    readonly profileAnchor: readonly string[] | null;
    /** `<root>/<…>/<name>/SKILL.md` dirs; `[]` when the CLI has no skills convention. */
    readonly skills: readonly (readonly string[])[];
    /** `<root>/<…>/**.md` command files; `[]` when the CLI has no commands convention. */
    readonly commands: readonly (readonly string[])[];
    /**
     * The plugin HOSTS whose installed plugins this CLI also loads skills from,
     * discovered rather than enumerated: a cache root under the user's home
     * whose `<marketplace>/<plugin>/<version>` layout is walked at read time, so
     * no plugin name, marketplace or version is ever written down here and a
     * plugin installed after this shipped is found without a release.
     *
     * `[]` when the CLI has no plugin mechanism, or — the case worth stating —
     * when it already REPORTS its plugins' commands itself
     * (`listReportedCommands`), where scanning would file a second row per
     * skill under whatever name the files use rather than the name the CLI
     * answers to.
     */
    readonly plugins: readonly {
      /** Segments of the cache root, under the user's home dir. */
      readonly cacheDir: readonly string[];
      /**
       * The manifest paths (relative to a version dir) that mark it as a
       * plugin — this CLI's own list, in its own precedence order. Without it
       * the walk would return every three-deep directory under the root.
       */
      readonly manifests: readonly (readonly string[])[];
      /**
       * Where INSIDE a plugin this CLI's skills live, best build first. The
       * FIRST entry that yields any skill wins for that plugin: a plugin
       * shipping a build for this CLI beside a generic one must contribute the
       * former alone, or the same skill is offered twice under two spellings
       * and only one of them can actually be run.
       */
      readonly skillDirs: readonly (readonly string[])[];
    }[];
  };

  // ── Live (token-level) streaming ────────────────────────────────────────
  /**
   * How to establish whether the INSTALLED binary can stream partial assistant
   * text. Null when the CLI has no such mode at all, which answers
   * `supportsLiveStream` false without spawning anything.
   */
  readonly liveStream: {
    /** Utility argv whose stdout is searched — `--help` is the cheapest honest source. */
    readonly probeArgs: readonly string[];
    /**
     * ONE string, used twice by design: pushed onto argv when a turn asks for
     * partials, and searched for in `probeArgs`' stdout. The same binary that
     * would reject it on argv is the one that advertises it, so a single field
     * makes the two reads incapable of drifting apart.
     */
    readonly flag: string;
  } | null;

  // ── Commands the CLI reports about ITSELF ───────────────────────────────
  /**
   * How to harvest the built-ins and plugin commands that exist nowhere on disk
   * to be scanned: start one turn in a throwaway cwd and cancel it the instant
   * the normalized `slash_commands` event lands. Null when the CLI makes no such
   * report, which answers `listReportedCommands` with `[]` and never spawns.
   */
  readonly reportedCommands: {
    /** Never reached by the model — the turn is cancelled the moment init lands. */
    readonly probePrompt: string;
    /** A hung probe must not wedge the caller forever. */
    readonly probeTimeoutMs: number;
    /** Defensive bound on the reported list. */
    readonly maxCommands: number;
    /** Names starting with this are the CLI's INTERNALS, not things a user invokes. */
    readonly internalPrefix: string | null;
  } | null;

  // ── Commands geniro provides for this CLI ───────────────────────────────
  /**
   * The slash commands this application adds to that CLI, which exist nowhere
   * outside it — see {@link AgentGeniroCommand}. Empty for a CLI that needs
   * nothing added.
   */
  readonly geniroCommands: readonly AgentGeniroCommand[];

  // ── Agent-to-agent calls (MCP) ──────────────────────────────────────────
  readonly mcp: {
    /**
     * Whether the call tools are withheld until a machine-level trust probe has
     * PASSED. True is the cautious answer: the shut-out caller degrades VISIBLY.
     */
    readonly callToolsRequireTrustProbe: boolean;
    /**
     * Whether an MCP endpoint reaches this CLI ONLY through a config file in the
     * run's own cwd, merged before the spawn and restored after. False means the
     * endpoint rides the turn itself, so nothing outside it ever sees the token.
     */
    readonly endpointRequiresCwdConfig: boolean;
    /**
     * Why this CLI's loaded MCP servers cannot be listed, or null when they
     * can be.
     *
     * A VALUE rather than a method because nothing acts on it — it is carried
     * to the UI and shown. It exists so that "this folder has no servers" and
     * "this CLI cannot tell us" stay different answers: both are an empty list,
     * and a reader that cannot distinguish them either invents a reason or
     * branches on which CLI it is holding. This field is what lets the panel
     * say something true without ever asking that question.
     */
    readonly listingUnavailableReason: string | null;
    /**
     * Why NO server of this CLI can be switched off, or null when some can.
     *
     * SEPARATE from {@link listingUnavailableReason} on purpose: listing and
     * toggling are different capabilities that merely coincide today. Reading
     * one to answer the other would tell the first CLI that can list but not
     * toggle (or the reverse) a reason that does not answer the question.
     */
    readonly toggleUnavailableReason: string | null;
    /**
     * Why NO server of this CLI can be switched off for ONE turn
     * (`AgentTurnInput.mcpDisabled`, a team member's own switches), or null
     * when the adapter applies that field.
     *
     * Separate from {@link toggleUnavailableReason}: that switch writes the
     * CLI's own config and lasts, this one is per turn and writes nothing the
     * user's own CLI reads. A CLI can have either without the other.
     */
    readonly turnToggleUnavailableReason: string | null;
    /**
     * What this CLI loads in its OWN interactive session that a headless turn
     * never gets — the sentence the panel shows under the rows — or null when
     * there is no such difference.
     *
     * This exists because a LISTING cannot say it. The panel is complete for
     * the turns geniro actually runs, and the user compares it against their
     * terminal's `/mcp`, which shows more; with nothing said, the only
     * available conclusion is that geniro lost some rows. Stating the gap is
     * the whole fix — the missing servers must NOT be listed, because they are
     * genuinely not loaded and a row for one would promise tools the agent
     * does not have.
     */
    readonly interactiveOnlyNote: string | null;
    /**
     * Why a row the user turned down in their OWN config carries no switch.
     *
     * The one remaining reason a switchable CLI still shows a locked row: the
     * toggle writes the CLI's own per-folder list, which reaches every scope,
     * but it cannot undo a rejection whose every source copy the CLI unions.
     */
    readonly userDisabledReason: string;
    /**
     * Argv that signs this CLI in to ONE MCP server, with the server's name
     * appended — `['mcp', 'login']` for both CLIs today. Null when the CLI has
     * no such command, and then {@link loginUnavailableReason} says so.
     *
     * A VALUE, not a method: what differs per CLI is the words, not the
     * mechanism, so `AgentAdapter.runMcpLogin` is concrete over this.
     *
     * The daemon RUNS this — which is a REVERSAL of what this block said for
     * two milestones, on a measurement that was right about the fact and wrong
     * about the conclusion. The terminal handoff it reversed was kept a while
     * as the fallback and is now GONE, unused by any caller once every sign-in
     * moved in-app.
     *
     * What was measured (claude 2.1.223, re-confirmed on 2.1.232): with stdin a
     * pipe, `claude mcp login <name>` answers "stdin isn't a terminal, so
     * authentication can't be completed here" and exits BEFORE printing
     * anything — an upfront refusal, so no amount of waiting or piping helps.
     * True, and the conclusion drawn from it ("so it must go to the user's own
     * terminal") skipped the middle option: the CLI wants a TERMINAL, not a
     * human. Under a pty the same command prints its authorization URL, opens
     * the browser itself and serves its own `http://localhost:<port>/callback`
     * — measured 2026-08-17. The window a user was made to look at was never
     * the mechanism.
     *
     * The pty costs no native module ({@link AgentCommandOptions.pty} carries
     * the how and why), which is what the old note assumed it would.
     */
    readonly loginArgs: readonly string[] | null;
    /**
     * Substrings of this CLI's own output that mean a server sign-in did NOT
     * complete — matched case-insensitively.
     *
     * A daemon-run sign-in under a pty cannot read an exit STATUS: the status
     * belongs to the `script` wrapper, not to the CLI beneath it. What the CLI
     * says is the only verdict there is. Empty for a CLI whose sign-in the
     * daemon does not run.
     *
     * Note what this is NOT used for: whether the server is now authenticated.
     * That is re-read from the listing, exactly as the account login's status
     * is re-probed rather than inferred from an exit — this only decides which
     * sentence the panel shows about the attempt.
     */
    readonly loginFailureMarkers: readonly string[];
    /**
     * Why no server of this CLI can be signed in to, or null when they can.
     *
     * Separate from {@link toggleUnavailableReason} for the same reason that one
     * is separate from {@link listingUnavailableReason}: signing in and
     * switching off are different capabilities, and a CLI that gains one
     * without the other must not be handed a sentence answering the other
     * question.
     */
    readonly loginUnavailableReason: string | null;
    /**
     * How far one MCP change of this CLI reaches — which kept sessions a
     * switched server (`toggle`) or a completed sign-in (`signIn`) made stale,
     * so geniro retires exactly those. Each answer is a fact about where the
     * CLI keeps that state: a per-repository file, a per-profile file, or one
     * shared by every profile on the machine.
     */
    readonly changeReach: {
      readonly toggle: McpChangeReach;
      readonly signIn: McpChangeReach;
    };
    /**
     * Why an UNAPPROVED server of this CLI cannot be approved from here, or
     * null when it can.
     *
     * Separate from {@link toggleUnavailableReason} even though cursor answers
     * both with the same subcommand, because the two capabilities come apart on
     * the CLI that has one and not the other: claude's toggle writes
     * `disabledMcpServers` and reaches every scope, and approves nothing — its
     * `Pending approval` rows are cleared in the CLI's own `/mcp` screen, which
     * a headless turn cannot open. Reading the toggle to answer this would put
     * an Approve button on claude's rows with nothing behind it, which is the
     * silent no-op the whole block exists to prevent.
     *
     * There is no `approveArgs` beside it: approving IS enabling for the CLI
     * that can do it (`cursor-agent mcp enable <name>` answers "✓ Enabled and
     * approved MCP server", measured on 2026.08.11-e8db854 against a project
     * whose `.cursor/mcp.json` server listed as `not loaded (needs approval)`),
     * so `AgentMcpService.setEnabled` is already the whole mechanism and a
     * second argv would be a second way to spell one command.
     */
    readonly approveUnavailableReason: string | null;
    /**
     * How long this CLI's MCP client holds ONE `tools/call` to geniro's endpoint
     * open before it gives up on it, in milliseconds — a MEASUREMENT, and the
     * wall every wait the call tools serve has to finish inside.
     *
     * A call tool that waits (`await_agent`, a sync `call_agent`) and outlives
     * it does not merely come back late: the model is handed the CLI's own
     * timeout error while geniro still holds a waiter for a reply nobody will
     * read — a question parked meanwhile was handed to it, marked delivered and
     * later failed QUESTION_TIMEOUT unseen, and a sync call's final result was
     * consumed by it and never collectable. So the team runtime bounds every
     * such wait BELOW this figure and answers `pending` with the call id
     * (`CallBroker.waitCeiling`), the call untouched and collectable.
     *
     * Per CLI because the two transports measure differently — see each
     * adapter's `getConfig()` for what was measured.
     */
    readonly toolCallDeadlineMs: number;
  };

  // ── Signing the CLI itself in ───────────────────────────────────────────
  /**
   * How the user signs in to the CLI, as opposed to {@link AdapterConfig.mcp}'s
   * `loginArgs`, which signs in to one MCP server the CLI loads.
   *
   * A separate block because the two fail independently: a CLI whose account
   * session expired still lists its MCP servers' auth state fine, and the
   * message the user needs is about the CLI, not about a server.
   */
  readonly auth: {
    /**
     * Argv that starts this CLI's own interactive sign-in — `['auth', 'login']`
     * for claude 2.1.227, `['login']` for cursor-agent 2026.08.04-aaa8809, both
     * read from the binaries' own `--help`. Null when the CLI has no such
     * command, and then {@link loginUnavailableReason} says so.
     *
     * A VALUE, not a method: what differs per CLI is the words, not the
     * mechanism, so `AgentAdapter.runLogin` is concrete over this.
     *
     * The daemon RUNS this. It resolved it for a terminal to run for two
     * milestones, on the reasoning the MCP sibling above records at length —
     * an interactive browser flow wants a TTY — and the account login turned
     * out not to want even that: re-probed on claude 2.1.228 and cursor-agent
     * 2026.08.11, neither refuses a closed stdin. Both print a usable URL and
     * open the browser themselves, claude then accepting a pasted code and
     * cursor polling to completion. The resolve-only path is gone with its
     * last caller.
     */
    readonly loginArgs: readonly string[] | null;
    /** Why this CLI cannot be signed in to from here, or null when it can. */
    readonly loginUnavailableReason: string | null;
    /**
     * Argv that signs this CLI OUT — `['auth', 'logout']` for claude 2.1.227,
     * `['logout']` for cursor-agent, both read from the binaries' own `--help`.
     * Null when the CLI has no such command, and then
     * {@link logoutUnavailableReason} says so.
     *
     * It exists so a card can offer the action that MATCHES the state it is
     * reporting. Before it, the only account action was Sign in, offered to
     * every detected CLI including ones the probe had just confirmed signed in —
     * which reads as an unfinished setup step rather than as an option, and was
     * reported as exactly that.
     *
     * Resolved and never run, like every other invocation in this block: a
     * sign-out is quick and non-interactive, but it is still the user's account
     * and belongs in a terminal they can see, beside the sign-in that undoes it.
     */
    readonly logoutArgs: readonly string[] | null;
    /** Why this CLI cannot be signed out from here, or null when it can. */
    readonly logoutUnavailableReason: string | null;
    /**
     * Output substrings that mean "this CLI is now waiting for a code pasted on
     * stdin" during a sign-in the DAEMON is running.
     *
     * The reason it exists: `loginArgs` can be run headlessly — the two CLIs
     * print a URL and open the browser themselves — but they then finish in two
     * different ways, and a caller cannot tell them apart without asking. cursor
     * POLLS to completion and needs nothing ("Waiting for browser
     * authentication…", probed 2026-08-12 on 2026.08.11-e8db854 with stdin
     * closed, so its list is empty). claude prints `Paste code here if prompted
     * >`, and its browser round-trip may or may not complete over the localhost
     * listener it also opens — so its marker is what turns a hung child into a
     * field the user can paste into.
     *
     * EVIDENCE-GATED like {@link expiredMarkers}, and empty is a real answer: an
     * invented marker either never fires or fires on unrelated output and asks
     * the user for a code no CLI wants.
     *
     * NOTE the deliberate narrowing this contradicts nothing in: `mcp login`
     * genuinely REFUSES a non-TTY stdin (probe-verified, claude 2.1.223), and
     * that measurement was generalised to the ACCOUNT login without re-checking.
     * Re-probed on 2.1.228: `claude auth login` with stdin closed does not
     * refuse — it prints a usable URL and waits. The two commands differ.
     */
    readonly loginCodePromptMarkers: readonly string[];
    /**
     * The shape of the link the user must open to sign in to the ACCOUNT (never
     * applied to an MCP server's sign-in), for a CLI that prints another link
     * before it; null takes the first link printed. codex
     * announces its local callback server (`http://localhost:1455`) ahead of
     * the authorization URL, so the first link is the wrong one there.
     */
    readonly loginUrlPattern: RegExp | null;
    /**
     * Substrings that mark a failed turn as "your account session is no longer
     * valid" — matched case-insensitively against the turn's error message, and
     * the reason an error row can offer Sign in instead of only a stack trace.
     *
     * EVIDENCE-GATED, and empty is a legitimate answer: a marker invented from
     * wording nobody observed either matches nothing (a dead feature) or
     * matches too much, and offering sign-in for an unrelated failure sends the
     * user to a command that cannot fix what they hit. A CLI whose auth-failure
     * wording has not been seen declares `[]` and says so — the sign-in stays
     * reachable from the agents panel, which needs no failure to be pressed.
     */
    readonly expiredMarkers: readonly string[];
    /**
     * Patterns that mark a failed turn as the ACCOUNT's usage window being
     * spent — what makes {@link AgentFailureClass}'s `rate_limited` reachable.
     *
     * Patterns rather than the substrings {@link expiredMarkers} uses, because
     * the wording is a FAMILY: claude says `hit your session limit`, `hit your
     * usage limit`, `hit your monthly limit` and `hit your fast limit` for one
     * event, and listing every noun a vendor may put in the middle is how the
     * list comes to be one release behind.
     *
     * A pattern here must NOT carry the `g` flag: these literals are read on
     * every failure and `RegExp.test` advances `lastIndex` on a global one, so
     * the second matching failure of a run would silently not match.
     * `agent-adapter.spec.ts` fails the suite on one that does.
     *
     * EVIDENCE-GATED exactly like {@link expiredMarkers}, and `[]` is a real
     * answer: a pattern invented from wording nobody observed either matches
     * nothing or tells a caller to sit and wait out a limit it never hit.
     */
    readonly rateLimitPatterns: readonly RegExp[];
    /**
     * Patterns whose FIRST capture group is when that window reopens, as the
     * CLI wrote it — read only once {@link rateLimitPatterns} has matched.
     *
     * Same no-`g` rule, same evidence gate. `[]` means this CLI states a limit
     * and never says when it lifts, which is a different fact from having no
     * limit wording at all and is why it is its own list.
     */
    readonly resetsAtPatterns: readonly RegExp[];
    /**
     * Whole failure messages that are this CLI's own sentence for its vendor's
     * service refusing a request (account, plan, model or client version), read
     * by `failureFrom` into {@link AgentTurnFailure.refusedByService}. Matched
     * EXACTLY, after trimming: they are ordinary English, and the whole-message
     * match is what tells the CLI's sentence from an agent quoting it.
     *
     * Evidence-gated like {@link expiredMarkers}; `[]` is a real answer.
     */
    readonly serviceRefusalMarkers: readonly string[];
    /**
     * Env var names that belong to THIS CLI and must reach no child by
     * inheritance — stripped by `utils/child-env.ts` from every process the
     * daemon spawns, whichever agent it belongs to. The adapter registry
     * registers every adapter's list at boot, so the strip is the UNION over
     * every CLI the daemon knows, which no single adapter could spell.
     *
     * Two kinds belong here. CREDENTIALS, so one agent's key never reaches
     * another agent or its tool grandchildren — list them in
     * {@link inheritedEnvKeys} as well to hand them back to this CLI's own
     * children. And inherited SETTINGS that would silently override a per-run
     * choice: a config directory the launching shell chose for itself, an outer
     * session's identity, a feature switch the adapter sets only when the user
     * asked for it.
     */
    readonly isolatedEnvKeys: readonly string[];
    /**
     * Env var names this CLI is entitled to inherit from the daemon's own
     * environment — credentials that {@link isolatedEnvKeys} strips from EVERY
     * child so they cannot cross agents, re-injected for this one alone. Each
     * one must also be in {@link isolatedEnvKeys}: a name that is not stripped
     * reaches every child anyway, so listing it here would protect nothing.
     * Their values are also registered with the debug log's redaction, since
     * this process holds them.
     *
     * A FIELD rather than a hook, and the reason is the bug it replaced: the
     * entitlement used to live in `buildEnv`, which only the turn path calls, so
     * a CLI's turns ran authenticated while its `runCommand` listings ran signed
     * out — cursor's model picker collapsed to one row and its MCP panel
     * reported nothing, both reading as facts about the user's setup rather than
     * as a failure to ask. Two call paths were free to disagree about the same
     * entitlement. One list read once on the base makes that unrepresentable.
     *
     * Empty is a real answer: a CLI whose credentials live on disk needs nothing
     * here. Like {@link expiredMarkers} that is a MEASUREMENT, not an
     * assumption — say what was checked, because "needs no env" and "we never
     * tried without it" look identical from the outside.
     */
    readonly inheritedEnvKeys: readonly string[];
  };

  // ── Taking over a conversation the CLI already holds ────────────────────
  /**
   * What this CLI can offer of the conversations already on the user's machine
   * — the facts behind {@link AgentAdapter.listSessions},
   * {@link AgentAdapter.prepareSessionImport} and
   * {@link AgentAdapter.readSessionHistory}.
   */
  readonly sessions: {
    /**
     * Why the conversations this CLI holds cannot be listed, or null when they
     * can be. Carried to the picker and shown there, so an empty list explains
     * itself instead of reading as "you have no history".
     */
    readonly listingUnavailableReason: string | null;
    /**
     * What the listing DOES NOT reach, or null when it reaches everything.
     *
     * Separate from {@link listingUnavailableReason} because it is the shape
     * that would otherwise be invisible: cursor lists its ACP sessions in full
     * and holds a second store — its interactive `cursor-agent` chats — that
     * the same server answers `Session not found` for (probed 2026-08-16 on
     * 2026.08.11-e8db854, an id out of `~/.cursor/chats/` under its own
     * recorded cwd). A user whose terminal history is all in that store sees a
     * short, correct list and concludes the feature is broken; this is the
     * sentence that tells them which half they are looking at.
     */
    readonly listingPartialReason: string | null;
    /**
     * Why a resumed thread starts with an empty transcript, or null when its
     * history arrives one way or the other.
     *
     * Non-null is the honest answer for a CLI that can hand back the
     * conversation but not the record of it — the thread continues correctly
     * (the AGENT still has its context) while geniro can show nothing before
     * the user's next message, which without a sentence reads as an import that
     * silently did nothing.
     */
    readonly historyUnavailableReason: string | null;
    /**
     * Why a search of these conversations reaches only their titles and
     * folders, or null when it reaches what was SAID in them.
     *
     * A picker's search is only as good as the text behind it, and a title here
     * is one line — for claude, the conversation's opening prompt. Somebody
     * looking for the thread where a bug was diagnosed remembers the diagnosis,
     * not how they opened the conversation, so a title-only search finds
     * nothing and reads as a broken feature rather than as a narrow one. What
     * makes the difference is whether the transcript is READABLE: claude keeps
     * one JSONL per session in its own profile, while cursor's lives inside an
     * ACP server whose `session/list` has no search parameter at all.
     */
    readonly contentSearchUnavailableReason: string | null;
  };

  // ── Config directory (which profile / account the CLI runs as) ──────────
  /**
   * Whether this CLI can be pointed at a different config directory for one
   * invocation — the directory holding its credentials, settings and plugins,
   * and therefore which ACCOUNT the turn runs under.
   */
  readonly configDir: {
    /**
     * The env var that carries it to this CLI (`CLAUDE_CONFIG_DIR`), or null
     * when the CLI has no such mechanism. Named here rather than spelled in
     * `buildEnv` because it is the same kind of per-CLI VALUE as a flag name,
     * and the adapter rules put those in config.
     */
    readonly envVar: string | null;
    /**
     * Why this CLI cannot be given one, or `null` when it can.
     *
     * Non-null is the "this CLI has no such thing" answer, and it is what
     * stops a run's `configDir` being validated, refused, or spawned for an
     * agent that would ignore it — geniro becoming the silent one is exactly
     * the failure the field exists to prevent. MUST agree with `envVar`: a
     * null reason promises a var to carry it, or an adapter override of
     * `configDirEnv` and of its turn env that carries the account instead.
     */
    readonly unavailableReason: string | null;
    /**
     * Why an OPEN conversation cannot follow the run to another profile, or
     * null when it can.
     *
     * A separate question from `unavailableReason`, and a run can genuinely
     * answer them differently: pointing the NEXT turn at another account is
     * one thing, and taking the conversation so far with it is another. Where
     * this is non-null the switch still happens — the thread's transcript is
     * geniro's own and is untouched — but the agent starts a fresh CLI
     * conversation from that point, which is what the user is told.
     *
     * MUST agree with {@link AgentAdapter.carrySessionToConfigDir}: a null
     * reason promises that method does something; if that operation fails,
     * the switch keeps the previous profile and conversation.
     */
    readonly sessionCarryUnavailableReason: string | null;
  };

  /**
   * The file this CLI loads in EVERY folder as the user's own standing
   * instructions, or why it has none. A thread analysis may recommend edits to
   * it, so the path must be the one the CLI really reads — under a run's
   * `configDir` when one is set, else under `homeDir` in the user's home.
   */
  readonly userInstructions: AgentUserInstructions;

  // ── A message into a turn that is already running ───────────────────────
  /**
   * Whether this CLI can be handed a user message MID-TURN — the fact behind
   * `buildFollowUpPayload`, lifted into config so it can be reported.
   *
   * The method alone could never answer this for the renderer: it is
   * `protected`, per-turn, and only tells you what happened AFTER a message was
   * already written. The composer needs to know BEFORE it offers the control,
   * because the queue's "send now" is exactly this capability and an agent
   * without it must not be offered a button that silently parks the message.
   *
   * MUST agree with `buildFollowUpPayload`: null here promises the override
   * exists. The two are pinned together in `agent-adapter.spec.ts` — a config
   * claiming a channel the adapter never implements would have the composer
   * promise immediate delivery and the daemon answer RUN_BUSY.
   */
  readonly followUp: {
    /**
     * Why this CLI cannot take a message into a running turn, or `null` when it
     * can. A SENTENCE, like the two reasons above, because the renderer shows
     * it on the disabled control — "not available" with no cause is the silent
     * refusal these fields exist to replace.
     */
    readonly unavailableReason: string | null;
    /**
     * Whether delivering that message STOPS what the agent is currently doing.
     *
     * The two shipped CLIs answer this differently and the difference is what
     * the user is about to do, so it cannot be left to a shared sentence.
     * Claude's stream-json stdin is a conversation: the message joins the turn
     * and the agent picks it up at its next tool boundary, having finished what
     * it was on. Cursor's ACP has no such frame, and a second `session/prompt`
     * on a live session CANCELS the first — probe-verified on
     * 2026.08.11-e8db854, where a counting turn twelve seconds in answered
     * `{"stopReason":"cancelled"}` while the injected prompt ran to `end_turn`
     * with the conversation intact.
     *
     * So a press means "add this" on one CLI and "drop what you are doing and
     * answer this" on the other — a tool call in flight is lost on the second.
     * The renderer says which before the press rather than after.
     */
    readonly interrupts: boolean;
    /**
     * Whether the CLI says when it TAKES a message written into its stdin, as
     * a `user_message_consumed` event.
     *
     * What it buys is a turn that does not end under an unanswered message.
     * A follow-up that joins a turn can miss it — written while the model is
     * producing its last words, it is answered in a further `result` of its
     * own — and only an acknowledgement tells that case apart from one already
     * answered. With it, `runCliSession` holds the first `result` until every
     * delivered message has been taken. Without it, the turn settles on the
     * first `result` as it always did.
     *
     * Only meaningful for the stdin-line channel (`buildFollowUpPayload`); a
     * driver that sends follow-ups itself decides its own turn's end.
     */
    readonly consumptionReported: boolean;
  };

  // ── What a turn cost ───────────────────────────────────────────────────────
  /**
   * Whose models this CLI runs — what tells an analysis's judge apart from the
   * members it marks, since a judge favours its own vendor's work. Absent: not
   * known for any model.
   */
  readonly modelVendor?: AdapterModelVendor;
  /**
   * Whether this CLI reports the tokens and money a turn spent, or the reason
   * its context meter will always be empty.
   *
   * Here rather than inferred from an absent figure, because the two look
   * identical from outside and mean opposite things: a turn that has not
   * finished yet has no usage, and a CLI that never sends any has none either.
   * The renderer cannot tell them apart, and a blank ring answered the user's
   * "why don't I see context here?" with silence.
   */
  readonly usage: {
    /**
     * Why usage never arrives, or `null` when it does. A SENTENCE, for the same
     * reason as the fields above: it is what the meter says when pointed at.
     */
    readonly unavailableReason: string | null;
    /**
     * Whether this CLI can be asked what its window currently HOLDS — the
     * category breakdown behind `AgentSession.readContextUsage` — and if so,
     * WHICH channel the answer comes from.
     *
     * Its own field beside the one above rather than folded into it, because
     * the two are genuinely independent: a CLI can report a turn's token
     * totals perfectly and still have no channel for "what is in the window
     * and what put it there".
     *
     * The channel rides the same field as the reason so the two cannot
     * disagree — and it is here rather than left implicit because the CALLER
     * has to know whether there was anything to ask before it can say why an
     * answer is missing. Inferring that from "either channel exists" told
     * every reaped claude chat that its agent "did not answer in time" when
     * nothing had been asked at all: claude reads from the live process alone,
     * and a claude chat that has ever run keeps a session id forever.
     */
    readonly breakdown: UsageReading;
    /**
     * The same answer for what the ACCOUNT behind this CLI is allowed — the
     * plan's rate-limit windows behind `AgentAdapter.readPlanLimits`.
     *
     * A third independent field for the same reason the second one exists: the
     * three questions are answered by three different mechanisms, and a CLI can
     * have any one of them without the others. Plan limits are not even about
     * the conversation — they are about the subscription the conversation runs
     * on — so a CLI reporting a perfect window breakdown may still have no way
     * to say when the user will be cut off.
     */
    readonly planLimits: UsageReading;
    /**
     * Whether this CLI's MONEY has to be fetched from its account rather than
     * read off a turn — the switch that puts its conversations under
     * `PolledSpendService`, which asks `AgentAdapter.fetchAccountSpend` on a
     * cadence of its own and never per turn. `false` for a CLI whose turns
     * price themselves.
     */
    readonly polledSpend: boolean;
    /**
     * Which public price-catalog provider this CLI's MODELS are priced under,
     * or the reason they are not — read by {@link AgentAdapter.listPriceOf}.
     *
     * A per-CLI fact and not a per-PROFILE one, deliberately: a list price is a
     * property of the model, and the same model costs the same list price
     * whichever account (a ChatGPT plan, an enterprise workspace, an API key)
     * the CLI is signed in under. What a CLI does with the figure is its own —
     * one that prices nothing on its wire puts it on the turn, one that does
     * uses it only where its own figure stops (claude's delegates).
     */
    readonly listPrice: AdapterListPrice;
  };

  // ── Handing the conversation to the user ────────────────────────────────
  /**
   * How this CLI reopens one of ITS OWN sessions interactively, so the user can
   * take the conversation over — or the reason it cannot.
   *
   * Probe-verified that the reason arm is not hypothetical: cursor-agent
   * accepts `--resume <id>`, but an ACP session id is not in its chat store, and
   * resuming an unknown id SILENTLY CREATES AN EMPTY CHAT rather than failing.
   * A missing handoff there is not a gap to paper over — offering the button
   * would drop the user into a blank conversation with no error anywhere.
   */
  readonly handoff:
    | {
        readonly kind: 'resume-command';
        /** The flag that resumes a session id — argv is `[resumeFlag, sessionId]`. */
        readonly resumeFlag: string;
        /**
         * The flag that opens a COPY of a session — argv `[heldFlag, sessionId]`
         * — used in place of `resumeFlag` while geniro's own kept process still
         * holds the conversation, for a CLI that lets only one process hold one
         * at a time. Null for a CLI whose conversation can be opened while
         * another of its processes has it open.
         */
        readonly heldFlag: string | null;
        /**
         * The flag naming the model, so a mirror opens on the SAME model the chat
         * is running.
         *
         * Without it the TUI resumes under the CLI's own default, which is a
         * different model with a different window — so the mirror of a 1M-window
         * chat reported a 200k context beside it and read as a different
         * conversation entirely.
         *
         * Required, not nullable: a CLI whose TUI cannot be told a model would
         * declare that by having no `terminal` block worth resuming into at all.
         * A real one re-adds the null arm with its reason, and a test that enters
         * it.
         */
        readonly modelFlag: string;
        /**
         * What a resumable session id looks like for this CLI. A value produced by
         * a DIFFERENT CLI must not be handed to this one's TUI.
         */
        readonly sessionIdPattern: RegExp;
      }
    | {
        readonly kind: 'unavailable';
        /** Stated to the user verbatim, so "no button" is never unexplained. */
        readonly reason: string;
      };

  // ── Compacting before the window fills ──────────────────────────────────
  /**
   * How this CLI is told to compact its OWN conversation before the window
   * fills — or the reason it cannot be told at all.
   *
   * geniro's own rule can only ever fire BETWEEN turns, because `/compact` is
   * itself a turn and the CLI is busy. That is too late for an agent whose one
   * turn eats a third of the window: measured on a live run (2026-09-22, member
   * `engineer`, threshold 80%), turns settled at 79% and 57% while the window
   * climbed to 92% INSIDE the turn after them, and the only thing that caught
   * it was claude's own compaction at ~97%. A CLI that compacts itself mid-turn
   * is the only mechanism that holds a threshold at all, so where one exists
   * geniro hands it the threshold instead of guessing between turns.
   */
  readonly autoCompact: AdapterAutoCompact;
}

/**
 * What a CLI accepts as its auto-compaction threshold — see
 * {@link AdapterConfig.autoCompact}.
 */
export type AdapterAutoCompact =
  | {
      /**
       * The CLI takes a WINDOW SIZE and compacts a fixed buffer short of it, so
       * geniro asks for a threshold by naming the window that produces it.
       */
      readonly kind: 'window-flag';
      /** The flag, spelled as the CLI spells it — argv is `[flag, tokens]`. */
      readonly flag: string;
      /**
       * How far short of the stated window the CLI actually compacts, in
       * tokens — so the window geniro asks for is the threshold it wants PLUS
       * this.
       *
       * A MEASUREMENT, not a documented constant: claude 2.1.276's `/context`
       * names the reserve outright ("Autocompact buffer"), and it read 33k
       * unchanged at 100k, 150k and 200k on haiku and at 900k on
       * `claude-opus-5[1m]` — so it is a fixed reserve rather than a share of
       * the window. Re-measure with `claude -p --autocompact <n> '/context'`,
       * which costs nothing (the command never reaches the API).
       */
      readonly summaryBufferTokens: number;
      /** The smallest window the CLI accepts; it refuses argv below this. */
      readonly minTokens: number;
      /** The largest it accepts. Above the model's own window it clamps. */
      readonly maxTokens: number;
    }
  | {
      /**
       * The CLI takes the THRESHOLD itself, as a `key=value` config override
       * at spawn — argv is `[flag, "<key>=<tokens>"]`, with no buffer on top.
       */
      readonly kind: 'config-override';
      /** The override flag, spelled as the CLI spells it. */
      readonly flag: string;
      /** The config key the token count is assigned to. */
      readonly key: string;
      /** The smallest threshold worth sending. */
      readonly minTokens: number;
    }
  | {
      readonly kind: 'unavailable';
      /** Why, and what was checked — so the next reader knows what to re-check. */
      readonly reason: string;
    };

/**
 * What the daemon hands every adapter it constructs: the shared services an
 * adapter may lean on, and never a fact about any one CLI.
 *
 * Each adapter turns this into its own options bag in a static `forDaemon`
 * beside its class, so where its per-turn files live, which store it keeps
 * its conversations in and which probe it runs are decided in that CLI's own
 * directory — `agents.module.ts` only lists which adapters exist.
 */
export interface AdapterDaemonDeps {
  /** The daemon's userData dir; an adapter keeps its own files under it. */
  readonly userDataDir: string;
  /** The spawn every turn goes through (the `agent-stdio` debug tee). */
  readonly spawn: SpawnFn;
  /** A logger for the named adapter's diagnostics. */
  readonly logger: (name: string) => SessionLogger;
  /** Handshake / vocabulary answers that survive a daemon restart. */
  readonly vocabularyStore: ModelVocabularyStore;
  /** The memoized `--version` reader every cache is keyed by. */
  readonly versions: AgentVersionService;
  /** Where an adapter registers a child it starts outside a turn. */
  readonly processes: ProcessRegistry;
  /** What this client tells a CLI it is, when a protocol asks. */
  readonly clientVersion: string;
  /**
   * The public model price catalog — synchronous, in memory, never the network
   * on a lookup. See `ModelPriceCatalog`.
   */
  readonly prices: ModelPriceLookup;
}

/**
 * Whose models a CLI runs — see {@link AdapterConfig.modelVendor}: one vendor
 * for every model, or one per model id prefix, matched case-insensitively; a
 * model no prefix matches (an `auto` pick) has no known vendor.
 */
export type AdapterModelVendor =
  | { readonly kind: 'fixed'; readonly vendor: string }
  | {
      readonly kind: 'by-model-id';
      readonly prefixes: readonly {
        readonly prefix: string;
        readonly vendor: string;
      }[];
    };

/**
 * Where a CLI's models get a LIST price from — see
 * {@link AdapterConfig.usage}.listPrice.
 */
export type AdapterListPrice =
  | {
      readonly kind: 'catalog';
      /** The catalog provider the CLI's model ids are that provider's API ids under. */
      readonly provider: ModelPriceProvider;
      /**
       * Whether the catalog's context window for a model is the window this
       * CLI enforces — what a turn's `--autocompact` threshold may be a share
       * of before the CLI has reported one itself. A MEASUREMENT per CLI: the
       * catalog states the vendor API's limit, and a CLI can apply its own.
       */
      readonly catalogWindows: boolean;
      /**
       * The catalog's `cache_write` is the vendor's shortest cache lifetime; a
       * CLI that writes a longer one is billed this multiple of `input` instead.
       * Read to apportion a bill among token classes (`billingRatesOf`), never to
       * price a turn.
       */
      readonly cacheWriteInputMultiple?: number;
    }
  | {
      readonly kind: 'unavailable';
      /** Why, and what was checked — so the next reader knows what to re-check. */
      readonly reason: string;
    };

/**
 * One note a CLI keeps in its own memory, read for the user's import into the
 * shared memory. `projectKey` is how the CLI files it under a project (what
 * `AgentAdapter.nativeMemoryProjectKey` makes of a folder) or null for a note
 * of no project; `importedFrom` is where it came from, as the entry's
 * provenance shows it; `type` is the CLI's own word, unchecked.
 */
export interface NativeMemoryNote {
  path: string;
  importedFrom: string;
  projectKey: string | null;
  /** The folder the CLI wrote the note for, when it can tell; else null. */
  folder: string | null;
  title: string;
  body: string;
  type: string | null;
}

/** What one profile of a CLI keeps in its own memory, and where it looked. */
export interface NativeMemoryReading {
  location: string;
  notes: NativeMemoryNote[];
}

/** One tool call as the tool ledger counts it (`AgentAdapter.toolCallMetric`). */
export interface ToolCallMetric {
  tool: string;
  /** The MCP server the tool came from, as the CLI names it; null for the CLI's own tool. */
  server: string | null;
}
