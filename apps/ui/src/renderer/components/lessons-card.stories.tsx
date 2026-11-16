import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';

import {
  CHECK_FOOTER,
  LESSON_BROKEN_AGAIN,
  LESSON_CORRECTION,
  LESSON_KNOWLEDGE_PROCEDURE,
  LESSON_MEMBER_RULE,
  LESSON_NO_PROJECT_PLACES,
  LESSON_PROJECT_RULE,
  LESSON_REFINES,
  PROJECT_DOCUMENTS,
  PROJECT_PLACES,
  REFLECTION_FOOTER,
} from '../__fixtures__/lessons';
import { formatUsd } from '../chats/agent-activity';
import { formatDuration } from '../stats/stats-format';
import {
  type LessonDocumentsReader,
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
  places,
  readDocuments,
}: Pick<
  LessonsCardProps,
  'lessons' | 'reflection' | 'check' | 'places' | 'readDocuments'
> & {
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
        places={places}
        readDocuments={readDocuments}
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
              memoryHandle: request.target.kind === 'memory' ? 'm40' : null,
              resultRef:
                request.target.kind === 'knowledge'
                  ? (request.target.handle ?? 'k-release')
                  : null,
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
              resultRef: null,
              reason,
            },
          }));
        }}
        onUpdateRule={async (proposalId) => {
          setOutcomes((current) => ({
            ...current,
            [proposalId]: {
              proposalId,
              status: 'saved',
              by: 'user',
              title: titleOf(proposalId),
              rule: null,
              target: { kind: 'memory', scope: 'project', type: 'feedback' },
              memoryHandle: 'm12',
              resultRef: null,
              reason: null,
            },
          }));
        }}
        onMoveUp={async (proposalId) => {
          setOutcomes((current) => ({
            ...current,
            [proposalId]: {
              proposalId,
              status: 'saved',
              by: 'user',
              title: titleOf(proposalId),
              rule: null,
              target: { kind: 'project_instructions' },
              memoryHandle: null,
              resultRef: null,
              reason: null,
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
  resultRef: null,
  reason: null,
} satisfies LessonOutcomeView;

const readProjectDocuments: LessonDocumentsReader = async () =>
  PROJECT_DOCUMENTS;

const meta = {
  title: 'Components/LessonsCard',
  component: LessonsDemo,
  args: {
    lessons: [LESSON_CORRECTION, LESSON_REFINES, LESSON_BROKEN_AGAIN],
    reflection: REFLECTION_FOOTER,
    places: PROJECT_PLACES,
    readDocuments: readProjectDocuments,
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

export const ProjectInstructionsWaiting: Story = {
  args: {
    lessons: [LESSON_PROJECT_RULE],
  },
};

export const MemberInstructionsWaiting: Story = {
  args: {
    lessons: [LESSON_MEMBER_RULE],
  },
};

export const KnowledgePickerWaiting: Story = {
  args: {
    lessons: [LESSON_KNOWLEDGE_PROCEDURE],
  },
};

export const RefinesUpdateRule: Story = {
  args: {
    lessons: [LESSON_REFINES],
  },
};

export const BrokenAgainMoveUpToMemoryIndex: Story = {
  args: {
    lessons: [LESSON_BROKEN_AGAIN],
    places: LESSON_NO_PROJECT_PLACES,
  },
};

export const BrokenAgainMoveUpToProjectInstructions: Story = {
  args: {
    lessons: [LESSON_BROKEN_AGAIN],
  },
};

export const SavedToProjectInstructions: Story = {
  args: {
    lessons: [LESSON_PROJECT_RULE],
    initial: {
      [LESSON_PROJECT_RULE.id]: {
        proposalId: LESSON_PROJECT_RULE.id,
        status: 'saved',
        by: 'user',
        title: LESSON_PROJECT_RULE.title,
        rule: LESSON_PROJECT_RULE.rule,
        target: { kind: 'project_instructions' },
        memoryHandle: null,
        resultRef: null,
        reason: null,
      },
    },
  },
};

export const SavedToMemberInstructions: Story = {
  args: {
    lessons: [LESSON_MEMBER_RULE],
    initial: {
      [LESSON_MEMBER_RULE.id]: {
        proposalId: LESSON_MEMBER_RULE.id,
        status: 'saved',
        by: 'user',
        title: LESSON_MEMBER_RULE.title,
        rule: LESSON_MEMBER_RULE.rule,
        target: { kind: 'member_instructions', memberId: 'member-reviewer' },
        memoryHandle: null,
        resultRef: null,
        reason: null,
      },
    },
  },
};

export const SavedToKnowledge: Story = {
  args: {
    lessons: [LESSON_KNOWLEDGE_PROCEDURE],
    initial: {
      [LESSON_KNOWLEDGE_PROCEDURE.id]: {
        proposalId: LESSON_KNOWLEDGE_PROCEDURE.id,
        status: 'saved',
        by: 'user',
        title: LESSON_KNOWLEDGE_PROCEDURE.title,
        rule: LESSON_KNOWLEDGE_PROCEDURE.rule,
        target: { kind: 'knowledge', handle: 'k-release' },
        memoryHandle: null,
        resultRef: 'k-release',
        reason: null,
      },
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
        resultRef: null,
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
        resultRef: null,
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
        resultRef: null,
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
        resultRef: null,
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
