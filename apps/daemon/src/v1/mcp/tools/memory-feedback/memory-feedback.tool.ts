import { HOST_MEMORY_FEEDBACK_TOOL } from '../../../agents/chat.types';
import type { McpToolResult, MemoryCallScope } from '../../mcp.types';
import { MemoryMcpTool } from '../memory-mcp-tool';
import { memoryFeedbackInstructions } from './memory-feedback.instructions';
import {
  memoryFeedbackResultText,
  readMemoryFeedbackArgs,
} from './memory-feedback.reader';
import { memoryFeedbackSchema } from './memory-feedback.schema';

/** `memory_feedback` — mark a shared memory entry helped, not useful or misleading. */
export class MemoryFeedbackTool extends MemoryMcpTool {
  readonly name = HOST_MEMORY_FEEDBACK_TOOL;

  protected instructions(): string {
    return memoryFeedbackInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return memoryFeedbackSchema();
  }

  protected async answer(
    args: Record<string, unknown>,
    { place, actor, memberId }: MemoryCallScope,
  ): Promise<McpToolResult> {
    const read = readMemoryFeedbackArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const outcome = await this.memory.feedback(
      actor,
      memberId,
      read.query.id,
      read.query.verdict,
      read.query.reason,
      place,
    );
    const { text, isError } = memoryFeedbackResultText(outcome);
    return this.masked(text, isError);
  }
}
