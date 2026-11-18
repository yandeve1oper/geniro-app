import { HOST_TELL_THREADS_TOOL } from '../../../agents/chat.types';
import type { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import type { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { tellThreadsInstructions } from './tell-threads.instructions';
import {
  readTellThreadsArgs,
  tellThreadsResultText,
} from './tell-threads.reader';
import { tellThreadsSchema } from './tell-threads.schema';

/**
 * `tell_threads` — offered only on a command-center manager turn. `tools/call`
 * skips `isOffered`, so the command center refuses any other run from its row.
 */
export class TellThreadsTool extends BaseMcpTool {
  readonly name = HOST_TELL_THREADS_TOOL;

  constructor(
    private readonly managers: CommandCenterBroker,
    private readonly ops: CommandCenterOpsBroker,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.managers.canManage(runId, memberId);
  }

  protected instructions(): string {
    return tellThreadsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return tellThreadsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readTellThreadsArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const answer = await this.ops.tell(runId, read.query);
    return 'error' in answer
      ? this.text(answer.error, true)
      : this.text(tellThreadsResultText(answer));
  }
}
