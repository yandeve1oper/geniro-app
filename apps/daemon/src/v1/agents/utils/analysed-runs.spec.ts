import { describe, expect, it } from 'vitest';

import {
  analysisTurnOf,
  readAnalysedRuns,
  writeAnalysedRuns,
} from './analysed-runs';

describe('analysed runs column', () => {
  it('round-trips the runs in their order', () => {
    const runs = [
      { runId: 'b', snapshotSeq: 40, working: true },
      { runId: 'a', snapshotSeq: 0, working: false },
    ];

    expect(readAnalysedRuns(writeAnalysedRuns(runs))).toEqual(runs);
  });

  it('drops an entry that does not read and keeps the rest', () => {
    const stored = JSON.stringify([
      { runId: 'a', snapshotSeq: 3 },
      { runId: 7, snapshotSeq: 1 },
      { runId: 'b', snapshotSeq: -1 },
      'junk',
    ]);

    expect(readAnalysedRuns(stored)).toEqual([
      { runId: 'a', snapshotSeq: 3, working: false },
    ]);
  });

  it('reads a missing or unreadable column as no runs', () => {
    expect(readAnalysedRuns(null)).toEqual([]);
    expect(readAnalysedRuns('{not json')).toEqual([]);
    expect(readAnalysedRuns('{"runId":"a"}')).toEqual([]);
  });
});

describe('analysisTurnOf', () => {
  const none = {
    analysisSourceRunId: null,
    analysisSourceSeq: null,
    analysisSourceWorking: null,
    analysisTeamSlug: null,
    analysisRuns: null,
    analysisPurpose: null,
  };

  it('answers null for a chat that is not an analysis', () => {
    expect(analysisTurnOf('a', none)).toBeNull();
  });

  it('reads a thread analysis as its one source', () => {
    expect(
      analysisTurnOf('a', {
        ...none,
        analysisSourceRunId: 'src',
        analysisSourceSeq: 9,
        analysisSourceWorking: true,
      }),
    ).toEqual({
      analysisRunId: 'a',
      sourceRunId: 'src',
      snapshotSeq: 9,
      sourceWorking: true,
    });
  });

  it('marks a lessons reflection on its turn, and only a lessons reflection', () => {
    const thread = {
      ...none,
      analysisSourceRunId: 'src',
      analysisSourceSeq: 9,
      analysisSourceWorking: false,
    };

    expect(
      analysisTurnOf('a', { ...thread, analysisPurpose: 'lessons' })?.purpose,
    ).toBe('lessons');
    expect(
      analysisTurnOf('a', { ...thread, analysisPurpose: 'review' }),
    ).not.toHaveProperty('purpose');
  });

  it('reads a team analysis as its runs, the newest standing as the source', () => {
    const runs = [
      { runId: 'new', snapshotSeq: 12, working: true },
      { runId: 'old', snapshotSeq: 30, working: false },
    ];

    expect(
      analysisTurnOf('a', {
        ...none,
        analysisTeamSlug: 'team',
        analysisRuns: writeAnalysedRuns(runs),
      }),
    ).toEqual({
      analysisRunId: 'a',
      sourceRunId: 'new',
      snapshotSeq: 12,
      sourceWorking: true,
      team: { slug: 'team', runs },
    });
  });

  it('answers null for a team analysis whose runs do not read', () => {
    expect(
      analysisTurnOf('a', {
        ...none,
        analysisTeamSlug: 'team',
        analysisRuns: 'junk',
      }),
    ).toBeNull();
  });
});
