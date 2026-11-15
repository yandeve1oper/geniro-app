import {
  HOST_KNOWLEDGE_SEARCH_TOOL,
  HOST_SEARCH_CHATS_TOOL,
} from '../../../agents/chat.types';

/** What a model reads about `memory_search`. */
export function memorySearchInstructions(): string {
  return (
    'Search the memory every agent shares across Claude Code, Codex and Cursor: durable notes about ' +
    "the user, their preferences and corrections, this project's conventions and decisions, and where " +
    'things live. Search it by default at the start of any non-trivial task in this project, before ' +
    'you plan or change anything. Skip it only for a request that stands on its own, such as the ' +
    'current date, a plain translation, or a question with nothing to do with this project. If you are ' +
    "unsure, run one quick search. Use one or two short queries on the task's area and the tools you " +
    'will touch; with no match, carry on with the task. Search again when something fails in a way you ' +
    'did not expect, and before you ask the user a question or pick a convention on a guess — another ' +
    "agent may already have recorded the answer. It returns each entry's handle (`m12`), revision, " +
    'scope (global, this project or this team) and an excerpt; read the whole entry with memory_read. ' +
    'Entries saved by other agents during your conversation appear here too. ' +
    `Do NOT use it to search past conversations — ${HOST_SEARCH_CHATS_TOOL} does that — nor for the long guides the user keeps — ${HOST_KNOWLEDGE_SEARCH_TOOL} does that.`
  );
}
