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

export const ForgottenWithReason: Story = {
  args: {
    entry: memoryEntry({
      status: 'forgotten',
      forgetReason:
        '2 threads marked it not useful: “Invoice template” — the template changed in November',
      purgeAt: '2026-12-15T09:00:00.000Z',
    }),
    onEdit: undefined,
    onForget: undefined,
    onRestore: () => undefined,
  },
};

export const WithTrackRecord: Story = {
  args: {
    entry: memoryEntry(),
    track: {
      memoryId: 'memory-1',
      indexShows: 3,
      reads: 2,
      helped: 1,
      notUseful: 0,
    },
  },
};

export const SearchableOnly: Story = {
  args: {
    entry: memoryEntry({ indexed: false, source: AGENT_SOURCE }),
    showReach: true,
    track: {
      memoryId: 'memory-1',
      indexShows: 0,
      reads: 1,
      helped: 0,
      notUseful: 2,
    },
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
