import { describe, expect, it } from 'vitest';

import { polledSpendRows, type PolledSpendRun } from './polled-spend';

const run = (over: Partial<PolledSpendRun> = {}): PolledSpendRun => ({
  id: 'run-1',
  polledCostCents: 1000,
  updatedAt: new Date('2026-10-01T10:00:00Z'),
  agentKind: null,
  model: null,
  cwd: '/repo',
  teamId: 'dev-team',
  teamSnapshot: null,
  analysisPurpose: null,
  polledSpendBuckets: JSON.stringify({
    '2026-10-01|gpt-5': 600,
    '2026-10-02|gpt-5': 400,
  }),
  ...over,
});

const pollsCursor = (kind: string): boolean => kind === 'cursor-agent';

describe('polledSpendRows', () => {
  it('files a chat run’s bill under no member', () => {
    const rows = polledSpendRows(
      run({ agentKind: 'cursor-agent', teamId: null }),
      'cursor-agent',
    );

    expect(rows.map((row) => [row.memberId, row.costUsd])).toEqual([
      [null, 6],
      [null, 4],
    ]);
  });

  it('splits a team run’s bill across the members the poll credited', () => {
    const rows = polledSpendRows(
      run(),
      'cursor-agent',
      null,
      [
        { memberId: 'qa', agentKind: 'cursor-agent', polledCostCents: 750 },
        {
          memberId: 'handyman',
          agentKind: 'cursor-agent',
          polledCostCents: 250,
        },
        { memberId: 'manager', agentKind: 'claude', polledCostCents: 0 },
      ],
      pollsCursor,
    );

    expect(
      rows.map((row) => [row.memberId, row.agentKind, row.costUsd, row.seq]),
    ).toEqual([
      ['handyman', 'cursor-agent', 1.5, -1],
      ['qa', 'cursor-agent', 4.5, -2],
      ['handyman', 'cursor-agent', 1, -3],
      ['qa', 'cursor-agent', 3, -4],
    ]);
    expect(rows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)).toBe(10);
  });

  it('keeps a team run’s bill unattributed when no member was credited', () => {
    const rows = polledSpendRows(run(), 'cursor-agent', null, [], pollsCursor);

    expect(rows.map((row) => row.memberId)).toEqual([null, null]);
  });
});
