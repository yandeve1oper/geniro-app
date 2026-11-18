import type { Meta, StoryObj } from '@storybook/react-vite';

import { ContactEdgeLine } from './contact-edge';

const NOW = Date.parse('2026-11-17T12:00:00Z');

const meta = {
  title: 'Command center/ContactEdge',
  component: ContactEdgeLine,
  args: {
    id: 'contact:thread',
    path: 'M 20 40 L 300 40',
    state: 'idle',
    pulses: [],
    now: NOW,
  },
  decorators: [
    (story) => (
      <svg width={320} height={80} viewBox="0 0 320 80">
        {story()}
      </svg>
    ),
  ],
} satisfies Meta<typeof ContactEdgeLine>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Dashed and dim: no contact in the last five minutes, and no reply awaited. */
export const Idle: Story = {};

/** Solid primary: the manager reached the thread within the last five minutes. */
export const Lit: Story = { args: { state: 'lit' } };

/** Solid amber: the thread owes the manager a reply, whatever the time since contact. */
export const AwaitingReply: Story = { args: { state: 'awaiting' } };

/** A pulse just left the manager: one dot travels the edge, then it is gone. */
export const TravellingPulse: Story = {
  args: {
    state: 'lit',
    pulses: [
      {
        id: 'pulse-out',
        threadId: 'thread',
        at: new Date(NOW).toISOString(),
        direction: 'out',
      },
    ],
  },
};
