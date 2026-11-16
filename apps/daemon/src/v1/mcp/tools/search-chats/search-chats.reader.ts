import {
  type GlobalChatSearchQuery,
  GlobalChatSearchQuerySchema,
} from '../../../agents/chat.types';
import {
  isOrderedWindow,
  UNORDERED_WINDOW_MESSAGE,
} from '../../../agents/utils/run-activity';
import type { ToolArgs } from '../../mcp.types';
import { readToolArgs } from '../tool-args';

/** A `search_chats` call's query, or why it cannot be read. */
export function readSearchChatsArgs(
  args: Record<string, unknown>,
): ToolArgs<GlobalChatSearchQuery> {
  return readToolArgs(
    GlobalChatSearchQuerySchema.strict().refine(isOrderedWindow, {
      message: UNORDERED_WINDOW_MESSAGE,
    }),
    args,
  );
}
