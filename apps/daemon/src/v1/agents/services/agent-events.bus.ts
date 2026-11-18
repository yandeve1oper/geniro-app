import { Injectable, Optional } from '@nestjs/common';
import { type Observable, Subject } from 'rxjs';

import type {
  PullRequestsCapturedEvent,
  ReplyCreditSpent,
  RunCreatedEvent,
  RunDeltaEvent,
  RunItemEvent,
  RunStatusEvent,
  RunWire,
  ThreadMessagesChange,
  ThreadMessageSent,
} from '../chat.types';
import { RunContextRegistry } from './run-context.registry';

/**
 * In-process pub-sub for persisted run items — the `session_stream`-style bus.
 * The chat service publishes each item AFTER it is persisted (persist-then-emit)
 * so the durable transcript is always the source of truth; the notifications
 * gateway subscribes and fans events out to per-run Socket.IO rooms. RxJS only
 * (no `@nestjs/event-emitter`), since `rxjs` is already a daemon dependency.
 */
@Injectable()
export class AgentEventBus {
  /**
   * `@Optional()` so a bare `new AgentEventBus()` still works — a dozen specs
   * build one to assert what a subscriber receives, and none of them is about
   * the stamp. A bus without the registry publishes exactly what it is handed,
   * which is the pre-existing behaviour rather than a degraded one.
   */
  constructor(@Optional() private readonly contexts?: RunContextRegistry) {}

  private readonly subject = new Subject<RunItemEvent>();
  private readonly deltas = new Subject<RunDeltaEvent>();
  private readonly statuses = new Subject<RunStatusEvent>();
  private readonly deleted = new Subject<string>();
  private readonly threadMessageChanges = new Subject<ThreadMessagesChange>();
  private readonly threadMessagesSent = new Subject<ThreadMessageSent>();
  private readonly replyCreditsSpent = new Subject<ReplyCreditSpent>();
  private readonly changed = new Subject<RunWire[]>();
  private readonly groupsChanged = new Subject<void>();
  private readonly runCreated = new Subject<RunCreatedEvent>();
  private readonly pullRequestsCaptured =
    new Subject<PullRequestsCapturedEvent>();

  publish(event: RunItemEvent): void {
    this.subject.next(event);
  }

  /** All run-item events, for a single fan-out subscriber (the gateway). */
  all(): Observable<RunItemEvent> {
    return this.subject.asObservable();
  }

  /**
   * The EPHEMERAL live-text plane — a deliberately separate stream from
   * {@link publish}.
   *
   * Kept apart rather than widening `RunItemEvent` because that type's whole
   * meaning is "already persisted": one union would make it possible to hand a
   * never-persisted delta to a subscriber that reasonably assumes a durable
   * row exists behind it. Two streams make the invariant unmistakable at every
   * call site, and the gateway simply fans both into the same run room.
   */
  publishDelta(event: RunDeltaEvent): void {
    this.deltas.next(event);
  }

  /** All live-text events, for the same single fan-out subscriber. */
  allDeltas(): Observable<RunDeltaEvent> {
    return this.deltas.asObservable();
  }

  /**
   * A run's status changed.
   *
   * Broadcast to EVERY client rather than to the run's room, because the
   * sidebar shows runs the user is not looking at: live items only reach the
   * room of the run in focus, so a background run's badge went stale the
   * moment it settled and stayed stale until the next refetch. Status is a
   * handful of bytes per settle, so there is no reason to make the user's
   * attention decide whether it is accurate.
   */
  publishRunStatus(event: RunStatusEvent): void {
    this.statuses.next(this.withContextReading(event));
  }

  /**
   * Stamp the run's newest context reading onto a status event that does not
   * already carry one.
   *
   * HERE rather than at the producers, and that is the whole point: there are
   * five announce sites in the chat service alone, three more in the title
   * service, and one shared settle helper both the chat and team paths go
   * through. A fact carried by "whichever of those remembered to add it" is a
   * fact that goes stale at the next call site somebody writes — which is
   * exactly how the ring came to be an hour behind. One seam cannot be
   * forgotten.
   *
   * It is additive and never corrective: an event that states the pair itself
   * is left alone, and a run the registry has never heard of is published
   * exactly as it was, so a producer keeps the last word and nothing invents a
   * figure for a run that has none.
   */
  private withContextReading(event: RunStatusEvent): RunStatusEvent {
    if (event.contextTokens !== undefined) {
      return event;
    }
    const reading = this.contexts?.read(event.runId) ?? null;
    if (reading === null) {
      return event;
    }
    return {
      ...event,
      contextTokens: reading.tokens,
      contextEstimated: reading.estimated,
      contextWindowTokens: reading.window,
    };
  }

