import { HOST_TELL_THREADS_TOOL } from '../../../agents/chat.types';

/** What the manager reads about `start_thread`. */
export function startThreadInstructions(): string {
  return (
    "Start a new thread for a task: it files a card on the project's task board with its own worktree and branch, and starts it there. Use it when the user asks for new work, or when work you coordinate needs a thread of its own. " +
    "Give the project (id or exact name), a short title, and a brief — what the thread is to do, which becomes the card's description. `agent` or `team` pick what runs it; the project's default otherwise. " +
    'Outside `auto` the user approves the start with a Start card first (`card_shown`); in `auto` it starts at once (`starting`). Either way you are told when the thread has started and is on your roster, or why it could not start. ' +
    `Do not use it to message an existing thread — use ${HOST_TELL_THREADS_TOOL}.`
  );
}
