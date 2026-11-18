import { describe, expect, it } from 'vitest';

import {
  STATUS_SUFFIX_LINE_MAX,
  STATUS_SUFFIX_MAX_LINES,
} from '../command-center.types';
import { composeStatusSuffix, type StatusLine } from './status-suffix';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function line(over: Partial<StatusLine> = {}): StatusLine {
  return {
    handle: 't1',
    column: 'working',
    pullRequest: null,
    lastActivityAt: NOW - 3 * MINUTE,
    awaitingReply: false,
    ...over,
  };
}

function lastActivityPhrase(ms: number): string {
  return composeStatusSuffix([line({ lastActivityAt: NOW - ms })], NOW)!.split(
    '\n',
  )[1]!;
}

describe('composeStatusSuffix', () => {
  it('composes nothing for an empty roster', () => {
    expect(composeStatusSuffix([], NOW)).toBeNull();
  });

  it('states one thread’s column, pull request, activity and the reply it waits for', () => {
    expect(
      composeStatusSuffix(
        [
          line({
            handle: 't2',
            column: 'waiting',
            pullRequest: 42,
            lastActivityAt: null,
            awaitingReply: true,
          }),
        ],
        NOW,
      ),
    ).toBe(
      '[command center] Thread status now:\n- t2 · waiting on the user · PR #42 · no activity yet · you await its reply',
    );
  });

  it('gives each column its word', () => {
    const words = (
      ['working', 'waiting', 'idle', 'in_review', 'done'] as const
    ).map(
      (column) =>
        composeStatusSuffix([line({ column, lastActivityAt: null })], NOW)!
          .split('\n')[1]!
          .split(' · ')[1],
    );

    expect(words).toEqual([
      'working',
      'waiting on the user',
      'idle',
      'in review',
      'done',
    ]);
  });

  it('gives the age of the last activity in minutes, then hours, then days', () => {
    expect(lastActivityPhrase(0)).toMatch(/last activity 0m ago$/);
    expect(lastActivityPhrase(59 * MINUTE)).toMatch(/last activity 59m ago$/);
    expect(lastActivityPhrase(2 * HOUR)).toMatch(/last activity 2h ago$/);
    expect(lastActivityPhrase(47 * HOUR)).toMatch(/last activity 47h ago$/);
    expect(lastActivityPhrase(49 * HOUR)).toMatch(/last activity 2d ago$/);
  });

  it('lists at most STATUS_SUFFIX_MAX_LINES threads, then a count of the rest', () => {
    const total = STATUS_SUFFIX_MAX_LINES + 5;
    const lines = Array.from({ length: total }, (_, index) =>
      line({ handle: `t${index + 1}` }),
    );

    const text = composeStatusSuffix(lines, NOW)!.split('\n');

    expect(text).toHaveLength(1 + STATUS_SUFFIX_MAX_LINES + 1);
    expect(text[STATUS_SUFFIX_MAX_LINES]).toMatch(/^- t40 · /);
    expect(text.at(-1)).toBe('- …and 5 more threads');
  });

  it('caps each line at STATUS_SUFFIX_LINE_MAX characters, ending with an ellipsis', () => {
    const text = composeStatusSuffix(
      [line({ handle: 'x'.repeat(STATUS_SUFFIX_LINE_MAX + 40) })],
      NOW,
    )!.split('\n');

    const content = text[1]!.slice(2);
    expect(content).toHaveLength(STATUS_SUFFIX_LINE_MAX);
    expect(content.endsWith('…')).toBe(true);
  });
});
