import {
  Archive,
  CalendarDays,
  CalendarRange,
  Clock,
  Filter,
  History,
  ListFilter,
  MessageSquare,
} from 'lucide-react';
import React, { useRef, useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Menu } from '../components/ui/menu';
import { Popover } from '../components/ui/popover';
import {
  type ActivityPreset,
  type ActivityWindow,
  customWindow,
  windowOfPreset,
} from './activity-window';
import { SIDEBAR_MENU_WIDTH } from './group-header';
import type { ChatListScope } from './use-chat-run';

/** The rows, in the order they are offered. */
const SCOPES = [
  {
    value: 'active',
    label: 'Active chats',
    icon: <MessageSquare />,
  },
  { value: 'all', label: 'Show all', icon: <ListFilter /> },
  { value: 'archived', label: 'Archived only', icon: <Archive /> },
] as const satisfies readonly {
  value: ChatListScope;
  label: string;
  icon: React.ReactNode;
}[];

const PRESETS = [
  { value: 'any', label: 'Any time', icon: <History /> },
  { value: 'today', label: 'Today', icon: <Clock /> },
  { value: 'since-yesterday', label: 'Since yesterday', icon: <Clock /> },
  { value: 'this-week', label: 'This week', icon: <CalendarDays /> },
  { value: 'custom', label: 'Custom range…', icon: <CalendarRange /> },
] as const satisfies readonly {
  value: ActivityPreset;
  label: string;
  icon: React.ReactNode;
}[];

const isScope = (value: string): value is ChatListScope =>
  SCOPES.some((scope) => scope.value === value);

const isPreset = (value: string): value is ActivityPreset =>
  PRESETS.some((preset) => preset.value === value);

/**
 * What the chat sidebar lists — one icon in the header's control row, opening
 * the scopes and the "Last active" window.
 *
 * An ICON among the other three rather than a band of its own, which is what it
 * replaced: a two-option segmented control sat under the heading as a fourth
 * row of chrome above a list, and it could only ever name two of the three
 * answers. Reported as "у нас не должно быть этого элемента интерфейса… должна
 * быть отдельная маленькая иконка, там же, где сверху другие три иконки".
 *
 * The trigger is TONED when either group is narrowed away from its default, and
 * that is the whole of what a collapsed control owes its user: an icon that
 * looked identical in every state would leave "why is this thread missing?"
 * with nothing on screen to answer it. Both current choices are also on the
 * hover title, since colour is not a label.
 */
export function ChatScopeFilter({
  scope,
  onChange,
  window,
  preset,
  onWindowChange,
}: {
  scope: ChatListScope;
  onChange: (next: ChatListScope) => void;
  window: ActivityWindow | null;
  preset: ActivityPreset;
  onWindowChange: (
    preset: ActivityPreset,
    window: ActivityWindow | null,
  ) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const current = SCOPES.find((entry) => entry.value === scope) ?? SCOPES[0];
  const currentPreset =
    PRESETS.find((entry) => entry.value === preset) ?? PRESETS[0];
  const range = customWindow(from, to);
  const narrowed = scope !== 'active' || window !== null;

  return (
    <span className="relative inline-flex">
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        data-menu-trigger
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter chats"
        title={`Filter chats · ${current.label}${
          window === null ? '' : ` · ${currentPreset.label}`
        }`}
        className={
          narrowed ? 'size-7 text-primary hover:text-primary' : 'size-7'
        }
        onClick={() => setOpen((wasOpen) => !wasOpen)}>
        <Filter className="shrink-0" />
      </Button>
      <Menu
        open={open}
        side="bottom"
        align="end"
        anchor="viewport"
        triggerRef={triggerRef}
        // The same width as the sidebar's other menu (a group's colours), so
        // the two panels in this column are one shape. Its default is wide
        // enough to reach across the nav rail beside it.
        className={SIDEBAR_MENU_WIDTH}
        value={scope}
        groups={[
          {
            label: 'Show',
            items: SCOPES.map((entry) => ({
              ...entry,
              checked: entry.value === scope,
            })),
          },
          {
            label: 'Last active',
            items: PRESETS.map((entry) => ({
              ...entry,
              checked: entry.value === preset,
              value: `window:${entry.value}`,
            })),
          },
        ]}
        onSelect={(value) => {
          setOpen(false);
          if (isScope(value)) {
            onChange(value);
            return;
          }
          const picked = value.startsWith('window:')
            ? value.slice('window:'.length)
            : '';
          if (!isPreset(picked)) {
            return;
          }
          if (picked === 'custom') {
            setRangeOpen(true);
          } else if (picked === 'any') {
            onWindowChange('any', null);
          } else {
            onWindowChange(picked, windowOfPreset(picked, new Date()));
          }
        }}
        onClose={() => setOpen(false)}
      />
      <Popover
        open={rangeOpen}
        onClose={() => setRangeOpen(false)}
        triggerRef={triggerRef}
        side="bottom"
        align="end"
        anchor="viewport"
        label="Custom activity range"
        className={SIDEBAR_MENU_WIDTH}>
        <div className="flex flex-col gap-2 p-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <Input
              type="date"
              aria-label="From"
              className="h-8 text-xs"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            To
            <Input
              type="date"
              aria-label="To"
              className="h-8 text-xs"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setRangeOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={range === null}
              onClick={() => {
                if (range !== null) {
                  onWindowChange('custom', range);
                  setRangeOpen(false);
                }
              }}>
              Apply
            </Button>
          </div>
        </div>
      </Popover>
    </span>
  );
}
