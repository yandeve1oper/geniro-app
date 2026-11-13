import { totalmem } from 'node:os';

import {
  Injectable,
  Logger,
  type OnApplicationShutdown,
  Optional,
} from '@nestjs/common';

import { awakeTimeout, type AwakeTimer } from '../../../utils/sleep-watch';
import type {
  AgentEvent,
  AgentSession,
  AgentTurnHandle,
  AgentTurnInput,
  SessionCloseCause,
} from '../adapters/adapter.types';
import type { AgentAdapter } from '../adapters/agent-adapter';
import {
  DEFAULT_KEPT_SESSION_IDLE_MINUTES,
  type KeptProcessRoot,
  type KeptSessionConfigState,
  MIN_KEPT_SESSION_LIMIT,
} from '../chat.types';
import type { RecordedGroup } from '../utils/process-descendants';
import { runTagEnv } from '../utils/run-process-scan';
import {
  callConversationOf,
  runIdOfSessionKey,
  runSessionKeyPrefix,
} from '../utils/session-keys';
import {
  deferredMcpChangeNote,
  endedCommandsNote,
  type SessionNote,
  stoppedCommandsNote,
  withSessionNote,
} from '../utils/session-replacement-notes';
import type {
  BetweenTurnApproval,
  CliSessionOptions,
  SessionCloseOptions,
  StoppedCommands,
} from '../utils/spawn-cli';
import { currentRunOwner } from './run-process-attribution.service';

/**
 * How long a run's CLI process is kept after its last turn, until the user
 * sets their own window (`Settings.keptSessionIdleMinutes`, pushed by Electron
 * main through `PUT /v1/agents/sessions/config` on every daemon start and after
 * each change — see {@link AgentSessionRegistry.setIdleMinutes}). The daemon
 * reads no settings file, so this is what it uses until the first push lands.
 *
 * The whole cost/benefit of a run-scoped process sits on this number. Too
 * short and the user's MCP servers — and a browser one of them owns — are
 * rebooted while they are still reading the last answer, and the conversation
 * resumes cold. Too long and an abandoned chat holds a CLI and every server it
 * started for hours.
 *
 * ONE HOUR by default, because that is what the cold resume costs: claude
 * keeps a subscription's prompt cache for an hour, and a fresh `--resume`
 * misses that cache once `git status` has changed — which in a worktree it
 * almost always has. Closing a process before the hour is up pays a full cache
 * rewrite on top of booting every MCP server again. Lowering it trades that for
 * memory; raising it past the cache keeps only the warm MCP servers.
 *
 * The same window for every run. A card's run is an ordinary chat run: a card
 * in Done can still be written to, so how long its process lives does not
 * depend on the card's column.
 *
 * What it changes is WHICH mechanism does the reaping, not whether anything
 * does — and neither of the other two moved:
 *
 * - The daemon's own idle exit (10 min with no connected client) still takes
 *   everything the moment the app is closed, so this only ever governs a
 *   session whose window the user still has open.
 * - The ceiling (the user's limit, else {@link MAX_LIVE_SESSIONS}, derived
 *   from this machine's memory at ~1GB each) still caps how many are held at
 *   once. Within the window that ceiling is what closes an idle session
 *   rather than the clock — which is the
 *   better order anyway: it reclaims the process the user is least likely to
 *   come back to, at the moment the memory is actually wanted, instead of on a
 *   timer that cannot see whether anything needs the room.
 */
export const SESSION_IDLE_MS = DEFAULT_KEPT_SESSION_IDLE_MINUTES * 60_000;

/**
 * What one kept CLI process costs in memory.
 *
 * MEASURED 2026-08-25 on the author's own machine, over the four claude
 * sessions the daemon was holding: 1202MB, 1129MB, 905MB, 897MB — mean
 * ~1.01GB. That is the HEAVY case and deliberately so, since it is the one the
 * ceiling exists for: a CLI with ten MCP servers dialled, which is what a
 * working chat looks like here. A CLI with none is a fraction of it, so this
 * over-estimates in the safe direction.
 */
export const SESSION_MEMORY_COST_BYTES = 1024 ** 3;

/**
 * How much of the machine's memory the kept sessions may claim between them.
 *
 * An eighth. Not a number anybody can derive — what it encodes is that these
 * processes are a CACHE (every one of them can be closed and re-opened with
 * `--resume`, costing latency and nothing else), so they get a slice rather
 * than a share of what is free: the user's editor, browser and the agents'
 * own subprocesses have the rest, and none of them announce themselves here.
 */
const SESSION_MEMORY_SHARE = 1 / 8;

/**
 * The cap, and it is not about memory — a 512GB machine would compute 64.
 * Past about a dozen the constraint stops being the hardware and starts being
 * the person: those are conversations somebody is meant to be following, and a
 * ceiling that scales without bound is not a ceiling. The idle window reaps
 * what is genuinely abandoned either way.
 */
const MAX_LIVE_SESSIONS_CAP = 16;

/**
 * How many run-scoped processes may live at once, for a machine of this size.
 *
 * A CLI holding ten MCP servers is about a gigabyte, so this is a real ceiling
 * and not a formality: without it, opening a dozen chats would keep a dozen of
 * them. It was a flat `3`, which is the whole reason it is now computed — three
 * is right for a 16GB laptop and absurd on the 128GB machine this was reported
 * from, where it meant paying a cold start (~6.5s and every MCP server
 * rebooted) on the fourth chat while 110GB sat free. REPORTED as "что за max
 * live session… это очень мало!", and the answer asked for was to derive it
 * rather than pick a better constant.
 *
 * Derived from TOTAL memory, never from what is free right now: free memory
 * depends on what the machine happened to be doing when the daemon booted, so
 * the same computer would get a different ceiling on each launch and no
 * behaviour here would be reproducible. Memory is also the only axis — cores
 * do not bound how many idle processes may sit in RAM.
 *
 * Pure and exported so it is testable at sizes this machine is not: see the
 * spec, which pins the curve rather than whatever the test host happens to
 * have.
 */
export function sessionCeilingFor(totalMemoryBytes: number): number {
  const affordable = Math.floor(
    (totalMemoryBytes * SESSION_MEMORY_SHARE) / SESSION_MEMORY_COST_BYTES,
  );
  return Math.min(
    MAX_LIVE_SESSIONS_CAP,
    Math.max(MIN_KEPT_SESSION_LIMIT, affordable),
  );
}

const MACHINE_MEMORY_BYTES = totalmem();

/** The ceiling this daemon runs under — {@link sessionCeilingFor} of this box. */
export const MAX_LIVE_SESSIONS = sessionCeilingFor(MACHINE_MEMORY_BYTES);

/**
 * How long after its last off-turn row a session is still treated as WORKING.
 *
 * `session.idle` means "no turn of OURS in flight", which is also true of a CLI
 * running flat out between turns — a delegate reporting back, a continuation
 * the agent opened for itself. {@link touchOffTurn} already had to teach the
 * idle WINDOW that difference; eviction never learned it, and the two are the
 * same fact used for two decisions.
 *
 * What that cost is measured, on the reporter's own run `309e0822` (2026-08-25,
 * reconstructed from `geniro.db` and the debug log): a claude thread ran on
 * after its turn settled, wrote its twelve-task plan, said "Starting T1", and
 * its last row landed at 13:16:09 — one second before `evictIfFull` picked it
 * as the least-recently-used idle session and closed the process. The chat then
 * sat for 22 minutes reading `completed` with 11 of 12 tasks pending, until the
 * user typed "status?" to restart it. REPORTED as "Тред сам по себе остановился
 * … я должен писать ему какое-то сообщение, чтобы он продолжил".
 *
 * Five minutes, the same span and the same reasoning as `ChatService`'s
 * `DELEGATE_ROW_LEASE_MS`: it is the answer to "how long do we go on believing
 * a quiet stretch is still work", and two different answers to one question is
 * how the badge and the process come to disagree about whether a chat is busy.
 *
 * It can only ever push the registry OVER the ceiling, never refuse a turn —
 * `evictIfFull` already has that arm, for the case where no session may be
 * closed, and this widens what counts as busy rather than adding a new outcome.
 */
