import { HOST_RECOMMENDATIONS_TOOL } from '../../../agents/chat.types';
import type { AnalysisBroker } from '../../../agents/services/analysis.broker';
import type { KnowledgeService } from '../../../knowledge/services/knowledge.service';
import type { MemoryService } from '../../../memory/services/memory.service';
import type { TeamHistoryService } from '../../../stats/services/team-history.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { reportRecommendationsInstructions } from './report-recommendations.instructions';
import {
  readRecommendationsCall,
  recommendationsResultText,
} from './report-recommendations.reader';
import { reportRecommendationsSchema } from './report-recommendations.schema';

/** `report_recommendations` — an analysis's selectable recommendations card. */
export class ReportRecommendationsTool extends BaseMcpTool {
  readonly name = HOST_RECOMMENDATIONS_TOOL;

  constructor(
    private readonly analysis: AnalysisBroker,
    private readonly memory: Pick<MemoryService, 'enabled'>,
    private readonly history: Pick<
      TeamHistoryService,
      'versionIndex' | 'population'
    >,
    private readonly knowledge: Pick<KnowledgeService, 'agentsMayWrite'>,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.analysis.canReview(runId, memberId);
  }

  protected instructions(): string {
    return reportRecommendationsInstructions(
      this.memory.enabled,
      this.knowledge.agentsMayWrite,
    );
  }

  protected inputSchema(): Record<string, unknown> {
    return reportRecommendationsSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId, memberId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readRecommendationsCall(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const result = recommendationsResultText(
      await this.analysis.report(
        runId,
        memberId,
        read.query,
        (slug) => this.history.versionIndex(slug),
        (slug) => this.history.population(slug),
      ),
    );
    return this.text(result.text, result.isError);
  }
}
