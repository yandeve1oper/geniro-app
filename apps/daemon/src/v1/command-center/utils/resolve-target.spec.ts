import { describe, expect, it } from 'vitest';

import { type NameableThread, resolveTarget } from './resolve-target';

const billing: NameableThread = {
  handle: 't1',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000001',
  title: 'Billing export',
};
const cacheA: NameableThread = {
  handle: 't2',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000002',
  title: 'Cache fix',
};
const cacheB: NameableThread = {
  handle: 't3',
  runId: '6f1d2c1e-1111-4a3b-8c1d-000000000003',
  title: 'cache  FIX',
};
const roster = [billing, cacheA, cacheB];

describe('resolveTarget', () => {
  it('resolves a handle in any case, a run id, and a unique exact title', () => {
    expect(resolveTarget('T1', roster)).toEqual({
      kind: 'resolved',
      thread: billing,
    });
    expect(resolveTarget(cacheA.runId, roster)).toEqual({
      kind: 'resolved',
      thread: cacheA,
    });
    expect(resolveTarget(' billing   EXPORT ', roster)).toEqual({
      kind: 'resolved',
      thread: billing,
    });
  });

  it('calls a title two roster threads share ambiguous, naming both', () => {
    expect(resolveTarget('Cache fix', roster)).toEqual({
      kind: 'ambiguous',
      candidates: [cacheA, cacheB],
    });
  });

  it('calls a word two roster titles contain ambiguous, naming both', () => {
    expect(resolveTarget('cache', roster)).toEqual({
      kind: 'ambiguous',
      candidates: [cacheA, cacheB],
    });
  });

  it('answers a name no title matches exactly with the one title containing it, never resolving it', () => {
    expect(resolveTarget('billing', roster)).toEqual({
      kind: 'unknown',
      candidates: [billing],
    });
    expect(resolveTarget('mobile app', roster)).toEqual({
      kind: 'unknown',
      candidates: [],
    });
  });
});
