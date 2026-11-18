import {
  type DaemonHandle,
  type GitStamp,
  runSettingsOf,
  type Settings,
} from '../shared/contracts';
import { gitFailureLine } from './git-failure';

/** How long any one daemon call may take before its caller gives up on it. */
const DAEMON_CALL_TIMEOUT_MS = 10_000;

/**
 * The longest failure reason the daemon takes.
 *
 * TWIN PARSER: `reportPrepareFailureSchema` in
 * `apps/daemon/src/v1/tasks/dto/task.dto.ts` (`reason` `.max`), which the
 * command-center starts route shares. Cut here so a long git line is never
 * refused; change one and change the other.
 */
export const MAX_PREPARE_FAILURE_CHARS = 1000;

/** How much of an unparseable error body one log line may carry. */
const MAX_DETAIL_CHARS = 300;

/**
 * The daemon refusals that mean ANOTHER start of the same card holds it — the
 * two the task-run route answers when a second start arrives while a first is
 * in flight or its agent is at work.
 *
 * TWIN: `apps/daemon/src/v1/tasks/services/task-runs.service.ts` throws them
 * (`start`, `assertNotAlreadyRunning`), and
 * `apps/ui/src/renderer/tasks/use-board.ts` reads the same pair. Spelled once
 * per side because this process imports no daemon source.
 */
const ANOTHER_START_HOLDS_IT: ReadonlySet<string> = new Set([
  'TASK_RUN_STARTING',
  'TASK_ALREADY_RUNNING',
]);

export interface Worktree {
  path: string;
  branch: string;
  reused: boolean;
}

/** The card a run is started for, as the daemon hands it out. */
export interface RunTask {
  taskId: string;
  title: string;
  status: string;
  /**
   * Where to cut the worktree from, ALREADY RESOLVED by the daemon against the
   * project's folder. Read as given: the inheritance rule belongs to the
   * process that holds both rows.
   */
  folder: string;
}

/**
 * Who starts the run. An autopilot start names its approval mode; a start
 * made by the command center names none, so the user's and the project's own
 * default applies.
 */
export interface RunStarter {
  startedBy: 'autopilot' | 'manager';
  approval?: string;
}

export interface RunStartDeps {
  /** Make the worktree and branch this task will be worked in. */
  prepareWorktree: (input: {
    taskId: string;
    folder: string;
  }) => Promise<Worktree>;
  /** Give a worktree back when the run could not be started. */
  discardWorktree: (taskId: string) => Promise<unknown>;
  /**
   * The commit a worktree stands on and whether it is dirty, sent with the
   * start as a hand-pressed Run sends it — without it the run has no "changed
   * since this chat started" view, and an unattended run is the one whose
   * changes nobody watched being made.
   */
  gitStamp: (dir: string) => Promise<GitStamp>;
  /**
   * The user's per-CLI switches, read fresh per start — the run snapshots them,
   * exactly as a hand-pressed Run does.
   */
  agentOptions: () => Settings['agentOptions'];
  /**
   * The user's standing instructions to every agent, read fresh per start and
   * sent when non-blank — the rule a hand-pressed Run follows, so a card runs
   * under the same instructions whoever pressed it.
   */
  customInstructions: () => Settings['customInstructions'];
  /** The reply language, read and sent on the same terms. */
  replyLanguage: () => Settings['replyLanguage'];
  fetchTimeoutMs?: number;
}

export type PreparedWorktree =
  { ok: true; worktree: Worktree } | { ok: false; gitLine: string };

/**
 * Make the worktree a run is started in. A failure is returned, not thrown,
 * because what the caller does with it — report it, log it — differs.
 */
export async function prepareRunWorktree(
  deps: RunStartDeps,
  task: Pick<RunTask, 'taskId' | 'folder'>,
): Promise<PreparedWorktree> {
  try {
    const worktree = await deps.prepareWorktree({
      taskId: task.taskId,
      folder: task.folder,
    });
    return { ok: true, worktree };
  } catch (error) {
    // Never empty: the daemon refuses an empty reason, and a refused report
    // leaves the card taking the slot again.
    const gitLine =
      gitFailureLine(error, messageOf(error)).trim() ||
      'git failed without saying why';
    return { ok: false, gitLine };
  }
}

/**
 * Post the run that starts the card in its prepared worktree. Throws the
 * daemon's refusal as a {@link DaemonRefusal}.
 */
export async function startRunOn(
  deps: RunStartDeps,
  handle: DaemonHandle,
  task: RunTask,
  worktree: Worktree,
  starter: RunStarter,
): Promise<void> {
  const runSettings = runSettingsOf({
    customInstructions: deps.customInstructions(),
    replyLanguage: deps.replyLanguage(),
    agentOptions: deps.agentOptions(),
  });
  // A reading that fails costs the run its changes view, never its start.
  const stamp = await deps.gitStamp(worktree.path).catch(() => null);
  await daemonPost(
    handle,
    `/v1/tasks/${encodeURIComponent(task.taskId)}/runs`,
    {
      cwd: worktree.path,
      branch: worktree.branch,
      from: task.status,
      ...(starter.approval === undefined ? {} : { approval: starter.approval }),
      startedBy: starter.startedBy,
      // The same snapshot a hand-pressed Run takes.
      ...runSettings,
      startSha: stamp?.sha ?? undefined,
      startDirty: stamp?.dirty ?? undefined,
    },
    deps.fetchTimeoutMs,
  );
}

