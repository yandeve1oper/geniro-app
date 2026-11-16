import { HOST_CHECK_LESSONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { LessonCheckService } from '../../../lessons/services/lesson-check.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { checkLessonsInstructions } from './check-lessons.instructions';
import {
  checkLessonsResultText,
  readCheckLessons,
} from './check-lessons.reader';
import { checkLessonsSchema } from './check-lessons.schema';

/** `check_lessons` — the second model's verdict on each lesson a reflection found. */
export class CheckLessonsTool extends BaseMcpTool {
  readonly name = HOST_CHECK_LESSONS_TOOL;

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly checks: Pick<LessonCheckService, 'file'>,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.analysis.isLessonCheck(runId, memberId);
  }

  protected instructions(): string {
    return checkLessonsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return checkLessonsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readCheckLessons(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const turn = await this.analysis.turnOf(runId, memberId);
    if ('status' in turn) {
      const result = checkLessonsResultText(turn);
      return this.text(result.text, result.isError);
    }
    const result = checkLessonsResultText(
      await this.checks.file(turn, read.query),
    );
    return this.text(result.text, result.isError);
  }
}
