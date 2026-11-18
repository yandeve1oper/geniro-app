import {
  type StartThreadAnswer,
  type StartThreadInput,
  StartThreadSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `start_thread` call's arguments, or why they cannot be read. */
export function readStartThreadArgs(
  args: Record<string, unknown>,
): ToolArgs<StartThreadInput> {
  return readToolArgs(StartThreadSchema.strict(), args);
}

export function startThreadResultText(answer: StartThreadAnswer): string {
  if (answer.status === 'refused') {
    return `${answer.code}: ${answer.reason}`;
  }
  const card = answer.identifier ?? answer.taskId;
  return answer.status === 'starting'
    ? `${JSON.stringify(answer)}\nCard ${card} is starting now. You are told when the thread has started; end your turn rather than wait.`
    : `${JSON.stringify(answer)}\nCard ${card} is filed and a Start card is on screen for the user. You are told when they answer and when the thread starts; end your turn rather than wait.`;
}
