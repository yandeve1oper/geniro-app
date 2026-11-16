import type { EntityManager } from '@mikro-orm/sqlite';
import { describe, expect, it } from 'vitest';

import type { MemoryService } from '../../memory/services/memory.service';
import type { ProjectScopeService } from '../../projects/services/project-scope.service';
import type { Item } from '../../runs/entity/item.entity';
import type { Run } from '../../runs/entity/run.entity';
import {
  type AnalysedRun,
  type AnalysisTurn,
  type FoldedRun,
  type ItemWire,
  MAX_RECOMMENDATIONS_PER_TARGET,
  type MemberAssessment,
  type RecommendationItem,
  type RecommendationsPayload,
  type RecommendationsReport,
  type RecommendationsTeamPopulation,
  type RunFold,
} from '../chat.types';
import type { ItemDao } from '../dao/item.dao';
import type { RunDao } from '../dao/run.dao';
import {
  AnalysisReportsService,
  checkItems,
  checkMembers,
} from './analysis-reports.service';
import type { ThreadReaderService } from './thread-reader.service';
import type { ThreadTimelineService } from './thread-timeline.service';

const KEPT_FOR_PATCH =
  'The card is kept for this turn: send only `patch` with what fixes these, never the whole card again';

const CARD: RecommendationsPayload = {
  sourceRunId: 'source',
  sourceKind: 'team',
  timing: null,
  items: [
    {
      id: 'W-1',
      target: 'team',
      territory: 'process',
      kind: 'parallelize',
      location: 'reviewer',
      title: 'Parallel reviewers',
      change: 'edges: …',
      evidence: [{ seq: 4, quote: 'waiting' }],
      rootCause: 'serial',
      impact: { minutesSaved: 12, basis: 'critical path', confidence: 4 },
      risk: { level: 'low', note: 'none' },
    },
  ],
};

const ITEM: RecommendationItem = {
  ...CARD.items[0]!,
  impact: {
    minutesSaved: 12,
    costSavedUsd: 0.4,
    basis: 'critical path',
    confidence: 4,
    outcome: 'reviewer 30m → 18m per run',
  },
};

function sink(
  cardAt: number | null,
  card: unknown = CARD,
  applied: readonly string[] = [],
  purpose: AnalysisTurn['purpose'] = undefined,
) {
  const written: { kind: string; payload: object }[] = [];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      rowAtSeq: (_runId: string, seq: number) =>
        Promise.resolve(
          seq === cardAt
            ? ({
                kind: 'recommendations',
                payload: JSON.stringify(card),
              } as Item)
            : null,
        ),
      userMessagesInOrder: () =>
        Promise.resolve(
          applied.length === 0
            ? []
            : [
                {
                  payload: JSON.stringify({
                    apply: { cardSeq: cardAt, ids: applied },
                  }),
                },
              ],
        ),
      recommendationOutcomeRows: () =>
        Promise.resolve(
          written.map(({ payload }, seq) => ({
            seq,
            payload: JSON.stringify(payload),
          })),
        ),
    } as unknown as ItemDao,
    {} as ThreadTimelineService,
    { enabled: true } as MemoryService,
    {} as ThreadReaderService,
    {} as ProjectScopeService,
  );
  const analysis = service.sinkFor(
    {
      analysisRunId: 'analysis',
      sourceRunId: 'source',
      snapshotSeq: 9,
      sourceWorking: false,
      purpose,
    },
    (kind, payload) => {
      written.push({ kind, payload });
      return Promise.resolve({ seq: 20 } as ItemWire);
    },
  );
  return { written, report: analysis.report, mark: analysis.mark };
}

describe('AnalysisReportsService — outcomes', () => {
  it('writes one outcome row against the card it names', async () => {
    const { mark, written } = sink(7);
    const marks = {
      cardSeq: 7,
      outcomes: [
        { id: 'W-1', status: 'applied' as const, backup: '.backups/x.yaml' },
      ],
    };

    expect(await mark(marks)).toEqual({
      status: 'recorded',
      seq: 20,
      count: 1,
      allMarked: false,
    });
    expect(written).toEqual([
      { kind: 'recommendation_outcome', payload: marks },
    ]);
  });

  it('says when the last item the Apply selected is marked, whatever its status', async () => {
    const { mark } = sink(
      7,
      { ...CARD, items: [...CARD.items, { ...CARD.items[0], id: 'R-4' }] },
      ['W-1', 'R-4'],
    );

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ allMarked: false });
    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'R-4', status: 'skipped' }] }),
    ).toMatchObject({ allMarked: true });
  });

  it('still marks a card whose stored figures no longer read', async () => {
    const { mark, written } = sink(7, {
      ...CARD,
      teamStats: { runs: -1, agents: 'none' },
    });

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'recorded' });
    expect(written).toHaveLength(1);
  });

  it('refuses an id the card does not hold, and a seq that is not a card', async () => {
    const { mark, written } = sink(7);

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'R-4', status: 'failed' }] }),
    ).toEqual({ status: 'refused', reason: 'the card has no R-4' });
    expect(
      await mark({ cardSeq: 8, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'refused' });
    expect(written).toEqual([]);
  });
});

