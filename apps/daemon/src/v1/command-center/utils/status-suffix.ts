import {
  type CommandCenterColumn,
  STATUS_SUFFIX_LINE_MAX,
  STATUS_SUFFIX_MAX_LINES,
} from '../command-center.types';

/** One managed thread as the status table states it. */
export interface StatusLine {
  handle: string;
  column: CommandCenterColumn;
  pullRequest: number | null;
  /** Epoch ms of its last activity, or null. */
  lastActivityAt: number | null;
  awaitingReply: boolean;
}

const COLUMN_WORDS: Record<CommandCenterColumn, string> = {
  working: 'working',
  waiting: 'waiting on the user',
  idle: 'idle',
  in_review: 'in review',
  done: 'done',
};

function ago(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function capped(line: string): string {
  return line.length > STATUS_SUFFIX_LINE_MAX
    ? `${line.slice(0, STATUS_SUFFIX_LINE_MAX - 1)}…`
    : line;
}

/**
 * The status table appended to every manager turn's prompt — what changes too
 * often for the brief. Times are relative to `now`, so the agent never has to
 * reason about clocks. At most {@link STATUS_SUFFIX_MAX_LINES} threads, then a
 * count of the rest.
 */
export function composeStatusSuffix(
  lines: readonly StatusLine[],
  now: number,
): string | null {
  if (lines.length === 0) {
    return null;
  }
  const shown = lines
    .slice(0, STATUS_SUFFIX_MAX_LINES)
    .map((line) =>
      capped(
        [
          line.handle,
          COLUMN_WORDS[line.column],
          line.pullRequest === null ? null : `PR #${line.pullRequest}`,
          line.lastActivityAt === null
            ? 'no activity yet'
            : `last activity ${ago(now - line.lastActivityAt)}`,
          line.awaitingReply ? 'you await its reply' : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' · '),
      ),
    );
  const rest = lines.length - shown.length;
  return [
    '[command center] Thread status now:',
    ...shown.map((line) => `- ${line}`),
    ...(rest > 0 ? [`- …and ${rest} more threads`] : []),
  ].join('\n');
}
