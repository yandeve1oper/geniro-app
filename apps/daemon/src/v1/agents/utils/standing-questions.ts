import {
  type HostQuestion,
  type HostQuestionOutcome,
  type StandingHostQuestion,
} from '../chat.types';

/** The agent call parked on a card, resolved once the card answers it. */
export type HostQuestionResolver = (outcome: HostQuestionOutcome) => void;

/**
 * The question CARDS one turn has on screen, and the four transitions between
 * them: OPEN, ADOPT, DETACH and CLOSE.
 *
 * Per TURN, and owned by the turn rather than by the run — see
 * {@link StandingHostQuestion} for the measurement that makes a card outlive
 * the agent call that raised it, and `chat.types.ts` for why the span is the
 * turn's.
 *
 * A card is keyed by what it ASKS — every word it shows — so a re-ask carrying
 * the identical title and questions finds the card already up and adopts it,
 * while a rewording is a different question and gets its own card. That is the
 * honest reading: the person is being asked something else.
 *
 * It holds no persistence and no registry. Everything here is the protocol
 * alone, so the states two racing agent calls can put one card into are
 * reachable from a spec instead of only by driving a whole turn.
 */
export class StandingQuestions {
  private readonly cards = new Map<string, StandingHostQuestion>();

  /**
   * What IDENTIFIES an ask. A retry after the client's deadline re-sends
   * exactly this, so the same words are the same question and get the same
   * card.
   */
  static keyFor(title: string | null, questions: HostQuestion[]): string {
    return JSON.stringify({ title, questions });
  }

  /** The card already up for this ask, or undefined when none is. */
  peek(key: string): StandingHostQuestion | undefined {
    return this.cards.get(key);
  }

  /**
   * An answer given while the agent had nothing in flight — handed over and
   * forgotten, which is the collection a retry came for.
   */
  collectHeld(key: string): HostQuestionOutcome | null {
    const card = this.cards.get(key);
    if (card === undefined || card.held === null) {
      return null;
    }
    this.cards.delete(key);
    return card.held;
  }

  /** OPEN a card nothing was asking for yet. */
  open(
    key: string,
    requestId: string,
    resolve: HostQuestionResolver,
  ): StandingHostQuestion {
    const card: StandingHostQuestion = {
      requestId,
      waiting: resolve,
      held: null,
      closed: false,
    };
    this.cards.set(key, card);
    return card;
  }

  /**
   * ADOPT the card already up rather than raise a second one. Two cards for one
   * question is the older defect this whole path was written for, and it is
   * what a naive retry produces.
   *
   * The resolver being displaced is SETTLED rather than dropped. Two calls can
   * be parked on one card at once — an earlier client's deadline lapses without
   * its cancellation reaching {@link detach} — and overwriting `waiting` left
   * that first `tools/call` handler never returning at all, so its hijacked
   * HTTP response was never written and the socket stayed open for the life of
   * the process, one leak per re-ask.
   */
  adopt(card: StandingHostQuestion, resolve: HostQuestionResolver): void {
    const displaced = card.waiting;
    card.waiting = resolve;
    if (displaced !== null && displaced !== resolve) {
      displaced({
        status: 'unavailable',
        reason: 'the agent stopped waiting for this answer',
      });
    }
  }

  /**
   * DETACH the call and leave the card standing: the buttons still work, the
   * badge still says the run is waiting on the user, and the answer is held for
   * the agent's retry.
   *
   * The identity check is what keeps an OLD call's abort from detaching a NEWER
   * one — by the time a client's deadline fires, its retry may already have
   * adopted this card.
   */
  detach(card: StandingHostQuestion, resolve: HostQuestionResolver): boolean {
    if (card.closed || card.waiting !== resolve) {
      return false;
    }
    card.waiting = null;
    resolve({
      status: 'unavailable',
      reason: 'the agent stopped waiting for this answer',
    });
    return true;
  }

  /**
   * An answer arriving FROM the card. Nothing is lost when no call is on the
   * line: the outcome is held for the retry, which is the whole point of the
   * card outliving the call.
   *
   * Deliberately `void`. Whether it reached an agent is not a decision any
   * caller can act on — the verdict is recorded either way, since a held answer
   * reaches the agent a moment later — so returning it would offer a branch
   * that must never be taken.
   */
  deliver(
    key: string,
    card: StandingHostQuestion,
    outcome: HostQuestionOutcome,
  ): void {
    if (card.closed) {
      return;
    }
    card.closed = true;
    const waiting = card.waiting;
    card.waiting = null;
    if (waiting !== null) {
      this.cards.delete(key);
      waiting(outcome);
      return;
    }
    card.held = outcome;
  }

  /**
   * CLOSE one card: the turn is over, so nothing can reach it any more and the
   * record goes with it. Private because {@link sweep} is the only way a card
   * is closed — a caller closing one by key would leave the turn's other cards
   * parked with no sweep to answer them.
   */
  private close(key: string, outcome: HostQuestionOutcome): void {
    const card = this.cards.get(key);
    if (card === undefined || card.closed) {
      return;
    }
    card.closed = true;
    this.cards.delete(key);
    const waiting = card.waiting;
    card.waiting = null;
    waiting?.(outcome);
  }

  /**
   * CLOSE every card still open, answering each parked call with the same
   * sentence. The turn's own sweep.
   */
  sweep(outcome: HostQuestionOutcome): void {
    for (const key of [...this.cards.keys()]) {
      this.close(key, outcome);
    }
  }
}

/** What a card's verdict tells the agent that asked. */
export function hostQuestionOutcomeOf(
  allow: boolean,
  answer: string | undefined,
): HostQuestionOutcome {
  return allow
    ? { status: 'answered', answer: answer ?? '' }
    : { status: 'declined' };
}

/**
 * One BLOCKING ask through a turn's standing cards: an answer held for a
 * retry is handed over, a card already up is adopted, otherwise `raise` puts
 * one up — returning its request id, or the outcome to answer with when it
 * could not — and `arm` routes its verdict, which reaches `standing.deliver`.
 * The caller giving up detaches its call and leaves the card standing.
 */
export async function askThroughStanding(
  standing: StandingQuestions,
  key: string,
  signal: AbortSignal | undefined,
  raise: () => Promise<string | HostQuestionOutcome>,
  arm: (requestId: string, card: StandingHostQuestion) => void,
): Promise<HostQuestionOutcome> {
  const detachOnAbort = (
    card: StandingHostQuestion,
    resolve: HostQuestionResolver,
  ): void => {
    if (signal === undefined) {
      return;
    }
    const detach = (): void => {
      standing.detach(card, resolve);
    };
    if (signal.aborted) {
      detach();
      return;
    }
    signal.addEventListener('abort', detach, { once: true });
  };
  const up = standing.peek(key);
  if (up !== undefined) {
    const held = standing.collectHeld(key);
    if (held !== null) {
      return held;
    }
    return await new Promise<HostQuestionOutcome>((resolve) => {
      standing.adopt(up, resolve);
      detachOnAbort(up, resolve);
    });
  }
  const raised = await raise();
  if (typeof raised !== 'string') {
    return raised;
  }
  return await new Promise<HostQuestionOutcome>((resolve) => {
    const card = standing.open(key, raised, resolve);
    arm(raised, card);
    detachOnAbort(card, resolve);
  });
}
