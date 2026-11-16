import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  CHECK_FOOTER,
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

/** Decisions are recorded in place, the way the daemon's outcome rows would. */
function LessonsDemo({
  lessons,
  initial,
  reflection,
  check,
}: Pick<LessonsCardProps, 'lessons' | 'reflection' | 'check'> & {
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
        check={check}
        onSave={async (proposalId, request) => {
          setOutcomes((current) => ({
            ...current,
            [proposalId]: {
              proposalId,
              status: 'saved',
              by: 'user',
              title: request.title ?? titleOf(proposalId),
              rule: null,
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
              by: 'user',
              title: titleOf(proposalId),
              rule: null,
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

const SAVED_AUTOMATICALLY = {
  proposalId: LESSON_CORRECTION.id,
  status: 'saved',
  by: 'auto',
  title: LESSON_CORRECTION.title,
  rule: LESSON_CORRECTION.rule,
  target: LESSON_CORRECTION.target,
  memoryHandle: 'm31',
  reason: null,
} satisfies LessonOutcomeView;

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

export const WithCheck: Story = {
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES],
    check: CHECK_FOOTER,
  },
};

export const Working: Story = {
  args: {
    lessons: [LESSON_CORRECTION],
    reflection: {
      ...REFLECTION_FOOTER,
      figures: { working: true, durationMs: null, costUsd: null },
    },
  },
};

export const AutoSaved: Story = {
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES],
    initial: {
      [LESSON_CORRECTION.id]: SAVED_AUTOMATICALLY,
      [LESSON_REFINES.id]: {
        proposalId: LESSON_REFINES.id,
        status: 'pending',
        by: 'auto',
        title: LESSON_REFINES.title,
        rule: LESSON_REFINES.rule,
        target: LESSON_REFINES.target,
        memoryHandle: null,
        reason: null,
      },
    },
  },
};

export const DroppedByCheck: Story = {
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES, LESSON_BROKEN_AGAIN],
    initial: {
      [LESSON_CORRECTION.id]: SAVED_AUTOMATICALLY,
      [LESSON_REFINES.id]: {
        proposalId: LESSON_REFINES.id,
        status: 'dropped_by_check',
        by: 'auto',
        title: LESSON_REFINES.title,
        rule: LESSON_REFINES.rule,
        target: LESSON_REFINES.target,
        memoryHandle: null,
        reason: 'The user never corrected this; the build simply failed once.',
      },
      [LESSON_BROKEN_AGAIN.id]: {
        proposalId: LESSON_BROKEN_AGAIN.id,
        status: 'dropped_by_check',
        by: 'auto',
        title: LESSON_BROKEN_AGAIN.title,
        rule: LESSON_BROKEN_AGAIN.rule,
        target: LESSON_BROKEN_AGAIN.target,
        memoryHandle: null,
        reason: 'Restates the repository’s own docs.',
      },
    },
  },
};

export const Handled: Story = {
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES],
    initial: {
      [LESSON_CORRECTION.id]: {
        ...SAVED_AUTOMATICALLY,
        by: 'user',
      },
      [LESSON_REFINES.id]: {
        proposalId: LESSON_REFINES.id,
        status: 'rejected',
        by: 'user',
        title: LESSON_REFINES.title,
        rule: LESSON_REFINES.rule,
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
