import {
  defineConfig,
  MikroORM,
  UnderscoreNamingStrategy,
} from '@mikro-orm/sqlite';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { GENIRO_ORM_RUNTIME } from '../../../db/sqlite.driver';
import { clearSecrets, registerSecret } from '../../diagnostics/utils/redact';
import { ProjectDao } from '../../projects/dao/project.dao';
import { ProjectInstructionChangeDao } from '../../projects/dao/project-instruction-change.dao';
import { Project } from '../../projects/entity/project.entity';
import { ProjectInstructionChange } from '../../projects/entity/project-instruction-change.entity';
import type { ProjectRootsService } from '../../projects/services/project-roots.service';
import { ProjectScopeService } from '../../projects/services/project-scope.service';
import { Goal } from '../../runs/entity/goal.entity';
import { Item } from '../../runs/entity/item.entity';
import { NodeState } from '../../runs/entity/node-state.entity';
import { Run } from '../../runs/entity/run.entity';
import { WallTurn } from '../../runs/entity/wall-turn.entity';
import type { ItemKind } from '../../runs/runs.types';
import { TaskDao } from '../../tasks/dao/task.dao';
import { Task } from '../../tasks/entity/task.entity';
import { member, teamOf } from '../../teams/__tests__/team-builders';
import { TeamSchema } from '../../teams/teams.types';
import { teamVersionOf } from '../../teams/utils/team-version';
import { kindRowsPassthrough } from '../__tests__/kind-rows-passthrough';
import { claudeToolCallMetric } from '../adapters/claude/utils/claude-mcp-tool-name.utils';
import type {
  AnalysedTeam,
  AnalysisSource,
  RecommendationsTeamPopulation,
} from '../chat.types';
import { GoalDao } from '../dao/goal.dao';
import { ItemDao } from '../dao/item.dao';
import { NodeStateDao } from '../dao/node-state.dao';
import { RunDao } from '../dao/run.dao';
import { WallTurnDao } from '../dao/wall-turn.dao';
import type { AgentAdapterRegistry } from './agent-adapter.registry';
import { ChatWaterfallService } from './chat-waterfall.service';
import type { ItemCallIndexService } from './item-call-index.service';
import type { PolledSpendService } from './polled-spend.service';
import { RunOutcomeHistoryService } from './run-outcome-history.service';
import {
  fitToBudget,
  ITEM_TEXT_CHARS,
  OVERVIEW_BYTES,
  PAGE_BYTES,
  ThreadReaderService,
} from './thread-reader.service';
import { ThreadTimelineService } from './thread-timeline.service';

const T0 = Date.parse('2026-10-14T09:00:00.000Z');

describe('fitToBudget', () => {
  const entries = (count: number, size: number, fill: string): string[] =>
    Array.from({ length: count }, () => fill.repeat(size));

  it('shrinks a lastResort list only once every ordinary list is down to one entry', () => {
    const fitted = fitToBudget(
      { ordinary: entries(20, 100, 'o'), last: entries(2, 2_000, 'l') },
      ['ordinary'],
      2_500,
      ['last'],
    );

    expect(fitted.ordinary).toHaveLength(1);
    expect(fitted.last).toHaveLength(1);
    expect(fitted.shortened).toEqual({ ordinary: '1 of 20', last: '1 of 2' });
  });

  it('leaves a lastResort list whole while an ordinary list can still drop an entry', () => {
    const fitted = fitToBudget(
      { ordinary: entries(20, 100, 'o'), last: entries(4, 1, 'a') },
      ['ordinary'],
      500,
      ['last'],
    );

    const kept = (fitted.ordinary as unknown[]).length;
    expect(kept).toBeGreaterThan(1);
    expect(fitted.last).toHaveLength(4);
    expect(fitted.shortened).toEqual({ ordinary: `${kept} of 20` });
  });
});

