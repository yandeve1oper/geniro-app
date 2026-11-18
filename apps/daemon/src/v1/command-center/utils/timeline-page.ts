import { TIMELINE_TEXT_MAX_CHARS } from '../command-center.types';

export interface TimedRow {
  id: string;
  at: Date;
}

export function oneLine(text: string | null | undefined): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (line === '') {
    return null;
  }
  return line.length > TIMELINE_TEXT_MAX_CHARS
    ? `${line.slice(0, TIMELINE_TEXT_MAX_CHARS - 1)}…`
    : line;
}

/**
 * The newest `limit` rows, newest first, with every row sharing the cut's
 * instant kept too, so `nextBefore` (that instant, read as "strictly older")
 * never skips a row. `nextBefore` is null when nothing lies past the page.
 */
export function pageOf<T extends TimedRow>(
  rows: readonly T[],
  limit: number,
): { rows: T[]; nextBefore: Date | null } {
  const sorted = [...rows].sort(
    (a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id),
  );
  if (sorted.length <= limit) {
    return { rows: sorted, nextBefore: null };
  }
  const boundary = sorted[limit - 1]!.at;
  return {
    rows: sorted.filter(
      (row, index) => index < limit || row.at.getTime() === boundary.getTime(),
    ),
    nextBefore: boundary,
  };
}
