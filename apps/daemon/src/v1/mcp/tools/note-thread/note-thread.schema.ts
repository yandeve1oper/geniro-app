import { NoteThreadSchema } from '../../../agents/chat.types';
import { toolInputSchema } from '../tool-args';

/** `note_thread`'s arguments — generated from the schema they are parsed with. */
export function noteThreadSchema(): Record<string, unknown> {
  return toolInputSchema(NoteThreadSchema);
}
