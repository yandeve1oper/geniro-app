import { z } from 'zod';

import {
  MEMORY_FEEDBACK_REASON_MAX_CHARS,
  MEMORY_FEEDBACK_VERDICTS,
  MEMORY_HANDLE_PATTERN,
  type MemoryFeedbackOutcome,
} from '../../../memory/memory.types';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

export const MemoryFeedbackArgsSchema = z
  .object({
    id: z
      .string()
      .trim()
      .regex(MEMORY_HANDLE_PATTERN, 'a handle like m12')
      .describe('The handle of the entry (`m12`).'),
    verdict: z
      .enum(MEMORY_FEEDBACK_VERDICTS)
      .describe(
        'helped: it saved work or a mistake; misleading: following it led you wrong; not_useful: it did not apply or is stale.',
      ),
    reason: z
      .string()
      .describe(
        `What the entry did in this task, in one line of at most ${MEMORY_FEEDBACK_REASON_MAX_CHARS} characters — the user reads it.`,
      ),
  })
  .strict();

export type MemoryFeedbackArgs = z.infer<typeof MemoryFeedbackArgsSchema>;

export function readMemoryFeedbackArgs(
  args: Record<string, unknown>,
): ToolArgs<MemoryFeedbackArgs> {
  return readToolArgs(MemoryFeedbackArgsSchema, args);
}

const VERDICT_WORDS: Record<MemoryFeedbackArgs['verdict'], string> = {
  helped: 'helped',
  not_useful: 'not useful',
  misleading: 'misleading',
};

/**
 * What the agent reads back.
 *
 * TWIN PARSER: `memoryToolEntryOf` in `apps/ui/src/renderer/chats/memory-tool-row.tsx`
 * reads this text for the transcript row; reword it there too.
 */
export function memoryFeedbackResultText(outcome: MemoryFeedbackOutcome): {
  text: string;
  isError: boolean;
} {
  if (outcome.kind === 'refused') {
    return { text: `${outcome.code}: ${outcome.reason}`, isError: true };
  }
  const marked = `Marked ${outcome.handle} ${VERDICT_WORDS[outcome.verdict]}.`;
  return {
    text: outcome.forgotten
      ? `${marked} Enough threads found it not useful, so no agent sees it any more; the user can bring it back.`
      : marked,
    isError: false,
  };
}
