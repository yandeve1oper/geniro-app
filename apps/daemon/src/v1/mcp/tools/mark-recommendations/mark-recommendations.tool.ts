import { HOST_RECOMMENDATION_MARKS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { markRecommendationsInstructions } from './mark-recommendations.instructions';
import {
  marksResultText,
  readRecommendationMarks,
} from './mark-recommendations.reader';
import { markRecommendationsSchema } from './mark-recommendations.schema';

/** `mark_recommendations` — each applied item's outcome, shown on its card. */
export class MarkRecommendationsTool extends BaseMcpTool {
  readonly name = HOST_RECOMMENDATION_MARKS_TOOL;

  constructor(private readonly analysis: AnalysisBroker) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.analysis.canReview(runId, memberId);
  }

  protected instructions(): string {
    return markRecommendationsInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return markRecommendationsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readRecommendationMarks(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const result = marksResultText(
      await this.analysis.mark(runId, memberId, read.query),
    );
    return this.text(result.text, result.isError);
  }
}
