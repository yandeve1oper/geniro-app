import type { AgentEvent, LiveWordsEvent } from '../adapters/adapter.types';

/** Whether the event belongs on the live plane's words or reasoning, never on a row. */
export function isLiveWordsEvent(event: AgentEvent): event is LiveWordsEvent {
  return (
    event.type === 'text_delta' ||
    event.type === 'thinking_progress' ||
    event.type === 'reasoning_delta'
  );
}
