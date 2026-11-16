import { HOST_LESSONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { LessonFilingService } from '../../../lessons/services/lesson-filing.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { proposeLessonsInstructions } from './propose-lessons.instructions';
import {
  proposeLessonsResultText,
  readProposeLessons,
} from './propose-lessons.reader';
import { proposeLessonsSchema } from './propose-lessons.schema';

/** `propose_lessons` — a lessons reflection's lessons about the thread it read. */
export class ProposeLessonsTool extends BaseMcpTool {
  readonly name = HOST_LESSONS_TOOL;

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly lessons: Pick<LessonFilingService, 'file'>,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.analysis.isReflection(runId, memberId);
  }

  protected instructions(): string {
    return proposeLessonsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return proposeLessonsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readProposeLessons(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      const result = proposeLessonsResultText(turn);
      return this.text(result.text, result.isError);
    }
    const result = proposeLessonsResultText(
      await this.lessons.file(turn, read.query.lessons),
    );
    return this.text(result.text, result.isError);
  }
}