export const OFF_TURN_ACTIVE_MS = 5 * 60_000;

/**
 * A chat's or a member's own conversation used this recently is never closed
 * to make room: its person is most likely still reading the answer, and a cold
 * start costs the next turn a new process, its MCP servers and, for cursor, a
 * replay of the whole conversation. A callee's conversation has no such claim
 * once idle — its call has returned — so it is closed first.
 */
export const RECENTLY_USED_MS = 10 * 60_000;

/**
 * What made a kept process stale, which decides whether its replacement may
 * wait for the background work running in it:
 *
 * - `mcp` — the MCP servers a fresh process would load changed. May wait: the
 *   old process still serves the conversation, only without the change, and
 *   replacing it would stop the dev servers and test runs the agent left up.
 * - `account` — the CLI's credentials changed, and the old process may fail
 *   every turn on the ones it started with.
 * - `conversation` — geniro replaced the conversation (a carried compaction) or
 *   moved it to another process; a turn on the old one continues the wrong one.
 */
type StaleCause = 'mcp' | 'account' | 'conversation';

interface StaleMark {
  /** Each change that marked it, in order, for the log and the agent's line. */
  reasons: string[];
  cause: StaleCause;
  /**
   * The row saying this mark is waiting was written, and the agent was told —
   * each once per set of reasons, since a dev server can hold it for the rest
   * of the chat. A new reason is a new mark. Apart because a turn with no
   * prompt to carry the line (a slash command) still writes the row.
   */
  rowWritten?: boolean;
  told?: boolean;
}

/**
 * The mark an entry carries after `next` lands on `current`. A cause that
 * cannot wait outranks `mcp`, so a compaction after an MCP change still
 * replaces the process; among `mcp` marks every change is kept, so the line
 * the agent gets names all of them.
 */
function mergeStale(current: StaleMark | null, next: StaleMark): StaleMark {
  if (current === null) {
    return next;
  }
  if (current.cause !== 'mcp') {
    return current;
  }
  if (next.cause !== 'mcp') {
    return next;
  }
  const added = next.reasons.filter((r) => !current.reasons.includes(r));
  return added.length === 0
    ? current
    : { reasons: [...current.reasons, ...added], cause: 'mcp' };
}

interface KeptSession {
  key: string;
  agent: string;
  cwd: string;
  configDir: string | null;
  session: AgentSession;
}

interface SessionEntry {
  session: AgentSession;
  /**
   * The agent and folder this process was spawned for.
   *
   * Recorded solely so {@link AgentSessionRegistry.markStaleWhere} can find
   * the sessions an MCP change is ABOUT. The registry is keyed by run, and a
   * change to a folder's servers is about every run working in that folder —
   * a fact neither the run id nor the session itself carries.
   */
  agent: string;
  cwd: string;
  /** The profile it runs under — null for the CLI's default one. */
  configDir: string | null;
  /**
   * Why this process can no longer serve a turn, or null.
   *
   * Set when something outside the run changed what a fresh process would
   * load — today, that folder's MCP servers. The session is NOT closed on the
   * spot, which is the whole design: closing it would either kill a turn that
   * is running or reap a dozen idle chats nobody is about to use. The flag is
   * read at the start of the next turn, which is exactly the moment the change
   * has to have landed — unless its cause may wait and the process is still
   * running background work, in which case it is read again at the turn after.
   */
  stale: StaleMark | null;
  /** When this run's last turn ended; drives both eviction and expiry. */
  lastUsedAt: number;
  /**
   * When the CLI last produced a row with no turn of ours open, or 0 for a
   * session that has never done so.
   *
   * Separate from {@link lastUsedAt}, which both this and a settling turn
   * refresh: the two mean different things to eviction. A session whose turn
   * ended a moment ago is merely RECENT, and evicting it costs a respawn; one
   * writing rows this second is WORKING, and evicting it costs the work. Only
   * the second is exempt, so a busy chat is not confused with a fresh one.
   */
  offTurnActiveAt: number;
  /** The idle reap. Awake time — see {@link AgentSessionRegistry.arm}. */
  timer: AwakeTimer | null;
  /**
   * The between-turn approval policy, in a holder the session reads THROUGH.
   *
   * The session is opened once and lives for the whole run, but the policy is
   * built per turn (it closes over that turn's approval mode). Handing the
   * spawn a bare closure therefore froze the posture at turn 1: a chat started
   * in `auto` and switched to `ask` went on auto-approving between-turn
   * permissions for the rest of the session, with no card — the same silent
   * wrong verdict this whole change exists to end, inverted. The holder is
   * what lets every later turn — including the ones served off the reuse path,
   * which never reach a spawn at all — replace it.
   */
  policy: { current: BetweenTurnApproval | undefined };
  /**
   * Where events arriving BETWEEN turns go, in a holder the session reads
   * THROUGH — {@link policy}'s reason, reached from a different direction.
   *
   * It was bound once at spawn, on the reading that it carries no turn state
   * and files under the RUN. That held while a key served one identity turn
   * after turn. A team callee's key is its CONVERSATION, which several
   * calls continue in turn, and each call files its rows under its own id — so,
   * bound at spawn, everything the CLI did after call-2's turn was filed under
   * call-1 and nested in call-1's block. Each turn now installs its own.
   */
  offTurn: { current: ((event: AgentEvent) => void) | undefined };
}

/**
 * The CLI process each chat run keeps between its turns.
 *
 * A coding CLI boots the user's MCP servers when it starts, and an MCP server
 * can own something expensive — a browser they are logged into. Spawning one
 * process per turn therefore tore that down on every message; measured on
 * claude 2.1.223, two messages meant two full boots of all ten servers and
 * 6.5s of startup before the second turn produced a token. Held across the run
 * it is one boot and 0.5s.
 *
 * **This registry is the owner of those processes.** Nothing else reaps one:
 * a run-scoped CLI has no reason of its own to exit, so every path out — the
 * idle window, the eviction, a delete, daemon shutdown — goes through
 * {@link close} here.
 *
 * Deliberately separate from `ProcessRegistry`, which tracks TURNS (claim,
 * cancel, shutdown drain). The two lifetimes genuinely differ now: a turn ends
 * while its process keeps running, and folding them into one map would make
 * "is this run busy" and "does this run hold a process" the same question when
 * they are no longer the same question.
 */
@Injectable()
export class AgentSessionRegistry implements OnApplicationShutdown {
  private readonly logger = new Logger(AgentSessionRegistry.name);
  private readonly entries = new Map<string, SessionEntry>();
  /**
   * What each key's next turn owes its agent about detached commands a close
   * stopped — transcript rows and prompt lines, kept apart because a turn that
   * carries no prompt still writes the rows.
   */
  private readonly stopped = new Map<
    string,
    { rows: string[]; prompts: string[] }
  >();
  /**
   * Processes the idle close, or a finished card's close, has asked to finish
   * gracefully (`SessionCloseOptions`) and that have not exited yet, with the
   * key each was closed under. A graceful close signals nothing at first, so
   * the CLI can run for a few seconds after its entry is gone — and it is still
   * this registry's to end: shutdown ({@link closeAll}) and a teardown
   * ({@link closeRun}) escalate it, a finished card's close waits for it
   * ({@link closeFinishedRun}), and it is still reported as the run's
   * ({@link processRoots}), so no reap signals it mid-exit. An immediate close
   * is not kept here: its process is already being signalled.
   */
  private readonly closing = new Map<SessionEntry, string>();
  /** Entries whose `close()` threw: their `closed` may never settle. */
  private readonly closeFailed = new WeakSet<SessionEntry>();
  /**
   * Processes closed for going unused whose exit {@link onIdleClosed} is still
   * owed. A teardown or shutdown that escalates one withdraws it.
   */
  private readonly idleExits = new Set<SessionEntry>();
  private readonly idleCloseListeners = new Set<(runId: string) => void>();
  /**
   * When any conversation of each run last started or settled a turn, or wrote
   * a row off-turn — kept past its process, so a sibling whose CLI died a
   * minute ago still counts when another of the run's processes idles out.
   */
  private readonly runUsedAt = new Map<string, number>();
  private shuttingDown = false;
  private readonly leftCommandListeners = new Set<
    (runId: string, left: StoppedCommands) => void
  >();
  private readonly closeListeners = new Set<
    (
      runId: string,
      interrupted: boolean,
      exited: boolean,
      cause: SessionCloseCause | null,
    ) => void
  >();
  /** See {@link onIdleFarewell} — one listener, not a set: it is a question put
   *  to the process, and the close waits for it. */
  private farewell: ((runId: string) => Promise<void>) | null = null;

