import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import type { RunDao } from '../../agents/dao/run.dao';
import type { AgentAdapterRegistry } from '../../agents/services/agent-adapter.registry';
import type { ProjectDao } from '../../projects/dao/project.dao';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { TeamChangeLogDao } from '../../teams/dao/team-change-log.dao';
import { TeamChangeLogEntry } from '../../teams/entity/team-change-log-entry.entity';
import { TeamChangeLogService } from '../../teams/services/team-change-log.service';
import type { TeamStoreService } from '../../teams/services/team-store.service';
import type { Team } from '../../teams/teams.types';
import {
  canonicalGraphJson,
  canonicalGraphOf,
  teamVersionOf,
} from '../../teams/utils/team-version';
import { TeamRecommendationDao } from '../dao/team-recommendation.dao';
import { TeamVersionDao } from '../dao/team-version.dao';
import { UsageActivityDao } from '../dao/usage-activity.dao';
import { UsageEventDao } from '../dao/usage-event.dao';
import { TeamRecommendation } from '../entity/team-recommendation.entity';
import { TeamVersion } from '../entity/team-version.entity';
import { UsageActivity } from '../entity/usage-activity.entity';
import { UsageEvent } from '../entity/usage-event.entity';
import type {
  FiledRecommendation,
  TeamStatsMemberWire,
  UsageEventInput,
} from '../stats.types';
import { TeamHistoryService } from './team-history.service';
import type { TeamStatsService } from './team-stats.service';
import { TeamVersionsService } from './team-versions.service';

const DAY_MS = 86_400_000;
const FIRST: Team = teamOf([member('dev')], { name: 'Dev Team' });
const SECOND: Team = {
  ...FIRST,
  members: [{ ...FIRST.members[0]!, model: 'sonnet' }],
};
const V1 = teamVersionOf(FIRST);
const V2 = teamVersionOf(SECOND);

/**
 * A team's history read from the ledgers alone: runs, chats and analyses
 * that are gone still count through what the ledgers kept.
 */
