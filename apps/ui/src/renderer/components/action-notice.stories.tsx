import type { Meta, StoryObj } from '@storybook/react-vite';

import { ActionNotice } from './action-notice';

const meta = {
  title: 'Components/ActionNotice',
  component: ActionNotice,
  args: {
    icon: '💡',
    title: 'Learning from “Refactor the parser”',
    detail: 'claude-haiku-5-5 · ≈$0.02 · $0.12 today',
    onDismiss: () => undefined,
  },
  decorators: [(story) => <div className="w-[420px]">{story()}</div>],
} satisfies Meta<typeof ActionNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithCheck: Story = {
  args: {
    detail:
      'claude-haiku-5-5 · ≈$0.02 · check ≈$0.27 if a lesson is found · $0.12 today',
    action: { label: 'Skip', onAction: () => undefined },
  },
};

export const LongTitle: Story = {
  args: {
    title:
      'Learning from “Migrate the billing exports to the new ledger schema and check every archived invoice”',
    detail: 'default model · ≈1.2k tokens',
    action: { label: 'Skip', onAction: () => undefined },
  },
};
