import { createContext } from 'react';

import type { LessonDocumentsReader } from '../components/lessons-card';
import type { DaemonApis } from '../daemon-api';
import { describeDaemonError } from '../daemon-api';

/** The statuses of a lesson still waiting on the user's decision. */
export const WAITING_LESSON_STATUSES = 'proposed,check_failed';

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

/** The knowledge API, for a lesson's target picker to list a project's documents; null leaves the picker without them. */
export const LessonsKnowledgeApiContext = createContext<
  DaemonApis['knowledge'] | null
>(null);

/** The daemon's refusal as a lesson's error line; the rest passes through. */
export function described(call: Promise<unknown>): Promise<void> {
  return call.then(
    () => undefined,
    (err: unknown) => {
      throw new Error(describeDaemonError(err));
    },
  );
}

/** The project's active documents, by handle and title, for a target picker. */
export function documentsReaderOf(
  api: DaemonApis['knowledge'] | null,
): LessonDocumentsReader | null {
  if (api === null) {
    return null;
  }
  return (projectId: string) =>
    api.listKnowledge({ place: `project:${projectId}`, status: 'active' }).then(
      ({ documents }) =>
        documents.map((document) => ({
          handle: document.handle,
          title: document.title,
        })),
      (err: unknown) => {
        throw new Error(describeDaemonError(err));
      },
    );
}
