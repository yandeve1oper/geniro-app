import type { AgentEvent } from '../adapters/adapter.types';
import { mapEventToItem } from './event-to-item';
import { shellCloseEvent, strandedShells } from './open-shells';

/**
 * Close every detached command an IMPORTED conversation leaves open: no CLI
 * process of this daemon's will ever report on it, so it would read
 * `running · detached` for the life of the thread.
 *
 * Closed unconditionally. The command was started outside Geniro, and the
 * process table cannot say whose it is: a prefix match would pin an old
 * session's `pnpm dev` to the running app's own. Which are open is the same
 * fold the boot and run-end sweeps take over stored rows, so an import and a
 * sweep cannot disagree.
 */
export function closeImportedShells(events: AgentEvent[]): AgentEvent[] {
  const rows = events.flatMap((event) => {
    const item = mapEventToItem(event);
    return item === null ||
      (item.kind !== 'shell_open' && item.kind !== 'shell_info')
      ? []
      : [{ kind: item.kind, payload: item.payload, memberId: null }];
  });
  const open = strandedShells(rows);
  return open.length === 0 ? events : [...events, ...open.map(shellCloseEvent)];
}