describe('AnalysisReportsService — a lessons reflection', () => {
  it('refuses a card a reflection sends, recording nothing', async () => {
    const { report, written } = sink(7, CARD, [], 'lessons');

    expect(await report({ whole: CARD }, null, null)).toEqual({
      status: 'refused',
      reason: expect.stringContaining('LESSONS_REFLECTION'),
    });
    expect(written).toEqual([]);
  });

  it('refuses an outcome a reflection marks, recording nothing', async () => {
    const { mark, written } = sink(7, CARD, [], 'lessons');

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toEqual({
      status: 'refused',
      reason: expect.stringContaining('LESSONS_REFLECTION'),
    });
    expect(written).toEqual([]);
  });

  it('still records an outcome a review analysis marks', async () => {
    const { mark, written } = sink(7, CARD, [], 'review');

    expect(
      await mark({ cardSeq: 7, outcomes: [{ id: 'W-1', status: 'applied' }] }),
    ).toMatchObject({ status: 'recorded' });
    expect(written).toHaveLength(1);
  });
});

describe('checkItems', () => {
  const memoryItem: RecommendationItem = {
    ...ITEM,
    id: 'M-1',
    target: 'memory' as const,
    kind: 'forget',
    location: 'm12',
  };

  it('caps memory items per target like any other', () => {
    const six = ['M-1', 'M-2', 'M-3', 'M-4', 'M-5', 'M-6'].map((id) => ({
      ...memoryItem,
      id,
    }));

    expect(
      checkItems(
        {
          hotspots: [],
          items: six.map((item) => ({
            ...item,
            impact: { ...item.impact, costSavedUsd: null, outcome: 'gone' },
          })),
        },
        'chat',
        true,
        new Set(),
      ),
    ).toContainEqual(expect.stringContaining('6 memory items'));
  });

  const projectItem: RecommendationItem = {
    ...ITEM,
    id: 'P-1',
    target: 'project' as const,
    kind: 'update',
    location: 'p-billing',
    impact: {
      ...ITEM.impact,
      costSavedUsd: null,
      outcome: 'fewer retries',
    },
  };

  it('takes a P- item naming an analysed run’s project, in a chat analysis too', () => {
    expect(
      checkItems(
        { hotspots: [], items: [projectItem] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toEqual([]);
  });

  it('refuses a P- item naming another project, and any when no analysed run has one', () => {
    expect(
      checkItems(
        { hotspots: [], items: [{ ...projectItem, location: 'p-other' }] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toContainEqual(expect.stringContaining('location must be the projectId'));
    expect(
      checkItems(
        { hotspots: [], items: [projectItem] },
        'team',
        true,
        new Set(),
      ),
    ).toContainEqual(expect.stringContaining('belong to no project'));
  });

  const overlayItem: RecommendationItem = {
    ...projectItem,
    id: 'O-1',
    target: 'overlay' as const,
  };

  it('takes an O- item naming an analysed team run’s project', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(['p-billing']),
      ),
    ).toEqual([]);
  });

  it('refuses an O- item for a plain chat, for another project, and when no analysed run has one', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'chat',
        true,
        new Set(['p-billing']),
      ),
    ).toContainEqual(expect.stringContaining('no team overlay to change'));
    expect(
      checkItems(
        { hotspots: [], items: [{ ...overlayItem, location: 'p-other' }] },
        'team',
        true,
        new Set(['p-billing']),
      ),
    ).toContainEqual(
      expect.stringContaining(
        'location must be the projectId whose overlay it changes',
      ),
    );
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(),
      ),
    ).toContainEqual(
      expect.stringContaining('overlay recommendations cannot apply'),
    );
  });

  it('refuses an O- item for a project that defaults to another team', () => {
    expect(
      checkItems(
        { hotspots: [], items: [overlayItem] },
        'team',
        true,
        new Set(['p-billing']),
        new Set(),
      ),
    ).toContainEqual(expect.stringContaining('defaults to another team'));
  });

  it('reports every problem of a card at once, each item and each target', () => {
    const problems = checkItems(
      {
        hotspots: [],
        items: [
          ITEM,
          { ...ITEM, id: 'W-2' },
          { ...projectItem, location: 'p-other' },
          ...[1, 2, 3, 4, 5, 6].map((n) => ({
            ...memoryItem,
            id: `M-${n}`,
          })),
        ],
      },
      'chat',
      false,
      new Set(['p-billing']),
    );

    expect(problems).toHaveLength(10);
    expect(problems).toContainEqual(
      expect.stringContaining('W-1: the analysed thread is a plain chat'),
    );
    expect(problems).toContainEqual(
      expect.stringContaining('W-2: the analysed thread is a plain chat'),
    );
    expect(problems).toContainEqual(
      expect.stringContaining('location must be the projectId'),
    );
    expect(problems).toContainEqual(
      expect.stringContaining('M-6: the shared memory is off'),
    );
    expect(problems).toContainEqual(expect.stringContaining('6 memory items'));
  });
});

