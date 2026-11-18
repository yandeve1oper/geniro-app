import {
  type TellThreadsAnswer,
  type TellThreadsInput,
  TellThreadsSchema,
} from '../../../agents/chat.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `tell_threads` call's arguments, or why they cannot be read. */
export function readTellThreadsArgs(
  args: Record<string, unknown>,
): ToolArgs<TellThreadsInput> {
  return readToolArgs(TellThreadsSchema.strict(), args);
}

/** The answer as the manager reads it: the JSON, then what to do next. */
export function tellThreadsResultText(answer: TellThreadsAnswer): string {
  return `${JSON.stringify(answer)}\n${nextStepOf(answer)}`;
}

function nextStepOf(answer: TellThreadsAnswer): string {
  if (answer.unresolved.length > 0) {
    return 'Nothing was sent. Ask the user which threads they meant — the candidates are listed — then call again.';
  }
  const refused = answer.sent.filter((row) => row.outcome === 'refused');
  const waiting = answer.sent.filter((row) => row.outcome === 'waiting');
  const lines: string[] = [];
  if (refused.length > 0) {
    lines.push(
      `Not delivered to ${refused.map((row) => `${row.to} (${row.code ?? 'refused'})`).join(', ')}: those threads did not get the message. Tell the user, or try again once the cause is fixed.`,
    );
  }
  if (waiting.length > 0) {
    lines.push(
      `Waiting at ${waiting.map((row) => `${row.to} (${row.code ?? 'waiting'})`).join(', ')}: it is read with that thread's next turn, not now.`,
    );
  }
  lines.push(
    refused.length + waiting.length === 0
      ? 'Each thread above got the message. A reply reaches you as a message of your own; do not poll for it.'
      : 'A reply from a thread that got the message reaches you as a message of your own; do not poll for it.',
  );
  return lines.join('\n');
}
