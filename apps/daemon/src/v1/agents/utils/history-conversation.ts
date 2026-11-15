import type { HistoryConversation } from '../chat.types';

/**
 * The conversation `GET …/items` was asked to read (`HistoryQueryDto.conversation`
 * / `.call` / `.delegate`), or undefined for the whole run. The DTO refuses more
 * than one at once.
 */
export function historyConversationOf(query: {
  conversation?: 'root';
  call?: string;
  delegate?: string;
}): HistoryConversation | undefined {
  if (query.conversation === 'root') {
    return { root: true };
  }
  if (query.delegate !== undefined) {
    return { delegate: query.delegate };
  }
  return query.call === undefined ? undefined : { call: query.call };
}
