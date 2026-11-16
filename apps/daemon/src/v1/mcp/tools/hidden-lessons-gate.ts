import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_CHECK_LESSONS_TOOL,
  HOST_LESSONS_TOOL,
  HOST_MEMORY_READ_TOOL,
  HOST_MEMORY_SEARCH_TOOL,
} from '../../agents/chat.types';
import type { AnalysisBroker } from '../../agents/services/analysis.broker';
import type { McpTool } from '../mcp.types';

/** The only geniro tools a hidden lessons chat — a reflection or its check — is listed. */
export const HIDDEN_LESSONS_TOOLS: ReadonlySet<string> = new Set([
  HOST_ANALYZED_THREAD_TOOL,
  HOST_MEMORY_SEARCH_TOOL,
  HOST_MEMORY_READ_TOOL,
  HOST_LESSONS_TOOL,
  HOST_CHECK_LESSONS_TOOL,
]);

/**
 * Lists a hidden lessons chat only the tools it works with. Every schema a
 * CLI is listed rides the prompt prefix written to the cache on each
 * reflection, so a tool the chat never uses is spend on every run.
 */
export function gatedForHiddenLessons(
  tool: McpTool,
  analysis: Pick<AnalysisBroker, 'isHiddenLessons'>,
): McpTool {
  return {
    handles: (name) => tool.handles(name),
    list: (context) => {
      const listed = tool.list(context);
      return analysis.isHiddenLessons(context.runId, context.memberId)
        ? listed.filter((entry) => HIDDEN_LESSONS_TOOLS.has(entry.name))
        : listed;
    },
    call: (name, args, context) => tool.call(name, args, context),
  };
}