  /**
   * This registry's ceiling, defaulting to what the machine affords.
   *
   * A constructor argument purely as a TEST SEAM — the specs pin a fixed value
   * so the eviction cases mean the same thing on a 16GB CI box and on a 128GB
   * desktop, where the computed ceiling differs by a factor of eight. `@Optional`
   * is what lets Nest instantiate this with no provider for `Number`.
   */
  private readonly automaticCeiling: number;

  /** The user's own ceiling (`Settings.keptSessionLimit`), null for {@link automaticCeiling}. */
  private userLimit: number | null = null;

  /** This geniro's owner tag, stamped on every process beside the run id. */
  private readonly runOwner = currentRunOwner();

  /** The idle window every arm uses — see {@link setIdleMinutes}. */
  private idleWindowMs = SESSION_IDLE_MS;
  private idleWindowPushed = false;

  constructor(@Optional() ceiling?: number) {
    this.automaticCeiling = ceiling ?? MAX_LIVE_SESSIONS;
  }

  private get ceiling(): number {
    return this.userLimit ?? this.automaticCeiling;
  }

  /**
   * Told whenever a run's process is closed OR ends by itself — the one signal
   * that no further event of any kind is coming from it.
   *
   * It exists because an off-turn `running` ends only on a terminal event, and
   * closing the process that owed that event strands the badge for ever (see
   * `ChatService.settleAfterSessionClosed`). Nothing here interprets that; the
   * registry's job is to say the process is gone.
   *
   * A process that DIES — a crash, an OOM kill, a `pkill` — strands that badge
   * exactly as a close does, and for a while it was told nothing: only
   * {@link closeEntry} notified, while {@link forgetWhenClosed} dropped the
   * entry in silence. So a chat carrying on off-turn whose CLI crashed read
   * `running · still working` for good, its delegates were never closed, and
   * nothing in the transcript said why. Both paths now notify, EXACTLY ONCE per
   * process: `closeEntry` removes the entry before the process exits, and the
   * exit's handler only speaks for an entry that is still registered.
   *
   * `exited` says which of the two it was — geniro closing the process, or the
   * process ending on its own — because the sentence the transcript owes the
   * user differs: "geniro closed it" is false about a crash.
   *
   * NOT fired during shutdown: every session is closed on the way out, the
   * daemon is seconds from exiting, and a listener writing rows into a
   * database that is closing behind it can only lose. The next boot's
   * reconcile owns those runs instead.
   *
   * `interrupted` says whether the process was still WORKING when it was
   * closed ({@link worksOffTurn}) — the difference between housekeeping and
   * cutting a running agent off, which the listener cannot see from here and
   * which decides whether the transcript owes the user a sentence.
   *
   * `cause` is the one {@link close} was given, so the listener closes the
   * work still out the way the session did; null for every other ending.
   */
  onClosed(
    listener: (
      runId: string,
      interrupted: boolean,
      exited: boolean,
      cause: SessionCloseCause | null,
    ) => void,
  ): void {
    this.closeListeners.add(listener);
  }

  /**
   * Told when a process has ended with commands still recorded as running in
   * it, whatever ended it but shutdown, with where they ran
   * ({@link StoppedCommands.groups}). After a graceful end the CLI has stopped
   * them itself; after a crash, an OOM kill, or a close whose escalation cut
   * the CLI's shutdown short, they are what it left running. A teardown's close
   * is included: its reap finds a command by the run tag, which a system binary
   * whose parent is gone no longer shows.
   */
  onLeftCommands(
    listener: (runId: string, left: StoppedCommands) => void,
  ): void {
    this.leftCommandListeners.add(listener);
  }

  /**
   * The LAST moment this run's process can be asked anything — awaited before
   * an unused session is closed.
   *
   * It exists because some readings only a RUNNING agent can give are wanted
   * long after it stops running: claude answers the context breakdown and the
   * plan limits on its live stdin dialogue alone, so a chat whose process has
   * been reaped has nothing to show until the user spends a turn reviving it.
   * Asking on the way out costs one round trip on a process that is about to be
   * thrown away, and it is asked at the one close that leaves a conversation
   * the user will come back to.
   *
   * ONLY the idle close. An eviction wants the memory back now, a staleness
   * replacement has a turn waiting behind it, a delete is discarding the run,
   * and shutdown is seconds from ending the process anyway — none of them can
   * afford a second of politeness, and all four leave the reading absent, which
   * the readout already has a sentence for.
   *
   * The listener is handed the run id and nothing else: the session is still in
   * the map while it runs, so {@link peek} is how it reaches the process, and
   * this hook stays free of the session type.
   */
  onIdleFarewell(listener: (runId: string) => Promise<void>): void {
    this.farewell = listener;
  }

  /**
   * Told, with the RUN id, once a process this registry closed because it went
   * unused for the idle window has exited — the moment the run's leftovers are
   * no longer under a CLI the registry reports ({@link processRoots}).
   *
   * Only that close: an eviction, a stale replacement, a teardown (which reaps
   * itself) and shutdown are not the user leaving the run, and a teardown or
   * shutdown that escalates the close still under way withdraws it. A team
   * run is told once per key; whatever listens decides whether the RUN is done.
   */
  onIdleClosed(listener: (runId: string) => void): void {
    this.idleCloseListeners.add(listener);
  }

  /**
   * Owe the next turn of any conversation under `runId` a prompt line — what
   * was stopped while the run sat unused, which no single key's close stopped.
   * A chat's key is its run id; in a team the first conversation to take a
   * turn carries it.
   */
  oweRunNote(runId: string, prompt: string): void {
    this.oweKeyNote(runId, prompt);
  }

  /**
   * Owe one conversation's next turn a prompt line: `key` is its session key
   * (a team member's own, or a chat's run id). False when it was not kept —
   * the daemon is shutting down, so no next turn will carry it.
   */
  oweKeyNote(key: string, prompt: string): boolean {
    if (this.shuttingDown) {
      return false;
    }
    const owed = this.stopped.get(key) ?? { rows: [], prompts: [] };
    owed.prompts.push(prompt);
    this.stopped.set(key, owed);
    return true;
  }

