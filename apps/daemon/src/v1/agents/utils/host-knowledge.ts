import { HOST_KNOWLEDGE_TOOLS } from '../chat.types';
import { isHostToolCall } from './host-tool';

/**
 * Whether a permission request names one of the knowledge store's tools.
 *
 * Auto-approved because a card per call would make it unusable, and a card
 * reaches no team member. What makes that safe sits in `KnowledgeService`, not
 * in the approval: a read sees only the run's own places, and a write is held
 * to the user's `agentWrites` setting, and a document saved at once stays out
 * of every run's index until the user loads it there.
 */
export function isHostKnowledgeCall(
  serverName: string | null,
  toolName: string,
): boolean {
  return HOST_KNOWLEDGE_TOOLS.some((tool) =>
    isHostToolCall(serverName, toolName, tool),
  );
}
