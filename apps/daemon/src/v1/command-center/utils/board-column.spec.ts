import { describe, expect, it } from 'vitest';

import type { RunWire } from '../../agents/chat.types';
import { boardColumnOf } from './board-column';

type BoardRun = Pick<
  RunWire,
  'status' | 'awaiting' | 'outcome' | 'pullRequests'
>;

const OPENED_PR = {
  owner: 'geniro-io',
  repo: 'geniro-app',
  number: 7,
  url: 'https://github.com/geniro-io/geniro-app/pull/7',
  seq: 3,
  opened: true,
} as unknown as RunWire['pullRequests'][number];

function run(over: Partial<BoardRun> = {}): BoardRun {
  return {
    status: 'completed',
    awaiting: null,
    outcome: null,
    pullRequests: [],
    ...over,
  } as BoardRun;
}

const OUTCOME = {
  kind: 'success',
  summary: null,
  source: 'recorded',
} as unknown as RunWire['outcome'];

describe('boardColumnOf', () => {
  it('places a thread waiting on the user first, ahead of working, done and review', () => {
    expect(
      boardColumnOf(run({ status: 'running', awaiting: 'approval' }), 'done'),
    ).toBe('waiting');
    expect(
      boardColumnOf(
        run({ status: 'completed', awaiting: 'question', outcome: OUTCOME }),
        'in_review',
      ),
    ).toBe('waiting');
  });

  it('places a running thread in working, even when its card is Done or it has an outcome', () => {
    expect(boardColumnOf(run({ status: 'running' }), 'done')).toBe('working');
    expect(
      boardColumnOf(run({ status: 'running', outcome: OUTCOME }), null),
    ).toBe('working');
  });

  it('places a thread whose card is Done, or that recorded an outcome, in done', () => {
    expect(boardColumnOf(run(), 'done')).toBe('done');
    expect(boardColumnOf(run({ outcome: OUTCOME }), null)).toBe('done');
  });

  it('prefers done over in review when both hold', () => {
    expect(
      boardColumnOf(
        run({ outcome: OUTCOME, pullRequests: [OPENED_PR] }),
        'in_review',
      ),
    ).toBe('done');
  });

  it('places a thread whose card is In review, or that opened a pull request, in review', () => {
    expect(boardColumnOf(run(), 'in_review')).toBe('in_review');
    expect(boardColumnOf(run({ pullRequests: [OPENED_PR] }), null)).toBe(
      'in_review',
    );
    expect(boardColumnOf(run({ pullRequests: [OPENED_PR] }), 'todo')).toBe(
      'in_review',
    );
  });

  it('leaves a pull request that was never opened out of review', () => {
    const notOpened = {
      ...OPENED_PR,
      opened: false,
    } as RunWire['pullRequests'][number];

    expect(boardColumnOf(run({ pullRequests: [notOpened] }), null)).toBe(
      'idle',
    );
  });

  it('places a thread with nothing behind it in idle', () => {
    expect(boardColumnOf(run(), null)).toBe('idle');
    expect(boardColumnOf(run({ status: 'failed' }), 'backlog')).toBe('idle');
  });
});
