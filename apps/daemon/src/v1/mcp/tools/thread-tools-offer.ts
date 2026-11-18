import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { CommandCenterBroker } from '../../agents/services/command-center.broker';
import type { ProjectChatBroker } from '../../agents/services/project-chat.broker';
import type { TeamBuilderBroker } from '../../agents/services/team-builder.broker';
import type { McpListContext } from '../mcp.types';

/** The brokers that say a turn belongs to one of the app's own chats. */
export interface ThreadToolGates {
  analysis: AnalysisBroker;
  teamBuilders: TeamBuilderBroker;
  projectChats: ProjectChatBroker;
  commandCenters: CommandCenterBroker;
}

/**
 * Whether a turn belongs to the app's own analysis, builder or project chat,
 * or to the command center's manager — which reaches threads through its own
 * `tell_threads` instead of `list_threads` / `message_thread`.
 */
export function isAppOwnChat(
  gates: ThreadToolGates,
  { runId, memberId }: McpListContext,
): boolean {
  return (
    gates.analysis.canAnalyse(runId, memberId) ||
    gates.teamBuilders.canEdit(runId, memberId) ||
    gates.projectChats.canEdit(runId, memberId) ||
    gates.commandCenters.canManage(runId, memberId)
  );
}

/** Whether a turn is offered the tools that reach other threads. */
export function offersThreadTools(
  gates: ThreadToolGates,
  context: McpListContext,
): boolean {
  return !isAppOwnChat(gates, context);
}
