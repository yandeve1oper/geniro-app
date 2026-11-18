/** One roster thread a manager may name. */
export interface NameableThread {
  handle: string;
  runId: string;
  title: string;
}

export type TargetResolution =
  | { kind: 'resolved'; thread: NameableThread }
  | { kind: 'ambiguous'; candidates: NameableThread[] }
  | { kind: 'unknown'; candidates: NameableThread[] };

const CANDIDATES_MAX = 5;

function folded(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * What a manager's name for a thread names on its roster: a handle (`t3`), a
 * run id, or a title matched exactly, case and spacing aside. A name two roster
 * titles share, exactly or as a part of each, is ambiguous; a name matching no
 * title exactly comes back with the one title containing it, if any, to ask
 * the user with rather than guess.
 */
export function resolveTarget(
  name: string,
  roster: readonly NameableThread[],
): TargetResolution {
  const wanted = folded(name);
  const byHandle = roster.find((thread) => folded(thread.handle) === wanted);
  if (byHandle !== undefined) {
    return { kind: 'resolved', thread: byHandle };
  }
  const byId = roster.find((thread) => thread.runId === name.trim());
  if (byId !== undefined) {
    return { kind: 'resolved', thread: byId };
  }
  const byTitle = roster.filter((thread) => folded(thread.title) === wanted);
  if (byTitle.length === 1 && byTitle[0] !== undefined) {
    return { kind: 'resolved', thread: byTitle[0] };
  }
  if (byTitle.length > 1) {
    return { kind: 'ambiguous', candidates: byTitle.slice(0, CANDIDATES_MAX) };
  }
  const containing =
    wanted === ''
      ? []
      : roster.filter((thread) => folded(thread.title).includes(wanted));
  return {
    kind: containing.length > 1 ? 'ambiguous' : 'unknown',
    candidates: containing.slice(0, CANDIDATES_MAX),
  };
}
