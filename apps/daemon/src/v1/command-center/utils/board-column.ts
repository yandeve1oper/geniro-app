import type { RunWire } from '../../agents/chat.types';
import type { TaskStatus } from '../../tasks/tasks.types';
import type { CommandCenterColumn } from '../command-center.types';

/**
 * The board column a thread sits in. In order: waiting on the user, working,
 * done (its card is Done or the thread recorded how it ended), in review (its
 * card is In review, or it opened a pull request and nothing runs), idle.
 * A thread with no card is placed by its pull requests and outcome alone.
 */
export function boardColumnOf(
  run: Pick<RunWire, 'status' | 'awaiting' | 'outcome' | 'pullRequests'>,
  taskStatus: TaskStatus | null,
): CommandCenterColumn {
  if (run.awaiting !== null) {
    return 'waiting';
  }
  if (run.status === 'running') {
    return 'working';
  }
  if (taskStatus === 'done' || run.outcome !== null) {
    return 'done';
  }
  if (
    taskStatus === 'in_review' ||
    run.pullRequests.some((pullRequest) => pullRequest.opened)
  ) {
    return 'in_review';
  }
  return 'idle';
}
