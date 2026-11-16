import {
  HOST_MEMORY_FORGET_TOOL,
  HOST_MEMORY_READ_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `memory_feedback`. */
export function memoryFeedbackInstructions(): string {
  return (
    'Say how a shared memory entry served you in this task, so later agents keep what helps and ' +
    `lose what does not. Mark only an entry you actually relied on or found wrong here — one listed ` +
    `in your memory index or returned by ${HOST_MEMORY_READ_TOOL} in this run: \`helped\` when ` +
    'following it saved you work or a mistake, `misleading` when following it led you wrong, ' +
    '`not_useful` when it did not apply or is stale. Give the reason in one line — the user reads ' +
    'it. One mark per entry per thread: a later mark replaces yours. Entries several threads mark ' +
    'not useful are forgotten on their own, restorable by the user. Do NOT use it to tidy up ' +
    `memory, for entries you never read, or for one you verified wrong — retire that with ` +
    `${HOST_MEMORY_FORGET_TOOL}.`
  );
}