  /** A thread's waiting messages changed. Names the thread, never the text. */
  publishThreadMessagesChanged(runId: string): void {
    this.threadMessageChanges.next({ runId });
  }

  allThreadMessageChanges(): Observable<ThreadMessagesChange> {
    return this.threadMessageChanges.asObservable();
  }

  /** A message between threads was written. Names both ends, never the text. */
  publishThreadMessageSent(sent: ThreadMessageSent): void {
    this.threadMessagesSent.next(sent);
  }

  allThreadMessagesSent(): Observable<ThreadMessageSent> {
    return this.threadMessagesSent.asObservable();
  }

  publishReplyCreditSpent(spent: ReplyCreditSpent): void {
    this.replyCreditsSpent.next(spent);
  }

  allReplyCreditsSpent(): Observable<ReplyCreditSpent> {
    return this.replyCreditsSpent.asObservable();
  }

  /** All run-status changes, for the single fan-out subscriber. */
  allStatuses(): Observable<RunStatusEvent> {
    return this.statuses.asObservable();
  }

  /**
   * A run and everything it owned has been deleted.
   *
   * A third stream rather than a direct call, because the things that must
   * react live in modules ABOVE this one — `TeamsModule` imports
   * `AgentsModule`, so the chat service cannot inject a team-side holder
   * without a module cycle. Announcing the deletion downward inverts that
   * dependency: anything holding per-run state subscribes and cleans up its
   * own, which is also how a second such holder gets added later without
   * touching the deleting code.
   *
   * Fired AFTER the durable rows are gone, so a subscriber can never observe a
   * half-deleted run.
   */
  publishRunDeleted(runId: string): void {
    this.deleted.next(runId);
  }

  /** Run ids whose records have been deleted. */
  allDeleted(): Observable<string> {
    return this.deleted.asObservable();
  }

  /**
   * Runs whose ROW the user re-filed — archived, unarchived, renamed, moved
   * into a group, pinned or reordered — carried whole, as the route answered.
   *
   * The sibling of {@link publishRunDeleted} and needed for its reason: the
   * client that pressed the button re-files its own row from the reply, and
   * every OTHER client — the phone over the LAN gateway, a second window —
   * learned nothing, so a thread archived on one device stayed on the other's
   * desk until the next full re-list. `run_status` cannot carry it: it is an
   * announce about what a run is DOING, and none of these changes it.
   */
  publishRunsChanged(runs: RunWire[]): void {
    if (runs.length > 0) {
      this.changed.next(runs);
    }
  }

  /** Re-filed run rows, for the single fan-out subscriber (the gateway). */
  allChanged(): Observable<RunWire[]> {
    return this.changed.asObservable();
  }

  /**
   * The sidebar's GROUPS changed — one was created, renamed, recoloured,
   * folded, given a rule, reordered or deleted.
   *
   * The third sibling of {@link publishRunsChanged}, for the same reason: the
   * client that made the change re-reads from its own reply, and every OTHER
   * client — the phone over the LAN gateway — learned nothing until its next
   * reconnect, so a group made on one device was missing from the other's
   * sidebar. It carries no payload: groups are few, and the one listing route
   * is the single answer every client already reads them from.
   */
  publishGroupsChanged(): void {
    this.groupsChanged.next();
  }

  /** Group-list changes, for the single fan-out subscriber (the gateway). */
  allGroupsChanged(): Observable<void> {
    return this.groupsChanged.asObservable();
  }

  /**
   * A run row was persisted — a chat or a team run, at its creation. Published
   * AFTER the write (persist-then-emit), so a subscriber never sees a run that does not
   * exist. The Stats ledger counts threads from here, because the module that owns the
   * ledger imports this one and not the reverse.
   */
  publishRunCreated(event: RunCreatedEvent): void {
    this.runCreated.next(event);
  }

  /** Run creations, for the single subscriber that counts threads. */
  allRunCreated(): Observable<RunCreatedEvent> {
    return this.runCreated.asObservable();
  }

  /**
   * Pull requests a thread has just been seen to open: only the new ones, each announced
   * once. They are read from the transcript, so each carries when the agent opened it.
   */
  publishPullRequestsCaptured(event: PullRequestsCapturedEvent): void {
    if (event.pullRequests.length > 0) {
      this.pullRequestsCaptured.next(event);
    }
  }

  /** Captured pull requests, for the single subscriber that counts them. */
  allPullRequestsCaptured(): Observable<PullRequestsCapturedEvent> {
    return this.pullRequestsCaptured.asObservable();
  }
}
