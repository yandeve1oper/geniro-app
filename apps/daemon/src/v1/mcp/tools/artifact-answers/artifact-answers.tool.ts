import { NotFoundException } from '@packages/common';

import { HOST_ARTIFACT_ANSWERS_TOOL } from '../../../agents/chat.types';
import type { ArtifactBroker } from '../../../agents/services/artifact.broker';
import type { ChatArtifactsService } from '../../../agents/services/chat-artifacts.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { artifactAnswersInstructions } from './artifact-answers.instructions';
import {
  artifactAnswersText,
  readArtifactAnswersArgs,
} from './artifact-answers.reader';
import { artifactAnswersSchema } from './artifact-answers.schema';

/** `artifact_answers` — read what the user picked on the run's pages. Offered beside `show_artifact`. */
export class ArtifactAnswersTool extends BaseMcpTool {
  readonly name = HOST_ARTIFACT_ANSWERS_TOOL;

  constructor(
    private readonly artifacts: ArtifactBroker,
    private readonly pages: ChatArtifactsService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.artifacts.canPublish(runId, memberId);
  }

  protected instructions(): string {
    return artifactAnswersInstructions();
  }

  protected inputSchema(): Record<string, unknown> {
    return artifactAnswersSchema();
  }

  protected async run(
    args: Record<string, unknown>,
    { runId }: McpCallContext,
  ): Promise<McpToolResult> {
    const read = readArtifactAnswersArgs(args);
    if (!read.ok) {
      return this.invalidArgs(read.error);
    }
    const { artifactId } = read.query;
    try {
      return this.text(
        artifactAnswersText(
          await this.pages.keptAnswers(runId, artifactId),
          artifactId,
        ),
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        return this.text('This run no longer exists.', true);
      }
      throw error;
    }
  }
}
