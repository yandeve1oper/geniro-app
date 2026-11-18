import { StartThreadSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `start_thread`'s arguments — generated from the schema they are parsed with. */
export function startThreadSchema(): Record<string, unknown> {
  return toolInputSchema(StartThreadSchema);
}
