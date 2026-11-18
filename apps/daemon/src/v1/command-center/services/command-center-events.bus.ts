import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type {
  CommandCenterChangedEvent,
  CommandCenterContactEvent,
} from '../command-center.types';

/** How long changes gather before one event names them all. */
export const CHANGED_DEBOUNCE_MS = 500;

/**
 * The command center's live events, for the single fan-out subscriber (the
 * gateway). Changes are gathered per reason for {@link CHANGED_DEBOUNCE_MS}
 * and published once, naming every run that moved; a contact is published at
 * once, since it is what lights the graph.
 */
@Injectable()
export class CommandCenterEventBus implements OnModuleDestroy {
  private readonly changes = new Subject<CommandCenterChangedEvent>();
  private readonly contacts = new Subject<CommandCenterContactEvent>();
  private readonly pending = new Map<
    CommandCenterChangedEvent['reason'],
    Set<string>
  >();
  private timer: ReturnType<typeof setTimeout> | null = null;

  publishChanged(
    runIds: readonly string[],
    reason: CommandCenterChangedEvent['reason'],
  ): void {
    if (runIds.length === 0) {
      return;
    }
    const gathered = this.pending.get(reason) ?? new Set<string>();
    for (const runId of runIds) {
      gathered.add(runId);
    }
    this.pending.set(reason, gathered);
    this.timer ??= setTimeout(() => this.flush(), CHANGED_DEBOUNCE_MS);
  }

  publishContact(event: CommandCenterContactEvent): void {
    this.contacts.next(event);
  }

  allChanges(): Observable<CommandCenterChangedEvent> {
    return this.changes.asObservable();
  }

  allContacts(): Observable<CommandCenterContactEvent> {
    return this.contacts.asObservable();
  }

  onModuleDestroy(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    this.timer = null;
    const batches = [...this.pending];
    this.pending.clear();
    for (const [reason, runIds] of batches) {
      this.changes.next({ runIds: [...runIds], reason });
    }
  }
}
