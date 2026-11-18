import {
  type NoteThreadAnswer,
  type NoteThreadInput,
  NoteThreadSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `note_thread` call's arguments, or why they cannot be read. */
export function readNoteThreadArgs(
  args: Record<string, unknown>,
): ToolArgs<NoteThreadInput> {
  return readToolArgs(NoteThreadSchema.strict(), args);
}

export function noteThreadResultText(answer: NoteThreadAnswer): string {
  return answer.status === 'noted'
    ? `Noted on ${answer.handle} (${answer.title}).`
    : `${JSON.stringify(answer)}\nNothing was noted: name the thread by one of the candidates.`;
}
