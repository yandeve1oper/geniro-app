import { spawn as nodeSpawn } from 'node:child_process';

import { awakeTimeout, type AwakeTimer } from '../../../utils/sleep-watch';
import type {
  AgentApprovalMode,
  AgentEvent,
  AgentTurnHandle,
  ApprovalOption,
  CommandRecord,
  FollowUpMessage,
  SessionCloseCause,
  SubagentTrackingLost,
  TurnIo,
} from '../adapters/adapter.types';
import { isUserQuestion } from './approval-answer';
import { buildChildEnv } from './child-env';
import { currentChildJournal, trackDetachedChild } from './child-journal';
import { foldTurnComplete, foldUsage } from './fold-turn-complete';
import { createGroupTerminator } from './kill-tree';
import { MAX_BUFFERED_LINE_CHARS, NdjsonBuffer } from './ndjson-buffer';
import {
  commandLiveness,
  commandTargets,
  descendantsOf,
  endedRecordOf,
  isGroupAnchored,
  listProcesses,
  type ProcessRow,
  type RecordedGroup,
  recordedPidsRunning,
} from './process-descendants';
import { decodePsText } from './process-usage';
import {
  type PlainProcess,
  RUN_ID_ENV,
  scanPlainTable,
} from './run-process-scan';

/**
 * The slice of a child process this module depends on. Narrower than node's
 * `ChildProcess` so a test can supply a fake without reconstructing the whole
 * interface — the real `spawn` result satisfies it structurally.
 */
