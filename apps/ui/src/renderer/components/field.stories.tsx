import type { Meta, StoryObj } from '@storybook/react-vite';

import { Field } from './field';
import { Input } from './ui/input';

const meta = {
  title: 'Components/Field',
  component: Field,
  args: {
    label: 'Binary path',
    htmlFor: 'binary-path',
    children: (
      <Input id="binary-path" type="text" placeholder="Auto-detect on PATH" />
    ),
  },
  decorators: [(story) => <div className="w-80">{story()}</div>],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const WithHint: Story = {
  args: {
    hint: 'Detected here — edit to pin a different binary.',
  },
};

export const WithHelp: Story = {
  args: {
    hint: 'Detected here — edit to pin a different binary.',
    help: 'Leave this empty and Geniro finds the program by itself. Set it when Geniro could not find it, or when you want a specific copy.',
  },
};

export const WithoutLabelableControl: Story = {
  args: {
    label: 'Account',
    htmlFor: undefined,
    hint: undefined,
    children: (
      <p className="text-sm text-muted-foreground">
        Signs in through the claude CLI itself — no key to enter here.
      </p>
    ),
  },
};
