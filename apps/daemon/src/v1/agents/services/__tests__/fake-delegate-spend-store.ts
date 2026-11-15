import type { DelegateFigures } from '../../adapters/adapter.types';
import type { DelegateSpendStore } from '../delegate-spend.store';

/**
 * An in-memory {@link DelegateSpendStore} for specs that drive the live plane
 * without a database. It keeps what the column would hold — a figure set per
 * delegate, replaced on each write — and leaves the timing and the database
 * to the real store's own spec.
 */
export class FakeDelegateSpendStore {
  /** run → delegate id → figures, as the column would hold them. */
  readonly runs = new Map<string, Map<string, DelegateFigures>>();

  constructor(seed: Record<string, Record<string, DelegateFigures>> = {}) {
    for (const [runId, figures] of Object.entries(seed)) {
      this.runs.set(runId, new Map(Object.entries(figures)));
    }
  }

  set(runId: string, delegateId: string, figures: DelegateFigures): void {
    const held = this.runs.get(runId) ?? new Map<string, DelegateFigures>();
    held.set(delegateId, figures);
    this.runs.set(runId, held);
  }

  flushRun(): void {}

  /** One run's figures as a plain object — for assertions. */
  of(runId: string): Record<string, DelegateFigures> {
    return Object.fromEntries(this.runs.get(runId) ?? []);
  }

  asStore(): DelegateSpendStore {
    return this as unknown as DelegateSpendStore;
  }
}
