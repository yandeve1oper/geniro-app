import type { GraphThread } from './graph-view';
import {
  THREAD_STATUS_TEXT,
  type ThreadAttention,
  type ThreadCardStatus,
} from './thread-card';

export const FIXTURE_NOW = Date.parse('2026-11-17T12:00:00Z');

const STATUSES: ThreadCardStatus[] = ['working', 'waiting', 'idle', 'failed'];

const ATTENTION_OF: Record<ThreadCardStatus, ThreadAttention> = {
  working: 'working',
  waiting: 'question',
  idle: 'quiet',
  failed: 'blocked',
  done: 'quiet',
};

const HOUR = 60 * 60_000;

const TITLES = [
  'Fix the login redirect',
  'Rebase billing on main',
  'Cache warmup',
  'Release notes',
  'Rename the settings page',
  'Wire the start conductor',
];

/**
 * Synthetic threads for the graph's stories and specs: statuses in turn, every
 * second one works a board card, every fifth has gone still for days.
 */
export function graphThreadsOf(count: number): GraphThread[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const status = STATUSES[index % STATUSES.length]!;
    const still = index % 5 === 4;
    return {
      id: `thread-${n}`,
      createdAt: new Date(FIXTURE_NOW - (count - index) * 60_000).toISOString(),
      view: {
        title: TITLES[index % TITLES.length]!,
        status,
        statusText: THREAD_STATUS_TEXT[status],
        attention: still ? 'inactive' : ATTENTION_OF[status],
        project: index % 2 === 0 ? 'QA Billing' : 'QA Cache',
        agentLabel: index % 4 === 3 ? 'dev-team' : 'claude',
        isTeam: index % 4 === 3,
        crew:
          index % 4 === 3
            ? {
                people: [
                  { key: 'lead', name: 'Nick Fury', avatar: null },
                  { key: 'senior', name: 'Tony Stark', avatar: null },
                  { key: 'qa', name: 'Thanos', avatar: null },
                ],
                total: 5,
              }
            : null,
        pullRequest:
          index % 3 === 0 ? { number: 400 + n, state: 'open' } : null,
        note: index === 1 ? 'waits for billing API v2' : null,
        lastMessage:
          index % 2 === 0
            ? 'Rebased on **main** and re-ran the suite; two flaky specs left, looking at them now'
            : index % 3 === 0
              ? 'Done — PR is up'
              : null,
        boardCard:
          index % 2 === 0
            ? {
                identifier: `QA-${n}`,
                title: `${TITLES[index % TITLES.length]!} card`,
                status: 'in_progress',
              }
            : null,
        idleDays: still ? 6 : null,
        lastAt: new Date(
          FIXTURE_NOW - (still ? 6 * 24 * HOUR : (index + 1) * 0.1 * HOUR),
        ).toISOString(),
        now: FIXTURE_NOW,
      },
    };
  });
}
