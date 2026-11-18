import type { Meta, StoryObj } from '@storybook/react-vite';

import { FIXTURE_NOW, graphThreadsOf } from './graph-fixtures';
import { GraphView } from './graph-view';

const MINUTE = 60_000;

const MIXED_CONTACTS = {
  'thread-1': {
    lastAt: new Date(FIXTURE_NOW - 2 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-2': {
    lastAt: new Date(FIXTURE_NOW - 40 * MINUTE).toISOString(),
    awaitingReply: true,
  },
  'thread-3': {
    lastAt: new Date(FIXTURE_NOW - 3 * MINUTE).toISOString(),
    awaitingReply: false,
  },
  'thread-4': { lastAt: null, awaitingReply: false },
};

const MANAGER = {
  agentLabel: 'Claude',
  model: 'opus',
  working: true,
  lastActivityAt: new Date(FIXTURE_NOW - 3 * MINUTE).toISOString(),
};

const meta = {
  title: 'Command center/GraphView',
  component: GraphView,
  args: {
    manager: MANAGER,
    pendingStarts: 1,
    threads: graphThreadsOf(4),
    contacts: MIXED_CONTACTS,
    pulses: [],
    now: FIXTURE_NOW,
    narrow: false,
    onOpen: () => {},
    asking: new Map([['thread-2', 'question' as const]]),
    onAnswer: () => {},
    className: 'h-full',
  },
  decorators: [
    (story) => <div className="h-[560px] w-[1100px]">{story()}</div>,
  ],
} satisfies Meta<typeof GraphView>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A few threads, one band each: blocked on top, then working, a question, quiet. */
export const Few: Story = {};

/** Twelve threads in their attention bands, the still ones greyed at the bottom. */
export const Bands: Story = { args: { threads: graphThreadsOf(12) } };

/** Thirty threads: the 24 that need the user most, and one "+6 more". */
export const Crowded: Story = {
  args: { threads: graphThreadsOf(30), contacts: {} },
};

/** No manager chat yet: its node still heads the tree. */
export const ManagerNotStarted: Story = {
  args: { manager: null, pendingStarts: 0, contacts: {} },
};

/** A phone: one column, the manager first and each thread indented under it. */
export const Phone: Story = {
  args: { narrow: true },
  decorators: [(story) => <div className="h-[700px] w-[390px]">{story()}</div>],
};
