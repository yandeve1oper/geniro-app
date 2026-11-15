import type { Meta, StoryObj } from '@storybook/react-vite';

import { memoryEntry } from '../__fixtures__/memories';
import { PUBLISHED_IDENTITIES } from '../__tests__/agent-identities';
import { AgentIdentityContext } from '../agent-identity';
import { MemoryRow } from './memory-row';

const LONG_BODY = Array.from(
  { length: 8 },
  (_, index) => `Line ${index + 1}: invoices are never edited after sending.`,
).join('\n');

const AGENT_SOURCE = {
  actor: 'agent',
  agentKind: 'claude',
  model: 'opus',
  runId: 'run-1',
  importedFrom: null,
} as const;

const meta = {
  title: 'Components/MemoryRow',
  component: MemoryRow,
  decorators: [
    (story) => (
      <AgentIdentityContext.Provider value={PUBLISHED_IDENTITIES}>
        <div className="w-[560px]">{story()}</div>
      </AgentIdentityContext.Provider>
    ),
  ],
  args: {
    entry: memoryEntry(),
    projectName: null,
    onEdit: () => undefined,
    onForget: () => undefined,
  },
} satisfies Meta<typeof MemoryRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {};

export const WaitingForReview: Story = {
  args: {
    entry: memoryEntry({ status: 'pending', source: AGENT_SOURCE }),
    onApprove: () => undefined,
  },
};

export const Forgotten: Story = {
  args: {
    entry: memoryEntry({ status: 'forgotten' }),
    onEdit: undefined,
    onForget: undefined,
    onRestore: () => undefined,
  },
};

export const LongBody: Story = {
  args: { entry: memoryEntry({ body: LONG_BODY }) },
};

export const Focused: Story = {
  args: {
    entry: memoryEntry({ projectId: 'project-billing' }),
    projectName: 'Billing',
    focused: true,
  },
};

export const Busy: Story = { args: { busy: true } };

export const TeamNote: Story = {
  args: {
    entry: memoryEntry({ teamSlug: 'review-crew' }),
    teamName: 'Review crew',
  },
};

export const SearchOnly: Story = {
  args: {
    entry: memoryEntry({ source: AGENT_SOURCE }),
    onIndexed: () => undefined,
  },
};

export const LoadedAgentNote: Story = {
  args: {
    entry: memoryEntry({
      source: AGENT_SOURCE,
      approvedAt: '2026-10-21T09:00:00.000Z',
    }),
    onIndexed: () => undefined,
  },
};
