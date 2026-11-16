import { HOST_ARTIFACT_TOOL } from '../../../agents/chat.types';
import type { ArtifactBroker } from '../../../agents/services/artifact.broker';
import type { ShareService } from '../../../shares/services/share.service';
import type {
  McpCallContext,
  McpListContext,
  McpToolResult,
} from '../../mcp.types';
import { BaseMcpTool } from '../base-mcp-tool';
import { showArtifactInstructions } from './show-artifact.instructions';
import {
  hostArtifactResultText,
  readHostArtifact,
  readShareRequested,
} from './show-artifact.reader';
import { showArtifactSchema } from './show-artifact.schema';

/** `show_artifact` — publish a page the agent wrote, revisable in place. */
export class ShowArtifactTool extends BaseMcpTool {
  readonly name = HOST_ARTIFACT_TOOL;

  constructor(
    private readonly artifacts: ArtifactBroker,
    private readonly shares: ShareService,
  ) {
    super();
  }

  protected isOffered({ runId, memberId }: McpListContext): boolean {
    return this.artifacts.canPublish(runId, memberId);
  }

  protected instructions({ runId }: McpListContext): string {
    return showArtifactInstructions(
      this.artifacts.inTeamRun(runId),
      this.shares.agentsMayShare(),
    );
  }

  protected inputSchema(): Record<string, unknown> {
    return showArtifactSchema(this.shares.agentsMayShare());
  }

  protected async run(
    args: Record<string, unknown>,
    context: McpCallContext,
  ): Promise<McpToolResult> {
    const { runId, memberId, caller, conversationId } = context;
    const read = readHostArtifact(args);
    if (!read.ok) {
      return this.invalidArgs(read.reason);
    }
    const { artifact } = read;
    const outcome = await this.artifacts.publish(
      runId,
      memberId,
      artifact,
      caller,
    );
    // Shared only AFTER the page is published, and a failed share never
    // fails the publish: the page is on the user's screen either way, and
    // the receipt says why there is no link. The share service re-checks the
    // user's switch itself, because a kept CLI may still hold a description
    // listed while it was on.
    const share =
      outcome.status === 'published' && readShareRequested(args)
        ? await this.shares.shareForAgent(
            {
              runId,
              artifactId: outcome.artifactId,
              title: artifact.title,
              // Woken with the link if the share has to wait for the user
              // to sign in.
              asker: {
                runId,
                memberId,
                conversationId,
                caller,
                target: this.artifacts.inTeamRun(runId) ? 'team' : 'chat',
              },
            },
            context.remote,
          )
        : null;
    // Same reading as its drawing siblings, and it covers `rejected` too:
    // an oversize page is an answer the agent acts on by writing a
    // smaller one, not a call it got wrong.
    return this.text(hostArtifactResultText(outcome, share));
  }
}
