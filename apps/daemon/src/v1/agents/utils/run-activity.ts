import type { Expression, ExpressionBuilder, Kysely, SqlBool } from 'kysely';

import type { ActivityWindow, ChatTextDatabase } from '../chat.types';

type RunsAsR = ChatTextDatabase & { r: ChatTextDatabase['runs'] };

type RunScope = ExpressionBuilder<RunsAsR, 'r'>;

export function newestItemAt(eb: RunScope) {
  return eb
    .selectFrom('items as newest')
    .select('newest.created_at')
    .whereRef('newest.run_id', '=', 'r.id')
    .where('newest.deleted_at', 'is', null)
    .orderBy('newest.seq', 'desc')
    .orderBy('newest.created_at', 'desc')
    .limit(1);
}

export function newestUserMessageAt(eb: RunScope) {
  return eb
    .selectFrom('items as asked')
    .select('asked.created_at')
    .whereRef('asked.run_id', '=', 'r.id')
    .where('asked.kind', '=', 'message')
    .where('asked.role', '=', 'user')
    .where('asked.in_call', 'is', null)
    .where('asked.parent_tool_use_id', 'is', null)
    .where('asked.deleted_at', 'is', null)
    .orderBy('asked.seq', 'desc')
    .orderBy('asked.created_at', 'desc')
    .limit(1);
}

export function activityWindowOf(query: {
  activeSince?: string;
  activeUntil?: string;
}): ActivityWindow | undefined {
  const window: ActivityWindow = {
    ...(query.activeSince === undefined
      ? {}
      : { since: new Date(query.activeSince) }),
    ...(query.activeUntil === undefined
      ? {}
      : { until: new Date(query.activeUntil) }),
  };
  return hasActivityWindow(window) ? window : undefined;
}

export function isOrderedWindow(query: {
  activeSince?: string;
  activeUntil?: string;
}): boolean {
  return (
    query.activeSince === undefined ||
    query.activeUntil === undefined ||
    Date.parse(query.activeUntil) > Date.parse(query.activeSince)
  );
}

export const UNORDERED_WINDOW_MESSAGE = 'activeUntil must be after activeSince';

export function hasActivityWindow(
  window: ActivityWindow | undefined,
): window is ActivityWindow {
  return window?.since !== undefined || window?.until !== undefined;
}

export function windowBounds<DB, TB extends keyof DB>(
  eb: ExpressionBuilder<DB, TB>,
  at: Expression<number | null>,
  window: ActivityWindow,
): Expression<SqlBool> {
  const bounds: Expression<SqlBool>[] = [];
  if (window.since !== undefined) {
    bounds.push(eb(at, '>=', window.since.getTime()));
  }
  if (window.until !== undefined) {
    bounds.push(eb(at, '<', window.until.getTime()));
  }
  return eb.and(bounds);
}

export function activeIn(eb: RunScope, window: ActivityWindow) {
  return windowBounds(eb, newestItemAt(eb).$asScalar(), window);
}

export function runIdsActiveIn(
  db: Kysely<ChatTextDatabase>,
  window: ActivityWindow,
) {
  return db
    .selectFrom('runs as r')
    .select('r.id')
    .where((eb) => activeIn(eb, window));
}