/** Tell the daemon a card's worktree could not be made or its start refused. */
export async function reportFailure(
  deps: RunStartDeps,
  handle: DaemonHandle,
  path: string,
  line: string,
): Promise<void> {
  await daemonPost(
    handle,
    path,
    { reason: line.slice(0, MAX_PREPARE_FAILURE_CHARS) },
    deps.fetchTimeoutMs,
  );
}

/**
 * Whether a worktree THIS tick made may go back after its start was refused.
 *
 * Making it is not the same as being its only user. A task's worktree lives
 * at ONE path per task, so a person pressing Run on the same card a moment
 * later is handed this very directory as `reused` — and when that start is
 * the one the daemon took, this refusal is the loser's, and removing a clean
 * tree here takes the cwd out from under the agent the winner just started.
 * So the daemon is asked. A refusal naming another start of the card
 * ({@link ANOTHER_START_HOLDS_IT}) keeps it outright: that start may not
 * have moved the card yet. Otherwise the card is read, and one now in
 * `in_progress` is being worked. A card that is GONE holds nothing; any
 * other failure to read it keeps the worktree — a stray costs disk, a wrong
 * guess costs an agent its working directory.
 *
 * TWIN: `renderer/tasks/use-board.ts` asks the same question after a refused
 * press — main and the renderer share no code for it.
 */
export async function mayGiveBack(
  deps: RunStartDeps,
  handle: DaemonHandle,
  taskId: string,
  refusal: unknown,
): Promise<boolean> {
  if (
    refusal instanceof DaemonRefusal &&
    refusal.code !== null &&
    ANOTHER_START_HOLDS_IT.has(refusal.code)
  ) {
    return false;
  }
  try {
    const card = await daemonRead<{ status?: unknown }>(
      handle,
      `/v1/tasks/${encodeURIComponent(taskId)}`,
      deps.fetchTimeoutMs,
    );
    return card.status !== 'in_progress';
  } catch (error) {
    return error instanceof DaemonRefusal && error.status === 404;
  }
}

/**
 * A call the daemon answered with an error status — its message the log line,
 * and its status and `code` kept apart so a caller can branch on them rather
 * than on the wording.
 */
export class DaemonRefusal extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function daemonRead<T>(
  handle: DaemonHandle,
  path: string,
  timeoutMs: number = DAEMON_CALL_TIMEOUT_MS,
): Promise<T> {
  const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
    headers: { authorization: `Bearer ${handle.token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw await refusalOf('GET', path, res);
  }
  return (await res.json()) as T;
}

export async function daemonPost(
  handle: DaemonHandle,
  path: string,
  body: unknown,
  timeoutMs: number = DAEMON_CALL_TIMEOUT_MS,
): Promise<void> {
  const res = await fetch(`http://${handle.host}:${handle.port}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw await refusalOf('POST', path, res);
  }
}

/**
 * What a refused call actually said.
 *
 * The status code alone was all this logged, and it is not enough to act on:
 * `autopilot did not start "Feedback": POST … answered 400` was the ONLY record
 * of a project with no agent configured, repeated every twenty seconds for
 * hours. The daemon's refusals carry a `code` and a sentence written for the
 * user (`ValidationException` and friends put both in the body), so reading it
 * turns the same line into one naming the cause.
 *
 * Best-effort by construction: an unreadable or empty body degrades to the
 * status code, which is exactly what was logged before. Failing to read the
 * body must never become a second failure on top of the one being reported.
 */
async function refusalOf(
  method: string,
  path: string,
  res: Response,
): Promise<DaemonRefusal> {
  // Inside the chain, so even a `text` that throws synchronously degrades to
  // the status code: the refusal must come back whatever the body did.
  const body = await Promise.resolve()
    .then(() => res.text())
    .then((text) => bodyOf(text))
    .catch(() => null);
  const line =
    body === null
      ? `${method} ${path} answered ${res.status}`
      : `${method} ${path} answered ${res.status}: ${body.detail}`;
  return new DaemonRefusal(line, res.status, body?.code ?? null);
}

/**
 * The human half of a daemon error body, and the code beside it.
 *
 * The shape is the vendored exception filter's (`{statusCode, code, message}`),
 * and it is read defensively rather than typed: this runs in the Electron main
 * process, which shares no code with the daemon and holds none of its
 * generated types, so the body is untrusted JSON. `errorCode`/`description`
 * are read as well, the exception's own field names. A body that is not the
 * expected shape falls back to its own text, trimmed to something a log line
 * can hold.
 */
function bodyOf(body: string): { detail: string; code: string | null } | null {
  const text = body.trim();
  if (text === '') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      const row = parsed as Record<string, unknown>;
      const message =
        typeof row.description === 'string'
          ? row.description
          : typeof row.message === 'string'
            ? row.message
            : null;
      const code =
        typeof row.code === 'string'
          ? row.code
          : typeof row.errorCode === 'string'
            ? row.errorCode
            : null;
      if (message !== null) {
        return {
          detail: code === null ? message : `${code} — ${message}`,
          code,
        };
      }
    }
  } catch {
    // Not JSON: the raw text below is the best that can be said.
  }
  return {
    detail:
      text.length > MAX_DETAIL_CHARS
        ? `${text.slice(0, MAX_DETAIL_CHARS)}…`
        : text,
    code: null,
  };
}
