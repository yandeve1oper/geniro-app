import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadMessageCard, ThreadOpenContext } from './thread-message-card';

const meta = {
  title: 'Chats/ThreadMessageCard',
  component: ThreadMessageCard,
  args: {
    messages: [
      {
        id: 'm1',
        fromRunId: 'r-pelican',
        fromTitle: 'Pelican',
        fromMember: null,
        text: 'The review is ready whenever you are.',
        inReplyTo: null,
      },
      {
        id: 'm2',
        fromRunId: 'r-otter',
        fromTitle: 'Otter',
        fromMember: 'Backend Engineer',
        text: 'The migration is in. Two open questions:\n1. Keep the old column until the next release?\n2. Backfill in one batch or by day?',
        inReplyTo: null,
      },
    ],
  },
  decorators: [
    (story) => (
      <div className="w-[360px] bg-background p-3 text-foreground">
        <ThreadOpenContext.Provider value={() => {}}>
          {story()}
        </ThreadOpenContext.Provider>
      </div>
    ),
  ],
} satisfies Meta<typeof ThreadMessageCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Messages: Story = {};

export const WithReplyContext: Story = {
  args: {
    messages: [
      {
        id: 'm3',
        fromRunId: 'r-otter',
        fromTitle: 'Otter',
        fromMember: 'Backend Engineer',
        text: 'Backfill in one batch. The table is small enough, and it finishes before the release window.',
        inReplyTo: {
          text: 'Can you tell me how you want to backfill the old column?',
          at: '2026-11-06T10:00:00.000Z',
        },
      },
    ],
  },
};

export const AtPhoneWidth: Story = {
  decorators: [
    (story) => (
      <div className="w-[320px] bg-background p-3 text-foreground">
        <ThreadOpenContext.Provider value={() => {}}>
          {story()}
        </ThreadOpenContext.Provider>
      </div>
    ),
  ],
};
