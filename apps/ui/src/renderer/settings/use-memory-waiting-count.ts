import { useEffect, useState } from 'react';

import { WAITING_LESSON_STATUSES } from '../chats/lessons-api-context';
import { useLatestCallback } from '../components/use-latest-callback';
import type { DaemonApis } from '../daemon-api';
import type { DaemonClient } from '../daemon-client';

/** Null until both reads answer, and again when one fails, so a stale count is never drawn. */
export function useMemoryWaitingCount(
  apis: DaemonApis | null,
  client: DaemonClient | null,
): number | null {
  const [waiting, setWaiting] = useState<number | null>(null);
  const read = useLatestCallback(() => {
    if (apis === null) {
      return;
    }
    void Promise.all([
      apis.memories.memoryReviewSummary({}),
      apis.lessons.listLessonProposals({ status: WAITING_LESSON_STATUSES }),
    ])
      .then(([summary, lessons]) =>
        setWaiting(summary.pending + lessons.proposals.length),
      )
      .catch(() => setWaiting(null));
  }, [apis]);

  useEffect(() => {
    read();
    if (client === null) {
      return;
    }
    const offMemory = client.onMemoryChanged(read);
    const offLessons = client.onLessonsChanged(read);
    const offConnected = client.onReconnect(read);
    return () => {
      offMemory();
      offLessons();
      offConnected();
    };
  }, [apis, client, read]);

  return waiting;
}
