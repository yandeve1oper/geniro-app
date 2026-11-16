import type { HostSinkUnavailable } from '../../../agents/services/host-sink.broker';
import {
  type CheckLessonsCall,
  CheckLessonsCallSchema,
} from '../../../lessons/lessons.types';
import type { LessonChecked } from '../../../lessons/services/lesson-check.service';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `check_lessons` call's verdicts, or why they cannot be read. */
export function readCheckLessons(
  args: Record<string, unknown>,
): ToolArgs<CheckLessonsCall> {
  return readToolArgs(CheckLessonsCallSchema.strict(), args);
}

export function checkLessonsResultText(
  outcome: LessonChecked | HostSinkUnavailable,
): { text: string; isError: boolean } {
  if (outcome.status === 'unavailable') {
    return {
      text: `The verdicts could not be recorded (${outcome.reason}). Say them in your reply instead.`,
      isError: true,
    };
  }
  if (outcome.status === 'refused') {
    return {
      text: `Nothing was recorded. Correct these and send every verdict again:\n${outcome.problems
        .map((problem) => `- ${problem.code}: ${problem.reason}`)
        .join('\n')}`,
      isError: true,
    };
  }
  return {
    text: `Recorded: ${outcome.kept} kept, ${outcome.dropped} dropped. Reply in one sentence; do not repeat them.`,
    isError: false,
  };
}