describe('checkItems — external items', () => {
  const EXTERNAL: RecommendationItem = {
    ...ITEM,
    id: 'X-1',
    target: 'external' as const,
    kind: 'check',
    location: '/Users/me/other-repo',
  };
  const folderThere = () => true;

  it('takes an X- item naming an absolute folder that is there, in a team and in a plain chat', () => {
    expect(
      checkItems(
        { hotspots: [], items: [EXTERNAL] },
        'team',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toEqual([]);
    expect(
      checkItems(
        { hotspots: [], items: [EXTERNAL] },
        'chat',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toEqual([]);
  });

  it('refuses a relative location, and an absolute one the folder check denies', () => {
    expect(
      checkItems(
        {
          hotspots: [],
          items: [{ ...EXTERNAL, location: 'other-repo' }],
        },
        'chat',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toContainEqual(
      expect.stringContaining('location must be the absolute root folder'),
    );
    expect(
      checkItems(
        { hotspots: [], items: [EXTERNAL] },
        'chat',
        true,
        new Set(),
        new Set(),
        false,
        () => false,
      ),
    ).toContainEqual(
      expect.stringContaining('location must be the absolute root folder'),
    );
  });

  it('refuses an X- id on another target, and an external item under another target’s id', () => {
    expect(
      checkItems(
        { hotspots: [], items: [{ ...EXTERNAL, target: 'team' }] },
        'team',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toContainEqual(
      expect.stringContaining('X-1 is a team item — its id starts with W-'),
    );
    expect(
      checkItems(
        { hotspots: [], items: [{ ...EXTERNAL, id: 'R-1' }] },
        'chat',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toContainEqual(expect.stringContaining('its id starts with X-'));
  });

  it('caps external items at the per-target limit', () => {
    const items = Array.from(
      { length: MAX_RECOMMENDATIONS_PER_TARGET + 1 },
      (_, index) => ({
        ...EXTERNAL,
        id: `X-${index + 1}`,
      }),
    );

    expect(
      checkItems(
        { hotspots: [], items },
        'chat',
        true,
        new Set(),
        new Set(),
        false,
        folderThere,
      ),
    ).toContainEqual(
      expect.stringContaining(
        `${MAX_RECOMMENDATIONS_PER_TARGET + 1} external items — keep the strongest ${MAX_RECOMMENDATIONS_PER_TARGET} at most`,
      ),
    );
  });
});

describe('AnalysisReportsService — project items', () => {
  it('refuses a P- item for a project outside the analysed runs', async () => {
    const written: unknown[] = [];
    const service = new AnalysisReportsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: (id: string) =>
          Promise.resolve({ id, teamId: null, projectId: 'p-billing' } as Run),
      } as unknown as RunDao,
      {
        existingSeqs: (_runId: string, seqs: number[]) =>
          Promise.resolve(new Set(seqs)),
      } as unknown as ItemDao,
      {
        read: () =>
          Promise.resolve({
            fold: { lanes: [] },
            timeline: folded('source').timeline,
          }),
      } as unknown as ThreadTimelineService,
      { enabled: true } as MemoryService,
      {} as ThreadReaderService,
      {
        projectOfRun: (run: Pick<Run, 'projectId'>) =>
          Promise.resolve(run.projectId ? { id: run.projectId } : null),
      } as unknown as ProjectScopeService,
    );
    const { report } = service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 20 } as ItemWire);
      },
    );

    expect(
      await report(
        {
          whole: {
            hotspots: [],
            items: [
              {
                ...ITEM,
                id: 'P-1',
                target: 'project',
                kind: 'update',
                location: 'p-shop',
                impact: {
                  ...ITEM.impact,
                  costSavedUsd: null,
                  outcome: 'fewer retries',
                },
              },
            ],
          },
        },
        null,
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('(p-billing)'),
    });
    expect(written).toEqual([]);
  });
});

function folded(runId: string): FoldedRun {
  return {
    runId,
    turns: [
      {
        memberId: 'reviewer',
        startedAt: new Date(1_000).toISOString(),
        model: 'opus',
        member: null,
        outcome: 'completed',
        durationMs: 1_000,
        toolCalls: 1,
        inputTokens: null,
        outputTokens: null,
        costUsd: 2,
        contextTokens: null,
        timingSource: 'cli',
      },
    ],
    lanes: [
      {
        memberId: 'reviewer',
        agentKind: 'claude',
        turns: 1,
        workedMs: 1_800_000,
        toolCalls: 1,
        costUsd: 2,
      },
    ],
    calls: [],
    wallWorkedMs: new Map(),
    callWorkedMs: new Map(),
    costUsd: 2,
    version: 'v-b',
    nodeModels: new Map(),
    pooledNodes: new Set(),
    timeline: {
      wallMs: 2_400_000,
      activeMs: 2_000_000,
      waitingOnUserMs: 0,
      criticalPathMs: 1_800_000,
      criticalPath: [],
      nodes: [],
      tools: [],
    },
  };
}

const REVIEWER: MemberAssessment = {
  member: 'reviewer',
  usefulness: 4,
  quality: 2,
  verdict: 'tune',
  summary: 'Its reviews are used, but it re-reads the whole diff every round',
  evidence: [{ runId: 'r1', seq: 7, quote: 'reading the diff again' }],
  items: ['W-1'],
};

const REVIEWER_IN_R2: MemberAssessment = {
  ...REVIEWER,
  evidence: [{ runId: 'r2', seq: 3, quote: 'reading the diff again' }],
};

const POPULATION: RecommendationsTeamPopulation = {
  runs: 9,
  perRun: {
    costUsd: 1.25,
    pricedRuns: 9,
    workedMs: 600_000,
    timedRuns: 9,
    turns: 3,
  },
};

function teamReporter(
  existing?: (runId: string, seqs: number[], upTo: number) => number[],
  opened?: Map<string, AnalysedRun>,
) {
  const written: { kind: string; payload: object }[] = [];
  const asked: { runId: string; seqs: number[] }[] = [];
  const runs = [
    { runId: 'r2', snapshotSeq: 30, working: false },
    { runId: 'r1', snapshotSeq: 20, working: false },
    { runId: 'gone', snapshotSeq: 10, working: false },
  ];
  const service = new AnalysisReportsService(
    { fork: () => ({}) } as unknown as EntityManager,
    {} as RunDao,
    {
      existingSeqs: (runId: string, seqs: number[], upTo: number) => {
        asked.push({ runId, seqs });
        return Promise.resolve(new Set(existing?.(runId, seqs, upTo) ?? seqs));
      },
    } as unknown as ItemDao,
    {} as ThreadTimelineService,
    { enabled: true } as MemoryService,
    {
      foldRuns: (analysed: typeof runs) =>
        Promise.resolve(
          analysed.map((entry): RunFold => ({
            analysed: entry,
            run:
              entry.runId === 'gone'
                ? null
                : ({
                    title: `Run ${entry.runId}`,
                    createdAt: new Date(entry.snapshotSeq * 1_000),
                  } as Run),
            folded: entry.runId === 'gone' ? null : folded(entry.runId),
          })),
        ),
    } as unknown as ThreadReaderService,
    {} as ProjectScopeService,
  );
  const open = () =>
    service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'r2',
        snapshotSeq: 30,
        sourceWorking: false,
        team: { slug: 'dev-team', runs, ...(opened ? { opened } : {}) },
      },
      (kind, payload) => {
        written.push({ kind, payload });
        return Promise.resolve({ seq: 40 } as ItemWire);
      },
    ).report;
  return { written, report: open(), open, asked };
}

const index = () =>
  Promise.resolve({ current: 'v-b', numbers: new Map([['v-b', 3]]) });

describe('AnalysisReportsService — a team card', () => {
  it("files the runs' figures the daemon measured beside the agent's hotspots, every run it read but a deleted one", async () => {
    const { report, written } = teamReporter();
    const filed: RecommendationsReport = {
      hotspots: [
        {
          title: 'The reviewer holds every run',
          node: 'reviewer',
          why: 'It re-reads the whole diff each round',
          items: ['W-1'],
        },
      ],
      items: [ITEM],
      members: [REVIEWER],
    };

    expect(await report({ whole: filed }, index, null)).toEqual({
      status: 'recorded',
      seq: 40,
      count: 1,
      members: 1,
    });
    const payload = written[0]?.payload as RecommendationsPayload;
    expect(payload).toMatchObject({
      hotspots: filed.hotspots,
      members: [REVIEWER],
      timing: null,
      teamStats: {
        runs: 2,
        perRun: { wallMs: 2_400_000, costUsd: 2, pricedRuns: 2 },
        totals: { costUsd: 4, turns: 2 },
        agents: [
          {
            node: 'reviewer',
            runs: 2,
            workedMs: 3_600_000,
            workedPerRunMs: 1_800_000,
            costPerRunUsd: 2,
          },
        ],
      },
    });
    expect(
      payload.teamStats?.runList.map((run) => [
        run.runId,
        run.title,
        run.version,
        run.current,
      ]),
    ).toEqual([
      ['r2', 'Run r2', 3, true],
      ['r1', 'Run r1', 3, true],
    ]);
  });

  it('files the runs by hash alone when the version index cannot be read', async () => {
    const { report, written } = teamReporter();

    await report(
      { whole: { hotspots: [], items: [ITEM], members: [REVIEWER] } },
      () => Promise.reject(new Error('ledger locked')),
      null,
    );

    expect(
      (written[0]?.payload as RecommendationsPayload).teamStats?.runList.map(
        (run) => run.version,
      ),
    ).toEqual([null, null]);
  });

  it('takes the whole population from the reader, and files none when the reader fails', async () => {
    const { report, written } = teamReporter();
    const card = { hotspots: [], items: [ITEM], members: [REVIEWER] };

    await report({ whole: card }, index, () => Promise.resolve(POPULATION));
    await report({ whole: card }, index, () =>
      Promise.reject(new Error('ledger locked')),
    );

    expect(
      (written[0]?.payload as RecommendationsPayload).teamStats?.population,
    ).toEqual(POPULATION);
    expect(
      (written[1]?.payload as RecommendationsPayload).teamStats?.population,
    ).toBeNull();
  });

  it('refuses a hotspot naming an item the card lacks, or a member that took no turn', async () => {
    const { report, written } = teamReporter();

    expect(
      await report(
        {
          whole: {
            hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
            items: [ITEM],
            members: [REVIEWER],
          },
        },
        index,
        null,
      ),
    ).toEqual({
      status: 'refused',
      reason: `hotspot "Loops" names W-9, which is not on the card. ${KEPT_FOR_PATCH}`,
    });
    expect(
      await report(
        {
          whole: {
            hotspots: [{ title: 'Idle QA', node: 'qa', why: 'x', items: [] }],
            items: [ITEM],
            members: [REVIEWER],
          },
        },
        index,
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('member qa, which took no turn'),
    });
    expect(written).toEqual([]);
  });

  describe('a run read outside the sample', () => {
    const outside = (seq: number) => ({
      ...ITEM,
      evidence: [{ runId: 'r-out', seq, quote: 'waiting' }],
    });
    const atOrBelow = (_runId: string, seqs: number[], upTo: number) =>
      seqs.filter((seq) => seq <= upTo);
    const pinned = () =>
      new Map([['r-out', { runId: 'r-out', snapshotSeq: 5, working: false }]]);

    it('takes a citation at or below the snapshot its read pinned', async () => {
      const { report, written } = teamReporter(atOrBelow, pinned());

      const filed = await report(
        { whole: { hotspots: [], items: [outside(5)], members: [REVIEWER] } },
        index,
        null,
      );

      expect(filed.status).toBe('recorded');
      expect(written).toHaveLength(1);
    });

    it('refuses a seq past that snapshot, though the run may have moved on', async () => {
      const { report, written } = teamReporter(atOrBelow, pinned());

      const filed = await report(
        { whole: { hotspots: [], items: [outside(6)], members: [REVIEWER] } },
        index,
        null,
      );

      expect(filed.status).toBe('refused');
      expect(filed.status === 'refused' ? filed.reason : '').toContain(
        'evidence seq 6 does not exist in the analysed run r-out (snapshot ends at 5)',
      );
      expect(written).toEqual([]);
    });

    it('refuses a run this turn never read, asking no row of it, since a citation pins nothing', async () => {
      const { report, written, asked } = teamReporter(atOrBelow);

      const filed = await report(
        { whole: { hotspots: [], items: [outside(1)], members: [REVIEWER] } },
        index,
        null,
      );

      expect(filed.status).toBe('refused');
      expect(filed.status === 'refused' ? filed.reason : '').toContain(
        'evidence runId r-out has not been read in this turn',
      );
      expect(asked.map((entry) => entry.runId)).not.toContain('r-out');
      expect(written).toEqual([]);
    });
  });

  it('names every problem of a card at once, one refusal for all of them', async () => {
    const { report, written } = teamReporter((runId, seqs) =>
      runId === 'r1' ? seqs.filter((seq) => seq !== 7) : seqs,
    );
    const card = {
      hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
      items: [
        ITEM,
        {
          ...ITEM,
          evidence: [
            { runId: 'r1', seq: 7, quote: 'waiting' },
            { runId: 'nope', seq: 2, quote: 'waiting' },
          ],
        },
      ],
      members: [{ ...REVIEWER, items: ['W-1', 'W-9'] }],
    };

    const filed = await report({ whole: card }, index, null);

    expect(filed.status).toBe('refused');
    const reason = filed.status === 'refused' ? filed.reason : '';
    expect(reason).toContain('5 problems: ');
    expect(reason).toContain('duplicate id W-1');
    expect(reason).toContain('evidence runId nope has not been read');
    expect(reason).toContain(
      'evidence seq 7 does not exist in the analysed run r1',
    );
    expect(reason).toContain(
      'hotspot "Loops" names W-9, which is not on the card',
    );
    expect(reason).toContain(
      'member reviewer names W-9, which is not on the card',
    );
    expect(reason.endsWith(KEPT_FOR_PATCH)).toBe(true);
    expect(written).toEqual([]);
  });

  it('names every issue of a card that fails the schema', async () => {
    const { report, written } = teamReporter();

    const filed = await report(
      {
        whole: {
          hotspots: [],
          items: [{ ...ITEM, target: 'bogus', territory: 'bogus' }],
          members: [REVIEWER],
        },
      },
      index,
      null,
    );

    expect(filed.status).toBe('refused');
    const reason = filed.status === 'refused' ? filed.reason : '';
    expect(reason).toContain('items.0.target');
    expect(reason).toContain('items.0.territory');
    expect(written).toEqual([]);
  });
});

describe('AnalysisReportsService — member assessments', () => {
  it('refuses a team card that assesses no member', async () => {
    const { report, written } = teamReporter();

    expect(
      await report({ whole: { hotspots: [], items: [ITEM] } }, index, null),
    ).toEqual({
      status: 'refused',
      reason: `assess the members: one entry in members for each member of the team that took a turn in the analysed runs. ${KEPT_FOR_PATCH}`,
    });
    expect(written).toEqual([]);
  });

  it("checks a member's evidence against the run it names", async () => {
    const { report, written, asked } = teamReporter((runId, seqs) =>
      runId === 'r1' ? seqs.filter((seq) => seq !== 7) : seqs,
    );

    expect(
      await report(
        { whole: { hotspots: [], items: [ITEM], members: [REVIEWER] } },
        index,
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('evidence seq 7 does not exist'),
    });
    expect(asked).toContainEqual({ runId: 'r1', seqs: [7] });
    expect(written).toEqual([]);
  });

  it('refuses a member that took no turn in the analysed runs', async () => {
    const { report, written } = teamReporter();

    expect(
      await report(
        {
          whole: {
            hotspots: [],
            items: [ITEM],
            members: [REVIEWER, { ...REVIEWER, member: 'qa' }],
          },
        },
        index,
        null,
      ),
    ).toEqual({
      status: 'refused',
      reason: `member qa took no turn in the analysed runs — assess only members the reads name (reviewer). ${KEPT_FOR_PATCH}`,
    });
    expect(written).toEqual([]);
  });

  it("assesses a thread analysis of a team run by the run's own lanes, and files no team stats for a thread", async () => {
    const written: RecommendationsPayload[] = [];
    const service = new AnalysisReportsService(
      { fork: () => ({}) } as unknown as EntityManager,
      {
        getById: () => Promise.resolve({ id: 'source', teamId: 'dev-team' }),
      } as unknown as RunDao,
      {
        existingSeqs: (_runId: string, seqs: number[]) =>
          Promise.resolve(new Set(seqs)),
      } as unknown as ItemDao,
      {
        read: () =>
          Promise.resolve({
            fold: { lanes: [{ memberId: 'reviewer' }, { memberId: 'coder' }] },
            timeline: { ...folded('source').timeline, sinks: [] },
          }),
      } as unknown as ThreadTimelineService,
      { enabled: true } as MemoryService,
      {} as ThreadReaderService,
      {} as ProjectScopeService,
    );
    const { report } = service.sinkFor(
      {
        analysisRunId: 'analysis',
        sourceRunId: 'source',
        snapshotSeq: 9,
        sourceWorking: false,
      },
      (_kind, payload) => {
        written.push(payload as RecommendationsPayload);
        return Promise.resolve({ seq: 12 } as ItemWire);
      },
    );
    const coder: MemberAssessment = {
      ...REVIEWER,
      member: 'coder',
      verdict: 'keep',
      items: [],
      evidence: [{ seq: 3, quote: 'tests pass' }],
    };

    expect(
      await report(
        {
          whole: {
            hotspots: [],
            items: [ITEM],
            members: [
              { ...REVIEWER, evidence: [{ seq: 4, quote: 'x' }] },
              coder,
            ],
          },
        },
        null,
        null,
      ),
    ).toEqual({ status: 'recorded', seq: 12, count: 1, members: 2 });
    expect(
      await report(
        {
          whole: {
            hotspots: [],
            items: [ITEM],
            members: [{ ...coder, member: 'qa' }],
          },
        },
        null,
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('(reviewer, coder)'),
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.members).toHaveLength(2);
    expect(written[0]?.teamStats).toBeNull();
  });
});

describe('AnalysisReportsService — a patched card', () => {
  const WHOLE_WITH_MISSING_HOTSPOT_ITEM = {
    hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
    items: [ITEM],
    members: [REVIEWER_IN_R2],
  };

  it('records a refused card once a patch fixes what it named, and the row holds the patched card', async () => {
    const { report, written } = teamReporter();

    await report({ whole: WHOLE_WITH_MISSING_HOTSPOT_ITEM }, index, null);
    expect(
      await report(
        { patch: { hotspots: [{ title: 'Loops', items: ['W-1'] }] } },
        index,
        null,
      ),
    ).toEqual({ status: 'recorded', seq: 40, count: 1, members: 1 });

    const payload = written[0]?.payload as RecommendationsPayload;
    expect(payload.hotspots).toEqual([
      { title: 'Loops', why: 'x', items: ['W-1'] },
    ]);
  });

  it('builds the next patch on the patched card, not the refused original', async () => {
    const { report } = teamReporter();

    await report({ whole: WHOLE_WITH_MISSING_HOTSPOT_ITEM }, index, null);
    expect(
      await report(
        { patch: { hotspots: [{ title: 'Loops', items: ['W-8'] }] } },
        index,
        null,
      ),
    ).toEqual({
      status: 'refused',
      reason: `hotspot "Loops" names W-8, which is not on the card. ${KEPT_FOR_PATCH}`,
    });

    const second = await report({ patch: { summary: 'second' } }, index, null);

    expect(second).toEqual({
      status: 'refused',
      reason: `hotspot "Loops" names W-8, which is not on the card. ${KEPT_FOR_PATCH}`,
    });
  });

  it('replaces the kept card with a new whole card', async () => {
    const { report } = teamReporter();

    await report({ whole: WHOLE_WITH_MISSING_HOTSPOT_ITEM }, index, null);
    await report(
      {
        whole: {
          hotspots: [{ title: 'Other', why: 'x', items: ['W-7'] }],
          items: [ITEM],
          members: [REVIEWER_IN_R2],
        },
      },
      index,
      null,
    );

    const patched = await report({ patch: { summary: 'x' } }, index, null);

    expect(patched).toEqual({
      status: 'refused',
      reason: `hotspot "Other" names W-7, which is not on the card. ${KEPT_FOR_PATCH}`,
    });
  });

  it('refuses a patch once a card is recorded, and one from a later sink, since a kept card lasts only for its turn', async () => {
    const { report, open, written } = teamReporter();

    expect(
      await report(
        { whole: { hotspots: [], items: [ITEM], members: [REVIEWER_IN_R2] } },
        index,
        null,
      ),
    ).toMatchObject({ status: 'recorded' });
    expect(
      await report({ patch: { summary: 'x' } }, index, null),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('NO_KEPT_CARD'),
    });

    await report({ whole: WHOLE_WITH_MISSING_HOTSPOT_ITEM }, index, null);
    const nextTurn = open();

    expect(
      await nextTurn({ patch: { summary: 'x' } }, index, null),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('NO_KEPT_CARD'),
    });
    expect(written).toHaveLength(1);
  });

  it('keeps a whole card that fails the schema, and a patch fixes it into shape', async () => {
    const { report } = teamReporter();

    expect(
      await report(
        {
          whole: {
            hotspots: [],
            items: [{ ...ITEM, territory: 'bogus' }],
            members: [REVIEWER_IN_R2],
          },
        },
        index,
        null,
      ),
    ).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('items.0.territory'),
    });
    expect(
      await report(
        { patch: { items: [{ id: 'W-1', territory: 'process' }] } },
        index,
        null,
      ),
    ).toEqual({ status: 'recorded', seq: 40, count: 1, members: 1 });
  });

  it('runs every check on a patch, so one that introduces a bad evidence seq is refused', async () => {
    const { report, written } = teamReporter((runId, seqs) =>
      runId === 'r1' ? seqs.filter((seq) => seq !== 7) : seqs,
    );

    await report({ whole: WHOLE_WITH_MISSING_HOTSPOT_ITEM }, index, null);
    const filed = await report(
      {
        patch: {
          hotspots: [{ title: 'Loops', items: ['W-1'] }],
          items: [
            { id: 'W-1', evidence: [{ runId: 'r1', seq: 7, quote: 'x' }] },
          ],
        },
      },
      index,
      null,
    );

    expect(filed).toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('evidence seq 7 does not exist'),
    });
    expect(written).toEqual([]);
  });

  it('never repeats an item’s change text or an evidence quote in a refusal', async () => {
    const { report } = teamReporter((runId, seqs) =>
      runId === 'r1' ? seqs.filter((seq) => seq !== 7) : seqs,
    );

    const filed = await report(
      {
        whole: {
          hotspots: [{ title: 'Loops', why: 'x', items: ['W-9'] }],
          items: [
            {
              ...ITEM,
              change: 'SECRET-CHANGE-TEXT',
              evidence: [{ runId: 'r1', seq: 7, quote: 'SECRET-QUOTE' }],
            },
          ],
          members: [REVIEWER_IN_R2],
        },
      },
      index,
      null,
    );

    expect(filed.status).toBe('refused');
    const reason = filed.status === 'refused' ? filed.reason : '';
    expect(reason).toContain('evidence seq 7 does not exist');
    expect(reason).not.toContain('SECRET-CHANGE-TEXT');
    expect(reason).not.toContain('SECRET-QUOTE');
  });
});

