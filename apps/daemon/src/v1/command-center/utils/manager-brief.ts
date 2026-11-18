import {
  HOST_NOTE_THREAD_TOOL,
  HOST_START_THREAD_TOOL,
  HOST_TELL_THREADS_TOOL,
  TELL_THREADS_MAX_TARGETS,
} from '../../agents/chat.types';
import type { RosterReason } from '../command-center.types';

/** One roster line of the manager's brief. */
export interface RosterBriefLine {
  handle: string;
  title: string;
  project: string | null;
  reason: RosterReason;
  note: string | null;
}

const REASON_WORDS: Record<RosterReason, string> = {
  auto: 'active',
  manager: 'started by you',
  user: 'added by the user',
};

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The command center manager's standing brief: its job, its tools, and the
 * roster of threads it manages. It is the chat's `teamInstructions`, part of
 * the CLI session's identity, so it holds only what changes when the roster
 * does — statuses ride each turn's prompt instead (`composeStatusSuffix`).
 * The same roster always composes the same text.
 */
export function composeManagerBrief(
  roster: readonly RosterBriefLine[],
): string {
  const lines = roster.map((entry) =>
    [
      entry.handle,
      clean(entry.title),
      entry.project === null ? 'no project' : clean(entry.project),
      REASON_WORDS[entry.reason],
      entry.note === null ? null : `note: ${clean(entry.note)}`,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  );
  return [
    '# You are the command center manager',
    '',
    "You are the user's one point of control over every thread working in this app. Each thread is another agent or team doing a separate task. You watch them, pass the user's instructions on to them, coordinate them with each other, and start new threads when asked.",
    '',
    '## How to work',
    '',
    `- The user writes to you in plain words and never picks threads. Work out which threads they mean from the roster below (titles, projects, your notes) and the status table each message carries. When you cannot tell which threads they mean, ask back with the candidates instead of guessing: a word that fits more than one roster title ("billing" with two billing threads) is unclear even if one of them came up recently, so ask before sending.`,
    `- Reach threads with \`${HOST_TELL_THREADS_TOOL}\`: one call sends the same message to 1–${TELL_THREADS_MAX_TARGETS} of them, named by handle (t3). If any name is ambiguous or unknown nothing is sent, and the answer lists the candidates. Leave \`expect_reply\` on when you need an answer: each thread's first reply then reaches you even past your usual wake budget.`,
    `- Keep one note per thread with \`${HOST_NOTE_THREAD_TOOL}\` — why it matters, what it is waiting on, what you told it. Notes are part of this roster and survive compaction.`,
    `- Start a new thread with \`${HOST_START_THREAD_TOOL}\`: it files a task card with its own worktree and branch. Outside \`auto\` the user approves it with a Start card first; you are told when it has started.`,
    '- Coordinate merges, conflicts and hand-offs by talking to the threads involved; nothing watches pull requests for you.',
    '- You do no coding yourself. Report back to the user briefly: what you sent where, and what came back.',
    '',
    '## Roster',
    '',
    lines.length === 0
      ? 'No threads are active right now.'
      : lines.map((line) => `- ${line}`).join('\n'),
  ].join('\n');
}
