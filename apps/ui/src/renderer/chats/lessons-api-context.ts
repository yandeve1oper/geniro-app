import { createContext } from 'react';

import type { DaemonApis } from '../daemon-api';

/**
 * The lessons API client (`/v1/lessons`). Provided by `Chats`, which holds the
 * daemon handle; a lessons card drawn without it has its buttons disabled.
 */
export const LessonsApiContext = createContext<DaemonApis['lessons'] | null>(
  null,
);

/** The agents API, for a lessons card to name its models as the model menu does; null shows the raw id. */
export const LessonsAgentsApiContext = createContext<
  DaemonApis['agents'] | null
>(null);

/** Scroll the open transcript to a seq, for a lesson's "Show in thread"; null draws no link. */
export const LessonsJumpContext = createContext<((seq: number) => void) | null>(
  null,
);
