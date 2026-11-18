import { HOST_START_THREAD_TOOL } from '../../../agents/chat.types';
import type { CommandCenterBroker } from '../../../agents/services/command-center.broker';
import type { CommandCenterOpsBroker } from '../../../agents/services/command-center-ops.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { startThreadInstructions } from './start-thread.instructions';
import {
  readStartThreadArgs,
  startThreadResultText,
} from './start-thread.reader';
import { startThreadSchema } from './start-thread.schema';

/**
 * `start_thread` — offered only on a command-center manager turn. `tools/call`
 * skips `isOffered`, so the command center refuses any other run from its row.
 */
export class StartThreadTool extends BaseMcpTool {
  readonly name = HOST_START_THREAD_TOOL;

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
    return startThreadInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return startThreadSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readStartThreadArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const answer = await this.ops.start(runId, read.query);
    return 'error' in answer
      ? this.text(answer.error, true)
      : this.text(startThreadResultText(answer));
  }
}