describe('checkMembers', () => {
  const took = new Set(['reviewer', 'coder']);
  const repoItem: RecommendationItem = {
    ...ITEM,
    id: 'R-1',
    target: 'repo',
    kind: 'check',
    location: 'package.json:1',
  };

  it('takes a chat with no members, and refuses one that assesses any', () => {
    expect(checkMembers({ hotspots: [], items: [] }, 'chat', took)).toEqual([]);
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER] },
        'chat',
        took,
      ),
    ).toContainEqual(expect.stringContaining('plain chat'));
  });

  it('refuses a member assessed twice', () => {
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER, REVIEWER] },
        'team',
        took,
      ),
    ).toEqual(['member reviewer is assessed twice — one entry per member']);
  });

  it('refuses a verdict carried out by an item the card lacks, or by an item that is no team, overlay or project item', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, items: ['W-2'] }],
        },
        'team',
        took,
      ),
    ).toEqual(['member reviewer names W-2, which is not on the card']);
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM, repoItem],
          members: [{ ...REVIEWER, items: ['R-1'] }],
        },
        'team',
        took,
      ),
    ).toContainEqual(
      expect.stringContaining(
        "member reviewer names R-1 — only team, overlay and project items (W-…, O-…, P-…) carry out a member's verdict",
      ),
    );
  });

  it('accepts a verdict carried out by an overlay item or a project item, and refuses the other prefixes', () => {
    const overlayItem: RecommendationItem = {
      ...ITEM,
      id: 'O-1',
      target: 'overlay',
    };
    const projectItem: RecommendationItem = {
      ...ITEM,
      id: 'P-1',
      target: 'project',
    };

    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM, overlayItem, projectItem],
          members: [{ ...REVIEWER, items: ['O-1', 'P-1'] }],
        },
        'team',
        took,
      ),
    ).toEqual([]);
    for (const id of ['R-1', 'U-1', 'M-1', 'K-1', 'X-1']) {
      const target = id.startsWith('R')
        ? 'repo'
        : id.startsWith('U')
          ? 'user'
          : id.startsWith('M')
            ? 'memory'
            : id.startsWith('K')
              ? 'knowledge'
              : 'external';
      expect(
        checkMembers(
          {
            hotspots: [],
            items: [ITEM, { ...ITEM, id, target }],
            members: [{ ...REVIEWER, items: [id] }],
          },
          'team',
          took,
        ),
      ).toContainEqual(
        expect.stringContaining(
          `names ${id} — only team, overlay and project items`,
        ),
      );
    }
  });

  it('returns every member’s problem, not only the first', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [
            { ...REVIEWER, member: 'qa' },
            { ...REVIEWER, member: 'coder', items: [] },
          ],
        },
        'team',
        took,
      ),
    ).toEqual([
      expect.stringContaining('member qa took no turn in the analysed runs'),
      expect.stringContaining("member coder's verdict tune names no item"),
    ]);
  });

  it('takes a member the runs gave too little to judge, but refuses a change resting on no mark', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [
            {
              ...REVIEWER,
              usefulness: null,
              quality: null,
              verdict: 'keep',
              items: [],
            },
          ],
        },
        'team',
        took,
      ),
    ).toEqual([]);
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, usefulness: null, quality: null }],
        },
        'team',
        took,
      ),
    ).toEqual([
      "member reviewer's verdict tune rests on no mark — judge its usefulness or quality, or keep it while the runs give too little to judge",
    ]);
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, usefulness: null }],
        },
        'team',
        took,
      ),
    ).toEqual([]);
  });

  it('refuses a change with no item to carry it out, and a keep that names one', () => {
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, verdict: 'remove', items: [] }],
        },
        'team',
        took,
      ),
    ).toContainEqual(expect.stringContaining('verdict remove names no item'));
    expect(
      checkMembers(
        {
          hotspots: [],
          items: [ITEM],
          members: [{ ...REVIEWER, verdict: 'keep' }],
        },
        'team',
        took,
      ),
    ).toContainEqual(expect.stringContaining('is kept, so it names no items'));
    expect(
      checkMembers(
        { hotspots: [], items: [ITEM], members: [REVIEWER] },
        'team',
        took,
      ),
    ).toEqual([]);
  });
});
