import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  LESSONS_APP_OFF_REASON,
  type LessonsChoice,
  LessonsOverrideControl,
} from './lessons-override-control';

const meta = {
  title: 'Components/LessonsOverrideControl',
  component: LessonsOverrideControl,
  args: {
    value: 'inherit',
    onChange: () => {},
    inheritedLabel: 'Inherit (On — app setting)',
  },
  decorators: [
    (story) => <div className="w-96 rounded-card bg-card">{story()}</div>,
  ],
} satisfies Meta<typeof LessonsOverrideControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playground: Story = {
  render: (args) => {
    function LessonsOverrideDemo(): React.JSX.Element {
      const [value, setValue] = useState<LessonsChoice>('inherit');
      return (
        <LessonsOverrideControl {...args} value={value} onChange={setValue} />
      );
    }
    return <LessonsOverrideDemo />;
  },
};

export const On: Story = { args: { value: 'on' } };

export const Off: Story = { args: { value: 'off' } };

export const InheritedFromTheTeam: Story = {
  args: {
    value: 'inherit',
    inheritedLabel: 'Inherit (project, then app setting)',
  },
};

export const LockedByTheAppSetting: Story = {
  args: {
    value: 'inherit',
    inheritedLabel: 'Inherit (Off — app setting)',
    disabled: true,
    disabledReason: LESSONS_APP_OFF_REASON,
  },
};
