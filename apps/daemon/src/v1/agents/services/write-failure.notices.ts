import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

import { redactSecrets } from '../../diagnostics/utils/redact';
import { RunNoticeWriter } from './run-notice.writer';

/**
 * How long one run's write failures are gathered before its notice row is
 * written: a broken write tends to fail in bursts, one per event, and the
 * thread gets one row for the burst rather than one per event.
 */
export const WRITE_FAILURE_NOTICE_DELAY_MS = 5_000;

const MAX_REASON_CHARS = 300;

interface PendingFailures {
  count: number;
  reason: string;
  timer: NodeJS.Timeout;
}

/**
 * Tells the user, in the thread itself, that some of its events were not saved.
 *
 * A row the database refused is gone from the transcript and from every
 * figure folded from it — a call that never ends, a member that keeps
 * "working" — and the debug log was the only place that said so. Each event
 * chain (a chat turn's, a team pass's) reports every write it lost here, and
 * the run gets one warning row per burst naming how many and why.
 */
@Injectable()
export class WriteFailureNotices implements OnApplicationShutdown {
  private readonly pending = new Map<string, PendingFailures>();

  constructor(private readonly notices: RunNoticeWriter) {}

  note(runId: string, err: unknown): void {
    const held = this.pending.get(runId);
    if (held !== undefined) {
      held.count += 1;
      return;
    }
    const timer = setTimeout(() => {
      void this.flush(runId);
    }, WRITE_FAILURE_NOTICE_DELAY_MS);
    timer.unref();
    this.pending.set(runId, { count: 1, reason: reasonOf(err), timer });
  }

  onApplicationShutdown(): void {
    for (const held of this.pending.values()) {
      clearTimeout(held.timer);
    }
    this.pending.clear();
  }

  private async flush(runId: string): Promise<void> {
    const held = this.pending.get(runId);
    if (held === undefined) {
      return;
    }
    this.pending.delete(runId);
    const events = held.count === 1 ? '1 event' : `${held.count} events`;
    await this.notices.warn(
      runId,
      `${events} of this thread could not be saved, so its transcript is missing them and an agent or call it shows as working may already have stopped. Reason: ${held.reason}`,
      'Not saved',
    );
  }
}

function reasonOf(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const line = redactSecrets(text.split('\n', 1)[0] ?? '').trim();
  return line.length <= MAX_REASON_CHARS
    ? line
    : `${line.slice(0, MAX_REASON_CHARS)}…`;
}
