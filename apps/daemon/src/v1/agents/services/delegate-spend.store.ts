import { EntityManager } from '@mikro-orm/sqlite';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import type { DelegateFigures } from '../adapters/adapter.types';
import { RunDao } from '../dao/run.dao';
import { readDelegateSpend, writeDelegateSpend } from '../utils/delegate-spend';
import { AgentEventBus } from './agent-events.bus';

/**
 * The longest a non-final change waits before it reaches the row. A delegate
 * reports on every request it makes, so writing each report would rewrite the
 * run's column several times a second for as long as a sub-agent runs.
 */
const COALESCE_MS = 2000;

/** One run's half of the store: its figures once read, and its write queue. */
interface RunDelegates {
  /** Null until this process has read the row (or after a write failed). */
  figures: Map<string, DelegateFigures> | null;
  /** The column text last read or written, so an unchanged set is not rewritten. */
  written: string | null;
  /** Every operation for this run, in order — see {@link DelegateSpendStore}. */
  chain: Promise<void>;
  /** The coalesced write a non-final change is waiting for, if any. */
  timer: NodeJS.Timeout | null;
}

/**
 * The durable half of the live plane's delegate figures — `Run.delegateSpend`,
 * kept in step with `PartialStreamService`, which is its only writer.
 *
 * Figures are the run's history: an entry stays while the run exists, so a
 * delegate that finished keeps its figures on the row for the run-state read.
 * WRITE-BEHIND and serialized per run, as `UnrecordedSpendStore` is: the live
 * plane must never wait on the database. A non-final change reaches the row at
 * most once per {@link COALESCE_MS}; a final one, and every turn boundary
 * through {@link flushRun}, writes at once.
 *
 * The first operation on a run reads the column and merges with it, so figures
 * written before a daemon restart are kept, never overwritten.
 */
@Injectable()
export class DelegateSpendStore implements OnModuleInit {
  private readonly logger = new Logger(DelegateSpendStore.name);
  private readonly runs = new Map<string, RunDelegates>();

  constructor(
    private readonly em: EntityManager,
    private readonly runDao: RunDao,
    private readonly bus: AgentEventBus,
  ) {}

  onModuleInit(): void {
    this.bus.allDeleted().subscribe((runId) => {
      const entry = this.runs.get(runId);
      if (entry !== undefined) {
        this.cancelTimer(entry);
      }
      this.runs.delete(runId);
    });
  }

  /** Record one delegate's figures; a final reading is written at once. */
  set(
    runId: string,
    delegateId: string,
    figures: DelegateFigures,
    final: boolean,
  ): void {
    const entry = this.entryOf(runId);
    this.queue(runId, entry, (held) => held.set(delegateId, figures), final);
    if (final) {
      this.cancelTimer(entry);
    } else {
      this.armTimer(runId, entry);
    }
  }

  /** Write whatever the run has pending now, and cancel its coalesced write. */
  flushRun(runId: string): void {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      return;
    }
    this.cancelTimer(entry);
    this.queue(runId, entry, null, true);
  }

  /** Resolves once every operation queued so far for `runId` has landed. */
  async flushed(runId: string): Promise<void> {
    await this.runs.get(runId)?.chain;
  }

  private queue(
    runId: string,
    entry: RunDelegates,
    mutate: ((figures: Map<string, DelegateFigures>) => void) | null,
    write: boolean,
  ): void {
    entry.chain = entry.chain
      .then(async () => {
        const em = this.em.fork();
        let figures = entry.figures;
        if (figures === null) {
          figures = readDelegateSpend(
            await this.runDao.delegateSpendOf(runId, em),
          );
          entry.figures = figures;
          entry.written = writeDelegateSpend(figures);
        }
        mutate?.(figures);
        if (write) {
          await this.write(runId, entry, figures, em);
        }
      })
      .catch((err: unknown) => {
        entry.figures = null;
        this.logger.warn(
          `could not record the delegate figures of run ${runId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  private async write(
    runId: string,
    entry: RunDelegates,
    figures: Map<string, DelegateFigures>,
    em: EntityManager,
  ): Promise<void> {
    const text = writeDelegateSpend(figures);
    if (text === entry.written) {
      return;
    }
    await this.runDao.setDelegateSpend(runId, text, em);
    entry.written = text;
  }

  private armTimer(runId: string, entry: RunDelegates): void {
    if (entry.timer !== null) {
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = null;
      this.flushRun(runId);
    }, COALESCE_MS);
    entry.timer.unref();
  }

  private cancelTimer(entry: RunDelegates): void {
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  private entryOf(runId: string): RunDelegates {
    let entry = this.runs.get(runId);
    if (!entry) {
      entry = {
        figures: null,
        written: null,
        chain: Promise.resolve(),
        timer: null,
      };
      this.runs.set(runId, entry);
    }
    return entry;
  }
}
