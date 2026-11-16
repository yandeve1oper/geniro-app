import { ProposeLessonsCallSchema } from '../../../lessons/lessons.types';
import { toolInputSchema } from '../tool-args';

/** `propose_lessons`'s arguments — generated from the schema they are parsed with. */
export function proposeLessonsSchema(): Record<string, unknown> {
  return toolInputSchema(ProposeLessonsCallSchema);
}
