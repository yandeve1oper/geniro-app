import type { Meta, StoryObj } from '@storybook/react-vite';

import { type MemorySort, MemorySortPanel } from './memory-sort-panel';
import { Button } from './ui/button';

function sort(over: Partial<MemorySort> = {}): MemorySort {
  return {
    verdicts: new Map(),
    running: false,
    done: 0,
    total: 0,
    error: null,
    start: () => undefined,
    cancel: () => undefined,
    ...over,
  };
}

const meta = {
  title: 'Components/MemorySortPanel',
  component: MemorySortPanel,
  args: {
    slot: 'memory-cleanup-sort',
    sort: sort(),
    description:
      'An agent reads the entries listed below and says which still hold and which to forget, with a reason for each. It only proposes: nothing is forgotten until you press Forget. Runs on your agent’s account.',
    settings: (
      <span className="text-xs text-muted-foreground">Claude · Sonnet</span>
    ),
    startLabel: 'Sort 30 listed',
    startDisabled: false,
    sorted: false,
    onStart: () => undefined,
  },
} satisfies Meta<typeof MemorySortPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AtRest: Story = {};

export const WithSortAll: Story = {
  args: {
    moreActions: (
      <Button type="button" size="sm" variant="outline">
        Sort all 746 unsorted
      </Button>
    ),
  },
};

export const Running: Story = {
  args: { sort: sort({ running: true, done: 12, total: 30 }) },
};

export const Sorted: Story = {
  args: {
    sorted: true,
    startLabel: 'All listed entries sorted',
    startDisabled: true,
    summary: (
      <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>18 to forget · 12 to keep</span>
        <Button type="button" size="sm" variant="outline">
          Tick the 16 to forget
        </Button>
        <span>2 with a warning left for you</span>
      </span>
    ),
  },
};

export const NoAgent: Story = {
  args: {
    settings: (
      <span className="text-xs text-muted-foreground">
        No installed agent can sort. Claude and Codex can.
      </span>
    ),
    startDisabled: true,
  },
};

export const Failed: Story = {
  args: {
    sort: sort({
      error: 'claude did not answer — check that it is installed and signed in',
    }),
  },
};