  /**
   * Start a turn for this run, reusing its process when one fits and spawning
   * a fresh session when none does.
   *
   * The reuse decision is the ADAPTER's: a session refuses a turn it cannot
   * serve (different argv, dead process, a CLI that hosts one turn per
   * process) and this simply takes the refusal as "spawn a new one". So
   * nothing here knows which CLI it is talking to.
   */
  startTurn(
    runId: string,
    adapter: AgentAdapter,
    input: AgentTurnInput,
    onEvent: (event: AgentEvent) => void,
    /**
     * This turn's answer for a request that arrives after it settles — see
     * {@link BetweenTurnApproval}.
     *
     * Supplied per TURN even though the session is per RUN, and installed on
     * every call (spawn and reuse alike) so the posture a between-turn request
     * is judged by is the one the user most recently chose.
     */
    betweenTurnApproval?: BetweenTurnApproval | undefined,
    /**
     * Where a NON-approval event arriving between turns goes — see
     * `CliSessionOptions.onBetweenTurnEvent`. Installed on every call, like the
     * posture above ({@link SessionEntry.offTurn}): what the CLI does after a
     * turn belongs to the identity that turn filed under, and one key can serve
     * several — a callee conversation continued by several calls.
     */
    onBetweenTurnEvent?: (event: AgentEvent) => void,
    /**
     * How a request the posture will not decide reaches the USER with no turn
     * in flight — see `CliSessionOptions.onHeldApproval`. Bound at spawn like
     * the event sink above and for the same reason: it files the card under the
     * RUN, which does not change from turn to turn.
     */
    onHeldApproval?: CliSessionOptions['onHeldApproval'],
  ): AgentTurnHandle {
    this.noteUsed(runId);
    const existing = this.entries.get(runId);
    // Asked to work again, replaced or reused: a later close is not the Stop's.
    existing?.session.noteCloseCause?.(null);
    if (
      existing !== undefined &&
      existing.stale !== null &&
      !this.mayKeepStale(existing)
    ) {
      // Replaced rather than reused, and replaced HERE rather than when the
      // change landed: the process holds MCP servers it read at spawn, so a
      // turn served by it would run against the configuration the user just
      // left. The conversation survives — cursor re-`session/load`s it off
      // disk and claude resumes by id — so the cost is one respawn.
      this.closeEntry(runId, existing, existing.stale.reasons.join('; '));
    } else if (existing) {
      this.disarm(existing);
      // Before the turn opens, not after: this turn's posture is what a
      // request arriving after it settles must be judged by, and the reuse
      // path is the ONLY path most turns take.
      existing.policy.current = betweenTurnApproval;
      // A turn that names no sink keeps the last one, rather than dropping
      // what the CLI does next on the floor.
      if (onBetweenTurnEvent !== undefined) {
        existing.offTurn.current = onBetweenTurnEvent;
      }
      // A stale entry reaching here is one whose change may wait: it stays
      // marked, and the first turn that starts with no background work in it
      // replaces it.
      const stale = existing.stale;
      const deferred =
        stale === null || stale.told === true
          ? null
          : deferredMcpChangeNote(stale.reasons);
      const reuseInput = this.withOwedNotes(runId, input, deferred?.prompt);
      const handle = existing.session.startTurn(reuseInput, onEvent);
      if (handle) {
        const carried = reuseInput !== input;
        this.tellStopped(runId, carried, onEvent);
        if (stale !== null && deferred !== null) {
          if (stale.rowWritten !== true) {
            onEvent({
              type: 'notice',
              message: deferred.transcript,
              severity: 'info',
            });
            stale.rowWritten = true;
          }
          stale.told = carried;
        }
        return this.track(runId, existing, handle);
      }
      // It could not serve this turn, and a session that has refused one will
      // not serve the next either — the reasons are all sticky (dead process,
      // changed argv, one-turn CLI). Replace it rather than keeping a process
      // nothing can use.
      this.closeEntry(runId, existing, 'it could not serve the next turn');
    }

    // Evict BEFORE spawning, so the ceiling counts what will exist rather than
    // what did.
    this.evictIfFull();

    const turnInput = this.withOwedNotes(runId, input);
    const policy: SessionEntry['policy'] = { current: betweenTurnApproval };
    const offTurn: SessionEntry['offTurn'] = { current: onBetweenTurnEvent };
    const session = adapter.startSession(turnInput, {
      // A daemon that is shutting down must not keep a process alive past the
      // drain: `close()` would have to arrive from a hook that has already run.
      runScoped: !this.shuttingDown,
      // Read THROUGH the holder on every request, so the posture is the one
      // the most recent turn declared rather than the one this spawn saw.
      // Only installed when this caller has a posture at all — a session with
      // no policy must keep `spawn-cli`'s own default (hold a question, refuse
      // a permission), which an always-present indirection would erase.
      betweenTurnApproval:
        betweenTurnApproval === undefined
          ? undefined
          : // A later turn that supplies none falls back to HOLDING rather
            // than to the refuse default — between the two, the direction that
            // cannot grant something unasked is the one to fail toward.
            (request) => policy.current?.(request) ?? null,
      // Wrapped so an off-turn row RESTARTS the idle clock — see
      // {@link touchOffTurn} — and read THROUGH the holder, so it reaches the
      // sink the most recent turn installed. Only when the caller supplied a
      // sink: passing a function where it passed none would change what
      // `startSession` is told about this session, and the re-arm has nothing
      // to observe anyway.
      onBetweenTurnEvent:
        onBetweenTurnEvent === undefined
          ? undefined
          : (event) => {
              this.touchOffTurn(runId);
              offTurn.current?.(event);
            },
      onHeldApproval,
      // The RUN, not this key: a team files each member and conversation
      // under its own key, and the run's teardown searches by the run alone.
      runTag: runTagEnv(runIdOfSessionKey(runId), this.runOwner),
    });
    const handle = session.startTurn(turnInput, onEvent);
    if (!handle) {
      // A freshly opened session always accepts its first turn — a spawn
      // failure comes back as a settled handle carrying an `error` event. This
      // is a broken adapter contract, not a runtime condition.
      session.close();
      throw new Error(`agent session for run ${runId} refused its first turn`);
    }
    // A spawn that failed has no agent to read the line; it waits for the next.
    this.tellStopped(runId, turnInput !== input && session.alive, onEvent);
    const entry: SessionEntry = {
      session,
      agent: adapter.getConfig().kind,
      cwd: input.cwd,
      configDir: input.configDir ?? null,
      stale: null,
      lastUsedAt: Date.now(),
      offTurnActiveAt: 0,
      timer: null,
      policy,
      offTurn,
    };
    this.entries.set(runId, entry);
    this.forgetWhenClosed(runId, entry);
    return this.track(runId, entry, handle);
  }

  /**
   * Close the run's process, if it still holds one. Idempotent, so every
   * teardown path can call it without first asking whether there is one.
   *
   * `reason` is read by the user and the agent: a close that stops detached
   * commands owes the key's next turn a note quoting it ("its turn was
   * retried").
   */
  close(runId: string, reason: string, cause?: SessionCloseCause): void {
    const entry = this.entries.get(runId);
    if (entry) {
      this.closeEntry(runId, entry, reason, true, cause);
    }
  }

  /**
   * The user stopped this run's work while its processes are kept: whenever
   * one of them is closed before it is asked anything again, the close is the
   * Stop's ({@link SessionCloseCause}). A team keeps its processes across
   * a Stop, so the close that ends their delegates comes later.
   */
  noteUserStop(runId: string): void {
    const prefix = runSessionKeyPrefix(runId);
    for (const [key, entry] of this.entries) {
      if (key === runId || key.startsWith(prefix)) {
        entry.session.noteCloseCause?.('user-stop');
      }
    }
  }

  /**
   * Close EVERY process one run holds — its own key, and every per-member and
   * per-conversation key a team run opens under it (`<runId>::…`).
   *
   * A team run's processes outlive each reply, as a chat's do, so a
   * teardown that closed only the bare run key (all a chat has) would leave a
   * deleted or archived team's agents — and every server they started —
   * running with nothing left to end them.
   */
  closeRun(runId: string): void {
    const prefix = runSessionKeyPrefix(runId);
    // At once: a process still finishing an idle close under the run too.
    for (const [entry, key] of [...this.closing]) {
      if (key === runId || key.startsWith(prefix)) {
        this.escalate(key, entry);
      }
    }
    for (const [key, entry] of [...this.entries]) {
      if (key === runId || key.startsWith(prefix)) {
        this.closeEntry(key, entry, 'its run was torn down', false);
      }
    }
    this.runUsedAt.delete(runId);
    // Nothing will start a turn here again to be told.
    for (const key of [...this.stopped.keys()]) {
      if (key === runId || key.startsWith(prefix)) {
        this.stopped.delete(key);
      }
    }
  }

  /**
   * End every process a FINISHED card's run holds, gracefully, and resolve once
   * each is gone, so the caller's reap never signals a CLI still finishing.
   * Never rejects. A process whose close threw is not waited on: it is dropped
   * from {@link closing} and left to that reap. An idle close under way is
   * taken over, so the run's idle reap does not follow it.
   *
   * Unlike a teardown it keeps what an earlier close owed the key: the card can
   * run again, and its agent is then owed that news.
   */
  closeFinishedRun(runId: string): Promise<void> {
    const prefix = runSessionKeyPrefix(runId);
    const gone: Promise<void>[] = [];
    const awaitGone = (entry: SessionEntry): void => {
      if (this.closeFailed.has(entry)) {
        this.closing.delete(entry);
        return;
      }
      gone.push(entry.session.closed);
    };
    for (const [entry, key] of [...this.closing]) {
      if (key === runId || key.startsWith(prefix)) {
        this.idleExits.delete(entry);
        awaitGone(entry);
      }
    }
    for (const [key, entry] of [...this.entries]) {
      if (key === runId || key.startsWith(prefix)) {
        this.closeEntry(
          key,
          entry,
          "its card's work is finished",
          false,
          undefined,
          { graceful: true },
        );
        awaitGone(entry);
      }
    }
    return Promise.all(gone).then(() => undefined);
  }

