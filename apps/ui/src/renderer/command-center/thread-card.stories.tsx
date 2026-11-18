import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadCard } from './thread-card';

const meta = {
  title: 'Command center/ThreadCard',
  component: ThreadCard,
  args: {
    title: 'Fix the login redirect',
    status: 'working',
    statusText: 'Working',
    attention: 'working',
    project: 'Geniro',
    agentLabel: 'claude',
    isTeam: false,
    crew: null,
    pullRequest: null,
    note: null,
    lastMessage:
      'Rebased on **main** and re-ran the suite; two flaky specs left, looking at them now',
    boardCard: null,
    idleDays: null,
    lastAt: new Date(Date.parse('2026-11-17T11:55:00Z')).toISOString(),
    now: Date.parse('2026-11-17T12:00:00Z'),
    onGo: () => {},
  },
  decorators: [(story) => <div className="p-4">{story()}</div>],
} satisfies Meta<typeof ThreadCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Working: Story = {};

/** A thread that works a board card wears it as a label. */
export const WithBoardCard: Story = {
  args: {
    boardCard: {
      identifier: 'GEN-412',
      title: 'Fix the login redirect',
      status: 'in_progress',
    },
  },
};

/** Nobody has touched it for days: greyed out, and the idle mark says how many. */
export const InactiveForDays: Story = {
  args: {
    status: 'idle',
    statusText: 'Idle',
    attention: 'inactive',
    lastMessage: 'Done — PR is up',
    idleDays: 6,
    lastAt: '2026-11-11T12:00:00Z',
  },
};

/** Waiting on a question: yellow. */
export const Question: Story = {
  args: {
    status: 'waiting',
    statusText: 'Question for you',
    attention: 'question',
    title: 'Pick the migration strategy',
    lastMessage: 'Should the backfill run before or after the column rename?',
  },
};

/** Blocked on a press — a failure or an approval: red. */
export const Blocked: Story = {
  args: {
    status: 'failed',
    statusText: 'Failed',
    attention: 'blocked',
    title: 'Release notes',
    lastMessage: 'The CLI exited: usage limit reached',
  },
};

/** A team run wears its team's name. */
export const Team: Story = {
  args: {
    agentLabel: 'dev-team',
    isTeam: true,
    crew: {
      people: [
        {
          key: 'lead',
          name: 'Nick Fury',
          avatar: { kind: 'emoji', value: '🛰️' },
        },
        { key: 'senior', name: 'Tony Stark', avatar: null },
        { key: 'middle', name: 'Peter Parker', avatar: null },
        { key: 'qa', name: 'Thanos', avatar: null },
      ],
      total: 6,
    },
    attention: 'quiet',
    status: 'idle',
  },
};

export const WithPullRequestAndNote: Story = {
  args: {
    title: 'Wire the thread-start conductor',
    pullRequest: { number: 417, state: 'draft' },
    note: 'Waiting for the other thread to land its migration first.',
    boardCard: {
      identifier: 'GEN-417',
      title: 'Conductor',
      status: 'in_review',
    },
  },
};

export const LongTitle: Story = {
  args: {
    title:
      'Investigate why the sidebar resets its scroll position whenever a background agent posts a status line into a thread the user is not reading right now',
  },
};