describe('ThreadReaderService (in-memory sqlite)', () => {
  let orm: MikroORM;
  let reader: ThreadReaderService;
  let itemDao: ItemDao;
  let wallTurns: WallTurnDao;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        ...GENIRO_ORM_RUNTIME,
        dbName: ':memory:',
        entities: [
          Run,
          Item,
          NodeState,
          WallTurn,
          Goal,
          Project,
          ProjectInstructionChange,
          Task,
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

  function newReader(): ThreadReaderService {
    const em = orm.em.fork();
    itemDao = new ItemDao(em);
    wallTurns = new WallTurnDao(em);
    const runDao = new RunDao(em);
    const waterfall = new ChatWaterfallService(
      em,
      itemDao,
      new NodeStateDao(em),
      runDao,
      { pollsSpend: () => false } as unknown as PolledSpendService,
      kindRowsPassthrough(itemDao),
    );
    return new ThreadReaderService(
      em,
      runDao,
      itemDao,
      new ThreadTimelineService(em, waterfall, itemDao, {
        ensureIndexed: () => Promise.resolve(),
        stampEpochOf: () => 0,
      } as unknown as ItemCallIndexService),
      {
        for: (agent: string) => ({
          userInstructionsFile: (configDir: string | null) => ({
            path: `${configDir ?? `home-of-${agent}`}/RULES.md`,
          }),
          toolCallMetric: claudeToolCallMetric,
        }),
        all: () =>
          new Map([['claude', { toolCallMetric: claudeToolCallMetric }]]),
      } as unknown as AgentAdapterRegistry,
      wallTurns,
      new RunOutcomeHistoryService(em, itemDao, {
        all: () =>
          new Map([
            [
              'claude',
              { getConfig: () => ({ questionToolName: 'AskUserQuestion' }) },
            ],
          ]),
      } as unknown as AgentAdapterRegistry),
      kindRowsPassthrough(itemDao),
      new ProjectScopeService(em, new TaskDao(em), new ProjectDao(em), {
        rootsOf: async (cwds: Iterable<string | null>) =>
          new Map(
            [...cwds]
              .filter((cwd): cwd is string => cwd !== null)
              .map((cwd) => [cwd, cwd]),
          ),
      } as unknown as ProjectRootsService),
      new ProjectInstructionChangeDao(em),
      new GoalDao(em),
    );
  }

  beforeEach(async () => {
    await orm.schema.clear();
    reader = newReader();
    const run = new Run();
    run.id = 'source';
    run.title = 'Slow thread';
    run.status = 'completed';
    run.agentKind = 'claude';
    run.cwd = '/tmp/project';
    const fork = orm.em.fork();
    fork.persist(run);
    await fork.flush();
  });

  afterEach(() => {
    clearSecrets();
  });

  async function insert(
    seq: number,
    kind: ItemKind,
    payload: unknown,
    seconds: number,
    memberId?: string,
  ): Promise<void> {
    const fork = orm.em.fork();
    const at = new Date(T0 + seconds * 1000);
    fork.create(Item, {
      runId: 'source',
      seq,
      kind,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      ...(kind === 'message' ? { role: 'user' } : {}),
      ...(memberId === undefined ? {} : { memberId }),
      createdAt: at,
      updatedAt: at,
    });
    await fork.flush();
  }

  describe('view=project', () => {
    async function bindSource(
      project: Partial<Project>,
      snapshot: string | null,
    ): Promise<void> {
      const fork = orm.em.fork();
      fork.persist(
        Object.assign(new Project(), {
          id: 'p-billing',
          name: 'Billing',
          folder: '/tmp/project',
          taskKey: 'BIL',
          ...project,
        }),
      );
      const run = await fork.findOneOrFail(Run, 'source');
      run.projectId = 'p-billing';
      run.projectSource = 'folder';
      run.projectInstructions = snapshot;
      await fork.flush();
    }

    it('returns current text, differing snapshot and changes, masked', async () => {
      registerSecret('tok-SECRET-1234', 'deploy key');
      await bindSource(
        {
          instructions: 'Use pnpm. Deploy key tok-SECRET-1234.',
          instructionsRevision: 3,
        },
        'Project: Billing\n\nUse yarn.',
      );
      const fork = orm.em.fork();
      fork.persist(
        Object.assign(new ProjectInstructionChange(), {
          projectId: 'p-billing',
          changedAt: new Date(T0),
          field: 'instructions',
          source: 'analysis',
          previous: 'Use yarn.',
          next: 'Use pnpm.',
          recommendationIds: JSON.stringify(['P-1']),
          chatRunId: 'analysis-1',
        }),
      );
      await fork.flush();

      const answer = await reader.read(
        { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
        { view: 'project' },
      );

      expect(JSON.stringify(answer)).not.toContain('tok-SECRET-1234');
      expect(answer.projects).toEqual([
        expect.objectContaining({
          projectId: 'p-billing',
          name: 'Billing',
          key: 'BIL',
          instructionsRevision: 3,
          description: null,
          instructionsChars: 'Use pnpm. Deploy key tok-SECRET-1234.'.length,
          instructionsMaxChars: 20_000,
          instructionBlocks: [
            {
              id: 'instructions',
              title: 'Instructions',
              text: expect.stringMatching(/^Use pnpm\. Deploy key /),
            },
          ],
          runs: [
            expect.objectContaining({
              runId: 'source',
              startedWith: 'Project: Billing\n\nUse yarn.',
            }),
          ],
          changes: [
            expect.objectContaining({
              field: 'instructions',
              by: 'analysis',
              previous: 'Use yarn.',
              next: 'Use pnpm.',
              recommendationIds: ['P-1'],
            }),
          ],
        }),
      ]);
    });

    it('reads a start copy that differs only by the project’s old name as the same text', async () => {
      await bindSource(
        { name: 'Billing', instructions: 'Use pnpm.' },
        'Project: Payments\n\nUse pnpm.',
      );

      const answer = await reader.read(
        { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
        { view: 'project' },
      );

      expect(answer.projects).toEqual([
        expect.objectContaining({
          runs: [
            expect.objectContaining({ startedWith: 'the same text as now' }),
          ],
        }),
      ]);
    });

    it('lists every project a team analysis’s runs belong to', async () => {
      await bindSource({ instructions: 'Use pnpm.' }, null);
      const fork = orm.em.fork();
      fork.persist(
        Object.assign(new Project(), {
          id: 'p-ledger',
          name: 'Ledger',
          folder: '/tmp/ledger',
          taskKey: 'LED',
        }),
      );
      fork.persist(
        Object.assign(new Run(), {
          id: 'other',
          title: 'Ledger run',
          status: 'completed',
          agentKind: 'claude',
          cwd: '/tmp/ledger',
          projectId: 'p-ledger',
          projectSource: 'explicit',
        }),
      );
      await fork.flush();

      const answer = await reader.read(
        {
          sourceRunId: 'source',
          snapshotSeq: 0,
          sourceWorking: false,
          team: {
            slug: 'crew',
            runs: [
              { runId: 'source', snapshotSeq: 0, working: false },
              { runId: 'other', snapshotSeq: 0, working: false },
            ],
          },
        },
        { view: 'project' },
      );

      expect(
        (answer.projects as { projectId: string; runs: { runId: string }[] }[])
          .map((project) => [
            project.projectId,
            project.runs.map((run) => run.runId),
          ])
          .sort(),
      ).toEqual([
        ['p-billing', ['source']],
        ['p-ledger', ['other']],
      ]);
    });

    it('names a run in no project, and the overview names the run’s project', async () => {
      const none = await reader.read(
        { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
        { view: 'project' },
      );
      expect(none).toMatchObject({
        projects: [],
        runsWithoutProject: ['source'],
      });

      await bindSource({ instructions: 'Use pnpm.' }, null);
      await insert(0, 'message', { text: 'go' }, 0);
      const overview = await reader.read(
        { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
        { view: 'overview' },
      );
      expect(overview.source).toMatchObject({
        project: { id: 'p-billing', name: 'Billing' },
      });
    });
  });

  it('times tool calls in the overview and keeps it inside its budget', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', output: 'done' }, 91);
    await insert(3, 'turn_complete', { usage: { durationMs: 95_000 } }, 96);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 3, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.source).toMatchObject({ kind: 'chat', title: 'Slow thread' });
    expect(answer.slowestTools).toEqual([
      expect.objectContaining({ seq: 1, name: 'Bash', ms: 90_000 }),
    ]);
    expect(answer.timing).toMatchObject({ wallMs: 96_000, toolCalls: 1 });
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
  });

  it('counts the team notes up to the snapshot and points at them only when there are some', async () => {
    const note = {
      kind: 'fact',
      text: 'CI is ubuntu',
      memberId: 'a',
      conversationId: null,
    };
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'team_note', note, 1);
    await insert(2, 'team_note', { ...note, kind: 'pitfall' }, 2);
    await insert(3, 'turn_complete', { usage: { durationMs: 3_000 } }, 3);
    // Written after the analysis began: outside its snapshot.
    await insert(4, 'team_note', note, 4);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 3, sourceWorking: false },
      { view: 'overview' },
    );
    expect(answer.teamNotes).toBe(2);
    expect(answer.next).toContain('kinds=["team_note"]');

    const before = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'overview' },
    );
    expect(before.teamNotes).toBe(0);
    expect(before.next).not.toContain('team_note');
  });

  it("names the chat agent's own instructions file, failed tool calls and the tokens it spent", async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', isError: true }, 2);
    await insert(3, 'tool_call', { id: 't2', name: 'Read' }, 3);
    await insert(4, 'tool_result', { id: 't2' }, 4);
    await insert(
      5,
      'turn_complete',
      {
        usage: {
          durationMs: 5_000,
          inputTokens: 1_200,
          outputTokens: 300,
          cacheReadTokens: 9_000,
          costUsd: 0.25,
        },
      },
      5,
    );

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 5, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.source).toMatchObject({
      userInstructions: [
        { agent: 'claude', configDir: null, path: 'home-of-claude/RULES.md' },
      ],
    });
    expect(answer.timing).toMatchObject({
      failedToolCalls: 1,
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 9_000,
      costUsd: 0.25,
    });
    expect(answer.slowestTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 1, failed: true }),
        expect.not.objectContaining({ failed: true }),
      ]),
    );
    expect(answer.toolTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bash', failed: 1 }),
        expect.objectContaining({ name: 'Read', failed: 0 }),
      ]),
    );
  });

  it('lists the goals with their evidence, the outcome, each MCP server and the stage moves', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(
      1,
      'tool_call',
      { id: 't1', name: 'mcp__codegraph__codegraph_explore' },
      1,
    );
    await insert(2, 'tool_result', { id: 't1', isError: true }, 2);
    await insert(3, 'tool_call', { id: 't2', name: 'Bash' }, 3);
    await insert(4, 'tool_result', { id: 't2' }, 4);
    await insert(
      5,
      'stage_change',
      {
        action: 'complete',
        stageId: 'build',
        stageTitle: 'Build',
        text: 'built',
        rev: 1,
        by: { kind: 'agent', nodeId: 'agent' },
      },
      5,
    );
    await insert(6, 'turn_complete', { usage: { durationMs: 1_000 } }, 6);
    await insert(
      7,
      'thread_outcome',
      {
        kind: 'partial',
        summary: 'after the snapshot',
        teamSlug: null,
        nodeId: 'agent',
        conversationId: null,
      },
      7,
    );
    const em = orm.em.fork();
    for (const [number, status, evidence] of [
      [1, 'achieved', 'spec passes'],
      [2, 'achieved', 'csv saved'],
      [3, 'open', null],
    ] as const) {
      em.persist(
        Object.assign(new Goal(), {
          runId: 'source',
          number,
          text: `goal ${number}`,
          source: 'agent',
          status,
          evidence,
        }),
      );
    }
    await em.flush();

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 6, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.goals).toEqual([
      {
        id: 'g1',
        text: 'goal 1',
        source: 'agent',
        status: 'achieved',
        evidence: 'spec passes',
      },
      {
        id: 'g2',
        text: 'goal 2',
        source: 'agent',
        status: 'achieved',
        evidence: 'csv saved',
      },
      {
        id: 'g3',
        text: 'goal 3',
        source: 'agent',
        status: 'open',
        evidence: null,
      },
    ]);
    // The outcome row lies past the snapshot, and a goal is still open, so
    // the thread has no outcome yet.
    expect(answer.outcome).toBeNull();
    const later = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 7, sourceWorking: false },
      { view: 'overview' },
    );
    expect(later.outcome).toEqual({
      kind: 'partial',
      summary: 'after the snapshot',
      source: 'recorded',
      seq: 7,
    });
    expect(answer.mcpServers).toEqual([
      {
        server: 'codegraph',
        calls: 1,
        failed: 1,
        tools: ['codegraph_explore'],
      },
    ]);
    expect(answer.stages).toEqual([
      expect.objectContaining({ seq: 5, action: 'complete', stage: 'build' }),
    ]);
    expect(answer.handOffs).toBe(0);
  });

  it('tells the analysis which part of the cost geniro priced itself', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(
      1,
      'turn_complete',
      { usage: { durationMs: 1_000, costUsd: 0.5, estimatedCostUsd: 0.5 } },
      1,
    );

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.timing).toMatchObject({
      costUsd: 0.5,
      estimatedCostUsd: 0.5,
    });
  });

  it('leaves usage it never measured null, not zero', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'turn_complete', { usage: { durationMs: 1_000 } }, 1);

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.timing).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
    });
  });

  it('counts sub-agent tool calls apart and carries a turn’s cost split', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', output: 'done' }, 2);
    await insert(
      3,
      'tool_call',
      { id: 't2', name: 'Read', parentToolUseId: 'toolu_agent' },
      3,
    );
    await insert(4, 'tool_result', { id: 't2', output: 'read' }, 4);
    await insert(
      5,
      'turn_complete',
      {
        usage: {
          durationMs: 6_000,
          costUsd: 3,
          modelCosts: [
            { model: 'haiku', costUsd: 2 },
            { model: 'opus', costUsd: 1 },
          ],
        },
      },
      6,
    );
    const source = {
      sourceRunId: 'source',
      snapshotSeq: 5,
      sourceWorking: false,
    };

    const overview = await reader.read(source, { view: 'overview' });
    expect(overview.timing).toMatchObject({
      toolCalls: 1,
      delegateToolCalls: 1,
    });
    expect(overview.nodes).toEqual([
      expect.objectContaining({ toolCalls: 1, delegateToolCalls: 1 }),
    ]);
    expect(overview.toolTotals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bash', delegate: false, calls: 1 }),
        expect.objectContaining({ name: 'Read', delegate: true, calls: 1 }),
      ]),
    );
    expect(overview.slowestTools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seq: 3, delegate: true }),
        expect.objectContaining({ seq: 1, delegate: false }),
      ]),
    );
    const tools = (
      await reader.read(source, { view: 'spans', kinds: ['tool'] })
    ).spans as Record<string, unknown>[];
    expect(tools.map((span) => [span.seq, span.delegate])).toEqual(
      expect.arrayContaining([
        [1, false],
        [3, true],
      ]),
    );

    expect(overview.nodes).toEqual([
      expect.objectContaining({ toolMs: 1_000, delegateToolMs: 1_000 }),
    ]);
    const spans = (
      await reader.read(source, { view: 'spans', kinds: ['turn'] })
    ).spans as Record<string, unknown>[];
    expect(spans).toEqual([
      expect.objectContaining({
        toolCalls: 1,
        delegateToolCalls: 1,
        modelCosts: [
          { model: 'haiku', costUsd: 2 },
          { model: 'opus', costUsd: 1 },
        ],
      }),
    ]);
  });

  it('states how long the callee worked inside each call span, through the snapshot', async () => {
    const started = (callId: string): Record<string, unknown> => ({
      callId,
      callerMemberId: 'lead',
      calleeMemberId: 'dev',
      mode: 'sync',
    });
    await insert(1, 'call_started', started('call-1'), 0);
    await insert(
      2,
      'turn_complete',
      { callId: 'call-1', usage: { durationMs: 4_000 } },
      5,
    );
    await insert(3, 'call_result', { callId: 'call-1', status: 'ok' }, 6);
    await insert(4, 'call_started', started('call-2'), 7);
    await insert(
      5,
      'turn_complete',
      { callId: 'call-2', usage: { costUsd: 0.1 } },
      10,
    );
    await insert(6, 'call_result', { callId: 'call-2', status: 'ok' }, 11);
    await insert(
      7,
      'turn_complete',
      { callId: 'call-2', usage: { durationMs: 9_000 } },
      12,
    );
    await wallTurns.record('source', [{ seq: 5, memberId: 'dev', ms: 2_500 }]);

    const spans = (
      await reader.read(
        { sourceRunId: 'source', snapshotSeq: 6, sourceWorking: false },
        { view: 'spans', kinds: ['call'] },
      )
    ).spans as Record<string, unknown>[];

    expect(spans.map((span) => [span.ms, span.workedMs])).toEqual([
      [6_000, 4_000],
      [4_000, 2_500],
    ]);
  });

  it('leaves the cost split out of a turn span that has none', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(
      1,
      'turn_complete',
      { usage: { durationMs: 1_000, costUsd: 1 } },
      1,
    );

    const spans = (
      await reader.read(
        { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
        { view: 'spans', kinds: ['turn'] },
      )
    ).spans as Record<string, unknown>[];
    expect(spans).toHaveLength(1);
    expect(spans[0]).not.toHaveProperty('modelCosts');
  });

  it('never returns a row past the snapshot seq', async () => {
    await insert(0, 'message', { text: 'before' }, 0);
    await insert(1, 'message', { text: 'after the click' }, 1);

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'items' },
    );
    const item = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 1 },
    );

    expect((page.items as { seq: number }[]).map((row) => row.seq)).toEqual([
      0,
    ]);
    expect(item.error).toBe('PAST_SNAPSHOT');
  });

  it('pages items under the byte budget and continues from the cursor', async () => {
    const long = 'x'.repeat(ITEM_TEXT_CHARS * 2);
    for (let seq = 0; seq < 30; seq += 1) {
      await insert(seq, 'message', { text: `${seq} ${long}` }, seq);
    }

    const first = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 29, sourceWorking: false },
      { view: 'items' },
    );
    const rows = first.items as { seq: number; text: string }[];
    const next = first.next as { afterSeq: number };
    const second = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 29, sourceWorking: false },
      { view: 'items', afterSeq: next.afterSeq },
    );

    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    expect(rows.length).toBeLessThan(30);
    expect(rows[0]!.text).toContain('view=item seq=0');
    expect((second.items as { seq: number }[])[0]!.seq).toBe(next.afterSeq + 1);
  });

  it('collapses a base64 image and masks a registered secret in one row', async () => {
    registerSecret('sk-live-0123456789abcdef', 'api key');
    await insert(
      0,
      'tool_result',
      {
        id: 't1',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'A'.repeat(4096),
            },
          },
          { type: 'text', text: 'token sk-live-0123456789abcdef' },
        ],
      },
      0,
    );

    const item = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0 },
    );

    expect(item.text).toContain('[image: image/png, 3 KB]');
    expect(item.text).not.toContain('AAAA');
    expect(item.text).not.toContain('sk-live-0123456789abcdef');
  });

  it('reads one long row in chunks that each fit a page', async () => {
    await insert(0, 'message', { text: 'y'.repeat(PAGE_BYTES * 2) }, 0);

    const first = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0 },
    );
    const next = first.next as { offset: number };
    const second = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'item', seq: 0, offset: next.offset },
    );

    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    const joined = `${first.text as string}${second.text as string}`;
    expect(first.total).toBe(PAGE_BYTES * 2);
    expect(joined).toBe('y'.repeat(joined.length));
    expect(joined.length).toBeGreaterThan(PAGE_BYTES);
  });

  it('pages slow tools as spans and continues from the cursor', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    let seq = 1;
    const name = (index: number): string =>
      `${String(index).padStart(4, '0')}-${'n'.repeat(76)}`;
    for (let index = 0; index < 300; index += 1) {
      await insert(
        seq,
        'tool_call',
        { id: `t${index}`, name: name(index) },
        index,
      );
      await insert(
        seq + 1,
        'tool_result',
        { id: `t${index}` },
        index + (index % 2 === 0 ? 30 : 1),
      );
      seq += 2;
    }
    const source = {
      sourceRunId: 'source',
      snapshotSeq: seq - 1,
      sourceWorking: false,
    };
    const read = (cursor?: number) =>
      reader.read(source, {
        view: 'spans',
        kinds: ['tool'],
        minMs: 10_000,
        ...(cursor === undefined ? {} : { cursor }),
      });

    const first = await read();
    const firstSpans = first.spans as {
      type: string;
      ms: number;
      name: string;
    }[];
    const next = first.next as { cursor: number };
    const second = await read(next.cursor);
    const secondSpans = second.spans as { name: string }[];

    expect(first.total).toBe(150);
    expect(
      firstSpans.every((span) => span.type === 'tool' && span.ms >= 10_000),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(
      PAGE_BYTES,
    );
    expect(next.cursor).toBe(firstSpans.length);
    expect(second.from).toBe(next.cursor);
    // The page picks up exactly where the first one stopped.
    const lastIndex = Number(firstSpans.at(-1)!.name.slice(0, 4));
    expect(Number(secondSpans[0]!.name.slice(0, 4))).toBe(lastIndex + 2);
  });

  it('masks a secret a page clip would have cut, leaving no prefix of it', async () => {
    registerSecret('sk-live-0123456789abcdef', 'api key');
    await insert(
      0,
      'message',
      {
        text: `${'x'.repeat(ITEM_TEXT_CHARS - 5)}sk-live-0123456789abcdef tail`,
      },
      0,
    );

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'items' },
    );
    const text = (page.items as { text: string }[])[0]!.text;

    expect(text).not.toContain('sk-li');
  });

  it('says there is more when the read limit, not the byte budget, ended the page', async () => {
    for (let seq = 0; seq < 50; seq += 1) {
      await insert(seq, 'message', { text: `m${seq}` }, seq);
    }

    const page = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 49, sourceWorking: false },
      { view: 'items' },
    );

    expect((page.items as unknown[]).length).toBe(40);
    expect(page.next).toEqual({ afterSeq: 39 });
  });

  it('draws a tool call left open at the snapshot by the working flag it was taken with', async () => {
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 10);
    await insert(2, 'message', { text: 'still going' }, 70);
    const spans = async (working: boolean) =>
      (
        await reader.read(
          { sourceRunId: 'source', snapshotSeq: 2, sourceWorking: working },
          { view: 'spans', kinds: ['tool'] },
        )
      ).spans as { open: boolean; ms: number }[];

    expect(await spans(true)).toEqual([
      expect.objectContaining({ open: true, ms: 60_000 }),
    ]);
    expect(await spans(false)).toEqual([
      expect.objectContaining({ open: false, ms: 0 }),
    ]);
  });

  it('shortens the overview to its budget and says what it kept', async () => {
    let seq = 0;
    for (let index = 0; index < 400; index += 1) {
      const name = `Tool-${index}-${'q'.repeat(40)}`;
      await insert(seq, 'tool_call', { id: `t${index}`, name }, index);
      await insert(seq + 1, 'tool_result', { id: `t${index}` }, index + 1);
      seq += 2;
    }

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: seq - 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
    expect((answer.shortened as Record<string, string>).slowestTools).toMatch(
      /^\d+ of 400$/,
    );
  });

  it('keeps every goal, clipping only its evidence past the budget, and keeps the nodes, calls and stages whole', async () => {
    await insert(0, 'message', { text: 'go' }, 0, 'lead');
    await insert(
      1,
      'call_started',
      {
        callId: 'call-1',
        callerMemberId: 'lead',
        calleeMemberId: 'dev',
        mode: 'sync',
      },
      1,
      'lead',
    );
    await insert(
      2,
      'turn_complete',
      { usage: { durationMs: 4_000 } },
      5,
      'dev',
    );
    await insert(
      3,
      'call_result',
      { callId: 'call-1', status: 'ok' },
      6,
      'lead',
    );
    await insert(
      4,
      'call_started',
      {
        callId: 'call-2',
        callerMemberId: 'lead',
        calleeMemberId: 'dev',
        mode: 'sync',
      },
      7,
      'lead',
    );
    await insert(
      5,
      'turn_complete',
      { usage: { durationMs: 9_000 } },
      12,
      'dev',
    );
    await insert(
      6,
      'call_result',
      { callId: 'call-2', status: 'ok' },
      13,
      'lead',
    );
    await insert(
      7,
      'turn_complete',
      { usage: { durationMs: 2_000 } },
      14,
      'qa',
    );
    for (const [seq, stageId, rev] of [
      [8, 'build', 1],
      [9, 'review', 2],
    ] as const) {
      await insert(
        seq,
        'stage_change',
        {
          action: 'complete',
          stageId,
          stageTitle: stageId,
          text: 'done',
          rev,
          by: { kind: 'agent', nodeId: 'lead' },
        },
        14 + seq,
        'lead',
      );
    }
    await insert(
      10,
      'turn_complete',
      { usage: { durationMs: 1_000 } },
      25,
      'lead',
    );
    const em = orm.em.fork();
    for (let number = 1; number <= 6; number += 1) {
      em.persist(
        Object.assign(new Goal(), {
          runId: 'source',
          number,
          text: `goal ${number}`,
          source: 'agent',
          status: 'achieved',
          evidence: 'e'.repeat(3_500),
        }),
      );
    }
    await em.flush();

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 10, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.goals).toHaveLength(6);
    for (const goal of answer.goals as { evidence: string }[]) {
      expect(goal.evidence).toBe(`${'e'.repeat(300)}… [+3200 chars]`);
    }
    expect(answer.shortened).toEqual({
      goalEvidence: 'clipped to 300 characters each',
    });
    expect(answer.nodes).toHaveLength(3);
    expect(answer.calls).toEqual([expect.objectContaining({ calls: 2 })]);
    expect(answer.stages).toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
  });

  it('shortens the goals themselves when clipped evidence is not enough, saying both, before it touches the nodes', async () => {
    const em = orm.em.fork();
    await insert(0, 'message', { text: 'go' }, 0, 'lead');
    await insert(
      1,
      'turn_complete',
      { usage: { durationMs: 1_000 } },
      1,
      'lead',
    );
    for (let number = 1; number <= 80; number += 1) {
      em.persist(
        Object.assign(new Goal(), {
          runId: 'source',
          number,
          text: `goal ${number}`,
          source: 'agent',
          status: 'achieved',
          evidence: 'e'.repeat(400),
        }),
      );
    }
    await em.flush();

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 1, sourceWorking: false },
      { view: 'overview' },
    );

    const shortened = answer.shortened as Record<string, string>;
    expect(shortened.goalEvidence).toBe('clipped to 300 characters each');
    expect(shortened.goals).toMatch(/^\d+ of 80$/);
    expect(shortened).not.toHaveProperty('nodes');
    expect(answer.nodes).toHaveLength(1);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
  });

  it('shrinks a long tool list before it shrinks the nodes, and names only the list it shortened', async () => {
    let seq = 0;
    for (let index = 0; index < 400; index += 1) {
      const name = `Tool-${index}-${'q'.repeat(40)}`;
      await insert(seq, 'tool_call', { id: `t${index}`, name }, index, 'lead');
      await insert(
        seq + 1,
        'tool_result',
        { id: `t${index}` },
        index + 1,
        'lead',
      );
      seq += 2;
    }
    await insert(
      seq,
      'turn_complete',
      { usage: { durationMs: 1_000 } },
      401,
      'dev',
    );
    await insert(
      seq + 1,
      'turn_complete',
      { usage: { durationMs: 1_000 } },
      402,
      'qa',
    );

    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: seq + 1, sourceWorking: false },
      { view: 'overview' },
    );

    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      OVERVIEW_BYTES,
    );
    const shortened = answer.shortened as Record<string, string>;
    expect(shortened.slowestTools).toMatch(/^\d+ of 400$/);
    expect(shortened).not.toHaveProperty('nodes');
    expect(answer.nodes).toHaveLength(3);
  });

  it('answers view=spend as unsupported, because the tool answers it', async () => {
    const answer = await reader.read(
      { sourceRunId: 'source', snapshotSeq: 0, sourceWorking: false },
      { view: 'spend' },
    );

    expect(answer.error).toBe('UNSUPPORTED');
  });

  it('answers every view of an archived thread as it did while the thread was live', async () => {
    const fork = orm.em.fork();
    fork.persist(
      Object.assign(new Project(), {
        id: 'p-billing',
        name: 'Billing',
        folder: '/tmp/project',
        taskKey: 'BIL',
        instructions: 'Use pnpm.',
      }),
    );
    const source = await fork.findOneOrFail(Run, 'source');
    source.projectId = 'p-billing';
    source.projectSource = 'folder';
    await fork.flush();
    await insert(0, 'message', { text: 'go' }, 0);
    await insert(1, 'tool_call', { id: 't1', name: 'Bash' }, 1);
    await insert(2, 'tool_result', { id: 't1', output: 'done' }, 91);
    await insert(3, 'turn_complete', { usage: { durationMs: 95_000 } }, 96);
    const turn = {
      sourceRunId: 'source',
      snapshotSeq: 3,
      sourceWorking: false,
    };
    const readEveryView = async (from: ThreadReaderService) => ({
      overview: await from.read(turn, { view: 'overview' }),
      spans: await from.read(turn, { view: 'spans', kinds: ['turn', 'tool'] }),
      items: await from.read(turn, { view: 'items' }),
      item: await from.read(turn, { view: 'item', seq: 2 }),
      project: await from.read(turn, { view: 'project' }),
    });

    const live = await readEveryView(reader);

    const shelve = orm.em.fork();
    const row = await shelve.findOneOrFail(Run, 'source');
    row.archivedAt = new Date();
    await shelve.flush();
    const archived = await readEveryView(newReader());

    expect(live.overview.slowestTools).toEqual([
      expect.objectContaining({ seq: 1, name: 'Bash', ms: 90_000 }),
    ]);
    expect(live.spans.error).toBeUndefined();
    expect(live.items.snapshotSeq).toBe(3);
    expect(live.item.seq).toBe(2);
    expect(live.project.projects).toEqual([
      expect.objectContaining({ projectId: 'p-billing' }),
    ]);
    expect(archived).toEqual(live);
  });

  it('answers SOURCE_GONE once the analysed thread is deleted', async () => {
    const answer = await reader.read(
      { sourceRunId: 'deleted', snapshotSeq: 0, sourceWorking: false },
      { view: 'overview' },
    );

    expect(answer.error).toBe('SOURCE_GONE');
  });

  describe('a team analysis', () => {
    async function teamRun(
      id: string,
      createdAt: number,
      title = `Run ${id}`,
    ): Promise<void> {
      const run = new Run();
      run.id = id;
      run.title = title;
      run.status = 'completed';
      run.teamId = 'team';
      run.createdAt = new Date(T0 + createdAt);
      const fork = orm.em.fork();
      fork.persist(run);
      await fork.flush();
    }

    async function row(
      runId: string,
      seq: number,
      kind: ItemKind,
      payload: unknown,
      seconds: number,
      memberId: string,
    ): Promise<void> {
      const fork = orm.em.fork();
      const at = new Date(T0 + seconds * 1000);
      fork.create(Item, {
        runId,
        seq,
        kind,
        memberId,
        payload: JSON.stringify(payload),
        createdAt: at,
        updatedAt: at,
      });
      await fork.flush();
    }

    const outcomeRow = (acceptance: string, reviewRounds: number) => ({
      prOwner: 'o',
      prRepo: 'r',
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      draft: false,
      reviewRounds,
      acceptance,
      questionsAsked: 0,
      teamSlug: 'team',
      nodeId: 'dev',
      conversationId: null,
    });

    const turn = (model: string, costUsd: number, durationMs: number) => ({
      usage: { durationMs, costUsd, contextModel: model },
    });

    const scope = {
      sourceRunId: 'wf-new',
      snapshotSeq: 3,
      sourceWorking: false,
      team: {
        slug: 'team',
        runs: [
          { runId: 'wf-new', snapshotSeq: 3, working: false },
          { runId: 'wf-old', snapshotSeq: 1, working: false },
          { runId: 'wf-gone', snapshotSeq: 4, working: false },
        ],
      },
    };

    beforeEach(async () => {
      await teamRun('wf-new', 2_000);
      await teamRun('wf-old', 1_000);
      await row('wf-new', 0, 'message', { text: 'go' }, 0, 'dev');
      await row('wf-new', 1, 'turn_complete', turn('opus', 3, 6_000), 6, 'dev');
      await row('wf-new', 2, 'turn_complete', turn('opus', 1, 2_000), 9, 'dev');
      await row(
        'wf-new',
        3,
        'run_outcome',
        outcomeRow('accepted', 2),
        10,
        'dev',
      );
      // Past the snapshot too: neither may reach the comparison.
      await row(
        'wf-new',
        5,
        'run_outcome',
        outcomeRow('changes_requested', 3),
        31,
        'dev',
      );
      await row(
        'wf-new',
        6,
        'approval_request',
        { toolName: 'AskUserQuestion', questions: [{ question: 'More?' }] },
        32,
        'dev',
      );
      // Written after the analysis began: past this run's snapshot.
      await row(
        'wf-new',
        4,
        'turn_complete',
        turn('opus', 9, 9_000),
        30,
        'dev',
      );
      await row('wf-old', 0, 'message', { text: 'go' }, 0, 'dev');
      await row(
        'wf-old',
        1,
        'turn_complete',
        turn('sonnet', 1, 4_000),
        4,
        'dev',
      );
    });

    describe('team versions', () => {
      const first = teamOf([member('dev')], { name: 'Team' });
      const second = teamOf([member('dev', { model: 'opus' })], {
        name: 'Team',
      });
      const V1 = teamVersionOf(TeamSchema.parse(first));
      const V2 = teamVersionOf(TeamSchema.parse(second));

      beforeEach(async () => {
        const fork = orm.em.fork();
        const newest = await fork.findOneOrFail(Run, { id: 'wf-new' });
        newest.teamSnapshot = JSON.stringify(second);
        const older = await fork.findOneOrFail(Run, { id: 'wf-old' });
        older.teamSnapshot = JSON.stringify(first);
        await fork.flush();
      });

      it("names each run's team version by its number and compares the runs version by version", async () => {
        const asked: string[] = [];

        const answer = await reader.read(scope, { view: 'runs' }, (slug) => {
          asked.push(slug);
          return Promise.resolve({
            current: V2,
            numbers: new Map([
              [V1, 1],
              [V2, 2],
            ]),
          });
        });

        expect(asked).toEqual(['team']);
        expect(answer.currentVersion).toEqual({
          version: V2,
          number: 2,
          current: true,
        });
        expect(answer.runs).toEqual([
          expect.objectContaining({
            runId: 'wf-new',
            version: { version: V2, number: 2, current: true },
          }),
          expect.objectContaining({
            runId: 'wf-old',
            version: { version: V1, number: 1, current: false },
          }),
          { runId: 'wf-gone', gone: true },
        ]);
        expect(answer.versions).toEqual([
          expect.objectContaining({
            version: V2,
            number: 2,
            runIds: ['wf-new'],
            avgCostUsd: 4,
          }),
          expect.objectContaining({
            version: V1,
            number: 1,
            runIds: ['wf-old'],
            avgCostUsd: 1,
          }),
        ]);
      });

      it('names the versions by hash alone when their numbers cannot be read', async () => {
        const answer = await reader.read(scope, { view: 'runs' }, () =>
          Promise.reject(new Error('SQLITE_BUSY')),
        );

        expect(answer.currentVersion).toBeNull();
        expect(answer.runs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              runId: 'wf-new',
              version: { version: V2, number: null, current: false },
            }),
          ]),
        );
      });

      it("answers the team's whole population beside the runs read, from the reader handed in", async () => {
        const population: RecommendationsTeamPopulation = {
          runs: 9,
          perRun: {
            costUsd: 1.5,
            pricedRuns: 9,
            workedMs: 600_000,
            timedRuns: 9,
            turns: 3,
          },
        };
        const asked: string[] = [];

        const answer = await reader.read(
          scope,
          { view: 'runs' },
          null,
          (slug) => {
            asked.push(slug);
            return Promise.resolve(population);
          },
        );

        expect(asked).toEqual(['team']);
        expect(answer).toMatchObject({ runsRead: 3, population });
      });

      it('answers no population when its reader fails', async () => {
        const answer = await reader.read(scope, { view: 'runs' }, null, () =>
          Promise.reject(new Error('SQLITE_BUSY')),
        );

        expect(answer).toMatchObject({ runsRead: 3, population: null });
      });
    });

    it('counts the questions put to the user up to each run’s snapshot', async () => {
      await teamRun('wf-q', 3_000);
      const question = {
        toolName: 'AskUserQuestion',
        questions: [{ question: 'Ship it?' }],
      };
      await row('wf-q', 0, 'message', { text: 'go' }, 0, 'dev');
      await row('wf-q', 1, 'approval_request', question, 1, 'dev');
      await row('wf-q', 2, 'approval_verdict', { allow: true }, 2, 'dev');
      await row('wf-q', 3, 'turn_complete', turn('opus', 1, 3_000), 3, 'dev');
      await row('wf-q', 4, 'approval_request', question, 4, 'dev');

      const answer = await reader.read(
        {
          sourceRunId: 'wf-q',
          snapshotSeq: 3,
          sourceWorking: false,
          team: {
            slug: 'team',
            runs: [{ runId: 'wf-q', snapshotSeq: 3, working: false }],
          },
        },
        { view: 'runs' },
      );

      expect(answer.runs).toEqual([
        expect.objectContaining({ runId: 'wf-q', questionsAsked: 1 }),
      ]);
    });

    it("compares the runs and each member's models, every turn up to each run's own snapshot", async () => {
      const answer = await reader.read(scope, { view: 'runs' });

      expect(answer.team).toBe('team');
      expect(answer.runs).toEqual([
        expect.objectContaining({
          runId: 'wf-new',
          turns: 2,
          costUsd: 4,
          calls: 0,
          nodes: [
            expect.objectContaining({
              node: 'dev',
              turns: 2,
              workedMs: 8_000,
              costUsd: 4,
            }),
          ],
          questionsAsked: 0,
          pullRequests: [
            {
              pullRequest: 'o/r#7',
              acceptance: 'accepted',
              reviewRounds: 2,
              draft: false,
              changesRequestedRounds: 0,
              msToAccepted: 0,
            },
          ],
        }),
        expect.objectContaining({
          runId: 'wf-old',
          turns: 1,
          costUsd: 1,
          nodes: [
            expect.objectContaining({
              node: 'dev',
              turns: 1,
              workedMs: 4_000,
              costUsd: 1,
            }),
          ],
        }),
        { runId: 'wf-gone', gone: true },
      ]);
      expect(answer.calls).toEqual([]);
      expect(answer.models).toEqual([
        expect.objectContaining({
          node: 'dev',
          model: 'opus',
          runs: 1,
          turns: 2,
          costUsd: 4,
          costPerTurnUsd: 2,
        }),
        expect.objectContaining({
          node: 'dev',
          model: 'sonnet',
          runs: 1,
          turns: 1,
          costUsd: 1,
        }),
      ]);
    });

    // cursor reports no timing: its working time is the wall clock's ledger,
    // and its completed turn is drawn from its lane's previous row.
    it("times a member its CLI did not time by the wall clock, up to the run's snapshot", async () => {
      await row('wf-old', 2, 'message', { text: 'checking' }, 100, 'qa');
      await row('wf-old', 3, 'turn_complete', { usage: {} }, 100.002, 'qa');
      await wallTurns.record('wf-old', [
        { seq: 3, memberId: 'qa', ms: 90_000 },
        // Past the run's snapshot.
        { seq: 5, memberId: 'qa', ms: 40_000 },
      ]);
      const wider = {
        ...scope,
        team: {
          slug: 'team',
          runs: [{ runId: 'wf-old', snapshotSeq: 4, working: false }],
        },
      };

      const answer = await reader.read(wider, { view: 'runs' });
      const [old] = answer.runs as { nodes: Record<string, unknown>[] }[];

      expect(old!.nodes).toEqual([
        expect.objectContaining({ node: 'dev', workedMs: 4_000 }),
        expect.objectContaining({
          node: 'qa',
          workedMs: 90_000,
          busyMs: null,
          criticalPathMs: null,
        }),
      ]);
      expect(answer.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ node: 'qa', workedMs: 90_000 }),
        ]),
      );
      expect(answer.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            node: 'qa',
            turns: 1,
            timedTurns: 0,
            avgTurnMs: null,
          }),
        ]),
      );
    });

    it('pages a long comparison rather than dropping runs, and names a run with no rows yet', async () => {
      const many = Array.from({ length: 30 }, (_, index) => `wf-${index}`);
      for (const [index, id] of many.entries()) {
        await teamRun(id, 10_000 + index, `${id} ${'t'.repeat(600)}`);
        await row(id, 0, 'message', { text: 'go' }, 0, 'dev');
        for (let seq = 1; seq <= 3; seq += 1) {
          await row(
            id,
            seq,
            'turn_complete',
            turn(`model-${seq}`, 1, 1_000),
            seq,
            `node-${seq}-${'x'.repeat(60)}`,
          );
        }
      }
      await teamRun('wf-empty', 9_000);
      const wide = {
        ...scope,
        team: {
          slug: 'team',
          runs: [
            ...many.map((runId) => ({ runId, snapshotSeq: 3, working: false })),
            { runId: 'wf-empty', snapshotSeq: 0, working: false },
          ],
        },
      };

      let text = '';
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = await reader.read(wide, { view: 'runs', offset });
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
          PAGE_BYTES,
        );
        text += page.text as string;
        offset = (page.next as { offset: number } | null)?.offset;
      }
      const whole = JSON.parse(text) as {
        runs: { runId: string; note?: string }[];
        models: unknown[];
      };

      expect(whole.runs).toHaveLength(31);
      expect(whole.runs.at(-1)).toMatchObject({
        runId: 'wf-empty',
        note: 'The run has no rows yet.',
      });
      expect(whole.models).toHaveLength(3);
    });

    it('masks a registered secret in the comparison before cutting it into pages', async () => {
      const secret = 'ghp_SECRETsecretSECRETsecret0123456789';
      registerSecret(secret, 'github token');
      const many = Array.from({ length: 40 }, (_, index) => `wf-m${index}`);
      for (const [index, id] of many.entries()) {
        await teamRun(
          id,
          20_000 + index,
          `${id} ${secret} ${'p'.repeat(index * 37)}`,
        );
        await row(id, 0, 'message', { text: 'go' }, 0, 'dev');
        await row(id, 1, 'turn_complete', turn('opus', 1, 1_000), 1, 'dev');
      }
      const wide = {
        ...scope,
        team: {
          slug: 'team',
          runs: many.map((runId) => ({
            runId,
            snapshotSeq: 1,
            working: false,
          })),
        },
      };

      const pages: string[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = await reader.read(wide, { view: 'runs', offset });
        pages.push(page.text as string);
        offset = (page.next as { offset: number } | null)?.offset;
      }

      expect(pages.length).toBeGreaterThan(1);
      for (const page of pages) {
        expect(page).not.toContain('ghp_SECRET');
        expect(page).not.toContain('0123456789');
      }
    });

    it('cuts every later page from the comparison the first page was cut from, and refuses one that lapsed', async () => {
      const now = vi.spyOn(Date, 'now');
      try {
        now.mockReturnValue(1_000_000);
        const first = await reader.read(scope, { view: 'runs' });
        const fork = orm.em.fork();
        (await fork.findOneOrFail(Run, { id: 'wf-new' })).status = 'failed';
        await fork.flush();
        // A later page within the window is cut from the same text, though a
        // run moved on; a read from the start folds afresh.
        now.mockReturnValue(1_000_000 + 4 * 60_000);
        expect(JSON.stringify(first)).not.toContain('"statusNow":"failed"');
        expect(
          (await reader.read(scope, { view: 'runs', offset: 10 })).error,
        ).toBeUndefined();
        expect(
          JSON.stringify(await reader.read(scope, { view: 'runs' })),
        ).toContain('"statusNow":"failed"');
        // The window is counted from the last read, not the first.
        now.mockReturnValue(1_000_000 + 8 * 60_000);
        expect(
          (await reader.read(scope, { view: 'runs', offset: 10 })).error,
        ).toBeUndefined();

        now.mockReturnValue(1_000_000 + 20 * 60_000);
        expect(
          (await reader.read(scope, { view: 'runs', offset: 10 })).error,
        ).toBe('RUNS_CHANGED');
      } finally {
        now.mockRestore();
      }
    });

    it('reads an archived run of its sample as it read the run while it was live', async () => {
      const readEveryView = async (from: ThreadReaderService) => ({
        runs: await from.read(scope, { view: 'runs' }),
        overview: await from.read(scope, {
          view: 'overview',
          runId: 'wf-old',
        }),
        items: await from.read(scope, { view: 'items', runId: 'wf-old' }),
        team: await from.analysedTeamOf(scope, {
          sourceRunId: 'wf-old',
          snapshotSeq: 1,
          sourceWorking: false,
        }),
      });

      const live = await readEveryView(reader);

      const shelve = orm.em.fork();
      const row = await shelve.findOneOrFail(Run, 'wf-old');
      row.archivedAt = new Date();
      await shelve.flush();
      const archived = await readEveryView(newReader());

      expect(live.items.snapshotSeq).toBe(1);
      expect(live.team?.slug).toBe('team');
      expect(JSON.stringify(live.runs)).toContain('wf-old');
      expect(archived).toEqual(live);
    });

    it('reads one of its runs by runId, and refuses a chat of no team', async () => {
      const older = await reader.read(scope, {
        view: 'items',
        runId: 'wf-old',
      });
      const newest = await reader.read(scope, { view: 'items' });
      const stranger = await reader.read(scope, {
        view: 'items',
        runId: 'source',
      });

      expect(older.snapshotSeq).toBe(1);
      expect(newest.snapshotSeq).toBe(3);
      expect(stranger.error).toBe('NOT_A_TEAM_RUN');
    });

    describe('a run outside the sample', () => {
      const sampleOf = (): AnalysisSource & { team: AnalysedTeam } => ({
        sourceRunId: 'wf-new',
        snapshotSeq: 3,
        sourceWorking: false,
        team: {
          slug: 'team',
          runs: [{ runId: 'wf-new', snapshotSeq: 3, working: false }],
        },
      });

      it('opens an archived run of the team, pinned at its first read while it moves on', async () => {
        const fork = orm.em.fork();
        const shelved = await fork.findOneOrFail(Run, 'wf-old');
        shelved.archivedAt = new Date();
        await fork.flush();
        const turn = sampleOf();

        const first = await reader.read(turn, {
          view: 'items',
          runId: 'wf-old',
        });
        await row('wf-old', 2, 'message', { text: 'later' }, 9, 'dev');
        const again = await reader.read(turn, {
          view: 'items',
          runId: 'wf-old',
        });
        const past = await reader.read(turn, {
          view: 'item',
          runId: 'wf-old',
          seq: 2,
        });

        expect(first.snapshotSeq).toBe(1);
        expect(again).toEqual(first);
        expect(past.error).toBe('PAST_SNAPSHOT');
        expect(turn.team.opened?.get('wf-old')).toEqual({
          runId: 'wf-old',
          snapshotSeq: 1,
          working: false,
        });
        expect(turn.team.runs).toHaveLength(1);
      });

      it('reads a later turn afresh, since a new turn pins again', async () => {
        await reader.read(sampleOf(), { view: 'items', runId: 'wf-old' });
        await row('wf-old', 2, 'message', { text: 'later' }, 9, 'dev');

        const later = await reader.read(sampleOf(), {
          view: 'items',
          runId: 'wf-old',
        });

        expect(later.snapshotSeq).toBe(2);
      });

      it('keeps the pin that landed first when two reads race', async () => {
        const turn = sampleOf();
        const winner = { runId: 'wf-old', snapshotSeq: 0, working: true };

        const racing = reader.readSourceOf(turn, 'wf-old');
        Object.assign(turn.team, { opened: new Map([['wf-old', winner]]) });

        expect(await racing).toEqual({
          sourceRunId: 'wf-old',
          snapshotSeq: 0,
          sourceWorking: true,
        });
      });

      it('refuses another team, a deleted run, a chat of no team and a run with no rows, pinning none', async () => {
        const fork = orm.em.fork();
        fork.persist(
          Object.assign(new Run(), {
            id: 'wf-other',
            title: 'Theirs',
            status: 'completed',
            teamId: 'other-team',
          }),
        );
        await fork.flush();
        await row('wf-other', 0, 'message', { text: 'theirs' }, 0, 'dev');
        await teamRun('wf-empty', 50);
        const turn = sampleOf();
        const errorOf = async (runId: string) =>
          (await reader.read(turn, { view: 'overview', runId })).error;

        expect(await errorOf('wf-other')).toBe('OTHER_TEAM_RUN');
        expect(await errorOf('no-such-run')).toBe('RUN_GONE');
        expect(await errorOf('source')).toBe('NOT_A_TEAM_RUN');
        expect(await errorOf('wf-empty')).toBe('RUN_EMPTY');
        expect(turn.team.opened).toBeUndefined();
      });
    });

    it('names its own team to view=team and the save, with the newest run’s start copy only while that run exists', async () => {
      const fork = orm.em.fork();
      const newest = await fork.findOneOrFail(Run, { id: 'wf-new' });
      newest.teamSnapshot = 'name: Team';
      newest.customInstructions = 'MINE';
      newest.replyLanguage = 'Russian';
      newest.taskInstructions = 'CARD';
      newest.projectInstructions = 'PROJECT';
      newest.memoryIndex = 'INDEX';
      await fork.flush();

      expect(await reader.analysedTeamOf(scope)).toEqual({
        slug: 'team',
        snapshot: 'name: Team',
        baseSnapshot: 'name: Team',
        overlaySnapshot: null,
        projectId: null,
        instructions: {
          customInstructions: 'MINE',
          replyLanguage: 'Russian',
          taskInstructions: 'CARD',
          projectInstructions: 'PROJECT',
          memoryIndex: 'INDEX',
          knowledgeIndex: null,
        },
      });
      expect(
        await reader.analysedTeamOf({ ...scope, sourceRunId: 'wf-gone' }),
      ).toEqual({
        slug: 'team',
        snapshot: null,
        baseSnapshot: null,
        overlaySnapshot: null,
        instructions: null,
      });
      const older = await fork.findOneOrFail(Run, { id: 'wf-old' });
      older.teamSnapshot = 'name: Team v1';
      await fork.flush();
      // A run named reads against its own copy, with its own instructions.
      expect(
        await reader.analysedTeamOf(scope, {
          sourceRunId: 'wf-old',
          snapshotSeq: 1,
          sourceWorking: false,
        }),
      ).toEqual({
        slug: 'team',
        snapshot: 'name: Team v1',
        baseSnapshot: 'name: Team v1',
        overlaySnapshot: null,
        projectId: null,
        instructions: {
          customInstructions: null,
          replyLanguage: null,
          taskInstructions: null,
          projectInstructions: null,
          memoryIndex: null,
          knowledgeIndex: null,
        },
      });
      expect(
        await reader.analysedTeamOf({
          sourceRunId: 'source',
          snapshotSeq: 0,
          sourceWorking: false,
        }),
      ).toBeNull();
    });

    it('answers view=runs only for a team analysis, and a thread analysis no other run', async () => {
      const thread = {
        sourceRunId: 'source',
        snapshotSeq: 0,
        sourceWorking: false,
      };

      expect((await reader.read(thread, { view: 'runs' })).error).toBe(
        'UNSUPPORTED',
      );
      expect(
        (await reader.read(thread, { view: 'overview', runId: 'wf-new' }))
          .error,
      ).toBe('NOT_ANALYSED');
    });
  });
});
