import type { TimelineEvent } from './timeline-panel';

export const TIMELINE_FIXTURE_NOW = new Date('2026-11-17T12:00:00').getTime();

const LOGIN = {
  threadRunId: 'run-login',
  threadTitle: 'Fix the login redirect',
};
const RELEASE = { threadRunId: 'run-release', threadTitle: 'Release notes' };
const BILLING = { threadRunId: 'run-billing', threadTitle: 'Billing export' };
const SESSIONS = {
  threadRunId: 'run-sessions',
  threadTitle: 'Migrate sessions',
};

function event(
  id: string,
  kind: TimelineEvent['kind'],
  when: string,
  over: Partial<Omit<TimelineEvent, 'id' | 'kind' | 'at'>> = {},
): TimelineEvent {
  return {
    id,
    kind,
    at: new Date(when).toISOString(),
    threadRunId: null,
    threadTitle: null,
    text: null,
    detail: null,
    awaitingReply: false,
    ...over,
  };
}

export function timelineFixtures(): TimelineEvent[] {
  return [
    event('evt-01', 'manager_message', '2026-11-17T11:58:00', {
      ...LOGIN,
      text: 'Asked the login thread to rebase onto main before the review.',
      awaitingReply: true,
    }),
    event('evt-02', 'thread_message', '2026-11-17T11:41:00', {
      ...LOGIN,
      text: 'Rebased, tests green. Ready for review.',
    }),
    event('evt-03', 'pull_request', '2026-11-17T11:30:00', {
      ...LOGIN,
      detail: '418',
    }),
    event('evt-04', 'stage', '2026-11-17T10:50:00', {
      ...RELEASE,
      detail: 'review',
    }),
    event('evt-05', 'question', '2026-11-17T10:12:00', {
      ...BILLING,
      text: 'Should the export include archived invoices?',
    }),
    event('evt-06', 'user_message', '2026-11-17T09:40:00', {
      text: 'Can you check whether the billing export has a row limit?',
    }),
    event('evt-07', 'approval', '2026-11-17T09:03:00', {
      ...BILLING,
      text: 'Allow running the export check against the staging database?',
    }),
    event('evt-08', 'start_requested', '2026-11-17T08:15:00', {
      threadTitle: 'Wire the thread-start conductor',
      text: 'GEN-417 · Conductor',
    }),
    event('evt-09', 'thread_started', '2026-11-16T18:20:00', {
      ...BILLING,
      text: 'Started on the billing export.',
    }),
    event('evt-10', 'outcome', '2026-11-16T16:02:00', {
      ...RELEASE,
      detail: 'done',
      text: 'Release notes merged into the changelog.',
    }),
    event('evt-11', 'outcome', '2026-11-16T14:46:00', {
      ...SESSIONS,
      detail: 'failed',
      text: 'Stopped after the migration failure.',
    }),
    event('evt-12', 'failed', '2026-11-16T14:45:00', {
      ...SESSIONS,
      text: 'The migration step timed out after 120 s.',
    }),
    event('evt-13', 'manager_message', '2026-11-16T12:05:00', {
      ...BILLING,
      text: 'Thanks, go ahead with the export.',
    }),
    event('evt-14', 'user_message', '2026-11-13T09:12:00', {
      text: 'Start a thread for the sessions migration.',
    }),
    event('evt-15', 'thread_message', '2026-11-13T08:50:00', {
      ...SESSIONS,
      text: 'Waiting on the schema review before I touch the table.',
    }),
    event('evt-16', 'manager_message', '2026-11-12T17:30:00', {
      ...RELEASE,
      text: 'The release notes thread is waiting for your go-ahead.',
      awaitingReply: true,
    }),
  ];
}
