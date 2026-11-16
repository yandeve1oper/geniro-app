import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  LESSON_BROKEN_AGAIN,
  LESSON_CORRECTION,
  LESSON_REFINES,
  REFLECTION_FOOTER,
} from '../__fixtures__/lessons';
import { formatUsd } from '../chats/agent-activity';
import { formatDuration } from '../stats/stats-format';
import {
  type LessonOutcomeView,
  LessonsCard,
  type LessonsCardProps,
} from './lessons-card';

const LOOK = { formatDuration, formatUsd };

/** Save and Reject record their outcome in place, the way the daemon's row would. */
function LessonsDemo({
  lessons,
  initial,
  reflection,
}: Pick<LessonsCardProps, 'lessons' | 'reflection'> & {
  initial?: Record<string, LessonOutcomeView>;
}): React.JSX.Element {
  const [outcomes, setOutcomes] = useState<Record<string, LessonOutcomeView>>(
    initial ?? {},
  );
  const titleOf = (proposalId: string): string =>
    lessons.find((lesson) => lesson.id === proposalId)?.title ?? proposalId;
  return (
    <div className="w-[600px]">
      <LessonsCard
        look={LOOK}
        lessons={lessons}
        outcomes={outcomes}
        reflection={reflection}
        onSave={async (proposalId, request) => {
          setOutcomes((current) => ({
            ...current,
            [proposalId]: {
              proposalId,
              status: 'saved',
              title: request.title ?? titleOf(proposalId),
              target: request.target,
              memoryHandle: 'm40',
              reason: null,
            },
          }));
        }}
        onReject={async (proposalId, reason) => {
          setOutcomes((current) => ({
            ...current,
            [proposalId]: {
              proposalId,
              status: 'rejected',
              title: titleOf(proposalId),
              target: LESSON_CORRECTION.target,
              memoryHandle: null,
              reason,
            },
          }));
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Components/LessonsCard',
  component: LessonsDemo,
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES, LESSON_BROKEN_AGAIN],
    reflection: REFLECTION_FOOTER,
  },
} satisfies Meta<typeof LessonsDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Proposed: Story = {};

export const Working: Story = {
  args: {
    lessons: [LESSON_CORRECTION],
    reflection: { ...REFLECTION_FOOTER, working: true },
  },
};

export const Handled: Story = {
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES],
    initial: {
      [LESSON_CORRECTION.id]: {
        proposalId: LESSON_CORRECTION.id,
        status: 'saved',
        title: LESSON_CORRECTION.title,
        target: LESSON_CORRECTION.target,
        memoryHandle: 'm31',
        reason: null,
      },
      [LESSON_REFINES.id]: {
        proposalId: LESSON_REFINES.id,
        status: 'rejected',
        title: LESSON_REFINES.title,
        target: LESSON_REFINES.target,
        memoryHandle: null,
        reason: 'already covered by m12',
      },
    },
  },
};

export const Empty: Story = {
  args: {
    lessons: [],
  },
};
