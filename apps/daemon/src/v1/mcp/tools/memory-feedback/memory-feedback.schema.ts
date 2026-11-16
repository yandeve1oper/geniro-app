import { toolInputSchema } from '../tool-args';
import { MemoryFeedbackArgsSchema } from './memory-feedback.reader';

/** `memory_feedback`'s arguments — generated from the schema they are parsed with. */
export function memoryFeedbackSchema(): Record<string, unknown> {
  return toolInputSchema(MemoryFeedbackArgsSchema);
}
