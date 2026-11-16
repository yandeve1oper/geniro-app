import { CALL_MODES } from '../../../teams/teams.types';
import { COLD_RESUME_CONTEXT_PERCENT } from '../../../teams/utils/prompt-cache-standing';
import { MAX_CALL_TITLE_LENGTH } from './call-agent.reader';

/** `call_agent`'s arguments. */
export function callAgentSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description:
          'The callee — its member id or display name from your "May call" list.',
      },
      message: {
        type: 'string',
        description:
          'The task for the callee. Without `thread` it starts a FRESH conversation seeing only this text (plus its own instructions) — include all context it needs.',
      },
      title: {
        type: 'string',
        description: `A short, human-readable reason for this call — WHY you are making it (e.g. "Get concrete UAT links from the DB"), shown to the user on the call's card. Not the task itself. At most ${MAX_CALL_TITLE_LENGTH} characters.`,
      },
      thread: {
        type: 'string',
        description: `Optional: a previous call_id of YOUR call to this same agent — the callee CONTINUES its latest session with its full memory. If its pool member becomes unavailable, another member may continue in a fresh session with the original task and recent transcript; older details may be omitted. Omit to start a new thread. Before continuing a conversation, above all after a pause, check it with list_agent_threads: it reports each conversation's context size in tokens and as a percent of its model's window, and where its prompt cache stands. One whose prompt cache has EXPIRED and whose context is over ${COLD_RESUME_CONTEXT_PERCENT}% full is refused (CACHE_EXPIRED) unless you pass resume_cold, because resuming it re-bills the whole context uncached.`,
      },
      resume_cold: {
        type: 'boolean',
        description:
          'Optional, with `thread`: continue the conversation even though its cache has expired and its context is large. Only when its history is worth re-billing in full; otherwise start a new instance.',
      },
      mode: {
        type: 'string',
        enum: [...CALL_MODES],
        description:
          'async (preferred) returns a call_id at once — keep working or end your turn, you are notified when it finishes or asks, then collect it with await_agent; sync (the default when omitted) blocks until the result; fire_and_forget never returns a result.',
      },
      member: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional, only when the user requests a specific member of an "agent pool" (CLI, model, or account): its member number. The call starts on that member and still falls back to the next available member when it hits a usage limit or is signed out; the conversation returns to it once it is available again, and a thread keeps it as its preferred member. Otherwise omit to use the first available member in priority order. A thread starts on the member holding its latest session and may fall back.',
      },
    },
    required: ['agent', 'message', 'title'],
  };
}
