import {
  HOST_NOTE_THREAD_TOOL,
  HOST_TELL_THREADS_TOOL,
  TELL_THREADS_MAX_TARGETS,
} from '../../../agents/chat.types';

/** What the manager reads about `tell_threads`. */
export function tellThreadsInstructions(): string {
  return (
    `Send one plain-text message to 1–${TELL_THREADS_MAX_TARGETS} threads on your roster in a single call — an instruction from the user, a coordination step such as "rebase on main after billing merges", a question. ` +
    'Name each thread by its roster handle (t3), its id, or its exact title; a word that fits two titles is ambiguous. When any name is ambiguous or matches no roster thread, NOTHING is sent: the answer lists each unresolved name with its candidates — ask the user which they meant instead of guessing. ' +
    'For each thread the answer says what happened: `joined` its running turn, `woken` as a turn of its own, `waiting` with a reason, or `refused` with a code. ' +
    "Leave `expect_reply` on when you need an answer: each thread's first reply then reaches you even past your wake budget, within 2 hours. " +
    `The threads read your text as a message from another agent, not their user's words. Record why you wrote to a thread with ${HOST_NOTE_THREAD_TOOL}. Use ${HOST_TELL_THREADS_TOOL} for every message to a thread; it is your only way to reach them.`
  );
}
