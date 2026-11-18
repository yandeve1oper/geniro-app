import { describe, expect, it } from 'vitest';

import {
  attentionOf,
  IDLE_AFTER_DAYS,
  idleDaysOf,
  orderByAttention,
  statusTextOf,
} from './card-view';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const DAY = 24 * 60 * 60_000;

describe('idleDaysOf', () => {
  it('says nothing for a thread that moved within the last few days', () => {
    expect(
      idleDaysOf(
        new Date(NOW - (IDLE_AFTER_DAYS - 0.5) * DAY).toISOString(),
        NOW,
      ),
    ).toBeNull();
  });

  it('counts the whole days once a thread has sat still long enough', () => {
    expect(
      idleDaysOf(new Date(NOW - IDLE_AFTER_DAYS * DAY).toISOString(), NOW),
    ).toBe(IDLE_AFTER_DAYS);
    expect(idleDaysOf(new Date(NOW - 14.7 * DAY).toISOString(), NOW)).toBe(14);
  });
});

const HOUR = 60 * 60_000;

function cardOf(
  over: {
    status?: string;
    awaiting?: 'question' | 'approval' | null;
    column?: 'working' | 'waiting' | 'idle' | 'in_review' | 'done';
    awaitingReply?: boolean;
    lastAt?: number;
  } = {},
): Parameters<typeof attentionOf>[0] {
  return {
    run: {
      status: over.status ?? 'completed',
      awaiting: over.awaiting ?? null,
      lastActivityAt: new Date(over.lastAt ?? NOW - HOUR).toISOString(),
      createdAt: new Date(NOW - 30 * DAY).toISOString(),
    },
    column: over.column ?? 'idle',
    contact: { lastAt: null, awaitingReply: over.awaitingReply ?? false },
  } as Parameters<typeof attentionOf>[0];
}

describe('attentionOf', () => {
  it('puts a failed thread or one held at an approval among the blocked', () => {
    expect(attentionOf(cardOf({ status: 'failed' }), NOW)).toBe('blocked');
    expect(
      attentionOf(
        cardOf({ awaiting: 'approval', column: 'waiting', status: 'running' }),
        NOW,
      ),
    ).toBe('blocked');
  });

  it('puts a running thread among the working', () => {
    expect(
      attentionOf(cardOf({ column: 'working', status: 'running' }), NOW),
    ).toBe('working');
  });

  it('puts a thread asking the user, or one the manager awaits, among the questions', () => {
    expect(
      attentionOf(
        cardOf({ awaiting: 'question', column: 'waiting', status: 'running' }),
        NOW,
      ),
    ).toBe('question');
    expect(attentionOf(cardOf({ awaitingReply: true }), NOW)).toBe('question');
  });

  it('calls a still thread quiet within a day and inactive after', () => {
    expect(attentionOf(cardOf({ lastAt: NOW - 23 * HOUR }), NOW)).toBe('quiet');
    expect(attentionOf(cardOf({ lastAt: NOW - 25 * HOUR }), NOW)).toBe(
      'inactive',
    );
  });
});

describe('orderByAttention', () => {
  it('orders by attention band, newest activity first within a band', () => {
    const entry = (id: string, attention: string, hoursAgo: number) => ({
      id,
      view: {
        attention: attention as ReturnType<typeof attentionOf>,
        lastAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
      },
    });

    expect(
      orderByAttention([
        entry('old-quiet', 'quiet', 5),
        entry('inactive', 'inactive', 50),
        entry('new-quiet', 'quiet', 1),
        entry('working', 'working', 3),
        entry('blocked', 'blocked', 9),
        entry('question', 'question', 2),
      ]).map((item) => item.id),
    ).toEqual([
      'blocked',
      'working',
      'question',
      'new-quiet',
      'old-quiet',
      'inactive',
    ]);
  });
});

describe('statusTextOf', () => {
  it('says why a blocked or questioned thread stands in its band', () => {
    const card = (over: Parameters<typeof cardOf>[0]) => cardOf(over);

    expect(statusTextOf(card({ status: 'failed' }), 'failed', 'blocked')).toBe(
      'Failed',
    );
    expect(
      statusTextOf(card({ awaiting: 'approval' }), 'waiting', 'blocked'),
    ).toBe('Needs approval');
    expect(
      statusTextOf(card({ awaiting: 'question' }), 'waiting', 'question'),
    ).toBe('Question for you');
    expect(
      statusTextOf(card({ awaitingReply: true }), 'idle', 'question'),
    ).toBe('Awaiting reply');
    expect(statusTextOf(card({}), 'idle', 'quiet')).toBe('Idle');
  });
});
