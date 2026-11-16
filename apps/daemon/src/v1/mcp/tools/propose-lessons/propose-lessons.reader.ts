import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import {
  type ProposeLessonsCall,
  ProposeLessonsCallSchema,
} from '../../../lessons/lessons.types';
import type { LessonFiled } from '../../../lessons/services/lesson-filing.service';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `propose_lessons` call's lessons, or why they cannot be read. */
export function readProposeLessons(
  args: Record<string, unknown>,
): ToolArgs<ProposeLessonsCall> {
  return readToolArgs(ProposeLessonsCallSchema.strict(), args);
}

export function proposeLessonsResultText(
  outcome: LessonFiled | HostSinkUnavailable,
): { text: string; isError: boolean } {
  if (outcome.status === 'unavailable') {
    return {
      text: `The lessons could not be recorded (${outcome.reason}). Say them in your reply instead.`,
      isError: true,
    };
  }
  if (outcome.status === 'refused') {
    return {
      text: `Nothing was recorded. Correct these and send the whole list again:\n${outcome.problems
        .map((problem) => `- ${problem.code}: ${problem.reason}`)
        .join('\n')}`,
      isError: true,
    };
  }
  if (outcome.count === 0) {
    return {
      text: 'Recorded: no lessons from this stretch. Say in one or two sentences why none passed.',
      isError: false,
    };
  }
  const noun = outcome.count === 1 ? 'lesson' : 'lessons';
  return {
    text: `${outcome.count} ${noun} recorded on the thread's card for the user to save or reject. Reply in one or two sentences; do not repeat them.`,
    isError: false,
  };
}