  /**
   * Retire the sessions of one agent that `reached` says a change affects,
   * from the next turn on. The caller decides the reach — a folder, a
   * repository, a profile — and this only applies it.
   *
   * REPORTED against cursor as "usually when I update MCP they are available
   * from the very next turn; here it did not see they were updated" — with the
   * agent itself writing, in the transcript, "MCP tools in this session — still
   * only GitHub, Playwright and codegraph; no Linear connector appeared… the
   * connector may need the session restarted". It had diagnosed its own
   * process: a CLI reads its MCP configuration once, when it starts, and geniro
   * keeps that process alive across turns, so a server switched on or signed in
   * to reached the config and never reached the running agent.
   *
   * A MARK rather than a close, for two reasons that both matter. A session may
   * be mid-turn, and closing it there kills work the user asked for. And a
   * folder may hold a dozen idle chats, none of which is about to be used —
   * closing them all would re-spawn a dozen CLIs, each re-launching the user's
   * own MCP servers, to serve turns nobody sent. The next turn on each session
   * is both the correct moment and the only one that costs anything.
   *
   * Answers how many it marked, which is what makes the caller's log worth
   * reading: zero is the ordinary case (a change made with no chat open in that
   * folder) and is not a failure.
   */
  markStaleWhere(
    agent: string,
    reached: (session: { cwd: string; configDir: string | null }) => boolean,
    reason: string,
    cause: Exclude<StaleCause, 'conversation'>,
  ): number {
    let marked = 0;
    for (const entry of this.entries.values()) {
      if (entry.agent !== agent || !reached(entry)) {
        continue;
      }
      const mark = mergeStale(entry.stale, { reasons: [reason], cause });
      // Counted only when this change is what retires it — newly, or now
      // without waiting — so a caller's log does not claim a respawn already
      // owed.
      if (entry.stale === null || entry.stale.cause !== mark.cause) {
        marked += 1;
      }
      entry.stale = mark;
    }
    return marked;
  }

  /** {@link markStaleWhere} for every session of one agent in one folder. */
  markStale(
    agent: string,
    cwd: string,
    reason: string,
    cause: Exclude<StaleCause, 'conversation'>,
  ): number {
    return this.markStaleWhere(
      agent,
      (session) => session.cwd === cwd,
      reason,
      cause,
    );
  }

  /** The folders this agent's kept sessions run in, each once. */
  cwdsOf(agent: string): string[] {
    const cwds = new Set<string>();
    for (const entry of this.entries.values()) {
      if (entry.agent === agent) {
        cwds.add(entry.cwd);
      }
    }
    return [...cwds];
  }

  /**
   * Retire every session of one agent, in EVERY folder, from the next turn on —
   * the account-wide twin of {@link markStaleWhere}, and a mark for the same
   * reasons.
   *
   * For a change to the ACCOUNT a CLI runs as: a sign-in or a sign-out through
   * geniro. A kept process started under the previous credentials, and nothing
   * that happens to the credential store afterwards is guaranteed to reach it.
   * REPORTED as a chat where every message failed with `401 OAuth access token
   * has expired` until the user signed out and back in; the sign-in the
   * transcript now offers must not leave that chat's next message on the
   * process that produced the 401. Whether the CLI would have re-read its
   * credentials by itself is not measured, and does not need to be: a respawn
   * costs one cold start, a stale process costs the user's retry.
   */
  markAgentStale(
    agent: string,
    reason: string,
    cause: Exclude<StaleCause, 'conversation'>,
  ): number {
    return this.markStaleWhere(agent, () => true, reason, cause);
  }

  /**
   * Retire ONE key's process: its next turn runs on a fresh one — the
   * single-key twin of {@link markStaleWhere}.
   *
   * For a conversation geniro has REPLACED (a carried compaction, which drops
   * the CLI's session). The kept process still holds that session, and a later
   * turn is opened on it rather than on a new one — an ACP session keeps its
   * session id across turns — so the summary would be sent into the very
   * conversation it replaced and nothing would shrink. A mark rather than a
   * close for `markStaleWhere`'s reasons: whatever the process started in the
   * background runs on until the conversation is actually continued.
   *
   * Answers whether there was a process to retire.
   */
  retire(key: string, reason: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    entry.stale = mergeStale(entry.stale, {
      reasons: [reason],
      cause: 'conversation',
    });
    return true;
  }

  /** The idle window in minutes, as the user last set it. */
  get idleMinutes(): number {
    return this.idleWindowMs / 60_000;
  }

  /** Whether {@link idleMinutes} is the user's, not the default before the first push. */
  get hasUserIdleWindow(): boolean {
    return this.idleWindowPushed;
  }

  /**
   * Take the user's idle window (`Settings.keptSessionIdleMinutes`), pushed by
   * Electron main on every daemon start and after each change. Held in memory
   * only, {@link SESSION_IDLE_MS} until the first push.
   *
   * Every later arm uses it, and every process already waiting out a window is
   * re-timed to its last use plus the new one, on awake time as before
   * (`AwakeTimer.retime`). One already past the new deadline goes through the
   * ordinary idle close at once, so the exemptions hold as they always do: a
   * parked question or a detached command re-arms it. A process with a turn in
   * flight has no window yet; its settle arms the new one.
   */
  setIdleMinutes(minutes: number): void {
    this.idleWindowMs = minutes * 60_000;
    this.idleWindowPushed = true;
    for (const entry of this.entries.values()) {
      entry.timer?.retime(this.idleWindowMs);
    }
  }

  /**
   * Take the user's ceiling (`Settings.keptSessionLimit`), pushed beside the
   * idle window; null hands it back to {@link sessionCeilingFor}. A lower one
   * closes idle processes at once, in eviction order and under the same
   * exemptions, so it may stay over the new ceiling until they lapse.
   */
  setLimit(limit: number | null): void {
    this.userLimit = limit;
    this.dropUnusable();
    this.evictWhile(
      () => this.entries.size > this.ceiling,
      'the session limit was lowered',
    );
  }

  /** What `GET /v1/agents/sessions/config` answers. */
  get config(): KeptSessionConfigState {
    return {
      idleMinutes: this.idleMinutes,
      limit: this.userLimit,
      automaticLimit: this.automaticCeiling,
      sessionMemoryBytes: SESSION_MEMORY_COST_BYTES,
      totalMemoryBytes: MACHINE_MEMORY_BYTES,
      recentlyUsedMinutes: RECENTLY_USED_MS / 60_000,
    };
  }

  /** Runs currently holding a process — for diagnostics and the specs. */
  get liveCount(): number {
    return this.entries.size;
  }

