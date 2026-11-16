import { Injectable } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type { LessonsChangedEvent } from '../lessons.types';

/**
 * A thread's lesson segments or proposals changed — an offer appeared, was
 * dismissed, a reflection started, filed or failed. The notifications gateway
 * broadcasts it as `lessons_changed`, so "Not reflected yet" and an offer row
 * re-read without polling. Published after the write.
 */
@Injectable()
export class LessonsEventBus {
  private readonly changes = new Subject<LessonsChangedEvent>();

  publishChanged(runId: string | null): void {
    this.changes.next({ runId });
  }

  allChanges(): Observable<LessonsChangedEvent> {
    return this.changes.asObservable();
  }
}