export interface SpawnedProcess {
  /** Child PID. Doubles as the process-group id when spawned `detached`. */
  readonly pid?: number;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  readonly stdin: NodeJS.WritableStream | null;
  on(
    event: 'close' | 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  on(event: 'error', listener: (err: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedProcess;

/**
 * Default: node's `spawn` with all three stdio streams piped, and `detached` so
 * the child becomes its own process-group leader. That lets {@link runCliSession}
 * signal the WHOLE group on cancel/shutdown (`process.kill(-pid, …)`) and reap the
 * tool/MCP grandchildren a coding agent forks — a single-PID kill would orphan them.
 *
 * `detached` is also what makes the group survive the daemon's own death, so the
 * spawn is journaled here — in the same expression that creates it, before any
 * caller can see the child. The next boot reaps whatever the journal still
 * holds; see `child-journal.ts`.
 */
export const defaultSpawn: SpawnFn = (command, args, options) => {
  const child = nodeSpawn(command, args, {
    ...options,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  trackDetachedChild(child, command);
  return child;
};

/**
 * When the child's stdin is closed — the one knob that decides whether a
 * process serves one turn or many.
 *
 * - `payload` — closed immediately after the opening payload, so a CLI reading
 *   its prompt from argv never blocks on stdin.
 * - `turn` — closed on the turn's terminal event, so a stream-json CLI that
 *   held a mid-turn dialogue stops waiting and exits. ONE turn per process.
 * - `session` — never closed automatically; only {@link CliSession.close} ends
 *   it. This is what lets one process serve turn after turn, which is the
 *   whole point: the CLI's own MCP servers (and anything they own, up to a
 *   browser the user is logged into) are booted once per RUN instead of once
 *   per message.
 */
export type StdinLifetime = 'payload' | 'turn' | 'session';

/**
 * The session owner's answer for an approval request that arrives with NO turn
 * in flight: `true` answer it now, `false` refuse it now, `null` hold it for
 * the next turn to adopt.
 *
 * Named because three signatures spell it — the session option, the adapter's
 * `startSession` opts, and the registry's `startTurn` — and a shape restated
 * three times is a shape that drifts.
 *
 * The tool NAME is what tells a question from a permission, and keying on the
 * name rather than on a payload flag is this codebase's standing rule for that
 * decision — a flag can drift between CLI releases and quietly move a tool
 * across the human gate. The arguments ride along for a permission whose
 * answer depends on what it asks for (a gallery naming a URL).
 */
export type BetweenTurnApproval = (request: {
  toolName: string;
  input: unknown;
}) => boolean | null;

/** An `approval_request`, narrowed — the only event kind that is ever held. */
export type ApprovalRequestEvent = Extract<
  AgentEvent,
  { type: 'approval_request' }
>;

/**
 * How many between-turn approval requests one session will hold at once.
 *
 * Not a tuning knob so much as a refusal to grow without bound: a CLI that
 * keeps asking on a chat the user has walked away from would otherwise hold
 * one entry — and one blocked tool call — per request for the session's whole
 * 30-minute life. Twenty is far above any real conversation's between-turn
 * backlog (a turn holding even two is unusual) while still being a number.
 */
const MAX_HELD_APPROVALS = 20;

/** Everything one turn on a {@link CliSession} needs. */
export interface CliTurnOptions {
  /**
   * Written to the child's stdin to open this turn. Undefined = nothing to
   * write (a CLI that takes its prompt from argv, or a protocol whose opening
   * message comes from {@link CliTurnOptions.onStdinReady} instead).
   */
  stdinPayload?: string;
  onEvent: (event: AgentEvent) => void;
  /**
   * Encode one approval verdict as the stdin line the CLI expects (the
   * adapter owns the wire format). Undefined = this CLI has no approval
   * protocol and `respondApproval` is a no-op.
   */
  buildApprovalResponse?: (
    id: string,
    allow: boolean,
    updatedInput?: unknown,
    option?: ApprovalOption,
  ) => string | undefined;
  /**
   * Encode a user message sent while THIS turn is still running, as the stdin
   * line the CLI expects. Undefined = this CLI cannot be told anything more
   * once its prompt is in, and `sendUserMessage` is a no-op.
   */
  buildFollowUpPayload?: (message: FollowUpMessage) => string | undefined;
  /**
   * Deliver that same message through a driver that writes for itself, for a
   * CLI whose channel is a request in a stateful protocol rather than one
   * stdin line ({@link TurnDriver.sendFollowUp}).
   *
   * Takes precedence over {@link buildFollowUpPayload} when both are defined.
   * The settle guard is still applied HERE, so a driver never has to know
   * whether the turn it is driving is already over.
   */
  sendFollowUp?: (message: FollowUpMessage) => boolean;
  /** {@link TurnDriver.subagentsAFollowUpCancels}. */
  subagentsAFollowUpCancels?: () => number;
  /**
   * The CLI acknowledges each message it takes off stdin with a
   * `user_message_consumed` event (`AdapterConfig`'s
   * `followUp.consumptionReported`), so a follow-up written through
   * {@link buildFollowUpPayload} is tracked until it is taken, and a
   * `turn_complete` arriving before then does not end the turn — see
   * {@link TurnState.unconsumedFollowUps}.
   */
  followUpConsumptionReported?: boolean;
  /**
   * The text of this turn's own prompt, as the CLI echoes it back when it TAKES
   * it — the same `user_message_consumed` that crosses off a follow-up. Read
   * only alongside {@link followUpConsumptionReported}: it is what tells a
   * continuation that ABSORBED this prompt from one that merely finished ahead
   * of it — see {@link TurnState.promptTaken}.
   */
  promptText?: string;
  /**
   * Encode a mid-turn approval-mode change as the stdin line the CLI expects.
   * Undefined = THIS turn cannot be re-moded, and `setApprovalMode` is a no-op
   * — which is a per-TURN fact, not a per-CLI one: the same adapter answers
   * differently for a turn it spawned with a permission dialogue and one it
   * spawned without.
   */
  buildApprovalModePayload?: (mode: AgentApprovalMode) => string | undefined;
  /**
   * Encode an in-protocol "stop what you are doing" as the stdin line the CLI
   * expects. Undefined = this turn can only be stopped by killing it.
   *
   * Only consulted for a `session` stdin lifetime, and that restriction is the
   * point rather than an optimization: on a one-turn process killing the group
   * costs nothing extra, while on a run-scoped one it would tear down exactly
   * the MCP servers the session exists to keep alive. Probe-verified on claude
   * 2.1.223 — a `control_request`/`interrupt` was answered in 2ms and ended the
   * turn with the process still running.
   */
  buildInterruptPayload?: () => string | undefined;
  /**
   * Asked FIRST when a run-scoped turn is stopped: withdraw the prompt if the
   * DRIVER is still holding it behind frames of its own (`TurnDriver.
   * withdrawHeldPrompt`). True means the CLI was never asked anything, so the
   * turn settles `turn_cancelled` at once with no interrupt written and nothing
   * killed — the twin of {@link holdPrompt}'s own hold, which this module
   * answers the same way without asking anyone.
   */
  withdrawPrompt?: () => boolean;
  /**
   * Asked when the PROCESS ends under this turn before the turn's own terminal
   * event — the 5s interrupt fallback's group kill, a crash, a process
   * `error`, or a stdin that broke — for what the driver still holds that only it can report
   * (`TurnDriver.onProcessEnded`). Its events are emitted ahead of the
   * terminal this module writes.
   */
  onProcessEnded?: () => AgentEvent[];
  /** `TurnDriver.onQuiet`. */
  onQuiet?: () => AgentEvent[] | null;
  /**
   * Asked when the session is CLOSED under this live turn: how long to let the
   * turn end on its own before the group is signalled
   * (`TurnDriver.closeGraceMs`). The process still goes — at the turn's settle
   * or the deadline, whichever comes first.
   */
  closeGraceMs?: () => number;
  /**
   * Awaited BEFORE this turn's opening payload is written, for a CLI that can
   * accept a prompt before it is ready to serve one (claude's MCP servers are
   * still dialling for the first seconds of a process — see
   * `TurnDriver.awaitPromptReady`, which is the only producer).
   *
   * The turn is open while this runs: its stdout is already being parsed, so
   * the gate can hold a dialogue of its own through `io`, and a cancel is
   * honoured — the payload is dropped rather than written into a turn the user
   * has already stopped. It must resolve and must bound itself; a rejection is
   * logged and the payload goes out anyway, because losing the user's message
   * is worse than sending it early.
   */
  holdPrompt?: (io: TurnIo) => Promise<void>;
  /**
   * Called once this turn's opening payload (if any) has been written — before
   * the handle is returned, so a client-initiated protocol can send its first
   * message ahead of any stdout.
   */
  onStdinReady?: (io: TurnIo) => void;
}

export interface CliSessionOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  stdinLifetime: StdinLifetime;
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
  /** `TurnDriver.onDroppedLine`: a line too long to read was skipped. */
  onDroppedLine?: (prefix: string, length: number) => AgentEvent[];
  spawn?: SpawnFn;
  logger?: SessionLogger;
  /**
   * Whether this CLI backgrounds a command and then reports it FINISHED, so
   * the only truthful source for "is it still running" is the process table.
   *
   * Supplied by the adapter from its own config, never decided here — this
   * module names no CLI. See `sweepDetachedShells` for the measurement it
   * exists for, and `AdapterConfig.shells` for where the fact is written down.
   *
   * Off by default: a CLI that reports its own detachments is already served by
   * the `background_work` bracket, and asking the OS about it as well would
   * open every command twice.
   *
   * Such a CLI reports no units for its commands at all, so its execute calls
   * are also what records where its commands run ({@link commandWork}).
   */
  detectDetachedShells?: boolean;
  /**
   * The CLI's own record of the commands it started, for a CLI that keeps one:
   * what ties a command to its process when its text is not in the table (a
   * heredoc, or a wrapper that takes the line over a file descriptor).
   */
  readCommandRecords?: () => Promise<readonly CommandRecord[]>;
  /**
   * This CLI sends nothing while it waits on a command it detached
   * (`AdapterConfig.shells.silentWaitReason`).
   */
  silentCommandWait?: boolean;
  /** {@link COMMAND_WAIT_QUIET_MS}. A TEST SEAM. */
  commandWaitQuietMs?: number;
  /**
   * How the process table is read, for the sweep above. A TEST SEAM on the
   * `spawn` option's terms — production passes nothing and gets the real `ps`.
   */
  listProcesses?: () => Promise<ProcessRow[]>;
  /**
   * How the process table is read with each process's group, for the record
   * {@link StoppedCommands.groups} hands on. A TEST SEAM on the same terms.
   */
  listProcessGroups?: () => Promise<PlainProcess[] | null>;
  /** {@link COMMAND_GROUP_READ_DELAY_MS}, unless a test sets it. */
  commandGroupReadDelayMs?: number;
  /**
   * The tool name this CLI asks the USER an open-ended question with, or null
   * when it has none. Supplied by the adapter from its own config — this module
   * never learns any CLI's names.
   *
   * It exists so the between-turns refusal can tell a permission check from a
   * question. Refusing a permission check is honest: no turn can carry the
   * verdict. Refusing a QUESTION answers it "no" on the user's behalf, in their
   * name, and they never see it was asked.
   */
  questionToolName?: string | null;
  /**
   * What to do with an approval request that arrives with NO turn in flight —
   * see {@link BetweenTurnApproval} for the tri-state.
   *
   * Supplied by the session's OWNER, because the answer depends on the run's
   * approval posture and nothing at this layer knows it. Without it this module
   * had to decide alone, and both of its answers were wrong in the same way —
   * a plain permission was refused under `auto`, where the whole contract is to
   * approve it, and the refusal reached the user as "Denied by the user in
   * Geniro" for a card they were never shown.
   *
   * Undefined keeps the previous behaviour for callers that have no posture to
   * offer: refuse a permission, hold a question.
   */
  betweenTurnApproval?: BetweenTurnApproval;
  /**
   * A NON-approval event that arrived with no turn in flight, handed to the
   * session's owner instead of being dropped.
   *
   * The owner gets it because only it knows what the event belongs to: the
   * events are turn-less but not run-less, and a run's transcript is exactly
   * the durable place they still have. Kept as a hand-off rather than a
   * replay — this module must never give one turn's output to another turn,
   * which is why these are not buffered like {@link BetweenTurnApproval}'s
   * held requests.
   *
   * WHICH of them are worth keeping is the owner's call too, and the caution
   * is real: a `tool_result` pairs with a call already on the transcript by
   * id, so it lands unambiguously, while a stray message has no such anchor.
   *
   * Undefined = the previous behaviour, a logged drop.
   */
  onBetweenTurnEvent?: (event: AgentEvent) => void;
  /**
   * Put a request the policy will not decide in front of the USER now, rather
   * than holding it until some later turn happens to adopt it.
   *
   * The holding path it takes precedence over is what a real incident was made
   * of: claude asked an `AskUserQuestion` 8 minutes after its turn had settled
   * (the CLI carries on by itself — see `handleOrphanEvent`), the question was
   * held, and NOTHING said so. The transcript grew the tool-call row and the
   * badge said the agent was working, so for 22 minutes the app showed a run
   * making progress while the CLI stood blocked on a person who had no control
   * to answer with. The session's idle window then closed the process, which
   * the CLI read as a refusal — and the user got a bare "claude run failed"
   * for a question they were never shown.
   *
   * `respond` is the whole reason this can exist off-turn: a verdict is one
   * encoded line on a stdin that is already open, and neither the encoder nor
   * the stdin belongs to a turn. Its `input` argument echoes the request's own
   * arguments back exactly as the in-turn seam does, so an ALLOW cannot hand
   * the CLI a blanked argument list. Its `option` is the one of the request's
   * own `options` the user picked, exactly as `respondApproval` takes it.
   *
   * Returns whether the owner TOOK the request. False (or no handler at all)
   * falls back to holding it — a caller with nowhere to draw a card must not
   * lose the request, only wait longer for it.
   */
  onHeldApproval?: (
    event: ApprovalRequestEvent,
    respond: (
      allow: boolean,
      input?: unknown,
      option?: ApprovalOption,
    ) => boolean,
  ) => boolean;
}

/**
 * Sink for this module's account of itself.
 *
 * `warn` is the historical contract (a skipped line, a lost event). `debug` is
 * the D1 addition and is deliberately a SEPARATE level: the approval
 * round-trip and the turn boundaries are per-tool-call chatter, worth having
 * only when reconstructing an incident, and at warning level they would bury
 * the lines that mean something is genuinely wrong.
 *
 * Optional, because every pre-existing caller passes a bare `{ warn }`.
 */
export interface SessionLogger {
  warn(message: string): void;
  debug?(message: string): void;
}

/**
 * One CLI process, and the turns run on it.
 *
 * A `payload`/`turn` session hosts exactly one turn and dies with it — that is
 * every caller that predates run-scoped sessions. A `session` one stays alive
 * between turns, idle, holding its MCP servers up.
 */
/**
 * One question put to a live CLI over its own stdin control channel, OUTSIDE
 * any turn — see {@link CliSession.ask}.
 *
 * The reader is the whole contract: it is offered every parsed stdout object
 * until one of them answers, so it owns the correlation (matching the request
 * id it just wrote) and this module never learns a CLI's control vocabulary.
 */
export interface SessionAsk<T> {
  /** The stdin line to write, newline-terminated by its author. */
  line: string;
  /**
   * Reads one parsed stdout object. Non-null ends the wait and is the answer;
   * null means "not my reply, keep waiting".
   */
  read: (obj: unknown) => T | null;
  /**
   * How long to wait before giving up with null. Required rather than
   * defaulted: what counts as too slow is a property of the question, and the
   * caller is the only side that knows it.
   */
  timeoutMs: number;
}

export interface CliSession {
  subagentRecoveryBlocked?(id: string): boolean;
  /**
   * Ask the CLI something on its own stdin control channel, out of band of any
   * turn.
   *
   * Additive by construction: the reader is offered each parsed stdout object
   * BEFORE the mapper sees it, and neither can consume the other's lines — a
   * control reply maps to no event, and an event line answers no ask. So this
   * cannot perturb a turn in flight, which is the point: the one caller today
   * asks a chat what its context window currently holds, and the user may well
   * be mid-turn when they open the readout.
   *
   * Resolves null rather than throwing on every failure — a stdin that is
   * closed, a process that is gone, a CLI that does not know the subtype and
   * says nothing, or the deadline passing. All four mean "no answer", and a
   * readout has nothing different to do about any of them.
   */
  ask<T>(request: SessionAsk<T>): Promise<T | null>;
  /**
   * Open a turn on this process. Null when the process cannot take one: it is
   * gone, its stdin has been closed, or a turn is already in flight. Callers
   * treat null as "spawn a fresh process" rather than asking twice.
   */
  startTurn(turn: CliTurnOptions): AgentTurnHandle | null;
  /** Alive, with no turn in flight — ready to take another one. */
  readonly idle: boolean;
  /** The process has not been observed to end. */
  readonly alive: boolean;
  /**
   * Alive, but `startTurn` will refuse every further turn — the last turn was
   * ended for the CLI rather than by it, so this process may still print that
   * turn's tail. The owner closes such an entry instead of counting it as a
   * reusable one.
   */
  readonly retired: boolean;
  /**
   * Alive with no turn in flight, and yet NOT free: the CLI is blocked on a
   * verdict only the user can give — a card raised between turns, or a request
   * held for the next turn to adopt.
   *
   * Separate from `idle` on purpose, the way `retired` is and for the mirror
   * reason. Folding it in would make every reader treat this session as busy,
   * including {@link CliSession.startTurn}'s own callers; what actually needs to
   * change is narrower — whoever REAPS an unused process must not reap this one,
   * because the thing it is waiting for is a person, and a person taking twenty
   * minutes to answer is not a session going unused. The whole incident this
   * exists to prevent is that reap: the close reached the CLI as a refusal of
   * the question, and the run was marked failed for it.
   */
  readonly parked: boolean;
  /**
   * The pid of the CLI this session spawned, or null once it has ended (or
   * never started). Spawned `detached`, so it is also the process-GROUP id —
   * which is what lets a reader attribute every process under it to this
   * session without guessing from command lines.
   */
  readonly pid: number | null;
  /**
   * How many commands this process has started and not yet ended that no turn
   * of ours waits on — a `pnpm dev`, a watcher, a server the agent ran in the
   * background — with every command its delegates run, one a delegate still
   * waits on included.
   *
   * Closing this process stops them — the CLI stops its own on shutdown, and
   * what it leaves is stopped from {@link StoppedCommands.groups} — so whoever
   * REAPS an unused process must not reap one holding them: a dev server is
   * quiet by design, and a session that has said nothing for the idle window
   * while serving `localhost:3000` is not a session going unused. Reported as
   * servers an agent started in a team run being unreachable after its
   * next reply.
   */
  readonly shellsRunning: number;
  /**
   * Of {@link shellsRunning}, the commands running detached — what a close
   * reports stopping. A delegate's command its delegate still waits on keeps
   * the process from being reaped, but is no detached command yet.
   */
  readonly detachedRunning: number;
  /**
   * The command lines of the detached commands {@link detachedRunning} counts,
   * oldest first — one per command whose launching call disclosed its line, so
   * it may hold fewer entries than that count.
   *
   * For whoever has to say what closing this process stopped: the agent that
   * started a dev server needs its line to start it again.
   */
  readonly runningCommands: readonly string[];
  /**
   * {@link detachedRunning} and {@link runningCommands} as they stood when the
   * process ended, with where every command it reported running ran, or null
   * while it runs. The live readings are empty by then, so a holder told of
   * the end by `closed` reads what was running from here.
   */
  readonly endedRunning: StoppedCommands | null;
  /**
   * Where the command a call launched runs, as last recorded — its process
   * groups and their members: empty while it runs with nothing recorded, null
   * when the CLI reports no command of that call running.
   */
  recordedGroupsOf(callId: string): readonly RecordedGroup[] | null;
  /**
   * Terminate the CLI's process group — the CLI and whatever shares its group
   * (claude's MCP servers; codex gives each of its own a group). Its
   * detached commands run in sessions of their own and are stopped by its
   * shutdown. On a `user-stop` the delegates still out are closed `stopped`,
   * not `untracked` — after a graceful close too, which keeps the cause for
   * the exit it waits for (see {@link SessionCloseOptions}).
   */
  close(cause?: SessionCloseCause, options?: SessionCloseOptions): void;
  /**
   * Record why the process will be closed, ahead of whatever ends it — a
   * later close, its own kill after a refused interrupt, or its exit. Null
   * withdraws it; the next turn withdraws it too.
   */
  noteCloseCause?(cause: SessionCloseCause | null): void;
  /** The cause recorded by {@link noteCloseCause} or `close`, or null. */
  readonly closeCause?: SessionCloseCause | null;
  /** Resolves once the process is gone. Never rejects. */
  readonly closed: Promise<void>;
}

/**
 * How a kept process is ended.
 *
 * `graceful` asks an IDLE process to finish rather than signalling it at once:
 * its stdin is closed first, and the group is SIGTERMed the moment the CLI
 * exits — or {@link TURN_END_EXIT_GRACE_MS} (2s) later if it has not. claude
 * exits on EOF; `cursor-agent acp` does not, and the deadline ends it. The
 * group signal after the CLI is gone is what reaches a grandchild it left
 * behind — an MCP server's own worker outlives a CLI killed by pid alone, at
 * ppid 1. A process with a turn in flight is signalled at once either way.
 * Only the idle close asks for it (`AgentSessionRegistry`); eviction, a
 * teardown and shutdown stay immediate.
 */
export interface SessionCloseOptions {
  graceful?: boolean;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toUtf8(chunk: string | Buffer): string {
  return typeof chunk === 'string' ? chunk : chunk.toString('utf8');
}

/** Bytes of a child's stderr retained for the failure message on a non-zero exit. */
const STDERR_TAIL_BYTES = 2000;

/**
 * How long an in-protocol interrupt is given to end the turn before the cancel
 * falls back to killing the process group.
 *
 * The fallback is what keeps Stop honest: an interrupt the CLI acknowledges but
 * never acts on would otherwise leave the turn running with the user told it
 * had stopped. Generous relative to the 2ms the acknowledgement itself took,
 * because the CLI still has to unwind whatever tool call it was inside.
 */
const INTERRUPT_SETTLE_GRACE_MS = 5000;

/**
 * How long `exit` waits for `close` before settling the turn itself.
 *
 * `close` is the preferred settle point because it guarantees stdout has fully
 * drained; `exit` only says the CLI is gone. The window exists so the ordinary
 * case still settles on `close` with everything parsed — it is a BACKSTOP for
 * the case where `close` is never coming at all, not a race against it.
 *
 * Generous on purpose: settling early would cut off trailing stdout, and the
 * cost of waiting is a spinner that stops two seconds later rather than never.
 */
const EXIT_SETTLE_GRACE_MS = 2000;

/**
 * How long a `turn`-lifetime CLI is given to exit BY ITSELF after its turn's
 * terminal event, before its process group is terminated.
 *
 * A `turn` process exists to serve exactly one turn, and that turn settles when
 * the process ENDS — so a CLI that ends its turn and then goes on living wedges
 * the turn open forever. Closing stdin is all that used to be done about it,
 * which assumes a CLI that treats EOF as "we're finished". `cursor-agent acp`
 * does not (probe-recorded in `cursor-acp.const.ts`, and measured again here:
 * 3m25s after its turn reported `end_turn`, the process was still alive at
 * 163MB with a `worker-server` grandchild beside it). The consequences were both
 * halves of one report — the run's `ProcessRegistry` slot was never released, so
 * every later message in that chat answered `RUN_BUSY` and sat in the composer's
 * queue with the spinner still running, and each turn leaked a process group
 * that outlived the daemon (four such groups found reparented to launchd, 1.5
 * days old).
 *
 * So the terminal event arms this instead of merely closing stdin. A CLI that
 * does exit on EOF — claude — is gone long before it fires and never notices;
 * the turn still settles on the process actually ending, so the guarantee that
 * `done` implies fully-drained stdout is unchanged.
 *
 * 2s for the same reason `EXIT_SETTLE_GRACE_MS` is 2s: long enough that a CLI
 * intending to exit always wins the race, short enough to stay inside the
 * renderer's own RUN_BUSY retry budget (300+600+1200+2400ms), so a message
 * queued in this window still goes out on its own.
 *
 * **It arms for a `turn` lifetime ONLY, and that restriction is now load-bearing
 * rather than incidental.** On a `session` lifetime the process is the whole
 * conversation, so terminating it 2s after a turn's terminal event kills every
 * sub-agent that turn left running in the background — which is exactly what it
 * did to cursor while that CLI was one process per turn: a turn launched eleven
 * background reviewers, said "I'll be notified as they complete", and the group
 * went down 2.5s later. Measured both ways on a delegate given a 20-second
 * shell command — permission asked at 28.5s and its file written at 49.0s with
 * the process kept, never written at all under a control run that killed the
 * group here. A `session` process is ended by `close()` instead (the registry's
 * idle window, eviction, staleness replacement or shutdown), and a turn on one
 * is stopped in protocol rather than by killing anything —
 * `CliTurnOptions.buildInterruptPayload`.
 */
const TURN_END_EXIT_GRACE_MS = 2000;

/**
 * How often the process table is re-read while a command the CLI called
 * finished is still running — see `sweepDetachedShells`.
 *
 * A poll only exists while something IS out, so this is the cadence of a
 * genuinely rare state rather than a background cost every session pays. Five
 * seconds is chosen against what the reading is FOR: a row in a panel saying
 * what is running, where being five seconds stale is invisible, while `ps`
 * itself is a spawn and a few milliseconds of work that should not be repeated
 * every second for a `pnpm dev` somebody will leave up for an hour.
 */
const DETACHED_SHELL_POLL_MS = 5000;

/**
 * How long a turn must go quiet, with a command it detached still alive, before
 * it reads as waiting on that command. Real thinking runs to tens of seconds
 * (cursor chats, 2026-11: 111 of 4359 quiet gaps ran between 30 and 60 s), and a
 * false reading lets a message cancel that thinking.
 */
const COMMAND_WAIT_QUIET_MS = 45_000;

/**
 * Silence windows a turn waiting on a command it started may take, against the
 * one any other turn gets: the CLI's own wait tool blocks for at most 119
 * minutes, and the model needs time to answer once it returns.
 */
const COMMAND_WAIT_SILENCE_WINDOWS = 5;

/**
 * How often a session re-reads where the commands its CLI reported running
 * run while any is out — see `recordCommandGroups`. A process a command forks later joins its
 * group's record on the next reading; one that starts yet another session in
 * between is beyond it.
 */
export const COMMAND_GROUP_REFRESH_MS = 15_000;

/**
 * How long after a command is reported starting, a call answered or an
 * approval allowed, its session reads the table: one reading for a burst, and
 * a moment for a command a call names to have spawned (cursor reports the call
 * first). A burst that goes on after its reading was armed gets one more, this
 * long after the first.
 */
export const COMMAND_GROUP_READ_DELAY_MS = 500;

/**
 * The result written for a command whose call the CLI never answered because
 * its process died under the turn — a crash, an OOM kill, an exit no one asked
 * for. Not on a Stop, which the transcript already reads as one.
 */
export const CUT_OFF_COMMAND_RESULT =
  'The agent’s process ended before this command finished.';

/**
 * How many command lines a session keeps by call id for
 * `CliSession.runningCommands`. Far above the detached commands one agent
 * keeps running, so only lines of long-finished calls are ever dropped.
 */
const MAX_REMEMBERED_COMMANDS = 256;

/**
 * How long a run-scoped turn may go completely SILENT before the turn is
 * settled as failed and the user gets their composer back.
 *
 * The gap this closes: on a `session` lifetime a turn ends on its terminal
 * EVENT, so a process that stays alive and simply never emits one leaves the
 * turn open forever. Both other backstops hang off `handle.done`, which is
 * exactly what never resolves in that state — so nothing bounds it.
 *
 * Measured against SILENCE rather than against the turn's total length, and
 * that distinction is the whole design. A wall-clock cap cleared only by the
 * terminal event would settle a turn that is working perfectly well — an agent
 * legitimately runs for hours — and the user would watch real work be
 * abandoned. Any event at all rearms this, so it fires only when the CLI has
 * genuinely stopped talking.
 *
 * Generous for the same reason: a single tool call (a full test suite, a long
 * build) can be silent for many minutes, and settling one of those early costs
 * the user their turn. Half an hour of nothing is not a slow turn.
 *
 * **It does not run at all while the turn is blocked on a verdict**
 * ({@link TurnState.outstanding} non-empty), and that is not a longer window
 * but the absence of one. This deadline's whole premise is that silence is
 * UNEXPLAINED — it catches a CLI nobody can account for. A turn parked on an
 * approval card is the opposite: geniro raised the request, knows the CLI is
 * blocked on it, and is itself the thing withholding the answer. The clock
 * would be timing a human, and a human who steps away for lunch has not
 * wedged.
 *
 * Measured on the user's own daemon log (2026-08-11, two chats): an
 * `AskUserQuestion` card went up at 16:30:40 and nothing arrived after it,
 * because nothing could — the CLI was waiting. Thirty minutes and one second
 * later the turn was settled as `error` with the sentence below, the run was
 * marked failed, and the card the user was about to answer was rewritten as
 * `unanswerable`. The line was false in every clause: the CLI had produced an
 * answer AND a question, and it had not given up on anything.
 *
 * The process is deliberately LEFT ALIVE on expiry — it holds the run's MCP
 * servers, and the next turn reuses it. Only the turn is given up on.
 *
 * **Time the machine spends ASLEEP is not silence** ({@link awakeTimeout}): a
 * detected wake restarts the window, in full, from the wake — as it does for
 * the off-turn hold below.
 */
const TURN_SILENCE_DEADLINE_MS = 30 * 60 * 1000;

/**
 * The ending a turn settles on when its prompt was answered inside a
 * continuation (see `TurnState.continuationAnswer`).
 *
 * The continuation's own row has already been written, usage and all, down the
 * between-turn path — so this carries the answer's TEXT and no usage. Copying
 * the figures would store the same turn's spend twice, and the usage ledger
 * reads every `turn_complete` row.
 *
 * Stamped `answeredByContinuation` for the same reason: the continuation's row
 * is the turn's visible ending, and a client that cannot tell this row from an
 * ordinary one draws the turn as finished twice.
 */
function answeredByContinuation(
  result: Extract<AgentEvent, { type: 'turn_complete' }>,
): Extract<AgentEvent, { type: 'turn_complete' }> {
  return {
    type: 'turn_complete',
    usage: null,
    stopReason: result.stopReason,
    finalText: result.finalText,
    answeredByContinuation: true,
  };
}
/**
 * Main-thread events that prove the MODEL is producing again, and so end a
 * hold — see the release in `emit`.
 *
 * Only what the agent itself authored. A `tool_result` is deliberately absent:
 * it is the ENVIRONMENT answering a call the turn made before it stopped
 * talking, and it arrives whether or not the agent ever acts on it — a
 * delegate's late result is exactly that, and it is the case the hold exists
 * to keep a turn open FOR. Every one here cannot arrive without the model
 * having emitted something new.
 */
const RESUMES_A_HELD_TURN: ReadonlySet<AgentEvent['type']> = new Set([
  'text',
  'text_delta',
  'reasoning_delta',
  'thinking_progress',
  // The model is SERIALIZING a call it decided to make, which it could not be
  // doing without having produced something new. It belongs here for the same
  // reason `tool_call` below does, and arrives before it.
  'tool_compose',
  'tool_call',
]);

/** The mutable state of the one turn currently in flight. */
interface TurnState {
  /** When this turn opened — the denominator of the settle line. */
  startedAt: number;
  settled: boolean;
  /**
   * Emit at most ONE terminal event per turn, whichever arrives first: a
   * `result`-line `turn_complete` from the mapper, a `turn_cancelled` from a
   * kill we asked for, or an `error`. Without this gate a child that prints a
   * success `result` AND then exits non-zero (or fires `error` then `close`)
   * would emit two contradictory terminal items for one turn.
   */
  terminalEmitted: boolean;
  /**
   * A cancel() was requested: the CLI usually reacts by printing an is_error
   * result line (or exiting non-zero) BEFORE the stop reaches us, and that
   * error would win the one-terminal race — recording a fake failure for a
   * deliberate stop. So after a cancel an `error` terminal is normalized to
   * `turn_cancelled`; a genuine `turn_complete` that raced it still wins (the
   * turn really finished).
   *
   * It is also what separates a stop from a KILL, which is the other direction
   * of the same mistake — see the signal branch of `settleFromTermination`.
   * Every deliberate termination sets this (`cancel()` carries Stop and the
   * shutdown reap; `close()` retires a session), so a signal arriving with it
   * unset came from outside geniro and is a failure, not a cancellation.
   */
  cancelRequested: boolean;
  /**
   * The cancel arrived while the prompt was still held, so the CLI was never
   * asked anything and nothing on its side was interrupted — see the held
   * branch of `cancel`. Read by the settle: a stopped turn normally drops its
   * unanswered requests (the CLI ends them with the turn), while these are
   * still live on the CLI and must be re-held for the next turn.
   */
  stoppedBeforePrompt: boolean;
  resolveDone: () => void;
  /** Resolves when the turn settles — what a graceful close waits on. */
  done: Promise<void>;
  options: CliTurnOptions;
  /** Fallback deadline armed when an in-protocol interrupt was delivered. */
  interruptTimer: ReturnType<typeof setTimeout> | null;
  /**
   * Rearmed by every event this turn produces; fires only after
   * {@link TURN_SILENCE_DEADLINE_MS} of nothing. Null for a lifetime whose
   * turn already ends with its process.
   */
  silenceTimer: AwakeTimer | null;
  /**
   * Every approval request this turn has been shown and not yet answered —
   * whether it was adopted from the hold buffer or raised inside the turn.
   *
   * Both kinds leave the CLI blocked on a verdict, and a turn can settle
   * without producing one: the user presses Stop, or the turn finishes on its
   * own while a sub-agent is still parked on the card. Whatever the route,
   * dropping the request strands a live CLI on a question nothing can ever
   * answer — the wedge this whole seam exists to remove, one turn later. So the
   * remainder is drained back onto the hold buffer at settle, and
   * `respondApproval` prunes whatever it actually delivered.
   *
   * The silence deadline used to be a third route and is no longer: a non-empty
   * map SUSPENDS it ({@link TURN_SILENCE_DEADLINE_MS}), because a turn waiting
   * on a human has not wedged. This map is therefore also what decides whether
   * that deadline is running at all — a second reader, and the reason
   * `respondApproval` rearms on delivery.
   *
   * The in-turn case is the commoner door, not an edge: it needs no
   * between-turns race at all, just a turn that ends before its user does.
   */
  outstanding: Map<string, ApprovalRequestEvent>;
  /**
   * The terminal event held back because background work was outstanding
   * (`openWork` at SESSION scope), to be emitted when the last unit reports (or
   * when the silence deadline gives up on them).
   *
   * The FIRST one is kept, not the last: it is the one that answers the user's
   * prompt and carries that turn's usage. A CLI's later self-initiated turns
   * report their own results, whose text ("Background note (no action
   * needed)…") is not this turn's answer and whose usage is not this turn's
   * context.
   */
  deferredTerminal: AgentEvent | null;
  /**
   * This turn's prompt has not been written yet — {@link CliTurnOptions.holdPrompt}
   * is still deciding.
   *
   * While it is true, a `turn_complete` from the CLI cannot be about this turn:
   * the turn's prompt has not been sent, so there is nothing for the CLI to have
   * completed. Settling on one is how the user's message came to be thrown away
   * — TRACED in the reporter's own daemon log (2026-08-17 19:14): a fresh
   * process, the MCP-readiness gate holding the prompt, and claude printing an
   * empty `result` (`duration_ms:42`, `total_cost_usd:0`, `result:""`) 2.9s in.
   * geniro settled the turn on it and marked the run `completed`; the gate then
   * finished at 6.5s, found `turn.settled` and DROPPED the prompt. The message
   * was persisted, never sent, never answered, and the transcript said "✓ done ·
   * 0s · $0.0000" over it — the reported "I didn't get an answer at all".
   *
   * The window is not narrow and is about to widen: the gate waits on every MCP
   * server a folder defines (9 of them, 6.5s, on the traced run) and now allows
   * a stalling one up to a minute.
   */
  promptHeld: boolean;
  /**
   * The CLI has already answered this turn's latest prompt with a result of
   * its own — held, or dropped when the agent spoke again.
   *
   * It is what decides whether a CONTINUATION's result can end the turn. While
   * the prompt is unanswered it cannot: the CLI finishes a continuation it was
   * already running before it reads the prompt, so that result is not this
   * turn's answer (the probed case at the continuation branch in `emit`). Once
   * the prompt HAS been answered, nothing further is owed — every result after
   * that is a continuation, because a continuation is the only way the CLI
   * speaks again unprompted. Skipping those left a turn with no ending it would
   * accept. TRACED on run `3e05c90a` (2026-09-14): a turn opened 12:47, its own
   * result held for sub-agents, the agent carried on as each one reported, and
   * the last continuation's result at 13:56 was skipped as "not this turn's
   * ending" — thirty minutes of silence later the deadline settled the turn as
   * `error`, under a transcript whose final row read `done`.
   *
   * Cleared again when a follow-up is delivered into the turn, since that is a
   * new prompt the CLI has not answered yet.
   */
  promptAnswered: boolean;
  /**
   * The last continuation result this turn routed AROUND itself while its
   * prompt was still unanswered — see the continuation branch in `emit`.
   *
   * Kept because the CLI can answer the prompt INSIDE that continuation and
   * never emit a result of its own for it. The "not this turn's ending" rule
   * then leaves the turn nothing it will accept, and the only thing left to end
   * it was the silence deadline, which wrote a failure over a finished turn.
   * TRACED on run `a0877ce9` (2026-09-14): a callee's final message and two
   * continuation results landed at 17:01:24, the CLI announced `idle` in the
   * same millisecond, and the call was failed with "produced nothing for 30
   * minutes" at 17:31:24 — its caller told `CALLEE_FAILED` about work that had
   * shipped a pull request.
   *
   * So once the CLI says it is idle (or has been silent for the whole deadline),
   * a turn holding one of these settles on it. Cleared with `promptAnswered`
   * when a follow-up is delivered, since that result did not answer it.
   */
  continuationAnswer: Extract<AgentEvent, { type: 'turn_complete' }> | null;
  /**
   * The CLI has echoed this turn's OWN prompt as taken
   * ({@link CliTurnOptions.promptText}).
   *
   * Once it has, a continuation's result is this turn's ending, because the
   * continuation took the prompt into itself. PROBED on claude 2.1.284 with a
   * prompt written while a continuation the CLI opened by itself ran a
   * foreground command: the prompt was echoed (`isReplay`) at the next tool
   * boundary, and ONE result followed, stamped
   * `origin:{kind:"task-notification"}` and answering the prompt. The case the
   * "not this turn's ending" rule was built on is the other order, probed the
   * same day: a prompt written while the continuation wrote its final words was
   * echoed only AFTER that continuation's result, and answered by a result of
   * its own. So the echo's position is the fact that separates them.
   *
   * Without it the absorbing case was routed around as a continuation that
   * ended nothing, and the turn settled on `idle` with a second, usage-less
   * row — REPORTED as a doubled `✓ done` on run `74a134dd`, whose session
   * file records the CLI's own `absorbed_mid_turn` for that message.
   */
  promptTaken: boolean;
  /**
   * The text of every follow-up written into this turn that the CLI has not
   * yet said it TOOK (`user_message_consumed`), oldest first.
   *
   * While it is non-empty a `turn_complete` is not the end of the turn. A
   * message written as the model produces its final words is answered by a
   * further `result` of its own (probed on claude 2.1.270), so settling on the
   * first one ended the turn under a message the agent was about to answer:
   * the run read `completed` for as long as it went on working — TRACED on the
   * reporter's own run `51c646fb`, where four queued messages went in at
   * 11:05:06–08, the turn settled `workflow_completed` at 11:05:28, and the
   * Manager answered them until 11:07:09 with its agent calls refused
   * `RUN_NOT_ACTIVE`.
   *
   * Only filled for a CLI whose options set `followUpConsumptionReported` —
   * without an acknowledgement nothing could ever empty it.
   *
   * Each keeps the `deliveryId` it was written with: one still here when the
   * process ends died queued inside the CLI — PROBED on claude 2.1.295, which
   * logs it `enqueue` and runs it as a turn of its own after an interrupt, but
   * only while the process lives, and a chat's Stop closes the session — so
   * {@link emitProcessEnded} reports it `follow_up_dropped`.
   */
  unconsumedFollowUps: { text: string; deliveryId: string | null }[];
  /**
   * The `turn_complete` held back because a follow-up was still unconsumed,
   * folded into the one the turn finally settles on ({@link foldTurnComplete})
   * so the first segment's bill is not lost.
   *
   * Released the way every other hold is: on the CLI announcing `idle` (an
   * acknowledgement that never matched leaves nothing else to wait for), on a
   * clean exit, or by the silence deadline for a CLI that never says `idle`.
   */
  supersededTerminal: Extract<AgentEvent, { type: 'turn_complete' }> | null;
  /**
   * A held result the turn CONTINUED past ({@link supersedeHeldTerminal}) —
   * never an ending again, only a bill. Unlike {@link supersededTerminal} it is
   * no settle candidate: the idle, exit and silence paths that release a held
   * result must not bring back one the agent has since talked past. Folded into
   * whatever terminal the turn does end on, so that segment's cost survives.
   */
  continuedSegment: Extract<AgentEvent, { type: 'turn_complete' }> | null;
  /** Whether the owner was last told this turn is held. */
  holdAnnounced: boolean;
  /** Armed while the CLI talks; firing means it has gone quiet. */
  quietTimer: AwakeTimer | null;
  /** Counts the CLI talking, so a slow reading can tell it spoke meanwhile. */
  spokenCount: number;
  /** The detached commands the quiet turn is announced as waiting on. */
  commandWaitFor: number;
  /** Silence windows this wait has already taken past the first. */
  commandWaitWindows: number;
  /** The command calls this turn made, which alone can stretch its silence. */
  ownCommands: Set<string>;
  /**
   * The CLI's own latest `cost_progress` figure — what it has spent since its
   * last `result` line — kept so {@link heldCostOf} can be added to it.
   */
  liveCostUsd: number;
  /** Of {@link liveCostUsd}, the part geniro priced itself. */
  liveEstimatedCostUsd: number;
  /**
   * Whether a non-zero `cost_progress` has been published for this turn, so
   * its ending owes the live plane a zero ahead of the terminal that records
   * the same money.
   */
  costPublished: boolean;
}

/**
 * What the segments a turn is HOLDING have cost — money a `result` line
 * already reported, on no durable row until the turn settles and folds them in.
 *
 * Without it the live figure drops it: the CLI's own reading restarts at each
 * `result` (`cost_progress` measures from there), while the held
 * `turn_complete` carrying that segment is not emitted until the turn ends.
 * REPORTED as two identical callees on one team reading $0.18 and $22.34 —
 * the first had been held for its background delegates, and its card showed
 * only what it spent after the latest continuation (run `07d68eea`, call-15,
 * whose session files price at ~$15).
 */
function heldCostOf(turn: TurnState): {
  costUsd: number;
  estimatedCostUsd: number;
} {
  const total = { costUsd: 0, estimatedCostUsd: 0 };
  const held = [
    turn.deferredTerminal,
    turn.supersededTerminal,
    turn.continuedSegment,
  ];
  for (const segment of held) {
    if (segment?.type !== 'turn_complete') {
      continue;
    }
    total.costUsd += positiveOrZero(segment.usage?.costUsd);
    total.estimatedCostUsd += positiveOrZero(segment.usage?.estimatedCostUsd);
  }
  return total;
}

function positiveOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * A turn's ending, carrying what a segment it CONTINUED past had spent — see
 * `TurnState.continuedSegment`. A success folds the whole segment in; a
 * failure or a Stop folds its figures into the ones that ending carries.
 */
function withContinuedSegment(
  continued: Extract<AgentEvent, { type: 'turn_complete' }> | null,
  ending: AgentEvent,
): AgentEvent {
  if (continued === null) {
    return ending;
  }
  if (ending.type === 'turn_complete') {
    return foldTurnComplete(continued, ending);
  }
  if (ending.type === 'error' || ending.type === 'turn_cancelled') {
    const usage = foldUsage(continued.usage, ending.usage ?? null);
    return usage === null ? ending : { ...ending, usage };
  }
  return ending;
}

/**
 * Spawn a headless CLI agent, reassemble its stdout NDJSON, map each object to
 * normalized {@link AgentEvent}s, and surface a single settle point per turn.
 *
 * Terminal conditions are normalized: a signal-kill (cancel/shutdown) yields a
 * `turn_cancelled`, a non-zero exit yields an `error` (with the stderr tail),
 * and a clean exit relies on the `result` line the mapper already turned into
 * `turn_complete`. A turn handle's `done` never rejects — every outcome is an
 * event first.
 *
 * **What settles a turn depends on the stdin lifetime**, and the difference is
 * the whole reason this function has one:
 *
 * - `payload` / `turn` — the process serves this turn alone, so `done` waits
 *   for the process to END (`close`, or the `exit` backstop). That is what
 *   every caller before run-scoped sessions relies on: by the time `done`
 *   resolves, stdout has fully drained and the child is gone.
 * - `session` — the process outlives the turn, so `done` resolves on the
 *   TERMINAL EVENT. Waiting for the process would never resolve at all.
 */
export function runCliSession(opts: CliSessionOptions): CliSession {
  const spawnFn = opts.spawn ?? defaultSpawn;
  const settlesOnTerminalEvent = opts.stdinLifetime === 'session';

  let current: TurnState | null = null;
  /**
   * The wire encoder for an approval verdict, kept at SESSION scope.
   *
   * It is the adapter's pure `(id, allow, input) => line` — the CLI's wire
   * format, identical for every turn of one process — so holding the most
   * recent turn's copy carries no turn state with it. It exists so a permission
   * request arriving with NO turn in flight can still be ANSWERED — per the
   * owner's posture, or held for the next turn — rather than dropped; see
   * {@link handleOrphanEvent}.
   */
  let approvalEncoder: CliTurnOptions['buildApprovalResponse'];
  /**
   * DELEGATES the CLI has started on this PROCESS and not reported on — see
   * `AgentEvent`'s `background_work`, and {@link trackBackgroundWork} for why a
   * backgrounded COMMAND is deliberately not in here.
   *
   * At SESSION scope, and that is the correction rather than a detail. It used
   * to live on the turn that happened to be open when the `started` line
   * arrived, which quietly assumed a delegate is launched inside a turn of
   * ours. It routinely is not: the CLI carries on by itself between turns (a
   * task-notification continuation runs a whole further turn), and a delegate
   * launched THERE was invisible — no liveness announcement, so its block read
   * `done` the moment its launching call returned, and nothing to hold the
   * next turn, so the run settled `completed` with three agents still working.
   * That is the reported "it says it's waiting on agent A and B, even though
   * its status is done, complete": traced in the reporter's own daemon log
   * (2026-08-18 10:29–10:31, run acd7b34c), three `Agent` calls with
   * `run_in_background: true` and not one `subagent_info` row between them.
   *
   * A turn is not over while this is non-empty, however plainly the CLI's
   * turn-end line says otherwise — and neither is an OFF-turn continuation; see
   * {@link deferredOffTurnTerminal}.
   *
   * claude's `AdapterConfig.backgroundWork.agentNote` tells the agent to END
   * its turn on the strength of this hold (and that a backgrounded command
   * holds nothing): a change to what enters this set changes what it may say.
   */
  const openWork = new Set<string>();
  /**
   * The DELEGATES among {@link openWork}, as work-id → launching tool call.
   *
   * Kept because only the `started` line says what a unit IS and which call
   * produced it, while the settle may carry neither — so the pairing has to be
   * remembered to turn a settle back into "that delegate has finished".
   * Everything else about background work stays identity-only, as it was.
   *
   * Outlives {@link openWork}: the silence deadline can give up on a unit while
   * the CLI still reports it later, and that late report is what closes the
   * delegate's block. Session-scoped for the same reason as the set above.
   */
  const delegateWork = new Map<string, string>();
  /**
   * Units the agent is WAITING on — started with `background_work.foreground`
   * and not moved to the background since. A sync sub-agent, or a long command
   * run in the foreground.
   *
   * Neither twin announces one as background work while it is here: no
   * `backgroundOpen: true` for a delegate, no `shell_open` for a command. Those
   * two announcements are what the run's `subagentsOut` / `shellsOpen` count,
   * and the composer reads a non-zero count as "the agent is free, send
   * straight in" — true of work the agent launched and moved on from, false of
   * work its current tool call is blocked on. REPORTED as a message typed
   * during a sync `Explore` sub-agent going straight into a turn that could not
   * read it until the sub-agent returned. A `backgrounded` takes the unit out
   * of this set and makes the announcement it was owed.
   */
  const foregroundUnits = new Set<string>();
  /**
   * The SHELLS a turn has launched, as work-id → launching tool call — the
   * twin of {@link delegateWork}, kept for the same reason and read by
   * {@link announceShellWork}.
   *
   * Kept BESIDE {@link openWork} rather than among it: only `unit === 'agent'`
   * enters that set. Which is what makes its SIZE readable as a delegate count,
   * and {@link AgentTurnHandle.attributableDelegate} depends on exactly that.
   *
   * Separate rather than one map with a kind, because the two are consulted to
   * answer opposite questions: this one says "that settle belongs to a command
   * the transcript is showing as running", the other says "that settle belongs
   * to a delegate whose block must close". A single map would make each of them
   * a filter over the other's entries.
   */
  const shellWork = new Map<string, string>();
  /**
   * The shells already ANNOUNCED as settled, so one unit's end is one row.
   *
   * A CLI may report the same ending on more than one channel — claude sends
   * both `task_updated` and `task_notification` — and the row is durable, so a
   * duplicate is stored for the life of the transcript. Session-scoped like its
   * neighbours: an id is a few bytes and the alternative is a window in which a
   * late second report writes the row again.
   */
  const settledShells = new Set<string>();
  /**
   * Every detached command this process has started and not yet ended — what
   * {@link CliSession.shellsRunning} counts, with every command in
   * {@link delegateCommands} (one its delegate still waits on included).
   *
   * Its own set rather than a reading of {@link shellWork}, which records only
   * a unit whose launching call is known: a command is running whether or not
   * the CLI said which call started it, and a count that missed it would let
   * the process holding a `pnpm dev` be reaped.
   */
  const runningShells = new Set<string>();
  /**
   * The command line each call ran, by call id — what
   * {@link CliSession.runningCommands} names a detached command by, joined
   * through {@link shellWork} and {@link delegateCommandCalls}.
   *
   * Gathered for every CLI and in either arrival order relative to the unit's
   * `started`, so it cannot be pruned on the call's answer: a backgrounded
   * command is answered at once and runs on. Bounded instead, by
   * {@link MAX_REMEMBERED_COMMANDS}, never dropping one a running command
   * still needs.
   */
  const callCommands = new Map<string, string>();
  /**
   * Command calls the CLI has not answered, by id → their tool's name and the
   * delegate that made each, if one did — what a death under the turn cuts
   * off ({@link cutOffCommands}).
   */
  const openCommandCalls = new Map<
    string,
    { name: string; parentToolUseId: string | undefined }
  >();
  /**
   * A delegate's own detached command → the call that launched it — the
   * {@link shellWork} of {@link delegateCommands}, which records the owner
   * rather than the call.
   */
  const delegateCommandCalls = new Map<string, string>();
  /** See {@link CliSession.endedRunning}. */
  let endedRunning: StoppedCommands | null = null;
  /**
   * The delegates' commands running detached — with {@link runningShells},
   * what a close reports stopping. A command its delegate still waits on is
   * not one yet.
   */
  const detachedDelegateCommands = (): string[] =>
    [...delegateCommands.keys()].filter((id) => !foregroundUnits.has(id));
  /** The lines of the detached commands running now — {@link CliSession.runningCommands}. */
  const currentCommands = (): string[] =>
    [
      ...[...runningShells].map((id) => shellWork.get(id)),
      ...detachedDelegateCommands().map((id) => delegateCommandCalls.get(id)),
    ].flatMap((call) => {
      const command = call === undefined ? undefined : callCommands.get(call);
      return command === undefined ? [] : [command];
    });
  /**
   * The commands this session's CLI has RUN, by the id of the call that ran
   * each — the raw material for {@link sweepDetachedShells}, and what stands
   * for a unit in {@link commandWork} until the sweep has looked at it;
   * gathered only for a CLI that needs it (`CliTurnOptions.detectDetachedShells`).
   *
   * `returned` is the whole point of the pair: a call the CLI has not answered
   * yet is an ordinary foreground command, and the transcript already draws it
   * as running on the strength of that missing answer. The sweep is only ever
   * interested in the opposite — a call the CLI said was FINISHED.
   */
  const executeCalls = new Map<
    string,
    { command: string; returned: boolean; calledAt: number }
  >();
  /**
   * Calls the OS confirmed were still running after their CLI called them done.
   *
   * Session-scoped like {@link settledShells}, because that is how long such a
   * command lives: it outlives its turn by construction, and the process ending
   * is what finally closes it.
   */
  const osDetachedShells = new Set<string>();
  /** The sweep in flight, so that overlapping asks never open a shell twice. */
  let shellSweep: Promise<void> | null = null;
  let shellSweepOwed = false;
  let detachedShellTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Where each command the CLI reports running runs, by its unit id — see
   * {@link recordCommandGroups}. A settle drops its entry.
   */
  const commandGroups = new Map<string, RecordedGroup[]>();
  /**
   * Mirror {@link commandGroups} into the child journal, so a daemon that dies
   * leaves the next boot what to stop. Not once the process is gone: what
   * was recorded then is the hand-over, dropped by whoever stops it.
   */
  const journalCommandGroups = (): void => {
    const cliPid = child?.pid;
    if (processGone || cliPid === undefined) {
      return;
    }
    currentChildJournal()?.recordCommandGroups(
      cliPid,
      opts.env?.[RUN_ID_ENV] ?? null,
      [...commandGroups.values()].flat(),
    );
  };
  let commandGroupTimer: ReturnType<typeof setTimeout> | null = null;
  let commandGroupRead: ReturnType<typeof setTimeout> | null = null;
  /** When {@link commandGroupRead} was armed — the burst's first ask. */
  let commandGroupReadAskedAt = 0;
  /**
   * The burst went on after its reading was armed, so that reading can come
   * before a later command spawns: another follows it, a full delay after.
   */
  let commandGroupReadOwed = false;
  /** A reading is in flight; another asked for meanwhile follows it. */
  let readingGroups = false;
  let readGroupsAgain = false;
  /**
   * A terminal event that arrived with NO turn open while {@link openWork} was
   * still outstanding, held until the work reports.
   *
   * The in-turn rule, applied to the path that has no turn to hold. A CLI
   * continuation's own `result` line reaches the owner as an ordinary
   * between-turn event, and the owner settles the run on it — so without this a
   * run went back to `completed` moments after a delegate was launched, which
   * is the same lie the turn hold exists to prevent, arriving through the other
   * door.
   */
  let deferredOffTurnTerminal: AgentEvent | null = null;
  /**
   * Whether this CLI has ever announced its session state (`session_state`).
   *
   * It decides what ends a hold once its last unit has reported. The report is
   * NOT the end: the CLI learns a delegate finished through a task
   * notification, which opens a whole further turn of its own, so settling on
   * the report settled one breath before the agent spoke again — REPORTED as a
   * false "done" notification ("говорит мне «done», но потом сразу продолжает
   * работать"). A CLI that announces its state says when the turn is really
   * over: `idle` comes only after that continuation has ended (probed on claude
   * 2.1.270 — see `CLAUDE_SESSION_STATE_SUBTYPE`). So such a hold ends on the
   * continuation's own result (its main-thread output discards the held
   * terminal first) or on `idle`, with no timer anywhere. A ten-second grace
   * stood here before, and it delayed every genuine ending's badge and
   * notification by exactly that much.
   *
   * A CLI that has never announced its state is released on the report, since
   * nothing else will ever say the turn is over.
   */
  let announcesSessionState = false;
  /**
   * Background commands a DELEGATE started (`background_work.ownedByDelegate`),
   * remembered for the session so both of their settles are swallowed along
   * with their start — see {@link announceShellWork}.
   */
  const delegateShells = new Set<string>();
  /**
   * The delegate each delegate-made tool call belongs to (its
   * `parentToolUseId`) — the only owner fact a command a delegate detaches can
   * be filed by, since claude's `task_started` names none. Dropped once read,
   * and with the delegate once its end is announced.
   */
  const delegateCallOwner = new Map<string, string>();
  /**
   * A delegate's detached commands still running → the delegate's launching
   * call, or null while the call that started the command is not yet seen.
   */
  const delegateCommands = new Map<string, string | null>();
  /** Delegate commands still waiting for their owner, by their launching call. */
  const unownedDelegateCommands = new Map<string, string>();
  /**
   * A delegate's settle withheld while a command it detached still runs.
   * claude reports a delegate `completed` each time it ends a TURN and starts
   * it again once that command reports, so this settle is not its end.
   */
  const heldDelegateSettles = new Map<
    string,
    Extract<AgentEvent, { type: 'background_work' }>
  >();

  /** Bounds {@link deferredOffTurnTerminal}, as the turn's own deadline does. */
  let offTurnHoldTimer: AwakeTimer | null = null;
  /**
   * Held off-turn results the stretch has since continued past — the off-turn
   * twin of `TurnState.continuedSegment`: never an ending again, only a bill,
   * folded into whatever ends the stretch.
   */
  let offTurnContinued: Extract<AgentEvent, { type: 'turn_complete' }> | null =
    null;
  /** The CLI's own `cost_progress` reading since its last off-turn `result`. */
  let offTurnLiveCostUsd = 0;
  /** Of {@link offTurnLiveCostUsd}, the part geniro priced itself. */
  let offTurnLiveEstimatedCostUsd = 0;
  /** Whether the owner was last told an off-turn stretch is held. */
  let offTurnHoldAnnounced = false;
  /** Whether a non-zero off-turn live cost is up, owed a zero to come down. */
  let offTurnCostPublished = false;
  /**
   * When the CLI last gave a result, last reported background work done to
   * the agent, and last went idle — what dates the moment it woke for a
   * stretch of its own ({@link offTurnWakeAt}).
   */
  let lastResultAt = 0;
  let lastReportAt = 0;
  let lastIdleAt = 0;
  /** A stretch of the CLI's own is running (or held), so it has been dated. */
  let offTurnStretchOpen = false;

  /**
   * When the CLI began the stretch it is starting now. claude starts working
   * on a background unit's report at once (its `task_notification`), or right
   * after its result when the report came in while it was still talking, and
   * goes idle only once nothing is left — so a report since the last idle
   * dates the wake. Without one, the stretch's first output is all there is.
   */
  const offTurnWakeAt = (now: number): number =>
    lastReportAt > lastIdleAt
      ? Math.min(now, Math.max(lastReportAt, lastResultAt))
      : now;

  /**
   * A background unit the agent was waiting on has reported, and the CLI
   * starts working on it at once — so a hold standing for it is over now, not
   * when the agent next says something.
   */
  const wakeOnReport = (): void => {
    lastReportAt = Date.now();
    if (current?.deferredTerminal) {
      announceTurnHold(current, 0);
    } else if (deferredOffTurnTerminal !== null) {
      announceOffTurnHold(0);
    }
  };

  /** The in-turn hold's announcement, each change once. */
  const announceTurnHold = (
    turn: TurnState,
    open: number,
    unit?: 'command',
  ): void => {
    if (open === 0 && !turn.holdAnnounced) {
      return;
    }
    turn.holdAnnounced = open > 0;
    turn.options.onEvent({
      type: 'turn_held',
      open,
      ...(unit === undefined ? {} : { unit }),
    });
  };

  /** The agent is producing again, or has been given work: the wait is over. */
  const endCommandWait = (turn: TurnState): void => {
    if (turn.commandWaitFor === 0) {
      return;
    }
    turn.commandWaitFor = 0;
    turn.commandWaitWindows = 0;
    announceTurnHold(turn, 0);
    // The agent owes an answer now: a full window for it, not the wait's tail.
    armSilenceDeadline(turn);
  };

  /** Keep a standing wait's count on what the last sweep found. */
  const refreshCommandWait = (): void => {
    const turn = current;
    if (turn === null || turn.commandWaitFor === 0) {
      return;
    }
    const open = osDetachedShells.size;
    if (open === 0) {
      endCommandWait(turn);
    } else if (open !== turn.commandWaitFor) {
      turn.commandWaitFor = open;
      announceTurnHold(turn, open, 'command');
    }
  };

  /**
   * The turn has gone quiet. Its CLI may be blocked on a command it detached,
   * which it does not report (`AdapterConfig.shells.silentWaitReason`): what it
   * has written so far becomes rows either way, and with such a command alive
   * the turn is announced as waiting on it, which is not the agent thinking.
   */
  const onTurnQuiet = async (turn: TurnState): Promise<void> => {
    if (
      turn.settled ||
      turn.cancelRequested ||
      turn.commandWaitFor > 0 ||
      turn.outstanding.size > 0 ||
      turn.deferredTerminal !== null ||
      openWork.size > 0
    ) {
      return;
    }
    const written = turn.options.onQuiet?.() ?? null;
    if (written === null) {
      return;
    }
    // Straight to the owner: these are the CLI's earlier words, so they neither
    // rearm the watch that just fired nor say the CLI has spoken since.
    for (const event of written) {
      turn.options.onEvent(event);
    }
    const spokenCount = turn.spokenCount;
    await sweepDetachedShells();
    if (
      turn.settled ||
      turn !== current ||
      turn.cancelRequested ||
      turn.spokenCount !== spokenCount ||
      turn.commandWaitFor > 0 ||
      osDetachedShells.size === 0
    ) {
      return;
    }
    turn.commandWaitFor = osDetachedShells.size;
    announceTurnHold(turn, turn.commandWaitFor, 'command');
  };

  const continueOffTurnPast = (held: AgentEvent): void => {
    if (held.type !== 'turn_complete') {
      return;
    }
    offTurnContinued = offTurnContinued
      ? foldTurnComplete(offTurnContinued, held)
      : held;
  };

  const withOffTurnSegments = (ending: AgentEvent): AgentEvent => {
    if (
      ending.type !== 'turn_complete' &&
      ending.type !== 'error' &&
      ending.type !== 'turn_cancelled'
    ) {
      return ending;
    }
    const continued = offTurnContinued;
    offTurnContinued = null;
    if (current === null) {
      offTurnStretchOpen = false;
    }
    // The ending records every held segment, so the live figure comes down
    // ahead of it, as `finishTurn` brings a turn's down.
    offTurnLiveCostUsd = 0;
    offTurnLiveEstimatedCostUsd = 0;
    if (deferredOffTurnTerminal === null) {
      publishOffTurnLiveCost();
    }
    return withContinuedSegment(continued, ending);
  };

  /** The in-turn `turn_held`, for a stretch the CLI opened by itself. */
  const announceOffTurnHold = (open: number): void => {
    if (current !== null || (open === 0 && !offTurnHoldAnnounced)) {
      return;
    }
    offTurnHoldAnnounced = open > 0;
    opts.onBetweenTurnEvent?.({ type: 'turn_held', open });
  };

  /** The off-turn twin of `publishLiveCost`: the held segments count too. */
  const publishOffTurnLiveCost = (): void => {
    let costUsd = offTurnLiveCostUsd;
    let estimatedCostUsd = offTurnLiveEstimatedCostUsd;
    for (const segment of [deferredOffTurnTerminal, offTurnContinued]) {
      if (segment?.type !== 'turn_complete') {
        continue;
      }
      costUsd += positiveOrZero(segment.usage?.costUsd);
      estimatedCostUsd += positiveOrZero(segment.usage?.estimatedCostUsd);
    }
    if (costUsd <= 0 && !offTurnCostPublished) {
      return;
    }
    offTurnCostPublished = costUsd > 0;
    opts.onBetweenTurnEvent?.({
      type: 'cost_progress',
      costUsd,
      ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
    });
  };
  /**
   * Notices raised with NO turn to carry them, held for the next one.
   *
   * A turn owns `onEvent`, so an event arriving between turns has nowhere to go
   * — which is why an orphaned question was previously visible only as a daemon
   * log line. Buffering is not a delay dressed up: the CLI is left blocked on
   * that request, so the very next turn is the one that will produce nothing,
   * and this is the sentence that explains why. Delivering it there puts the
   * explanation exactly where the user meets the symptom.
   */
  const pendingNotices: string[] = [];
  /**
   * Approval requests held for the next turn to adopt, because no verdict could
   * be produced without one.
   *
   * Unlike a notice this is not an explanation — it is the request itself, and
   * the CLI is blocked on it. Held rather than refused: a refusal reaches the
   * agent as the USER's "no", for a card nobody ever saw. Replayed into the next
   * turn, it becomes an ordinary `approval_request` and takes the same card path
   * every in-turn request takes, so the user finally sees what was asked and the
   * verdict they give reaches a live stdin.
   *
   * Safe to replay where a general event is not: a verdict is answered by `id`,
   * so adopting one attributes nothing to the wrong turn — whereas replaying,
   * say, a `tool_result` would file one turn's output under another's.
   */
  const pendingApprovals: ApprovalRequestEvent[] = [];
  /** The one sentence {@link pendingNotices} carries for a held request. */
  const heldNotice = `${opts.command} asked this between turns — kept for you rather than answered on your behalf.`;
  /**
   * Take one request out of {@link pendingApprovals}, and the sentence
   * explaining the hold with it once nothing is held any more — a notice that
   * says "kept for you" over a card that will never be drawn is the kind of
   * explanation that makes a user go looking for the card.
   */
  const dropHeldApproval = (id: string): boolean => {
    const at = pendingApprovals.findIndex((held) => held.id === id);
    if (at === -1) {
      return false;
    }
    pendingApprovals.splice(at, 1);
    if (pendingApprovals.length === 0) {
      const noticeAt = pendingNotices.indexOf(heldNotice);
      if (noticeAt !== -1) {
        pendingNotices.splice(noticeAt, 1);
      }
    }
    return true;
  };
  /**
   * Requests the OWNER took off-turn ({@link CliSessionOptions.onHeldApproval})
   * and has not answered yet — a card on someone's screen right now — by id.
   *
   * Deliberately NOT in `pendingApprovals`: that buffer's contract is "replay
   * this into the next turn", and replaying a request the user is already
   * looking at would draw a second card for it. What the two share is the only
   * thing this map is read for — while either is non-empty, the CLI is blocked
   * on a person and the session is {@link CliSession.parked}.
   *
   * It holds the REQUEST, not only its id, because a turn opened while one is
   * still unanswered ADOPTS it into its own `outstanding` (see `startTurn`):
   * the CLI is blocked on it, so that turn is too. Left here instead, the
   * next turn's owner swept the card as `unanswerable` without ever calling
   * its `respond` — so this entry, and with it `parked`, stood for the life of
   * the session: the idle reaper re-armed over it forever, eviction skipped it,
   * and the CLI stayed blocked under every later turn.
   */
  const ownedApprovals = new Map<string, ApprovalRequestEvent>();
  /**
   * When each outstanding approval request was seen, for the round-trip line.
   *
   * The D1 investigation had to reconstruct "was this request ever answered,
   * and how fast" from transcript rows, because nothing recorded the SUCCESSFUL
   * side of the exchange — only the failures were visible, which is precisely
   * the ratio that turned out to be the diagnosis.
   */
  const approvalSeenAt = new Map<string, number>();
  /** Why the process was closed, when a close said — see `CliSession.close`. */
  let closeCause: SessionCloseCause | null = null;
  let processGone = false;
  /**
   * The child's `exit` has fired — set SYNCHRONOUSLY, ahead of the settle.
   *
   * `processGone` cannot answer "can this process still take a turn": it stays
   * false for the whole {@link EXIT_SETTLE_GRACE_MS} window while `close` is
   * awaited, and on a `session` lifetime `stdinEnded` stays false too. For
   * those two seconds the session reported itself idle AND alive, so the
   * registry would hand a caller a handle on a process that had already
   * ended. `processGone` still owns the settle/flush semantics; this owns the
   * question of whether the process is there.
   */
  let processExited = false;
  let stdinEnded = false;
  /**
   * A stopped turn was ended FOR the CLI rather than by it, so this process may
   * still print the rest of it.
   *
   * Set when a turn that was asked to stop settles WITHOUT the CLI's own
   * terminal line, and never cleared: the session is retired from REUSE, so a
   * straggler can only ever arrive with no turn open and reach
   * {@link handleOrphanEvent}. Retiring is what `AgentSessionRegistry` reads as
   * "close and replace", so the next message pays a full respawn — the user's
   * MCP servers go down and boot again, a browser they are driving among them.
   *
   * Which is why it is NOT set for a stopped turn the CLI ended itself — the
   * ordinary Stop. Measured on claude 2.1.266: after a stream-json `interrupt`
   * the CLI printed its `control_response`, the partial reply, a
   * `[Request interrupted by user]` line and then its own `result`
   * (`error_during_execution`, `terminal_reason: aborted_streaming`) — and
   * NOTHING after it for five seconds, while a second message on the same
   * process ran to its own `result`. That `result` line is what settles the
   * turn, so no tail is left to mistake for the next turn's output. (codex does
   * leave one, fenced by turn id in its own driver — `CodexSession.endedTurns`.)
   *
   * It used to be set for every Stop, REPORTED as "я его остановил. У него был
   * открыт браузер Playwright. Потом он написал новое сообщение, и Playwright
   * сразу закрылся" — the respawn taking the browser with the old process.
   *
   * The defect retiring guards against, for the record: after a Stop, a
   * cancelled turn's trailing `result` line settled the NEXT turn the moment it
   * opened (a message that got no answer at all), and its closing text was
   * persisted with the new turn's seq. Only a turn settled BEFORE its own
   * terminal line can leave that tail — the case this still covers.
   */
  let cancelledTurnMayStillEmit = false;
  /**
   * This session was ABANDONED — ended by us while its child may still be
   * running (a broken stdin nobody can write to again) — and the group kill
   * sent with it must be allowed to escalate.
   *
   * `endProcess` disarms the escalation because it normally runs once the
   * process is accounted for; here it runs to mark the session gone at once,
   * ahead of the process. Without this the SIGTERM went out alone, and a CLI
   * that ignored it lived on untracked — its owner having already forgotten a
   * session whose `closed` had resolved. Cleared when the child is seen to
   * exit, after which there is nothing left to escalate against.
   */
  let reapAfterEnd = false;
  /**
   * A graceful close is under way: the group is owed a SIGTERM when the CLI
   * exits — see {@link SessionCloseOptions}.
   */
  let reapGroupOnExit = false;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  /** See {@link TURN_END_EXIT_GRACE_MS} — one per process, which serves one turn. */
  let turnExitTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const settleTurn = (turn: TurnState, reason: string): void => {
    if (turn.settled) {
      return;
    }
    turn.settled = true;
    // The turn boundary, with WHY. The D1 investigation had to infer "was a
    // turn open when this tool call happened" from transcript rows, and the
    // reason — a `result` line, the silence deadline, the process ending —
    // was not recoverable at all.
    opts.logger?.debug?.(
      `${opts.command}: turn settled (${reason}) after ${Date.now() - turn.startedAt}ms`,
    );
    if (turn.interruptTimer) {
      clearTimeout(turn.interruptTimer);
      turn.interruptTimer = null;
    }
    if (turn.silenceTimer) {
      turn.silenceTimer.clear();
      turn.silenceTimer = null;
    }
    if (turn.quietTimer) {
      turn.quietTimer.clear();
      turn.quietTimer = null;
    }
    if (current === turn) {
      current = null;
    }
    // ONE process-table read per settle, which is where a backgrounded command
    // becomes worth naming: while the turn ran, the agent was working and the
    // badge said so, and every command it had answered for was believed
    // finished. Un-awaited on purpose — a readout must never delay the turn's
    // own ending — and cheap in the ordinary case, where nothing has outlived
    // the turn and the sweep returns before it spawns anything.
    void sweepDetachedShells();
    // Asked to stop AND ended some other way than on the CLI's own terminal
    // line — see {@link cancelledTurnMayStillEmit}. A stopped turn the CLI ended
    // ITSELF leaves nothing here to trail (codex's tail is fenced in its own
    // driver), so the process goes on serving turns and the user's MCP servers
    // — a browser among them — survive the Stop.
    //
    // Keyed on the cancel, NOT on the broader "did not end by itself". The
    // silence deadline settles a turn the same way, but the deadline path
    // deliberately keeps the process reusable ("Only the turn was given up on,
    // so the next one still reuses it", pinned in `spawn-cli.session.spec.ts`).
    const retiring = turn.cancelRequested && !turn.terminalEmitted;
    if (retiring) {
      cancelledTurnMayStillEmit = true;
    }
    // Anything this turn was shown but never answered goes back on the hold
    // buffer, ahead of whatever arrived later, so the next turn offers it
    // again. The CLI is still blocked on it either way; the only question is
    // whether it can ever be reached again.
    //
    // Which is exactly why a STOPPED turn's must not be: the CLI ends a stopped
    // turn together with its requests, so nothing is waiting on them any more,
    // and re-offering one would put a card up on the user's next message for a
    // question nobody is asking. A retiring settle has the further reason that
    // the session will serve no next turn at all.
    //
    // A turn stopped BEFORE its prompt was sent is the exception: nothing was
    // interrupted, so every request it adopted is still live on the CLI and is
    // re-held exactly as an ordinary settle re-holds one.
    if (turn.outstanding.size > 0) {
      if (turn.cancelRequested && !turn.stoppedBeforePrompt) {
        opts.logger?.warn(
          `${opts.command}: ${turn.outstanding.size} approval request(s) went unanswered when the turn was stopped — dropped with it`,
        );
      } else {
        pendingApprovals.unshift(...turn.outstanding.values());
        opts.logger?.warn(
          `${opts.command}: ${turn.outstanding.size} approval request(s) went unanswered when the turn settled — re-held for the next turn`,
        );
      }
      turn.outstanding.clear();
    }
    // The map only ever times a WITHIN-turn round trip, so nothing in it can
    // still be answered once the turn is over. `respondApproval` and the
    // between-turns handler each delete their own entry, but a request settled
    // off both paths — `ApprovalRegistry.sweepNode`'s `unanswerable`, a
    // deny-on-persist-throw, a cancel with a card still open — left one behind,
    // and a run-scoped session holds this closure for every turn of the chat.
    approvalSeenAt.clear();
    // `killTimer` is deliberately NOT cleared here. It belongs to the PROCESS,
    // not the turn: a cancel that settled the turn in protocol (or a
    // `close()` taken while a turn was running) still needs its SIGTERM to
    // escalate if the group ignores it. Only the process actually ending
    // disarms it — see `endProcess`.
    turn.resolveDone();
  };

  /**
   * Make sure a one-turn process actually goes away once its turn is over — see
   * {@link TURN_END_EXIT_GRACE_MS}.
   *
   * Armed from the terminal event, beside the stdin close it is the backstop
   * for — and by a graceful close of a kept process, which closes stdin for the
   * same reason with no turn left to kill. Idempotent and a no-op once the
   * process is accounted for, so a second terminal condition cannot arm a
   * second kill.
   */
  const armTurnExitDeadline = (): void => {
    if (turnExitTimer !== null || processGone) {
      return;
    }
    turnExitTimer = setTimeout(() => {
      turnExitTimer = null;
      if (processGone) {
        return;
      }
      opts.logger?.debug?.(
        `${opts.command}: its turn ended but the process did not — terminating the group`,
      );
      killGroup();
    }, TURN_END_EXIT_GRACE_MS);
  };

  /**
   * Arm (or rearm) the silence deadline for a turn that ends on an event.
   * A no-op for the other lifetimes, whose turn ends with its process and is
   * already bounded by `close`/`exit`.
   *
   * Also a no-op while the turn is blocked on a verdict — see
   * {@link TURN_SILENCE_DEADLINE_MS}. Rearmed from `respondApproval` once the
   * last one is delivered, so the CLI gets a full window to speak again.
   */
  const armSilenceDeadline = (turn: TurnState): void => {
    if (!settlesOnTerminalEvent || turn.settled) {
      return;
    }
    armQuietWatch(turn);
    if (turn.outstanding.size > 0) {
      if (turn.silenceTimer) {
        turn.silenceTimer.clear();
        turn.silenceTimer = null;
      }
      opts.logger?.debug?.(
        `${opts.command}: the silence deadline is suspended — the turn is blocked on ${turn.outstanding.size} unanswered request(s)`,
      );
      return;
    }
    // Refreshed rather than rebuilt, so the sleep watch's ticker is not
    // stopped and restarted on every event.
    if (turn.silenceTimer) {
      turn.silenceTimer.refresh();
      return;
    }
    turn.silenceTimer = awakeTimeout(() => {
      turn.silenceTimer = null;
      if (turn.settled || turn.terminalEmitted) {
        return;
      }
      // This turn already produced its result and was only waiting on background
      // work that has now gone silent too. It FINISHED — release the held
      // terminal rather than overwriting a completed turn with a failure whose
      // sentence ("produced nothing…") would be false about it twice over: it
      // produced an answer, and what stopped talking was the work, not the turn.
      const held = turn.deferredTerminal;
      if (held) {
        opts.logger?.warn(
          `${opts.command}: releasing the held '${held.type}' — ${openWork.size} unit(s) of background work never reported`,
        );
        // Given up on, so they must not hold the NEXT turn either — the set is
        // session-scoped now, and a unit this deadline has already written off
        // would otherwise hold every turn after it for as long as the session
        // lives. `delegateWork` is deliberately left alone so a late report
        // can resolve its outcome.
        closeOpenDelegates();
        openWork.clear();
        finishTurn(turn, held);
        return;
      }
      // Likewise a result held for a follow-up the CLI took and then never
      // answered: the turn DID produce that result.
      if (turn.supersededTerminal) {
        opts.logger?.warn(
          `${opts.command}: releasing a held 'turn_complete' — the follow-up it was held for was never answered`,
        );
        finishTurn(turn, turn.supersededTerminal);
        return;
      }
      // The same reading for a CLI that never says `idle`: it answered this
      // turn inside a continuation and has had nothing to add for the whole
      // window. A finished answer is not "produced nothing".
      if (turn.continuationAnswer) {
        opts.logger?.warn(
          `${opts.command}: settling on the continuation result that answered this turn — nothing followed it for ${Math.round(
            TURN_SILENCE_DEADLINE_MS / 60_000,
          )} minutes`,
        );
        finishTurn(turn, answeredByContinuation(turn.continuationAnswer));
        return;
      }
      // Silence with a known reason: the CLI's own wait tool sends nothing. Only
      // a command this turn started: a dev server from an earlier one explains
      // no silence, and a wedged CLI beside it must still be given up on.
      if (
        turn.commandWaitFor > 0 &&
        turn.commandWaitWindows + 1 < COMMAND_WAIT_SILENCE_WINDOWS &&
        [...osDetachedShells].some((id) => turn.ownCommands.has(id))
      ) {
        turn.commandWaitWindows += 1;
        armSilenceDeadline(turn);
        return;
      }
      // Through `emit`, so this takes the one-terminal gate with every other
      // outcome and cannot contradict a `result` line that arrives beside it.
      emit({
        type: 'error',
        message: `${opts.command} produced nothing for ${Math.round(
          (TURN_SILENCE_DEADLINE_MS * (turn.commandWaitWindows + 1)) / 60_000,
        )} minutes — giving up on the turn`,
      });
    }, TURN_SILENCE_DEADLINE_MS);
  };

  /** Restart the wait for {@link onTurnQuiet}, for a CLI whose waits are silent. */
  const armQuietWatch = (turn: TurnState): void => {
    if (!opts.silentCommandWait) {
      return;
    }
    turn.spokenCount += 1;
    if (turn.quietTimer) {
      turn.quietTimer.refresh();
      return;
    }
    turn.quietTimer = awakeTimeout(() => {
      turn.quietTimer = null;
      void onTurnQuiet(turn);
    }, opts.commandWaitQuietMs ?? COMMAND_WAIT_QUIET_MS);
  };

  /**
   * An event arrived with NO turn in flight — the process outlived the turn
   * geniro was tracking and kept working.
   *
   * Measured, not hypothetical: across the author's own `geniro.db`, 1589 of
   * 4505 tool results arrived in this state, and they carried 165 of the 181
   * `Tool permission request failed: AbortError: Stream closed` failures
   * (10.4% here against 0.5% inside an open turn).
   *
   * Most events genuinely have nobody to tell, and holding them for the next
   * turn would attribute one turn's output to another — so they stay dropped.
   * An `approval_request` is the exception, because dropping it is not
   * neutral: the CLI is BLOCKED on a reply that, with no turn, nothing will
   * ever send.
   *
   * What to answer is the OWNER's call ({@link CliSessionOptions.betweenTurnApproval}),
   * because it turns on the run's approval posture and this layer cannot see
   * one. Deciding here alone was wrong in both directions: under `auto` — whose
   * entire contract is to approve plain permissions unattended — every
   * between-turn tool call was REFUSED, and the refusal reached the agent as
   * the user's own "no" for a card that was never rendered. That is the
   * "Denied by the user in Geniro" a user saw while their agent reported it had
   * lost write access to the worktree.
   *
   * A request the owner will not decide is HELD rather than refused, and the
   * next turn adopts it — see {@link pendingApprovals}.
   */
  function handleOrphanEvent(event: AgentEvent): void {
    if (
      current === null &&
      !offTurnStretchOpen &&
      event.parentToolUseId === undefined &&
      RESUMES_A_HELD_TURN.has(event.type)
    ) {
      offTurnStretchOpen = true;
      opts.onBetweenTurnEvent?.({
        type: 'off_turn_started',
        at: offTurnWakeAt(Date.now()),
      });
    }
    // The off-turn twin of the in-turn release: the CLI speaking again means
    // the continuation this hold was released for has begun, so the held
    // terminal no longer ends anything — but what that segment cost is still
    // the stretch's, and it is folded into whatever ends it.
    if (
      deferredOffTurnTerminal !== null &&
      event.parentToolUseId === undefined &&
      RESUMES_A_HELD_TURN.has(event.type)
    ) {
      opts.logger?.debug?.(
        `${opts.command}: releasing the off-turn hold — the main thread is talking again with ${openWork.size} unit(s) still out`,
      );
      if (offTurnHoldTimer) {
        offTurnHoldTimer.clear();
        offTurnHoldTimer = null;
      }
      continueOffTurnPast(deferredOffTurnTerminal);
      deferredOffTurnTerminal = null;
      announceOffTurnHold(0);
    }
    if (event.type === 'background_work') {
      // Turn plumbing wherever it arrives. It is NOT forwarded to the owner as
      // an event (it maps to no row, so the owner drops it anyway) — what the
      // owner is told is the delegate liveness `trackBackgroundWork` announces
      // from it, which is the only thing that can correct a block whose
      // launching call returned the moment the delegate was accepted.
      trackBackgroundWork(event);
      return;
    }
    if (event.type === 'cost_progress') {
      offTurnLiveCostUsd = event.costUsd > 0 ? event.costUsd : 0;
      offTurnLiveEstimatedCostUsd = positiveOrZero(event.estimatedCostUsd);
      publishOffTurnLiveCost();
      return;
    }
    if (
      event.type === 'turn_complete' &&
      settlesOnTerminalEvent &&
      openWork.size > 0
    ) {
      // The CLI's own continuation has stopped talking while work IT started is
      // still running. Same rule as the in-turn hold, same reason: forwarding it
      // now settles the run `completed` under delegates that are demonstrably
      // still going. The FIRST one is kept, as in a turn — a later continuation
      // reports on itself, not on the work being waited for.
      if (deferredOffTurnTerminal === null) {
        deferredOffTurnTerminal = event;
        opts.logger?.debug?.(
          `${opts.command}: holding an off-turn '${event.type}' — ${openWork.size} unit(s) of background work have not reported`,
        );
        armOffTurnHold();
        offTurnLiveCostUsd = 0;
        offTurnLiveEstimatedCostUsd = 0;
        announceOffTurnHold(openWork.size);
        publishOffTurnLiveCost();
      }
      return;
    }
    if (event.type !== 'approval_request') {
      if (opts.onBetweenTurnEvent) {
        opts.onBetweenTurnEvent(withOffTurnSegments(event));
        return;
      }
      opts.logger?.warn(
        `${opts.command}: dropped a '${event.type}' event arriving between turns`,
      );
      return;
    }
    const isQuestion = isUserQuestion(
      opts.questionToolName ?? null,
      event.toolName,
    );
    // The default is the pre-owner behaviour, kept for callers with no posture
    // to offer: a question is held (refusing answers for the user), a
    // permission is refused (no turn can carry a verdict).
    // Not `?? default` — null is a VERDICT here ("hold it"), and `??` would
    // read it as an absent policy and fall through to the refusal this exists
    // to remove.
    const offered = opts.betweenTurnApproval
      ? opts.betweenTurnApproval({
          toolName: event.toolName,
          input: event.input,
        })
      : isQuestion
        ? null
        : false;
    // A floor no owner can lower: a QUESTION is never answered without the
    // user, whatever the posture says. The previous code refused questions
    // unconditionally and so could not get this wrong; now that an owner
    // decides, the one verdict that would speak for the user has to be
    // unavailable rather than merely unused by today's only caller.
    const verdict = isQuestion && offered === true ? null : offered;
    if (verdict !== offered) {
      opts.logger?.warn(
        `${opts.command}: refusing to auto-answer the question tool '${event.toolName}' between turns — held for the user instead`,
      );
    }
    if (verdict === null) {
      approvalSeenAt.delete(event.id);
      // Offered to the owner FIRST, because holding is the weaker answer: it
      // leaves the CLI blocked with nothing on screen until a turn that may
      // never come. A verdict needs no turn — only this stdin and the encoder
      // the last turn installed, both of which outlive it.
      if (opts.onHeldApproval && approvalEncoder) {
        const respond = (
          allow: boolean,
          input?: unknown,
          option?: ApprovalOption,
        ): boolean => {
          ownedApprovals.delete(event.id);
          const answer = approvalEncoder?.(event.id, allow, input, option);
          const written = answer !== undefined && sessionWrite(answer);
          if (written) {
            // Answered, so it must be dropped wherever it has moved to since
            // the card went up: a turn opened meanwhile ADOPTED it (see
            // `startTurn`) and is suspending its silence deadline on it, or a
            // turn that settled re-held it for the next one. Keyed on the
            // write, as `respondApproval` is — a verdict the CLI never received
            // leaves it exactly where it is.
            if (current?.outstanding.delete(event.id)) {
              armSilenceDeadline(current);
            }
            dropHeldApproval(event.id);
            if (allow) {
              requestCommandGroups();
            }
          }
          // The failure half NAMES its cause rather than blaming stdin for all
          // of them — `writeObstacle`'s reason, and "no encoder" kept distinct
          // from it, since that one is geniro having nothing to send rather
          // than nowhere to send it.
          const failure =
            answer === undefined
              ? 'this CLI has no encoder for the verdict'
              : (writeObstacle() ?? 'the write was refused');
          opts.logger?.warn(
            `${opts.command}: between-turn ${isQuestion ? 'question' : 'approval_request'} for '${event.toolName}' ` +
              `(id ${event.id}) ${written ? `${allow ? 'allowed' : 'refused'} by the user` : `could NOT be answered — ${failure}`}`,
          );
          return written;
        };
        ownedApprovals.set(event.id, event);
        if (opts.onHeldApproval(event, respond)) {
          opts.logger?.warn(
            `${opts.command}: ${isQuestion ? 'question' : 'approval_request'} for '${event.toolName}' ` +
              `(id ${event.id}) arrived between turns — raised for the user to answer now`,
          );
          return;
        }
        // The owner declined it, so nothing is on screen after all — fall
        // through to the hold rather than leaving the set claiming a card.
        ownedApprovals.delete(event.id);
      }
      pendingApprovals.push(event);
      opts.logger?.warn(
        `${opts.command}: ${isQuestion ? 'question' : 'approval_request'} for '${event.toolName}' ` +
          `(id ${event.id}) arrived between turns — held for the next turn to adopt`,
      );
      // Oldest first, and SAID rather than silently trimmed. Every held
      // request is a CLI blocked on a verdict, so dropping one is giving up on
      // it — a fact the log has to carry, because the user's only other clue
      // would be an agent that never finished. The cap exists because nothing
      // else bounds this: a CLI asking repeatedly on a chat nobody returns to
      // would grow the buffer for as long as the session lives.
      while (pendingApprovals.length > MAX_HELD_APPROVALS) {
        const dropped = pendingApprovals.shift()!;
        opts.logger?.warn(
          `${opts.command}: dropped held request '${dropped.toolName}' (id ${dropped.id}) — ` +
            `more than ${MAX_HELD_APPROVALS} are outstanding and the CLI is still blocked on it`,
        );
      }
      // ONE notice per turn however many are held: the sentence explains the
      // state, not each occurrence, and N verbatim copies of it would bury the
      // cards it is pointing at.
      // Short, and INFORMATIONAL — see the severity below. The three-clause
      // version this replaces explained the whole mechanism (nothing was on
      // screen; it was not answered for you; it is shown above), in the daemon's
      // failure chrome, immediately above the card it points at. Reported back
      // as an error the user "still sees sometimes", which is fair: nothing went
      // wrong, the request was kept and handed over exactly as intended.
      if (!pendingNotices.includes(heldNotice)) {
        pendingNotices.push(heldNotice);
      }
      return;
    }
    // The request's OWN input rides back, exactly as the in-turn auto-approve
    // seam does it. Passing undefined was harmless while this branch only ever
    // denied (a deny drops the field), but an ALLOW echoes it — and the
    // adapter's `updatedInput ?? {}` would have handed the CLI a blanked
    // argument list for a call it had just been given permission to make.
    const line = approvalEncoder?.(event.id, verdict, event.input);
    const answered = line !== undefined && sessionWrite(line);
    approvalSeenAt.delete(event.id);
    if (answered && verdict) {
      // A command the CLI reported before asking runs only now.
      requestCommandGroups();
    }
    // WARN, not debug: the CLI asked permission for work no turn owns, which
    // is the state the D1 numbers point at. Every field a later reader needs
    // to join this to a transcript row is on the line — tool and request id
    // were both missing from the message this replaces.
    opts.logger?.warn(
      `${opts.command}: approval_request for '${event.toolName}' (id ${event.id}) arrived between turns — ` +
        (answered
          ? `${verdict ? 'allowed' : 'refused'} by the run's standing approval posture`
          : `and could NOT be answered (${line === undefined ? 'this CLI has no encoder for the verdict' : (writeObstacle() ?? 'the write was refused')}) — the CLI is parked`),
    );
  }

  /**
   * A held terminal describes a turn that has since CONTINUED, so it no longer
   * ends it — but what that segment cost is still this turn's. Dropping it
   * lost the whole first segment's bill: the turn settles on its next `result`,
   * which the adapter reports as that segment's own figures alone. It is kept
   * as an earlier segment {@link finishTurn} folds into the turn's ending.
   */
  const supersedeHeldTerminal = (turn: TurnState): void => {
    const held = turn.deferredTerminal;
    turn.deferredTerminal = null;
    if (held?.type !== 'turn_complete') {
      return;
    }
    turn.continuedSegment = turn.continuedSegment
      ? foldTurnComplete(turn.continuedSegment, held)
      : held;
  };

  /**
   * Hand a turn its terminal event and settle it — the one door every outcome
   * takes, whether it arrived now or was held for background work.
   *
   * Extracted so a deferred terminal cannot take a shorter path than a prompt
   * one: the one-terminal gate, the stdin close and the settle are the same
   * three steps either way.
   */
  /**
   * Publish what this turn has spent that no durable row carries yet: the
   * CLI's own reading since its last `result`, plus every segment the turn is
   * holding ({@link heldCostOf}). A zero is published only to take down a
   * figure that was up.
   */
  const publishLiveCost = (turn: TurnState): void => {
    const held = heldCostOf(turn);
    const costUsd = turn.liveCostUsd + held.costUsd;
    if (costUsd <= 0 && !turn.costPublished) {
      return;
    }
    turn.costPublished = costUsd > 0;
    const estimatedCostUsd = turn.liveEstimatedCostUsd + held.estimatedCostUsd;
    turn.options.onEvent({
      type: 'cost_progress',
      costUsd,
      ...(estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
    });
  };

  const finishTurn = (turn: TurnState, ending: AgentEvent): void => {
    if (turn.terminalEmitted) {
      return;
    }
    turn.terminalEmitted = true;
    turn.deferredTerminal = null;
    turn.supersededTerminal = null;
    const event = withContinuedSegment(turn.continuedSegment, ending);
    turn.continuedSegment = null;
    // The terminal records every held segment, so the live figure comes down
    // AHEAD of it — a reader adding the two never counts that money twice.
    turn.liveCostUsd = 0;
    turn.liveEstimatedCostUsd = 0;
    publishLiveCost(turn);
    // Ending with its process already told to go (a chat's Stop closes the
    // session): what the CLI still holds queued goes with it, so it is said
    // ahead of the terminal, where every owner matches it.
    if (groupKilled) {
      emitUntakenFollowUps(turn);
    }
    if (opts.stdinLifetime === 'turn') {
      endStdin();
      // Closing stdin only ASKS a one-turn CLI to finish; one that ignores EOF
      // would otherwise hold this turn — and the run's registry slot — open
      // for good. See {@link TURN_END_EXIT_GRACE_MS}.
      armTurnExitDeadline();
    }
    turn.options.onEvent(event);
    if (settlesOnTerminalEvent) {
      settleTurn(turn, `terminal event '${event.type}'`);
    }
  };

  /**
   * Tell the transcript that a DELEGATE is still out, and later that it is not.
   *
   * The transcript reads a delegate as finished when its launching tool call
   * returns, which is right for one the agent waits for and wrong for one it
   * does not: a fire-and-forget delegate's `Task` call returns in under a
   * second while the delegate runs on (measured on claude 2.1.232 — three of
   * them still working 50s after their blocks had closed, so the app reported
   * none working while three were). This is the only signal that can correct
   * it, so it is forwarded as a `subagent_info` announcement — the row that
   * already carries facts ABOUT a delegate, keyed by the same launching call.
   *
   * Only for units the adapter named as delegates: the same channel carries
   * shell commands and a delegate's own sub-work, and announcing those would
   * put phantom sub-agents in the transcript.
   */
  const announceDelegateWork = (
    event: Extract<AgentEvent, { type: 'background_work' }>,
    trackingLost?: SubagentTrackingLost,
  ): void => {
    const toolCallId =
      event.phase === 'started'
        ? event.unit === 'agent'
          ? event.toolCallId
          : null
        : // A settle names neither the kind nor (on one of the two channels) the
          // call, so it is matched against what the `started` recorded. A unit
          // that was never announced as a delegate is silently not one.
          (delegateWork.get(event.id) ?? null);
    if (toolCallId === null) {
      return;
    }
    if (event.phase === 'started') {
      heldDelegateSettles.delete(toolCallId);
      delegateWork.set(event.id, toolCallId);
      // A delegate the agent is WAITING on is not background work, and says
      // nothing yet: its block is the launching call, which is still open. The
      // `backgrounded` below is where it gets its `backgroundOpen: true`, if it
      // ever does. See `foregroundUnits`.
      if (event.foreground === true) {
        return;
      }
    } else if (event.phase === 'backgrounded') {
      // Only the move of a unit that was WAITED on is news — a second one, or
      // one for a delegate that was background from the start, would write a
      // durable row repeating what the transcript already says.
      if (!foregroundUnits.has(event.id)) {
        return;
      }
    } else if (
      event.outcome === 'completed' &&
      [...delegateCommands.values()].includes(toolCallId)
    ) {
      // Announced when its last command settles. Of the two channels' settles
      // the one carrying figures is kept.
      if (
        heldDelegateSettles.get(toolCallId)?.usage === undefined ||
        event.usage !== undefined
      ) {
        heldDelegateSettles.set(toolCallId, event);
      }
      return;
    } else if (event.usage !== undefined) {
      // Forgotten on the settle that carried the FIGURES, not on the first
      // settle to arrive — and the difference is the whole of what a delegate
      // costs.
      //
      // A CLI is free to report one unit's end on two channels, which is
      // exactly why the pairing is remembered here at all; only one of the two
      // says what the work spent. Measured on claude 2.1.237, the figure-less
      // one goes FIRST: `task_updated {status:'completed'}` then
      // `task_notification {usage:{…}}`, in that order on a real delegation.
      // Deleting on the first therefore threw the figures away every time —
      // observed end to end, four `subagent_info` rows in the app's own
      // database with `tokens: null` on all of them.
      //
      // A settle with no figures still ANNOUNCES (the block has to close), it
      // simply does not close the book. The cost of that is an entry surviving
      // the session for a unit whose CLI never reports usage: two short
      // strings, on a map this code already keeps deliberately past the
      // silence deadline for late reports.
      delegateWork.delete(event.id);
    }
    if (event.phase === 'settled') {
      // Its end, announced: whatever was held for it is superseded, and the
      // owner entries of calls that never started a command are let go.
      heldDelegateSettles.delete(toolCallId);
      for (const [call, owner] of delegateCallOwner) {
        if (owner === toolCallId) {
          delegateCallOwner.delete(call);
        }
      }
    }
    const announcement: AgentEvent = {
      type: 'subagent_info',
      id: toolCallId,
      // Nulls throughout: this announcement claims ONE fact and must not
      // overwrite a label, prompt or duration a richer announcement gave — the
      // consumer merges by preferring the last NON-null per field.
      label: null,
      kind: null,
      prompt: null,
      model: null,
      // …with the exception of what the settle line itself measured, which is
      // announced HERE rather than by the adapter for the reason recorded on
      // `background_work.usage`: this is the only point that knows the settling
      // unit was a delegate at all. A `started` carries no figures and keeps
      // the nulls, so it cannot blank out a settle that arrives first on the
      // other channel.
      durationMs: event.usage?.durationMs ?? null,
      tokens: event.usage?.tokens ?? null,
      toolUses: event.usage?.toolUses ?? null,
      // The settle channel reports a token ROLL-UP and nothing finer, so the
      // billing breakdown and the price derived from it are not this
      // announcement's to make — they ride the launching call's own result,
      // which is the only line that breaks a delegate's spend down by kind.
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      costUsd: null,
      stepsUnavailableReason: null,
      // A foreground `started` returned above, so both other arms here open it.
      backgroundOpen: event.phase !== 'settled',
      // What the settle SAID, not merely that it happened. Null on a `started`
      // and on a settle whose CLI names no outcome: absent claims no outcome,
      // so a recoverable delegate's block reads untracked until its record
      // is read (`foldRunDelegates`).
      backgroundOutcome:
        event.phase === 'settled' ? (event.outcome ?? null) : null,
      ...(trackingLost === undefined ? {} : { trackingLost }),
    };
    // To whoever can carry it. A delegate launched between turns is the whole
    // reason this is not simply `turn.options.onEvent`: that path had no turn,
    // so the announcement was dropped and the block stayed closed over a
    // delegate that had not started working yet.
    if (current) {
      current.options.onEvent(announcement);
      return;
    }
    opts.onBetweenTurnEvent?.(announcement);
  };

  const closeOpenDelegates = (
    outcome: 'untracked' | 'stopped' = 'untracked',
    trackingLost?: SubagentTrackingLost,
  ): void => {
    for (const id of openWork) {
      if (delegateWork.has(id)) {
        announceDelegateWork(
          {
            type: 'background_work',
            id,
            phase: 'settled',
            unit: 'agent',
            toolCallId: null,
            outcome,
          },
          trackingLost,
        );
      }
    }
  };

  /**
   * Bound the off-turn hold, so a unit that never reports cannot strand a
   * continuation's result for the life of the session.
   *
   * The turn's own silence deadline is the model, and the same window: this is
   * the same "the CLI has gone quiet on us" question asked with no turn open.
   * It releases rather than fails — the continuation FINISHED, and only the
   * work it was waited on for went silent.
   */
  const armOffTurnHold = (): void => {
    if (offTurnHoldTimer) {
      offTurnHoldTimer.clear();
    }
    offTurnHoldTimer = awakeTimeout(() => {
      offTurnHoldTimer = null;
      const held = deferredOffTurnTerminal;
      if (!held) {
        return;
      }
      opts.logger?.warn(
        `${opts.command}: releasing an off-turn '${held.type}' — ${openWork.size} unit(s) of background work never reported`,
      );
      // Written off exactly as the turn's deadline writes its own units off,
      // and for the same reason: they must not hold anything after this.
      closeOpenDelegates();
      openWork.clear();
      releaseOffTurnHold();
    }, TURN_SILENCE_DEADLINE_MS);
  };

  /**
   * A background SHELL's end, announced as the row that closes it.
   *
   * The delegate twin above and this one split the SAME channel by what the
   * unit is, because the two need opposite treatment: a delegate's own block
   * already exists and is corrected (`subagent_info`), while a shell has no row
   * of its own at all — only the tool call that launched it, which returned
   * within the second. Announcing a shell as a delegate would put phantom
   * sub-agents in the transcript, which is exactly what the delegate twin
   * refuses to do in the other direction.
   *
   * Only the SETTLE is announced. A `started` is remembered (the pairing to the
   * launching call is stated on that line and, on one of the two settle
   * channels, nowhere else) and says nothing a client needs — the tool call is
   * already the start.
   */
  /**
   * The CLI's own statement of whether it is working — see
   * {@link announcesSessionState}.
   *
   * `idle` is the authoritative turn-over, so a hold still standing when it
   * arrives is over — including one {@link openWork} still counts units for:
   * the CLI does not go idle while a background agent of its own is due to
   * report, so a unit still listed here is a report this layer missed, and it is
   * written off the way the silence deadline writes off its own.
   */
  const onSessionState = (idle: boolean): void => {
    announcesSessionState = true;
    if (!idle) {
      return;
    }
    lastIdleAt = Date.now();
    offTurnStretchOpen = false;
    const turn = current;
    const held = turn?.deferredTerminal ?? deferredOffTurnTerminal;
    if (held) {
      if (openWork.size > 0) {
        opts.logger?.warn(
          `${opts.command}: the CLI went idle with ${openWork.size} unit(s) of background work never reported — settling the held '${held.type}'`,
        );
        closeOpenDelegates();
        openWork.clear();
      } else {
        opts.logger?.debug?.(
          `${opts.command}: the CLI went idle — settling the held '${held.type}'`,
        );
      }
      if (turn?.deferredTerminal) {
        finishTurn(turn, turn.deferredTerminal);
        return;
      }
      releaseOffTurnHold();
    }
    // The turn's prompt was answered inside a continuation and no result of
    // its own is coming: `idle` is the CLI saying so. See
    // `TurnState.continuationAnswer`. Not while a card is open — the CLI can
    // report idle while it waits on one, and that turn has not finished.
    if (
      turn &&
      !turn.terminalEmitted &&
      !turn.promptHeld &&
      turn.outstanding.size === 0 &&
      turn.continuationAnswer
    ) {
      opts.logger?.debug?.(
        `${opts.command}: the CLI went idle with this turn's prompt answered inside a continuation — settling on that result`,
      );
      finishTurn(turn, answeredByContinuation(turn.continuationAnswer));
      return;
    }
    // A result held for a follow-up the CLI never carried on with. `idle` is
    // the CLI saying nothing more is coming — an acknowledgement that did not
    // match what was written (the only way to get here) waits no longer.
    // Not while a card is open, for the reason above.
    if (
      turn &&
      !turn.terminalEmitted &&
      turn.outstanding.size === 0 &&
      turn.supersededTerminal
    ) {
      opts.logger?.warn(
        `${opts.command}: the CLI went idle without taking the ${turn.unconsumedFollowUps.length} follow-up(s) a result was held for — settling on it`,
      );
      turn.unconsumedFollowUps = [];
      finishTurn(turn, turn.supersededTerminal);
    }
  };

  /** Record a detached command as running and tell whoever can carry it. */
  const openShell = (workId: string, toolCallId: string | null): void => {
    runningShells.add(workId);
    requestCommandGroups();
    const opened: AgentEvent = { type: 'shell_open', toolCallId, workId };
    if (current) {
      current.options.onEvent(opened);
    } else {
      opts.onBetweenTurnEvent?.(opened);
    }
  };

  const announceShellWork = (
    event: Extract<AgentEvent, { type: 'background_work' }>,
  ): void => {
    if (event.phase === 'started') {
      // A DELEGATE's own command: its block holds it, and the main thread's
      // terminals — list, count, chip — deliberately do not (REPORTED as "we
      // should not show terminals from subagents"). Without this every one
      // reached the daemon's shell list and the run's count, and the shelf
      // chip listed it unlabelled while the agents panel showed nothing.
      if (event.ownedByDelegate === true && event.unit !== 'agent') {
        delegateShells.add(event.id);
        const owner =
          event.toolCallId === null
            ? undefined
            : delegateCallOwner.get(event.toolCallId);
        delegateCommands.set(event.id, owner ?? null);
        if (event.toolCallId !== null) {
          delegateCommandCalls.set(event.id, event.toolCallId);
          if (owner === undefined) {
            unownedDelegateCommands.set(event.toolCallId, event.id);
          } else {
            delegateCallOwner.delete(event.toolCallId);
          }
        }
        requestCommandGroups();
        return;
      }
      // Recorded for EVERY unit, delegate or not: a settle carries no kind, so
      // which map answers for an id is decided here, where the CLI stated it.
      if (event.unit !== 'agent' && event.toolCallId !== null) {
        shellWork.set(event.id, event.toolCallId);
        // A command the agent waits on runs in a session of its own too.
        if (event.foreground === true) {
          requestCommandGroups();
        }
      }
      // …and the OWNER is told, which the bracket itself cannot do: a
      // `background_work` is turn plumbing and is never forwarded, so without
      // this the daemon could watch every detached command END and never see
      // one begin. `unit !== 'agent'` is the same carve-out the settle below
      // makes — a delegate's liveness is `announceDelegateWork`'s business.
      //
      // Not for a command run in the FOREGROUND: claude registers one as a task
      // once it has run a few seconds (`is_backgrounded: false`), so that it
      // CAN be moved to the background — but until it is, it is the agent's
      // current tool call, not a detached command, and announcing it would
      // count it in `shellsOpen`. See `foregroundUnits`.
      if (event.unit !== 'agent' && event.foreground !== true) {
        openShell(event.id, event.toolCallId ?? null);
      }
      return;
    }
    if (event.phase === 'backgrounded') {
      // A foreground command the CLI has just detached: from here on it IS a
      // background shell, owed the open its start withheld. A delegate's move
      // is the other twin's, and a delegate's own command stays in its block.
      if (
        foregroundUnits.has(event.id) &&
        !delegateWork.has(event.id) &&
        !delegateShells.has(event.id)
      ) {
        openShell(
          event.id,
          event.toolCallId ?? shellWork.get(event.id) ?? null,
        );
      }
      return;
    }
    // A foreground command that ENDED in the foreground was never announced as
    // a shell, so there is nothing to close: its end is its own tool result.
    // A shell_info here would be a durable row about a detached command that
    // never existed.
    if (
      foregroundUnits.has(event.id) &&
      !delegateWork.has(event.id) &&
      !delegateShells.has(event.id)
    ) {
      shellWork.delete(event.id);
      commandGroups.delete(event.id);
      journalCommandGroups();
      return;
    }
    // A delegate's settle is the other twin's business — it is matched against
    // what the `started` recorded, so a unit this map never saw is silently not
    // a shell and nothing is announced for it.
    if (delegateWork.has(event.id)) {
      return;
    }
    // Its start announced nothing, so its end has nothing to close. Kept in the
    // set: claude reports the end on both terminal channels, and the second
    // would otherwise be announced as an ordinary shell's.
    if (delegateShells.has(event.id)) {
      const owner = delegateCommands.get(event.id) ?? null;
      delegateCommands.delete(event.id);
      delegateCommandCalls.delete(event.id);
      commandGroups.delete(event.id);
      journalCommandGroups();
      for (const [call, unit] of unownedDelegateCommands) {
        if (unit === event.id) {
          unownedDelegateCommands.delete(call);
        }
      }
      // Offered again rather than announced outright: it is held once more
      // while another of the delegate's commands still runs.
      const held = owner === null ? undefined : heldDelegateSettles.get(owner);
      if (owner !== null && held !== undefined) {
        heldDelegateSettles.delete(owner);
        announceDelegateWork(held);
      }
      return;
    }
    const wasRunning = runningShells.delete(event.id);
    commandGroups.delete(event.id);
    journalCommandGroups();
    // ONCE per unit. A CLI is free to report one unit's end on both of its
    // terminal channels, and claude does: measured on a real background `sleep`
    // (2026-08-24, 2.1.237), `task_updated` and `task_notification` both landed
    // within 7ms and wrote two identical rows into the transcript. The reader
    // is idempotent, so the cost was noise rather than wrongness — but the rows
    // are DURABLE, so it was noise stored forever, twice per background command.
    if (settledShells.has(event.id)) {
      return;
    }
    // A unit this process never opened is one an earlier process of the
    // conversation ran, and closed as that process ended: claude, resumed after
    // a crash, reports such a task `stopped` once more (measured on 2.1.295).
    if (!wasRunning) {
      shellWork.delete(event.id);
      return;
    }
    settledShells.add(event.id);
    const toolCallId = event.toolCallId ?? shellWork.get(event.id) ?? null;
    // Forgotten on the FIRST settle, unlike the delegate map: nothing here is
    // waiting for a second line carrying figures — a shell's end is the whole
    // of what this reports — so keeping the entry would only leak one string
    // per background command for the life of the session.
    shellWork.delete(event.id);
    const announcement: AgentEvent = {
      type: 'shell_info',
      toolCallId,
      workId: event.id,
      ...(event.ending === undefined ? {} : { ending: event.ending }),
    };
    // To whoever can carry it, on the same rule as the delegate announcement:
    // a background command routinely OUTLIVES the turn that launched it, so
    // the between-turn sink is the normal path here rather than the exception.
    if (current) {
      current.options.onEvent(announcement);
      return;
    }
    opts.onBetweenTurnEvent?.(announcement);
  };

  /**
   * Hand a held off-turn terminal to the owner, once, carrying every segment
   * the stretch continued past. `insideTurn` when a turn of ours has opened:
   * the stretch ended without ending that turn.
   */
  const releaseOffTurnHold = (insideTurn = false): void => {
    const held = deferredOffTurnTerminal;
    deferredOffTurnTerminal = null;
    if (offTurnHoldTimer) {
      offTurnHoldTimer.clear();
      offTurnHoldTimer = null;
    }
    announceOffTurnHold(0);
    if (held) {
      opts.onBetweenTurnEvent?.(
        withOffTurnSegments(
          insideTurn && held.type === 'turn_complete'
            ? { ...held, insideTurn: true }
            : held,
        ),
      );
    }
  };

  /**
   * Note a command the CLI ran, and later that the CLI answered for it.
   *
   * Reads the SHARED tool vocabulary (`toolKind: 'execute'`) rather than any
   * CLI's tool names, on the rule that field was added for: the two shipped
   * CLIs call their shell tool `Bash` and `` `sleep 300` `` respectively, and
   * recognising either name here would be an agent branch in an agent-agnostic
   * module.
   *
   * The COMMAND is read off the call's own arguments, which is the only place
   * it exists; a call that discloses none is skipped, since there would be
   * nothing to look for in the process table.
   */
  const rememberExecuteCall = (event: AgentEvent): void => {
    if (!opts.detectDetachedShells) {
      return;
    }
    if (event.type === 'tool_result') {
      const known = executeCalls.get(event.id);
      if (known) {
        known.returned = true;
        // Answered as finished, maybe while it runs on: where it runs is
        // recorded now, not at the turn's end.
        requestCommandGroups();
      }
      return;
    }
    if (event.type !== 'tool_call' || event.kind !== 'execute') {
      return;
    }
    const command = commandLineOf(event);
    if (command !== null) {
      executeCalls.set(event.id, {
        command,
        returned: false,
        calledAt: Date.now(),
      });
      current?.ownCommands.add(event.id);
      requestCommandGroups();
    }
  };

  /**
   * Note the command line a call ran, for {@link CliSession.runningCommands}.
   *
   * Read off the call's own `command` argument rather than its kind: claude
   * marks no kind on its shell tool, and the argument is where every shipped
   * CLI puts the line.
   */
  const rememberCommandLine = (event: AgentEvent): void => {
    if (event.type === 'tool_result') {
      openCommandCalls.delete(event.id);
      return;
    }
    if (event.type !== 'tool_call') {
      return;
    }
    const command = commandLineOf(event);
    if (command === null) {
      return;
    }
    callCommands.set(event.id, command);
    openCommandCalls.set(event.id, {
      name: event.name,
      parentToolUseId: event.parentToolUseId,
    });
    if (callCommands.size <= MAX_REMEMBERED_COMMANDS) {
      return;
    }
    // Every unit not yet settled, not only the running ones: a foreground
    // command is in `shellWork` before a `backgrounded` makes it a shell.
    const needed = new Set([
      ...shellWork.values(),
      ...delegateCommandCalls.values(),
      // A command the detached-shell sweep has yet to look at.
      ...executeCalls.keys(),
    ]);
    for (const id of callCommands.keys()) {
      if (!needed.has(id)) {
        callCommands.delete(id);
        return;
      }
    }
  };

  /**
   * Which of this CLI's answered commands still run, for a CLI that reports a
   * backgrounded command finished; each opens a shell row. Decided by the CLI's
   * own record where it keeps one (`.claude/rules/daemon-cursor-acp.md`),
   * else by the command's text in the process table under this CLI.
   *
   * An unanswered call is an ordinary foreground command, which the transcript
   * already shows as running. The result goes through {@link announceShellWork}
   * as an ordinary `background_work` bracket, so there is no second kind of
   * shell downstream.
   */
  const sweepDetachedShells = async (): Promise<void> => {
    if (!opts.detectDetachedShells) {
      return;
    }
    if (shellSweep !== null) {
      shellSweepOwed = true;
      return shellSweep;
    }
    shellSweep = (async () => {
      try {
        do {
          shellSweepOwed = false;
          await readDetachedShells();
        } while (shellSweepOwed && !processGone);
      } catch (err) {
        opts.logger?.warn(
          `${opts.command}: could not read which of its commands still run: ${errorMessage(err)}`,
        );
      } finally {
        shellSweep = null;
      }
    })();
    return shellSweep;
  };

  const readDetachedShells = async (): Promise<void> => {
    const pending = [...executeCalls].filter(
      ([id, call]) => call.returned && !osDetachedShells.has(id),
    );
    if (pending.length === 0 && osDetachedShells.size === 0) {
      return;
    }
    const rootPid = child?.pid;
    if (rootPid === undefined) {
      return;
    }
    const alive = descendantsOf(
      await (opts.listProcesses ?? listProcesses)(),
      rootPid,
    );
    const records = (await opts.readCommandRecords?.()) ?? [];
    const stillRunning = commandLiveness(alive, records);
    const keptOpen = new Set(
      [...osDetachedShells].filter((id) => {
        const call = executeCalls.get(id);
        return call !== undefined && stillRunning(call.command);
      }),
    );
    // A call the CLI has not answered holds its own record: an earlier call
    // written alike has ended, whatever that record says.
    for (const call of executeCalls.values()) {
      if (!call.returned) {
        stillRunning(call.command);
      }
    }
    // Newest first: of several calls written alike, the newest holds the record.
    for (const [id, call] of pending.reverse()) {
      if (!stillRunning(call.command)) {
        // Answered and gone — the ordinary case, and the reason this map is
        // pruned here rather than growing for the life of the session.
        executeCalls.delete(id);
        commandGroups.delete(id);
        journalCommandGroups();
        continue;
      }
      osDetachedShells.add(id);
      keptOpen.add(id);
      announceShellWork({
        type: 'background_work',
        id,
        phase: 'started',
        // The launching call's own id IS the work id here. Unlike a CLI's
        // bracket there is no separate work id to carry, and using the call's
        // makes the row joinable to the transcript exactly as a reported one is.
        unit: 'other',
        toolCallId: id,
      });
    }
    for (const id of [...osDetachedShells]) {
      if (keptOpen.has(id)) {
        continue;
      }
      osDetachedShells.delete(id);
      const call = executeCalls.get(id);
      const command = call?.command;
      executeCalls.delete(id);
      const record =
        call === undefined
          ? null
          : endedRecordOf(records, call.command, call.calledAt);
      announceShellWork({
        type: 'background_work',
        id,
        phase: 'settled',
        unit: 'other',
        toolCallId: null,
        ...(command === undefined
          ? {}
          : {
              ending: {
                command,
                exitCode: record?.exitCode ?? null,
                outputPath: record?.outputPath ?? null,
                endedAt: record?.endedAt ?? null,
              },
            }),
      });
    }
    refreshCommandWait();
    armDetachedShellPoll();
  };

  /**
   * Keep asking while anything is out, and stop the moment nothing is.
   *
   * A poll rather than an event because there is no event: the CLI has already
   * said its piece about these commands and will not mention them again. It is
   * bounded by the SET being non-empty, so an ordinary session — every command
   * finishing when the CLI said it did — never runs one.
   *
   * Chained timeouts rather than an interval, so a slow `ps` on a loaded
   * machine cannot overlap itself, and `unref`'d so a forgotten timer can never
   * be the thing keeping the daemon alive.
   */
  const armDetachedShellPoll = (): void => {
    if (detachedShellTimer !== null || osDetachedShells.size === 0) {
      return;
    }
    detachedShellTimer = setTimeout(() => {
      detachedShellTimer = null;
      void sweepDetachedShells();
    }, DETACHED_SHELL_POLL_MS);
    detachedShellTimer.unref?.();
  };

  /**
   * Record where each command the CLI reports running runs ({@link
   * commandWork}) — its process group and the members it has now, each with
   * its start time — from the moment it is reported until it is reported
   * ended, so that a stop owed after this process is gone has an identity to
   * act on. Every CLI starts a command in a session of its own, and once the
   * CLI is gone nothing else ties the command to it: for a system binary not
   * even the run tag can be read.
   *
   * Found by STRUCTURE, among this CLI's own descendants, while that structure
   * still exists: only the groups the command's own processes run in. Never
   * the CLI's own group, which holds the CLI and what else it runs there
   * (claude's MCP servers). A group recorded earlier keeps its place while a
   * recorded member is still in it, and takes on whatever has joined it since,
   * wherever that now runs — a wrapper shell that exited leaves its command
   * parented to launchd. A reading that finds nothing of a command drops it.
   *
   * Never rejects: a reading that fails keeps the last record.
   */
  const recordCommandGroups = async (): Promise<void> => {
    if (readingGroups) {
      readGroupsAgain = true;
      return;
    }
    readingGroups = true;
    try {
      do {
        readGroupsAgain = false;
        await readCommandGroups();
      } while (readGroupsAgain && !processGone);
    } catch (err) {
      opts.logger?.warn(
        `${opts.command}: could not record where its background commands run: ${errorMessage(err)}`,
      );
    } finally {
      readingGroups = false;
    }
    armCommandGroupRefresh();
  };

  const readCommandGroups = async (): Promise<void> => {
    const rootPid = child?.pid;
    const running = commandWork();
    if (rootPid === undefined || processGone || running.length === 0) {
      return;
    }
    const rows = await (opts.listProcessGroups ?? scanPlainTable)();
    // The process may have ended during the read, and `endProcess` has
    // already handed over what was recorded by then.
    if (rows === null || processGone) {
      return;
    }
    // Decoded as `listProcesses` does: the commands matched are the agent's
    // own text, and `ps` escapes every non-ASCII byte.
    const tree = descendantsOf(rows, rootPid).map((row) => ({
      ...row,
      args: decodePsText(row.args),
    }));
    const groupOf = new Map(rows.map((row) => [row.pid, row.pgid]));
    const ownGroup = groupOf.get(rootPid) ?? rootPid;
    const records = (await opts.readCommandRecords?.()) ?? [];
    if (processGone) {
      return;
    }
    for (const workId of running) {
      // A call the CLI answered as finished (cursor) is only what still runs
      // in its tree: a group a reading caught it in while it ran is not
      // carried over, or a leftover the CLI never counted would be.
      const answered =
        executeCalls.get(workId)?.returned === true &&
        !runningShells.has(workId);
      const pgids = new Set(
        (answered ? [] : (commandGroups.get(workId) ?? []))
          .filter((group) => isGroupAnchored(group, rows))
          .map((group) => group.pgid),
      );
      const call = shellWork.get(workId) ?? delegateCommandCalls.get(workId);
      const command =
        (call === undefined ? undefined : callCommands.get(call)) ??
        executeCalls.get(workId)?.command;
      if (command !== undefined) {
        for (const pid of [
          ...commandTargets(tree, command),
          ...recordedPidsRunning(tree, records, command),
        ]) {
          const pgid = groupOf.get(pid);
          if (pgid !== undefined) {
            pgids.add(pgid);
          }
        }
      }
      pgids.delete(rootPid);
      pgids.delete(ownGroup);
      const groups = [...pgids].map((pgid) => ({
        pgid,
        members: rows.flatMap((row) =>
          row.pgid === pgid && row.startedAt !== null
            ? [{ pid: row.pid, startedAt: row.startedAt }]
            : [],
        ),
      }));
      if (groups.length > 0) {
        commandGroups.set(workId, groups);
      } else {
        // Nothing of it runs any more, wherever it ran.
        commandGroups.delete(workId);
      }
    }
    journalCommandGroups();
  };

  /**
   * Every command the CLI has reported running and not yet reported ended,
   * by unit id: its background shells, its delegates' commands, the commands
   * the agent waits on, and — for a CLI that reports no units (cursor) — its
   * execute calls, until the turn's sweep finds them gone or detached.
   */
  const commandWork = (): string[] => [
    ...new Set([
      ...runningShells,
      ...delegateCommands.keys(),
      ...[...foregroundUnits].filter((id) => shellWork.has(id)),
      ...executeCalls.keys(),
    ]),
  ];

  /** A reading for the burst this belongs to — see {@link COMMAND_GROUP_READ_DELAY_MS}. */
  const requestCommandGroups = (): void => {
    if (processGone) {
      return;
    }
    if (commandGroupRead !== null) {
      commandGroupReadOwed ||= Date.now() > commandGroupReadAskedAt;
      return;
    }
    commandGroupReadAskedAt = Date.now();
    commandGroupRead = setTimeout(() => {
      commandGroupRead = null;
      void recordCommandGroups().then(() => {
        if (commandGroupReadOwed) {
          commandGroupReadOwed = false;
          requestCommandGroups();
        }
      });
    }, opts.commandGroupReadDelayMs ?? COMMAND_GROUP_READ_DELAY_MS);
    commandGroupRead.unref?.();
  };

  /** Chained and `unref`'d like {@link armDetachedShellPoll}, and only while work is out. */
  const armCommandGroupRefresh = (): void => {
    if (
      commandGroupTimer !== null ||
      processGone ||
      commandWork().length === 0
    ) {
      return;
    }
    commandGroupTimer = setTimeout(() => {
      commandGroupTimer = null;
      void recordCommandGroups();
    }, COMMAND_GROUP_REFRESH_MS);
    commandGroupTimer.unref?.();
  };

  /**
   * Account for one unit of background work, wherever it arrived.
   *
   * The one place `openWork` moves, called from inside a turn and from
   * {@link handleOrphanEvent} alike — because which of those a `task_started`
   * lands in is the CLI's timing, not a fact about the work.
   */
  const trackBackgroundWork = (
    event: Extract<AgentEvent, { type: 'background_work' }>,
  ): void => {
    // The SHELL twin runs FIRST, and the order is load-bearing rather than
    // arbitrary: it decides "is this a delegate?" by asking `delegateWork`,
    // which the delegate twin DELETES from on the settle that carries figures.
    // Called the other way round, a delegate's settle-with-usage found an empty
    // map and was announced as a shell as well.
    //
    // `foregroundUnits` is written around the two calls, never inside them: both
    // twins read it, so it must say "waited on" through both and change only
    // once both have answered.
    // Read before either twin forgets the unit: a detached command of the main
    // thread ending is a report the agent wakes for, as a delegate's is.
    const mainShellEnded =
      event.phase === 'settled' &&
      runningShells.has(event.id) &&
      !delegateShells.has(event.id) &&
      !foregroundUnits.has(event.id);
    if (event.phase === 'started' && event.foreground === true) {
      foregroundUnits.add(event.id);
    }
    announceShellWork(event);
    announceDelegateWork(event);
    if (event.phase !== 'started') {
      foregroundUnits.delete(event.id);
    }
    if (event.phase === 'backgrounded') {
      // Not a settle: the unit is still out, and a delegate stays in
      // `openWork` exactly as it entered it at its start.
      return;
    }
    if (event.phase === 'started') {
      // Only a DELEGATE holds the turn. A backgrounded command does not: the
      // agent that launched it has said its piece and is waiting for the user,
      // and holding the turn for a `pnpm dev` that never ends reports the
      // thread as working for as long as the server runs — the reported "it
      // shows working even though you actually stopped".
      //
      // What the hold buys is that a unit's completion has a turn to arrive
      // into, and for a shell that is now bought elsewhere: its end is a
      // durable `shell_info` row (see {@link announceShellWork}) and anything
      // the CLI says once it lands is carried by the owner's own between-turn
      // path. A delegate keeps the hold because the continuation it triggers is
      // a whole further turn of the agent's own, which is the incident this
      // mechanism was built for.
      //
      // A unit the CLI did not classify counts as a shell — the same reading
      // `announceDelegateWork` already takes, so a CLI that names no kinds
      // cannot get delegate treatment through one path and not the other.
      if (event.unit === 'agent') {
        openWork.add(event.id);
      }
      return;
    }
    const closed = openWork.delete(event.id);
    if (closed || mainShellEnded) {
      wakeOnReport();
    }
    if (!closed || openWork.size > 0) {
      return;
    }
    // The last unit reported, so anything held for it is due. Only reached when
    // this settle actually closed something that was being waited on — a stray
    // `settled` for unknown work must release nothing.
    const held = current?.deferredTerminal ?? deferredOffTurnTerminal;
    if (!held) {
      return;
    }
    if (announcesSessionState) {
      // Nothing settles on the report itself — see `announcesSessionState`. The
      // continuation's output discards this hold and its result ends the turn;
      // with no continuation, the CLI's `idle` does (`onSessionState`).
      opts.logger?.debug?.(
        `${opts.command}: the held '${held.type}' has no background work left — it ends on the CLI's continuation or its idle announcement`,
      );
      return;
    }
    opts.logger?.debug?.(
      `${opts.command}: releasing the held '${held.type}' — its background work has reported`,
    );
    if (current?.deferredTerminal) {
      finishTurn(current, current.deferredTerminal);
      return;
    }
    releaseOffTurnHold();
  };

  /**
   * The CLI has withdrawn a request it raised — see `AgentEvent`'s
   * `approval_withdrawn`. Retired from every place a request can be held, so
   * nothing goes on waiting for, or re-offering, a verdict nothing can use:
   * the turn's `outstanding` map (which is what suspends its silence
   * deadline), the between-turn hold, and the owner's off-turn cards.
   *
   * Forwarded ONLY when a card for it could be on screen — in the turn, or
   * owned off-turn — since retiring that card is the owner's business and a
   * held request has none yet. An id nothing here holds (already answered, or
   * a control request that was never an approval) changes nothing and is not
   * forwarded: the owner would otherwise be asked to retire a card it closed.
   */
  const withdrawApproval = (
    event: Extract<AgentEvent, { type: 'approval_withdrawn' }>,
  ): void => {
    const turn = current;
    const wasOutstanding = turn?.outstanding.delete(event.id) === true;
    const wasOwned = ownedApprovals.delete(event.id);
    const wasHeld = dropHeldApproval(event.id);
    approvalSeenAt.delete(event.id);
    if (!wasOutstanding && !wasOwned && !wasHeld) {
      opts.logger?.debug?.(
        `${opts.command}: request ${event.id} was withdrawn — nothing here was holding it open`,
      );
      return;
    }
    opts.logger?.warn(
      `${opts.command}: request ${event.id} was withdrawn by the CLI — retired rather than left waiting for a verdict`,
    );
    if (turn && wasOutstanding) {
      // The turn is no longer blocked on it, so the clock that measures an
      // UNEXPLAINED silence runs again — and from here, not from the request.
      armSilenceDeadline(turn);
    }
    if (!wasOutstanding && !wasOwned) {
      return;
    }
    if (turn) {
      turn.options.onEvent(event);
      return;
    }
    opts.onBetweenTurnEvent?.(event);
  };

  /**
   * Deliver an event to the turn it belongs to; see {@link handleOrphanEvent}
   * for what happens when there is no turn to deliver it to.
   */
  const emit = (event: AgentEvent): void => {
    if (event.type === 'approval_request') {
      approvalSeenAt.set(event.id, Date.now());
    }
    // Recorded HERE, at the one door every event passes through, and BEFORE the
    // turn/orphan split: a command run by a CLI carrying on between turns is as
    // detachable as one run inside a turn, and the sweep's whole subject is
    // work that outlives the turn that started it.
    rememberExecuteCall(event);
    rememberCommandLine(event);
    if (event.type === 'tool_call' && event.parentToolUseId !== undefined) {
      // Either order: nothing ties claude's `task_started` for a command to
      // the delegate line that made the call.
      const command = unownedDelegateCommands.get(event.id);
      if (command === undefined) {
        // Only a delegate this layer tracks: a CLI that never brackets its
        // delegates would have nothing ever prune the entry.
        if ([...delegateWork.values()].includes(event.parentToolUseId)) {
          delegateCallOwner.set(event.id, event.parentToolUseId);
        }
      } else {
        unownedDelegateCommands.delete(event.id);
        delegateCommands.set(command, event.parentToolUseId);
      }
    }
    if (event.type === 'session_state') {
      // Turn plumbing wherever it arrives, never forwarded: it maps to no row,
      // and what it says is this layer's business — whether a hold is over.
      onSessionState(event.idle);
      return;
    }
    if (
      event.parentToolUseId === undefined &&
      (event.type === 'turn_complete' ||
        event.type === 'error' ||
        event.type === 'turn_cancelled')
    ) {
      lastResultAt = Date.now();
    }
    if (event.type === 'approval_withdrawn') {
      // Turn plumbing wherever it arrives: a request can be withdrawn inside a
      // turn, between turns, or while it sits held for the next one.
      withdrawApproval(event);
      return;
    }
    const turn = current;
    if (!turn) {
      handleOrphanEvent(event);
      return;
    }
    if (event.type === 'approval_request') {
      // Recorded HERE, at the one door every request bound for a turn passes
      // through — adopted from the hold buffer or raised mid-turn alike. Doing
      // it at the adoption site instead covered only the rarer of the two, and
      // left an in-turn request that its turn never answered stranding the CLI
      // for good (see {@link TurnState.outstanding}).
      turn.outstanding.set(event.id, event);
    }
    // Turn plumbing: it says whether the turn's work is over, which is this
    // function's business and no consumer's. The ONE thing that IS forwarded is
    // a delegate's liveness — see `announceDelegateWork` — because the
    // transcript's own end-of-delegate signal (the launching call returning)
    // fires instantly for one nobody is waiting on.
    if (event.type === 'background_work') {
      trackBackgroundWork(event);
      armSilenceDeadline(turn);
      return;
    }
    // Turn plumbing as well: the CLI has taken a message. The turn's own prompt
    // is recorded as taken (see `TurnState.promptTaken`) — checked first, since
    // it is written before any follow-up and so echoed before one; a follow-up
    // this turn wrote is crossed off.
    if (event.type === 'user_message_consumed') {
      if (
        !turn.promptTaken &&
        turn.options.followUpConsumptionReported === true &&
        turn.options.promptText !== undefined &&
        event.text === turn.options.promptText
      ) {
        turn.promptTaken = true;
        return;
      }
      const index = turn.unconsumedFollowUps.findIndex(
        (followUp) => followUp.text === event.text,
      );
      if (index !== -1) {
        turn.unconsumedFollowUps.splice(index, 1);
        armSilenceDeadline(turn);
      }
      return;
    }
    const normalized: AgentEvent =
      turn.cancelRequested && event.type === 'error'
        ? // What the stopped turn spent rides along: the CLI's ledger has
          // already moved past it, so dropping it here would lose it for good.
          {
            type: 'turn_cancelled',
            ...(event.usage ? { usage: event.usage } : {}),
          }
        : event;
    if (
      normalized.type === 'turn_complete' ||
      normalized.type === 'turn_cancelled' ||
      normalized.type === 'error'
    ) {
      if (turn.terminalEmitted) {
        return;
      }
      // A continuation the CLI ran BY ITSELF has ended — not this turn. Probed
      // on claude 2.1.266: a prompt written while the CLI was mid-continuation
      // is answered only after the continuation's own result, so settling here
      // handed this turn the continuation's text and ended it before its real
      // answer arrived. The result goes the between-turn way instead (its row
      // and usage are real), and this turn waits for its own.
      //
      // Only while that answer is still OWED — see `TurnState.promptAnswered`.
      // Once the turn has had its own result, a continuation's result is the
      // only ending left to it. And never once the CLI has echoed this turn's
      // prompt as TAKEN: the continuation absorbed it, so this result is the
      // turn's answer — see `TurnState.promptTaken`.
      if (
        normalized.type === 'turn_complete' &&
        normalized.continuation === true &&
        !turn.promptAnswered &&
        !turn.promptTaken
      ) {
        opts.logger?.debug?.(
          `${opts.command}: a continuation's result arrived inside a turn — not this turn's ending`,
        );
        // …unless the CLI turns out to have answered the prompt INSIDE it — see
        // `TurnState.continuationAnswer`.
        turn.continuationAnswer = normalized;
        armSilenceDeadline(turn);
        // Stamped, so the ROW says it ended nothing — see `insideTurn`.
        handleOrphanEvent({ ...normalized, insideTurn: true });
        return;
      }
      // The same rule for a continuation that FAILED. Its row is real and goes
      // the between-turn way, stamped as having ended nothing; this turn goes
      // on waiting for its own answer. Ending the user's turn on it failed a
      // turn whose prompt the CLI had not even reached yet.
      //
      // Unlike a completed continuation it is never kept as the turn's answer
      // (`continuationAnswer`): a failure answers nothing. And a Stop is not
      // routed around — `normalized` is already `turn_cancelled` then, since
      // the user asking to stop is exactly what should end this turn. A
      // continuation that had absorbed this turn's prompt is not routed around
      // either: its failure is this turn's (`TurnState.promptTaken`).
      if (
        normalized.type === 'error' &&
        normalized.continuation === true &&
        !turn.promptAnswered &&
        !turn.promptTaken
      ) {
        opts.logger?.debug?.(
          `${opts.command}: a continuation's FAILURE arrived inside a turn — not this turn's ending`,
        );
        armSilenceDeadline(turn);
        handleOrphanEvent({ ...normalized, insideTurn: true });
        return;
      }
      // A completion for a prompt that has not been sent is not this turn's.
      // See {@link TurnState.promptHeld} for the traced run this comes from:
      // dropping it here is what keeps the gate's own release — which writes
      // the prompt moments later — from finding a turn already settled and
      // throwing the user's message away.
      //
      // `turn_complete` ONLY. A `turn_cancelled` is the user asking to stop
      // before their message went out, which must still stop the turn, and an
      // `error` before the prompt is a CLI that cannot run it — swallowing
      // either would hang the composer on a turn nothing will ever end.
      if (normalized.type === 'turn_complete' && turn.promptHeld) {
        opts.logger?.warn(
          `${opts.command}: ignoring a turn_complete that arrived before this turn's prompt was sent — the prompt is still held`,
        );
        armSilenceDeadline(turn);
        return;
      }
      let terminal: AgentEvent = normalized;
      if (normalized.type === 'turn_complete') {
        // A result held for a follow-up is the same turn's earlier segment —
        // folded in, so the turn settles once, on the answer to the LAST
        // message, with everything it cost.
        const folded = turn.supersededTerminal
          ? foldTurnComplete(turn.supersededTerminal, normalized)
          : normalized;
        turn.supersededTerminal = null;
        terminal = folded;
        // A message written into this turn has not been taken yet, so this
        // result answers what came BEFORE it — the CLI is about to open a
        // further stretch for it. See {@link TurnState.unconsumedFollowUps}.
        // The prompt is therefore still OWED, and `promptAnswered` stays as
        // the delivery left it.
        //
        // A session lifetime only: a process that ends with its turn has no
        // further stretch to wait for.
        if (settlesOnTerminalEvent && turn.unconsumedFollowUps.length > 0) {
          turn.supersededTerminal = folded;
          opts.logger?.debug?.(
            `${opts.command}: holding the turn open — ${turn.unconsumedFollowUps.length} follow-up(s) written into it have not been taken yet`,
          );
          publishLiveCost(turn);
          armSilenceDeadline(turn);
          return;
        }
        turn.promptAnswered = true;
      }
      // The CLI has stopped TALKING while work it started is still running, and
      // on a session lifetime the process is still there doing it. Hold the
      // terminal event: emitting it now ends the turn mid-work, and everything
      // the process produces next — including whole turns claude runs of its own
      // accord as each unit reports — arrives with no turn to own it.
      //
      // Only a `turn_complete`, and only on a session lifetime. A cancel is the
      // user asking to stop NOW, an `error` is a turn that has failed rather
      // than finished, and a turn whose process ends with it has no "after" to
      // wait for — deferring in any of those three cases would hold a turn open
      // for work that is already over.
      if (
        terminal.type === 'turn_complete' &&
        settlesOnTerminalEvent &&
        openWork.size > 0
      ) {
        if (turn.deferredTerminal === null) {
          turn.deferredTerminal = terminal;
          opts.logger?.debug?.(
            `${opts.command}: holding the turn open — ${openWork.size} unit(s) of background work have not reported`,
          );
          // Said OUT LOUD, because from here the run is a different thing than
          // it was a moment ago and nothing else can tell: the agent has
          // stopped, and the turn is alive only for its listeners. See
          // `AgentEvent`'s `turn_held` for the two readings that were wrong
          // without it.
          announceTurnHold(turn, openWork.size);
          publishLiveCost(turn);
        }
        armSilenceDeadline(turn);
        return;
      }
      finishTurn(turn, terminal);
      return;
    }
    // The CLI's running figure restarts at each `result`, so on its own it
    // forgets every segment this turn is still holding — see `heldCostOf`.
    if (normalized.type === 'cost_progress') {
      turn.liveCostUsd = normalized.costUsd > 0 ? normalized.costUsd : 0;
      turn.liveEstimatedCostUsd = positiveOrZero(normalized.estimatedCostUsd);
      armSilenceDeadline(turn);
      publishLiveCost(turn);
      return;
    }
    // The MAIN thread has spoken again while its own terminal was held: the
    // agent is working, so the hold is over — whatever background work is still
    // outstanding.
    //
    // A hold says two things at once, and only one of them survives this. The
    // turn stays open (that is what `openWork` is for), but the agent is no
    // longer IDLE — which is the half every consumer acts on: the composer
    // sends a message straight to an idle CLI instead of queueing it, and the
    // badge reads the run as idle rather than running. Nothing took either back
    // down, so both stayed wrong for the rest of the turn. Reported as "it sent
    // message not in queue … its always, not just during compaction": a
    // background task with no end (a dev server) held the turn, the user's next
    // three messages each went straight into a CLI that was demonstrably
    // working, and the last of them landed mid-compaction.
    //
    // MAIN THREAD ONLY. A delegate's rows arrive on this same stream and are
    // usually the very work the hold is waiting for — clearing on those would
    // undo the mechanism entirely.
    //
    // The deferred terminal no longer ENDS the turn, and that is the point of
    // doing this here: it describes a turn that has since continued, so
    // releasing it when the last unit reports would settle the turn in the
    // middle of the agent's next answer, filing everything after it under no
    // turn at all. The turn now ends on its NEXT terminal — which is held again
    // if work is still out, since `openWork` is untouched — with this one's
    // bill folded into it ({@link supersedeHeldTerminal}), and the silence
    // deadline still bounds a CLI that speaks once and then wedges.
    if (
      turn.deferredTerminal !== null &&
      event.parentToolUseId === undefined &&
      RESUMES_A_HELD_TURN.has(event.type)
    ) {
      opts.logger?.debug?.(
        `${opts.command}: releasing the hold — the main thread is talking again with ${openWork.size} unit(s) still out`,
      );
      supersedeHeldTerminal(turn);
      announceTurnHold(turn, 0);
    }
    if (
      event.parentToolUseId === undefined &&
      RESUMES_A_HELD_TURN.has(event.type)
    ) {
      endCommandWait(turn);
    }
    // The CLI is still talking, so it has not wedged — push the deadline out.
    armSilenceDeadline(turn);
    turn.options.onEvent(normalized);
  };

  /**
   * What the driver still holds that only it can report, for a turn whose
   * process ended or broke under it — emitted ahead of the terminal this
   * module writes (`CliTurnOptions.onProcessEnded`). Then the follow-ups this
   * module wrote into the CLI's stdin that it never took: they died with it
   * (see {@link TurnState.unconsumedFollowUps}).
   */
  const emitProcessEnded = (turn: TurnState): void => {
    for (const event of turn.options.onProcessEnded?.() ?? []) {
      emit(event);
    }
    if (!turn.cancelRequested) {
      cutOffCommands();
    }
    emitUntakenFollowUps(turn);
  };

  /**
   * Answer every command call the CLI never answered, ahead of the turn's
   * ending: its process died under the turn, so no answer is coming, and a
   * call without one would read as still running.
   */
  const cutOffCommands = (): void => {
    for (const [id, call] of [...openCommandCalls]) {
      emit({
        type: 'tool_result',
        id,
        name: call.name,
        result: CUT_OFF_COMMAND_RESULT,
        isError: true,
        ...(call.parentToolUseId === undefined
          ? {}
          : { parentToolUseId: call.parentToolUseId }),
      });
    }
  };

  /** Report the follow-ups `turn` wrote that the CLI never took, once. */
  function emitUntakenFollowUps(turn: TurnState): void {
    const dropped = turn.unconsumedFollowUps.flatMap((followUp) =>
      followUp.deliveryId === null ? [] : [followUp.deliveryId],
    );
    turn.unconsumedFollowUps = [];
    if (dropped.length > 0) {
      turn.options.onEvent({ type: 'follow_up_dropped', deliveryIds: dropped });
    }
  }

  let child: SpawnedProcess;
  try {
    child = spawnFn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: buildChildEnv(opts.env),
    });
  } catch (err) {
    // The session never existed, so none of the state above ever applies to it
    // — the whole closure is abandoned for a stand-in. The failure still
    // reaches the caller the way every other terminal condition does: as an
    // `error` event on the first turn's own handle, never as a throw.
    return deadSession(`failed to spawn ${opts.command}: ${errorMessage(err)}`);
  }

  // The whole group, not the direct child: a single-PID SIGTERM would orphan
  // the tool/MCP grandchildren the agent forked.
  //
  // `processGone` — not `processExited` — is the right predicate, and the
  // difference matters. `processExited` means the CLI itself is gone; the
  // GROUP may still be full of grandchildren holding the inherited stdio open,
  // and those are exactly what the escalation is for. `processGone` means the
  // session has been accounted for (`close`, or the exit backstop), by which
  // point there is nothing left to escalate against.
  const terminator = createGroupTerminator(child, {
    // …except after an ABANDON (see {@link reapAfterEnd}), where the session is
    // accounted for while the child may still be running — the escalation is
    // then exactly what is needed, until the child is seen to exit.
    isGone: () => processGone && !reapAfterEnd,
  });

  /**
   * The out-of-band questions waiting on a reply — see {@link CliSession.ask}.
   *
   * A set and not one slot: two readouts opened at once is an ordinary thing
   * for a user to do, and the second must not silently steal the first's
   * answer. Each entry removes itself, whichever way it ends.
   */
  const pendingAsks = new Set<(obj: unknown) => void>();

  const buffer = new NdjsonBuffer({
    onObject: (obj) => {
      // Offered to the askers FIRST and to every one of them, then handed to
      // the mapper unchanged. Neither side consumes the object: a control
      // reply maps to no event, and an ask's reader recognises only its own
      // request id — so this stays additive to the turn's event stream rather
      // than a fork in it.
      //
      // The copy is what makes it safe to remove an entry from inside `offer`,
      // which each one does whichever way it ends. Skipped while the set is
      // empty, which is every moment no readout is open.
      if (pendingAsks.size > 0) {
        for (const offer of [...pendingAsks]) {
          offer(obj);
        }
      }
      for (const event of opts.mapper(obj)) {
        emit(event);
      }
    },
    onParseError: (line) =>
      opts.logger?.warn(
        `${opts.command}: skipped unparseable stream line: ${line.slice(0, 200)}`,
      ),
    onOversizedLine: (prefix, length) => {
      opts.logger?.warn(
        `${opts.command}: skipped a stream line of ${length} characters, over the ${MAX_BUFFERED_LINE_CHARS} read as one line: ${prefix.slice(0, 200)}`,
      );
      for (const event of opts.onDroppedLine?.(prefix, length) ?? []) {
        emit(event);
      }
    },
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string | Buffer) => {
    // Any stdout at all proves the CLI has not wedged, whether or not the
    // mapper makes an event of it — a line this daemon does not recognise is
    // still the process talking, and settling a turn over one would be a
    // vocabulary gap presented to the user as a hang.
    if (current) {
      armSilenceDeadline(current);
    }
    buffer.push(toUtf8(chunk));
  });

  let stderrTail = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderrTail = (stderrTail + toUtf8(chunk)).slice(-STDERR_TAIL_BYTES);
  });

  /** The process is gone: settle whatever was running and close the session. */
  const endProcess = (): void => {
    if (!processGone) {
      processGone = true;
      stdinEnded = true;
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
      }
      if (turnExitTimer) {
        clearTimeout(turnExitTimer);
        turnExitTimer = null;
      }
      // Not for an abandon: the child may outlive this, and its SIGKILL is
      // still owed — see {@link reapAfterEnd}.
      if (!reapAfterEnd) {
        terminator.disarm();
      }
      resolveClosed();
    }
    // Every background command this process was still running ends with it:
    // the CLI stops them on its own shutdown, and what a CLI that died without
    // one left is stopped from `endedRunning.groups` by the session's owner.
    // Nothing else will ever say so: a shell's end is reported by the CLI, and
    // the CLI is what just ended. Announced here so the rows close, since the
    // client lists a detached command on the strength of that report rather
    // than on the run's status — without it a `pnpm dev` from a reaped session
    // is listed as running for the rest of that transcript's life.
    //
    // Before `releaseOffTurnHold`, so these rows precede the terminal event
    // they were outstanding at.
    // The poll goes with them: its whole subject is commands running under
    // this process, and there is no process.
    if (detachedShellTimer !== null) {
      clearTimeout(detachedShellTimer);
      detachedShellTimer = null;
    }
    if (commandGroupTimer !== null) {
      clearTimeout(commandGroupTimer);
      commandGroupTimer = null;
    }
    if (commandGroupRead !== null) {
      clearTimeout(commandGroupRead);
      commandGroupRead = null;
    }
    endedRunning ??= {
      running: runningShells.size + detachedDelegateCommands().length,
      commands: currentCommands(),
      groups: [...commandGroups.values()].flat(),
      pid: child?.pid,
    };
    commandGroups.clear();
    osDetachedShells.clear();
    executeCalls.clear();
    // A delegate's own commands end with the process as well, so a settle held
    // for them is owed now as stopped, figures kept: its CLI reported it done
    // while those commands ran, and the process ending is what stopped them.
    delegateCommands.clear();
    delegateCommandCalls.clear();
    unownedDelegateCommands.clear();
    delegateCallOwner.clear();
    for (const held of [...heldDelegateSettles.values()]) {
      announceDelegateWork({ ...held, outcome: 'stopped' });
    }
    // `runningShells` as well as `shellWork`: a unit the CLI announced with no
    // launching call is in the first alone, and closing only the second left
    // its `shell_open` without an end — a `Terminals 1` nothing could retire.
    for (const id of new Set([...shellWork.keys(), ...runningShells])) {
      announceShellWork({
        type: 'background_work',
        id,
        phase: 'settled',
        // The CLI said neither, and neither is needed: the launching call was
        // recorded on the `started`, and the kind is what put the id in this
        // map in the first place.
        unit: 'other',
        toolCallId: null,
      });
    }
    // Nothing can report now, so nothing is being waited for: whatever was held
    // for background work is handed over rather than dying with the process,
    // which would leave the run reading `running` with no process behind it.
    // A command whose launching call was never known is not in `shellWork`,
    // so the loop above did not settle it — but it ended with the process too.
    runningShells.clear();
    callCommands.clear();
    openCommandCalls.clear();
    // The user's Stop is what ended them; any other end of the process says
    // only that their work is over.
    if (closeCause === 'user-stop') {
      closeOpenDelegates('stopped');
    } else {
      closeOpenDelegates('untracked', 'process-ended');
    }
    openWork.clear();
    releaseOffTurnHold(current !== null);
    const continued = offTurnContinued;
    offTurnContinued = null;
    if (continued) {
      opts.onBetweenTurnEvent?.(
        current ? { ...continued, insideTurn: true } : continued,
      );
    }
    if (current) {
      settleTurn(current, 'the process ended');
    }
  };

  child.on('error', (err: Error) => {
    if (processGone) {
      return;
    }
    if (current && !current.settled) {
      emitProcessEnded(current);
      emit({
        type: 'error',
        message: `${opts.command} process error: ${err.message}`,
      });
    }
    endProcess();
  });

  // `close` fires after stdio is fully drained AND the process has exited, so
  // every stdout line is parsed before the terminal event — `exit` can race the
  // last chunk. Guard on `processGone`: a child can surface a process-level
  // `error` and THEN fire `close` with a non-zero code; without this guard both
  // handlers emit a terminal event and the transcript records two
  // contradictory ones.
  const settleFromTermination = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    buffer.flush();
    if (current && !current.terminalEmitted) {
      emitProcessEnded(current);
      if (signal && current.cancelRequested) {
        emit({ type: 'turn_cancelled' });
      } else if (signal) {
        // A signal geniro never asked for. The distinction is the whole point:
        // `cancelRequested` is set by BOTH deliberate terminations (`cancel()`,
        // which Stop and the shutdown reap both reach, and `close()`), so
        // anything left here killed the agent from outside — an OOM kill, a
        // crash, a `pkill`, a supervisor taking the process down.
        //
        // Reading every signal as a cancellation reported that as `cancelled`,
        // and the damage is not the word: `cancelled` is deliberately the ONE
        // ending the app does not notify about, because announcing a Stop tells
        // the user what they just did. So a killed agent settled quietly under
        // a badge saying the user had stopped it — measured here by SIGKILLing
        // a live `cursor-agent acp` mid-turn, which left the run `cancelled`
        // and posted no banner. Nobody had pressed anything.
        const detail = stderrTail.trim();
        emit({
          type: 'error',
          message: `${opts.command} was terminated by ${signal}${detail ? `: ${detail}` : ''}`,
          // The same facts as the sentence, in fields — the sentence is what
          // the user reads, these are what a report can be built from without
          // parsing English back apart.
          detail: { signal },
        });
      } else if (code !== null && code !== 0) {
        const detail = stderrTail.trim();
        emit({
          type: 'error',
          message: `${opts.command} exited with code ${code}${detail ? `: ${detail}` : ''}`,
          detail: { exitCode: code },
        });
      } else if (current.deferredTerminal ?? current.supersededTerminal) {
        // A CLEAN exit while a terminal event was held for background work: the
        // process is gone, so the work is over one way or another, and the turn
        // DID complete — release what it produced. Falling through to the branch
        // below would replace a real `turn_complete` (with the turn's usage) with
        // "exited without completing the turn", which is exactly backwards.
        // The same holds for one held for a follow-up the CLI never got to.
        finishTurn(
          current,
          (current.deferredTerminal ?? current.supersededTerminal)!,
        );
      } else {
        // A CLEAN exit with no terminal event: the process ended without ever
        // printing the result line the mapper turns into `turn_complete`.
        // Saying nothing here is not neutral — `ChatService` fills the silence
        // with a synthetic `turn_complete` and records a success the agent
        // never produced, which reads to the user as an answered turn with no
        // answer in it.
        const detail = stderrTail.trim();
        emit({
          type: 'error',
          message: `${opts.command} exited without completing the turn${detail ? `: ${detail}` : ''}`,
        });
      }
    }
    endProcess();
  };

  child.on('close', (code, signal) => {
    if (processGone) {
      return;
    }
    settleFromTermination(code, signal);
  });

  // The BACKSTOP for a `close` that never arrives.
  //
  // `close` fires only once the process has exited AND every piped stdio fd has
  // lost its last writer. A coding agent forks tool/MCP grandchildren that
  // inherit those fds, and any one of them outliving the CLI holds `close` open
  // indefinitely — the process is gone, its turn is over, and nothing says so.
  // Everything hangs off this one settle: the run row stays `running`, the
  // transcript never gets a terminal item, the registry slot is never released
  // (so every later send answers RUN_BUSY), and the composer spins forever.
  //
  // The codebase already learned this on the utility path and did not carry it
  // here — see `agent-adapter.ts`'s `child.on('exit', () => reapGroup())` and
  // its note that `close` "waits for the stdio pipes, which a lingering
  // health-check grandchild holds open".
  //
  // `close` stays the PREFERRED path: this only arms a timer, so the ordinary
  // turn still settles on `close` with stdout fully drained, and the timer is
  // cleared once the process is accounted for. Deliberately signals NOTHING —
  // reaping the group here would SIGKILL the user's own MCP servers, and
  // through them a browser session they are driving. The detached commands are
  // not in that group anyway; what the CLI left of them is stopped from
  // `endedRunning.groups`.
  child.on('exit', (code, signal) => {
    // Before the early return, and before the timer: the process is gone as of
    // now whatever the settle does about it, and every reader below asks this
    // rather than waiting out the grace window.
    processExited = true;
    // An abandoned child has now gone, so its pending escalation has nothing
    // left to force — `isGone` reads true again from here.
    reapAfterEnd = false;
    // The one exit that DOES signal the group: geniro asked this idle process
    // to finish, so what it left behind is not the user's to keep. A fresh
    // terminator, so the escalation outlives the settle below — safe by the
    // POSIX rule `runAsProcessGroup`'s reap relies on: a group id is not
    // reissued while the group has members, and an empty one finds nothing.
    if (reapGroupOnExit) {
      reapGroupOnExit = false;
      createGroupTerminator(child).terminate();
    }
    if (processGone || exitTimer) {
      return;
    }
    exitTimer = setTimeout(() => {
      exitTimer = null;
      if (processGone) {
        return;
      }
      settleFromTermination(code, signal);
    }, EXIT_SETTLE_GRACE_MS);
    exitTimer.unref?.();
  });

  /**
   * The one write path to the child's stdin, shared by every turn and by a
   * client-initiated protocol driver. Re-reads `child.stdin` per call so a
   * stream torn down mid-turn is caught here rather than by a stale reference,
   * and never throws — a closed pipe is a dropped write, and the process's own
   * termination handlers own the terminal event.
   *
   * Guarded on the PROCESS, not on a turn: opening the next turn on an idle
   * session is a legitimate write with no turn in flight. The three
   * turn-scoped writers below add their own guard on top.
   */
  /**
   * Why {@link sessionWrite} would refuse right now — null while it would land.
   *
   * The four obstacles are FOUR DIAGNOSES, not one, and the boolean `write`
   * answers collapses them. Naming them here is what keeps a caller from
   * inventing a cause: see `TurnIo.writeObstacle`, which exists because the ACP
   * driver printed `stdin is closed` for every one of them and sent an
   * investigation after the wrong process.
   *
   * Ordered as the guards below are, so the sentence names the FIRST thing that
   * stops the write rather than the most recently observed — `endProcess` sets
   * `stdinEnded` alongside `processGone`, so reading them the other way round
   * would report every terminated group as geniro closing the pipe.
   */
  const writeObstacle = (): string | null => {
    if (processGone) {
      return 'its process group has been terminated';
    }
    if (processExited) {
      return 'the CLI has exited';
    }
    if (stdinEnded) {
      return "geniro closed the CLI's stdin at the end of the turn";
    }
    const stream = child.stdin;
    if (!stream || !stream.writable) {
      // The remaining case, and the one worth spelling out: the pipe is intact
      // on our side and the CLI stopped reading it. Measured on cursor-agent,
      // which does this ~2s before its own turn-end frame while still running.
      return 'the CLI closed its end of stdin while still running';
    }
    return null;
  };

  const processAlive = (): boolean => !processGone && !processExited;

  const sessionWrite = (payload: string): boolean => {
    if (processGone || processExited || stdinEnded) {
      return false;
    }
    const stream = child.stdin;
    // `writable` is the question, and the try/catch below cannot stand in for
    // it: writing past an ended or destroyed pipe does NOT throw — node
    // reports it asynchronously and the call returns — so the catch never
    // fires and a write that never landed was answered `true`. The caller
    // ACTS on this answer: `sendUserMessage` returning true has the chat
    // commit a user message the CLI never received.
    //
    // The write's own return value is deliberately not consulted: a false
    // there is backpressure, meaning buffered-not-yet-flushed, which is a
    // delivered write and not a failed one.
    if (!stream || !stream.writable) {
      return false;
    }
    try {
      stream.write(payload);
      return true;
    } catch {
      return false;
    }
  };

  function endStdin(): void {
    if (stdinEnded) {
      return;
    }
    stdinEnded = true;
    try {
      child.stdin?.end();
    } catch {
      // Already closed with the child's exit — nothing to end.
    }
  }

  const stdin = child.stdin;
  if (stdin) {
    // A stdin that errors asynchronously (EPIPE — the CLI exited before we
    // finished writing) would otherwise throw an unhandled stream error and
    // crash the daemon; surface it as a normal terminal error instead.
    stdin.on('error', (err: Error) => {
      if (processGone) {
        return;
      }
      // An errored stdin can never be written again, so the session must stop
      // reporting itself usable — `idle` and `startTurn` both read this flag.
      //
      // This is the case a SESSION lifetime introduced and the guard below was
      // never widened for: the process outlives the turn, so its pipe can break
      // BETWEEN turns, with no `current` to carry the event. Every exit here
      // was then a bare `return` — nothing recorded, nothing marked — so the
      // registry went on handing out a session whose pipe was broken, later
      // writes were answered `true` into a pipe nobody was reading, and the
      // run went quiet with no trace anywhere. For a `turn` or `payload`
      // lifetime this changes nothing: `endStdin` has already set the flag by
      // the time either could reach this line.
      stdinEnded = true;
      const failure: AgentEvent = {
        type: 'error',
        message: `${opts.command} stdin error: ${err.message}`,
      };
      if (!current) {
        // No turn at all — the between-turns break a SESSION lifetime makes
        // possible. Logged DIRECTLY rather than emitted: with no turn to carry
        // it, `emit` routes to `handleOrphanEvent`, which records the event
        // TYPE and discards the message, so the reason would still be nowhere.
        opts.logger?.warn(failure.message);
        // …and retire the session. Marking it unusable is only half: `closed`
        // is the ONE channel its owner forgets it through, and an entry that is
        // `alive` but not `idle` is skipped by both the idle timer and the
        // eviction sweep while still counting against the session ceiling — so
        // it would hold a slot for the daemon's lifetime and get a HEALTHY
        // session evicted in its place. The group is signalled too: a process
        // whose stdin we have given up on is one nobody can talk to again.
        abandon();
        return;
      }
      // After the terminal event the turn is already decided — a late EPIPE
      // (e.g. closing a kept-open stdin as the child exits) must not settle
      // early, or `close` would skip the final buffer flush and `done` would
      // resolve before stdout drains. The process is on its way out on its
      // own here, so this one only records.
      if (current.terminalEmitted) {
        opts.logger?.warn(failure.message);
        return;
      }
      emitProcessEnded(current);
      emit(failure);
      // The same abandon as the between-turns case, for the same reason.
      // Ending the session with no signal at all — `endProcess` marks it gone
      // and resolves `closed`, so its owner forgets it — would leave a CLI
      // that has merely stopped reading its stdin (cursor-agent does so ~2s
      // before its own turn-end frame) running, untracked, with every MCP
      // server it had dialled.
      abandon();
    });
  }

  /**
   * The group has been told to go — set before the signal, so a terminal the
   * CLI still prints on its way out (claude answers an interrupt in ~25 ms,
   * inside the SIGTERM's window) knows the follow-ups it never took die with it
   * ({@link emitUntakenFollowUps}).
   */
  let groupKilled = false;
  const killGroup = (): void => {
    groupKilled = true;
    terminator.terminate();
  };

  /**
   * End a session whose child may still be running: signal the group with an
   * escalation that survives the end (see {@link reapAfterEnd}), then account
   * for the session at once, so nothing tries to use it again.
   */
  function abandon(): void {
    reapAfterEnd = true;
    killGroup();
    endProcess();
  }

  const startTurn = (turnOptions: CliTurnOptions): AgentTurnHandle | null => {
    if (
      processGone ||
      processExited ||
      stdinEnded ||
      current !== null ||
      cancelledTurnMayStillEmit
    ) {
      return null;
    }
    // Asked to work again: whatever closes it next is not the Stop's.
    closeCause = null;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const turn: TurnState = {
      startedAt: Date.now(),
      settled: false,
      terminalEmitted: false,
      cancelRequested: false,
      stoppedBeforePrompt: false,
      resolveDone: () => resolveDone(),
      done,
      options: turnOptions,
      interruptTimer: null,
      silenceTimer: null,
      outstanding: new Map(),
      deferredTerminal: null,
      promptHeld: turnOptions.holdPrompt !== undefined,
      promptAnswered: false,
      continuationAnswer: null,
      promptTaken: false,
      unconsumedFollowUps: [],
      supersededTerminal: null,
      continuedSegment: null,
      holdAnnounced: false,
      quietTimer: null,
      spokenCount: 0,
      commandWaitFor: 0,
      commandWaitWindows: 0,
      ownCommands: new Set(),
      liveCostUsd: 0,
      liveEstimatedCostUsd: 0,
      costPublished: false,
    };
    announceOffTurnHold(0);
    offTurnStretchOpen = false;
    current = turn;
    // A continuation's result held for background work is handed over BEFORE
    // this turn produces anything of its own — it belongs to what happened
    // before, and holding it further would file it under this turn's rows. The
    // owner will not settle the run on it (a real turn is running now, which is
    // exactly the case `offTurnRuns` distinguishes), so what it costs is
    // nothing and what it saves is the row, with its usage and its cost. It
    // ends the stretch, not this turn, so it is stamped as ending nothing.
    releaseOffTurnHold(true);
    // A stretch the agent was still working when this turn opened: what it
    // continued past is this turn's earlier work now, whichever result ends it.
    if (offTurnContinued !== null) {
      turn.continuedSegment = offTurnContinued;
      offTurnContinued = null;
    }
    // Kept at session scope so a request arriving AFTER this turn settles can
    // still be refused rather than dropped — see `handleOrphanEvent`.
    approvalEncoder = turnOptions.buildApprovalResponse;
    // Anything that happened while no turn was open is told to THIS one, before
    // its own output — it is the context for what this turn is about to do (or
    // fail to do). Drained, not copied: each is said once.
    // A request held while no turn was open is adopted FIRST, ahead of the
    // notice explaining it — the notice says "it is shown above", and a card
    // that arrived after its own explanation would make a liar of it. The CLI
    // has been blocked on each of these since it asked, so this is also the
    // earliest moment either could reach a user.
    while (pendingApprovals.length > 0) {
      const adopted = pendingApprovals.shift()!;
      // Recorded the same way `emit` records an in-turn request — this loop
      // hands the event straight to the turn rather than going through it, so
      // the bookkeeping has to be repeated rather than inherited.
      approvalSeenAt.set(adopted.id, Date.now());
      turn.outstanding.set(adopted.id, adopted);
      turnOptions.onEvent(adopted);
    }
    // A request the OWNER put on screen between turns and nobody has answered
    // yet is adopted too — SILENTLY, since its card is already up and a second
    // one would ask the same question twice. The CLI is blocked on it, so this
    // turn is as well: its silence deadline must stay suspended on it, and a
    // settle that leaves it unanswered must re-hold it for the turn after,
    // exactly as for a request raised inside this turn.
    //
    // Left in the owned map it was stranded: this turn's owner sweeps every
    // card still pending when the turn ends — writing `unanswerable` over the
    // between-turn one too — without ever calling its `respond`, so nothing
    // cleared the entry. `parked` then read true for the life of the process
    // (the idle reaper re-armed over it forever and eviction skipped it) while
    // the CLI stayed blocked beneath every later turn, each dying at the
    // silence deadline. The card's own `respond` still works after the move:
    // it writes on the session's stdin and drops the request from this turn.
    for (const [id, owned] of ownedApprovals) {
      turn.outstanding.set(id, owned);
    }
    ownedApprovals.clear();
    while (pendingNotices.length > 0) {
      // `info`, because every notice this queue carries is the between-turn
      // hand-over above: the machinery worked, and the row exists only so the
      // odd timing is not silent. The daemon's failure chrome is for degrades.
      turnOptions.onEvent({
        type: 'notice',
        message: pendingNotices.shift()!,
        severity: 'info',
      });
    }
    opts.logger?.debug?.(`${opts.command}: turn opened`);
    // Armed from the start, not from the first event: a turn whose CLI never
    // answers at all is exactly the case with nothing to rearm it.
    armSilenceDeadline(turn);

    /**
     * Write the turn's prompt, then hand the driver its opening window.
     *
     * The two are one step because the second is documented as happening after
     * the first: a protocol whose FIRST message comes from the client (ACP's
     * `initialize`) opens here, and with no gate this whole function still runs
     * inside the synchronous window below, so its opening message is queued on
     * stdin before the child can answer it.
     */
    const openTurnStdin = (): void => {
      // The write/end can also throw synchronously (stdin already destroyed).
      // Keep it inside the settle contract: surface an error event and end the
      // process rather than letting the throw unwind before the handle exists.
      try {
        if (turnOptions.stdinPayload !== undefined) {
          stdin?.write(turnOptions.stdinPayload);
        }
        if (opts.stdinLifetime === 'payload') {
          endStdin();
        }
      } catch (err) {
        if (!turn.terminalEmitted) {
          emit({
            type: 'error',
            message: `failed to write ${opts.command} stdin: ${errorMessage(err)}`,
          });
        }
        endProcess();
      }
      turnOptions.onStdinReady?.({
        write: sessionWrite,
        emit,
        writeObstacle,
        processAlive,
      });
    };

    if (turnOptions.holdPrompt) {
      void (async () => {
        try {
          await turnOptions.holdPrompt?.({
            write: sessionWrite,
            // Turn-scoped: a gate still polling after a Stop settled the turn
            // must not narrate into the next one, nor — with no turn open —
            // reach the owner as off-turn output, which a settled run reads as
            // the agent working again. The write stays the session's: its
            // polls are answered on the same pipe whatever the turn is doing.
            emit: (event) => {
              if (turn.settled) {
                opts.logger?.debug?.(
                  `${opts.command}: the prompt gate emitted a '${event.type}' after its turn settled — dropped`,
                );
                return;
              }
              emit(event);
            },
            writeObstacle,
            processAlive,
          });
        } catch (err) {
          // A gate that cannot decide must never cost the message it was
          // holding — the un-gated write is precisely the behaviour that
          // shipped before any gate existed.
          opts.logger?.warn(
            `${opts.command}: prompt gate failed, sending anyway: ${errorMessage(err)}`,
          );
        }
        // Cleared BEFORE the drop check, not after the write: from here the
        // prompt either goes out or is deliberately abandoned, and in both
        // cases a later `turn_complete` is a real answer about a real state.
        // Left set, a turn abandoned here would swallow every terminal event
        // the CLI ever produced and hang the composer for good.
        turn.promptHeld = false;
        // The user can have cancelled, or the child died, while we held. Both
        // make the payload something to drop rather than to write: a prompt
        // written into a stopped turn would run work nobody asked for, and one
        // written into a dead pipe is an EPIPE dressed as a turn failure.
        //
        // `cancelRequested` in its own right, and not only through the settle
        // it usually causes: on a one-turn process a Stop kills the group and
        // the turn settles only once that process is gone, so a gate releasing
        // in between found nothing settled and wrote the prompt into it.
        if (
          turn.settled ||
          turn.terminalEmitted ||
          turn.cancelRequested ||
          processGone ||
          stdinEnded
        ) {
          return;
        }
        openTurnStdin();
        // Rearmed from the WRITE. The deadline measures how long the CLI has
        // been silent with something to say, and it had nothing to say until
        // now — leaving the arm above to run through the hold would spend the
        // window on geniro's own waiting.
        armSilenceDeadline(turn);
      })();
    } else {
      openTurnStdin();
    }

    /** A turn-scoped write: dead once this turn is decided. */
    const turnWrite = (
      build: (() => string | undefined) | undefined,
    ): boolean => {
      if (turn.settled || turn.terminalEmitted) {
        return false;
      }
      const line = build?.();
      if (line === undefined) {
        return false;
      }
      return sessionWrite(line);
    };

    return {
      done,
      // The conditions and their reasons belong to the contract
      // ({@link AgentTurnHandle.attributableDelegate}); what is local is the
      // evidence for the first one, which this file states itself on the
      // release path: "the main thread is talking again with N unit(s) still
      // out". A held turn is the window in which it is NOT talking.
      attributableDelegate: () => {
        if (turn.deferredTerminal === null || openWork.size !== 1) {
          return null;
        }
        const [workId] = openWork;
        // Looked up THROUGH the live set, never off {@link delegateWork}.
        return (workId === undefined ? null : delegateWork.get(workId)) ?? null;
      },
      respondApproval: (id, allow, updatedInput, option) => {
        const delivered = turnWrite(() =>
          turnOptions.buildApprovalResponse?.(id, allow, updatedInput, option),
        );
        if (delivered) {
          // Answered, so it must not be re-held when this turn settles.
          // Keyed on delivery: a verdict the CLI never received leaves the
          // request outstanding, which is exactly when re-holding is right.
          turn.outstanding.delete(id);
          // The CLI is unblocked and owes us output again, so the silence
          // deadline resumes — from HERE, not from when the card went up. It
          // was suspended for the whole wait (see TURN_SILENCE_DEADLINE_MS),
          // and starting a full window now is the point: an answer delivered
          // at minute 29 must not leave the turn one minute from being given
          // up on. A no-op while another card is still open.
          armSilenceDeadline(turn);
          if (allow) {
            // A command the CLI reported before asking runs only now.
            requestCommandGroups();
          }
        }
        const seenAt = approvalSeenAt.get(id);
        approvalSeenAt.delete(id);
        // Both outcomes, deliberately. Recording only the failures is what made
        // the D1 numbers unobtainable from logs: "how often is a verdict
        // delivered" has no answer unless the delivered ones are written down
        // too.
        opts.logger?.debug?.(
          `${opts.command}: approval ${id} ${allow ? 'allowed' : 'denied'}` +
            `${option === undefined ? '' : ` (${option.scope}: ${option.id})`} — ` +
            `${delivered ? 'written to stdin' : 'NOT written (turn already settled)'}` +
            (seenAt === undefined
              ? ''
              : ` ${Date.now() - seenAt}ms after it was raised`),
        );
        return delivered;
      },
      sendUserMessage: (message) => {
        // Guarded like the verdict above, and for the same reason: a write that
        // lands after the turn settled would be reported as delivered while the
        // agent never sees it, and the caller would drop it from its queue.
        //
        // A driver that writes for itself takes the same guard and skips the
        // payload builder — see `CliTurnOptions.sendFollowUp`, which exists
        // because a stateful protocol's frame cannot be built without also
        // being recorded.
        //
        // And REFUSED while the turn's own prompt is still held: written now,
        // the follow-up would reach the CLI AHEAD of the prompt it follows.
        // MEASURED through this daemon on claude 2.1.270 — the MCP-readiness
        // gate held the prompt for 6,069ms, a message sent at 6.0s went in 63ms
        // before the prompt, and the CLI answered it first, settled the turn on
        // that answer, and ran the prompt as a further turn nobody owned: the
        // run read `completed` while it worked. A refusal is the RUN_BUSY the
        // caller already queues on, so the message goes in after the prompt.
        if (turn.promptHeld) {
          opts.logger?.debug?.(
            `${opts.command}: refusing a follow-up — this turn's prompt has not been written yet`,
          );
          return false;
        }
        // And refused once the turn has been asked to stop: whatever the CLI
        // does next, it ends this turn — codex answers "no active turn to
        // steer", claude's queue dies with a closed session. MEASURED: a
        // message sent to codex right after Stop was steered into the stopping
        // turn and refused, so it never opened the turn the user meant. The
        // refusal is the same RUN_BUSY, which queues it for the next turn.
        if (turn.cancelRequested) {
          opts.logger?.debug?.(
            `${opts.command}: refusing a follow-up — this turn is being stopped`,
          );
          return false;
        }
        const delivered = turnOptions.sendFollowUp
          ? !turn.settled &&
            !turn.terminalEmitted &&
            turnOptions.sendFollowUp(message)
          : turnWrite(() => turnOptions.buildFollowUpPayload?.(message));
        // A new prompt the CLI has not answered — a continuation's result is
        // again not this turn's ending (see `TurnState.promptAnswered`).
        if (delivered) {
          turn.promptAnswered = false;
          turn.continuationAnswer = null;
          // Written, not yet TAKEN — the turn must not end under it. Only on
          // the stdin-line path, and only for a CLI that acknowledges what it
          // takes: nothing else could ever cross it off.
          if (
            !turnOptions.sendFollowUp &&
            turnOptions.followUpConsumptionReported
          ) {
            turn.unconsumedFollowUps.push({
              text: message.text,
              deliveryId: message.deliveryId ?? null,
            });
          }
        }
        // A message delivered into a HELD turn ends the hold at the write,
        // rather than when the CLI gets round to answering. Waiting for it to
        // speak leaves a window — measured at 8 seconds in the reported case,
        // where a compaction was the thing it had been asked to do and said
        // nothing for its whole first stretch — in which the run still reads as
        // idle and the NEXT message goes straight out too. Here the fact is
        // already known: the agent has been given work.
        if (delivered && turn.deferredTerminal !== null) {
          opts.logger?.debug?.(
            `${opts.command}: releasing the hold — a follow-up was delivered into the held turn`,
          );
          supersedeHeldTerminal(turn);
          announceTurnHold(turn, 0);
          armSilenceDeadline(turn);
        }
        if (delivered) {
          turn.spokenCount += 1;
          endCommandWait(turn);
        }
        return delivered;
      },
      subagentsAFollowUpCancels: () =>
        turn.settled || turn.terminalEmitted || turn.cancelRequested
          ? 0
          : (turnOptions.subagentsAFollowUpCancels?.() ?? 0),
      setApprovalMode: (mode) =>
        // Same settle guard as the two writers above. It matters more here: a
        // true reported for a write the turn never read would tell the user
        // their permission posture changed when it did not.
        turnWrite(() => turnOptions.buildApprovalModePayload?.(mode)),
      cancel: () => {
        if (turn.settled) {
          return;
        }
        // An in-protocol stop is already under way, and the deadline armed
        // below is what bounds it. A second press must NOT skip that grace:
        // killing the group is exactly what takes the user's MCP servers — and
        // a browser one of them owns — down with the turn, and "stop harder"
        // is not what pressing Stop twice asks for.
        if (turn.interruptTimer) {
          return;
        }
        turn.cancelRequested = true;
        // On a run-scoped session, stopping the TURN must not stop the
        // PROCESS, for that same reason. Ask the CLI to stop in protocol, and
        // fall back to the group kill only if it cannot be asked.
        if (settlesOnTerminalEvent) {
          // …unless the CLI has not been asked ANYTHING yet: the prompt is
          // still held, here by the readiness gate or in the driver behind its
          // own config frames. Then there is no turn on the CLI's side for an
          // interrupt to stop, and writing one bought two failures. claude
          // answers an interrupt with no turn running with a bare
          // `control_response` and nothing else — no result, so no terminal —
          // and when the gate then released, the prompt went out into the
          // stopped turn and the agent answered it (a probe of exactly this:
          // stdin `INTERRUPT\nPROMPT\n`, events `[turn_complete]`). Past the
          // 5s grace the fallback killed the whole group instead, taking the
          // user's MCP servers down over a message that never reached the CLI.
          //
          // So the turn ends HERE, as the cancellation it is, and the process
          // is left as it was: nothing it could still print belongs to this
          // turn, which is why it is not retired either. The held prompt is
          // dropped by the release check above, or by the driver.
          if (turn.promptHeld || turnOptions.withdrawPrompt?.() === true) {
            opts.logger?.debug?.(
              `${opts.command}: stopped before its prompt was sent — nothing to interrupt`,
            );
            turn.stoppedBeforePrompt = true;
            finishTurn(turn, { type: 'turn_cancelled' });
            return;
          }
          const line = turnOptions.buildInterruptPayload?.();
          if (line !== undefined && sessionWrite(line)) {
            turn.interruptTimer = setTimeout(() => {
              turn.interruptTimer = null;
              if (!turn.settled) {
                killGroup();
              }
            }, INTERRUPT_SETTLE_GRACE_MS);
            turn.interruptTimer.unref?.();
            return;
          }
        }
        killGroup();
      },
    };
  };

  return {
    ask: <T>(request: SessionAsk<T>): Promise<T | null> =>
      new Promise<T | null>((resolve) => {
        // Written FIRST: a stdin that will not take the line means there is no
        // question to wait on, and registering the reader before finding that
        // out would leave it parked for the whole deadline.
        if (!sessionWrite(request.line)) {
          resolve(null);
          return;
        }
        let done = false;
        const finish = (answer: T | null): void => {
          if (done) {
            return;
          }
          done = true;
          pendingAsks.delete(offer);
          clearTimeout(timer);
          resolve(answer);
        };
        const offer = (obj: unknown): void => {
          if (done) {
            return;
          }
          // A reader throwing is the reader's bug, not the session's: it must
          // not take down the stdout parse loop that every turn depends on.
          let answer: T | null;
          try {
            answer = request.read(obj);
          } catch (err) {
            opts.logger?.warn(
              `${opts.command}: an out-of-band reply reader threw: ${errorMessage(err)}`,
            );
            finish(null);
            return;
          }
          if (answer !== null) {
            finish(answer);
          }
        };
        const timer = setTimeout(() => finish(null), request.timeoutMs);
        timer.unref?.();
        pendingAsks.add(offer);
        // The process can end while the question is out — nothing else would
        // then ever call `offer`, and the deadline would be the only way out.
        void closed.then(() => finish(null));
      }),
    startTurn,
    get idle() {
      return !processGone && !processExited && !stdinEnded && current === null;
    },
    get alive() {
      return !processGone && !processExited;
    },
    /**
     * This process will serve no further turn, though it is still running.
     *
     * Separate from `idle` on purpose, and it must stay that way: every reader
     * treats a NON-idle entry as BUSY, so folding retirement into `idle` would
     * stop the idle timer reaping it (`AgentSessionRegistry.arm`) while
     * `evictIfFull` went on counting it against the ceiling — the same
     * inversion the dead-session sweep exists to prevent, which its own doc
     * block spells out. The owner drops a retired entry in that same sweep.
     */
    get retired() {
      return cancelledTurnMayStillEmit;
    },
    /**
     * Both buffers, because both mean the same thing about the PROCESS: it is
     * standing still on a verdict a person owes it. Which of the two holds the
     * request only decides whether a card is up yet.
     */
    get parked() {
      return ownedApprovals.size > 0 || pendingApprovals.length > 0;
    },
    get pid() {
      return processGone || processExited ? null : (child.pid ?? null);
    },
    subagentRecoveryBlocked: (id) =>
      [...delegateCommands.values()].includes(id),
    get shellsRunning() {
      return runningShells.size + delegateCommands.size;
    },
    get detachedRunning() {
      return runningShells.size + detachedDelegateCommands().length;
    },
    recordedGroupsOf: (callId) => {
      const work = commandWork().filter(
        (id) =>
          (shellWork.get(id) ??
            delegateCommandCalls.get(id) ??
            (executeCalls.has(id) ? id : undefined)) === callId,
      );
      return work.length === 0
        ? null
        : work.flatMap((id) => commandGroups.get(id) ?? []);
    },
    get runningCommands() {
      return currentCommands();
    },
    get endedRunning() {
      return endedRunning;
    },
    close: (cause, options) => {
      if (processGone) {
        return;
      }
      // Before the graceful return: the exit it waits for is what closes the
      // delegates still out, and it reads the cause from here.
      closeCause ??= cause ?? null;
      if (options?.graceful === true && current === null && !processExited) {
        reapGroupOnExit = true;
        endStdin();
        armTurnExitDeadline();
        return;
      }
      const turn = current;
      if (turn) {
        turn.cancelRequested = true;
      }
      // A driver that learns a delivered message's fate only from the turn's
      // own end gets that end before the signal — bounded, and the process
      // goes either way.
      const grace =
        turn && !turn.terminalEmitted
          ? (turn.options.closeGraceMs?.() ?? 0)
          : 0;
      if (turn && grace > 0) {
        const deadline = setTimeout(killGroup, grace);
        void turn.done.then(() => {
          clearTimeout(deadline);
          killGroup();
        });
        return;
      }
      killGroup();
    },
    noteCloseCause: (cause) => {
      if (!processGone) {
        closeCause = cause;
      }
    },
    get closeCause() {
      return closeCause;
    },
    closed,
  };
}

/**
 * The command line a tool call ran — its non-blank `command` argument — or
 * null for a call that discloses none.
 */
function commandLineOf(
  event: Extract<AgentEvent, { type: 'tool_call' }>,
): string | null {
  const input = event.input;
  const command =
    typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : null;
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

/**
 * The session a spawn failure leaves behind: no process, and one turn's worth
 * of bad news to deliver. Its first `startTurn` emits the spawn error and
 * hands back an already-settled handle, so the caller's single settle point
 * still fires exactly once; every later call answers null.
 */
function deadSession(message: string): CliSession {
  let used = false;
  return {
    // No process, so no channel to ask on — the same null a live session gives
    // for a question it could not get an answer to.
    ask: () => Promise.resolve(null),
    startTurn: (turnOptions) => {
      if (used) {
        return null;
      }
      used = true;
      turnOptions.onEvent({ type: 'error', message });
      return {
        done: Promise.resolve(),
        cancel: () => {},
        respondApproval: () => false,
        sendUserMessage: () => false,
        attributableDelegate: () => null,
        setApprovalMode: () => false,
      };
    },
    idle: false,
    alive: false,
    // Not retired but DEAD, and the distinction matters to the holder: a
    // retired session is a live process to close, while this one has no process
    // at all. `alive: false` is what gets this entry dropped.
    retired: false,
    // No process, so nothing is blocked on anyone.
    parked: false,
    pid: null,
    shellsRunning: 0,
    detachedRunning: 0,
    runningCommands: [],
    endedRunning: null,
    recordedGroupsOf: () => null,
    close: () => {},
    closed: Promise.resolve(),
  };
}

/** The detached commands a process was running, counted and named. */
export interface StoppedCommands {
  running: number;
  commands: readonly string[];
  /**
   * Where every command the CLI reported running ran, as last recorded while
   * the process lived — the detached ones counted above and the ones the
   * agent waited on: their process groups, with the members each had and
   * their start times.
   */
  groups: readonly RecordedGroup[];
  /** The CLI's pid: the key {@link groups} are journaled under until stopped. */
  pid?: number;
}

export interface RunCliOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Extra env merged over `process.env` for the child. */
  env?: Record<string, string>;
  /**
   * Written to the child's stdin before stdin is closed. When undefined, stdin
   * is closed immediately with no payload (so a CLI that reads its prompt from
   * args never blocks waiting on stdin).
   */
  stdinPayload?: string;
  /**
   * Keep stdin open after the payload so the turn can carry a mid-turn
   * dialogue (the approval control protocol). Stdin is closed as soon as a
   * terminal event is emitted, letting the CLI exit; without that close a
   * stream-json CLI waits on stdin forever.
   */
  keepStdinOpen?: boolean;
  buildApprovalResponse?: CliTurnOptions['buildApprovalResponse'];
  buildFollowUpPayload?: CliTurnOptions['buildFollowUpPayload'];
  buildApprovalModePayload?: CliTurnOptions['buildApprovalModePayload'];
  /** Maps each parsed stream-json object to zero or more normalized events. */
  mapper: (obj: unknown) => AgentEvent[];
  onStdinReady?: CliTurnOptions['onStdinReady'];
  onEvent: (event: AgentEvent) => void;
  spawn?: SpawnFn;
  logger?: SessionLogger;
}

/**
 * One CLI process serving exactly one turn — the shape every caller had before
 * run-scoped sessions, kept as a thin façade over {@link runCliSession} rather
 * than a second implementation of the same state machine.
 *
 * `done` still resolves only once the PROCESS is gone and its stdout has
 * drained, which is what callers of this form rely on.
 */
export function runHeadlessCli(opts: RunCliOptions): AgentTurnHandle {
  const session = runCliSession({
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    stdinLifetime: opts.keepStdinOpen ? 'turn' : 'payload',
    mapper: opts.mapper,
    spawn: opts.spawn,
    logger: opts.logger,
  });
  const handle = session.startTurn({
    stdinPayload: opts.stdinPayload,
    onEvent: opts.onEvent,
    buildApprovalResponse: opts.buildApprovalResponse,
    buildFollowUpPayload: opts.buildFollowUpPayload,
    buildApprovalModePayload: opts.buildApprovalModePayload,
    onStdinReady: opts.onStdinReady,
  });
  // A fresh session always accepts its first turn — the session was created on
  // the line above, so nothing can have taken the slot. Asserted rather than
  // non-null-asserted so a future change to `startTurn`'s guards surfaces here
  // instead of as a null handle inside an adapter.
  if (!handle) {
    throw new Error(`failed to open a turn on ${opts.command}`);
  }
  return handle;
}
