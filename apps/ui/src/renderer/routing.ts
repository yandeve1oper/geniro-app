import type { AppView } from './components/nav-rail';

/**
 * The address bar's view of the app — one member per `AppView` (see
 * `components/nav-rail.tsx`), each carrying whatever id that view can be
 * opened directly to. `chats`/`teams`/`tasks` carry `null` for "this
 * view, nothing further selected" rather than splitting into a separate
 * list-vs-item pair of members, which is what lets `App.tsx` build one from
 * its own state (`threadRequest`) without a branch per shape.
 */
export type Route =
  | { view: 'chats'; runId: string | null }
  | { view: 'teams'; slug: string | null }
  | { view: 'tasks'; projectId: string | null }
  | { view: 'projects'; projectId: string | null }
  | { view: 'knowledge'; documentId: string | null }
  | { view: 'command-center' }
  | { view: 'settings' }
  | { view: 'stats' };

// Explicitly `AppView`-typed (rather than `Route['view']`) so a typo here
// that names something outside `nav-rail.tsx`'s own union is a type error.
const ID_VIEWS: ReadonlySet<AppView> = new Set([
  'chats',
  'teams',
  'tasks',
  'projects',
  'knowledge',
]);

/** The teams view's hash before the rename, still found in saved links. */
const LEGACY_TEAMS_VIEW = 'workflows';

/**
 * Decode a hash's id segment, folding a malformed percent-escape into `null`
 * rather than throwing into a render — a pasted link is untrusted input, and
 * `decodeURIComponent` throws on a lone `%`.
 */
function decodeId(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * Parse a `window.location.hash` into a {@link Route}, or `null` for
 * anything this build does not recognise — an unknown view, a settings/stats
 * hash carrying a stray id segment, or an id segment that fails to decode.
 * The caller's job on `null` is to leave the app on its current view rather
 * than blank it; this function only reads, it never falls back.
 */
export function parseRoute(hash: string): Route | null {
  // Strip a leading `#` and an optional `/`, so `#/chats/<id>` and the bare
  // `#chats/<id>` both resolve the same way.
  const path = hash.replace(/^#\/?/, '');
  const [rawView, rawId] = path.split('/', 2);
  if (rawId !== undefined && rawId.length > 0) {
    const id = decodeId(rawId);
    if (id === null) {
      return null;
    }
    switch (rawView) {
      case 'chats':
        return { view: 'chats', runId: id };
      case 'teams':
      case LEGACY_TEAMS_VIEW:
        return { view: 'teams', slug: id };
      case 'tasks':
        return { view: 'tasks', projectId: id };
      case 'projects':
        return { view: 'projects', projectId: id };
      case 'knowledge':
        return { view: 'knowledge', documentId: id };
      default:
        // `settings`/`stats` take no id at all — a stray segment names no
        // route rather than one this build merely ignores.
        return null;
    }
  }
  switch (rawView) {
    case 'chats':
      return { view: 'chats', runId: null };
    case 'teams':
    case LEGACY_TEAMS_VIEW:
      return { view: 'teams', slug: null };
    case 'tasks':
      return { view: 'tasks', projectId: null };
    case 'projects':
      return { view: 'projects', projectId: null };
    case 'knowledge':
      return { view: 'knowledge', documentId: null };
    case 'command-center':
      return { view: 'command-center' };
    case 'settings':
      return { view: 'settings' };
    case 'stats':
      return { view: 'stats' };
    default:
      return null;
  }
}

/**
 * The inverse of {@link parseRoute} — `parseRoute(formatRoute(route))` must
 * round-trip for every arm, which is what `routing.spec.ts` pins.
 */
export function formatRoute(route: Route): string {
  if (!ID_VIEWS.has(route.view)) {
    return `#/${route.view}`;
  }
  const id =
    route.view === 'chats'
      ? route.runId
      : route.view === 'teams'
        ? route.slug
        : route.view === 'tasks' || route.view === 'projects'
          ? route.projectId
          : route.view === 'knowledge'
            ? route.documentId
            : null;
  return id === null
    ? `#/${route.view}`
    : `#/${route.view}/${encodeURIComponent(id)}`;
}
