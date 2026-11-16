import { CheckLessonsCallSchema } from '../../../lessons/lessons.types';
import { toolInputSchema } from '../tool-args';

/** `check_lessons`'s arguments — generated from the schema they are parsed with. */
export function checkLessonsSchema(): Record<string, unknown> {
  return toolInputSchema(CheckLessonsCallSchema);
}
