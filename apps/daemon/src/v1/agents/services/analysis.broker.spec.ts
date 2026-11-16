import { describe, expect, it } from 'vitest';

import type { AnalysisTurn } from '../chat.types';
import { AnalysisBroker } from './analysis.broker';

const RUN = 'run-1';
const MEMBER = 'agent';

function register(
  broker: AnalysisBroker,
  purpose: AnalysisTurn['purpose'],
  run = RUN,
  member = MEMBER,
): () => void {
  return broker.register(run, member, {
    turn: {
      analysisRunId: run,
      sourceRunId: 'source',
      snapshotSeq: 0,
      sourceWorking: false,
      purpose,
    },
    report: () => Promise.reject(new Error('unused')),
    mark: () => Promise.reject(new Error('unused')),
  });
}

function gatesOf(broker: AnalysisBroker, run = RUN, member = MEMBER) {
  return {
    analyse: broker.canAnalyse(run, member),
    reflection: broker.isReflection(run, member),
    review: broker.canReview(run, member),
  };
}

describe('AnalysisBroker gates per turn purpose', () => {
  it.each([
    [
      'a review',
      'review' as const,
      { analyse: true, reflection: false, review: true },
    ],
    [
      'an untagged analysis',
      undefined,
      { analyse: true, reflection: false, review: true },
    ],
    [
      'a lessons reflection',
      'lessons' as const,
      { analyse: true, reflection: true, review: false },
    ],
  ])('%s is offered its own tools only', (_, purpose, expected) => {
    const broker = new AnalysisBroker();
    register(broker, purpose);

    expect(gatesOf(broker)).toEqual(expected);
  });

  it('answers no gate for a member with no sink, or for a sink of another member', () => {
    const broker = new AnalysisBroker();
    register(broker, 'lessons', RUN, 'other');

    expect(gatesOf(broker)).toEqual({
      analyse: false,
      reflection: false,
      review: false,
    });
  });

  it('drops a gate with its sink when the turn ends', () => {
    const broker = new AnalysisBroker();
    const dispose = register(broker, 'lessons');

    dispose();

    expect(gatesOf(broker)).toEqual({
      analyse: false,
      reflection: false,
      review: false,
    });
  });
});
