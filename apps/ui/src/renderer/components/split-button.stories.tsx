import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import { SplitButton } from './split-button';
import type { MenuGroup } from './ui/menu';

const TARGETS: MenuGroup[] = [
  {
    label: 'Memory',
    items: [
      { value: 'memory:project', label: 'Memory · project' },
      { value: 'memory:global', label: 'Memory · global' },
    ],
  },
  {
    label: 'Instructions',
    items: [
      { value: 'project', label: 'Project instructions' },
      {
        value: 'member:retired',
        label: 'Instructions of retired-reviewer',
        hint: 'unavailable',
        disabled: true,
      },
    ],
  },
];

const LABELS: Record<string, string> = {
  'memory:project': 'Memory · project',
  'memory:global': 'Memory · global',
  project: 'Project instructions',
};

function Picker({ disabled }: { disabled?: boolean }): React.JSX.Element {
  const [value, setValue] = useState('project');
  return (
    <SplitButton
      groups={TARGETS}
      value={value}
      menuLabel="Choose where it goes"
      disabled={disabled}
      onClick={() => undefined}
      onSelect={setValue}>
      {`Save to ${LABELS[value] ?? value}`}
    </SplitButton>
  );
}

const meta = {
  title: 'Components/SplitButton',
  component: Picker,
  decorators: [(story) => <div className="h-[280px] p-4">{story()}</div>],
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {};

export const Disabled: Story = { args: { disabled: true } };
