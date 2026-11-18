import { TellThreadsSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `tell_threads`' arguments — generated from the schema they are parsed with. */
export function tellThreadsSchema(): Record<string, unknown> {
  return toolInputSchema(TellThreadsSchema);
}
