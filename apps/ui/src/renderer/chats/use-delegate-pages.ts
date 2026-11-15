import { createContext } from 'react';

import type { CallConversationState } from './call-conversation';
import {
  type ConversationFilter,
  type ConversationPagesArgs,
  useConversationPages,
} from './use-call-pages';

/** Where reading one sub-agent's own rows stands, keyed by its launching call. */
export interface DelegateConversationLoader {
  /** The delegate's newest page, once — or, with `older`, the page before the oldest held. */
  load(delegateId: string, older: boolean): void;
  /** Ask again for a delegate whose read failed. */
  retry(delegateId: string): void;
  /** Null before the delegate was first asked for. */
  stateOf(delegateId: string): CallConversationState | null;
}

/** Null where the transcript holds every row itself. */
export const DelegateConversationContext =
  createContext<DelegateConversationLoader | null>(null);

const delegateFilter = (delegateId: string): ConversationFilter => ({
  delegate: delegateId,
});

/**
 * One sub-agent's rows, read page by page through the shared paging core — the
 * same reads a call card's conversation makes, named by the delegate instead.
 */
export function useDelegatePages(args: ConversationPagesArgs): {
  delegateConversations: DelegateConversationLoader;
  /** Forget what was read, at every place the rows go — see `useCallPages`. */
  forgetDelegatePages: () => void;
} {
  const { loader, forget } = useConversationPages({
    ...args,
    filterOf: delegateFilter,
  });
  return { delegateConversations: loader, forgetDelegatePages: forget };
}
