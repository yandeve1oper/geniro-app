import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { HelpHint, HelpHintPart } from './help-hint';

const meta = {
  title: 'Components/HelpHint',
  component: HelpHint,
  args: {
    subject: 'Compact',
    children: (
      <p>Gives the empty room inside the database file back to the disk.</p>
    ),
  },
  decorators: [
    (story) => (
      <div className="flex h-56 w-96 items-start justify-start pt-4">
        {story()}
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole('button', { name: 'About Compact' }),
    );
  },
} satisfies Meta<typeof HelpHint>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One paragraph, pinned open. */
export const Plain: Story = {};

/** An action explained in parts: what it does, how, and whether to press it. */
export const InParts: Story = {
  args: {
    children: (
      <>
        <HelpHintPart title="What it does">
          Shrinks the database file. Your chats are not changed.
        </HelpHintPart>
        <HelpHintPart title="How it works">
          Geniro’s background service restarts and rewrites the file without its
          empty room.
        </HelpHintPart>
        <HelpHintPart title="Worth pressing?">
          Yes: 3.1 GB of the 10 GB file is empty room.
        </HelpHintPart>
      </>
    ),
  },
};