  /**
   * Whether a live process is kept under any key starting with `prefix` — for
   * a caller that knows the family of keys a conversation's process sits in
   * but not the exact one (a team call is keyed by its conversation's
   * first call). Like {@link peek}, reading does not refresh the idle clock.
   */
  holdsAnyUnder(prefix: string): boolean {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix) && entry.session.alive) {
        return true;
      }
    }
    return false;
  }

  /**
   * How many kept processes are WORKING with no turn of ours in flight — a CLI
   * that produced a row off-turn within {@link OFF_TURN_ACTIVE_MS}, or one
   * serving a detached command.
   *
   * The same two exemptions eviction already makes, asked for a different
   * reader: `IdleShutdownLifecycle`, whose "is anything running" was
   * `ProcessRegistry`'s TURN count alone. A turn now ends while its process
   * keeps working — a continuation claude opens for itself, a delegate still
   * out, a dev server the agent started — and with every window closed and no
   * turn open, the daemon SIGTERMed itself ten minutes later and took all of it
   * down.
   *
   * Read-only, and it touches no clock: asking whether a session works must
   * not be what keeps it working.
   */
  get workingOffTurn(): number {
    let working = 0;
    for (const entry of this.entries.values()) {
      if (
        entry.session.alive &&
        (this.worksOffTurn(entry) || entry.session.shellsRunning > 0)
      ) {
        working += 1;
      }
    }
    return working;
  }

  /** How many of the run's kept processes have a turn in flight. */
  turnsInFlight(runId: string): number {
    let turns = 0;
    for (const [key, entry] of this.entries) {
      if (
        runIdOfSessionKey(key) === runId &&
        entry.session.alive &&
        !entry.session.idle
      ) {
        turns += 1;
      }
    }
    return turns;
  }

  /**
   * Whether a kept process works with no turn of ours in flight, counting a
   * detached command only while its run took a turn within `detachedForMs`:
   * a dev server nobody has used since is running, not working.
   */
  worksBetweenTurns(detachedForMs: number): boolean {
    const now = Date.now();
    const runLastUsed = new Map(this.runUsedAt);
    for (const [key, entry] of this.entries) {
      const run = runIdOfSessionKey(key);
      runLastUsed.set(
        run,
        Math.max(runLastUsed.get(run) ?? 0, entry.lastUsedAt),
      );
    }
    for (const [key, entry] of this.entries) {
      if (
        entry.session.alive &&
        (this.worksOffTurn(entry) ||
          (entry.session.shellsRunning > 0 &&
            now - (runLastUsed.get(runIdOfSessionKey(key)) ?? 0) <
              detachedForMs))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Every live CLI process one run holds — its own key and every `<runId>::…`
   * key under it, as {@link closeRun} reaches them — with the pid each was
   * spawned as. With no run, every live CLI process this daemon holds.
   *
   * The pid is the ROOT of attribution: it is the process this daemon spawned
   * for that run, so everything found under it in the process table is that
   * run's work by construction, never by matching a command line. Like
   * {@link peek}, reading does not refresh the idle clock — watching a chat's
   * processes is not using it.
   */
  processRoots(runId?: string): KeptProcessRoot[] {
    const prefix = runId === undefined ? null : runSessionKeyPrefix(runId);
    const roots: KeptProcessRoot[] = [];
    for (const [key, entry] of this.entries) {
      if (prefix !== null && key !== runId && !key.startsWith(prefix)) {
        continue;
      }
      const pid = entry.session.alive ? entry.session.pid : null;
      if (pid === null) {
        continue;
      }
      roots.push({ key, agent: entry.agent, cwd: entry.cwd, pid });
    }
    // Still the run's until it exits — see {@link closing}. `pid` reads null
    // once the CLI has exited.
    for (const [entry, key] of this.closing) {
      if (prefix !== null && key !== runId && !key.startsWith(prefix)) {
        continue;
      }
      const pid = entry.session.pid;
      if (pid !== null) {
        roots.push({ key, agent: entry.agent, cwd: entry.cwd, pid });
      }
    }
    return roots;
  }

  /**
   * Where a command one of this run's live processes launched runs, as its
   * session recorded it — empty while it runs with nothing recorded, null when
   * no live process of the run reports it running.
   */
  recordedGroupsOf(runId: string, callId: string): RecordedGroup[] | null {
    const prefix = runSessionKeyPrefix(runId);
    let groups: RecordedGroup[] | null = null;
    for (const [key, entry] of this.entries) {
      if ((key === runId || key.startsWith(prefix)) && entry.session.alive) {
        const own = entry.session.recordedGroupsOf(callId);
        if (own !== null) {
          groups = [...(groups ?? []), ...own];
        }
      }
    }
    return groups;
  }

  /**
   * This run's live process, or null when it holds none.
   *
   * Handed OUT rather than questioned here, because what to ask it is the
   * adapter's business and not this registry's — and because the answer to
   * "what is in the window" does not always need a process at all (cursor
   * reads its own store off disk). Callers must not hold on to it: it is
   * reaped by the idle window and by eviction.
   *
   * Deliberately does NOT touch `lastUsedAt`. Reading what a session is doing
   * is not using it, and refreshing the clock here would let an open readout
   * keep an abandoned chat's CLI — and its MCP servers — alive indefinitely.
   */
  peek(runId: string): AgentSession | null {
    const entry = this.entries.get(runId);
    return entry && entry.session.alive ? entry.session : null;
  }

  /**
   * Every live kept process, whichever run it serves, with the agent, folder
   * and profile it was spawned for. Like {@link peek}, reading does not refresh
   * the idle clock, and callers must not hold on to a session.
   */
  liveSessions(): KeptSession[] {
    const live: KeptSession[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.session.alive) {
        live.push({
          key,
          agent: entry.agent,
          cwd: entry.cwd,
          configDir: entry.configDir,
          session: entry.session,
        });
      }
    }
    return live;
  }

  subagentRecoveryBlocked(runId: string, id: string): boolean {
    const prefix = runSessionKeyPrefix(runId);
    return [...this.entries].some(
      ([key, entry]) =>
        (key === runId || key.startsWith(prefix)) &&
        entry.session.alive &&
        entry.session.subagentRecoveryBlocked?.(id) === true,
    );
  }

  /**
   * Whether the live session under `key` {@link holdsWork} — work of its own
   * that closing the process would stop.
   */
  holdsWorkFor(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && entry.session.alive && this.holdsWork(entry);
  }

  /** The CLI the live session under `key` runs, or null when it holds none. */
  agentOf(key: string): string | null {
    const entry = this.entries.get(key);
    return entry && entry.session.alive ? entry.agent : null;
  }

  onApplicationShutdown(): void {
    this.closeAll();
  }

  /**
   * Close every process on the way out. Idempotent.
   *
   * `ProcessRegistry` cancels the in-flight TURNS and drains them; this ends
   * the processes those turns were running on, which nothing else would. The
   * pidfile and instance-lock hooks call it too, after the drain: they run
   * before this module's own hook, and must not release while a kept process
   * is still running.
   */
  closeAll(): void {
    this.shuttingDown = true;
    // A graceful close still under way would outlive the daemon: `cursor-agent
    // acp` ignores EOF, and its deadline is a timer in this process.
    for (const [entry, key] of [...this.closing]) {
      this.escalate(key, entry);
    }
    for (const [runId, entry] of [...this.entries]) {
      this.closeEntry(runId, entry, 'the daemon is shutting down');
    }
  }

  /**
   * Drop an entry the moment its process dies, rather than waiting for someone
   * to try to use it.
   *
   * A dead session reports `idle === false` — it is not "alive with no turn in
   * flight" — and every reader here treats a non-idle entry as BUSY. So the
   * idle timer returns without closing it, and `evictIfFull` skips it while
   * still counting it against the ceiling. The consequence is inverted: a
   * genuinely live idle session gets chosen as `oldest` and closed instead,
   * respawning that run's CLI and re-booting the user's MCP servers — the exact
   * cost this whole feature exists to avoid.
   *
   * `closed` is the channel the session already exposes for this
   * (`CliSession.closed`), so nothing new had to be plumbed; it simply had no
   * subscriber on this side.
   *
   * An entry still registered when its `closed` lands is a process that ended
   * WITHOUT this registry closing it — every close here drops the entry first —
   * so this is also where the close listeners hear about a crash (see
   * {@link onClosed}).
   */
  private forgetWhenClosed(runId: string, entry: SessionEntry): void {
    void entry.session.closed.then(() => {
      // Only if it is still the registered one: a replaced entry's `closed`
      // arrives after its successor is in the map, and deleting then would
      // drop a live session. The same check is what keeps a close this
      // registry made from being announced twice — `closeEntry` has already
      // dropped the entry by the time the exit it caused lands here.
      if (this.entries.get(runId) !== entry) {
        return;
      }
      // Read BEFORE the entry is dropped, on `closeEntry`'s terms: a process
      // that died while writing rows between turns cut the agent off, one that
      // died after sitting quiet did not.
      const interrupted = this.worksOffTurn(entry);
      this.disarm(entry);
      this.entries.delete(runId);
      this.logger.log(`the agent session for run ${runId} ended on its own`);
      // A CLI that ended without its own shutdown left its detached commands
      // running; what was recorded of them is handed on to be stopped.
      const ended = entry.session.endedRunning;
      if (ended !== null && ended.running > 0) {
        this.oweStopped(
          runId,
          endedCommandsNote(ended.commands, ended.running),
        );
      }
      this.notifyLeftCommands(runId, ended);
      this.notifyClosed(
        runId,
        interrupted,
        true,
        entry.session.closeCause ?? null,
      );
    });
  }

  /** Re-arm the idle window once this turn settles. */
  private track(
    runId: string,
    entry: SessionEntry,
    handle: AgentTurnHandle,
  ): AgentTurnHandle {
    void handle.done.then(() => {
      // Only for the entry still registered under this run: a session replaced
      // while the old turn was settling must not re-arm a timer over its
      // successor.
      if (this.entries.get(runId) !== entry) {
        return;
      }
      entry.lastUsedAt = Date.now();
      this.noteUsed(runId);
      this.arm(runId, entry);
    });
    return handle;
  }

  /**
   * The CLI produced a row with no turn of ours open — restart the idle clock.
   *
   * `session.idle` means "alive with no turn of OURS in flight", which is
   * exactly true of a CLI running flat out between turns: a delegate reporting
   * back, a continuation the agent opened for itself. Without this the window
   * armed at the last settle simply runs out underneath live work — measured on
   * run 1fb3a9f5, a session reaped three seconds after its last row, thirty
   * minutes of continuous off-turn output having touched nothing here.
   *
   * Refreshes rather than arms, and only when a window is already running: with
   * a turn in flight there is deliberately no timer (`disarm`), and `track`
   * arms the next one when that turn settles.
   */
  private touchOffTurn(runId: string): void {
    const entry = this.entries.get(runId);
    if (!entry?.timer) {
      return;
    }
    entry.lastUsedAt = Date.now();
    entry.offTurnActiveAt = entry.lastUsedAt;
    this.noteUsed(runId);
    entry.timer.refresh();
  }

  /**
   * Is the process doing something closing it would stop, with no turn of ours
   * in flight — a parked question, off-turn work, or a command still running
   * (`shellsRunning`: detached, or a delegate's)? What
   * eviction will not take and a deferrable stale mark waits for.
   */
  private holdsWork(entry: SessionEntry): boolean {
    return (
      entry.session.parked ||
      this.worksOffTurn(entry) ||
      entry.session.shellsRunning > 0
    );
  }

  /**
   * Is this session carrying on by ITSELF — working, with no turn of ours open?
   *
   * The third thing eviction must not take, beside a turn in flight and a
   * parked question. See {@link OFF_TURN_ACTIVE_MS} for the run this was
   * measured on.
   */
  private worksOffTurn(entry: SessionEntry): boolean {
    return (
      entry.offTurnActiveAt > 0 &&
      Date.now() - entry.offTurnActiveAt < OFF_TURN_ACTIVE_MS
    );
  }

  /**
   * May this stale process serve the coming turn anyway? Only for a change
   * that may wait ({@link StaleCause}), and only while it {@link holdsWork}.
   */
  private mayKeepStale(entry: SessionEntry): boolean {
    return (
      entry.stale?.cause === 'mcp' &&
      entry.session.alive &&
      this.holdsWork(entry)
    );
  }

  /**
   * This turn's input carrying, in one note, the lines owed for commands a
   * close stopped and `deferred`'s, or the input itself when nothing is owed
   * or the turn cannot carry it.
   */
  private withOwedNotes(
    runId: string,
    input: AgentTurnInput,
    deferred?: string,
  ): AgentTurnInput {
    const lines = [
      ...owedKeys(runId).flatMap((key) => this.stopped.get(key)?.prompts ?? []),
      ...(deferred === undefined ? [] : [deferred]),
    ];
    return lines.length === 0
      ? input
      : withSessionNote(input, lines.join('\n\n'));
  }

  /** Owe this key's next turn `note` about the commands its process ran. */
  private oweStopped(runId: string, note: SessionNote): void {
    if (this.shuttingDown) {
      return;
    }
    const owed = this.stopped.get(runId) ?? { rows: [], prompts: [] };
    owed.rows.push(note.transcript);
    owed.prompts.push(note.prompt);
    this.stopped.set(runId, owed);
  }

  /**
   * A turn has opened: write the owed transcript rows, and forget the prompt
   * lines once one carried them. A turn that could not (a prompt-less resume)
   * leaves them for the next turn, which is the agent's first chance to read.
   */
  private tellStopped(
    runId: string,
    carried: boolean,
    onEvent: (event: AgentEvent) => void,
  ): void {
    for (const key of owedKeys(runId)) {
      const owed = this.stopped.get(key);
      if (owed === undefined) {
        continue;
      }
      for (const message of owed.rows) {
        onEvent({ type: 'notice', message, severity: 'warning' });
      }
      owed.rows = [];
      if (carried || owed.prompts.length === 0) {
        this.stopped.delete(key);
      }
    }
  }

  /**
   * Arm the idle reap on awake time.
   *
   * Time asleep is not a chat going unused, whether its process was working
   * between turns or the chat was merely left idle. What that costs: a chat
   * idle overnight keeps its CLI, and the MCP servers it dialled, for up to one
   * whole window of awake time after the wake.
   */
  private arm(runId: string, entry: SessionEntry): void {
    this.disarm(entry);
    entry.timer = awakeTimeout(() => {
      entry.timer = null;
      if (this.entries.get(runId) !== entry || !entry.session.idle) {
        return;
      }
      if (entry.session.shellsRunning > 0) {
        // Quiet is not unused when the process is serving something: a dev
        // server the agent started writes nothing for as long as it works,
        // and it dies with this process. Re-armed on the same terms as the
        // parked case below — the window resumes once the last one ends.
        this.arm(runId, entry);
        return;
      }
      if (entry.session.parked) {
        // The window measures a chat going UNUSED, and this one is not: the CLI
        // is standing still on a question the user has been shown and has not
        // answered. Closing it here is how a real run was lost — the CLI read
        // the close as a refusal of the question, wrote "the user doesn't want
        // to proceed", and the run was marked failed 22 minutes after anyone
        // had touched it.
        //
        // Re-armed rather than abandoned: the wait ends when they answer, and
        // nothing else would restart the clock before the next turn. So an
        // answered card leaves the session with at most one more full window,
        // and one never answered costs a process the user still has open — the
        // same bound an in-turn card already has, where Stop is the only end.
        this.arm(runId, entry);
        return;
      }
      void this.closeAfterFarewell(runId, entry);
    }, this.idleWindowMs);
  }

  private disarm(entry: SessionEntry): void {
    if (entry.timer) {
      entry.timer.clear();
      entry.timer = null;
    }
  }

  /**
   * Make room for one more process by closing a session that is not DOING
   * anything. A session with a turn in flight, one parked on a question, and
   * one carrying on by itself between turns are all exempt — evicting any of
   * them kills work the user is watching to make room for work they just asked
   * for — and so is an own conversation used within {@link RECENTLY_USED_MS}.
   */
  private evictIfFull(): void {
    this.dropUnusable();
    if (
      !this.evictWhile(
        () => this.entries.size >= this.ceiling,
        'the session ceiling was reached',
      )
    ) {
      // Going over the ceiling is the lesser harm: the alternative is refusing
      // a turn the user asked for, or killing one that is running or about to.
      this.logger.warn(
        `none of the ${this.entries.size} agent sessions can be closed (busy, or used in the last ${RECENTLY_USED_MS / 60_000} minutes) — starting another over the ${this.ceiling} ceiling`,
      );
    }
  }

  /** Close evictable sessions while `over` holds; false when none is left to close. */
  private evictWhile(over: () => boolean, reason: string): boolean {
    while (over()) {
      const victim = this.evictionCandidate(Date.now());
      if (victim === null) {
        return false;
      }
      this.closeEntry(victim[0], victim[1], reason);
    }
    return true;
  }

  /**
   * The session to close for room: idle callee conversations and sessions not
   * used within {@link RECENTLY_USED_MS} first — callees before own
   * conversations — then recently used callees, least recently used first in
   * each.
   */
  private evictionCandidate(now: number): [string, SessionEntry] | null {
    let best: [string, SessionEntry] | null = null;
    let bestRank = Number.POSITIVE_INFINITY;
    for (const candidate of this.entries) {
      const [key, entry] = candidate;
      // `parked` alongside `idle`, not folded into it: a session holding a
      // card the user is looking at is idle in the only sense `idle` claims
      // (no turn in flight) and busy in the sense that matters here. Evicting
      // it kills the question rather than the process — the CLI takes the
      // close as a refusal, and the user's answer arrives at nothing.
      // `worksOffTurn` alongside the two: a CLI writing rows between turns is
      // idle in the only sense `idle` claims and busy in the sense that
      // matters here, exactly as `parked` is. Reported as a thread that
      // "остановился и ничего не делает" — see {@link OFF_TURN_ACTIVE_MS}.
      if (!entry.session.idle || this.holdsWork(entry)) {
        continue;
      }
      const recent = now - entry.lastUsedAt < RECENTLY_USED_MS;
      const callee = callConversationOf(key) !== null;
      if (recent && !callee) {
        continue;
      }
      const rank = (recent ? 2 : 0) + (callee ? 0 : 1);
      if (
        rank < bestRank ||
        (rank === bestRank &&
          best !== null &&
          entry.lastUsedAt < best[1].lastUsedAt)
      ) {
        best = candidate;
        bestRank = rank;
      }
    }
    return best;
  }

  private dropUnusable(): void {
    // A dead session is not busy, whatever `idle` says about it. Dropping these
    // first is what stops one from occupying a slot forever and getting a LIVE
    // session evicted in its place — `closed` normally removes them, but a
    // process killed behind the registry's back (the cancel fallback's group
    // kill) may not have settled yet when the next turn arrives.
    for (const [runId, entry] of [...this.entries]) {
      if (!entry.session.alive) {
        this.closeEntry(runId, entry, 'its process was already gone');
      } else if (entry.session.retired) {
        // Alive, idle, and unable to serve a turn — the state a cancelled (or
        // deadline-ended) turn leaves behind. It has to be dropped HERE and not
        // merely skipped: its `lastUsedAt` was just refreshed, so it is the
        // NEWEST entry, and eviction would keep it and close a genuinely
        // reusable session instead — re-booting that run's MCP servers to make
        // room for a process nothing can use.
        this.closeEntry(runId, entry, 'it can no longer serve a turn');
      }
    }
  }

  /**
   * Let {@link onIdleFarewell} have its last word, then close — gracefully
   * (`SessionCloseOptions`): nothing is waiting on this process, so it may
   * finish on its own, and the group signal after it exits reaches what an MCP
   * server left behind. The only graceful close here.
   *
   * The entry stays in the map for the duration, which is what lets the
   * listener reach the process through {@link peek} — and is also why the state
   * is RE-CHECKED afterwards: a turn can arrive while the question is in
   * flight, and that turn's session must not be closed under it. Nothing is
   * re-armed in that case because `startTurn` disarmed this timer and the
   * turn's own settle arms the next window.
   */
  private async closeAfterFarewell(
    runId: string,
    entry: SessionEntry,
  ): Promise<void> {
    if (this.farewell) {
      try {
        await this.farewell(runId);
      } catch (err) {
        // A last reading is worth nothing next to the close it precedes: a
        // listener that throws must not leave the process running for ever.
        this.logger.warn(
          `the idle farewell for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (this.entries.get(runId) !== entry || !entry.session.idle) {
      return;
    }
    this.closeEntry(runId, entry, 'it went unused', true, undefined, {
      graceful: true,
    });
    this.idleExits.add(entry);
    void entry.session.closed.then(() => {
      const run = runIdOfSessionKey(runId);
      // Wall time since this key's own last use is at least its awake-time
      // window, so only another conversation of the run can fail this.
      if (
        this.idleExits.delete(entry) &&
        Date.now() - (this.runUsedAt.get(run) ?? 0) >= this.idleWindowMs
      ) {
        // Unused for the window, so its last use blocks nothing any more.
        this.runUsedAt.delete(run);
        this.notifyIdleClosed(run);
      }
    });
  }

  private noteUsed(key: string): void {
    const now = Date.now();
    // A use older than the window blocks no idle reap; forget it.
    for (const [run, at] of this.runUsedAt) {
      if (now - at >= this.idleWindowMs) {
        this.runUsedAt.delete(run);
      }
    }
    this.runUsedAt.set(runIdOfSessionKey(key), now);
  }

  /**
   * Turn a graceful close still under way into an immediate one — a signal to
   * the group now — and stop counting the process as {@link closing}, as an
   * immediate close never does.
   */
  private escalate(key: string, entry: SessionEntry): void {
    this.closing.delete(entry);
    this.idleExits.delete(entry);
    try {
      entry.session.close();
    } catch (err) {
      this.logger.warn(
        `failed to close the agent session for run ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * `tell` is whether a later turn on this key should hear which detached
   * commands the close stopped — every close but a teardown's, which leaves no
   * conversation to tell, a finished card's ({@link closeFinishedRun}), and
   * shutdown's.
   */
  private closeEntry(
    runId: string,
    entry: SessionEntry,
    reason: string,
    tell = true,
    explicitCause?: SessionCloseCause,
    options?: SessionCloseOptions,
  ): void {
    const cause = explicitCause ?? entry.session.closeCause ?? undefined;
    // Read BEFORE the entry is dropped and the timer disarmed — both are what
    // the answer is computed from.
    const interrupted = this.worksOffTurn(entry);
    const running = entry.session.detachedRunning;
    if (tell && running > 0) {
      // Read before the close, which is what empties them.
      this.oweStopped(
        runId,
        stoppedCommandsNote(reason, entry.session.runningCommands, running),
      );
    }
    this.disarm(entry);
    this.entries.delete(runId);
    if (options?.graceful === true) {
      this.closing.set(entry, runId);
      void entry.session.closed.then(() => this.closing.delete(entry));
    }
    try {
      entry.session.close(cause, options);
    } catch (err) {
      // One session that cannot be closed must not stop the others — this runs
      // in a loop on shutdown, where giving up would orphan every later
      // process.
      this.closeFailed.add(entry);
      this.logger.warn(
        `failed to close the agent session for run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.logger.log(`closed the agent session for run ${runId} — ${reason}`);
    this.notifyClosed(runId, interrupted, false, cause ?? null);
    // Once the process has ended: its own shutdown stops what it ran, and
    // only what that left behind is still anchored by then.
    void entry.session.closed.then(() =>
      this.notifyLeftCommands(runId, entry.session.endedRunning),
    );
  }

  private notifyIdleClosed(runId: string): void {
    if (this.shuttingDown) {
      return;
    }
    for (const listener of this.idleCloseListeners) {
      try {
        listener(runId);
      } catch (err) {
        this.logger.warn(
          `an idle-close listener for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private notifyLeftCommands(
    runId: string,
    left: StoppedCommands | null,
  ): void {
    if (this.shuttingDown || left === null || left.groups.length === 0) {
      return;
    }
    for (const listener of this.leftCommandListeners) {
      try {
        listener(runId, left);
      } catch (err) {
        this.logger.warn(
          `a left-commands listener for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Tell every {@link onClosed} listener that this run's process is gone —
   * the one place both ways out (a close here, a process ending by itself)
   * reach them, so the two cannot come to disagree about when a listener is
   * owed a call.
   */
  private notifyClosed(
    runId: string,
    interrupted: boolean,
    exited: boolean,
    cause: SessionCloseCause | null = null,
  ): void {
    if (this.shuttingDown) {
      return;
    }
    for (const listener of this.closeListeners) {
      try {
        listener(runId, interrupted, exited, cause);
      } catch (err) {
        // One listener's failure must not stop the others, and must never stop
        // a close: this runs inside `evictIfFull` and the teardown path, where
        // throwing would leave a process the registry has already forgotten.
        this.logger.warn(
          `a session-close listener for run ${runId} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Where a turn on `key` finds what it owes its agent: the key's own notes,
 * then its run's ({@link AgentSessionRegistry.oweRunNote}).
 */
function owedKeys(key: string): string[] {
  const runId = runIdOfSessionKey(key);
  return runId === key ? [key] : [key, runId];
}
