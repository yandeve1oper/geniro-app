import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bell, Brain, Palette } from 'lucide-react';
import { useState } from 'react';

import { SettingsGroup, SettingsGroups } from './settings-group';
import { SettingsPanel, SettingsPanelRow } from './settings-panel';
import { Button } from './ui/button';
import { Switch } from './ui/switch';

function Toggle({ id }: { id: string }): React.JSX.Element {
  const [on, setOn] = useState(true);
  return <Switch id={id} checked={on} onCheckedChange={setOn} />;
}

const meta = {
  title: 'Components/SettingsGroup',
  component: SettingsGroup,
  args: {
    title: 'Notifications',
    children: null,
  },
  decorators: [
    (story) => <div className="w-[64rem] max-w-full">{story()}</div>,
  ],
} satisfies Meta<typeof SettingsGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A page of groups: on a wide page each name sits in a column beside its rows,
 * and a rule separates one group from the next. Narrow the frame to see the
 * names move above their rows.
 */
export const Page: Story = {
  render: () => (
    <SettingsGroups>
      <SettingsGroup
        icon={<Bell />}
        title="Notifications"
        description="How Geniro tells you an agent needs you."
        hint="Banners come from macOS. If none arrive, press Send a test: it shows whether macOS lets Geniro post at all.">
        <SettingsPanel>
          <SettingsPanelRow
            label="Show system notifications"
            htmlFor="story-group-notifications"
            hint="A banner when an agent asks you something or finishes. Clicking it opens that chat.">
            <Toggle id="story-group-notifications" />
          </SettingsPanelRow>
        </SettingsPanel>
      </SettingsGroup>
      <SettingsGroup
        icon={<Palette />}
        title="Appearance"
        description="Colours of the whole app.">
        <SettingsPanel>
          <SettingsPanelRow label="Theme" layout="block">
            <span className="text-sm">System</span>
          </SettingsPanelRow>
        </SettingsPanel>
      </SettingsGroup>
    </SettingsGroups>
  ),
};

/** A group whose content needs the whole width keeps its name above it, with its actions. */
export const Stacked: Story = {
  render: () => (
    <SettingsGroups>
      <SettingsGroup
        layout="stacked"
        icon={<Brain />}
        title="Entries"
        description="Every note in memory, newest first."
        hint="Each entry is one note agents can find by search. Approve, edit or forget any of them here."
        actions={
          <Button size="sm" variant="outline">
            New entry
          </Button>
        }>
        <SettingsPanel>
          <SettingsPanelRow layout="block">
            <span className="text-sm text-muted-foreground">
              1,228 entries — press Show to list them.
            </span>
          </SettingsPanelRow>
        </SettingsPanel>
      </SettingsGroup>
    </SettingsGroups>
  ),
};
