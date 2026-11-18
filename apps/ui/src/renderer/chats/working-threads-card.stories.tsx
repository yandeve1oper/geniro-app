import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';

import { type WorkingThread, WorkingThreadsCard } from './working-threads-card';

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function thread(over: Partial<WorkingThread>): WorkingThread {
  return {
    runId: 'run-1',
    title: 'Build the export button and its tests',
    agentLabel: 'Senior Engineer',
    agentKind: 'claude',
    startedAt: minutesAgo(11),
    status: 'working',
    ...over,
  };
}

const meta = {
  title: 'Chats/WorkingThreadsCard',
  component: WorkingThreadsCard,
  decorators: [
    (story) => (
      <div className="relative flex h-[520px] w-[720px] flex-col rounded-lg border border-border pb-10">
        <div className="min-h-0 flex-1" />
        {story()}
      </div>
    ),
  ],
  args: {
    beside: false,
    onOpenThread: () => {},
    threads: [
      thread({ runId: 'run-1' }),
      thread({
        runId: 'run-2',
        title: 'Fix the parser for nested tables',
        agentLabel: 'Middle Engineer',
        agentKind: 'codex',
        startedAt: minutesAgo(3),
      }),
    ],
  },
} satisfies Meta<typeof WorkingThreadsCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const pinPanel: Story['play'] = async ({ canvasElement }) => {
  await userEvent.click(
    within(canvasElement).getByRole('button', { name: /^Threads working · / }),
  );
};

export const Working: Story = {};

export const Pinned: Story = { play: pinPanel };

export const WithWaiting: Story = {
  args: {
    threads: [
      thread({ runId: 'run-1' }),
      thread({
        runId: 'run-2',
        title: 'Which CSV escaping does the export library apply?',
        agentLabel: 'Researcher',
        agentKind: 'cursor-agent',
        status: 'waiting',
        startedAt: minutesAgo(42),
      }),
      thread({
        runId: 'run-3',
        title: 'Draft the release notes',
        agentLabel: null,
        agentKind: null,
        startedAt: null,
        status: 'waiting',
      }),
    ],
  },
  play: pinPanel,
};

export const BesideAgentsCard: Story = {
  args: { beside: true },
  decorators: [
    (story) => (
      <>
        {story()}
        <div
          aria-hidden="true"
          className="absolute right-4 -bottom-2 size-8 rounded-full border border-border bg-popover shadow-panel-lg"
        />
      </>
    ),
  ],
};
