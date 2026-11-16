import {
  HOST_ANALYZED_THREAD_TOOL,
  HOST_LESSONS_TOOL,
  HOST_RECOMMENDATION_MARKS_TOOL,
  HOST_RECOMMENDATIONS_TOOL,
} from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names the analysis chat's thread reader.
 *
 * The one history reader that is auto-approved, and only because of how it is
 * installed: it exists solely on an analysis chat, reads the ONE thread the
 * user clicked "Analyze" on — or the team they pressed "Analyze & improve" on
 * or opened a builder chat of: the runs the daemon sampled, and any other run
 * of that team the agent names and the reader finds is that team's
 * (`ThreadReaderService.readSourceOf`, the slug the daemon's, never the
 * model's) — each up to its snapshot, beside the team's own ledger figures over
 * its other runs (view=history, view=spend: no transcript text, no folder
 * path), and every answer leads with the data-not-instructions line and is
 * masked of registered secrets. The general history tools (`search_chats`, `read_chat_context`)
 * read every project and stay behind a card. A large thread takes dozens of
 * pages; a card per page would make the analysis unusable outside `auto`.
 */
export function isHostAnalysisReadCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_ANALYZED_THREAD_TOOL);
}

/**
 * Whether a permission request names the recommendations card or its outcome
 * marks — the render family's reading (`isHostFindingsCall`): the call draws
 * in this app's own transcript and changes nothing outside it.
 */
export function isHostRecommendationsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return (
    isHostToolCall(serverName, toolName, HOST_RECOMMENDATIONS_TOOL) ||
    isHostToolCall(serverName, toolName, HOST_RECOMMENDATION_MARKS_TOOL)
  );
}

/**
 * Whether a permission request names `propose_lessons`: installed only on a
 * lessons reflection, it files proposals the user then saves or rejects, and
 * changes nothing an agent reads.
 */
export function isHostLessonsCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return isHostToolCall(serverName, toolName, HOST_LESSONS_TOOL);
}
