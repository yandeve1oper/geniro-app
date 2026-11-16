import {
  type PendingQuestionSnapshot,
  readPendingQuestion,
  serializePendingQuestion,
} from './pending-question';

/** One member's standing question card, as `Run.pendingMemberQuestions` holds it. */
export interface PendingMemberQuestion {
  memberId: string;
  card: PendingQuestionSnapshot;
}

export function serializeMemberQuestions(
  entries: readonly PendingMemberQuestion[],
): string | null {
  return entries.length === 0
    ? null
    : JSON.stringify(
        entries.map(({ memberId, card }) => ({
          memberId,
          ...(JSON.parse(serializePendingQuestion(card)) as Record<
            string,
            unknown
          >),
        })),
      );
}

function rawEntries(value: string | null): Record<string, unknown>[] {
  if (value === null || value.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === 'object',
        )
      : [];
  } catch {
    return [];
  }
}

/** Every card's id, even one whose questions no longer read — so it can still be closed. */
export function memberQuestionIds(value: string | null): string[] {
  return rawEntries(value).flatMap((entry) =>
    typeof entry.requestId === 'string' && entry.requestId.length > 0
      ? [entry.requestId]
      : [],
  );
}

/** The cards that still read, each through the reader the live call uses. */
export function readMemberQuestions(
  value: string | null,
): PendingMemberQuestion[] {
  return rawEntries(value).flatMap(({ memberId, ...card }) => {
    const read = readPendingQuestion(JSON.stringify(card));
    return typeof memberId === 'string' &&
      memberId.length > 0 &&
      read?.kind === 'question'
      ? [{ memberId, card: read }]
      : [];
  });
}