describe('TeamHistoryService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let activityDao: UsageActivityDao;
  let usageDao: UsageEventDao;
  let versionDao: TeamVersionDao;
  let recommendations: TeamRecommendationDao;
  let changeLog: TeamChangeLogService;
  let liveRuns: Set<string>;
  let teamRuns: Record<string, unknown>[];
  let costs: Map<string, number>;
  let members: TeamStatsMemberWire[];
  let adapterKinds: Map<string, unknown>;
  let projectRefs: { id: string; name: string; folder: string }[];
  let service: TeamHistoryService;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [
          UsageActivity,
          UsageEvent,
          TeamVersion,
          TeamChangeLogEntry,
          TeamRecommendation,
        ],
        ignoreUndefinedInQuery: true,
        allowGlobalContext: true,
        namingStrategy: UnderscoreNamingStrategy,
        discovery: { checkDuplicateFieldNames: false },
      }),
    );
    await orm.schema.create();
  });

  afterAll(async () => {
    await orm.close(true);
  });

  beforeEach(async () => {
    await orm.schema.clear();
    const em = orm.em.fork();
    teamRuns = [];
    costs = new Map();
    activityDao = new UsageActivityDao(em);
    usageDao = new UsageEventDao(em);
    versionDao = new TeamVersionDao(em);
    recommendations = new TeamRecommendationDao(em);
    changeLog = new TeamChangeLogService(new TeamChangeLogDao(em));
    liveRuns = new Set(['analysis-new']);
    adapterKinds = new Map();
    projectRefs = [{ id: 'p-app', name: 'Geniro App', folder: '/work/app' }];
    const adapters = {
      all: () => adapterKinds,
    } as unknown as AgentAdapterRegistry;
    const worktreeRepos = new Map([
      ['/work/app/.claude/worktrees/feat', '/work/app'],
    ]);
    const projectRoots = {
      rootsOf: (cwds: Iterable<string | null>) =>
        Promise.resolve(
          new Map(
            [...cwds].flatMap((cwd) =>
              cwd !== null && worktreeRepos.has(cwd)
                ? [[cwd, worktreeRepos.get(cwd)!] as const]
                : [],
            ),
          ),
        ),
    } as unknown as ProjectRootsService;
    const projects = {
      listRefs: () => Promise.resolve(projectRefs),
    } as unknown as ProjectDao;
    service = new TeamHistoryService(
      em,
      new TeamVersionsService(
        em,
        activityDao,
        usageDao,
        versionDao,
        adapters,
        {
          get: () =>
            Promise.resolve({ slug: 'dev-team', team: SECOND, hash: 'h' }),
        } as unknown as TeamStoreService,
        changeLog,
      ),
      activityDao,
      usageDao,
      recommendations,
      changeLog,
      {
        getById: (id: string) =>
          Promise.resolve(liveRuns.has(id) ? { id } : null),
        newestTeamRuns: (slug: string, limit: number | null) =>
          Promise.resolve(
            slug === 'dev-team' && limit === null ? teamRuns : [],
          ),
      } as unknown as RunDao,
      adapters,
      {
        read: () => Promise.resolve({ byMember: members }),
        totalsOf: (runIds: readonly string[]) =>
          Promise.resolve(
            new Map(
              runIds.flatMap((runId) => {
                const costUsd = costs.get(runId);
                return costUsd === undefined
                  ? []
                  : [[runId, { costUsd }] as const];
              }),
            ),
          ),
      } as unknown as TeamStatsService,
      projectRoots,
      projects,
    );
    members = [];
    for (const [team, version, at] of [
      [FIRST, V1, '2026-10-01T10:00:00.000Z'],
      [SECOND, V2, '2026-10-10T10:00:00.000Z'],
    ] as const) {
      await versionDao.register(
        'dev-team',
        version,
        canonicalGraphJson(canonicalGraphOf(team)),
        new Date(at),
      );
    }
  });

  async function teamRun(
    runId: string,
    version: string,
    at: string,
    turns: { costUsd: number | null; durationMs: number | null }[],
  ): Promise<void> {
    await activityDao.stampThreadVersion(runId, new Date(at), {
      slug: 'dev-team',
      version,
      inferred: false,
    });
    for (const [index, turn] of turns.entries()) {
      const event: UsageEventInput = {
        runId,
        memberId: 'dev',
        seq: index + 1,
        occurredAt: new Date(at),
        agentKind: 'claude',
        model: null,
        cwd: null,
        teamName: 'Dev Team',
        costUsd: turn.costUsd,
        estimatedCostUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreationTokens: null,
        thinkingTokens: null,
        durationMs: turn.durationMs,
        apiMs: null,
        ttftMs: null,
        timeToRequestMs: null,
        numTurns: null,
      };
      await usageDao.recordOnce(event);
    }
  }

  async function pullRequest(
    runId: string,
    acceptance: 'accepted' | 'changes_requested',
    reviewRounds: number,
    questionsAsked = 0,
  ): Promise<void> {
    await activityDao.upsertRunOutcome({
      runId,
      sourceSeq: 1,
      occurredAt: new Date('2026-10-11T10:00:00.000Z'),
      teamSlug: 'dev-team',
      prOwner: 'acme',
      prRepo: 'app',
      prNumber: runId.length,
      prUrl: `https://github.com/acme/app/pull/${runId.length}`,
      draft: false,
      reviewRounds,
      acceptance,
      questionsAsked,
      changesRequestedRounds: acceptance === 'changes_requested' ? 1 : 0,
      msToAccepted: acceptance === 'accepted' ? 60_000 : null,
    });
  }

  function filed(
    chatRunId: string,
    cardSeq: number,
    itemId: string,
    filedAt: string,
  ): FiledRecommendation {
    return {
      slug: 'dev-team',
      chatRunId,
      chatKind: 'analysis',
      cardSeq,
      filedAt: new Date(filedAt),
      libraryVersion: V1,
      itemId,
      target: itemId.startsWith('W-') ? 'team' : 'repo',
      territory: 'process',
      kind: 'model',
      location: 'dev',
      title: `Title of ${itemId}`,
      change: 'x'.repeat(itemId === 'W-2' ? 1000 : 10),
      rootCause: 'the reviewer runs the largest model',
      minutesSaved: 5,
      costSavedUsd: itemId === 'W-1' ? 1.25 : null,
      expectedOutcome: itemId === 'W-1' ? 'reviewer turns 4m → 2m' : null,
      confidence: 4,
      risk: 'low',
    };
  }

  it('lists every run of the team outside the sample newest first, however many, with what each cost', async () => {
    const at = new Date('2026-11-01T00:00:00.000Z');
    teamRuns = Array.from({ length: 300 }, (_, index) => ({
      id: `run-${index}`,
      title: `Run ${index}`,
      status: index === 1 ? 'running' : 'completed',
      createdAt: at,
      archivedAt: index === 1 ? null : at,
    }));
    costs = new Map([['run-1', 12.5]]);

    const listed = await service.otherRuns('dev-team', {
      analysedRunIds: ['run-0'],
    });

    expect(listed).toHaveLength(299);
    expect(listed[0]).toEqual({
      runId: 'run-1',
      title: 'Run 1',
      createdAt: at.toISOString(),
      statusNow: 'running',
      archived: false,
      costUsd: 12.5,
    });
    expect(listed[298]).toEqual(
      expect.objectContaining({
        runId: 'run-299',
        archived: true,
        costUsd: null,
      }),
    );
    expect(
      await service.otherRuns('other-team', { analysedRunIds: [] }),
    ).toEqual([]);
  });

  it('folds every version over every run the ledgers kept, deleted runs included, newest version first', async () => {
    await teamRun('run-a', V1, '2026-10-02T10:00:00.000Z', [
      { costUsd: 2, durationMs: 60_000 },
      { costUsd: 2, durationMs: 60_000 },
    ]);
    await teamRun('run-b-deleted', V1, '2026-10-03T10:00:00.000Z', [
      { costUsd: 4, durationMs: 120_000 },
    ]);
    await teamRun('run-c', V2, '2026-10-11T10:00:00.000Z', [
      { costUsd: 1, durationMs: 30_000 },
    ]);
    await pullRequest('run-a', 'changes_requested', 3);
    await pullRequest('run-c', 'accepted', 1, 2);

    const history = await service.read('dev-team', {
      analysedRunIds: ['run-c', 'run-a'],
      readerRunId: 'analysis-new',
    });

    expect(history.currentVersion).toEqual({
      version: V2,
      number: 2,
      current: true,
    });
    const [second, first] = history.versions;
    expect(second).toMatchObject({
      version: { version: V2, number: 2, current: true },
      analysedRunIds: ['run-c'],
      figures: {
        runs: 1,
        costUsd: 1,
        avgCostUsd: 1,
        turns: 1,
        cliWorkedMs: 30_000,
        avgCliWorkedMs: 30_000,
        pullRequests: {
          total: 1,
          accepted: 1,
          avgReviewRounds: 1,
          avgChangesRequestedRounds: 0,
          avgMsToAccepted: 60_000,
          avgQuestionsPerRun: 2,
        },
      },
    });
    expect(second!.changes!.diff).toContain('+    model: sonnet');
    expect(first).toMatchObject({
      version: { version: V1, number: 1, current: false },
      analysedRunIds: ['run-a'],
      figures: {
        runs: 2,
        pricedRuns: 2,
        costUsd: 8,
        avgCostUsd: 4,
        turns: 3,
        avgTurns: 1.5,
        cliWorkedMs: 240_000,
        avgCliWorkedMs: 120_000,
        pullRequests: {
          total: 1,
          changesRequested: 1,
          avgReviewRounds: 3,
          avgChangesRequestedRounds: 1,
          avgMsToAccepted: null,
          avgQuestionsPerRun: 0,
        },
      },
      changes: null,
    });
    expect(history.summary.analysedRunsByVersion).toEqual([
      { version: { version: V2, number: 2, current: true }, runIds: ['run-c'] },
      {
        version: { version: V1, number: 1, current: false },
        runIds: ['run-a'],
      },
    ]);
  });

  it('counts a run’s questions once whatever its pull requests, and leaves out copies made before questions were counted', async () => {
    await teamRun('run-x', V1, '2026-10-02T10:00:00.000Z', [
      { costUsd: 1, durationMs: 60_000 },
    ]);
    await teamRun('run-old', V1, '2026-10-01T10:00:00.000Z', [
      { costUsd: 1, durationMs: 60_000 },
    ]);
    const copy = (
      runId: string,
      prNumber: number,
      figures: {
        questionsAsked: number;
        changesRequestedRounds: number | null;
        msToAccepted: number | null;
      },
    ): Promise<void> =>
      activityDao.upsertRunOutcome({
        runId,
        sourceSeq: prNumber,
        occurredAt: new Date('2026-10-11T10:00:00.000Z'),
        teamSlug: 'dev-team',
        prOwner: 'acme',
        prRepo: 'app',
        prNumber,
        prUrl: `https://github.com/acme/app/pull/${prNumber}`,
        draft: false,
        reviewRounds: 1,
        acceptance: 'accepted',
        ...figures,
      });
    await copy('run-x', 1, {
      questionsAsked: 2,
      changesRequestedRounds: 1,
      msToAccepted: 60_000,
    });
    await copy('run-x', 2, {
      questionsAsked: 5,
      changesRequestedRounds: 0,
      msToAccepted: 180_000,
    });
    await copy('run-old', 3, {
      questionsAsked: 0,
      changesRequestedRounds: null,
      msToAccepted: null,
    });

    const history = await service.read('dev-team', {
      analysedRunIds: ['run-x'],
      readerRunId: 'analysis-new',
    });

    expect(
      history.versions.find((entry) => entry.version?.version === V1)?.figures
        .pullRequests,
    ).toMatchObject({
      total: 3,
      accepted: 3,
      avgChangesRequestedRounds: 0.5,
      avgMsToAccepted: 120_000,
      avgQuestionsPerRun: 5,
    });
  });

  it('names who changed the team and why, and what became of every earlier recommendation, an analysis that is gone included', async () => {
    await recommendations.file([
      filed('analysis-old', 5, 'W-1', '2026-10-05T10:00:00.000Z'),
      filed('analysis-old', 5, 'W-2', '2026-10-05T10:00:00.000Z'),
      filed('analysis-old', 5, 'R-1', '2026-10-05T10:00:00.000Z'),
      filed('analysis-new', 3, 'W-1', '2026-10-12T10:00:00.000Z'),
    ]);
    const selectedAt = new Date('2026-10-05T11:00:00.000Z');
    await recommendations.markSelected(
      'analysis-old',
      5,
      ['W-1', 'R-1'],
      selectedAt,
    );
    await recommendations.markOutcome(
      'analysis-old',
      5,
      { itemId: 'W-1', outcome: 'applied', note: null },
      { seq: 9, at: new Date('2026-10-05T12:00:00.000Z') },
    );
    await recommendations.markOutcome(
      'analysis-old',
      5,
      { itemId: 'R-1', outcome: 'skipped', note: 'the check exists already' },
      { seq: 9, at: new Date('2026-10-05T12:00:00.000Z') },
    );
    await changeLog.record({
      slug: 'dev-team',
      source: 'analysis',
      before: FIRST,
      after: SECOND,
      summary: 'W-1 Title of W-1',
      recommendationIds: ['W-1'],
      chatRunId: 'analysis-old',
      cardSeq: 5,
      backup: '.backups/dev-team.yaml',
    });
    await changeLog.record({
      slug: 'dev-team',
      source: 'builder',
      before: SECOND,
      after: SECOND,
      reason: 'renamed it',
      chatRunId: 'analysis-new',
    });

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: 'analysis-new',
    });

    expect(history.changeLog.map((change) => change.source)).toEqual([
      'builder',
      'analysis',
    ]);
    expect(history.changeLog[1]).toMatchObject({
      from: { version: V1, number: 1, current: false },
      to: { version: V2, number: 2, current: true },
      summary: 'W-1 Title of W-1',
      recommendationIds: ['W-1'],
      chatRunId: 'analysis-old',
      byThisChat: false,
      backup: '.backups/dev-team.yaml',
    });
    expect(history.changeLog[0]).toMatchObject({ byThisChat: true });
    expect(history.versions[0]!.madeBy).toEqual([
      expect.objectContaining({ source: 'builder' }),
      expect.objectContaining({
        source: 'analysis',
        recommendationIds: ['W-1'],
      }),
    ]);

    const [newest, oldest] = history.recommendations;
    expect(newest).toMatchObject({
      chatRunId: 'analysis-new',
      byThisChat: true,
      chatStillExists: true,
      items: [{ id: 'W-1', status: 'open' }],
    });
    expect(oldest).toMatchObject({
      chatRunId: 'analysis-old',
      byThisChat: false,
      chatStillExists: false,
      cardSeq: 5,
      libraryVersion: { version: V1, number: 1 },
    });
    expect(
      oldest!.items.map(({ id, status, note }) => ({ id, status, note })),
    ).toEqual([
      { id: 'W-1', status: 'applied', note: null },
      { id: 'W-2', status: 'not-selected', note: null },
      { id: 'R-1', status: 'skipped', note: 'the check exists already' },
    ]);
    expect(oldest!.items[0]).toMatchObject({
      expectedMinutesSavedPerRun: 5,
      expectedCostSavedPerRunUsd: 1.25,
      expectedOutcome: 'reviewer turns 4m → 2m',
    });
    expect(oldest!.items[1]).toMatchObject({
      expectedCostSavedPerRunUsd: null,
      expectedOutcome: null,
    });
    expect(oldest!.items[0]!.changedIn).toEqual([
      {
        at: history.changeLog[1]!.at,
        to: { version: V2, number: 2, current: true },
      },
    ]);
    expect(oldest!.items[0]!.selectedAt).toBe(selectedAt.toISOString());
    expect(oldest!.items[1]!.change).toMatch(/^x{600}… \[\+400 chars\]$/);
    expect(history.summary.recommendations).toEqual({
      applied: 1,
      skipped: 1,
      failed: 0,
      selected: 0,
      open: 1,
      'not-selected': 1,
      unanswered: 0,
    });
  });

  it('lists a project overlay’s logged changes beside the team’s, never as a version of the team', async () => {
    await changeLog.recordOverlay({
      slug: 'dev-team',
      projectId: 'p1',
      source: 'analysis',
      fromHash: null,
      toHash: 'overlay-hash',
      summary: 'O-1 Effort for Manifest',
      recommendationIds: ['O-1'],
      chatRunId: 'analysis-new',
      cardSeq: 3,
      backup: null,
    });

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(history.changeLog).toEqual([
      expect.objectContaining({
        projectId: 'p1',
        source: 'analysis',
        recommendationIds: ['O-1'],
      }),
    ]);
    expect(history.versions.flatMap((version) => version.madeBy)).toEqual([]);
  });

  it('counts a card replaced before anything on it was applied as unanswered, never as passed over', async () => {
    await recommendations.file([
      filed('analysis-replaced', 4, 'W-1', '2026-10-05T10:00:00.000Z'),
      filed('analysis-replaced', 4, 'W-2', '2026-10-05T10:00:00.000Z'),
    ]);

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(
      history.recommendations[0]!.items.map(({ id, status }) => [id, status]),
    ).toEqual([
      ['W-1', 'unanswered'],
      ['W-2', 'unanswered'],
    ]);
    expect(history.summary.recommendations).toMatchObject({
      unanswered: 2,
      'not-selected': 0,
    });
  });

  it('counts an item left out of an Apply as not selected, while its chat still exists too', async () => {
    await recommendations.file([
      filed('analysis-new', 3, 'W-1', '2026-10-12T10:00:00.000Z'),
      filed('analysis-new', 3, 'W-2', '2026-10-12T10:00:00.000Z'),
    ]);
    await recommendations.markSelected(
      'analysis-new',
      3,
      ['W-1'],
      new Date('2026-10-12T11:00:00.000Z'),
    );

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(
      history.recommendations[0]!.items.map(({ id, status }) => [id, status]),
    ).toEqual([
      ['W-1', 'selected'],
      ['W-2', 'not-selected'],
    ]);
  });

  it('counts an item the user selected but nobody marked as selected', async () => {
    await recommendations.file([
      filed('analysis-old', 5, 'W-1', '2026-10-05T10:00:00.000Z'),
    ]);
    await recommendations.markSelected(
      'analysis-old',
      5,
      ['W-1'],
      new Date('2026-10-05T11:00:00.000Z'),
    );

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(history.recommendations[0]!.items[0]!.status).toBe('selected');
  });

  it("numbers each recorded version and names the library's current one", async () => {
    const index = await service.versionIndex('dev-team');

    expect(index.current).toBe(V2);
    expect([...index.numbers]).toEqual([
      [V2, 2],
      [V1, 1],
    ]);
  });

  it("carries every member's figures, work and earlier assessments, as the team's statistics count them", async () => {
    members = [
      {
        memberId: 'dev',
        agentKind: 'claude',
        costUsd: 3,
        turns: 4,
        workedMs: 1_000,
        measuredWorkedMs: 0,
        runs: 2,
        work: null,
        assessments: [
          {
            chatRunId: 'analysis-old',
            chatKind: 'analysis',
            cardSeq: 5,
            filedAt: '2026-10-20T10:00:00.000Z',
            runs: 2,
            versions: [{ number: 1, current: false }],
            usefulness: 2,
            quality: 3,
            verdict: 'remove',
            summary: 'Repeats what the lead already did',
            evidence: [{ runId: 'r1', seq: 3, quote: 'same diff again' }],
            items: [{ id: 'W-1', title: 'Drop dev', status: 'skipped' }],
            judge: { agent: 'codex', model: null, sameVendor: false },
            userVerdict: {
              verdict: 'disagree',
              note: 'it is the only one who runs the tests',
              at: '2026-10-21T10:00:00.000Z',
            },
          },
        ],
        perRun: { costUsd: null, workedMs: null },
        changes: [],
      },
    ];

    const history = await service.read('dev-team', {
      analysedRunIds: [],
      readerRunId: null,
    });

    expect(history.members).toEqual(members);
  });

  it('reads a team’s spend from its ledgers alone: an ended run counts, another team’s run does not, a worktree is filed under its repository, and each turn is priced at its adapter’s billing rates', async () => {
    const billingRatesOf = vi.fn((_model: string | null) => ({
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite: 8,
    }));
    adapterKinds = new Map([['claude', { billingRatesOf }]]);
    const longAgo = new Date(Date.now() - 400 * DAY_MS);
    const turn = (
      runId: string,
      cwd: string | null,
      costUsd: number,
    ): UsageEventInput => ({
      runId,
      memberId: 'dev',
      seq: 1,
      occurredAt: longAgo,
      agentKind: 'claude',
      model: 'opus-5',
      cwd,
      teamName: 'Dev Team',
      costUsd,
      estimatedCostUsd: null,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });
    await activityDao.stampThreadVersion('run-gone', longAgo, {
      slug: 'dev-team',
      version: V1,
      inferred: false,
    });
    await usageDao.recordOnce(
      turn('run-gone', '/work/app/.claude/worktrees/feat', 3),
    );
    await activityDao.stampThreadVersion('run-other-team', longAgo, {
      slug: 'other-team',
      version: V1,
      inferred: false,
    });
    await usageDao.recordOnce(turn('run-other-team', null, 50));

    const spend = await service.spend('dev-team', {
      analysedRunIds: ['run-gone'],
    });

    expect(spend.population.runs).toBe(1);
    expect(spend.windows[0]).toMatchObject({
      window: 'all',
      runs: 1,
      costUsd: 3,
    });
    expect(spend.windows[1]).toMatchObject({
      window: 'last30Days',
      runs: 0,
      costUsd: null,
    });
    expect(spend.byProject).toEqual([
      expect.objectContaining({
        project: 'Geniro App',
        folder: null,
        all: expect.objectContaining({ costUsd: 3 }),
      }),
    ]);
    expect(billingRatesOf).toHaveBeenCalledWith('opus-5');
    expect(spend.windows[0]).toMatchObject({
      inputUsd: 2,
      outputUsd: 1,
      notSplitUsd: 0,
    });
  });

  it('names a folder in no project by its last segment alone, and leaves a turn of no registered CLI unsplit', async () => {
    const at = new Date('2026-10-01T10:00:00.000Z');
    await activityDao.stampThreadVersion('run-loose', at, {
      slug: 'dev-team',
      version: V1,
      inferred: false,
    });
    await usageDao.recordOnce({
      runId: 'run-loose',
      memberId: 'dev',
      seq: 1,
      occurredAt: at,
      agentKind: 'codex',
      model: 'gpt-6',
      cwd: '/home/someone/secret-client/repo',
      teamName: 'Dev Team',
      costUsd: 4,
      estimatedCostUsd: null,
      inputTokens: 1_000,
      outputTokens: 100,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      thinkingTokens: null,
      durationMs: null,
      apiMs: null,
      ttftMs: null,
      timeToRequestMs: null,
      numTurns: null,
    });

    const spend = await service.spend('dev-team', { analysedRunIds: [] });

    expect(spend.byProject).toEqual([
      expect.objectContaining({ project: null, folder: 'repo' }),
    ]);
    expect(JSON.stringify(spend)).not.toContain('secret-client');
    expect(spend.windows[0]).toMatchObject({ costUsd: 4, notSplitUsd: 4 });
  });
});
