import { type DaemonApis, daemonErrorCode } from '../daemon-api';

/**
 * Whether the daemon refused a turn because the run's folder is not there.
 *
 * Read off the daemon's named code rather than its sentence (`cwd does not
 * exist: …`), for the reason `daemonErrorCode` gives: the sentence is prose,
 * and a folder whose own path contains the words would match it.
 */
export function isMissingCwdError(err: unknown): boolean {
  return daemonErrorCode(err) === 'INVALID_CWD';
}

/** What a send's run says about the folder it works in. */
export interface WorktreeRun {
  taskId: string | null;
  cwd: string | null;
}

/**
 * The card whose worktree a chat that is not the card's own may work in: a
 * worktree's folder is named after its task (`<userData>/worktrees/<taskId>`),
 * so its last segment is the only candidate, and the card's own record decides.
 */
function folderTaskCandidate(cwd: string | null): string | null {
  return cwd?.split('/').filter(Boolean).at(-1) ?? null;
}

/**
 * Put back the worktree a chat works in, so it can carry on.
 *
 * A task's worktree is collected once its card is Done and nothing is working
 * in it — but its chat is still an ordinary conversation, and so is any other
 * chat started in that folder: an analysis of the card's thread runs where the
 * thread worked. A message sent into either afterwards is refused `cwd does
 * not exist`, Apply included. The BRANCH outlives the directory by design,
 * so main cuts the same path again from it (`prepareWorktree` re-uses a branch
 * that exists) and every commit the agent made is there; when the follow-up
 * settles under the still-Done card, the daemon says the work is finished again
 * and the board collects it again.
 *
 * A run that is not the card's own is restored only when the card records that
 * very folder as its worktree. The folder is the one a Run press resolves: the
 * card's own, else its project's. False on ANY failure — the caller then shows
 * the daemon's own refusal, which is the true answer to what happened.
 */
export async function restoreRunWorktree(
  apis: Pick<DaemonApis, 'tasks' | 'projects'>,
  run: WorktreeRun,
): Promise<boolean> {
  const taskId = run.taskId ?? folderTaskCandidate(run.cwd);
  if (taskId === null) {
    return false;
  }
  try {
    const task = await apis.tasks.readTask({ taskId });
    if (run.taskId === null && task.worktreePath !== run.cwd) {
      return false;
    }
    const folder =
      task.folder ??
      (await apis.projects.readProject({ projectId: task.projectId })).folder;
    const made = await window.geniro.prepareTaskWorktree({ taskId, folder });
    return made.ok;
  } catch {
    return false;
  }
}

/**
 * Run `send`; when the daemon refuses it because the run's folder is gone, put
 * the worktree back and send ONCE more.
 *
 * Once, because the only refusal this answers is the one a restore can fix —
 * a second refusal after a successful restore is some other problem, and the
 * caller shows it. A chat whose folder is no card's worktree has nothing of
 * geniro's to restore, so its refusal is rethrown untouched.
 *
 * `onRestoring` is told when the restore starts: cutting the worktree again can
 * take seconds, and the send is held for all of them.
 */
export async function sendRestoringWorktree<T>(
  send: () => Promise<T>,
  run: WorktreeRun | null,
  restore: (run: WorktreeRun) => Promise<boolean>,
  onRestoring: () => void = () => {},
): Promise<T> {
  try {
    return await send();
  } catch (err: unknown) {
    if (run === null || !isMissingCwdError(err)) {
      throw err;
    }
    onRestoring();
    if (!(await restore(run))) {
      throw err;
    }
    return send();
  }
}
