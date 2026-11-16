import type { Meta, StoryObj } from '@storybook/react-vite';
import { Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import {
  SettingsList,
  SettingsPanel,
  SettingsPanelRow,
} from './settings-panel';
import { Button } from './ui/button';
import { Switch } from './ui/switch';
import { Textarea } from './ui/textarea';

/**
 * The Settings screen's own rows, with the app's real labels and notes — the
 * component is a container, so a story showing one row with placeholder text
 * would document nothing about the thing it exists for, which is what several
 * settings look like ONE UNDER ANOTHER.
 */
const meta = {
  title: 'Components/SettingsPanel',
  component: SettingsPanelRow,
  args: {
    label: 'Show system notifications',
    // Dummy default satisfying the required-args type — every story below
    // supplies its own children through `render`.
    children: null,
  },
  decorators: [
    (story) => <div className="w-[42rem] max-w-full">{story()}</div>,
  ],
} satisfies Meta<typeof SettingsPanelRow>;

export default meta;
type Story = StoryObj<typeof meta>;

function Toggle({ id }: { id: string }): React.JSX.Element {
  const [on, setOn] = useState(true);
  return <Switch id={id} checked={on} onCheckedChange={setOn} />;
}

/** One setting: the name and what it does on the left, the control on the right. */
export const Playground: Story = {
  render: (args) => (
    <SettingsPanel>
      <SettingsPanelRow
        {...args}
        htmlFor="story-notifications"
        description="Banners when an agent asks something and when a turn ends; clicking one opens that chat. Never for the chat you are watching, or a turn you stopped.">
        <Toggle id="story-notifications" />
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/** A setting whose explanation is too long for the row sits behind a "?" after its name. */
export const WithHint: Story = {
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow
        label="Keep the Mac awake while agents work"
        htmlFor="story-hint-awake"
        hint="While an agent works the Mac does not go to idle sleep; while it only waits for you, it may. The display still turns off, and closing the lid still sleeps the Mac.">
        <Toggle id="story-hint-awake" />
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/** Several rows, which is the arrangement the divider and the enclosure are for. */
export const Stacked: Story = {
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow
        label="Show system notifications"
        htmlFor="story-stacked-notifications"
        description="Banners when an agent asks something and when a turn ends.">
        <Toggle id="story-stacked-notifications" />
      </SettingsPanelRow>
      <SettingsPanelRow
        label="Keep intermediate steps collapsed"
        htmlFor="story-stacked-steps"
        description="A turn's tool calls start folded, file edits included.">
        <Toggle id="story-stacked-steps" />
      </SettingsPanelRow>
      <SettingsPanelRow label="Delivery">
        <Button type="button" variant="ghost" size="sm">
          macOS settings
        </Button>
        <Button type="button" variant="outline" size="sm">
          Send a test
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/**
 * `block`, for content that IS the width — the label sits above it and nothing
 * is right-aligned. The row under it is the ordinary `inline` one, so the two
 * layouts can be compared in the arrangement they actually appear in.
 */
export const Block: Story = {
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow layout="block">
        <Textarea
          rows={4}
          placeholder="e.g. Always answer in British English. Prefer small, reviewable diffs."
        />
      </SettingsPanelRow>
      <SettingsPanelRow
        label="Applies to new chats"
        description="Handed to every agent at the start of each new chat or team run — one already running keeps what it started with.">
        <Button type="button" variant="ghost" size="sm">
          Remove from existing chats
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};

/**
 * `SettingsList` — the same enclosure over a real `<ul>`, for rows that are
 * ITEMS rather than settings. Both Settings subpages use it: the saved run
 * configurations and the fast actions.
 *
 * The enclosure is what ties a row's trailing actions to the row. Without it
 * these lists were loose two-line blocks on the page ground with a pencil
 * floating 700px to the right of the name it edits, belonging to nothing.
 *
 * `overflow-hidden` at the call site rather than in the component: it is what
 * clips a row's hover fill to the card radius, and it would cut off a `Select`
 * panel in a `SettingsPanel` row.
 */
export const List: Story = {
  render: () => (
    <SettingsList className="overflow-hidden">
      {[
        [
          'Review my diff',
          'Review what changed on this branch and report findings.',
        ],
        ['Write the tests', 'Write unit tests for the code I just changed.'],
        [
          'Explain this file',
          'Walk me through this file — what it does and who calls it.',
        ],
      ].map(([name, text]) => (
        <li
          key={name}
          className="flex items-center gap-1 pr-2 hover:bg-sidebar-accent">
          <button
            type="button"
            className="flex min-w-0 flex-1 flex-col items-start gap-0.5 px-4 py-3 text-left outline-none focus-visible:bg-sidebar-accent">
            <span className="w-full truncate text-sm text-foreground">
              {name}
            </span>
            <span className="w-full truncate text-xs text-muted-foreground">
              {text}
            </span>
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Edit ${name}`}
            className="size-7 shrink-0 text-muted-foreground">
            <Pencil className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Delete ${name}`}
            className="size-7 shrink-0 text-muted-foreground">
            <Trash2 className="size-4" />
          </Button>
        </li>
      ))}
    </SettingsList>
  ),
};

/**
 * Under `26rem` of CONTAINER width the inline row stacks rather than let either
 * half give way — a truncated description says nothing, and a control squeezed
 * into a 3rem cell cannot be pressed. This is the panel in a narrow window.
 */
export const Narrow: Story = {
  decorators: [(story) => <div className="w-[22rem]">{story()}</div>],
  render: () => (
    <SettingsPanel>
      <SettingsPanelRow
        label="Show system notifications"
        htmlFor="story-narrow-notifications"
        description="Banners when an agent asks something and when a turn ends.">
        <Toggle id="story-narrow-notifications" />
      </SettingsPanelRow>
      <SettingsPanelRow label="Delivery">
        <Button type="button" variant="outline" size="sm">
          Send a test
        </Button>
      </SettingsPanelRow>
    </SettingsPanel>
  ),
};
