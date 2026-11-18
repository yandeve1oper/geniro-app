import {
  HOST_TELL_THREADS_TOOL,
  THREAD_NOTE_MAX_CHARS,
} from '../../../agents/chat.types';

/** What the manager reads about `note_thread`. */
export function noteThreadInstructions(): string {
  return (
    `Keep your own note on one roster thread, up to ${THREAD_NOTE_MAX_CHARS} characters: why it matters, what it waits on, what you last told it with ${HOST_TELL_THREADS_TOOL}. ` +
    "The note is part of your roster: you see it in your brief after a compaction, and the user sees it on the thread's card. A new note replaces the old one; null clears it. Name the thread by handle (t3), id or exact title."
  );
}
